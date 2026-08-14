// assistant 核心 · 信号(R6 纯 TS 部分)。
// 依据: 设计文档 §8(统一信号模型) + adjudications N1(6 键健康词汇表)。
// 信号持久化 = .assistant/signals/{id}.json(vault paths); 文件即状态。

export type RadarKind = "ingest" | "dedup" | "suggest" | "plot" | "risk" | "writing";
export type Severity = "hint" | "note" | "risk" | "conflict";
export type SignalStatus = "open" | "accepted" | "rejected" | "deferred" | "resolved";

export interface SignalTarget {
  novel?: string;
  chapter_index?: number;
  scene_slug?: string;
  content_hash?: string;
}

export interface Signal {
  id: string;
  radar: RadarKind;
  severity: Severity;
  /** 作者语言的可执行命题(收件箱卡片首行) */
  title: string;
  /** 证据(来源 + 引用, 作者语言) */
  evidence: string[];
  proposed_action: string;
  reversibility: boolean;
  confidence?: number;
  observed_at: string;
  /** 正文一变即过期(写作/审查类信号) */
  expires_when_draft_changes?: boolean;
  target?: SignalTarget;
  status: SignalStatus;
  decided_at?: string;
  /** 打回理由(校准原料) */
  reject_reason?: string;
}

const RADARS: RadarKind[] = ["ingest", "dedup", "suggest", "plot", "risk", "writing"];
const SEVERITIES: Severity[] = ["hint", "note", "risk", "conflict"];
/** 干扰分级(设计文档 §11): 冲突级立即亮宠物; 风险进角标; 提示/注意静默堆积 */
export const SEVERITY_ORDER: Record<Severity, number> = {
  conflict: 3,
  risk: 2,
  note: 1,
  hint: 0,
};

export interface CreateSignalInput {
  radar: RadarKind;
  severity: Severity;
  title: string;
  evidence: string[];
  proposed_action: string;
  reversibility: boolean;
  confidence?: number;
  target?: SignalTarget;
  expires_when_draft_changes?: boolean;
  id?: string;
}

/** 校验并创建信号(状态 open)。非法字段抛错。 */
export function createSignal(input: CreateSignalInput, now: Date = new Date()): Signal {
  if (!RADARS.includes(input.radar)) throw new Error(`radar 非法: ${input.radar}`);
  if (!SEVERITIES.includes(input.severity)) throw new Error(`severity 非法: ${input.severity}`);
  if (!input.title.trim()) throw new Error("title 必填(可执行命题)");
  if (input.evidence.length === 0) throw new Error("evidence 至少一条");
  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw new Error("confidence 必须在 [0,1]");
  }
  return {
    id: input.id ?? `sig-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    radar: input.radar,
    severity: input.severity,
    title: input.title,
    evidence: input.evidence,
    proposed_action: input.proposed_action,
    reversibility: input.reversibility,
    confidence: input.confidence,
    observed_at: now.toISOString(),
    expires_when_draft_changes: input.expires_when_draft_changes ?? false,
    target: input.target,
    status: "open",
  };
}

/** 新鲜度(§8): 正文哈希与信号观测时不一致 → 过期。 */
export function isStale(signal: Signal, currentContentHash?: string): boolean {
  if (!signal.expires_when_draft_changes) return false;
  if (!signal.target?.content_hash) return false;
  return currentContentHash !== undefined && currentContentHash !== signal.target.content_hash;
}

/** 收件箱排序(§9): 风险前置——severity 降序, 同级按观察时间升序(先来先看)。 */
export function sortInbox(signals: Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    const bySeverity = (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    return a.observed_at.localeCompare(b.observed_at);
  });
}

/** 健康键词汇表(N1): 统一 6 键, 域前缀。 */
export const HEALTH_KEYS = [
  "scene_unreviewed",
  "scene_unassigned_chapter",
  "scene_missing_setup",
  "scene_needs_organize",
  "structure_needs_review",
  "structure_unassigned",
] as const;
export type HealthKey = (typeof HEALTH_KEYS)[number];
