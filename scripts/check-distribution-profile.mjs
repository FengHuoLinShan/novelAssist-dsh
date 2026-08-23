#!/usr/bin/env node
/** Static N34/N36 distribution contract for the source-only monorepo. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesRoot = join(root, 'packages', 'novelcraft')
const expectedEngine = '^22.19.0 || >=24.0.0'
const failures = []
const workspaceNames = []
const corePackageNames = [
  'vault', 'trace', 'store', 'llm-step', 'rag', 'rag-bge', 'memory',
  'world', 'context', 'outline', 'assistant', 'writing', 'imports',
]
const corePackages = new Set(corePackageNames)
const hostPackages = new Set(['dsh', 'client', 'preset'])
const expectedPackages = new Set([...corePackageNames, ...hostPackages])
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])
const isForbiddenPackage = (value) => typeof value === 'string' &&
  (value.startsWith('@deepseek-ai/') || value === '@novelcraft/dsh' || value.startsWith('@novelcraft/dsh/'))

function sourceFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(file))
    else if (entry.isFile() && !entry.name.endsWith('.d.ts') && sourceExtensions.has(extname(entry.name))) out.push(file)
  }
  return out
}

function deepseekRuntimeImports(file) {
  const source = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const found = []
  const constants = new Map()
  const requireAliases = new Set(['require'])

  const evalString = (node, seen = new Set()) => {
    if (!node) return undefined
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      return evalString(node.expression, seen)
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evalString(node.left, seen)
      const right = evalString(node.right, seen)
      return left === undefined || right === undefined ? undefined : left + right
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text
      for (const span of node.templateSpans) {
        const part = evalString(span.expression, seen)
        if (part === undefined) return undefined
        value += part + span.literal.text
      }
      return value
    }
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const next = new Set(seen)
      next.add(node.text)
      return constants.has(node.text) ? constants.get(node.text) : undefined
    }
    return undefined
  }

  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = evalString(node.initializer)
      if (value !== undefined) constants.set(node.name.text, value)
      if (ts.isIdentifier(node.initializer) && requireAliases.has(node.initializer.text)) requireAliases.add(node.name.text)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
               ts.isIdentifier(node.left) && ts.isIdentifier(node.right) && requireAliases.has(node.right.text)) {
      requireAliases.add(node.left.text)
    }
    ts.forEachChild(node, collect)
  }
  // A few passes resolve simple forward constant/alias chains deterministically.
  for (let i = 0; i < 4; i += 1) collect(sf)

  const literalPackage = (node) => evalString(node)
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const dependency = literalPackage(node.moduleSpecifier)
      if (isForbiddenPackage(dependency)) {
        const clause = node.importClause
        const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : []
        const onlyTypeBindings = clause?.name === undefined && named.length > 0 && named.every((item) => item.isTypeOnly)
        if (clause === undefined || (!clause.isTypeOnly && !onlyTypeBindings)) found.push(dependency)
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const dependency = literalPackage(node.moduleSpecifier)
      if (isForbiddenPackage(dependency)) {
        const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : []
        const onlyTypeBindings = named.length > 0 && named.every((item) => item.isTypeOnly)
        if (!node.isTypeOnly && !onlyTypeBindings) found.push(dependency)
      }
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly &&
               ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression) {
      const dependency = literalPackage(node.moduleReference.expression)
      if (isForbiddenPackage(dependency)) found.push(dependency)
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const directImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const directOrAliasedRequire = ts.isIdentifier(node.expression) && requireAliases.has(node.expression.text)
      const computedRequire = ts.isElementAccessExpression(node.expression) && evalString(node.expression.argumentExpression) === 'require'
      if (directImport || directOrAliasedRequire || computedRequire) {
        const dependency = literalPackage(node.arguments[0])
        if (isForbiddenPackage(dependency)) found.push(dependency)
        else if (dependency === undefined && node.arguments[0].getText(sf).includes('@deepseek-ai')) found.push('<dynamic @deepseek-ai expression>')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const jsxPragma = source.match(/@jsxImportSource\s+([^\s*]+)/)?.[1]
  if (isForbiddenPackage(jsxPragma)) found.push(jsxPragma)
  return found
}

const packageDirs = readdirSync(packagesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
const actualPackageNames = new Set(packageDirs.map((entry) => entry.name))
for (const expected of expectedPackages) {
  if (!actualPackageNames.has(expected)) failures.push(`missing required workspace directory: ${expected}`)
}
for (const actual of actualPackageNames) {
  if (!expectedPackages.has(actual)) failures.push(`unexpected workspace directory: ${actual}`)
}

for (const entry of packageDirs) {
  const file = join(packagesRoot, entry.name, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    failures.push(`${entry.name}: invalid or missing package.json (${String(error)})`)
    continue
  }
  workspaceNames.push(pkg.name)
  // rc.8 strips a trailing `/client` when resolving browser bundle ids.
  const expectedName = entry.name === 'client' ? '@novelcraft/dsh-client' : `@novelcraft/${entry.name}`
  if (pkg.name !== expectedName) failures.push(`${entry.name}: unexpected package name ${pkg.name}`)
  if (pkg.private !== true) failures.push(`${pkg.name}: private must be true`)
  if (pkg.engines?.node !== expectedEngine) failures.push(`${pkg.name}: engines.node must be ${expectedEngine}`)
  if (corePackages.has(entry.name)) {
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependency, requested] of Object.entries(pkg[section] ?? {})) {
        if (isForbiddenPackage(dependency) || (typeof requested === 'string' && requested.startsWith('npm:@deepseek-ai/'))) {
          failures.push(`${pkg.name}: forbidden ${section} entry ${dependency}@${requested}`)
        }
      }
    }
    for (const tree of ['src', 'dist']) {
      for (const sourceFile of sourceFiles(join(packagesRoot, entry.name, tree))) {
        for (const dependency of deepseekRuntimeImports(sourceFile)) {
          failures.push(`${sourceFile.slice(root.length + 1)}: forbidden core runtime import ${dependency}`)
        }
      }
    }
  }
}

if (workspaceNames.length !== 16) failures.push(`expected 16 workspaces, found ${workspaceNames.length}`)
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (rootPkg.private !== true) failures.push('root package must remain private')
if (rootPkg.engines?.node !== expectedEngine) failures.push(`root engines.node must be ${expectedEngine}`)
if (!Array.isArray(rootPkg.workspaces) || !rootPkg.workspaces.includes('packages/novelcraft/*')) {
  failures.push('root workspaces must include packages/novelcraft/*')
}
if (rootPkg.overrides !== undefined) failures.push('destructive root overrides are forbidden by N36')
const bgePkg = JSON.parse(readFileSync(join(packagesRoot, 'rag-bge', 'package.json'), 'utf8'))
if (bgePkg.optionalDependencies?.['@huggingface/transformers'] !== '4.2.0') {
  failures.push('@huggingface/transformers must be a pinned rag-bge optionalDependency')
}
if (bgePkg.dependencies?.['@huggingface/transformers'] !== undefined) {
  failures.push('@huggingface/transformers must not be a normal dependency')
}

const dshPkg = JSON.parse(readFileSync(join(packagesRoot, 'dsh', 'package.json'), 'utf8'))
if (dshPkg.optionalDependencies?.['@novelcraft/rag-bge'] === undefined || dshPkg.dependencies?.['@novelcraft/rag-bge'] !== undefined) {
  failures.push('@novelcraft/dsh must keep rag-bge in optionalDependencies only')
}

const presetRoot = join(packagesRoot, 'preset')
const presetPkg = JSON.parse(readFileSync(join(presetRoot, 'package.json'), 'utf8'))
for (const dependency of ['@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill']) {
  if (presetPkg.peerDependencies?.[dependency] !== '0.1.0-rc.8') {
    failures.push(`@novelcraft/preset must pin ${dependency} to D21 rc.8`)
  }
}
const activePresets = ['novelcraft-author', 'novelcraft-import-review', 'novelcraft-worldbuilder']
for (const preset of activePresets) {
  const text = readFileSync(join(presetRoot, 'presets', preset, 'agent.cordis.yml'), 'utf8')
  if (!text.includes('@deepseek-ai/dsh-skill-filesystem') || !text.includes('@deepseek-ai/dsh-tool-skill')) {
    failures.push(`${preset}: native Skill provider and consumer must both be mounted`)
  }
  if (/dsh-(?:tool-bash|terminal|fs-)/.test(text)) {
    failures.push(`${preset}: model-facing shell or raw filesystem is forbidden`)
  }
}
const skillEntries = readdirSync(join(presetRoot, 'skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(presetRoot, 'skills', entry.name, 'SKILL.md')))
if (skillEntries.length !== 9) failures.push(`@novelcraft/preset must ship exactly 9 Skill bundles, found ${skillEntries.length}`)

// N36: default CI 只验证 optional 缺失与文本链降级，不构建/测试 BGE capability；
// 显式 bge-profile 才 include optional 并执行 rag-bge tests/audit。
const DEFAULT_WORKSPACES = 'vault trace store llm-step rag memory outline writing imports world context assistant dsh client'
function validateCiProfiles(text) {
  const out = []
  const pieces = text.split('\n  bge-profile:')
  if (pieces.length !== 2) return ['CI must contain exactly one bge-profile job']
  const [defaultCi, bgeCi] = pieces
  if (!/node:\s*\[22\.19\.0,\s*24\.x\]/.test(defaultCi)) out.push('default CI must cover Node 22.19.0 and 24.x')
  if (!/npm ci --omit=optional/.test(defaultCi)) out.push('default CI must install with --omit=optional')
  if (!/@huggingface\/transformers/.test(defaultCi) || !/await import\('@novelcraft\/rag-bge'\)/.test(defaultCi)) {
    out.push('default CI must assert optional runtime chain and adapter are unavailable')
  }
  if (!/rm -f node_modules\/@novelcraft\/rag-bge/.test(defaultCi) || !/test ! -L node_modules\/@novelcraft\/rag-bge/.test(defaultCi)) {
    out.push('default CI must physically remove and verify absence of the optional rag-bge workspace link')
  }
  const loops = [...defaultCi.matchAll(/for p in ([^;\n]+); do/g)].map((m) => m[1].trim())
  if (loops.length !== 3 || loops.some((value) => value !== DEFAULT_WORKSPACES)) {
    out.push('default CI build/test/typecheck loops must equal the canonical non-BGE workspace set')
  }
  if (/for p in[^\n]*\brag-bge\b/.test(defaultCi) || /run:\s*(?:\|\s*)?npm (?:test|run typecheck)\s*(?:\n|$)/.test(defaultCi)) {
    out.push('default CI must not run rag-bge or root test/typecheck')
  }
  if (!/npm test -w @novelcraft\/preset/.test(defaultCi)) out.push('default CI must test the source-only preset/Skill profile')
  if (!/node-version:\s*24\.x/.test(bgeCi)) out.push('bge-profile must run on Node 24.x')
  if (!/npm ci --include=optional/.test(bgeCi)) out.push('bge-profile must install optional dependencies')
  if (!/npm run build -w @novelcraft\/rag\b/.test(bgeCi) || !/npm run build -w @novelcraft\/rag-bge\b/.test(bgeCi)) {
    out.push('bge-profile must build rag and rag-bge')
  }
  if (!/npm test -w @novelcraft\/rag -w @novelcraft\/rag-bge/.test(bgeCi)) out.push('bge-profile must test rag and rag-bge')
  if (!/check-audit-baseline\.mjs --profile=bge/.test(bgeCi)) out.push('bge-profile must enforce the BGE audit baseline')
  return out
}

const ciText = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
failures.push(...validateCiProfiles(ciText))
const ciMutations = [
  ['node matrix', 'node: [22.19.0, 24.x]', 'node: [20.x]'],
  ['default install', 'npm ci --omit=optional', 'npm install'],
  ['default loops', DEFAULT_WORKSPACES, `${DEFAULT_WORKSPACES} rag-bge`],
  ['preset test', 'npm test -w @novelcraft/preset', 'echo skip-preset-test'],
  ['physical adapter absence', 'rm -f node_modules/@novelcraft/rag-bge', 'echo keep-rag-bge-link'],
  ['absence probe', "await import('@novelcraft/rag-bge')", "await import('@novelcraft/rag')"],
  ['BGE install', 'npm ci --include=optional', 'npm ci --omit=optional'],
  ['BGE build', 'npm run build -w @novelcraft/rag-bge', 'echo skip-rag-bge-build'],
  ['BGE audit', 'node scripts/check-audit-baseline.mjs --profile=bge', 'echo skip-bge-audit'],
]
for (const [name, from, to] of ciMutations) {
  const mutated = ciText.replace(from, to)
  if (mutated === ciText || validateCiProfiles(mutated).length === 0) failures.push(`CI profile checker self-test failed: ${name}`)
}

if (failures.length > 0) {
  console.error(`distribution profile failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`distribution profile OK: ${workspaceNames.length} private workspaces, node ${expectedEngine}, ${corePackages.size} core runtimes DSH-free`)
