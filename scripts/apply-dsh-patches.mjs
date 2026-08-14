#!/usr/bin/env node
/**
 * 窄缝共享层补丁(ADR-0018 §1): 给 @deepseek-ai/dsh-api-remotes 的
 * API_REMOTE_FORWARDED_EVENTS allowlist 加一条通用 `client/push`, 使 host 插件能经
 * 既有 host/remote-event 通道向浏览器客户端推送自定义事件(ctx.remote.$on 消费)。
 *
 * 幂等; 目标数组形状变化时 fail-loud, 提示复核本补丁(对应 ADR-0018 的「升级时重放并复核」)。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const path = join(
  process.cwd(),
  'node_modules/@deepseek-ai/dsh-api-remotes/lib/index.js',
)

let src
try {
  src = readFileSync(path, 'utf8')
} catch {
  console.log(
    '[novelcraft] skip dsh patch: @deepseek-ai/dsh-api-remotes not installed yet',
  )
  process.exit(0)
}

if (src.includes('"client/push"')) {
  console.log('[novelcraft] dsh-api-remotes already patched (client/push present)')
  process.exit(0)
}

const needle = '\t"settings/document-updated"\n];'
if (!src.includes(needle)) {
  console.error(
    '[novelcraft] dsh-api-remotes allowlist shape changed — re-check ADR-0018 patch (needs re-base on this DSH version)',
  )
  process.exit(1)
}

writeFileSync(
  path,
  src.replace(needle, '\t"settings/document-updated",\n\t"client/push"\n];'),
)
console.log(
  '[novelcraft] applied dsh-api-remotes patch: +client/push in API_REMOTE_FORWARDED_EVENTS',
)
