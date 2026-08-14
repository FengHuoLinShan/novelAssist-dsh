// M7 Phase E 钉死契约(N27): catalog 预算/参数转录值防再漂移。
// 表格 = specRef → { budgetTokens, temperature, timeoutMs }, 转录自 catalog §x.y(N27)。
// 口径: temperature 按 catalog 原样转录; timeout catalog 秒 → timeoutMs 毫秒;
// budgetTokens 仅在 spec 最坏情况输入估算 ≤ catalog max_tokens 时转录 catalog 值,
// 输入可能超过则保持 0(N27 输入主导豁免, 输入上界由调用方控制)。
// 本表只含 catalog 有对应节且注册于 llm-step BUILTIN_SPECS 的 spec(7 个);
// 其余包注册的 spec(world/outline/imports/writing)转录核对一致、无改动, 不入本表。
import { describe, expect, it } from "vitest";
import { loadSpec } from "../src/index";

// specRef → { budgetTokens, temperature, timeoutMs }(转录自 catalog §x.y, N27)
const TRANSCRIBED: Record<string, { budgetTokens: number; temperature: number; timeoutMs: number }> = {
  // catalog §1.6: temp 0.3 / max_tokens 32768; timeout = 项目 LLM timeout+60s 公式, 无字面秒数 → 600_000ms 上限保持
  entity_extraction: { budgetTokens: 32768, temperature: 0.3, timeoutMs: 600_000 },
  // catalog §1.9: temp 0.1; 无 max_tokens/timeout 行 → 0 / 600_000ms 保持
  dedup_judge: { budgetTokens: 0, temperature: 0.1, timeoutMs: 600_000 },
  // catalog §3.3: temp 0.1 / timeout 1800s; 无 max_tokens 行 → budgetTokens 0 保持
  semantic_review: { budgetTokens: 0, temperature: 0.1, timeoutMs: 1_800_000 },
  // catalog §1.8: temp 0.2 / timeout 1200s; max_tokens 32768 不转录(输入=上下文编译+多章/整场 Scene 证据拼接
  // 可能超过 → N27 输入主导豁免) → budgetTokens 0 保持
  structure_analysis: { budgetTokens: 0, temperature: 0.2, timeoutMs: 1_200_000 },
  // catalog §3.5: temp 0.7 / timeout 1800s; 无 max_tokens 行 → budgetTokens 0 保持
  next_chapter_proposal: { budgetTokens: 0, temperature: 0.7, timeoutMs: 1_800_000 },
  // catalog §3.1: temp 0.7 / timeout 1800s; 无 max_tokens 行 → budgetTokens 0 保持
  writing_generate: { budgetTokens: 0, temperature: 0.7, timeoutMs: 1_800_000 },
  // catalog §3.6: temp 0.1 / timeout 120s / budget 2048; budget 不转录(默认召回集输入估算 ≈2625 token > 2048
  // → N27 输入主导豁免; 保持 N24 的 4096 守卫)
  rag_rerank: { budgetTokens: 4096, temperature: 0.1, timeoutMs: 120_000 },
};

describe("spec 注册表 = catalog 转录值(N27 钉死契约)", () => {
  it("BUILTIN_SPECS 每个有 catalog 节的 spec 与转录表逐项一致", () => {
    for (const [specRef, expected] of Object.entries(TRANSCRIBED)) {
      const spec = loadSpec(specRef);
      expect(spec, `spec 未注册: ${specRef}`).toBeDefined();
      expect(
        { budgetTokens: spec!.budgetTokens, temperature: spec!.temperature, timeoutMs: spec!.timeoutMs },
        `${specRef} 漂移(catalog 转录值, N27)`,
      ).toEqual(expected);
    }
  });

  it("转录表覆盖全部 7 个内置 spec(catalog 均有对应节)", () => {
    // 防止新增内置 spec 未进转录表(铁律5 预算/超时纪律)。
    const registered = ["dedup_judge", "entity_extraction", "next_chapter_proposal", "rag_rerank", "semantic_review", "structure_analysis", "writing_generate"];
    expect(Object.keys(TRANSCRIBED).sort()).toEqual(registered.sort());
  });
});
