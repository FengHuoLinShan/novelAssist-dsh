// @novelcraft/client · 通道 wire 契约(纯类型 + 常量, 宿主/浏览器共享;
// 无任何运行时依赖, 可被 client bundle 安全引用)。
export const RPC_CHANNEL = '/novelcraft';

/** 通道端点名。 */
export const ENDPOINTS = {
  watchState: 'watch/state',
  inboxList: 'inbox/list',
  inboxAct: 'inbox/act',
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
