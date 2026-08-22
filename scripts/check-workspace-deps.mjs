#!/usr/bin/env node
/**
 * check-workspace-deps.mjs —— workspace 发布依赖卫生检查。
 *
 * 对每个 npm workspace 递归扫描其 `src` 下的 .ts/.tsx/.js/.mjs,
 * 抽取 bare import/export/dynamic-import/side-effect-import 字面量的包名,
 * 要求包名出现在该 workspace 的 dependencies / peerDependencies /
 * optionalDependencies 中 (devDependencies 单独存在不能掩盖发布依赖:
 * 发布后 consumer 无法解析)。
 *
 * 覆盖形态(脚本内自测逐条锁定, 见 runSelfTest):
 * - 静态 import:    `import { a } from 'x'`
 * - 静态 re-export: `export { b } from 'x'` / `export * from 'x'`
 * - 动态 import:    `import('x')`(含 `=> import('x')` 紧邻 `>` 形态)
 * - side-effect:    `import 'x'`
 * - 跨行形态:       `import { a } from\n'x'` / `import\n'x'` —— 语句区间
 *   不以行尾截断, 否则换行分割的合法 ESM specifier 会漏检
 * - 纯字面模板 specifier: `import \`x\`` / `import(\`x\`)` / `export * from \`x\``
 *   (含 `${...}` 插值的模板无法静态定包名, 整体掩码不记录)
 *
 * 误报防护: 注释、字符串、模板(含插值)整体掩码后才匹配关键字; 字符串字面量
 * 掩码为占位, 只把紧跟 import/export 语句形态的字符串当作 specifier;
 * Node builtin(node: 前缀或 builtinModules)、相对路径、绝对路径、URL、# 别名
 * 一律忽略。JSX 文本(同行前置 `<` / 紧邻 `>` 的非动态形态)不当作导入。
 *
 * 测试隔离: 只扫描各 workspace 的 `src`(且跳过 test/__tests__ 目录与
 * *.test.* / *.spec.* 文件), 测试代码不参与发布依赖检查。
 *
 * 用法: node scripts/check-workspace-deps.mjs   (由根 `npm run check:deps` 调用)
 * 启动先跑内置自测(检测器不变量), 任一违规 → 打印 package/file 并以非零退出。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.CHECK_DEPS_ROOT
  ? resolvePath(process.env.CHECK_DEPS_ROOT)
  : fileURLToPath(new URL('..', import.meta.url))
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.mjs']
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
// 测试文件/目录名一律跳过(测试依赖不进发布面)。
const TEST_DIR_NAMES = new Set(['test', '__tests__'])
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/

/** 展开 workspace glob(支持 `dir/*` 形态), 返回含 package.json 的目录。 */
function expandWorkspaces(patterns) {
  const dirs = []
  for (const pattern of patterns) {
    const star = pattern.indexOf('*')
    if (star < 0) {
      if (statSync(join(ROOT, pattern), { throwIfNoEntry: false })?.isDirectory()) dirs.push(join(ROOT, pattern))
      continue
    }
    const base = join(ROOT, pattern.slice(0, star))
    const suffix = pattern.slice(star + 1)
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (!suffix || entry.name.endsWith(suffix)) {
        const dir = join(base, entry.name)
        if (statSync(join(dir, 'package.json'), { throwIfNoEntry: false })?.isFile()) dirs.push(dir)
      }
    }
  }
  return dirs.sort()
}

/** 递归收集 src 下的源文件(排除 test/__tests__ 目录与测试文件)。 */
function collectSources(srcDir) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      if (entry.isDirectory() && TEST_DIR_NAMES.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (SOURCE_EXTS.some((ext) => entry.name.endsWith(ext)) && !TEST_FILE_RE.test(entry.name)) {
        files.push(full)
      }
    }
  }
  walk(srcDir)
  return files
}

/**
 * 词法掩码: 返回 { masked, strings }。
 * - masked: 注释/模板字符串/字符串字面量全部替换为空格(保位), 关键字只在
 *   masked 的代码区匹配, 从而天然排除注释与模板文本误报。
 * - strings: 真实字符串字面量 { value, start, end }(按位置升序)。
 *   含 `${...}` 插值的模板不记录(无法静态定名); 无插值的纯字面模板记录,
 *   以支持 `import \`x\`` / `import(\`x\`)` / `export * from \`x\``。
 */
function maskSource(source) {
  const strings = []
  const chars = [...source]
  const blank = (from, to) => { for (let i = from; i < to; i++) chars[i] = ' ' }

  for (let i = 0; i < source.length;) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      blank(i, end < 0 ? source.length : end)
      i = end < 0 ? source.length : end
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) { blank(i, source.length); i = source.length }
      else { blank(i, end + 2); i = end + 2 }
    } else if (ch === '`') {
      // 模板字符串整体掩码(含 ${...} 插值)——模板文本不是 import specifier。
      let j = i + 1
      let interpolated = false
      while (j < source.length) {
        if (source[j] === '\\') j += 2
        else if (source[j] === '$' && source[j + 1] === '{') { interpolated = true; j += 2 }
        else if (source[j] === '`') { j++; break }
        else j++
      }
      if (!interpolated && j <= source.length && source[j - 1] === '`') {
        strings.push({ value: source.slice(i + 1, j - 1), start: i, end: j })
      }
      blank(i, j)
      i = j
    } else if (ch === "'" || ch === '"') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') j += 2
        else if (source[j] === ch) { j++; break }
        else j++
      }
      strings.push({ value: source.slice(i + 1, j - 1), start: i, end: j })
      blank(i, j)
      i = j
    } else {
      i++
    }
  }
  return { masked: chars.join(''), strings }
}

/** 找从 `from` 起的下一个字符串字面量(仅允许空白/掩码区在前)。 */
function nextString(from, strings) {
  return strings.find((s) => s.start >= from)
}

/**
 * 抽取一个语句区间的 specifier:
 * - 语句区间 = 关键字位置到下一个顶层 `;`(括号深度 0)或 EOF —— 不以 `\n` 截断,
 *   否则 `import {a} from\n'x'` / `import\n'x'` 的换行 specifier 会漏检。
 * - `from`(`\bfrom\b` 词边界, 避免 fromStatus/const from=/from: 等标识符)后紧跟
 *   字符串 → 取该字符串; 关键字到字符串之间必须纯空白(`=`/`:`/`,`/`)` 等残留
 *   标点会拒掉标识符用法)。
 * - 静态 side-effect import(`import 'x'`)→ 关键字之后、语句之内第一个字符串,
 *   且关键字与字符串之间必须纯空白。
 * - `export ... from 'x'` → `from` 后字符串。
 * - JSX 文本: 关键字同行前置 `<`(如 `<p> import ...`)即放弃。
 * - from-candidate 隔离: 关键字与 from 之间若已出现字符串字面量(如
 *   `import 'a'\nimport {b} from 'x'` 里前一语句的 side-effect specifier),
 *   该 from 属于后续语句, 跳过 —— 防止 side-effect 导入被错误归属到后一个
 *   import 的 from 包名上(会漏报它自己的缺失依赖)。
 */
function statementSpecifier(start, end, masked, strings, keywordEnd) {
  // 同行前置 `<`: JSX 文本形态 `<p> import 'x' from 'y'</p>`(含空格)。
  const lineStart = masked.lastIndexOf('\n', start - 1) + 1
  if (masked.slice(lineStart, start).includes('<')) return null

  const span = masked.slice(start, end)
  const firstStringStart = nextString(start, strings)?.start ?? Infinity
  const fromRe = /\bfrom\b/g
  let fm
  while ((fm = fromRe.exec(span)) !== null) {
    const before = span.slice(0, fm.index)
    if (before.includes('<')) return null
    // 关键字与 from 之间已有字符串 → 该 from 属后续语句, 不是本语句的。
    if (firstStringStart < start + fm.index) continue
    const s = nextString(start + fm.index + 4, strings)
    if (!s || s.start >= end) continue
    // `from` 与字符串之间必须纯空白: `from = 'x'`/`from: 'x'`/`['mv', from, to]`
    // 均残留 `=`/`:`/`,` 等标点而被拒。
    const between = masked.slice(start + fm.index + 4, s.start)
    if (/^\s*$/.test(between)) return s
  }
  // 无 `from` 的静态导入只可能是 `import 'x'`(side-effect):
  // 关键字与字符串之间必须纯空白(自 keywordEnd 起测)。
  const s = nextString(keywordEnd, strings)
  if (s && s.start < end) {
    const seg = masked.slice(keywordEnd, s.start)
    if (/^\s*$/.test(seg)) return s
  }
  return null
}

/** 语句区间: 从 start 到下一个顶层 `;`(括号深度 0)或 EOF。 */
function statementEnd(start, masked) {
  let depth = 0
  for (let i = start; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === ';') return i
  }
  return masked.length
}

/** 从源码抽取全部 bare 包名。 */
function extractPackages(source) {
  const { masked, strings } = maskSource(source)
  const packages = new Set()
  const kwRe = /\b(import|export)\b/g
  let m
  while ((m = kwRe.exec(masked)) !== null) {
    const kw = m[1]
    const kwStart = m.index
    const kwEnd = kwRe.lastIndex
    // 属性访问形态(obj.import / obj?.export): 关键字前是 `.` 时跳过。
    if (kwStart > 0 && masked[kwStart - 1] === '.') continue
    const after = masked.slice(kwEnd)

    if (kw === 'import') {
      // import.meta 不是动态导入。
      if (after.startsWith('.')) continue
      // 动态导入: import('literal')。仅消费到 `(` 为止——尾随 `\s*` 贪婪吞掉
      // 掩码空白(字符串也被掩成空格)会越过真实 specifier。
      const dyn = /^\s*\(/.exec(after)
      if (dyn) {
        const s = nextString(kwEnd + dyn[0].length, strings)
        if (!s) continue
        const tail = masked.slice(s.end).match(/^\s*/)[0]
        if (masked[s.end + tail.length] === ')') packages.add(s.value)
        continue
      }
      // JSX 文本守卫: 紧邻 `>` 且非动态导入形态(如 `<p>import 'x'</p>`)——
      // 必须放在动态导入之后, 否则 `()=>import('x')` 会被误当作 JSX 文本跳过。
      if (kwStart > 0 && masked[kwStart - 1] === '>') continue
    }
    const end = statementEnd(kwStart, masked)
    const spec = statementSpecifier(kwStart, end, masked, strings, kwEnd)
    if (spec) packages.add(spec.value)
  }
  return packages
}

/** 裸 specifier → 包名; 非 bare 返回 null。 */
function packageName(spec) {
  if (!spec || spec.length === 0) return null
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return null // URL / scheme 形态
  if (BUILTINS.has(spec)) return null
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    if (parts.length < 2 || !parts[0] || !parts[1]) return null
    return `${parts[0]}/${parts[1]}`
  }
  const first = spec.split('/')[0]
  return first || null
}

/**
 * 内置自测: 锁定四类导入形态(static import/export · dynamic import ·
 * side-effect import)+ 换行/注释/模板/`=> import()` 变体 + 反向控制(注释/
 * 插值模板/属性访问/import.meta/JSX 文本不得误报)。不触碰任何 workspace。
 * 任一用例失败 → 打印差异并非零退出(检测器不变量被破坏, 禁止静默继续)。
 */
function runSelfTest() {
  const cases = [
    { src: "import { a } from 'pkg-static'", expect: ['pkg-static'] },
    { src: "export { b } from 'pkg-export'", expect: ['pkg-export'] },
    { src: "export * from 'pkg-export-star'", expect: ['pkg-export-star'] },
    { src: "const d = await import('pkg-dynamic')", expect: ['pkg-dynamic'] },
    { src: "import 'pkg-side'", expect: ['pkg-side'] },
    { src: "import\n  'pkg-side-nl'", expect: ['pkg-side-nl'] },
    { src: "import { a } from\n  'pkg-from-nl'", expect: ['pkg-from-nl'] },
    { src: "export { b } from\n  'pkg-export-nl'", expect: ['pkg-export-nl'] },
    { src: "import(/* c */ 'pkg-dyn-comment')", expect: ['pkg-dyn-comment'] },
    { src: "const f = () => import('pkg-dyn-arrow')", expect: ['pkg-dyn-arrow'] },
    { src: "const t = import(`pkg-dyn-tpl`)", expect: ['pkg-dyn-tpl'] },
    { src: "import `pkg-tpl`", expect: ['pkg-tpl'] },
    { src: "export * from `pkg-export-tpl`", expect: ['pkg-export-tpl'] },
    // side-effect 与后续 from 语句隔离: 前一句的 specifier 不得被归属到后一句的 from
    { src: "import 'a-side'\nimport { b } from 'b-from'", expect: ['a-side', 'b-from'] },
    { src: "import 's1'; import { x } from 'p1'; import 's2'", expect: ['s1', 'p1', 's2'] },
    // 反向控制: 上述形态之外一律不得误报
    { src: "// import 'x'\nimport { ok } from 'fine'", expect: ['fine'] },
    { src: "const s = `import 'x' from 'y'`", expect: [] },
    { src: "const s = `import ${x}`", expect: [] },
    { src: "const o = { import: 'x' }", expect: [] },
    { src: "obj.import('x')", expect: [] },
    { src: "import.meta.url", expect: [] },
    { src: "<p>import 'x' from 'y'</p>", expect: [] },
  ]
  let failed = 0
  for (const { src, expect } of cases) {
    const got = [...extractPackages(src)].sort()
    const want = [...expect].sort()
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed++
      console.error(`  ✗ self-test: ${JSON.stringify(src)}\n    期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)}`)
    }
  }
  if (failed > 0) {
    console.error(`check-workspace-deps self-test: ${failed}/${cases.length} 用例失败 — 检测器不变量被破坏, 中止。`)
    process.exit(1)
  }
  console.log(`check-workspace-deps self-test: ${cases.length}/${cases.length} 通过(static import/export · dynamic import · side-effect import · 换行/注释/模板/JSX 变体)。`)
}

function main() {
  runSelfTest()
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const violations = []
  let filesChecked = 0
  const found = new Map() // pkg -> Set<file>

  for (const wsDir of expandWorkspaces(rootPkg.workspaces ?? [])) {
    const pkgPath = join(wsDir, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const prod = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ])
    const dev = new Set(Object.keys(pkg.devDependencies ?? {}))
    const srcDir = join(wsDir, 'src')
    if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) continue

    for (const file of collectSources(srcDir)) {
      filesChecked++
      const source = readFileSync(file, 'utf8')
      for (const spec of extractPackages(source)) {
        const name = packageName(spec)
        if (!name) continue
        if (prod.has(name)) continue
        const rel = relative(ROOT, file).split(sep).join('/')
        const kind = dev.has(name) ? '仅声明在 devDependencies' : '完全未声明'
        violations.push({ name, rel, kind })
        if (!found.has(name)) found.set(name, new Set())
        found.get(name).add(rel)
      }
    }
  }

  if (violations.length > 0) {
    console.error(`check-workspace-deps: 发现 ${violations.length} 处发布依赖违规(扫描 ${filesChecked} 个 src 文件):\n`)
    for (const v of violations) {
      console.error(`  ✗ ${v.name} — 导入于 ${v.rel}(${v.kind})`)
    }
    console.error('\n请将该包加入对应 workspace 的 dependencies/peerDependencies/optionalDependencies(devDependencies 不能掩盖发布依赖)。')
    process.exit(1)
  }
  console.log(`check-workspace-deps: OK — ${filesChecked} 个 src 文件, 全部 bare import 均已声明为发布依赖。`)
}

main()