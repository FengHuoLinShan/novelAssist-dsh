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
