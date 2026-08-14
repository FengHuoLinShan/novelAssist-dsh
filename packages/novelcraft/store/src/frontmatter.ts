import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { TARGET_LENGTHS, CURRENT_STAGES } from '@novelcraft/vault';
import { StoreError } from './errors.js';
import { sha256Hex } from './hash.js';
import type { AssetKind, Frontmatter, ValidationIssue } from './types.js';

// ============================================================================
// YAML frontmatter 解析/序列化(自实现极简子集 → 引入轻量 yaml 依赖, 见 package.json)
// ============================================================================

export interface ParsedMarkdown {
  data: Frontmatter;
  body: string;
}

/** 解析 `---\n...\n---` 包裹的 frontmatter; 无 frontmatter 时 data={} 且 body=全文。 */
export function parseFrontmatter(text: string): ParsedMarkdown {
  if (!text.startsWith('---')) {
    return { data: {}, body: text };
  }
  const lines = text.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '---' || trimmed === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    // 无闭合分隔符: 视为无 frontmatter。
    return { data: {}, body: text };
  }
  const yamlText = lines.slice(1, end).join('\n');
  const body = lines.slice(end + 1).join('\n');
  let data: Frontmatter = {};
  if (yamlText.trim().length > 0) {
    const parsed = parseYaml(yamlText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Frontmatter;
    }
  }
  return { data, body };
}

/** 序列化 frontmatter + body 为完整 markdown 文件(确定性: lineWidth=0 不折行)。 */
export function serializeFrontmatter(data: Frontmatter, body: string): string {
  const yamlText = stringifyYaml(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yamlText}\n---\n${body}`;
}

// ============================================================================
// 状态机(store-rules §2 合法迁移白名单)
// ============================================================================

export type TransitionTable = Record<string, string[]>;

export const TRANSITIONS: Record<string, TransitionTable> = {
  object: {
    draft: ['canonical', 'merged', 'ignored'],
    candidate: ['canonical', 'merged', 'ignored'],
    canonical: ['deprecated'],
    merged: [],
    ignored: [],
    deprecated: [],
  },
  pending: {
    pending: ['accepted', 'rejected'],
    accepted: [],
    rejected: [],
  },
  scene: {
    draft: ['canonical'],
    candidate: ['canonical'], // 历史 candidate 并入 draft(adjudication #6), 兼容接受
    canonical: ['deprecated'],
    deprecated: [],
  },
  chapter: {
    draft: ['published', 'deprecated'],
    published: ['draft', 'deprecated'], // 再编辑 = copy-on-write 新 draft(R18)
    canonical: ['draft', 'deprecated'],
    candidate: ['draft', 'deprecated'], // adopt→draft(R34); reject→deprecated(R19)
    deprecated: [],
  },
  bible_page: {
    draft: ['canonical'],
    canonical: ['draft', 'archived'],
    archived: [],
  },
  thread: { draft: ['canonical'], canonical: ['deprecated'], deprecated: [] },
  arc: { draft: ['canonical'], canonical: ['deprecated'], deprecated: [] },
  foreshadowing: { draft: ['canonical'], canonical: ['deprecated'], deprecated: [] },
  reveal: { draft: ['canonical'], canonical: ['deprecated'], deprecated: [] },
};

/** 校验一条状态迁移是否在 §2 白名单内(R3/R18/R19)。 */
export function canTransition(assetKind: string, from: string, to: string): boolean {
  const table = TRANSITIONS[assetKind];
  if (!table) return false;
  return (table[from] ?? []).includes(to);
}

// ============================================================================
// 枚举与归一化(确定性)
// ============================================================================

/** 20 类 entity_type 枚举(R29)。 */
export const ENTITY_TYPES = [
  'character',
  'location',
  'faction',
  'organization',
  'species',
  'group',
  'item',
  'object',
  'event',
  'rule',
  'power_system',
  'secret',
  'legend',
  'resource',
  'concept',
  'creature',
  'skill',
  'ability',
  'artifact',
  'other',
] as const;

const ENTITY_TYPE_ALIASES: Record<string, string> = {
  '人物': 'character',
  '角色': 'character',
  '地点': 'location',
  '位置': 'location',
  '势力': 'faction',
  '组织': 'organization',
  '机构': 'organization',
  '种族': 'species',
  '群体': 'group',
  '团体': 'group',
  '物品': 'item',
  '物件': 'item',
  '对象': 'object',
  '事件': 'event',
  '规则': 'rule',
  '法则': 'rule',
  '力量体系': 'power_system',
  '能力体系': 'power_system',
  '力量设定': 'power_system',
  '秘密': 'secret',
  '传说': 'legend',
  '传奇': 'legend',
  '资源': 'resource',
  '概念': 'concept',
  '生物': 'creature',
  '怪物': 'creature',
  '技能': 'skill',
  '能力': 'ability',
  '神器': 'artifact',
  '圣物': 'artifact',
  '法宝': 'artifact',
  '其他': 'other',
  '其它': 'other',
};

/** 归一 entity_type 到 20 类枚举; 越界/中文别名不识别时返回 null(R29)。 */
export function normalizeEntityType(value: string): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if ((ENTITY_TYPES as readonly string[]).includes(lower)) return lower;
  return ENTITY_TYPE_ALIASES[lower] ?? ENTITY_TYPE_ALIASES[v] ?? null;
}

/** 占位词黑名单(R25)。 */
export const PLACEHOLDER_WORDS = [
  '变量',
  'variable',
  'placeholder',
  '未知',
  'unknown',
  '某人',
  '某物',
  'n/a',
  'na',
  'none',
] as const;

/** 是否占位词(R25): casefold + 去空白后命中黑名单。 */
export function isPlaceholderWord(name: string): boolean {
  const v = normalizeAliasKey(name);
  return (PLACEHOLDER_WORDS as readonly string[]).some((w) => w.toLowerCase() === v);
}

/** 别名归一化键(R24): 合并空白 + casefold(近似 Unicode casefold)。 */
export function normalizeAliasKey(alias: string): string {
  return String(alias ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** 别名列表 → 纯文本别名数组(兼容 string 与 {alias} 两种形态)。 */
export function normalizeAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && typeof (item as { alias?: unknown }).alias === 'string') {
      out.push((item as { alias: string }).alias);
    }
  }
  return out;
}

/** name 归一(R21): 去首尾空白 + 合并多余空白。 */
export function normalizeNameForKey(name: string): string {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

/** entity_key = (entity_type 小写, name 去多余空白)(R21)。 */
export function entityKey(kind: string, name: string): string {
  const k = normalizeEntityType(kind) ?? String(kind ?? '').toLowerCase();
  return `${k}::${normalizeNameForKey(name)}`;
}

/** fusion operation 归一(R60): 中文别名 → kept/merged/split/reordered/rewritten。 */
export const FUSION_OPERATIONS = ['kept', 'merged', 'split', 'reordered', 'rewritten'] as const;

const OPERATION_ALIASES: Record<string, string> = {
  keep: 'kept',
  kept: 'kept',
  merge: 'merged',
  merged: 'merged',
  合并: 'merged',
  并入: 'merged',
  split: 'split',
  拆分: 'split',
  拆: 'split',
  reordered: 'reordered',
  reorder: 'reordered',
  排序: 'reordered',
  重排: 'reordered',
  rewritten: 'rewritten',
  rewrite: 'rewritten',
  重写: 'rewritten',
  改写: 'rewritten',
  保留: 'kept',
};

/** 归一 operation; 未识别返回 null(R60)。 */
export function normalizeOperation(value: string): string | null {
  const v = String(value ?? '').trim().toLowerCase();
  return OPERATION_ALIASES[v] ?? null;
}

/** NarrativeTag 枚举(outline §附录)。 */
export const NARRATIVE_TAGS = [
  'draft',
  'hook',
  'inciting_incident',
  'rising_action',
  'climax',
  'valley',
  'transition',
  'payoff',
] as const;

/**
 * narrative_tag 归一(R61): imported→draft, 截断 32 字符, 默认 draft。
 */
export function normalizeNarrativeTag(value: unknown): string {
  let tag = typeof value === 'string' ? value.trim() : '';
  if (tag === 'imported') tag = 'draft'; // R61
  if (tag === '') tag = 'draft';
  if (tag.length > 32) tag = tag.slice(0, 32); // R61 截断 32
  return tag;
}

/**
 * Scene 单一 narrative_tag(R64): 旧 narrative_function 值并入 narrative_tag
 * (narrative_tag 缺失时取其值), 再经 R61 归一。
 */
export function narrativeTagFromFm(fm: Frontmatter): string {
  const raw = fm.narrative_tag;
  const fn = fm.narrative_function;
  if (typeof raw === 'string' && raw.trim() !== '') return normalizeNarrativeTag(raw);
  if (typeof fn === 'string' && fn.trim() !== '') return normalizeNarrativeTag(fn);
  return 'draft';
}

/**
 * provenance_key = sha256(workflow_id, candidate_id, source_candidate_ids 排序,
 * fusion_operation, source_chapter_indices 排序), 与来源顺序无关(R22)。
 */
export function provenanceKey(opts: {
  workflowId: string;
  candidateId: string;
  sourceCandidateIds?: string[];
  fusionOperation?: string;
  sourceChapterIndices?: number[];
}): string {
  const sourceCandidates = (opts.sourceCandidateIds ?? []).slice().sort().join('\u001f');
  const chapterIndices = (opts.sourceChapterIndices ?? [])
    .slice()
    .sort((a, b) => a - b)
    .join(',');
  const parts = [opts.workflowId, opts.candidateId, sourceCandidates, opts.fusionOperation ?? '', chapterIndices];
  return sha256Hex(parts.join('\n'));
}

// ============================================================================
// 导入门禁(R31)
// ============================================================================

export const ALLOWED_IMPORT_EXTENSIONS = ['.txt', '.epub', '.html', '.htm', '.mobi', '.azw3'] as const;
export const MAX_IMPORT_FILE_SIZE = 50 * 1024 * 1024; // 50MB

export interface ImportFileGateResult {
  ok: boolean;
  reason?: string;
}

/** 导入文件白名单 + 50MB 上限 + basename 净化(R31)。 */
export function validateImportFile(fileName: string, fileSize: number): ImportFileGateResult {
  const base = fileName.split(/[\\/]/).pop() ?? fileName; // basename 净化(R31)
  const ext = base.slice(base.lastIndexOf('.')).toLowerCase();
  if (!(ALLOWED_IMPORT_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: `非法文件类型 ${ext}(白名单: ${ALLOWED_IMPORT_EXTENSIONS.join('/')})` };
  }
  if (fileSize > MAX_IMPORT_FILE_SIZE) {
    return { ok: false, reason: `文件超过 50MB 上限: ${fileSize}` };
  }
  return { ok: true };
}

// ============================================================================
// frontmatter 校验(必填/类型/状态机取值)
// ============================================================================

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'list' | 'object';

export interface AssetSchema {
  required: string[];
  fields: Record<string, FieldType>;
  statusValues: string[];
  enums?: Record<string, readonly string[]>;
}

const OBJECT_FIELDS: Record<string, FieldType> = {
  id: 'string',
  kind: 'string',
  name: 'string',
  status: 'string',
  aliases: 'list',
  summary: 'string',
  public_info: 'string',
  hidden_truth: 'string',
  importance: 'number',
  importance_level: 'string',
  reveal_level: 'string',
  evidence: 'list',
  workflow: 'string',
  source: 'string',
  adopted_at: 'string',
  content_hash: 'string',
  confidence: 'number',
  suggested_action: 'string',
  tags: 'list',
  relations: 'list',
  merged_into: 'string',
  merged_at: 'string',
  user_edited: 'boolean',
  entity_key: 'string',
  provenance_key: 'string',
};

const STRUCTURE_FIELDS: Record<string, FieldType> = {
  id: 'string',
  status: 'string',
  name: 'string',
  title: 'string',
  summary: 'string',
  thread_type: 'string',
  current_stage: 'string',
  start_chapter: 'integer',
  end_chapter: 'integer',
  planned_payoff_chapter: 'integer',
  planned_payoff_scene: 'string', // adjudication #11: 整数索引 → slug 引用
  planned_seed_chapter: 'integer',
  planned_reinforce_chapters: 'list',
  related_thread_ids: 'list',
  related_character_ids: 'list',
  related_entity_ids: 'list',
  related_memory_ids: 'list',
  relations: 'list', // ADR-0019 N14: 结构资产统一 relations 有向对写面
  target_type: 'string',
  target_id: 'string',
  secret_summary: 'string',
  reveal_stages: 'list',
  surface_meaning: 'string',
  hidden_meaning: 'string',
  visible_goal: 'string',
  hidden_truth: 'string',
  provenance_meta: 'object',
};

export const SCHEMAS: Record<AssetKind, AssetSchema> = {
  book: {
    required: ['title'],
    fields: { title: 'string', genre: 'string', tone: 'string', language: 'string', target_length: 'string', current_stage: 'string' },
    statusValues: [],
    enums: { target_length: TARGET_LENGTHS, current_stage: CURRENT_STAGES },
  },
  object: {
    required: ['id', 'kind', 'name', 'status'],
    fields: OBJECT_FIELDS,
    statusValues: ['draft', 'candidate', 'canonical', 'merged', 'ignored', 'deprecated'],
  },
  pending: {
    required: ['id', 'status'],
    fields: {
      ...OBJECT_FIELDS,
      source_module: 'string',
      review_group: 'string',
      target_type: 'string',
      action_schema: 'string',
      payload: 'object',
      risk_level: 'string',
      revision_link: 'object',
    },
    statusValues: ['draft', 'candidate', 'canonical', 'merged', 'ignored', 'deprecated', 'pending', 'accepted', 'rejected'],
  },
  scene: {
    required: ['id', 'status', 'scene_index', 'narrative_tag', 'source'],
    fields: {
      id: 'string',
      status: 'string',
      scene_index: 'integer',
      title: 'string',
      goal: 'string',
      core_conflict: 'string',
      emotional_beat: 'string',
      must_happen: 'string',
      must_not_happen: 'string',
      narrative_tag: 'string',
      source: 'string',
      scene_chunks: 'list',
      chapter_ids: 'list',
      pov_character_id: 'string',
      structure_meta: 'object',
      relations: 'list', // ADR-0019 N14: Scene 也走统一 relations 写面
      content_hash: 'string',
      evidence: 'list',
      provenance_key: 'string',
      workflow: 'string',
      adopted_at: 'string',
      planning_state: 'string',
      needs_review: 'boolean',
      reviewed_at: 'string',
      user_edited: 'boolean',
    },
    statusValues: ['draft', 'canonical', 'deprecated'],
  },
  chapter: {
    required: ['chapter_index', 'status', 'content_hash'],
    fields: {
      chapter_index: 'integer',
      title: 'string',
      status: 'string',
      content_hash: 'string',
      provenance: 'object',
      conflict_check_snapshot: 'object',
      source: 'string',
    },
    statusValues: ['draft', 'published', 'canonical', 'candidate', 'deprecated'],
  },
  chapter_candidate: {
    required: ['status', 'content_hash', 'source'],
    fields: {
      chapter_index: 'integer',
      title: 'string',
      status: 'string',
      content_hash: 'string',
      source: 'string',
      provenance: 'object',
    },
    statusValues: ['candidate', 'deprecated'],
  },
  thread: {
    required: ['id', 'status', 'name', 'thread_type'],
    fields: STRUCTURE_FIELDS,
    statusValues: ['draft', 'canonical', 'deprecated'],
  },
  arc: {
    required: ['id', 'status', 'title'],
    fields: STRUCTURE_FIELDS,
    statusValues: ['draft', 'canonical', 'deprecated'],
  },
  foreshadowing: {
    required: ['id', 'status', 'name'],
    fields: STRUCTURE_FIELDS,
    statusValues: ['draft', 'canonical', 'deprecated'],
  },
  reveal: {
    // ADR-0019 P3: related_thread_ids 从 required 放宽(「未归类」=「无边」, 用 serves_thread 边表达)
    required: ['id', 'status', 'target_type', 'target_id', 'secret_summary'],
    fields: STRUCTURE_FIELDS,
    statusValues: ['draft', 'canonical', 'deprecated'],
  },
  outline: {
    required: ['title', 'creative_core', 'outline_markdown', 'major_storylines', 'macro_movements', 'open_decisions'],
    fields: {
      title: 'string',
      creative_core: 'object',
      outline_markdown: 'string',
      major_storylines: 'list',
      macro_movements: 'list',
      open_decisions: 'list',
      version_number: 'integer',
      source: 'string',
      base_revision_id: 'string',
      restored_from_revision_id: 'string',
      idempotency_key: 'string',
      content_hash: 'string',
      provenance: 'object',
    },
    statusValues: [],
  },
  bible_page: {
    required: ['id', 'status', 'page_type', 'page_key', 'title', 'version_number'],
    fields: {
      id: 'string',
      page_type: 'string',
      page_key: 'string',
      title: 'string',
      status: 'string',
      free_text: 'string',
      body: 'string',
      sections: 'list',
      linked_asset_refs: 'list',
      activation_defaults: 'object',
      template_key: 'string',
      template_version: 'integer',
      version_number: 'integer',
      content_hash: 'string',
    },
    statusValues: ['draft', 'canonical', 'archived'],
  },
  imported_chapter: {
    required: ['chapter_index', 'title', 'content', 'is_analyzed', 'import_record_id'],
    fields: {
      chapter_index: 'integer',
      title: 'string',
      content: 'string',
      is_analyzed: 'boolean',
      import_record_id: 'string',
      novel_id: 'string',
    },
    statusValues: [],
  },
};

function typeOf(v: unknown): FieldType {
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (v && typeof v === 'object') return 'object';
  return 'object';
}

function matchesType(v: unknown, expected: FieldType): boolean {
  if (Array.isArray(v)) return expected === 'list';
  if (typeof v === 'number') {
    if (expected === 'integer') return Number.isInteger(v);
    if (expected === 'number') return !Number.isNaN(v);
    return false;
  }
  switch (expected) {
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'list':
      return Array.isArray(v);
    default:
      return false;
  }
}

/**
 * 按 specs/assets 字段表校验(必填/类型/状态机取值)。
 * 返回结构化错误列表; 空数组 = 合法。
 */
export function validateFrontmatter(kind: AssetKind, fm: Frontmatter): ValidationIssue[] {
  const schema = SCHEMAS[kind];
  if (!schema) {
    throw new StoreError('INVALID_ASSET_KIND', `未知资产 kind: ${kind}`);
  }
  const issues: ValidationIssue[] = [];
  for (const field of schema.required) {
    const v = fm[field];
    if (v === undefined || v === null || v === '') {
      issues.push({ code: 'MISSING_REQUIRED', path: field, message: `${kind} 缺少必填字段 ${field}` });
    }
  }
  for (const [field, expected] of Object.entries(schema.fields)) {
    const v = fm[field];
    if (v === undefined || v === null) continue;
    if (!matchesType(v, expected)) {
      issues.push({
        code: 'INVALID_TYPE',
        path: field,
        message: `${field} 应为 ${expected}, 实际为 ${typeOf(v)}`,
      });
    }
  }
  if (schema.statusValues.length > 0 && typeof fm.status === 'string' && fm.status !== '') {
    if (!schema.statusValues.includes(fm.status)) {
      issues.push({
        code: 'INVALID_STATUS',
        path: 'status',
        message: `status 取值非法: ${fm.status}(允许: ${schema.statusValues.join('/')})`,
      });
    }
  }
  for (const [field, values] of Object.entries(schema.enums ?? {})) {
    const v = fm[field];
    if (typeof v === 'string' && v !== '' && !(values as readonly string[]).includes(v)) {
      issues.push({
        code: 'INVALID_ENUM',
        path: field,
        message: `${field} 取值非法: ${v}(允许: ${values.join('/')})`,
      });
    }
  }
  return issues;
}

/**
 * 写链接入(N23): 校验「最终落盘 frontmatter」并 fail-closed, 与 assertValidRelations
 * 同构(issues 非空即抛 StoreError(VALIDATION_FAILED, 明细, issues))。
 * 缺 id 时确定性补 id = 目标文件 slug(N2: id=文件名 slug; B3 写端同约定)再校验;
 * 返回补全后的 fm, 调用方落盘此返回值(校验通过才可能写文件, 无部分状态)。
 */
export function validateFrontmatterForWrite(kind: AssetKind, fm: Frontmatter, targetSlug: string): Frontmatter {
  const target: Frontmatter = { ...fm };
  if (target.id === undefined || target.id === null || target.id === '') {
    target.id = targetSlug;
  }
  const issues = validateFrontmatter(kind, target);
  if (issues.length === 0) return target;
  const detail = issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  throw new StoreError('VALIDATION_FAILED', `frontmatter 校验失败(${kind}): ${detail}`, issues);
}
