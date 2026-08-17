/**
 * 物理版本標記（§P1.4）。
 *
 * 這些常數的存在目的只有一個：讓一份 replay 檔能夠說出「我是哪一套物理算出來的」。
 * §15 的驅動切換機構上線後會改變物理模型，屆時所有既有的 fixture 與 replay 都會失效；
 * 有了版本欄位，播放器可以直接拒絕重現，而不是靜默地播出一場結局不同的戰鬥。
 */

/**
 * 單調遞增的物理版本。**Phase 0 結案狀態為 1。**
 *
 * 以下任一情形發生時必須 +1：
 *   - `src/data/constants.ts` 中任何影響物理的數值變更
 *   - `src/sim/` 中影響計算結果的邏輯變更（含力的施加順序）
 *   - Rapier 版本或 wasm binary 變更
 *   - §8 判定條件變更（含門檻值）
 *
 * **不需**升版：純渲染層變更、CLI 介面變更、註解與文件、關閉狀態的診斷輸出。
 */
export const PHYSICS_VERSION = 1;

/** 本實作所依據的規格版本。 */
export const SPEC_VERSION = '1.3';

/** 精確鎖定的 Rapier 版本，須與 package.json 的 dependencies 一致。 */
export const RAPIER_VERSION = '0.19.3';

/**
 * Phase 0 結案記錄的 wasm 雜湊。
 *
 * 刻意寫成常數而非執行期計算：`src/` 底下不得做檔案 I/O（§3.6），
 * 且這個值的用途是「當初產生 replay 的那份 binary」，本來就該是釘死的紀錄。
 * `tests/acceptance.test.ts` 會比對它與實際安裝的 wasm 是否相符。
 */
export const RAPIER_WASM_SHA256 =
  '1ce1c8c4036b4dcd3bde86c6efdb0f270cf5e274979b1de6ab8052947ef166c5';

/**
 * `src/data/constants.ts` 在 PHYSICS_VERSION 這一版的內容雜湊（SHA-256）。
 *
 * `tests/acceptance.test.ts` 會在此雜湊改變而 `PHYSICS_VERSION` 未變時失敗。
 * 這是**提醒**而非阻止（§P1.4.2）：改了常數就順手把兩者一起更新。
 *
 * 註：純註解變更也會改動雜湊而觸發提醒，此時只需重新蓋章、不必升版。
 */
export const PHYSICS_CONSTANTS_SHA256 =
  '35882281103bbbdd60b0ecc62242eb228e00d19d5f995368f92daecb23880a3b';
