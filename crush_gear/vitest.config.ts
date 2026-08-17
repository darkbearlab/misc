import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // §11.5 量測的是牆上時間；讓測試檔逐一執行，避免互相搶 CPU 造成假性超時。
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
