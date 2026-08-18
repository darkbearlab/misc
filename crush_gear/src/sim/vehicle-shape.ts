/**
 * 車體幾何的解析層(§6.1、§6.3)。
 *
 * 與 `arena.ts` 同一個模式:車體尺寸一旦改變,以下**全部**必須連動重算 ——
 * 各部件 collider、輪位錨點、輪距/軸距、車體最低點、最遠水平半徑
 * (進而是 §7.1 的投擲餘裕與 §7.2 的兩車最小距離)。
 *
 * **不指定覆寫時直接回傳 `DEFAULT_VEHICLE`**,其每個欄位都是 `constants.ts` 的同一個
 * double / 同一個陣列,不做任何算術,因此預設路徑與寫死常數時位元完全相同。
 *
 * ## 部件模型
 *
 * 車體是**一顆 RigidBody 掛載 N 個 collider**,順序固定(§9.3 要求力與建立順序固定)。
 * v1 是兩個(底盤 + 前武器);第四輪的官方規格車是六個。
 * 質量、重心、慣量三者全部由幾何與質量分配衍生,不得人為指定任何一項(§6.2)。
 */

import {
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  CHASSIS_OFFSET,
  SUSPENSION_REST_LENGTH,
  SUSPENSION_STIFFNESS,
  TRACK_WIDTH,
  WEAPON_HULL,
  WEAPON_MASS,
  WHEELBASE,
  WHEEL_ANCHORS,
} from '../data/constants.js';
import type { Vec3, VehicleOverride, VehiclePresetName } from './types.js';

export type Point3 = readonly [number, number, number];

/** 單一 collider。順序即建立順序,不得重排(§9.3)。 */
export type VehiclePart =
  | { kind: 'cuboid'; name: string; halfExtents: Vec3; offset: Vec3; mass: number }
  | { kind: 'hull'; name: string; points: readonly Point3[]; mass: number };

export type ResolvedVehicle = {
  parts: readonly VehiclePart[];
  totalMass: number;
  wheelAnchors: readonly Point3[];
  trackWidth: number;
  wheelbase: number;
  /** 車體所有 collider 的最低點(局部座標)。 */
  lowestY: number;
  /** 車體原點至最遠幾何點的**水平**距離。 */
  maxRadius: number;
  /** 供報表使用的整車外框(m)。 */
  totalLength: number;
  totalWidth: number;
  totalHeight: number;
  /**
   * 輪武器是否參與地面碰撞。
   *
   * `false` 時輪武器仍存在、仍會與對手車碰撞,只是不與地板碰撞 ——
   * 這是第四輪要求的對照組,用來判斷它的穩定效果是否真實存在。
   */
  wheelWeaponHitsGround: boolean;
};

// ──────────────────────────────────────────────────────────────────────────
// 幾何工具
// ──────────────────────────────────────────────────────────────────────────

/** 一個部件在局部座標下的所有角點。cuboid 展開成 8 個角,hull 直接用頂點。 */
export function partCorners(part: VehiclePart): Point3[] {
  if (part.kind === 'hull') return [...part.points];
  const { halfExtents: h, offset: o } = part;
  const out: Point3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push([o.x + sx * h.x, o.y + sy * h.y, o.z + sz * h.z]);
      }
    }
  }
  return out;
}

/** 部件在 XZ 平面上的投影凸多邊形(順序為凸包順序)。§7.2 的 SAT 用。 */
export function partFootprint(part: VehiclePart): readonly (readonly [number, number])[] {
  if (part.kind === 'cuboid') {
    const { halfExtents: h, offset: o } = part;
    return [
      [o.x - h.x, o.z - h.z],
      [o.x + h.x, o.z - h.z],
      [o.x + h.x, o.z + h.z],
      [o.x - h.x, o.z + h.z],
    ];
  }
  return convexHull2d(part.points.map((p) => [p[0], p[2]] as const));
}

/**
 * 2D 凸包(Andrew monotone chain)。
 *
 * 純比較與加減乘,沒有除法也沒有超越函式 —— 結果與平台無關(§16)。
 */
export function convexHull2d(
  points: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const sorted = [...points].sort((a, b) => (a[0] - b[0] !== 0 ? a[0] - b[0] : a[1] - b[1]));
  if (sorted.length <= 2) return sorted;

  const cross = (
    o: readonly [number, number],
    a: readonly [number, number],
    b: readonly [number, number],
  ): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const build = (pts: readonly (readonly [number, number])[]): (readonly [number, number])[] => {
    const stack: (readonly [number, number])[] = [];
    for (const p of pts) {
      while (
        stack.length >= 2 &&
        cross(stack[stack.length - 2] as readonly [number, number],
              stack[stack.length - 1] as readonly [number, number], p) <= 0
      ) {
        stack.pop();
      }
      stack.push(p);
    }
    stack.pop();
    return stack;
  };

  return [...build(sorted), ...build([...sorted].reverse())];
}

function computeLowestY(parts: readonly VehiclePart[]): number {
  let lowest = Infinity;
  for (const part of parts) {
    for (const c of partCorners(part)) {
      if (c[1] < lowest) lowest = c[1];
    }
  }
  return lowest;
}

/** 水平最遠半徑:所有部件的所有角點,取 XZ 模長最大者。 */
function computeMaxRadius(parts: readonly VehiclePart[]): number {
  let maxSquared = 0;
  for (const part of parts) {
    for (const c of partCorners(part)) {
      const r2 = c[0] * c[0] + c[2] * c[2];
      if (r2 > maxSquared) maxSquared = r2;
    }
  }
  return Math.sqrt(maxSquared);
}

function extent(parts: readonly VehiclePart[], axis: 0 | 1 | 2): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const part of parts) {
    for (const c of partCorners(part)) {
      if (c[axis] < lo) lo = c[axis];
      if (c[axis] > hi) hi = c[axis];
    }
  }
  return hi - lo;
}

// ──────────────────────────────────────────────────────────────────────────
// v1 車體（PHYSICS_VERSION = 1，凍結）
// ──────────────────────────────────────────────────────────────────────────

/** V1 全長 = 底盤後緣 −0.050 至刃口 0.100 = 0.150 m。 */
export const V1_TOTAL_LENGTH = 0.15;
/** V1 底盤寬 = 2 × 0.035 = 0.070 m。 */
export const V1_CHASSIS_WIDTH = 0.07;
/** V1 全高 = 車體垂直範圍 = 0.015 − (−0.010) = 0.025 m（非離地全高）。 */
export const V1_TOTAL_HEIGHT = 0.025;

const V1_PARTS: readonly VehiclePart[] = [
  {
    kind: 'cuboid',
    name: 'chassis',
    halfExtents: CHASSIS_HALF_EXTENTS,
    offset: CHASSIS_OFFSET,
    mass: CHASSIS_MASS,
  },
  { kind: 'hull', name: 'front-weapon', points: WEAPON_HULL, mass: WEAPON_MASS },
];

/**
 * 預設車體:每個欄位都直接取自 `constants.ts`,不做任何算術。
 *
 * `maxRadius` 與 `lowestY` 是推導值,但只由常數推導一次,與 v1 寫死時相同。
 */
export const DEFAULT_VEHICLE: ResolvedVehicle = {
  parts: V1_PARTS,
  totalMass: CHASSIS_MASS + WEAPON_MASS,
  wheelAnchors: WHEEL_ANCHORS,
  trackWidth: TRACK_WIDTH,
  wheelbase: WHEELBASE,
  lowestY: computeLowestY(V1_PARTS),
  maxRadius: computeMaxRadius(V1_PARTS),
  totalLength: V1_TOTAL_LENGTH,
  totalWidth: V1_CHASSIS_WIDTH,
  totalHeight: V1_TOTAL_HEIGHT,
  wheelWeaponHitsGround: false,
};

// ──────────────────────────────────────────────────────────────────────────
// 第四輪：依官方部件上限重建的車體
// ──────────────────────────────────────────────────────────────────────────

/**
 * 官方規格車(第四輪)。**取代第三輪的等比放大方案。**
 *
 * ## 座標系與基準面
 *
 * 局部原點取在**輪軸平面**(y = 0 即輪心高度)。這樣選是因為離地高才是規則約束的量,
 * 而輪軸離地高 = `SUSPENSION_REST_LENGTH − 靜態壓縮`,是懸吊直接決定的:
 *
 * ```
 * 靜態壓縮  = m·g / (4k) = 0.165 × 9.81 / 1200 = 1.3489 mm
 * 原點離地高 = 25 − 1.3489                     = 23.6511 mm
 * 局部 y     = 離地高 − 23.6511
 * ```
 *
 * 懸吊參數(restLength / maxTravel / k / c)**維持不變**,因此輪半徑取 25 mm
 * (輪頂離地 50 mm ≤ 底盤含輪上限 55 mm)。
 *
 * ## 形態:寬扁,不是細長
 *
 * 底盤長 100 而寬 140,是官方部件表最反直覺的一點 —— 實物是**寬扁形**。
 * 車身外殼反而較長(140)較窄(90),兩側各約 23 mm 由輪武器填滿至全寬 136。
 * 100 + 65 + 65 = 230 > 200,故前後武器與底盤在 Z 上**必然重疊**,不可首尾相接。
 *
 * 由此得到 track 110 / wheelbase 70 —— **輪距大於軸距**,與 v1(56 / 70)相反。
 * 這會直接改變 roll 與 pitch 的相對穩定性。
 *
 * ## 1–10 mm 特許區間本輪不使用
 *
 * 官方規則允許前後武器進入離地 1–10 mm(其餘零件不得),那是「貼地插入對手車底」的
 * 規則來源。本輪不實作該機制,因此前武器底面與其餘部件同樣設在 12 mm。
 */
const OFFICIAL_ORIGIN_HEIGHT_MM =
  SUSPENSION_REST_LENGTH * 1000 - (0.165 * 9.81) / (4 * SUSPENSION_STIFFNESS) * 1000;

/** 離地高(mm) → 局部 y(m)。 */
function fromGround(mm: number): number {
  return (mm - OFFICIAL_ORIGIN_HEIGHT_MM) / 1000;
}

/** mm → m。純粹為了讓下面的座標表讀起來就是規則書上的數字。 */
const mm = (v: number): number => v / 1000;

const OFFICIAL_PARTS_BASE: readonly VehiclePart[] = [
  // 底盤：100(Z) × 90(X) × 16(Y)，離地 14–30。最重，含 2 顆 AA 電池與馬達。
  {
    kind: 'cuboid',
    name: 'base',
    halfExtents: { x: mm(45), y: mm(8), z: mm(50) },
    offset: { x: 0, y: fromGround(22), z: 0 },
    mass: 0.095,
  },
  // 車身外殼：140(Z) × 90(X) × 42(Y)，離地 30–72。薄塑膠殼，明顯較輕。
  {
    kind: 'cuboid',
    name: 'shell',
    halfExtents: { x: mm(45), y: mm(21), z: mm(70) },
    offset: { x: 0, y: fromGround(51), z: 0 },
    mass: 0.03,
  },
  // 前武器：楔形，根部 z=33 寬 55 高 36，刃口 z=98 寬 12。
  // 刃口保留 12 mm 寬不收成尖點 —— 退化的 hull 會讓碰撞法線不穩定（同 v1 的理由）。
  {
    kind: 'hull',
    name: 'front-weapon',
    points: [
      [-mm(27.5), fromGround(12), mm(33)],
      [mm(27.5), fromGround(12), mm(33)],
      [-mm(27.5), fromGround(48), mm(33)],
      [mm(27.5), fromGround(48), mm(33)],
      [-mm(6), fromGround(12), mm(98)],
      [mm(6), fromGround(12), mm(98)],
      [-mm(6), fromGround(30), mm(98)],
      [mm(6), fromGround(30), mm(98)],
    ],
    mass: 0.022,
  },
  // 後武器：65(Z) × 50(X) × 25(Y)，離地 12–37，Z −98…−33。高度剛好頂到上限。
  {
    kind: 'cuboid',
    name: 'rear-weapon',
    halfExtents: { x: mm(25), y: mm(12.5), z: mm(32.5) },
    offset: { x: 0, y: fromGround(24.5), z: -mm(65.5) },
    mass: 0.01,
  },
  // 輪武器 ×2：X 45…68（每側 23 mm），Z ±40，離地 12–32。
  // 實物裝在輪上並隨輪旋轉，但本專案的輪子不是剛體（§6.4），無法承載旋轉碰撞體，
  // 因此簡化為固定於車體、向兩側伸出的靜態 collider。見 TUNING_PHASE15.md。
  {
    kind: 'cuboid',
    name: 'wheel-weapon-left',
    halfExtents: { x: mm(11.5), y: mm(10), z: mm(40) },
    offset: { x: -mm(56.5), y: fromGround(22), z: 0 },
    mass: 0.004,
  },
  {
    kind: 'cuboid',
    name: 'wheel-weapon-right',
    halfExtents: { x: mm(11.5), y: mm(10), z: mm(40) },
    offset: { x: mm(56.5), y: fromGround(22), z: 0 },
    mass: 0.004,
  },
];

/** 輪武器的部件名稱,供「是否參與地面碰撞」的對照組使用。 */
export const WHEEL_WEAPON_NAMES = ['wheel-weapon-left', 'wheel-weapon-right'] as const;

const OFFICIAL_TRACK_WIDTH = mm(110);
const OFFICIAL_WHEELBASE = mm(70);

/** 順序固定為 左前、右前、左後、右後（§9.3）。錨點落在輪武器的水平投影內。 */
const OFFICIAL_ANCHORS: readonly Point3[] = [
  [-OFFICIAL_TRACK_WIDTH / 2, 0, OFFICIAL_WHEELBASE / 2],
  [OFFICIAL_TRACK_WIDTH / 2, 0, OFFICIAL_WHEELBASE / 2],
  [-OFFICIAL_TRACK_WIDTH / 2, 0, -OFFICIAL_WHEELBASE / 2],
  [OFFICIAL_TRACK_WIDTH / 2, 0, -OFFICIAL_WHEELBASE / 2],
];

function buildOfficial(wheelWeaponHitsGround: boolean): ResolvedVehicle {
  const parts = OFFICIAL_PARTS_BASE;
  return {
    parts,
    totalMass: parts.reduce((sum, p) => sum + p.mass, 0),
    wheelAnchors: OFFICIAL_ANCHORS,
    trackWidth: OFFICIAL_TRACK_WIDTH,
    wheelbase: OFFICIAL_WHEELBASE,
    lowestY: computeLowestY(parts),
    maxRadius: computeMaxRadius(parts),
    totalLength: extent(parts, 2),
    totalWidth: extent(parts, 0),
    totalHeight: extent(parts, 1),
    wheelWeaponHitsGround,
  };
}

export const OFFICIAL_VEHICLE: ResolvedVehicle = buildOfficial(true);
/** 對照組：輪武器不參與地面碰撞，其餘完全相同。 */
export const OFFICIAL_VEHICLE_NO_GROUND: ResolvedVehicle = buildOfficial(false);

// ──────────────────────────────────────────────────────────────────────────
// 解析
// ──────────────────────────────────────────────────────────────────────────

const PRESETS: Record<VehiclePresetName, ResolvedVehicle> = {
  official: OFFICIAL_VEHICLE,
  'official-no-ground-wheel-weapon': OFFICIAL_VEHICLE_NO_GROUND,
};

/**
 * 依覆寫解出完整的車體幾何。
 *
 * 兩條路徑:
 *   - `preset`:第四輪的官方規格車(明確的頂點表)
 *   - `override`:第三輪的等比放大(V1/V2/V3),保留供 `tools/vehicle-scan.ts` 使用
 *
 * 兩者都不指定時回傳 `DEFAULT_VEHICLE`。
 */
export function resolveVehicle(
  override?: VehicleOverride,
  preset?: VehiclePresetName,
): ResolvedVehicle {
  if (preset !== undefined) return PRESETS[preset];
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

  const parts: VehiclePart[] = [
    {
      kind: 'cuboid',
      name: 'chassis',
      halfExtents: {
        x: CHASSIS_HALF_EXTENTS.x * sW,
        y: CHASSIS_HALF_EXTENTS.y * sH,
        z: CHASSIS_HALF_EXTENTS.z * sL,
      },
      offset: {
        x: CHASSIS_OFFSET.x * sW,
        y: CHASSIS_OFFSET.y * sH,
        z: CHASSIS_OFFSET.z * sL,
      },
      mass: CHASSIS_MASS,
    },
    {
      kind: 'hull',
      name: 'front-weapon',
      points: WEAPON_HULL.map((p) => [p[0] * sW, p[1] * sH, p[2] * sL] as Point3),
      mass: WEAPON_MASS,
    },
  ];

  const wheelbase = WHEELBASE * sTrack;
  const anchorY = (WHEEL_ANCHORS[0]?.[1] as number) * sH;
  const halfTrack = trackWidth / 2;
  const halfBase = wheelbase / 2;

  return {
    parts,
    totalMass: CHASSIS_MASS + WEAPON_MASS,
    wheelAnchors: [
      [-halfTrack, anchorY, halfBase],
      [halfTrack, anchorY, halfBase],
      [-halfTrack, anchorY, -halfBase],
      [halfTrack, anchorY, -halfBase],
    ],
    trackWidth,
    wheelbase,
    lowestY: computeLowestY(parts),
    maxRadius: computeMaxRadius(parts),
    totalLength,
    totalWidth: chassisWidth,
    totalHeight,
    wheelWeaponHitsGround: false,
  };
}
