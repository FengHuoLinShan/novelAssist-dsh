#!/usr/bin/env node
/**
 * dsh-mobile revert: 从 .novelcraft-orig 备份还原全局 dsh 的宿主文件、客户端 UI
 * bundle 与前端 dist。
 * 用法: node scripts/dsh-mobile/revert.mjs
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))

function resolveGlobalRoot() {
  if (process.env.DSH_GLOBAL_ROOT) return resolve(process.env.DSH_GLOBAL_ROOT)
  const which = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  const bin = execFileSync('readlink', ['-f', which], { encoding: 'utf8' }).trim()
  return resolve(dirname(dirname(bin)))
}

const nodeModules = join(resolveGlobalRoot(), 'node_modules/@deepseek-ai')
const files = [
  'dsh-web-app/lib/startup.js',
  'dsh-web-app/lib/index.js',
  'dsh-web-app/cordis.patch.yml',
  'dsh-client-connection/lib/index.js',
  'dsh-client-ui-layout/lib/client.js',
  'dsh-client-ui-sidebar/lib/client.js',
  'dsh-client-ui-conversation/lib/client.js',
]

let restored = 0
for (const rel of files) {
  const target = join(nodeModules, rel)
  const backup = `${target}.novelcraft-orig`
  if (!existsSync(backup)) {
    console.log(`[dsh-mobile] 无备份, 跳过: ${rel}`)
    continue
  }
  execFileSync('cp', [backup, target])
  console.log(`[dsh-mobile] 已还原: ${rel}`)
  restored += 1
}

const distTarget = join(nodeModules, 'dsh-web-frontend/dist')
const distBackup = `${distTarget}.novelcraft-orig`
if (existsSync(distBackup)) {
  rmSync(distTarget, { recursive: true, force: true })
  execFileSync('cp', ['-R', distBackup, distTarget])
  console.log('[dsh-mobile] 已还原前端 dist')
  restored += 1
}

console.log(restored === 0 ? '[dsh-mobile] 无可还原项。' : `[dsh-mobile] 还原完成, 共 ${restored} 项。重启 dsh web 生效。`)
