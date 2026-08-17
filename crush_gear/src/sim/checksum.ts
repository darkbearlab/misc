/**
 * 狀態雜湊（§9.2）。
 *
 * 關鍵規則：浮點數不得直接雜湊。所有數值先量化為整數再逐位元組餵入 FNV-1a 32-bit。
 * 量化把 1e-7 以下的差異抹平，使得跨平台／跨執行的微小浮點噪音不會影響 checksum，
 * 但仍足以偵測真正的模擬分歧。
 */

import type { Quat, Vec3 } from './types.js';

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 量化：保留到小數第 6 位，並截斷為 32-bit 有號整數。 */
export function quantize(v: number): number {
  return Math.round(v * 1e6) | 0;
}

/** 增量式 FNV-1a 32-bit 雜湊器。餵入順序即為雜湊語意的一部分。 */
export class Fnv1a {
  private h = FNV_OFFSET_BASIS >>> 0;

  /** 餵入單一位元組（只取低 8 bit）。 */
  pushByte(b: number): void {
    this.h = (this.h ^ (b & 0xff)) >>> 0;
    this.h = Math.imul(this.h, FNV_PRIME) >>> 0;
  }

  /** 餵入一個 32-bit 整數，little-endian，4 個位元組。 */
  pushU32(v: number): void {
    const u = v >>> 0;
    this.pushByte(u);
    this.pushByte(u >>> 8);
    this.pushByte(u >>> 16);
    this.pushByte(u >>> 24);
  }

  /** 量化後餵入一個浮點數。 */
  pushFloat(v: number): void {
    this.pushU32(quantize(v));
  }

  /** 依 x, y, z 順序餵入向量。 */
  pushVec3(v: Vec3): void {
    this.pushFloat(v.x);
    this.pushFloat(v.y);
    this.pushFloat(v.z);
  }

  /** 依 x, y, z, w 順序餵入四元數。 */
  pushQuat(q: Quat): void {
    this.pushFloat(q.x);
    this.pushFloat(q.y);
    this.pushFloat(q.z);
    this.pushFloat(q.w);
  }

  /** 目前的雜湊值（32-bit 無號）。 */
  digest(): number {
    return this.h >>> 0;
  }
}

/** 單台車納入雜湊的狀態，順序固定：位置 → 旋轉 → 線速度 → 角速度。 */
export type VehicleChecksumState = {
  translation: Vec3;
  rotation: Quat;
  linvel: Vec3;
  angvel: Vec3;
};

/**
 * 計算一幀的 state checksum。
 *
 * 餵入順序（不得更動，任何更動都會使既有 replay 檔失效）：
 *   1. 車 A：質心位置、旋轉四元數、線速度、角速度
 *   2. 車 B：同上
 *   3. RNG 內部狀態（4 個 u32）
 */
export function checksumFrame(
  vehicles: readonly VehicleChecksumState[],
  rngState: readonly number[],
): number {
  const h = new Fnv1a();
  for (let i = 0; i < vehicles.length; i += 1) {
    const v = vehicles[i] as VehicleChecksumState;
    h.pushVec3(v.translation);
    h.pushQuat(v.rotation);
    h.pushVec3(v.linvel);
    h.pushVec3(v.angvel);
  }
  for (let i = 0; i < rngState.length; i += 1) {
    h.pushU32(rngState[i] as number);
  }
  return h.digest();
}
