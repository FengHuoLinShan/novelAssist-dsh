import fs from 'node:fs';
import type { AssetKind, Frontmatter } from './types.js';
import { StoreError } from './errors.js';
import { contentHash, normalizeContentHash } from './hash.js';
import { resolveAsset, resolveWithin, assertNoInternalSymlink, slugFromFilename } from './paths.js';
import { parseFrontmatter, serializeFrontmatter, canTransition, validateFrontmatterForWrite } from './frontmatter.js';
import { readText } from './fs.js';
import {
  executeCanonicalWrite,
  executePreparedCanonicalWrite,
  prepareCanonicalWrite,
  type PreparedCanonicalWrite,
  type TxLocalTarget,
} from './tx-write.js';
import { gitHead } from './git.js';

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
  /** N32 内部测试 seam: 执行器选项透传(gates/faults/锁; 生产缺省)。 */
  tx?: import('./transaction/execute.js').TransactionOptions;
}

export interface AdoptResult {
  kind: AdoptableKind;
  ref: string;
  fromStatus: string;
  toStatus: string;
  targetRelPath: string;
  commit: string;
}

/** 审批前冻结的 adopt 计划；批准后只能执行其中的固定 writeSet/HEAD。 */
export interface PreparedAdopt {
  readonly write: PreparedCanonicalWrite;
  readonly result: Omit<AdoptResult, 'commit'>;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
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
 * adopt = 候选文件移入 canonical 路径, **经 ADR-0021/N32 事务**(kind='canonical'):
 * - 首写前构造完整确定性 writeSet(移动 = 新路径建 + 旧路径删; copy-on-adopt = 双目标
 *   新 frontmatter), expected = 审批/计划时刻读到的当前字节 sha256(审批后不刷新,
 *   ADR §4 背景 4), output = 落盘字节;
 * - 内容 CAS(R8)、bible 发布 CAS(R7)、落盘前 schema 校验(N23)、路径/R9 symlink
 *   检查均在事务 preflight 完成, 任一失败 → intent 建立前零写入;
 * - 任何预存 staged → STAGED_CONFLICT; writeSet 外无关 unstaged/untracked 允许;
 * - 崩溃由 durable intent 条件回滚, 不复用 allowed-once(ADR §8);
 * - 不再直接 writeFileSync + gitAdd + gitCommit(业务写面无 git add -A)。
 */
export function prepareAdopt(
  root: string,
  kind: AdoptableKind,
  ref: string,
  opts: AdoptOptions = {},
): PreparedAdopt {
  const src = resolveAsset(root, kind, ref);

  const text = readText(src.abs);
  const { data: fm, body } = parseFrontmatter(text);
  const from = typeof fm.status === 'string' ? fm.status : '';
  const to = targetStatus(kind as AdoptableKind);

  if (!canTransition(transitionKind(kind as AdoptableKind), from, to)) {
    throw new StoreError('ILLEGAL_TRANSITION', `非法状态迁移: ${from} -> ${to} (${kind}, R3/R19)`);
  }

  // content_hash CAS(R8/R15): expectedContentHash 提供时, 当前缺失/空或不相等一律
  // CONFLICT fail-closed; 只有完全匹配才放行(不能因缺哈希而 fail-open)。
  if (opts.expectedContentHash !== undefined) {
    const cur = normalizeContentHash(typeof fm.content_hash === 'string' ? fm.content_hash : '');
    const exp = normalizeContentHash(opts.expectedContentHash);
    if (!exp || !cur || cur !== exp) {
      throw new StoreError('CONFLICT', `content_hash CAS 失败: 期望 ${exp || '(空)'}, 实际 ${cur || '(缺失)'} (R8/R15)`);
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
    // copy-on-adopt(R34, M4 语义): 覆盖同名章节文件(版本历史 = git), 原 candidate 置 deprecated。
    const idx = Number(fm.chapter_index ?? src.slug);
    if (!Number.isInteger(idx) || idx < 1) {
      throw new StoreError('BAD_CANDIDATE', `候选缺少合法 chapter_index: ${src.slug}`);
    }
    const targetRel = `chapters/${pad3(idx)}.md`;
    const draftFm: Frontmatter = { ...fm, status: 'draft', content_hash: hash };
    draftFm.provenance = {
      ...asObject(fm.provenance),
      adopted_from_candidate_id: src.slug,
      adopted_at: now,
      adopted_by: opts.adoptedBy ?? 'author',
    };
    delete draftFm.adopted_from_candidate_id;
    // N23: 两个落盘 frontmatter 先校验后写入(无部分状态); chapter_candidate→chapter schema
    const draftChecked = validateFrontmatterForWrite('chapter', draftFm, slugFromFilename(targetRel));

    const depFm: Frontmatter = { ...fm, status: 'deprecated', content_hash: hash };
    depFm.provenance = {
      ...asObject(fm.provenance),
      adoption_result_draft_id: slugFromFilename(targetRel),
      deprecated_from_status: from,
      rejected_at: now,
    };
    const depChecked = validateFrontmatterForWrite('chapter_candidate', depFm, src.slug);
    // R9: 任何写前对落盘目标逐段 symlink 检查(fail-closed)。目标章 chapters/NNN.md
    // 由 resolveWithin 构造, guardPath 的 real containment 会放行指向 vault 内
    // 其他文件的 symlink——若其本身是 symlink, 事务 temp+rename 写会跟随写穿; 源候选
    // 同样复检(防 resolve 与落盘之间被换成 symlink)。
    const targetAbs = resolveWithin(root, targetRel);
    assertNoInternalSymlink(root, targetAbs);
    assertNoInternalSymlink(root, src.abs);

    const targets: TxLocalTarget[] = [
      {
        path: targetRel,
        current: fs.existsSync(targetAbs) ? readText(targetAbs) : null,
        output: serializeFrontmatter(draftChecked, body),
      },
      {
        path: src.rel,
        current: text,
        output: serializeFrontmatter(depChecked, body),
      },
    ];
    return Object.freeze({
      write: prepareCanonicalWrite(root, targets, {
        purpose: `adopt(chapter): ${src.slug} -> ${targetRel}`,
        expectedHead: gitHead(root),
        ...(opts.tx ? { tx: opts.tx } : {}),
      }),
      result: Object.freeze({ kind: 'chapter_candidate' as const, ref: src.slug, fromStatus: from, toStatus: to, targetRelPath: targetRel }),
    });
  }

  const newFm: Frontmatter = { ...fm, status: to, content_hash: hash, adopted_at: fm.adopted_at ?? now };
  let targetRel = src.rel;
  if (kind === 'object' && src.kind === 'pending') {
    targetRel = `world/objects/${src.slug}.md`; // adopt = 移入 canonical 路径
  }
  if (kind === 'bible_page') {
    newFm.version_number = Number(fm.version_number ?? 0) + 1; // 发布 version+1(R7)
  }

  // N23: 落盘前校验最终目标 frontmatter(缺 id 确定性补 id=slug, N2/B3)
  const checked = validateFrontmatterForWrite(transitionKind(kind as AdoptableKind) as AssetKind, newFm, src.slug);
  // R9: 写前对最终落盘目标逐段 symlink 检查(fail-closed)——目标可能是派生路径
  // (object pending→objects 移入), resolveWithin 的 real containment 放行 vault
  // 内 symlink, 目标文件本身是 symlink 时写会跟随写穿; 同文件 in-place 时与
  // src.abs 同目标, 一并复检(防 resolve 与落盘之间被换成 symlink)。
  const targetAbs = resolveWithin(root, targetRel);
  assertNoInternalSymlink(root, targetAbs);
  if (kind === 'object' && targetRel !== src.rel && fs.existsSync(targetAbs)) {
    throw new StoreError('CONFLICT', `canonical 对象已存在: ${src.slug}; 请使用 merge/attach_alias`);
  }
  if (targetRel !== src.rel) {
    assertNoInternalSymlink(root, src.abs);
  }

  const targets: TxLocalTarget[] = [
    {
      path: targetRel,
      current: fs.existsSync(targetAbs) ? readText(targetAbs) : null,
      output: serializeFrontmatter(checked, body),
    },
  ];
  if (targetRel !== src.rel) {
    // 移动面: 旧路径删除(move 语义, git 记录 D+A)。
    targets.push({ path: src.rel, current: text, output: undefined });
  }
  return Object.freeze({
    write: prepareCanonicalWrite(root, targets, {
      purpose: `adopt(${kind}): ${src.slug}`,
      expectedHead: gitHead(root),
      ...(opts.tx ? { tx: opts.tx } : {}),
    }),
    result: Object.freeze({ kind: kind as AdoptableKind, ref: src.slug, fromStatus: from, toStatus: to, targetRelPath: targetRel }),
  });
}

export async function executePreparedAdopt(prepared: PreparedAdopt): Promise<AdoptResult> {
  const tx = await executePreparedCanonicalWrite(prepared.write);
  return { ...prepared.result, commit: tx.commit };
}

export async function adopt(
  root: string,
  kind: AdoptableKind,
  ref: string,
  opts: AdoptOptions = {},
): Promise<AdoptResult> {
  return executePreparedAdopt(prepareAdopt(root, kind, ref, opts));
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
 * 写面 = canonical 事务(与 adopt 同 seam, ADR-0021/N32)。
 */
export async function softDelete(root: string, kind: SoftDeletableKind, ref: string): Promise<SoftDeleteResult> {
  const src = resolveAsset(root, kind, ref);
  const text = readText(src.abs);
  const { data: fm, body } = parseFrontmatter(text);
  const from = typeof fm.status === 'string' ? fm.status : '';
  const terminal = kind === 'bible_page' ? 'archived' : 'deprecated';
  if (from === terminal) {
    return { kind, ref: src.slug, status: 'noop' };
  }
  const newFm: Frontmatter = { ...fm, status: terminal, content_hash: contentHash(body) };
  newFm.provenance = { ...asObject(fm.provenance), deprecated_from_status: from, deprecated_at: new Date().toISOString() };
  const checked = validateFrontmatterForWrite(kind as AssetKind, newFm, src.slug); // N23 落盘前校验
  assertNoInternalSymlink(root, src.abs); // R9: 写前复检(resolve 后不得被换成 symlink)。
  const res = await executeCanonicalWrite(root, [
    { path: src.rel, current: text, output: serializeFrontmatter(checked, body) },
  ], { purpose: `soft-delete(${kind}): ${src.slug}` });
  return { kind, ref: src.slug, status: terminal, commit: res.commit };
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
 * 写面 = canonical 事务(ADR-0021/N32)。
 */
export async function confirmSuggestion(root: string, ref: string): Promise<SuggestionResult> {
  return resolveSuggestion(root, ref, 'accepted');
}

export async function rejectSuggestion(root: string, ref: string): Promise<SuggestionResult> {
  return resolveSuggestion(root, ref, 'rejected');
}

async function resolveSuggestion(root: string, ref: string, to: 'accepted' | 'rejected'): Promise<SuggestionResult> {
  const src = resolveAsset(root, 'pending', ref);
  const text = readText(src.abs);
  const { data: fm, body } = parseFrontmatter(text);
  const from = typeof fm.status === 'string' ? fm.status : '';
  if (from !== 'pending') {
    throw new StoreError('ILLEGAL_TRANSITION', `建议已裁决, 不可重复 claim (R32): status=${from}`);
  }
  const checked = validateFrontmatterForWrite('pending', { ...fm, status: to }, src.slug); // N23 落盘前校验
  assertNoInternalSymlink(root, src.abs); // R9: 写前复检(resolve 后不得被换成 symlink)。
  const res = await executeCanonicalWrite(root, [
    { path: src.rel, current: text, output: serializeFrontmatter(checked, body) },
  ], { purpose: `${to}(suggestion): ${src.slug}` });
  return { ref: src.slug, fromStatus: from, toStatus: to, commit: res.commit };
}
