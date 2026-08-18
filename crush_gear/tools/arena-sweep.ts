#!/usr/bin/env node
/**
 * Phase 1.5 第二輪:場地尺寸單變數掃描。
 *
 *   npx tsx tools/arena-sweep.ts
 *   npx tsx tools/arena-sweep.ts --json
 *
 * 維持 stadium 形狀,等比縮放 R 與 L。μ 與車體常數完全不動。
 * OUT 門檻、26 段圍欄、地板 cuboid、投擲合法範圍全部由 `resolveArena()` 連動重算。
 *
 * 每組另外跑一次 5760 條射線的圍欄無縫隙測試 —— 縮小場地會改變弦長,
 * 縫隙是此結構的最主要風險,不能沿用基線的驗證結果。
 *
 * 覆寫只存在於記憶體中,`constants.ts` 不會被改動,**掃描結果不得作為版本依據**。
 */

import RAPIER from '@dimforge/rapier3d-compat';

import { FENCE_HEIGHT, THROW_LIMITS, TIRE_FRICTION_COEF } from '../src/data/constants.js';
import { PHYSICS_VERSION } from '../src/data/version.js';
import { resolveArena, stadiumDistanceIn, type ResolvedArena } from '../src/sim/arena.js';
import { Rng } from '../src/sim/rng.js';
import type { BattleInput, BattleReason, PhysicsOverride, ThrowParams } from '../src/sim/types.js';
import { createWorld, initPhysics } from '../src/sim/world.js';
import { BATTLE_COUNT, measureSweep, SWEEP_SEED, type SweepMeasurement } from './measure.js';

/** 車體總長，用於「短邊 / 車長」比值。底盤 0.100 + 前武器 0.050。 */
const VEHICLE_LENGTH = 0.15;

type Group = { name: string; radius: number; segment: number };

const GROUPS: Group[] = [
  { name: '基線', radius: 0.35, segment: 0.3 },
  { name: 'S1', radius: 0.3, segment: 0.257 },
  { name: 'S2', radius: 0.25, segment: 0.214 },
  { name: 'S3', radius: 0.21, segment: 0.18 },
  { name: 'S4', radius: 0.175, segment: 0.15 },
];

// ──────────────────────────────────────────────────────────────────────────
// 圍欄無縫隙測試（每組都要重跑）
// ──────────────────────────────────────────────────────────────────────────

type FenceCheck = { rays: number; misses: number; worstError: number };

function checkFence(arena: ResolvedArena): FenceCheck {
  const world = createWorld(arena);
  try {
    let misses = 0;
    let worstError = 0;
    let rays = 0;
    const angles = 1440;
    const heights = [0.005, 0.02, 0.04, 0.055];
    for (let i = 0; i < angles; i += 1) {
      const t = (i / angles) * Math.PI * 2;
      const originZ = arena.halfSegment * Math.sin(t);
      const dir = { x: Math.cos(t), y: 0, z: Math.sin(t) };
      for (const h of heights) {
        rays += 1;
        const ray = new RAPIER.Ray({ x: 0, y: h, z: originZ }, dir);
        const hit = world.castRay(ray, 1, true);
        if (hit === null) {
          misses += 1;
          continue;
        }
        const px = dir.x * hit.timeOfImpact;
        const pz = originZ + dir.z * hit.timeOfImpact;
        worstError = Math.max(
          worstError,
          Math.abs(stadiumDistanceIn(arena.halfSegment, px, pz) - arena.fieldRadius),
        );
      }
    }
    return { rays, misses, worstError };
  } finally {
    world.free();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 取樣（每組都要用該組自己的投擲合法範圍）
// ──────────────────────────────────────────────────────────────────────────

type Sampling = { battles: BattleInput[]; attempts: number; rejectRate: number };

function sampleBattles(arena: ResolvedArena): Sampling {
  const rng = new Rng(SWEEP_SEED);
  const battles: BattleInput[] = [];
  let attempts = 0;

  const maxZ = arena.throwMaxStadiumDistance + arena.halfSegment;
  const randomThrow = (): ThrowParams => {
    let x = 0;
    let z = 0;
    do {
      attempts += 1;
      x = rng.nextRange(-arena.throwMaxStadiumDistance, arena.throwMaxStadiumDistance);
      z = rng.nextRange(-maxZ, maxZ);
    } while (stadiumDistanceIn(arena.halfSegment, x, z) > arena.throwMaxStadiumDistance);
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
  };

  for (let i = 0; i < BATTLE_COUNT; i += 1) {
    battles.push({ seed: 1000 + i, throwA: randomThrow(), throwB: randomThrow() });
  }
  const accepted = BATTLE_COUNT * 2;
  return { battles, attempts, rejectRate: 1 - accepted / attempts };
}

// ──────────────────────────────────────────────────────────────────────────

type Row = {
  group: Group;
  arena: ResolvedArena;
  fence: FenceCheck;
  sampling: Sampling;
  sweep: SweepMeasurement;
};

function pct(n: number, total: number): string {
  return `${((100 * n) / total).toFixed(1)}%`;
}

function table(rows: readonly Row[]): string {
  const out: string[] = [];
  const line = (cells: readonly string[]): string =>
    `| ${cells[0]!.padEnd(24)} | ${cells.slice(1).map((c) => c.padStart(14)).join(' | ')} |`;
  out.push(line(['指標', ...rows.map((r) => `${r.group.name}`)]));
  out.push(`|${'-'.repeat(26)}|${rows.map(() => '-'.repeat(16)).join('|')}|`);

  const row = (label: string, get: (r: Row) => string): void => {
    out.push(line([label, ...rows.map(get)]));
  };
  const gap = (): void => {
    out.push(line(['', ...rows.map(() => '')]));
  };

  row('R', (r) => r.arena.fieldRadius.toFixed(3));
  row('L', (r) => r.arena.segmentLength.toFixed(3));
  row('整體 X × Z', (r) =>
    `${(r.arena.fieldRadius * 2).toFixed(2)}×${(r.arena.segmentLength + r.arena.fieldRadius * 2).toFixed(2)}`,
  );
  row('短邊 / 車長', (r) => ((r.arena.fieldRadius * 2) / VEHICLE_LENGTH).toFixed(1));
  row('OUT 門檻', (r) => r.arena.outThreshold.toFixed(3));
  row('投擲最大距離', (r) => r.arena.throwMaxStadiumDistance.toFixed(3));
  row('地板 half X/Z', (r) =>
    `${r.arena.floorHalfExtents.x.toFixed(2)}/${r.arena.floorHalfExtents.z.toFixed(2)}`,
  );
  gap();
  row('圍欄射線落空', (r) => String(r.fence.misses));
  row('圍欄最大誤差 mm', (r) => (r.fence.worstError * 1000).toFixed(2));
  row('取樣拒絕率', (r) => `${(r.sampling.rejectRate * 100).toFixed(1)}%`);
  gap();
  row('A_WINS', (r) => String(r.sweep.results.A_WINS));
  row('B_WINS', (r) => String(r.sweep.results.B_WINS));
  row('DRAW', (r) => String(r.sweep.results.DRAW));
  gap();
  row('OUT', (r) => `${String(r.sweep.reasons.OUT)} (${pct(r.sweep.reasons.OUT, BATTLE_COUNT)})`);
  row('FLIP', (r) => `${String(r.sweep.reasons.FLIP)} (${pct(r.sweep.reasons.FLIP, BATTLE_COUNT)})`);
  row(
    'TIMEOUT ★',
    (r) => `${String(r.sweep.reasons.TIMEOUT)} (${pct(r.sweep.reasons.TIMEOUT, BATTLE_COUNT)})`,
  );
  row('0-120 幀 ★', (r) => {
    const b = r.sweep.histogram[0];
    return `${String(b?.count ?? 0)} (${pct(b?.count ?? 0, BATTLE_COUNT)})`;
  });
  gap();
  row('角速度 p50', (r) => r.sweep.angularSpeed.p50.toFixed(1));
  row('角速度 p90', (r) => r.sweep.angularSpeed.p90.toFixed(1));
  row('角速度 p99', (r) => r.sweep.angularSpeed.p99.toFixed(1));
  row('角速度 max', (r) => r.sweep.angularSpeed.max.toFixed(1));
  row('clamp (線/角)', (r) => `${String(r.sweep.clampHits.linear)} / ${String(r.sweep.clampHits.angular)}`);
  gap();
  row('線速度峰值', (r) => r.sweep.maxLinearSpeed.toFixed(3));
  row('質心 y 峰值', (r) => r.sweep.maxComY.toFixed(4));
  row('總幀數', (r) => String(r.sweep.totalFrames));
  return out.join('\n');
}

function histograms(rows: readonly Row[]): string {
  const out: string[] = [];
  const maxCount = Math.max(...rows.flatMap((r) => r.sweep.histogram.map((b) => b.count)), 1);
  for (const r of rows) {
    out.push('');
    out.push(`${r.group.name}  (R ${r.arena.fieldRadius.toFixed(3)} / L ${r.arena.segmentLength.toFixed(3)})`);
    for (const b of r.sweep.histogram) {
      const bar = '#'.repeat(Math.round((b.count / maxCount) * 34));
      const rs = (Object.entries(b.reasons) as [BattleReason, number][])
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${String(n)}`)
        .join(', ');
      out.push(
        `  ${b.label.padEnd(15)} ${String(b.count).padStart(4)} (${pct(b.count, BATTLE_COUNT).padStart(6)}) ${bar.padEnd(34)} ${rs}`,
      );
    }
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  await initPhysics();

  const rows: Row[] = [];
  for (const group of GROUPS) {
    process.stderr.write(`  ${group.name} (R ${String(group.radius)} / L ${String(group.segment)}) …\n`);
    // 基線那一組不傳覆寫，確保走預設路徑
    const isBaseline = group.name === '基線';
    const physics: PhysicsOverride | undefined = isBaseline
      ? undefined
      : { fieldRadius: group.radius, fieldSegmentLength: group.segment };
    const arena = resolveArena(physics);
    const fence = checkFence(arena);
    const sampling = sampleBattles(arena);
    const sweep = await measureSweep(sampling.battles, physics);
    rows.push({ group, arena, fence, sampling, sweep });
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ physicsVersion: PHYSICS_VERSION, rows }, null, 2)}\n`);
    return;
  }

  const out: string[] = [];
  out.push(`# 場地尺寸單變數掃描（μ = ${String(TIRE_FRICTION_COEF)}，車體常數不變，未升版）`);
  out.push('');
  out.push(
    `${String(BATTLE_COUNT)} 場 / 組，seed ${String(SWEEP_SEED)}。**每組使用自己的投擲合法範圍**（R − 0.08），` +
      `因此投擲參數逐組不同，這是縮放場地的必然結果。圍欄高度維持 ${String(FENCE_HEIGHT)} m。`,
  );
  out.push('');
  out.push(table(rows));
  out.push('');
  out.push('## 戰鬥長度直方圖');
  out.push(histograms(rows));
  out.push('');

  const clamped = rows.filter((r) => r.sweep.clampHits.linear + r.sweep.clampHits.angular > 0);
  const gappy = rows.filter((r) => r.fence.misses > 0);
  if (clamped.length > 0) {
    out.push(`⚠ clamp 在 ${clamped.map((r) => r.group.name).join(', ')} 觸發 —— 須停下處理。`);
  } else {
    out.push('✓ 所有組別 clamp 觸發次數皆為 0。');
  }
  if (gappy.length > 0) {
    out.push(`⚠ 圍欄射線落空：${gappy.map((r) => r.group.name).join(', ')} —— 有縫隙。`);
  } else {
    out.push(`✓ 所有組別圍欄無縫隙（每組 ${String(rows[0]?.fence.rays ?? 0)} 條射線，落空 0）。`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
