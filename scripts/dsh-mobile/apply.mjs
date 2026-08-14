#!/usr/bin/env node
/**
 * dsh-mobile: 把 scripts/dsh-mobile/stage/ 下的宿主补丁、前端 dist 与客户端 UI
 * bundle 部署到全局安装的 @deepseek-ai/dsh(移动端远程访问 + PIN 配对 + 移动 UI)。
 *
 * 部署面:
 *   1. 宿主补丁: dsh-web-app(2 文件 + bundle patch)、dsh-client-connection(index)
 *   2. 前端 dist: dsh-web-frontend/dist(shell 内核 + PWA 资源)
 *   3. 客户端 UI bundle: dsh-client-ui-{layout,sidebar,conversation}/lib/client.js
 *      (浏览器 UI 插件经 /plugins/<id>/client.js 由宿主从全局安装包提供,
 *       vite dist 不含这些插件代码)
 *
 * - 幂等: 目标已是补丁内容则跳过; 目标与备份一致(升级后还原为原版)则重新应用。
 * - fail-loud: 目标与「备份」和「stage 内容」都不一致时拒绝, 提示重新基线化
 *   (对应升级后需要 review 补丁再重放的策略)。
 * - 备份: 首次应用前把原文件备份为 <target>.novelcraft-orig。
 *
 * 用法: node scripts/dsh-mobile/apply.mjs
 * 环境变量: DSH_GLOBAL_ROOT  显式指定全局 dsh 包根目录(默认从 PATH 的 dsh 推导)
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const stage = join(here, 'stage')

/** stage 内容的防呆标记: 防止把过期/错误版本的 stage 灌进去。 */
const FILE_MARKERS = {
  'dsh-web-app/lib/startup.js': ['--pair-pin', 'randomInt'],
  'dsh-web-app/lib/index.js': ['pairPin', 'pairing PIN for non-local clients'],
  'dsh-web-app/cordis.patch.yml': ['ctx.webRuntime.pairPin'],
  'dsh-client-connection/lib/index.js': ['pairing-required', 'PAIR_COOKIE'],
  'client-bundles/dsh-client-ui-layout.js': ['PairingGate'],
  'client-bundles/dsh-client-ui-sidebar.js': ['closeDrawer'],
  'client-bundles/dsh-client-ui-conversation.js': ['safe-area-inset-bottom'],
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 从 PATH 上的 dsh 二进制推导全局包根: .../lib/node_modules/@deepseek-ai/dsh */
function resolveGlobalRoot() {
  if (process.env.DSH_GLOBAL_ROOT) return resolve(process.env.DSH_GLOBAL_ROOT)
  let which
  try {
    which = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
  } catch {
    console.error('[dsh-mobile] dsh 不在 PATH 中; 用 DSH_GLOBAL_ROOT 指定全局包根')
    process.exit(1)
  }
  const bin = execFileSync('readlink', ['-f', which], { encoding: 'utf8' }).trim()
  // .../@deepseek-ai/dsh/lib/bin.js -> 根 = lib 的上一级
  return resolve(dirname(dirname(bin)))
}

const root = resolveGlobalRoot()
const nodeModules = join(root, 'node_modules/@deepseek-ai')

const targets = [
  join(nodeModules, 'dsh-web-app/lib/startup.js'),
  join(nodeModules, 'dsh-web-app/lib/index.js'),
  join(nodeModules, 'dsh-web-app/cordis.patch.yml'),
  join(nodeModules, 'dsh-client-connection/lib/index.js'),
]

let changed = 0
for (const target of targets) {
  const rel = target.slice(nodeModules.length + 1)
  const src = join(stage, rel)
  const backup = `${target}.novelcraft-orig`

  if (!existsSync(src)) {
    console.error(`[dsh-mobile] 缺少 stage 文件: ${src}`)
    process.exit(1)
  }
  const stageText = readFileSync(src, 'utf8')
  for (const marker of FILE_MARKERS[rel] ?? []) {
    if (!stageText.includes(marker)) {
      console.error(`[dsh-mobile] stage 防呆失败: ${rel} 缺标记 ${JSON.stringify(marker)} — 请复核补丁内容`)
      process.exit(1)
    }
  }

  if (!existsSync(target)) {
    console.error(`[dsh-mobile] 目标不存在: ${target}`)
    process.exit(1)
  }
  const cur = readFileSync(target, 'utf8')
  if (cur === stageText) {
    console.log(`[dsh-mobile] 已是补丁版, 跳过: ${rel}`)
    continue
  }
  const backupText = existsSync(backup) ? readFileSync(backup, 'utf8') : null
  if (backupText !== null && cur !== backupText) {
    console.error(
      `[dsh-mobile] ${rel} 内容与备份和 stage 均不一致(dsh 可能已升级) — 请 review 后重新基线化 stage, 再重放`,
    )
    process.exit(1)
  }
  if (backupText === null) copyFileSync(target, backup)
  copyFileSync(src, target)
  console.log(`[dsh-mobile] 已应用: ${rel} (sha256 ${sha256(src).slice(0, 12)}…)`)
  changed += 1
}

// 客户端 UI bundle(浏览器插件代码, 宿主经 /plugins/<id>/client.js 提供)
const clientBundles = [
  { stage: 'dsh-client-ui-layout.js', target: join(nodeModules, 'dsh-client-ui-layout/lib/client.js') },
  { stage: 'dsh-client-ui-sidebar.js', target: join(nodeModules, 'dsh-client-ui-sidebar/lib/client.js') },
  { stage: 'dsh-client-ui-conversation.js', target: join(nodeModules, 'dsh-client-ui-conversation/lib/client.js') },
]
for (const { stage: stageName, target } of clientBundles) {
  const rel = `client-bundles/${stageName}`
  const src = join(stage, rel)
  const backup = `${target}.novelcraft-orig`
  if (!existsSync(src)) {
    console.error(`[dsh-mobile] 缺少 stage 文件: ${src}`)
    process.exit(1)
  }
  const stageText = readFileSync(src, 'utf8')
  for (const marker of FILE_MARKERS[rel] ?? []) {
    if (!stageText.includes(marker)) {
      console.error(`[dsh-mobile] stage 防呆失败: ${rel} 缺标记 ${JSON.stringify(marker)} — 请复核补丁内容`)
      process.exit(1)
    }
  }
  if (!existsSync(target)) {
    console.error(`[dsh-mobile] 目标不存在: ${target}`)
    process.exit(1)
  }
  const cur = readFileSync(target, 'utf8')
  if (cur === stageText) {
    console.log(`[dsh-mobile] 已是补丁版, 跳过: ${rel}`)
    continue
  }
  const backupText = existsSync(backup) ? readFileSync(backup, 'utf8') : null
  if (backupText !== null && cur !== backupText) {
    console.error(`[dsh-mobile] ${rel} 与备份和 stage 均不一致 — 请 review 后重新基线化 stage, 再重放`)
    process.exit(1)
  }
  if (backupText === null) copyFileSync(target, backup)
  copyFileSync(src, target)
  console.log(`[dsh-mobile] 已应用: ${rel} (sha256 ${sha256(src).slice(0, 12)}…)`)
  changed += 1
}

// 前端 dist(shell 内核 + PWA 资源; 可选: 只有 build-frontend.mjs 产出后才部署)
const distSrc = join(stage, 'frontend-dist')
const distTarget = join(nodeModules, 'dsh-web-frontend/dist')
const distBackup = `${distTarget}.novelcraft-orig`
if (existsSync(join(distSrc, 'index.html'))) {
  if (!existsSync(distBackup)) {
    rmSync(distBackup, { recursive: true, force: true })
    // 目录复制 + 重命名实现备份(存在同名文件时 cp 会失败, 故先 rm)
    execFileSync('cp', ['-R', distTarget, distBackup])
    console.log('[dsh-mobile] 已备份前端 dist -> dist.novelcraft-orig')
  }
  rmSync(distTarget, { recursive: true, force: true })
  mkdirSync(distTarget, { recursive: true })
  execFileSync('cp', ['-R', `${distSrc}/.`, distTarget])
  console.log('[dsh-mobile] 已部署前端 dist(shell + PWA 资源)')
  changed += 1
} else {
  console.log('[dsh-mobile] 未发现 stage/frontend-dist, 跳过前端(先跑 build-frontend.mjs)')
}

console.log(changed === 0
  ? '[dsh-mobile] 无需变更。'
  : `[dsh-mobile] 完成, 共 ${changed} 项。宿主补丁需重启 dsh web 生效; 客户端 UI 刷新页面即生效。`)
