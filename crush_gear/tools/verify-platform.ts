#!/usr/bin/env node
/**
 * 跨平台決定性驗證（§16）。
 *
 * 本專案的線上架構（以 seed + 投擲參數取代連線同步）完全建立在跨平台一致性之上。
 * 剛體碰撞是混沌系統，1e-15 的浮點差異在數百幀後會演變為完全不同的勝負，
 * 因此「同一台機器重複執行一致」完全不等於「跨平台一致」。
 *
 * 用法：
 *   npx tsx tools/verify-platform.ts --generate --out baseline.json
 *   npx tsx tools/verify-platform.ts --compare baseline.json
 *   npx tsx tools/verify-platform.ts --dump orbit_01 --frame 1234
 *   npx tsx tools/verify-platform.ts --list
 *
 * `--generate` 預設會同時記錄每一幀的 checksum（dense），這是把首次分歧定位到
 * 確切幀號的唯一辦法；§9.2 的 60 幀取樣只能定位到 60 幀的區間。以 `--no-dense` 關閉。
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { simulate } from '../src/sim/simulate.js';
import type { BattleInput, SimResult, ThrowParams } from '../src/sim/types.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(REPO_ROOT, 'fixtures', 'platform');

const USAGE = `crush-gear cross-platform determinism verifier (SPEC v1.2 §16)

Usage:
  tsx tools/verify-platform.ts --generate [--out baseline.json] [--no-dense]
  tsx tools/verify-platform.ts --compare <baseline.json>
  tsx tools/verify-platform.ts --dump <fixtureId> --frame <n>
  tsx tools/verify-platform.ts --list

Exit code is 1 when any fixture diverges.
`;

// ──────────────────────────────────────────────────────────────────────────
// 環境指紋
// ──────────────────────────────────────────────────────────────────────────

type Fingerprint = {
  nodeVersion: string;
  v8Version: string;
  platform: string;
  arch: string;
  cpuModel: string;
  rapierVersion: string;
  /** runtime 是否支援 wasm SIMD 指令集。 */
  wasmSimdSupported: boolean;
  /** Rapier 的 wasm build 本身是否用到 SIMD —— 這才是會造成分歧的那一項。 */
  rapierWasmUsesSimd: boolean | null;
  /** Rapier wasm 檔的 SHA-256，確保比對雙方跑的是同一份二進位。 */
  rapierWasmSha256: string | null;
  /**
   * JS 超越函式的位元指紋。
   *
   * wasm 的浮點運算依規範位元精確，但本專案的 JS 端仍用到 Math.sin / cos / tan / hypot，
   * 這些函式的精度是實作定義的。若兩個平台只有這一項不同，就能立刻把矛頭指向
   * JS 數學函式庫而不是 Rapier。
   */
  jsMathFingerprint: string;
  /** Math.hypot(a,b) 是否與 Math.sqrt(a*a+b*b) 位元相同（stadiumDistance 用得到）。 */
  hypotMatchesSqrt: boolean;
};

/**
 * 最小 SIMD 偵測模組：`func () -> () { i32.const 0; i32x4.splat; drop }`。
 * `0xFD 0x0F` 是 i32x4.splat，只有支援 SIMD 的 runtime 才會驗證通過。
 *
 * 註：wasm-feature-detect 廣為流傳的那組位元組在 Node 24 上驗證失敗（模組本身格式有誤），
 * 因此改用手工組出的版本，已確認能 validate 且能 instantiate。
 */
const SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: () -> ()
  0x03, 0x02, 0x01, 0x00, // function: 1 func of type 0
  0x0a, 0x09, 0x01, 0x07, 0x00, // code: 1 body, size 7, 0 locals
  0x41, 0x00, 0xfd, 0x0f, 0x1a, 0x0b, // i32.const 0; i32x4.splat; drop; end
]);

/**
 * tsconfig 沒有載入 DOM 型別，`WebAssembly` 在型別層只是個 namespace。
 * 這裡取出執行期的物件並只宣告用得到的那一個方法。
 */
const WASM = (globalThis as unknown as { WebAssembly: { validate(bytes: Uint8Array): boolean } })
  .WebAssembly;

const RAPIER_WASM = join(
  REPO_ROOT,
  'node_modules',
  '@dimforge',
  'rapier3d-compat',
  'rapier_wasm3d_bg.wasm',
);

/** 掃描 wasm 的 type section 是否出現 v128 (0x7B)，判斷這份 build 有沒有用 SIMD。 */
function inspectRapierWasm(): { usesSimd: boolean | null; sha256: string | null } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(RAPIER_WASM);
  } catch {
    return { usesSimd: null, sha256: null };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // 走過 section header，只看 type section (id = 1)
  let offset = 8;
  let usesSimd = false;
  while (offset < bytes.length) {
    const id = bytes[offset] as number;
    offset += 1;
    let size = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = bytes[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    } while ((byte & 0x80) !== 0);
    if (id === 1) {
      for (let i = offset; i < offset + size; i += 1) {
        if (bytes[i] === 0x7b) {
          usesSimd = true;
          break;
        }
      }
    }
    offset += size;
  }
  return { usesSimd, sha256 };
}

/** 把一組 f64 的原始位元餵進 SHA-256，1 ULP 的差異也會反映出來。 */
function hashFloats(values: readonly number[]): string {
  const buffer = Buffer.allocUnsafe(values.length * 8);
  values.forEach((v, i) => buffer.writeDoubleLE(v, i * 8));
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function buildJsMathFingerprint(): { fingerprint: string; hypotMatchesSqrt: boolean } {
  const values: number[] = [];
  let hypotMatchesSqrt = true;
  for (let i = 0; i < 64; i += 1) {
    const t = (i / 64) * Math.PI * 2;
    values.push(Math.sin(t), Math.cos(t), Math.tan(t / 8));
    const a = 0.35 * Math.cos(t);
    const b = 0.15 * Math.sin(t);
    const hypot = Math.hypot(a, b);
    values.push(hypot);
    if (hypot !== Math.sqrt(a * a + b * b)) hypotMatchesSqrt = false;
  }
  return { fingerprint: hashFloats(values), hypotMatchesSqrt };
}

function readRapierVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  return pkg.dependencies['@dimforge/rapier3d-compat'] ?? 'unknown';
}

function buildFingerprint(): Fingerprint {
  const wasm = inspectRapierWasm();
  const math = buildJsMathFingerprint();
  return {
    nodeVersion: process.versions.node,
    v8Version: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model.trim() ?? 'unknown',
    rapierVersion: readRapierVersion(),
    wasmSimdSupported: WASM.validate(SIMD_PROBE),
    rapierWasmUsesSimd: wasm.usesSimd,
    rapierWasmSha256: wasm.sha256,
    jsMathFingerprint: math.fingerprint,
    hypotMatchesSqrt: math.hypotMatchesSqrt,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

type Fixture = {
  id: string;
  category: string;
  description: string;
  battle: BattleInput;
};

const THROW_KEYS = ['x', 'z', 'y', 'yaw', 'pitch', 'speed', 'spin'] as const;

function parseThrow(value: unknown, what: string): ThrowParams {
  if (typeof value !== 'object' || value === null) throw new Error(`${what} must be an object.`);
  const record = value as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of THROW_KEYS) {
    const raw = record[key];
    if (typeof raw !== 'number') throw new Error(`${what}.${key} must be a number.`);
    out[key] = raw;
  }
  return out as unknown as ThrowParams;
}

/**
 * 已簽入的參考 baseline 就放在 fixtures/platform/ 內（v1.3 §1.4.1 指定的路徑），
 * 它不是 fixture，讀取時必須跳過。
 */
const REFERENCE_BASELINE_NAME = 'baseline.json';

/** 依檔名排序讀取，確保任何平台上的順序都相同。 */
function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json') && f !== REFERENCE_BASELINE_NAME)
    .sort();
  return files.map((file) => {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8').replace(/^\uFEFF/, '')) as
      Record<string, unknown>;
    const id = typeof raw['id'] === 'string' ? raw['id'] : file.replace(/\.json$/, '');
    const seed = raw['seed'];
    if (typeof seed !== 'number' || !Number.isInteger(seed)) {
      throw new Error(`${file}: seed must be an integer.`);
    }
    return {
      id,
      category: typeof raw['category'] === 'string' ? raw['category'] : 'uncategorised',
      description: typeof raw['description'] === 'string' ? raw['description'] : '',
      battle: {
        seed,
        throwA: parseThrow(raw['throwA'], `${file}.throwA`),
        throwB: parseThrow(raw['throwB'], `${file}.throwB`),
      },
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Baseline
// ──────────────────────────────────────────────────────────────────────────

type FixtureResult = {
  id: string;
  category: string;
  result: string;
  reason: string;
  frames: number;
  checksums: number[];
  denseChecksums?: number[];
};

type Baseline = {
  formatVersion: 1;
  fingerprint: Fingerprint;
  results: FixtureResult[];
};

async function runFixtures(fixtures: readonly Fixture[], dense: boolean): Promise<FixtureResult[]> {
  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    const r: SimResult = await simulate(fixture.battle, dense ? { dense: true } : {});
    results.push({
      id: fixture.id,
      category: fixture.category,
      result: r.result,
      reason: r.reason,
      frames: r.frames,
      checksums: r.checksums,
      ...(r.denseChecksums !== undefined ? { denseChecksums: r.denseChecksums } : {}),
    });
  }
  return results;
}

// ──────────────────────────────────────────────────────────────────────────
// 比對
// ──────────────────────────────────────────────────────────────────────────

function diffFingerprints(a: Fingerprint, b: Fingerprint): string[] {
  const keys = Object.keys(a) as (keyof Fingerprint)[];
  return keys
    .filter((k) => a[k] !== b[k])
    .map((k) => `  ${k}:\n    baseline: ${String(a[k])}\n    current:  ${String(b[k])}`);
}

type Divergence = {
  /** 60 幀取樣層級的首次分歧（取樣索引與對應幀號）。 */
  sampleIndex: number;
  sampleFrame: number;
  /** dense 資料可用時的確切分歧幀號。 */
  exactFrame: number | null;
  /** 分歧前最後一次相符的 checksum 與其幀號。 */
  lastMatchingFrame: number | null;
  lastMatchingChecksum: number | null;
  baselineChecksum: number | null;
  currentChecksum: number | null;
};

function findDivergence(
  baseline: FixtureResult,
  current: FixtureResult,
): Divergence | null {
  const dense =
    baseline.denseChecksums !== undefined && current.denseChecksums !== undefined
      ? { base: baseline.denseChecksums, cur: current.denseChecksums }
      : null;

  let exactFrame: number | null = null;
  if (dense !== null) {
    const n = Math.max(dense.base.length, dense.cur.length);
    for (let f = 0; f < n; f += 1) {
      if (dense.base[f] !== dense.cur[f]) {
        exactFrame = f;
        break;
      }
    }
  }

  const n = Math.max(baseline.checksums.length, current.checksums.length);
  for (let i = 0; i < n; i += 1) {
    const b = baseline.checksums[i] ?? null;
    const c = current.checksums[i] ?? null;
    if (b !== c) {
      const isLast = i === baseline.checksums.length - 1;
      const sampleFrame = isLast ? baseline.frames : i * 60;
      return {
        sampleIndex: i,
        sampleFrame,
        exactFrame,
        lastMatchingFrame: i === 0 ? null : (i - 1) * 60,
        lastMatchingChecksum: i === 0 ? null : (baseline.checksums[i - 1] ?? null),
        baselineChecksum: b,
        currentChecksum: c,
      };
    }
  }

  if (baseline.frames !== current.frames || baseline.result !== current.result) {
    return {
      sampleIndex: baseline.checksums.length,
      sampleFrame: baseline.frames,
      exactFrame,
      lastMatchingFrame: (baseline.checksums.length - 1) * 60,
      lastMatchingChecksum: baseline.checksums[baseline.checksums.length - 1] ?? null,
      baselineChecksum: null,
      currentChecksum: null,
    };
  }
  return null;
}

function formatVec(v: { x: number; y: number; z: number; w?: number }): string {
  const parts = [v.x, v.y, v.z, ...(v.w === undefined ? [] : [v.w])];
  return `(${parts.map((n) => n.toExponential(17)).join(', ')})`;
}

async function dumpState(fixture: Fixture, frame: number): Promise<void> {
  const r = await simulate(fixture.battle, { captureFrame: frame });
  process.stdout.write(`\nfixture ${fixture.id}, frame ${frame} (this platform)\n`);
  if (r.capturedState === undefined) {
    process.stdout.write(`  frame ${frame} was never reached (battle ended at ${r.frames})\n`);
    return;
  }
  for (const [tag, s] of [
    ['A', r.capturedState.a],
    ['B', r.capturedState.b],
  ] as const) {
    process.stdout.write(
      `  car ${tag}\n` +
        `    com      ${formatVec(s.translation)}\n` +
        `    rotation ${formatVec(s.rotation)}\n` +
        `    linvel   ${formatVec(s.linvel)}\n` +
        `    angvel   ${formatVec(s.angvel)}\n`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const has = (flag: string): boolean => argv.includes(flag);
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (argv.length === 0 || has('--help') || has('-h')) {
    process.stdout.write(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  const fixtures = loadFixtures();

  if (has('--list')) {
    for (const f of fixtures) {
      process.stdout.write(`${f.id.padEnd(16)} ${f.category.padEnd(12)} ${f.description}\n`);
    }
    process.stdout.write(`\n${fixtures.length} fixtures\n`);
    return 0;
  }

  if (has('--dump')) {
    const id = valueOf('--dump');
    const frame = Number.parseInt(valueOf('--frame') ?? '', 10);
    const fixture = fixtures.find((f) => f.id === id);
    if (fixture === undefined) throw new Error(`Unknown fixture id: ${String(id)}`);
    if (!Number.isInteger(frame) || frame < 0) throw new Error('--frame requires a frame number.');
    await dumpState(fixture, frame);
    return 0;
  }

  if (has('--generate')) {
    const dense = !has('--no-dense');
    const out = valueOf('--out') ?? 'baseline.json';
    const baseline: Baseline = {
      formatVersion: 1,
      fingerprint: buildFingerprint(),
      results: await runFixtures(fixtures, dense),
    };
    writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    process.stderr.write(
      `wrote ${out}: ${baseline.results.length} fixtures, ` +
        `${baseline.results.reduce((s, r) => s + r.frames, 0)} frames, dense=${dense}\n`,
    );
    process.stdout.write(`${JSON.stringify(baseline.fingerprint, null, 2)}\n`);
    return 0;
  }

  if (has('--compare')) {
    const path = valueOf('--compare');
    if (path === undefined) throw new Error('--compare requires a baseline file.');
    const baseline = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Baseline;
    const current = buildFingerprint();
    const dense = baseline.results.some((r) => r.denseChecksums !== undefined);
    const results = await runFixtures(fixtures, dense);

    const fingerprintDiff = diffFingerprints(baseline.fingerprint, current);
    process.stdout.write('=== environment fingerprint ===\n');
    if (fingerprintDiff.length === 0) {
      process.stdout.write('  identical (comparing against the same environment)\n');
    } else {
      process.stdout.write(`${fingerprintDiff.join('\n')}\n`);
    }

    process.stdout.write('\n=== fixtures ===\n');
    let diverged = 0;
    for (const result of results) {
      const base = baseline.results.find((r) => r.id === result.id);
      if (base === undefined) {
        process.stdout.write(`  ${result.id.padEnd(16)} MISSING FROM BASELINE\n`);
        diverged += 1;
        continue;
      }
      const divergence = findDivergence(base, result);
      if (divergence === null) {
        process.stdout.write(
          `  ${result.id.padEnd(16)} OK   ${base.result}/${base.reason} ${base.frames}f, ` +
            `${base.checksums.length} checksums\n`,
        );
        continue;
      }
      diverged += 1;
      process.stdout.write(
        `  ${result.id.padEnd(16)} DIVERGED\n` +
          `      baseline outcome  ${base.result}/${base.reason} @ ${base.frames}f\n` +
          `      current  outcome  ${result.result}/${result.reason} @ ${result.frames}f\n` +
          `      first divergent sample  index ${divergence.sampleIndex} (frame ${divergence.sampleFrame})\n` +
          `      exact divergent frame   ${
            divergence.exactFrame === null
              ? 'unavailable (baseline has no dense checksums — regenerate without --no-dense)'
              : String(divergence.exactFrame)
          }\n` +
          `      last matching frame     ${String(divergence.lastMatchingFrame)} ` +
          `(checksum ${String(divergence.lastMatchingChecksum)})\n` +
          `      checksum baseline=${String(divergence.baselineChecksum)} current=${String(divergence.currentChecksum)}\n`,
      );
      const fixture = fixtures.find((f) => f.id === result.id);
      if (fixture !== undefined && divergence.exactFrame !== null) {
        // 印出分歧前一幀與分歧幀的完整狀態，供人工比對
        for (const f of [Math.max(0, divergence.exactFrame - 1), divergence.exactFrame]) {
          await dumpState(fixture, f);
        }
        process.stdout.write(
          `      run the same --dump on the other platform to compare field by field\n`,
        );
      }
    }

    process.stdout.write(
      `\n${results.length - diverged}/${results.length} fixtures identical` +
        `${diverged === 0 ? '' : `, ${diverged} DIVERGED`}\n`,
    );
    return diverged === 0 ? 0 : 1;
  }

  process.stdout.write(USAGE);
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
