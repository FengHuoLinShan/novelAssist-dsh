#!/usr/bin/env node
/** 使用 Node 原生子进程并行运行 workspace 自有测试；不改变任何 package 的覆盖集合。 */
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGES = join(ROOT, 'packages', 'novelcraft')
// ponytail: 固定 2 个 package worker；3 路会让 Vitest worker 在重测试重叠时 RPC 超时。
const CONCURRENCY = 2

const workspaces = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => JSON.parse(readFileSync(join(PACKAGES, entry.name, 'package.json'), 'utf8')))
  .filter((pkg) => typeof pkg.scripts?.test === 'string')
  .map((pkg) => pkg.name)
  .sort()

let cursor = 0
let failed = 0

async function worker() {
  while (cursor < workspaces.length) {
    const name = workspaces[cursor++]
    const started = Date.now()
    const result = await new Promise((resolve) => {
      const child = spawn('npm', ['test', '--workspace', name], {
        cwd: ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { output += chunk })
      child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.stack ?? error.message}\n` }))
      child.on('close', (code) => resolve({ code: code ?? 1, output }))
    })
    process.stdout.write(`\n[${name}] ${(Date.now() - started) / 1000}s\n${result.output}`)
    if (result.code !== 0) failed += 1
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, workspaces.length) }, () => worker()))
if (failed > 0) {
  console.error(`workspace tests: ${failed}/${workspaces.length} failed`)
  process.exit(1)
}
console.log(`workspace tests: ${workspaces.length}/${workspaces.length} passed`)
