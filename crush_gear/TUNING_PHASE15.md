# Phase 1.5 物理調校 — 基線與流程

設計方將調整**車體尺寸**與**輪胎摩擦係數 μ**。此變更會使 `PHYSICS_VERSION` 由 1 升至 2。

本文件是調校的對照組與操作手冊。**目前尚未變更任何數值** —— 以下全部是 v1 的實測基線。

- 物理規格見 [SPEC.md](SPEC.md) §5–§8
- Phase 0 的調參紀錄見 [TUNING.md](TUNING.md)
- 重跑基線：`npx tsx tools/baseline-report.ts`（人可讀）或 `--json`（可 diff）

---

## 1. v1 基線（`PHYSICS_VERSION = 1`）

量測環境：win32 / x64 / Node 24.14.0 / Rapier 0.19.3
（跨平台矩陣 8/8 全綠，見 [README.md](README.md) 的結案記錄）

### 1.1 參數

| 參數 | v1 值 |
|---|---|
| 輪距 / 軸距 | 0.056 m / 0.070 m |
| 總質量 | 0.15 kg（底盤 0.11 + 前武器 0.04） |
| **輪胎摩擦係數 μ** | **0.30** ← 預計調降 |
| wheelSurfaceSpeed | 4.0 m/s |
| 懸吊 k / c | 300 N/m / 2.0 Ns/m |

### 1.2 單車實測

```
靜態行駛高度        0.02904 m（車體原點）
車體最低點離地      0.01904 m
localCom            (0.000000, 0.002455, 0.017795)
慣量                Ixx 2.3465e-4   Iyy 2.7989e-4   Izz 5.7787e-5  kg·m²
cogHeight           0.03123 m
翻覆臨界 μ          0.897          （現行 μ = 0.30，遠低於臨界）
自由加速 0.5 秒     1.461 m/s      （理論 μ·g·t = 1.472）
阻尼三模態 r        heave 0.5556   pitch 0.6520   roll 0.0955
```

**阻尼三模態是硬性約束**：任何改變輪距、軸距或轉動慣量的調整，都必須重新確認三者 `|r| < 1`
（SPEC.md §6.4）。車體放大會同時改變輪距與慣量，這一項**必然要重算**。

### 1.3 500 場隨機投擲（seed 20260817）

```
勝負          A_WINS 203 / B_WINS 200 / DRAW 97
結束原因      OUT 297 / FLIP 106 / TIMEOUT 97
總幀數        1,067,140
角速度分位    p50 37.0   p90 53.7   p99 71.9   max 84.2      （clamp 400）
質心 y 峰值   0.3483                                          （上限 0.5）
線速度峰值    5.072                                           （clamp 30）
clamp 觸發    線速度 0 · 角速度 0
```

### 1.4 戰鬥長度直方圖

| 幀數區間 | 場次 | 佔比 | 結束原因 |
|---|---|---|---|
| 0–120 | 280 | 56.0% | OUT 252, FLIP 28 |
| 120–300 | 10 | 2.0% | OUT 5, FLIP 5 |
| 300–600 | 9 | 1.8% | OUT 2, FLIP 7 |
| 600–1200 | 18 | 3.6% | OUT 6, FLIP 12 |
| 1200–2400 | 23 | 4.6% | OUT 9, FLIP 14 |
| 2400–3600 | 14 | 2.8% | OUT 6, FLIP 8 |
| 3600–4800 | 22 | 4.4% | OUT 7, FLIP 15 |
| 4800–6000 | 15 | 3.0% | OUT 6, FLIP 9 |
| 6000–7200 | 12 | 2.4% | OUT 4, FLIP 8 |
| **7200（逾時）** | **97** | **19.4%** | TIMEOUT 97 |

**這張表是判讀調校成效的主要依據**，兩端各代表一個已知問題：

- **56% 的 0–120 幀**：均勻取樣的廢投。**不是缺陷** —— 真人玩家會學會避開這塊參數空間。
  但它會稀釋勝率統計，平衡驗證需另建有效子空間取樣器（`PHASE1_BACKLOG.md`）。
- **19.4% 的逾時**：沿弧形圍欄的穩定漂移環繞。**是缺陷** —— 玩家無從避免也無法脫離
  （SPEC.md §15、`PHASE1_BACKLOG.md`）。車體放大**可能自然減輕**此現象，是本次調校要觀察的重點。

### 1.5 判讀時的兩個陷阱

**FLIP 率下降不必然是壞事。** 現有 106 場 FLIP **全部是「撞飛式翻覆」**，
沒有任何一場是實物中最主要的「鏟起式翻覆」——`WEAPON_HULL` 最低點 `y = -0.005`
高於底盤最低點 `y = -0.010`，武器在幾何上碰不到對手車底（`PHASE2_BACKLOG.md` 第 1 項）。
在鏟形武器上線前，FLIP 率只反映撞飛的頻率。

**μ 對環繞的影響方向未知。** 側向摩擦變小可能更易脫離弧線，也可能更難被推出場。
這一項只能實測，不要事先假設方向。

---

## 2. 調參工作流

### 2.1 快循環（每次改參數都跑）

```bash
# 1. 改 src/data/constants.ts
# 2. 重新蓋章 version.ts 的 PHYSICS_CONSTANTS_SHA256
sha256sum src/data/constants.ts

# 3. 物理健全性（clamp、三模態、行駛高度、幾何斷言）
npx vitest run tests/acceptance.test.ts          # 14.0 s

# 4. 統計，與本文件 §1 逐項對照
npx tsx tools/baseline-report.ts                 # 8.8 s

# 5. 看成因（開疊圖，尤其是法向力柱與輪胎力箭頭）
npm run dev                                      # 1.2 s 起動
```

**一輪約 25 秒**（不含看畫面的時間）。

### 2.2 慢循環（選定一組參數後、升版前跑一次）

```bash
npm run check                                    # 170 s
npx tsx tools/verify-platform.ts --compare fixtures/platform/baseline.json   # 2.9 s
```

各步驟實測耗時：

| 步驟 | 耗時 |
|---|---|
| typecheck | 2.3 s |
| lint | 2.2 s |
| `tests/overlay.test.ts` | 0.2 s |
| `tests/replay.test.ts` | 2.9 s |
| `tests/render.test.ts` | 3.7 s |
| `tests/acceptance.test.ts` | 14.0 s |
| **`tests/determinism.test.ts`** | **147.5 s** |
| `tools/baseline-report.ts`（500 場，12 workers） | 8.8 s |
| `verify-platform --compare`（20 fixture） | 2.9 s |
| dev server 起動 | 1.2 s |

`npm run check` 的 170 秒有 **87% 花在決定性測試**上，而決定性與參數值無關 ——
它驗證的是「同一輸入重複執行結果相同」，改 μ 不會動搖這一點。
**因此快循環刻意不跑它**，只在選定參數後跑一次。

### 2.3 調參後會**正常變紅**的測試

以下失敗是預期的訊號，不是壞掉。逐項處理，不要為了讓它變綠而改回參數：

| 測試 | 為何會紅 | 處理 |
|---|---|---|
| `acceptance` → physicsVersion 與 constants 同步 | 常數雜湊變了 | 重新蓋章 `PHYSICS_CONSTANTS_SHA256`；確定要保留這組參數時同時把 `PHYSICS_VERSION` 升到 2 |
| `verify-platform --compare` | 物理變了，checksum 必然全部不同 | **預期** —— 這正是升版要重新產生 baseline 的原因（見 §3） |
| `acceptance` → 角速度統計基線（p90 < 80、peak < 140） | 這是 v1 的實測上界 | 依新實測值更新門檻，並在本文件記錄新舊值 |
| `acceptance` → 穩定產生 FLIP / OUT | 斷言了特定輸入的特定結局 | 依新物理重新挑選 sample battle，或放寬為「reason 屬於預期集合」 |
| `acceptance` → 靜態行駛高度落在 §7 的 y 下界之下 | 車體尺寸改變會動到行駛高度 | **必須連帶重算 §7 的 `y` 下界**（SPEC.md §7 有明文要求） |
| `replay` → sample battle 的結局斷言 | 同上 | 重新產生 `sample_battles/` 並更新 `_comment` 與 README 表格 |
| `render` → 五類結局皆可播放 | 若某個 sample 的結局改變 | 同上 |

**不會紅**（已刻意設計成從常數讀取）：幾何同步測試、疊圖換算測試、決定性測試、
`overlay` 的 `F/N = μ` 測試（μ 由 `TIRE_FRICTION_COEF` 讀入而非寫死）。

### 2.4 硬性約束（改參數時不得違反）

- **三模態 `|r| < 1`** —— 車體放大必然改變 `I_zz` 與輪距，`acceptance` 有自動驗算
- **clamp 觸發次數必須為 0** —— clamp 只攔數值發散，不得參與遊戲（SPEC.md §6.3）
- **`y > 0.5` 不得出現**
- **§7 的 `y` 下界須依新的實測靜態高度重新確認**
- 不得為了讓某項測試變綠而降低 checksum 精度或放寬比對容差

---

## 3. `PHYSICS_VERSION` 升版時的 baseline 歸檔

### 3.1 為何歸檔而非刪除

v1 的 baseline 是**跨平台矩陣的既有證據**。日後若某個平台出現分歧，
必須能回答「這是新引入的，還是 v1 就存在？」——沒有 v1 的 fixture 與 baseline 就無從判斷。

### 3.2 目錄結構

```
fixtures/platform/
  v1/                     ← 歸檔（唯讀，不再更新）
    head_on_01.json … orbit_04.json      20 組 fixture
    baseline.json                         v1 的參考結果
    ARCHIVE.md                            指紋、CI run 連結、歸檔日期
  head_on_01.json … orbit_04.json         現行（v2）
  baseline.json
```

`loadFixtures()` 只讀 `*.json`，子目錄會被自動略過，因此歸檔不會干擾現行組。

### 3.3 歸檔步驟

```bash
# 1. 歸檔 v1（用 git mv 保留檔案歷史）
mkdir -p fixtures/platform/v1
git mv fixtures/platform/*.json fixtures/platform/v1/

# 2. 寫 fixtures/platform/v1/ARCHIVE.md
#    須含：physicsVersion 1、Rapier 0.19.3、wasm SHA-256、CI run 連結、
#          八組平台矩陣結果、歸檔日期

# 3. 以新物理重新產生 v2 的 fixture 與 baseline
#    （fixture 的投擲參數可沿用 v1 的同一組，只有結果會不同；
#      若新物理下某類情境不再出現，才需要重新搜尋）
npx tsx tools/verify-platform.ts --generate --no-dense --out fixtures/platform/baseline.json

# 4. 推送後確認 CI matrix 對 v2 全綠
```

### 3.4 重跑歸檔版

`verify-platform` 已支援 `--fixtures` 指向任意 fixture 目錄
（本階段新增，否則歸檔的 baseline 無法使用）：

```bash
npx tsx tools/verify-platform.ts \
  --fixtures fixtures/platform/v1 \
  --compare  fixtures/platform/v1/baseline.json
```

**注意**：這只在把 `constants.ts` 也還原成 v1 的情況下才會通過。
歸檔的用途是「保留 v1 的證據以供事後比對」，不是「在 v2 的程式碼上重跑 v1」——
後者需要一併 checkout v1 的 commit。

### 3.5 一併需要歸檔或更新的項目

| 項目 | 處置 |
|---|---|
| `fixtures/platform/*.json` + `baseline.json` | 移至 `v1/` |
| `src/data/version.ts` | `PHYSICS_VERSION` 1 → 2，重新蓋章常數雜湊 |
| `sample_battles/*.json` | 重新產生（結局會變），更新 `_comment` |
| `fixtures/benchmark-500.json` | 投擲參數不變，**無須重產**（它只是輸入） |
| `README.md` 結案記錄 | 新增 v2 的平台矩陣結果，保留 v1 那一列 |
| 本文件 §1 | 新增 v2 基線區塊，**保留 v1 區塊作為對照** |
| 既有 replay 檔 | 自動失效 —— `physicsVersion` 不符會拒絕重現（SPEC_PHASE1.md §P1.4.2） |
