/**
 * @novelcraft/vault — R1 内核: 工作区初始化、路径规范、slug、读写门禁。
 *
 * 工程约定(见 packages/novelcraft/README.md):
 * - 纯 TS, strict 模式; 零 DSH 依赖、零 LLM、纯确定性。
 * - git 操作用 node:child_process 调 git CLI。
 *
 * 规则引用:
 * - §22.2 = docs/agent/dsh-rebuild/自主智能式作家助手设计.md 「文件夹真相」目录树。
 * - R#     = specs/rules/store-rules.md 完整性规则编号。
 * - N#     = specs/adjudications.md 裁定编号。
 * - small-modules §1.1 = specs/assets/small-modules.md 「project」节(book.yml 字段)。
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ensureVaultGitignore } from './gitignore.js';

/** 书根标记文件(§22.2; small-modules §1.1)。 */
export const BOOK_FILENAME = 'book.yml';

/** slug 最大长度(N10 / R63)。 */
export const SLUG_MAX_LENGTH = 64;

/**
 * 默认揭示策略白名单(small-modules §1.1 完整性规则;
 * project/schemas.py:47-53)。
 */
export const REVEAL_POLICIES = [
  'author_safe',
  'author_only',
  'reader_known',
  'public',
] as const;

export type RevealPolicy = (typeof REVEAL_POLICIES)[number];

/** 目标规模枚举(N9 / small-modules §1.1)。 */
export const TARGET_LENGTHS = ['short', 'medium', 'novel', 'epic'] as const;
export type TargetLength = (typeof TARGET_LENGTHS)[number];

/** 当前阶段枚举(N9 / small-modules §1.1)。 */
export const CURRENT_STAGES = [
  'world_building',
  'outlining',
  'writing',
  'revising',
] as const;
export type CurrentStage = (typeof CURRENT_STAGES)[number];

const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_REVEAL_POLICY: RevealPolicy = 'author_safe';

/**
 * book.yml 字段来源(small-modules §1.1)。字段名以 Spec 为权威(N9):
 * `target_length` / `current_stage`(旧代码映射), 不用 `target_scale`/`stage`。
 */
export interface BookMeta {
  /** 书名; 必填, 去首尾空白, 拒绝空字节与纯空白(small-modules §1.1)。 */
  title: string;
  /** 题材(如 玄幻/科幻/悬疑); 开放字符串, 可选。 */
  genre?: string;
  /** 风格基调(如 严肃/轻松/黑暗); 开放字符串, 可选。 */
  tone?: string;
  /** 创作语言; 默认 `zh`。 */
  language?: string;
  /** 目标规模枚举(short/medium/novel/epic); 可选(N9)。 */
  target_length?: string;
  /** 当前阶段枚举(world_building/outlining/writing/revising); 可选(N9)。 */
  current_stage?: string;
  /** 默认揭示策略; 默认 `author_safe`, 白名单见 REVEAL_POLICIES。 */
  default_reveal_policy?: string;
}

/** §22.2 目录树(含 adjudications #1–#5 追加)的全部路径常量与拼接函数。 */
export interface VaultPaths {
  root: string;
  bookYml: string;
  chapters: {
    dir: string;
    pending: string;
    /** chapters/{NNN}.md; NNN 三零填充(§22.2 `003.md`, adjudication #3 `{NNN}.md`)。 */
    chapterFile: (n: number) => string;
    /** chapters/pending/{slug}.md(adjudication #3): 候选 slug 任意单文件段(如 cand_foo / 003)。 */
    pendingFile: (slug: string) => string;
  };
  scenes: {
    dir: string;
    sceneFile: (slug: string) => string;
  };
  world: {
    dir: string;
    objects: string;
    pending: string;
    objectFile: (slug: string) => string;
    pendingFile: (slug: string) => string;
    /** 世界地图册文件模型(map-atlas 实施计划 §2; N28/N29)。 */
    atlas: {
      dir: string;
      nodes: string;
      pages: string;
      pendingNodes: string;
      pendingPages: string;
      images: string;
      nodeFile: (slug: string) => string;
      pageFile: (slug: string) => string;
      pendingNodeFile: (slug: string) => string;
      pendingPageFile: (slug: string) => string;
    };
  };
  structure: {
    dir: string;
    /** story-outline 落点(adjudication #1); 保持单文件(N12)。 */
    outline: string;
    /** 结构资产目录(N12): 每资产一文件, 细粒度 CAS/手改/git diff。 */
    threads: string;
    arcs: string;
    foreshadowing: string;
    reveal: string;
    threadFile: (slug: string) => string;
    arcFile: (slug: string) => string;
    foreshadowingFile: (slug: string) => string;
    revealFile: (slug: string) => string;
  };
  memory: {
    dir: string;
    events: string;
  };
  bible: {
    dir: string;
    bibleFile: (slug: string) => string;
  };
  imports: {
    dir: string;
    /** imports 停靠(§22.2 D9a: 统一 .txt/.md); name 需自带扩展名。 */
    importFile: (name: string) => string;
  };
  assistant: {
    dir: string;
    policy: string;
    calibration: string;
    checkpoint: string;
    signals: string;
    signalFile: (name: string) => string;
    llm: string;
    /** 派生审查/回执目录(adjudication #4)。 */
    reviews: string;
    reviewFile: (name: string) => string;
    /** 续写提案落点(下一步提案中心 §17.5.3)。 */
    proposals: string;
    proposalFile: (name: string) => string;
    /** merge_records 落点(adjudication #5)。 */
    mergeLog: string;
    /** 世界地图册工作产物目录(map-atlas 实施计划 §2.3; runs 提交, queue/decisions 只记录)。 */
    atlas: {
      dir: string;
      runs: string;
      annotationQueue: string;
      decisions: string;
      runFile: (runId: string) => string;
    };
  };
}

/**
 * 集中定义 §22.2 + adjudications 的全量路径常量与拼接函数。
 *
 * fail-closed(R9): 所有静态目录/文件与动态文件构造器内部先经 `guardPath(r, ·)`
 * 验证(lexical + real 双重 containment, 防逃逸 vault 外), 再经
 * `assertNoSymlinkOnPath` 逐段校验——**任何 vault 内 symlink 一律拒绝**, 包括
 * 指向 vault 内其他目录/文件的 symlink(guardPath 会放行 root 内 symlink, 但
 * kind 边界目录/文件被重定向会破坏资产语义, 如 world/objects→bible)。
 * 任一固定子目录/文件被 symlink 时 `paths(root)` 整体 fail-closed; init 前目录
 * 尚不存在时 guardPath 按「最深存在祖先」解析, 待创建路径落在 canonical root 内
 * 仍正常放行。动态构造器的 slug/name/runId 只允许单文件路径段(经 assertSafePathSegment)。
 * root 自身为 symlink 不在此检查范围(guardPath 以其真实位置为 canonical root)。
 */
export function paths(root: string): VaultPaths {
  const r = path.resolve(root);
  const within = (abs: string): string => {
    const p = guardPath(r, abs);
    assertNoSymlinkOnPath(r, p);
    return p;
  };

  const chaptersDir = within(path.join(r, 'chapters'));
  const chaptersPendingDir = within(path.join(chaptersDir, 'pending'));
  const scenesDir = within(path.join(r, 'scenes'));
  const worldDir = within(path.join(r, 'world'));
  const worldObjectsDir = within(path.join(worldDir, 'objects'));
  const worldPendingDir = within(path.join(worldDir, 'pending'));
  const worldAtlasDir = within(path.join(worldDir, 'atlas'));
  const worldAtlasNodesDir = within(path.join(worldAtlasDir, 'nodes'));
  const worldAtlasPagesDir = within(path.join(worldAtlasDir, 'pages'));
  const worldAtlasPendingDir = within(path.join(worldAtlasDir, 'pending'));
  const worldAtlasPendingNodesDir = within(path.join(worldAtlasPendingDir, 'nodes'));
  const worldAtlasPendingPagesDir = within(path.join(worldAtlasPendingDir, 'pages'));
  const worldAtlasImagesDir = within(path.join(worldAtlasDir, 'images'));
  const structureDir = within(path.join(r, 'structure'));
  const threadsDir = within(path.join(structureDir, 'threads'));
  const arcsDir = within(path.join(structureDir, 'arcs'));
  const foreshadowingDir = within(path.join(structureDir, 'foreshadowing'));
  const revealDir = within(path.join(structureDir, 'reveal'));
  const memoryDir = within(path.join(r, 'memory'));
  const bibleDir = within(path.join(r, 'bible'));
  const importsDir = within(path.join(r, 'imports'));
  const assistantDir = within(path.join(r, '.assistant'));
  const signalsDir = within(path.join(assistantDir, 'signals'));
  const reviewsDir = within(path.join(assistantDir, 'reviews'));
  const proposalsDir = within(path.join(assistantDir, 'proposals'));
  const assistantAtlasDir = within(path.join(assistantDir, 'atlas'));
  const assistantAtlasRunsDir = within(path.join(assistantAtlasDir, 'runs'));
  const assistantAtlasAnnotationQueueDir = within(path.join(assistantAtlasDir, 'annotation-queue'));
  const assistantAtlasDecisionsDir = within(path.join(assistantAtlasDir, 'decisions'));

  const slugFile = (
    base: string,
    seg: string,
    what: string,
    ext = '.md',
  ): string => within(path.join(base, `${assertSafePathSegment(seg, what)}${ext}`));

  return {
    root: r,
    bookYml: within(path.join(r, BOOK_FILENAME)),
    chapters: {
      dir: chaptersDir,
      pending: chaptersPendingDir,
      chapterFile: (n) => within(path.join(chaptersDir, `${assertChapterIndex(n)}.md`)),
      pendingFile: (slug) => slugFile(chaptersPendingDir, slug, 'chapter candidate slug'),
    },
    scenes: {
      dir: scenesDir,
      sceneFile: (slug) => slugFile(scenesDir, slug, 'scene slug'),
    },
    world: {
      dir: worldDir,
      objects: worldObjectsDir,
      pending: worldPendingDir,
      objectFile: (slug) => slugFile(worldObjectsDir, slug, 'object slug'),
      pendingFile: (slug) => slugFile(worldPendingDir, slug, 'pending slug'),
      atlas: {
        dir: worldAtlasDir,
        nodes: worldAtlasNodesDir,
        pages: worldAtlasPagesDir,
        pendingNodes: worldAtlasPendingNodesDir,
        pendingPages: worldAtlasPendingPagesDir,
        images: worldAtlasImagesDir,
        nodeFile: (slug) => slugFile(worldAtlasNodesDir, slug, 'atlas node slug'),
        pageFile: (slug) => slugFile(worldAtlasPagesDir, slug, 'atlas page slug'),
        pendingNodeFile: (slug) => slugFile(worldAtlasPendingNodesDir, slug, 'atlas node slug'),
        pendingPageFile: (slug) => slugFile(worldAtlasPendingPagesDir, slug, 'atlas page slug'),
      },
    },
    structure: {
      dir: structureDir,
      outline: within(path.join(structureDir, 'outline.md')),
      threads: threadsDir,
      arcs: arcsDir,
      foreshadowing: foreshadowingDir,
      reveal: revealDir,
      threadFile: (slug) => slugFile(threadsDir, slug, 'thread slug'),
      arcFile: (slug) => slugFile(arcsDir, slug, 'arc slug'),
      foreshadowingFile: (slug) => slugFile(foreshadowingDir, slug, 'foreshadowing slug'),
      revealFile: (slug) => slugFile(revealDir, slug, 'reveal slug'),
    },
    memory: {
      dir: memoryDir,
      events: within(path.join(memoryDir, 'events.jsonl')),
    },
    bible: {
      dir: bibleDir,
      bibleFile: (slug) => slugFile(bibleDir, slug, 'bible slug'),
    },
    imports: {
      dir: importsDir,
      // name 可带扩展名(chapter1.txt), 但必须是单文件段(不可含目录)。
      importFile: (name) =>
        within(path.join(importsDir, assertSafePathSegment(name, 'import file name'))),
    },
    assistant: {
      dir: assistantDir,
      policy: within(path.join(assistantDir, 'policy.yml')),
      calibration: within(path.join(assistantDir, 'calibration.md')),
      checkpoint: within(path.join(assistantDir, 'checkpoint.json')),
      signals: signalsDir,
      signalFile: (name) => slugFile(signalsDir, name, 'signal name', '.json'),
      llm: within(path.join(assistantDir, 'llm.yml')),
      reviews: reviewsDir,
      reviewFile: (name) => slugFile(reviewsDir, name, 'review name', '.json'),
      proposals: proposalsDir,
      proposalFile: (name) => slugFile(proposalsDir, name, 'proposal name', '.json'),
      mergeLog: within(path.join(assistantDir, 'merge-log.jsonl')),
      atlas: {
        dir: assistantAtlasDir,
        runs: assistantAtlasRunsDir,
        annotationQueue: assistantAtlasAnnotationQueueDir,
        decisions: assistantAtlasDecisionsDir,
        runFile: (runId) => slugFile(assistantAtlasRunsDir, runId, 'atlas run id', '.json'),
      },
    },
  };
}

/**
 * §22.2 目录树骨架(仅目录)。固定文件(book.yml 由 init 写; outline.md/events.jsonl/
 * policy.yml 等)由 store/outline 等插件按内容落盘, init 只建目录 + book.yml + .git。
 * 含 adjudications #3(chapters/pending)、#4(.assistant/reviews)与 N12
 * (structure/threads|arcs|foreshadowing|reveal 目录)。
 */
const VAULT_DIRS: readonly string[] = [
  'chapters',
  'chapters/pending',
  'scenes',
  'world',
  'world/objects',
  'world/pending',
  'structure',
  'structure/threads',
  'structure/arcs',
  'structure/foreshadowing',
  'structure/reveal',
  'memory',
  'bible',
  'imports',
  '.assistant',
  '.assistant/signals',
  '.assistant/reviews',
  '.assistant/proposals',
  // map-atlas 文件模型(map-atlas 实施计划 §2; N28/N29): 目录化节点/页面/图片 + 工作产物。
  'world/atlas',
  'world/atlas/nodes',
  'world/atlas/pages',
  'world/atlas/pending',
  'world/atlas/pending/nodes',
  'world/atlas/pending/pages',
  'world/atlas/images',
  '.assistant/atlas',
  '.assistant/atlas/runs',
  '.assistant/atlas/annotation-queue',
  '.assistant/atlas/decisions',
];

/**
 * bootstrap commit 确定性日期(UTC 2026-01-01; 与 store 事务 NOVELCRAFT_TX_DATE 同规范):
 * author/committer 时间戳固定, 使 commit OID 成为树/身份/日期/message 的纯函数——
 * 同内容重跑 → 同 OID(确定性, 独立审查加固 ③)。
 */
const BOOTSTRAP_COMMIT_DATE = '2026-01-01 00:00:00 +0000';

/**
 * bootstrap commit 固定身份 + 日期(N32: commit 身份/日期固定; 以 env 注入, 优先级高于
 * 一切 config, 不受全局 git config 与外部 author/committer 环境注入影响;
 * 配合 buildGitEnv 的 config 隔离, commit 确定性对 GIT_* 与 global config 免疫)。
 */
const BOOTSTRAP_COMMIT_IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'novelcraft',
  GIT_AUTHOR_EMAIL: 'novelcraft@example.invalid',
  GIT_COMMITTER_NAME: 'novelcraft',
  GIT_COMMITTER_EMAIL: 'novelcraft@example.invalid',
  GIT_AUTHOR_DATE: BOOTSTRAP_COMMIT_DATE,
  GIT_COMMITTER_DATE: BOOTSTRAP_COMMIT_DATE,
};

/** bootstrap commit 固定 message(确定性边界的一部分)。 */
const BOOTSTRAP_COMMIT_MESSAGE = 'init: bootstrap vault';

/** 初始 commit 固定包含的 initVault **实际落盘文件**(§22.2 book.yml + M6/N29 .gitignore; 目录不进 git)。 */
const BOOTSTRAP_INIT_FILES: readonly string[] = [BOOK_FILENAME, '.gitignore'];

/** OID 格式: sha1=40-hex / sha256=64-hex(独立审查加固 ⑤)。 */
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type ObjectFormat = 'sha1' | 'sha256';

/**
 * 最小 allowlist 环境基座(独立审查加固 ①): 只继承非 GIT_* 白名单键, 因此全部 Git
 * 重定向/配置注入变量 —— GIT_DIR、GIT_WORK_TREE、GIT_COMMON_DIR、GIT_OBJECT_DIRECTORY、
 * GIT_ALTERNATE_OBJECT_DIRECTORIES、GIT_NAMESPACE、GIT_REPLACE_REF_BASE、GIT_INDEX_FILE、
 * GIT_CONFIG_*(含动态 GIT_CONFIG_KEY_<n>)、GIT_CEILING_DIRECTORIES 等 —— 全部显式清除
 * (不继承即 unset); GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM 指向 /dev/null + GIT_CONFIG_NOSYSTEM=1
 * 隔离 global/system 配置(commit 确定性不受外部 gitconfig 影响); GIT_NO_REPLACE_OBJECTS=1
 * 禁 replace refs(加固 ② env 双保险); LC_ALL/LANG=C 固定英文错误输出。
 * GIT_DEFAULT_HASH 单独受控透传: 它只决定 `git init` 的仓库 object format(sha1/sha256),
 * 不是重定向/注入面, 且是 SHA256 profile 的入口。
 * extra 只允许显式白名单内的受控 GIT_* 键(私有 index、身份/日期), 其余 GIT_* 为内部错误。
 */
const GIT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'SystemRoot',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
];

/** extra 中允许出现的受控 GIT_* 键(其余 GIT_* 一律内部错误——防未来误加重定向面)。 */
const GIT_ALLOWED_EXTRA: ReadonlySet<string> = new Set([
  'GIT_INDEX_FILE', // 私有 index(逐调用受控; 绝不来自外部环境)
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
]);

function buildGitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LC_ALL: 'C',
    LANG: 'C',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const defaultHash = process.env.GIT_DEFAULT_HASH;
  if (defaultHash !== undefined) env.GIT_DEFAULT_HASH = defaultHash; // 受控透传(见上)
  for (const k of GIT_ENV_ALLOWLIST) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  if (extra) {
    for (const k of Object.keys(extra)) {
      if (/^GIT_/.test(k) && !GIT_ALLOWED_EXTRA.has(k)) {
        throw new Error(`内部错误: 不允许的 GIT_* env 注入: ${k}`);
      }
      env[k] = extra[k];
    }
  }
  return env;
}

/** git CLI 薄封装(独立审查加固 ①②: 最小安全 env + --no-replace-objects/--no-optional-locks):
 * 失败抛错(带命令与 stderr), 便于定位。 */
function runGit(root: string, args: readonly string[], extraEnv?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('git', ['--no-replace-objects', '--no-optional-locks', ...(args as string[])], {
      cwd: root,
      env: buildGitEnv(extraEnv),
      stdio: 'pipe',
    }).toString('utf8');
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string })?.stderr;
    const msg =
      stderr === undefined
        ? String(err)
        : Buffer.isBuffer(stderr)
          ? stderr.toString('utf8')
          : String(stderr);
    throw new Error(`git ${args.join(' ')} failed in "${root}": ${msg.trim()}`);
  }
}

/** git 命令是否成功(exit 0; 1(unborn HEAD/无 staged)/128(未知 HEAD)等一律 false)。 */
function gitSucceeds(root: string, args: readonly string[]): boolean {
  try {
    execFileSync('git', ['--no-replace-objects', '--no-optional-locks', ...(args as string[])], {
      cwd: root,
      env: buildGitEnv(),
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

/** .git 内部关键路径(存在性检查 + 非 symlink + real containment)。 */
const GIT_INTERNAL_KEY_PATHS: readonly string[] = [
  'objects',
  'refs',
  'HEAD',
  'index',
  'info',
  'logs',
  'config',
  'hooks',
];

/**
 * 验证 .git 内部关键路径非 symlink 且 real containment(独立审查加固 ①): git 会跟随
 * .git/objects、.git/refs 等 symlink 在外部写对象/引用; 任一已存在条目是 symlink 或
 * realpath 逃出 .git 真实位置 → fail-closed。root 自身为 symlink 时以其真实位置为
 * canonical root(gitDir 的 realpath 必须仍在 realRoot 内)。
 */
function assertGitInternalSafe(root: string, gitDir: string): void {
  let realRoot: string;
  let realGit: string;
  try {
    realRoot = realpathSync(path.resolve(root));
    realGit = realpathSync(gitDir);
  } catch (err) {
    throw new Error(
      `bootstrapVaultGitHistory: 无法解析 .git 真实路径: ${(err as Error).message}`,
    );
  }
  const relGit = path.relative(realRoot, realGit);
  if (relGit === '..' || relGit.startsWith(`..${path.sep}`) || path.isAbsolute(relGit)) {
    throw new Error(
      `bootstrapVaultGitHistory: .git 真实位置在 vault 外, 拒绝操作 (N32/R9): ${realGit}`,
    );
  }
  for (const rel of GIT_INTERNAL_KEY_PATHS) {
    const p = path.join(gitDir, rel);
    let st;
    try {
      st = lstatSync(p, { throwIfNoEntry: false });
    } catch (err) {
      throw new Error(
        `bootstrapVaultGitHistory: 无法检查 .git/${rel}: ${(err as Error).message}`,
      );
    }
    if (st === undefined) continue;
    if (st.isSymbolicLink()) {
      throw new Error(
        `bootstrapVaultGitHistory: .git 内部路径是 symlink, 拒绝操作 (N32/R9): ${p}`,
      );
    }
    let real: string;
    try {
      real = realpathSync(p);
    } catch (err) {
      throw new Error(
        `bootstrapVaultGitHistory: 无法解析 .git/${rel} 真实路径: ${(err as Error).message}`,
      );
    }
    const relReal = path.relative(realGit, real);
    if (relReal === '..' || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal)) {
      throw new Error(
        `bootstrapVaultGitHistory: .git/${rel} 真实位置逃出 .git, 拒绝操作 (N32/R9): ${real}`,
      );
    }
  }
}

/**
 * 禁 replace refs/grafts/shallow 等 provenance 变换(独立审查加固 ②): 任何改变对象/历史
 * provenance 的状态一律 fail-closed(不盲信 git 解析结果); 全部 git 命令另带
 * --no-replace-objects + GIT_NO_REPLACE_OBJECTS=1(即使个别状态漏检, 读对象也不被替换)。
 */
function assertNoProvenanceState(gitDir: string): void {
  const replaceDir = path.join(gitDir, 'refs', 'replace');
  let rep;
  try {
    rep = lstatSync(replaceDir, { throwIfNoEntry: false });
  } catch (err) {
    throw new Error(
      `bootstrapVaultGitHistory: 无法检查 refs/replace: ${(err as Error).message}`,
    );
  }
  if (rep !== undefined) {
    if (rep.isSymbolicLink()) {
      throw new Error(
        `bootstrapVaultGitHistory: refs/replace 是 symlink, 拒绝操作 (N32/R9): ${replaceDir}`,
      );
    }
    if (rep.isDirectory()) {
      if (readdirSync(replaceDir).length > 0) {
        throw new Error(
          `bootstrapVaultGitHistory: 仓库存在 replace refs(改变对象 provenance), fail-closed (N32/R9): ${replaceDir}`,
        );
      }
    } else {
      throw new Error(
        `bootstrapVaultGitHistory: refs/replace 状态异常, fail-closed (N32/R9): ${replaceDir}`,
      );
    }
  }
  const packed = path.join(gitDir, 'packed-refs');
  if (existsSync(packed)) {
    const body = readFileSync(packed, 'utf8');
    if (/ refs\/replace\//.test(body)) {
      throw new Error(
        `bootstrapVaultGitHistory: packed-refs 含 replace refs(改变对象 provenance), fail-closed (N32/R9): ${packed}`,
      );
    }
  }
  for (const rel of ['info/grafts', 'shallow'] as const) {
    const p = path.join(gitDir, rel);
    if (existsSync(p)) {
      throw new Error(
        `bootstrapVaultGitHistory: 仓库处于 ${rel} 状态(改变历史 provenance), fail-closed (N32/R9): ${p}`,
      );
    }
  }
}

/** 仓库 object format 探测(sha1/sha256 → 40/64-hex OID; 独立审查加固 ⑤)。 */
function gitObjectFormat(root: string): ObjectFormat {
  const fmt = runGit(root, ['rev-parse', '--show-object-format']).trim();
  if (fmt !== 'sha1' && fmt !== 'sha256') {
    throw new Error(
      `bootstrapVaultGitHistory: 仓库 object format 不受支持(仅 sha1/sha256): "${fmt}"`,
    );
  }
  return fmt;
}

/** 读文件原始字节; 不存在返回 null。 */
function readFileOrNull(p: string): Buffer | null {
  try {
    return readFileSync(p);
  } catch {
    return null;
  }
}

/** 字节快照比较(null 代表文件不存在)。 */
function bytesEqual(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}

/**
 * N32 / ADR-0021 bootstrap: 把新建 vault 的 HEAD 从未生(branch 无 commit)推进到
 * **精确初始 commit**——ADR-0021 事务(私有 index 从 base HEAD tree 初始化、
 * `git commit-tree <tree> -p <base HEAD>`、`update-ref` CAS 推进)要求事务启动时
 * 已有 HEAD, 而原 initVault 只 `git init` 不建 commit, 首个事务将无 base 可用。
 *
 * 契约(fail-closed + 幂等 + 确定性; 独立审查加固 ①–⑤):
 * - 仅当 `.git` 为真实目录且 HEAD 不存在(unborn)时建 commit; `.git` 缺失/gitfile/
 *   symlink 与 HEAD 已存在(已有历史)一律 **no-op**——绝不新增 commit、绝不捕获
 *   工作区外部文件(预存 staged/untracked 皆不动)。
 * - 所有 git 命令最小安全 env(buildGitEnv): 清除 GIT_DIR/WORK_TREE/COMMON_DIR/
 *   OBJECT_DIRECTORY/ALTERNATE/NAMESPACE/REPLACE/GIT_INDEX_FILE/CONFIG 等全部
 *   重定向/配置注入变量; 私有 index 显式受控(GIT_INDEX_FILE 指向 `.git` 内临时
 *   index); 隔离 global/system 配置。`.git` 内部关键路径(objects/refs/HEAD/index/
 *   info/logs/config/hooks)逐一验证非 symlink 且 real containment(加固 ①)。
 * - 禁 replace refs/grafts/shallow 等 provenance 变换(加固 ②): 存在即 fail-closed;
 *   全部命令带 --no-replace-objects/GIT_NO_REPLACE_OBJECTS=1, read-tree 不读替换。
 * - commit 确定性(加固 ③): author/committer name/email/date 与 message 全固定,
 *   tree = 声明文件的工作区字节(hash-object 原样, 无 clean filter), 不受 GIT_* 与
 *   global config 影响; 同内容重跑 → 同 OID。
 * - **写对象/ref 前的 fail-closed 预检**(零副作用): 共享 `.git/index.lock` 存在或
 *   共享 index 存在任何预存 staged(N32/ADR-0021 §2)→ 抛错, 不写对象、不写 ref、
 *   不触碰 index(不自动清除、不并入)。
 * - `update-ref <ref> <commit> <zero-oid>` 三参 CAS(加固 ③): unborn 期望 = 合法全零
 *   OID(按仓库 object format: sha1=40 / sha256=64, 加固 ⑤); 发布点前后复核 symbolic
 *   HEAD 仍指向被更新分支(加固 ④); CAS 失败 = 跨进程竞争 → loser 安全识别: 分支现值
 *   == 本地确定性 commit(同内容必同 OID)→ 视为已 bootstrap no-op; 指向其他 commit
 *   → 冲突抛错, 绝不 force 覆盖; 分支仍 unborn(并发 ref lock, 无法判定)→ fail-closed。
 * - 共享 index 安装仅由 CAS 赢家执行(另一进程负责时不得重复写): 安装前复核 lock 缺席
 *   且 index 字节与预检快照一致(TOCTOU 收紧), `read-tree <commit>`(禁 replace)失败
 *   同样抛错——不污染、不覆盖、不清除共享 index。
 * - 任一 git 步骤失败: 清理私有 index 临时目录后抛错, 零残留。
 */
export function bootstrapVaultGitHistory(root: string): void {
  const r = path.resolve(root);

  // 前置 1: .git 必须为真实目录。缺失/gitfile/symlink → no-op(initVault 的 .git
  // 校验已在其更早阶段 fail-closed; 「book.yml 已存在但 .git 缺失」由 initVault
  // 先安全 git init 再调用本函数, 不把直接调用的非仓库路径当错误)。
  const gitDir = path.join(r, '.git');
  const gitStat = lstatSync(gitDir, { throwIfNoEntry: false });
  if (gitStat === undefined || !gitStat.isDirectory()) return;

  // 前置 2: .git 内部关键路径非 symlink 且 real containment(加固 ①)。
  assertGitInternalSafe(r, gitDir);

  // 前置 3: 禁 replace refs/grafts/shallow 等 provenance 变换(加固 ②)。
  assertNoProvenanceState(gitDir);

  // 前置 4: HEAD 已存在(已有历史)→ 幂等 no-op, 绝不新增 commit。
  if (gitSucceeds(r, ['rev-parse', '--verify', '--quiet', 'HEAD'])) return;

  // 前置 5: fail-closed 预检(写任何对象/ref 之前; 全读, 零副作用):
  // - 共享 .git/index.lock 已存在(并发 git 临界区, 无法证明归属)→ 拒绝;
  // - 共享 index 存在任何预存 staged → 拒绝(N32/ADR-0021 §2: 不自动清除、不并入);
  //   通过时快照共享 index 字节, 供安装前 TOCTOU 复核。
  const indexLock = path.join(gitDir, 'index.lock');
  if (lstatSync(indexLock, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(
      `bootstrapVaultGitHistory: 共享 index.lock 已存在, 无法证明归属, fail-closed 零副作用 (N32/R9): ${indexLock}`,
    );
  }
  const indexPath = path.join(gitDir, 'index');
  const indexSnapshot = readFileOrNull(indexPath);
  if (!gitSucceeds(r, ['diff', '--cached', '--quiet'])) {
    throw new Error(
      `bootstrapVaultGitHistory: 共享 index 存在预存 staged, fail-closed 零副作用 (N32/ADR-0021 §2): ${r}`,
    );
  }

  // 前置 6: 分支名取自 HEAD symbolic ref(git init 默认分支可能是 master 或 main,
  // 不硬编码; unborn HEAD 下 symbolic-ref 仍有效)。非 refs/heads/ 前缀或含空白/
  // 换行(注入面)→ fail-closed。
  const ref = runGit(r, ['symbolic-ref', 'HEAD']).trim();
  if (!/^refs\/heads\/[^\s]+$/.test(ref)) {
    throw new Error(
      `bootstrapVaultGitHistory: HEAD 未指向本地分支, got "${ref}" (N32/R9)`,
    );
  }

  // 前置 7: 目标分支必须尚不存在(unborn HEAD 却已有分支引用 = 状态不一致, 拒绝覆盖)。
  if (gitSucceeds(r, ['show-ref', '--verify', '--quiet', ref])) {
    throw new Error(
      `bootstrapVaultGitHistory: 分支 "${ref}" 已存在但 HEAD unborn, 拒绝覆盖 (N32/R9)`,
    );
  }

  // 前置 8: initVault 声明的实际落盘文件。目录/其他条目一律 fail-closed(绝不 add
  // 目录递归卷入外部文件); 直接调用场景缺文件则跳过, 一个都不在则视为无语义内容。
  const bootstrapFiles: string[] = [];
  for (const name of BOOTSTRAP_INIT_FILES) {
    const st = lstatSync(path.join(r, name), { throwIfNoEntry: false });
    if (st === undefined) continue;
    if (!st.isFile()) {
      throw new Error(
        `bootstrapVaultGitHistory: "${name}" 不是普通文件, 拒绝加入初始 commit (N32/R9)`,
      );
    }
    bootstrapFiles.push(name);
  }
  if (bootstrapFiles.length === 0) return;

  // 前置 9: object format 探测(sha1/sha256 → zero OID 长度, 加固 ⑤)。
  const fmt = gitObjectFormat(r);
  const oidLen = fmt === 'sha256' ? 64 : 40;
  const zeroOid = '0'.repeat(oidLen);

  const tmpDir = mkdtempSync(path.join(gitDir, 'novelcraft-bootstrap-'));
  try {
    // 私有 index: 先把每个声明文件写成 blob 对象, 再经 --cacheinfo 精确 stage
    // (mode 100644, 无 clean filter 变换 → tree 字节 = 工作区字节)。未声明路径
    // (预存 staged/untracked/外部文件)永远不在其中。
    const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: path.join(tmpDir, 'index') };
    for (const name of bootstrapFiles) {
      const blob = runGit(r, ['hash-object', '-w', name], indexEnv).trim();
      if (!OID_RE.test(blob)) {
        throw new Error(`bootstrapVaultGitHistory: hash-object 输出异常: ${blob}`);
      }
      runGit(r, ['update-index', '--add', '--cacheinfo', '100644', blob, name], indexEnv);
    }
    const tree = runGit(r, ['write-tree'], indexEnv).trim();
    if (!OID_RE.test(tree)) {
      throw new Error(`bootstrapVaultGitHistory: write-tree 输出异常: ${tree}`);
    }
    const commit = runGit(
      r,
      [
        '-c', 'commit.gpgsign=false',
        '-c', 'i18n.commitEncoding=utf-8',
        '-c', 'user.name=novelcraft',
        '-c', 'user.email=novelcraft@example.invalid',
        'commit-tree', tree, '-m', BOOTSTRAP_COMMIT_MESSAGE,
      ],
      BOOTSTRAP_COMMIT_IDENTITY_ENV,
    ).trim();
    if (!OID_RE.test(commit)) {
      throw new Error(`bootstrapVaultGitHistory: commit-tree 输出异常: ${commit}`);
    }

    // 发布点复核(加固 ④): update-ref CAS 前再次验证 symbolic HEAD 未切换(被切到
    // 其他分支/游离时, 拒绝更新目标 ref; 不 force)。
    const headBeforeCas = runGit(r, ['symbolic-ref', 'HEAD']).trim();
    if (headBeforeCas !== ref) {
      throw new Error(
        `bootstrapVaultGitHistory: symbolic HEAD 在发布前切换(${headBeforeCas || '(detached)'}), 拒绝更新 ${ref} (N32/R9)`,
      );
    }

    // 三参 CAS: `update-ref <ref> <commit> <zero-oid>`(unborn 期望 = 合法全零 OID;
    // sha1=40 / sha256=64)。跨进程并发时最多一赢家, 其余 CAS 失败进入 loser 路径。
    let casFailed: Error | null = null;
    try {
      runGit(r, ['update-ref', ref, commit, zeroOid]);
    } catch (err) {
      casFailed = err as Error;
    }

    if (casFailed !== null) {
      // loser 路径(跨进程最多一赢家): 安全识别「同一确定性 commit」或「冲突」。
      // commit 身份/日期/message/tree 全固定 → 同内容必同 OID。
      let current: string | null = null;
      if (gitSucceeds(r, ['rev-parse', '--verify', '--quiet', ref])) {
        current = runGit(r, ['rev-parse', '--verify', ref]).trim();
      }
      if (current === commit) {
        // 并发进程已发布与本地字节级相同的确定性 commit → 视为已 bootstrap;
        // 不重复写共享 index(安装由 CAS 赢家负责)。
        return;
      }
      if (current === null) {
        throw new Error(
          `bootstrapVaultGitHistory: update-ref CAS 失败且分支仍 unborn(并发 ref lock?), 无法判定归属, fail-closed (N32/R9): ${casFailed.message}`,
        );
      }
      throw new Error(
        `bootstrapVaultGitHistory: update-ref CAS 失败, 分支 "${ref}" 已指向其他 commit ${current}(期望确定性 commit ${commit}), 拒绝覆盖 (N32/R9)`,
      );
    }

    // 发布后复核(加固 ④): symbolic HEAD 仍指向被更新的分支(状态一致性)。
    const headAfterCas = runGit(r, ['symbolic-ref', 'HEAD']).trim();
    if (headAfterCas !== ref) {
      throw new Error(
        `bootstrapVaultGitHistory: symbolic HEAD 在发布后切换(${headAfterCas || '(detached)'}), 状态异常 (N32/R9)`,
      );
    }

    // 共享 index 安装(仅 CAS 赢家): 安装前复核 lock 缺席 + index 字节与预检快照一致
    // (TOCTOU 收紧——期间外部 git add 会改变字节或产生 lock, 一律 fail-closed);
    // `read-tree <commit>` 在 --no-replace-objects 下读树, 失败(如并发 index.lock)
    // 同样抛错, 不静默覆盖、不清除共享 index。
    if (lstatSync(indexLock, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(
        `bootstrapVaultGitHistory: 安装共享 index 前发现 index.lock, fail-closed (N32/R9): ${indexLock}`,
      );
    }
    if (!bytesEqual(readFileOrNull(indexPath), indexSnapshot)) {
      throw new Error(
        `bootstrapVaultGitHistory: 共享 index 在事务期间被外部 git 改写, 拒绝安装 (N32/R9): ${indexPath}`,
      );
    }
    runGit(r, ['read-tree', commit]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 初始化 vault: 建目录树骨架、写 book.yml、`git init`, 并建立 **精确初始 commit**
 * (N32/ADR-0021: 写事务要求启动时已有 base HEAD; 初始 commit 仅含 initVault 实际
 * 落盘文件 book.yml/.gitignore, 禁止 `git add -A`, 见 bootstrapVaultGitHistory)。
 *
 * - 幂等: book.yml 已存在则原样返回(resolveVaultRoot 同款判据), 不重写、不抛错;
 *   已有 git 历史绝不新增 commit、绝不捕获工作区外部文件。
 * - 确定性: 同一 rootPath + bookMeta 产出相同目录与 book.yml 字节; 初始 commit
 *   身份/日期/message 固定、tree 精确(commit OID 确定性, 不受 GIT_* 与 global
 *   config 影响)。
 * - 迁移: 旧 vault(无 atlas 目录/无图片 gitignore 行)再次调用时补齐目录与
 *   gitignore 行(幂等, 不重写 book.yml、不重复 git init); 半初始化(book.yml 已写
 *   但初始 commit 未建)→ 幂等补建 commit。
 * - **半初始化缺 .git**: book.yml 已存在但 `.git` 缺失 → 先以最小安全 env `git init`
 *   再 bootstrap(或 git init 失败时明确抛错), **绝不返回无 HEAD 的 vault**。
 * - 全部 git 命令走最小安全 env 与 fail-closed 预检(见 bootstrapVaultGitHistory):
 *   预存 staged / 共享 index.lock / .git 内部 symlink / replace refs/grafts/shallow
 *   均在写对象/ref 前拒绝, 零 git 副作用。
 */
export function initVault(rootPath: string, bookMeta: BookMeta): VaultPaths {
  const root = path.resolve(rootPath);
  const bookYml = path.join(root, BOOK_FILENAME);

  // 目录骨架 + gitignore 行始终幂等补齐(旧 vault 迁移: 无 atlas 目录也能补齐)。
  mkdirSync(root, { recursive: true });
  for (const dir of VAULT_DIRS) {
    // R9: 建目录前逐段 guard + symlink 检查——固定子目录被预置为 symlink(无论指向
    // vault 外还是 vault 内其他目录)时第一处即 fail-closed, 绝不 mkdirSync 跟随
    // 链接在错误位置建目录。
    const abs = path.join(root, dir);
    guardPath(root, abs);
    assertNoSymlinkOnPath(root, abs);
    mkdirSync(abs, { recursive: true });
  }

  // R9: .git 条目无条件检查(book 分支之前, 幂等 re-init 同样执行)——每书独立
  // repo 契约(§22.2「.git init」)。预置 .git symlink(指向外部或 dangling)会让
  // git 在错误位置初始化/操作; 预置 gitfile(普通文件 `gitdir: <path>`)是外部
  // worktree 形态, 同样拒绝(本仓库无 worktree 契约)。普通 .git 目录(已初始化,
  // 幂等重 init)与不存在(全新 init)放行。检查在 book 写前: 恶意条目时 book.yml
  // 不落盘; 已有 book 的 re-init 也不会放行外部 gitdir。
  const gitEntry = path.join(root, '.git');
  const gitStat = lstatSync(gitEntry, { throwIfNoEntry: false });
  if (gitStat !== undefined && !gitStat.isDirectory()) {
    if (gitStat.isSymbolicLink()) {
      throw new Error(
        `Path "${gitEntry}" is a symlink: 每书独立 repo 拒绝 .git symlink (R9)`,
      );
    }
    // 普通文件 = gitfile(`gitdir: ...`)或未知条目: 一律 fail-closed。
    throw new Error(
      `Path "${gitEntry}" is not a directory: 每书独立 repo 拒绝 .git gitfile/未知条目 (R9)`,
    );
  }

  // R9: book.yml 路径在 existsSync 判断前即做逐段 symlink 检查, fail-early。
  // 预置 dangling internal symlink 会被 existsSync 判为不存在而进入写入分支
  // (writeFileSync 跟随链接在 vault 内错误目标落盘); valid internal symlink
  // 虽最终被末尾 paths() 拒绝, 但此前已完成全部建目录副作用。两者都在此处拒绝。
  assertNoSymlinkOnPath(root, bookYml);

  if (!existsSync(bookYml)) {
    const title = validateTitle(bookMeta.title);
    const reveal = validateRevealPolicy(
      bookMeta.default_reveal_policy ?? DEFAULT_REVEAL_POLICY,
    );
    if (bookMeta.target_length !== undefined) {
      validateEnum(bookMeta.target_length, TARGET_LENGTHS, 'target_length');
    }
    if (bookMeta.current_stage !== undefined) {
      validateEnum(bookMeta.current_stage, CURRENT_STAGES, 'current_stage');
    }

    // R9: book.yml 落盘前 guard(预置 dangling symlink 时写出会被链接重定向到 vault 外)。
    writeFileSync(guardPath(root, bookYml), serializeBookYaml(bookMeta, title, reveal), 'utf-8');

    // README 约定: git 操作用 node:child_process 调 git CLI(§22.2「.git init」);
    // 最小安全 env(清除 GIT_* 重定向/配置注入, 隔离 global config)。
    runGit(root, ['init']);
  } else if (gitStat === undefined) {
    // 半初始化缺 .git: book.yml 已存在但 .git 缺失 → 安全 git init 后由
    // bootstrapVaultGitHistory 补初始 commit; git init 失败 → runGit 抛错(明确
    // fail), 绝不返回无 HEAD 的 vault。
    runGit(root, ['init']);
  }

  // M6 Track A1: 派生索引不提交 git(.assistant/rag-index.json; 可随时全量重建)。
  // N29: world/atlas/images/ 图片字节不进入 git(本地保留, gitignore)。
  ensureVaultGitignore(root, ['.assistant/rag-index.json', 'world/atlas/images/']);

  // N32 / ADR-0021: 保证对外返回前 HEAD 已存在(精确初始 commit)。新 vault 建立
  // bootstrap commit(仅 initVault 声明文件); 已有历史(HEAD 存在)→ no-op; 半
  // 初始化(book.yml 已写、commit 中断)→ 幂等补建。契约见 bootstrapVaultGitHistory。
  bootstrapVaultGitHistory(root);

  return paths(root);
}

/**
 * 从任意子路径(文件或目录)向上查找 book.yml 定位 vault 根; 找不到抛错。
 * 等价 novel_id 隔离边界(R9: 以工作区根为边界)。
 */
export function resolveVaultRoot(startPath: string): string {
  const start = path.resolve(startPath);
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, BOOK_FILENAME))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // 到达文件系统根, 未找到。
    }
    dir = parent;
  }
  throw new Error(
    `No vault root found: no ${BOOK_FILENAME} in or above "${start}"`,
  );
}

// ============================================================================
// validateInitializedVault(N34 工作区隔离: 只读验证「已初始化」vault)。
// 只读 seam(零 fs 写、零 git 写): 供 DSH 会话绑定(bindByCwd)与工具/事件钩子
// 在把任意目录当 vault 前做 fail-closed 前置校验; 绝不自动 init。
// ============================================================================

export interface VaultValidationResult {
  ok: boolean;
  /** 第一个失败原因(作者语言; ok=true 时为 undefined) */
  reason?: string;
}

const VAULT_VALIDATION_OK: VaultValidationResult = { ok: true };

function validationFail(reason: string): VaultValidationResult {
  return { ok: false, reason };
}

/**
 * 逐行读取 book.yml 顶层 `key: value` 标量字段(校验专用; 无 YAML 依赖)。
 * 覆盖 initVault 确定性输出的双引号标量(yamlQuote)与手写 `title: 半初始化`
 * 这类 plain scalar; 单引号标量按 YAML `''` 转义。含 `:` 的嵌套/块/非标量行
 * 跳过(不解释)→ 关键字段缺失时由调用方 fail-closed。畸形引号的值记为 undefined
 * (不加入字段表; title 依赖它的场景由调用方判缺失/非法)。返回字段表。
 */
function parseBookYamlFields(content: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    const value = unquoteBookYamlScalar(line.slice(idx + 1).trim());
    if (value !== undefined) fields.set(key, value);
  }
  return fields;
}

/** 解引一个标量: 双引号(yaml 转义子集)/单引号(YAML `''`)/plain(原样)。畸形引号返回 undefined。 */
function unquoteBookYamlScalar(value: string): string | undefined {
  if (value.length === 0) return '';
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return undefined; // 未闭合: 非法
    const inner = value.slice(1, -1);
    return inner
      .replace(/\\(\\|"|n|r|t)/g, (_match, ch: string) =>
        ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch === '"' ? '"' : '\\')
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return undefined;
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * 验证 root 是一个「已初始化」vault(R9/N34 工作区隔离 fail-closed 前置):
 * 1. book.yml 合法: 存在、普通非 symlink 文件、可解析出合法 title
 *    (非空字符串、无空字节, 与 initVault 的 validateTitle 同规则), 可选枚举字段
 *    (default_reveal_policy / target_length / current_stage)白名单内;
 * 2. `.git` 为真实目录(非 symlink、非 gitfile)且 HEAD 可解析(已建初始 commit;
 *    只读 `git rev-parse --verify HEAD`, 最小安全 env, 零 git 副作用);
 * 3. 必要骨架存在: VAULT_DIRS 全部为真实目录(非 symlink)。
 * 任一失败返回 ok:false + 首个原因; 全部通过返回 ok:true。纯只读。
 */
export function validateInitializedVault(root: string): VaultValidationResult {
  const r = path.resolve(root);

  // --- 1. book.yml 合法 ---
  const bookYml = path.join(r, BOOK_FILENAME);
  let bookStat;
  try {
    bookStat = lstatSync(bookYml, { throwIfNoEntry: false });
  } catch (err) {
    return validationFail(`无法检查 ${BOOK_FILENAME}: ${(err as Error).message}`);
  }
  if (bookStat === undefined) return validationFail(`${BOOK_FILENAME} 不存在(不是已初始化的 vault)`);
  if (bookStat.isSymbolicLink()) return validationFail(`${BOOK_FILENAME} 是 symlink, 拒绝(fail-closed)`);
  if (!bookStat.isFile()) return validationFail(`${BOOK_FILENAME} 不是普通文件`);
  let bookContent: string;
  try {
    bookContent = readFileSync(bookYml, 'utf8');
  } catch (err) {
    return validationFail(`${BOOK_FILENAME} 读取失败: ${(err as Error).message}`);
  }
  const fields = parseBookYamlFields(bookContent);
  const title = fields.get('title');
  if (typeof title !== 'string') {
    return validationFail(`${BOOK_FILENAME} 缺合法 title(非字符串或引号未闭合)`);
  }
  try {
    validateTitle(title);
  } catch (err) {
    return validationFail(`${BOOK_FILENAME} title 非法: ${(err as Error).message}`);
  }
  if (fields.has('default_reveal_policy')) {
    const value = fields.get('default_reveal_policy');
    if (typeof value !== 'string') return validationFail(`${BOOK_FILENAME} default_reveal_policy 非法`);
    try {
      validateRevealPolicy(value);
    } catch (err) {
      return validationFail(`${BOOK_FILENAME} default_reveal_policy 非法: ${(err as Error).message}`);
    }
  }
  for (const field of ['target_length', 'current_stage'] as const) {
    if (fields.has(field)) {
      const value = fields.get(field);
      if (typeof value !== 'string') return validationFail(`${BOOK_FILENAME} ${field} 非法`);
      try {
        validateEnum(value, field === 'target_length' ? TARGET_LENGTHS : CURRENT_STAGES, field);
      } catch (err) {
        return validationFail(`${BOOK_FILENAME} ${field} 非法: ${(err as Error).message}`);
      }
    }
  }

  // --- 2. .git 为真实目录且 HEAD 可解析 ---
  const gitDir = path.join(r, '.git');
  let gitStat;
  try {
    gitStat = lstatSync(gitDir, { throwIfNoEntry: false });
  } catch (err) {
    return validationFail(`无法检查 .git: ${(err as Error).message}`);
  }
  if (gitStat === undefined) return validationFail('.git 不存在(伪 book.yml / 半初始化, 拒绝)');
  if (gitStat.isSymbolicLink()) return validationFail('.git 是 symlink, 拒绝(fail-closed)');
  if (!gitStat.isDirectory()) return validationFail('.git 不是目录(gitfile/未知条目, 拒绝)');
  if (!gitSucceeds(r, ['rev-parse', '--verify', '--quiet', 'HEAD'])) {
    return validationFail('.git 无 HEAD(unborn, 未建初始 commit, 拒绝)');
  }

  // --- 3. 必要骨架存在 ---
  for (const dir of VAULT_DIRS) {
    const abs = path.join(r, dir);
    let st;
    try {
      st = lstatSync(abs, { throwIfNoEntry: false });
    } catch (err) {
      return validationFail(`无法检查骨架目录 ${dir}: ${(err as Error).message}`);
    }
    if (st === undefined) return validationFail(`骨架缺失目录: ${dir}`);
    if (st.isSymbolicLink()) return validationFail(`骨架目录是 symlink, 拒绝: ${dir}`);
    if (!st.isDirectory()) return validationFail(`骨架路径不是目录: ${dir}`);
  }

  return VAULT_VALIDATION_OK;
}

/**
 * 防路径穿越(R9): 规范化后必须仍在 root 内, 否则抛错。
 * 返回规范化后的逻辑绝对路径(供 readAsset/writeAsset 直接使用)。
 *
 * 双层 containment:
 * 1. lexical: `path.resolve`/`path.relative` 规范化后必须在 root 内;
 * 2. real: root 与 target 各自按真实文件系统解析(target 不存在时取最深
 *    「条目本身存在」的祖先的 realpath 再拼接剩余段; 祖先存在性用 lstat 判定,
 *    不跟随 symlink), 任何经 symlink 解析后逃出 canonical root 的路径一律拒绝。
 *    root 自身为 symlink 时, 其真实位置即 canonical root; 指向 root 内部的
 *    symlink 放行。最深条目是 dangling symlink(realpath 失败)时 fail-closed
 *    拒绝, 绝不回退父目录(否则写操作会跟随该链接在 vault 外创建文件)。
 *
 * 说明: 本函数只做同步调用范围内的可实现检查(条目存在性 + realpath 解析), 不解决
 * 检查与后续文件操作之间的 TOCTOU 竞态。
 */
export function guardPath(root: string, p: string): string {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, p);
  const rel = path.relative(rootResolved, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(
      `Path escapes vault root: "${p}" (resolved to "${target}")`,
    );
  }
  // real 检查: 按真实文件系统位置判定 containment(防 symlink 逃逸)。
  const realRoot = realLocation(rootResolved);
  const realTarget = realLocation(target);
  const relReal = path.relative(realRoot, realTarget);
  if (
    relReal === '..' ||
    relReal.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relReal)
  ) {
    throw new Error(
      `Path escapes vault root via symlink: "${p}" (real path "${realTarget}" is outside canonical root "${realRoot}")`,
    );
  }
  return target;
}

/**
 * 把 p 解析为真实位置: 取最深「条目本身存在」的祖先的 realpath, 再拼接其后
 * 不存在的路径段。这样 target 尚不存在(即将被创建)时也能按真实文件系统判定
 * 其落点。
 *
 * 条目存在性用 lstat(不跟随 symlink)判定: dangling symlink 的条目本身仍存在,
 * 因此一旦最深条目是 dangling symlink(realpath 失败), 直接 fail-closed 抛错——
 * 绝不回退到父目录。否则 `writeFileSync` 会跟随该链接在 vault 外创建文件
 * (旧实现用 existsSync 会把 dangling symlink 误判为不存在的普通路径)。
 * 与之前一致的行为: 普通不存在路径回退父目录, 指向有效目标的 symlink 走 realpath。
 * 其他解析失败(权限拒绝、符号链接环、ENOTDIR、盘符不存在等)同样抛错——fail-closed。
 */
function realLocation(p: string): string {
  const suffix: string[] = [];
  let cur = p;
  for (;;) {
    let entry;
    try {
      entry = lstatSync(cur, { throwIfNoEntry: false });
    } catch (err) {
      // lstat 本身失败(如路径穿过普通文件的 ENOTDIR): fail-closed。
      throw new Error(
        `Cannot resolve real path of "${p}": ${(err as Error).message}`,
      );
    }
    if (entry !== undefined) {
      // 路径条目本身存在(文件/目录/symlink, 含 dangling symlink)。
      try {
        const real = realpathSync(cur);
        return suffix.length === 0 ? real : path.join(real, ...suffix.reverse());
      } catch (err) {
        // lstat 成功但 realpath 失败 = dangling symlink / 符号链接环:
        // fail-closed, 不得回退父目录。
        throw new Error(
          `Cannot resolve real path of "${p}": ${(err as Error).message}`,
        );
      }
    }
    // 条目确实不存在: 回退到父目录继续找最深存在祖先。
    const parent = path.dirname(cur);
    if (parent === cur) {
      // 到达文件系统根仍不存在(如 Windows 无此盘符): 无法解析真实位置。
      throw new Error(`Cannot resolve real path of "${p}"`);
    }
    suffix.push(path.basename(cur));
    cur = parent;
  }
}

/**
 * 单文件路径段白名单校验(R9): 拒绝空、`.`、`..` 与任何目录分隔符(`/ \`)及控制字符。
 * 供 paths() 全部动态文件构造器与外部(store/world 等核心包)复用; 合法中文 slug
 * (如「诡秘之主」)与含空格 id 不受影响。返回原值(仅校验)。
 */
export function assertSafePathSegment(seg: string, what = 'path segment'): string {
  if (typeof seg !== 'string' || seg.length === 0 || seg === '.' || seg === '..') {
    throw new Error(`${what} 非法路径段: ${JSON.stringify(seg)}`);
  }
  if (/[/\\]/.test(seg) || /[\u0000-\u001f\u007f-\u009f]/.test(seg)) {
    throw new Error(`${what} 非法路径段: ${JSON.stringify(seg)}`);
  }
  return seg;
}

/**
 * 章节编号校验(§22.2 NNN 三零填充): 必须为正整数(1-based), 非整/0/负数抛错。
 */
function assertChapterIndex(n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`chapterFile: 章节号必须是正整数, got ${JSON.stringify(n)}`);
  }
  return String(n).padStart(3, '0');
}

/**
 * vault 内路径组件 symlink 检查(R9, paths 构造层): 沿 root 相对路径逐段
 * `lstatSync(entry, { throwIfNoEntry: false })`(不跟随), 任一**已存在**的组件是
 * SymbolicLink 一律 fail-closed——包括指向 vault 内部其他目录/文件的 symlink
 * (guardPath 的 real containment 会放行 root 内 symlink, 但 kind 边界目录/文件
 * 被重定向会破坏资产语义, 如 world/objects→bible 或 objectFile 目标→bible 文件)。
 * 逐段检查同时封住 parent 链(如 world→symlink 时, world/objects 的检查也会命中)。
 * 不存在的组件(待创建)放行, 由更深的父段继续检查; lstat 本身失败(如中间组件
 * 是普通文件导致 ENOTDIR)同样 fail-closed。root 自身为 symlink 不在此检查范围
 * (guardPath 以其真实位置为 canonical root, 且 rel 从 root 之下开始分段)。
 */
export function assertNoSymlinkOnPath(root: string, p: string): void {
  const rootResolved = path.resolve(root);
  const rel = path.relative(rootResolved, path.resolve(p));
  let cur = rootResolved;
  for (const seg of rel.split(path.sep)) {
    if (seg.length === 0 || seg === '.') continue;
    cur = path.join(cur, seg);
    let entry;
    try {
      entry = lstatSync(cur, { throwIfNoEntry: false });
    } catch (err) {
      // 中间组件穿透普通文件(ENOTDIR)/权限失败等: 无法验证 → fail-closed。
      throw new Error(
        `Cannot verify path "${p}" at "${cur}": ${(err as Error).message}`,
      );
    }
    if (entry !== undefined && entry.isSymbolicLink()) {
      throw new Error(
        `Path "${p}" crosses a symlink inside the vault: "${cur}"`,
      );
    }
  }
}

/** 带 guard 的读取(R12: 文件是唯一真相)。 */
export function readAsset(root: string, relPath: string): string {
  const p = guardPath(root, relPath);
  return readFileSync(p, 'utf-8');
}

/** 带 guard 的写入; 写前确保父目录存在。 */
export function writeAsset(root: string, relPath: string, content: string): void {
  const p = guardPath(root, relPath);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf-8');
}

/**
 * slugify(N10 / R63): id = 文件名 slug; id 可含中文(如「诡秘之主」)。
 *
 * - 保留 CJK 字符;
 * - 归一空白: 连续空白 → 单个 `-`;
 * - 仅剔除文件系统路径非法字符(`/ \ : * ? " < > |`, 映射为 `-`)与控制字符(移除);
 * - 限长 64(截断后去尾部 `-`);
 * - 空结果或只剩非法字符时抛错;
 * - 冲突去重: 传 `existing`(Set<string>)时, 同名追加 `-2`/`-3` 等短后缀;
 *   不修改传入的 set。
 */
export function slugify(title: string, existing?: Set<string>): string {
  if (typeof title !== 'string') {
    throw new Error('slugify: title must be a string');
  }
  const base = title
    .replace(/[\s/\\:*?"<>|]+/g, '-') // 空白 + 路径非法字符 → '-'
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '') // 控制字符 → 移除
    .replace(/-+/g, '-') // 折叠连字符
    .replace(/^-+|-+$/g, '') // 去首尾连字符
    .slice(0, SLUG_MAX_LENGTH) // 限长 64
    .replace(/-+$/g, ''); // 截断后重去尾部连字符
  if (base.length === 0) {
    throw new Error(`slugify: cannot produce a non-empty slug from "${title}"`);
  }
  return dedupe(base, existing);
}

/** 同名冲突时追加 `-2`/`-3` 等短后缀(N10)。 */
function dedupe(slug: string, existing?: Set<string>): string {
  if (!existing || !existing.has(slug)) {
    return slug;
  }
  let n = 2;
  while (existing.has(`${slug}-${n}`)) {
    n += 1;
  }
  return `${slug}-${n}`;
}

function validateTitle(title: unknown): string {
  if (typeof title !== 'string') {
    throw new Error('bookMeta.title is required and must be a string');
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error('bookMeta.title must be a non-empty, non-whitespace string');
  }
  if (trimmed.includes('\0')) {
    throw new Error('bookMeta.title must not contain null bytes');
  }
  return trimmed;
}

function validateRevealPolicy(value: string): RevealPolicy {
  if ((REVEAL_POLICIES as readonly string[]).includes(value)) {
    return value as RevealPolicy;
  }
  throw new Error(
    `Invalid default_reveal_policy "${value}" (expected one of: ${REVEAL_POLICIES.join(', ')})`,
  );
}

function validateEnum(
  value: string,
  allowed: readonly string[],
  field: string,
): void {
  if (allowed.includes(value)) {
    return;
  }
  throw new Error(
    `Invalid ${field} "${value}" (expected one of: ${allowed.join(', ')})`,
  );
}

/** 按固定字段顺序序列化 book.yml(确定性输出)。 */
function serializeBookYaml(
  meta: BookMeta,
  title: string,
  reveal: RevealPolicy,
): string {
  const language = meta.language ?? DEFAULT_LANGUAGE;
  const lines: string[] = [`title: ${yamlQuote(title)}`];
  if (meta.genre !== undefined) lines.push(`genre: ${yamlQuote(meta.genre)}`);
  if (meta.tone !== undefined) lines.push(`tone: ${yamlQuote(meta.tone)}`);
  lines.push(`language: ${yamlQuote(language)}`);
  if (meta.target_length !== undefined) {
    lines.push(`target_length: ${yamlQuote(meta.target_length)}`);
  }
  if (meta.current_stage !== undefined) {
    lines.push(`current_stage: ${yamlQuote(meta.current_stage)}`);
  }
  lines.push(`default_reveal_policy: ${yamlQuote(reveal)}`);
  return lines.join('\n') + '\n';
}

/** 输出一个安全合法的 YAML 双引号标量。 */
function yamlQuote(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        if (code < 0x20 || code === 0x7f) {
          out += '\\x' + code.toString(16).padStart(2, '0');
        } else {
          out += ch;
        }
    }
  }
  return out + '"';
}

export * from './gitignore.js';
export * from './intake.js';
