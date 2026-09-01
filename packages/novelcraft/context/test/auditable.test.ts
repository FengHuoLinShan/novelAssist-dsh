import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileAuditableContext, estimateContextTokens } from "../src/index";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const sources = [
  {
    tier: "P0" as const,
    name: "任务",
    content: "续写第三章，保持人物知识边界。",
    source_id: "task",
    source_type: "instruction",
    source_status: "confirmed",
    open_target: { kind: "task" },
  },
  {
    tier: "P1" as const,
    name: "当前章",
    content: "章节正文。".repeat(300),
    source_id: "chapter-003",
    source_type: "chapter_text",
    source_status: "canonical",
    open_target: { kind: "chapter", index: 3 },
  },
  {
    tier: "P4" as const,
    name: "检索片段",
    content: "低优先资料。".repeat(100),
    source_id: "rag-1",
    source_type: "rag_chunk",
  },
];

describe("compileAuditableContext(P0-C1)", () => {
  it("唯一 rendered_text 严格满足估算器硬上限，manifest 只含实际片段", () => {
    const result = compileAuditableContext(
      { task: "续写", scope: "chapter", budget_tokens: 90 },
      { sources },
    );
    expect(result.total_tokens).toBe(estimateContextTokens(result.rendered_text));
    expect(result.total_tokens).toBeLessThanOrEqual(90);
    expect(result.source_manifest.map((source) => source.source_id)).not.toContain("rag-1");
    expect(result.omitted_source_ids).toContain("rag-1");
    for (const item of result.source_manifest) {
      const original = sources.find((source) => source.source_id === item.source_id)?.content ?? "";
      const included = original.slice(item.included_range.start, item.included_range.end);
      expect(item.source_hash).toBe(hash(original));
      expect(item.included_content_hash).toBe(hash(included));
      expect(result.rendered_text).toContain(included);
    }
    for (const budget_tokens of [1, 8, 31, 64, 89]) {
      const bounded = compileAuditableContext(
        { task: "续写", scope: "chapter", budget_tokens },
        { sources },
      );
      expect(bounded.total_tokens).toBeLessThanOrEqual(budget_tokens);
    }
  });

  it("截断前后双 hash/range 可复核，同内容的 source_hash 相同", () => {
    const result = compileAuditableContext(
      { task: "续写", scope: "chapter", budget_tokens: 90 },
      { sources },
    );
    const chapter = result.source_manifest.find((source) => source.source_id === "chapter-003");
    expect(chapter?.truncated).toBe(true);
    expect(chapter?.included_range.end).toBeLessThan(sources[1].content.length);
    expect(chapter?.included_content_hash).not.toBe(chapter?.source_hash);

    const same = compileAuditableContext(
      { task: "x", scope: "chapter", budget_tokens: 100 },
      { sources: [
        { tier: "P1", name: "A", content: "同一内容", source_id: "a", source_type: "chapter_text" },
        { tier: "P1", name: "B", content: "同一内容", source_id: "b", source_type: "chapter_text" },
      ] },
    );
    expect(same.source_manifest[0].source_hash).toBe(same.source_manifest[1].source_hash);
  });

  it("相同输入 hash 确定；任一来源变化（包括被遗漏来源）都改变 context_hash", () => {
    const opts = { task: "续写", scope: "chapter" as const, budget_tokens: 90 };
    const a = compileAuditableContext(opts, { sources });
    const b = compileAuditableContext(opts, { sources: sources.map((source) => source.source_id === "chapter-003"
      ? { ...source, open_target: { index: 3, kind: "chapter" } }
      : { ...source }) });
    expect(a.context_hash).toBe(b.context_hash);
    expect(a.context_hash).toMatch(/^[0-9a-f]{64}$/);
    const changed = sources.map((source) => source.source_id === "rag-1"
      ? { ...source, content: `${source.content}变化` }
      : source);
    expect(compileAuditableContext(opts, { sources: changed }).context_hash).not.toBe(a.context_hash);
    const movedTarget = sources.map((source) => source.source_id === "chapter-003"
      ? { ...source, open_target: { kind: "chapter", index: 4 } }
      : source);
    expect(compileAuditableContext(opts, { sources: movedTarget }).context_hash).not.toBe(a.context_hash);
  });

  it("selected_asset_ids 只投影存活来源；重复 id/空资料 fail-closed", () => {
    const result = compileAuditableContext(
      { task: "续写", scope: "chapter", budget_tokens: 90 },
      { sources },
    );
    expect(result.selected_asset_ids.chapter_text).toEqual(["chapter-003"]);
    expect(result.selected_asset_ids.rag_chunk).toBeUndefined();
    expect(() => compileAuditableContext(
      { task: "x", scope: "chapter" },
      { sources: [sources[0], { ...sources[1], source_id: "task" }] },
    )).toThrow(/source_id 重复/);
    expect(() => compileAuditableContext(
      { task: "x", scope: "chapter" },
      { sources: [{ ...sources[0], content: "  " }] },
    )).toThrow(/content 为空/);
  });

  it("task/scope/budget/source 元数据均进 hash；特殊 source_type 不破坏 selected ids", () => {
    const base = compileAuditableContext(
      { task: "续写", scope: "chapter", budget_tokens: 100 },
      { sources: [{ tier: "P1", name: "A", content: "正文", source_id: "a", source_type: "__proto__" }] },
    );
    expect(base.selected_asset_ids.__proto__).toEqual(["a"]);
    const variants = [
      compileAuditableContext({ task: "审稿", scope: "chapter", budget_tokens: 100 }, { sources: [{ tier: "P1", name: "A", content: "正文", source_id: "a", source_type: "__proto__" }] }),
      compileAuditableContext({ task: "续写", scope: "arc", budget_tokens: 100 }, { sources: [{ tier: "P1", name: "A", content: "正文", source_id: "a", source_type: "__proto__" }] }),
      compileAuditableContext({ task: "续写", scope: "chapter", budget_tokens: 99 }, { sources: [{ tier: "P1", name: "A", content: "正文", source_id: "a", source_type: "__proto__" }] }),
      compileAuditableContext({ task: "续写", scope: "chapter", budget_tokens: 100 }, { sources: [{ tier: "P2", name: "A", content: "正文", source_id: "a", source_type: "__proto__" }] }),
      compileAuditableContext({ task: "续写", scope: "chapter", budget_tokens: 100 }, { sources: [{ tier: "P1", name: "B", content: "正文", source_id: "a", source_type: "__proto__" }] }),
    ];
    for (const variant of variants) expect(variant.context_hash).not.toBe(base.context_hash);
  });

  it("Unicode 输入 fail-closed，合法 emoji 截断不拆 surrogate pair", () => {
    const emojiSource = { tier: "P1" as const, name: "emoji", content: "😀".repeat(40), source_id: "emoji", source_type: "note" };
    for (let budget_tokens = 1; budget_tokens <= 40; budget_tokens++) {
      const result = compileAuditableContext({ task: "x", scope: "chapter", budget_tokens }, { sources: [emojiSource] });
      const end = result.source_manifest[0]?.included_range.end;
      if (end !== undefined) {
        const last = emojiSource.content.charCodeAt(end - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
      expect(result.total_tokens).toBeLessThanOrEqual(budget_tokens);
    }
    expect(() => compileAuditableContext(
      { task: "x", scope: "chapter" },
      { sources: [{ ...emojiSource, content: "\ud800" }] },
    )).toThrow(/Unicode/);
    expect(() => compileAuditableContext(
      { task: "x", scope: "chapter" },
      { sources: [{ ...emojiSource, open_target: { n: Number.NaN } }] },
    )).toThrow(/open_target/);
  });
});
