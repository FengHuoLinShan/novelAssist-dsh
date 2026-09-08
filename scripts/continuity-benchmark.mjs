#!/usr/bin/env node
/**
 * 连续性基准(N54, M13-B 批 1): 错误注入 → core 检测器直调 → 分类捕获率矩阵。
 *
 * 纪律(N54 ③④):
 * - 零 @deepseek-ai import(只 import node:* 与 @novelcraft/* 工作区包);
 * - 只写 tmpdir(mkdtemp + finally rmSync), 不碰仓库与真实 Vault;
 * - vitest 不消费 catalog, 本脚本与各包行为测试双轨;
 * - MISS 不红(用户裁定 2026-09-08): 退出码只反映脚本自身失败;
 *   gap 条目 MISS 是诚实呈现(批 2 补检测器后转 PASS)。
 *
 * 用法: npm run bench:continuity [-- --json]
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initVault } from '@novelcraft/vault'
import { listSignals, runRadarSweep } from '@novelcraft/assistant'
import { parseFrontmatter, validateRelations } from '@novelcraft/store'
import { resolvePovKnowledgeContext } from '@novelcraft/writing'

const CATALOG_PATH = fileURLToPath(new URL('../evals/continuity-benchmark/catalog.json', import.meta.url))
const AS_JSON = process.argv.includes('--json')

/** 结构目录 → relations 校验的 sourceKind(store AssetKind 口径)。 */
const STRUCTURE_KIND_DIRS = [
  ['thread', 'structure/threads'],
  ['arc', 'structure/arcs'],
  ['foreshadowing', 'structure/foreshadowing'],
  ['reveal', 'structure/reveal'],
  ['scene', 'scenes'],
]

/** 基础种子(catalog.base_seed 声明形状): 3 章 + 一个全清洁 Scene, 五面雷达与六键全静默。 */
function seedBase(root) {
  for (let n = 1; n <= 3; n++) {
    writeFileSync(
      join(root, 'chapters', `${String(n).padStart(3, '0')}.md`),
      `---\nchapter_index: ${n}\nstatus: published\ncontent_hash: "hash-${n}"\ntitle: 第${n}章\n---\n`,
      'utf8',
    )
  }
  writeFileSync(
    join(root, 'scenes', 's000.md'),
    [
      '---',
      'id: s000',
      'status: draft',
      'title: 开场',
      'source: deep_import',
      'scene_index: 0',
      'chapter_ids: [1, 2, 3]',
      'reviewed_at: "2026-09-08T00:00:00Z"',
      'goal: 进入小镇',
      'core_conflict: 与守门人周旋',
      'must_happen: 拿到通行证',
      'must_not_happen: 暴露身份',
      '---',
      '',
    ].join('\n'),
    'utf8',
  )
}

/** 应用条目注入: files 写入(自动建父目录, 覆盖base), delete 删除。 */
function applyInject(root, inject) {
  if (!inject || typeof inject !== 'object') return
  // 相对路径 + 无 `..` 段: 与 core guardPath 纪律一致, catalog 是仓库内数据仍守界。
  const safeRel = (rel) => {
    if (typeof rel !== 'string' || rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) {
      fail(`catalog 注入路径非法(须为无 .. 的相对路径): ${rel}`)
    }
    return rel
  }
  for (const [relPath, content] of Object.entries(inject.files ?? {})) {
    const file = join(root, safeRel(relPath))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  for (const relPath of inject.delete ?? []) {
    const file = join(root, safeRel(relPath))
    if (existsSync(file)) unlinkSync(file)
  }
}

/** 收集本 vault 的 relations 校验问题(扫注入后的结构资产与 Scene 的 relations 字段)。
 * 口径注记: 顶层非递归枚举; core 索引对 structure/ 走递归(listFilesRecursive)——当前
 * catalog 全部平铺文件, 若未来注入子目录资产需改为递归(评审 P2-4 注记)。 */
function collectRelationIssues(root) {
  const issues = []
  for (const [kind, relDir] of STRUCTURE_KIND_DIRS) {
    const dir = join(root, relDir)
    if (!existsSync(dir)) continue
    // 与 core 扫描器同款枚举纪律: 只接收普通 .md 文件, 不跟随 symlink。
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const slug = entry.name.replace(/\.md$/, '')
      let data
      try {
        data = parseFrontmatter(readFileSync(join(dir, entry.name), 'utf8')).data
      } catch {
        continue // 坏 frontmatter 由各资产校验器负责, 本面只看 relations
      }
      if (Array.isArray(data.relations)) {
        issues.push(...validateRelations(root, kind, slug, data.relations))
      }
    }
  }
  return issues
}

/** 对注入后的 vault 跑全部确定性检测面, 收集可匹配工件。 */
function runDetectors(root, entry) {
  runRadarSweep(root)
  const signals = listSignals(root)
  const warnings = []
  if (typeof entry.inject?.pov_target_chapter === 'number') {
    warnings.push(...resolvePovKnowledgeContext(root, entry.inject.pov_target_chapter).warnings)
  }
  const relationIssues = collectRelationIssues(root)
  return { signals, warnings, relationIssues }
}

/** 判定: llm-only 只标注; covered/gap 按期望匹配器判 PASS/MISS。 */
function judge(entry, artifacts) {
  if (entry.class === 'llm-only') return 'LLM-ONLY'
  const expected = entry.expected ?? {}
  if (typeof expected.id_prefix === 'string') {
    return artifacts.signals.some((s) => s.id.startsWith(expected.id_prefix)) ? 'PASS' : 'MISS'
  }
  if (typeof expected.warning_code === 'string') {
    return artifacts.warnings.some((w) => w.code === expected.warning_code) ? 'PASS' : 'MISS'
  }
  if (typeof expected.issue_code === 'string') {
    return artifacts.relationIssues.some((i) => i.code === expected.issue_code) ? 'PASS' : 'MISS'
  }
  return 'NO-MATCHER' // catalog 缺匹配器: 脚本/目录契约破损, 诚实亮出
}

function fail(message) {
  console.error(`continuity-benchmark: ${message}`)
  process.exit(1)
}

// --- 主流程 ---
let catalog
try {
  catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
} catch (error) {
  fail(`catalog 读取/解析失败(${CATALOG_PATH}): ${error.message}`)
}
if (!Array.isArray(catalog.entries) || catalog.entries.length === 0) fail('catalog.entries 为空或非数组')

// 基础种子零信号自检(N54 语义前提, 评审 P1): 干净 base 上任何信号都是基线噪声,
// 会无声破坏 PASS/MISS 语义——唯一无其他警示通道的漂移面, 非空即败。
{
  const root = mkdtempSync(join(tmpdir(), 'nc-continuity-base-'))
  try {
    initVault(root, { title: '连续性基准', language: 'zh' })
    seedBase(root)
    runRadarSweep(root)
    const noise = listSignals(root).filter((s) => s.status === 'open')
    if (noise.length > 0) {
      fail(`基础种子不再零信号(基线噪声 ${noise.length} 条): ${noise.map((s) => s.id).join(', ')}——请修 seedBase 或核对 core 检测器新增面`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const VALID_CLASSES = new Set(['covered', 'gap', 'llm-only'])
const rows = []
for (const entry of catalog.entries) {
  if (!entry.id || !entry.class || !entry.expected) fail(`catalog 条目缺字段: ${JSON.stringify(entry).slice(0, 120)}`)
  if (!VALID_CLASSES.has(entry.class)) fail(`catalog 条目 class 非法(须 covered|gap|llm-only): ${entry.id} → ${entry.class}`)
  const root = mkdtempSync(join(tmpdir(), 'nc-continuity-'))
  try {
    initVault(root, { title: '连续性基准', language: 'zh' })
    seedBase(root)
    applyInject(root, entry.inject)
    const artifacts = runDetectors(root, entry)
    rows.push({
      id: entry.id,
      class: entry.class,
      kind: entry.expected.kind,
      result: judge(entry, artifacts),
      open_signals: artifacts.signals.filter((s) => s.status === 'open').length,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// --- 汇总 ---
const count = (cls, result) => rows.filter((r) => r.class === cls && r.result === result).length
const summary = {
  covered_total: rows.filter((r) => r.class === 'covered').length,
  covered_pass: count('covered', 'PASS'),
  covered_miss: count('covered', 'MISS'),
  gap_total: rows.filter((r) => r.class === 'gap').length,
  gap_miss: count('gap', 'MISS'),
  gap_premature_pass: count('gap', 'PASS'),
  llm_only_total: rows.filter((r) => r.class === 'llm-only').length,
  no_matcher: rows.filter((r) => r.result === 'NO-MATCHER').length,
}
// 守恒检查: 三类计数之和必须等于条目总数, 防拼写错误的 class 静默掉出所有汇总桶。
if (summary.covered_total + summary.gap_total + summary.llm_only_total !== catalog.entries.length) {
  fail('分类汇总守恒失败: 存在未知 class 条目')
}

if (AS_JSON) {
  console.log(JSON.stringify({ catalog_version: catalog.version, summary, entries: rows }, null, 2))
} else {
  console.table(rows.map(({ id, class: cls, kind, result }) => ({ id, class: cls, expected_kind: kind, result })))
  console.log('汇总(N54 ②: 仅报告, MISS 不红):')
  console.log(
    `  covered: ${summary.covered_pass}/${summary.covered_total} PASS` +
      (summary.covered_miss > 0 ? `  ⚠ covered-MISS=${summary.covered_miss}(检测器退化或目录漂移)` : '') +
      `\n  gap: ${summary.gap_miss}/${summary.gap_total} MISS(批 2 目标, 现状诚实呈现)` +
      (summary.gap_premature_pass > 0 ? `  ⚠ gap 提前 PASS=${summary.gap_premature_pass}(检测器已覆盖? 目录需改类)` : '') +
      `\n  llm-only: ${summary.llm_only_total} 条仅标注(需 LLM 语义判断, 付费评测受 N52 ③ 约束)` +
      (summary.no_matcher > 0 ? `  ⚠ NO-MATCHER=${summary.no_matcher}(catalog 缺匹配器)` : ''),
  )
}

if (summary.no_matcher > 0) fail('存在 NO-MATCHER 条目: catalog 与脚本匹配器契约破损')
