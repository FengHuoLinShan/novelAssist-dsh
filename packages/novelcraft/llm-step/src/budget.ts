// 预算估算(R2): 启发式近似, 依据 specs/rules/policy-defaults.md。
// 拉丁字符 /4, CJK /1.6; 真实 token 数以 provider usage 回执为准。
export function estimateTokens(text: string): number {
  let latin = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef);
    if (isCjk) cjk += 1;
    else latin += 1;
  }
  return Math.ceil(cjk / 1.6 + latin / 4);
}

export interface BudgetResult {
  estimatedInput: number;
  allowed: boolean;
}

/** 预算守卫: 估算输入 + 输出上限 超预算即拒绝(budget_exceeded)。 */
export function checkBudget(inputText: string, outputCapTokens: number): BudgetResult {
  const estimatedInput = estimateTokens(inputText);
  return { estimatedInput, allowed: outputCapTokens <= 0 || estimatedInput <= outputCapTokens };
}

// —— 工作流累计预算 guard seam(N34 / ADR-0023 §6: ExecutionProfile.workflowBudget) ——
// 编排级累计 token 预算: 一次编排(deep_import 多章、批量生成等)在启动时按
// profile.workflowBudget 创建 tracker, 逐 runStep 调用消费; 超支在 provider 前
// fail-closed(不产生新的 provider 成本)。至少提供累计 guard seam —— 编排是否真正
// 传 tracker 由其决定, 本 seam 不改变任何既有调用面(纯加法)。

export interface WorkflowBudget {
  /** 预算总量(只读) */
  readonly total: number;
  /** 累计已消费(只读快照) */
  readonly spent: number;
  /** 剩余可用(只读快照) */
  readonly remaining: number;
  /** At least one attempted spend exceeded the remaining budget. */
  readonly exceeded?: boolean;
  /**
   * 尝试消费 amount token: 剩余充足 → 扣减并返回 true; 不足 → 不扣减返回 false
   * (调用方据此 fail-closed, 不得部分消费)。
   */
  trySpend(amount: number): boolean;
}

/** 创建累计预算 tracker(total 必须是 ≥1 有限整数, 否则抛错 fail-closed)。 */
export function createWorkflowBudget(total: number): WorkflowBudget {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new Error(`workflowBudget 必须是 ≥1 的整数(实际 ${total})`);
  }
  let spent = 0;
  let exceeded = false;
  return {
    get total() {
      return total;
    },
    get spent() {
      return spent;
    },
    get remaining() {
      return total - spent;
    },
    get exceeded() {
      return exceeded;
    },
    trySpend(amount: number): boolean {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`workflowBudget 消费量必须是 ≥0 的有限数字(实际 ${amount})`);
      }
      if (spent + amount > total) {
        exceeded = true;
        return false;
      }
      spent += amount;
      return true;
    },
  };
}
