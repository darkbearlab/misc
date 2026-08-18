/**
 * 共用型別定義，以及模擬各層共用的純向量／四元數運算。
 *
 * 這裡的所有函式皆為 pure：不接觸任何全域狀態、不做 I/O、不使用 Math.random / Date.now。
 * Vec3 / Quat 的欄位名稱刻意與 Rapier 的 `Vector` / `Rotation` 一致，可直接互傳。
 */

// ──────────────────────────────────────────────────────────────────────────
// 基本幾何型別
// ──────────────────────────────────────────────────────────────────────────

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

// ──────────────────────────────────────────────────────────────────────────
// 純向量運算
// ──────────────────────────────────────────────────────────────────────────

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/** 長度為 0 時回傳零向量，呼叫端必須自行判斷退化情形。 */
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

/** 將 v 投影到以 n（單位向量）為法線的平面上。 */
export function projectOntoPlane(v: Vec3, n: Vec3): Vec3 {
  const d = dot(v, n);
  return { x: v.x - d * n.x, y: v.y - d * n.y, z: v.z - d * n.z };
}

// ──────────────────────────────────────────────────────────────────────────
// 純四元數運算
// ──────────────────────────────────────────────────────────────────────────

/** axis 必須為單位向量。 */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

/** Hamilton product：先套用 b 再套用 a。 */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** 以四元數旋轉向量：v' = q · v · q⁻¹（q 必須為單位四元數）。 */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  // t = 2 * (q_vec × v);  v' = v + q_w * t + q_vec × t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// §7 投擲參數
// ──────────────────────────────────────────────────────────────────────────

/** 玩家唯一的操作面：每台車以一組投擲參數投入場中。 */
export type ThrowParams = {
  /** 投入點 X，範圍 [-0.45, 0.45]。 */
  x: number;
  /** 投入點 Z，範圍 [-0.45, 0.45]。 */
  z: number;
  /** 投入高度，範圍 [0.02, 0.15]。 */
  y: number;
  /** 車頭朝向，弧度 [0, 2π)。繞世界 +Y 軸。 */
  yaw: number;
  /** 俯仰角，弧度 [-0.3, 0.3]。正值為機首上仰。 */
  pitch: number;
  /** 初速大小，m/s，範圍 [0, 5.0]。方向由 yaw 與 pitch 決定。 */
  speed: number;
  /** 初始角速度（繞世界 +Y 軸），rad/s，範圍 [-20, 20]。 */
  spin: number;
};

/** 一場戰鬥的完整輸入。相同輸入必然產生相同輸出。 */
export type BattleInput = {
  seed: number;
  throwA: ThrowParams;
  throwB: ThrowParams;
};

// ──────────────────────────────────────────────────────────────────────────
// §8 / §10 判定與輸出
// ──────────────────────────────────────────────────────────────────────────

export type BattleResult = 'A_WINS' | 'B_WINS' | 'DRAW';

export type BattleReason = 'OUT' | 'FLIP' | 'TIMEOUT';

export type Outcome = {
  result: BattleResult;
  reason: BattleReason;
};

/** 判定用的每幀車輛狀態快照。 */
export type VehicleJudgeState = {
  /** 質心世界座標。 */
  com: Vec3;
  /** 車體局部 +Y 經旋轉後的世界向量。 */
  up: Vec3;
};

/**
 * 非規格必要、僅供 §11 驗收與調參使用的診斷數據。
 * CLI 的 `--input` 輸出不含此欄位（§10 的輸出格式為固定四欄）。
 */
export type SimStats = {
  /** 全程車體質心 y 的最大值（§11.2 要求不得 > 0.5）。 */
  maxComY: number;
  /** 全程最大線速度。 */
  maxLinearSpeed: number;
  /** 全程最大角速度。 */
  maxAngularSpeed: number;
  /** 線速度 clamp 觸發次數（§11.2 要求為 0）。 */
  linearClampHits: number;
  /** 角速度 clamp 觸發次數（§11.2 要求為 0）。 */
  angularClampHits: number;
};

/**
 * 診斷選項（§16 跨平台驗證專用）。
 * 全部不影響物理計算，只影響額外記錄多少資訊。
 */
/**
 * 探索用的物理覆寫（Phase 1.5 參數掃描）。
 *
 * **這不是正式的參數來源。** 選定的值最終必須寫死回 `src/data/constants.ts` 並升
 * `PHYSICS_VERSION`；掃描結果不得作為版本依據。
 *
 * 覆寫以純參數傳入，`src/sim/` 不會因此讀取任何 I/O、環境變數或牆上時間（§3 禁令 1、2、6）。
 * 不指定任何欄位時，傳給輪胎模型的就是 `constants.ts` 的同一個值，執行路徑與結果位元相同。
 *
 * 只開放 §6.5 明文允許調整的兩項：「若車輛行為顯得不順，正確做法是調 μ 與
 * `wheelSurfaceSpeed`，不得加入轉向輔助、角速度阻尼或任何額外程式碼。」
 */
/**
 * 探索用的車體尺寸覆寫(Phase 1.5 第三輪)。
 *
 * 四個自由度,其餘幾何由 `resolveVehicle()` 推導。**質量不在此列** ——
 * 依裁決固定為 0.15 kg(0.11 / 0.04),不隨尺寸變化。
 */
export type VehicleOverride = {
  /** 全長(底盤後緣至刃口),m。V1 = 0.150。 */
  totalLength: number;
  /** 底盤寬,m。V1 = 0.070。 */
  chassisWidth: number;
  /** 全高(車體自身的垂直範圍,非離地高),m。V1 = 0.025。 */
  totalHeight: number;
  /** 輪距,m。V1 = 0.056。軸距隨此等比。 */
  trackWidth: number;
};

export type PhysicsOverride = {
  /** 覆寫 `TIRE_FRICTION_COEF`。 */
  tireFrictionCoef?: number;
  /** 覆寫 `WHEEL_SURFACE_SPEED`。 */
  wheelSurfaceSpeed?: number;
  /**
   * 覆寫 stadium 半徑 R。
   *
   * 出界門檻、26 段圍欄、地板 cuboid、投擲合法範圍全部由 `resolveArena()` 連動重算,
   * 呼叫端無從指定不一致的組合。
   */
  fieldRadius?: number;
  /** 覆寫 stadium 直線段長度 L。 */
  fieldSegmentLength?: number;
  /**
   * 覆寫車體尺寸。底盤、前武器、輪位、最遠半徑全部由 `resolveVehicle()` 連動重算,
   * §7.1 的投擲餘裕與 §7.2 的兩車最小距離也隨之改變。
   */
  vehicle?: VehicleOverride;
  /**
   * 採用 §7.1 新版投擲餘裕(`VEHICLE_MAX_RADIUS + THROW_CLEARANCE`,與車長掛鉤)。
   *
   * 預設 false,沿用 `PHYSICS_VERSION = 1` 凍結的固定值 0.08 m ——
   * 直接換成新值會使既有 fixture 的投擲點變為不合法,v1 的 baseline 無法驗證。
   * 正式採用時連同升版與 fixture 重產一起進行。
   */
  vehicleDerivedThrowMargin?: boolean;
  /**
   * 啟用 §7.2 兩車初始分離約束(`dist(A, B) ≥ 2 × maxRadius + 0.005`)。
   *
   * 與 `vehicleDerivedThrowMargin` 同屬取樣規則變更,同樣預設 false ——
   * v1 的 20 組 fixture 中有投擲點違反此約束,直接啟用會使 baseline 無法驗證。
   * 兩項於第三輪定案時一併寫死並升 `PHYSICS_VERSION` 至 2。
   */
  enforceMinThrowSeparation?: boolean;
};

export type SimOptions = {
  /** 探索用的物理覆寫；不指定時一律使用 `constants.ts` 的值。 */
  physics?: PhysicsOverride;
  /**
   * 額外記錄「每一幀」的 checksum。
   * §9.2 規定的取樣頻率是每 60 幀一次，跨平台分歧只能定位到 60 幀的區間；
   * 開啟本選項才能把首次分歧定位到確切幀號。
   */
  dense?: boolean;
  /** 在指定幀擷取雙方的完整狀態（未量化），供分歧診斷使用。 */
  captureFrame?: number;
  /** 記錄每幀雙車的位置與旋轉，供 replay 播放器使用（§P1.3）。 */
  trajectory?: boolean;
  /** 記錄每幀每輪的接地／法向力／輪胎力／接觸點等除錯資料（§P1.5）。 */
  diagnostics?: boolean;
};

// ──────────────────────────────────────────────────────────────────────────
// §P1.3 / §P1.5 軌跡與診斷（皆為旁路輸出，不參與任何物理計算或 checksum）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 每幀的位置與旋轉，索引 0 = 車 A、1 = 車 B。
 *
 * **`position` 是剛體原點的位移（`body.translation()`），不是質心。**
 * 渲染的 mesh 是以車體局部座標建構的，要放對位置就必須用剛體原點的變換；
 * 用質心會讓整台車偏移約 (0, 0.0025, 0.0178) m。
 *
 * 以 f32 儲存是刻意的（§P1.3.2）：這是**顯示用**資料，不回饋模擬。
 * 模擬全程 f64，checksum 依 §9.2 由 f64 狀態量化後計算，兩者不共用。
 * **不得反過來以軌跡資料重建模擬狀態，或以軌跡的 f32 值做任何判定。**
 */
export type TrajectoryFrames = {
  frameCount: number;
  /** 長度 frameCount * 3 */
  position: Float32Array[];
  /** 長度 frameCount * 4，四元數 (x, y, z, w) */
  rotation: Float32Array[];
};

/**
 * 單台車的每輪診斷寫入端（§P1.5）。
 *
 * 這是**旁路寫入**：`applyWheelForces()` 只是把已經算出來的中間值抄一份出來，
 * 不為了記錄而重新計算，也不調整任何計算順序。`frame` 由 `simulate()` 每幀設定。
 */
export type WheelDiagnosticsWriter = {
  grounded: Uint8Array;
  normalForce: Float32Array;
  tireForce: Float32Array;
  contactPoint: Float32Array;
  frame: number;
};

/** §P1.5 除錯疊圖用的每輪資料，索引 0 = 車 A、1 = 車 B。 */
export type TrajectoryDiagnostics = {
  /** frameCount * 4；1 = 該輪該幀取得有效接觸 */
  wheelGrounded: Uint8Array[];
  /** frameCount * 4；懸吊法向力 N（牛頓） */
  normalForce: Float32Array[];
  /** frameCount * 4 * 3；輪胎力向量（世界座標，牛頓） */
  tireForce: Float32Array[];
  /** frameCount * 4 * 3；接觸點世界座標 */
  contactPoint: Float32Array[];
  /** frameCount；質心到 stadium 中心線的距離 */
  stadiumDist: Float32Array[];
  /** frameCount；FLIP 連續幀計數器 */
  flipCounter: Uint16Array[];
  /**
   * 車體局部座標的質心，每台車一組（整場固定不變）。
   *
   * 疊圖要標出重心位置就必須有它，而它是 Rapier 依兩個 collider 的質量分佈合成的，
   * 無法從常數推導。這裡只是把建構完成後讀到的值抄一份出來（旁路，§P1.2.2）。
   * 軌跡中的 position 是**剛體原點**，質心 = position + rotation · localCenterOfMass。
   */
  localCenterOfMass: Vec3[];
};

/** 單台車在某一幀的完整狀態，供 §16 的分歧診斷輸出。 */
export type VehicleStateDump = {
  translation: Vec3;
  rotation: Quat;
  linvel: Vec3;
  angvel: Vec3;
};

export type SimResult = {
  result: BattleResult;
  reason: BattleReason;
  frames: number;
  checksums: number[];
  stats: SimStats;
  /** 僅在 `SimOptions.dense` 為真時存在：第 0 幀起每一幀的 checksum。 */
  denseChecksums?: number[];
  /** 僅在 `SimOptions.trajectory` 為真時存在（§P1.3）。 */
  trajectory?: TrajectoryFrames;
  /** 僅在 `SimOptions.diagnostics` 為真時存在（§P1.5）。 */
  diagnostics?: TrajectoryDiagnostics;
  /** 僅在 `SimOptions.captureFrame` 命中時存在。 */
  capturedState?: {
    frame: number;
    a: VehicleStateDump;
    b: VehicleStateDump;
  };
};
