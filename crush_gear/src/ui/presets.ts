/**
 * 播放器的物理設定清單。
 */

import type { PhysicsOverride } from '../sim/types.js';

/**
 * 播放器可選的物理設定(§Phase 1-e 後續)。
 *
 * **播放器的預設值與模擬核心的預設值刻意不同。** 核心不指定覆寫時走 v1 凍結路徑,
 * `verify-platform` 與 fixture 依賴這一點;播放器則預設載入最新的探索設定,
 * 否則第四、五輪的成果只存在於覆寫路徑,設計方永遠看不到,
 * 而視覺判斷正是後續裁決的依據。兩者互不影響。
 */
export type PlayerPreset = {
  id: string;
  label: string;
  /** 顯示用的一行摘要:車體 + substep + 地板摩擦。 */
  summary: string;
  /** 範例檔所在的目錄（相對 sample_battles/）。 */
  sampleDir: string;
  physics?: PhysicsOverride;
};

export const PLAYER_PRESETS: readonly PlayerPreset[] = [
  {
    id: 'wedge',
    label: '第五輪 鏟形',
    summary: '官方規格車 + 鏟形前後武器 · substep 4 · μ_floor 0.20',
    sampleDir: 'official',
    physics: {
      vehiclePreset: 'wedge',
      substeps: 4,
      vehicleDerivedThrowMargin: true,
      enforceMinThrowSeparation: true,
    },
  },
  {
    id: 'wedge-no-friction',
    label: '第五輪 鏟形（μ_floor 0）',
    summary: '同上，但地板摩擦 0 —— FLIP 33.6% 對 4.8% 的對照組',
    sampleDir: 'official',
    physics: {
      vehiclePreset: 'wedge-no-friction',
      substeps: 4,
      vehicleDerivedThrowMargin: true,
      enforceMinThrowSeparation: true,
    },
  },
  {
    id: 'official',
    label: '第四輪 箱形',
    summary: '官方規格車 + 箱形武器 · substep 1 · μ_floor 0',
    sampleDir: 'official',
    physics: {
      vehiclePreset: 'official',
      vehicleDerivedThrowMargin: true,
      enforceMinThrowSeparation: true,
    },
  },
  {
    id: 'v1',
    label: 'v1 凍結基線',
    summary: 'PHYSICS_VERSION 1 的車體 150×70 · substep 1 · μ_floor 0',
    sampleDir: '',
  },
];
