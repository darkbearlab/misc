/**
 * 輪胎力模型（§6.4）—— 本專案的物理核心，純函式，無副作用。
 *
 * 物理前提：戰鬥車輪胎接地面積極小、轉速極高，恆處於滑動摩擦狀態。因此
 *   - 摩擦力永遠處於 Coulomb 飽和上限 F = μN，與馬達扭力無關
 *   - 摩擦力各向同性，不區分縱向與橫向
 *   - 不存在線性抓地區，因此不需要任何輪胎模型（Pacejka 等）
 *   - 角速度 ω 視為常數，馬達性能抽象為單一參數 wheelSurfaceSpeed = ω·r
 */

import { SLIP_EPSILON } from '../data/constants.js';
import { length, normalize, projectOntoPlane, scale, sub, type Vec3 } from './types.js';

export type TireForceInput = {
  /** 車體在接觸點 p 的世界速度 v_contact。 */
  contactVelocity: Vec3;
  /** 接觸法線 n（單位向量）。 */
  normal: Vec3;
  /** 車體前向量（世界座標，單位向量）。 */
  forward: Vec3;
  /** 該輪的法向力 N（牛頓，恆 ≥ 0）。 */
  normalForce: number;
  /** 輪面線速度 ω·r（m/s）。 */
  wheelSurfaceSpeed: number;
  /** 摩擦係數 μ。 */
  frictionCoef: number;
};

/**
 * 計算單一輪胎的摩擦力（世界座標，牛頓）。
 *
 * 步驟完全依照 §6.4：
 *   1. v_contact                                    （由呼叫端提供）
 *   2. v_contact_tangent = v_contact − (v_contact·n) n
 *   3. forward_tangent   = normalize(forward − (forward·n) n)
 *   4. v_drive           = forward_tangent · wheelSurfaceSpeed
 *   5. v_slip            = v_contact_tangent − v_drive
 *   6. |v_slip| < EPSILON → 力為 0
 *   7. F = −μ · N · normalize(v_slip)
 *
 * 退化情形（規格未定義，此處明確處理並記錄於 TUNING.md）：
 * 當車頭方向與接觸法線幾乎平行時（例如車頭直接頂進地面／圍欄），
 * forward 投影至接觸平面後長度趨近 0，無法正規化。此時視為「無驅動方向」，
 * 令 v_drive = 0，仍然施加純滑動摩擦力。這是唯一物理上合理的解釋，
 * 且不會憑空產生任何驅動力。
 */
export function tireForce(input: TireForceInput): Vec3 {
  const { contactVelocity, normal, forward, normalForce, wheelSurfaceSpeed, frictionCoef } = input;

  if (normalForce <= 0) return { x: 0, y: 0, z: 0 };

  // 2. 投影至接觸平面
  const contactTangent = projectOntoPlane(contactVelocity, normal);

  // 3. 前向量投影至接觸平面
  const forwardPlanar = projectOntoPlane(forward, normal);
  const forwardPlanarLen = length(forwardPlanar);

  // 4. 輪面驅動速度
  const drive: Vec3 =
    forwardPlanarLen < SLIP_EPSILON
      ? { x: 0, y: 0, z: 0 }
      : scale(scale(forwardPlanar, 1 / forwardPlanarLen), wheelSurfaceSpeed);

  // 5. 滑移速度
  const slip = sub(contactTangent, drive);
  const slipLen = length(slip);

  // 6. 無滑移 → 無力（實務上不會發生）
  if (slipLen < SLIP_EPSILON) return { x: 0, y: 0, z: 0 };

  // 7. Coulomb 飽和摩擦力，方向恆與滑移速度相反
  return scale(normalize(slip), -frictionCoef * normalForce);
}
