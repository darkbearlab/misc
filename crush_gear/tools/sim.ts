#!/usr/bin/env node
/**
 * CLI 入口（§10、v1.2 §1.3、v1.2 §3）。
 *
 * 所有 I/O 都集中在這一層 —— `src/sim/` 與 `src/data/` 內不得有任何檔案讀寫或主控台輸出（§3.6）。
 *
 * 用法：
 *   npx tsx tools/sim.ts --input battle.json
 *   npx tsx tools/sim.ts --input battle.json --repeat 100 --verify
 *   npx tsx tools/sim.ts --batch batch.json --out results.csv [--workers N]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';

import { simulate } from '../src/sim/simulate.js';
import type { BattleInput, BattleReason, SimResult, ThrowParams } from '../src/sim/types.js';
import { runBattles } from './pool.js';

const USAGE = `crush-gear Phase 0 simulator

Usage:
  tsx tools/sim.ts --input <battle.json>
  tsx tools/sim.ts --input <battle.json> --repeat <n> --verify
  tsx tools/sim.ts --batch <batch.json> [--out <results.csv>] [--workers <n>]

Options:
  --input <file>   Single battle input (see sample_battles/).
  --repeat <n>     Run the same input n times (default 1).
  --verify         Compare the checksum arrays of every run and report divergence.
  --batch <file>   Batch of battle inputs: a bare JSON array, or { "battles": [...] }.
  --out <file>     Write the batch CSV here instead of stdout. The battle-length
                   histogram is written alongside it as <file>.histogram.json.
  --workers <n>    Worker threads for --batch (default: os.availableParallelism()).
                   --workers 1 runs in-process with no threads, for clean per-frame
                   cost measurement (SPEC v1.2 §11.5b).
  --help           Show this message.
`;

// ──────────────────────────────────────────────────────────────────────────
// 參數解析
// ──────────────────────────────────────────────────────────────────────────

type CliOptions = {
  input?: string;
  batch?: string;
  out?: string;
  repeat: number;
  workers: number;
  verify: boolean;
  help: boolean;
};

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    repeat: 1,
    workers: availableParallelism(),
    verify: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const takeValue = (name: string): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option ${name} requires a value.`);
      }
      i += 1;
      return value;
    };
    const takePositiveInt = (name: string): number => {
      const raw = takeValue(name);
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`${name} must be a positive integer, got "${raw}".`);
      }
      return n;
    };

    switch (arg) {
      case '--input':
        options.input = takeValue(arg);
        break;
      case '--batch':
        options.batch = takeValue(arg);
        break;
      case '--out':
        options.out = takeValue(arg);
        break;
      case '--repeat':
        options.repeat = takePositiveInt(arg);
        break;
      case '--workers':
        options.workers = takePositiveInt(arg);
        break;
      case '--verify':
        options.verify = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

// ──────────────────────────────────────────────────────────────────────────
// 輸入檔解析
// ──────────────────────────────────────────────────────────────────────────

const THROW_KEYS = ['x', 'z', 'y', 'yaw', 'pitch', 'speed', 'spin'] as const;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function parseThrow(value: unknown, what: string): ThrowParams {
  const record = asRecord(value, what);
  const out: Record<string, number> = {};
  for (const key of THROW_KEYS) {
    const raw = record[key];
    if (typeof raw !== 'number') {
      throw new Error(`${what}.${key} must be a number.`);
    }
    out[key] = raw;
  }
  return out as unknown as ThrowParams;
}

function parseBattle(value: unknown, what: string): BattleInput {
  const record = asRecord(value, what);
  const seed = record['seed'];
  if (typeof seed !== 'number' || !Number.isInteger(seed)) {
    throw new Error(`${what}.seed must be an integer.`);
  }
  return {
    seed,
    throwA: parseThrow(record['throwA'], `${what}.throwA`),
    throwB: parseThrow(record['throwB'], `${what}.throwB`),
  };
}

type BatchEntry = { id: string; battle: BattleInput };

function parseBatch(value: unknown): BatchEntry[] {
  const list = Array.isArray(value) ? value : asRecord(value, 'batch file')['battles'];
  if (!Array.isArray(list)) {
    throw new Error('Batch file must be a JSON array, or an object with a "battles" array.');
  }
  return list.map((entry, index) => {
    const what = `battles[${index}]`;
    const record = asRecord(entry, what);
    const rawId = record['id'];
    const id = typeof rawId === 'string' ? rawId : String(index);
    return { id, battle: parseBattle(entry, what) };
  });
}

function readJson(path: string): unknown {
  // Windows 上的編輯器常留下 UTF-8 BOM，JSON.parse 不接受，先剝掉。
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text) as unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// 模式：單場 / 驗證
// ──────────────────────────────────────────────────────────────────────────

/** §10 規定的輸出欄位，不含診斷用的 stats。 */
function specOutput(result: SimResult): Record<string, unknown> {
  return {
    result: result.result,
    reason: result.reason,
    frames: result.frames,
    checksums: result.checksums,
  };
}

type Divergence = {
  run: number;
  sampleIndex: number;
  /** 分歧的取樣點對應的幀數；若兩次執行的取樣數量不同則為 null。 */
  frame: number | null;
  expected: number | null;
  actual: number | null;
};

function findDivergence(
  reference: SimResult,
  candidate: SimResult,
  run: number,
  sampleInterval: number,
): Divergence | null {
  const n = Math.max(reference.checksums.length, candidate.checksums.length);
  for (let i = 0; i < n; i += 1) {
    const expected = reference.checksums[i] ?? null;
    const actual = candidate.checksums[i] ?? null;
    if (expected !== actual) {
      // 取樣點 i 對應幀 i * interval，但最後一個取樣點是結束幀。
      const isLastOfReference = i === reference.checksums.length - 1;
      const frame = isLastOfReference ? reference.frames : i * sampleInterval;
      return { run, sampleIndex: i, frame, expected, actual };
    }
  }
  if (reference.frames !== candidate.frames) {
    return {
      run,
      sampleIndex: reference.checksums.length,
      frame: null,
      expected: reference.frames,
      actual: candidate.frames,
    };
  }
  return null;
}

async function runSingle(options: CliOptions, inputPath: string): Promise<number> {
  const battle = parseBattle(readJson(inputPath), 'input');

  if (!options.verify && options.repeat === 1) {
    const result = await simulate(battle);
    process.stdout.write(`${JSON.stringify(specOutput(result), null, 2)}\n`);
    return 0;
  }

  const started = performance.now();
  const first = await simulate(battle);
  const divergences: Divergence[] = [];

  for (let run = 1; run < options.repeat; run += 1) {
    const result = await simulate(battle);
    const divergence = findDivergence(first, result, run, 60);
    if (divergence !== null) divergences.push(divergence);
  }

  const elapsedMs = performance.now() - started;
  const identical = divergences.length === 0;

  process.stdout.write(
    `${JSON.stringify(
      {
        ...specOutput(first),
        verify: {
          runs: options.repeat,
          identical,
          divergentRuns: divergences.length,
          firstDivergence: divergences[0] ?? null,
          elapsedMs: Math.round(elapsedMs),
        },
      },
      null,
      2,
    )}\n`,
  );

  return identical ? 0 : 1;
}

// ──────────────────────────────────────────────────────────────────────────
// 模式：批次（worker pool，§1.3）
// ──────────────────────────────────────────────────────────────────────────

// ── 戰鬥長度直方圖（§3） ─────────────────────────────────────────────────

const HISTOGRAM_EDGES = [120, 300, 600, 1200, 2400, 3600, 4800, 6000, 7200] as const;

type HistogramBucket = {
  label: string;
  count: number;
  reasons: Record<BattleReason, number>;
};

function buildHistogram(results: readonly SimResult[]): HistogramBucket[] {
  const buckets: HistogramBucket[] = [];
  let lower = 0;
  for (const edge of HISTOGRAM_EDGES) {
    buckets.push({
      label: `${lower}-${edge}`,
      count: 0,
      reasons: { OUT: 0, FLIP: 0, TIMEOUT: 0 },
    });
    lower = edge;
  }
  buckets.push({ label: '7200 (timeout)', count: 0, reasons: { OUT: 0, FLIP: 0, TIMEOUT: 0 } });

  for (const r of results) {
    const index =
      r.frames >= 7200
        ? buckets.length - 1
        : HISTOGRAM_EDGES.findIndex((edge) => r.frames < edge);
    const bucket = buckets[index] as HistogramBucket;
    bucket.count += 1;
    bucket.reasons[r.reason] += 1;
  }
  return buckets;
}

function formatHistogram(buckets: readonly HistogramBucket[], total: number): string {
  const width = 40;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const lines = ['', 'battle length histogram (frames):'];
  for (const b of buckets) {
    const bar = '#'.repeat(Math.round((b.count / max) * width));
    const pct = ((100 * b.count) / total).toFixed(1);
    const reasons = (Object.entries(b.reasons) as [BattleReason, number][])
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    lines.push(
      `  ${b.label.padEnd(15)} ${String(b.count).padStart(4)} (${pct.padStart(5)}%) ` +
        `${bar.padEnd(width)}  ${reasons}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const CSV_HEADER = [
  'index',
  'id',
  'seed',
  'result',
  'reason',
  'frames',
  'seconds',
  'finalChecksum',
  'a_x',
  'a_y',
  'a_z',
  'a_yaw',
  'a_pitch',
  'a_speed',
  'a_spin',
  'b_x',
  'b_y',
  'b_z',
  'b_yaw',
  'b_pitch',
  'b_speed',
  'b_spin',
].join(',');

function csvRow(index: number, entry: BatchEntry, result: SimResult): string {
  const a = entry.battle.throwA;
  const b = entry.battle.throwB;
  const fields: (string | number)[] = [
    index,
    JSON.stringify(entry.id),
    entry.battle.seed,
    result.result,
    result.reason,
    result.frames,
    (result.frames / 120).toFixed(4),
    result.checksums[result.checksums.length - 1] ?? '',
    a.x,
    a.y,
    a.z,
    a.yaw,
    a.pitch,
    a.speed,
    a.spin,
    b.x,
    b.y,
    b.z,
    b.yaw,
    b.pitch,
    b.speed,
    b.spin,
  ];
  return fields.join(',');
}

async function runBatch(options: CliOptions, batchPath: string): Promise<number> {
  const entries = parseBatch(readJson(batchPath));
  const workers = Math.max(1, Math.min(options.workers, entries.length));

  const started = performance.now();
  const results = await runBattles(
    entries.map((e) => e.battle),
    workers,
  );
  const elapsedMs = performance.now() - started;

  const rows = [CSV_HEADER];
  const tally = { A_WINS: 0, B_WINS: 0, DRAW: 0 };
  const reasons: Record<BattleReason, number> = { OUT: 0, FLIP: 0, TIMEOUT: 0 };
  let totalFrames = 0;
  results.forEach((result, i) => {
    rows.push(csvRow(i, entries[i] as BatchEntry, result));
    tally[result.result] += 1;
    reasons[result.reason] += 1;
    totalFrames += result.frames;
  });

  const histogram = buildHistogram(results);
  const csv = `${rows.join('\n')}\n`;

  if (options.out !== undefined) {
    writeFileSync(options.out, csv, 'utf8');
    const histogramPath = `${options.out}.histogram.json`;
    writeFileSync(
      histogramPath,
      `${JSON.stringify({ battles: results.length, totalFrames, buckets: histogram }, null, 2)}\n`,
      'utf8',
    );
    process.stderr.write(`wrote ${options.out} and ${histogramPath}\n`);
  } else {
    process.stdout.write(csv);
  }

  const carFrames = totalFrames * 2;
  process.stderr.write(
    `${results.length} battles in ${Math.round(elapsedMs)} ms using ${workers} worker(s) — ` +
      `A_WINS=${tally.A_WINS} B_WINS=${tally.B_WINS} DRAW=${tally.DRAW} | ` +
      `OUT=${reasons.OUT} FLIP=${reasons.FLIP} TIMEOUT=${reasons.TIMEOUT}\n` +
      `${totalFrames} frames (${carFrames} car-frames)` +
      `${workers === 1 ? `, ${((elapsedMs * 1000) / carFrames).toFixed(2)} us/car-frame` : ''}\n`,
  );
  process.stderr.write(formatHistogram(histogram, results.length));

  return 0;
}

// ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || (options.input === undefined && options.batch === undefined)) {
    process.stdout.write(USAGE);
    return options.help ? 0 : 1;
  }
  if (options.input !== undefined && options.batch !== undefined) {
    throw new Error('--input and --batch are mutually exclusive.');
  }

  if (options.batch !== undefined) return runBatch(options, options.batch);
  return runSingle(options, options.input as string);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
