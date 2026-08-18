/**
 * three.js 場景建構：場地、燈光、相機（§P1.7）。
 *
 * **所有幾何尺寸都從 `src/data/constants.ts` 衍生，沒有任何硬編數值。**
 * 圍欄更直接重用 `src/sim/world.ts` 的 `buildFenceSegments()` —— 那正是物理世界
 * 建構圍欄時用的同一份資料，因此視覺與碰撞不可能不同步。
 */

import * as THREE from 'three';

import {
  FENCE_HEIGHT,
  FIELD_HALF_SEGMENT,
  FIELD_RADIUS,
  FLOOR_HALF_EXTENTS,
  OUT_THRESHOLD,
} from '../data/constants.js';
import { buildFenceSegments } from '../sim/world.js';
import {
  AMBIENT_INTENSITY,
  ARENA_CURVE_SEGMENTS,
  CAMERA_FAR,
  CAMERA_FOV,
  CAMERA_NEAR,
  COLOR_ARENA_SURFACE,
  COLOR_BACKGROUND,
  COLOR_FENCE,
  COLOR_OUT_RING,
  COLOR_PHYSICS_FLOOR,
  FILL_LIGHT_INTENSITY,
  KEY_LIGHT_INTENSITY,
  OUT_RING_OPACITY,
  OUT_RING_WIDTH_FACTOR,
  OVERVIEW_DISTANCE_FACTOR,
  OVERVIEW_HEIGHT_FACTOR,
} from './visual.js';

/**
 * Stadium 輪廓：兩端半圓 + 中央直線段，半徑為參數。
 *
 * 這是 `stadiumDistance() === radius` 的等值線，形狀與 §8.1 的出界判定完全同源。
 */
export function stadiumShape(radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(radius, -FIELD_HALF_SEGMENT);
  shape.lineTo(radius, FIELD_HALF_SEGMENT);
  shape.absarc(0, FIELD_HALF_SEGMENT, radius, 0, Math.PI, false);
  shape.lineTo(-radius, -FIELD_HALF_SEGMENT);
  shape.absarc(0, -FIELD_HALF_SEGMENT, radius, Math.PI, Math.PI * 2, false);
  shape.closePath();
  shape.curves.forEach((c) => {
    if (c instanceof THREE.EllipseCurve) c.updateArcLengths();
  });
  return shape;
}

/** 把 XY 平面上的形狀轉到 XZ 平面（y = 高度）。 */
function toGroundPlane(object: THREE.Object3D, height: number): void {
  object.rotation.x = -Math.PI / 2;
  object.position.y = height;
}

/**
 * 建立整個場地。
 *
 * 三層由下而上：
 *   1. 實際的物理地板（矩形 cuboid，刻意不貼合輪廓 —— §5.3）
 *   2. stadium 形的比賽區表面，標示圍欄內緣所圍出的範圍
 *   3. 26 段圍欄，位置與旋轉直接取自物理世界的建構函式
 * 另加一圈出界門檻線，讓 §8.1 的判定邊界看得見。
 *
 * curveSegments 是**純渲染**參數（Phase 1-e §4）：只影響 stadium 表面與出界環的折線
 * 段數，不影響任何幾何尺寸，更不影響物理 —— 圍欄的位置與碰撞形狀仍完全來自
 * buildFenceSegments()。低階裝置降低它可以少畫幾百個三角形。
 */
export function buildArena(curveSegments: number = ARENA_CURVE_SEGMENTS): THREE.Group {
  const arena = new THREE.Group();
  arena.name = 'arena';

  // 1. 物理地板：真正存在於 Rapier 世界中的那塊矩形
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(
      FLOOR_HALF_EXTENTS.x * 2,
      FLOOR_HALF_EXTENTS.y * 2,
      FLOOR_HALF_EXTENTS.z * 2,
    ),
    new THREE.MeshStandardMaterial({ color: COLOR_PHYSICS_FLOOR }),
  );
  floor.position.y = -FLOOR_HALF_EXTENTS.y;
  floor.name = 'physics-floor';
  floor.receiveShadow = true;
  arena.add(floor);

  // 2. 比賽區表面（純視覺，物理上仍是上面那塊矩形）
  const surfaceShape = stadiumShape(FIELD_RADIUS);
  const surface = new THREE.Mesh(
    new THREE.ShapeGeometry(surfaceShape, curveSegments),
    new THREE.MeshStandardMaterial({
      color: COLOR_ARENA_SURFACE,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
  );
  toGroundPlane(surface, 0);
  surface.name = 'arena-surface';
  surface.receiveShadow = true;
  arena.add(surface);

  // 3. 圍欄：與物理世界共用同一份 segment 資料
  const fenceMaterial = new THREE.MeshStandardMaterial({ color: COLOR_FENCE });
  const fences = new THREE.Group();
  fences.name = 'fence';
  for (const segment of buildFenceSegments()) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(
        segment.halfExtents.x * 2,
        segment.halfExtents.y * 2,
        segment.halfExtents.z * 2,
      ),
      fenceMaterial,
    );
    mesh.position.set(segment.center.x, segment.center.y, segment.center.z);
    mesh.quaternion.set(
      segment.rotation.x,
      segment.rotation.y,
      segment.rotation.z,
      segment.rotation.w,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    fences.add(mesh);
  }
  arena.add(fences);

  // 出界門檻線（§8.1 的 stadiumDistance > OUT_THRESHOLD）
  const ringWidth = FIELD_RADIUS * OUT_RING_WIDTH_FACTOR;
  const outer = stadiumShape(OUT_THRESHOLD + ringWidth);
  outer.holes.push(new THREE.Path(stadiumShape(OUT_THRESHOLD).getPoints(curveSegments)));
  const ring = new THREE.Mesh(
    new THREE.ShapeGeometry(outer, curveSegments),
    new THREE.MeshBasicMaterial({
      color: COLOR_OUT_RING,
      transparent: true,
      opacity: OUT_RING_OPACITY,
    }),
  );
  toGroundPlane(ring, FENCE_HEIGHT / 2);
  ring.name = 'out-threshold';
  arena.add(ring);

  return arena;
}

/** 場地的最大水平半徑，供相機取景使用。 */
export function arenaExtent(): number {
  return FIELD_HALF_SEGMENT + OUT_THRESHOLD;
}

export function buildLights(): THREE.Group {
  const lights = new THREE.Group();
  lights.name = 'lights';

  lights.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));

  const extent = arenaExtent();
  const key = new THREE.DirectionalLight(0xffffff, KEY_LIGHT_INTENSITY);
  key.name = 'key-light';
  key.position.set(extent, extent * 2, extent);
  key.castShadow = true;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.camera.near = CAMERA_NEAR;
  key.shadow.camera.far = extent * 4;
  lights.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, FILL_LIGHT_INTENSITY);
  fill.position.set(-extent, extent, -extent);
  lights.add(fill);

  return lights;
}

export function buildScene(curveSegments: number = ARENA_CURVE_SEGMENTS): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLOR_BACKGROUND);
  scene.add(buildArena(curveSegments));
  scene.add(buildLights());
  return scene;
}

export function buildCamera(aspect: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, CAMERA_NEAR, CAMERA_FAR);
  applyOverviewCamera(camera);
  return camera;
}

/** 全景：固定俯視偏角，涵蓋整個 stadium。 */
export function applyOverviewCamera(camera: THREE.PerspectiveCamera): void {
  const extent = arenaExtent();
  camera.position.set(0, extent * OVERVIEW_HEIGHT_FACTOR, extent * OVERVIEW_DISTANCE_FACTOR);
  camera.lookAt(0, 0, 0);
}
