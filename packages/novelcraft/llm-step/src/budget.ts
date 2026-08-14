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
