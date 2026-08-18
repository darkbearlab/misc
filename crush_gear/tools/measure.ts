/**
 * 物理量測(Phase 1.5 調參用)。
 *
 * `baseline-report.ts` 與 `mu-sweep.ts` 共用這一份,確保基線與掃描的每個數字
 * 都出自完全相同的取樣器與量測程序,可以直接並列比較。
 *
 * 本模組**只讀取**模擬結果,不改變任何物理。
 */

import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  DT,
  FIELD_HALF_SEGMENT,
  GRAVITY,
  SUSPENSION_DAMPING,
  SUSPENSION_REST_LENGTH,
  SUSPENSION_STIFFNESS,
  THROW_LIMITS,
  THROW_MAX_STADIUM_DISTANCE,
  TIRE_FRICTION_COEF,
  WHEEL_SURFACE_SPEED,
} from '../src/data/constants.js';
import { resolveArena, stadiumDistanceIn } from '../src/sim/arena.js';
import { Rng } from '../src/sim/rng.js';
import type {
  BattleInput,
  BattleReason,
  PhysicsOverride,
  SimResult,
  ThrowParams,
} from '../src/sim/types.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { resolveVehicle } from '../src/sim/vehicle-shape.js';
import { createWorld } from '../src/sim/world.js';
import { runBattles } from './pool.js';

export const BATTLE_COUNT = 500;
export const SWEEP_SEED = 20260817;
export const HISTOGRAM_EDGES = [120, 300, 600, 1200, 2400, 3600, 4800, 6000, 7200] as const;

/** 與 `tests/acceptance.test.ts` 完全相同的取樣器。 */
function randomThrow(rng: Rng): ThrowParams {
  const maxZ = THROW_MAX_STADIUM_DISTANCE + FIELD_HALF_SEGMENT;
  let x = 0;
  let z = 0;
  do {
    x = rng.nextRange(-THROW_MAX_STADIUM_DISTANCE, THROW_MAX_STADIUM_DISTANCE);
    z = rng.nextRange(-maxZ, maxZ);
  } while (stadiumDistanceIn(FIELD_HALF_SEGMENT, x, z) > THROW_MAX_STADIUM_DISTANCE);

  const L = THROW_LIMITS;
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

/**
 * 產生掃描用的 500 場投擲。
 *
 * **每個 μ 值都必須跑同一批投擲參數**,否則差異會混入取樣噪音而無法歸因。
 * 取樣器不依賴 μ,因此同一個 seed 必然給出同一批。
 */
export function sweepBattles(): BattleInput[] {
  const rng = new Rng(SWEEP_SEED);
  const battles: BattleInput[] = [];
  for (let i = 0; i < BATTLE_COUNT; i += 1) {
    battles.push({ seed: 1000 + i, throwA: randomThrow(rng), throwB: randomThrow(rng) });
  }
  return battles;
}

export type SingleVehicleMeasurement = {
  rideHeight: number;
  groundClearance: number;
  cogHeight: number;
  rolloverMu: number;
  localCom: { x: number; y: number; z: number };
  inertia: { x: number; y: number; z: number };
  freeAccel: number;
  freeAccelTheory: number;
  freeAccelRatio: number;
  modeK: { heave: number; pitch: number; roll: number };
  modes: { heave: number; pitch: number; roll: number };
};

/** 靜態行駛高度、翻覆臨界 μ、自由加速 —— 全部實測而非公式推導。 */
export function measureSingleVehicle(physics?: PhysicsOverride): SingleVehicleMeasurement {
  const g = Math.abs(GRAVITY.y);
  const mu = physics?.tireFrictionCoef ?? TIRE_FRICTION_COEF;
  const shape = resolveVehicle(physics?.vehicle);
  const anchorY = shape.wheelAnchors[0]?.[1] as number;

  const settleWorld = createWorld(resolveArena(physics));
  const settle = new Vehicle(
    settleWorld,
    { x: 0, z: 0, y: 0.06, yaw: 0, pitch: 0, speed: 0, spin: 0 },
    physics,
  );
  for (let f = 0; f < 600; f += 1) {
    settle.applyWheelForces(settleWorld, DT);
    settleWorld.step();
    settle.readState();
    settle.clampVelocities();
  }
  const rideHeight = settle.translation().y;
  const comRaw = settle.localCenterOfMass();
  const inertiaRaw = settle.body.principalInertia();
  const localCom = { x: comRaw.x, y: comRaw.y, z: comRaw.z };
  const inertia = { x: inertiaRaw.x, y: inertiaRaw.y, z: inertiaRaw.z };
  settleWorld.free();

  const staticCompression = (shape.totalMass * g) / (4 * SUSPENSION_STIFFNESS);
  const contactY = anchorY - (SUSPENSION_REST_LENGTH - staticCompression);
  const cogHeight = localCom.y - contactY;

  const accelWorld = createWorld();
  const runner = new Vehicle(
    accelWorld,
    { x: 0, z: -0.26, y: 0.0295, yaw: 0, pitch: 0, speed: 0, spin: 0 },
    physics,
  );
  for (let f = 0; f < 60; f += 1) {
    runner.applyWheelForces(accelWorld, DT);
    accelWorld.step();
    runner.readState();
    runner.clampVelocities();
  }
  const freeAccel = runner.linearSpeed();
  accelWorld.free();

  const freeAccelTheory = mu * g * 0.5;

  return {
    rideHeight,
    groundClearance: rideHeight + shape.lowestY,
    cogHeight,
    // 翻覆臨界只取決於幾何,不隨 μ 改變 —— 作為掃描的對照
    rolloverMu: shape.trackWidth / (2 * cogHeight),
    localCom,
    inertia,
    freeAccel,
    freeAccelTheory,
    freeAccelRatio: freeAccel / freeAccelTheory,
    // 每個模態的每幀速度衰減比 r = 1 − c·K，K = n·lever²·dt / I_eff（§6.4）。
    modeK: {
      heave: 4 * DT / shape.totalMass,
      pitch: (4 * (shape.wheelbase / 2) ** 2 * DT) / inertia.x,
      roll: (4 * (shape.trackWidth / 2) ** 2 * DT) / inertia.z,
    },
    modes: {
      heave: 1 - SUSPENSION_DAMPING * ((4 * DT) / shape.totalMass),
      pitch: 1 - SUSPENSION_DAMPING * ((4 * (shape.wheelbase / 2) ** 2 * DT) / inertia.x),
      roll: 1 - SUSPENSION_DAMPING * ((4 * (shape.trackWidth / 2) ** 2 * DT) / inertia.z),
    },
  };
}

export type HistogramBucket = {
  label: string;
  count: number;
  reasons: Record<BattleReason, number>;
};

export type SweepMeasurement = {
  battles: number;
  seed: number;
  totalFrames: number;
  results: { A_WINS: number; B_WINS: number; DRAW: number };
  reasons: Record<BattleReason, number>;
  histogram: HistogramBucket[];
  angularSpeed: { p50: number; p90: number; p99: number; max: number };
  maxComY: number;
  maxLinearSpeed: number;
  clampHits: { linear: number; angular: number };
  elapsedMs: number;
  workers: number;
};

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

export async function measureSweep(
  battles: readonly BattleInput[],
  physics?: PhysicsOverride,
): Promise<SweepMeasurement> {
  const workers = availableParallelism();
  const started = performance.now();
  const results = (await runBattles(battles, workers, physics)) as SimResult[];
  const elapsedMs = performance.now() - started;

  const tally = { A_WINS: 0, B_WINS: 0, DRAW: 0 };
  const reasons: Record<BattleReason, number> = { OUT: 0, FLIP: 0, TIMEOUT: 0 };
  const histogram: HistogramBucket[] = [];
  let lower = 0;
  for (const edge of HISTOGRAM_EDGES) {
    histogram.push({
      label: `${String(lower)}-${String(edge)}`,
      count: 0,
      reasons: { OUT: 0, FLIP: 0, TIMEOUT: 0 },
    });
    lower = edge;
  }
  histogram.push({
    label: '7200 (timeout)',
    count: 0,
    reasons: { OUT: 0, FLIP: 0, TIMEOUT: 0 },
  });

  const angular: number[] = [];
  let maxComY = Number.NEGATIVE_INFINITY;
  let maxLinearSpeed = 0;
  let linear = 0;
  let angularClamps = 0;
  let totalFrames = 0;

  for (const r of results) {
    tally[r.result] += 1;
    reasons[r.reason] += 1;
    totalFrames += r.frames;
    angular.push(r.stats.maxAngularSpeed);
    maxComY = Math.max(maxComY, r.stats.maxComY);
    maxLinearSpeed = Math.max(maxLinearSpeed, r.stats.maxLinearSpeed);
    linear += r.stats.linearClampHits;
    angularClamps += r.stats.angularClampHits;

    const index =
      r.frames >= 7200 ? histogram.length - 1 : HISTOGRAM_EDGES.findIndex((e) => r.frames < e);
    const bucket = histogram[index];
    if (bucket !== undefined) {
      bucket.count += 1;
      bucket.reasons[r.reason] += 1;
    }
  }
  angular.sort((a, b) => a - b);

  return {
    battles: battles.length,
    seed: SWEEP_SEED,
    totalFrames,
    results: tally,
    reasons,
    histogram,
    angularSpeed: {
      p50: percentile(angular, 0.5),
      p90: percentile(angular, 0.9),
      p99: percentile(angular, 0.99),
      max: angular[angular.length - 1] ?? 0,
    },
    maxComY,
    maxLinearSpeed,
    clampHits: { linear, angular: angularClamps },
    elapsedMs,
    workers,
  };
}

/** 目前生效的輪胎參數(含覆寫),供報告標頭顯示。 */
export function effectiveTireParams(physics?: PhysicsOverride): {
  mu: number;
  wheelSurfaceSpeed: number;
  overridden: boolean;
} {
  const mu = physics?.tireFrictionCoef ?? TIRE_FRICTION_COEF;
  const wheelSurfaceSpeed = physics?.wheelSurfaceSpeed ?? WHEEL_SURFACE_SPEED;
  return {
    mu,
    wheelSurfaceSpeed,
    overridden: mu !== TIRE_FRICTION_COEF || wheelSurfaceSpeed !== WHEEL_SURFACE_SPEED,
  };
}
