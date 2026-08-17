/**
 * 播放核心（§P1.8.1）。
 *
 * **播放器不執行任何物理。** 它只讀 `Trajectory`，不持有 Rapier 世界、
 * 不呼叫 `world.step()`、不依顯示幀推進任何狀態。
 *
 * 時間推進：模擬固定 120 Hz，顯示更新率不定，因此以**真實經過時間**換算目標幀，
 * 並在相鄰兩幀之間插值（位置 lerp、旋轉 slerp）。
 * 直接把顯示幀對應成模擬幀會讓播放速度隨螢幕更新率漂移。
 *
 * 本檔刻意只依賴 three 的數學型別，不碰任何 DOM 或 WebGL，因此可在 node 下直接測試。
 */

import * as THREE from 'three';

import { DT, WHEEL_ANCHORS } from '../data/constants.js';
import type { Trajectory } from '../replay/trajectory.js';

/** 模擬頻率，由固定步長衍生（120 Hz）。 */
export const SIM_HZ = 1 / DT;

export const PLAYBACK_SPEEDS = [0.1, 0.25, 0.5, 1, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export class TrajectoryPlayer {
  readonly trajectory: Trajectory;
  /** 結束幀 = `outcome.frames`；播到這裡就停（§P1.7.4）。 */
  readonly lastFrame: number;

  private timeInFrames = 0;
  private playing = false;
  private speed: number = 1;

  private readonly scratchA = new THREE.Quaternion();
  private readonly scratchB = new THREE.Quaternion();

  constructor(trajectory: Trajectory) {
    this.trajectory = trajectory;
    this.lastFrame = trajectory.outcome.frames;
  }

  // ── 狀態 ──────────────────────────────────────────────────────────────

  /** 目前的浮點幀位置。 */
  get position(): number {
    return this.timeInFrames;
  }

  /** 目前顯示的整數幀。 */
  get frame(): number {
    return Math.min(Math.floor(this.timeInFrames), this.lastFrame);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isFinished(): boolean {
    return this.timeInFrames >= this.lastFrame;
  }

  get playbackSpeed(): number {
    return this.speed;
  }

  /** 模擬時間（秒）。 */
  get elapsedSeconds(): number {
    return this.timeInFrames * DT;
  }

  get durationSeconds(): number {
    return this.lastFrame * DT;
  }

  // ── 控制 ──────────────────────────────────────────────────────────────

  play(): void {
    if (this.isFinished) this.timeInFrames = 0;
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  restart(): void {
    this.timeInFrames = 0;
    this.playing = true;
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new RangeError(`Playback speed must be a positive number, got ${String(speed)}`);
    }
    this.speed = speed;
  }

  /** 跳至指定幀（可為小數），並暫停。 */
  seek(frame: number): void {
    this.timeInFrames = Math.max(0, Math.min(frame, this.lastFrame));
    this.playing = false;
  }

  /** 逐幀前進 / 後退。 */
  step(delta: number): void {
    this.seek(Math.round(this.timeInFrames) + delta);
  }

  /**
   * 依真實經過時間推進。
   *
   * @param realDeltaSeconds 兩次繪製之間實際經過的秒數
   */
  advance(realDeltaSeconds: number): void {
    if (!this.playing) return;
    if (!Number.isFinite(realDeltaSeconds) || realDeltaSeconds <= 0) return;

    this.timeInFrames += realDeltaSeconds * this.speed * SIM_HZ;
    if (this.timeInFrames >= this.lastFrame) {
      this.timeInFrames = this.lastFrame;
      this.playing = false;
    }
  }

  // ── 取樣 ──────────────────────────────────────────────────────────────

  /**
   * 取得某台車在目前時間點的變換，位置 lerp、旋轉 slerp。
   *
   * @param car 0 = 車 A，1 = 車 B
   */
  sampleTransform(car: number, outPosition: THREE.Vector3, outRotation: THREE.Quaternion): void {
    const position = this.trajectory.position[car];
    const rotation = this.trajectory.rotation[car];
    if (position === undefined || rotation === undefined) {
      throw new RangeError(`Trajectory has no vehicle ${String(car)}.`);
    }

    const f0 = Math.min(Math.floor(this.timeInFrames), this.lastFrame);
    const f1 = Math.min(f0 + 1, this.lastFrame);
    const alpha = f1 === f0 ? 0 : this.timeInFrames - f0;

    const p0 = f0 * 3;
    const p1 = f1 * 3;
    outPosition.set(
      lerp(position[p0] as number, position[p1] as number, alpha),
      lerp(position[p0 + 1] as number, position[p1 + 1] as number, alpha),
      lerp(position[p0 + 2] as number, position[p1 + 2] as number, alpha),
    );

    const r0 = f0 * 4;
    const r1 = f1 * 4;
    this.scratchA.set(
      rotation[r0] as number,
      rotation[r0 + 1] as number,
      rotation[r0 + 2] as number,
      rotation[r0 + 3] as number,
    );
    if (alpha === 0) {
      outRotation.copy(this.scratchA);
      return;
    }
    this.scratchB.set(
      rotation[r1] as number,
      rotation[r1 + 1] as number,
      rotation[r1 + 2] as number,
      rotation[r1 + 3] as number,
    );
    outRotation.copy(this.scratchA).slerp(this.scratchB, alpha);
  }

  /**
   * 取得某台車四輪在目前顯示幀的懸吊命中距離；離地的輪回傳 `null`。
   *
   * 接觸點在相鄰兩幀之間不插值 —— 輪子在接地與離地之間切換時，
   * 對接觸點做插值沒有物理意義。
   *
   * 需要診斷資料；未啟用時全部回傳 `null`（輪子畫在自由長度位置）。
   */
  suspensionDistances(car: number, out: (number | null)[]): (number | null)[] {
    const diagnostics = this.trajectory.diagnostics;
    const wheelCount = WHEEL_ANCHORS.length;
    if (diagnostics === undefined) {
      for (let i = 0; i < wheelCount; i += 1) out[i] = null;
      return out;
    }

    const grounded = diagnostics.wheelGrounded[car];
    const contacts = diagnostics.contactPoint[car];
    const position = this.trajectory.position[car];
    const rotation = this.trajectory.rotation[car];
    if (
      grounded === undefined ||
      contacts === undefined ||
      position === undefined ||
      rotation === undefined
    ) {
      for (let i = 0; i < wheelCount; i += 1) out[i] = null;
      return out;
    }

    const f = this.frame;
    this.scratchA.set(
      rotation[f * 4] as number,
      rotation[f * 4 + 1] as number,
      rotation[f * 4 + 2] as number,
      rotation[f * 4 + 3] as number,
    );
    const bodyX = position[f * 3] as number;
    const bodyY = position[f * 3 + 1] as number;
    const bodyZ = position[f * 3 + 2] as number;

    for (let i = 0; i < wheelCount; i += 1) {
      if (grounded[f * wheelCount + i] !== 1) {
        out[i] = null;
        continue;
      }
      const anchor = WHEEL_ANCHORS[i] as readonly [number, number, number];
      ANCHOR.set(anchor[0], anchor[1], anchor[2]).applyQuaternion(this.scratchA);
      const ax = bodyX + ANCHOR.x;
      const ay = bodyY + ANCHOR.y;
      const az = bodyZ + ANCHOR.z;

      const c = (f * wheelCount + i) * 3;
      const dx = ax - (contacts[c] as number);
      const dy = ay - (contacts[c + 1] as number);
      const dz = az - (contacts[c + 2] as number);
      out[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return out;
  }
}

const ANCHOR = new THREE.Vector3();

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 結局的人類可讀描述（§P1.7.4）。 */
export function describeOutcome(trajectory: Trajectory): string {
  const { result, reason, frames } = trajectory.outcome;
  const winner = result === 'A_WINS' ? 'A 勝' : result === 'B_WINS' ? 'B 勝' : '平手';
  const why =
    reason === 'OUT' ? '出界' : reason === 'FLIP' ? '翻覆' : '時限到（60 秒）';
  return `${winner} — ${why}（${String(frames)} 幀 / ${(frames * DT).toFixed(2)} 秒）`;
}
