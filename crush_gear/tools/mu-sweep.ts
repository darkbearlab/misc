#!/usr/bin/env node
/**
 * Phase 1.5 第一輪:μ 單變數掃描。
 *
 *   npx tsx tools/mu-sweep.ts                       # 預設 0.30 / 0.25 / 0.20 / 0.15 / 0.10
 *   npx tsx tools/mu-sweep.ts 0.30 0.22 0.18        # 自訂
 *   npx tsx tools/mu-sweep.ts --json
 *
 * **每個 μ 值跑的是同一批 500 場投擲**(同一個 seed、同一個取樣器),
 * 取樣器不依賴 μ,因此組間差異純粹來自 μ 而非取樣噪音。
 *
 * 覆寫只存在於記憶體中,`src/data/constants.ts` 不會被改動。
 * **掃描結果不得作為版本依據** —— 選定的值必須寫死回 constants.ts 並升 PHYSICS_VERSION。
 */

import { MAX_ANGULAR_SPEED, TIRE_FRICTION_COEF } from '../src/data/constants.js';
import { PHYSICS_VERSION } from '../src/data/version.js';
import type { BattleReason } from '../src/sim/types.js';
import { initPhysics } from '../src/sim/world.js';
import {
  BATTLE_COUNT,
  measureSingleVehicle,
  measureSweep,
  sweepBattles,
  SWEEP_SEED,
  type SingleVehicleMeasurement,
  type SweepMeasurement,
} from './measure.js';

const DEFAULT_MU = [0.3, 0.25, 0.2, 0.15, 0.1];

type Row = { mu: number; single: SingleVehicleMeasurement; sweep: SweepMeasurement };

function pct(n: number, total: number): string {
  return `${((100 * n) / total).toFixed(1)}%`;
}

function table(rows: readonly Row[]): string {
  const out: string[] = [];
  const head = ['指標', ...rows.map((r) => `μ = ${r.mu.toFixed(2)}`)];
  const line = (cells: readonly string[]): string =>
    `| ${cells[0]!.padEnd(26)} | ${cells.slice(1).map((c) => c.padStart(15)).join(' | ')} |`;

  out.push(line(head));
  out.push(`|${'-'.repeat(28)}|${rows.map(() => '-'.repeat(17)).join('|')}|`);

  const row = (label: string, get: (r: Row) => string): void => {
    out.push(line([label, ...rows.map(get)]));
  };

  row('A_WINS', (r) => String(r.sweep.results.A_WINS));
  row('B_WINS', (r) => String(r.sweep.results.B_WINS));
  row('DRAW', (r) => String(r.sweep.results.DRAW));
  out.push(line(['', ...rows.map(() => '')]));
  row('OUT', (r) => `${String(r.sweep.reasons.OUT)} (${pct(r.sweep.reasons.OUT, BATTLE_COUNT)})`);
  row('FLIP', (r) => `${String(r.sweep.reasons.FLIP)} (${pct(r.sweep.reasons.FLIP, BATTLE_COUNT)})`);
  row(
    'TIMEOUT ★',
    (r) => `${String(r.sweep.reasons.TIMEOUT)} (${pct(r.sweep.reasons.TIMEOUT, BATTLE_COUNT)})`,
  );
  out.push(line(['', ...rows.map(() => '')]));
  row('角速度 p50', (r) => r.sweep.angularSpeed.p50.toFixed(1));
  row('角速度 p90', (r) => r.sweep.angularSpeed.p90.toFixed(1));
  row('角速度 p99', (r) => r.sweep.angularSpeed.p99.toFixed(1));
  row('角速度 max', (r) => r.sweep.angularSpeed.max.toFixed(1));
  row('clamp 觸發 (線/角)', (r) => `${String(r.sweep.clampHits.linear)} / ${String(r.sweep.clampHits.angular)}`);
  out.push(line(['', ...rows.map(() => '')]));
  row('線速度峰值', (r) => r.sweep.maxLinearSpeed.toFixed(3));
  row('質心 y 峰值', (r) => r.sweep.maxComY.toFixed(4));
  out.push(line(['', ...rows.map(() => '')]));
  row('自由加速 0.5s (m/s)', (r) => r.single.freeAccel.toFixed(3));
  row('理論 μ·g·t', (r) => r.single.freeAccelTheory.toFixed(3));
  row('實測/理論', (r) => r.single.freeAccelRatio.toFixed(3));
  row('翻覆臨界 μ (對照)', (r) => r.single.rolloverMu.toFixed(3));
  out.push(line(['', ...rows.map(() => '')]));
  row('總幀數', (r) => String(r.sweep.totalFrames));
  row('批次耗時 (ms)', (r) => String(Math.round(r.sweep.elapsedMs)));
  return out.join('\n');
}

function histograms(rows: readonly Row[]): string {
  const out: string[] = [];
  const labels = rows[0]?.sweep.histogram.map((b) => b.label) ?? [];
  const maxCount = Math.max(...rows.flatMap((r) => r.sweep.histogram.map((b) => b.count)), 1);

  for (const r of rows) {
    out.push('');
    out.push(`μ = ${r.mu.toFixed(2)}`);
    r.sweep.histogram.forEach((b, i) => {
      const bar = '#'.repeat(Math.round((b.count / maxCount) * 34));
      const rs = (Object.entries(b.reasons) as [BattleReason, number][])
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${String(n)}`)
        .join(', ');
      out.push(
        `  ${(labels[i] ?? '').padEnd(15)} ${String(b.count).padStart(4)} (${pct(b.count, BATTLE_COUNT).padStart(6)}) ${bar.padEnd(34)} ${rs}`,
      );
    });
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  await initPhysics();

  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const values = args.length > 0 ? args.map(Number) : DEFAULT_MU;
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid mu value: ${String(v)}`);
  }

  // 同一批投擲，五組共用
  const battles = sweepBattles();

  const rows: Row[] = [];
  for (const mu of values) {
    // μ 等於常數時不傳覆寫，確保基線那一組走的是預設路徑
    const physics = mu === TIRE_FRICTION_COEF ? undefined : { tireFrictionCoef: mu };
    process.stderr.write(`  μ = ${mu.toFixed(2)} …\n`);
    rows.push({
      mu,
      single: measureSingleVehicle(physics),
      sweep: await measureSweep(battles, physics),
    });
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ physicsVersion: PHYSICS_VERSION, rows }, null, 2)}\n`);
    return;
  }

  const out: string[] = [];
  out.push(`# μ 單變數掃描（其餘參數不變，physicsVersion ${String(PHYSICS_VERSION)} 未升版）`);
  out.push('');
  out.push(
    `${String(BATTLE_COUNT)} 場 / 組，seed ${String(SWEEP_SEED)}，五組共用同一批投擲參數。clamp 上限：角速度 ${String(MAX_ANGULAR_SPEED)}。`,
  );
  out.push('');
  out.push(table(rows));
  out.push('');
  out.push('## 戰鬥長度直方圖');
  out.push(histograms(rows));
  out.push('');

  const clamped = rows.filter((r) => r.sweep.clampHits.linear + r.sweep.clampHits.angular > 0);
  if (clamped.length > 0) {
    out.push(
      `⚠ clamp 在 μ = ${clamped.map((r) => r.mu.toFixed(2)).join(', ')} 觸發 —— §6.3 的 clamp 角色被破壞，須停下處理。`,
    );
  } else {
    out.push('✓ 所有 μ 值下 clamp 觸發次數皆為 0。');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
