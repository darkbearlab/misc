import { defineConfig } from 'vite';

/**
 * Replay 播放器的開發／建置設定（§P1.6）。
 *
 * 沒有任何框架外掛 —— 播放控制以原生 DOM 實作（延續 Phase 0 §1 的禁令）。
 * `@dimforge/rapier3d-compat` 把 wasm 以 base64 內嵌，因此瀏覽器端不需要
 * 額外的 wasm 載入設定，`src/sim/` 可以原封不動地在瀏覽器裡跑。
 */
export default defineConfig({
  server: { port: 5173 },
  build: {
    target: 'es2022',
    // Rapier 的 wasm 以 base64 內嵌，單一 chunk 本來就會偏大。
    chunkSizeWarningLimit: 3000,
  },
});
