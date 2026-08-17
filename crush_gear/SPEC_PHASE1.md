# SPEC — Phase 1 渲染與 Replay 播放器(現行版)

**文件版本**:Phase 1 + Patch 1
**狀態**:P1-a / P1-b / P1-c / P1-d 全部完成

本文件是渲染層的**唯一有效規格**。原 `SPEC_phase1.md` 與 `SPEC_phase1_patch1.md` 已套用並作廢。模擬核心規格見 `SPEC.md`。

**`SPEC.md` 的全部條款在本階段完全有效**,不因引入渲染而放寬。

> **文件維護規則**:本檔案存於 repo 並納入版控。日後變更以直接修改本檔案 + commit 的方式進行。

---

## §P1.0 已拍板的設計決策

**1. 渲染採 three.js(3D),不使用 2D canvas**

早期曾建議 2D + 偽翻覆判定,該建議**作廢**。其理由是「3D 物理的調參成本高」,而物理凍結後渲染層不調任何物理參數,該成本不存在。反之,FLIP 佔結局的 21%,2D 無法表現翻覆;且軌跡資料本就含四元數,2D 渲染反而要丟棄資訊。

**2. 版本化機制於 Phase 1 建立,不延後**

物理模型日後變更將使全部 fixture 與 baseline 失效。版本欄位事前加入的成本是數個欄位,事後補加須回頭處理所有已存的 replay 檔。

---

## §P1.1 目標與非目標

### 目標

replay 播放器:輸入 `{seed, throwA, throwB}`,以 `sim/` 產生完整軌跡,再以 three.js 播放。

其首要價值不是功能而是**觀察**——物理調校與極限環繞的修正方案含有純觀感參數,盲調無法收斂,必須先有眼睛。

### 非目標(不得實作)

- 極限環繞的修正機構(改變物理模型,將使全部 baseline 失效)
- 有效投擲子空間取樣器
- 技術債 T1(substep)、T3(Rapier 計時器)
- 組裝 UI、零件系統、AI 對手、賽事模式、音效
- 即時互動操作(投擲參數在播放中不可變更)

---

## §P1.2 架構:軌跡產生與播放完全分離

### P1.2.1 核心約束

**播放器不執行物理模擬。** 流程嚴格分為兩段:

```
1. 產生:sim/simulate.ts 跑完整場戰鬥 → Trajectory 物件
2. 播放:renderer 讀取 Trajectory → 繪製
```

渲染層不得呼叫 `world.step()`、不得持有 Rapier 世界、不得依 `requestAnimationFrame` 的 delta 推進任何物理狀態。

此分離不是效能考量,而是**結構性保證**:渲染在架構上不可能影響物理結果,因此 `SPEC.md` 的決定性驗證無須因引入渲染而重做。

### P1.2.2 `src/sim/` 的變更限制

**`src/sim/` 與 `src/data/` 原則上不得修改**,驗收時須以 `git diff` 證明。

唯一允許的例外是**可選診斷輸出**,且須滿足全部四項:

1. 以旗標開啟,預設關閉
2. 關閉時的執行路徑與變更前位元完全相同
3. 診斷資料不進入 checksum
4. 不改變任何力的施加順序或計算順序

新增診斷輸出後,必須重跑 `tests/determinism.test.ts` 與 `verify-platform --compare`,確認 20 組 fixture 的 checksum 未變。**任一組改變即須撤回該診斷輸出。**

診斷寫入必須是既有計算結果的**旁路寫入**,不得為了記錄而重新計算或調整計算順序;緩衝區須在迴圈外一次配置。

---

## §P1.3 軌跡資料格式

```ts
type Trajectory = {
  meta: TrajectoryMeta;
  frameCount: number;          // 含第 0 幀
  position: Float32Array[];    // 每車一組,索引 0 = A,1 = B;長度 frameCount * 3
  rotation: Float32Array[];    // 長度 frameCount * 4(四元數 x,y,z,w)
  diagnostics?: TrajectoryDiagnostics;
  outcome: { result: Result; reason: Reason; frames: number };
};
```

### 軌跡使用 f32 是刻意的

軌跡是**顯示用資料**,不回饋模擬。模擬全程以 f64 進行,checksum 依 `SPEC.md` §9.2 由 f64 狀態量化後計算,兩者不共用。

f32 可將 7200 幀雙車的軌跡壓在約 400 KB,顯示精度遠超螢幕像素解析度。

**明確警告**:不得以軌跡資料重建模擬狀態,或以軌跡 f32 值進行任何判定。判定結果由 `outcome` 攜帶,已在模擬階段以 f64 決定。

實測資料量:軌跡 394 KB、診斷 1.68 MB。無須分塊或串流。

---

## §P1.4 版本化與相容性

### P1.4.1 `TrajectoryMeta`

```ts
type TrajectoryMeta = {
  physicsVersion: number;      // 見 SPEC.md §17
  specVersion: string;
  rapierVersion: string;
  wasmSha256: string;
  seed: number;
  throwA: ThrowParams;
  throwB: ThrowParams;
  generatedAt: string;         // ISO 8601,僅供人閱讀,不參與任何判定
};
```

### P1.4.2 replay 檔的相容性檢查

replay 檔僅儲存 `TrajectoryMeta`(不含軌跡本身,實測 < 2 KB),播放時以其中的 `seed` 與投擲參數重新產生軌跡。

載入時比對 `physicsVersion`、`rapierVersion`、`wasmSha256`:

- **全部相符** → 重新產生軌跡並播放
- **任一不符** → **拒絕重新產生**,拋出 `IncompatibleReplayError`,顯示明確訊息說明該 replay 由不同版本的物理產生。**不得靜默播放不同的結果。**

「以不同版本重跑並顯示不同結局」是本專案最嚴重的失效模式之一——它讓使用者相信自己看到的是原本那場戰鬥。寧可拒絕播放。

---

## §P1.5 可選診斷輸出

```ts
type TrajectoryDiagnostics = {
  wheelGrounded: Uint8Array[];      // frameCount * 4
  normalForce: Float32Array[];      // frameCount * 4
  tireForce: Float32Array[];        // frameCount * 4 * 3(世界座標向量)
  contactPoint: Float32Array[];     // frameCount * 4 * 3
  stadiumDist: Float32Array[];      // frameCount
  flipCounter: Uint16Array[];       // frameCount
  localCenterOfMass: Vec3[];        // 每車一組常數;Rapier 合成值,無法由常數推導
};
```

`localCenterOfMass` 是**整場固定**的單一向量而非逐幀陣列,因此以 `Vec3`(`{x,y,z}`)儲存而非 typed array。
軌跡中的 `position` 是**剛體原點**,質心 = `position + rotation · localCenterOfMass`。

啟用方式:`simulate(input, { diagnostics: true })`,預設 `false`。受 §P1.2.2 的四項條件約束。

播放器一律附帶診斷:輪子的懸吊位置需要接觸點才畫得正確,且實測開啟診斷不增加產生時間。

---

## §P1.6 技術棧與檔案結構

```
src/
  sim/       物理模擬(不得 import replay / render / ui / three)
  data/      常數與版本(同上)
  replay/    meta 組裝、序列化、相容性檢查(純資料,不做 I/O、不碰瀏覽器 API)
  render/
    scene.ts     three.js 場景建構(場地、燈光、相機)
    vehicle.ts   車體 mesh 建構
    player.ts    播放控制與時間軸
    overlay.ts   除錯疊圖
    visual.ts    純視覺常數(顏色、光照、比例)——見 §P1.7.1
    main.ts      進入點
  ui/
    controls.ts  播放控制介面(原生 DOM)
index.html
vite.config.ts
```

- Vite + TypeScript
- three.js,精確版本鎖定(現行 `0.185.1`)
- vite 釘在 7.3.6(vitest 3.2.4 的 vite 相依範圍為 ^5/^6/^7,vite 8 會衝突)
- **不得引入 React 或其他 UI 框架**;播放控制以原生 DOM 實作

### `src/replay/` 的存在理由

`TrajectoryMeta.generatedAt` 需要牆上時間,而 `SPEC.md` §3 禁令 2 禁止 `src/sim/` 讀取。將 meta 組裝移出 `sim/`,使 `sim/` 只輸出 frame 資料與 outcome、不知道自己被誰包裝,是 §P1.2.1 分離保證能成立的必要條件。

**不得併入呼叫端**——由 CLI 與渲染層各自組裝 meta 會產生兩份實作,遲早分歧。此層亦為後續線上對戰交換 replay 檔的序列化位置。

### ESLint

`src/render/` 與 `src/ui/` 允許使用瀏覽器 API;`src/sim/`、`src/data/`、`src/replay/`、`tools/` 的禁令維持不變。反向 import 規則(`sim/`、`data/` 不得 import `replay/`、`render/`、`ui/`、`three`)須強制。

`tsconfig` 加入 DOM lib(單一設定檔較好維護);`src/sim` 不得碰瀏覽器 API 仍由 ESLint 與 acceptance test 把關。

---

## §P1.7 場景與視覺

### P1.7.1 幾何一律由常數衍生

場地與車體的所有 mesh 尺寸**必須從 `src/data/constants.ts` 讀取**,不得硬編任何數值。

包含:stadium 半徑與直線段長度、圍欄高度厚度、26 段圍欄的位置與旋轉、底盤 cuboid 尺寸、前武器 hull 頂點、四個輪位錨點座標、出界門檻。

理由:硬編會導致視覺與物理不同步,而這種不同步極難察覺——看到的車和實際碰撞的車形狀不同,所有觀察都失去意義。

**正確作法是共用來源**:圍欄 mesh 重用 `buildFenceSegments()`,與 Rapier 建構圍欄使用同一份資料。此模式應沿用至日後的零件系統。

**純視覺常數集中於 `src/render/visual.ts`**,只放**沒有物理對應物**的東西:顏色、光照強度、相機角度與比例、疊圖的換算比例、輪子外觀(輪子在模型中根本不是剛體,沒有真實尺寸)。有物理對應的尺寸一律不得出現在此。

此禁令由 `tests/render.test.ts` 掃描 `scene.ts` 與 `vehicle.ts` 強制:兩檔內不得出現任何等於 `constants.ts` 匯出值的數字字面量。材質外觀值(`roughness` 等)也必須移入 `visual.ts` —— 否則審查者看到 `roughness: 0.35` 無從判斷那是不是場地半徑。

### P1.7.2 車輪的呈現

物理上輪子不是剛體。視覺上須在四個錨點下方繪製輪子 mesh,其垂直位置由該幀的懸吊壓縮量決定。

輪子的滾動旋轉為純視覺,依 `wheelSurfaceSpeed` 恆速旋轉。**不得試圖從物理推導輪子轉速**——模型中輪子轉速本就是常數(`SPEC.md` §6.5)。

### P1.7.3 相機

- **全景**(預設):固定俯視偏角,涵蓋整個 stadium
- **跟隨**:跟隨指定車輛,平滑追蹤,**不隨車體旋轉**(否則畫面會因高速自轉而無法觀看)
- **自由**:滑鼠軌道控制

### P1.7.4 結局呈現

播放至 `outcome.frames` 時停止並顯示結果。OUT 與 FLIP 應有明顯視覺標示,但**不得加入任何改變軌跡的演出**(慢動作重播可以,改變車體位置不可)。

---

## §P1.8 播放控制與除錯疊圖

### P1.8.1 播放控制

- 播放 / 暫停 / 重播
- 速度:0.1× / 0.25× / 0.5× / 1× / 2×
- 逐幀前進 / 後退
- 時間軸拖曳,可跳至任意幀
- 目前幀號與總幀數顯示

**時間推進**:模擬為固定 120 Hz,顯示更新率不定。播放須以真實經過時間換算目標幀,並在相鄰兩幀間插值——位置 lerp、旋轉 slerp。**不得以顯示幀直接對應模擬幀**(0.1× 下每顯示幀只推進 0.2 模擬幀,無插值會連續 5 幀不動)。

### P1.8.2 除錯疊圖

六項,可獨立切換:

1. 四輪接地狀態(離地時變色)
2. **法向力 N** — 四輪各自的柱狀指示,須能看出車體傾斜時外側輪與內側輪的分配差異
3. **輪胎力向量** — 接觸點的箭頭,長度正比於力,並提供數值標示切換
4. 車體重心位置與 up vector
5. stadium 距離與出界門檻(地面上的環)
6. FLIP 計數器(接近 60 時警示)

第 2、3 項是物理調校的主要儀表,須做到可精確判讀。實測 `F/N` 於四輪皆等於 μ,使「摩擦力恆為 Coulomb 飽和上限」在畫面上直接可見。

**疊圖須關閉深度測試**(除錯 gizmo 的標準作法)——接觸點位於車底,否則柱與箭頭會被底盤完全遮擋。

### P1.8.3 輸入介面

- 手動輸入 `{seed, throwA, throwB}`
- 載入 `sample_battles/` 的既有檔案
- 隨機產生合法投擲(依 `SPEC.md` §7 的範圍與 stadium 內拒絕取樣)

---

## §P1.9 效能要求

| 指標 | 上限 |
|---|---|
| 軌跡產生(7200 幀場次) | 400 ms |
| 播放時的顯示更新率 | 60 fps 穩定 |
| 診斷啟用時的軌跡產生 | 500 ms |

**不實作 Web Worker。** 實測 309 ms 與診斷版 300 ms 的差異落在量測噪音內;且該情況僅發生於 7200 幀場次,而該類場次正是極限環繞修正後將要消除的。為一個即將消失的邊界情況引入非同步架構,不符本專案的複雜度取捨。

**不得為效能調整物理參數或降低 solver 迭代次數。**

---

## §P1.10 驗收條件

1. **物理位元不變**:`verify-platform --compare` 20/20 通過
2. **`sim/` 未被實質修改**:`git diff` 僅顯示 §P1.5 的診斷旁路;關閉診斷時的執行路徑與變更前相同(以 checksum 證明)
3. **判定一致**:任取 10 組輸入,播放器顯示的 `result` / `reason` / `frames` 與 CLI 輸出完全相同
4. **版本檢查生效**:竄改 replay 檔的 `physicsVersion` / `rapierVersion` / `wasmSha256`,確認拒絕重現並拋出 `IncompatibleReplayError`
5. **幾何同步**:場地與車體的 mesh 尺寸全部由 `constants.ts` 衍生,無硬編數值
6. **播放控制**:五種速度皆正確,0.1× 下仍為平滑插值;拖曳後續播與從頭播至該幀一致;逐幀移動於兩端不越界
7. **疊圖**:六項可獨立切換,顯示值與診斷資料一致(以單元測試驗證換算,非目視)
8. **效能**:§P1.9 三項達標
9. **五類結局皆可播放**:`sample_battles/` 的既有檔案全部能正確播放至結束
10. **既有測試全綠**:`npm run check` 不得有任何一項因本階段變更而失敗

---

## §P1.11 §13 維持有效

遇規格內部矛盾或物理上不可行的要求,停止並提出問題,不得自行決定替代方案。

**若渲染或除錯需求看似需要修改 `src/sim/` 的計算方式(而非旁路記錄),一律停止並提出。渲染需求不具備修改物理的資格。**
