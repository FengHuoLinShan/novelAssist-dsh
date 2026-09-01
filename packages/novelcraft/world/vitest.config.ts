import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Git transaction tests spawn many synchronous subprocesses; one worker avoids Vitest RPC starvation.
    maxWorkers: 1,
  },
});
