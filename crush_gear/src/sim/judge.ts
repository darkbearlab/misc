/**
 * 勝負判定（§8）。每幀檢查，判定優先序：OUT → FLIP → TIMEOUT。
 *
 * 同幀雙方皆滿足敗北條件（不論是 OUT 或 FLIP）時判定為 DRAW（§8.4 / §14.7）；
 * 此時 reason 取優先序較高者，即只要任一方是 OUT 就記為 OUT。
 */

import { FIELD_HALF_SEGMENT, FLIP_HOLD_FRAMES, OUT_Y_LIMIT, TIMEOUT_FRAMES } from '../data/constants.js';
import { DEFAULT_ARENA, stadiumDistanceIn, type ResolvedArena } from './arena.js';
import { dot, WORLD_UP, type Outcome, type VehicleJudgeState } from './types.js';

/**
 * Stadium 距離函數：點 (x, z) 到 stadium 中心線（沿 Z 的線段）的最短距離。
 *
 * 中心線為 z ∈ [−L/2, +L/2] 上的線段；把 z 夾擠到該區間再取平面距離，
 * 即可同時涵蓋中央直線段與兩端半圓。距離 = FIELD_RADIUS 即為圍欄內緣。
 *
 * ⚠️ **這裡刻意不使用 `Math.hypot`，請勿「優化」回去**（§3 禁令 7、v1.3 §1）。
 *
 * `Math.hypot` 的精度是**實作定義**的，而本函式位於每幀熱路徑上：它決定出界判定，
 * 出界判定決定模擬的終止幀，終止幀決定 checksum 陣列的長度與最後一筆內容。
 * 兩個平台若在不同幀終止，checksum 陣列長度就不同，§11.8 直接判定不通過；
 * 更嚴重的是若某車擦過門檻的那一幀另一車正好 FLIP，依 §8.4 勝負會由 A_WINS 變成 DRAW ——
 * 也就是**勝負結果可跨平台不一致**。
 *
 * `Math.hypot` 的唯一優勢是避免中間值平方時的溢位／下溢，但本專案中
 * |x| ≤ 0.55、|dz| ≤ 0.45，平方後量級在 1e-1 ~ 1e-7，距 f64 的溢位邊界有數百個數量級的餘裕，
 * 該優勢沒有發揮的餘地。而 `Math.sqrt` 與 `+ - *` 都是 IEEE-754 要求正確捨入的運算，
 * 因此這個版本在熱路徑上不含任何精度為實作定義的運算。
 */
export function stadiumDistance(x: number, z: number): number {
  const dz = Math.max(-FIELD_HALF_SEGMENT, Math.min(FIELD_HALF_SEGMENT, z));
  const dzz = z - dz;
  return Math.sqrt(x * x + dzz * dzz);
}

/** §8.1 出界：質心超出圍欄外緣的餘裕範圍，或掉落至地板平面以下。 */
export function isOut(state: VehicleJudgeState, arena: ResolvedArena = DEFAULT_ARENA): boolean {
  const { com } = state;
  return (
    stadiumDistanceIn(arena.halfSegment, com.x, com.z) > arena.outThreshold ||
    com.y < OUT_Y_LIMIT
  );
}

/** §8.2 翻覆瞬時條件：車體 up vector 與世界 +Y 的內積 < 0。 */
export function isInverted(state: VehicleJudgeState): boolean {
  return dot(state.up, WORLD_UP) < 0;
}

export class Judge {
  /** 連續翻覆幀數計數器，條件不滿足時歸零。 */
  private flipFramesA = 0;
  private flipFramesB = 0;

  /**
   * @param arena 場地幾何；不指定時為 `constants.ts` 的預設值。
   *   出界門檻與 stadium 距離都取自這裡，場地縮放時判定才會跟著變。
   */
  constructor(private readonly arena: ResolvedArena = DEFAULT_ARENA) {}

  /**
   * 目前的連續翻覆幀數（唯讀），供 §P1.5 的除錯疊圖顯示「快要 FLIP 了」。
   * 純讀取，不影響判定。
   *
   * @param index 0 = 車 A，1 = 車 B
   */
  flipFrames(index: number): number {
    return index === 0 ? this.flipFramesA : this.flipFramesB;
  }

  /**
   * 檢查一幀。回傳 `null` 代表尚未分出勝負。
   *
   * @param frame 目前已推進的幀數（第 0 幀為投入瞬間，尚未 step）。
   */
  update(frame: number, a: VehicleJudgeState, b: VehicleJudgeState): Outcome | null {
    const outA = isOut(a, this.arena);
    const outB = isOut(b, this.arena);

    this.flipFramesA = isInverted(a) ? this.flipFramesA + 1 : 0;
    this.flipFramesB = isInverted(b) ? this.flipFramesB + 1 : 0;
    const flipA = this.flipFramesA >= FLIP_HOLD_FRAMES;
    const flipB = this.flipFramesB >= FLIP_HOLD_FRAMES;

    const lostA = outA || flipA;
    const lostB = outB || flipB;

    if (lostA || lostB) {
      // 優先序：只要任一方是 OUT，reason 就是 OUT。
      const reason = outA || outB ? 'OUT' : 'FLIP';
      if (lostA && lostB) return { result: 'DRAW', reason };
      if (lostA) return { result: 'B_WINS', reason };
      return { result: 'A_WINS', reason };
    }

    // §8.3 時限：Phase 0 不實作耐久度或分數判定，時限即平手。
    if (frame >= TIMEOUT_FRAMES) {
      return { result: 'DRAW', reason: 'TIMEOUT' };
    }

    return null;
  }
}
