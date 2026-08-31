// @novelcraft/trace · trace contract 事件与记录器(零运行时依赖)。
// 依据: 设计文档 §15(Trace contract 锁编排纪律)、ADR-0016 §1、ADR-0017 §1(③ trace contract)。
// 本包是纯 TS 叶子包: 只定义事件词表 + 内存有序记录 + 断言 DSL + mock 决策/策略默认,
// 不依赖 DSH 运行时, 可直接 vitest 直测。

export type TraceEventType =
  | "begin_import"
  | "stage_candidates"
  | "checkpoint"
  | "batch_planned"
  | "batch_artifact"
  | "batch_cursor"
  | "resume"
  | "apply_state"
  | "llm_step"
  | "degradation"
  | "approval"
  | "adopt"
  | "reject"
  | "complete_import";

/** 审批决策(与 DSH ApprovalOutcome 的 allowed-once/rejected/unavailable 对齐; fail-closed)。 */
export type ApprovalDecision = "allowed-once" | "rejected" | "unavailable";

/** 深度导入分片/批量策略默认值(来源: specs/rules/policy-defaults.md §4)。 */
export interface DeepImportPolicy {
  /** Phase 1a 逐章切分并发/批量上限(默认 50) */
  slicingBatchSize: number;
  /** Phase 2 实体抽取 Scene 批大小(默认 12) */
  phase2BatchSize: number;
  /** Phase 2b 别名/关系 Scene 并发上限(默认 4) */
  aliasConcurrency: number;
}

/** 降级条款词表(R52–R55 / PLAN.md「降级条款」)。 */
export const DEGRADATION_CLAUSE = {
  /** R54: 1a 重叠/空洞整章 fallback, 不部分采用 */
  phase1aFallback: "1a_whole_chapter_fallback",
  /** R52: 1b provider/schema 失败空语义进复核 */
  phase1bEmptySemantics: "1b_empty_semantics",
  /** R53: 2b 只降级不丢对象 */
  phase2bNoDrop: "2b_no_drop",
  /** R55: 去重失败降级(不抛异常) */
  dedupFailed: "dedup_failed",
} as const;

export type DegradationClause = (typeof DEGRADATION_CLAUSE)[keyof typeof DEGRADATION_CLAUSE];

interface TraceEventBase {
  /** 单调递增序号(0 起, 记录器内部维护) */
  seq: number;
  /** 记录时刻(ISO 8601) */
  ts: string;
  type: TraceEventType;
}

export interface BeginImportEvent extends TraceEventBase {
  type: "begin_import";
  workflow_id: string;
  start_chapter: number;
  end_chapter: number;
  authorization_confirmed: boolean;
  input_fingerprint: string;
  /** N34/ADR-0023 §6 + 独立审查 P5: 启动解析一次的执行画像指纹(可选, 加法)。
   *  resume/续跑按此拒绝旧 run(执行画像变化不沿用旧 checkpoint)。 */
  profile_fingerprint?: string;
  /** P5/R6: 本次编排的契约版本集(从 spec registry 构造; 可选, 加法)。 */
  contract_versions?: Record<string, string>;
}

export interface StageCandidatesEvent extends TraceEventBase {
  type: "stage_candidates";
  phase: string;
  /** 本次分片处理的输入条目数(供 assertShardsWithinPolicy 校验) */
  batch_size: number;
  /** 本批次产出/暂存候选数 */
  count: number;
  /** 本批次候选 id(2b 无新候选, 为空) */
  candidate_ids: string[];
}

export interface CheckpointEvent extends TraceEventBase {
  type: "checkpoint";
  phase: string;
  input_fingerprint: string;
  done: boolean;
}

export interface BatchPlannedEvent extends TraceEventBase {
  type: "batch_planned";
  workflow_id: string;
  batch_id: string;
  phase: string;
  ordinal: number;
}

export interface BatchArtifactEvent extends TraceEventBase {
  type: "batch_artifact";
  workflow_id: string;
  batch_id: string;
  result_hash: string;
  transaction_id: string;
}

export interface BatchCursorEvent extends TraceEventBase {
  type: "batch_cursor";
  workflow_id: string;
  batch_id: string;
  state: "completed";
}

export interface ResumeEvent extends TraceEventBase {
  type: "resume";
  workflow_id: string;
  outcome: "continued" | "provider_outcome_unknown" | "incompatible" | "recovered_intent";
  remaining_batches: number;
}

export interface ApplyStateEvent extends TraceEventBase {
  type: "apply_state";
  workflow_id: string;
  apply_id: string;
  target: string;
  from?: "waiting_approval" | "applying";
  to: "waiting_approval" | "applying" | "applied" | "rejected" | "skipped" | "failed";
  transaction_id?: string;
}

export interface LlmStepEvent extends TraceEventBase {
  type: "llm_step";
  /** 本次 provider 调用是否成功(未抛错) */
  ok: boolean;
  /** 失败时的错误消息(provider 层, 未分类) */
  error?: string;
  model?: string;
  /** 本次请求 system 提示指纹(N38/M10-A review 加法): runStep 组装时填充,
   *  tracedProvider 透传 —— 模型可见⟺可回放。 */
  promptHash?: string;
  /** 输出契约注入模式(text-contract | none)。 */
  schemaInjection?: "text-contract" | "none";
}

export interface DegradationEvent extends TraceEventBase {
  type: "degradation";
  clause: string;
  phase: string;
  detail?: string;
}

export interface ApprovalEvent extends TraceEventBase {
  type: "approval";
  action: string;
  decision: ApprovalDecision;
}

export interface AdoptEvent extends TraceEventBase {
  type: "adopt";
  action: string;
  items: string[];
}

export interface RejectEvent extends TraceEventBase {
  type: "reject";
  action: string;
  decision: "rejected" | "unavailable";
}

export interface CompleteImportEvent extends TraceEventBase {
  type: "complete_import";
  workflow_id: string;
  adopted: number;
}

export type TraceEvent =
  | BeginImportEvent
  | StageCandidatesEvent
  | CheckpointEvent
  | BatchPlannedEvent
  | BatchArtifactEvent
  | BatchCursorEvent
  | ResumeEvent
  | ApplyStateEvent
  | LlmStepEvent
  | DegradationEvent
  | ApprovalEvent
  | AdoptEvent
  | RejectEvent
  | CompleteImportEvent;

/** 记录入参 = 事件去 seq/ts(由记录器补全)。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TraceEventInput = DistributiveOmit<TraceEvent, "seq" | "ts">;

/** 可注入 trace sink(runDeepImport 的 runtime.trace)。 */
export interface TraceSink {
  record(event: TraceEventInput): TraceEvent;
}

/** 内存追加、有序的 trace 记录器。 */
export class TraceRecorder implements TraceSink {
  private events: TraceEvent[] = [];
  private seq = 0;

  record(event: TraceEventInput): TraceEvent {
    const full = { ...event, seq: this.seq++, ts: new Date().toISOString() } as TraceEvent;
    this.events.push(full);
    return full;
  }

  /** 按记录顺序返回全部事件(拷贝, 防外部篡改)。 */
  all(): TraceEvent[] {
    return [...this.events];
  }

  eventsOf(type: TraceEventType): TraceEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  clear(): void {
    this.events = [];
    this.seq = 0;
  }

  get length(): number {
    return this.events.length;
  }
}
