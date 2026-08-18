#!/usr/bin/env node
/**
 * 產生一份完整的物理基線報告(Phase 1.5 調參的對照組)。
 *
 * 每次調整 `src/data/constants.ts` 後重跑本工具,與 `TUNING_PHASE15.md` 的
 * v1 基線逐項對照,即可看出這次改動實際造成了什麼。
 *
 *   npx tsx tools/baseline-report.ts              # 人可讀
 *   npx tsx tools/baseline-report.ts --json       # 機器可讀,便於 diff
 *
 * 本工具**只讀取**模擬結果,不改變任何物理。
 */

import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  DT,
  FIELD_HALF_SEGMENT,
  GRAVITY,
  MAX_ANGULAR_SPEED,
  MAX_LINEAR_SPEED,
  SUSPENSION_DAMPING,
  SUSPENSION_REST_LENGTH,
  SUSPENSION_STIFFNESS,
  THROW_LIMITS,
  THROW_MAX_STADIUM_DISTANCE,
  TIRE_FRICTION_COEF,
  TOTAL_MASS,
  TRACK_WIDTH,
  WHEELBASE,
  WHEEL_ANCHORS,
} from '../src/data/constants.js';
import { PHYSICS_VERSION } from '../src/data/version.js';
import { stadiumDistance } from '../src/sim/judge.js';
import { Rng } from '../src/sim/rng.js';
import type { BattleInput, BattleReason, SimResult, ThrowParams } from '../src/sim/types.js';
import { Vehicle } from '../src/sim/vehicle.js';
import { createWorld, initPhysics } from '../src/sim/world.js';
import { runBattles } from './pool.js';

const BATTLE_COUNT = 500;
const SWEEP_SEED = 20260817;

/** 與 `tests/acceptance.test.ts` 完全相同的取樣器,兩邊的數字才可直接對照。 */
function randomThrow(rng: Rng): ThrowParams {
  const maxZ = THROW_MAX_STADIUM_DISTANCE + FIELD_HALF_SEGMENT;
  let x = 0;
  let z = 0;
  do {
    x = rng.nextRange(-THROW_MAX_STADIUM_DISTANCE, THROW_MAX_STADIUM_DISTANCE);
    z = rng.nextRange(-maxZ, maxZ);
  } while (stadiumDistance(x, z) > THROW_MAX_STADIUM_DISTANCE);

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

const HISTOGRAM_EDGES = [120, 300, 600, 1200, 2400, 3600, 4800, 6000, 7200] as const;

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

/** 靜態行駛高度、翻覆臨界 μ、自由加速 —— 全部從單車實測而非公式推導。 */
async function measureSingleVehicle(): Promise<{
  rideHeight: number;
  groundClearance: number;
  cogHeight: number;
  rolloverMu: number;
  localCom: { x: number; y: number; z: number };
  inertia: { x: number; y: number; z: number };
  freeAccel: number;
  freeAccelTheory: number;
  modes: { heave: number; pitch: number; roll: number };
}> {
  const g = Math.abs(GRAVITY.y);
  const anchorY = WHEEL_ANCHORS[0]?.[1] as number;

  // 靜置收斂 → 行駛高度
  const settleWorld = createWorld();
  const settle = new Vehicle(settleWorld, {
    x: 0,
    z: 0,
    y: 0.06,
    yaw: 0,
    pitch: 0,
    speed: 0,
    spin: 0,
  });
  for (let f = 0; f < 600; f += 1) {
    settle.applyWheelForces(settleWorld, DT);
    settleWorld.step();
    settle.readState();
    settle.clampVelocities();
  }
  const rideHeight = settle.translation().y;
  const localComRaw = settle.localCenterOfMass();
  const inertiaRaw = settle.body.principalInertia();
  const localCom = { x: localComRaw.x, y: localComRaw.y, z: localComRaw.z };
  const inertia = { x: inertiaRaw.x, y: inertiaRaw.y, z: inertiaRaw.z };
  settleWorld.free();

  const staticCompression = (TOTAL_MASS * g) / (4 * SUSPENSION_STIFFNESS);
  const contactY = anchorY - (SUSPENSION_REST_LENGTH - staticCompression);
  const cogHeight = localCom.y - contactY;
  const rolloverMu = TRACK_WIDTH / (2 * cogHeight);
  const groundClearance = rideHeight + Math.min(...WHEEL_ANCHORS.map(() => -0.01));

  // 自由加速 0.5 秒
  const accelWorld = createWorld();
  const runner = new Vehicle(accelWorld, {
    x: 0,
    z: -0.26,
    y: 0.0295,
    yaw: 0,
    pitch: 0,
    speed: 0,
    spin: 0,
  });
  for (let f = 0; f < 60; f += 1) {
    runner.applyWheelForces(accelWorld, DT);
    accelWorld.step();
    runner.readState();
    runner.clampVelocities();
  }
  const freeAccel = runner.linearSpeed();
  accelWorld.free();

  // 顯式阻尼三模態
  const modes = {
    heave: 1 - SUSPENSION_DAMPING * ((4 * DT) / TOTAL_MASS),
    pitch: 1 - SUSPENSION_DAMPING * ((4 * (WHEELBASE / 2) ** 2 * DT) / inertia.x),
    roll: 1 - SUSPENSION_DAMPING * ((4 * (TRACK_WIDTH / 2) ** 2 * DT) / inertia.z),
  };

  return {
    rideHeight,
    groundClearance,
    cogHeight,
    rolloverMu,
    localCom,
    inertia,
    freeAccel,
    freeAccelTheory: TIRE_FRICTION_COEF * g * 0.5,
    modes,
  };
}

async function main(): Promise<void> {
  await initPhysics();
  const asJson = process.argv.includes('--json');

  const single = await measureSingleVehicle();

  const rng = new Rng(SWEEP_SEED);
  const battles: BattleInput[] = [];
  for (let i = 0; i < BATTLE_COUNT; i += 1) {
    battles.push({ seed: 1000 + i, throwA: randomThrow(rng), throwB: randomThrow(rng) });
  }

  const workers = availableParallelism();
  const parallelStart = performance.now();
  const results = await runBattles(battles, workers);
  const parallelMs = performance.now() - parallelStart;

  const tally = { A_WINS: 0, B_WINS: 0, DRAW: 0 };
  const reasons: Record<BattleReason, number> = { OUT: 0, FLIP: 0, TIMEOUT: 0 };
  const buckets = [...HISTOGRAM_EDGES, Number.POSITIVE_INFINITY].map(() => ({
    count: 0,
    reasons: { OUT: 0, FLIP: 0, TIMEOUT: 0 } as Record<BattleReason, number>,
  }));
  const angular: number[] = [];
  let maxComY = Number.NEGATIVE_INFINITY;
  let maxLinear = 0;
  let linearClamps = 0;
  let angularClamps = 0;
  let totalFrames = 0;

  for (const r of results as SimResult[]) {
    tally[r.result] += 1;
    reasons[r.reason] += 1;
    totalFrames += r.frames;
    angular.push(r.stats.maxAngularSpeed);
    maxComY = Math.max(maxComY, r.stats.maxComY);
    maxLinear = Math.max(maxLinear, r.stats.maxLinearSpeed);
    linearClamps += r.stats.linearClampHits;
    angularClamps += r.stats.angularClampHits;

    const index =
      r.frames >= 7200
        ? buckets.length - 1
        : HISTOGRAM_EDGES.findIndex((edge) => r.frames < edge);
    const bucket = buckets[index];
    if (bucket !== undefined) {
      bucket.count += 1;
      bucket.reasons[r.reason] += 1;
    }
  }
  angular.sort((a, b) => a - b);

  const report = {
    physicsVersion: PHYSICS_VERSION,
    parameters: {
      trackWidth: TRACK_WIDTH,
      wheelbase: WHEELBASE,
      totalMass: TOTAL_MASS,
      tireFrictionCoef: TIRE_FRICTION_COEF,
      suspensionStiffness: SUSPENSION_STIFFNESS,
      suspensionDamping: SUSPENSION_DAMPING,
    },
    singleVehicle: single,
    sweep: {
      battles: BATTLE_COUNT,
      seed: SWEEP_SEED,
      totalFrames,
      results: tally,
      reasons,
      histogram: buckets.map((b, i) => ({
        label: i === buckets.length - 1 ? '7200 (timeout)' : `${i === 0 ? 0 : HISTOGRAM_EDGES[i - 1]}-${HISTOGRAM_EDGES[i]}`,
        ...b,
      })),
      angularSpeed: {
        p50: percentile(angular, 0.5),
        p90: percentile(angular, 0.9),
        p99: percentile(angular, 0.99),
        max: angular[angular.length - 1] ?? 0,
      },
      maxComY,
      maxLinearSpeed: maxLinear,
      clampHits: { linear: linearClamps, angular: angularClamps },
    },
    timing: { parallelMs: Math.round(parallelMs), workers },
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const out: string[] = [];
  out.push(`physicsVersion ${String(PHYSICS_VERSION)}`);
  out.push('');
  out.push('── 參數 ────────────────────────────────────────────');
  out.push(`  輪距 ${TRACK_WIDTH} m   軸距 ${WHEELBASE} m   總質量 ${TOTAL_MASS} kg`);
  out.push(`  μ ${TIRE_FRICTION_COEF}   k ${SUSPENSION_STIFFNESS} N/m   c ${SUSPENSION_DAMPING} Ns/m`);
  out.push('');
  out.push('── 單車實測 ────────────────────────────────────────');
  out.push(`  靜態行駛高度        ${single.rideHeight.toFixed(5)} m（車體原點）`);
  out.push(`  車體最低點離地      ${single.groundClearance.toFixed(5)} m`);
  out.push(
    `  localCom            (${single.localCom.x.toFixed(6)}, ${single.localCom.y.toFixed(6)}, ${single.localCom.z.toFixed(6)})`,
  );
  out.push(
    `  慣量                Ixx ${single.inertia.x.toExponential(4)}  Iyy ${single.inertia.y.toExponential(4)}  Izz ${single.inertia.z.toExponential(4)}`,
  );
  out.push(`  cogHeight           ${single.cogHeight.toFixed(5)} m`);
  out.push(`  翻覆臨界 μ          ${single.rolloverMu.toFixed(3)}（現行 μ = ${TIRE_FRICTION_COEF}）`);
  out.push(
    `  自由加速 0.5 秒     ${single.freeAccel.toFixed(3)} m/s（理論 μ·g·t = ${single.freeAccelTheory.toFixed(3)}）`,
  );
  out.push(
    `  阻尼三模態 r        heave ${single.modes.heave.toFixed(4)}  pitch ${single.modes.pitch.toFixed(4)}  roll ${single.modes.roll.toFixed(4)}   （須全部 |r| < 1）`,
  );
  out.push('');
  out.push(`── ${String(BATTLE_COUNT)} 場隨機投擲（seed ${String(SWEEP_SEED)}） ──────────────`);
  out.push(`  勝負          A_WINS ${String(tally.A_WINS)} / B_WINS ${String(tally.B_WINS)} / DRAW ${String(tally.DRAW)}`);
  out.push(`  結束原因      OUT ${String(reasons.OUT)} / FLIP ${String(reasons.FLIP)} / TIMEOUT ${String(reasons.TIMEOUT)}`);
  out.push(`  總幀數        ${String(totalFrames)}`);
  out.push(
    `  角速度分位    p50 ${report.sweep.angularSpeed.p50.toFixed(1)}  p90 ${report.sweep.angularSpeed.p90.toFixed(1)}  p99 ${report.sweep.angularSpeed.p99.toFixed(1)}  max ${report.sweep.angularSpeed.max.toFixed(1)}  （clamp ${String(MAX_ANGULAR_SPEED)}）`,
  );
  out.push(`  質心 y 峰值   ${maxComY.toFixed(4)}   線速度峰值 ${maxLinear.toFixed(3)}（clamp ${String(MAX_LINEAR_SPEED)}）`);
  out.push(`  clamp 觸發    線速度 ${String(linearClamps)} · 角速度 ${String(angularClamps)}`);
  out.push('');
  out.push('  戰鬥長度直方圖');
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  report.sweep.histogram.forEach((b) => {
    const bar = '#'.repeat(Math.round((b.count / maxCount) * 32));
    const rs = (Object.entries(b.reasons) as [BattleReason, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${String(n)}`)
      .join(', ');
    out.push(
      `    ${b.label.padEnd(15)} ${String(b.count).padStart(4)} (${((100 * b.count) / BATTLE_COUNT).toFixed(1).padStart(5)}%) ${bar.padEnd(32)} ${rs}`,
    );
  });
  out.push('');
  out.push(`  批次耗時      ${String(Math.round(parallelMs))} ms（${String(workers)} workers）`);
  process.stdout.write(`${out.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
