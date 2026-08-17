/**
 * 播放控制介面（§P1.8.1、§P1.8.3）與除錯疊圖開關（§P1.8.2）。
 *
 * 以原生 DOM 實作 —— 延續 Phase 0 §1 的禁令，不引入 React 或任何 UI 框架。
 * 這一層只負責蒐集輸入與顯示狀態，不碰 three.js、也不碰模擬。
 */

import { FIELD_HALF_SEGMENT, THROW_LIMITS, THROW_MAX_STADIUM_DISTANCE } from '../data/constants.js';
import { PLAYBACK_SPEEDS } from '../render/player.js';
import { OVERLAY_FEATURES, OVERLAY_LABELS, type OverlayFeature } from '../render/overlay.js';
import { stadiumDistance } from '../sim/judge.js';
import { Rng } from '../sim/rng.js';
import type { BattleInput, ThrowParams } from '../sim/types.js';

export type CameraMode = 'overview' | 'follow-a' | 'follow-b' | 'free';

export type ControlsHandlers = {
  onRun: (input: BattleInput) => void;
  onTogglePlay: () => void;
  onRestart: () => void;
  onCameraMode: (mode: CameraMode) => void;
  onSpeed: (speed: number) => void;
  onSeek: (frame: number) => void;
  onStep: (delta: number) => void;
  onOverlay: (feature: OverlayFeature, enabled: boolean) => void;
  onShowValues: (enabled: boolean) => void;
  /**
   * 依名稱取得範例輸入。
   *
   * 刻意放在 handlers 裡而不是事後指派的欄位 —— 建構子結尾就會載入第一個範例，
   * 若這個相依是事後才接上的，初始載入時它還是 undefined，畫面會停在空白狀態。
   */
  resolveSample: (name: string) => BattleInput | undefined;
};

const THROW_FIELDS = [
  { key: 'x', label: 'x', step: 0.01 },
  { key: 'z', label: 'z', step: 0.01 },
  { key: 'y', label: 'y (高度)', step: 0.005 },
  { key: 'yaw', label: 'yaw', step: 0.01 },
  { key: 'pitch', label: 'pitch', step: 0.01 },
  { key: 'speed', label: 'speed', step: 0.1 },
  { key: 'spin', label: 'spin', step: 0.5 },
] as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 在 stadium 內以拒絕取樣產生合法投擲（§P1.8.3、依 Phase 0 §7 的範圍）。 */
export function randomThrow(rng: Rng): ThrowParams {
  const maxZ = THROW_MAX_STADIUM_DISTANCE + FIELD_HALF_SEGMENT;
  let x = 0;
  let z = 0;
  do {
    x = rng.nextRange(-THROW_MAX_STADIUM_DISTANCE, THROW_MAX_STADIUM_DISTANCE);
    z = rng.nextRange(-maxZ, maxZ);
  } while (stadiumDistance(x, z) > THROW_MAX_STADIUM_DISTANCE);

  const L = THROW_LIMITS;
  const round = (v: number): number => Math.round(v * 10000) / 10000;
  return {
    x: round(x),
    z: round(z),
    y: round(rng.nextRange(L.y.min, L.y.max)),
    yaw: round(rng.nextRange(L.yaw.min, L.yaw.max)),
    pitch: round(rng.nextRange(L.pitch.min, L.pitch.max)),
    speed: round(rng.nextRange(L.speed.min, L.speed.max)),
    spin: round(rng.nextRange(L.spin.min, L.spin.max)),
  };
}

export class Controls {
  readonly root: HTMLElement;

  private readonly seedInput: HTMLInputElement;
  private readonly throwInputs: Record<'A' | 'B', Map<string, HTMLInputElement>> = {
    A: new Map(),
    B: new Map(),
  };
  private readonly sampleSelect: HTMLSelectElement;
  private readonly statusLine: HTMLElement;
  private readonly outcomeLine: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly timeline: HTMLInputElement;
  private readonly frameReadout: HTMLElement;
  private randomCounter = 0;
  /** 使用者正在拖曳時間軸時，暫停由播放迴圈回寫滑桿位置。 */
  private scrubbing = false;

  constructor(
    private readonly handlers: ControlsHandlers,
    sampleNames: readonly string[],
  ) {
    this.root = el('div', 'panel');

    // ── 輸入 ────────────────────────────────────────────────────────────
    const inputSection = el('section', 'section');
    inputSection.append(el('h2', undefined, '投擲參數'));

    const seedRow = el('div', 'row');
    seedRow.append(el('label', undefined, 'seed'));
    this.seedInput = el('input');
    this.seedInput.type = 'number';
    this.seedInput.step = '1';
    this.seedInput.value = '20260817';
    seedRow.append(this.seedInput);
    inputSection.append(seedRow);

    for (const car of ['A', 'B'] as const) {
      const group = el('fieldset', 'car-group');
      group.append(el('legend', undefined, `車 ${car}`));
      for (const field of THROW_FIELDS) {
        const row = el('div', 'row');
        row.append(el('label', undefined, field.label));
        const input = el('input');
        input.type = 'number';
        input.step = String(field.step);
        input.value = '0';
        row.append(input);
        group.append(row);
        this.throwInputs[car].set(field.key, input);
      }
      inputSection.append(group);
    }

    // ── 動作 ────────────────────────────────────────────────────────────
    const actions = el('section', 'section');

    const sampleRow = el('div', 'row');
    sampleRow.append(el('label', undefined, '範例'));
    this.sampleSelect = el('select');
    for (const name of sampleNames) {
      const option = el('option');
      option.value = name;
      option.textContent = name;
      this.sampleSelect.append(option);
    }
    sampleRow.append(this.sampleSelect);
    actions.append(sampleRow);

    const buttonRow = el('div', 'row buttons');
    const loadButton = el('button', undefined, '載入範例');
    loadButton.addEventListener('click', () => {
      this.dispatchSampleLoad();
    });
    const randomButton = el('button', undefined, '隨機投擲');
    randomButton.addEventListener('click', () => {
      this.randomCounter += 1;
      const rng = new Rng((this.readSeed() + this.randomCounter) | 0);
      this.setThrow('A', randomThrow(rng));
      this.setThrow('B', randomThrow(rng));
      this.run();
    });
    const runButton = el('button', 'primary', '產生並播放');
    runButton.addEventListener('click', () => {
      this.run();
    });
    buttonRow.append(loadButton, randomButton, runButton);
    actions.append(buttonRow);

    // ── 播放（§P1.8.1） ─────────────────────────────────────────────────
    const playback = el('section', 'section');
    playback.append(el('h2', undefined, '播放'));

    const transportRow = el('div', 'row buttons');
    const stepBack = el('button', undefined, '◀ 幀');
    stepBack.title = '後退一幀';
    stepBack.addEventListener('click', () => {
      this.handlers.onStep(-1);
    });
    this.playButton = el('button', undefined, '播放');
    this.playButton.addEventListener('click', () => {
      this.handlers.onTogglePlay();
    });
    const stepForward = el('button', undefined, '幀 ▶');
    stepForward.title = '前進一幀';
    stepForward.addEventListener('click', () => {
      this.handlers.onStep(1);
    });
    const restartButton = el('button', undefined, '重播');
    restartButton.addEventListener('click', () => {
      this.handlers.onRestart();
    });
    transportRow.append(stepBack, this.playButton, stepForward, restartButton);
    playback.append(transportRow);

    // 時間軸
    this.timeline = el('input', 'timeline');
    this.timeline.type = 'range';
    this.timeline.min = '0';
    this.timeline.max = '0';
    this.timeline.step = '1';
    this.timeline.value = '0';
    this.timeline.disabled = true;
    const onScrub = (): void => {
      this.handlers.onSeek(Number(this.timeline.value));
    };
    this.timeline.addEventListener('pointerdown', () => {
      this.scrubbing = true;
    });
    this.timeline.addEventListener('pointerup', () => {
      this.scrubbing = false;
    });
    this.timeline.addEventListener('input', onScrub);
    this.timeline.addEventListener('change', onScrub);
    playback.append(this.timeline);

    this.frameReadout = el('div', 'readout', '— / —');
    playback.append(this.frameReadout);

    // 速度
    const speedRow = el('div', 'row');
    speedRow.append(el('label', undefined, '速度'));
    const speedSelect = el('select');
    for (const speed of PLAYBACK_SPEEDS) {
      const option = el('option');
      option.value = String(speed);
      option.textContent = `${String(speed)}×`;
      if (speed === 1) option.selected = true;
      speedSelect.append(option);
    }
    speedSelect.addEventListener('change', () => {
      this.handlers.onSpeed(Number(speedSelect.value));
    });
    speedRow.append(speedSelect);
    playback.append(speedRow);

    // 相機
    const cameraRow = el('div', 'row');
    cameraRow.append(el('label', undefined, '相機'));
    const cameraSelect = el('select');
    for (const [value, label] of [
      ['overview', '全景'],
      ['follow-a', '跟隨 A'],
      ['follow-b', '跟隨 B'],
      ['free', '自由'],
    ] as const) {
      const option = el('option');
      option.value = value;
      option.textContent = label;
      cameraSelect.append(option);
    }
    cameraSelect.addEventListener('change', () => {
      this.handlers.onCameraMode(cameraSelect.value as CameraMode);
    });
    cameraRow.append(cameraSelect);
    playback.append(cameraRow);

    this.statusLine = el('div', 'status', '尚未產生軌跡');
    this.outcomeLine = el('div', 'outcome');
    playback.append(this.statusLine, this.outcomeLine);

    // ── 除錯疊圖（§P1.8.2） ─────────────────────────────────────────────
    const overlaySection = el('section', 'section');
    overlaySection.append(el('h2', undefined, '除錯疊圖'));
    for (const feature of OVERLAY_FEATURES) {
      overlaySection.append(
        this.checkbox(OVERLAY_LABELS[feature], feature === 'wheelGrounded', (on) => {
          this.handlers.onOverlay(feature, on);
        }),
      );
    }
    overlaySection.append(
      this.checkbox('顯示數值（N / F）', false, (on) => {
        this.handlers.onShowValues(on);
      }),
    );
    playback.append(overlaySection);

    this.root.append(inputSection, actions, playback);
  }

  private checkbox(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLElement {
    const row = el('label', 'checkrow');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = initial;
    input.addEventListener('change', () => {
      onChange(input.checked);
    });
    row.append(input, el('span', undefined, label));
    return row;
  }

  // ── 對外 ──────────────────────────────────────────────────────────────

  /**
   * 載入目前選中的範例並開始播放。
   *
   * **刻意不在建構子裡做。** `onRun` 的實作會回頭呼叫 `controls.setStatus()` 等方法，
   * 而建構子執行期間 `const controls = new Controls(...)` 的繫結還在 TDZ，
   * 會拋 `Cannot access 'controls' before initialization`。由 main 在建構完成後呼叫。
   */
  loadSelectedSample(): void {
    if (this.sampleSelect.options.length === 0) return;
    this.dispatchSampleLoad();
  }

  /** 取得目前所有疊圖開關的初始狀態，讓 main 能與 UI 對齊。 */
  initialOverlayState(): Record<OverlayFeature, boolean> {
    const state = {} as Record<OverlayFeature, boolean>;
    for (const feature of OVERLAY_FEATURES) state[feature] = feature === 'wheelGrounded';
    return state;
  }

  setThrow(car: 'A' | 'B', params: ThrowParams): void {
    for (const field of THROW_FIELDS) {
      const input = this.throwInputs[car].get(field.key);
      if (input !== undefined) input.value = String(params[field.key]);
    }
  }

  setSeed(seed: number): void {
    this.seedInput.value = String(seed);
  }

  setStatus(text: string): void {
    this.statusLine.textContent = text;
  }

  setOutcome(text: string): void {
    this.outcomeLine.textContent = text;
  }

  setPlaying(playing: boolean): void {
    this.playButton.textContent = playing ? '暫停' : '播放';
  }

  /** 軌跡就緒後設定時間軸範圍。 */
  setTimelineRange(lastFrame: number): void {
    this.timeline.max = String(lastFrame);
    this.timeline.value = '0';
    this.timeline.disabled = lastFrame <= 0;
  }

  /** 每幀回寫目前位置；使用者正在拖曳時不覆寫滑桿。 */
  setPlayhead(frame: number, lastFrame: number, seconds: number): void {
    if (!this.scrubbing) this.timeline.value = String(frame);
    this.frameReadout.textContent =
      `${String(frame)} / ${String(lastFrame)} 幀 · ${seconds.toFixed(2)} 秒`;
  }

  // ── 內部 ──────────────────────────────────────────────────────────────

  private dispatchSampleLoad(): void {
    const name = this.sampleSelect.value;
    const input = this.handlers.resolveSample(name);
    if (input === undefined) return;
    this.setSeed(input.seed);
    this.setThrow('A', input.throwA);
    this.setThrow('B', input.throwB);
    this.run();
  }

  private readSeed(): number {
    const value = Number.parseInt(this.seedInput.value, 10);
    return Number.isInteger(value) ? value : 0;
  }

  private readThrow(car: 'A' | 'B'): ThrowParams {
    const out: Record<string, number> = {};
    for (const field of THROW_FIELDS) {
      const input = this.throwInputs[car].get(field.key);
      out[field.key] = input === undefined ? 0 : Number.parseFloat(input.value);
    }
    return out as unknown as ThrowParams;
  }

  private run(): void {
    this.handlers.onRun({
      seed: this.readSeed(),
      throwA: this.readThrow('A'),
      throwB: this.readThrow('B'),
    });
  }
}
