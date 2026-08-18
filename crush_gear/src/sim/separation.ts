/**
 * §7.2 兩車初始分離的幾何判定(第四輪修訂)。
 *
 * ## 為什麼從外接圓改成多邊形
 *
 * 舊規則以「兩個保守外接圓相切」為門檻。對 v1 的細長車尚可,對第四輪的官方規格車
 * 就過度保守到癱瘓投擲區 —— 車長 196 mm、寬僅 90–136 mm,外接圓半徑由後武器後角
 * (25, −98) 決定達 101 mm,但兩台車尾對尾時實際只需約 50 mm 就不重疊。
 * 外接圓把整個投擲區吃掉的面積,幾乎都是實際上合法的姿態。
 *
 * 新規則:以雙方 yaw 與各部件的 XZ 投影多邊形做 2D 判定,要求不重疊且最小間距 ≥ 5 mm。
 * 外接圓保留為**快速預篩** —— 絕大多數投擲對距離很遠,一次比較就能通過。
 *
 * ## 為什麼逐部件而不是整車凸包
 *
 * 官方規格車的 XZ 投影是**十字形**:外殼 90 寬 × 140 長,輪武器向兩側伸到 136 寬但
 * 只有 80 長,前後武器又窄又長。整車凸包會把四個凹角全部填實,面積遠大於實際車體,
 * 那等於換一個比較小的保守形狀而已。
 *
 * 每個部件本身都是凸的(cuboid 與 convex hull),因此逐部件配對做 SAT 是**精確**的,
 * 且 6 × 6 = 36 對的成本在這個規模下可以忽略。
 *
 * ## 決定性
 *
 * 全部是加減乘與比較,除法只在正規化時出現,沒有超越函式除了 yaw 的 sin/cos ——
 * 而後者直接沿用 `types.ts` 的 `quatFromAxisAngle` / `rotateByQuat`,
 * 與模擬本身用的是同一段程式碼,不會出現「驗證與模擬對 yaw 的理解不同」這種分歧。
 */

import { partFootprint, type ResolvedVehicle } from './vehicle-shape.js';
import { quatFromAxisAngle, rotateByQuat, type Vec3 } from './types.js';

export type Point2 = readonly [number, number];
export type Polygon2 = readonly Point2[];

const AXIS_Y: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * 把一台車的所有部件投影到世界 XZ 平面。
 *
 * **刻意忽略 pitch。** pitch 上限 ±0.3 rad 會讓實際投影略為縮短,忽略它得到的是
 * 略大的多邊形 —— 偏保守,不會漏判重疊。而納入 pitch 會讓這裡必須重建完整的
 * 三維旋轉再投影,複雜度與出錯機會都上升,換來的只是更寬鬆的判定。
 */
export function vehicleFootprints(
  shape: ResolvedVehicle,
  x: number,
  z: number,
  yaw: number,
): Polygon2[] {
  const q = quatFromAxisAngle(AXIS_Y, yaw);
  return shape.parts.map((part) =>
    partFootprint(part).map(([px, pz]) => {
      const w = rotateByQuat(q, { x: px, y: 0, z: pz });
      return [x + w.x, z + w.z] as Point2;
    }),
  );
}

/** 多邊形沿某軸的投影區間。 */
function project(poly: Polygon2, ax: number, az: number): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const [px, pz] of poly) {
    const d = px * ax + pz * az;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
}

/**
 * 兩個凸多邊形是否重疊(分離軸定理)。
 *
 * 對凸多邊形而言,若存在任一條邊的法線使兩者投影不相交,即為分離;
 * 檢查雙方所有邊的法線就足夠,不需要其他方向。
 */
export function polygonsIntersect(a: Polygon2, b: Polygon2): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i += 1) {
      const p = poly[i] as Point2;
      const q = poly[(i + 1) % poly.length] as Point2;
      // 邊的法線（不需正規化，只比較是否相交）
      const ax = -(q[1] - p[1]);
      const az = q[0] - p[0];
      if (ax === 0 && az === 0) continue;
      const pa = project(a, ax, az);
      const pb = project(b, ax, az);
      if (pa.max < pb.min || pb.max < pa.min) return false;
    }
  }
  return true;
}

/** 點到線段的距離平方。 */
function pointSegmentDistanceSq(p: Point2, a: Point2, b: Point2): number {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const apx = p[0] - a[0];
  const apz = p[1] - a[1];
  const lenSq = abx * abx + abz * abz;
  let t = lenSq === 0 ? 0 : (apx * abx + apz * abz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = apx - t * abx;
  const dz = apz - t * abz;
  return dx * dx + dz * dz;
}

/**
 * 兩個**不相交**的凸多邊形之間的最小距離。
 *
 * 相交時回傳 0。不相交時最近的一對特徵必定是「一方的頂點對另一方的邊」,
 * 因此掃過所有 (頂點, 邊) 組合即為精確解 —— 不需要 GJK。
 *
 * 注意 SAT 的軸間隙**不是**距離:那只是各面法線方向上的間隙,
 * 頂點對頂點的情形會低估。這也是為什麼距離要另外算而不是沿用 SAT 的結果。
 */
export function polygonDistance(a: Polygon2, b: Polygon2): number {
  if (polygonsIntersect(a, b)) return 0;
  let best = Infinity;
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const p of from) {
      for (let i = 0; i < to.length; i += 1) {
        const s = to[i] as Point2;
        const e = to[(i + 1) % to.length] as Point2;
        const d = pointSegmentDistanceSq(p, s, e);
        if (d < best) best = d;
      }
    }
  }
  return Math.sqrt(best);
}

export type SeparationResult = {
  /** 是否滿足 §7.2。 */
  ok: boolean;
  /** 兩車之間的最小間距(m);重疊時為 0。 */
  distance: number;
  /** 是否由外接圓預篩直接通過(未做多邊形計算)。 */
  viaPrefilter: boolean;
};

/**
 * §7.2 判定。
 *
 * 1. **外接圓預篩**:中心距 ≥ 兩個 maxRadius 相加 + 淨空 ⇒ 必然滿足,直接通過。
 * 2. 否則逐部件配對做多邊形距離,取最小值與淨空比較。
 */
export function checkSeparation(
  shape: ResolvedVehicle,
  a: { x: number; z: number; yaw: number },
  b: { x: number; z: number; yaw: number },
  clearance: number,
): SeparationResult {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  const centreDistance = Math.sqrt(dx * dx + dz * dz);

  if (centreDistance >= 2 * shape.maxRadius + clearance) {
    return { ok: true, distance: centreDistance - 2 * shape.maxRadius, viaPrefilter: true };
  }

  const pa = vehicleFootprints(shape, a.x, a.z, a.yaw);
  const pb = vehicleFootprints(shape, b.x, b.z, b.yaw);

  let min = Infinity;
  for (const polyA of pa) {
    for (const polyB of pb) {
      const d = polygonDistance(polyA, polyB);
      if (d < min) min = d;
      // 已經重疊就不必再算其餘配對。
      if (min === 0) return { ok: false, distance: 0, viaPrefilter: false };
    }
  }
  return { ok: min >= clearance, distance: min, viaPrefilter: false };
}
