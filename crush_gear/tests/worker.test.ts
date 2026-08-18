/**
 * §P1.9（Phase 1-e 修訂）：軌跡產生移入 Worker 後，結果必須與主執行緒**位元相同**。
 *
 * ## 為什麼這個測試不是多餘的
 *
 * 「同一個函式在另一條執行緒上跑」聽起來當然會得到同樣的答案，但真正的風險不在計算，
 * 在**傳遞**：軌跡是一組 Float32Array / Uint8Array / Uint16Array，跨執行緒時要經過
 * 結構化複製或轉移。少一個欄位、轉移後被 detach、型別化陣列被當成普通物件序列化 ——
 * 這些都不會拋錯，只會讓播放器安靜地畫出一場稍微不同的戰鬥。
 *
 * 因此這裡用 `node:worker_threads` 起一條**真的**執行緒，跑與瀏覽器 Worker 完全相同的
 * `runTrajectoryJob()`，把結果送回來，再與主執行緒的結果逐位元比較。
 * 瀏覽器 Worker 與 node Worker 的訊息傳遞都走結構化複製演算法，這一段是共通的；
 * 未被涵蓋的只有 `trajectory-worker.ts` 那幾行 `self.onmessage` 薄殼。
 */
import { Worker } from 'node:worker_threads';

import { beforeAll, describe, expect, it } from 'vitest';

import { generateTrajectory, type Trajectory } from '../src/replay/trajectory.js';
import {
  collectTransferables,
  type TrajectoryRequest,
  type TrajectoryResponse,
} from '../src/replay/trajectory-job.js';
import type { BattleInput } from '../src/sim/types.js';
import { initPhysics } from '../src/sim/world.js';

/** 固定的 generatedAt，讓 meta 也能直接比對（它是唯一含牆上時間的欄位）。 */
const GENERATED_AT = '2026-08-18T00:00:00.000Z';

/** 一場短的（26 幀出界）與一場滿長的（逾時 7200 幀）—— 後者才是 Worker 存在的理由。 */
const CASES: { name: string; input: BattleInput; expectFrames: number }[] = [
  {
    // fixtures/platform/early_out_01.json —— §16 矩陣裡已驗證過的短場次
    name: '短場次（26 幀出界）',
    expectFrames: 26,
    input: {
      seed: 20260822,
      throwA: {"x":0.0219,"z":-0.1579,"y":0.0345,"yaw":2.2798,"pitch":-0.038,"speed":4.0606,"spin":-19.7539},
      throwB: {"x":-0.0572,"z":-0.0864,"y":0.1129,"yaw":0.7217,"pitch":0.2256,"speed":3.0762,"spin":1.9408},
    },
  },
  {
    // sample_battles/draw_timeout.json —— 兩車各自沿圍欄環繞，跑滿 60 秒
    name: '逾時場次（7200 幀）',
    expectFrames: 7200,
    input: {
      seed: 20260817,
      throwA: {"x":0.2425,"z":0.0788,"y":0.1101,"yaw":4.7073,"pitch":0.0738,"speed":1.6013,"spin":-17.7397},
      throwB: {"x":-0.2129,"z":-0.0869,"y":0.0813,"yaw":5.9917,"pitch":-0.1437,"speed":0.4364,"spin":-13.5988},
    },
  },
];

/**
 * 在 node 的 worker_threads 上跑一次軌跡產生。
 *
 * Worker 本體以 `eval: true` 內嵌，避免為測試多留一個只有測試會用的檔案；
 * 它 import 的是正式程式碼裡的同一個 `runTrajectoryJob`。
 */
function generateInWorker(request: TrajectoryRequest): Promise<Trajectory> {
  // tsx 的 ESM loader 讓 worker 能直接 import .ts；路徑轉成 file:// URL 以支援 Windows。
  const jobUrl = new URL('../src/replay/trajectory-job.ts', import.meta.url).href;
  const source = `
    import { parentPort } from 'node:worker_threads';
    import { collectTransferables, runTrajectoryJob } from ${JSON.stringify(jobUrl)};
    parentPort.on('message', async (request) => {
      const response = await runTrajectoryJob(request);
      if (response.kind === 'error') { parentPort.postMessage(response); return; }
      parentPort.postMessage(response, collectTransferables(response.trajectory));
    });
  `;

  return new Promise<Trajectory>((resolve, reject) => {
    const worker = new Worker(source, {
      eval: true,
      execArgv: ['--import', 'tsx'],
      // vitest 會把自己的環境變數帶進來，其中 NODE_OPTIONS 可能與 execArgv 衝突。
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    worker.on('message', (response: TrajectoryResponse) => {
      void worker.terminate();
      if (response.kind === 'error') reject(new Error(response.message));
      else resolve(response.trajectory);
    });
    worker.on('error', (error) => {
      void worker.terminate();
      reject(error);
    });
    worker.postMessage(request);
  });
}

/** 逐位元比較兩份軌跡的所有型別化陣列與 outcome。 */
function expectIdentical(a: Trajectory, b: Trajectory): void {
  expect(b.frameCount).toBe(a.frameCount);
  expect(b.outcome).toEqual(a.outcome);
  expect(b.meta).toEqual(a.meta);

  for (let car = 0; car < 2; car += 1) {
    // Float32Array 的位元比較：toEqual 對型別化陣列是逐元素比較，
    // 而 f32 的每個元素都是精確值，沒有容差問題。
    expect(b.position[car]).toEqual(a.position[car]);
    expect(b.rotation[car]).toEqual(a.rotation[car]);
  }

  const da = a.diagnostics;
  const db = b.diagnostics;
  expect(db === undefined).toBe(da === undefined);
  if (da !== undefined && db !== undefined) {
    for (let car = 0; car < 2; car += 1) {
      expect(db.wheelGrounded[car]).toEqual(da.wheelGrounded[car]);
      expect(db.normalForce[car]).toEqual(da.normalForce[car]);
      expect(db.tireForce[car]).toEqual(da.tireForce[car]);
      expect(db.contactPoint[car]).toEqual(da.contactPoint[car]);
      expect(db.stadiumDist[car]).toEqual(da.stadiumDist[car]);
      expect(db.flipCounter[car]).toEqual(da.flipCounter[car]);
      expect(db.localCenterOfMass[car]).toEqual(da.localCenterOfMass[car]);
    }
  }
}

describe('§P1.9 Worker 與主執行緒的軌跡位元相同', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  for (const testCase of CASES) {
    it(
      `${testCase.name}：跨執行緒後每一個 Float32Array 都逐位元相同`,
      async () => {
        const request: TrajectoryRequest = {
          kind: 'generate',
          id: 1,
          input: testCase.input,
          options: { diagnostics: true, generatedAt: GENERATED_AT },
        };

        const main = await generateTrajectory(testCase.input, {
          diagnostics: true,
          generatedAt: GENERATED_AT,
        });
        const worker = await generateInWorker(request);

        // 名稱宣稱的長度必須成立 —— 否則「已測過 7200 幀」是假的
        expect(main.outcome.frames).toBe(testCase.expectFrames);

        expectIdentical(main, worker);
      },
      120_000,
    );
  }

  it('collectTransferables 涵蓋所有型別化陣列且不重複', async () => {
    const trajectory = await generateTrajectory(CASES[0]!.input, {
      diagnostics: true,
      generatedAt: GENERATED_AT,
    });
    const buffers = collectTransferables(trajectory);

    // 2 車 × (position, rotation) + 2 車 × 6 組診斷 = 16 個 buffer。
    // 重複的 buffer 會讓 postMessage 直接拋錯，因此去重是必要的而非防禦性的。
    expect(buffers.length).toBe(16);
    expect(new Set(buffers).size).toBe(buffers.length);

    // 每一個型別化陣列的 buffer 都必須在清單裡，漏掉就會退回複製（慢但不會錯），
    // 或者更糟：部分轉移部分複製，讓兩邊指向不同的記憶體。
    const set = new Set(buffers);
    for (const view of [...trajectory.position, ...trajectory.rotation]) {
      expect(set.has(view.buffer as ArrayBuffer)).toBe(true);
    }
  });

  it('沒有診斷資料時也能正確收集', async () => {
    const trajectory = await generateTrajectory(CASES[0]!.input, { generatedAt: GENERATED_AT });
    // 只有 2 車 × (position, rotation) = 4 個。
    expect(collectTransferables(trajectory).length).toBe(4);
  });
});
