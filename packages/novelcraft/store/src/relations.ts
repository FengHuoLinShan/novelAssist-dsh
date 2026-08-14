// store · 结构资产 relation 边确定性校验(ADR-0019 P0)。
// relations 有向对 {target, type, status} 的写入门禁: 形状/type 白名单/源 kind 白名单/
// 自环(R26)/悬空/端点 kind。纯函数, 只读, 不写; 返回 ValidationIssue[] 与
// validateFrontmatter 同构。依据: ADR-0019 附录 A + specs/adjudications.md
// N14(结构资产 relations 写面)/N15(type 枚举 + 白名单)/N16(身份锚分层)+
// specs/rules/store-rules.md R26(关系自环禁止)。
import { readFileSync } from 'node:fs';
import { StoreError } from './errors.js';
import { ENTITY_TYPES, parseFrontmatter } from './frontmatter.js';
import { resolveAsset } from './paths.js';
import type { ResolvableKind } from './paths.js';
import type { AssetKind, ValidationIssue } from './types.js';

/** 核心 relation type 枚举(ADR-0019 附录 A, 7 项, N15)。 */
export const RELATION_TYPES = [
  'serves_thread',
  'belongs_to_arc',
  'reveals_foreshadowing',
  'pays_off_in_scene',
  'references_character',
  'references_entity',
  'references_memory',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/**
 * type → 允许的源 kind(附录 A 精确自 specs/assets/outline.md 字段表, N15)。
 * type 不编码源 kind; 源 kind 由目录上下文给定。
 */
export const RELATION_SOURCES: Record<RelationType, readonly AssetKind[]> = {
  serves_thread: ['scene', 'arc', 'foreshadowing', 'reveal'],
  belongs_to_arc: ['scene'],
  reveals_foreshadowing: ['reveal'],
  pays_off_in_scene: ['foreshadowing'],
  references_character: ['thread', 'arc', 'scene'],
  references_entity: ['thread', 'arc', 'scene', 'foreshadowing'],
  references_memory: ['thread'],
};

/**
 * type → 目标解析方式(N15)。
 * references_memory 的目标是 memory 事件流 id(events.jsonl, 无 slug 文件),
 * 无文件落点可解析, 仅做非空格式校验; 存在性留给 memory 消费者。
 */
export const RELATION_TARGETS: Record<RelationType, { resolvable: ResolvableKind | null }> = {
  serves_thread: { resolvable: 'thread' },
  belongs_to_arc: { resolvable: 'arc' },
  reveals_foreshadowing: { resolvable: 'foreshadowing' },
  pays_off_in_scene: { resolvable: 'scene' },
  references_character: { resolvable: 'object' },
  references_entity: { resolvable: 'object' },
  references_memory: { resolvable: null },
};

/** 对象目标的 kind 判定(N16 身份锚分层: 人物走 character, 其余 19 类为 entity)。 */
function objectKindMatches(type: RelationType, kind: string): boolean {
  if (type === 'references_character') return kind === 'character';
  return kind !== 'character' && (ENTITY_TYPES as readonly string[]).includes(kind);
}

/**
 * 校验一条结构资产的 relations 写面(ADR-0019 §5 P0)。
 *
 * - 形状: relations 必须是数组, 元素是含 target/type 的对象;
 * - type 白名单: 未知 type 拒绝(核心枚举, N15; policy 扩展白名单尚未接入);
 * - 源 kind 白名单: sourceKind 不在该 type 允许源集合 → 拒绝;
 * - 自环: target 解析到与源同 kind 同 slug → 拒绝(R26);
 * - 悬空: target 无文件落点 → 拒绝;
 * - 端点 kind: references_character/references_entity 校验对象 kind 匹配。
 *
 * 返回问题清单(空数组 = 通过), 不抛异常; P0 只新增校验器, 暂不接入写入链。
 */
export function validateRelations(
  root: string,
  sourceKind: AssetKind,
  sourceSlug: string,
  relations: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (relations === undefined || relations === null) return issues;
  if (!Array.isArray(relations)) {
    issues.push({ code: 'INVALID_TYPE', path: 'relations', message: 'relations 应为 list' });
    return issues;
  }
  relations.forEach((entry, index) => {
    const path = `relations[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ code: 'INVALID_RELATION_ENTRY', path, message: 'relations 元素应为对象' });
      return;
    }
    const r = entry as Record<string, unknown>;
    const target = typeof r.target === 'string' ? r.target : '';
    const type = typeof r.type === 'string' ? r.type : '';
    if (!target) {
      issues.push({ code: 'MISSING_REQUIRED', path: `${path}.target`, message: 'relations 边缺少 target' });
    }
    if (!type) {
      issues.push({ code: 'MISSING_REQUIRED', path: `${path}.type`, message: 'relations 边缺少 type' });
    }
    if (!target || !type) return;

    if (!(RELATION_TYPES as readonly string[]).includes(type)) {
      issues.push({
        code: 'UNKNOWN_RELATION_TYPE',
        path: `${path}.type`,
        message: `relation type 非法: ${type}(核心枚举: ${RELATION_TYPES.join('/')})`,
      });
      return;
    }
    const rt = type as RelationType;
    if (!RELATION_SOURCES[rt].includes(sourceKind)) {
      issues.push({
        code: 'RELATION_TYPE_NOT_ALLOWED',
        path: `${path}.type`,
        message: `${sourceKind} 不允许 relation type=${rt}(允许源: ${RELATION_SOURCES[rt].join('/')})`,
      });
      return;
    }

    const spec = RELATION_TARGETS[rt];
    if (spec.resolvable === null) return; // memory 事件 id: 无文件落点, 仅非空校验

    let resolved;
    try {
      resolved = resolveAsset(root, spec.resolvable, target);
    } catch {
      issues.push({
        code: 'RELATION_TARGET_NOT_FOUND',
        path: `${path}.target`,
        message: `relation target 未找到: ${target}(kind=${spec.resolvable})`,
      });
      return;
    }

    // 自环(R26): 核心 7 type 源/目标 kind 分离, 结构上不可达;
    // 保留为未来同 kind type(如 thread 互证)的防御。
    if (resolved.slug === sourceSlug && resolved.kind === sourceKind) {
      issues.push({
        code: 'RELATION_SELF_LOOP',
        path: `${path}.target`,
        message: `relation 自环拒绝: ${target}`,
      });
      return;
    }

    if (rt === 'references_character' || rt === 'references_entity') {
      let fmKind = '';
      try {
        const { data } = parseFrontmatter(readFileSync(resolved.abs, 'utf8'));
        fmKind = typeof data.kind === 'string' ? data.kind : '';
      } catch {
        issues.push({
          code: 'RELATION_TARGET_NOT_FOUND',
          path: `${path}.target`,
          message: `relation target 读取失败: ${target}`,
        });
        return;
      }
      if (!objectKindMatches(rt, fmKind)) {
        issues.push({
          code: 'RELATION_TARGET_KIND_MISMATCH',
          path: `${path}.target`,
          message: `relation target kind 不符: ${target}(type=${rt}, 实际 kind=${fmKind || '(空)'})`,
        });
      }
    }
  });
  return issues;
}

/**
 * 写链硬错接入点(ADR-0019 P3, 用户裁定): 校验失败即抛 StoreError,
 * 与 adopt fail-closed 语义一致。结构资产落盘必有有效边。
 */
export function assertValidRelations(
  root: string,
  sourceKind: AssetKind,
  sourceSlug: string,
  relations: unknown,
): void {
  const issues = validateRelations(root, sourceKind, sourceSlug, relations);
  if (issues.length === 0) return;
  const detail = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  throw new StoreError('VALIDATION_FAILED', `relations 校验失败: ${detail}`, issues);
}
