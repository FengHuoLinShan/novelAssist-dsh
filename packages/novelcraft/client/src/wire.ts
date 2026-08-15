// @novelcraft/client · 通道 wire 契约(纯类型 + 常量, 宿主/浏览器共享;
// 无任何运行时依赖, 可被 client bundle 安全引用)。
export const RPC_CHANNEL = '/novelcraft';

/** 通道端点名。 */
export const ENDPOINTS = {
  watchState: 'watch/state',
  inboxList: 'inbox/list',
  inboxAct: 'inbox/act',
  storyMap: 'story/map',
  writingDesk: 'writing/desk',
  chapterDossier: 'chapter/dossier',
  presetsList: 'presets/list',
  presetsSelect: 'presets/select',
  atlasView: 'atlas/view',
  atlasAnnotationRequest: 'atlas/annotation-request',
} as const;

export interface WatchStatePayload {
  sessionId?: string;
  workspacePath?: string;
}

export interface WatchStateValue {
  bound: { book: string; root: string } | null;
  open: number;
  attention: boolean;
  threshold: number;
  radarRunning: boolean;
  /** 剧情雷达一句话摘要(§9: 宠物静默态点击的默认答复; 未绑定缺省)。 */
  plotSummary?: string;
}

export interface InboxListPayload {
  sessionId?: string;
  workspacePath?: string;
}

/** 收件箱卡片(作者语言, 不暴露 raw JSON/内部枚举)。 */
export interface SignalCard {
  id: string;
  radar: string;
  severity: string;
  title: string;
  evidence: string[];
  proposed_action: string;
  reversibility: boolean;
  status: string;
  observed_at: string;
}

export interface InboxListValue {
  bound: { book: string; root: string } | null;
  signals: SignalCard[];
  threshold: number;
}

export interface InboxActPayload {
  sessionId?: string;
  workspacePath?: string;
  signalId: string;
  action: 'accept' | 'reject' | 'modify' | 'defer';
  reason?: string;
  modifiedTitle?: string;
  modifiedProposedAction?: string;
}

export interface InboxActValue {
  ok: boolean;
  action: string;
  kind: 'adopt' | 'microflow' | 'record';
  microflow?: string;
  message: string;
}

export interface StoryMapPayload {
  sessionId?: string;
  workspacePath?: string;
}

export interface StoryMapAssetCard {
  kind: 'thread' | 'arc' | 'foreshadowing' | 'reveal';
  slug: string;
  name: string;
  status: string;
  summary?: string;
  thread_type?: string;
  start_chapter?: number;
  end_chapter?: number;
  chapter_range?: number[];
  planned_payoff_chapter?: number;
  planned_payoff_scene?: string;
  related_thread_ids?: string[];
  target_type?: string;
  target_id?: string;
  secret_summary?: string;
}

export interface StoryMapSceneCard {
  slug: string;
  status: string;
  chapters: string[];
  title?: string;
}

export interface StoryMapValue {
  bound: { book: string; root: string } | null;
  book: string;
  chapters: Array<{ index: number; title?: string }>;
  scenes: StoryMapSceneCard[];
  threads: StoryMapAssetCard[];
  arcs: StoryMapAssetCard[];
  foreshadowing: StoryMapAssetCard[];
  reveals: StoryMapAssetCard[];
  /** 跨类关系边(ADR-0019: 显式 relations + related_*_ids 兼容投影并集去重)。 */
  edges: Array<{ source: string; target: string; type: string; status: string; sourceKind?: string }>;
}

export interface WritingDeskPayload {
  sessionId?: string;
  workspacePath?: string;
}

export interface ReviewCard {
  review_id: string;
  chapter_index: number;
  verdict: string;
  finding_count: number;
  reviewed_at: string;
}

export interface ObjectCard {
  slug: string;
  name: string;
  kind: string;
  status: string;
}

export interface ProposalCard {
  run_id: string;
  chapter_index: number;
  next_chapter: number;
  generated_at: string;
  proposals: Array<{
    title: string;
    premise: string;
    basis?: string[];
    cost?: string;
    risk?: string;
  }>;
}

export interface WritingDeskValue {
  bound: { book: string; root: string } | null;
  book: string;
  chapters: Array<{ index: number; title?: string }>;
  threads: Array<{ slug: string; name: string; thread_type?: string; status: string }>;
  arcs: Array<{ slug: string; name: string; status: string }>;
  /** 守望台: 新鲜信号 */
  signals: SignalCard[];
  /** 参照台: 已采用/候选对象 */
  objects: ObjectCard[];
  /** 评审台: 各章最新语义审查 */
  reviews: ReviewCard[];
  /** 计划台: 最新一条续写提案(无则 null) */
  proposals: ProposalCard | null;
}

export interface ChapterDossierPayload {
  sessionId?: string;
  workspacePath?: string;
  chapterIndex: number;
}

/** Scene 分解卡(§17.5.1; store DossierScene 的纯 JSON 投影, 作者语言)。 */
export interface DossierSceneCard {
  slug: string;
  title: string;
  status: string;
  goal?: string;
  core_conflict?: string;
  must_happen?: string;
  must_not_happen?: string;
  narrative_tag?: string;
  pov_character_id?: string;
}

/** 章节档案资产面(镜像 store.ChapterDossier, 平铺为纯 JSON 接口; 逐资产容错, 不炸整体)。 */
export interface ChapterDossierAsset {
  /** 章不存在 → null(「未导入章」兜底 UI, 其余字段尽力组装)。 */
  chapter: {
    index: number;
    title?: string;
    status: string;
    contentHash?: string;
    wordCount: number;
  } | null;
  scenes: DossierSceneCard[];
  characters: Array<{ slug: string; name: string }>;
  pov: Array<{ scene: string; character: string }>;
  foreshadowing: {
    planted: Array<{ slug: string; name: string }>;
    activeThrough: Array<{ slug: string; name: string }>;
    duePayoff: Array<{ slug: string; name: string }>;
  };
  reveals: Array<{ slug: string; name: string }>;
  referencedObjects: Array<{ slug: string; name: string; kind: string }>;
  rhythm: { wordCount: number; sceneCount: number; avgSceneLength: number };
}

export interface ChapterDossierValue {
  bound: { book: string; root: string } | null;
  dossier: ChapterDossierAsset;
  /** 本章最新一条语义审查(无则 null)。 */
  review: { review_id: string; verdict: string; finding_count: number; reviewed_at: string } | null;
  /** target.chapter_index==N 的 open 信号。 */
  signals: SignalCard[];
  /** next_chapter==N 的最新一条续写提案(无则 null)。 */
  proposal: ProposalCard | null;
}

export interface PresetsListPayload {
  sessionId?: string;
  workspacePath?: string;
}

/** 内容手预设卡(纯 JSON 投影; N20/D13; 卡片信息序对齐父仓库 account-provider-card: 名称→模型→状态行)。 */
export interface ContentPresetCard {
  name: string;
  label?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout_ms?: number;
  /** 来源: 种子(内置 DEFAULT_CONTENT_PRESETS)或存储(用户自定义卡)。 */
  source: 'seed' | 'stored';
}

export interface PresetsListValue {
  bound: { book: string; root: string } | null;
  /** 全量预设(种子 ∪ 存储); 最小 profile(宿主无 presets 面)时种子兜底。 */
  presets: ContentPresetCard[];
  /** 当前书生效预设名(llm.yml preset 键; 未设/未绑定 null)。 */
  active: string | null;
  /** 内容手默认路由(宿主 Config.llm; 缺省兜底 deepseek/deepseek-chat)。 */
  defaultRoute: { provider: string; model: string };
  /** 已注册 provider 路由 id 列表(ctx.llm; 最小 profile 空数组, 不炸)。 */
  availableProviders: string[];
}

export interface PresetsSelectPayload {
  sessionId?: string;
  workspacePath?: string;
  /** 预设名; null = 恢复默认(移除 llm.yml 的 preset 键, N19 只动这一键)。 */
  preset: string | null;
}

export interface PresetsSelectValue {
  ok: boolean;
  /** 写入后生效的预设名(null = 默认/继承助手配置)。 */
  active: string | null;
  /** 作者语言结果消息。 */
  message: string;
}

// ---------------------------------------------------------------------------
// map-atlas(Phase 6; 计划 §4 Phase 6)
// ---------------------------------------------------------------------------

export interface AtlasViewPayload {
  sessionId?: string;
  workspacePath?: string;
  runId?: string;
}

/** 文字标签卡(坐标恒为归一化 0–1; spec §2.2)。 */
export interface AtlasLabelCard {
  id: string;
  label: string;
  position_x: number;
  position_y: number;
  target_node_ref?: string;
  sort_order?: number;
}

/** 页面卡(预览仅 ≤2MB 小图给 base64; 大图只回元数据与本地相对路径)。 */
export interface AtlasPageCard {
  id: string;
  node_ref: string;
  title: string;
  level: string;
  generation_status: string;
  review_status: string;
  visual_brief: string;
  prompt: string;
  evidence: { supported: string[]; visual_fill: string[]; conflicts: string[] };
  image?: { file: string; media_type: string; width: number; height: number; byte_size: number; preview_data_url?: string };
  /** 有 image 元数据但本地文件缺失。 */
  image_missing: boolean;
  annotations: AtlasLabelCard[];
  content_hash: string;
}

/** 节点卡(树渲染; is_placeholder = 已采用且无 adopted 页, N28)。 */
export interface AtlasNodeCard {
  id: string;
  parent_ref: string | null;
  title: string;
  level: string;
  status: string;
  is_placeholder: boolean;
}

export interface AtlasViewValue {
  bound: { book: string; root: string } | null;
  run: { id: string; run_kind: string; status: string; planned_page_count: number; error_code: string | null; error_message: string | null; created_at: string } | null;
  adopted: { nodes: AtlasNodeCard[]; pages: AtlasPageCard[] };
  pending: { nodes: AtlasNodeCard[]; pages: AtlasPageCard[] };
  /** 标注队列状态(.assistant/atlas/annotation-queue/ 未消费; ops = 各文件 op 数合计)。 */
  queue: { files: number; ops: number; pages: string[] };
}

/** 标注请求载荷(UI 落盘队列; 机器生成机器消费, 不经自然语言)。 */
export interface AtlasAnnotationOpInput {
  op: 'add' | 'update' | 'delete';
  id?: string;
  label?: string;
  position_x?: number;
  position_y?: number;
  target_node_ref?: string | null;
}

export interface AtlasAnnotationRequestPayload {
  sessionId?: string;
  workspacePath?: string;
  page_ref: string;
  base_content_hash: string;
  ops: AtlasAnnotationOpInput[];
}

export interface AtlasAnnotationRequestValue {
  ok: boolean;
  queued: number;
  file: string;
  message: string;
}
