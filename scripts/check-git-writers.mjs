#!/usr/bin/env node
/**
 * check-git-writers.mjs —— 业务 Git 写者卫生静态检查(TypeScript Compiler API AST 版)。
 *
 * 范围: 仅扫描 packages/novelcraft 下各包(src 目录; test/__tests__ 目录与
 * *.test.* /*.spec.* 文件、scripts/ 一律不扫; 扩展名 ts/tsx/js/jsx/mjs/cjs/mts/cts)。
 * 解析: 根 devDependency 的 TypeScript compiler API(ts.createSourceFile, 按扩展名选
 * ScriptKind)全量 AST 遍历 —— 不做词法掩码/正则结构匹配; 注释/字符串/正则字面量/
 * JSX 文本天然与代码区分, 不再有掩码类漏报误报。
 * 规矩(R17/R14「adopt = 一次原子 commit」的写者纪律; Wave2 已收敛, gate 常态为绿):
 *
 *   R1 禁止无参数/默认 `gitAdd(root)` —— 默认参数即 `['-A']`(全量扫描, 会捕获并发
 *      用户编辑/无关改动, 违反 R17「只提交本操作范围」)。业务调用必须传本批精确
 *      相对路径(gitAdd(root, relPaths) / 显式 pathspec 数组), 形态见已收敛的
 *      imports/src/commit.ts、alias-relation.ts、structure.ts、workspace.ts 与
 *      store/src/merge.ts。`gitAdd(root, undefined)`、`gitAdd(root, void 0)` 与
 *      尾逗号/注释省略(`gitAdd(root,)` / `gitAdd(root, /* x *\/)`)等价默认 -A,
 *      同属 R1 违规; pathspec 里的 '-A'/'--all'(字符串/模板/常量传播数组)为显式违规。
 *   R2 禁止业务代码中的 '-A'/'--all' 字面量 —— git add 全量扫描标记只允许出现在
 *      store/src/git.ts 的 gitAdd 实现默认值节点里; 业务调用显式传 -A/--all 与 R1
 *      同等违规。例外: 只读 git 参数数组上下文(如 `git log --all` 的 --all =
 *      「所有 refs」)不报; tracked child_process 调用的 options 参数(exec 第 2+ 参 /
 *      execFile 第 3+ 参)内容不扫(见 R3 切分)。判定基于 AST 节点 + 常量折叠,
 *      注释/字符串文本不误报。
 *   R3 禁止业务层直接 child_process 调 `git add`/`git commit` —— git 写必须收敛在
 *      store 事务实现(@novelcraft/store 的 adopt()/gitAdd(精确路径)+gitCommit() /
 *      ADR-0021 transaction)。绑定解析(AST): ESM import 具名/别名/命名空间/默认、
 *      import=require、CJS require(解构/命名空间/属性)、动态 import()(await 解构/
 *      命名空间)、const 别名/命名空间成员/解构/赋值别名(let x; x = execFileSync)、
 *      computed member(cp['execFileSync'])、命令/args 变量的可判定常量(const
 *      字符串/数组/模板/拼接, fixpoint 传播); 未在本文件声明的规范名
 *      exec/execSync/execFile/execFileSync/spawn/spawnSync/fork 按 child_process
 *      保守兜底。本地同名函数/变量、`.exec()` 等成员调用、正则字面量
 *      (/git add/.source、re.test)、字符串文本一律不误报。
 *      参数切分: exec/execSync 只看第一命令参数; execFile/execFileSync/spawn/
 *      spawnSync/fork 只看 command + args 数组(第二参); options(exec 第 2+ 参 /
 *      execFile 第 3+ 参, 含文档字符串/环境值/input)一律不扫。
 *      模板插值逐表达式遍历与常量折叠: `git ${'add'} ${f}` 插值可判定 → 静态即写;
 *      `git ${sub}` / `cd ${d} && git ${s}` / `git ${sub} --all` 子命令动态 →
 *      fail-closed 按写报; `git log ${sha}` / `git ${'status'}` 只读不报。
 *      动态未知且可能 git 写一律 fail-closed: exec 风格命令参数不可判定(该 API 无
 *      封装 seam)→ 按写报; execFile 风格 cmd 不可判定 → 按 args 判定(写形态/全动态
 *      按写报); execFile 风格 cmd='git' 且子命令位置不可判定为写(整体不可判定,
 *      或数组元素动态/只读)→ **sealed seam 形态**, 默认不报, 业务侧数组字面量内
 *      动态元素(`[sub]` / `[...x]`)照 fail-closed 报 —— 封装函数内的同类形态由
 *      允许表按节点形状精确豁免(见下)。只读 git 命令如 rev-parse/status/ls-files/
 *      log 不在禁止之列; `git init` 仅限 vault bootstrap。
 *
 * 精确允许表(ALLOWANCES —— 不是宽泛 allowlist, 逐条锚定 **AST 节点形状** = 文件 +
 * 规则 + 限定所在函数 + 节点形态(sealed seam: cmd 可判定恰为 'git' 且子命令不可
 * 判定为 add/commit), 不设整文件/整函数豁免; 允许函数内其它违规(含嵌套函数内的
 * 调用、可判定写形态)一律照报):
 *   1. store/src/git.ts —— GIT_ADD_SWEEP 仅限 gitAdd() 的 paths 参数默认值数组节点
 *      (paths: string[] = ['-A'], 当前树唯一); gitAdd 函数体内其它 '-A'、其它参数
 *      默认值、其它函数的 '-A' 一律照报。GIT_CP_WRITE 仅限 execFile() 内底层
 *      execFileSync('git', args) 唯一节点(git CLI 唯一封层)。
 *   2. store/src/transaction/git-transaction.ts —— GIT_CP_WRITE 仅限 gitExec() /
 *      assertSharedIndexClean() 内底层 execFileSync('git', args) 节点(ADR-0021/N32
 *      事务原语实现; gitExecUnpinned() 的 args 为自身参数, 属整体不可判定 seam,
 *      规则本就不触发, 不进表)。
 *   3. store/src/transaction/execute.ts —— GIT_CP_WRITE 仅限 git()/gitOk() 薄封装内
 *      底层 execFileSync('git', args) 节点(事务编排实现)。
 *   4. vault/src/index.ts —— GIT_CP_WRITE 仅限 runGit()/gitSucceeds() 内底层
 *      execFileSync('git', ['--no-replace-objects', '--no-optional-locks',
 *      ...(args as string[])]) 节点(vault bootstrap 封装, 参数动态); 内联
 *      `git init` 子命令只读不触发。
 *
 * Wave2 已收敛: 业务 src 全部 gitAdd 均已改传本批精确相对路径(含 adopt.ts 事务内
 * 4 处历史形态), 默认(gate)模式零违规即通过, 常态为绿; 未来业务写一律以默认模式
 * 为准, --report 仅用于人工排查。任何新增业务写绕过都会在允许表节点形状之外照报,
 * 无需改动本脚本。
 *
 * 用法:
 *   node scripts/check-git-writers.mjs            # gate: 违规 → 打印清单, 退出 1
 *   node scripts/check-git-writers.mjs --report   # 可读违规清单(信息性, 退出 0)
 *   node scripts/check-git-writers.mjs --help
 *
 * 启动先跑内置自测(锁定 R1–R3 检测器不变量与允许表节点形状语义, 含全部复审对抗
 * 用例与正/反向用例); 任一失败 → 禁止继续扫描。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NOVELCRAFT_DIR = join(ROOT, 'packages', 'novelcraft')
const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
// 测试目录/文件不扫(用户约定: test/scripts 不扫; src 内残留测试目录也防御性跳过)。
const TEST_DIR_NAMES = new Set(['test', '__tests__'])
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/

const RULE = {
  GIT_ADD_SWEEP: 'GIT_ADD_SWEEP',
  GIT_CP_WRITE: 'GIT_CP_WRITE',
}

/** git add 全量扫描标记: -A 及其长形式 --all, 只允许存在于 store gitAdd 默认值节点。 */
const SWEEP_STRINGS = new Set(['-A', '--all'])

/**
 * node:child_process 函数名 → 调用风格(绑定别名继承原函数风格):
 * - 'exec'    风格: exec / execSync —— 第一参是命令串;
 * - 'execfile'风格: execFile / execFileSync / spawn / spawnSync / fork —— 第一参是命令,
 *   第二参是参数数组。
 */
const CP_STYLE = new Map([
  ['exec', 'exec'],
  ['execSync', 'exec'],
  ['execFile', 'execfile'],
  ['execFileSync', 'execfile'],
  ['spawn', 'execfile'],
  ['spawnSync', 'execfile'],
  ['fork', 'execfile'],
])
const CP_FN_NAMES = new Set(CP_STYLE.keys())
const CP_MODULE_IDS = new Set(['node:child_process', 'child_process'])

/**
 * 只读 git 子命令: 以其为首的参数数组里出现 -A/--all 是只读标志(如 `git log --all`
 * 的 --all = 所有 refs), 不是 add 全量扫描标记, R2 不报。
 */
const READONLY_GIT_SUBCOMMANDS = new Set([
  'log', 'status', 'rev-parse', 'show', 'ls-files', 'diff', 'branch', 'tag', 'remote',
  'config', 'symbolic-ref', 'rev-list', 'cat-file', 'ls-tree', 'merge-base', 'describe',
  'blame', 'grep', 'for-each-ref', 'show-ref', 'check-ignore', 'check-attr', 'help',
  'version', 'shortlog', 'whatchanged', 'count-objects', 'fsck', 'notes', 'reflog',
  'stash', 'verify-commit', 'verify-tag', 'name-rev', 'interpret-trailers',
])

/** 取值的 git 全局选项(其后一个数组元素是它的值, 不是子命令/路径)。 */
const VALUE_OPTIONS = new Set([
  '-c', '--git-dir', '--work-tree', '--namespace', '--git-common-dir',
  '--object-directory', '--alternate-object-directories', '--config-env',
])

const GIT_TS_PATH = 'packages/novelcraft/store/src/git.ts'

/**
 * 精确允许表: file = 相对仓库根的完整路径(精确匹配) + rule + 限定所在函数
 * (enclosingFunctionName 必须完全等于 withinFunction) + 节点形态(sealed seam:
 * cmd 可判定恰为 'git' 且子命令位置不可判定为 add/commit)。不设整文件豁免 ——
 * 允许函数之外(含未来新增)的调用照常报告; 允许函数内的其它(可判定写)调用同样照报。
 */
const ALLOWANCES = [
  {
    file: GIT_TS_PATH,
    rule: RULE.GIT_CP_WRITE,
    withinFunction: 'execFile',
    reason:
      '低层封装定义: git CLI 唯一封层 execFile() 内唯一的底层 execFileSync(\'git\', args, …) ' +
      '节点(sealed seam)。该函数内任何可判定写形态的调用、嵌套函数内调用照报。',
  },
  {
    file: GIT_TS_PATH,
    rule: RULE.GIT_ADD_SWEEP,
    withinFunction: 'gitAdd',
    reason:
      '默认 [-A] 只允许出现在 gitAdd 的 paths 参数默认值数组节点(paths: string[] = ' +
      '[\'-A\'])内; gitAdd 体内其它 \'-A\'、其它参数默认值、其它函数一律照报。',
  },
  {
    file: 'packages/novelcraft/store/src/transaction/git-transaction.ts',
    rule: RULE.GIT_CP_WRITE,
    withinFunction: 'gitExec',
    reason:
      'transaction 实现(N32/ADR-0021 §6): gitExec() 封装内底层 execFileSync(\'git\', args, …) ' +
      '节点(args = [...pinArgs(ctx), ...opts.args], 子命令不可判定为写; 私有 index/' +
      'exact tree/commit-tree/update-ref CAS)。',
  },
  {
    file: 'packages/novelcraft/store/src/transaction/git-transaction.ts',
    rule: RULE.GIT_CP_WRITE,
    withinFunction: 'assertSharedIndexClean',
    reason:
      'transaction 实现: assertSharedIndexClean() 内底层 execFileSync(\'git\', args, …) 节点' +
      '(args = [...pinArgs(ctx), \'diff\', …], 子命令经 pinArgs 后为只读 diff 探测)。',
  },
  {
    file: 'packages/novelcraft/store/src/transaction/execute.ts',
    rule: RULE.GIT_CP_WRITE,
    withinFunction: 'git',
    reason:
      'transaction 实现: git() 薄封装内底层 execFileSync(\'git\', args, …) 节点' +
      '(业务写面禁用 git add -A)。',
  },
  {
    file: 'packages/novelcraft/store/src/transaction/execute.ts',
    rule: RULE.GIT_CP_WRITE,
    withinFunction: 'gitOk',
    reason:
      'transaction 实现: gitOk() 探测封装内底层 execFileSync(\'git\', args, …) 节点' +
      '(exit 判定专用, 只读探测)。',
  },
  {
    file: 'packages/novelcraft/vault/src/index.ts',
    rule: RULE.GIT_CP_WRITE,
    withinFunction: 'runGit',
    reason:
      'vault bootstrap 封装: runGit() 内底层 execFileSync(\'git\', [\'--no-replace-objects\', ' +
      '\'--no-optional-locks\', ...(args as string[])], …) 节点(参数动态, 子命令不可判定为写; ' +
      'bootstrap 的 hash-object/update-index/write-tree/commit-tree/update-ref 在此收敛)。',
  },
  {
    file: 'packages/novelcraft/vault/src/index.ts',
    rule: RULE.GIT_CP_WRITE,
    withinFunction: 'gitSucceeds',
    reason:
      'vault bootstrap 封装: gitSucceeds() 内底层 execFileSync(\'git\', [\'--no-replace-objects\', ' +
      '\'--no-optional-locks\', ...(args as string[])], …) 节点(exit 判定专用, 只读探测)。',
  },
]

/** 收集 packages/novelcraft/<pkg>/src 下的全部候选文件。 */
function collectScannedFiles() {
  const files = []
  const pkgs = readdirSync(NOVELCRAFT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  for (const pkg of pkgs) {
    const srcDir = join(NOVELCRAFT_DIR, pkg, 'src')
    if (!statSync(srcDir, { throwIfNoEntry: false })?.isDirectory()) continue
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        if (entry.isDirectory() && TEST_DIR_NAMES.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (
          SOURCE_EXTS.some((ext) => entry.name.endsWith(ext)) &&
          !TEST_FILE_RE.test(entry.name)
        ) {
          files.push(full)
        }
      }
    }
    walk(srcDir)
  }
  return files
}

/** 扩展名 → ts.ScriptKind(ts/tsx/js/jsx/mjs/cjs/mts/cts 全支持)。 */
function scriptKindOf(relPath) {
  if (relPath.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (relPath.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (relPath.endsWith('.ts') || relPath.endsWith('.mts') || relPath.endsWith('.cts')) {
    return ts.ScriptKind.TS
  }
  return ts.ScriptKind.JS
}

/** 函数/方法类节点。 */
function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/** 函数节点 → 名称(匿名箭头/函数表达式向上找 const/属性名)。 */
function functionLikeName(fn) {
  if (fn.name) return fn.name.text
  let p = fn.parent
  while (p) {
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p)
    ) {
      p = p.parent
      continue
    }
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(p.left)) {
      return p.left.text
    }
    break
  }
  return ''
}

/** node 所在的最近函数节点(函数作用域判定用); 不在任何函数内返回 null。 */
function enclosingFunctionNode(node) {
  let cur = node
  while (cur && cur.parent) {
    cur = cur.parent
    if (isFunctionLike(cur)) return cur
  }
  return null
}

/** node 所在的最近具名函数名; 不在任何函数内返回 ''。 */
function enclosingFunctionName(node) {
  let cur = node
  while (cur && cur.parent) {
    cur = cur.parent
    if (isFunctionLike(cur)) return functionLikeName(cur)
  }
  return ''
}

// ---------------------------------------------------------------------------
// 绑定环境: 哪些标识符来自 node:child_process(函数/命名空间), 以及可判定常量。
// ---------------------------------------------------------------------------

/**
 * 表达式 → 绑定形态(只用于「标识符是否 child_process」判定, 与常量折叠分离):
 * - { kind: 'ns' }   模块命名空间(import * as / 默认 import / require / import() /
 *                    import=require / 别名);
 * - { kind: 'fn', style }   child_process 函数(具名导入/解构/成员/computed/别名);
 * - null             未绑定/本地/不可判定。
 */
function exprKind(expr, fns, namespaces) {
  let e = expr
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e))
  ) {
    e = e.expression
  }
  if (!e) return null
  if (ts.isIdentifier(e)) {
    if (fns.has(e.text)) return { kind: 'fn', style: fns.get(e.text) }
    if (namespaces.has(e.text)) return { kind: 'ns' }
    return null
  }
  if (ts.isPropertyAccessExpression(e)) {
    if (ts.isIdentifier(e.name) && CP_STYLE.has(e.name.text)) {
      const obj = exprKind(e.expression, fns, namespaces)
      if (obj && obj.kind === 'ns') return { kind: 'fn', style: CP_STYLE.get(e.name.text) }
    }
    return null
  }
  if (ts.isElementAccessExpression(e)) {
    const idx = e.argumentExpression
    if (idx && (ts.isStringLiteral(idx) || ts.isNoSubstitutionTemplateLiteral(idx)) && CP_STYLE.has(idx.text)) {
      const obj = exprKind(e.expression, fns, namespaces)
      if (obj && obj.kind === 'ns') return { kind: 'fn', style: CP_STYLE.get(idx.text) }
    }
    return null
  }
  if (ts.isCallExpression(e)) {
    if (ts.isIdentifier(e.expression) && e.expression.text === 'require') {
      const mod = e.arguments[0]
      if (mod && (ts.isStringLiteral(mod) || ts.isNoSubstitutionTemplateLiteral(mod)) && CP_MODULE_IDS.has(mod.text)) {
        return { kind: 'ns' }
      }
    }
    if (e.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const mod = e.arguments[0]
      if (mod && (ts.isStringLiteral(mod) || ts.isNoSubstitutionTemplateLiteral(mod)) && CP_MODULE_IDS.has(mod.text)) {
        return { kind: 'ns' }
      }
    }
    return null
  }
  if (ts.isAwaitExpression(e)) return exprKind(e.expression, fns, namespaces)
  return null
}

/**
 * 收集 child_process 绑定:
 * - fns: Map<标识符, 'exec'|'execfile'>(确定为 child_process 函数及调用风格,
 *   别名绑定继承风格);
 * - namespaces: 确定为 child_process 模块(成员如 cp.execFileSync)的标识符;
 * - declInit: 变量名 → 同函数作用域初始化表达式列表(常量折叠用, 首个声明为准;
 *   按所在函数节点区分作用域 —— 不同函数的同名 const 互不串扰)。
 * 支持 ESM import 具名/别名/命名空间/默认、import=require、CJS require 解构/
 * 命名空间/属性、动态 import()(await 解构/命名空间)、const/let 别名与赋值别名
 * (fixpoint)、computed member; 未在本文件声明的规范名按 child_process 保守兜底
 * (防 import 形态漏网; 本地同名声明抑制兜底)。
 */
function buildEnv(sf) {
  const fns = new Map()
  const namespaces = new Set()
  const localDecls = new Set()
  const declInit = new Map() // name → [{ init, scope }]
  const aliasSources = [] // { name, expr }: const 初始化 / 赋值 / 参数默认值
  const destructures = [] // { name, prop, srcExpr }: 从 ns/require 解构

  const addAlias = (name, expr) => aliasSources.push({ name, expr })

  const visit = (node, scope) => {
    if (ts.isImportDeclaration(node)) {
      const mod = node.moduleSpecifier
      if (mod && ts.isStringLiteral(mod) && CP_MODULE_IDS.has(mod.text)) {
        const clause = node.importClause
        if (clause) {
          if (clause.name) namespaces.add(clause.name.text) // 默认导入(CJS 互操作)
          const nb = clause.namedBindings
          if (nb) {
            if (ts.isNamespaceImport(nb)) {
              namespaces.add(nb.name.text)
            } else {
              for (const spec of nb.elements) {
                if (spec.isTypeOnly) continue
                const orig = spec.propertyName ? spec.propertyName.text : spec.name.text
                if (CP_STYLE.has(orig)) fns.set(spec.name.text, CP_STYLE.get(orig))
              }
            }
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const mr = node.moduleReference
      if (
        mr &&
        ts.isExternalModuleReference(mr) &&
        mr.expression &&
        ts.isStringLiteral(mr.expression) &&
        CP_MODULE_IDS.has(mr.expression.text)
      ) {
        namespaces.add(node.name.text)
      }
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          localDecls.add(decl.name.text)
          if (decl.initializer) {
            if (!declInit.has(decl.name.text)) declInit.set(decl.name.text, [])
            const entries = declInit.get(decl.name.text)
            if (!entries.some((e) => e.scope === scope)) entries.push({ init: decl.initializer, scope })
            const k = exprKind(decl.initializer, fns, namespaces)
            if (k && k.kind === 'ns') namespaces.add(decl.name.text)
            else if (k && k.kind === 'fn') fns.set(decl.name.text, k.style)
            else addAlias(decl.name.text, decl.initializer)
          }
        } else if (ts.isObjectBindingPattern(decl.name)) {
          const src = decl.initializer
          if (src) {
            for (const el of decl.name.elements) {
              if (el.dotDotDotToken) continue
              const prop = el.propertyName
                ? ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)
                  ? el.propertyName.text
                  : null
                : ts.isIdentifier(el.name)
                  ? el.name.text
                  : null
              if (prop && CP_STYLE.has(prop)) destructures.push({ name: el.name.text, prop, srcExpr: src })
            }
          }
        }
      }
    } else if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression)) {
      const b = node.expression
      if (b.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(b.left)) {
        addAlias(b.left.text, b.right)
      }
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      localDecls.add(node.name.text)
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.initializer) {
      addAlias(node.name.text, node.initializer)
    }
    ts.forEachChild(node, (child) => visit(child, isFunctionLike(child) ? child : scope))
  }
  visit(sf, null)

  // 未声明未绑定的规范名 → 保守兜底(真实文件均 import 自 node:child_process)。
  // 须在 fixpoint 之前: 别名(const efs = execFileSync / 赋值)依赖兜底绑定参与解析。
  for (const [n, style] of CP_STYLE) {
    if (!localDecls.has(n)) fns.set(n, style)
  }

  // fixpoint: 别名/解构依赖的绑定可能晚于使用点声明(或依赖其它别名)。
  for (let iter = 0; iter < 8; iter++) {
    let changed = false
    for (const { name, expr } of aliasSources) {
      const k = exprKind(expr, fns, namespaces)
      if (k && k.kind === 'ns' && !namespaces.has(name)) {
        namespaces.add(name)
        changed = true
      } else if (k && k.kind === 'fn' && !fns.has(name)) {
        fns.set(name, k.style)
        changed = true
      }
    }
    for (const { name, prop, srcExpr } of destructures) {
      if (fns.has(name)) continue
      const k = exprKind(srcExpr, fns, namespaces)
      if (k && k.kind === 'ns' && CP_STYLE.has(prop)) {
        fns.set(name, CP_STYLE.get(prop))
        changed = true
      }
    }
    if (!changed) break
  }

  return { fns, namespaces, declInit }
}

/** 调用表达式 → 是否为 child_process 函数调用及其风格; 非追踪调用返回 null。 */
function resolveCallee(expr, env) {
  const k = exprKind(expr, env.fns, env.namespaces)
  if (k && k.kind === 'fn') return { style: k.style }
  return null
}

// ---------------------------------------------------------------------------
// 常量折叠: 命令/args 变量的可判定常量(字符串/数组/模板/拼接, 经 declInit 传播)。
// ---------------------------------------------------------------------------

/**
 * 表达式 → 折叠值:
 * - { str }        可判定字符串(字面量/无插值模板/常量标识符/拼接/全折叠模板);
 * - { tmpl }       带不可判定插值的模板 { staticText, first, decPrefix, unknown };
 * - { arr }        可判定数组(元素为折叠值; 元素可为 { unknown }/{ void });
 * - { regex }      正则字面量(明确不是命令/参数字符串);
 * - { void }       undefined / void 0;
 * - null           不可判定(参数/调用/其它)。
 */
function foldExpr(expr, env, depth = 0, seen = new Set()) {
  if (depth > 16) return null
  let e = expr
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isSatisfiesExpression(e) ||
      ts.isNonNullExpression(e) ||
      ts.isTypeAssertionExpression(e))
  ) {
    e = e.expression
  }
  if (!e) return null
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return { str: e.text }
  if (ts.isNumericLiteral(e)) return { str: String(e.text) }
  if (ts.isRegularExpressionLiteral(e)) return { regex: true }
  if (ts.isTemplateExpression(e)) return foldTemplate(e, env, depth, seen)
  if (ts.isArrayLiteralExpression(e)) {
    const items = []
    for (const el of e.elements) {
      if (ts.isSpreadElement(el)) {
        const f = foldExpr(el.expression, env, depth + 1, seen)
        if (f && f.arr) items.push(...f.arr)
        else items.push({ unknown: true })
      } else if (ts.isOmittedExpression(el)) {
        items.push({ void: true })
      } else {
        items.push(foldExpr(el, env, depth + 1, seen) ?? { unknown: true })
      }
    }
    return { arr: items }
  }
  if (ts.isIdentifier(e)) {
    if (e.text === 'undefined') return { void: true }
    const entries = env.declInit.get(e.text)
    if (entries) {
      const scope = enclosingFunctionNode(e)
      const entry = entries.find((en) => en.scope === scope)
      const init = entry && entry.init
      if (init && !seen.has(e.text)) {
        const s2 = new Set(seen)
        s2.add(e.text)
        return foldExpr(init, env, depth + 1, s2)
      }
    }
    return null
  }
  if (ts.isElementAccessExpression(e)) {
    const obj = foldExpr(e.expression, env, depth + 1, seen)
    const idx = foldExpr(e.argumentExpression, env, depth + 1, seen)
    if (obj && obj.arr && idx && idx.str && /^\d+$/.test(idx.str)) {
      const item = obj.arr[Number(idx.str)]
      if (!item) return null
      if (item.str) return { str: item.str }
      if (item.tmpl) return { tmpl: item.tmpl }
      if (item.arr) return { arr: item.arr }
      return null
    }
    return null
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldExpr(e.left, env, depth + 1, seen)
    const r = foldExpr(e.right, env, depth + 1, seen)
    if (l && l.str && r && r.str) return { str: l.str + r.str }
    if (l && l.str && !r) return { tmpl: { staticText: l.str, first: l.str, decPrefix: l.str, unknown: true } }
    if (r && r.str && !l) return { tmpl: { staticText: r.str, first: '', decPrefix: '', unknown: true } }
    return null
  }
  if (ts.isVoidExpression(e)) return { void: true }
  if (ts.isAwaitExpression(e)) return foldExpr(e.expression, env, depth + 1, seen)
  return null
}

/** 带插值模板折叠: 全部插值可判定 → { str }; 否则 { tmpl }。 */
function foldTemplate(t, env, depth, seen) {
  let staticText = t.head.text
  let decPrefix = t.head.text
  let known = true
  for (const span of t.templateSpans) {
    const f = foldExpr(span.expression, env, depth + 1, seen)
    if (f && f.str) {
      staticText += f.str
      if (known) decPrefix += f.str
    } else {
      known = false
    }
    staticText += span.literal.text
    if (known) decPrefix += span.literal.text
  }
  if (known) return { str: staticText }
  return { tmpl: { staticText, first: t.head.text, decPrefix, unknown: true } }
}

/** 数组元素节点列表 → 折叠元素列表。 */
function foldElements(elements, env) {
  const items = []
  for (const el of elements) {
    if (ts.isSpreadElement(el)) {
      const f = foldExpr(el.expression, env)
      if (f && f.arr) items.push(...f.arr)
      else items.push({ unknown: true })
    } else if (ts.isOmittedExpression(el)) {
      items.push({ void: true })
    } else {
      items.push(foldExpr(el, env) ?? { unknown: true })
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// 调用分类: exec 首参命令串 / execFile command+args 子命令(逐元素、跳过全局选项)。
// ---------------------------------------------------------------------------

const GIT_CMD_RE = /^git(\.exe)?(\s|$)/
const WRITE_CMD_RE = /^git(\.exe)?\s+(add|commit)\b/

/**
 * execFile 风格第二参(折叠元素列表)的子命令判定:
 * - 跳过省略元素、全局选项与取值选项('-c' 等消费其值参数);
 * - 首个非选项元素 = 子命令: 'add'/'commit' → write; 其他字面量 → read;
 * - 插值模板: 静态/首字面量即 add/commit → write; 首字面量为空(完全动态) →
 *   dynamic(fail-closed); 数组内不可判定元素/展开 → dynamic(fail-closed);
 * - 正则字面量 → read(明确不是子命令字符串)。
 */
function subcommandOf(items) {
  let skipNext = false
  for (const it of items) {
    if (it.void) continue
    if (skipNext) {
      skipNext = false
      continue
    }
    if (it.str) {
      if (VALUE_OPTIONS.has(it.str)) {
        skipNext = true
        continue
      }
      if (it.str.startsWith('-')) continue
      if (it.str === 'add' || it.str === 'commit') return { kind: 'write', value: it.str }
      return { kind: 'read', value: it.str }
    }
    if (it.regex) return { kind: 'read', value: '' }
    if (it.tmpl) {
      const t = it.tmpl
      if (t.staticText === 'add' || t.staticText === 'commit') {
        return { kind: 'write', value: t.staticText, dynamic: true }
      }
      if (t.first === 'add' || t.first === 'commit') {
        return { kind: 'write', value: t.first, dynamic: true }
      }
      if (t.first === '') return { kind: 'dynamic' }
      if (t.staticText.startsWith('-')) continue
      return { kind: 'read', value: t.staticText }
    }
    if (it.unknown) return { kind: 'dynamic' }
    return { kind: 'read', value: '' }
  }
  return { kind: 'read', value: '' }
}

/** exec 风格命令(折叠值)的 git 写判定(模板插值逐表达式遍历, fail-closed)。 */
function execCommandResult(sf, f, argNode) {
  const text = () => {
    const t = argNode.getText(sf).replace(/\s+/g, ' ').trim()
    return t.length > 160 ? t.slice(0, 160) + '…' : t
  }
  if (f && f.str) {
    if (GIT_CMD_RE.test(f.str) && WRITE_CMD_RE.test(f.str)) {
      return { kind: 'write', dynamic: false, detail: `命令串 '${f.str}' 是直接 git add/commit 写操作` }
    }
    return { kind: 'read' }
  }
  if (f && f.regex) return { kind: 'read' }
  if (f && f.tmpl) {
    const { staticText: st, decPrefix: dp } = f.tmpl
    const addCommit = /(^|[;&|]+\s*)\s*git(\.exe)?\s+(add|commit)\b/
    const gitTail = /(^|[;&|]+\s*)\s*git(\.exe)?\s*$/
    if (addCommit.test(st) || addCommit.test(dp)) {
      return { kind: 'write', dynamic: false, detail: `插值模板命令 '\`${text()}\`' 静态即 git add/commit 写操作` }
    }
    if (gitTail.test(st) || gitTail.test(dp)) {
      return { kind: 'write', dynamic: true, detail: `插值模板命令 '\`${text()}\`' 子命令动态(无法证明只读, fail-closed 按写报)` }
    }
    if (/^\s*$/.test(dp) || /^\s*$/.test(st)) {
      return { kind: 'write', dynamic: true, detail: `插值模板命令 '\`${text()}\`' 命令头动态(无法证明只读, fail-closed 按写报)` }
    }
    return { kind: 'read' }
  }
  if (f && f.void) return { kind: 'read' }
  // 命令参数不可判定(exec 风格无封装 seam)→ fail-closed。
  return { kind: 'write', dynamic: true, detail: `exec 风格命令参数不可判定(无封装 seam, 可能 git add/commit, fail-closed 按写报): ${text()}` }
}

/** 子命令判定结果 → R3 写/读结果。 */
function subToResult(sub) {
  if (sub.kind === 'write') {
    return {
      kind: 'write',
      dynamic: !!sub.dynamic,
      detail: sub.dynamic
        ? `git 子命令为动态形态(可能 add/commit, fail-closed 按写报)`
        : `child_process 直调 git ${sub.value}(绕过 store seam)`,
    }
  }
  if (sub.kind === 'dynamic') {
    return { kind: 'write', dynamic: true, detail: 'git 子命令为动态形态(可能 add/commit, fail-closed 按写报)' }
  }
  return { kind: 'read' }
}

/** 取表达式的折叠「参数数组元素」视图; 不可判定(整体 opaque)→ null。 */
function argsItemsView(f, env) {
  if (!f) return null
  if (f.arr) return f.arr
  if (f.str) return [{ str: f.str }]
  if (f.tmpl) return [{ tmpl: f.tmpl }]
  if (f.regex) return [{ regex: true }]
  if (f.void) return [{ void: true }]
  return null
}

/**
 * 追踪调用 → 是否 git 写(style = 'exec'|'execfile', 别名已继承原函数风格):
 * - exec 风格: 只看第一命令参数(折叠/插值遍历/fail-closed); options 不扫;
 * - execfile 风格: 只看 command + args 数组; options(第 3+ 参)不扫;
 *   命令名必须可判定为 'git'('git.exe'); 第一参本身是 git add/commit 命令串
 *   (误用形态)直接报; cmd 不可判定 → 按 args 判定(fail-closed);
 *   cmd='git' 且子命令位置不可判定为写 → sealed seam, 不报(允许表锚定形态)。
 */
function classifyCpCall(sf, env, node, style) {
  const args = node.arguments
  if (style === 'exec') {
    if (args.length < 1) return { kind: 'read' }
    const f = foldExpr(args[0], env)
    return execCommandResult(sf, f, args[0])
  }

  if (args.length < 1) return { kind: 'read' }
  const cmd = foldExpr(args[0], env)

  // 第一参本身是 git add/commit 命令串(execFile 误用为命令串形态)
  if (cmd && cmd.str) {
    if (GIT_CMD_RE.test(cmd.str) && WRITE_CMD_RE.test(cmd.str)) {
      return { kind: 'write', dynamic: false, detail: `命令串 '${cmd.str}' 是直接 git add/commit 写操作` }
    }
    if (!/^(git|git\.exe)$/.test(cmd.str)) return { kind: 'read' }
  } else if (cmd && cmd.tmpl) {
    if (!/^(git|git\.exe)$/.test(cmd.tmpl.staticText)) return { kind: 'read' }
  } else if (cmd && cmd.regex) {
    return { kind: 'read' }
  } else if (cmd && cmd.void) {
    return { kind: 'read' }
  } else {
    // cmd 不可判定 → 按 args 判定(fail-closed)
    const items = args.length >= 2 ? argsItemsView(foldExpr(args[1], env), env) : null
    if (items) {
      const sub = subcommandOf(items)
      if (sub.kind === 'write' || sub.kind === 'dynamic') {
        return {
          kind: 'write',
          dynamic: true,
          detail: `execFile 风格命令变量不可判定且 args 含 git ${sub.kind === 'write' ? sub.value : '动态'} 形态(无法证明只读, fail-closed 按写报)`,
        }
      }
      return { kind: 'read' }
    }
    return { kind: 'write', dynamic: true, detail: 'execFile 风格命令与参数均不可判定(无法证明只读, fail-closed 按写报)' }
  }

  // cmd 可判定为 'git'
  if (args.length < 2) return { kind: 'read' }
  let arg1 = args[1]
  while (arg1 && (ts.isParenthesizedExpression(arg1) || ts.isAsExpression(arg1))) arg1 = arg1.expression
  if (!arg1) return { kind: 'read' }

  if (ts.isArrayLiteralExpression(arg1)) {
    return subToResult(subcommandOf(foldElements(arg1.elements, env)))
  }
  const items = argsItemsView(foldExpr(arg1, env), env)
  if (items) return subToResult(subcommandOf(items))
  // cmd='git' 且 args 整体不可判定 → sealed seam(store/vault 封装形态), 不报。
  return { kind: 'seam' }
}

/** gitAdd 调用 → R1 违规形态(noarg/undefined/void 0/显式 sweep); 合法返回 null。 */
function classifyGitAdd(sf, env, call) {
  const args = call.arguments
  if (args.length < 2) {
    return {
      kind: 'noarg',
      detail:
        '无参数 gitAdd(root) 走默认 -A(全量扫描, 会捕获并发用户编辑/无关改动, 违反 R17 范围语义); 仿 imports/src/commit.ts 改为 gitAdd(root, 本批精确相对路径)。',
    }
  }
  let arg1 = args[1]
  while (arg1 && (ts.isParenthesizedExpression(arg1) || ts.isAsExpression(arg1))) arg1 = arg1.expression
  if (!arg1) return null
  if (ts.isIdentifier(arg1) && arg1.text === 'undefined') {
    return { kind: 'noarg', detail: 'gitAdd(root, undefined) 等价默认 -A(全量扫描, 违反 R17 范围语义); 传本批精确相对路径数组。' }
  }
  if (ts.isVoidExpression(arg1)) {
    const f = foldExpr(arg1.expression, env)
    if (f && f.str === '0') {
      return { kind: 'noarg', detail: 'gitAdd(root, void 0) 等价默认 -A(全量扫描, 违反 R17 范围语义); 传本批精确相对路径数组。' }
    }
    return null
  }
  const f = foldExpr(arg1, env)
  let sweeps = []
  if (f && f.arr) {
    sweeps = f.arr.filter(
      (it) => (it.str && SWEEP_STRINGS.has(it.str)) || (it.tmpl && !it.tmpl.unknown && SWEEP_STRINGS.has(it.tmpl.staticText)),
    )
  } else if (f && f.str && SWEEP_STRINGS.has(f.str)) {
    sweeps = [{ str: f.str }]
  } else if (f && f.tmpl && !f.tmpl.unknown && SWEEP_STRINGS.has(f.tmpl.staticText)) {
    sweeps = [{ tmpl: { staticText: f.tmpl.staticText } }]
  }
  if (sweeps.length > 0) {
    const names = sweeps.map((s) => (s.str ?? s.tmpl.staticText).trim())
    return {
      kind: 'explicit',
      detail: `gitAdd(…[${names.map((v) => `'${v}'`).join('/')}]) 显式全量扫描标记; 改为传本批精确相对路径数组(gitAdd(root, relPaths))。`,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// R2 上下文判定(只读 git 参数数组 / options 参数 / gitAdd 默认值节点)。
// ---------------------------------------------------------------------------

/** 折叠元素列表 → 首个「有效」字符串元素(跳过省略/取值选项/全局选项); 动态/无 → null。 */
function firstMeaningfulElement(items) {
  let skipNext = false
  for (const it of items) {
    if (it.void) continue
    if (skipNext) {
      skipNext = false
      continue
    }
    if (it.str) {
      if (VALUE_OPTIONS.has(it.str)) {
        skipNext = true
        continue
      }
      if (it.str.startsWith('-')) continue
      return it.str
    }
    return null
  }
  return null
}

/**
 * sweep 字面量是否处于「只读 git 参数数组」上下文: 所在数组字面量首个有效元素为
 * 只读子命令(如 ['log', '--all'] 的 --all = 所有 refs)→ 该 -A/--all 是只读标志,
 * 非 git add 全量扫描标记, R2 不报。遇调用/函数/文件边界即停。
 */
function readonlyGitArgsArray(sf, env, lit) {
  let cur = lit.parent
  while (cur) {
    if (ts.isArrayLiteralExpression(cur)) {
      const first = firstMeaningfulElement(foldElements(cur.elements, env))
      return first !== null && READONLY_GIT_SUBCOMMANDS.has(first)
    }
    if (ts.isCallExpression(cur) || ts.isNewExpression(cur) || isFunctionLike(cur) || ts.isSourceFile(cur)) {
      return false
    }
    cur = cur.parent
  }
  return false
}

/**
 * sweep 字面量是否位于 tracked child_process 调用的 options 参数里(exec 第 2+ 参 /
 * execFile 第 3+ 参)。选项内容(文档字符串/环境值/input)一律不扫(R3 参数切分)。
 */
function inOptionsArg(sf, env, lit) {
  let cur = lit.parent
  while (cur) {
    if (ts.isCallExpression(cur) || ts.isNewExpression(cur)) {
      const res = ts.isCallExpression(cur) ? resolveCallee(cur.expression, env) : null
      if (res) {
        const args = cur.arguments
        const optsStart = res.style === 'exec' ? 1 : 2
        const litStart = lit.getStart(sf)
        for (let i = optsStart; i < args.length; i++) {
          if (litStart >= args[i].getStart(sf) && lit.end <= args[i].end) return true
        }
      }
      // 非 tracked 调用(或不在 options 里)继续向上找外层调用
      cur = cur.parent
      continue
    }
    if (isFunctionLike(cur) || ts.isSourceFile(cur) || ts.isClassDeclaration(cur)) return false
    cur = cur.parent
  }
  return false
}

/**
 * sweep 字面量是否恰为 store/src/git.ts gitAdd 的 paths 参数默认值数组节点
 * (paths: string[] = ['-A'])。允许表锚定节点形状 —— 函数体内其它 '-A' 不在其内。
 */
function isGitAddDefaultSweep(lit, relPath) {
  if (relPath !== GIT_TS_PATH) return false
  let cur = lit.parent
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur))) cur = cur.parent
  if (!cur || !ts.isArrayLiteralExpression(cur)) return false
  const param = cur.parent
  return (
    !!param &&
    ts.isParameter(param) &&
    ts.isIdentifier(param.name) &&
    param.name.text === 'paths' &&
    !!param.parent &&
    ts.isFunctionDeclaration(param.parent) &&
    !!param.parent.name &&
    param.parent.name.text === 'gitAdd'
  )
}

/**
 * 是否为允许表锚定的 sealed seam 调用节点: cmd 可判定恰为 'git' 且子命令位置
 * 不可判定为 add/commit —— args 整体不可判定, 或 args 折叠数组/数组字面量的首个
 * 「有效」元素为动态/只读(含封装内拼装: [...pinArgs(ctx), ...opts.args] /
 * ['--no-replace-objects', ...(args as string[])] 等)。可判定写形态不在其内。
 */
function isSeamShape(sf, env, node) {
  const args = node.arguments
  if (args.length < 2) return false
  const cmd = foldExpr(args[0], env)
  if (!cmd || !(cmd.str && /^(git|git\.exe)$/.test(cmd.str))) return false
  let arg1 = args[1]
  while (arg1 && (ts.isParenthesizedExpression(arg1) || ts.isAsExpression(arg1))) arg1 = arg1.expression
  if (!arg1) return false
  if (ts.isArrayLiteralExpression(arg1)) {
    return subcommandOf(foldElements(arg1.elements, env)).kind !== 'write'
  }
  const items = argsItemsView(foldExpr(arg1, env), env)
  if (items) return subcommandOf(items).kind !== 'write'
  return true // args 整体不可判定
}

// ---------------------------------------------------------------------------
// 单文件分析
// ---------------------------------------------------------------------------

/** 索引 → { line, col }(1 起)。 */
function lineColOf(sf, source, index) {
  const p = sf.getLineAndCharacterOfPosition(index)
  return { line: p.line + 1, col: p.character + 1 }
}

/** 原文件该行文本(trim 后, 供报告展示)。 */
function snippetOf(source, index) {
  const upTo = source.slice(0, index)
  const from = upTo.lastIndexOf('\n') + 1
  const to = source.indexOf('\n', from)
  return source.slice(from, to < 0 ? source.length : to).trim()
}

/**
 * 单文件分析 → violations[]:
 *   { rule, line, col, snippet, detail, spanStart, node }
 * 允许表精确过滤(文件 + 规则 + 所在函数 + 节点形状), 不做整文件豁免。
 */
function analyzeSource(source, relPath) {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, scriptKindOf(relPath))
  const env = buildEnv(sf)
  const violations = []
  const coveredSpans = [] // 已定责调用区间(start..end): 区间内 -A 不再重复报(R2 去重)

  const calls = []
  const gitAddCalls = []
  const sweepLiterals = []
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const res = resolveCallee(node.expression, env)
      if (res) calls.push({ node, style: res.style })
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'gitAdd') {
        gitAddCalls.push(node)
      }
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      SWEEP_STRINGS.has(node.text)
    ) {
      sweepLiterals.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  // ---- R1: 无参数/undefined/void 0/显式 sweep 等价默认 gitAdd(root) ----
  for (const call of gitAddCalls) {
    const r = classifyGitAdd(sf, env, call)
    if (!r) continue
    const lc = lineColOf(sf, source, call.getStart(sf))
    violations.push({
      rule: RULE.GIT_ADD_SWEEP,
      line: lc.line,
      col: lc.col,
      snippet: snippetOf(source, call.getStart(sf)),
      detail: r.detail,
      spanStart: call.getStart(sf),
      node: call,
    })
    coveredSpans.push([call.getStart(sf), call.end])
  }

  // ---- R3: 追踪自 node:child_process 的 git add/commit 调用(sealed seam 不报) ----
  for (const { node, style } of calls) {
    const cls = classifyCpCall(sf, env, node, style)
    if (cls.kind !== 'write') continue
    const lc = lineColOf(sf, source, node.getStart(sf))
    violations.push({
      rule: RULE.GIT_CP_WRITE,
      line: lc.line,
      col: lc.col,
      snippet: snippetOf(source, node.getStart(sf)),
      detail:
        `业务层禁止绕过 store seam 直接 child_process 调 git add/commit(单点事务/审计收敛在 store); ` +
        `${cls.detail}; 改用 @novelcraft/store 的 adopt() 或 gitAdd(精确路径)+gitCommit()。`,
      spanStart: node.getStart(sf),
      node,
    })
    coveredSpans.push([node.getStart(sf), node.end])
  }

  // ---- R2: 业务代码中的 -A/--all 字面量(已定责区间内 / gitAdd 默认值节点 /
  // options 参数 / 只读 git 参数数组上下文不报) ----
  for (const lit of sweepLiterals) {
    if (coveredSpans.some(([a, b]) => lit.pos >= a && lit.end <= b)) continue
    if (isGitAddDefaultSweep(lit, relPath)) continue
    if (inOptionsArg(sf, env, lit)) continue
    if (readonlyGitArgsArray(sf, env, lit)) continue
    const lc = lineColOf(sf, source, lit.getStart(sf))
    violations.push({
      rule: RULE.GIT_ADD_SWEEP,
      line: lc.line,
      col: lc.col,
      snippet: snippetOf(source, lit.getStart(sf)),
      detail: `业务代码中的 '${lit.text}' 字面量 = git add 全量扫描标记; 只允许存在于 store/src/git.ts 的 gitAdd 实现默认值, 业务调用一律改用精确 pathspec。`,
      spanStart: lit.getStart(sf),
      node: lit,
    })
  }

  // ---- 精确允许表过滤(文件 + 规则 + 所在函数 + 节点形状; 无整文件豁免) ----
  return violations.filter((v) => {
    if (v.rule === RULE.GIT_ADD_SWEEP) {
      return !isGitAddDefaultSweep(v.node, relPath)
    }
    for (const a of ALLOWANCES) {
      if (a.file !== relPath || a.rule !== v.rule) continue
      if (enclosingFunctionName(v.node) !== a.withinFunction) continue
      if (isSeamShape(sf, env, v.node)) return false
    }
    return true
  })
}

// ============================================================================
// 内置自测: 锁定 R1–R3 检测器不变量与允许表节点形状语义(含复审对抗用例及
// 正/反向用例)。任一用例失败 → 打印差异并非零退出(禁止静默继续)。
// ============================================================================
function runSelfTest() {
  const cases = [
    // ── R1 正向: 无参数 gitAdd(root) / 省略 / undefined / void 0 ──
    { src: `gitAdd(root);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `  gitAdd(root);\n  gitCommit(root, 'm');`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root,);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, );`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, /* paths */);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, undefined);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, void 0);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, void(0));`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, void (0));`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd();`, expect: ['GIT_ADD_SWEEP@1'] },
    // ── R1 正向: 显式 -A/--all(字符串/数组/模板/常量) ──
    { src: `gitAdd(root, ['-A']);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, ["-A", "x.md"]);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, '-A');`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: 'gitAdd(root, [`-A`]);', expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, [...rel, '-A']);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, ['x.md', \`-A\`]);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root, ['log', '--all']);`, expect: ['GIT_ADD_SWEEP@1'] },
    {
      src: `const sweep = ['-A'];\ngitAdd(root, sweep);`,
      expect: ['GIT_ADD_SWEEP@1', 'GIT_ADD_SWEEP@2'],
    },
    { src: `gitAdd(root, '-A' as const);`, expect: ['GIT_ADD_SWEEP@1'] },
    // ── R1 反向: 精确 pathspec 合法(已收敛形态) ──
    { src: `gitAdd(root, [file]);`, expect: [] },
    { src: `gitAdd(root, ['world/objects/a.md', 'world/objects/b.md']);`, expect: [] },
    { src: `gitAdd(root, relPaths);`, expect: [] },
    { src: `gitAdd(root, changed);`, expect: [] },
    { src: `gitAdd(root, plan.files.map((f) => f.relativePath));`, expect: [] },
    { src: `gitAdd(root, []);`, expect: [] },
    { src: `gitAdd(root, [undefined]);`, expect: [] },
    { src: `gitAdd(root, tgt.rel);`, expect: [] },
    { src: `gitAdd(root, ['a.md', 'b.md',]);`, expect: [] },
    { src: `gitAdd(root, 'x.md');`, expect: [] },
    { src: `gitAdd(root, ...relPaths);`, expect: [] },
    { src: `gitAdd(root, [...new Set([a, b])]);`, expect: [] },
    { src: `gitCommit(root, 'msg');`, expect: [] },
    // ── R2 正向: 裸 -A/--all 字面量(业务代码) ──
    { src: `const s = '-A';`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `const s = '--all';`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: 'const s = `-A`;', expect: ['GIT_ADD_SWEEP@1'] },
    { src: `const args = ['add', '--all'];`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `const opts = { flag: '-A' };`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `execFileSync('tool', ['-A']);`, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `run(['-A']);`, expect: ['GIT_ADD_SWEEP@1'] },
    // ── R2 反向: 只读 git 参数数组上下文(git log --all 的 --all 非扫描标记) ──
    { src: `const args = ['log', '--all'];`, expect: [] },
    { src: `git(root, ['log', '--all', '--reflog', '--format=%H']);`, expect: [] },
    { src: `const args = ['--parents', 'log', '--all'];`, expect: [] },
    { src: `const args = ['-c', 'user.x=y', 'log', '--all'];`, expect: [] },
    { src: `const args = ['log', '-A'];`, expect: [] },
    { src: `const args = ['status', '-A'];`, expect: [] },
    { src: `execFileSync('git', ['log', '-A'], { cwd });`, expect: [] },
    // ── 反向: 注释/字符串文本/正则不误报 ──
    { src: `// gitAdd(root) 是违规模式; 也禁止 ' -A'\nconst ok = 1;`, expect: [] },
    { src: `const doc = "gitAdd(root) 是违规模式; '-A' 全量";`, expect: [] },
    { src: `const re = /git add -A/; re.test(s);`, expect: [] },
    { src: `/git (add|commit) -A/.test(x);`, expect: [] },
    // ── R3 正向: child_process git add/commit(多种 API/形态/跨行) ──
    { src: `execFileSync('git', ['add', '-A'], { cwd });`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync('git', ['commit', '-m', 'x'], { cwd: root });`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync(\n  'git',\n  ['-c', 'user.name=x', '-c', 'user.email=y', 'commit', '-m', 'm'],\n  { cwd: root },\n);`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync('git', ['--git-dir', gd, 'commit', '-m', 'm'], { cwd: root });`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execSync('git add .');`, expect: ['GIT_CP_WRITE@1'] },
    { src: `exec('git commit -m "x"');`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execSync('git.exe add x');`, expect: ['GIT_CP_WRITE@1'] },
    { src: `spawnSync('git', ['add', 'f.md']);`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFile('git', ['add', 'f.md']);`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync("git", ["add", "--all"], opts);`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync('git.exe', ['commit', '-m', 'x']);`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync('git', ['add']);`, expect: ['GIT_CP_WRITE@1'] },
    // ── R3 正向: import 具名/别名/命名空间/require 解构 形态 ──
    { src: `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `import { execFileSync as efs } from 'node:child_process';\nefs('git add file.md');`, expect: ['GIT_CP_WRITE@2'] },
    { src: `import * as cp from 'node:child_process';\ncp.spawnSync('git', ['add', 'f.md']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const { execFileSync } = require('node:child_process');\nexecFileSync('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const { execFileSync: efs } = require('node:child_process');\nefs('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `import cp from 'node:child_process';\ncp.execFileSync('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `import cp = require('node:child_process');\ncp.execFileSync('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const cp = require('node:child_process');\ncp.execFileSync('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const efs = require('node:child_process').execFileSync;\nefs('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    // ── R3 正向: 动态 import() / 解构 / 命名空间 ──
    { src: `const { execFileSync } = await import('node:child_process');\nexecFileSync('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const cp = await import('node:child_process');\ncp.execFileSync('git', ['commit', '-m', 'x']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const cp = await import('node:child_process');\ncp['spawnSync']('git', ['commit', '-m', 'x']);`, expect: ['GIT_CP_WRITE@2'] },
    // ── R3 正向: const 别名(含命名空间成员/解构/赋值别名/computed member) ──
    { src: `const efs = execFileSync;\nefs('git add file.md');`, expect: ['GIT_CP_WRITE@2'] },
    { src: `import { execFileSync } from 'node:child_process';\nconst e2 = execFileSync;\ne2('git', ['commit', '-m', 'x']);`, expect: ['GIT_CP_WRITE@3'] },
    { src: `import * as cp from 'node:child_process';\nconst efs = cp.execFileSync;\nefs('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@3'] },
    { src: `import * as cp from 'node:child_process';\nconst { execFileSync: efs } = cp;\nefs('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@3'] },
    { src: `import * as cp from 'node:child_process';\ncp['execFileSync']('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `import * as cp from 'node:child_process';\ncp["spawnSync"]('git', ['commit', '--amend']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `let efs;\nefs = execFileSync;\nefs('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@3'] },
    { src: `const cp = require('node:child_process');\nconst { execFileSync: efs } = cp;\nefs('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@3'] },
    { src: `const cp = require('node:child_process');\nconst a = cp;\na.execFileSync('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@3'] },
    { src: `const efs = require('node:child_process')['execFileSync'];\nefs('git', ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    // ── R3 正向: 命令/args 变量的可判定常量(const 字符串/数组/拼接/传播) ──
    { src: `const sub = 'add';\nexecFileSync('git', [sub, '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const sub = 'commit';\nexecFileSync('git', [sub]);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const cmd = 'git';\nexecFileSync(cmd, ['add', '.']);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const cmd = 'git add .';\nexecSync(cmd);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const cmd = 'git ' + 'add .';\nexecSync(cmd);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const args = ['add', '-A'];\nexecFileSync('git', args);`, expect: ['GIT_ADD_SWEEP@1', 'GIT_CP_WRITE@2'] },
    { src: `const args = ['-c', 'user.x=y', 'add', '.'];\nexecFileSync('git', args);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const args = ['add'];\nexecFileSync('git', args[0], args);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const base = ['add', '.'];\nexecFileSync('git', [...base]);`, expect: ['GIT_CP_WRITE@2'] },
    { src: `const a = ['-c', 'user.x=y'];\nconst b = [...a, 'add', '.'];\nexecFileSync('git', b);`, expect: ['GIT_CP_WRITE@3'] },
    { src: `const base = ['status'];\nexecFileSync('git', [...base, '--porcelain']);`, expect: [] },
    // ── R3 正向: 模板插值(静态写/插值可判定/动态 fail-closed/复合命令) ──
    { src: 'execSync(`git add ${f}`);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(`git ${sub}`);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(`git ${sub} --all`);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(`cd ${dir} && git add .`);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(`cd ${d} && git ${s}`);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(`git ${"add"} ${f}`);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(`echo ${x} && git ${"commit"} -m ${m}`);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(`${a}${b}`);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(cmd);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execSync(process.env.CMD);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execFileSync(`git`, [`${cmd}`]);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execFileSync("git", [`${"add"}`, "."]);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execFileSync("git", [`add${x}`]);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execFileSync("git", ["-c", `${k}`, `${sub}`]);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execFileSync("git", [sub, "add"]);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execFileSync("git", [...x]);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execFileSync(cmd, ["add", "."]);', expect: ['GIT_CP_WRITE@1'] },
    { src: 'execFileSync(cmd, args);', expect: ['GIT_CP_WRITE@1'] },
    // ── R3 反向: 只读 git / 非 git / 误报反例 ──
    { src: `execFileSync('git', ['rev-parse', 'HEAD'], { cwd });`, expect: [] },
    { src: `execFileSync('git', ['init'], { cwd, stdio: 'pipe' });`, expect: [] },
    { src: `execFileSync('git', ['status', '--porcelain'], { cwd });`, expect: [] },
    { src: `execFileSync('git', ['ls-files'], { cwd });`, expect: [] },
    { src: `execFileSync('git', ['log', '--format=%s'], { cwd });`, expect: [] },
    { src: `execFileSync('git', ['push', 'origin', 'main'], { cwd });`, expect: [] },
    { src: `execFileSync('git', ['pull'], { cwd });`, expect: [] },
    { src: `execSync('git status');`, expect: [] },
    { src: 'execSync(`git log ${sha}`);', expect: [] },
    { src: 'execSync(`git ${"status"}`);', expect: [] },
    { src: 'execSync(`git log --format=${f}`);', expect: [] },
    { src: 'execSync(`npm ${c}`);', expect: [] },
    { src: 'execSync(`echo ${x}`);', expect: [] },
    { src: 'execSync(`cd ${d} && git status`);', expect: [] },
    { src: 'execSync(`git push ${x}`);', expect: [] },
    { src: `const cmd = 'git status';\nexecSync(cmd);`, expect: [] },
    { src: `const cmd = 'echo ' + x;\nexecSync(cmd);`, expect: [] },
    { src: `const args = ['log', '--all'];\nexecFileSync('git', args);`, expect: [] },
    { src: `const sub = 'status';\nexecFileSync('git', [sub]);`, expect: [] },
    { src: `const cmd = 'git';\nexecFileSync(cmd, ['status']);`, expect: [] },
    { src: `execFileSync('git', ['--git-dir', gd, 'status', '--porcelain'], { cwd });`, expect: [] },
    // 反向: 命令名不是 git(execFileSync('tool', ['git']) 等)不误报
    { src: `execFileSync('tool', ['git', 'add']);`, expect: [] },
    { src: `execFileSync('tool', ['git']);`, expect: [] },
    { src: `spawn('npm', ['run', 'add'], { stdio: 'inherit' });`, expect: [] },
    // 反向: 本地同名函数/变量、成员调用、字符串文本、正则不误报
    { src: `function exec(s) { return s; }\nexec('git add .');`, expect: [] },
    { src: `const spawn = require('./local-spawn');\nspawn('git', ['add']);`, expect: [] },
    { src: `m.exec('git add .');`, expect: [] },
    { src: `re.exec('test string');`, expect: [] },
    { src: `/^git (add|commit)/.exec(s);`, expect: [] },
    { src: `execSync(/git add/);`, expect: [] },
    { src: `execSync(/git add/.source);`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync('git', [/git add/]);`, expect: [] },
    { src: `const words = ['add', 'commit'];`, expect: [] },
    { src: `console.log('git commit -m x');`, expect: [] },
    { src: `const s = "run: git add .";`, expect: [] },
    // ── R3 反向: options 参数内容一律不扫(exec 第 2+ 参 / execFile 第 3+ 参) ──
    { src: `execSync('echo hi', { shell: 'git add .' });`, expect: [] },
    { src: `execSync('git status', { env: { X: '-A' } });`, expect: [] },
    { src: `execFileSync('git', ['status'], { env: { CMD: 'git add .' } });`, expect: [] },
    { src: `execFileSync('git', ['status'], { env: { FLAG: '-A' } });`, expect: [] },
    { src: `execFileSync('git', ['log'], { input: 'git add .' });`, expect: [] },
    { src: `execFileSync('git', ['log', '--format=git add %s'], { cwd });`, expect: [] },
    { src: `spawn('git', ['status'], { stdio: ['ignore', 'pipe', 'git add'] });`, expect: [] },
    { src: `exec('echo hi', 'git commit -m x');`, expect: [] },
    { src: `execSync('git status', '-A');`, expect: [] },
    { src: `execFileSync('git', ['status'], ['-A']);`, expect: [] },
    // ── R3 正向: options 内容不影响写判定(只扫 command+args) ──
    { src: `execSync('git add .', { cwd, shell: 'git commit' });`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync('git', ['add', '.'], { timeout: 1000, input: 'git commit' });`, expect: ['GIT_CP_WRITE@1'] },
    { src: `spawn('git', ['add', 'x'], { stdio: ['ignore', 'pipe', 'git add'] });`, expect: ['GIT_CP_WRITE@1'] },
    { src: `execFileSync('git', ['add'], ['-A']);`, expect: ['GIT_CP_WRITE@1'] },
    // ── sealed seam: cmd='git' 且 args 整体不可判定 → 不报(store/vault 封装形态) ──
    { src: `function f(root, args) { return execFileSync('git', args, { cwd: root }); }`, expect: [] },
    { src: `function runGit(root, args) { return execFileSync('git', args as string[], { cwd: root }); }`, expect: [] },
    {
      src: `function runGit(root, args) { return execFileSync('git', args as string[], { cwd: root }); }\nfunction gitSucceeds(root, args) { execFileSync('git', args as string[], { cwd: root }); }\nexecFileSync('git', ['init'], { cwd: root });`,
      expect: [],
    },
    { src: `const args = process.argv.slice(2);\nexecFileSync('git', args);`, expect: [] },
    { src: `execFileSync('git', getArgs());`, expect: [] },
    // 反向: seam 之外的其它违规照报(同一函数内可判定写、文件级)
    { src: `function f(root, args) { execFileSync('git', ['add', '.']); return execFileSync('git', args, { cwd: root }); }`, expect: ['GIT_CP_WRITE@1'] },
    { src: `function f(root, args) { return execFileSync('git', args, { cwd: root }); }\nexecSync('git add .');`, expect: ['GIT_CP_WRITE@2'] },
    // ── 常量作用域: 不同函数的同名 const 互不串扰(参数 args 不得解析到其它函数的 const args) ──
    {
      src: `function other() { const args = ['add', '.']; execFileSync('git', args); }\nfunction gitExecUnpinned(repoDir: string, args: string[]) { return execFileSync('git', args, {}); }`,
      expect: ['GIT_CP_WRITE@1'],
    },
    {
      src: `function a() { const args = ['add', '.']; execFileSync('git', args); }\nfunction b(args) { return execFileSync('git', args); }\nfunction c() { const args = ['status']; execFileSync('git', args); }`,
      expect: ['GIT_CP_WRITE@1'],
    },
    // ── 允许表: 封装内拼装数组(子命令动态/只读)精确豁免(节点形状), 业务同形照报 ──
    // git-transaction.ts: gitExec 的真实形态 [...pinArgs(ctx), ...opts.args]
    {
      src: `function gitExec(opts: { ctx: unknown; args: string[] }): string {\n  const args = [...pinArgs(opts.ctx), ...opts.args];\n  return execFileSync('git', args, {});\n}`,
      rel: 'packages/novelcraft/store/src/transaction/git-transaction.ts',
      expect: [],
    },
    // git-transaction.ts: assertSharedIndexClean 的真实形态(子命令经 pinArgs 后为只读 diff)
    {
      src: `function assertSharedIndexClean(ctx: { repoDir: string }): void {\n  const args = [...pinArgs(ctx), 'diff', '--cached', '--exit-code', '--name-only', '-z'];\n  execFileSync('git', args, { cwd: ctx.repoDir });\n}`,
      rel: 'packages/novelcraft/store/src/transaction/git-transaction.ts',
      expect: [],
    },
    // vault: runGit/gitSucceeds 的真实形态(固定全局选项 + 自身参数展开)
    {
      src: `function runGit(root: string, args: readonly string[]): string {\n  return execFileSync('git', ['--no-replace-objects', '--no-optional-locks', ...(args as string[])], { cwd: root });\n}`,
      rel: 'packages/novelcraft/vault/src/index.ts',
      expect: [],
    },
    {
      src: `function gitSucceeds(root: string, args: readonly string[]): boolean {\n  execFileSync('git', ['--no-replace-objects', '--no-optional-locks', ...(args as string[])], { cwd: root });\n  return true;\n}`,
      rel: 'packages/novelcraft/vault/src/index.ts',
      expect: [],
    },
    // 业务代码同形(不在允许表)→ 照 fail-closed 报
    {
      src: `function f(root, args) { return execFileSync('git', ['--no-replace-objects', ...(args as string[])], {}); }`,
      expect: ['GIT_CP_WRITE@1'],
    },
    {
      src: `function f(opts) { const args = [...pin(opts), ...opts.args]; return execFileSync('git', args, {}); }`,
      expect: ['GIT_CP_WRITE@1'],
    },
    // 允许表内函数: 可判定写形态照报(豁免仅限 seam 节点形状)
    {
      src: `function gitExec(opts: { ctx: unknown; args: string[] }): string {\n  const args = [...pinArgs(opts.ctx), ...opts.args];\n  execFileSync('git', ['add', '-A'], {});\n  return execFileSync('git', args, {});\n}`,
      rel: 'packages/novelcraft/store/src/transaction/git-transaction.ts',
      expect: ['GIT_CP_WRITE@3'],
    },
    // ── 允许表: 精确(文件 + 规则 + 所在函数 + 节点形状), 非整文件/整函数豁免 ──
    // store/git.ts: execFile 封装内底层 execFileSync('git', args) seam 节点允许
    {
      src: `import { execFileSync } from 'node:child_process';\nfunction execFile(repoDir: string, args: string[], opts?: { allowFailure?: boolean }): string {\n  return execFileSync('git', args, { cwd: repoDir });\n}`,
      rel: GIT_TS_PATH,
      expect: [],
    },
    // store/git.ts: gitAdd 的 paths 参数默认值数组节点 ['-A'] 允许
    {
      src: `export function gitAdd(repoDir: string, paths: string[] = ['-A']): void {\n  run(repoDir, ['add', ...paths]);\n}`,
      rel: GIT_TS_PATH,
      expect: [],
    },
    // store/git.ts: 允许节点之外照报 —— 允许函数内的其它(可判定写)调用照报
    {
      src: `function execFile(repoDir: string, args: string[]): string {\n  execFileSync('git', ['add', '-A'], { cwd: repoDir });\n  return execFileSync('git', args, { cwd: repoDir });\n}`,
      rel: GIT_TS_PATH,
      expect: ['GIT_CP_WRITE@2'],
    },
    // store/git.ts: nested 照报 —— execFile 内嵌套函数调用不在允许节点形状内
    {
      src: `function execFile(repoDir: string, args: string[]): string {\n  function inner() { return execFileSync('git', ['add', '.']); }\n  inner();\n  return execFileSync('git', args, { cwd: repoDir });\n}`,
      rel: GIT_TS_PATH,
      expect: ['GIT_CP_WRITE@2'],
    },
    // store/git.ts: 允许函数之外照报
    {
      src: `function execFile(repoDir: string, args: string[]): string {\n  return execFileSync('git', args, { cwd: repoDir });\n}\nexecSync('git add .');`,
      rel: GIT_TS_PATH,
      expect: ['GIT_CP_WRITE@4'],
    },
    // store/git.ts: gitAdd 体内其它 '-A'(body 字面量)不是默认值节点, 照报
    {
      src: `export function gitAdd(repoDir: string, paths: string[] = ['-A']): void {\n  run(repoDir, ['add', '-A', ...paths]);\n}`,
      rel: GIT_TS_PATH,
      expect: ['GIT_ADD_SWEEP@2'],
    },
    // store/git.ts: 其它参数默认值不是 paths 默认值节点, 照报
    {
      src: `export function gitAdd(repoDir: string, paths: string[] = ['-A'], extra: string[] = ['-A']): void {}`,
      rel: GIT_TS_PATH,
      expect: ['GIT_ADD_SWEEP@1'],
    },
    // store/git.ts: 其它函数的默认值照报
    {
      src: `export function gitAdd(repoDir: string, paths: string[] = ['-A']): void {}\nfunction other(repoDir: string, paths: string[] = ['-A']): void {}`,
      rel: GIT_TS_PATH,
      expect: ['GIT_ADD_SWEEP@2'],
    },
    // store/git.ts: gitAdd(root) 调用在 git.ts 内照报(非整文件豁免)
    { src: `gitAdd(root);`, rel: GIT_TS_PATH, expect: ['GIT_ADD_SWEEP@1'] },
    { src: `const s = '-A';`, rel: GIT_TS_PATH, expect: ['GIT_ADD_SWEEP@1'] },
    // git-transaction.ts: gitExec 封装内 seam 节点允许; 可判定写照报
    {
      src: `import { execFileSync } from 'node:child_process';\nfunction gitExec(opts: { repoDir: string; args: string[] }): string {\n  return execFileSync('git', opts.args, { cwd: opts.repoDir });\n}`,
      rel: 'packages/novelcraft/store/src/transaction/git-transaction.ts',
      expect: [],
    },
    {
      src: `function gitExec(opts: { args: string[] }): string {\n  execFileSync('git', ['add', '-A'], {});\n  return execFileSync('git', opts.args, {});\n}\nexec('git add .');`,
      rel: 'packages/novelcraft/store/src/transaction/git-transaction.ts',
      expect: ['GIT_CP_WRITE@2', 'GIT_CP_WRITE@5'],
    },
    // execute.ts: git()/gitOk() 封装内 seam 节点允许; 可判定写照报
    {
      src: `import { execFileSync } from 'node:child_process';\nfunction git(root: string, args: string[]): string {\n  return execFileSync('git', args, {});\n}\nfunction gitOk(root: string, args: string[]): boolean {\n  execFileSync('git', args, {});\n  return true;\n}`,
      rel: 'packages/novelcraft/store/src/transaction/execute.ts',
      expect: [],
    },
    {
      src: `function git(root: string, args: string[]): string {\n  execFileSync('git', ['add', '.']);\n  return execFileSync('git', args, {});\n}\nexecSync('git commit -m x');`,
      rel: 'packages/novelcraft/store/src/transaction/execute.ts',
      expect: ['GIT_CP_WRITE@2', 'GIT_CP_WRITE@5'],
    },
    {
      src: `function gitOk(root: string, args: string[]): boolean {\n  execFileSync('git', ['commit', '-m', 'x']);\n  return true;\n}`,
      rel: 'packages/novelcraft/store/src/transaction/execute.ts',
      expect: ['GIT_CP_WRITE@2'],
    },
    // adopt.ts: 整文件豁免已移除 —— 事务内历史形态无参数 gitAdd 照报
    { src: `gitAdd(root);`, rel: 'packages/novelcraft/store/src/adopt.ts', expect: ['GIT_ADD_SWEEP@1'] },
    // 近似/无关路径不豁免
    { src: `gitAdd(root);`, rel: 'packages/novelcraft/store/src/adopt.ts.bak', expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root);`, rel: 'packages/novelcraft/store/src/merge.ts', expect: ['GIT_ADD_SWEEP@1'] },
    { src: `gitAdd(root);`, rel: 'packages/novelcraft/pkg/src/fake.ts', expect: ['GIT_ADD_SWEEP@1'] },
    // 业务文件自定义 gitAdd 的默认值不属于允许表(允许表锚定 store/src/git.ts)
    { src: `function gitAdd(paths: string[] = ['-A']) {}`, rel: 'packages/novelcraft/pkg/src/fake.ts', expect: ['GIT_ADD_SWEEP@1'] },
    // ── 扩展名全支持: ts/tsx/js/jsx/mjs/cjs/mts/cts ──
    {
      src: `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add', '.']);`,
      rel: 'packages/novelcraft/pkg/src/fake.mjs',
      expect: ['GIT_CP_WRITE@2'],
    },
    {
      src: `const { execFileSync } = require('node:child_process');\nexecFileSync('git', ['add', '.']);`,
      rel: 'packages/novelcraft/pkg/src/fake.cjs',
      expect: ['GIT_CP_WRITE@2'],
    },
    {
      src: `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add', '.']);`,
      rel: 'packages/novelcraft/pkg/src/fake.cts',
      expect: ['GIT_CP_WRITE@2'],
    },
    {
      src: `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add', '.']);`,
      rel: 'packages/novelcraft/pkg/src/fake.mts',
      expect: ['GIT_CP_WRITE@2'],
    },
    {
      src: `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add', '.']);`,
      rel: 'packages/novelcraft/pkg/src/fake.js',
      expect: ['GIT_CP_WRITE@2'],
    },
    {
      src: `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['add', '.']);`,
      rel: 'packages/novelcraft/pkg/src/fake.jsx',
      expect: ['GIT_CP_WRITE@2'],
    },
    {
      src: `import { execFileSync } from 'node:child_process';\nconst C = () => { execFileSync('git', ['add', '.']); return null; };`,
      rel: 'packages/novelcraft/pkg/src/fake.tsx',
      expect: ['GIT_CP_WRITE@2'],
    },
    { src: `const x = <div>{'git add'}</div>;`, rel: 'packages/novelcraft/pkg/src/fake.jsx', expect: [] },
  ]
  let failed = 0
  for (const { src, rel = 'packages/novelcraft/pkg/src/fake.ts', expect } of cases) {
    const got = analyzeSource(src, rel)
      .map((v) => `${v.rule}@${v.line}`)
      .sort()
    const want = [...expect].sort()
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failed++
      console.error(
        `  ✗ self-test: ${JSON.stringify(src)} (rel=${rel})\n    期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)}`,
      )
    }
  }
  if (failed > 0) {
    console.error(`check-git-writers self-test: ${failed}/${cases.length} 用例失败 — 检测器不变量被破坏, 中止。`)
    process.exit(1)
  }
  console.log(
    `check-git-writers self-test: ${cases.length}/${cases.length} 通过(AST/TS compiler API: R1 gitAdd 默认/显式 sweep · R2 -A/--all 字面量与只读数组上下文 · R3 import/require/动态 import/别名/赋值/computed member/可判定常量 · 模板插值遍历 · 正则字面量不误报 · exec 首参/execFile command+args · options 不扫 · 动态 fail-closed · sealed seam · 允许表节点形状)。`,
  )
}

function usage() {
  console.log(
    `用法:\n` +
      `  node scripts/check-git-writers.mjs            # gate: 违规 → 打印清单, 退出 1\n` +
      `  node scripts/check-git-writers.mjs --report   # 可读违规清单(信息性, 退出 0)\n` +
      `  node scripts/check-git-writers.mjs --help`,
  )
}

function main() {
  runSelfTest()
  const args = process.argv.slice(2)
  const reportMode = args.includes('--report')
  if (args.includes('--help')) {
    usage()
    process.exit(0)
  }
  for (const a of args) {
    if (a !== '--report') {
      usage()
      process.exit(2)
    }
  }

  const files = collectScannedFiles()
  const violations = []
  for (const file of files) {
    const rel = relative(ROOT, file).split(sep).join('/')
    violations.push(...analyzeSource(readFileSync(file, 'utf8'), rel).map((v) => ({ ...v, file: rel })))
  }
  violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

  const byRule = new Map()
  for (const v of violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1)
  const pkgCount = new Set(
    files.map((f) => relative(NOVELCRAFT_DIR, f).split(sep)[0]),
  ).size

  const header = `check-git-writers: 扫描 ${NOVELCRAFT_DIR}/<pkg>/src(${pkgCount} 个包, ${files.length} 个文件)`

  if (violations.length === 0) {
    console.log(`${header}: OK — 无业务 Git 写者违规(所有 git 写均经 store seam 且传精确 pathspec)。`)
    process.exit(0)
  }

  // 按文件分组打印(可读违规清单; 两种模式同一份输出, 区别只在退出码)。
  const groups = new Map()
  for (const v of violations) {
    if (!groups.has(v.file)) groups.set(v.file, [])
    groups.get(v.file).push(v)
  }
  console.error(`${header}: 发现 ${violations.length} 处违规, 分布 ${groups.size} 个源文件:\n`)
  for (const [file, hits] of [...groups.entries()].sort()) {
    console.error(`── ${file}`)
    for (const h of hits) {
      console.error(`  ✗ [${h.rule}] ${file}:${h.line}:${h.col}  ${h.snippet}`)
      console.error(`      ${h.detail}`)
    }
    console.error('')
  }
  console.error(
    `按规则统计: ${[...byRule.entries()].map(([r, n]) => `${r}×${n}`).join(', ')}(共 ${violations.length})`,
  )
  console.error(`精确允许表(文件 + 规则 + 所在函数 + 节点形状, 非整文件/整函数豁免):`)
  for (const a of ALLOWANCES) console.error(`  - ${a.file} [${a.rule} @${a.withinFunction}()]: ${a.reason}`)
  console.error(
    '\ngate 语义: 业务写已全部收敛为精确 pathspec(Wave2 完成), 默认模式零违规即通过, 常态为绿;' +
      ' 任何新增业务写绕过都会在允许表节点形状之外照报, 允许表无需改动。',
  )

  if (reportMode) {
    console.error(
      `\n[--report] 信息性输出(非 gate), 退出 0; 仅用于人工排查。收敛后请以默认模式(gate)为准: npm run check:git-writers。`,
    )
    process.exit(0)
  }
  console.error(
    `\ncheck-git-writers: FAIL — 违规未清零。请按 R1–R3 收敛后重跑; 当前如需可读清单请用 --report。`,
  )
  process.exit(1)
}

main()
