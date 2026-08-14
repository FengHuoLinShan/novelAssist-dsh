// @novelcraft/dsh · runDeepImport 的 DSH 挂载适配 + 文件化 trace sink。
// seam 契约(packages/novelcraft/README.md): 深度导入编排 = 确定性工作流,
// runtime.provider = DshProvider、runtime.approve = ApprovalGate(fail-closed)、
// runtime.trace = ImportTraceSink(落 .assistant/import-trace.jsonl, 文件真相 + git 回滚面)。
// 依据: 设计文档 §15(trace contract)、§9(adopt 必过 approval)、§22.2(session log)。
import path from 'node:path';
import { appendFileSync } from 'node:fs';
import { paths } from '@novelcraft/vault';
import * as imports from '@novelcraft/imports';
import type { ApprovalDecision, DeepImportPolicy, TraceEvent, TraceEventInput, TraceSink } from '@novelcraft/trace';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { NovelCraftService } from './service.js';

/** vault 内深度导入 trace 落点(.assistant/import-trace.jsonl, 与 checkpoint/merge-log 同目录)。 */
export function importTraceFile(root: string): string {
  return path.join(paths(root).assistant.dir, 'import-trace.jsonl');
}

/**
 * 文件化 trace sink: 每个事件补 seq/ts 后追加一行 JSON。
 * 事件进 git 历史(可回滚可审计), 是 §15 trace contract 在 DSH 挂载下的持久化形态。
 */
export class ImportTraceSink implements TraceSink {
  private seq = 0;
  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  record(event: TraceEventInput): TraceEvent {
    const full = { ...event, seq: this.seq++, ts: new Date().toISOString() } as TraceEvent;
    appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }
}

export interface DeepImportOptions {
  startChapter: number;
  endChapter: number;
  /** 分片/批量策略覆盖(缺省 @novelcraft/trace loadPolicyDefaults)。 */
  policy?: DeepImportPolicy;
}

/** GateDecision → ApprovalDecision 映射: cancelled 视同拒绝(fail-closed)。 */
function toApprovalDecision(decision: string): ApprovalDecision {
  if (decision === 'allowed-once') return 'allowed-once';
  if (decision === 'unavailable') return 'unavailable';
  return 'rejected'; // rejected / cancelled 一律拒绝
}

/**
 * 深度导入 DSH 挂载: 组装 runDeepImport 的运行时并执行六阶段。
 * - 计划经 planImport(confirmed 强制 true, R40 授权快照);
 * - adopt(Scene commit)经 ApprovalGate(fail-closed, §9);
 * - trace 事件落 .assistant/import-trace.jsonl(§15 trace contract)。
 */
export async function deepImport(
  service: NovelCraftService,
  agent: Agent | undefined,
  root: string,
  opts: DeepImportOptions,
): Promise<imports.DeepImportResult> {
  const plan = imports.planImport(root, {
    startChapter: opts.startChapter,
    endChapter: opts.endChapter,
    confirmed: true,
  });
  const sink = new ImportTraceSink(importTraceFile(root));
  return imports.runDeepImport(root, plan, {
    // 内容手经该书预设面(N20): llm.yml preset/直键注入 provider/model/参数默认。
    provider: await service.contentProviderFor(root),
    approve: async (action, summary, items) => {
      const decision = await service.approval.request(agent, { action, summary, items });
      return toApprovalDecision(decision);
    },
    trace: sink,
    ...(opts.policy ? { policy: opts.policy } : {}),
  });
}
