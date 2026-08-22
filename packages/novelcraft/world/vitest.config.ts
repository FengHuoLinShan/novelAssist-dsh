import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Git transaction tests spawn many synchronous subprocesses; bounded workers avoid RPC starvation.
    maxWorkers: 4,
  },
});
