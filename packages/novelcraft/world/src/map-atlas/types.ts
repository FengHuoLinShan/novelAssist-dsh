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

/** 标注 ops(Phase 5 工具/队列载荷; add=新增, update=按 id 补丁, delete=按 id 删除)。 */
export type AtlasAnnotationOp =
  | { op: 'add'; label: string; position_x: number; position_y: number; target_node_ref?: string | null }
  | { op: 'update'; id: string; label?: string; position_x?: number; position_y?: number; target_node_ref?: string | null }
  | { op: 'delete'; id: string };

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
  /** 原始来源全文 hash。 */
  source_hash?: string;
  /** 实际进入 packet 的片段 hash/range；旧资产可缺省。 */
  included_content_hash?: string;
  included_range?: { start: number; end: number };
  truncated?: boolean;
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

/**
 * 空间事实提取结果(Phase 2; AtlasRun.spatial_evidence 落盘形态)。
 * 分桶确定性: explicit→supported, inferred/working→visual_fill, conflicting→conflicts。
 */
export interface SpatialEvidence {
  schema_version: number;
  facts: SpatialFact[];
  supported: SpatialFact[];
  visual_fill: SpatialFact[];
  conflicts: SpatialFact[];
  /** sha256(schema_version + 各地点 {slug,name,aliases,sources} 规范化 JSON)。 */
  source_fingerprint: string;
  locations_checked: number;
  locations_with_facts: number;
  /** 部分批次失败(降级继续)。 */
  degraded: boolean;
  /** 全部批次失败。 */
  all_batches_failed: boolean;
  /** 因 location_key/basis/source_keys 非法被丢弃的条数(规则 4)。 */
  invalid_count: number;
  /** 无地点(catalog §4.12 降级口径)。 */
  insufficient_sources?: boolean;
  /** 指纹复用自上一 run(未调 provider)。 */
  reused?: boolean;
  /** checkpoint 续跑游标(降级时 = 下一待跑批号)。 */
  next_checkpoint?: number;
  /** 各批 llm_step journal/usage 汇总(L1; run.journal 审计来源)。 */
  journal?: unknown[];
  message?: string;
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

// ============================================================================
// Phase 3: AtlasPlan(规划产物; catalog §4.11; 校验 = validateAtlasPlan 纯函数)
// ============================================================================

/** 规划期标注(旧 AtlasAnnotationPlan; adopt 时 target_plan_key 解析为 node id)。 */
export interface AtlasPlanAnnotation {
  label: string;
  position_x: number;
  position_y: number;
  target_plan_key?: string | null;
  source_ref?: SourceRef | null;
}

/** 规划节点(旧 AtlasNodePlan; M4: location_entity_id→location_ref 存 location slug)。 */
export interface AtlasPlanNode {
  /** `^[a-z0-9][a-z0-9_-]{0,127}$`, plan 内唯一。 */
  plan_key: string;
  parent_plan_key?: string | null;
  /** 引用已采用节点作父(update 已有地点子图); 与 parent_plan_key 互斥。 */
  existing_parent_node_id?: string | null;
  /** 关联世界地点对象 slug; 同 plan 内唯一。 */
  location_ref?: string | null;
  title: string;
  level: AtlasLevel;
  summary: string;
  /** 语义锚点: 地点完整名称必须出现(旧引擎 prompt 规则)。 */
  visual_brief: string;
  /** 外部生图参考文本(N28: M4 不生图, prompt 仅为参考产物)。 */
  prompt: string;
  evidence: AtlasEvidence;
  sources: SourceRef[];
  annotations: AtlasPlanAnnotation[];
}

export interface AtlasPlan {
  style_brief: string;
  nodes: AtlasPlanNode[];
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

// ============================================================================
// Phase 2: 来源上下文编译(计划 §4 Phase 2; 确定性, 无 LLM; catalog §4.12 输入侧)
// ============================================================================

/** compileAtlasContext 选项。 */
export interface AtlasContextOptions {
  /** 世界书 draft(工作稿)页纳入证据(默认 false; 计划 §2 来源口径)。 */
  include_working_drafts?: boolean;
  /** 室内图开关(保留字段, Phase 2 不消费)。 */
  include_interiors?: boolean;
  /** 作者风格要求(保留字段, Phase 3 plan prompt 消费)。 */
  style_note?: string;
}

/** 一条来源证据(预算截断后文本)。 */
export interface AtlasEvidenceItem {
  /** 逐字 key: `wiki:<slug>` / `rag:<chunk_id>`(供 llm 输出 source_keys 校验)。 */
  source_key: string;
  text: string;
}

/** 单个地点的资料 packet(map_spatial_facts 的 LLM 输入单元)。 */
export interface AtlasContextPacket {
  /** = 地点对象裸 slug。 */
  location_key: string;
  name: string;
  aliases: string[];
  /** 对象 frontmatter 可选 importance(缺省 0)。 */
  importance: number;
  /** 世界书证据(≤3 页/地点)。 */
  wiki: AtlasEvidenceItem[];
  /** RAG 证据(topK=5; 无索引/失败时为空, degrade 不抛错)。 */
  rag: AtlasEvidenceItem[];
  /** 逐字 key 清单(= manifest 中属于该地点的 source_id 带族前缀)。 */
  source_keys: string[];
}

/** compileAtlasContext 结果(确定性: 同输入同 context_hash)。 */
export interface AtlasContextResult {
  packets: AtlasContextPacket[];
  /** 全部来源清单(spatial facts 校验白名单 + 前端 open_target)。 */
  source_manifest: SourceRef[];
  /** location_key → 排序后的 source_hash 列表(source_fingerprint 输入)。 */
  location_source_hashes: Record<string, string[]>;
  /** sha256(options + manifest ids + hashes) 全 hex。 */
  context_hash: string;
  /** 无可核对地点(空 packets)。 */
  insufficient_sources: boolean;
  message?: string;
}
