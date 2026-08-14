import { entityKey } from './frontmatter.js';
import type { Frontmatter } from './types.js';

export interface EntityCandidate {
  kind: string;
  name: string;
  [k: string]: unknown;
}

/** 同批内按 entity_key 去重(R21): 同名同型只留一个。 */
export function dedupeByEntityKey<T extends EntityCandidate>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = entityKey(item.kind, item.name);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/** 精确同名同型 working 实体确定性复用(R23)。 */
export function findExactEntity<T extends { kind?: unknown; name?: unknown; status?: unknown }>(
  objects: T[],
  kind: string,
  name: string,
): T | undefined {
  const key = entityKey(kind, name);
  const WORKING = new Set(['canonical', 'draft', 'candidate']);
  return objects.find(
    (o) =>
      typeof o.kind === 'string' &&
      typeof o.name === 'string' &&
      typeof o.status === 'string' &&
      WORKING.has(o.status) &&
      entityKey(o.kind, o.name) === key,
  );
}

/** L0 确定性分组(R28): 归一化名完全相同且同型 → 直接合并的候选组。 */
export function l0ExactGroups<T extends EntityCandidate>(items: T[]): T[][] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = entityKey(item.kind, item.name);
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return [...map.values()].filter((g) => g.length > 1);
}

/**
 * 自动采纳资格(R27/R39): 低置信不自动升 canonical; 只有达阈值的候选才可自动 promote。
 * 阈值进 policy.yml(dedup.structure_auto_confidence 默认 0.96)。
 */
export function shouldAutoPromote(fm: Frontmatter, opts: { minConfidence?: number } = {}): boolean {
  const min = opts.minConfidence ?? 0.96;
  const c = fm.confidence;
  return typeof c === 'number' && c >= min && fm.status !== 'canonical';
}
