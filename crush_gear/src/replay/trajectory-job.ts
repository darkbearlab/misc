/**
 * 軌跡產生工作的訊息協定與執行本體（§P1.9，Phase 1-e 修訂）。
 *
 * ## 為什麼要有這一層
 *
 * 軌跡產生是主執行緒上的一段長時間同步計算：7200 幀的場次在中階手機上實測需要
 * 1.7 秒（4× CPU 節流），期間畫面完全凍結、無法互動。逾時場次佔比 16.8%，
 * 因此大約每六場就會遇到一次。移到 Worker 是唯一不動物理的解法。
 *
 * ## 結構保證不變（§P1.2.1）
 *
 * **Worker 內跑的仍是完整的 `generateTrajectory()`，一次跑完才回傳。**
 * 不是逐幀串流給渲染層，也不是把物理搬到渲染迴圈裡。
 * 「產生」與「播放」兩段的分界完全沒有移動，只是第一段換了一條執行緒。
 * 渲染層拿到的仍然是一份已經定案、不會再變的 `Trajectory`。
 *
 * ## 為什麼協定與執行本體分開放在這裡
 *
 * `trajectory-worker.ts` 只是 `self.onmessage` 的薄殼，本檔才是內容。
 * 這樣測試可以直接呼叫 `runTrajectoryJob()`，也可以用 `node:worker_threads`
 * 載入同一份邏輯做真正的跨執行緒比對，不必依賴瀏覽器環境。
 */

import type { BattleInput } from '../sim/types.js';
import { generateTrajectory, type GenerateOptions, type Trajectory } from './trajectory.js';

export type TrajectoryRequest = {
  kind: 'generate';
  /** 呼叫端的識別碼；回應原樣帶回，讓客端能丟棄過期的結果。 */
  id: number;
  input: BattleInput;
  options: GenerateOptions;
};

export type TrajectoryResponse =
  | { kind: 'done'; id: number; trajectory: Trajectory }
  | { kind: 'error'; id: number; message: string };

/**
 * 執行一次軌跡產生。這就是 Worker 收到訊息後做的事。
 *
 * 錯誤一律轉成 `{ kind: 'error' }` 而非讓它逃出去 —— Worker 裡未捕捉的例外
 * 只會變成一個沒有內容的 `error` 事件，呼叫端拿不到原因。
 */
export async function runTrajectoryJob(
  request: TrajectoryRequest,
): Promise<TrajectoryResponse> {
  try {
    const trajectory = await generateTrajectory(request.input, request.options);
    return { kind: 'done', id: request.id, trajectory };
  } catch (error) {
    return {
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 收集一份軌跡裡所有可轉移的 ArrayBuffer。
 *
 * 軌跡是 7200 幀 × 兩車的位置與旋轉，開啟診斷時另有約 1.7 MB 的每輪資料。
 * 用結構化複製會整份複製一次，轉移則是零拷貝 —— 在手機上這個差別是實質的。
 *
 * 轉移後這些 buffer 在 Worker 端會被 detach，因此**只能在回傳的最後一步做**。
 * 同一個 buffer 出現兩次會讓 postMessage 直接拋錯，故以 Set 去重
 * （目前不會發生，但診斷資料日後若共用 buffer 就會）。
 */
export function collectTransferables(trajectory: Trajectory): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const take = (views: readonly ArrayBufferView[] | undefined): void => {
    if (views === undefined) return;
    for (const view of views) buffers.add(view.buffer as ArrayBuffer);
  };

  take(trajectory.position);
  take(trajectory.rotation);

  const d = trajectory.diagnostics;
  if (d !== undefined) {
    take(d.wheelGrounded);
    take(d.normalForce);
    take(d.tireForce);
    take(d.contactPoint);
    take(d.stadiumDist);
    take(d.flipCounter);
    // localCenterOfMass 是普通物件陣列，沒有 buffer 可轉移。
  }

  return [...buffers];
}
