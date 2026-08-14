// @novelcraft/trace · MockApproval(脚本化决策, fail-closed)+ policy 默认值加载。
import type { ApprovalDecision, DeepImportPolicy } from "./trace.js";

export interface MockApprovalScript {
  /** 按调用顺序弹出的决策; 耗尽后 fail-closed 返回 unavailable。 */
  decisions: ApprovalDecision[];
}

/** 脚本化审批: 记录每次调用并按队列弹出决策(耗尽即拒绝)。 */
export class MockApproval {
  readonly calls: Array<{ action: string; summary: string; items: string[] }> = [];
  private decisions: ApprovalDecision[];

  constructor(script: MockApprovalScript) {
    this.decisions = [...script.decisions];
  }

  async approve(action: string, summary: string, items: string[]): Promise<ApprovalDecision> {
    this.calls.push({ action, summary, items });
    return this.decisions.shift() ?? "unavailable"; // fail-closed(§9 ApprovalGate)
  }
}

/** policy-defaults.md §4: phase2 batch 12 / alias 并发 4 / 1a 并发 50。 */
export const DEFAULT_POLICY: DeepImportPolicy = {
  slicingBatchSize: 50,
  phase2BatchSize: 12,
  aliasConcurrency: 4,
};

export function loadPolicyDefaults(overrides?: Partial<DeepImportPolicy>): DeepImportPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}
