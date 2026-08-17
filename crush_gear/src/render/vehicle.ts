/**
 * 車體 mesh 建構與每幀更新（§P1.7.1、§P1.7.2）。
 *
 * 底盤、前武器、輪位全部由 `src/data/constants.ts` 衍生 ——
 * 底盤 box 用的是 Rapier 那顆 cuboid collider 的 half-extents 與位移，
 * 前武器則是對 `WEAPON_HULL` 這組**同一份頂點**取凸包。
 * 看到的車與實際碰撞的車因此必然同形。
 */

import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

import {
  CHASSIS_HALF_EXTENTS,
  CHASSIS_OFFSET,
  SUSPENSION_REST_LENGTH,
  WEAPON_HULL,
  WHEEL_ANCHORS,
} from '../data/constants.js';
import {
  COLOR_WEAPON,
  COLOR_WHEEL,
  COLOR_WHEEL_AIRBORNE,
  WEAPON_METALNESS,
  WEAPON_ROUGHNESS,
  WHEEL_SEGMENTS,
  WHEEL_VISUAL_RADIUS,
  WHEEL_VISUAL_WIDTH,
} from './visual.js';

export type VehicleView = {
  /** 套用剛體變換的根節點。 */
  root: THREE.Group;
  /** 四個輪子，順序同 WHEEL_ANCHORS（左前、右前、左後、右後）。 */
  wheels: THREE.Mesh[];
  chassis: THREE.Mesh;
  weapon: THREE.Mesh;
};

const GROUNDED_MATERIAL = new THREE.MeshStandardMaterial({ color: COLOR_WHEEL });
const AIRBORNE_MATERIAL = new THREE.MeshStandardMaterial({ color: COLOR_WHEEL_AIRBORNE });

/**
 * 建立一台車的 mesh 樹。
 *
 * @param bodyColor 車體顏色（純視覺，用來區分 A / B）
 */
export function buildVehicle(bodyColor: number): VehicleView {
  const root = new THREE.Group();
  root.name = 'vehicle';

  // 底盤：與 Rapier 的 cuboid collider 完全同尺寸同位移
  const chassis = new THREE.Mesh(
    new THREE.BoxGeometry(
      CHASSIS_HALF_EXTENTS.x * 2,
      CHASSIS_HALF_EXTENTS.y * 2,
      CHASSIS_HALF_EXTENTS.z * 2,
    ),
    new THREE.MeshStandardMaterial({ color: bodyColor }),
  );
  chassis.position.set(CHASSIS_OFFSET.x, CHASSIS_OFFSET.y, CHASSIS_OFFSET.z);
  chassis.name = 'chassis';
  chassis.castShadow = true;
  root.add(chassis);

  // 前武器：對 WEAPON_HULL 取凸包，與 Rapier 的 convexHull collider 同一組頂點
  const weapon = new THREE.Mesh(
    new ConvexGeometry(WEAPON_HULL.map((p) => new THREE.Vector3(p[0], p[1], p[2]))),
    new THREE.MeshStandardMaterial({
      color: COLOR_WEAPON,
      metalness: WEAPON_METALNESS,
      roughness: WEAPON_ROUGHNESS,
    }),
  );
  weapon.name = 'weapon';
  weapon.castShadow = true;
  root.add(weapon);

  // 輪子：物理上不是剛體，這裡純粹是視覺表現（§P1.7.2）
  const wheelGeometry = new THREE.CylinderGeometry(
    WHEEL_VISUAL_RADIUS,
    WHEEL_VISUAL_RADIUS,
    WHEEL_VISUAL_WIDTH,
    WHEEL_SEGMENTS,
  );
  const wheels: THREE.Mesh[] = [];
  for (let i = 0; i < WHEEL_ANCHORS.length; i += 1) {
    const anchor = WHEEL_ANCHORS[i] as readonly [number, number, number];
    const wheel = new THREE.Mesh(wheelGeometry, GROUNDED_MATERIAL);
    // 圓柱預設軸向為 +Y，轉成沿車體 X 軸（左右）
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(anchor[0], anchor[1], anchor[2]);
    wheel.name = `wheel-${String(i)}`;
    wheel.castShadow = true;
    wheels.push(wheel);
    root.add(wheel);
  }

  return { root, wheels, chassis, weapon };
}

/**
 * 依懸吊壓縮量更新輪子的垂直位置（§P1.7.2）。
 *
 * 輪心固定在錨點正下方 `d − r` 處，其中 d 是該幀懸吊 raycast 的命中距離。
 * 離地時退回自由長度，看起來就是懸吊伸到底。
 *
 * @param suspensionDistance 每輪的命中距離；`null` 代表該輪離地
 */
export function updateWheels(
  view: VehicleView,
  suspensionDistance: readonly (number | null)[],
  highlightAirborne = true,
): void {
  for (let i = 0; i < view.wheels.length; i += 1) {
    const wheel = view.wheels[i] as THREE.Mesh;
    const anchor = WHEEL_ANCHORS[i] as readonly [number, number, number];
    const distance = suspensionDistance[i];
    const grounded = distance !== null && distance !== undefined;
    const d = grounded ? distance : SUSPENSION_REST_LENGTH;
    wheel.position.y = anchor[1] - (d - WHEEL_VISUAL_RADIUS);
    // 離地變色是 §P1.8.2 的第一項疊圖，可獨立關閉。
    wheel.material = grounded || !highlightAirborne ? GROUNDED_MATERIAL : AIRBORNE_MATERIAL;
  }
}

/**
 * 輪子的滾動旋轉（§P1.7.2）。
 *
 * **純視覺，不得試圖從物理推導轉速** —— 模型中輪面線速度本來就是常數（§6.4），
 * 輪子的轉速不是模擬出來的量。
 */
export function spinWheels(view: VehicleView, angle: number): void {
  for (const wheel of view.wheels) wheel.rotation.x = angle;
}
