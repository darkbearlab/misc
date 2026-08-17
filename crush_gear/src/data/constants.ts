/**
 * 所有物理常數與場地尺寸。（SPEC v1.1）
 *
 * 本檔為規格書 §4 / §5 / §6 / §7 / §8 / §9 的唯一數值來源，
 * 任何調參都只應該發生在這裡（並記錄於 TUNING.md）。
 *
 * 單位：公尺（m）、公斤（kg）、秒（s）、弧度（rad）。右手座標系，+Y 為上，+Z 為車頭方向。
 */

import type { Vec3 } from '../sim/types.js';

// ──────────────────────────────────────────────────────────────────────────
// §4 積分設定
// ──────────────────────────────────────────────────────────────────────────

/** Fixed timestep。全專案唯一的時間步長，不得改為可變 timestep（§3.5）。 */
export const DT = 1 / 120;

/** Rapier constraint solver 迭代次數。 */
export const SOLVER_ITERATIONS = 8;

/** 重力加速度向量。 */
export const GRAVITY: Vec3 = { x: 0, y: -9.81, z: 0 };

// ──────────────────────────────────────────────────────────────────────────
// §5 場地（stadium：兩端半圓 + 中央矩形）
// ──────────────────────────────────────────────────────────────────────────

/** 半圓半徑 R。同時是圍欄內緣到 stadium 中心線的距離。 */
export const FIELD_RADIUS = 0.35;

/** 中央直線段長度 L（沿 Z）。 */
export const FIELD_SEGMENT_LENGTH = 0.3;

/** L / 2。stadium 距離函數的夾擠半長。 */
export const FIELD_HALF_SEGMENT = FIELD_SEGMENT_LENGTH / 2;

/** 圍欄高度（自地板上表面起算）。刻意低於車體被推撞時的爬升高度。 */
export const FENCE_HEIGHT = 0.06;

/** 圍欄厚度。圍欄內緣貼合 stadium 輪廓，向外延伸。 */
export const FENCE_THICKNESS = 0.05;

/** 每端半圓的圍欄分段數（每段 15°，12 段涵蓋 180°）。 */
export const FENCE_ARC_SEGMENTS = 12;

/**
 * 相鄰圍欄段之間的重疊係數。
 * 圍欄有縫隙會讓車輛卡住或穿出，是此結構最主要的風險，故刻意讓相鄰段重疊。
 */
export const FENCE_OVERLAP_FACTOR = 1.15;

/** 圍欄外緣到中心線的距離。 */
export const FENCE_OUTER_RADIUS = FIELD_RADIUS + FENCE_THICKNESS;

/** 地板厚度（實心，非薄板），刻意設大以防止高速穿透。 */
export const FLOOR_THICKNESS = 0.2;

/**
 * 地板為單一矩形 cuboid，刻意不貼合 stadium 輪廓。
 * 地板形狀不影響任何判定（出界以 §8.1 的距離函數判定），
 * 使用單一 cuboid 可避免不必要的複雜度與潛在接縫問題。
 */
export const FLOOR_HALF_EXTENTS: Vec3 = { x: 0.45, y: FLOOR_THICKNESS / 2, z: 0.6 };

/** 地板與圍欄 collider friction。刻意為 0：所有摩擦力由 §6.4 輪胎模型提供。 */
export const FLOOR_FRICTION = 0;

/** 地板與圍欄 collider restitution。 */
export const FLOOR_RESTITUTION = 0.15;

// ──────────────────────────────────────────────────────────────────────────
// §6.1 車體幾何（矩形底盤 + 前武器，單一 RigidBody 掛載兩個 collider）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 底盤（シャーシ）：矩形 box。
 * 佔據範圍 x ∈ [-0.035, 0.035]、y ∈ [-0.010, 0.015]、z ∈ [-0.050, 0.050]。
 */
export const CHASSIS_HALF_EXTENTS: Vec3 = { x: 0.035, y: 0.0125, z: 0.05 };

/** 底盤相對車體原點的位移。車體原點位於底盤幾何中心（非全車幾何中心）。 */
export const CHASSIS_OFFSET: Vec3 = { x: 0, y: 0.0025, z: 0 };

/** 底盤質量。 */
export const CHASSIS_MASS = 0.11;

/**
 * 前武器（フロントウェポン）：楔形 convex hull，自底盤前緣 z = 0.050 向前延伸至 z = 0.100。
 * 刃口刻意保留 0.008 m 寬度，不收成單點 —— 退化成尖點的 convex hull
 * 會讓碰撞法線計算不穩定。
 */
export const WEAPON_HULL: readonly (readonly [number, number, number])[] = [
  // 根部（貼合底盤前緣 z = 0.050）
  [-0.03, -0.005, 0.05],
  [0.03, -0.005, 0.05],
  [-0.03, 0.01, 0.05],
  [0.03, 0.01, 0.05],
  // 刃口（z = 0.100）
  [-0.004, -0.002, 0.1],
  [0.004, -0.002, 0.1],
  [-0.004, 0.006, 0.1],
  [0.004, 0.006, 0.1],
];

/** 前武器質量。 */
export const WEAPON_MASS = 0.04;

/** 總質量，由兩個 collider 的質量分配自然得出（僅供斷言與文件使用）。 */
export const TOTAL_MASS = CHASSIS_MASS + WEAPON_MASS;

/** 車體所有 collider 的最低點（局部座標）。底盤底面 −0.010 低於武器底面 −0.005。 */
export const VEHICLE_LOWEST_Y = Math.min(
  CHASSIS_OFFSET.y - CHASSIS_HALF_EXTENTS.y,
  ...WEAPON_HULL.map((p) => p[1]),
);

// ──────────────────────────────────────────────────────────────────────────
// §6.2 剛體屬性
// ──────────────────────────────────────────────────────────────────────────

/** collider friction。所有摩擦由輪胎模型提供。 */
export const VEHICLE_FRICTION = 0;

/** collider restitution（車對車碰撞的彈性）。 */
export const VEHICLE_RESTITUTION = 0.25;

/** 線速度上限，每幀 clamp。 */
export const MAX_LINEAR_SPEED = 30;

/**
 * 角速度上限，每幀 clamp。
 *
 * clamp 只負責攔截數值發散，不得參與遊戲：只要在正常遊戲中觸發過一次，
 * 它就從保險絲變成了遊戲規則。400 rad/s ≈ 64 轉/秒，車體達到此角速度
 * 已明確屬於數值異常而非物理行為。
 */
export const MAX_ANGULAR_SPEED = 400;

// ──────────────────────────────────────────────────────────────────────────
// §6.3 輪位與懸吊
// ──────────────────────────────────────────────────────────────────────────

/**
 * 4 個輪位（車體局部座標，為懸吊射線起點），矩形佈局、左右對稱、前後同寬。
 * 順序固定為 左前、右前、左後、右後 —— §9.3 要求力的施加順序必須固定。
 *
 * 兩項幾何條件由 vehicle.ts 的 assertion 驗證：
 *   1. 所有錨點在底盤 collider 的水平投影內（|x| = 0.028 < 0.035、|z| = 0.035 < 0.050）
 *   2. 錨點高度 y = −0.005 嚴格高於車體最低點 y = −0.010
 */
export const WHEEL_ANCHORS: readonly (readonly [number, number, number])[] = [
  [-0.028, -0.005, 0.035], // 左前
  [0.028, -0.005, 0.035], // 右前
  [-0.028, -0.005, -0.035], // 左後
  [0.028, -0.005, -0.035], // 右後
];

/** 輪距（track width）。 */
export const TRACK_WIDTH = 0.056;

/** 軸距（wheelbase）。 */
export const WHEELBASE = 0.07;

/** 靜止時懸吊長度。相對 v1.0 增加 0.005 以補償錨點上移，維持相同靜態行駛高度。 */
export const SUSPENSION_REST_LENGTH = 0.025;

/** 懸吊最大行程。 */
export const SUSPENSION_MAX_TRAVEL = 0.02;

/**
 * 懸吊剛度 k（N/m），靜態壓縮約 1.2 mm（四輪並聯等效 1200 N/m）。
 *
 * 此值應在數值穩定的前提下盡可能大，以趨近剛性接觸；
 * 實物並無懸吊，彈簧僅為取得法向力的手段。
 * k = 300 時 roll 模態的 ω_n·dt ≈ 1.1，已接近顯式積分的穩定邊界。
 */
export const SUSPENSION_STIFFNESS = 300;

/**
 * 懸吊阻尼 c（Ns/m）。
 *
 * 顯式積分的穩定性由**轉動模態**決定而非 heave 模態：每個模態的每幀速度衰減比為
 * r = 1 − c·K，K = n·lever²·dt / I_eff，需要 |r| < 1。
 * 詳見 TUNING.md。
 */
export const SUSPENSION_DAMPING = 2;

/** 懸吊 raycast 最大距離。 */
export const SUSPENSION_RAY_LENGTH = SUSPENSION_REST_LENGTH + SUSPENSION_MAX_TRAVEL;

// ──────────────────────────────────────────────────────────────────────────
// §6.4 輪胎力模型
// ──────────────────────────────────────────────────────────────────────────

/** 輪面線速度 ω·r。馬達性能在本模型中抽象為這單一參數。 */
export const WHEEL_SURFACE_SPEED = 4;

/** 輪胎摩擦係數 μ。摩擦力恆為 Coulomb 飽和上限 μN，各向同性。 */
export const TIRE_FRICTION_COEF = 0.3;

/** 滑移速度下限；低於此值視為無滑移，力為 0。 */
export const SLIP_EPSILON = 1e-6;

// ──────────────────────────────────────────────────────────────────────────
// §7 投擲參數合法範圍
// ──────────────────────────────────────────────────────────────────────────

/** 投入點與圍欄內緣必須保持的最小距離。 */
export const THROW_FENCE_MARGIN = 0.08;

/** 投入點允許的最大 stadium 距離。矩形範圍檢查已作廢。 */
export const THROW_MAX_STADIUM_DISTANCE = FIELD_RADIUS - THROW_FENCE_MARGIN;

export const THROW_LIMITS = {
  /** 下界 = 實測靜態行駛高度 + 0.001，避免車體生成於懸吊壓縮狀態。 */
  y: { min: 0.03, max: 0.15 },
  yaw: { min: 0, max: Math.PI * 2 }, // [0, 2π)，上界為開區間
  pitch: { min: -0.3, max: 0.3 },
  speed: { min: 0, max: 5 },
  spin: { min: -20, max: 20 },
} as const;

// ──────────────────────────────────────────────────────────────────────────
// §8 勝負判定
// ──────────────────────────────────────────────────────────────────────────

/** 出界：stadium 距離超過此值（圍欄外緣 0.40 + 餘裕 0.05）。 */
export const OUT_THRESHOLD = 0.45;

/** 出界：質心 y 低於此值（掉落至地板平面以下）。 */
export const OUT_Y_LIMIT = -0.1;

/** 翻覆判定所需的連續幀數（0.5 秒）。 */
export const FLIP_HOLD_FRAMES = 60;

/** 時限（60 秒）。 */
export const TIMEOUT_FRAMES = 7200;

// ──────────────────────────────────────────────────────────────────────────
// §9.2 Checksum
// ──────────────────────────────────────────────────────────────────────────

/** 每隔幾幀記錄一次 checksum（0.5 秒）。 */
export const CHECKSUM_SAMPLE_INTERVAL = 60;
