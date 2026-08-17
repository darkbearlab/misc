/**
 * 除錯疊圖（§P1.8.2）。
 *
 * 這組疊圖是 §15 調參階段的主要工具，其中兩項是下一階段的儀表：
 *   - **輪胎力向量**：判斷摩擦係數 μ 的調整方向
 *   - **法向力 N**：判讀翻覆成因（車體傾斜時外側輪與內側輪的分配差異）
 *
 * 所有數值都直接來自 `TrajectoryDiagnostics` 的旁路記錄，
 * 疊圖只做「數值 → 幾何長度」的線性換算，不重新計算任何物理量。
 * 換算函式刻意做成純函式並單獨匯出，讓單元測試能驗證顯示值與診斷資料一致（驗收 5）。
 */

import * as THREE from 'three';

import { FIELD_HALF_SEGMENT, FLIP_HOLD_FRAMES, OUT_THRESHOLD } from '../data/constants.js';
import type { Trajectory } from '../replay/trajectory.js';
import type { TrajectoryPlayer } from './player.js';
import {
  COLOR_COM,
  COLOR_NORMAL_FORCE,
  COLOR_STADIUM_LINE,
  COLOR_STADIUM_LINE_DANGER,
  COLOR_TIRE_FORCE,
  COLOR_UP_VECTOR,
  COM_MARKER_RADIUS,
  NORMAL_FORCE_BAR_THICKNESS,
  NORMAL_FORCE_METRES_PER_NEWTON,
  TIRE_FORCE_METRES_PER_NEWTON,
  UP_VECTOR_LENGTH,
} from './visual.js';

export const OVERLAY_FEATURES = [
  'wheelGrounded',
  'normalForce',
  'tireForce',
  'centerOfMass',
  'stadiumDistance',
  'flipCounter',
] as const;

export type OverlayFeature = (typeof OVERLAY_FEATURES)[number];

export const OVERLAY_LABELS: Record<OverlayFeature, string> = {
  wheelGrounded: '四輪接地狀態',
  normalForce: '法向力 N',
  tireForce: '輪胎力向量',
  centerOfMass: '重心與 up vector',
  stadiumDistance: 'stadium 距離',
  flipCounter: 'FLIP 計數器',
};

const WHEEL_COUNT = 4;
const CAR_COUNT = 2;

// ──────────────────────────────────────────────────────────────────────────
// 換算（純函式，供單元測試直接驗證 —— 驗收條件 5）
// ──────────────────────────────────────────────────────────────────────────

/** 法向力 N（牛頓）→ 柱狀指示的高度（公尺）。 */
export function normalForceBarHeight(newtons: number): number {
  return Math.max(0, newtons) * NORMAL_FORCE_METRES_PER_NEWTON;
}

/** 輪胎力大小（牛頓）→ 箭頭長度（公尺）。 */
export function tireForceArrowLength(newtons: number): number {
  return Math.max(0, newtons) * TIRE_FORCE_METRES_PER_NEWTON;
}

/** 自診斷資料讀出某輪的輪胎力向量。 */
export function readTireForce(
  diagnostics: NonNullable<Trajectory['diagnostics']>,
  car: number,
  frame: number,
  wheel: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const array = diagnostics.tireForce[car];
  if (array === undefined) return out.set(0, 0, 0);
  const i = (frame * WHEEL_COUNT + wheel) * 3;
  return out.set(array[i] ?? 0, array[i + 1] ?? 0, array[i + 2] ?? 0);
}

/** 自診斷資料讀出某輪的接觸點。 */
export function readContactPoint(
  diagnostics: NonNullable<Trajectory['diagnostics']>,
  car: number,
  frame: number,
  wheel: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const array = diagnostics.contactPoint[car];
  if (array === undefined) return out.set(0, 0, 0);
  const i = (frame * WHEEL_COUNT + wheel) * 3;
  return out.set(array[i] ?? 0, array[i + 1] ?? 0, array[i + 2] ?? 0);
}

/** 車體重心的世界座標 = 剛體原點 + 旋轉 · 局部質心。 */
export function centerOfMassWorld(
  origin: THREE.Vector3,
  rotation: THREE.Quaternion,
  localCom: { x: number; y: number; z: number },
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(localCom.x, localCom.y, localCom.z).applyQuaternion(rotation).add(origin);
}

/**
 * stadium 中心線上離某點最近的位置 —— 距離線的另一端。
 * 中心線是 z ∈ [−L/2, L/2] 上的線段，因此只需夾擠 z。
 */
export function nearestCentreLinePoint(z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(0, 0, Math.max(-FIELD_HALF_SEGMENT, Math.min(FIELD_HALF_SEGMENT, z)));
}

// ──────────────────────────────────────────────────────────────────────────
// 疊圖
// ──────────────────────────────────────────────────────────────────────────

type CarOverlay = {
  normalBars: THREE.Mesh[];
  tireArrows: THREE.ArrowHelper[];
  comMarker: THREE.Mesh;
  upArrow: THREE.ArrowHelper;
  distanceLine: THREE.Line;
};

/** 一個浮動數值標籤（HTML，投影到接觸點上方）。 */
type Label = { element: HTMLElement; anchor: THREE.Vector3 };

export class DebugOverlay {
  readonly group = new THREE.Group();
  /** 浮動數值標籤的容器，由 main 掛到 viewport 上。 */
  readonly labelLayer: HTMLElement;

  private readonly cars: CarOverlay[] = [];
  private readonly labels: Label[] = [];
  private readonly enabled = new Set<OverlayFeature>();
  private showValues = false;

  private readonly scratch = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();

  /**
   * 讓疊圖穿透車體繪製。
   *
   * 接觸點在車底，法向力柱與輪胎力箭頭若照常做深度測試就會被底盤與輪子整個擋住 ——
   * 而 §P1.8.2 要求這兩項「可精確判讀」。除錯 gizmo 關掉深度測試是標準作法。
   */
  private static seeThrough(object: THREE.Object3D): void {
    object.renderOrder = 999;
    object.traverse((node) => {
      const material = (node as THREE.Mesh | THREE.Line).material;
      if (material === undefined) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        m.depthTest = false;
        m.depthWrite = false;
        m.transparent = true;
      }
      node.renderOrder = 999;
    });
  }

  constructor(labelLayer: HTMLElement) {
    this.group.name = 'debug-overlay';
    this.labelLayer = labelLayer;

    const barGeometry = new THREE.BoxGeometry(
      NORMAL_FORCE_BAR_THICKNESS,
      1,
      NORMAL_FORCE_BAR_THICKNESS,
    );

    for (let car = 0; car < CAR_COUNT; car += 1) {
      const normalBars: THREE.Mesh[] = [];
      const tireArrows: THREE.ArrowHelper[] = [];

      for (let wheel = 0; wheel < WHEEL_COUNT; wheel += 1) {
        const bar = new THREE.Mesh(
          barGeometry,
          new THREE.MeshBasicMaterial({ color: COLOR_NORMAL_FORCE }),
        );
        bar.visible = false;
        normalBars.push(bar);
        this.group.add(bar);

        const arrow = new THREE.ArrowHelper(
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(),
          1,
          COLOR_TIRE_FORCE,
        );
        arrow.visible = false;
        tireArrows.push(arrow);
        this.group.add(arrow);

        this.labels.push({ element: this.createLabel(), anchor: new THREE.Vector3() });
      }

      const comMarker = new THREE.Mesh(
        new THREE.SphereGeometry(COM_MARKER_RADIUS, 12, 8),
        new THREE.MeshBasicMaterial({ color: COLOR_COM }),
      );
      comMarker.visible = false;
      this.group.add(comMarker);

      const upArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(),
        UP_VECTOR_LENGTH,
        COLOR_UP_VECTOR,
      );
      upArrow.visible = false;
      this.group.add(upArrow);

      const distanceLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
        new THREE.LineBasicMaterial({ color: COLOR_STADIUM_LINE }),
      );
      distanceLine.visible = false;
      this.group.add(distanceLine);

      this.cars.push({ normalBars, tireArrows, comMarker, upArrow, distanceLine });
      // 每台車一個 FLIP / 距離文字標籤
      this.labels.push({ element: this.createLabel(), anchor: new THREE.Vector3() });
    }

    DebugOverlay.seeThrough(this.group);
  }

  private createLabel(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'overlay-label';
    element.style.display = 'none';
    this.labelLayer.append(element);
    return element;
  }

  // ── 開關 ──────────────────────────────────────────────────────────────

  setFeature(feature: OverlayFeature, on: boolean): void {
    if (on) this.enabled.add(feature);
    else this.enabled.delete(feature);
  }

  isEnabled(feature: OverlayFeature): boolean {
    return this.enabled.has(feature);
  }

  setShowValues(on: boolean): void {
    this.showValues = on;
  }

  get valuesShown(): boolean {
    return this.showValues;
  }

  /** 全部隱藏（沒有軌跡時）。 */
  clear(): void {
    for (const car of this.cars) {
      for (const bar of car.normalBars) bar.visible = false;
      for (const arrow of car.tireArrows) arrow.visible = false;
      car.comMarker.visible = false;
      car.upArrow.visible = false;
      car.distanceLine.visible = false;
    }
    for (const label of this.labels) label.element.style.display = 'none';
  }

  // ── 每幀更新 ──────────────────────────────────────────────────────────

  update(player: TrajectoryPlayer, camera: THREE.Camera, viewport: HTMLElement): void {
    const diagnostics = player.trajectory.diagnostics;
    if (diagnostics === undefined) {
      this.clear();
      return;
    }

    const frame = player.frame;
    let labelIndex = 0;

    for (let car = 0; car < CAR_COUNT; car += 1) {
      const overlay = this.cars[car] as CarOverlay;
      const grounded = diagnostics.wheelGrounded[car];
      const forces = diagnostics.normalForce[car];

      // 取這一幀的剛體變換（與車體 mesh 用同一組取樣，確保疊圖不會與車錯位）
      player.sampleTransform(car, ORIGIN, ROTATION);

      for (let wheel = 0; wheel < WHEEL_COUNT; wheel += 1) {
        const isGrounded = grounded?.[frame * WHEEL_COUNT + wheel] === 1;
        readContactPoint(diagnostics, car, frame, wheel, CONTACT);

        // ── 法向力柱 ──
        const bar = overlay.normalBars[wheel] as THREE.Mesh;
        const newtons = forces?.[frame * WHEEL_COUNT + wheel] ?? 0;
        const height = normalForceBarHeight(newtons);
        const showBar = this.enabled.has('normalForce') && isGrounded && height > 0;
        bar.visible = showBar;
        if (showBar) {
          bar.scale.y = height;
          bar.position.set(CONTACT.x, CONTACT.y + height / 2, CONTACT.z);
        }

        // ── 輪胎力箭頭 ──
        const arrow = overlay.tireArrows[wheel] as THREE.ArrowHelper;
        readTireForce(diagnostics, car, frame, wheel, FORCE);
        const magnitude = FORCE.length();
        const showArrow = this.enabled.has('tireForce') && isGrounded && magnitude > 0;
        arrow.visible = showArrow;
        if (showArrow) {
          arrow.position.copy(CONTACT);
          arrow.setDirection(DIRECTION.copy(FORCE).divideScalar(magnitude));
          arrow.setLength(tireForceArrowLength(magnitude));
        }

        // ── 數值標籤 ──
        const label = this.labels[labelIndex] as Label;
        labelIndex += 1;
        const showLabel =
          this.showValues && isGrounded && (this.enabled.has('tireForce') || this.enabled.has('normalForce'));
        if (showLabel) {
          const parts: string[] = [];
          if (this.enabled.has('normalForce')) parts.push(`N ${newtons.toFixed(3)}`);
          if (this.enabled.has('tireForce')) parts.push(`F ${magnitude.toFixed(3)}`);
          label.element.textContent = parts.join('  ');
          label.anchor.copy(CONTACT);
          this.placeLabel(label, camera, viewport, true);
        } else {
          label.element.style.display = 'none';
        }
      }

      // ── 重心與 up vector ──
      const localCom = diagnostics.localCenterOfMass[car] ?? { x: 0, y: 0, z: 0 };
      centerOfMassWorld(ORIGIN, ROTATION, localCom, COM);
      const showCom = this.enabled.has('centerOfMass');
      overlay.comMarker.visible = showCom;
      overlay.upArrow.visible = showCom;
      if (showCom) {
        overlay.comMarker.position.copy(COM);
        overlay.upArrow.position.copy(COM);
        overlay.upArrow.setDirection(UP.set(0, 1, 0).applyQuaternion(ROTATION));
      }

      // ── stadium 距離 ──
      const distance = diagnostics.stadiumDist[car]?.[frame] ?? 0;
      const showDistance = this.enabled.has('stadiumDistance');
      overlay.distanceLine.visible = showDistance;
      if (showDistance) {
        nearestCentreLinePoint(COM.z, this.scratch);
        const attribute = overlay.distanceLine.geometry.getAttribute('position');
        attribute.setXYZ(0, this.scratch.x, this.scratch.y, this.scratch.z);
        attribute.setXYZ(1, COM.x, 0, COM.z);
        attribute.needsUpdate = true;
        overlay.distanceLine.geometry.computeBoundingSphere();
        (overlay.distanceLine.material as THREE.LineBasicMaterial).color.setHex(
          distance > OUT_THRESHOLD ? COLOR_STADIUM_LINE_DANGER : COLOR_STADIUM_LINE,
        );
      }

      // ── 車體上方的文字（距離 + FLIP 計數） ──
      const carLabel = this.labels[labelIndex] as Label;
      labelIndex += 1;
      const flip = diagnostics.flipCounter[car]?.[frame] ?? 0;
      const showCarLabel = showDistance || this.enabled.has('flipCounter');
      if (showCarLabel) {
        const parts: string[] = [];
        if (showDistance) {
          parts.push(`d ${distance.toFixed(3)} / ${OUT_THRESHOLD.toFixed(2)}`);
        }
        if (this.enabled.has('flipCounter')) {
          parts.push(`FLIP ${String(flip)}/${String(FLIP_HOLD_FRAMES)}`);
        }
        carLabel.element.textContent = parts.join('   ');
        carLabel.element.classList.toggle('warn', flip > FLIP_HOLD_FRAMES / 2);
        carLabel.anchor.set(COM.x, COM.y + UP_VECTOR_LENGTH, COM.z);
        this.placeLabel(carLabel, camera, viewport, false);
      } else {
        carLabel.element.style.display = 'none';
      }
    }
  }

  private placeLabel(
    label: Label,
    camera: THREE.Camera,
    viewport: HTMLElement,
    small: boolean,
  ): void {
    this.projected.copy(label.anchor).project(camera);
    if (this.projected.z > 1) {
      label.element.style.display = 'none';
      return;
    }
    const x = (this.projected.x * 0.5 + 0.5) * viewport.clientWidth;
    const y = (-this.projected.y * 0.5 + 0.5) * viewport.clientHeight;
    label.element.style.display = 'block';
    label.element.style.transform = `translate(-50%, -50%) translate(${String(x)}px, ${String(y)}px)`;
    label.element.classList.toggle('small', small);
  }
}

// 迴圈外的暫存物件，避免每幀配置
const ORIGIN = new THREE.Vector3();
const ROTATION = new THREE.Quaternion();
const CONTACT = new THREE.Vector3();
const FORCE = new THREE.Vector3();
const COM = new THREE.Vector3();
const UP = new THREE.Vector3();
const DIRECTION = new THREE.Vector3();
