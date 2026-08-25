import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 深导 trace-contract/tx 用例是真实 git 编排(N32 事务化后单例 3s+,
    // 并行负载下会越过 vitest 默认 5s); 与 store/world 同级取 30s。
    testTimeout: 30000,
    hookTimeout: 30000,
    // Git/crash suites are child-process heavy; cap workers so Vitest RPC updates are serviced
    // within birpc's timeout instead of starving behind many synchronous git subprocesses.
    maxWorkers: 4,
  },
});
