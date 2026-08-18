/**
 * 批次模擬的 worker pool（SPEC v1.2 §1.3）。
 *
 * 500 場模擬彼此完全獨立（各自 seed、各自世界、無共享狀態），是可完美平行化的工作負載。
 *
 * 硬性條件：
 *   - **每場戰鬥的模擬過程在單一 worker 內序列完成，不得拆分至多個 worker**
 *   - 結果依輸入順序回傳，不受 worker 完成順序影響
 *   - Rapier wasm 在每個 worker 內獨立初始化
 *   - `workerCount <= 1` 時完全不建立 worker，改為 in-process 序列執行，
 *     供 §11.5b 量測單場成本
 */

import { Worker } from 'node:worker_threads';

import { simulate } from '../src/sim/simulate.js';
import type { BattleInput, PhysicsOverride, SimResult } from '../src/sim/types.js';
import type { WorkerReply, WorkerTask } from './sim-worker.js';

const WORKER_URL = new URL('./sim-worker.ts', import.meta.url);

/**
 * worker 需要一個能載入 TypeScript 的 loader。
 *
 * 以 `npx tsx` 執行時，父行程的 `execArgv` 已含 tsx 的 loader，worker 會直接繼承；
 * 但在 vitest 之類自帶 loader 的執行環境下不會，必須明確補上。
 */
function workerOptions(): { execArgv?: string[] } {
  const hasTsxLoader = process.execArgv.some((arg) => arg.includes('tsx'));
  return hasTsxLoader ? {} : { execArgv: ['--import', 'tsx'] };
}

export async function runBattles(
  battles: readonly BattleInput[],
  workerCount: number,
  physics?: PhysicsOverride,
): Promise<SimResult[]> {
  if (battles.length === 0) return [];
  const simOptions = physics === undefined ? {} : { physics };

  if (workerCount <= 1) {
    const results: SimResult[] = [];
    for (const battle of battles) results.push(await simulate(battle, simOptions));
    return results;
  }

  const results = new Array<SimResult | undefined>(battles.length).fill(undefined);
  const options = workerOptions();
  const pool = Array.from(
    { length: Math.min(workerCount, battles.length) },
    () => new Worker(WORKER_URL, options),
  );

  let nextIndex = 0;
  try {
    await Promise.all(
      pool.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const dispatch = (): void => {
              if (nextIndex >= battles.length) {
                resolve();
                return;
              }
              const index = nextIndex;
              nextIndex += 1;
              worker.postMessage({
                index,
                battle: battles[index] as BattleInput,
                ...(physics === undefined ? {} : { physics }),
              } satisfies WorkerTask);
            };

            worker.on('message', (reply: WorkerReply) => {
              if (reply.error !== undefined) {
                reject(new Error(`battle ${reply.index}: ${reply.error}`));
                return;
              }
              results[reply.index] = reply.result;
              dispatch();
            });
            worker.on('error', reject);

            dispatch();
          }),
      ),
    );
  } finally {
    await Promise.all(pool.map((worker) => worker.terminate()));
  }

  return results.map((r, i) => {
    if (r === undefined) throw new Error(`battle ${i} produced no result.`);
    return r;
  });
}
