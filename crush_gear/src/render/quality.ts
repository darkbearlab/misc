/**
 * 渲染品質等級（Phase 1-e §4）。
 *
 * ## 這一層絕不碰物理
 *
 * 效能不足時**唯一**能動的是渲染成本：pixel ratio、陰影、材質、mesh 細分。
 * solver 迭代次數、timestep、跳幀模擬、簡化碰撞體一律不在選項內 ——
 * 那些會改變模擬結果，違反 `SPEC.md` §13「渲染需求不具備修改物理的資格」。
 *
 * 軌跡資料與判定結果與本檔完全無關：品質切換只改變**同一份軌跡**畫得多細，
 * 不改變它的內容。切換品質不需要、也不會重新產生軌跡。
 */

import * as THREE from 'three';

import type { QualityLevel } from '../ui/controls.js';

export type QualitySettings = {
  /** 實際採用的等級（`auto` 會解析為 high / medium / low 之一）。 */
  resolved: Exclude<QualityLevel, 'auto'>;
  /** devicePixelRatio 的上限。這是行動裝置上最有效的單一槓桿。 */
  maxPixelRatio: number;
  /** 是否啟用陰影。關閉可省下一次完整的場景 depth pass。 */
  shadows: boolean;
  /** 陰影貼圖邊長。 */
  shadowMapSize: number;
  /** 場地曲線與圍欄的取樣段數上限。 */
  curveSegments: number;
  /** 是否啟用 MSAA。建立 renderer 時就要決定，之後不能改。 */
  antialias: boolean;
};

const PRESETS: Record<Exclude<QualityLevel, 'auto'>, Omit<QualitySettings, 'resolved'>> = {
  high: {
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 2048,
    curveSegments: 48,
    antialias: true,
  },
  medium: {
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 1024,
    curveSegments: 32,
    antialias: true,
  },
  low: {
    maxPixelRatio: 1,
    shadows: false,
    shadowMapSize: 512,
    curveSegments: 20,
    antialias: false,
  },
};

/**
 * 偵測裝置能力並挑一個起始等級。
 *
 * 沒有可靠的「這是不是中階手機」API，因此只用幾個粗略但穩定的訊號：
 * 指標精度（觸控 vs 滑鼠）、邏輯核心數、裝置記憶體、以及實際的 pixel 數。
 * 猜錯不要緊 —— 使用者可以手動覆寫，且執行時的 fps 量測會顯示在 HUD 上。
 */
export function detectQuality(): Exclude<QualityLevel, 'auto'> {
  if (typeof window === 'undefined') return 'high';

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  // deviceMemory 只有 Chromium 系有，缺少時不做推論。
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const dpr = window.devicePixelRatio || 1;
  // 實際要填的像素數才是負擔所在：高 DPR 的小螢幕一樣很吃力。
  const pixels = window.screen.width * window.screen.height * dpr * dpr;

  if (!coarse) return 'high';
  if (cores <= 4 || (memory !== undefined && memory <= 3)) return 'low';
  if (cores <= 6 || pixels > 4.5e6) return 'medium';
  return 'medium';
}

export function resolveQuality(level: QualityLevel): QualitySettings {
  const resolved = level === 'auto' ? detectQuality() : level;
  return { resolved, ...PRESETS[resolved] };
}

/**
 * 把設定套到 renderer 與場景上。
 *
 * `antialias` 不在此處理 —— WebGLRenderer 的 MSAA 在 context 建立時就固定了，
 * 改它必須重建 context 與所有 GPU 資源。啟動時取一次偵測值，之後不動。
 */
export function applyQuality(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  settings: QualitySettings,
): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.maxPixelRatio));
  renderer.shadowMap.enabled = settings.shadows;

  const key = scene.getObjectByName('key-light');
  if (key instanceof THREE.DirectionalLight) {
    key.castShadow = settings.shadows;
    if (key.shadow.mapSize.width !== settings.shadowMapSize) {
      key.shadow.mapSize.setScalar(settings.shadowMapSize);
      // 尺寸改變後必須丟掉舊的 render target，否則 three 會繼續用舊解析度。
      key.shadow.map?.dispose();
      key.shadow.map = null;
    }
    key.shadow.needsUpdate = true;
  }

  // 關閉陰影時把 castShadow 也關掉，省去 three 遍歷可投影物件的成本。
  //
  // 只還原「原本就會投影」的物件 —— 第一次套用時把建構時的值記進 userData，
  // 否則來回切換品質會把地面之類本來不投影的東西也變成投影者，反而更慢。
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const data = object.userData as { baseCastShadow?: boolean };
    data.baseCastShadow ??= object.castShadow;
    object.castShadow = settings.shadows && data.baseCastShadow;
  });
}
