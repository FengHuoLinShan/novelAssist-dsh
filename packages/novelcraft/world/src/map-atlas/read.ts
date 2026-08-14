// world/map-atlas · 读面(只读; 空 vault / 目录不存在 → 空结构, 不抛错)。
// 依据: map-atlas 实施计划 §2(文件模型)、§4 Phase 1、§5 确定性规则(N28/N29)。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { guardPath, paths } from '@novelcraft/vault';
import { parseFrontmatter } from '@novelcraft/store';
import {
  ATLAS_LEVELS,
  NODE_STATUSES,
  PAGE_GENERATION_STATUSES,
  PAGE_REVIEW_STATUSES,
  RUN_KINDS,
  RUN_STATUSES,
} from './types.js';
import type {
  AtlasAnnotation,
  AtlasEvidence,
  AtlasImage,
  AtlasLevel,
  AtlasNode,
  AtlasNodeStatus,
  AtlasNodeView,
  AtlasPage,
  AtlasPageView,
  AtlasPlan,
  AtlasRun,
  AtlasTreeNode,
  AtlasTree,
  PageGenerationStatus,
  PageReviewStatus,
  RunKind,
  RunStatus,
  SourceRef,
} from './types.js';

// ============================================================================
// 枚举/字段归一切片(读面容忍未知值: 越界 → 安全默认)
// ============================================================================

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = String(value ?? '');
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toImage(value: unknown): AtlasImage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.file !== 'string' || o.file === '') return undefined;
  return {
    file: o.file,
    media_type: asStr(o.media_type),
    sha256: asStr(o.sha256),
    width: asInt(o.width, 0),
    height: asInt(o.height, 0),
    byte_size: asInt(o.byte_size, 0),
  };
}

function toEvidence(value: unknown): AtlasEvidence {
  const o = (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.length > 0) : [];
  return {
    supported: list(o.supported),
    visual_fill: list(o.visual_fill),
    conflicts: list(o.conflicts),
  };
}

function toSourceRef(value: unknown): SourceRef {
  const o = (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}) as Record<string, unknown>;
  const ref: SourceRef = {};
  if (typeof o.source_id === 'string') ref.source_id = o.source_id;
  if (typeof o.source_type === 'string') ref.source_type = o.source_type;
  if (typeof o.title === 'string') ref.title = o.title;
  if (typeof o.summary === 'string') ref.summary = o.summary;
  if (o.open_target && typeof o.open_target === 'object' && !Array.isArray(o.open_target)) {
    ref.open_target = o.open_target as Record<string, unknown>;
  }
  if (typeof o.source_hash === 'string') ref.source_hash = o.source_hash;
  if (typeof o.source_status === 'string') ref.source_status = o.source_status;
  return ref;
}

function toSourceManifest(value: unknown): SourceRef[] {
  return Array.isArray(value) ? value.map(toSourceRef) : [];
}

function toAnnotation(value: unknown): AtlasAnnotation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const ann: AtlasAnnotation = {
    id: asStr(o.id),
    label: asStr(o.label),
    position_x: asInt(o.position_x, 0),
    position_y: asInt(o.position_y, 0),
  };
  if (typeof o.target_node_ref === 'string' && o.target_node_ref !== '') {
    ann.target_node_ref = o.target_node_ref;
  }
  if (typeof o.sort_order === 'number') ann.sort_order = o.sort_order;
  return ann;
}

function toAnnotations(value: unknown): AtlasAnnotation[] {
  return Array.isArray(value)
    ? value.map(toAnnotation).filter((a): a is AtlasAnnotation => !!a)
    : [];
}

function toNode(slug: string, data: Record<string, unknown>): AtlasNode {
  return {
    id: asStr(data.id) || slug,
    parent_ref: data.parent_ref === null || data.parent_ref === undefined
      ? null
      : asStr(data.parent_ref),
    location_ref: data.location_ref === null || data.location_ref === undefined
      ? null
      : asStr(data.location_ref),
    semantic_key: asStr(data.semantic_key),
    level: asEnum<AtlasLevel>(data.level, ATLAS_LEVELS, 'world'),
    title: asStr(data.title),
    ...(data.summary !== undefined ? { summary: asStr(data.summary) } : {}),
    status: asEnum<AtlasNodeStatus>(data.status, NODE_STATUSES, 'provisional'),
    sort_order: asInt(data.sort_order, 0),
  };
}

function toPage(slug: string, data: Record<string, unknown>): AtlasPage {
  return {
    id: asStr(data.id) || slug,
    run_ref: asStr(data.run_ref),
    node_ref: asStr(data.node_ref),
    // generation_choice 仅 'upload' 时保留(容错: 其他值视为缺省)。
    ...(data.generation_choice === 'upload' ? { generation_choice: 'upload' as const } : {}),
    generation_status: asEnum<PageGenerationStatus>(
      data.generation_status,
      PAGE_GENERATION_STATUSES,
      'prompt_only',
    ),
    review_status: asEnum<PageReviewStatus>(
      data.review_status,
      PAGE_REVIEW_STATUSES,
      'candidate',
    ),
    title: asStr(data.title),
    visual_brief: asStr(data.visual_brief),
    prompt: asStr(data.prompt),
    ...(toImage(data.image) ? { image: toImage(data.image)! } : {}),
    evidence: toEvidence(data.evidence),
    source_manifest: toSourceManifest(data.source_manifest),
    annotations: toAnnotations(data.annotations),
    review_note: asNullableStr(data.review_note),
    adopted_at: asNullableStr(data.adopted_at),
    rejected_at: asNullableStr(data.rejected_at),
    deprecated_at: asNullableStr(data.deprecated_at),
    content_hash: asStr(data.content_hash),
  };
}

// ============================================================================
// 确定性排序工具
// ============================================================================

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 节点排序: sort_order → title → id(确定性)。 */
function cmpNode(a: AtlasNodeView, b: AtlasNodeView): number {
  return a.sort_order - b.sort_order || cmpStr(a.title, b.title) || cmpStr(a.id, b.id);
}

/** 页面排序: title → id(§2.2 页面无 sort_order)。 */
function cmpPage(a: AtlasPageView, b: AtlasPageView): number {
  return cmpStr(a.title, b.title) || cmpStr(a.id, b.id);
}

function readDirMarkdown(dir: string): Array<{ slug: string; file: string; data: Record<string, unknown> }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const slug = f.replace(/\.md$/, '');
      const file = path.join(dir, f);
      const { data } = parseFrontmatter(readFileSync(file, 'utf8'));
      return { slug, file, data };
    });
}

/** 图片缺失判定: 有 image 元数据但本地图片文件不存在(N29)。 */
function imageMissing(root: string, image: AtlasImage | undefined): boolean {
  if (!image || !image.file) return false;
  let full: string;
  try {
    // image.file 相对 world/atlas(如 `images/<page-slug>/v1.png`)。
    full = guardPath(root, path.join('world', 'atlas', image.file));
  } catch {
    return true; // 越界路径不可能指向合法本地图片 → 视为缺失。
  }
  return !existsSync(full);
}

// ============================================================================
// 读面
// ============================================================================

/**
 * 读整个地图册树: nodes/ + pages/ + pending/nodes + pending/pages, 组确定性树。
 * 空 vault / 目录不存在 → 空结构, 不抛错。
 * - 派生 is_placeholder(N28): adopted 节点无 adopted page。
 * - 派生 image_missing(N29): page.image.file 存在但本地图片文件缺失。
 */
export function readAtlasTree(root: string): AtlasTree {
  const p = paths(root);

  const nodes = readDirMarkdown(p.world.atlas.nodes).map(({ slug, data }) => {
    const node = toNode(slug, data);
    return { ...node, is_placeholder: false } as AtlasNodeView;
  });
  const pages = readDirMarkdown(p.world.atlas.pages).map(({ slug, data }) => {
    const page = toPage(slug, data);
    return { ...page, image_missing: imageMissing(root, page.image) } as AtlasPageView;
  });
  const pendingNodes = readDirMarkdown(p.world.atlas.pendingNodes).map(({ slug, data }) => {
    const node = toNode(slug, data);
    return { ...node, is_placeholder: false } as AtlasNodeView;
  });
  const pendingPages = readDirMarkdown(p.world.atlas.pendingPages).map(({ slug, data }) => {
    const page = toPage(slug, data);
    return { ...page, image_missing: imageMissing(root, page.image) } as AtlasPageView;
  });

  // adopted pages 按 node_ref 分组(仅 review_status=adopted)。
  const adoptedPagesByNode = new Map<string, AtlasPageView[]>();
  for (const page of pages) {
    if (page.review_status !== 'adopted') continue;
    const list = adoptedPagesByNode.get(page.node_ref) ?? [];
    list.push(page);
    adoptedPagesByNode.set(page.node_ref, list);
  }

  // is_placeholder 派生(N28): adopted 节点无 adopted page。
  for (const node of nodes) {
    node.is_placeholder =
      node.status === 'adopted' && (adoptedPagesByNode.get(node.id) ?? []).length === 0;
  }

  nodes.sort(cmpNode);
  pages.sort(cmpPage);
  pendingNodes.sort(cmpNode);
  pendingPages.sort(cmpPage);

  const tree = buildTree(nodes, adoptedPagesByNode);
  return { nodes, pages, pendingNodes, pendingPages, tree };
}

function buildTree(
  nodes: AtlasNodeView[],
  adoptedPagesByNode: Map<string, AtlasPageView[]>,
): AtlasTreeNode[] {
  const byId = new Map<string, AtlasTreeNode>();
  for (const node of nodes) {
    byId.set(node.id, {
      node,
      pages: (adoptedPagesByNode.get(node.id) ?? []).slice().sort(cmpPage),
      children: [],
    });
  }

  const roots: AtlasTreeNode[] = [];
  for (const node of nodes) {
    const entry = byId.get(node.id)!;
    const parentId = node.parent_ref;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) {
      parent.children.push(entry);
    } else {
      roots.push(entry); // 无父或父不在本集(孤儿)视为根。
    }
  }

  // 递归排序子树(每层 sort_order→title→id)。
  const sortChildren = (entries: AtlasTreeNode[]): AtlasTreeNode[] => {
    entries.sort((a, b) => cmpNode(a.node, b.node));
    for (const e of entries) sortChildren(e.children);
    return entries;
  };
  return sortChildren(roots);
}

// ============================================================================
// run 读面(.assistant/atlas/runs/*.json)
// ============================================================================

function parseRun(raw: unknown, id: string): AtlasRun {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  const optsRaw = (o.options && typeof o.options === 'object' && !Array.isArray(o.options)
    ? o.options
    : {}) as Record<string, unknown>;
  const planRaw = (o.atlas_plan && typeof o.atlas_plan === 'object' && !Array.isArray(o.atlas_plan)
    ? o.atlas_plan
    : {}) as Record<string, unknown>;
  const atlasPlan: AtlasPlan = {
    style_brief: asStr(planRaw.style_brief),
    nodes: Array.isArray(planRaw.nodes)
      ? planRaw.nodes.map((n) => toNode(asStr((n as Record<string, unknown>).id), n as Record<string, unknown>))
      : [],
  };
  return {
    schema_version: asInt(o.schema_version, 1),
    id: asStr(o.id) || id,
    run_kind: asEnum<RunKind>(o.run_kind, RUN_KINDS, 'initial'),
    status: asEnum<RunStatus>(o.status, RUN_STATUSES, 'planning'),
    options: {
      style_note: asStr(optsRaw.style_note),
      include_working_drafts: optsRaw.include_working_drafts === true,
      include_interiors: optsRaw.include_interiors === true,
      full_rebuild: optsRaw.full_rebuild === true,
    },
    context_hash: asStr(o.context_hash),
    source_manifest: toSourceManifest(o.source_manifest),
    spatial_evidence: (o.spatial_evidence && typeof o.spatial_evidence === 'object' && !Array.isArray(o.spatial_evidence)
      ? o.spatial_evidence
      : {}) as Record<string, unknown>,
    atlas_plan: atlasPlan,
    planned_page_count: asInt(o.planned_page_count, 0),
    checkpoint: asStr(o.checkpoint),
    error_code: asNullableStr(o.error_code),
    error_message: asNullableStr(o.error_message),
    journal: Array.isArray(o.journal) ? o.journal : [],
    ...(typeof o.created_at === 'string' ? { created_at: o.created_at } : {}),
  };
}

function listRunFiles(runsDir: string): Array<{ id: string; file: string }> {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ id: f.replace(/\.json$/, ''), file: path.join(runsDir, f) }));
}

/** 读单个 run; 不存在抛错(与 readObject 同口径)。 */
export function readAtlasRun(root: string, runId: string): AtlasRun {
  const file = paths(root).assistant.atlas.runFile(runId);
  if (!existsSync(file)) throw new Error(`地图册 run 不存在: ${runId}`);
  return parseRun(JSON.parse(readFileSync(file, 'utf8')), runId);
}

/** 按时间确定性排序(created_at → id)返回全部 run(新→旧)。 */
export function listAtlasHistory(root: string): AtlasRun[] {
  const runsDir = paths(root).assistant.atlas.runs;
  return listRunFiles(runsDir)
    .map(({ id, file }) => parseRun(JSON.parse(readFileSync(file, 'utf8')), id))
    .sort((a, b) => {
      const ta = a.created_at ?? '';
      const tb = b.created_at ?? '';
      return cmpStr(tb, ta) || cmpStr(b.id, a.id); // 新在前。
    });
}

/** 最近一次 run; 无 run 时返回 null。 */
export function latestAtlasRun(root: string): AtlasRun | null {
  const history = listAtlasHistory(root);
  return history.length > 0 ? history[0] : null;
}
