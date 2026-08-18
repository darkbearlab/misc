/**
 * UI 的「隨機產生」:隨機的是**輸入**,不是模擬過程。
 *
 * §3 禁令 1（禁止 `Math.random`）約束的是 `src/sim/` —— 它保護的是模擬的決定性。
 * UI 產生一組新的投擲參數不在該範圍內。這份測試就是那條界線的守衛：
 * 產生器每次給出不同的輸入，而任何一組輸入送進 `simulate()` 之後都完全可重現。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { randomSeed, randomThrow } from '../src/ui/controls.js';
import { Rng } from '../src/sim/rng.js';
import { simulate } from '../src/sim/simulate.js';
import type { BattleInput } from '../src/sim/types.js';
import { initPhysics } from '../src/sim/world.js';

describe('UI 隨機投擲：隨機的是輸入，不是過程', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('randomSeed() 連續呼叫給出不同的值', () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 200; i += 1) seeds.add(randomSeed());
    // 200 次 32-bit 取樣若真隨機，重複的機率約 200²/2³³ ≈ 0.5%。
    // 放寬到 190 才算過，既能擋下「固定 seed」也不會被生日碰撞誤殺。
    expect(seeds.size).toBeGreaterThan(190);
  });

  it('randomSeed() 產生的都是合法的 32-bit 有號整數', () => {
    for (let i = 0; i < 100; i += 1) {
      const s = randomSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(s).toBeLessThan(2 ** 31);
    }
  });

  it('不同 seed 產生不同的投擲參數', () => {
    const a = randomThrow(new Rng(1));
    const b = randomThrow(new Rng(2));
    expect(a).not.toEqual(b);
  });

  it(
    '同一組 seed 與投擲參數重播結果完全相同',
    async () => {
      // 刻意用「真隨機」抽一組出來，證明任意輸入都可重現，而不是只有寫死的那組。
      const seed = randomSeed();
      const rng = new Rng(seed);
      const input: BattleInput = {
        seed,
        throwA: randomThrow(rng),
        throwB: randomThrow(rng),
      };

      const first = await simulate(input);
      const second = await simulate(input);

      expect(second.result).toBe(first.result);
      expect(second.reason).toBe(first.reason);
      expect(second.frames).toBe(first.frames);
      expect(second.checksums).toEqual(first.checksums);
    },
    60_000,
  );
});
