/**
 * 車體 mesh 建構與每幀更新（§P1.7.1、§P1.7.2）。
 *
 * 底盤、前武器、輪位全部由 `src/data/constants.ts` 衍生 ——
 * 底盤 box 用的是 Rapier 那顆 cuboid collider 的 half-extents 與位移，
 * 每個部件都對 `ResolvedVehicle.parts` 的**同一份資料**建幾何。
 * 看到的車與實際碰撞的車因此必然同形。
 */

import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

import { SUSPENSION_REST_LENGTH } from '../data/constants.js';
import { DEFAULT_VEHICLE, type ResolvedVehicle } from '../sim/vehicle-shape.js';

import {
  COLOR_WEAPON,
  COLOR_WHEEL,
  COLOR_WHEEL_AIRBORNE,
  COLOR_WHEEL_WEAPON,
  SHELL_OPACITY,
  WEAPON_METALNESS,
  WEAPON_ROUGHNESS,
  WHEEL_WIDTH_FACTOR,
  WHEEL_SEGMENTS,
  WHEEL_VISUAL_RADIUS,
} from './visual.js';

export type VehicleView = {
  /** 套用剛體變換的根節點。 */
  root: THREE.Group;
  /** 四個輪子，順序同 WHEEL_ANCHORS（左前、右前、左後、右後）。 */
  wheels: THREE.Mesh[];
  chassis: THREE.Mesh;
  weapon: THREE.Mesh;
  /** 全部部件的 mesh，順序與 shape.parts 相同。 */
  parts: THREE.Mesh[];
  /** 本車的解析後幾何；updateWheels 需要錨點高度。 */
  shape: ResolvedVehicle;
};

const GROUNDED_MATERIAL = new THREE.MeshStandardMaterial({ color: COLOR_WHEEL });
const AIRBORNE_MATERIAL = new THREE.MeshStandardMaterial({ color: COLOR_WHEEL_AIRBORNE });

/**
 * 建立一台車的 mesh 樹。
 *
 * **所有幾何都由 `ResolvedVehicle` 衍生**(§P1.7.1)—— 與 Rapier 建立 collider 時
 * 讀的是同一份 `parts`,因此「看到的車」與「實際碰撞的車」不可能不同步。
 * 第五輪的六件式車體(底盤、外殼、前武器、後武器、輪武器 ×2)全部會被畫出來;
 * 新增部件不需要改這裡,加進 `parts` 就會自動出現。
 *
 * @param bodyColor 車體顏色(純視覺,用來區分 A / B)
 * @param shape     要繪製的車體。省略時為 v1 的凍結車體。
 */
export function buildVehicle(
  bodyColor: number,
  shape: ResolvedVehicle = DEFAULT_VEHICLE,
): VehicleView {
  const root = new THREE.Group();
  root.name = 'vehicle';

  const bodyMaterial = new THREE.MeshStandardMaterial({ color: bodyColor });
  const shellMaterial = new THREE.MeshStandardMaterial({
    color: bodyColor,
    transparent: true,
    opacity: SHELL_OPACITY,
  });
  const weaponMaterial = new THREE.MeshStandardMaterial({
    color: COLOR_WEAPON,
    metalness: WEAPON_METALNESS,
    roughness: WEAPON_ROUGHNESS,
  });
  const wheelWeaponMaterial = new THREE.MeshStandardMaterial({
    color: COLOR_WHEEL_WEAPON,
    metalness: WEAPON_METALNESS,
    roughness: WEAPON_ROUGHNESS,
  });

  /** 部件的材質分派。外殼半透明,否則它會把底盤與輪武器整個蓋住看不到。 */
  const materialFor = (name: string): THREE.MeshStandardMaterial => {
    if (name === 'shell') return shellMaterial;
    if (name.startsWith('wheel-weapon')) return wheelWeaponMaterial;
    if (name.endsWith('weapon')) return weaponMaterial;
    return bodyMaterial;
  };

  const meshes: THREE.Mesh[] = [];
  for (const part of shape.parts) {
    const geometry =
      part.kind === 'cuboid'
        ? new THREE.BoxGeometry(
            part.halfExtents.x * 2,
            part.halfExtents.y * 2,
            part.halfExtents.z * 2,
          )
        : new ConvexGeometry(part.points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
    const mesh = new THREE.Mesh(geometry, materialFor(part.name));
    if (part.kind === 'cuboid') {
      mesh.position.set(part.offset.x, part.offset.y, part.offset.z);
    }
    mesh.name = part.name;
    mesh.castShadow = true;
    meshes.push(mesh);
    root.add(mesh);
  }

  // 輪子：物理上不是剛體，這裡純粹是視覺表現（§P1.7.2）
  const wheelGeometry = new THREE.CylinderGeometry(
    WHEEL_VISUAL_RADIUS,
    WHEEL_VISUAL_RADIUS,
    shape.trackWidth * WHEEL_WIDTH_FACTOR,
    WHEEL_SEGMENTS,
  );
  const wheels: THREE.Mesh[] = [];
  for (let i = 0; i < shape.wheelAnchors.length; i += 1) {
    const anchor = shape.wheelAnchors[i] as readonly [number, number, number];
    const wheel = new THREE.Mesh(wheelGeometry, GROUNDED_MATERIAL);
    // 圓柱預設軸向為 +Y，轉成沿車體 X 軸（左右）
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(anchor[0], anchor[1], anchor[2]);
    wheel.name = `wheel-${String(i)}`;
    wheel.castShadow = true;
    wheels.push(wheel);
    root.add(wheel);
  }

  // chassis / weapon 保留為第一、第二個部件的別名，維持既有呼叫端與測試。
  const chassis = meshes[0] as THREE.Mesh;
  const weapon = (meshes.find((m) => m.name === 'front-weapon') ?? meshes[1] ?? chassis);
  return { root, wheels, chassis, weapon, parts: meshes, shape };
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
    const anchor = view.shape.wheelAnchors[i] as readonly [number, number, number];
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
