// @novelcraft/dsh · ApprovalGate(ctx.approval 适配)。
// seam 契约(packages/novelcraft/README.md): ApprovalGate.request({action, summary, items})
// → allowed-once/rejected, 包 DSH approval 服务, fail-closed。
// 依据: 设计文档 §9(采用类写操作必过 approval)、§22.3(store seam = approval)。
// DSH ApprovalService.request 需要「有开轮的 Agent」; 无 agent 时本适配器直接
// fail-closed(拒绝), 不绕过 —— 与 DSH 自身语义一致(unavailable = fail closed)。
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval';
import { svc } from '../ctx.js';

export type GateDecision = Extract<ApprovalOutcome, 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;

export interface GateRequest {
  /** 动作名(作者语言: 如「采用对象」「采用章节候选」) */
  action: string;
  /** 一句话摘要(作者语言, 收件箱/确认界面可见) */
  summary: string;
  /** 变更条目清单(可选项, 附在 reason 中供人判断) */
  items?: string[];
  /** 取消信号(转给 DSH approval request) */
  signal?: AbortSignal;
  /** DSH 工具名(审计归属; 默认 novelcraft) */
  toolName?: string;
}

export class GateDeniedError extends Error {
  readonly decision: GateDecision;
  constructor(decision: GateDecision, message: string) {
    super(message);
    this.name = 'GateDeniedError';
    this.decision = decision;
  }
}

/**
 * 写面未走审批门即被调用(拒绝存根抛此错误; N31 收口 + 铁律3 fail-closed)。
 * 与 GateDeniedError 的区别: 后者是走了审批但被拒, 前者是调用方根本没走审批门。
 */
export class GateRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateRequiredError';
  }
}

/**
 * 把 ctx.approval 包装为 NovelCraft 的审批门。
 * - allowed-once → 'allowed'(DSH 语义: 授权只适用于本次请求动作);
 * - rejected/cancelled/unavailable/无 agent → 拒绝(fail-closed)。
 */
export class ApprovalGate {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  async request(agent: Agent | undefined, req: GateRequest): Promise<GateDecision> {
    if (!agent) {
      return 'unavailable'; // 无 agent = 无开轮 = 无法走审批链, fail-closed
    }
    const reason = [req.action, req.summary]
      .filter(Boolean)
      .join(': ')
      .concat(req.items?.length ? `(${req.items.length} 项变更)` : '');
    let outcome: ApprovalOutcome;
    try {
      const approval = svc<{ request(r: ApprovalRequest): Promise<ApprovalOutcome> }>(this.ctx, 'approval');
      if (!approval) return 'unavailable';
      outcome = await approval.request({
        agent,
        toolName: req.toolName ?? 'novelcraft',
        reason,
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch {
      return 'unavailable'; // 审批服务缺失/异常 → fail-closed
    }
    return outcome === 'allowed-once' ? 'allowed-once' : outcome;
  }

  /** 便捷: 通过审批后执行写动作; 未通过抛 GateDeniedError(作者语言消息)。 */
  async guard<T>(agent: Agent | undefined, req: GateRequest, fn: () => Promise<T>): Promise<T> {
    const decision = await this.request(agent, req);
    if (decision !== 'allowed-once') {
      throw new GateDeniedError(
        decision,
        `未获批准, 已放弃「${req.action}」(决策: ${decision})`,
      );
    }
    return fn();
  }
}
