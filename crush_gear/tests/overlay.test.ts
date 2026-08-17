/**
 * Phase 1 P1-c / P1-d 驗收。
 *
 * 驗收 1（五種速度、0.1× 仍為平滑插值）、2（拖曳後續播與從頭播一致）、
 * 3（逐幀不越界）、5（疊圖顯示值與診斷資料一致 —— 以單元測試驗證換算，非目視）。
 *
 * 疊圖的「顯示值」在此指的是換算後的幾何量（柱高、箭頭長度、重心座標），
 * 全部做成純函式後就能直接與 `TrajectoryDiagnostics` 的原始數值對照。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { FIELD_HALF_SEGMENT, FLIP_HOLD_FRAMES } from '../src/data/constants.js';
import { generateTrajectory, type Trajectory } from '../src/replay/trajectory.js';
import { stadiumDistance } from '../src/sim/judge.js';
import type { BattleInput } from '../src/sim/types.js';
import { initPhysics } from '../src/sim/world.js';
import {
  centerOfMassWorld,
  nearestCentreLinePoint,
  normalForceBarHeight,
  OVERLAY_FEATURES,
  OVERLAY_LABELS,
  readContactPoint,
  readTireForce,
  tireForceArrowLength,
} from '../src/render/overlay.js';
import { PLAYBACK_SPEEDS, SIM_HZ, TrajectoryPlayer } from '../src/render/player.js';
import {
  NORMAL_FORCE_METRES_PER_NEWTON,
  TIRE_FORCE_METRES_PER_NEWTON,
} from '../src/render/visual.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadSample(name: string): BattleInput {
  const raw = JSON.parse(
    readFileSync(join(REPO_ROOT, 'sample_battles', `${name}.json`), 'utf8'),
  ) as BattleInput;
  return { seed: raw.seed, throwA: raw.throwA, throwB: raw.throwB };
}

let trajectory: Trajectory;
let flipTrajectory: Trajectory;

beforeAll(async () => {
  await initPhysics();
  trajectory = await generateTrajectory(loadSample('spec_example'), {
    diagnostics: true,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  flipTrajectory = await generateTrajectory(loadSample('b_wins_flip'), {
    diagnostics: true,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
}, 120_000);

// ──────────────────────────────────────────────────────────────────────────
// 驗收 1：五種播放速度
// ──────────────────────────────────────────────────────────────────────────

describe('§2.3-1 五種播放速度皆正確運作', () => {
  it('規格列出的五種速度都可設定', () => {
    expect([...PLAYBACK_SPEEDS]).toEqual([0.1, 0.25, 0.5, 1, 2]);
  });

  it.each([...PLAYBACK_SPEEDS])('%s× 下 1 秒真實時間推進 120×speed 幀', (speed) => {
    const player = new TrajectoryPlayer(trajectory);
    player.setSpeed(speed);
    player.play();
    for (let i = 0; i < 60; i += 1) player.advance(1 / 60);
    expect(player.position).toBeCloseTo(SIM_HZ * speed, 6);
  });

  /**
   * 0.1× 是觀察碰撞細節的主要手段，必須是**平滑插值**而不是跳格。
   *
   * 判準：以 60 fps 推進時，每次繪製之間車體位置都在動（不是連續多幀完全相同），
   * 而 0.1× 下每個顯示幀只推進 0.2 個模擬幀 —— 若沒有插值就會出現連續 5 幀不動。
   */
  it('0.1× 下每個顯示幀的位置都在改變（確認有插值而非跳格）', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.setSpeed(0.1);
    player.play();

    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    let previous: THREE.Vector3 | null = null;
    let identicalRuns = 0;

    for (let i = 0; i < 90; i += 1) {
      player.advance(1 / 60);
      player.sampleTransform(0, position, rotation);
      if (previous !== null && position.distanceTo(previous) === 0) identicalRuns += 1;
      previous = position.clone();
    }
    // 每幀推進 0.2 個模擬幀，插值正確的話位置必定持續變化
    expect(identicalRuns).toBe(0);
    expect(player.position).toBeCloseTo(90 * (1 / 60) * SIM_HZ * 0.1, 6);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 驗收 2：拖曳後續播與從頭播一致
// ──────────────────────────────────────────────────────────────────────────

describe('§2.3-2 時間軸拖曳', () => {
  it('拖曳至任意幀的狀態，與從頭播放至該幀完全相同', () => {
    const targets = [0, 1, 37, 250, 1000];
    const seekPos = new THREE.Vector3();
    const seekRot = new THREE.Quaternion();
    const playPos = new THREE.Vector3();
    const playRot = new THREE.Quaternion();

    for (const target of targets) {
      if (target > trajectory.outcome.frames) continue;

      const seeked = new TrajectoryPlayer(trajectory);
      seeked.seek(target);

      const played = new TrajectoryPlayer(trajectory);
      played.play();
      // 以整數幀為單位推進，落在同一幀上
      played.advance(target / SIM_HZ);

      expect(played.frame, `frame ${target}`).toBe(seeked.frame);
      for (let car = 0; car < 2; car += 1) {
        seeked.sampleTransform(car, seekPos, seekRot);
        played.sampleTransform(car, playPos, playRot);
        expect(playPos.distanceTo(seekPos)).toBeLessThan(1e-6);
        expect(Math.abs(playRot.dot(seekRot))).toBeCloseTo(1, 6);
      }
    }
  });

  it('拖曳後繼續播放，會從該幀接續而非重頭', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.seek(300);
    expect(player.isPlaying).toBe(false);
    player.play();
    player.advance(1 / 60);
    expect(player.position).toBeGreaterThan(300);
    expect(player.position).toBeLessThan(300 + SIM_HZ);
  });

  it('播放結束後按播放會從頭開始', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.play();
    player.advance(trajectory.outcome.frames * 2 * (1 / SIM_HZ));
    expect(player.isFinished).toBe(true);
    player.play();
    expect(player.position).toBe(0);
    expect(player.isPlaying).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 驗收 3：逐幀不越界
// ──────────────────────────────────────────────────────────────────────────

describe('§2.3-3 逐幀前後移動在兩端正確停止', () => {
  it('在第 0 幀後退不會變成負數', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.seek(0);
    for (let i = 0; i < 5; i += 1) player.step(-1);
    expect(player.position).toBe(0);
    expect(player.frame).toBe(0);
  });

  it('在最後一幀前進不會越界', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.seek(trajectory.outcome.frames);
    for (let i = 0; i < 5; i += 1) player.step(1);
    expect(player.position).toBe(trajectory.outcome.frames);
    expect(player.frame).toBe(trajectory.outcome.frames);
  });

  it('自小數位置逐幀移動會落在整數幀上', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.seek(120.4);
    player.step(1);
    expect(player.position).toBe(121);
    player.step(-1);
    expect(player.position).toBe(120);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 驗收 4：六項疊圖可獨立切換
// ──────────────────────────────────────────────────────────────────────────

describe('§2.3-4 六項疊圖', () => {
  it('§P1.8.2 的六項全部有定義且各有標籤', () => {
    expect([...OVERLAY_FEATURES]).toEqual([
      'wheelGrounded',
      'normalForce',
      'tireForce',
      'centerOfMass',
      'stadiumDistance',
      'flipCounter',
    ]);
    for (const feature of OVERLAY_FEATURES) {
      expect(OVERLAY_LABELS[feature]).toBeTruthy();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 驗收 5：疊圖顯示值與診斷資料一致
// ──────────────────────────────────────────────────────────────────────────

describe('§2.3-5 疊圖的顯示值與診斷資料一致', () => {
  it('法向力柱高 = N × 比例，且對每個接地輪都成立', () => {
    const diagnostics = trajectory.diagnostics!;
    let checked = 0;
    for (let frame = 200; frame < 400; frame += 1) {
      for (let car = 0; car < 2; car += 1) {
        const grounded = diagnostics.wheelGrounded[car]!;
        const forces = diagnostics.normalForce[car]!;
        for (let wheel = 0; wheel < 4; wheel += 1) {
          if (grounded[frame * 4 + wheel] !== 1) continue;
          const newtons = forces[frame * 4 + wheel]!;
          expect(normalForceBarHeight(newtons)).toBeCloseTo(
            newtons * NORMAL_FORCE_METRES_PER_NEWTON,
            12,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('負值或零的法向力不會產生負高度', () => {
    expect(normalForceBarHeight(0)).toBe(0);
    expect(normalForceBarHeight(-5)).toBe(0);
  });

  it('輪胎力箭頭長度 = |F| × 比例，方向與診斷向量一致', () => {
    const diagnostics = trajectory.diagnostics!;
    const force = new THREE.Vector3();
    let checked = 0;
    for (let frame = 200; frame < 400; frame += 1) {
      for (let wheel = 0; wheel < 4; wheel += 1) {
        readTireForce(diagnostics, 0, frame, wheel, force);
        const magnitude = force.length();
        if (magnitude === 0) continue;
        expect(tireForceArrowLength(magnitude)).toBeCloseTo(
          magnitude * TIRE_FORCE_METRES_PER_NEWTON,
          12,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  /**
   * 摩擦力恆為 Coulomb 飽和上限 |F| = μN（§6.4）。
   * 這同時驗證了「箭頭長度」與「柱高」兩個顯示量之間的關係符合物理，
   * 也就是設計方據以判斷 μ 調整方向的那條線。
   */
  it('輪胎力大小恆等於 μN，因此箭頭長度與柱高成固定比例', () => {
    const diagnostics = trajectory.diagnostics!;
    const force = new THREE.Vector3();
    const mu = 0.3;
    let checked = 0;
    for (let frame = 200; frame < 400; frame += 1) {
      const grounded = diagnostics.wheelGrounded[0]!;
      const normals = diagnostics.normalForce[0]!;
      for (let wheel = 0; wheel < 4; wheel += 1) {
        if (grounded[frame * 4 + wheel] !== 1) continue;
        const n = normals[frame * 4 + wheel]!;
        if (n <= 0) continue;
        readTireForce(diagnostics, 0, frame, wheel, force);
        expect(force.length()).toBeCloseTo(mu * n, 5);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('接觸點讀取與診斷陣列一致', () => {
    const diagnostics = trajectory.diagnostics!;
    const point = new THREE.Vector3();
    const raw = diagnostics.contactPoint[1]!;
    for (const frame of [0, 50, 123, 400]) {
      for (let wheel = 0; wheel < 4; wheel += 1) {
        readContactPoint(diagnostics, 1, frame, wheel, point);
        const i = (frame * 4 + wheel) * 3;
        expect(point.x).toBe(raw[i]);
        expect(point.y).toBe(raw[i + 1]);
        expect(point.z).toBe(raw[i + 2]);
      }
    }
  });

  it('重心世界座標 = 剛體原點 + 旋轉 · 局部質心，且與 stadiumDist 對得起來', () => {
    const diagnostics = trajectory.diagnostics!;
    const player = new TrajectoryPlayer(trajectory);
    const origin = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const com = new THREE.Vector3();

    for (const frame of [0, 60, 240, 600]) {
      if (frame > trajectory.outcome.frames) continue;
      player.seek(frame);
      for (let car = 0; car < 2; car += 1) {
        player.sampleTransform(car, origin, rotation);
        centerOfMassWorld(origin, rotation, diagnostics.localCenterOfMass[car]!, com);
        // 軌跡是 f32，診斷的 stadiumDist 也是 f32，容差取 1e-4
        expect(stadiumDistance(com.x, com.z)).toBeCloseTo(
          diagnostics.stadiumDist[car]![frame]!,
          4,
        );
      }
    }
  });

  it('距離線的起點落在 stadium 中心線上', () => {
    const point = new THREE.Vector3();
    for (const z of [-1, -0.2, 0, 0.1, 0.42, 3]) {
      nearestCentreLinePoint(z, point);
      expect(point.x).toBe(0);
      expect(point.y).toBe(0);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(FIELD_HALF_SEGMENT);
    }
    nearestCentreLinePoint(0.05, point);
    expect(point.z).toBeCloseTo(0.05, 12);
  });

  it('FLIP 計數器在結局幀達到門檻，且中途曾出現警示區間', () => {
    const diagnostics = flipTrajectory.diagnostics!;
    const last = flipTrajectory.outcome.frames;
    const counters = [
      diagnostics.flipCounter[0]![last]!,
      diagnostics.flipCounter[1]![last]!,
    ];
    expect(Math.max(...counters)).toBeGreaterThanOrEqual(FLIP_HOLD_FRAMES);

    // 疊圖在計數器超過門檻一半時轉為警示，該區間必須真的存在
    const loser = counters[0]! >= FLIP_HOLD_FRAMES ? 0 : 1;
    let warnFrames = 0;
    for (let f = 0; f <= last; f += 1) {
      if ((diagnostics.flipCounter[loser]![f] ?? 0) > FLIP_HOLD_FRAMES / 2) warnFrames += 1;
    }
    expect(warnFrames).toBeGreaterThan(0);
  });

  it('局部質心為每台車一組常數，且略偏前上方', () => {
    const diagnostics = trajectory.diagnostics!;
    expect(diagnostics.localCenterOfMass).toHaveLength(2);
    for (const com of diagnostics.localCenterOfMass) {
      expect(com.x).toBeCloseTo(0, 6);
      expect(com.y).toBeGreaterThan(0);
      expect(com.z).toBeGreaterThan(0.01);
    }
  });
});
