/**
 * Seeded PRNG —— 全專案唯一的隨機來源（§3.1、§9.1）。
 *
 * 演算法：xoshiro128** ，狀態為 4 個 32-bit 無號整數，
 * 全程以 32-bit 整數運算（`Math.imul`、`>>>`、`^`）推進，
 * 不使用任何浮點運算產生亂數狀態 —— 這是跨平台位元級決定性的前提。
 *
 * 種子擴展使用 splitmix32，避免 seed = 0 或小整數導致狀態品質不佳。
 */

const STATE_WORDS = 4;

/** splitmix32：把單一 32-bit 種子擴展為高品質的狀態字。 */
function splitmix32(state: number): { value: number; next: number } {
  const z = (state + 0x9e3779b9) >>> 0;
  let v = z;
  v = Math.imul(v ^ (v >>> 16), 0x21f0aaad) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x735a2d97) >>> 0;
  v = (v ^ (v >>> 15)) >>> 0;
  return { value: v, next: z };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

export class Rng {
  private readonly s: Uint32Array;

  /**
   * @param seed 任意 32-bit 整數。相同 seed 必然產生相同序列。
   */
  constructor(seed: number) {
    if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
      throw new RangeError(`Rng seed must be an integer, got ${String(seed)}`);
    }
    this.s = new Uint32Array(STATE_WORDS);
    let sm = seed >>> 0;
    for (let i = 0; i < STATE_WORDS; i += 1) {
      const step = splitmix32(sm);
      sm = step.next;
      this.s[i] = step.value;
    }
    // xoshiro 的狀態不得全為 0。
    if (this.s[0] === 0 && this.s[1] === 0 && this.s[2] === 0 && this.s[3] === 0) {
      this.s[0] = 0x9e3779b9;
    }
  }

  /** 回傳下一個 32-bit 無號整數。 */
  nextU32(): number {
    const s = this.s;
    const s0 = s[0] as number;
    const s1 = s[1] as number;
    const s2 = s[2] as number;
    const s3 = s[3] as number;

    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0) >>> 0;

    const t = (s1 << 9) >>> 0;

    let n2 = (s2 ^ s0) >>> 0;
    let n3 = (s3 ^ s1) >>> 0;
    const n1 = (s1 ^ n2) >>> 0;
    const n0 = (s0 ^ n3) >>> 0;
    n2 = (n2 ^ t) >>> 0;
    n3 = rotl(n3, 11);

    s[0] = n0;
    s[1] = n1;
    s[2] = n2;
    s[3] = n3;

    return result;
  }

  /** 回傳 [0, 1) 的浮點數，使用 24-bit 尾數以避免捨入到 1.0。 */
  nextFloat(): number {
    return (this.nextU32() >>> 8) / 0x1000000;
  }

  /** 回傳 [min, max) 的浮點數。 */
  nextRange(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /**
   * 目前的內部狀態（4 個 32-bit 無號整數），供 checksum 使用（§9.1）。
   * 回傳複本，呼叫端無法從外部修改 RNG 狀態。
   */
  snapshot(): readonly number[] {
    return [this.s[0] as number, this.s[1] as number, this.s[2] as number, this.s[3] as number];
  }
}
