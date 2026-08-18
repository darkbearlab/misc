/**
 * 場地與物理世界建構（§4、§5）。
 *
 * 場地為 stadium 形（兩端半圓 + 中央矩形），非正方形：
 *   - 地板為單一矩形 cuboid，上表面位於 y = 0，厚度 0.20 m
 *   - 圍欄內緣貼合 stadium 輪廓，由 2 段直線 + 每端 12 段圓弧共 26 個 Fixed cuboid 組成
 *
 * 圍欄刻意低於車體被推撞時的爬升高度：車輛會爬上圍欄並翻出場外，這是預期行為。
 * 地板與圍欄 friction 刻意為 0：所有摩擦力由 §6.4 的輪胎模型提供，避免雙重摩擦來源
 * 導致調參時無法判斷力的出處。
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type { World } from '@dimforge/rapier3d-compat';

import {
  DT,
  FENCE_ARC_SEGMENTS,
  FENCE_HEIGHT,
  FENCE_OVERLAP_FACTOR,
  FENCE_THICKNESS,
  FLOOR_FRICTION,
  FLOOR_RESTITUTION,
  GRAVITY,
  SOLVER_ITERATIONS,
} from '../data/constants.js';
import { DEFAULT_ARENA, type ResolvedArena } from './arena.js';
import { quatFromAxisAngle, type Quat, type Vec3 } from './types.js';

let rapierReady: Promise<void> | null = null;

/**
 * 載入並初始化 Rapier 的 wasm 模組。可重複呼叫，只會實際初始化一次。
 *
 * 註：這是模組層級的初始化，不是模擬迴圈中的 I/O（§3.6 禁止的是模擬過程中的檔案／主控台存取）。
 */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

/** 一段圍欄的長方體描述。 */
type FenceSegment = {
  readonly center: Vec3;
  readonly halfExtents: Vec3;
  readonly rotation: Quat;
};

const AXIS_Y: Vec3 = { x: 0, y: 1, z: 0 };
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

const FENCE_HALF_THICKNESS = FENCE_THICKNESS / 2;
const FENCE_HALF_HEIGHT = FENCE_HEIGHT / 2;

/** 每段圓弧的圓心角。 */
const ARC_STEP = Math.PI / FENCE_ARC_SEGMENTS;

/**
 * 產生全部 26 段圍欄，順序固定（§9.3）：
 *   1. 直線段 2 段，依 x 由小到大（−X、+X）
 *   2. +Z 端半圓 12 段，依 θ 遞增
 *   3. −Z 端半圓 12 段，依 θ 遞增
 *
 * θ 自 0° 起算、每段 15°，第 i 段中心位於 θ = (i + 0.5)·15°，
 * 12 段恰好涵蓋各端的 180°。
 *
 * 圓弧段的切線方向半長以**外緣**半徑計算並乘上重疊係數，
 * 確保相鄰段在內外緣都重疊、不留縫隙 —— 圍欄縫隙會讓車輛卡住或穿出，
 * 是此結構的最主要風險（§5.2）。
 */
export function buildFenceSegments(arena: ResolvedArena = DEFAULT_ARENA): FenceSegment[] {
  const segments: FenceSegment[] = [];

  // 圍欄段中心線的半徑：內緣貼合 fieldRadius，向外延伸 FENCE_THICKNESS
  const centerRadius = arena.fieldRadius + FENCE_HALF_THICKNESS;
  const chordHalf = arena.fenceOuterRadius * Math.tan(ARC_STEP / 2) * FENCE_OVERLAP_FACTOR;
  const halfSegment = arena.halfSegment;

  for (const sign of [-1, 1]) {
    segments.push({
      center: { x: sign * centerRadius, y: FENCE_HALF_HEIGHT, z: 0 },
      halfExtents: { x: FENCE_HALF_THICKNESS, y: FENCE_HALF_HEIGHT, z: halfSegment },
      rotation: IDENTITY,
    });
  }

  // +Z 端：圓心 (0, +halfSegment)。局部 +X 對齊徑向 → 繞 Y 旋轉 −θ。
  for (let i = 0; i < FENCE_ARC_SEGMENTS; i += 1) {
    const theta = (i + 0.5) * ARC_STEP;
    segments.push({
      center: {
        x: centerRadius * Math.cos(theta),
        y: FENCE_HALF_HEIGHT,
        z: halfSegment + centerRadius * Math.sin(theta),
      },
      halfExtents: { x: FENCE_HALF_THICKNESS, y: FENCE_HALF_HEIGHT, z: chordHalf },
      rotation: quatFromAxisAngle(AXIS_Y, -theta),
    });
  }

  // −Z 端：圓心 (0, −halfSegment)。徑向為 (cosθ, 0, −sinθ) → 繞 Y 旋轉 +θ。
  for (let i = 0; i < FENCE_ARC_SEGMENTS; i += 1) {
    const theta = (i + 0.5) * ARC_STEP;
    segments.push({
      center: {
        x: centerRadius * Math.cos(theta),
        y: FENCE_HALF_HEIGHT,
        z: -halfSegment - centerRadius * Math.sin(theta),
      },
      halfExtents: { x: FENCE_HALF_THICKNESS, y: FENCE_HALF_HEIGHT, z: chordHalf },
      rotation: quatFromAxisAngle(AXIS_Y, theta),
    });
  }

  return segments;
}

/**
 * 建立物理世界並構築場地。
 *
 * 回傳的 world 已經完成一次「暖機 step」（§14.5）：Rapier 0.19 的場景查詢結構
 * （broad-phase BVH）只在 `world.step()` 中重建，若不暖機，第 0 幀的懸吊
 * raycast 會全部落空，導致低空投擲的第一幀缺少懸吊力。此時世界中只有 Fixed
 * 剛體，這一步在物理上完全是 no-op，且每次執行都以完全相同的方式進行，
 * 不影響決定性。車輛必須在本函式回傳後才建立。
 */
/**
 * §第四輪的對照組所需的 collision group。
 *
 * Rapier 的配對條件是**雙向**的:
 * `(A.membership & B.filter) != 0 && (B.membership & A.filter) != 0`。
 * 因此光是把輪武器的 filter 收窄無效 —— 地板的 membership 是全 1,仍然通得過。
 * 必須讓地板／圍欄擁有一個車體不共用的 membership 位元。
 *
 * **預設路徑完全不呼叫 `setCollisionGroups`。** 只有在需要關掉輪武器的地面碰撞時,
 * 才把環境與車體一起打上標籤;不然就是預設的 0xFFFFFFFF,與 v1 位元相同。
 */
/** 環境（地板、圍欄）：membership = bit 2，filter = 全部。 */
export const ENVIRONMENT_GROUPS = 0x0002_ffff;
/** 車體一般部件：membership = bit 1，filter = 全部。 */
export const VEHICLE_GROUPS = 0x0001_ffff;
/** 只與車體碰撞、不與環境碰撞：membership = bit 1，filter = 只有 bit 1。 */
export const VEHICLE_ONLY_GROUPS = 0x0001_0001;

export function createWorld(
  arena: ResolvedArena = DEFAULT_ARENA,
  /**
   * 為環境 collider 指定 collision group。
   *
   * **不指定時完全不呼叫 `setCollisionGroups`**，維持 Rapier 的預設 0xFFFFFFFF，
   * 因此 v1 的執行路徑位元不變。只有「輪武器不參與地面碰撞」的對照組會傳入。
   */
  environmentGroups?: number,
  /**
   * 非輪子部件對**地板**的摩擦係數（§5.5 例外，§第五輪新增）。
   *
   * 不指定時維持 FLOOR_FRICTION = 0，即 v1 的行為。
   *
   * 只設在地板上、且以 Max 合成 —— 這樣它只影響「車體 collider 對地板」：
   *   - 輪胎完全不受影響：輪子是 raycast，根本沒有 collider（§6.4）
   *   - 車對車仍為 0：兩邊都是車體 collider，max(0, 0) = 0
   * 若改設在車體 collider 上，車對車也會跟著有摩擦，那超出本例外的範圍。
   */
  nonWheelFriction?: number,
  /** 單一物理步的時間（§第五輪 substep）。不指定時為 DT。 */
  physicsDt?: number,
): World {
  const world = new RAPIER.World(GRAVITY);
  world.integrationParameters.dt = physicsDt ?? DT;
  world.integrationParameters.numSolverIterations = SOLVER_ITERATIONS;

  // 地板：單一矩形 cuboid，上表面對齊 y = 0
  const floor = arena.floorHalfExtents;
  const floorBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -floor.y, 0),
  );
  const floorDesc = RAPIER.ColliderDesc.cuboid(floor.x, floor.y, floor.z)
    .setFriction(nonWheelFriction ?? FLOOR_FRICTION)
    .setRestitution(FLOOR_RESTITUTION);
  if (nonWheelFriction !== undefined) {
    floorDesc.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max);
  }
  if (environmentGroups !== undefined) floorDesc.setCollisionGroups(environmentGroups);
  world.createCollider(floorDesc, floorBody);

  // 圍欄：順序固定，不得更動
  for (const segment of buildFenceSegments(arena)) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(segment.center.x, segment.center.y, segment.center.z)
        .setRotation(segment.rotation),
    );
    const fenceDesc = RAPIER.ColliderDesc.cuboid(
      segment.halfExtents.x,
      segment.halfExtents.y,
      segment.halfExtents.z,
    )
      .setFriction(FLOOR_FRICTION)
      .setRestitution(FLOOR_RESTITUTION);
    if (environmentGroups !== undefined) fenceDesc.setCollisionGroups(environmentGroups);
    world.createCollider(fenceDesc, body);
  }

  world.step();

  return world;
}
