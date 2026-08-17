/**
 * Replay 播放器進入點（§P1.2.1）。
 *
 * 流程嚴格分為兩段：
 *   1. 產生：`generateTrajectory()` 跑完整場戰鬥 → Trajectory
 *   2. 播放：讀 Trajectory → 繪製
 *
 * **這裡不持有 Rapier 世界、不呼叫 `world.step()`、不依 rAF 的 delta 推進任何物理。**
 * rAF 的 delta 只用來換算「該顯示第幾幀」，模擬結果早在第 1 段就完全定案。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { WHEEL_SURFACE_SPEED } from '../data/constants.js';
import { generateTrajectory, type Trajectory } from '../replay/trajectory.js';
import { initPhysics } from '../sim/world.js';
import type { BattleInput } from '../sim/types.js';
import { Controls, type CameraMode } from '../ui/controls.js';
import {
  applyOverviewCamera,
  arenaExtent,
  buildCamera,
  buildScene,
} from './scene.js';
import { DebugOverlay, type OverlayFeature } from './overlay.js';
import { describeOutcome, TrajectoryPlayer } from './player.js';
import { buildVehicle, spinWheels, updateWheels, type VehicleView } from './vehicle.js';
import {
  COLOR_CAR_A,
  COLOR_CAR_B,
  FOLLOW_DISTANCE_FACTOR,
  FOLLOW_HEIGHT_FACTOR,
  FOLLOW_SMOOTHING,
  WHEEL_VISUAL_RADIUS,
} from './visual.js';

// ── 範例輸入 ────────────────────────────────────────────────────────────

type SampleFile = { seed: number; throwA: BattleInput['throwA']; throwB: BattleInput['throwB'] };

const sampleModules = import.meta.glob<SampleFile>('../../sample_battles/*.json', {
  eager: true,
});

const SAMPLES = new Map<string, BattleInput>();
for (const [path, mod] of Object.entries(sampleModules)) {
  const name = path.split('/').pop()?.replace(/\.json$/, '');
  if (name === undefined || name === 'batch_example') continue;
  SAMPLES.set(name, { seed: mod.seed, throwA: mod.throwA, throwB: mod.throwB });
}

// ── 場景 ────────────────────────────────────────────────────────────────

const app = document.querySelector('#app');
if (app === null) throw new Error('#app container is missing from index.html');

const viewport = document.createElement('div');
viewport.className = 'viewport';
app.append(viewport);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap 已於 three r18x 標記為 deprecated（會退回 PCFShadowMap 並印警告）。
renderer.shadowMap.type = THREE.PCFShadowMap;
viewport.append(renderer.domElement);

const scene = buildScene();
const camera = buildCamera(1);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0, 0);
orbit.enabled = false;

const views: VehicleView[] = [buildVehicle(COLOR_CAR_A), buildVehicle(COLOR_CAR_B)];
for (const view of views) scene.add(view.root);

const labelLayer = document.createElement('div');
labelLayer.className = 'label-layer';
viewport.append(labelLayer);

const overlay = new DebugOverlay(labelLayer);
scene.add(overlay.group);

function resize(): void {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ── 播放狀態 ────────────────────────────────────────────────────────────

let player: TrajectoryPlayer | null = null;
let cameraMode: CameraMode = 'overview';
let wheelSpin = 0;
let generating = false;

const scratchPosition = new THREE.Vector3();
const scratchRotation = new THREE.Quaternion();
const followTarget = new THREE.Vector3();
const followDesired = new THREE.Vector3();
const suspension: (number | null)[] = [null, null, null, null];

const controls = new Controls(
  {
    onRun: (input) => {
      void run(input);
    },
    onTogglePlay: () => {
      player?.togglePlay();
      controls.setPlaying(player?.isPlaying ?? false);
    },
    onRestart: () => {
      player?.restart();
      controls.setPlaying(player?.isPlaying ?? false);
    },
    onCameraMode: (mode) => {
      cameraMode = mode;
      orbit.enabled = mode === 'free';
      if (mode === 'overview') applyOverviewCamera(camera);
    },
    onSpeed: (speed) => {
      player?.setSpeed(speed);
    },
    onSeek: (frame) => {
      player?.seek(frame);
      controls.setPlaying(false);
    },
    onStep: (delta) => {
      player?.step(delta);
      controls.setPlaying(false);
    },
    onOverlay: (feature, enabled) => {
      overlay.setFeature(feature, enabled);
      if (!enabled) overlay.clear();
    },
    onShowValues: (enabled) => {
      overlay.setShowValues(enabled);
      if (!enabled) overlay.clear();
    },
    resolveSample: (name) => SAMPLES.get(name),
  },
  [...SAMPLES.keys()].sort(),
);
app.append(controls.root);

// UI 的初始勾選狀態要與疊圖實際狀態一致，否則第一次切換會反向。
for (const [feature, on] of Object.entries(controls.initialOverlayState())) {
  overlay.setFeature(feature as OverlayFeature, on);
}

resize();

async function run(input: BattleInput): Promise<void> {
  if (generating) return;
  generating = true;
  controls.setStatus('產生軌跡中…');
  controls.setOutcome('');
  try {
    const started = performance.now();
    // 一律附帶診斷：實測不增加產生時間，而輪子的懸吊位置需要接觸點才畫得對。
    const trajectory = await generateTrajectory(input, { diagnostics: true });
    const elapsed = performance.now() - started;
    attach(trajectory, elapsed);
  } catch (error) {
    controls.setStatus(`失敗：${error instanceof Error ? error.message : String(error)}`);
    player = null;
  } finally {
    generating = false;
  }
}

function attach(trajectory: Trajectory, generationMs: number): void {
  player = new TrajectoryPlayer(trajectory);
  wheelSpin = 0;
  controls.setStatus(
    `${String(trajectory.frameCount)} 幀，產生耗時 ${generationMs.toFixed(0)} ms` +
      `（physicsVersion ${String(trajectory.meta.physicsVersion)}）`,
  );
  controls.setOutcome(describeOutcome(trajectory));
  controls.setTimelineRange(player.lastFrame);
  overlay.clear();
  player.play();
  controls.setPlaying(true);
}

// ── 繪製迴圈 ────────────────────────────────────────────────────────────

let previousTime = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const deltaSeconds = previousTime === 0 ? 0 : (now - previousTime) / 1000;
  previousTime = now;

  if (player !== null) {
    const wasPlaying = player.isPlaying;
    player.advance(deltaSeconds);
    if (wasPlaying && !player.isPlaying) controls.setPlaying(false);

    if (player.isPlaying) {
      // 輪子的滾動純屬視覺：輪面線速度在模型中本來就是常數（§6.4、§P1.7.2）。
      wheelSpin += (deltaSeconds * player.playbackSpeed * WHEEL_SURFACE_SPEED) / WHEEL_VISUAL_RADIUS;
    }

    for (let car = 0; car < views.length; car += 1) {
      const view = views[car] as VehicleView;
      player.sampleTransform(car, scratchPosition, scratchRotation);
      view.root.position.copy(scratchPosition);
      view.root.quaternion.copy(scratchRotation);
      updateWheels(
        view,
        player.suspensionDistances(car, suspension),
        overlay.isEnabled('wheelGrounded'),
      );
      spinWheels(view, wheelSpin);
    }

    overlay.update(player, camera, viewport);
    controls.setPlayhead(player.frame, player.lastFrame, player.elapsedSeconds);
    updateCamera(deltaSeconds);
  }

  if (orbit.enabled) orbit.update();
  renderer.render(scene, camera);
}

function updateCamera(deltaSeconds: number): void {
  if (player === null || cameraMode === 'overview' || cameraMode === 'free') return;

  const car = cameraMode === 'follow-a' ? 0 : 1;
  const view = views[car] as VehicleView;
  followTarget.copy(view.root.position);

  // 跟隨相機刻意**不隨車體旋轉** —— 車體常常高速自轉，跟著轉會完全無法觀看（§P1.7.3）。
  const extent = arenaExtent();
  followDesired.set(
    followTarget.x,
    followTarget.y + extent * FOLLOW_HEIGHT_FACTOR,
    followTarget.z + extent * FOLLOW_DISTANCE_FACTOR,
  );
  const t = Math.min(1, deltaSeconds * FOLLOW_SMOOTHING);
  camera.position.lerp(followDesired, t);
  camera.lookAt(followTarget);
}

await initPhysics();
requestAnimationFrame(frame);
// 建構完成後才載入第一個範例（見 Controls.loadSelectedSample 的說明）。
controls.loadSelectedSample();
