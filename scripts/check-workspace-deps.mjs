#!/usr/bin/env node
/** Workspace 发布依赖检查：TypeScript AST/Scanner 提取静态与动态 ESM specifier。 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { extname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = process.env.CHECK_DEPS_ROOT
  ? resolvePath(process.env.CHECK_DEPS_ROOT)
  : fileURLToPath(new URL('..', import.meta.url))
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs'])
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])
const TEST_DIR_NAMES = new Set(['test', '__tests__'])
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/

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
      if (!entry.isDirectory() || (suffix && !entry.name.endsWith(suffix))) continue
      const dir = join(base, entry.name)
      if (statSync(join(dir, 'package.json'), { throwIfNoEntry: false })?.isFile()) dirs.push(dir)
    }
  }
  return dirs.sort()
}

function collectSources(srcDir) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || (entry.isDirectory() && TEST_DIR_NAMES.has(entry.name))) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (SOURCE_EXTS.has(extname(entry.name)) && !TEST_FILE_RE.test(entry.name)) files.push(full)
    }
  }
  walk(srcDir)
  return files
}

function literalValue(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

/** AST 覆盖合法 ESM；Scanner 仅补现有自测锁定的 legacy `import `x`` 容错形态。 */
function extractPackages(source, fileName = 'source.tsx') {
  const out = new Set()
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX
    : fileName.endsWith('.js') || fileName.endsWith('.mjs') ? ts.ScriptKind.JS
      : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind)
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const value = literalValue(node.moduleSpecifier)
      if (value !== undefined) out.add(value)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const value = literalValue(node.arguments[0])
      if (value !== undefined) out.add(value)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const value = literalValue(node.argument.literal)
      if (value !== undefined) out.add(value)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, kind === ts.ScriptKind.TSX ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, source)
  let previous = ts.SyntaxKind.Unknown
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.ImportKeyword && previous !== ts.SyntaxKind.DotToken) {
      const next = scanner.scan()
      if (next === ts.SyntaxKind.NoSubstitutionTemplateLiteral) out.add(scanner.getTokenValue())
      previous = next
      continue
    }
    previous = token
  }
  return out
}

function packageName(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec) || BUILTINS.has(spec)) return null
  if (spec.startsWith('@')) {
    const parts = spec.split('/')
    return parts[0] && parts[1] ? `${parts[0]}/${parts[1]}` : null
  }
  return spec.split('/')[0] || null
}

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
    { src: "import 'a-side'\nimport { b } from 'b-from'", expect: ['a-side', 'b-from'] },
    { src: "import 's1'; import { x } from 'p1'; import 's2'", expect: ['s1', 'p1', 's2'] },
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
  console.log(`check-workspace-deps self-test: ${cases.length}/${cases.length} 通过(TypeScript AST/Scanner)。`)
}

function main() {
  runSelfTest()
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const violations = []
  let filesChecked = 0
  for (const wsDir of expandWorkspaces(rootPkg.workspaces ?? [])) {
    const pkg = JSON.parse(readFileSync(join(wsDir, 'package.json'), 'utf8'))
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
      for (const spec of extractPackages(readFileSync(file, 'utf8'), file)) {
        const name = packageName(spec)
        if (!name || prod.has(name)) continue
        violations.push({
          name,
          rel: relative(ROOT, file).split(sep).join('/'),
          kind: dev.has(name) ? '仅声明在 devDependencies' : '完全未声明',
        })
      }
    }
  }
  if (violations.length > 0) {
    console.error(`check-workspace-deps: 发现 ${violations.length} 处发布依赖违规(扫描 ${filesChecked} 个 src 文件):\n`)
    for (const violation of violations) console.error(`  ✗ ${violation.name} — 导入于 ${violation.rel}(${violation.kind})`)
    console.error('\n请将该包加入对应 workspace 的发布依赖；devDependencies 不能掩盖发布依赖。')
    process.exit(1)
  }
  console.log(`check-workspace-deps: OK — ${filesChecked} 个 src 文件, 全部 bare import 均已声明为发布依赖。`)
}

main()
