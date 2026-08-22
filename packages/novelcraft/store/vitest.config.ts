import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Git/crash suites are child-process heavy; cap workers so Vitest RPC updates are serviced
    // within birpc's timeout instead of starving behind many synchronous git subprocesses.
    maxWorkers: 4,
  },
});
