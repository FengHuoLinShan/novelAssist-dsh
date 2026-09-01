#!/usr/bin/env node
/** Static N34/N36/N37/N49 distribution contract for private workspaces plus one public DSH bundle. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesRoot = join(root, 'packages', 'novelcraft')
const expectedEngine = '>=24.11.0'
const expectedDshVersion = '0.1.2-alpha.4'
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
const workspacePackages = new Map()
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
  workspacePackages.set(entry.name, pkg)
  workspaceNames.push(pkg.name)
  // DSH strips a trailing `/client` when resolving browser bundle ids.
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
if (rootPkg.scripts?.postinstall !== undefined) failures.push('root postinstall must not patch the DSH runtime')
const pluginPkg = JSON.parse(readFileSync(join(root, 'plugin', 'package.json'), 'utf8'))
if (pluginPkg.name !== 'novelcraft-dsh' || pluginPkg.private === true) failures.push('public plugin package must be novelcraft-dsh')
if (pluginPkg.publishConfig?.access !== 'public') failures.push('novelcraft-dsh must publish publicly')
if (pluginPkg.dsh?.bundle?.patch !== './cordis.patch.yml' || pluginPkg.dsh?.client?.platform !== 'web') {
  failures.push('novelcraft-dsh must declare both bundle and web client faces')
}
if (pluginPkg.dependencies !== undefined || pluginPkg.peerDependencies !== undefined) {
  failures.push('novelcraft-dsh must use the DSH installation runtime without profile-level dependency duplication')
}
const pluginInject = pluginPkg.dsh?.client?.inject ?? []
for (const dependency of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-host-apiproxy']) {
  if (pluginInject.includes(dependency)) failures.push(`novelcraft-dsh must not inject retired ${dependency}`)
}
for (const dependency of ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session']) {
  if (!pluginInject.includes(dependency)) failures.push(`novelcraft-dsh must inject current ${dependency}`)
}
const pluginPatch = readFileSync(join(root, 'plugin', 'cordis.patch.yml'), 'utf8')
if (!pluginPatch.includes('name: novelcraft-dsh') || !pluginPatch.includes('name: novelcraft-dsh/client-host')) {
  failures.push('novelcraft-dsh patch must mount both host faces')
}
for (const script of ['build:plugin', 'check:plugin', 'pack:plugin', 'publish:plugin']) {
  if (typeof rootPkg.scripts?.[script] !== 'string') failures.push(`missing root plugin release script: ${script}`)
}
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

for (const packageName of ['dsh', 'client', 'preset']) {
  const pkg = workspacePackages.get(packageName)
  for (const section of ['peerDependencies', 'devDependencies']) {
    for (const [dependency, requested] of Object.entries(pkg?.[section] ?? {})) {
      if (dependency.startsWith('@deepseek-ai/dsh-') && requested !== expectedDshVersion) {
        failures.push(`${pkg.name} must pin ${dependency} to ${expectedDshVersion} in ${section}`)
      }
      if (dependency === '@deepseek-ai/dsh-client-runtime' || dependency === '@deepseek-ai/dsh-host-apiproxy') {
        failures.push(`${pkg.name} must not depend on retired ${dependency}`)
      }
    }
  }
}

const presetRoot = join(packagesRoot, 'preset')
const presetPkg = JSON.parse(readFileSync(join(presetRoot, 'package.json'), 'utf8'))
for (const dependency of ['@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill']) {
  if (presetPkg.peerDependencies?.[dependency] !== expectedDshVersion) {
    failures.push(`@novelcraft/preset must pin ${dependency} to ${expectedDshVersion}`)
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

// N36/N37: default CI 只验证 optional 缺失与文本链降级，不构建/测试 BGE capability；
// 显式 bge-profile 才 include optional 并执行 rag-bge tests/audit。
const FULL_BUILD_ORDER = ['vault', 'trace', 'llm-step', 'memory', 'store', 'context', 'outline', 'rag', 'writing', 'imports', 'rag-bge', 'world', 'assistant', 'dsh', 'client']
const DEFAULT_BUILD_ORDER = FULL_BUILD_ORDER.filter((name) => name !== 'rag-bge')
const BGE_BUILD_ORDER = ['vault', 'llm-step', 'memory', 'store', 'rag', 'rag-bge']
const DEFAULT_WORKSPACES = DEFAULT_BUILD_ORDER.join(' ')
const packageDirByName = new Map([...workspacePackages].map(([dir, pkg]) => [pkg.name, dir]))

function validateWorkspaceOrder(order, label) {
  const out = []
  const positions = new Map(order.map((name, index) => [name, index]))
  for (const [name, position] of positions) {
    const pkg = workspacePackages.get(name)
    if (!pkg) {
      out.push(`${label}: unknown workspace ${name}`)
      continue
    }
    for (const dependency of Object.keys(pkg.dependencies ?? {})) {
      const dependencyDir = packageDirByName.get(dependency)
      if (dependencyDir === undefined) continue
      const dependencyPosition = positions.get(dependencyDir)
      if (dependencyPosition === undefined) {
        out.push(`${label}: ${name} requires omitted workspace ${dependencyDir}`)
      } else if (dependencyPosition >= position) {
        out.push(`${label}: ${dependencyDir} must precede ${name}`)
      }
    }
  }
  return out
}

const buildScript = readFileSync(join(root, 'scripts', 'build-topological.mjs'), 'utf8')
const buildOrderBlock = buildScript.match(/const order = \[([^\]]+)\]/)?.[1] ?? ''
const rootBuildOrder = [...buildOrderBlock.matchAll(/'([^']+)'/g)].map((match) => match[1])
if (JSON.stringify(rootBuildOrder) !== JSON.stringify(FULL_BUILD_ORDER)) {
  failures.push('root build order must equal the canonical full workspace order')
}
failures.push(...validateWorkspaceOrder(rootBuildOrder, 'root build order'))

function validateCiProfiles(text) {
  const out = []
  const pieces = text.split('\n  bge-profile:')
  if (pieces.length !== 2) return ['CI must contain exactly one bge-profile job']
  const [defaultCi, bgeCi] = pieces
  if (!/node-version:\s*24\.11\.0/.test(defaultCi) || /\bmatrix\b/.test(defaultCi)) {
    out.push('default CI must run exactly once on Node 24.11.0')
  }
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
  if (loops[0]) out.push(...validateWorkspaceOrder(loops[0].split(/\s+/), 'default CI build order'))
  if (/for p in[^\n]*\brag-bge\b/.test(defaultCi) || /run:\s*(?:\|\s*)?npm (?:test|run typecheck)\s*(?:\n|$)/.test(defaultCi)) {
    out.push('default CI must not run rag-bge or root test/typecheck')
  }
  if (!/npm test -w @novelcraft\/preset/.test(defaultCi)) out.push('default CI must test the source-only preset/Skill profile')
  if (!/node-version:\s*24\.11\.0/.test(bgeCi)) out.push('bge-profile must run on Node 24.11.0')
  if (!/npm ci --include=optional/.test(bgeCi)) out.push('bge-profile must install optional dependencies')
  const bgeBuildOrder = [...bgeCi.matchAll(/npm run build -w @novelcraft\/([^\s]+)/g)].map((match) => match[1])
  if (JSON.stringify(bgeBuildOrder) !== JSON.stringify(BGE_BUILD_ORDER)) {
    out.push('bge-profile must build the canonical RAG dependency closure in topological order')
  }
  out.push(...validateWorkspaceOrder(bgeBuildOrder, 'BGE CI build order'))
  if (!/npm test -w @novelcraft\/rag-bge(?:\s|$)/.test(bgeCi) || /npm test -w @novelcraft\/rag(?:\s|$)/.test(bgeCi)) {
    out.push('bge-profile must test only rag-bge; default CI already tests rag')
  }
  if (!/check-audit-baseline\.mjs --profile=bge/.test(bgeCi)) out.push('bge-profile must enforce the BGE audit baseline')
  return out
}

const ciText = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
failures.push(...validateCiProfiles(ciText))
const ciMutations = [
  ['default Node', 'node-version: 24.11.0', 'node-version: 22.19.0'],
  ['default install', 'npm ci --omit=optional', 'npm install'],
  ['default loops', DEFAULT_WORKSPACES, `${DEFAULT_WORKSPACES} rag-bge`],
  ['preset test', 'npm test -w @novelcraft/preset', 'echo skip-preset-test'],
  ['physical adapter absence', 'rm -f node_modules/@novelcraft/rag-bge', 'echo keep-rag-bge-link'],
  ['absence probe', "await import('@novelcraft/rag-bge')", "await import('@novelcraft/rag')"],
  ['BGE install', 'npm ci --include=optional', 'npm ci --omit=optional'],
  ['BGE build', 'npm run build -w @novelcraft/rag-bge', 'echo skip-rag-bge-build'],
  ['BGE test', 'npm test -w @novelcraft/rag-bge', 'npm test -w @novelcraft/rag'],
  ['BGE audit', 'node scripts/check-audit-baseline.mjs --profile=bge', 'echo skip-bge-audit'],
]
for (const [name, from, to] of ciMutations) {
  const mutated = ciText.replace(from, to)
  if (mutated === ciText || validateCiProfiles(mutated).length === 0) failures.push(`CI profile checker self-test failed: ${name}`)
}
for (const [name, order] of [
  ['store before memory', ['vault', 'store', 'memory']],
  ['writing before context', ['vault', 'memory', 'store', 'outline', 'writing', 'context']],
]) {
  if (validateWorkspaceOrder(order, `self-test ${name}`).length === 0) {
    failures.push(`workspace topology checker self-test failed: ${name}`)
  }
}

if (failures.length > 0) {
  console.error(`distribution profile failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`distribution profile OK: ${workspaceNames.length} private workspaces + novelcraft-dsh public bundle, node ${expectedEngine}, ${corePackages.size} core runtimes DSH-free`)
