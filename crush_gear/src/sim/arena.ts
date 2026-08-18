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
import { DEFAULT_VEHICLE, resolveVehicle, type ResolvedVehicle } from './vehicle-shape.js';

export type ResolvedArena = {
  /** 半圓半徑 R;同時是圍欄內緣到中心線的距離。 */
  fieldRadius: number;
  /** 中央直線段長度 L。 */
  segmentLength: number;
  /** L / 2,stadium 距離函數的夾擠半長。 */
  halfSegment: number;
  /** 圍欄外緣到中心線的距離。 */
  fenceOuterRadius: number;
  /** §8.1 出界門檻。 */
  outThreshold: number;
  /** §7.1 投擲點允許的最大 stadium 距離。 */
  throwMaxStadiumDistance: number;
  /** 實際採用的投擲餘裕(R − throwMaxStadiumDistance)。 */
  throwMargin: number;
  /** 車體原點至最遠幾何點的水平距離,由車體常數衍生。 */
  vehicleMaxRadius: number;
  /**
   * §7.2 兩車投擲點所需的最小水平距離。
   *
   * `enforceMinThrowSeparation` 未開啟時為 0(不約束),見 `resolveArena()`。
   */
  minThrowSeparation: number;
  /** 地板 cuboid 的 half-extents。 */
  floorHalfExtents: Vec3;
};

/**
 * 出界門檻在圍欄外緣之外再留的餘裕。
 *
 * 這是**絕對距離**而非比例 —— 它代表「車體整個離開圍欄」所需的額外位移,
 * 與場地大小無關。基線:圍欄外緣 0.40 + 0.05 = 0.45 = `OUT_THRESHOLD`。
 */
const OUT_MARGIN = 0.05;

/** 地板延伸到圍欄外緣之外的距離,同樣是絕對值。基線:0.40 + 0.05 = 0.45 = 地板 half-x。 */
const FLOOR_MARGIN = 0.05;

/**
 * 車體原點至最遠幾何點的**水平**距離(V1 車體),由車體常數衍生,不得硬編。
 *
 * 取水平距離而非 3D 距離:圍欄是垂直牆面,車體能否穿入只取決於 XZ 平面上的伸出量。
 * V1 值 ≈ 0.10008 m,最遠點是前武器刃口 (±0.004, 0.100);
 * 底盤最遠角 (0.035, 0.050) 只有 0.0611 m。
 *
 * **場地與車體尺寸的連動關係集中在此** —— 車體一放大,投擲餘裕與兩車最小距離
 * 自動跟著變大(見 `resolveArena()` 的 `override.vehicle` 分支)。
 */
export const VEHICLE_MAX_RADIUS = DEFAULT_VEHICLE.maxRadius;

/**
 * 車體最遠點與圍欄內緣之間要保留的淨空(§7.1)。
 *
 * 投擲餘裕 = maxRadius + THROW_CLEARANCE,V1 車體合計約 0.12 m。
 */
export const THROW_CLEARANCE = 0.02;

/**
 * 兩車最小距離在「兩個最遠半徑相加」之外再留的容差(§7.2)。
 *
 * 以**幾何判定**(投擲點距離)而非碰撞體重疊檢測 —— 後者需要先建立世界才能判斷,
 * 會破壞「參數驗證先於模擬」的分層。保守外接圓已足夠,多出的 5 mm 是容差。
 */
export const MIN_SEPARATION_CLEARANCE = 0.005;

/** §7.1 新版投擲餘裕:與車長掛鉤,不再是固定的 0.08 m。 */
export function vehicleDerivedThrowMargin(vehicle: ResolvedVehicle = DEFAULT_VEHICLE): number {
  return vehicle.maxRadius + THROW_CLEARANCE;
}

/** §7.2 兩車投擲點所需的最小水平距離。 */
export function minThrowSeparation(vehicle: ResolvedVehicle = DEFAULT_VEHICLE): number {
  return 2 * vehicle.maxRadius + MIN_SEPARATION_CLEARANCE;
}

/**
 * 預設場地:每個欄位都直接取自 `constants.ts`,不做任何算術。
 *
 * 刻意不用下方的推導公式來產生 —— 推導會引入浮點結合律的差異
 * (例如 `0.35 - 0.08` 得到 0.26999999999999996),
 * 直接引用常數才能保證預設路徑位元不變。
 *
 * `minThrowSeparation` 為 0:v1 的物理不含 §7.2 約束(20 組 fixture 中有投擲點違反它)。
 */
export const DEFAULT_ARENA: ResolvedArena = {
  fieldRadius: FIELD_RADIUS,
  segmentLength: FIELD_SEGMENT_LENGTH,
  halfSegment: FIELD_HALF_SEGMENT,
  fenceOuterRadius: FENCE_OUTER_RADIUS,
  outThreshold: OUT_THRESHOLD,
  throwMaxStadiumDistance: THROW_MAX_STADIUM_DISTANCE,
  throwMargin: THROW_FENCE_MARGIN,
  vehicleMaxRadius: VEHICLE_MAX_RADIUS,
  minThrowSeparation: 0,
  floorHalfExtents: FLOOR_HALF_EXTENTS,
};

/**
 * 依覆寫解出完整的場地幾何。
 *
 * 場地只接受 R 與 L 兩個自由度(維持 stadium 形狀);其餘全部由此推導,
 * 呼叫端無從指定不一致的組合。車體尺寸的覆寫也在此吃進來 ——
 * §7.1 的投擲餘裕與 §7.2 的最小距離都由車體的 `maxRadius` 衍生。
 *
 * **投擲餘裕與最小距離的兩個版本**:
 * §7.1 已改為與車長掛鉤(`maxRadius + THROW_CLEARANCE`,V1 ≈ 0.12 m),
 * §7.2 新增兩車最小距離(`2 × maxRadius + 0.005`,V1 ≈ 0.205 m),
 * 但 `PHYSICS_VERSION = 1` 的物理凍結在舊規則 —— 換成新規則會使既有的 20 組 fixture
 * 中 14 個投擲點超出餘裕、另有若干組違反最小距離,v1 的 baseline 將無法驗證。
 * 因此兩者都須以旗標明確開啟,正式採用時連同升版與 fixture 重產一起進行。
 */
export function resolveArena(override?: PhysicsOverride): ResolvedArena {
  const radius = override?.fieldRadius;
  const segment = override?.fieldSegmentLength;
  const vehicleOverride = override?.vehicle;
  const preset = override?.vehiclePreset;
  const wantsMargin = override?.vehicleDerivedThrowMargin === true;
  const wantsSeparation = override?.enforceMinThrowSeparation === true;
  if (
    radius === undefined &&
    segment === undefined &&
    vehicleOverride === undefined &&
    preset === undefined &&
    !wantsMargin &&
    !wantsSeparation
  ) {
    return DEFAULT_ARENA;
  }

  const vehicle = resolveVehicle(vehicleOverride, preset);

  const fieldRadius = radius ?? FIELD_RADIUS;
  const segmentLength = segment ?? FIELD_SEGMENT_LENGTH;
  if (!(fieldRadius > 0) || !(segmentLength >= 0)) {
    throw new RangeError(
      `Invalid arena: fieldRadius=${String(fieldRadius)} segmentLength=${String(segmentLength)}`,
    );
  }

  const halfSegment = segmentLength / 2;
  const fenceOuterRadius = fieldRadius + FENCE_THICKNESS;

  // §7.1 投擲餘裕。新版與車長掛鉤,但 v1 的物理凍結在舊的固定值 —— 見上方註解。
  const throwMargin = wantsMargin ? vehicleDerivedThrowMargin(vehicle) : THROW_FENCE_MARGIN;
  const throwMaxStadiumDistance = fieldRadius - throwMargin;
  if (!(throwMaxStadiumDistance > 0)) {
    throw new RangeError(
      `Arena radius ${String(fieldRadius)} leaves no legal throw area ` +
        `(needs > ${String(throwMargin)} m for the §7.1 throw margin).`,
    );
  }

  return {
    fieldRadius,
    segmentLength,
    halfSegment,
    fenceOuterRadius,
    outThreshold: fenceOuterRadius + OUT_MARGIN,
    throwMaxStadiumDistance,
    throwMargin,
    vehicleMaxRadius: vehicle.maxRadius,
    minThrowSeparation: wantsSeparation ? minThrowSeparation(vehicle) : 0,
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
