/**
 * 場地幾何的解析層(§5)。
 *
 * stadium 的半徑 R 與直線段長度 L 一旦改變,以下**全部**必須連動重算:
 * 出界門檻、26 段圍欄的位置與弦長、地板 cuboid、投擲合法範圍。
 * 這些關係散落在 `world.ts`、`judge.ts` 與投擲驗證三處,任何一處漏改都會產生
 * 「看起來對、但判定用的是舊尺寸」的錯誤 —— 因此集中在這裡一次解出。
 *
 * **不指定覆寫時直接回傳 `DEFAULT_ARENA`**,其每個欄位都是 `constants.ts` 的同一個 double,
 * 不做任何重新計算,因此預設路徑與寫死常數時位元完全相同。
 */

import {
  FENCE_OUTER_RADIUS,
  FENCE_THICKNESS,
  FIELD_HALF_SEGMENT,
  FIELD_RADIUS,
  FIELD_SEGMENT_LENGTH,
  FLOOR_HALF_EXTENTS,
  FLOOR_THICKNESS,
  OUT_THRESHOLD,
  THROW_FENCE_MARGIN,
  THROW_MAX_STADIUM_DISTANCE,
} from '../data/constants.js';
import type { PhysicsOverride, Vec3 } from './types.js';

export type ResolvedArena = {
  /** 半圓半徑 R；同時是圍欄內緣到中心線的距離。 */
  fieldRadius: number;
  /** 中央直線段長度 L。 */
  segmentLength: number;
  /** L / 2，stadium 距離函數的夾擠半長。 */
  halfSegment: number;
  /** 圍欄外緣到中心線的距離。 */
  fenceOuterRadius: number;
  /** §8.1 出界門檻。 */
  outThreshold: number;
  /** §7 投擲點允許的最大 stadium 距離。 */
  throwMaxStadiumDistance: number;
  /** 地板 cuboid 的 half-extents。 */
  floorHalfExtents: Vec3;
};

/**
 * 出界門檻在圍欄外緣之外再留的餘裕。
 *
 * 這是**絕對距離**而非比例 —— 它代表「車體整個離開圍欄」所需的額外位移，
 * 與場地大小無關。基線：圍欄外緣 0.40 + 0.05 = 0.45 = `OUT_THRESHOLD`。
 */
const OUT_MARGIN = 0.05;

/** 地板延伸到圍欄外緣之外的距離，同樣是絕對值。基線：0.40 + 0.05 = 0.45 = 地板 half-x。 */
const FLOOR_MARGIN = 0.05;

/**
 * 預設場地：每個欄位都直接取自 `constants.ts`，不做任何算術。
 *
 * 刻意不用下方的推導公式來產生 —— 推導會引入浮點結合律的差異
 * （例如 `0.35 - 0.08` 得到 0.26999999999999996），
 * 直接引用常數才能保證預設路徑位元不變。
 */
export const DEFAULT_ARENA: ResolvedArena = {
  fieldRadius: FIELD_RADIUS,
  segmentLength: FIELD_SEGMENT_LENGTH,
  halfSegment: FIELD_HALF_SEGMENT,
  fenceOuterRadius: FENCE_OUTER_RADIUS,
  outThreshold: OUT_THRESHOLD,
  throwMaxStadiumDistance: THROW_MAX_STADIUM_DISTANCE,
  floorHalfExtents: FLOOR_HALF_EXTENTS,
};

/**
 * 依覆寫解出完整的場地幾何。
 *
 * 只接受 R 與 L 兩個自由度（維持 stadium 形狀）；其餘全部由此推導，
 * 呼叫端無從指定不一致的組合。
 */
export function resolveArena(override?: PhysicsOverride): ResolvedArena {
  const radius = override?.fieldRadius;
  const segment = override?.fieldSegmentLength;
  if (radius === undefined && segment === undefined) return DEFAULT_ARENA;

  const fieldRadius = radius ?? FIELD_RADIUS;
  const segmentLength = segment ?? FIELD_SEGMENT_LENGTH;
  if (!(fieldRadius > 0) || !(segmentLength >= 0)) {
    throw new RangeError(
      `Invalid arena: fieldRadius=${String(fieldRadius)} segmentLength=${String(segmentLength)}`,
    );
  }

  const halfSegment = segmentLength / 2;
  const fenceOuterRadius = fieldRadius + FENCE_THICKNESS;
  const throwMaxStadiumDistance = fieldRadius - THROW_FENCE_MARGIN;
  if (!(throwMaxStadiumDistance > 0)) {
    throw new RangeError(
      `Arena radius ${String(fieldRadius)} leaves no legal throw area ` +
        `(needs > ${String(THROW_FENCE_MARGIN)} m for the §7 fence margin).`,
    );
  }

  return {
    fieldRadius,
    segmentLength,
    halfSegment,
    fenceOuterRadius,
    outThreshold: fenceOuterRadius + OUT_MARGIN,
    throwMaxStadiumDistance,
    floorHalfExtents: {
      x: fenceOuterRadius + FLOOR_MARGIN,
      y: FLOOR_THICKNESS / 2,
      z: halfSegment + fenceOuterRadius + FLOOR_MARGIN,
    },
  };
}

/**
 * Stadium 距離函數（§8.1）。
 *
 * ⚠️ 刻意不使用 `Math.hypot`（§3 禁令 7）—— 見 `judge.ts` 的完整說明。
 */
export function stadiumDistanceIn(halfSegment: number, x: number, z: number): number {
  const dz = Math.max(-halfSegment, Math.min(halfSegment, z));
  const dzz = z - dz;
  return Math.sqrt(x * x + dzz * dzz);
}
