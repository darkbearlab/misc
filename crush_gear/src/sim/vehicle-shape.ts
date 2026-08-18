/**
 * 車體幾何的解析層(§6.1、§6.3)。
 *
 * 與 `arena.ts` 同一個模式:車體尺寸一旦改變,以下**全部**必須連動重算 ——
 * 底盤 half-extents、前武器 hull、輪位錨點、輪距/軸距、車體最低點、
 * 最遠幾何半徑(進而是 §7.1 的投擲餘裕與 §7.2 的兩車最小距離)。
 * 散落各處會產生「看起來對、但某一處還在用舊尺寸」的錯誤,因此集中在這裡一次解出。
 *
 * **不指定覆寫時直接回傳 `DEFAULT_VEHICLE`**,其每個欄位都是 `constants.ts` 的同一個
 * double / 同一個陣列,不做任何算術,因此預設路徑與寫死常數時位元完全相同。
 *
 * ## 放大規則(不是等比縮放)
 *
 * 三個獨立的縮放因子,由三個目標尺寸反推:
 *
 * | 因子 | 定義 | 影響 |
 * |---|---|---|
 * | `sL` | 全長 / 0.150 | 底盤 z、hull z |
 * | `sW` | 底盤寬 / 0.070 | 底盤 x、hull x |
 * | `sH` | 全高 / 0.025 | 底盤 y、hull y、錨點 y、底盤 y 位移 |
 *
 * **質量固定不隨尺寸變化**(0.11 / 0.04,合計 0.15 kg):
 * 實物質量主要來自電池與馬達,不隨外殼放大;官方車檢上限 180 g,現行 150 g 已無太多空間。
 * 因此放大等同於降低密度,慣量仍由 Rapier 依幾何與質量分配自動合成(§6.2)。
 *
 * **懸吊參數(restLength / maxTravel / k / c)不隨尺寸變化** —— 由呼叫端另行確認
 * 三模態的 |r| < 1 是否仍成立(§6.4)。
 */

import {
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  CHASSIS_OFFSET,
  TRACK_WIDTH,
  WEAPON_HULL,
  WEAPON_MASS,
  WHEELBASE,
  WHEEL_ANCHORS,
} from '../data/constants.js';
import type { Vec3, VehicleOverride } from './types.js';

export type Point3 = readonly [number, number, number];

export type ResolvedVehicle = {
  chassisHalfExtents: Vec3;
  chassisOffset: Vec3;
  chassisMass: number;
  weaponHull: readonly Point3[];
  weaponMass: number;
  totalMass: number;
  wheelAnchors: readonly Point3[];
  trackWidth: number;
  wheelbase: number;
  /** 車體所有 collider 的最低點(局部座標)。 */
  lowestY: number;
  /** 車體原點至最遠幾何點的**水平**距離。 */
  maxRadius: number;
  /** 全長 / 底盤寬 / 全高,供報表使用。 */
  totalLength: number;
  chassisWidth: number;
  totalHeight: number;
};

// ── V1 的量測基準（由 constants.ts 反推，供縮放因子使用） ──────────────────

/** V1 全長 = 底盤後緣 −0.050 至刃口 0.100 = 0.150 m。 */
export const V1_TOTAL_LENGTH = 0.15;
/** V1 底盤寬 = 2 × 0.035 = 0.070 m。 */
export const V1_CHASSIS_WIDTH = 0.07;
/**
 * V1 全高 = 車體垂直範圍 = 底盤頂 0.015 − 底盤底 −0.010 = **0.025 m**。
 *
 * 注意這是**車體自身的垂直範圍**,不是實物車檢意義下的「離地全高」;
 * 後者在靜態行駛高度 0.02904 下約為 0.044 m。
 */
export const V1_TOTAL_HEIGHT = 0.025;

/** 水平最遠半徑:底盤四角與 hull 全部頂點的 XZ 模長取最大。 */
export function computeMaxRadius(
  chassisHalfExtents: Vec3,
  weaponHull: readonly Point3[],
): number {
  let maxSquared = 0;
  const consider = (x: number, z: number): void => {
    const r2 = x * x + z * z;
    if (r2 > maxSquared) maxSquared = r2;
  };
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      consider(sx * chassisHalfExtents.x, sz * chassisHalfExtents.z);
    }
  }
  for (const p of weaponHull) consider(p[0], p[2]);
  return Math.sqrt(maxSquared);
}

function computeLowestY(
  chassisOffset: Vec3,
  chassisHalfExtents: Vec3,
  weaponHull: readonly Point3[],
): number {
  return Math.min(chassisOffset.y - chassisHalfExtents.y, ...weaponHull.map((p) => p[1]));
}

/**
 * 預設車體:每個欄位都直接取自 `constants.ts`,不做任何算術。
 *
 * `maxRadius` 與 `lowestY` 是推導值,但只由常數推導一次,與 v1 寫死時相同。
 */
export const DEFAULT_VEHICLE: ResolvedVehicle = {
  chassisHalfExtents: CHASSIS_HALF_EXTENTS,
  chassisOffset: CHASSIS_OFFSET,
  chassisMass: CHASSIS_MASS,
  weaponHull: WEAPON_HULL,
  weaponMass: WEAPON_MASS,
  totalMass: CHASSIS_MASS + WEAPON_MASS,
  wheelAnchors: WHEEL_ANCHORS,
  trackWidth: TRACK_WIDTH,
  wheelbase: WHEELBASE,
  lowestY: computeLowestY(CHASSIS_OFFSET, CHASSIS_HALF_EXTENTS, WEAPON_HULL),
  maxRadius: computeMaxRadius(CHASSIS_HALF_EXTENTS, WEAPON_HULL),
  totalLength: V1_TOTAL_LENGTH,
  chassisWidth: V1_CHASSIS_WIDTH,
  totalHeight: V1_TOTAL_HEIGHT,
};

/**
 * 依覆寫解出完整的車體幾何。
 *
 * 只接受四個自由度:全長、底盤寬、全高、輪距。其餘全部由此推導,
 * 呼叫端無從指定不一致的組合(例如「錨點在底盤外」)。
 *
 * 軸距隨輪距等比(兩者同屬「輪位」,一起縮放),不獨立指定。
 */
export function resolveVehicle(override?: VehicleOverride): ResolvedVehicle {
  if (override === undefined) return DEFAULT_VEHICLE;

  const { totalLength, chassisWidth, totalHeight, trackWidth } = override;
  for (const [name, value] of [
    ['totalLength', totalLength],
    ['chassisWidth', chassisWidth],
    ['totalHeight', totalHeight],
    ['trackWidth', trackWidth],
  ] as const) {
    if (!(value > 0)) throw new RangeError(`VehicleOverride.${name} must be > 0, got ${value}.`);
  }

  const sL = totalLength / V1_TOTAL_LENGTH;
  const sW = chassisWidth / V1_CHASSIS_WIDTH;
  const sH = totalHeight / V1_TOTAL_HEIGHT;
  const sTrack = trackWidth / TRACK_WIDTH;

  const chassisHalfExtents: Vec3 = {
    x: CHASSIS_HALF_EXTENTS.x * sW,
    y: CHASSIS_HALF_EXTENTS.y * sH,
    z: CHASSIS_HALF_EXTENTS.z * sL,
  };
  const chassisOffset: Vec3 = {
    x: CHASSIS_OFFSET.x * sW,
    y: CHASSIS_OFFSET.y * sH,
    z: CHASSIS_OFFSET.z * sL,
  };
  const weaponHull: Point3[] = WEAPON_HULL.map((p) => [p[0] * sW, p[1] * sH, p[2] * sL]);

  const wheelbase = WHEELBASE * sTrack;
  const anchorY = (WHEEL_ANCHORS[0]?.[1] as number) * sH;
  const halfTrack = trackWidth / 2;
  const halfBase = wheelbase / 2;
  // 順序固定為 左前、右前、左後、右後（§9.3 要求力的施加順序固定）。
  const wheelAnchors: Point3[] = [
    [-halfTrack, anchorY, halfBase],
    [halfTrack, anchorY, halfBase],
    [-halfTrack, anchorY, -halfBase],
    [halfTrack, anchorY, -halfBase],
  ];

  return {
    chassisHalfExtents,
    chassisOffset,
    chassisMass: CHASSIS_MASS,
    weaponHull,
    weaponMass: WEAPON_MASS,
    totalMass: CHASSIS_MASS + WEAPON_MASS,
    wheelAnchors,
    trackWidth,
    wheelbase,
    lowestY: computeLowestY(chassisOffset, chassisHalfExtents, weaponHull),
    maxRadius: computeMaxRadius(chassisHalfExtents, weaponHull),
    totalLength,
    chassisWidth,
    totalHeight,
  };
}
