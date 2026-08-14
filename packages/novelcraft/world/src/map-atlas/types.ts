// world/map-atlas · 世界地图册类型与枚举(map-atlas 实施计划 §2 文件模型)。
// 文件唯一真相: 节点/页面 = frontmatter 文本资产, run = .assistant/atlas/runs/*.json 工作产物。
// 无生图: 图片字节只由本机路径导入写入 gitignore 图片目录(N28/N29)。
// 核心包零 DSH 依赖; 纯类型 + 常量, 无副作用。

// ============================================================================
// 枚举与 rank 常量(§2.1/§2.2/§2.3)
// ============================================================================

export const ATLAS_LEVELS = [
  'cover',
  'world',
  'region',
  'city',
  'district',
  'street',
  'interior',
] as const;
export type AtlasLevel = (typeof ATLAS_LEVELS)[number];

/** 层级 rank 常量表: 父级 rank 严格大于子级(规则 1): cover=6 > world=5 > … > interior=0。 */
export const ATLAS_LEVEL_RANK: Readonly<Record<AtlasLevel, number>> = {
  cover: 6,
  world: 5,
  region: 4,
  city: 3,
  district: 2,
  street: 1,
  interior: 0,
};

export const RUN_KINDS = ['initial', 'update', 'rebuild', 'upload'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATUSES = ['planning', 'review_ready', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const PAGE_GENERATION_STATUSES = ['prompt_only', 'review_ready'] as const;
export type PageGenerationStatus = (typeof PAGE_GENERATION_STATUSES)[number];

export const PAGE_REVIEW_STATUSES = [
  'candidate',
  'adopted',
  'rejected',
  'deprecated',
] as const;
export type PageReviewStatus = (typeof PAGE_REVIEW_STATUSES)[number];

export const NODE_STATUSES = ['provisional', 'adopted'] as const;
export type AtlasNodeStatus = (typeof NODE_STATUSES)[number];

// ============================================================================
// 结构化字段(§2.1/§2.2)
// ============================================================================

/** 页面图片元数据(§2.2 image 块; prompt_only 时缺省)。 */
export interface AtlasImage {
  /** 相对 world/atlas 的路径, 如 `images/<page-slug>/v1.png`。 */
  file: string;
  media_type: string;
  sha256: string;
  width: number;
  height: number;
  byte_size: number;
}

/** 可移动自定义文字标签(§2.2 annotations; 坐标 0–1)。 */
export interface AtlasAnnotation {
  id: string;
  label: string;
  position_x: number;
  position_y: number;
  target_node_ref?: string;
  sort_order?: number;
}

/** 页面证据分区(§2.2 evidence)。 */
export interface AtlasEvidence {
  supported: string[];
  visual_fill: string[];
  conflicts: string[];
}

/** 来源引用(§5 规则 3: 每条 source 可解析到 source_manifest 的同一 source_id/hash/open_target)。 */
export interface SourceRef {
  source_id?: string;
  source_type?: string;
  title?: string;
  summary?: string;
  /** 前端可打开目标(如 {kind: 'object', slug} / {kind: 'bible_page', slug})。 */
  open_target?: Record<string, unknown>;
  source_hash?: string;
  source_status?: string;
}

/** 空间事实 basis 枚举(catalog §4.12: explicit|inferred|working|conflicting)。 */
export const SPATIAL_FACT_BASIS = [
  'explicit',
  'inferred',
  'working',
  'conflicting',
] as const;
export type SpatialFactBasis = (typeof SPATIAL_FACT_BASIS)[number];

/** 空间事实(catalog §4.12; 只作规划输入; location_key/source_keys 必须来自服务端 packet 逐字 key)。 */
export interface SpatialFact {
  location_key: string;
  statement: string;
  basis: SpatialFactBasis;
  source_keys: string[];
}

// ============================================================================
// 节点 / 页面(§2.1/§2.2)
// ============================================================================

export interface AtlasNode {
  id: string;
  parent_ref: string | null;
  location_ref: string | null;
  semantic_key: string;
  level: AtlasLevel;
  title: string;
  summary?: string;
  status: AtlasNodeStatus;
  sort_order: number;
}

export interface AtlasPage {
  id: string;
  run_ref: string;
  node_ref: string;
  /** 本地路径导入的图片页标记(specs/assets/map-atlas.md); prompt_only 候选页无此字段。 */
  generation_choice?: 'upload';
  generation_status: PageGenerationStatus;
  review_status: PageReviewStatus;
  title: string;
  visual_brief: string;
  prompt: string;
  /** prompt_only 时缺省(N28: 无图片页不能 adopt)。 */
  image?: AtlasImage;
  evidence: AtlasEvidence;
  source_manifest: SourceRef[];
  annotations: AtlasAnnotation[];
  review_note: string | null;
  adopted_at: string | null;
  rejected_at: string | null;
  deprecated_at: string | null;
  content_hash: string;
}

// ============================================================================
// run(§2.3 全字段 + created_at 用于确定性排序)
// ============================================================================

export interface AtlasRunOptions {
  style_note: string;
  include_working_drafts: boolean;
  include_interiors: boolean;
  full_rebuild: boolean;
}

export interface AtlasPlan {
  style_brief: string;
  nodes: AtlasNode[];
}

export interface AtlasRun {
  schema_version: number;
  id: string;
  run_kind: RunKind;
  status: RunStatus;
  options: AtlasRunOptions;
  context_hash: string;
  source_manifest: SourceRef[];
  spatial_evidence: Record<string, unknown>;
  atlas_plan: AtlasPlan;
  planned_page_count: number;
  checkpoint: string;
  error_code: string | null;
  error_message: string | null;
  journal: unknown[];
  /** ISO 8601 时间戳; listAtlasHistory/latestAtlasRun 的确定性排序键(缺省时 fallback 到 id)。 */
  created_at?: string;
}

// ============================================================================
// 读面视图(派生字段)
// ============================================================================

/** 节点读面视图; is_placeholder = adopted 节点无 adopted page(空页占位)。 */
export interface AtlasNodeView extends AtlasNode {
  /** N28: 已采用节点且无任何 adopted page → 空页占位。 */
  is_placeholder: boolean;
}

/** 页面读面视图; image_missing = 有 image 元数据但本地图片文件缺失。 */
export interface AtlasPageView extends AtlasPage {
  /** N29: image.file 存在但本地图片文件缺失(换机/克隆后缺图)。 */
  image_missing: boolean;
}

/** atlas 树的节点容器: 节点 + 其 adopted pages + 子节点(确定性排序)。 */
export interface AtlasTreeNode {
  node: AtlasNodeView;
  /** 该节点的已采用页面(sort_order→title→id 排序)。 */
  pages: AtlasPageView[];
  children: AtlasTreeNode[];
}

/** readAtlasTree 的返回结构: 覆盖 review(本次结果)与 atlas(我的地图册)两种视图。 */
export interface AtlasTree {
  /** nodes/ 目录(已采用 + 暂存节点; 确定性排序)。 */
  nodes: AtlasNodeView[];
  /** pages/ 目录(已采用页面; 确定性排序)。 */
  pages: AtlasPageView[];
  /** pending/nodes/ 目录(本轮候选节点)。 */
  pendingNodes: AtlasNodeView[];
  /** pending/pages/ 目录(本轮候选页面)。 */
  pendingPages: AtlasPageView[];
  /** 已采用节点树(每节点附 adopted pages; 空页占位 is_placeholder 可见)。 */
  tree: AtlasTreeNode[];
}
