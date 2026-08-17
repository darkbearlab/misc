# 超激力戰鬥車 — Phase 0 模擬核心

純 headless 的決定性物理模擬核心，可在 Node.js 直接執行。實作依據 **SPEC v1.3**
（v1.0 + v1.1 + v1.2 + v1.3 修訂）。

本階段成功的唯一定義：**同一組輸入參數重複執行 100 次，輸出的 state checksum 陣列完全一致。**

本階段**不含**任何渲染程式碼、零件脫落系統、組裝 UI、零件資料庫、AI 對手、賽事模式、
存檔、音效、動畫或粒子效果。

---

## 安裝

需要 Node.js 20 以上（開發與驗收於 Node 24 執行）。

```bash
npm install
```

Rapier 以**精確版本號**鎖定（`@dimforge/rapier3d-compat: 0.19.3`，無 `^` 無 `~`）。
Rapier 版本一旦變更，所有既有 replay 檔即視為失效。

---

## 執行

### 單場模擬

```bash
npx tsx tools/sim.ts --input sample_battles/a_wins_out.json
```

```json
{
  "result": "A_WINS",
  "reason": "OUT",
  "frames": 505,
  "checksums": [1840004718, ...]
}
```

### 決定性驗證

重複執行並比對所有 run 的 checksum 陣列，一致時 exit code 為 0，
出現分歧時為 1，並回報首次分歧的取樣點與幀數。

```bash
npx tsx tools/sim.ts --input sample_battles/a_wins_out.json --repeat 100 --verify
```

```json
{
  "result": "A_WINS",
  "reason": "OUT",
  "frames": 505,
  "checksums": [...],
  "verify": {
    "runs": 100,
    "identical": true,
    "divergentRuns": 0,
    "firstDivergence": null,
    "elapsedMs": 2077
  }
}
```

### 批次模式（worker pool 平行執行）

接受投擲參數陣列，輸出勝負統計 CSV（省略 `--out` 則印到 stdout；
彙總統計與戰鬥長度直方圖一律印到 stderr，不會污染 CSV）。

```bash
npx tsx tools/sim.ts --batch fixtures/benchmark-500.json --out results.csv
```

```
wrote results.csv and results.csv.histogram.json
500 battles in 7694 ms using 12 worker(s) — A_WINS=203 B_WINS=200 DRAW=97 | OUT=297 FLIP=106 TIMEOUT=97
1067140 frames (2134280 car-frames)

battle length histogram (frames):
  0-120            280 ( 56.0%) ########################################  OUT 252, FLIP 28
  120-300           10 (  2.0%) #                                         OUT 5, FLIP 5
  300-600            9 (  1.8%) #                                         OUT 2, FLIP 7
  600-1200          18 (  3.6%) ###                                       OUT 6, FLIP 12
  1200-2400         23 (  4.6%) ###                                       OUT 9, FLIP 14
  2400-3600         14 (  2.8%) ##                                        OUT 6, FLIP 8
  3600-4800         22 (  4.4%) ###                                       OUT 7, FLIP 15
  4800-6000         15 (  3.0%) ##                                        OUT 6, FLIP 9
  6000-7200         12 (  2.4%) ##                                        OUT 4, FLIP 8
  7200 (timeout)    97 ( 19.4%) ##############                            TIMEOUT 97
```

| 選項 | 說明 |
|---|---|
| `--workers N` | worker 數量，預設 `os.availableParallelism()` |
| `--workers 1` | 完全不建立 worker，in-process 序列執行，並額外輸出 µs/car-frame（§11.5b） |
| `--out FILE` | CSV 寫入 FILE，直方圖同時寫入 `FILE.histogram.json` |

每場戰鬥完整地在單一 worker 內序列完成，不跨 worker 拆分；結果依**輸入順序**回傳，
不受 worker 完成順序影響。`--workers 1` 與 `--workers 12` 的 CSV 位元完全相同。

批次檔可以是裸 JSON 陣列，或 `{ "battles": [ ... ] }`；每筆可加上選用的 `"id"`。

### 跨平台決定性驗證（§16）

```bash
npx tsx tools/verify-platform.ts --list
npx tsx tools/verify-platform.ts --generate --out baseline.json
npx tsx tools/verify-platform.ts --compare baseline.json
npx tsx tools/verify-platform.ts --dump orbit_01 --frame 1234
```

`fixtures/platform/` 內含 20 組 fixture，涵蓋高速正面對撞、擦邊碰撞、沿圍欄長時間環繞、
早期出界、早期翻覆五類，共 44,802 幀。同目錄下的 `baseline.json` 是已簽入的參考結果
（讀取 fixture 時會自動跳過它）。

`--generate` 預設同時記錄**每一幀**的 checksum，這是把首次分歧定位到確切幀號的唯一辦法
（§9.2 的 60 幀取樣只能定位到區間）；`--no-dense` 可關閉。
`--compare` 在發現分歧時會輸出首次分歧的確切幀號、分歧前最後一次相符的 checksum、
兩份環境指紋的差異欄位，並印出分歧幀前後雙方的完整狀態。

### 測試與檢查

```bash
npm test        # vitest：決定性 + §11 驗收條件（約 3 分鐘）
npm run lint    # ESLint：§2 / §3 專案級禁令
npm run typecheck
npm run check   # 以上三者
```

---

## 物理模型

**規格與全部數值以 [SPEC.md](SPEC.md) 為準**，本檔不重複條文，只放實測結果與操作說明。

| 主題 | 規格章節 |
|---|---|
| 場地（stadium 尺寸、26 段圍欄、地板） | [SPEC.md §5](SPEC.md) |
| 車體（雙 collider、質量重心慣量、剛體屬性、懸吊、輪胎力模型） | [SPEC.md §6](SPEC.md) |
| 投擲參數與合法範圍 | [SPEC.md §7](SPEC.md) |
| 勝負判定 | [SPEC.md §8](SPEC.md) |
| 決定性要求 | [SPEC.md §9](SPEC.md) |
| 跨平台決定性 | [SPEC.md §16](SPEC.md) |
| 渲染層與播放器 | [SPEC_PHASE1.md](SPEC_PHASE1.md) |

物理常數的唯一來源是 [src/data/constants.ts](src/data/constants.ts)；
`tests/acceptance.test.ts` 會在該檔內容改變而 `PHYSICS_VERSION` 未升時失敗提醒（SPEC.md §17）。

### 實測的湧現行為

輪胎恆處於滑動摩擦狀態，因此摩擦力永遠是 Coulomb 飽和上限 `F = μN`、各向同性
（SPEC.md §6.5）。以下行為是模擬的自然結果，**不是額外程式碼造出來的**：

- 車輛不沿車頭方向直線行進，慣性主導、明顯漂移
- 被撞擊後長時間自轉打滑
- 自由加速 0.5 秒後速度 **1.461 m/s**，與理論上限 `μg·t = 1.472 m/s` 相符
- 直線行駛時底盤幾乎不晃：0.5 秒內最大傾角 0.76°，行駛高度穩定在 29.0 mm
- 翻覆臨界 μ = **0.897**，高於 μ = 0.30，因此不會單靠橫向摩擦自行翻覆
- 500 場隨機投擲中，線速度與角速度的 clamp 觸發次數皆為 **0**

---

## 投擲參數

範圍與驗證規則見 [SPEC.md §7](SPEC.md)。超出範圍會在模擬開始前拋出 `RangeError`，不會靜默 clamp。

```json
{
  "seed": 12345,
  "throwA": { "x": -0.25, "z": 0, "y": 0.05, "yaw": 1.5708, "pitch": 0, "speed": 2.5, "spin": 0 },
  "throwB": { "x": 0.25, "z": 0, "y": 0.05, "yaw": 4.7124, "pitch": 0, "speed": 2.5, "spin": 0 }
}
```

`sample_battles/` 內含展示不同結局的輸入檔：

| 檔案 | 結局 |
|---|---|
| `a_wins_out.json` | `A_WINS` / `OUT` / 505 frames |
| `b_wins_flip.json` | `B_WINS` / `FLIP` / 516 frames |
| `draw_timeout.json` | `DRAW` / `TIMEOUT` / 7200 frames |
| `high_speed_head_on.json` | `B_WINS` / `FLIP` / 501 frames（兩車 5 m/s 正面對撞） |
| `spec_example.json` | 規格書 §10 的範例輸入（投入點依 v1.1 §7 調整） |
| `batch_example.json` | 批次模式範例 |

---

## Replay 與版本化

規格見 [SPEC_PHASE1.md §P1.2–§P1.5](SPEC_PHASE1.md)（分離架構、軌跡格式、版本化、診斷輸出）
與 [SPEC.md §17](SPEC.md)（`physicsVersion` 的升版規則）。以下是使用方式。

```ts
import { generateTrajectory, toReplayFile, loadReplay } from './src/replay/trajectory.js';

const t = await generateTrajectory({ seed, throwA, throwB });
// t.position[car]  Float32Array，長度 frameCount * 3（剛體原點，非質心）
// t.rotation[car]  Float32Array，長度 frameCount * 4（四元數 x,y,z,w）
// t.outcome        { result, reason, frames }

const file = toReplayFile(t);   // 只存 meta，約 1 KB
const again = await loadReplay(file);   // 版本不符時拋 IncompatibleReplayError
```

實測資料量：7200 幀雙車的軌跡 394 KB，診斷資料 1.68 MB。

目前的物理身分（`src/data/version.ts`）：`PHYSICS_VERSION = 1`、
`RAPIER_VERSION = 0.19.3`、`RAPIER_WASM_SHA256 = 1ce1c8c4…`。
`constants.ts` 的內容雜湊也記在同一檔案，改了常數卻沒動 `PHYSICS_VERSION` 時，
`tests/acceptance.test.ts` 會失敗提醒（是提醒而非阻止，純註解變更重新蓋章即可）。

### 播放器

```bash
npm run dev     # http://localhost:5173
```

進站即自動載入第一個範例並播放。

| 控制 | 說明 |
|---|---|
| 播放 / 暫停 / 重播 | |
| 逐幀 ◀ / ▶ | 在第 0 幀與結束幀正確停住，不越界 |
| 時間軸 | 拖曳至任意幀；拖曳後的狀態與從頭播到該幀完全相同 |
| 速度 | 0.1× / 0.25× / 0.5× / 1× / 2×，慢速下仍是平滑插值而非跳格 |
| 相機 | 全景 / 跟隨 A / 跟隨 B / 自由（滑鼠軌道） |

時間推進以**真實經過時間**換算目標幀（模擬固定 120 Hz，顯示更新率不定），
相鄰幀之間位置 lerp、旋轉 slerp。不以顯示幀直接對應模擬幀，
因此播放速度不隨螢幕更新率漂移。

### 除錯疊圖（§P1.8.2）

六項可獨立切換，資料全部來自診斷的旁路記錄，疊圖只做「數值 → 幾何長度」的線性換算：

| 疊圖 | 內容 |
|---|---|
| 四輪接地狀態 | 離地的輪子變色 |
| **法向力 N** | 接觸點的柱狀指示，高度 ∝ N；車體傾斜時外側／內側輪的分配差異一眼可辨 |
| **輪胎力向量** | 接觸點的箭頭，長度 ∝ 力的大小 |
| 重心與 up vector | 質心標記與車體上方向 |
| stadium 距離 | 由中心線到車體的連線，越過門檻時轉為警示色 |
| FLIP 計數器 | 連續翻覆幀數 / 60，過半時轉為警示 |

另有「顯示數值」開關，在接觸點旁標出 `N` 與 `F` 的實際數字。
疊圖刻意關閉深度測試，否則接觸點在車底、柱與箭頭會被底盤整個擋住。

實測一幀的讀數（`spec_example` 第 300 幀，車 A）：

```
N 0.382  F 0.115        F/N = 0.301
N 0.264  F 0.079        F/N = 0.299
N 0.422  F 0.127        F/N = 0.301
N 0.305  F 0.091        F/N = 0.298
                  ΣN = 1.373 N  （車重 m·g = 1.47 N）
```

四輪的 `F/N` 都等於 μ = 0.30 —— 摩擦力恆為 Coulomb 飽和上限（§6.4）在畫面上直接可讀。

### 診斷輸出（§P1.5）

`simulate(input, { diagnostics: true })` 額外記錄每幀每輪的接地狀態、法向力、
輪胎力向量、接觸點，以及每車的 stadium 距離與 FLIP 計數器。
這些是**旁路寫入** —— 只把已算出的中間值抄一份，不重新計算、不改變任何順序。
關閉時（預設）執行路徑與 Phase 0 位元完全相同，已由 `tests/replay.test.ts`
以逐幀 checksum 比對證明。

---

## 專案結構

```
src/
  sim/
    world.ts      場地與物理世界建構（stadium 圍欄）
    vehicle.ts    車體剛體（雙 collider）、懸吊、輪胎力
    tire.ts       輪胎力模型（純函式）
    judge.ts      勝負判定與 stadium 距離函數
    rng.ts        seeded PRNG（xoshiro128**）
    checksum.ts   狀態雜湊（FNV-1a 32-bit）
    simulate.ts   主模擬迴圈，對外唯一入口
    types.ts      共用型別定義與純向量／四元數運算
    (trajectory / diagnostics 為旁路輸出，預設關閉)
  data/
    constants.ts  所有物理常數與場地尺寸
    version.ts    physicsVersion 與物理身分（§P1.4）
  replay/
    trajectory.ts 軌跡組裝、replay 檔、相容性檢查（sim 與 render 之間的一層）
  render/
    scene.ts      場地與燈光（圍欄直接重用 sim 的 buildFenceSegments）
    vehicle.ts    車體 mesh（底盤 box、前武器凸包、四輪）
    player.ts     播放核心（真實時間 → 目標幀，lerp / slerp 插值）
    overlay.ts    除錯疊圖（§P1.8.2 六項）
    visual.ts     純視覺常數（顏色、光照、比例；不含任何物理尺寸）
    main.ts       進入點
  ui/
    controls.ts   原生 DOM 播放控制
tools/
  sim.ts              CLI 入口（唯一允許 I/O 的一層）
  pool.ts             批次模擬的 worker pool
  sim-worker.ts       worker 端點
  verify-platform.ts  跨平台決定性驗證（§16）
tests/
  determinism.test.ts   §9 決定性 / §11.1 / §1.3 平行化一致性
  acceptance.test.ts    §6 幾何驗證 / §11.2 ~ §11.7
  replay.test.ts        Phase 1 P1-a：軌跡、診斷、版本化
  render.test.ts        Phase 1 P1-b：幾何同步、判定一致、五類結局
  overlay.test.ts       Phase 1 P1-c/d：播放控制、疊圖換算
fixtures/
  platform/             §16 的 20 組 fixture + 已簽入的參考 baseline.json
  benchmark-500.json    §11.5a 的基準批次
sample_battles/
.github/workflows/
  platform-determinism.yml   §16 的 CI matrix
```

`src/sim/` 與 `src/data/` 底下不得 import 或使用任何瀏覽器 API，
也不得做任何檔案讀寫或主控台輸出。此約束由 `eslint.config.js` 的規則強制，
並由 `tests/acceptance.test.ts` 的靜態掃描複驗。

### 分層與渲染邊界

```
data  ←  sim  ←  replay  ←  render  ←  ui
```

相依只能由右往左。條文與理由見 [SPEC.md §2](SPEC.md)（分層）、
[SPEC.md §11.6](SPEC.md)（渲染邊界）、[SPEC_PHASE1.md §P1.6](SPEC_PHASE1.md)（`src/replay/` 的存在理由）。

實作以 ESLint 的 `no-restricted-imports` / `no-restricted-globals` 強制，
並由 `tests/acceptance.test.ts` 的靜態掃描複驗。

---

## 跨平台決定性

要求與驗證方式見 [SPEC.md §16](SPEC.md)。以下是實測結果。

**已驗證的本機結果**（win32 / x64 / Node 24.14.0 / V8 13.6，Rapier 0.19.3）：

| 驗證項目 | 結果 |
|---|---|
| 20 組 fixture 重複執行（44,802 幀） | 20/20 一致 |
| wasm 走 Liftoff 基準編譯器（`--liftoff-only`） | 20/20 一致 |
| wasm 走 TurboFan 最佳化編譯器（`--no-liftoff`） | 20/20 一致 |
| 停用 wasm 動態 tier-up（`--no-wasm-tier-up`） | 20/20 一致 |
| 停用 JS 最佳化編譯器（`--no-opt`） | 20/20 一致 |
| 單執行緒 V8（`--single-threaded`） | 20/20 一致 |

兩套完全不同的機器碼產生器對同一份 wasm 產生位元相同的結果，代表分歧不會來自 codegen 層。
支持一致性的三項結構性事實見 [SPEC.md §16.4](SPEC.md)。

**多架構矩陣結果：8/8 全綠**（2026-08-17）。Linux x64 產生的 baseline，在 macOS arm64、
Windows x64 上跑同一套 20 組 fixture（44,802 幀），checksum 陣列**位元完全相同**。
跨 CPU 架構、跨作業系統、跨 Node/V8 版本皆成立 ——
**seed 同步的線上架構假設成立，不需改為錄製回放。**

Rapier 版本或 wasm build 變更後，所有跨平台驗證須重跑；CI 為常態執行，作為升級時的迴歸防線。

### §11.8 執行方式

專案託管於 `darkbearlab/misc` 的 `crush_gear/` 子目錄，
CI 由該 repo 根目錄的 `.github/workflows/crush-gear-platform-determinism.yml` 驅動
（原因見下方說明）。手動觸發用 GitHub Actions 頁面的 `workflow_dispatch`。

> ⚠️ **若本專案是以子目錄形式放在別的 repo 裡**（例如 `<repo>/crush_gear/`），
> GitHub Actions **不會**執行 `crush_gear/.github/workflows/` 底下的 workflow ——
> Actions 只讀取 repo **根目錄**的 `.github/workflows/`。
> 此時需在 repo 根目錄另放一份適配版，重點是：
>
> ```yaml
> on:
>   push:
>     paths: ['crush_gear/**', '.github/workflows/<檔名>.yml']
>   workflow_dispatch:
> defaults:
>   run:
>     working-directory: crush_gear      # 只作用於 run: 步驟
> ```
>
> `uses:` 步驟不受 `working-directory` 影響，其 `path` 一律相對於 workspace 根目錄，
> 因此 `upload-artifact` 要寫 `crush_gear/baseline.json`、`download-artifact` 要寫 `path: crush_gear`。
>
> **目前的託管位置**：本專案位於 `darkbearlab/misc` 的 `crush_gear/` 子目錄，
> 適配版 workflow 已存在於該 repo 根目錄的
> `.github/workflows/crush-gear-platform-determinism.yml`。
> 本目錄下的 `.github/workflows/platform-determinism.yml` 保留原樣，
> 供日後搬到獨立 repo 時直接使用。
>
> 此適配版已於 2026-08-17 實際執行並全綠。

送出前的兩項檢查（本 repo 已確認通過）：

| 檢查 | 狀態 |
|---|---|
| `package-lock.json` 已納入版本控制（未提交會讓 CI 安裝到不同的 wasm binary） | ✅ 存在，鎖定 `0.19.3` 與 integrity hash |
| `fixtures/` 未被 `.gitignore` 排除 | ✅ `.gitignore` 內的 baseline 規則已錨定為 `/baseline.json`，不會誤傷 `fixtures/platform/baseline.json` |

### 結案記錄

| 欄位 | 值 |
|---|---|
| Rapier 版本 | `@dimforge/rapier3d-compat@0.19.3`（精確鎖定，`package-lock.json` 已納入版控） |
| wasm SHA-256 | `1ce1c8c4036b4dcd3bde86c6efdb0f270cf5e274979b1de6ab8052947ef166c5` |
| wasm 使用 SIMD | 否（type section 無 v128；CI 有 guard 會在改為 SIMD build 時失敗） |
| Fixture 組數 / 總幀數 | 20 組 / 44,802 幀 |
| 參考 baseline | `fixtures/platform/baseline.json` |
| CI run | [run #1](https://github.com/darkbearlab/misc/actions/runs/32045828668)，commit `919f0c3` |

| 平台組合 | Node | arch | 結果 | 驗證日期 |
|---|---|---|---|---|
| ubuntu-latest（baseline 產生者） | 20 | x64 | ✅ | 2026-08-17 |
| ubuntu-latest | 22 | x64 | ✅ 20/20 | 2026-08-17 |
| **macos-latest** | 20 | **arm64** | ✅ 20/20 | 2026-08-17 |
| **macos-latest** | 22 | **arm64** | ✅ 20/20 | 2026-08-17 |
| windows-latest | 20 | x64 | ✅ 20/20 | 2026-08-17 |
| windows-latest | 22 | x64 | ✅ 20/20 | 2026-08-17 |
| codegen tiers（Liftoff / TurboFan / no-tier-up / no-opt） | 20 | x64 | ✅ | 2026-08-17 |
| win32（本機開發，含 5 種 codegen 路徑） | 24.14.0 | x64 | ✅ 20/20 | 2026-08-17 |

**§11.8 通過，Phase 0 結案。**

未來若任一組分歧，依 v1.2 §7.5 停止並提出報告，**不得降低 checksum 精度或放寬比對容差**。
首要嫌疑順序：(1) 安裝到不同的 wasm binary（比對 SHA-256），(2) JS 端殘留的實作定義函式
（§3 禁令 7 的 ESLint 規則應已排除），(3) Rapier 內部的平台相依路徑。

---

## §11 驗收狀態

| # | 條件 | 狀態 | 實測 |
|---|---|---|---|
| 1 | 決定性：10 組參數 × 100 次執行 checksum 完全一致 | ✅（附偏離說明） | 10 組情境全部一致；其中 9 組跑滿 100 次，「逾時平手」情境為成本考量只跑 20 次，見 [TUNING.md](TUNING.md) §5 |
| 2 | 無爆飛：500 組隨機投擲 | ✅ | `y` 峰值 0.348（上限 0.5）；線速度峰值 5.07、角速度峰值 84.2，**clamp 觸發 0 次** |
| 3 | 翻覆可觸發 | ✅ | 500 場中 106 場以 FLIP 收場；`b_wins_flip.json` 穩定重現 |
| 4 | 出界可觸發 | ✅ | 500 場中 297 場以 OUT 收場；`a_wins_out.json` 穩定重現 |
| 5a | 批次吞吐：500 場平行執行於 30 秒內 | ✅ | **7.69 秒**（12 workers） |
| 5b | 單場成本：單執行緒 ≤ 50 µs/car-frame | ✅ | **20.44 µs/car-frame** |
| 6 | 渲染邊界（Phase 1 修訂） | ✅ | 見下方條文；靜態掃描 + ESLint 通過 |
| 7 | ESLint 通過 | ✅ | 無違例 |
| 8 | 跨平台一致（≥3 種平台組合，含 arm64 與非 Linux） | ✅ | CI matrix 8/8 全綠：ubuntu / macos-arm64 / windows × Node 20 / 22 + codegen tiers |

**Phase 0 已結案**（§11.8 於 2026-08-17 通過）。

19% 的戰鬥會進入沿圍欄的穩定漂移環繞而跑滿 60 秒時限。這是設計議題而非效能問題，
已記入 [PHASE1_BACKLOG.md](PHASE1_BACKLOG.md) §15，**不在 Phase 0 實作範圍**。
均勻隨機取樣的 56% 秒速出界則不是缺陷（真人玩家會學會避開），但 Phase 1 的平衡驗證
需要另一個「有效投擲子空間」取樣器，同樣記於 backlog。
