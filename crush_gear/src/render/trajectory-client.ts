/**
 * 主執行緒這一側的軌跡產生客端（§P1.9，Phase 1-e 修訂）。
 *
 * 把 `generateTrajectory()` 丟給 Worker，讓 UI 在 1.7 秒的計算期間仍可互動。
 * **播放行為完全沒變**：仍然是軌跡整份產生完畢後才開始播（§P1.2.1）。
 *
 * ## 取消 = 終止 Worker
 *
 * `simulate()` 是一段同步計算，沒有可以插入的中止點，因此唯一真正停得下來的方法
 * 是終止整條 Worker 執行緒。連續按「隨機產生」時舊的計算會被直接砍掉，
 * 而不是排隊等它跑完 —— 否則使用者按第三次時還在等第一次的結果。
 *
 * ## 為什麼在 `src/render/` 而不是 `src/replay/`
 *
 * §P1.6 規定 replay 層同時服務 CLI 與渲染層，不得使用瀏覽器 API ——
 * `Worker` 與 `performance` 都是。CLI 不需要把計算移出主執行緒（凍結對它無意義），
 * 因此 Worker 這一半屬於渲染層；跨執行緒共用的協定與執行本體留在
 * `src/replay/trajectory-job.ts`，那一份是環境中立的。
 *
 * ## 沒有 Worker 時的退路
 *
 * node（測試、`tools/`）與極舊的瀏覽器沒有 `Worker`，此時直接在當前執行緒跑。
 * 結果完全相同，只是會凍結而已 —— 對測試與 CLI 而言凍結不構成問題。
 */

import type { BattleInput } from '../sim/types.js';
import {
  generateTrajectory,
  type GenerateOptions,
  type Trajectory,
} from '../replay/trajectory.js';
import type { TrajectoryRequest, TrajectoryResponse } from '../replay/trajectory-job.js';

export type GenerateOutcome = {
  trajectory: Trajectory;
  /** 是否真的走了 Worker；退路模式下為 false。 */
  viaWorker: boolean;
  elapsedMs: number;
};

/** 產生期間的進度通知。 */
export type ProgressHandler = (state: { elapsedMs: number }) => void;

/** 呼叫端在新請求到來時取消舊請求所用的錯誤。 */
export class TrajectoryCancelledError extends Error {
  constructor() {
    super('Trajectory generation was superseded by a newer request.');
    this.name = 'TrajectoryCancelledError';
  }
}

/**
 * 進度回報的節奏（ms）。
 *
 * **只有經過時間，沒有百分比。** `simulate()` 不提供幀數進度，要取得它必須在
 * `src/sim/simulate.ts` 的主迴圈裡插入回呼 —— 那是物理核心的變更，
 * 不在本階段的授權範圍內。因此 UI 顯示的是不確定進度（§P1.9 允許）。
 */
const PROGRESS_INTERVAL = 100;

export class TrajectoryClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending:
    | { id: number; resolve: (r: TrajectoryResponse) => void; reject: (e: Error) => void }
    | null = null;
  /** Worker 建構失敗過就不再重試，直接走退路。 */
  private workerUnavailable = false;

  /** 目前是否有計算在跑。 */
  get busy(): boolean {
    return this.pending !== null;
  }

  async generate(
    input: BattleInput,
    options: GenerateOptions = {},
    onProgress?: ProgressHandler,
  ): Promise<GenerateOutcome> {
    // 新請求一律取代舊請求；舊的 Worker 連同它的計算一起終止。
    this.cancel();

    const started = performance.now();
    let ticker: ReturnType<typeof setInterval> | undefined;
    if (onProgress !== undefined) {
      onProgress({ elapsedMs: 0 });
      ticker = setInterval(() => {
        onProgress({ elapsedMs: performance.now() - started });
      }, PROGRESS_INTERVAL);
    }

    try {
      const worker = this.ensureWorker();
      if (worker === null) {
        // 退路：當前執行緒。會凍結，但結果相同。
        const trajectory = await generateTrajectory(input, options);
        return { trajectory, viaWorker: false, elapsedMs: performance.now() - started };
      }

      const id = this.nextId;
      this.nextId += 1;
      const request: TrajectoryRequest = { kind: 'generate', id, input, options };

      const response = await new Promise<TrajectoryResponse>((resolve, reject) => {
        this.pending = { id, resolve, reject };
        worker.postMessage(request);
      });

      if (response.kind === 'error') throw new Error(response.message);
      return {
        trajectory: response.trajectory,
        viaWorker: true,
        elapsedMs: performance.now() - started,
      };
    } finally {
      if (ticker !== undefined) clearInterval(ticker);
      this.pending = null;
    }
  }

  /** 終止進行中的計算。沒有計算在跑時什麼也不做。 */
  cancel(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    // 終止是唯一停得下同步計算的手段；下次 generate 會重建一條。
    this.worker?.terminate();
    this.worker = null;
    pending.reject(new TrajectoryCancelledError());
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker | null {
    if (this.workerUnavailable) return null;
    if (this.worker !== null) return this.worker;
    if (typeof Worker === 'undefined') {
      this.workerUnavailable = true;
      return null;
    }

    try {
      // `new URL(..., import.meta.url)` 是 Vite 辨識 Worker 的固定寫法；
      // 換成變數或字串常數會讓打包器抓不到這個進入點。
      const worker = new Worker(new URL('./trajectory-worker.js', import.meta.url), {
        type: 'module',
      });
      worker.addEventListener('message', (event: MessageEvent<TrajectoryResponse>) => {
        const pending = this.pending;
        // 過期的回應直接丟棄 —— 終止後仍可能有一則訊息已在路上。
        if (pending === null || pending.id !== event.data.id) return;
        this.pending = null;
        pending.resolve(event.data);
      });
      worker.addEventListener('error', (event) => {
        const pending = this.pending;
        if (pending === null) return;
        this.pending = null;
        pending.reject(new Error(event.message || 'Trajectory worker failed.'));
      });
      this.worker = worker;
      return worker;
    } catch {
      this.workerUnavailable = true;
      return null;
    }
  }
}
