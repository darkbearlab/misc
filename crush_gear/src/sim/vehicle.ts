/**
 * 車體剛體、懸吊、輪胎力（§6）。
 *
 * 車體為**單一 RigidBody 掛載兩個 convex collider**：
 *   - 底盤（chassis）：矩形 box，質量 0.11 kg
 *   - 前武器（weapon）：楔形 convex hull，自底盤前緣向前延伸，質量 0.04 kg
 *
 * 質量、重心、慣量三者全部由幾何與質量分配衍生，不得人為指定任何一項（§6.2）：
 * 只對兩個 collider 分別 `setMass()`，其餘交給 Rapier 依幾何自動合成。
 * 這個結構直接是 Phase 2 零件系統的原型（底盤 = core，前武器 = attack）。
 *
 * 輪子不建立獨立剛體：每台車有 4 個輪位，以 raycast + 彈簧懸吊實作，
 * 輪胎力則由 `tire.ts` 的純函式提供並以 `applyImpulseAtPoint` 施加。
 * 本檔刻意不使用 Rapier 的 `DynamicRayCastVehicleController`（§3.3）—— 該控制器
 * 內建 anti-slip 與縱橫向分離的摩擦模型，與「輪胎恆處於滑動狀態」的物理前提衝突。
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, Ray, RigidBody, World } from '@dimforge/rapier3d-compat';

import {
  MAX_ANGULAR_SPEED,
  MAX_LINEAR_SPEED,
  SUSPENSION_DAMPING,
  SUSPENSION_RAY_LENGTH,
  SUSPENSION_REST_LENGTH,
  SUSPENSION_STIFFNESS,
  TIRE_FRICTION_COEF,
  VEHICLE_FRICTION,
  VEHICLE_RESTITUTION,
  WHEEL_SURFACE_SPEED,
} from '../data/constants.js';
import { tireForce } from './tire.js';
import { resolveVehicle, type Point3, type ResolvedVehicle } from './vehicle-shape.js';
import {
  add,
  cross,
  dot,
  quatFromAxisAngle,
  quatMul,
  rotateByQuat,
  scale,
  sub,
  WORLD_UP,
  type PhysicsOverride,
  type Quat,
  type ThrowParams,
  type Vec3,
  type VehicleJudgeState,
  type WheelDiagnosticsWriter,
} from './types.js';
import type { VehicleChecksumState } from './checksum.js';

/** 車體局部 +Z 為車頭方向。 */
const LOCAL_FORWARD: Vec3 = { x: 0, y: 0, z: 1 };
const LOCAL_UP: Vec3 = { x: 0, y: 1, z: 0 };
const AXIS_X: Vec3 = { x: 1, y: 0, z: 0 };
const AXIS_Y: Vec3 = { x: 0, y: 1, z: 0 };

function weaponPoints(hull: readonly Point3[]): Float32Array {
  return new Float32Array(hull.flatMap((p) => [p[0], p[1], p[2]]));
}

/**
 * §6.3 的兩項幾何條件，加上 v1.0 §6.3 的刮地檢查。
 *
 * 1. 所有錨點必須落在底盤 collider 的水平投影內。
 *    v1.0 的錨點突出於車體之外，等於四個輪子懸空在車體外側 —— 那是幾何錯誤，
 *    會讓錨點先於 collider 穿進障礙物。
 * 2. 錨點高度必須嚴格高於車體最低點。
 * 3. 靜態行駛高度下，車體最低點必須嚴格高於接觸面，否則車體會直接刮地。
 *
 * 另註（非斷言，但為設計上的巧合且值得記錄）：
 * 錨點與車體最低點的落差 0.005 = restLength − maxTravel，
 * 因此懸吊恰好用完 maxTravel 的行程時底盤才會觸地。
 */
export function assertVehicleGeometry(shape: ResolvedVehicle): void {
  const half = shape.chassisHalfExtents;
  const lowestY = shape.lowestY;

  for (let i = 0; i < shape.wheelAnchors.length; i += 1) {
    const anchor = shape.wheelAnchors[i] as Point3;

    if (Math.abs(anchor[0]) >= half.x || Math.abs(anchor[2]) >= half.z) {
      throw new Error(
        `Wheel anchor ${i} at (${anchor[0]}, ${anchor[2]}) lies outside the chassis footprint ` +
          `(±${half.x}, ±${half.z}); the wheel would hang off the body.`,
      );
    }

    if (!(anchor[1] > lowestY)) {
      throw new Error(
        `Wheel anchor ${i} height (y=${anchor[1]}) must be strictly above the vehicle's ` +
          `lowest point (y=${lowestY}).`,
      );
    }
  }

  const anchorY = shape.wheelAnchors[0]?.[1] as number;
  const staticCompression =
    (shape.totalMass * 9.81) / (shape.wheelAnchors.length * SUSPENSION_STIFFNESS);
  const staticContactY = anchorY - (SUSPENSION_REST_LENGTH - staticCompression);
  if (!(lowestY > staticContactY)) {
    throw new Error(
      `Chassis geometry invalid: lowest point (y=${lowestY}) does not clear the static ` +
        `ride contact height (y=${staticContactY}); the chassis would scrape the ground.`,
    );
  }
}

/** 由投擲參數求車體初始朝向。正 pitch 為機首上仰（§14.6）。 */
export function orientationFromThrow(yaw: number, pitch: number): Quat {
  return quatMul(quatFromAxisAngle(AXIS_Y, yaw), quatFromAxisAngle(AXIS_X, -pitch));
}

/**
 * 一幀之內快取的剛體狀態。
 *
 * 每次跨越 JS↔wasm 邊界讀取剛體狀態約需 0.17 µs，而每幀原本要讀 12 次以上
 * （懸吊、clamp、判定、checksum 各讀一輪）。改為每幀只讀一次並全程共用，
 * 可省下約 7% 的模擬時間。這純粹是實作最佳化，數值完全相同。
 */
type FrameState = {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
  rw: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  cx: number;
  cy: number;
  cz: number;
};

export class Vehicle {
  readonly body: RigidBody;
  /** 底盤 collider。建立順序固定為底盤 → 前武器（§9.3）。 */
  readonly chassis: Collider;
  /** 前武器 collider。 */
  readonly weapon: Collider;

  private readonly ray: Ray;
  /**
   * 本車實際使用的輪胎參數。
   *
   * 未指定覆寫時就是 `constants.ts` 的同一個值 —— 是同一個 double，
   * 因此預設路徑與寫死常數時位元完全相同。
   */
  private readonly tireFrictionCoef: number;
  private readonly wheelSurfaceSpeed: number;
  private readonly state: FrameState = {
    tx: 0,
    ty: 0,
    tz: 0,
    rx: 0,
    ry: 0,
    rz: 0,
    rw: 1,
    vx: 0,
    vy: 0,
    vz: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    cx: 0,
    cy: 0,
    cz: 0,
  };

  /** §11.2 診斷用：clamp 觸發次數。 */
  linearClampHits = 0;
  angularClampHits = 0;

  /** 本車實際使用的幾何。未覆寫時就是 `DEFAULT_VEHICLE`（同一批 double）。 */
  readonly shape: ResolvedVehicle;

  constructor(world: World, params: ThrowParams, physics?: PhysicsOverride) {
    const shape = resolveVehicle(physics?.vehicle);
    this.shape = shape;
    assertVehicleGeometry(shape);

    this.tireFrictionCoef = physics?.tireFrictionCoef ?? TIRE_FRICTION_COEF;
    this.wheelSurfaceSpeed = physics?.wheelSurfaceSpeed ?? WHEEL_SURFACE_SPEED;

    const rotation = orientationFromThrow(params.yaw, params.pitch);
    const forward = rotateByQuat(rotation, LOCAL_FORWARD);
    const linvel = scale(forward, params.speed);

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(params.x, params.y, params.z)
        .setRotation(rotation)
        .setLinvel(linvel.x, linvel.y, linvel.z)
        .setAngvel({ x: 0, y: params.spin, z: 0 })
        .setCcdEnabled(true),
    );

    this.chassis = world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        shape.chassisHalfExtents.x,
        shape.chassisHalfExtents.y,
        shape.chassisHalfExtents.z,
      )
        .setTranslation(shape.chassisOffset.x, shape.chassisOffset.y, shape.chassisOffset.z)
        .setMass(shape.chassisMass)
        .setFriction(VEHICLE_FRICTION)
        .setRestitution(VEHICLE_RESTITUTION),
      this.body,
    );

    const weaponDesc = RAPIER.ColliderDesc.convexHull(weaponPoints(shape.weaponHull));
    if (weaponDesc === null) {
      throw new Error('Failed to build the front-weapon convex hull from WEAPON_HULL.');
    }
    this.weapon = world.createCollider(
      weaponDesc
        .setMass(shape.weaponMass)
        .setFriction(VEHICLE_FRICTION)
        .setRestitution(VEHICLE_RESTITUTION),
      this.body,
    );

    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.readState();
  }

  /**
   * 自 Rapier 讀入本幀的剛體狀態並快取。
   *
   * **必須在每次 `world.step()` 之後、讀取任何車輛狀態之前呼叫一次。**
   * `simulate.ts` 的主迴圈是唯一的呼叫者。施加 impulse 不會改變剛體狀態，
   * 因此同一幀內施力後不需要重新讀取。
   */
  readState(): void {
    const s = this.state;
    const t = this.body.translation();
    s.tx = t.x;
    s.ty = t.y;
    s.tz = t.z;
    const r = this.body.rotation();
    s.rx = r.x;
    s.ry = r.y;
    s.rz = r.z;
    s.rw = r.w;
    const v = this.body.linvel();
    s.vx = v.x;
    s.vy = v.y;
    s.vz = v.z;
    const w = this.body.angvel();
    s.wx = w.x;
    s.wy = w.y;
    s.wz = w.z;
    const c = this.body.worldCom();
    s.cx = c.x;
    s.cy = c.y;
    s.cz = c.z;
  }

  private rotation(): Quat {
    const s = this.state;
    return { x: s.rx, y: s.ry, z: s.rz, w: s.rw };
  }

  /**
   * 每幀套用 4 個輪位的懸吊力與輪胎力，順序固定為 shape.wheelAnchors 的陣列順序（§9.3）。
   *
   * 懸吊（§6.3）：
   *   1. 自 anchor 沿車體 −Y 方向 raycast，最大距離 restLength + maxTravel
   *   2. 無命中 → 該輪離地，N = 0，跳過輪胎力
   *   3. 命中距離 d → compression = restLength − d
   *   4. v_susp = 接觸點速度沿懸吊軸（車體 +Y）的分量（§14.2）
   *   5. N = k·compression − c·v_susp
   *   6. N < 0 → clamp 為 0（懸吊不得產生拉力）
   *   7. 沿命中法線方向施加大小為 N 的力於接觸點
   *
   * 力以 `applyImpulseAtPoint(F · dt, p)` 施加，dt 為固定步長。
   *
   * @param diag 選用的診斷旁路寫入端（§P1.5）。傳入時只會多做幾筆 typed array 寫入，
   *   不改變任何計算內容或順序；不傳時整條路徑與 Phase 0 位元完全相同。
   */
  applyWheelForces(world: World, dt: number, diag?: WheelDiagnosticsWriter): void {
    const anchors = this.shape.wheelAnchors;
    const diagBase = diag === undefined ? 0 : diag.frame * anchors.length;
    const body = this.body;
    const s = this.state;
    const translation: Vec3 = { x: s.tx, y: s.ty, z: s.tz };
    const rotation = this.rotation();
    const linvel: Vec3 = { x: s.vx, y: s.vy, z: s.vz };
    const angvel: Vec3 = { x: s.wx, y: s.wy, z: s.wz };
    const com: Vec3 = { x: s.cx, y: s.cy, z: s.cz };

    const suspensionUp = rotateByQuat(rotation, LOCAL_UP);
    const suspensionDown = scale(suspensionUp, -1);
    const forward = rotateByQuat(rotation, LOCAL_FORWARD);

    this.ray.dir = suspensionDown;

    for (let i = 0; i < anchors.length; i += 1) {
      const anchorLocal = anchors[i] as Point3;
      const anchorWorld = add(
        translation,
        rotateByQuat(rotation, {
          x: anchorLocal[0],
          y: anchorLocal[1],
          z: anchorLocal[2],
        }),
      );

      this.ray.origin = anchorWorld;
      const hit = world.castRayAndGetNormal(
        this.ray,
        SUSPENSION_RAY_LENGTH,
        true, // §14.4
        undefined,
        undefined,
        undefined,
        body,
      );
      // 2. 無命中 → 該輪離地
      if (hit === null) continue;

      const normal: Vec3 = { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z };

      // §14.3 退化命中：射線起點已經在某個 collider 內部。Rapier 對 solid ray 的這種情形
      // 回傳 toi = 0 且法線為零向量 —— 這不是有效接觸，若照常計算會得到滿載的 N 與一個
      // 沒有方向的接觸平面，憑空生出巨大的側向輪胎力。此處視同「該輪離地」，
      // 穿透交由車體 collider 處理。
      // 合法命中的法線必定與射線方向相反，即 dot(n, 懸吊上方向) > 0；
      // 爬圍欄時法線為水平，內積仍為正，不受影響。
      if (dot(normal, suspensionUp) <= 0) continue;

      // 3. 壓縮量
      const distance = hit.timeOfImpact;
      const compression = SUSPENSION_REST_LENGTH - distance;

      const contact = add(anchorWorld, scale(suspensionDown, distance));
      const contactVelocity = add(linvel, cross(angvel, sub(contact, com)));

      if (diag !== undefined) {
        const w = diagBase + i;
        diag.grounded[w] = 1;
        diag.contactPoint[w * 3] = contact.x;
        diag.contactPoint[w * 3 + 1] = contact.y;
        diag.contactPoint[w * 3 + 2] = contact.z;
      }

      // 4. 懸吊軸速度分量：沿車體 +Y 為正，車體下沉時為負 → 阻尼項增大 N，抵抗壓縮
      const suspensionVelocity = dot(contactVelocity, suspensionUp);

      // 5 & 6.
      const normalForce = Math.max(
        0,
        SUSPENSION_STIFFNESS * compression - SUSPENSION_DAMPING * suspensionVelocity,
      );
      if (diag !== undefined) diag.normalForce[diagBase + i] = normalForce;
      if (normalForce <= 0) continue;

      // 7. 懸吊力沿命中法線
      body.applyImpulseAtPoint(scale(normal, normalForce * dt), contact, true);

      // §6.4 輪胎力
      const force = tireForce({
        contactVelocity,
        normal,
        forward,
        normalForce,
        wheelSurfaceSpeed: this.wheelSurfaceSpeed,
        frictionCoef: this.tireFrictionCoef,
      });
      body.applyImpulseAtPoint(scale(force, dt), contact, true);

      if (diag !== undefined) {
        const w = (diagBase + i) * 3;
        diag.tireForce[w] = force.x;
        diag.tireForce[w + 1] = force.y;
        diag.tireForce[w + 2] = force.z;
      }
    }
  }

  /** 目前快取的剛體原點位移（渲染用；與質心不同，見 TrajectoryFrames 註解）。 */
  translation(): Vec3 {
    const s = this.state;
    return { x: s.tx, y: s.ty, z: s.tz };
  }

  /** 目前快取的旋轉四元數。 */
  orientation(): Quat {
    return this.rotation();
  }

  /**
   * §6.2：每幀 clamp 線速度與角速度上限。clamp 只負責攔截數值發散，不得參與遊戲。
   * 觸發時同步更新快取狀態，後續的判定與 checksum 才會看到 clamp 後的值。
   */
  clampVelocities(): void {
    const s = this.state;

    const linearSpeed = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
    if (linearSpeed > MAX_LINEAR_SPEED) {
      const k = MAX_LINEAR_SPEED / linearSpeed;
      s.vx *= k;
      s.vy *= k;
      s.vz *= k;
      this.body.setLinvel({ x: s.vx, y: s.vy, z: s.vz }, true);
      this.linearClampHits += 1;
    }

    const angularSpeed = Math.sqrt(s.wx * s.wx + s.wy * s.wy + s.wz * s.wz);
    if (angularSpeed > MAX_ANGULAR_SPEED) {
      const k = MAX_ANGULAR_SPEED / angularSpeed;
      s.wx *= k;
      s.wy *= k;
      s.wz *= k;
      this.body.setAngvel({ x: s.wx, y: s.wy, z: s.wz }, true);
      this.angularClampHits += 1;
    }
  }

  /** 判定用狀態：質心世界座標與車體 up vector。 */
  judgeState(): VehicleJudgeState {
    const s = this.state;
    return {
      com: { x: s.cx, y: s.cy, z: s.cz },
      up: rotateByQuat(this.rotation(), LOCAL_UP),
    };
  }

  /** Checksum 用狀態（§9.2）：質心位置、旋轉四元數、線速度、角速度。 */
  checksumState(): VehicleChecksumState {
    const s = this.state;
    return {
      translation: { x: s.cx, y: s.cy, z: s.cz },
      rotation: { x: s.rx, y: s.ry, z: s.rz, w: s.rw },
      linvel: { x: s.vx, y: s.vy, z: s.vz },
      angvel: { x: s.wx, y: s.wy, z: s.wz },
    };
  }

  /** 目前線速度大小。 */
  linearSpeed(): number {
    const s = this.state;
    return Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
  }

  /** 目前角速度大小。 */
  angularSpeed(): number {
    const s = this.state;
    return Math.sqrt(s.wx * s.wx + s.wy * s.wy + s.wz * s.wz);
  }

  /**
   * 車體局部座標的質心（整場固定），由 Rapier 依兩個 collider 的質量分佈合成。
   * 純讀取，僅供 §P1.5 的疊圖標示重心位置使用。
   */
  localCenterOfMass(): Vec3 {
    const c = this.body.localCom();
    return { x: c.x, y: c.y, z: c.z };
  }

  /** 質心世界座標。 */
  centerOfMass(): Vec3 {
    const s = this.state;
    return { x: s.cx, y: s.cy, z: s.cz };
  }

  /** 車體 up vector 與世界 +Y 的內積。 */
  upDot(): number {
    return dot(rotateByQuat(this.rotation(), LOCAL_UP), WORLD_UP);
  }
}
