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
  FIELD_HALF_SEGMENT,
  FIELD_RADIUS,
  FLOOR_FRICTION,
  FLOOR_HALF_EXTENTS,
  FLOOR_RESTITUTION,
  GRAVITY,
  SOLVER_ITERATIONS,
} from '../data/constants.js';
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

/** 圍欄段中心線的半徑：內緣貼合 FIELD_RADIUS，向外延伸 FENCE_THICKNESS。 */
const FENCE_CENTER_RADIUS = FIELD_RADIUS + FENCE_HALF_THICKNESS;

/** 每段圓弧的圓心角。 */
const ARC_STEP = Math.PI / FENCE_ARC_SEGMENTS;

/**
 * 每段圓弧的切線方向半長。
 * 以外緣半徑計算並乘上重疊係數，確保相鄰段在內外緣都重疊、不留縫隙。
 */
const ARC_CHORD_HALF =
  (FIELD_RADIUS + FENCE_THICKNESS) * Math.tan(ARC_STEP / 2) * FENCE_OVERLAP_FACTOR;

/**
 * 產生全部 26 段圍欄，順序固定（§9.3）：
 *   1. 直線段 2 段，依 x 由小到大（−X、+X）
 *   2. +Z 端半圓 12 段，依 θ 遞增
 *   3. −Z 端半圓 12 段，依 θ 遞增
 *
 * θ 自 0° 起算、每段 15°，第 i 段中心位於 θ = (i + 0.5)·15°，
 * 12 段恰好涵蓋各端的 180°。
 */
export function buildFenceSegments(): FenceSegment[] {
  const segments: FenceSegment[] = [];

  for (const sign of [-1, 1]) {
    segments.push({
      center: { x: sign * FENCE_CENTER_RADIUS, y: FENCE_HALF_HEIGHT, z: 0 },
      halfExtents: { x: FENCE_HALF_THICKNESS, y: FENCE_HALF_HEIGHT, z: FIELD_HALF_SEGMENT },
      rotation: IDENTITY,
    });
  }

  // +Z 端：圓心 (0, +FIELD_HALF_SEGMENT)。局部 +X 對齊徑向 → 繞 Y 旋轉 −θ。
  for (let i = 0; i < FENCE_ARC_SEGMENTS; i += 1) {
    const theta = (i + 0.5) * ARC_STEP;
    segments.push({
      center: {
        x: FENCE_CENTER_RADIUS * Math.cos(theta),
        y: FENCE_HALF_HEIGHT,
        z: FIELD_HALF_SEGMENT + FENCE_CENTER_RADIUS * Math.sin(theta),
      },
      halfExtents: { x: FENCE_HALF_THICKNESS, y: FENCE_HALF_HEIGHT, z: ARC_CHORD_HALF },
      rotation: quatFromAxisAngle(AXIS_Y, -theta),
    });
  }

  // −Z 端：圓心 (0, −FIELD_HALF_SEGMENT)。徑向為 (cosθ, 0, −sinθ) → 繞 Y 旋轉 +θ。
  for (let i = 0; i < FENCE_ARC_SEGMENTS; i += 1) {
    const theta = (i + 0.5) * ARC_STEP;
    segments.push({
      center: {
        x: FENCE_CENTER_RADIUS * Math.cos(theta),
        y: FENCE_HALF_HEIGHT,
        z: -FIELD_HALF_SEGMENT - FENCE_CENTER_RADIUS * Math.sin(theta),
      },
      halfExtents: { x: FENCE_HALF_THICKNESS, y: FENCE_HALF_HEIGHT, z: ARC_CHORD_HALF },
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
export function createWorld(): World {
  const world = new RAPIER.World(GRAVITY);
  world.integrationParameters.dt = DT;
  world.integrationParameters.numSolverIterations = SOLVER_ITERATIONS;

  // 地板：單一矩形 cuboid，上表面對齊 y = 0
  const floorBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -FLOOR_HALF_EXTENTS.y, 0),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(FLOOR_HALF_EXTENTS.x, FLOOR_HALF_EXTENTS.y, FLOOR_HALF_EXTENTS.z)
      .setFriction(FLOOR_FRICTION)
      .setRestitution(FLOOR_RESTITUTION),
    floorBody,
  );

  // 圍欄：順序固定，不得更動
  for (const segment of buildFenceSegments()) {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(segment.center.x, segment.center.y, segment.center.z)
        .setRotation(segment.rotation),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        segment.halfExtents.x,
        segment.halfExtents.y,
        segment.halfExtents.z,
      )
        .setFriction(FLOOR_FRICTION)
        .setRestitution(FLOOR_RESTITUTION),
      body,
    );
  }

  world.step();

  return world;
}
