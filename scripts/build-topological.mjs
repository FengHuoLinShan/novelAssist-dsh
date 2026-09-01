#!/usr/bin/env node
/** Deterministic workspace build order documented by the M4 seam graph. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// 源码包经 dist 解析 workspace 依赖；顺序必须覆盖 package.json 的直接依赖。
const order = ['vault', 'trace', 'llm-step', 'memory', 'store', 'context', 'outline', 'rag', 'writing', 'imports', 'rag-bge', 'world', 'assistant', 'dsh', 'client']
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
