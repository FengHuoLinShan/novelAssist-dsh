import type { Frontmatter } from './types.js';

/**
 * 6 键健康词汇表(N1 / R62): 按域前缀统一 Scene 四健康键 + 结构资产两级过滤键。
 * specs/adjudications.md N1。
 */
export const HEALTH_KEYS = [
  'scene_unreviewed',
  'scene_unassigned_chapter',
  'scene_missing_setup',
  'scene_needs_organize',
  'structure_needs_review',
  'structure_unassigned',
] as const;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** structure_meta 已平铺(adjudication #9), 但兼容旧嵌套读取。 */
function metaField(fm: Frontmatter, key: string): unknown {
  if (fm[key] !== undefined) return fm[key];
  return asObject(fm.structure_meta)[key];
}

function fieldStatus(fm: Frontmatter, field: string): string | undefined {
  const meta = asObject(fm.structure_meta);
  const ss = asObject(meta.semantic_field_statuses);
  const nested = typeof ss[field] === 'string' ? (ss[field] as string) : undefined;
  const top = typeof fm[`${field}_status`] === 'string' ? (fm[`${field}_status`] as string) : undefined;
  return nested ?? top;
}

/**
 * 缺设定字段明细: goal 为空, 或 core_conflict/must_happen/must_not_happen
 * 存在「present 无值 / not_applicable 有值 / uncertain / 无状态且无值」。
 * 返回命中的字段名(作者语言映射在收件箱层做)。
 */
export function missingSetupFields(fm: Frontmatter): string[] {
  const out: string[] = [];
  const goal = fm.goal;
  if (typeof goal !== 'string' || goal.trim() === '') out.push('goal');
  for (const field of ['core_conflict', 'must_happen', 'must_not_happen']) {
    const st = fieldStatus(fm, field);
    const val = fm[field];
    const hasVal = typeof val === 'string' && val.trim() !== '';
    if (st === 'uncertain') {
      out.push(field);
      continue;
    }
    if (st === 'present' && !hasVal) {
      out.push(field);
      continue;
    }
    if (st === 'not_applicable' && hasVal) {
      out.push(field);
      continue;
    }
    if (!st && !hasVal) {
      out.push(field);
      continue;
    }
  }
  return out;
}

export function organizeReasons(fm: Frontmatter): string[] {
  const reasons: string[] = [];
  const chapterIds = Array.isArray(fm.chapter_ids) ? fm.chapter_ids.map((x) => String(x)) : [];
  if (new Set(chapterIds).size !== chapterIds.length) reasons.push('duplicate_chapter');
  const chunks = Array.isArray(fm.scene_chunks) ? fm.scene_chunks : [];
  if (chunks.length > 0 && chapterIds.length > 0) {
    const chunkChapters = chunks
      .map((c) => asObject(c))
      .map((c) => (c.chapter_index !== undefined ? String(c.chapter_index) : c.chapter_id !== undefined ? String(c.chapter_id) : ''))
      .filter((s) => s !== '');
    const cset = new Set(chunkChapters);
    if (cset.size !== chapterIds.length || !chapterIds.every((id) => cset.has(id))) {
      reasons.push('chunk_chapter_mismatch');
    }
  }
  return reasons;
}

/** Scene 健康命中明细(键 + 证据: 缺字段 / 整理 reason)。 */
export interface SceneHealthDetail {
  key: string;
  /** 缺设定命中字段名(仅 scene_missing_setup) */
  missing?: string[];
  /** 整理类 reason 码(仅 scene_needs_organize) */
  reasons?: string[];
}

/**
 * Scene 健康信号(确定性, 纯字段推导, 不依赖 LLM; outline.md 结构健康信号)。
 * 返回带证据的命中明细; 键统一走 N1 六键词汇表。
 */
export function computeSceneHealthDetail(fm: Frontmatter): SceneHealthDetail[] {
  const details: SceneHealthDetail[] = [];
  const source = typeof fm.source === 'string' ? fm.source : '';
  const status = typeof fm.status === 'string' ? fm.status : '';

  const needsReview =
    metaField(fm, 'needs_review') === true ||
    (['deep_import', 'ai_generated'].includes(source) &&
      ['draft', 'candidate'].includes(status) &&
      metaField(fm, 'reviewed_at') === undefined);
  if (needsReview) details.push({ key: 'scene_unreviewed' });

  const chapterIds = Array.isArray(fm.chapter_ids) ? fm.chapter_ids : [];
  const planningState = metaField(fm, 'planning_state');
  if (chapterIds.length === 0 && planningState !== 'planned') {
    details.push({ key: 'scene_unassigned_chapter' });
  }

  const missing = missingSetupFields(fm);
  if (missing.length > 0) details.push({ key: 'scene_missing_setup', missing });

  const reasons = organizeReasons(fm);
  if (reasons.length > 0) details.push({ key: 'scene_needs_organize', reasons });

  return details;
}

/** Scene 健康信号键列表(向后兼容; 明细经 computeSceneHealthDetail)。 */
export function computeSceneHealth(fm: Frontmatter): string[] {
  return computeSceneHealthDetail(fm).map((d) => d.key);
}

/** 结构资产列表默认排除 deprecated(R20)。 */
export function filterActive<T extends { status?: unknown }>(entries: T[]): T[] {
  return entries.filter((e) => e.status !== 'deprecated');
}
