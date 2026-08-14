#!/usr/bin/env node
/**
 * dsh-mobile 前端构建: 在 deepseek-harness 源码克隆里安装依赖、构建客户端库与
 * web 前端, 然后把 apps/web/dist 产物流入 stage/frontend-dist, 供 apply.mjs 部署。
 *
 * 用法: node scripts/dsh-mobile/build-frontend.mjs
 * 环境变量:
 *   DSH_HARNESS_CHECKOUT  harness 源码克隆路径(默认: 与 novelAssist-dsh 同级的 deepseek-harness)
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const checkout = resolve(process.env.DSH_HARNESS_CHECKOUT ?? join(dirname(repoRoot), 'deepseek-harness'))

if (!existsSync(join(checkout, 'pnpm-workspace.yaml'))) {
  console.error(`[dsh-mobile] 未找到 harness 源码克隆: ${checkout}`)
  console.error('用 DSH_HARNESS_CHECKOUT 指定路径(需含 pnpm-workspace.yaml)。')
  process.exit(1)
}

const pnpm = (...args) => execFileSync('corepack', ['pnpm', '--dir', checkout, ...args], { stdio: 'inherit' })
const npm = (...args) => execFileSync('npm', [...args], { stdio: 'inherit', cwd: checkout })

console.log(`[dsh-mobile] harness checkout: ${checkout}`)
console.log('[dsh-mobile] 1/3 安装依赖(pnpm install)…')
pnpm('install', '--prefer-offline')

console.log('[dsh-mobile] 2/3 构建客户端库(build:lib:client)…')
npm('run', 'build:lib:client')

console.log('[dsh-mobile] 3/3 构建 web 前端(build:web)…')
npm('run', 'build:web')

const dist = join(checkout, 'apps/web/dist')
if (!existsSync(join(dist, 'index.html'))) {
  console.error(`[dsh-mobile] 构建产物缺失: ${dist}/index.html`)
  process.exit(1)
}

const out = join(here, 'stage/frontend-dist')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
execFileSync('cp', ['-R', `${dist}/.`, out])
const size = statSync(join(out, 'index.html')).size
console.log(`[dsh-mobile] 前端产物已就绪: ${out} (index.html ${size}B)`)

// 浏览器 UI 插件 bundle: 宿主经 /plugins/<id>/client.js 从全局安装包提供,
// vite dist 只含 shell 内核 — 移动端 UI 改动必须同时落地这三个 bundle。
const bundles = {
  'dsh-client-ui-layout.js': join(checkout, 'packages/client/ui-layout/lib/client.js'),
  'dsh-client-ui-sidebar.js': join(checkout, 'packages/client/ui-sidebar/lib/client.js'),
  'dsh-client-ui-conversation.js': join(checkout, 'packages/client/ui-conversation/lib/client.js'),
}
const bundleOut = join(here, 'stage/client-bundles')
rmSync(bundleOut, { recursive: true, force: true })
mkdirSync(bundleOut, { recursive: true })
for (const [name, source] of Object.entries(bundles)) {
  if (!existsSync(source)) {
    console.error(`[dsh-mobile] 客户端 bundle 缺失(先跑 build:lib:client): ${source}`)
    process.exit(1)
  }
  execFileSync('cp', [source, join(bundleOut, name)])
}
console.log(`[dsh-mobile] 客户端 UI bundle 已就绪: ${bundleOut}; 运行 apply.mjs 部署。`)
