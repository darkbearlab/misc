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

## 場地（§5）

Stadium 形（兩端半圓 + 中央矩形），整體 0.70 m (X) × 1.00 m (Z)。

| 參數 | 值 |
|---|---|
| 半圓半徑 R | 0.35 m |
| 中央直線段長度 L（沿 Z） | 0.30 m |
| 圍欄高度 / 厚度 | 0.06 m / 0.05 m |
| 地板厚度 | 0.20 m（單一矩形 cuboid，上表面 y = 0） |
| 地板與圍欄 friction / restitution | 0.0 / 0.15 |

圍欄內緣貼合 stadium 輪廓，由 **2 段直線 + 每端 12 段圓弧共 26 個 Fixed cuboid** 組成，
相鄰段以 1.15 的重疊係數確保無縫隙（實測 1440 個方向 × 4 個高度共 5760 條射線，落空 0 次）。

地板刻意使用單一矩形而非貼合輪廓：出界以距離函數判定，地板形狀不影響任何結果。

---

## 車體（§6）

**單一 RigidBody 掛載兩個 collider**，這個結構直接是 Phase 2 零件系統的原型
（底盤 = `core`，前武器 = `attack`）。

| 部件 | 形狀 | 尺寸 | 質量 |
|---|---|---|---|
| 底盤 chassis | cuboid | 0.070 × 0.025 × 0.100 m，位移 (0, 0.0025, 0) | 0.11 kg |
| 前武器 weapon | convex hull | 自 z = 0.050 延伸至 0.100，刃口寬 0.008 m | 0.04 kg |

**質量、重心、慣量三者全部由幾何與質量分配衍生，不人為指定任何一項。**
只對兩個 collider 分別 `setMass()`，其餘交給 Rapier 合成：

```
mass      0.150000 kg
localCom  (0.000000, 0.002455, 0.017795)     略偏前上方
inertia   Ixx = 2.3465e-4  Iyy = 2.7989e-4  Izz = 5.7787e-5  kg·m²
```

| 參數 | 值 |
|---|---|
| collider friction / restitution | 0.0 / 0.25 |
| CCD | 啟用 |
| 線速度上限 / 角速度上限 | 30 m/s / 400 rad/s |
| 輪距 / 軸距 | 0.056 m / 0.070 m |
| 懸吊 restLength / maxTravel / k / c | 0.025 m / 0.020 m / 300 N/m / 2.0 Ns/m |
| 輪胎 wheelSurfaceSpeed / μ | 4.0 m/s / 0.30 |

clamp 只負責攔截數值發散，**不得參與遊戲**：500 場隨機投擲中線速度與角速度的
clamp 觸發次數皆為 0。統計基線的迴歸偵測由 `tests/acceptance.test.ts` 負責，兩者不混用。

**摩擦力全部由輪胎模型提供。** 地板與車體的 collider friction 都刻意設為 0，
避免雙重摩擦來源導致調參時無法判斷力的出處。

輪胎恆處於滑動摩擦狀態，因此摩擦力永遠是 Coulomb 飽和上限 `F = μN`、各向同性、
與馬達扭力無關，不需要任何輪胎模型（Pacejka 等）。實測的湧現行為：

- 車輛不沿車頭方向直線行進，慣性主導、明顯漂移
- 被撞擊後長時間自轉打滑
- 自由加速 0.5 秒後速度 **1.461 m/s**，與理論上限 `μg·t = 1.472 m/s` 相符
- 直線行駛時底盤幾乎不晃：0.5 秒內最大傾角 0.76°，行駛高度穩定在 29.0 mm
- 翻覆臨界 μ = **0.897**（`trackWidth / (2·cogHeight)`），高於 μ = 0.30，
  因此不會單靠橫向摩擦自行翻覆；翻覆來自碰撞與前武器的掀擊

---

## 投擲參數（§7）

```json
{
  "seed": 12345,
  "throwA": { "x": -0.25, "z": 0, "y": 0.05, "yaw": 1.5708, "pitch": 0, "speed": 2.5, "spin": 0 },
  "throwB": { "x": 0.25, "z": 0, "y": 0.05, "yaw": 4.7124, "pitch": 0, "speed": 2.5, "spin": 0 }
}
```

| 參數 | 意義 | 合法範圍 |
|---|---|---|
| `x` / `z` | 投入點水平座標（m） | `stadiumDistance(x, z) ≤ 0.27`，即距圍欄內緣至少 0.08 m |
| `y` | 投入高度（m） | `[0.030, 0.15]` |
| `yaw` | 車頭朝向，繞世界 +Y 軸（rad） | `[0, 2π)` |
| `pitch` | 俯仰角（rad），**正值為機首上仰** | `[-0.3, 0.3]` |
| `speed` | 初速大小（m/s），方向由 yaw 與 pitch 決定 | `[0, 5.0]` |
| `spin` | 初始角速度，繞世界 +Y 軸（rad/s） | `[-20, 20]` |

超出範圍的參數會在模擬開始前拋出 `RangeError`，不會靜默 clamp。

`y` 的下界 0.030 恰好是**懸吊零壓縮**的高度（錨點 −0.005 + restLength 0.025），
低於此值車體會生成在懸吊壓縮狀態並被彈起。實測靜態行駛高度為 0.02904 m。

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
  data/
    constants.ts  所有物理常數與場地尺寸
tools/
  sim.ts              CLI 入口（唯一允許 I/O 的一層）
  pool.ts             批次模擬的 worker pool
  sim-worker.ts       worker 端點
  verify-platform.ts  跨平台決定性驗證（§16）
tests/
  determinism.test.ts   §9 決定性 / §11.1 / §1.3 平行化一致性
  acceptance.test.ts    §6 幾何驗證 / §11.2 ~ §11.7
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

---

## 勝負判定（§8）

每幀檢查，優先序 OUT → FLIP → TIMEOUT：

| 判定 | 條件 |
|---|---|
| `OUT` | `stadiumDistance(cx, cz) > 0.45` 或 `cy < -0.10` |
| `FLIP` | 車體 up vector 與世界 +Y 內積 `< 0`，且**持續 60 幀** |
| `TIMEOUT` | 達 7200 幀（60 秒）仍無勝負，判定為 `DRAW` |

```ts
function stadiumDistance(x: number, z: number): number {
  const dz = Math.max(-0.15, Math.min(0.15, z));
  const dzz = z - dz;
  return Math.sqrt(x * x + dzz * dzz);
}
```

此處刻意不使用 `Math.hypot`（§3 禁令 7）：它的精度是實作定義的，而本函式在每幀熱路徑上
決定出界判定 → 終止幀 → checksum 陣列長度，跨平台一個 ULP 的差異就足以讓勝負不一致。
詳見 [src/sim/judge.ts](src/sim/judge.ts) 的註解。

雙方於同一幀滿足敗北條件時判定為 `DRAW`；此時 `reason` 取優先序較高者，
即只要任一方是 `OUT` 就記為 `OUT`（§14.7）。

---

## 決定性（§9）

- 亂數只能來自 `src/sim/rng.ts` 的 xoshiro128\*\*，全程以 32-bit 整數運算推進
- 模擬迴圈以整數幀計數推進，不依賴實際經過時間
- 剛體建立順序固定：地板 → 圍欄直線段（−X、+X）→ +Z 端 12 段弧（θ 遞增）→
  −Z 端 12 段弧（θ 遞增）→ 車 A（底盤 → 前武器）→ 車 B
- 力的施加順序固定：車 A 的 4 個輪位（依 `WHEEL_ANCHORS` 陣列順序）→ 車 B 的 4 個輪位；
  每輪先施加懸吊力再施加輪胎力
- checksum 以 FNV-1a 32-bit 計算，所有浮點數先量化為 `Math.round(v * 1e6) | 0`
- 雜湊涵蓋範圍依固定順序：車 A 的質心位置、旋轉四元數、線速度、角速度 →
  車 B 同上 → RNG 內部狀態的 4 個 u32
- 取樣頻率：每 60 幀一次，加上結束幀必記一次

---

## 跨平台決定性（§16）

本專案的線上架構（以 seed + 投擲參數取代連線同步）完全建立在跨平台一致性之上。
剛體碰撞是混沌系統，1e-15 的浮點差異在數百幀後會演變為完全不同的勝負。

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

**支持跨平台一致的結構性事實：**

- Rapier 的 wasm **不 import 任何 JS 數學函式**，所有浮點運算都編譯在 wasm 內；
  WebAssembly 規範要求 f32/f64 運算位元精確（IEEE-754、round-to-nearest-even、
  無延伸精度、無 FMA 合併）
- 該 wasm build **不使用 SIMD**（type section 內完全沒有 v128），
  因此不存在 SIMD／純量路徑分歧的問題。CI 有一道檢查會在 Rapier 換成 SIMD build 時擋下來
- 本專案 JS 端的每幀熱路徑**只用到 `+ - * /` 與 `Math.sqrt`**，全部是 IEEE-754 要求
  正確捨入的運算，不含任何精度為實作定義的函式。`Math.sin` / `cos` / `tan` 只在
  世界佈局與初始姿態計算中使用（建構期，結果不隨幀累積）。
  此約束由 §3 禁令 7 的 ESLint 規則（`no-restricted-properties`）在 `src/sim/` 強制

**尚未執行的部分：** 真正的多架構矩陣（arm64、非 Linux、多個 Node 版本）需要 CI 或 Docker，
本開發環境兩者皆不可用。`.github/workflows/platform-determinism.yml` 已就緒，
涵蓋 ubuntu / macos(arm64) / windows × Node 20 / 22 共 6 種組合，
推上 GitHub 後即可執行。**§11.8 在該矩陣綠燈之前不算通過。**

Rapier 版本或 wasm build 變更後，所有跨平台驗證須重跑。

### §11.8 執行步驟（需設計方操作）

```bash
git init
git add -A
git commit -m "Phase 0: deterministic battle simulator"
gh repo create <name> --private --source=. --push
```

推送後於 GitHub Actions 確認 `platform determinism` workflow 的 7 個 job 全綠
（6 種平台組合 + codegen tier）。

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
> **在 workflow 實際跑完且全綠之前，§11.8 都不算通過。**

送出前的兩項檢查（本 repo 已確認通過）：

| 檢查 | 狀態 |
|---|---|
| `package-lock.json` 已納入版本控制（未提交會讓 CI 安裝到不同的 wasm binary） | ✅ 存在，鎖定 `0.19.3` 與 integrity hash |
| `fixtures/` 未被 `.gitignore` 排除 | ✅ `.gitignore` 內的 baseline 規則已錨定為 `/baseline.json`，不會誤傷 `fixtures/platform/baseline.json` |

### 結案記錄（待 §11.8 結果填入）

| 欄位 | 值 |
|---|---|
| Rapier 版本 | `@dimforge/rapier3d-compat@0.19.3` |
| wasm SHA-256 | `1ce1c8c4036b4dcd3bde86c6efdb0f270cf5e274979b1de6ab8052947ef166c5` |
| wasm 使用 SIMD | 否（type section 無 v128） |
| Fixture 組數 / 總幀數 | 20 組 / 44,802 幀 |
| 參考 baseline | `fixtures/platform/baseline.json` |

| 平台組合 | Node | arch | 結果 | 驗證日期 |
|---|---|---|---|---|
| win32（本機開發） | 24.14.0 | x64 | ✅ 20/20（含 5 種 codegen 路徑） | 2026-08-17 |
| ubuntu-latest | 20 | x64 | ⏳ 待執行 | |
| ubuntu-latest | 22 | x64 | ⏳ 待執行 | |
| macos-latest | 20 | arm64 | ⏳ 待執行 | |
| macos-latest | 22 | arm64 | ⏳ 待執行 | |
| windows-latest | 20 | x64 | ⏳ 待執行 | |
| windows-latest | 22 | x64 | ⏳ 待執行 | |

若任一組分歧，依 v1.2 §7.5 停止並提出報告，**不得降低 checksum 精度或放寬比對容差**。
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
| 6 | 無渲染碼 | ✅ | 靜態掃描 + 相依樹檢查通過 |
| 7 | ESLint 通過 | ✅ | 無違例 |
| 8 | 跨平台一致（≥3 種平台組合，含 arm64 與非 Linux） | ⏳ | 本機多 codegen 路徑全部一致；多架構矩陣待 CI 執行 |

**Phase 0 在 §11.8 綠燈後結案。在此之前不開始 Phase 1 的任何實作。**

19% 的戰鬥會進入沿圍欄的穩定漂移環繞而跑滿 60 秒時限。這是設計議題而非效能問題，
已記入 [PHASE1_BACKLOG.md](PHASE1_BACKLOG.md) §15，**不在 Phase 0 實作範圍**。
均勻隨機取樣的 56% 秒速出界則不是缺陷（真人玩家會學會避開），但 Phase 1 的平衡驗證
需要另一個「有效投擲子空間」取樣器，同樣記於 backlog。
