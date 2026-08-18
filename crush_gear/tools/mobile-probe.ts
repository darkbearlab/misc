#!/usr/bin/env node
/**
 * 行動裝置版面截圖與效能量測（Phase 1-e §6 驗收）。
 *
 *   npx vite preview --port 4173          # 先起一個靜態伺服器
 *   npx tsx tools/mobile-probe.ts http://localhost:4173/ ./out
 *
 * 以 CDP 驅動本機 Chrome：套用行動裝置的視窗尺寸與 DPR、對 CPU 施加節流，
 * 讀取播放器掛在 `window.__player` 上的讀數，並在每種尺寸各截兩張圖
 * （面板收合與展開）。另外稽核所有互動元素的觸控目標尺寸與頁面層級的捲動／縮放。
 *
 * ## 這不屬於模擬核心，不受 §3 禁令約束
 *
 * `SPEC.md` §3 的禁令（不得 I/O、不得讀牆上時間、不得使用非決定性 API）約束的是
 * `src/sim/`，因為那裡的任何非決定性都會直接破壞跨平台一致性。
 * 本工具屬**量測與驗證**用途：它啟動瀏覽器、寫檔案、讀牆上時間，全部是必要的，
 * 而且它從不參與模擬 —— 它只是從外面觀察一個已經跑完的播放器。
 * 同一個道理適用於 `tools/` 下的其他量測工具（見 `SPEC.md` §2）。
 *
 * ## 量測的限制（報告時必須一併說明）
 *
 * **這不是真機量測。** GPU 是桌機的，只有 CPU 被節流，因此：
 *   - 軌跡產生時間（純 CPU、Rapier wasm）是相對可信的代理值
 *   - fps 偏樂觀，真機的 GPU 與熱節流都會更差
 * 輸出一律標示節流倍率，不冒充真機數字。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

// ──────────────────────────────────────────────────────────────────────────
// 量測情境
// ──────────────────────────────────────────────────────────────────────────

type Device = { name: string; width: number; height: number; dpr: number };

const DEVICES: Device[] = [
  { name: 'phone-portrait', width: 390, height: 844, dpr: 3 },
  { name: 'phone-landscape', width: 844, height: 390, dpr: 3 },
  { name: 'small-portrait', width: 360, height: 640, dpr: 2 },
  { name: 'tablet-landscape', width: 1024, height: 768, dpr: 2 },
];

/** 1 = 不節流（桌機基準）；4 ≈ 中階手機的粗略代理。 */
const THROTTLES = [1, 4];

/** 量測用的場次：7200 幀的逾時場，也就是 §P1.9 的目標情境。 */
const SAMPLE = 'draw_timeout';

const DEBUG_PORT = 9333;

/** Chrome 的常見安裝位置；找不到時由 CHROME_PATH 指定。 */
const CHROME_CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

function resolveChrome(): string {
  const override = process.env['CHROME_PATH'];
  if (override !== undefined && override !== '') return override;
  const candidates = CHROME_CANDIDATES[platform()] ?? [];
  // 只需要知道存不存在；spawn 失敗會有自己的錯誤訊息。
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error(
    'Chrome not found. Set CHROME_PATH to the executable, e.g. ' +
      'CHROME_PATH="/usr/bin/chromium" npx tsx tools/mobile-probe.ts ...',
  );
}

// ──────────────────────────────────────────────────────────────────────────
// 極簡 CDP 客端
// ──────────────────────────────────────────────────────────────────────────

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class Cdp {
  private id = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: unknown;
      };
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  send<T = unknown>(method: string, params: unknown = {}, sessionId?: string): Promise<T> {
    this.id += 1;
    const id = this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function devtoolsEndpoint(): Promise<string> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/version`);
      const json = (await response.json()) as { webSocketDebuggerUrl: string };
      return json.webSocketDebuggerUrl;
    } catch {
      await sleep(300);
    }
  }
  throw new Error('Chrome devtools endpoint never came up.');
}

// ──────────────────────────────────────────────────────────────────────────
// 稽核腳本（在頁面內執行）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 觸控目標稽核（§1「不小於 44×44 CSS px」）。
 *
 * checkbox 被 `<label>` 包住時，實際可點的是整個 label —— 這是 WCAG 2.5.5 的量法，
 * 量 input 本身會得到 22×22 的假警報。
 */
const AUDIT_SCRIPT = `(() => {
  const MIN = 44;
  const bad = [];
  let total = 0;
  for (const e of document.querySelectorAll('button, input, select, summary, label.checkrow, a')) {
    const target = (e.tagName === 'INPUT' && e.closest('label')) ? e.closest('label') : e;
    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    total += 1;
    if (r.width < MIN - 0.5 || r.height < MIN - 0.5) {
      bad.push({ tag: e.tagName, cls: String(e.className),
                 txt: (e.textContent || '').trim().slice(0, 14),
                 w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
    }
  }
  const doc = document.documentElement;
  return JSON.stringify({
    interactive: total,
    undersized: bad,
    pageScrollsX: doc.scrollWidth > doc.clientWidth + 1,
    pageScrollsY: doc.scrollHeight > doc.clientHeight + 1,
    canvasTouchAction: getComputedStyle(document.querySelector('canvas')).touchAction,
    viewportTouchAction: getComputedStyle(document.querySelector('.viewport')).touchAction,
  });
})()`;

/** 展開面板（橫向）或捲到底（直向），以便截到控制項那一段。 */
const REVEAL_SCRIPT = `(() => {
  const toggle = document.querySelector('.panel-toggle');
  if (toggle && getComputedStyle(toggle).display !== 'none') { toggle.click(); return 'panel'; }
  const panel = document.querySelector('.panel');
  if (panel) { panel.scrollTop = panel.scrollHeight; return 'scroll'; }
  return 'none';
})()`;

// ──────────────────────────────────────────────────────────────────────────

type Row = {
  device: string;
  viewport: string;
  cpuThrottle: number;
  quality: string;
  pixelRatio: number;
  viaWorker: boolean;
  frameCount: number;
  generationMs: number;
  /** 產生期間主執行緒相鄰兩次 rAF 的最長間隔（ms）。越小代表越沒凍住。 */
  maxFrameGapMs: number;
  fpsMedian: number;
  fpsP10: number;
};

async function main(): Promise<void> {
  const baseUrl = process.argv[2] ?? 'http://localhost:4173/';
  const outDir = process.argv[3] ?? 'mobile-probe-out';
  mkdirSync(outDir, { recursive: true });

  const chrome = spawn(resolveChrome(), [
    `--remote-debugging-port=${String(DEBUG_PORT)}`,
    '--headless=new',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // headless 沒有真的 GPU，WebGL 走 SwiftShader —— 這正是 fps 只能當下限的原因。
    '--enable-unsafe-swiftshader',
    `--user-data-dir=${outDir}/chrome-profile`,
    'about:blank',
  ]);
  chrome.on('error', (error) => {
    process.stderr.write(`chrome failed to start: ${error.message}\n`);
  });

  const ws = new WebSocket(await devtoolsEndpoint());
  await new Promise((resolve) => {
    ws.addEventListener('open', resolve, { once: true });
  });
  const cdp = new Cdp(ws);

  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  const evaluate = async <T>(expression: string, awaitPromise = false): Promise<T> => {
    const result = await cdp.send<{
      result: { value: T };
      exceptionDetails?: { text: string };
    }>('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  const rows: Row[] = [];
  const audits: string[] = [];

  for (const device of DEVICES) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: device.width, height: device.height, deviceScaleFactor: device.dpr, mobile: true },
      sessionId,
    );
    await cdp.send(
      'Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 },
      sessionId,
    );

    for (const rate of THROTTLES) {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate }, sessionId);
      await cdp.send('Page.navigate', { url: baseUrl }, sessionId);

      let ready = false;
      for (let i = 0; i < 120; i += 1) {
        await sleep(500);
        const frames = await evaluate<number>(
          'window.__player ? window.__player.frameCount() : 0',
        );
        if (frames > 0) {
          ready = true;
          break;
        }
      }
      if (!ready) {
        process.stderr.write(`${device.name} @${String(rate)}x never became ready\n`);
        continue;
      }

      // 主執行緒阻塞量測：重設後觸發產生，等它跑完，讀出最長的 rAF 間隔。
      // 這才是「UI 有沒有凍住」的直接證據 —— fps 是 500 ms 平均，會把阻塞平滑掉。
      //
      // ⚠️ CDP 的 CPU 節流**只作用於主執行緒**，Worker 不受影響。因此軌跡產生移入
      // Worker 之後，這裡量到的 generationMs 是**未節流**的 worker 時間，
      // 不能拿來當「中階手機上的產生耗時」。真機上仍是原本那個量級。
      // 節流在這裡真正還有意義的量測是 maxFrameGap —— 主執行緒有沒有被卡住。
      await evaluate('window.__player.resetFrameGap()');
      await evaluate(`window.__player.run(${JSON.stringify(SAMPLE)})`, true);
      const maxFrameGapMs = Math.round(await evaluate<number>('window.__player.maxFrameGapMs()'));

      // fps 讀數每 500 ms 更新一次，先讓它穩定再取樣。
      await sleep(1500);
      const samples: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        await sleep(500);
        samples.push(await evaluate<number>('window.__player.fps()'));
      }
      samples.sort((a, b) => a - b);

      rows.push({
        device: device.name,
        viewport: `${String(device.width)}x${String(device.height)}@${String(device.dpr)}x`,
        cpuThrottle: rate,
        quality: await evaluate<string>('window.__player.quality()'),
        pixelRatio: await evaluate<number>('window.__player.pixelRatio()'),
        viaWorker: await evaluate<boolean>('window.__player.viaWorker()'),
        frameCount: await evaluate<number>('window.__player.frameCount()'),
        generationMs: Math.round(await evaluate<number>('window.__player.generationMs()')),
        maxFrameGapMs,
        fpsMedian: samples[Math.floor(samples.length / 2)] ?? 0,
        fpsP10: samples[Math.floor(samples.length * 0.1)] ?? 0,
      });

      const last = rows[rows.length - 1] as Row;
      process.stderr.write(
        `${device.name} @${String(rate)}x  gen ${String(last.generationMs)} ms  ` +
          `gap ${String(last.maxFrameGapMs)} ms  fps ${last.fpsMedian.toFixed(0)}  worker=${String(last.viaWorker)}\n`,
      );

      // 截圖與稽核只需要一次（節流不影響版面）。
      if (rate === THROTTLES[0]) {
        audits.push(`### ${device.name}\n${await evaluate<string>(AUDIT_SCRIPT)}`);

        const shot = await cdp.send<{ data: string }>(
          'Page.captureScreenshot',
          { format: 'png' },
          sessionId,
        );
        writeFileSync(`${outDir}/${device.name}.png`, Buffer.from(shot.data, 'base64'));

        await evaluate(REVEAL_SCRIPT);
        await sleep(500);
        const revealed = await cdp.send<{ data: string }>(
          'Page.captureScreenshot',
          { format: 'png' },
          sessionId,
        );
        writeFileSync(
          `${outDir}/${device.name}-panel.png`,
          Buffer.from(revealed.data, 'base64'),
        );
      }
    }
  }

  writeFileSync(`${outDir}/results.json`, `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(`${outDir}/audit.txt`, `${audits.join('\n\n')}\n`);
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n\n${audits.join('\n\n')}\n`);

  ws.close();
  chrome.kill();
  process.exit(0);
}

void main();
