#!/usr/bin/env node
/** Deterministic workspace build order documented by the M4 seam graph. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// world 依赖 imports(N33 map-atlas durable driver, 只做加法)→ world 必须在 imports
// 之后构建; imports → writing → outline, 故 outline/writing 提前于 imports 构建。
const order = ['vault', 'trace', 'store', 'llm-step', 'rag', 'rag-bge', 'memory', 'outline', 'writing', 'imports', 'world', 'context', 'assistant', 'dsh', 'client']
for (const workspace of order) {
  // rc.8 reserves a trailing `/client` as the browser subpath marker.
  const packageName = workspace === 'client' ? '@novelcraft/dsh-client' : `@novelcraft/${workspace}`
  const result = spawnSync('npm', ['run', 'build', '-w', packageName], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
