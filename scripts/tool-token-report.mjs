#!/usr/bin/env node
/**
 * 工具面 token 计量报告(N57/M13-E, Model Experience 三连的数据面)。
 *
 * 纪律:
 * - 零执行: 只构造 ToolDefinition(buildToolSegments 构造期零 I/O, service 以
 *   throw-proxy 传入——任何意外访问立即暴露), 绝不调用 execute;
 * - 有意识偏离 benchmark-read-paths 的「零 @deepseek-ai import」先例(N57 ②):
 *   计量对象本就是 dsh 工具面, 须 import workspace `@novelcraft/dsh/internal`;
 *   仅报告不进门禁, 不进 CI;
 * - 计量口径: description + parameters(JSON 序列化) 经 @novelcraft/context
 *   estimateContextTokens(与常驻状态面/编译器同一启发式)。
 *
 * 用法: npm run tools:report [-- --json]
 */
import { Context } from '@deepseek-ai/cordis'
import { buildToolSegments } from '@novelcraft/dsh/internal'
import { estimateContextTokens } from '@novelcraft/context'

const AS_JSON = process.argv.includes('--json')

const ctx = new Context()
// throw-proxy: 计量脚本不执行任何工具; 构造期若意外触达 service 立即抛错(防御自证)。
const service = new Proxy({}, {
  get() {
    throw new Error('tool-token-report: 构造期不得访问 service(计量面零执行纪律)')
  },
  has() {
    throw new Error('tool-token-report: 构造期不得探测 service')
  },
  ownKeys() {
    throw new Error('tool-token-report: 构造期不得枚举 service')
  },
})
const segments = buildToolSegments(ctx, service)

const rows = []
for (const segment of segments) {
  for (const tool of segment.tools) {
    const descriptionTokens = estimateContextTokens(tool.description ?? '')
    const schemaTokens = estimateContextTokens(JSON.stringify(tool.parameters ?? {}))
    rows.push({
      group: segment.group,
      name: tool.name,
      description_tokens: descriptionTokens,
      schema_tokens: schemaTokens,
      total_tokens: descriptionTokens + schemaTokens,
    })
  }
}

const groupSummary = [...new Set(rows.map((r) => r.group))].map((group) => {
  const groupRows = rows.filter((r) => r.group === group)
  return {
    group,
    tools: groupRows.length,
    total_tokens: groupRows.reduce((sum, r) => sum + r.total_tokens, 0),
  }
})
const total = rows.reduce((sum, r) => sum + r.total_tokens, 0)
const summary = {
  tools_total: rows.length,
  groups: groupSummary.length,
  grand_total_tokens: total,
  // 常驻参照(N53): 每会话常驻状态面预算缺省 600 tokens——工具面常驻成本约为其多少倍。
  resident_state_budget_default: 600,
  ratio_vs_resident_state: Number((total / 600).toFixed(1)),
}

if (AS_JSON) {
  console.log(JSON.stringify({ summary, group_summary: groupSummary, tools: rows }, null, 2))
} else {
  console.table(rows.map(({ group, name, description_tokens: d, schema_tokens: s, total_tokens: t }) =>
    ({ group, name, desc_tokens: d, schema_tokens: s, total: t })))
  console.table(groupSummary)
  console.log(
    `工具面合计: ${summary.tools_total} 个工具 / ${summary.grand_total_tokens} tokens(常驻每轮)` +
    `\n参照: 常驻创作状态面预算缺省 600 tokens(N53) —— 工具面 ≈ ${summary.ratio_vs_resident_state}× 该预算` +
    '\n纪律(N57 ①): v1 六组全默认开; 本报告仅计量, 不设门禁不做动态分域。',
  )
}
if (rows.length !== 39) {
  console.error(`tool-token-report: 工具计数 ${rows.length} ≠ 39(工具面漂移, 请核对四处硬清单)`)
  process.exit(1)
}
