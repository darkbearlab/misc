/**
 * 批次模擬的 worker（§1.3）。
 *
 * 每個 worker 內獨立初始化 Rapier 的 wasm 模組，並**在單一 worker 內序列完成整場戰鬥** ——
 * 不得把一場戰鬥拆到多個 worker，否則決定性立刻失效。
 *
 * 協定：
 *   main → worker   { index, battle }
 *   worker → main   { index, result } 或 { index, error }
 */

import { parentPort } from 'node:worker_threads';

import { simulate } from '../src/sim/simulate.js';
import type { BattleInput, SimResult } from '../src/sim/types.js';

export type WorkerTask = { index: number; battle: BattleInput };

export type WorkerReply =
  | { index: number; result: SimResult; error?: undefined }
  | { index: number; result?: undefined; error: string };

const port = parentPort;
if (port === null) {
  throw new Error('sim-worker.ts must be run as a worker thread.');
}

port.on('message', (task: WorkerTask) => {
  simulate(task.battle)
    .then((result) => {
      port.postMessage({ index: task.index, result } satisfies WorkerReply);
    })
    .catch((error: unknown) => {
      port.postMessage({
        index: task.index,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerReply);
    });
});
