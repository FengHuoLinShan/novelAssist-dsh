// context 行为契约(small-modules §4 + N4)
import { afterEach, describe, expect, it } from "vitest";
import { compileContext, CONTEXT_BUDGET_DEFAULT, contextSummary, estimateContextTokens } from "../src/index";

afterEach(() => {});

const input = {
  sections: [
    { tier: "P0" as const, name: "task", content: "写第 3 章" },
    { tier: "P1" as const, name: "chapter", content: "第 3 章正文。".repeat(50) },
    { tier: "P3" as const, name: "world", content: "世界设定。".repeat(200) },
    { tier: "P4" as const, name: "rag", content: "检索片段。".repeat(200) },
  ],
};

describe("compileContext(Tier P0–P4 预算淘汰)", () => {
  it("小预算: P0/P1 装入, P3/P4 被截断或驱逐, 事件完整", () => {
    const c = compileContext({ task: "写第 3 章", scope: "chapter", budget_tokens: 80 }, input);
    expect(c.sections.some((s) => s.tier === "P0")).toBe(true);
    const events = new Set(c.budget_events.map((e) => e.action));
    expect([...events].some((a) => a === "evict" || a === "truncate")).toBe(true);
    expect(c.total_tokens).toBeLessThanOrEqual(80 + 64);
    expect(c.confirmation.warnings.length).toBeGreaterThan(0);
  });
  it("默认预算(CONTEXT_BUDGET 内置, N4)", () => {
    const c = compileContext({ task: "t", scope: "world" }, input);
    expect(c.budget_tokens).toBe(CONTEXT_BUDGET_DEFAULT);
  });
  it("task 缺失拒绝", () => {
    expect(() => compileContext({ task: "", scope: "world" }, input)).toThrow(/task/);
  });
});

describe("contextSummary(作者语言)", () => {
  it("不暴露 raw JSON, 含 token 与驱逐提示", () => {
    const c = compileContext({ task: "t", scope: "world", budget_tokens: 60 }, input);
    const s = contextSummary(c);
    expect(s).toContain("tokens");
    expect(s).not.toContain("{");
  });
});

describe("estimateContextTokens(启发式)", () => {
  it("CJK/1.6", () => {
    expect(estimateContextTokens("诡秘之主")).toBe(Math.ceil(4 / 1.6));
  });
});
