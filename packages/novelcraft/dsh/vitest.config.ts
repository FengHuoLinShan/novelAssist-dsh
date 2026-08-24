import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    maxWorkers: 4,
    // Durable deep-import performs seven independently committed ADR-0021 batches.
    // Keep the timeout above the real Git-heavy production path while each LLM step
    // retains its own much smaller wall-clock deadline.
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
