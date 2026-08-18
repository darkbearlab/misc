# SPEC — 模擬核心規格(現行版)

**文件版本**:1.3 + Phase 1 §11.6 修訂
**對應 `physicsVersion`**:1
**狀態**:Phase 0 已結案(§11.1–§11.8 全部通過,含跨平台矩陣)

本文件是模擬核心的**唯一有效規格**。v1.0、v1.1 patch、v1.2 patch、v1.3 patch 全部已套用並作廢,不得再作為依據。渲染層規格見 `SPEC_PHASE1.md`。

> **文件維護規則**:本檔案存於 repo 並納入版控。日後所有規格變更以直接修改本檔案 + commit 的方式進行,不再以對話疊加 patch。變更物理相關條款時,必須同步升 `physicsVersion`(見 §17)。

---

## §0 模擬核心的目標

建立**純 headless 的物理模擬核心**,可在 Node.js 執行,模擬結果具備嚴格決定性。

核心成功的定義:同一組輸入參數重複執行 100 次,輸出的 state checksum 陣列完全一致;且該一致性跨 CPU 架構、作業系統與 Node/V8 版本成立。

本文件範圍**不含**:渲染、零件脫落系統、組裝 UI、零件資料庫、AI 對手、賽事模式、存檔、音效。

---

## §1 技術棧(不得替換)

- TypeScript(strict mode)
- `@dimforge/rapier3d-compat`(wasm 版,可在 Node 執行)
- Node.js 20 以上,以 `tsx` 直接執行 TS
- 測試框架:`vitest`

**版本鎖定**:

**影響物理或渲染輸出的相依套件必須以精確版本號指定**(不得使用 `^` 或 `~`)。現行清單:

| 套件 | 版本 | 理由 |
|---|---|---|
| `@dimforge/rapier3d-compat` | `0.19.3` | 決定物理結果;wasm binary 一變即失效 |
| `three` | `0.185.1` | 決定渲染輸出 |
| `@types/three` | `0.185.4` | 須與 three 對應 |
| `vite` | `7.3.6` | vitest 3.2.4 的 vite 相依範圍為 ^5/^6/^7,vite 8 會衝突 |

其餘為純開發工具(eslint、typescript、vitest、tsx 等),不進入任何輸出,允許使用 `^`;
其實際版本由 `package-lock.json` 鎖定。

**`package-lock.json` 必須納入版本控制**——CI 一律以 `npm ci` 安裝(依 lock file 精確還原整棵相依樹,含 transitive 相依)。未提交 lock file 會使 CI 安裝到不同的 wasm binary,§16 的跨平台矩陣將失去意義。

Rapier 版本或 wasm binary 一旦變更,所有既有 replay 檔即失效,且 §16 須全部重跑。

---

## §2 檔案結構與分層

```
src/
  sim/
    world.ts          場地與物理世界建構
    vehicle.ts        車體剛體、懸吊、輪胎力
    tire.ts           輪胎力模型(純函式)
    arena.ts          場地幾何解析(R/L → 出界門檻、圍欄、地板、投擲範圍)
    judge.ts          勝負判定與 stadium 距離函數
    rng.ts            seeded PRNG(xoshiro128**)
    checksum.ts       狀態雜湊(FNV-1a 32-bit)
    simulate.ts       主模擬迴圈,對外唯一入口
    types.ts          共用型別與純向量／四元數運算
  data/
    constants.ts      所有物理常數與場地尺寸
    version.ts        physicsVersion 與 constants 內容雜湊
  replay/             ┐
  render/             ├ 渲染層,規格見 SPEC_PHASE1.md §P1.6
  ui/                 ┘
tools/
  sim.ts              CLI 入口(唯一允許 I/O 的一層)
  pool.ts             批次模擬的 worker pool
  sim-worker.ts       worker 端點
  verify-platform.ts  跨平台決定性驗證
tests/
  determinism.test.ts   §9 決定性 / §11.1 / §9.4 平行化一致性
  acceptance.test.ts    §6 幾何驗證 / §11.2–§11.7
  replay.test.ts        ┐
  render.test.ts        ├ 渲染層,SPEC_PHASE1.md §P1.10
  overlay.test.ts       ┘
fixtures/
  platform/           §16 的 20 組 fixture + 參考 baseline.json
  benchmark-500.json  §11.5a 的基準批次
sample_battles/
index.html            ┐ 渲染層
vite.config.ts        ┘
.github/workflows/
  platform-determinism.yml
```

**分層相依方向**(單向,不得反向):

```
ui → render → replay → sim → data
tools ─────────────────↗
```

`src/sim/` 與 `src/data/` 不得 import `replay/`、`render/`、`ui/` 或任何渲染函式庫,亦不得使用任何瀏覽器 API(`window`、`document`、`performance`、`requestAnimationFrame` 等),不得做任何 I/O(檔案讀寫、主控台輸出一律由 `tools/` 負責)。

此約束以 ESLint 規則強制,並由 `tests/acceptance.test.ts` 的靜態掃描複驗。

---

## §3 全域禁令

違反者視為規格不符:

1. **禁止 `Math.random()`**。所有隨機來源必須經由 `src/sim/rng.ts` 的 seeded PRNG。
2. **禁止 `Date.now()`、`performance.now()` 影響模擬邏輯**。
3. **禁止使用 Rapier 的 `DynamicRayCastVehicleController`**。該控制器內建 anti-slip 與縱橫向分離的摩擦模型,與 §6.4 的物理前提(輪胎恆處滑動狀態)直接衝突。輪胎力必須依 §6.4 自行以 raycast + `applyImpulseAtPoint` 實作。
4. **禁止對動態物體使用 trimesh collider**。所有動態碰撞體一律 convex hull。
5. **禁止可變 timestep**。
6. **禁止在 `sim/` 內做任何 I/O**。
7. **禁止在每幀熱路徑使用精度為實作定義的數學函式**,包括但不限於 `Math.hypot`、`Math.sin`、`Math.cos`、`Math.tan`、`Math.pow`、`Math.exp`、`Math.log`、`Math.cbrt`、`Math.atan2`。
   僅允許 `+ - * /`、`Math.sqrt`、`Math.abs`、`Math.min`、`Math.max`、`Math.round`、`Math.floor`、`Math.trunc`、`Math.sign`。
   建構期(世界佈局、初始姿態計算)不受此限,因其結果不隨幀累積;例外檔案須在 ESLint 設定中逐一列出並說明理由。
   *此禁令的來源見 §16.4。*

---

## §4 座標系與單位

- 右手座標系,**+Y 為上**
- 長度:公尺(m)／質量:公斤(kg)／時間:秒(s)
- 重力:`(0, -9.81, 0)`

**Fixed timestep = 1/120 秒**。模擬迴圈以整數幀計數推進,不依賴實際經過時間。

```ts
world.integrationParameters.dt = 1 / 120;
world.integrationParameters.numSolverIterations = 8;
```

---

## §5 場地

### 5.1 形狀

**Stadium 形**(兩端半圓 + 中央矩形)。

| 參數 | 值 |
|---|---|
| 半圓半徑 R | 0.35 m |
| 中央直線段長度 L(沿 Z) | 0.30 m |
| 戰鬥區整體尺寸 | 0.70 m (X) × 1.00 m (Z) |
| 圍欄高度 / 厚度 | 0.06 m / 0.05 m |
| 地板厚度 | 0.20 m |
| 地板與圍欄 friction | 0.0 |
| 地板與圍欄 restitution | 0.15 |

**尺寸來源說明**:萬代原版場地的官方尺寸無法查證(商品絕版)。以上為依原版形狀特徵設定的合理值,非考據數字。形狀是規格,數值可調。

### 5.2 圍欄建構

圍欄內緣貼合 stadium 輪廓,由 **2 段直線 + 每端 12 段圓弧,共 26 個 Fixed cuboid** 組成。

**直線段(2 段)**
- 中心位於 `x = ±(R + 0.025)` 即 ±0.375
- half-extents `(0.025, 0.03, 0.15)`,涵蓋 `z ∈ [-0.15, 0.15]`

**半圓段(每端 12 段)**
- 每段圓心角 15°,自 `θ = 0°` 起算,涵蓋各端 180°
- 第 i 段中心距圓心 `R + 0.025`,圓心為 `(0, 0, ±0.15)`
- half-extents `(0.025, 0.03, chordHalf)`,其中 `chordHalf = (R + 0.05) · tan(7.5°) × 1.15`
- 繞 Y 軸旋轉對齊切線方向

**1.15 為重疊係數**,確保相鄰段無縫隙。圍欄縫隙會讓車輛卡住或穿出,是此結構的最主要風險。實測 1440 方向 × 4 高度共 5760 條射線,落空 0 次,最大誤差 3.0 mm 且全為外凸(不形成內凹口袋)。

**建構順序固定,不得更動**:直線段(−X、+X)→ +Z 端 12 段(θ 遞增)→ −Z 端 12 段(θ 遞增)。

### 5.3 地板

單一矩形 cuboid,half-extents `(0.45, 0.10, 0.60)`,頂面位於 `y = 0`。

刻意使用矩形而非貼合輪廓:出界以 §8.1 的距離函數判定,地板形狀不影響任何結果。渲染層可繪製 stadium 形地板,物理無須一致。

### 5.4 圍欄高度

刻意低於車體被推撞時的爬升高度。車輛會爬上圍欄並翻出場外,此為預期行為。

### 5.5 地板 friction = 0

刻意設定。所有摩擦力由 §6.4 的輪胎模型提供,避免雙重摩擦來源導致調參時無法判斷力的出處。

---

## §6 車體模型

### 6.1 結構與幾何

車體為**單一 RigidBody 掛載兩個 collider**,反映實物的「矩形底盤(シャーシ)+ 向前延伸的前武器(フロントウェポン)」結構。

此結構直接是零件系統的原型:底盤 = `core`,前武器 = `attack`。

**Collider A — 底盤(chassis)**

`ColliderDesc.cuboid()`:
- half-extents `(0.035, 0.0125, 0.050)`
- 相對車體原點位移 `(0, 0.0025, 0)`
- 佔據範圍 `x ∈ [-0.035, 0.035]`、`y ∈ [-0.010, 0.015]`、`z ∈ [-0.050, 0.050]`
- 質量 **0.11 kg**

**Collider B — 前武器(front weapon)**

```ts
const WEAPON_HULL: [number, number, number][] = [
  // 根部(貼合底盤前緣 z = 0.050)
  [-0.030, -0.005, 0.050],
  [ 0.030, -0.005, 0.050],
  [-0.030,  0.010, 0.050],
  [ 0.030,  0.010, 0.050],
  // 刃口(z = 0.100)
  [-0.004, -0.002, 0.100],
  [ 0.004, -0.002, 0.100],
  [-0.004,  0.006, 0.100],
  [ 0.004,  0.006, 0.100],
];
```
- 質量 **0.04 kg**

**刃口保留 0.008 m 寬度**,不收成單點。退化為尖點的 convex hull 會使碰撞法線計算不穩定。

**尺寸摘要**:總長 0.150 m(底盤 0.100 + 武器 0.050),底盤寬 0.070 m。車體原點位於**底盤幾何中心**,非全車幾何中心。

> **已知缺口**:`WEAPON_HULL` 最低點 `y = -0.005` 高於底盤最低點 `y = -0.010`,武器在幾何上無法接觸對手車底。實物中翻覆的主要機制是貼地鏟形結構插入對手車底掀起,現有模型無法呈現。詳見 `PHASE2_BACKLOG.md`。

### 6.2 質量、重心與慣量

**三者全部由幾何與質量分配衍生,不得人為指定任何一項。**

實作方式:對兩個 collider 分別以 `ColliderDesc.setMass()` 指定質量,其餘交給 Rapier 合成。

**禁止使用 `RigidBodyDesc.setAdditionalMassProperties()`** —— 其語意為疊加而非覆寫,無法在保持總質量的前提下指定絕對重心。

實測合成結果:
```
mass      0.150000 kg
localCom  (0.000000, 0.002455, 0.017795)
inertia   Ixx = 2.3465e-4  Iyy = 2.7989e-4  Izz = 5.7787e-5  kg·m²
主慣量軸相對車體軸偏 0.10°
```

### 6.3 剛體屬性

| 參數 | 值 |
|---|---|
| collider friction | **0.0**(所有摩擦由輪胎模型提供) |
| collider restitution | 0.25 |
| CCD | 啟用 |
| 線速度上限 | 30 m/s(每幀 clamp) |
| 角速度上限 | **400 rad/s**(每幀 clamp) |

**clamp 的角色**:clamp 只負責攔截數值發散,**不得參與遊戲**。clamp 只要在正常遊戲中觸發過一次,它就從保險絲變成了遊戲規則,代表該次碰撞結果被人為修改。

上限值應設於真實物理峰值的 4 倍以上。實測角速度峰值 84.2 rad/s(500 場),400 提供 4.8 倍餘裕,clamp 觸發 0 次。400 rad/s ≈ 64 轉/秒,達此值已明確屬數值異常。

統計基線的迴歸偵測由 `tests/acceptance.test.ts` 負責。**clamp 抓發散、統計基線抓迴歸,兩者不得混用。**

### 6.4 懸吊與輪子

**輪子不建立獨立剛體。** 每台車 4 個輪位,以 raycast + 彈簧懸吊實作。

```ts
const WHEEL_ANCHORS: [number, number, number][] = [
  [-0.028, -0.005,  0.035],  // 左前
  [ 0.028, -0.005,  0.035],  // 右前
  [-0.028, -0.005, -0.035],  // 左後
  [ 0.028, -0.005, -0.035],  // 右後
];
```

輪距 0.056 m,軸距 0.070 m。矩形佈局(左右對稱、前後同寬),反映實物的矩形底盤。

**兩項幾何條件須以 assertion 驗證**:
1. 所有錨點在底盤 collider 的水平投影內(`|x| = 0.028 < 0.035`、`|z| = 0.035 < 0.050`)
2. 錨點高度 `y = -0.005` **嚴格高於**車體 hull 最低點 `y = -0.010`

| 懸吊參數 | 值 |
|---|---|
| restLength | 0.025 m |
| maxTravel | 0.020 m |
| stiffness (k) | 300 N/m |
| damping (c) | 2.0 Ns/m |

**懸吊力計算(每輪每幀)**:
```
1. 自 anchor 沿車體 -Y 方向 raycast(solid = true),最大距離 = restLength + maxTravel
2. 若無命中,或命中法線與懸吊上方向的內積 ≤ 0 → 該輪離地,N = 0,跳過輪胎力
3. 命中距離 d,壓縮量 compression = restLength - d
4. v_susp = 接觸點沿懸吊方向的速度分量,以車體 +Y 為正
5. N = k * compression - c * v_susp
6. N < 0 時 clamp 為 0(懸吊不得產生拉力)
7. 沿命中法線方向施加大小為 N 的力於接觸點
```

**k = 300 的理由**:實物並無懸吊,輪軸直接固定於底盤。此處的彈簧不是模擬避震,而純粹是取得法向力 N 的數值手段,因此應在數值穩定的前提下**盡可能硬,以趨近剛性接觸**。靜態壓縮約 1.2 mm(四輪並聯等效 1200 N/m)。k = 300 時 roll 模態的 `ω_n·dt ≈ 1.06`,接近顯式積分的穩定邊界,大致即為此架構的上限。

> **技術債**:若需更硬的接觸,正解是導入 substep 或改用 Rapier 原生接觸取代 raycast 懸吊,**不得繼續調高 k**。見 `PHASE1_BACKLOG.md` T1。

**c = 2.0 的理由**:顯式積分的穩定性由**轉動模態**而非 heave 模態決定。顯式阻尼的每幀速度衰減比為 `r = 1 − c·K`,`K = n · c_lever² · dt / I_eff`。現行幾何下:

| 模態 | K | r (c = 2.0) | 穩定上限 |
|---|---|---|---|
| heave | 0.2222 | 0.5556 | c < 9.00 |
| pitch | 0.1740 | 0.6520 | c < 11.49 |
| roll | 0.4522 | 0.0955 | c < 4.42 |

**任何變更輪距、軸距或轉動慣量的修改,都必須重算三個模態並確認 `|r| < 1`。** 此驗算已納入 `tests/acceptance.test.ts`。

### 6.5 輪胎力模型(核心)

**物理前提**:戰鬥車輪胎接地面積極小、轉速極高,恆處於滑動摩擦狀態。因此:

- 摩擦力永遠處於 Coulomb 飽和上限 `F = μN`,**與馬達扭力無關**
- 摩擦力**各向同性**,不區分縱向與橫向
- 不存在線性抓地區,**不需要任何輪胎模型(Pacejka 等)**
- 輪子負載對轉速影響可忽略,**角速度 ω 視為常數**,不模擬扭力-轉速曲線

馬達性能抽象為單一參數:輪面線速度 `wheelSurfaceSpeed = ω · r`。

**每輪每幀計算**(純函式,`src/sim/tire.ts`):
```
輸入:接觸點世界座標 p、法向力 N、車體剛體、車體前向量 forward(世界)、接觸法線 n

1. v_contact = 車體在 p 點的世界速度
2. v_contact_tangent = v_contact - (v_contact · n) n
3. forward_tangent = normalize(forward - (forward · n) n)
   若投影長度趨近 0(車頭直接頂入地面或圍欄)→ v_drive = 0,跳至步驟 5
4. v_drive = forward_tangent * wheelSurfaceSpeed
5. v_slip = v_contact_tangent - v_drive
6. 若 |v_slip| < 1e-6 → 力為 0
7. F = -μ * N * normalize(v_slip)
8. 以 applyImpulseAtPoint(F * dt, p) 施加
```

| 輪胎參數 | 值 |
|---|---|
| wheelSurfaceSpeed | 4.0 m/s |
| frictionCoef (μ) | 0.30 |

**預期湧現行為**(若模擬正確,以下應自然發生,**不得以額外程式碼偽造**):

- 車輛不沿車頭方向直線行進,慣性主導、明顯漂移
- 被撞擊後長時間自轉打滑
- 加速度上限約 `μg ≈ 2.9 m/s²`(實測自由加速 0.5 秒達 1.461 m/s,理論 1.472)
- 翻覆臨界 `μ > trackWidth / (2 · cogHeight)`,實測 **0.897**(cogHeight 0.03123 m)

μ = 0.30 遠低於翻覆臨界,因此不會單靠橫向摩擦自行翻覆;現有翻覆全部來自碰撞衝量。

**若車輛行為顯得不順,正確做法是調 μ 與 `wheelSurfaceSpeed`,不得加入轉向輔助、角速度阻尼或任何額外程式碼。**

---

## §7 投擲參數

玩家唯一的操作面。兩車同時於第 0 幀投入。

```ts
type ThrowParams = {
  x: number;      // 投入點 X
  z: number;      // 投入點 Z
  y: number;      // 投入高度
  yaw: number;    // 車頭朝向,繞世界 +Y 軸
  pitch: number;  // 俯仰角,正值為機首上仰(繞車體 +X 軸的 −pitch 旋轉)
  speed: number;  // 初速大小,方向由 yaw 與 pitch 決定
  spin: number;   // 初始角速度,繞世界 +Y 軸
};
```

| 參數 | 合法範圍 |
|---|---|
| `x` / `z` | `stadiumDistance(x, z) ≤ R − (VEHICLE_MAX_RADIUS + 0.02)`(見下方 7.1) |
| `y` | `[0.030, 0.15]` |
| `yaw` | `[0, 2π)` |
| `pitch` | `[-0.3, 0.3]` |
| `speed` | `[0, 5.0]` m/s |
| `spin` | `[-20, 20]` rad/s |

**超出範圍必須在模擬開始前拋出錯誤,不得靜默 clamp。**

`y` 的下界 0.030 恰為**懸吊零壓縮**高度(錨點 −0.005 + restLength 0.025)。低於此值車體會生成在懸吊壓縮狀態並被彈起,屬數值產物而非「投得貼地」。實測靜態行駛高度 0.02904 m。

**變更懸吊參數或輪位高度時,`y` 下界必須依實測靜態高度重新確認。**

### 7.1 投擲餘裕與車長掛鉤

投擲點的合法範圍不是獨立常數,而是由車體尺寸推導:

```
stadiumDistance(x, z) ≤ R − (VEHICLE_MAX_RADIUS + THROW_CLEARANCE)
```

| 項 | 意義 | 現行值 |
|---|---|---|
| `R` | stadium 半徑 | 0.35 m |
| `VEHICLE_MAX_RADIUS` | 車體原點至最遠幾何點的**水平**距離 | 0.100080 m |
| `THROW_CLEARANCE` | 車體最遠點與圍欄內緣之間保留的淨空 | 0.02 m |
| 餘裕合計 | | 0.120080 m |

`VEHICLE_MAX_RADIUS` **由車體常數衍生,不得硬編**(`src/sim/arena.ts`):
取 `CHASSIS_HALF_EXTENTS` 四個角與 `WEAPON_HULL` 全部頂點的 XZ 座標,取最大模長。
現行最遠點為前武器刃口 (±0.004, 0.100);底盤最遠角僅 0.0611 m。
取**水平**距離而非 3D 距離:圍欄是垂直牆面,能否穿入只取決於 XZ 平面上的伸出量。

**為何掛鉤**:舊規則的固定餘裕 0.08 m 小於車體最大半徑 0.10008 m,因此投在邊界上的車,
刃口會生成在圍欄內部約 20 mm 深處,由碰撞解算彈開 —— 這是數值產物,不是玩家投出來的結果。
穿入深度 `(R − 0.08) + 0.10008 − R = 0.02008` **與 R 無關**,任何場地尺寸下都存在。

**場地與車體尺寸的連動集中在 `src/sim/arena.ts` 單一處**:車體放大時投擲餘裕自動跟著變大,
不需要(也不允許)另外維護一個手算的常數。

**升版要求**:此規則改變投擲取樣的合法區域,因此改變相同 seed 下產生的輸入分布。
正式採用時 `PHYSICS_VERSION` 必須升版,並重新產生 §16 的跨平台 fixture 與 `sample_battles`。
在此之前,實作以 `PhysicsOverride.vehicleDerivedThrowMargin` 旗標明示開啟,預設仍為
`PHYSICS_VERSION = 1` 凍結的固定值 0.08 m —— 直接切換會使既有 20 組 fixture 中的 14 個
投擲點變為不合法,v1 的 baseline 將無法驗證。

### 7.2 兩車初始分離

兩車投擲點的**水平**距離必須滿足:

```
dist(throwA, throwB) = sqrt((xA − xB)² + (zA − zB)²) ≥ 2 × VEHICLE_MAX_RADIUS + 0.005
```

| 項 | 意義 | 現行值 |
|---|---|---|
| `2 × VEHICLE_MAX_RADIUS` | 兩車保守外接圓相切所需的中心距 | 0.200160 m |
| 容差 | | 0.005 m |
| 最小距離合計 | | **0.205160 m** |

`VEHICLE_MAX_RADIUS` 由車體常數衍生(見 §7.1),因此本約束**不得硬編**,
實作集中於 `src/sim/arena.ts` 的 `minThrowSeparation()`。

**違反者於模擬開始前拋出錯誤**,與 §7.1 的範圍檢查同層級,不得靜默調整。

**以幾何判定,不做碰撞體重疊檢測。** 後者需要先建立世界才能判斷,
會破壞「參數驗證先於模擬」的分層。保守外接圓已足以保證不重疊,多出的 5 mm 是容差。
代價是偏保守:兩車尾對尾時實際只需約 0.10 m 就不會重疊,但仍會被此規則拒絕。

**距離只取 XZ**,不含 y。兩車可以投在不同高度,但那不構成「分離」—— 落地後仍會重疊。

#### 取樣器要求

隨機取樣器須以**拒絕取樣**滿足此約束。
**若某場地尺寸下拒絕率超過 50%,視為該尺寸無法容納合法對戰,回報為不可用。**

#### 為何需要此約束

無此約束時,兩車獨立取樣會有一定比例落在彼此內部,由解算器以巨大排斥脈衝彈開 ——
那不是玩家投出來的結果,是數值產物。實測(`TUNING_PHASE15.md` §1.7,每組 200 場):
基線 R=0.35 為 4.5%,隨場地縮小升至 R=0.175 的 33.0%,最深穿插逾 40 mm。

#### 升版要求

與 §7.1 的餘裕變更同屬**取樣規則變更**,改變相同 seed 下產生的輸入分布。
正式採用時 `PHYSICS_VERSION` 一併升至 2,並重新產生 §16 的跨平台 fixture 與 `sample_battles`。
在此之前,實作以 `PhysicsOverride.enforceMinThrowSeparation` 旗標明示開啟,預設不檢查 ——
v1 的 20 組 fixture 中有投擲點違反此約束,直接啟用會使 baseline 無法驗證。

---

## §8 勝負判定

`src/sim/judge.ts` 每幀檢查,優先序 OUT → FLIP → TIMEOUT。

### 8.1 出界(OUT)

```ts
const HALF_SEGMENT = 0.15;   // L / 2
const FIELD_RADIUS = 0.35;   // R
const OUT_THRESHOLD = 0.45;  // 圍欄外緣 0.40 + 餘裕 0.05

function stadiumDistance(x: number, z: number): number {
  const dz = Math.max(-HALF_SEGMENT, Math.min(HALF_SEGMENT, z));
  const dzz = z - dz;
  return Math.sqrt(x * x + dzz * dzz);   // 刻意不用 Math.hypot,見 §3 禁令 7 與 §16.4
}
```

質心滿足任一條件即判定:
- `stadiumDistance(cx, cz) > OUT_THRESHOLD`
- `cy < -0.10`

### 8.2 翻覆(FLIP)

車體 up vector(局部 +Y 經旋轉後的世界向量)與世界 +Y 的內積 `< 0`,**且持續 60 幀(0.5 秒)**。

計數器在條件不滿足時歸零。此延遲用於避免碰撞瞬間的短暫翻滾被誤判。

### 8.3 時限(TIMEOUT)

達 7200 幀(60 秒)仍無勝負,判定為 `DRAW`。

**時限是遊戲規則,不得以效能為由變更。** 實測 49 場(9.8%)落在 3600–7200 幀,砍半會將這些真實分出勝負的戰鬥誤判為平手。

### 8.4 同幀雙方觸發

雙方於同一幀滿足敗北條件時判定為 `DRAW`;`reason` 取優先序較高者,即只要任一方為 OUT 即記為 OUT。

---

## §9 決定性要求

### 9.1 隨機源

`src/sim/rng.ts` 實作 **xoshiro128\***\*,全程以 32-bit 整數運算推進,不得以浮點運算產生亂數狀態。

```ts
class Rng {
  constructor(seed: number);
  nextU32(): number;
  nextFloat(): number;  // [0, 1)
}
```

模擬本身目前不使用亂數,但 RNG 必須建立並納入 checksum,確保未來引入時架構已就緒。

### 9.2 Checksum

**量化規則**:浮點數不得直接雜湊,一律先量化:
```ts
function quantize(v: number): number {
  return Math.round(v * 1e6) | 0;
}
```

雜湊涵蓋範圍,依固定順序:
- 車 A 的質心位置 (x,y,z)、旋轉四元數 (x,y,z,w)、線速度 (x,y,z)、角速度 (x,y,z)
- 車 B 同上
- RNG 內部狀態的 4 個 u32

演算法:**FNV-1a 32-bit**。

取樣頻率:每 60 幀一次,加上結束幀必記一次。(`verify-platform --generate` 另提供逐幀 dense 模式,用於定位分歧幀號。)

**禁止為了讓比對通過而降低量化精度或放寬容差。** 混沌系統中,降低精度只會掩蓋分歧而非消除它。

### 9.3 順序決定性

- **剛體建立順序固定**:地板 → 圍欄直線段(−X、+X)→ +Z 端 12 段弧(θ 遞增)→ −Z 端 12 段弧(θ 遞增)→ 車 A(底盤 → 前武器)→ 車 B
- **力的施加順序固定**:車 A 的 4 個輪位(依 `WHEEL_ANCHORS` 順序)→ 車 B 的 4 個輪位;每輪先施加懸吊力再施加輪胎力
- 不得使用依賴迭代順序不確定的資料結構(如以物件鍵值順序遍歷)

### 9.4 平行執行的決定性

批次模擬允許以 `worker_threads` 平行執行,但:

- **每場戰鬥完整地在單一 worker 內序列完成**,不得跨 worker 拆分
- 結果輸出順序必須與輸入順序一致,不受 worker 完成順序影響
- Rapier wasm 模組在每個 worker 內獨立初始化
- `--workers 1` 與 `--workers N` 的輸出必須位元相同,此項納入 `tests/determinism.test.ts`

---

## §10 CLI 介面

```bash
# 單場
npx tsx tools/sim.ts --input battle.json

# 決定性驗證
npx tsx tools/sim.ts --input battle.json --repeat 100 --verify

# 批次(worker pool)
npx tsx tools/sim.ts --batch fixtures/benchmark-500.json --out results.csv

# 跨平台驗證
npx tsx tools/verify-platform.ts --generate --out baseline.json
npx tsx tools/verify-platform.ts --compare baseline.json
npx tsx tools/verify-platform.ts --dump <fixtureId> --frame <n>
```

| 選項 | 說明 |
|---|---|
| `--workers N` | worker 數量,預設 `os.availableParallelism()` |
| `--workers 1` | in-process 序列執行,額外輸出 µs/car-frame(§11.5b) |
| `--out FILE` | CSV 寫入 FILE,直方圖同時寫入 `FILE.histogram.json` |
| `--no-dense` | `verify-platform --generate` 關閉逐幀 checksum |

單場輸出(stdout,JSON):
```json
{ "result": "A_WINS", "reason": "OUT", "frames": 505, "checksums": [...] }
```

**批次模式必須輸出戰鬥長度直方圖**(常態輸出,非一次性分析),分桶:
`0-120, 120-300, 300-600, 600-1200, 1200-2400, 2400-3600, 3600-4800, 4800-6000, 6000-7200, 7200(逾時)`

每桶記錄場次數與結束原因分佈。此數據是調整時限、場地形狀與物理參數的必要依據。

彙總統計與直方圖印至 stderr,不得污染 CSV。

---

## §11 驗收條件

1. **決定性**:任一組輸入,連續執行 100 次 checksum 陣列完全一致。至少涵蓋 10 組不同投擲參數(含高速對撞、擦邊、原地自轉、長場次環繞)。

2. **無爆飛**:500 組隨機合法投擲,不得出現任何一幀車體 `y > 0.5`,**線速度與角速度的 clamp 觸發次數必須為 0**。若觸及,視為物理設定錯誤;修正方向依 §6.3 的 clamp 角色判斷。

3. **翻覆可觸發**:存在投擲參數能穩定產生 FLIP。

4. **出界可觸發**:存在投擲參數能穩定產生 OUT。

5. **效能**(拆分為兩項獨立指標,不得混用):
   - **5a 批次吞吐**:500 場隨機合法投擲於 **30 秒**內完成,允許 `worker_threads` 平行執行。
   - **5b 單場成本**:單執行緒模式下每 car-frame 平均模擬成本 ≤ **50 µs**。

   *拆分理由:總時間同時受每幀成本與總幀數影響,而總幀數是物理與遊戲規則的產物,不應由效能條件反向約束。工程門檻應以工程手段解決,不得藉由變更遊戲規則或物理參數達成。*

6. **渲染邊界**:`src/sim/`、`src/data/`、`src/replay/`、`tools/` 不得出現任何渲染 API,亦不得 import three 或其他渲染函式庫。僅 `src/render/`、`src/ui/` 允許使用渲染 API。此邊界由 ESLint 強制並由靜態掃描複驗。
   *修訂來源:Phase 1 引入 three.js。原條文「全專案不含任何渲染相關依賴或程式碼」作廢。*

7. **ESLint 通過**:§2 分層與 §3 全域禁令的規則無違例。

8. **跨平台一致**:同一套 fixture 於至少三種平台組合(須含一組 arm64、一組非 Linux)執行,所有 checksum 陣列完全一致。環境指紋差異記錄於 `README.md`。

### 結案記錄(Phase 0)

| 欄位 | 值 |
|---|---|
| Rapier 版本 | `@dimforge/rapier3d-compat@0.19.3` |
| wasm SHA-256 | `1ce1c8c4036b4dcd3bde86c6efdb0f270cf5e274979b1de6ab8052947ef166c5` |
| wasm 使用 SIMD | 否 |
| Fixture | 20 組 / 44,802 幀 |
| 平台矩陣 | ubuntu × Node 20/22 (x64)、macos × Node 20/22 (arm64)、windows × Node 20/22 (x64) 全綠 |

**跨平台一致性已驗證成立** —— seed + 投擲參數足以在任何平台重現一場戰鬥,線上對戰無須改為錄製回放。

---

## §12 交付物

- 完整原始碼
- `README.md`:安裝、執行方式、結案記錄
- `TUNING.md`:若修改 §5、§6 的任何初始值,須說明原因與最終值
- `PHASE1_BACKLOG.md` / `PHASE2_BACKLOG.md`:已確認但延後的設計議題
- `sample_battles/`:至少 5 組展示不同結局的輸入檔
- `fixtures/platform/`:20 組跨平台 fixture 與參考 baseline

---

## §13 遇到規格衝突時

若發現本規格內部矛盾、或某參數在物理上不可行,**停止並提出問題,不得自行決定替代方案**。

特別是涉及 §6.5 輪胎力模型、§9 決定性要求的部分,任何偏離都必須經過確認。

**渲染需求、除錯需求與效能門檻,均不具備修改物理的資格。** 若某項需求看似需要修改 `src/sim/` 的計算方式,一律停止並提出。

---

## §14 補充定義

以下為實作過程中補上、已納入正式規格的行為定義:

**14.1 輪面驅動方向退化** — `forward` 在接觸平面的投影長度趨近 0 時,令 `v_drive = 0`,仍施加純滑動摩擦力。

**14.2 懸吊速度符號** — `v_susp` 以車體 +Y 為正。車體下沉時 `v_susp < 0`,使阻尼項增大 N、抵抗壓縮。

**14.3 退化 raycast 命中** — 命中法線與懸吊上方向的內積 ≤ 0 時視同該輪離地,穿透交由 collider 處理。爬圍欄時法線為水平,內積仍為正,不受影響。
*來源:Rapier 對 `solid = true` 的射線,若起點已在 collider 內部,回傳 `toi = 0` 且法線為零向量,照公式硬算會產生憑空的側向力。*

**14.4 懸吊 raycast 使用 `solid = true`** — 配合 14.3 的退化處理。

**14.5 暖機 step** — 場地建構完成、車輛尚未建立時呼叫一次 `world.step()`,以建立 broad-phase BVH,避免第 0 幀 raycast 全部落空。此時世界僅含 Fixed 剛體,物理上為 no-op,不影響決定性。

**14.6 pitch 符號** — 正值為機首上仰(繞車體 +X 軸的 `−pitch` 旋轉)。

**14.7 同幀混合條件** — 見 §8.4。

**14.8 質量指定方式** — 使用 `ColliderDesc.setMass()` 於各 collider 分別指定。見 §6.2。

---

## §15 已知的設計議題

以下為已確認、但不在模擬核心規格範圍內的議題,詳見對應 backlog:

- **極限環繞**:19% 的戰鬥雙方沿弧形圍欄進入穩定漂移環繞,60 秒不脫離。成因為模型缺乏轉向與偏航阻尼,配合光滑凸邊界形成極限環。`PHASE1_BACKLOG.md` §15。
- **鏟形前武器缺口**:現有 FLIP 全為撞飛式,無鏟起式。`PHASE2_BACKLOG.md`。
- **投擲參數取樣分布**:均勻取樣有 56% 為秒速出界的廢投,平衡驗證須改用有效子空間取樣。`PHASE1_BACKLOG.md`。

---

## §16 跨平台決定性

### 16.1 為何是硬性要求

線上架構(以 seed + 投擲參數取代連線同步)完全建立在跨平台一致性之上。剛體碰撞是混沌系統,`1e-15` 的浮點差異在數百幀後會演變為完全不同的勝負。

### 16.2 驗證套件

`tools/verify-platform.ts` 與 `fixtures/platform/`,至少 20 組 fixture,涵蓋高速正面對撞、擦邊碰撞、沿圍欄長時間環繞、早期出界、早期翻覆。

環境指紋須記錄以下欄位:

| 欄位 | 意義 |
|---|---|
| `nodeVersion` / `v8Version` | 執行環境版本 |
| `platform` / `arch` / `cpuModel` | 作業系統與 CPU |
| `rapierVersion` | package.json 中鎖定的版本號 |
| `wasmSimdSupported` | **runtime** 是否支援 wasm SIMD |
| `rapierWasmUsesSimd` | **該 wasm build 本身**是否用到 SIMD —— 這才是會造成分歧的那一項 |
| `rapierWasmSha256` | wasm 檔雜湊,確保比對雙方跑的是同一份二進位 |
| `jsMathFingerprint` | JS 超越函式的位元指紋;兩平台僅此項不同即可直接歸咎於 JS 數學函式庫而非 Rapier |
| `hypotMatchesSqrt` | `Math.hypot(a,b)` 是否與 `Math.sqrt(a*a+b*b)` 位元相同。保留此欄位作為日後有人重新引入 `Math.hypot` 的迴歸偵測(見 §3 禁令 7) |

`--compare` 於分歧時須輸出:首次分歧的確切幀號、分歧前最後一次相符的 checksum、分歧幀前後雙方的完整狀態、兩份環境指紋的差異欄位。

### 16.3 CI matrix

`.github/workflows/platform-determinism.yml` 必須位於 **repo 根目錄**——GitHub Actions 只讀取根目錄的 `.github/workflows/`,子目錄中的 workflow 完全不會載入,推上去不會有任何 job,極易誤以為 CI 綠燈。

若專案位於子目錄,`defaults.run.working-directory` 只作用於 `run:` 步驟;`uses:` 步驟的 path 仍相對於 workspace 根目錄,artifact 路徑必須明寫子目錄前綴。

CI 狀態須以 run 層級的 `completed/success` 為準,不得採信執行中途的 job 快照。

### 16.4 支持一致性的結構性事實

- **Rapier 的 wasm 不 import 任何 JS 數學函式**,浮點運算全部編譯在 wasm 內。WebAssembly 規範要求 f32/f64 運算位元精確(IEEE-754、round-to-nearest-even、無延伸精度、無 FMA 合併)。此為跨平台一致性的主要依據。
- **該 wasm build 不使用 SIMD**(type section 內無 v128)。SIMD 與純量路徑的浮點結果不保證位元一致,且是否啟用取決於 runtime 偵測。CI 有一道檢查會在 Rapier 換成 SIMD build 時失敗。
- **JS 端每幀熱路徑不含任何精度為實作定義的運算**,由 §3 禁令 7 強制。

### 16.5 分歧時的處理

**立即停止並提出報告,不得自行決定補救方案。** 首要嫌疑順序:
1. 安裝到不同的 wasm binary(比對 SHA-256)
2. JS 端殘留的實作定義函式(§3 禁令 7 的 ESLint 規則應已排除)
3. Rapier 內部的平台相依路徑

---

## §17 物理版本化

`src/data/version.ts` 維護 `PHYSICS_VERSION`,單調遞增整數。**Phase 0 結案狀態為 1。**

### 必須升版的情形

- `src/data/constants.ts` 中任何影響物理的數值變更
- `src/sim/` 中影響計算結果的邏輯變更(含力的施加順序)
- Rapier 版本或 wasm binary 變更
- §8 判定條件變更(含門檻值)

### 不需升版

純渲染層變更、CLI 介面變更、註解與文件、關閉狀態的診斷輸出。

### 配套要求

- `version.ts` 同時記錄 `constants.ts` 的內容雜湊;雜湊改變而版本未升時,`tests/acceptance.test.ts` 須失敗以提醒
- 升版時,全部 fixture 與 checksum baseline 須重新產生,舊版**歸檔保留**而非刪除
- replay 檔的相容性檢查見 `SPEC_PHASE1.md` §P1.4
