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

function hasMissingSetup(fm: Frontmatter): boolean {
  const goal = fm.goal;
  if (typeof goal !== 'string' || goal.trim() === '') return true;
  for (const field of ['core_conflict', 'must_happen', 'must_not_happen']) {
    const st = fieldStatus(fm, field);
    const val = fm[field];
    const hasVal = typeof val === 'string' && val.trim() !== '';
    if (st === 'uncertain') return true;
    if (st === 'present' && !hasVal) return true;
    if (st === 'not_applicable' && hasVal) return true;
    if (!st && !hasVal) return true;
  }
  return false;
}

function organizeReasons(fm: Frontmatter): string[] {
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

/**
 * Scene 健康信号(确定性, 纯字段推导, 不依赖 LLM; outline.md 结构健康信号)。
 * 返回 HEALTH_KEYS 命中的信号键。
 */
export function computeSceneHealth(fm: Frontmatter): string[] {
  const signals: string[] = [];
  const source = typeof fm.source === 'string' ? fm.source : '';
  const status = typeof fm.status === 'string' ? fm.status : '';

  const needsReview =
    metaField(fm, 'needs_review') === true ||
    (['deep_import', 'ai_generated'].includes(source) &&
      ['draft', 'candidate'].includes(status) &&
      metaField(fm, 'reviewed_at') === undefined);
  if (needsReview) signals.push('scene_unreviewed');

  const chapterIds = Array.isArray(fm.chapter_ids) ? fm.chapter_ids : [];
  const planningState = metaField(fm, 'planning_state');
  if (chapterIds.length === 0 && planningState !== 'planned') signals.push('scene_unassigned_chapter');

  if (hasMissingSetup(fm)) signals.push('scene_missing_setup');

  if (organizeReasons(fm).length > 0) signals.push('scene_needs_organize');

  return signals;
}

/** 结构资产列表默认排除 deprecated(R20)。 */
export function filterActive<T extends { status?: unknown }>(entries: T[]): T[] {
  return entries.filter((e) => e.status !== 'deprecated');
}
