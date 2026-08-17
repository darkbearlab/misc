/**
 * Phase 1 P1-b：three.js 場景與基本播放。
 *
 * 驗收條件 3（判定一致）、5（幾何同步）、7（五類結局皆可播放）。
 *
 * 這裡不建立 WebGLRenderer —— three 的幾何與數學在 node 下完全可用，
 * 而需要 GPU 的只有最後那一步繪製。因此場景建構與播放邏輯都能直接測。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import * as constants from '../src/data/constants.js';
import {
  CHASSIS_HALF_EXTENTS,
  CHASSIS_OFFSET,
  DT,
  FIELD_RADIUS,
  OUT_THRESHOLD,
  WEAPON_HULL,
  WHEEL_ANCHORS,
} from '../src/data/constants.js';
import { generateTrajectory } from '../src/replay/trajectory.js';
import { stadiumDistance } from '../src/sim/judge.js';
import { Rng } from '../src/sim/rng.js';
import { simulate } from '../src/sim/simulate.js';
import type { BattleInput, ThrowParams } from '../src/sim/types.js';
import { buildFenceSegments, initPhysics } from '../src/sim/world.js';
import { describeOutcome, SIM_HZ, TrajectoryPlayer } from '../src/render/player.js';
import { arenaExtent, buildArena, stadiumShape } from '../src/render/scene.js';
import { buildVehicle, updateWheels } from '../src/render/vehicle.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_NAMES = [
  'a_wins_out',
  'b_wins_flip',
  'draw_timeout',
  'high_speed_head_on',
  'spec_example',
] as const;

function loadSample(name: string): BattleInput {
  const raw = JSON.parse(
    readFileSync(join(REPO_ROOT, 'sample_battles', `${name}.json`), 'utf8'),
  ) as BattleInput;
  return { seed: raw.seed, throwA: raw.throwA, throwB: raw.throwB };
}

beforeAll(async () => {
  await initPhysics();
}, 60_000);

// ──────────────────────────────────────────────────────────────────────────
// 驗收條件 5：幾何同步
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.7.1 幾何一律由 constants.ts 衍生', () => {
  /** constants.ts 匯出的所有非整數數值 —— 這些是「尺寸」，不該出現在渲染層的字面量裡。 */
  const physicalValues = new Set<number>();
  for (const value of Object.values(constants)) {
    if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
      physicalValues.add(Math.abs(value));
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const inner of Object.values(value as Record<string, unknown>)) {
        if (typeof inner === 'number' && !Number.isInteger(inner)) physicalValues.add(Math.abs(inner));
      }
    }
  }

  const GEOMETRY_FILES = ['src/render/scene.ts', 'src/render/vehicle.ts'];

  it.each(GEOMETRY_FILES)('%s 不含任何等於物理常數的字面量', (file) => {
    const code = readFileSync(join(REPO_ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const literals = code.match(/(?<![\w.])\d+\.\d+/g) ?? [];
    const offenders = literals.filter((raw) => physicalValues.has(Math.abs(Number(raw))));
    expect(offenders, `${file} 出現了與物理常數相同的硬編數值`).toEqual([]);
  });

  it.each(GEOMETRY_FILES)('%s 的尺寸來源確實是 constants.ts', (file) => {
    const code = readFileSync(join(REPO_ROOT, file), 'utf8');
    expect(code).toMatch(/from '\.\.\/data\/constants\.js'/);
  });

  it('圍欄 mesh 與物理世界共用同一份 segment 資料', () => {
    const arena = buildArena();
    const fence = arena.getObjectByName('fence');
    expect(fence).toBeDefined();
    const segments = buildFenceSegments();
    expect(fence!.children).toHaveLength(segments.length);

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!;
      const mesh = fence!.children[i] as THREE.Mesh;
      expect(mesh.position.x).toBeCloseTo(segment.center.x, 12);
      expect(mesh.position.y).toBeCloseTo(segment.center.y, 12);
      expect(mesh.position.z).toBeCloseTo(segment.center.z, 12);
      expect(mesh.quaternion.x).toBeCloseTo(segment.rotation.x, 12);
      expect(mesh.quaternion.w).toBeCloseTo(segment.rotation.w, 12);

      const params = (mesh.geometry as THREE.BoxGeometry).parameters;
      expect(params.width).toBeCloseTo(segment.halfExtents.x * 2, 12);
      expect(params.height).toBeCloseTo(segment.halfExtents.y * 2, 12);
      expect(params.depth).toBeCloseTo(segment.halfExtents.z * 2, 12);
    }
  });

  it('底盤 mesh 與 Rapier 的 cuboid collider 同尺寸同位移', () => {
    const view = buildVehicle(0);
    const params = (view.chassis.geometry as THREE.BoxGeometry).parameters;
    expect(params.width).toBeCloseTo(CHASSIS_HALF_EXTENTS.x * 2, 12);
    expect(params.height).toBeCloseTo(CHASSIS_HALF_EXTENTS.y * 2, 12);
    expect(params.depth).toBeCloseTo(CHASSIS_HALF_EXTENTS.z * 2, 12);
    expect(view.chassis.position.x).toBeCloseTo(CHASSIS_OFFSET.x, 12);
    expect(view.chassis.position.y).toBeCloseTo(CHASSIS_OFFSET.y, 12);
    expect(view.chassis.position.z).toBeCloseTo(CHASSIS_OFFSET.z, 12);
  });

  it('前武器 mesh 的頂點全部落在 WEAPON_HULL 的凸包上', () => {
    const view = buildVehicle(0);
    const positions = view.weapon.geometry.getAttribute('position');
    expect(positions.count).toBeGreaterThan(0);

    // three 的 BufferAttribute 以 f32 儲存，容差需大於 f32 量化誤差（此數量級約 1e-8）；
    // 1e-6 仍遠小於 hull 的最小特徵（刃口寬 0.008 m），足以抓出真正的幾何不符。
    const hull = WEAPON_HULL.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    for (let i = 0; i < positions.count; i += 1) {
      const v = new THREE.Vector3().fromBufferAttribute(positions, i);
      const nearest = Math.min(...hull.map((h) => h.distanceTo(v)));
      expect(nearest, `凸包頂點 ${i} 不在 WEAPON_HULL 上`).toBeLessThan(1e-6);
    }
  });

  it('四個輪子恰好位於 WHEEL_ANCHORS', () => {
    const view = buildVehicle(0);
    expect(view.wheels).toHaveLength(WHEEL_ANCHORS.length);
    for (let i = 0; i < WHEEL_ANCHORS.length; i += 1) {
      const anchor = WHEEL_ANCHORS[i]!;
      const wheel = view.wheels[i]!;
      expect(wheel.position.x).toBeCloseTo(anchor[0], 12);
      expect(wheel.position.z).toBeCloseTo(anchor[2], 12);
    }
  });

  it('出界門檻環與 stadiumDistance 的等值線一致', () => {
    const points = stadiumShape(OUT_THRESHOLD).getPoints(96);
    for (const p of points) {
      // Shape 的 (x, y) 對應地面的 (x, z)
      expect(stadiumDistance(p.x, p.y)).toBeCloseTo(OUT_THRESHOLD, 6);
    }
  });

  it('場地取景範圍涵蓋整個出界區', () => {
    expect(arenaExtent()).toBeGreaterThan(OUT_THRESHOLD);
    expect(arenaExtent()).toBeGreaterThan(FIELD_RADIUS);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 驗收條件 3：判定一致
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.10-3 播放器顯示的判定與 CLI 完全相同', () => {
  function randomThrow(rng: Rng): ThrowParams {
    const maxZ = constants.THROW_MAX_STADIUM_DISTANCE + constants.FIELD_HALF_SEGMENT;
    let x = 0;
    let z = 0;
    do {
      x = rng.nextRange(-constants.THROW_MAX_STADIUM_DISTANCE, constants.THROW_MAX_STADIUM_DISTANCE);
      z = rng.nextRange(-maxZ, maxZ);
    } while (stadiumDistance(x, z) > constants.THROW_MAX_STADIUM_DISTANCE);
    const L = constants.THROW_LIMITS;
    return {
      x,
      z,
      y: rng.nextRange(L.y.min, L.y.max),
      yaw: rng.nextRange(L.yaw.min, L.yaw.max),
      pitch: rng.nextRange(L.pitch.min, L.pitch.max),
      speed: rng.nextRange(L.speed.min, L.speed.max),
      spin: rng.nextRange(L.spin.min, L.spin.max),
    };
  }

  it('10 組輸入的 result / reason / frames 與 simulate() 一致', async () => {
    const rng = new Rng(31415);
    for (let i = 0; i < 10; i += 1) {
      const battle: BattleInput = {
        seed: 7000 + i,
        throwA: randomThrow(rng),
        throwB: randomThrow(rng),
      };
      const cli = await simulate(battle);
      const trajectory = await generateTrajectory(battle, {
        generatedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(trajectory.outcome, `battle ${i}`).toEqual({
        result: cli.result,
        reason: cli.reason,
        frames: cli.frames,
      });
    }
  }, 300_000);

  it('播放器停在 outcome.frames，且結局描述帶有正確的幀數', async () => {
    const trajectory = await generateTrajectory(loadSample('a_wins_out'), {
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const player = new TrajectoryPlayer(trajectory);
    expect(player.lastFrame).toBe(trajectory.outcome.frames);

    player.play();
    // 一口氣推進遠超過整場的時間
    player.advance(trajectory.outcome.frames * DT * 2);
    expect(player.frame).toBe(trajectory.outcome.frames);
    expect(player.isFinished).toBe(true);
    expect(player.isPlaying).toBe(false);

    expect(describeOutcome(trajectory)).toContain(String(trajectory.outcome.frames));
    expect(describeOutcome(trajectory)).toContain('出界');
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────────
// 驗收條件 7：五類結局皆可播放
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.10-7 sample_battles 的五個檔案都能播放至結束', () => {
  it.each(SAMPLE_NAMES)('%s', async (name) => {
    const trajectory = await generateTrajectory(loadSample(name), {
      diagnostics: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const player = new TrajectoryPlayer(trajectory);
    const view = buildVehicle(0);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const suspension: (number | null)[] = [null, null, null, null];

    player.play();
    // 以 60 fps 的節奏推進整場，模擬真實播放
    let guard = 0;
    while (!player.isFinished && guard < 100_000) {
      player.advance(1 / 60);
      for (let car = 0; car < 2; car += 1) {
        player.sampleTransform(car, position, rotation);
        expect(Number.isFinite(position.x)).toBe(true);
        expect(Math.abs(rotation.length() - 1)).toBeLessThan(1e-3);
        updateWheels(view, player.suspensionDistances(car, suspension));
        for (const wheel of view.wheels) expect(Number.isFinite(wheel.position.y)).toBe(true);
      }
      guard += 1;
    }
    expect(player.isFinished).toBe(true);
    expect(player.frame).toBe(trajectory.outcome.frames);
    // 播放時間應等於模擬時間（幀數 / 120 Hz）
    expect(player.durationSeconds).toBeCloseTo(trajectory.outcome.frames / SIM_HZ, 9);
  }, 300_000);
});

// ──────────────────────────────────────────────────────────────────────────
// §P1.8.1 時間推進
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.8.1 時間以真實經過時間換算，並在相鄰兩幀間插值', () => {
  let trajectory: Awaited<ReturnType<typeof generateTrajectory>>;

  beforeAll(async () => {
    trajectory = await generateTrajectory(loadSample('spec_example'), {
      diagnostics: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
  }, 60_000);

  it('1 秒的真實時間在 1× 速度下推進 120 幀', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.play();
    player.advance(1);
    expect(player.position).toBeCloseTo(SIM_HZ, 9);
  });

  it('播放速度會等比改變推進量，且與顯示更新率無關', () => {
    for (const speed of [0.1, 0.25, 0.5, 1, 2]) {
      const coarse = new TrajectoryPlayer(trajectory);
      const fine = new TrajectoryPlayer(trajectory);
      coarse.setSpeed(speed);
      fine.setSpeed(speed);
      coarse.play();
      fine.play();

      // 30 fps 與 240 fps 推進同樣長的真實時間，結果必須相同
      for (let i = 0; i < 30; i += 1) coarse.advance(1 / 30);
      for (let i = 0; i < 240; i += 1) fine.advance(1 / 240);
      expect(fine.position).toBeCloseTo(coarse.position, 6);
      expect(coarse.position).toBeCloseTo(SIM_HZ * speed, 6);
    }
  });

  it('位置在兩幀之間線性插值', () => {
    const player = new TrajectoryPlayer(trajectory);
    const at = new THREE.Vector3();
    const rotation = new THREE.Quaternion();

    player.seek(10);
    player.sampleTransform(0, at, rotation);
    const p10 = at.clone();
    player.seek(11);
    player.sampleTransform(0, at, rotation);
    const p11 = at.clone();

    player.seek(10.5);
    player.sampleTransform(0, at, rotation);
    expect(at.x).toBeCloseTo((p10.x + p11.x) / 2, 6);
    expect(at.y).toBeCloseTo((p10.y + p11.y) / 2, 6);
    expect(at.z).toBeCloseTo((p10.z + p11.z) / 2, 6);
  });

  it('旋轉以 slerp 插值，結果仍是單位四元數', () => {
    const player = new TrajectoryPlayer(trajectory);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    for (const frame of [0.5, 37.25, 120.75]) {
      player.seek(frame);
      player.sampleTransform(1, position, rotation);
      expect(rotation.length()).toBeCloseTo(1, 9);
    }
  });

  it('seek 會夾在 [0, lastFrame] 之內並暫停', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.play();
    player.seek(-50);
    expect(player.position).toBe(0);
    expect(player.isPlaying).toBe(false);
    player.seek(player.lastFrame + 1000);
    expect(player.position).toBe(player.lastFrame);
  });

  it('逐幀前進 / 後退', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.seek(100);
    player.step(1);
    expect(player.frame).toBe(101);
    player.step(-1);
    expect(player.frame).toBe(100);
  });

  it('暫停時不推進', () => {
    const player = new TrajectoryPlayer(trajectory);
    player.pause();
    player.advance(1);
    expect(player.position).toBe(0);
  });

  it('播放速度必須為正數', () => {
    const player = new TrajectoryPlayer(trajectory);
    expect(() => {
      player.setSpeed(0);
    }).toThrow(RangeError);
    expect(() => {
      player.setSpeed(-1);
    }).toThrow(RangeError);
  });

  it('懸吊距離取自診斷的接觸點，落在合理範圍內', () => {
    const player = new TrajectoryPlayer(trajectory);
    const out: (number | null)[] = [null, null, null, null];
    player.seek(300);
    const distances = player.suspensionDistances(0, out);
    let grounded = 0;
    for (const d of distances) {
      if (d === null) continue;
      grounded += 1;
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThanOrEqual(constants.SUSPENSION_RAY_LENGTH + 1e-6);
    }
    expect(grounded).toBeGreaterThan(0);
  });
});
