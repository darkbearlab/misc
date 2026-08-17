/**
 * Phase 1 P1-a：軌跡資料結構、版本化機制、`simulate()` 的軌跡輸出。
 *
 * 驗收條件 1（物理位元不變）、2（`sim/` 未被實質修改）、4（版本檢查生效）。
 *
 * P1-a 的核心主張只有一句：**開不開軌跡／診斷，物理都必須位元相同。**
 * 這是後續整個 Phase 1 的前提 —— 若不成立，Phase 0 的跨平台驗證就得全部重做。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { FIELD_RADIUS, FLIP_HOLD_FRAMES, OUT_THRESHOLD } from '../src/data/constants.js';
import {
  PHYSICS_VERSION,
  RAPIER_VERSION,
  RAPIER_WASM_SHA256,
  SPEC_VERSION,
} from '../src/data/version.js';
import {
  checkCompatibility,
  currentPhysicsIdentity,
  generateTrajectory,
  IncompatibleReplayError,
  loadReplay,
  parseReplayFile,
  toReplayFile,
  type TrajectoryMeta,
} from '../src/replay/trajectory.js';
import { simulate } from '../src/sim/simulate.js';
import type { BattleInput } from '../src/sim/types.js';
import { orientationFromThrow } from '../src/sim/vehicle.js';
import { initPhysics } from '../src/sim/world.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(REPO_ROOT, 'sample_battles');

function loadSample(name: string): BattleInput {
  const raw = JSON.parse(readFileSync(join(SAMPLES, `${name}.json`), 'utf8')) as BattleInput;
  return { seed: raw.seed, throwA: raw.throwA, throwB: raw.throwB };
}

const OUT_BATTLE = loadSample('a_wins_out');
const FLIP_BATTLE = loadSample('b_wins_flip');
const TIMEOUT_BATTLE = loadSample('draw_timeout');
const HEAD_ON = loadSample('high_speed_head_on');
const SPEC_EXAMPLE = loadSample('spec_example');

const ALL_SAMPLES: readonly { name: string; battle: BattleInput }[] = [
  { name: 'a_wins_out', battle: OUT_BATTLE },
  { name: 'b_wins_flip', battle: FLIP_BATTLE },
  { name: 'draw_timeout', battle: TIMEOUT_BATTLE },
  { name: 'high_speed_head_on', battle: HEAD_ON },
  { name: 'spec_example', battle: SPEC_EXAMPLE },
];

beforeAll(async () => {
  await initPhysics();
}, 60_000);

// ──────────────────────────────────────────────────────────────────────────
// 驗收條件 1 / 2：物理位元不變
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.2.2 軌跡與診斷是旁路輸出，不改變任何物理結果', () => {
  for (const { name, battle } of ALL_SAMPLES) {
    it(`${name}：關閉 / 軌跡 / 軌跡+診斷 三種模式的 checksum 完全相同`, async () => {
      const baseline = await simulate(battle);
      const withTrajectory = await simulate(battle, { trajectory: true });
      const withEverything = await simulate(battle, { trajectory: true, diagnostics: true });

      for (const [label, r] of [
        ['trajectory', withTrajectory],
        ['trajectory+diagnostics', withEverything],
      ] as const) {
        expect(r.result, label).toBe(baseline.result);
        expect(r.reason, label).toBe(baseline.reason);
        expect(r.frames, label).toBe(baseline.frames);
        expect(r.checksums, label).toEqual(baseline.checksums);
      }
    }, 120_000);
  }

  it('逐幀 checksum 也完全相同（dense 比對，最嚴格的一種）', async () => {
    const a = await simulate(HEAD_ON, { dense: true });
    const b = await simulate(HEAD_ON, { dense: true, trajectory: true, diagnostics: true });
    expect(b.denseChecksums).toEqual(a.denseChecksums);
  }, 120_000);

  it('關閉時不產生任何軌跡或診斷欄位', async () => {
    const r = await simulate(HEAD_ON);
    expect(r.trajectory).toBeUndefined();
    expect(r.diagnostics).toBeUndefined();
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────────
// §P1.3 軌跡內容
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.3 軌跡資料', () => {
  it('frameCount 為 outcome.frames + 1，陣列長度相符', async () => {
    const t = await generateTrajectory(OUT_BATTLE, { generatedAt: '2026-01-01T00:00:00.000Z' });
    expect(t.frameCount).toBe(t.outcome.frames + 1);
    for (let v = 0; v < 2; v += 1) {
      expect(t.position[v]?.length).toBe(t.frameCount * 3);
      expect(t.rotation[v]?.length).toBe(t.frameCount * 4);
    }
  }, 60_000);

  it('第 0 幀就是投擲參數本身（position = 剛體原點，rotation = 初始姿態）', async () => {
    const t = await generateTrajectory(OUT_BATTLE, { generatedAt: '2026-01-01T00:00:00.000Z' });
    const throws = [OUT_BATTLE.throwA, OUT_BATTLE.throwB];
    for (let v = 0; v < 2; v += 1) {
      const p = t.position[v] as Float32Array;
      const th = throws[v]!;
      expect(p[0]).toBe(Math.fround(th.x));
      expect(p[1]).toBe(Math.fround(th.y));
      expect(p[2]).toBe(Math.fround(th.z));

      const r = t.rotation[v] as Float32Array;
      const q = orientationFromThrow(th.yaw, th.pitch);
      expect(r[0]).toBeCloseTo(q.x, 6);
      expect(r[1]).toBeCloseTo(q.y, 6);
      expect(r[2]).toBeCloseTo(q.z, 6);
      expect(r[3]).toBeCloseTo(q.w, 6);
    }
  }, 60_000);

  it('所有值有限，四元數為單位長度', async () => {
    const t = await generateTrajectory(FLIP_BATTLE, { generatedAt: '2026-01-01T00:00:00.000Z' });
    for (let v = 0; v < 2; v += 1) {
      const p = t.position[v] as Float32Array;
      for (const value of p) expect(Number.isFinite(value)).toBe(true);

      const r = t.rotation[v] as Float32Array;
      for (let f = 0; f < t.frameCount; f += 1) {
        const x = r[f * 4] as number;
        const y = r[f * 4 + 1] as number;
        const z = r[f * 4 + 2] as number;
        const w = r[f * 4 + 3] as number;
        expect(Math.sqrt(x * x + y * y + z * z + w * w)).toBeCloseTo(1, 4);
      }
    }
  }, 60_000);

  it('7200 幀場次的軌跡記憶體量符合 §P1.3.3 的估計（約 400 KB）', async () => {
    const t = await generateTrajectory(TIMEOUT_BATTLE, {
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(t.frameCount).toBe(7201);
    const bytes =
      t.position.reduce((s, a) => s + a.byteLength, 0) +
      t.rotation.reduce((s, a) => s + a.byteLength, 0);
    expect(bytes).toBeLessThan(450 * 1024);
    expect(bytes).toBeGreaterThan(350 * 1024);
  }, 120_000);
});

// ──────────────────────────────────────────────────────────────────────────
// §P1.5 診斷
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.5 診斷輸出', () => {
  it('OUT 結局：最後一幀的 stadiumDist 確實越過門檻', async () => {
    const t = await generateTrajectory(OUT_BATTLE, {
      diagnostics: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const diag = t.diagnostics;
    expect(diag).toBeDefined();
    const last = t.frameCount - 1;
    const distances = [diag!.stadiumDist[0]![last]!, diag!.stadiumDist[1]![last]!];
    // A 勝，所以出界的是 B
    expect(Math.max(...distances)).toBeGreaterThan(OUT_THRESHOLD);
  }, 60_000);

  it('FLIP 結局：最後一幀的 flipCounter 達到門檻', async () => {
    const t = await generateTrajectory(FLIP_BATTLE, {
      diagnostics: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const last = t.frameCount - 1;
    const counters = [
      t.diagnostics!.flipCounter[0]![last]!,
      t.diagnostics!.flipCounter[1]![last]!,
    ];
    expect(Math.max(...counters)).toBeGreaterThanOrEqual(FLIP_HOLD_FRAMES);
  }, 60_000);

  it('正常行駛時四輪多半接地，且法向力總和約等於車重', async () => {
    const t = await generateTrajectory(SPEC_EXAMPLE, {
      diagnostics: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const grounded = t.diagnostics!.wheelGrounded[0] as Uint8Array;
    const forces = t.diagnostics!.normalForce[0] as Float32Array;

    // 取中段一整秒，避開投擲瞬間的暫態
    const from = 240;
    const to = Math.min(from + 120, t.frameCount);
    let groundedCount = 0;
    let sampled = 0;
    let forceSum = 0;
    for (let f = from; f < to; f += 1) {
      let frameForce = 0;
      for (let w = 0; w < 4; w += 1) {
        if (grounded[f * 4 + w] === 1) groundedCount += 1;
        frameForce += forces[f * 4 + w] as number;
        sampled += 1;
      }
      forceSum += frameForce;
    }
    expect(groundedCount / sampled).toBeGreaterThan(0.9);
    // 平均每幀的法向力總和應接近 m·g = 0.15 × 9.81 ≈ 1.47 N
    expect(forceSum / (to - from)).toBeGreaterThan(1.2);
    expect(forceSum / (to - from)).toBeLessThan(1.9);
  }, 60_000);

  it('接觸點都落在場地範圍內、且在地板上方附近', async () => {
    const t = await generateTrajectory(SPEC_EXAMPLE, {
      diagnostics: true,
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const grounded = t.diagnostics!.wheelGrounded[0] as Uint8Array;
    const points = t.diagnostics!.contactPoint[0] as Float32Array;
    let checked = 0;
    for (let f = 0; f < t.frameCount; f += 1) {
      for (let w = 0; w < 4; w += 1) {
        if (grounded[f * 4 + w] !== 1) continue;
        const y = points[(f * 4 + w) * 3 + 1] as number;
        expect(y).toBeGreaterThan(-0.01);
        expect(y).toBeLessThan(0.2);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  }, 60_000);
});

// ──────────────────────────────────────────────────────────────────────────
// 驗收條件 4：§P1.4 版本化
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.4 版本化與相容性', () => {
  const validMeta = (): TrajectoryMeta => ({
    physicsVersion: PHYSICS_VERSION,
    specVersion: SPEC_VERSION,
    rapierVersion: RAPIER_VERSION,
    wasmSha256: RAPIER_WASM_SHA256,
    seed: 12345,
    throwA: OUT_BATTLE.throwA,
    throwB: OUT_BATTLE.throwB,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('Phase 0 結案狀態的 physicsVersion 為 1', () => {
    expect(PHYSICS_VERSION).toBe(1);
  });

  it('版本識別與實際安裝的 Rapier 一致', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(RAPIER_VERSION).toBe(pkg.dependencies['@dimforge/rapier3d-compat']);
  });

  it('meta 相符時判定為相容', () => {
    expect(checkCompatibility(validMeta())).toEqual({ compatible: true });
  });

  it.each([
    ['physicsVersion', { physicsVersion: 2 }],
    ['rapierVersion', { rapierVersion: '0.20.0' }],
    ['wasmSha256', { wasmSha256: 'deadbeef'.repeat(8) }],
  ])('%s 不符時拒絕重現並給出說明', (field, override) => {
    const result = checkCompatibility({ ...validMeta(), ...override });
    expect(result.compatible).toBe(false);
    if (result.compatible) return;
    expect(result.reasons.join(' ')).toContain(field);
    expect(result.message).toContain('拒絕播放');
  });

  it('generatedAt 與投擲參數不影響相容性判斷', () => {
    const meta = { ...validMeta(), generatedAt: '1999-12-31T23:59:59.000Z', seed: 999 };
    expect(checkCompatibility(meta).compatible).toBe(true);
  });

  it('loadReplay 對竄改過 physicsVersion 的檔案拋出 IncompatibleReplayError，且不產生軌跡', async () => {
    const trajectory = await generateTrajectory(OUT_BATTLE, {
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const file = toReplayFile(trajectory);

    // 人工竄改（驗收條件 4）
    const tampered = JSON.parse(JSON.stringify(file)) as { meta: { physicsVersion: number } };
    tampered.meta.physicsVersion = 99;

    const parsed = parseReplayFile(tampered);
    await expect(loadReplay(parsed)).rejects.toThrow(IncompatibleReplayError);
    await expect(loadReplay(parsed)).rejects.toThrow('無法重現');
  }, 60_000);

  it('未竄改的 replay 檔可以完整重現同一場戰鬥', async () => {
    const original = await generateTrajectory(FLIP_BATTLE, {
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const roundTripped = await loadReplay(
      parseReplayFile(JSON.parse(JSON.stringify(toReplayFile(original)))),
    );

    expect(roundTripped.outcome).toEqual(original.outcome);
    expect(roundTripped.frameCount).toBe(original.frameCount);
    for (let v = 0; v < 2; v += 1) {
      expect(roundTripped.position[v]).toEqual(original.position[v]);
      expect(roundTripped.rotation[v]).toEqual(original.rotation[v]);
    }
  }, 120_000);

  it('replay 檔只存 meta，序列化後約 1 KB', async () => {
    const t = await generateTrajectory(TIMEOUT_BATTLE, {
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    const json = JSON.stringify(toReplayFile(t));
    expect(json.length).toBeLessThan(2048);
    expect(json).not.toContain('position');
  }, 120_000);

  it('結構不合法的檔案在相容性判斷之前就被擋下', () => {
    expect(() => parseReplayFile({})).toThrow('crush-gear replay');
    expect(() => parseReplayFile({ kind: 'crush-gear-replay' })).toThrow('meta');
    expect(() =>
      parseReplayFile({ kind: 'crush-gear-replay', meta: { physicsVersion: 'x' } }),
    ).toThrow('physicsVersion');
  });

  it('currentPhysicsIdentity 回報的雜湊與實際安裝的 wasm 相符', async () => {
    const { createHash } = await import('node:crypto');
    const wasm = readFileSync(
      join(REPO_ROOT, 'node_modules', '@dimforge', 'rapier3d-compat', 'rapier_wasm3d_bg.wasm'),
    );
    const actual = createHash('sha256').update(wasm).digest('hex');
    expect(currentPhysicsIdentity().wasmSha256).toBe(actual);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §P1.2.1 結構性保證
// ──────────────────────────────────────────────────────────────────────────

describe('§P1.2.1 渲染在架構上不可能影響物理', () => {
  it('src/sim 與 src/data 不 import replay / render / ui / three', () => {
    const files = [
      'src/sim/simulate.ts',
      'src/sim/vehicle.ts',
      'src/sim/world.ts',
      'src/sim/judge.ts',
      'src/sim/tire.ts',
      'src/sim/types.ts',
      'src/sim/rng.ts',
      'src/sim/checksum.ts',
      'src/data/constants.ts',
      'src/data/version.ts',
    ];
    for (const file of files) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/from\s+'[^']*(replay|render|ui)\//);
      expect(text, file).not.toMatch(/from\s+'three/);
    }
  });

  it('src/replay 不持有 Rapier 世界，也不呼叫 step()', () => {
    // 註解裡提到這些名稱是允許的（本檔就有），只檢查實際程式碼。
    const code = readFileSync(join(REPO_ROOT, 'src', 'replay', 'trajectory.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('@dimforge/rapier3d');
    expect(code).not.toMatch(/\.step\s*\(/);
    expect(code).not.toContain('createWorld');
  });

  it('stadium 幾何常數可被上層取得（渲染層不得硬編）', () => {
    expect(FIELD_RADIUS).toBeGreaterThan(0);
    expect(OUT_THRESHOLD).toBeGreaterThan(FIELD_RADIUS);
  });
});
