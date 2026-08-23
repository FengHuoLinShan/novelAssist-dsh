import { lstatSync, readFileSync } from 'node:fs';
import { paths } from '@novelcraft/vault';
import { StoreError } from './errors.js';
import { parseFrontmatter } from './frontmatter.js';
import { contentHash, normalizeContentHash } from './hash.js';
import { gitHead, gitRead, gitStatusEntries } from './git.js';

const CURRENT_STATUSES = new Set(['draft', 'published', 'canonical']);
const COMMIT_RE = /^[0-9a-f]{7,64}$/;

export interface CurrentChapter {
  chapterIndex: number;
  file: string;
  status: 'draft' | 'published' | 'canonical';
  title?: string;
  body: string;
  contentHash: string;
  head: string;
}

export interface ChapterVersion {
  commit: string;
  authoredAt: string;
  subject: string;
  status: string;
  title?: string;
  body: string;
  contentHash: string;
  declaredHashValid: boolean;
}

export interface ChapterHistoryEntry extends Omit<ChapterVersion, 'body'> {
  byteLength: number;
}

export interface ChapterDiff {
  from: Omit<ChapterVersion, 'body'>;
  to: Omit<ChapterVersion, 'body'>;
  patch: string;
  truncated: boolean;
}

function versionSummary(version: ChapterVersion): Omit<ChapterVersion, 'body'> {
  return {
    commit: version.commit,
    authoredAt: version.authoredAt,
    subject: version.subject,
    status: version.status,
    ...(version.title !== undefined ? { title: version.title } : {}),
    contentHash: version.contentHash,
    declaredHashValid: version.declaredHashValid,
  };
}

function chapterIndex(index: number): number {
  if (!Number.isInteger(index) || index < 1) {
    throw new StoreError('VALIDATION_FAILED', 'chapterIndex 必须是 >=1 的整数');
  }
  return index;
}

function rel(index: number): string {
  return `chapters/${String(chapterIndex(index)).padStart(3, '0')}.md`;
}

function git(root: string, args: string[], allowFailure = false): string {
  return gitRead(root, args, { allowFailure, raw: true });
}

function parseChapter(raw: string, index: number, source: string, strict = true) {
  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    throw new StoreError('VALIDATION_FAILED', `第 ${index} 章 frontmatter 无法解析(${source})`, error);
  }
  const status = typeof parsed.data.status === 'string' ? parsed.data.status : '';
  const declared = normalizeContentHash(typeof parsed.data.content_hash === 'string' ? parsed.data.content_hash : '');
  const actual = contentHash(parsed.body);
  const declaredHashValid = /^[0-9a-f]{64}$/.test(declared) && declared === actual;
  if (strict && !declaredHashValid) {
    throw new StoreError(
      'VALIDATION_FAILED',
      `第 ${index} 章 content_hash 与实际正文不一致(${source}); 请通过章节保存流程重新同步`,
      { declared, actual },
    );
  }
  return {
    status,
    title: typeof parsed.data.title === 'string' ? parsed.data.title : undefined,
    body: parsed.body,
    contentHash: actual,
    declaredHashValid,
  };
}

function assertCurrentPathClean(root: string, file: string, index: number): void {
  const dirty = gitStatusEntries(root).some((entry) => entry.path === file || entry.fromPath === file);
  if (dirty) {
    throw new StoreError('DIRTY_WORKSPACE', `第 ${index} 章存在未接收的外部修改; 请先通过章节保存流程同步`);
  }
}

/** 唯一 current-chapter 读取规则: 顶层普通文件 + current 状态 + 实际正文哈希 + 本章 clean。 */
export function readCurrentChapter(root: string, index: number): CurrentChapter {
  const i = chapterIndex(index);
  const file = rel(i);
  const abs = paths(root).chapters.chapterFile(i);
  let stat;
  try {
    stat = lstatSync(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StoreError('NOT_FOUND', `第 ${i} 章不存在`);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new StoreError('VALIDATION_FAILED', `第 ${i} 章不是普通文件`);
  }
  assertCurrentPathClean(root, file, i);
  const parsed = parseChapter(readFileSync(abs, 'utf8'), i, 'current');
  if (!CURRENT_STATUSES.has(parsed.status)) {
    throw new StoreError('VALIDATION_FAILED', `第 ${i} 章状态 ${parsed.status || '(缺失)'} 不是当前正文`);
  }
  return {
    chapterIndex: i,
    file,
    status: parsed.status as CurrentChapter['status'],
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    body: parsed.body,
    contentHash: parsed.contentHash,
    head: gitHead(root),
  };
}

function resolveCommit(root: string, commit: string): string {
  if (!COMMIT_RE.test(commit)) throw new StoreError('INVALID_REF', 'commit 必须是 7-64 位小写 hex');
  const resolved = git(root, ['rev-parse', '--verify', `${commit}^{commit}`], true).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(resolved)) {
    throw new StoreError('NOT_FOUND', `commit 不存在或不唯一: ${commit}`);
  }
  return resolved;
}

export function readChapterVersion(root: string, index: number, commit: string): ChapterVersion {
  const i = chapterIndex(index);
  const full = resolveCommit(root, commit);
  const file = rel(i);
  const raw = git(root, ['show', `${full}:${file}`], true);
  if (raw === '') throw new StoreError('NOT_FOUND', `commit ${full.slice(0, 12)} 不含第 ${i} 章`);
  // History stays readable even for legacy commits whose frontmatter hash used
  // the pre-v1 trailing-newline convention; restore rewrites the correct hash.
  const parsed = parseChapter(raw, i, full.slice(0, 12), false);
  const meta = git(root, ['show', '-s', '--format=%aI%x09%s', full]).trim();
  const tab = meta.indexOf('\t');
  return {
    commit: full,
    authoredAt: tab >= 0 ? meta.slice(0, tab) : '',
    subject: tab >= 0 ? meta.slice(tab + 1) : meta,
    status: parsed.status,
    ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    body: parsed.body,
    contentHash: parsed.contentHash,
    declaredHashValid: parsed.declaredHashValid,
  };
}

/** 只列触及本章路径的 Git 版本; 不建版本表或缓存。 */
export function listChapterHistory(root: string, index: number, limit = 20): ChapterHistoryEntry[] {
  const i = chapterIndex(index);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new StoreError('VALIDATION_FAILED', 'history limit 必须是 1-100 的整数');
  }
  const lines = git(root, ['log', `-n${limit}`, '--format=%H', '--', rel(i)], true)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const out: ChapterHistoryEntry[] = [];
  for (const commit of lines) {
    try {
      const version = readChapterVersion(root, i, commit);
      out.push({ ...versionSummary(version), byteLength: Buffer.byteLength(version.body, 'utf8') });
    } catch (error) {
      if (error instanceof StoreError && error.code === 'NOT_FOUND') continue;
      throw error;
    }
  }
  return out;
}

/** Git 原生逐章 patch; 输出限长仅影响展示, 不影响恢复所读 blob。 */
export function diffChapterVersions(
  root: string,
  index: number,
  fromCommit: string,
  toCommit = gitHead(root),
  maxChars = 100_000,
): ChapterDiff {
  const i = chapterIndex(index);
  const from = readChapterVersion(root, i, fromCommit);
  const to = readChapterVersion(root, i, toCommit);
  const patch = git(root, ['diff', '--no-ext-diff', '--unified=3', from.commit, to.commit, '--', rel(i)], true);
  return {
    from: versionSummary(from),
    to: versionSummary(to),
    patch: patch.slice(0, maxChars),
    truncated: patch.length > maxChars,
  };
}
