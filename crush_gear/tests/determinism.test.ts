/**
 * §9 決定性要求 / §11.1 驗收條件。
 *
 * 核心主張：同一組輸入參數重複執行 100 次，輸出的 state checksum 陣列完全一致。
 * 涵蓋 10 組不同的投擲參數，含高速對撞、擦邊、原地自轉、低空投擲、高拋、
 * 角落纏鬥、翻覆結局、出界結局與逾時平手。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { checksumFrame, quantize } from '../src/sim/checksum.js';
import { Rng } from '../src/sim/rng.js';
import { simulate } from '../src/sim/simulate.js';
import type { BattleInput, SimResult } from '../src/sim/types.js';
import { initPhysics } from '../src/sim/world.js';
import { runBattles } from '../tools/pool.js';

const PI = Math.PI;

type Scenario = {
  name: string;
  battle: BattleInput;
  /** 覆寫重複次數。目前全部情境皆為 §11.1 要求的 100 次，此欄位保留備用。 */
  repeats?: number;
};

const SCENARIOS: readonly Scenario[] = [
  {
    name: '高速對撞（兩車最大初速正對）',
    battle: {
      seed: 20260817,
      throwA: { x: 0, z: -0.4, y: 0.032, yaw: 0, pitch: 0, speed: 5, spin: 0 },
      throwB: { x: 0, z: 0.4, y: 0.032, yaw: PI, pitch: 0, speed: 5, spin: 0 },
    },
  },
  {
    name: '偏心高速對撞（撞擊點偏離中心，產生大量自轉）',
    battle: {
      seed: 20260817,
      throwA: { x: -0.02, z: -0.4, y: 0.032, yaw: 0, pitch: 0, speed: 5, spin: 0 },
      throwB: { x: 0.02, z: 0.4, y: 0.032, yaw: PI, pitch: 0, speed: 5, spin: 0 },
    },
  },
  {
    name: '擦邊（兩車平行錯身而過）',
    battle: {
      seed: 31337,
      throwA: { x: -0.06, z: -0.38, y: 0.032, yaw: 0.05, pitch: 0, speed: 4, spin: 0 },
      throwB: { x: 0.06, z: 0.38, y: 0.032, yaw: PI - 0.05, pitch: 0, speed: 4, spin: 0 },
    },
  },
  {
    name: '原地自轉（初速為 0，最大自旋）',
    battle: {
      seed: 99,
      throwA: { x: -0.2, z: 0, y: 0.032, yaw: 0, pitch: 0, speed: 0, spin: 20 },
      throwB: { x: 0.2, z: 0, y: 0.032, yaw: PI, pitch: 0, speed: 0, spin: -20 },
    },
  },
  {
    name: '最低投擲高度（懸吊恰好處於自由長度）',
    battle: {
      seed: 7,
      throwA: { x: -0.19, z: -0.19, y: 0.03, yaw: 0.7854, pitch: -0.3, speed: 3, spin: 5 },
      throwB: { x: 0.19, z: 0.19, y: 0.03, yaw: 3.927, pitch: 0.3, speed: 3, spin: -5 },
    },
  },
  {
    name: '最高投擲高度 + 最大仰角（長時間彈道飛行後落地）',
    battle: {
      seed: 8,
      throwA: { x: -0.26, z: 0, y: 0.15, yaw: 1.5708, pitch: 0.3, speed: 5, spin: 12 },
      throwB: { x: 0.26, z: 0, y: 0.15, yaw: 4.7124, pitch: 0.3, speed: 5, spin: -12 },
    },
  },
  {
    name: '沿弧形圍欄纏鬥（兩車同時投入 +Z 端半圓區）',
    battle: {
      seed: 555,
      throwA: { x: 0.2, z: 0.28, y: 0.032, yaw: 0.7854, pitch: 0, speed: 2, spin: 8 },
      throwB: { x: 0.17, z: 0.24, y: 0.05, yaw: 3.927, pitch: 0, speed: 2, spin: -8 },
    },
  },
  {
    name: '翻覆結局（A 仰躺超過 60 幀）',
    battle: {
      seed: 20260817,
      throwA: {
        x: 0.0829,
        z: -0.275,
        y: 0.0608,
        yaw: 0.5039,
        pitch: -0.1776,
        speed: 3.9655,
        spin: 13.2095,
      },
      throwB: {
        x: -0.2251,
        z: 0.1421,
        y: 0.0712,
        yaw: 4.7028,
        pitch: -0.2754,
        speed: 1.5321,
        spin: -6.966,
      },
    },
  },
  {
    name: '出界結局（長時間纏鬥後被推出場外）',
    battle: {
      seed: 20260817,
      throwA: {
        x: -0.1288,
        z: 0.1,
        y: 0.0607,
        yaw: 4.0095,
        pitch: 0.0563,
        speed: 2.4741,
        spin: 4.3775,
      },
      throwB: {
        x: 0.1442,
        z: 0.2273,
        y: 0.1261,
        yaw: 5.357,
        pitch: 0.2666,
        speed: 0.1488,
        spin: 10.7551,
      },
    },
  },
  {
    // 最昂貴的一組：每次都要推進滿 7200 幀，100 次約 32 秒。
    // 長場次是決定性最容易暴露問題的情境，因此不降低次數。
    name: '逾時平手（跑滿 7200 幀）',
    battle: {
      seed: 20260817,
      throwA: {
        x: 0.2425,
        z: 0.0788,
        y: 0.1101,
        yaw: 4.7073,
        pitch: 0.0738,
        speed: 1.6013,
        spin: -17.7397,
      },
      throwB: {
        x: -0.2129,
        z: -0.0869,
        y: 0.0813,
        yaw: 5.9917,
        pitch: -0.1437,
        speed: 0.4364,
        spin: -13.5988,
      },
    },
  },
];

const DEFAULT_REPEATS = 100;

/**
 * 讓出一個 macrotask。
 *
 * 單場模擬是完全同步的（決定性的必要條件），連跑 100 場會把 event loop 佔住數十秒，
 * 使 vitest worker 無法回應 reporter 的心跳而報出 RPC timeout。每隔幾場讓出一次即可，
 * 對模擬結果沒有任何影響。
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** 回傳首次分歧的描述，完全一致時回傳 null。 */
function describeDivergence(reference: SimResult, candidate: SimResult, run: number): string | null {
  if (candidate.result !== reference.result || candidate.reason !== reference.reason) {
    return `run ${run}: outcome ${candidate.result}/${candidate.reason} !== ${reference.result}/${reference.reason}`;
  }
  if (candidate.frames !== reference.frames) {
    return `run ${run}: frames ${candidate.frames} !== ${reference.frames}`;
  }
  if (candidate.checksums.length !== reference.checksums.length) {
    return `run ${run}: checksum count ${candidate.checksums.length} !== ${reference.checksums.length}`;
  }
  for (let i = 0; i < reference.checksums.length; i += 1) {
    if (candidate.checksums[i] !== reference.checksums[i]) {
      const isLast = i === reference.checksums.length - 1;
      const frame = isLast ? reference.frames : i * 60;
      return (
        `run ${run}: first divergence at sample ${i} (frame ${frame}): ` +
        `${String(candidate.checksums[i])} !== ${String(reference.checksums[i])}`
      );
    }
  }
  return null;
}

beforeAll(async () => {
  await initPhysics();
}, 60_000);

describe('§11.1 決定性：同一輸入重複執行的 checksum 陣列完全一致', () => {
  for (const scenario of SCENARIOS) {
    const repeats = scenario.repeats ?? DEFAULT_REPEATS;
    it(
      `${scenario.name} — ${repeats} 次執行完全一致`,
      async () => {
        const reference = await simulate(scenario.battle);
        expect(reference.checksums.length).toBeGreaterThan(0);

        for (let run = 1; run < repeats; run += 1) {
          const candidate = await simulate(scenario.battle);
          const divergence = describeDivergence(reference, candidate, run);
          expect(divergence).toBeNull();
          if (run % 5 === 0) await yieldToEventLoop();
        }
      },
      300_000,
    );
  }
});

describe('§9.2 checksum 的鑑別力', () => {
  it('checksum 對 1e-5 的狀態差異敏感，對 1e-8 的浮點噪音不敏感', () => {
    const base = {
      translation: { x: 0.123456, y: 0.05, z: -0.2 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linvel: { x: 1, y: 0, z: 2 },
      angvel: { x: 0, y: 3, z: 0 },
    };
    const noisy = { ...base, translation: { ...base.translation, x: 0.123456 + 1e-8 } };
    const different = { ...base, translation: { ...base.translation, x: 0.123456 + 1e-5 } };

    expect(checksumFrame([noisy], [1, 2, 3, 4])).toBe(checksumFrame([base], [1, 2, 3, 4]));
    expect(checksumFrame([different], [1, 2, 3, 4])).not.toBe(checksumFrame([base], [1, 2, 3, 4]));
  });

  it('RNG 狀態納入 checksum：狀態不同即得到不同 checksum', () => {
    const state = {
      translation: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      linvel: { x: 0, y: 0, z: 0 },
      angvel: { x: 0, y: 0, z: 0 },
    };
    expect(checksumFrame([state], [1, 2, 3, 4])).not.toBe(checksumFrame([state], [1, 2, 3, 5]));
  });

  it('checksum 為 32-bit 無號整數', () => {
    const state = {
      translation: { x: -12.5, y: 0.05, z: 7.25 },
      rotation: { x: 0.1, y: 0.2, z: 0.3, w: 0.927 },
      linvel: { x: -3, y: 0, z: 3 },
      angvel: { x: 9, y: -9, z: 0 },
    };
    const h = checksumFrame([state, state], [0xffffffff, 0, 1, 2]);
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('量化規則為 round(v * 1e6) | 0', () => {
    expect(quantize(0.0000005)).toBe(1);
    expect(quantize(-0.0000005)).toBe(0); // Math.round(-0.5) 為 -0，| 0 後正規化為 0
    expect(quantize(1.2345678)).toBe(1234568);
    expect(quantize(-1.2345678)).toBe(-1234568);
  });
});

describe('§9.1 seeded PRNG', () => {
  it('相同 seed 產生完全相同的序列', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 1000; i += 1) {
      expect(a.nextU32()).toBe(b.nextU32());
    }
  });

  it('不同 seed 產生不同序列', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    let differences = 0;
    for (let i = 0; i < 100; i += 1) {
      if (a.nextU32() !== b.nextU32()) differences += 1;
    }
    expect(differences).toBeGreaterThan(90);
  });

  it('nextU32 落在 32-bit 無號整數範圍，nextFloat 落在 [0, 1)', () => {
    const rng = new Rng(0);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 20000; i += 1) {
      const u = rng.nextU32();
      expect(Number.isInteger(u)).toBe(true);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(0xffffffff);

      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      min = Math.min(min, f);
      max = Math.max(max, f);
    }
    // 分佈應該撐滿整個區間
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.99);
  });

  it('seed = 0 不會退化為全零狀態', () => {
    const rng = new Rng(0);
    const values = new Set<number>();
    for (let i = 0; i < 50; i += 1) values.add(rng.nextU32());
    expect(values.size).toBeGreaterThan(40);
  });

  it('snapshot 回傳複本，無法從外部改動 RNG 狀態', () => {
    const rng = new Rng(42);
    const before = rng.snapshot();
    (before as number[])[0] = 0;
    expect(rng.snapshot()[0]).not.toBe(0);
  });

  it('seed 必須是整數', () => {
    expect(() => new Rng(1.5)).toThrow(RangeError);
  });
});

describe('§1.3 平行化不影響決定性', () => {
  /**
   * v1.2 §1.3 硬性條件：同一批次以不同 worker 數量執行，
   * 所有場次的 checksum 陣列必須完全一致，且輸出順序必須與輸入順序一致。
   */
  it('--workers 1 與 --workers 8 的結果逐場逐 checksum 完全相同', async () => {
    const battles = SCENARIOS.slice(0, 9).flatMap((s) => [
      s.battle,
      { ...s.battle, seed: s.battle.seed + 1 },
      { ...s.battle, seed: s.battle.seed + 2 },
    ]);

    const serial = await runBattles(battles, 1);
    const parallel = await runBattles(battles, 8);

    expect(parallel).toHaveLength(serial.length);
    for (let i = 0; i < serial.length; i += 1) {
      const a = serial[i] as SimResult;
      const b = parallel[i] as SimResult;
      expect(
        {
          result: b.result,
          reason: b.reason,
          frames: b.frames,
          checksums: b.checksums,
        },
        `battle ${i}`,
      ).toEqual({
        result: a.result,
        reason: a.reason,
        frames: a.frames,
        checksums: a.checksums,
      });
    }
  }, 300_000);

  it('結果順序由輸入索引決定，不受 worker 完成順序影響', async () => {
    // 刻意讓第 0 場最慢（逾時 7200 幀），其餘極快。若順序取決於完成時間，
    // 最慢的那場就不會留在第 0 個位置。
    const slow = SCENARIOS[9]?.battle as BattleInput;
    const fast = SCENARIOS[0]?.battle as BattleInput;
    const battles = [slow, ...Array.from({ length: 11 }, (_, i) => ({ ...fast, seed: 500 + i }))];

    const parallel = await runBattles(battles, 8);
    expect(parallel[0]?.frames).toBe(7200);
    expect(parallel[0]?.reason).toBe('TIMEOUT');
    for (let i = 1; i < battles.length; i += 1) {
      expect(parallel[i]?.frames).toBeLessThan(7200);
    }
  }, 300_000);
});

describe('§9.3 建立順序造成的差異可被 checksum 捕捉', () => {
  it('交換 A 與 B 的投擲參數會得到不同的 checksum 序列', async () => {
    const battle = SCENARIOS[2]?.battle as BattleInput;
    const swapped: BattleInput = {
      seed: battle.seed,
      throwA: battle.throwB,
      throwB: battle.throwA,
    };
    const a = await simulate(battle);
    const b = await simulate(swapped);
    expect(a.checksums).not.toEqual(b.checksums);
  }, 60_000);

  it('只改變 seed 就足以改變 checksum（RNG 狀態納入雜湊）', async () => {
    const battle = SCENARIOS[0]?.battle as BattleInput;
    const a = await simulate(battle);
    const b = await simulate({ ...battle, seed: battle.seed + 1 });
    expect(a.checksums).not.toEqual(b.checksums);
    // 物理完全相同，因此結局與幀數必須一致，只有 checksum 因 RNG 狀態而不同。
    expect(b.result).toBe(a.result);
    expect(b.frames).toBe(a.frames);
  }, 60_000);
});
