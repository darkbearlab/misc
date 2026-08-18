// @ts-check
/**
 * ESLint flat config —— 以規則強制執行 §2 與 §3 的專案級禁令。
 *
 *  §2  `src/sim/` 與 `src/data/` 不得 import 或使用任何瀏覽器 API
 *  §3.1 禁止 `Math.random()`
 *  §3.2 禁止以 `Date.now()` / `performance.now()` 影響模擬邏輯
 *  §3.3 禁止使用 Rapier 的 `DynamicRayCastVehicleController`
 *  §3.4 禁止對動態物體使用 trimesh collider
 *  §3.6 禁止在 `sim/` 內做任何 I/O
 *  §11.6 全專案不得含任何渲染相關依賴或程式碼
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** 一旦在 `src/sim/` 或 `src/data/` 出現就代表違反 §2 的瀏覽器全域。 */
const BROWSER_GLOBALS = [
  'window',
  'document',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'navigator',
  'localStorage',
  'sessionStorage',
  'location',
  'history',
  'screen',
  'alert',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Image',
  'HTMLCanvasElement',
  'CanvasRenderingContext2D',
  'WebGLRenderingContext',
  'WebGL2RenderingContext',
  'OffscreenCanvas',
  'ImageData',
  'self',
];

/** §11.6：任何渲染相關套件都不得出現在相依樹中。 */
const RENDERING_PACKAGES = [
  'three',
  'babylonjs',
  '@babylonjs/core',
  'pixi.js',
  'canvas',
  'gl',
  'regl',
  'twgl.js',
  'ogl',
  'p5',
  'phaser',
];

/**
 * §3 禁令 7（v1.3 §1.5）：每幀熱路徑上不得使用精度為實作定義的數學函式。
 *
 * 只有 `+ - * /`、`Math.sqrt`、`Math.abs`、`Math.min`、`Math.max`、
 * `Math.round`、`Math.floor`、`Math.trunc`、`Math.sign` 是 IEEE-754 要求正確捨入
 * （或純整數運算）的，跨平台位元一致。其餘超越函式的精度由引擎自行決定。
 *
 * 熱路徑上的一個 ULP 差異會改變出界判定的幀號，進而改變 checksum 陣列長度與勝負結果。
 * 詳見 src/sim/judge.ts 的 stadiumDistance() 註解。
 */
const IMPLEMENTATION_DEFINED_MATH = [
  'hypot',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'pow',
  'exp',
  'expm1',
  'log',
  'log2',
  'log10',
  'log1p',
  'cbrt',
  'fround',
];

const MATH_PRECISION_BAN = {
  object: 'Math',
  property: '',
  message:
    '§3 禁令 7：每幀熱路徑不得使用精度為實作定義的數學函式（跨平台位元不一致 → §11.8 失敗）。' +
    '只允許 + - * / 與 Math.sqrt/abs/min/max/round/floor/trunc/sign。' +
    '建構期（世界佈局、初始姿態）不受此限，見 eslint.config.js 的例外清單。',
};

const GLOBAL_BANS = [
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message:
      '§3.1 禁止使用 Math.random()。所有隨機來源必須經由 src/sim/rng.ts 的 seeded PRNG。',
  },
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: '§3.2 禁止使用 Date.now()。模擬迴圈以整數幀計數推進，不得依賴實際經過時間。',
  },
  {
    selector: "Identifier[name='DynamicRayCastVehicleController']",
    message:
      '§3.3 禁止使用 Rapier 的 DynamicRayCastVehicleController。輪胎力必須依 §6 自行以 raycast + applyImpulseAtPoint 實作。',
  },
  {
    selector: "MemberExpression[property.name='createVehicleController']",
    message: '§3.3 禁止使用 Rapier 的 DynamicRayCastVehicleController。',
  },
  {
    selector: "MemberExpression[property.name=/^(trimesh|roundTrimesh)$/]",
    message: '§3.4 禁止對動態物體使用 trimesh collider。所有動態碰撞體一律 convex hull。',
  },
];

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**', '*.csv'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      // TypeScript 自己就會抓未定義的識別字，開 no-undef 只會誤報。
      'no-undef': 'off',
      'no-restricted-syntax': ['error', ...GLOBAL_BANS],
      // §11.6（Phase 1 重新界定範圍）：渲染函式庫只允許出現在 src/render 與 src/ui，
      // 其餘一律禁止。下方有針對那兩個目錄的解除規則。
      'no-restricted-imports': [
        'error',
        {
          paths: RENDERING_PACKAGES.map((name) => ({
            name,
            message: '§11.6：渲染函式庫只允許出現在 src/render/ 與 src/ui/。',
          })),
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // §2 硬性約束 + §3.6：模擬核心不得碰瀏覽器 API，也不得做任何 I/O。
    files: ['src/sim/**/*.ts', 'src/data/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...BROWSER_GLOBALS.map((name) => ({
          name,
          message: `§2 src/sim 與 src/data 底下不得使用任何瀏覽器 API（${name}）。`,
        })),
      ],
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        ...GLOBAL_BANS,
        {
          selector: "MemberExpression[object.name='performance']",
          message: '§3.2 禁止使用 performance.now() 影響模擬邏輯。',
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message: '§3.2 模擬核心不得依賴牆上時間。',
        },
        {
          selector:
            "CallExpression[callee.object.name=/^(fs|fsPromises)$/], ImportDeclaration[source.value=/^node:(fs|http|https|net|child_process|readline)$/]",
          message: '§3.6 禁止在 sim/ 內做任何 I/O，檔案讀寫一律由 tools/ 層負責。',
        },
      ],
    },
  },

  {
    // §3 禁令 7：模擬核心的每幀熱路徑不得使用精度為實作定義的數學函式。
    files: ['src/sim/**/*.ts', 'src/data/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...IMPLEMENTATION_DEFINED_MATH.map((property) => ({
          ...MATH_PRECISION_BAN,
          property,
        })),
      ],
    },
  },

  {
    /**
     * §3 禁令 7 的建構期例外。
     *
     * 這兩個檔案在**世界佈局與初始姿態**中需要三角函數，其結果不隨幀累積：
     *   - world.ts    圍欄圓弧段的位置與朝向，只在 createWorld() 中計算一次
     *   - types.ts    quatFromAxisAngle()，用於圍欄旋轉與投擲初始朝向，每台車一次
     *
     * 兩者都不在每幀熱路徑上。每幀會執行的 rotateByQuat / normalize / length
     * 只用到 + - * / 與 Math.sqrt。
     *
     * 新增此清單的檔案前，請先確認該用法確實只在建構期執行。
     */
    files: ['src/sim/world.ts', 'src/sim/types.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },

  {
    /**
     * §P1.6：模擬核心不得反向依賴上層。
     *
     * `src/sim/` 與 `src/data/` 是最底層，只能被往上依賴。一旦它們 import 了
     * replay 或 render，「渲染在架構上不可能影響物理」這個 §P1.2.1 的結構性保證就破了。
     */
    files: ['src/sim/**/*.ts', 'src/data/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/replay/**', '**/render/**', '**/ui/**', 'three', 'three/*'],
              message:
                '§P1.6：src/sim 與 src/data 不得依賴 replay / render / ui 或任何渲染函式庫。',
            },
          ],
          paths: RENDERING_PACKAGES.map((name) => ({
            name,
            message: '§11.6 全專案不含任何渲染相關依賴或程式碼。',
          })),
        },
      ],
    },
  },

  {
    /**
     * §3 禁令 1(禁止 Math.random)只約束 src/sim/ —— 它保護的是**模擬**的決定性。
     *
     * UI 層產生「一組新的投擲參數」是使用者輸入的來源,不是模擬過程:
     * 隨機的是輸入,模擬本身收到那組參數後仍完全決定性
     * (tests/random-throw.test.ts 驗證同一組 seed 重播結果相同)。
     * 設計方 2026-08-18 明文裁決此範圍。
     */
    files: ['src/ui/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    /**
     * `src/replay/` 是 sim 之上、render 之下的一層：
     * 組裝 TrajectoryMeta（需要牆上時間）與判斷 replay 的相容性。
     * 它不做 I/O、不碰瀏覽器 API，因此 tools/ 與 render/ 都能使用。
     */
    files: ['src/replay/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        ...BROWSER_GLOBALS.map((name) => ({
          name,
          message: `§P1.6：src/replay 不得使用瀏覽器 API（${name}），它同時服務 CLI 與渲染層。`,
        })),
      ],
    },
  },

  {
    /**
     * §P1.6：`src/render/` 與 `src/ui/` 是唯二允許使用瀏覽器 API 與渲染函式庫的地方。
     *
     * 它們仍受 §3.1（禁止未受控的隨機來源）約束 —— 隨機投擲一樣要走 `src/sim/rng.ts`。
     * 而 §3 禁令 7（實作定義的數學函式）不適用於此：渲染層的數學不進 checksum，
     * 也不隨幀累積，跨平台差異在這裡沒有後果。
     */
    files: ['src/render/**/*.ts', 'src/ui/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
      'no-console': 'error',
    },
  },

  {
    // tools/ 是唯一允許 I/O 的一層；tests/ 需要量測牆上時間來驗收 §11.5，
    // 也需要 import three 來驗證渲染層的幾何同步（§P1.10-5）。
    files: ['tools/**/*.ts', 'tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
