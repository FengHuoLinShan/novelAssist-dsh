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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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
    /** merge_records 落点(adjudication #5)。 */
    mergeLog: string;
  };
}

/** 集中定义 §22.2 + adjudications 的全量路径常量与拼接函数。 */
export function paths(root: string): VaultPaths {
  const r = path.resolve(root);
  const chaptersDir = path.join(r, 'chapters');
  const scenesDir = path.join(r, 'scenes');
  const worldDir = path.join(r, 'world');
  const worldObjectsDir = path.join(worldDir, 'objects');
  const worldPendingDir = path.join(worldDir, 'pending');
  const structureDir = path.join(r, 'structure');
  const threadsDir = path.join(structureDir, 'threads');
  const arcsDir = path.join(structureDir, 'arcs');
  const foreshadowingDir = path.join(structureDir, 'foreshadowing');
  const revealDir = path.join(structureDir, 'reveal');
  const memoryDir = path.join(r, 'memory');
  const bibleDir = path.join(r, 'bible');
  const importsDir = path.join(r, 'imports');
  const assistantDir = path.join(r, '.assistant');
  const signalsDir = path.join(assistantDir, 'signals');
  const reviewsDir = path.join(assistantDir, 'reviews');

  return {
    root: r,
    bookYml: path.join(r, BOOK_FILENAME),
    chapters: {
      dir: chaptersDir,
      pending: path.join(chaptersDir, 'pending'),
      chapterFile: (n) => path.join(chaptersDir, `${String(n).padStart(3, '0')}.md`),
    },
    scenes: {
      dir: scenesDir,
      sceneFile: (slug) => path.join(scenesDir, `${slug}.md`),
    },
    world: {
      dir: worldDir,
      objects: worldObjectsDir,
      pending: worldPendingDir,
      objectFile: (slug) => path.join(worldObjectsDir, `${slug}.md`),
      pendingFile: (slug) => path.join(worldPendingDir, `${slug}.md`),
    },
    structure: {
      dir: structureDir,
      outline: path.join(structureDir, 'outline.md'),
      threads: threadsDir,
      arcs: arcsDir,
      foreshadowing: foreshadowingDir,
      reveal: revealDir,
      threadFile: (slug) => path.join(threadsDir, `${slug}.md`),
      arcFile: (slug) => path.join(arcsDir, `${slug}.md`),
      foreshadowingFile: (slug) => path.join(foreshadowingDir, `${slug}.md`),
      revealFile: (slug) => path.join(revealDir, `${slug}.md`),
    },
    memory: {
      dir: memoryDir,
      events: path.join(memoryDir, 'events.jsonl'),
    },
    bible: {
      dir: bibleDir,
      bibleFile: (slug) => path.join(bibleDir, `${slug}.md`),
    },
    imports: {
      dir: importsDir,
      importFile: (name) => path.join(importsDir, name),
    },
    assistant: {
      dir: assistantDir,
      policy: path.join(assistantDir, 'policy.yml'),
      calibration: path.join(assistantDir, 'calibration.md'),
      checkpoint: path.join(assistantDir, 'checkpoint.json'),
      signals: signalsDir,
      signalFile: (name) => path.join(signalsDir, `${name}.json`),
      llm: path.join(assistantDir, 'llm.yml'),
      reviews: reviewsDir,
      reviewFile: (name) => path.join(reviewsDir, `${name}.json`),
      mergeLog: path.join(assistantDir, 'merge-log.jsonl'),
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
];

/**
 * 初始化 vault: 建目录树骨架、写 book.yml、`git init`。
 *
 * - 幂等: book.yml 已存在则原样返回(resolveVaultRoot 同款判据), 不重写、不抛错。
 * - 确定性: 同一 rootPath + bookMeta 产出相同目录与 book.yml 字节。
 */
export function initVault(rootPath: string, bookMeta: BookMeta): VaultPaths {
  const root = path.resolve(rootPath);
  const bookYml = path.join(root, BOOK_FILENAME);

  if (existsSync(bookYml)) {
    return paths(root);
  }

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

  mkdirSync(root, { recursive: true });
  for (const dir of VAULT_DIRS) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }

  writeFileSync(bookYml, serializeBookYaml(bookMeta, title, reveal), 'utf-8');

  // README 约定: git 操作用 node:child_process 调 git CLI(§22.2「.git init」)。
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });

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

/**
 * 防路径穿越(R9): 规范化后必须仍在 root 内, 否则抛错。
 * 返回规范化后的绝对路径(供 readAsset/writeAsset 直接使用)。
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
  return target;
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
