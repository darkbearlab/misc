/**
 * 播放控制介面（§P1.8.1、§P1.8.3）與除錯疊圖開關（§P1.8.2）。
 *
 * 以原生 DOM 實作 —— 延續 Phase 0 §1 的禁令，不引入 React 或任何 UI 框架。
 * 這一層只負責蒐集輸入與顯示狀態，不碰 three.js、也不碰模擬。
 *
 * ## 行動裝置適配（Phase 1-e）
 *
 * 介面分成兩塊、由 `main.ts` 掛到不同容器：
 *   - `transport`：播放控制列，**永遠浮在 3D 視圖底部**，直向與橫向都完整可見。
 *     這是「不得有按鈕被截掉」的結構性保證 —— 它不在可收合的面板裡，
 *     所以面板收起來時它不會跟著消失。
 *   - `root`：其餘控制項（輸入、相機、品質、疊圖），在直向位於下方、橫向為浮層。
 *
 * 觸控相關的三個原則：
 *   1. 所有可點擊元素 ≥ 44×44 CSS px（`--touch`，於 index.html 定義）。
 *   2. 不使用下拉選單表達模式切換 —— 一律改為分段按鈕，一次點擊即完成。
 *   3. 不依賴 hover：原本靠 `title` 提示的按鈕改為直接標示文字。
 */

import { FIELD_HALF_SEGMENT, THROW_LIMITS, THROW_MAX_STADIUM_DISTANCE } from '../data/constants.js';
import { PLAYBACK_SPEEDS } from '../render/player.js';
import { OVERLAY_FEATURES, OVERLAY_LABELS, type OverlayFeature } from '../render/overlay.js';
import { stadiumDistance } from '../sim/judge.js';
import { Rng } from '../sim/rng.js';
import type { BattleInput, ThrowParams } from '../sim/types.js';
import { PHYSICS_VERSION } from '../data/version.js';
import { PLAYER_PRESETS, type PlayerPreset } from './presets.js';

export type CameraMode = 'overview' | 'follow-a' | 'follow-b' | 'free';

/** 渲染品質等級（§4）。**只影響渲染，不影響軌跡資料。** */
export type QualityLevel = 'auto' | 'high' | 'medium' | 'low';

export const QUALITY_LEVELS: readonly QualityLevel[] = ['auto', 'high', 'medium', 'low'];

const QUALITY_LABELS: Record<QualityLevel, string> = {
  auto: '自動',
  high: '高',
  medium: '中',
  low: '低',
};

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
  onQuality: (level: QualityLevel) => void;
  /** 切換物理設定；main 會重建車體 mesh 並重新產生軌跡。 */
  onPreset: (preset: PlayerPreset) => void;
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

/** 逐幀按鈕連點的初始延遲與重複間隔（ms）。 */
const REPEAT_DELAY = 380;
const REPEAT_INTERVAL = 70;

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

/**
 * 分段按鈕組，取代 `<select>`（§2）。
 *
 * 下拉選單在觸控裝置上要兩次互動（開啟 → 選取）且會蓋住畫面；
 * 分段按鈕一次點擊即完成，且每個選項都能滿足 44 px 的觸控目標。
 */
function segmented<T>(
  options: readonly { value: T; label: string }[],
  initial: T,
  onPick: (value: T) => void,
): { element: HTMLElement; select: (value: T) => void } {
  const group = el('div', 'segmented');
  group.setAttribute('role', 'group');
  const buttons = new Map<T, HTMLButtonElement>();

  const select = (value: T): void => {
    for (const [key, button] of buttons) {
      button.setAttribute('aria-pressed', key === value ? 'true' : 'false');
    }
  };

  for (const option of options) {
    const button = el('button', undefined, option.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      select(option.value);
      onPick(option.value);
    });
    buttons.set(option.value, button);
    group.append(button);
  }
  select(initial);
  return { element: group, select };
}

/**
 * 讓按鈕支援按住連發（§2「按鈕夠大可連點」）。
 *
 * 用 pointer 事件而非 click：觸控裝置的 click 有 ~300 ms 延遲且無法連發。
 * `setPointerCapture` 確保手指滑出按鈕範圍時仍收得到 pointerup，不會卡在連發狀態。
 */
function repeatable(button: HTMLButtonElement, action: () => void): void {
  let delayTimer: ReturnType<typeof setTimeout> | undefined;
  let repeatTimer: ReturnType<typeof setInterval> | undefined;

  const stop = (): void => {
    if (delayTimer !== undefined) clearTimeout(delayTimer);
    if (repeatTimer !== undefined) clearInterval(repeatTimer);
    delayTimer = undefined;
    repeatTimer = undefined;
  };

  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    action();
    delayTimer = setTimeout(() => {
      repeatTimer = setInterval(action, REPEAT_INTERVAL);
    }, REPEAT_DELAY);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    button.addEventListener(type, stop);
  }
}

/**
 * 產生一個真正隨機的 seed（32-bit 有號整數）。
 *
 * 優先用 `crypto.getRandomValues`；沒有時退回 `Math.random`。
 * 這是**使用者輸入的來源**，不是模擬過程 —— 見「隨機產生」按鈕的說明。
 */
export function randomSeed(): number {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    const buf = new Int32Array(1);
    c.getRandomValues(buf);
    return buf[0] as number;
  }
  return Math.floor((Math.random() - 0.5) * 2 ** 32) | 0;
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
  /** 其餘控制項；直向在下方、橫向為浮層。 */
  readonly root: HTMLElement;
  /** 播放控制列；永遠浮在 3D 視圖底部。 */
  readonly transport: HTMLElement;

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
  private readonly scrubBubble: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly presetLine: HTMLElement;
  /** 使用者正在拖曳時間軸時，暫停由播放迴圈回寫滑桿位置。 */
  private scrubbing = false;

  constructor(
    private readonly handlers: ControlsHandlers,
    sampleNames: readonly string[],
  ) {
    this.root = el('div', 'panel');
    this.transport = el('div', 'transport');

    // ── 播放控制列（§2）───────────────────────────────────────────────
    // 產生進度（§P1.9）：不確定進度指示，見 setBusy 的說明。
    this.progress = el('div', 'progress');
    this.progress.setAttribute('role', 'progressbar');
    this.progress.append(el('div', 'progress-bar'));
    this.transport.append(this.progress);

    // 時間軸 + 拖曳氣泡
    const scrubWrap = el('div', 'scrub-wrap');
    this.timeline = el('input', 'timeline');
    this.timeline.type = 'range';
    this.timeline.min = '0';
    this.timeline.max = '0';
    this.timeline.step = '1';
    this.timeline.value = '0';
    this.timeline.disabled = true;
    this.timeline.setAttribute('aria-label', '時間軸');

    this.scrubBubble = el('div', 'scrub-bubble', '0');
    scrubWrap.append(this.scrubBubble, this.timeline);

    const onScrub = (): void => {
      const frame = Number(this.timeline.value);
      this.handlers.onSeek(frame);
      this.paintTimeline(frame);
      this.scrubBubble.textContent = `${String(frame)} 幀`;
    };
    // pointerdown 就顯示氣泡：手指按下的瞬間就要看得到數值，不必等到移動。
    this.timeline.addEventListener('pointerdown', () => {
      this.scrubbing = true;
      this.scrubBubble.classList.add('on');
      this.scrubBubble.textContent = `${this.timeline.value} 幀`;
    });
    for (const type of ['pointerup', 'pointercancel'] as const) {
      this.timeline.addEventListener(type, () => {
        this.scrubbing = false;
        this.scrubBubble.classList.remove('on');
      });
    }
    this.timeline.addEventListener('input', onScrub);
    this.timeline.addEventListener('change', onScrub);
    this.transport.append(scrubWrap);

    // 傳輸按鈕：重播、−10、−1、播放、+1、+10
    const transportRow = el('div', 'transport-row');
    const restartButton = el('button', undefined, '↺');
    restartButton.type = 'button';
    restartButton.setAttribute('aria-label', '重播');
    restartButton.addEventListener('click', () => {
      this.handlers.onRestart();
    });

    const back10 = el('button', undefined, '−10');
    back10.type = 'button';
    back10.setAttribute('aria-label', '後退十幀');
    repeatable(back10, () => {
      this.handlers.onStep(-10);
    });

    const back1 = el('button', undefined, '−1');
    back1.type = 'button';
    back1.setAttribute('aria-label', '後退一幀');
    repeatable(back1, () => {
      this.handlers.onStep(-1);
    });

    this.playButton = el('button', 'play', '播放');
    this.playButton.type = 'button';
    this.playButton.addEventListener('click', () => {
      this.handlers.onTogglePlay();
    });

    const fwd1 = el('button', undefined, '+1');
    fwd1.type = 'button';
    fwd1.setAttribute('aria-label', '前進一幀');
    repeatable(fwd1, () => {
      this.handlers.onStep(1);
    });

    const fwd10 = el('button', undefined, '+10');
    fwd10.type = 'button';
    fwd10.setAttribute('aria-label', '前進十幀');
    repeatable(fwd10, () => {
      this.handlers.onStep(10);
    });

    transportRow.append(restartButton, back10, back1, this.playButton, fwd1, fwd10);
    this.transport.append(transportRow);

    // 速度：分段按鈕，不用下拉選單（§2）
    const speedGroup = segmented(
      PLAYBACK_SPEEDS.map((speed) => ({ value: speed as number, label: `${String(speed)}×` })),
      1,
      (speed) => {
        this.handlers.onSpeed(speed);
      },
    );
    this.transport.append(speedGroup.element);

    this.frameReadout = el('div', 'readout', '— / —');
    this.transport.append(this.frameReadout);

    // ── 主要入口（§3：手機上以載入範例／隨機產生為主）───────────────
    const actions = el('section');
    actions.append(el('h2', undefined, '場次'));

    const sampleRow = el('div', 'row');
    sampleRow.append(el('label', undefined, '範例'));
    this.sampleSelect = el('select');
    this.sampleSelect.setAttribute('aria-label', '範例場次');
    for (const name of sampleNames) {
      const option = el('option');
      option.value = name;
      option.textContent = name;
      this.sampleSelect.append(option);
    }
    // 選到就直接載入 —— 手機上少一次點擊。
    this.sampleSelect.addEventListener('change', () => {
      this.dispatchSampleLoad();
    });
    sampleRow.append(this.sampleSelect);
    actions.append(sampleRow);

    const buttonRow = el('div', 'buttons');
    const loadButton = el('button', 'primary', '載入範例');
    loadButton.type = 'button';
    loadButton.addEventListener('click', () => {
      this.dispatchSampleLoad();
    });
    const randomButton = el('button', 'primary', '隨機產生');
    randomButton.type = 'button';
    randomButton.addEventListener('click', () => {
      // 真隨機：每次都給一個新的 seed 與新的投擲參數。
      //
      // §3 禁令 1（禁止 Math.random）約束的是 src/sim/，目的是保證**模擬**的決定性。
      // UI 產生一組新輸入不在該範圍內 —— 隨機的是輸入，不是過程：
      // 同一組 seed 與投擲參數重播必定得到相同結果（tests/random-throw.test.ts）。
      const seed = randomSeed();
      this.setSeed(seed);
      const rng = new Rng(seed);
      this.setThrow('A', randomThrow(rng));
      this.setThrow('B', randomThrow(rng));
      this.run();
    });
    buttonRow.append(loadButton, randomButton);
    actions.append(buttonRow);

    this.statusLine = el('div', 'status', '尚未產生軌跡');
    this.outcomeLine = el('div', 'outcome');
    actions.append(this.statusLine, this.outcomeLine);

    // ── 物理設定（探索成果必須看得到）──────────────────────────────────
    const presetSection = el('section');
    presetSection.append(el('h2', undefined, '物理設定'));
    presetSection.append(
      segmented<string>(
        PLAYER_PRESETS.map((p) => ({ value: p.id, label: p.label })),
        PLAYER_PRESETS[0]?.id ?? 'v1',
        (id) => {
          const preset = PLAYER_PRESETS.find((p) => p.id === id);
          if (preset === undefined) return;
          this.setPresetSummary(preset);
          this.handlers.onPreset(preset);
        },
      ).element,
    );
    this.presetLine = el('div', 'status');
    presetSection.append(this.presetLine);

    // ── 相機（§P1.8.1）────────────────────────────────────────────────
    const cameraSection = el('section');
    cameraSection.append(el('h2', undefined, '相機'));
    cameraSection.append(
      segmented<CameraMode>(
        [
          { value: 'overview', label: '全景' },
          { value: 'follow-a', label: '跟隨 A' },
          { value: 'follow-b', label: '跟隨 B' },
          { value: 'free', label: '自由' },
        ],
        'overview',
        (mode) => {
          this.handlers.onCameraMode(mode);
        },
      ).element,
    );
    const hint = el(
      'div',
      'status',
      '自由相機：單指旋轉、雙指縮放與平移。',
    );
    cameraSection.append(hint);

    // ── 畫質（§4）─────────────────────────────────────────────────────
    const qualitySection = el('section');
    qualitySection.append(el('h2', undefined, '畫質'));
    qualitySection.append(
      segmented<QualityLevel>(
        QUALITY_LEVELS.map((level) => ({ value: level, label: QUALITY_LABELS[level] })),
        'auto',
        (level) => {
          this.handlers.onQuality(level);
        },
      ).element,
    );
    qualitySection.append(
      el('div', 'status', '只影響渲染，不影響軌跡資料與判定結果。'),
    );

    // ── 除錯疊圖（§P1.8.2）：手機上預設收合（§3）─────────────────────
    const overlayFold = el('details', 'fold');
    overlayFold.append(el('summary', undefined, '除錯疊圖'));
    const overlayBody = el('div', 'fold-body');
    for (const feature of OVERLAY_FEATURES) {
      overlayBody.append(
        this.checkbox(OVERLAY_LABELS[feature], feature === 'wheelGrounded', (on) => {
          this.handlers.onOverlay(feature, on);
        }),
      );
    }
    overlayBody.append(
      this.checkbox('顯示數值（N / F）', false, (on) => {
        this.handlers.onShowValues(on);
      }),
    );
    overlayFold.append(overlayBody);

    // ── 手動輸入（§3：放在展開區）────────────────────────────────────
    const inputFold = el('details', 'fold');
    inputFold.append(el('summary', undefined, '手動輸入投擲參數'));
    const inputBody = el('div', 'fold-body');

    const seedRow = el('div', 'row');
    seedRow.append(el('label', undefined, 'seed'));
    this.seedInput = el('input');
    this.seedInput.type = 'number';
    this.seedInput.step = '1';
    this.seedInput.value = '20260817';
    this.seedInput.inputMode = 'numeric';
    const copySeed = el('button', undefined, '複製');
    copySeed.type = 'button';
    copySeed.addEventListener('click', () => {
      void globalThis.navigator.clipboard.writeText(this.seedInput.value);
      copySeed.textContent = '已複製';
      setTimeout(() => {
        copySeed.textContent = '複製';
      }, 1200);
    });
    seedRow.append(this.seedInput, copySeed);
    inputBody.append(seedRow);

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
        input.inputMode = 'decimal';
        row.append(input);
        group.append(row);
        this.throwInputs[car].set(field.key, input);
      }
      inputBody.append(group);
    }

    const runRow = el('div', 'buttons');
    const runButton = el('button', 'primary', '產生並播放');
    runButton.type = 'button';
    runButton.addEventListener('click', () => {
      this.run();
    });
    runRow.append(runButton);
    inputBody.append(runRow);
    inputFold.append(inputBody);

    this.root.append(
      actions,
      presetSection,
      cameraSection,
      qualitySection,
      overlayFold,
      inputFold,
    );
    const initial = PLAYER_PRESETS[0];
    if (initial !== undefined) this.setPresetSummary(initial);
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

  /** 顯示目前使用中的設定:名稱 + physicsVersion + substep + μ_floor。 */
  setPresetSummary(preset: PlayerPreset): void {
    const substeps = preset.physics?.substeps ?? 1;
    const via = preset.physics === undefined ? '預設路徑' : '覆寫載入';
    this.presetLine.textContent =
      preset.summary +
      '　（physicsVersion ' + String(PHYSICS_VERSION) +
      '，' + via +
      '，substep ' + String(substeps) + '）';
  }

  /** 更新範例清單（不同 preset 有各自的範例目錄）。 */
  setSampleNames(names: readonly string[]): void {
    this.sampleSelect.replaceChildren();
    for (const name of names) {
      const option = el('option');
      option.value = name;
      option.textContent = name;
      this.sampleSelect.append(option);
    }
  }

  setStatus(text: string): void {
    this.statusLine.textContent = text;
  }

  setOutcome(text: string): void {
    this.outcomeLine.textContent = text;
  }

  /**
   * 切換「軌跡產生中」的狀態。
   *
   * 刻意**不停用任何控制項**：產生跑在 Worker 上，主執行緒仍然順暢，
   * 而且上一份軌跡還留著 —— 使用者可以一邊等新的一邊繼續看舊的。
   * 停用只會讓介面看起來壞掉。
   *
   * 進度是不確定的（只有經過時間，沒有百分比）：`simulate()` 不提供幀數進度，
   * 要取得它必須在物理主迴圈裡插入回呼，不在本階段的授權範圍內。
   */
  setBusy(busy: boolean): void {
    this.progress.classList.toggle('on', busy);
  }

  setPlaying(playing: boolean): void {
    this.playButton.textContent = playing ? '暫停' : '播放';
  }

  /** 軌跡就緒後設定時間軸範圍。 */
  setTimelineRange(lastFrame: number): void {
    this.timeline.max = String(lastFrame);
    this.timeline.value = '0';
    this.timeline.disabled = lastFrame <= 0;
    this.paintTimeline(0);
  }

  /** 每幀回寫目前位置；使用者正在拖曳時不覆寫滑桿。 */
  setPlayhead(frame: number, lastFrame: number, seconds: number): void {
    if (!this.scrubbing) {
      this.timeline.value = String(frame);
      this.paintTimeline(frame);
    }
    this.frameReadout.textContent =
      `${String(frame)} / ${String(lastFrame)} 幀 · ${seconds.toFixed(2)} 秒`;
  }

  // ── 內部 ──────────────────────────────────────────────────────────────

  /**
   * 更新滑桿的已播進度與氣泡位置。
   *
   * WebKit 的 `::-webkit-slider-runnable-track` 沒有 `::-moz-range-progress` 的對應物，
   * 只能以 CSS 變數餵一段 background-size 進去；氣泡的水平位置也在這裡一併算，
   * 兩者用同一個比例才不會分家。拇指有寬度，故兩端各內縮半個拇指。
   */
  private paintTimeline(frame: number): void {
    const max = Number(this.timeline.max);
    const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, frame / max));
    this.timeline.style.setProperty('--fill', `${String(ratio * 100)}%`);
    const thumb = 26;
    const width = this.timeline.clientWidth;
    const usable = Math.max(0, width - thumb);
    this.scrubBubble.style.left = `${String(thumb / 2 + ratio * usable)}px`;
  }

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
