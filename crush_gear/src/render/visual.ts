/**
 * 純視覺常數（§P1.7.1）。
 *
 * **這裡只放沒有物理對應物的東西**：顏色、光照強度、相機角度、以及輪子的外觀比例
 * （模型中輪子根本不是剛體，沒有真實尺寸可言）。
 *
 * 任何**有**物理對應的尺寸 —— stadium 半徑、圍欄高度厚度、底盤 cuboid、前武器 hull、
 * 輪位錨點 —— 一律從 `src/data/constants.ts` 讀取，絕不在渲染層寫死。
 * 硬編會讓「看到的車」與「實際碰撞的車」形狀不同，而這種不同步極難察覺，
 * 一旦發生，所有的觀察都失去意義。`tests/render.test.ts` 會掃描並擋下。
 */

import { SUSPENSION_REST_LENGTH, TRACK_WIDTH } from '../data/constants.js';

// ── 顏色 ────────────────────────────────────────────────────────────────

export const COLOR_BACKGROUND = 0x11141a;
export const COLOR_ARENA_SURFACE = 0x2b3242;
export const COLOR_PHYSICS_FLOOR = 0x171b24;
export const COLOR_FENCE = 0x4a5570;
export const COLOR_OUT_RING = 0xd05a5a;

export const COLOR_CAR_A = 0x4fa3ff;
export const COLOR_CAR_B = 0xff7a4f;
export const COLOR_WEAPON = 0xe8edf5;
export const COLOR_WHEEL = 0x22262f;
/** 該輪離地時的輪子顏色（§P1.8.2 的除錯疊圖會用到，P1-b 先接上）。 */
export const COLOR_WHEEL_AIRBORNE = 0xffd24a;
/** 輪武器：與前後武器區分開，否則六個部件疊在一起分不出誰是誰。 */
export const COLOR_WHEEL_WEAPON = 0x9aa7c4;

// ── 材質外觀 ────────────────────────────────────────────────────────────
// 這些是 PBR 的外觀參數，與尺寸無關。刻意集中在此，讓 scene.ts / vehicle.ts
// 完全不出現裸數值 —— 否則審查者看到 `roughness: 0.35` 無從判斷那是不是場地半徑。

export const WEAPON_METALNESS = 0.6;
export const WEAPON_ROUGHNESS = 0.35;
export const OUT_RING_OPACITY = 0.75;
/**
 * 車身外殼的不透明度。
 *
 * 外殼是最大的部件（140 × 90 × 42），不透明的話底盤、輪武器與輪子全部看不見。
 * 半透明是**除錯需求**，不是美術選擇。
 */
export const SHELL_OPACITY = 0.45;

// ── 光照 ────────────────────────────────────────────────────────────────

export const AMBIENT_INTENSITY = 1.1;
export const KEY_LIGHT_INTENSITY = 2.4;
export const FILL_LIGHT_INTENSITY = 0.8;

// ── 相機 ────────────────────────────────────────────────────────────────

export const CAMERA_FOV = 45;
export const CAMERA_NEAR = 0.01;
export const CAMERA_FAR = 20;
/** 全景相機的距離與高度，以場地尺寸的倍數表示（不是寫死的長度）。 */
export const OVERVIEW_DISTANCE_FACTOR = 1.35;
export const OVERVIEW_HEIGHT_FACTOR = 1.15;
/** 跟隨相機的偏移，同樣以場地尺寸的倍數表示。 */
export const FOLLOW_DISTANCE_FACTOR = 0.55;
export const FOLLOW_HEIGHT_FACTOR = 0.32;
/** 跟隨相機的平滑係數（每秒收斂比例）。 */
export const FOLLOW_SMOOTHING = 6;

// ── 輪子外觀 ────────────────────────────────────────────────────────────

/**
 * 輪子的視覺半徑。
 *
 * 取懸吊自由長度：如此一來懸吊未受壓時輪心恰好落在輪位錨點上，
 * 受壓時輪子相對車體上移，看起來就是懸吊在作動。
 * 這是**由物理常數衍生**的，不是憑空挑的數字。
 */
export const WHEEL_VISUAL_RADIUS = SUSPENSION_REST_LENGTH;

/** 輪寬，取輪距的一個比例；輪子不是剛體，沒有真實寬度可言。 */
export const WHEEL_WIDTH_FACTOR = 0.18;
export const WHEEL_VISUAL_WIDTH = TRACK_WIDTH * WHEEL_WIDTH_FACTOR;

export const WHEEL_SEGMENTS = 16;

/** 圓弧場地邊界的取樣段數（純粹是曲線的平滑度）。 */
export const ARENA_CURVE_SEGMENTS = 48;

/** 出界門檻環的線寬（以場地半徑的比例表示）。 */
export const OUT_RING_WIDTH_FACTOR = 0.012;

// ── 除錯疊圖（§P1.8.2） ─────────────────────────────────────────────────

export const COLOR_NORMAL_FORCE = 0x62d98a;
export const COLOR_TIRE_FORCE = 0xffcc44;
export const COLOR_COM = 0xff4fd0;
export const COLOR_UP_VECTOR = 0x8affd8;
export const COLOR_STADIUM_LINE = 0x5f7fbf;
export const COLOR_STADIUM_LINE_DANGER = 0xd05a5a;
export const COLOR_FLIP_WARN = 0xffb020;

/**
 * 法向力的顯示比例（公尺 / 牛頓）。
 *
 * 靜態時單輪約 0.37 N（車重 1.47 N 分四輪），對應柱高約 18 mm ——
 * 與車體高度 25 mm 同量級，一眼就能比較四輪之間的分配差異。
 */
export const NORMAL_FORCE_METRES_PER_NEWTON = 0.05;

/**
 * 輪胎力的顯示比例（公尺 / 牛頓）。
 *
 * 靜態滑動時單輪約 μN = 0.11 N，對應箭頭長度約 44 mm，
 * 與車長 150 mm 相比清楚可辨但不至於蓋住車體。
 */
export const TIRE_FORCE_METRES_PER_NEWTON = 0.4;

export const NORMAL_FORCE_BAR_THICKNESS = 0.004;
export const COM_MARKER_RADIUS = 0.004;
export const UP_VECTOR_LENGTH = 0.06;
