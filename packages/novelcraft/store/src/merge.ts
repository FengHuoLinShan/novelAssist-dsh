import fs from 'node:fs';
import path from 'node:path';
import type { Frontmatter } from './types.js';
import { StoreError } from './errors.js';
import { paths, resolveAsset } from './paths.js';
import {
  parseFrontmatter,
  serializeFrontmatter,
  normalizeAliases,
  normalizeAliasKey,
  isPlaceholderWord,
  validateFrontmatterForWrite,
} from './frontmatter.js';
import { readText } from './fs.js';
import { executeCanonicalWrite, type TxLocalTarget } from './tx-write.js';
import type { TransactionOptions } from './transaction/execute.js';

export interface MergeOptions {
  /** R37: source 为 canonical 时需二次确认(allow_canonical_merge)。 */
  allowCanonicalMerge?: boolean;
  /** 上层 approval 已确认(等价 allow_canonical_merge 二次确认)。 */
  approved?: boolean;
  workflow?: string;
  provenance?: Record<string, unknown>;
  /** N32 内部测试 seam: 执行器选项透传(gates/faults/锁; 生产缺省)。 */
  tx?: TransactionOptions;
}

export interface MergeRecord {
  operation: 'merge' | 'split';
  source: string;
  target: string;
  sourcePrevStatus: string;
  targetKind: string;
  inheritedAliases: string[];
  workflow?: string;
  provenance?: Record<string, unknown>;
  reversible: boolean;
  ts: string;
}

export interface MergeResult {
  source: string;
  target: string;
  inheritedAliases: string[];
  logEntry: MergeRecord;
  commit: string;
}

export interface SplitResult {
  source: string;
  target: string;
  restoredStatus: string;
  removedAliases: string[];
  logEntry: MergeRecord;
  commit: string;
}

export interface AttachAliasOptions {
  workflow?: string;
  provenance?: Record<string, unknown>;
  /** N32 内部测试 seam: 执行器选项透传。 */
  tx?: TransactionOptions;
}

export interface AttachAliasResult {
  target: string;
  alias: string;
  count: number;
  commit: string;
}

function readMergeLog(root: string): MergeRecord[] {
  const p = paths(root).assistant.mergeLog;
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as MergeRecord);
}

/**
 * 计算 merge-log 的追加目标(当前字节 + 输出字节; 不直接写盘):
 * 日志/祖先链是本次 canonical 事务 writeSet 的一部分(N32: 含日志/祖先链)。
 */
function mergeLogTarget(root: string, rec: MergeRecord): TxLocalTarget {
  const p = paths(root).assistant.mergeLog;
  const current = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  const rel = relOf(root, p);
  const output = (current ?? '') + JSON.stringify(rec) + '\n';
  return { path: rel, current, output };
}

function relOf(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/');
}

/**
 * 合并两个同型世界对象(R6): source 置 merged(继承别名), 不硬删;
 * 可逆(L4 split); 已采用(source canonical)需二次确认(R37); 目标必须 canonical(R36)。
 * 本层只做确定性执行 + merge-log 追加; 二次确认由上层 approval 负责。
 * 写面 = canonical 事务(ADR-0021/N32): 目标/source/merge-log 三目标一次 commit。
 */
export async function mergeEntities(
  root: string,
  sourceRef: string,
  targetRef: string,
  opts: MergeOptions = {},
): Promise<MergeResult> {
  const src = resolveAsset(root, 'object', sourceRef);
  const tgt = resolveAsset(root, 'object', targetRef);

  if (src.slug === tgt.slug) {
    throw new StoreError('MERGE_SELF', `不能合并到自身 (R26): ${src.slug}`);
  }

  const srcText = readText(src.abs);
  const tgtText = readText(tgt.abs);
  const { data: srcFm, body: srcBody } = parseFrontmatter(srcText);
  const { data: tgtFm, body: tgtBody } = parseFrontmatter(tgtText);

  if (srcFm.kind !== tgtFm.kind) {
    throw new StoreError('MERGE_TYPE_MISMATCH', `融合必须同类型 (R6): ${String(srcFm.kind)} != ${String(tgtFm.kind)}`);
  }
  if (tgtFm.status !== 'canonical') {
    throw new StoreError('INVALID_TARGET', `合并目标必须是 canonical (R36): ${tgt.slug}`);
  }

  const srcStatus = typeof srcFm.status === 'string' ? srcFm.status : '';
  if (srcStatus === 'merged' || srcStatus === 'deprecated') {
    throw new StoreError('ILLEGAL_TRANSITION', `源已 ${srcStatus}, 不可重复合并`);
  }
  if (srcStatus === 'canonical' && !(opts.approved || opts.allowCanonicalMerge)) {
    throw new StoreError('CONFIRMATION_REQUIRED', '合并已采用对象需二次确认 (R37)');
  }

  // 继承别名(去重, R24 归一化)
  const srcAliases = normalizeAliases(srcFm.aliases);
  const tgtAliases = normalizeAliases(tgtFm.aliases);
  const tgtKeys = new Set(tgtAliases.map(normalizeAliasKey));
  const inherited: string[] = [];
  for (const a of srcAliases) {
    const key = normalizeAliasKey(a);
    if (!tgtKeys.has(key)) {
      tgtKeys.add(key);
      tgtAliases.push(a);
      inherited.push(a);
    }
  }

  const now = new Date().toISOString();
  // N23: 两个落盘 frontmatter 先校验后写入(无部分状态, 均按 object schema)
  const checkedTgt = validateFrontmatterForWrite('object', { ...tgtFm, aliases: tgtAliases }, tgt.slug);
  const checkedSrc = validateFrontmatterForWrite('object', { ...srcFm, status: 'merged', merged_into: tgt.slug, merged_at: now }, src.slug);

  const record: MergeRecord = {
    operation: 'merge',
    source: src.slug,
    target: tgt.slug,
    sourcePrevStatus: srcStatus,
    targetKind: String(tgtFm.kind ?? ''),
    inheritedAliases: inherited,
    workflow: opts.workflow,
    provenance: opts.provenance,
    reversible: true,
    ts: now,
  };

  // R9: 写前落盘目标逐段 symlink 检查(fail-closed; 复用 paths.resolveAsset 已 gate,
  // 再对最终目标复检防 resolve 与落盘之间被换成 symlink)。
  const targets: TxLocalTarget[] = [
    { path: tgt.rel, current: tgtText, output: serializeFrontmatter(checkedTgt, tgtBody) },
    { path: src.rel, current: srcText, output: serializeFrontmatter(checkedSrc, srcBody) },
    mergeLogTarget(root, record),
  ];
  const res = await executeCanonicalWrite(root, targets, {
    purpose: `merge: ${src.slug} -> ${tgt.slug}`,
    ...(opts.tx ? { tx: opts.tx } : {}),
  });
  return { source: src.slug, target: tgt.slug, inheritedAliases: inherited, logEntry: record, commit: res.commit };
}

/**
 * 拆分一次 merge(R6 可逆): 恢复 source 状态、移除继承的别名, 追加 split 记录。
 * 写面 = canonical 事务(ADR-0021/N32)。
 */
export async function splitMerge(root: string, sourceRef: string): Promise<SplitResult> {
  const src = resolveAsset(root, 'object', sourceRef);
  const records = readMergeLog(root);

  // 按顺序重放, 维护 source → 当前活跃 merge 记录(split 清除)。
  let active: MergeRecord | null = null;
  for (const r of records) {
    if (r.source !== src.slug) continue;
    if (r.operation === 'merge') active = r;
    else if (r.operation === 'split') active = null;
  }
  if (!active) {
    throw new StoreError('MERGE_NOT_FOUND', `无活跃合并记录, 无法拆分: ${src.slug}`);
  }

  const tgt = resolveAsset(root, 'object', active.target);
  const srcText = readText(src.abs);
  const tgtText = readText(tgt.abs);
  const { data: srcFm, body: srcBody } = parseFrontmatter(srcText);
  const { data: tgtFm, body: tgtBody } = parseFrontmatter(tgtText);

  const removedKeys = new Set(active.inheritedAliases.map(normalizeAliasKey));
  const tgtAliases = normalizeAliases(tgtFm.aliases).filter((a) => !removedKeys.has(normalizeAliasKey(a)));

  const restored: Frontmatter = { ...srcFm, status: active.sourcePrevStatus };
  delete restored.merged_into;
  delete restored.merged_at;

  // N23: 两个落盘 frontmatter 先校验后写入(无部分状态, 均按 object schema)
  const checkedSrc = validateFrontmatterForWrite('object', restored, src.slug);
  const checkedTgt = validateFrontmatterForWrite('object', { ...tgtFm, aliases: tgtAliases }, tgt.slug);

  const record: MergeRecord = {
    operation: 'split',
    source: src.slug,
    target: tgt.slug,
    sourcePrevStatus: active.sourcePrevStatus,
    targetKind: active.targetKind,
    inheritedAliases: [],
    workflow: active.workflow,
    provenance: active.provenance,
    reversible: false,
    ts: new Date().toISOString(),
  };

  const targets: TxLocalTarget[] = [
    { path: src.rel, current: srcText, output: serializeFrontmatter(checkedSrc, srcBody) },
    { path: tgt.rel, current: tgtText, output: serializeFrontmatter(checkedTgt, tgtBody) },
    mergeLogTarget(root, record),
  ];
  const res = await executeCanonicalWrite(root, targets, {
    purpose: `split: ${src.slug} <- ${tgt.slug}`,
  });
  return {
    source: src.slug,
    target: tgt.slug,
    restoredStatus: active.sourcePrevStatus,
    removedAliases: active.inheritedAliases,
    logEntry: record,
    commit: res.commit,
  };
}

/**
 * 别名只附着已有对象(R1): 写目标对象 frontmatter `aliases: []`, 不新建对象文件;
 * 目标必须 canonical(R36); 归一化去重(R24); 占位词拒绝(R25)。
 * 写面 = canonical 事务(ADR-0021/N32)。
 */
export async function attachAlias(
  root: string,
  targetRef: string,
  alias: string,
  opts: AttachAliasOptions = {},
): Promise<AttachAliasResult> {
  if (isPlaceholderWord(alias)) {
    throw new StoreError('INVALID_ALIAS', `占位词别名被拒绝 (R25): ${alias}`);
  }
  const tgt = resolveAsset(root, 'object', targetRef);
  const text = readText(tgt.abs);
  const { data: tgtFm, body } = parseFrontmatter(text);
  if (tgtFm.status !== 'canonical') {
    throw new StoreError('INVALID_TARGET', `别名目标必须是 canonical (R36): ${tgt.slug}`);
  }
  const aliases = normalizeAliases(tgtFm.aliases);
  const key = normalizeAliasKey(alias);
  if (aliases.some((a) => normalizeAliasKey(a) === key)) {
    throw new StoreError('DUPLICATE_ALIAS', `别名已存在 (R24): ${alias}`);
  }
  aliases.push(alias);

  const checked = validateFrontmatterForWrite('object', { ...tgtFm, aliases }, tgt.slug); // N23 落盘前校验
  const res = await executeCanonicalWrite(root, [
    { path: tgt.rel, current: text, output: serializeFrontmatter(checked, body) },
  ], {
    purpose: `attach_alias: ${tgt.slug} += ${alias}`,
    ...(opts.tx ? { tx: opts.tx } : {}),
  });
  return { target: tgt.slug, alias, count: aliases.length, commit: res.commit };
}

// §22.6 原语命名(与设计文档保持一致): merge_entities / split_merge / attach_alias。
export const merge_entities = mergeEntities;
export const split_merge = splitMerge;
export const attach_alias = attachAlias;

// 便于测试与上层读取 merge-log。
export { readMergeLog, relOf };
