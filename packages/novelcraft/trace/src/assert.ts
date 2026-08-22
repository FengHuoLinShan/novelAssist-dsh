// @novelcraft/trace · 策略断言 DSL(设计文档 §15「Trace contract」)。
// 每条断言对应一条 §15 不变量; 失败抛错(作者语言消息), 测试直接 expect(() => assert...)。
import { TraceRecorder } from "./trace.js";
import type { DeepImportPolicy, TraceEvent, TraceEventType } from "./trace.js";

export type TraceSource = TraceRecorder | readonly TraceEvent[];

function eventsOf(trace: TraceSource): readonly TraceEvent[] {
  return trace instanceof TraceRecorder ? trace.all() : trace;
}

function firstIndexOf(events: readonly TraceEvent[], type: TraceEventType): number {
  return events.findIndex((e) => e.type === type);
}

/** §15 顺序: before 事件必须先于 after 事件(取各自首次出现)。 */
export function assertOrdered(trace: TraceSource, before: TraceEventType, after: TraceEventType): void {
  const events = eventsOf(trace);
  const i = firstIndexOf(events, before);
  const j = firstIndexOf(events, after);
  if (i < 0) throw new Error(`trace contract 违反: 缺少 ${before} 事件`);
  if (j < 0) throw new Error(`trace contract 违反: 缺少 ${after} 事件`);
  if (i >= j) throw new Error(`trace contract 违反: ${before} 必须先于 ${after}(实际序 ${i} ≥ ${j})`);
}

/** §9/§15 审批: 每个 adopt 前必有 approval=allowed-once; rejected/unavailable 之后不得有 adopt。 */
export function assertEveryAdoptApproved(trace: TraceSource): void {
  const events = eventsOf(trace);
  let granted = false;
  let blocked = false;
  for (const e of events) {
    if (e.type === "approval") {
      if (e.decision === "allowed-once") {
        granted = true;
        blocked = false;
      } else {
        granted = false;
        blocked = true;
      }
    } else if (e.type === "adopt") {
      if (blocked) throw new Error(`trace contract 违反: rejected/unavailable 之后不得有 adopt(${e.action})`);
      if (!granted) throw new Error(`trace contract 违反: adopt(${e.action}) 前必须有 approval=allowed-once`);
      granted = false; // allowed-once 只授权一次
    }
  }
}

/** §15 checkpoint: 每个 phase 后必有 checkpoint, 且在其 stage_candidates(若有)之后。 */
export function assertCheckpointAfterPhase(trace: TraceSource, phases: string[]): void {
  const events = eventsOf(trace);
  for (const phase of phases) {
    const cps = events.filter((e) => e.type === "checkpoint" && e.phase === phase);
    if (cps.length === 0) throw new Error(`trace contract 违反: phase ${phase} 后缺少 checkpoint`);
    const staged = events.filter((e) => e.type === "stage_candidates" && e.phase === phase);
    if (staged.length > 0) {
      const lastStaged = Math.max(...staged.map((e) => e.seq));
      const firstCp = Math.min(...cps.map((e) => e.seq));
      if (firstCp <= lastStaged) {
        throw new Error(`trace contract 违反: phase ${phase} 的 checkpoint 必须在其 stage_candidates 之后`);
      }
    }
  }
}

/** N33: 每个 batch 必须 plan → artifact commit → cursor completed，且不得重复推进。 */
export function assertBatchPersistenceOrder(trace: TraceSource): void {
  const events = eventsOf(trace);
  const planned = events.filter((e) => e.type === "batch_planned");
  for (const plan of planned) {
    const artifacts = events.filter((e) => e.type === "batch_artifact" && e.batch_id === plan.batch_id);
    const cursors = events.filter((e) => e.type === "batch_cursor" && e.batch_id === plan.batch_id);
    if (artifacts.length !== 1) throw new Error(`trace contract 违反: batch ${plan.batch_id} 必须恰有一个 artifact commit`);
    if (cursors.length !== 1) throw new Error(`trace contract 违反: batch ${plan.batch_id} 必须恰推进一次 cursor`);
    if (plan.seq >= artifacts[0].seq || artifacts[0].seq >= cursors[0].seq) {
      throw new Error(`trace contract 违反: batch ${plan.batch_id} 必须 plan → artifact → cursor`);
    }
  }
  const batchEvents = events.filter(
    (e): e is Extract<TraceEvent, { type: "batch_artifact" | "batch_cursor" }> =>
      e.type === "batch_artifact" || e.type === "batch_cursor",
  );
  const unplanned = batchEvents.find((event) => !planned.some((plan) => plan.batch_id === event.batch_id));
  if (unplanned) throw new Error(`trace contract 违反: batch ${unplanned.batch_id} 未先提交 plan`);
}

/** N33: applied 必须从 applying 转入并携 transaction identity；中断只能回待审批。 */
export function assertApplyStateMachine(trace: TraceSource): void {
  const events = eventsOf(trace).filter(
    (e): e is Extract<TraceEvent, { type: "apply_state" }> => e.type === "apply_state",
  );
  const current = new Map<string, string>();
  for (const event of events) {
    const observed = current.get(event.apply_id);
    if (event.from !== undefined && observed !== undefined && event.from !== observed) {
      throw new Error(`trace contract 违反: apply ${event.apply_id} from=${event.from} 与当前 ${observed} 不符`);
    }
    if (event.to === "applying" && event.from !== "waiting_approval") {
      throw new Error(`trace contract 违反: apply ${event.apply_id} 只能由 waiting_approval 进入 applying`);
    }
    if (event.to === "applied" && (event.from !== "applying" || !event.transaction_id)) {
      throw new Error(`trace contract 违反: apply ${event.apply_id} applied 缺少 applying/transaction identity`);
    }
    if (event.to === "waiting_approval" && event.from !== "applying") {
      throw new Error(`trace contract 违反: apply ${event.apply_id} 非 applying 中断不得回 waiting_approval`);
    }
    current.set(event.apply_id, event.to);
  }
}

const SHARD_LIMIT_KEY: Record<string, keyof DeepImportPolicy> = {
  "1a": "slicingBatchSize",
  "2a": "phase2BatchSize",
  "2b": "aliasConcurrency",
};

/** policy-defaults.md §4 分片: 各 phase 批大小不得超过 policy 上限。 */
export function assertShardsWithinPolicy(trace: TraceSource, policy: DeepImportPolicy): void {
  const events = eventsOf(trace);
  for (const e of events) {
    if (e.type !== "stage_candidates") continue;
    const key = SHARD_LIMIT_KEY[e.phase];
    if (!key) continue;
    if (e.batch_size > policy[key]) {
      throw new Error(`trace contract 违反: phase ${e.phase} 分片 ${e.batch_size} 超过 policy 上限 ${policy[key]}(${key})`);
    }
  }
}

/** §15 降级: 每条降级条款都必须在 trace 中出现过对应 degradation 事件。 */
export function assertDegradationClauses(trace: TraceSource, clauses: readonly string[]): void {
  const events = eventsOf(trace);
  const seen = new Set(events.filter((e) => e.type === "degradation").map((e) => e.clause));
  for (const clause of clauses) {
    if (!seen.has(clause)) throw new Error(`trace contract 违反: 缺少降级条款事件 ${clause}`);
  }
}
