import fs from 'node:fs';
import path from 'node:path';
import type { AssetKind, Frontmatter } from './types';
import { StoreError } from './errors';
import { contentHash, normalizeContentHash } from './hash';
import { resolveAsset, resolveWithin, slugFromFilename } from './paths';
import { parseFrontmatter, serializeFrontmatter, canTransition } from './frontmatter';
import { isGitRepo, hasUncommittedChanges, gitAdd, gitCommit } from './git';
import { readText, writeText, listFilesRecursive } from './fs';

export type AdoptableKind =
  | 'object'
  | 'scene'
  | 'chapter_candidate'
  | 'bible_page'
  | 'thread'
  | 'arc'
  | 'foreshadowing'
  | 'reveal';

export interface AdoptOptions {
  /** CAS: 期望的当前 content_hash, 失配拒绝(R8/R15)。 */
  expectedContentHash?: string;
  /** copy-on-adopt 时记录 adopted_by。 */
  adoptedBy?: string;
  /** bible 发布 CAS 基线(base_version_number), 失配拒绝(R7)。 */
  expectedBaseVersion?: number;
}

export interface AdoptResult {
  kind: AdoptableKind;
  ref: string;
  fromStatus: string;
  toStatus: string;
  targetRelPath: string;
  commit: string;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

function nextChapterIndex(root: string): number {
  const chaptersDir = resolveWithin(root, 'chapters');
  let max = 0;
  for (const rel of listFilesRecursive(chaptersDir)) {
    const m = /^(\d{3})\.md$/.exec(rel);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/** adopt 的目标状态: 候选正文→draft(R34), 其余→canonical。 */
function targetStatus(kind: AdoptableKind): string {
  return kind === 'chapter_candidate' ? 'draft' : 'canonical';
}

/** 状态机表键: chapter_candidate 复用 chapter 表(R19)。 */
function transitionKind(kind: AdoptableKind): string {
  return kind === 'chapter_candidate' ? 'chapter' : kind;
}

/**
 * adopt = 候选文件移入 canonical 路径 + git add/commit(R17)。
 *
 * 前置: 工作区干净(CAS, R17); 源状态 ∈ 合法迁移白名单(R3/R19);
 * content_hash CAS(R8); 已采用不硬删(R2, 由 softDelete 承接)。
 */
export function adopt(root: string, kind: AdoptableKind, ref: string, opts: AdoptOptions = {}): AdoptResult {
  const src = resolveAsset(root, kind, ref);

  if (!isGitRepo(root)) {
    throw new StoreError('NOT_A_GIT_REPO', `工作区不是 git 仓库: ${root}`);
  }
  if (hasUncommittedChanges(root)) {
    throw new StoreError('DIRTY_WORKSPACE', '工作区存在未提交改动, 拒绝 adopt (R17)');
  }

  const text = readText(src.abs);
  const { data: fm, body } = parseFrontmatter(text);
  const from = typeof fm.status === 'string' ? fm.status : '';
  const to = targetStatus(kind);

  if (!canTransition(transitionKind(kind), from, to)) {
    throw new StoreError('ILLEGAL_TRANSITION', `非法状态迁移: ${from} -> ${to} (${kind}, R3/R19)`);
  }

  // content_hash CAS(R8/R15)
  if (opts.expectedContentHash !== undefined) {
    const cur = normalizeContentHash(typeof fm.content_hash === 'string' ? fm.content_hash : '');
    const exp = normalizeContentHash(opts.expectedContentHash);
    if (cur && exp && cur !== exp) {
      throw new StoreError('CONFLICT', `content_hash 失配(stale): 期望 ${exp}, 实际 ${cur}`);
    }
  }

  // bible 发布 CAS(R7): base_version_number == 当前 version_number
  if (kind === 'bible_page' && opts.expectedBaseVersion !== undefined) {
    if (Number(fm.version_number ?? 0) !== opts.expectedBaseVersion) {
      throw new StoreError('CONFLICT', `世界书 base_version 失配 (R7)`);
    }
  }

  const hash = contentHash(body);
  const now = new Date().toISOString();

  if (kind === 'chapter_candidate') {
    // copy-on-adopt(R34): 新建最高编号 draft, 原 candidate 置 deprecated。
    const idx = nextChapterIndex(root);
    const targetRel = `chapters/${pad3(idx)}.md`;
    const draftFm: Frontmatter = { ...fm, status: 'draft', content_hash: hash };
    draftFm.provenance = {
      ...asObject(fm.provenance),
      adopted_from_candidate_id: src.slug,
      adopted_at: now,
      adopted_by: opts.adoptedBy ?? 'author',
    };
    delete draftFm.adopted_from_candidate_id;
    writeText(resolveWithin(root, targetRel), serializeFrontmatter(draftFm, body));

    const depFm: Frontmatter = { ...fm, status: 'deprecated', content_hash: hash };
    depFm.provenance = {
      ...asObject(fm.provenance),
      adoption_result_draft_id: slugFromFilename(targetRel),
      deprecated_from_status: from,
      rejected_at: now,
    };
    writeText(src.abs, serializeFrontmatter(depFm, body));

    gitAdd(root);
    const commit = gitCommit(root, `adopt(chapter): ${src.slug} -> ${targetRel}`);
    return { kind, ref: src.slug, fromStatus: from, toStatus: to, targetRelPath: targetRel, commit };
  }

  const newFm: Frontmatter = { ...fm, status: to, content_hash: hash, adopted_at: fm.adopted_at ?? now };
  let targetRel = src.rel;
  if (kind === 'object' && src.kind === 'pending') {
    targetRel = `world/objects/${src.slug}.md`; // adopt = 移入 canonical 路径
  }
  if (kind === 'bible_page') {
    newFm.version_number = Number(fm.version_number ?? 0) + 1; // 发布 version+1(R7)
  }

  writeText(resolveWithin(root, targetRel), serializeFrontmatter(newFm, body));
  if (targetRel !== src.rel) {
    fs.unlinkSync(src.abs);
  }

  gitAdd(root);
  const commit = gitCommit(root, `adopt(${kind}): ${src.slug}`);
  return { kind, ref: src.slug, fromStatus: from, toStatus: to, targetRelPath: targetRel, commit };
}

export type SoftDeletableKind =
  | 'object'
  | 'scene'
  | 'chapter'
  | 'bible_page'
  | 'thread'
  | 'arc'
  | 'foreshadowing'
  | 'reveal';

export interface SoftDeleteResult {
  kind: SoftDeletableKind;
  ref: string;
  status: 'deprecated' | 'archived' | 'noop';
  commit?: string;
}

/**
 * 软删(R2): 已采用资产转历史态(deprecated/archived), 不物理删除;
 * 已历史态再删 = no-op。git 历史天然保留旧版本。
 */
export function softDelete(root: string, kind: SoftDeletableKind, ref: string): SoftDeleteResult {
  const src = resolveAsset(root, kind, ref);
  const { data: fm, body } = parseFrontmatter(readText(src.abs));
  const from = typeof fm.status === 'string' ? fm.status : '';
  const terminal = kind === 'bible_page' ? 'archived' : 'deprecated';
  if (from === terminal) {
    return { kind, ref: src.slug, status: 'noop' };
  }
  const newFm: Frontmatter = { ...fm, status: terminal, content_hash: contentHash(body) };
  newFm.provenance = { ...asObject(fm.provenance), deprecated_from_status: from, deprecated_at: new Date().toISOString() };
  writeText(src.abs, serializeFrontmatter(newFm, body));
  gitAdd(root);
  const commit = gitCommit(root, `soft-delete(${kind}): ${src.slug}`);
  return { kind, ref: src.slug, status: terminal, commit };
}

export interface SuggestionResult {
  ref: string;
  fromStatus: string;
  toStatus: 'accepted' | 'rejected';
  commit: string;
}

/**
 * 建议队列裁决(R4/R32): pending → accepted/rejected, 单赢家 CAS claim。
 * 已裁决(非 pending)再 confirm/reject → 拒绝。
 */
export function confirmSuggestion(root: string, ref: string): SuggestionResult {
  return resolveSuggestion(root, ref, 'accepted');
}

export function rejectSuggestion(root: string, ref: string): SuggestionResult {
  return resolveSuggestion(root, ref, 'rejected');
}

function resolveSuggestion(root: string, ref: string, to: 'accepted' | 'rejected'): SuggestionResult {
  const src = resolveAsset(root, 'pending', ref);
  const { data: fm, body } = parseFrontmatter(readText(src.abs));
  const from = typeof fm.status === 'string' ? fm.status : '';
  if (from !== 'pending') {
    throw new StoreError('ILLEGAL_TRANSITION', `建议已裁决, 不可重复 claim (R32): status=${from}`);
  }
  writeText(src.abs, serializeFrontmatter({ ...fm, status: to }, body));
  gitAdd(root);
  const commit = gitCommit(root, `${to}(suggestion): ${src.slug}`);
  return { ref: src.slug, fromStatus: from, toStatus: to, commit };
}

