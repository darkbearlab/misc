/**
 * 軌跡產生的 Worker 進入點（§P1.9，Phase 1-e 修訂）。
 *
 * 這裡刻意只有訊息收發的薄殼，內容全在 `src/replay/trajectory-job.ts` ——
 * 那一份可以在 node 下直接測試，本檔則需要瀏覽器的 Worker 環境。
 * 把邏輯留在這裡會讓「Worker 與主執行緒結果位元相同」這條驗收無從測起。
 *
 * **本檔位於 `src/render/` 而非 `src/replay/`**：§P1.6 規定 replay 層同時服務 CLI 與
 * 渲染層，不得使用瀏覽器 API，而 `self` / `Worker` 正是瀏覽器 API。
 * CLI 從來不需要 Worker，因此這一半屬於渲染層。ESLint 規則擋下了原本的擺法。
 */

import {
  collectTransferables,
  runTrajectoryJob,
  type TrajectoryRequest,
  type TrajectoryResponse,
} from '../replay/trajectory-job.js';

self.addEventListener('message', (event: MessageEvent<TrajectoryRequest>) => {
  void (async () => {
    const response: TrajectoryResponse = await runTrajectoryJob(event.data);
    if (response.kind === 'error') {
      self.postMessage(response);
      return;
    }
    // 轉移而非複製：7200 幀的軌跡（開診斷時約 1.7 MB）在手機上複製一次是可觀的開銷。
    self.postMessage(response, { transfer: collectTransferables(response.trajectory) });
  })();
});
