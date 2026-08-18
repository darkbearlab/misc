/**
 * Replay 播放器進入點（§P1.2.1）。
 *
 * 流程嚴格分為兩段：
 *   1. 產生：`generateTrajectory()` 跑完整場戰鬥 → Trajectory
 *   2. 播放：讀 Trajectory → 繪製
 *
 * **這裡不持有 Rapier 世界、不呼叫 `world.step()`、不依 rAF 的 delta 推進任何物理。**
 * rAF 的 delta 只用來換算「該顯示第幾幀」，模擬結果早在第 1 段就完全定案。
 *
 * ## 行動裝置適配（Phase 1-e）
 *
 * 三件事在這一層處理：觸控手勢的對應、版面的掛載位置、以及品質等級的套用。
 * 三者都只動渲染與 DOM —— 模擬完全沒有變化，`verify-platform --compare` 仍須 20/20。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { WHEEL_SURFACE_SPEED } from '../data/constants.js';
import { generateTrajectory, type Trajectory } from '../replay/trajectory.js';
import { initPhysics } from '../sim/world.js';
import type { BattleInput } from '../sim/types.js';
import { Controls, type CameraMode, type QualityLevel } from '../ui/controls.js';
import {
  applyOverviewCamera,
  arenaExtent,
  buildCamera,
  buildScene,
} from './scene.js';
import { DebugOverlay, type OverlayFeature } from './overlay.js';
import { describeOutcome, TrajectoryPlayer } from './player.js';
import { applyQuality, resolveQuality, type QualitySettings } from './quality.js';
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

// ── 品質 ────────────────────────────────────────────────────────────────

// 起始等級要在建立 renderer 之前決定 —— MSAA 在 WebGL context 建立時就固定了。
let quality: QualitySettings = resolveQuality('auto');

// ── 場景 ────────────────────────────────────────────────────────────────

const app = document.querySelector('#app');
if (app === null) throw new Error('#app container is missing from index.html');

const viewport = document.createElement('div');
viewport.className = 'viewport';
app.append(viewport);

const renderer = new THREE.WebGLRenderer({ antialias: quality.antialias });
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap 已於 three r18x 標記為 deprecated（會退回 PCFShadowMap 並印警告）。
renderer.shadowMap.type = THREE.PCFShadowMap;
viewport.append(renderer.domElement);

const scene = buildScene(quality.curveSegments);
const camera = buildCamera(1);
applyQuality(renderer, scene, quality);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0, 0);
orbit.enabled = false;
// 觸控手勢對應（§1）：單指旋轉、雙指縮放與平移。
// three 的預設值本來就是這組，但它是預設而非保證 —— 明寫下來，
// 免得日後升版改了預設值就悄悄壞掉。
orbit.touches.ONE = THREE.TOUCH.ROTATE;
orbit.touches.TWO = THREE.TOUCH.DOLLY_PAN;
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
// 手指移動一小段就要有明顯回饋，但不能靈敏到難以定位。
orbit.rotateSpeed = 0.8;
orbit.zoomSpeed = 0.9;
orbit.minDistance = 0.15;
orbit.maxDistance = arenaExtent() * 4;

const views: VehicleView[] = [buildVehicle(COLOR_CAR_A), buildVehicle(COLOR_CAR_B)];
for (const view of views) scene.add(view.root);

const labelLayer = document.createElement('div');
labelLayer.className = 'label-layer';
viewport.append(labelLayer);

const overlay = new DebugOverlay(labelLayer);
scene.add(overlay.group);

// 效能讀數（§4 驗收需要實測值）
const hud = document.createElement('div');
hud.className = 'hud';
viewport.append(hud);

function resize(): void {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
// 旋轉螢幕後 clientWidth/Height 不一定馬上更新，補一次延後的量測。
window.addEventListener('orientationchange', () => {
  setTimeout(resize, 250);
});
// 行動瀏覽器的網址列收合會改變可視高度，但不一定觸發 resize。
window.visualViewport?.addEventListener('resize', resize);

// ── 播放狀態 ────────────────────────────────────────────────────────────

let player: TrajectoryPlayer | null = null;
let cameraMode: CameraMode = 'overview';
let wheelSpin = 0;
let generating = false;
let lastGenerationMs = 0;

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
      if (mode === 'free') {
        // 進入自由相機時把軌道中心對到場地中心，否則會繞著上一個 target 轉。
        orbit.target.set(0, 0, 0);
        orbit.update();
      }
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
    onQuality: (level: QualityLevel) => {
      quality = resolveQuality(level);
      applyQuality(renderer, scene, quality);
      resize();
    },
    resolveSample: (name) => SAMPLES.get(name),
  },
  [...SAMPLES.keys()].sort(),
);
// 控制列是 #app 的子元素而非 .viewport 的：桌機與橫向時它絕對定位浮在 3D 視圖底部，
// 直向時 CSS 把它改回 static、成為版面的第二列。無論哪一種，它都不在可收合的面板裡，
// 因此收起面板不會帶走播放控制（§2「不得有按鈕被截掉」）。
app.append(controls.transport);
app.append(controls.root);

// 橫向浮層的開關（§3）。桌機與直向由 CSS 隱藏，這裡不必判斷裝置。
const panelToggle = document.createElement('button');
panelToggle.type = 'button';
panelToggle.className = 'panel-toggle';
panelToggle.textContent = '選項';
panelToggle.setAttribute('aria-label', '開關控制面板');
panelToggle.addEventListener('click', () => {
  const open = app.classList.toggle('panel-open');
  panelToggle.textContent = open ? '關閉' : '選項';
  // 浮層讓出寬度後 3D 視圖尺寸不變（浮層是絕對定位），但控制列會位移，
  // 下一幀重算一次以免時間軸的氣泡位置對不上。
  requestAnimationFrame(resize);
});
viewport.append(panelToggle);

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
  lastGenerationMs = generationMs;
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
let fpsFrames = 0;
let fpsSince = 0;
let fps = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const deltaSeconds = previousTime === 0 ? 0 : (now - previousTime) / 1000;
  previousTime = now;

  // 每 500 ms 更新一次讀數；每幀更新會讓數字跳到讀不出來。
  fpsFrames += 1;
  if (fpsSince === 0) fpsSince = now;
  if (now - fpsSince >= 500) {
    fps = (fpsFrames * 1000) / (now - fpsSince);
    fpsFrames = 0;
    fpsSince = now;
    hud.textContent =
      `${fps.toFixed(0)} fps · ${quality.resolved} · ` +
      `${String(Math.round(renderer.getPixelRatio() * 100) / 100)}x`;
  }

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

/**
 * 量測用的掛勾（§6 驗收）。
 *
 * 只讀取已經算好的數字，不改變任何行為 —— 存在的理由是自動化量測需要一個
 * 穩定的取值點，而不是去解析 HUD 的文字。
 */
declare global {
  interface Window {
    __player?: {
      fps: () => number;
      quality: () => string;
      pixelRatio: () => number;
      generationMs: () => number;
      frameCount: () => number;
      isPlaying: () => boolean;
      run: (name: string) => Promise<void>;
    };
  }
}
window.__player = {
  fps: () => fps,
  quality: () => quality.resolved,
  pixelRatio: () => renderer.getPixelRatio(),
  generationMs: () => lastGenerationMs,
  frameCount: () => player?.trajectory.frameCount ?? 0,
  isPlaying: () => player?.isPlaying ?? false,
  run: async (name: string) => {
    const input = SAMPLES.get(name);
    if (input !== undefined) await run(input);
  },
};

await initPhysics();
requestAnimationFrame(frame);
// 建構完成後才載入第一個範例（見 Controls.loadSelectedSample 的說明）。
controls.loadSelectedSample();
