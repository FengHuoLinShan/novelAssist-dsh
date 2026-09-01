import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider, type Provider } from "@novelcraft/llm-step";
import { chunkChapterText, rebuildRagIndex, type RagChunk } from "@novelcraft/rag";
import { initVault } from "@novelcraft/vault";
import { appendEvent } from "@novelcraft/memory";
import {
  adoptChapterCandidate,
  buildAuditableProposalContext,
  chapterBody,
  contentHashOf,
  executeReviewedChapterCandidateAdopt,
  generateNextChapterFromProposal,
  ingestChapter,
  prepareReviewedChapterCandidateAdopt,
  proposeNextChapterAuditable,
  reviewChapterCandidate,
} from "../src/index.js";

const dirs: string[] = [];
function makeRoot(chapters = 1): string {
  const root = mkdtempSync(join(tmpdir(), "ncw-audit-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  for (let chapter = 1; chapter <= chapters; chapter++) {
    ingestChapter(root, { chapterIndex: chapter, text: `第 ${chapter} 章 KEYSTONE 正文结尾`, source: "paste" });
  }
  return root;
}
afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

const direction = { title: "冻结方向", premise: "沿 KEYSTONE 线索继续", basis: ["历史照应"] };

function seedPovScene(root: string): void {
  const file = join(root, "scenes", "s002.md");
  if (!existsSync(file)) {
    writeFileSync(file, [
      "---", "id: s002", "status: canonical", "title: 第二章", "chapter_ids: [2]",
      "pov_character_id: char-a", "---", "",
    ].join("\n"), "utf8");
  }
}

async function freezeProposal(root: string) {
  seedPovScene(root);
  const result = await proposeNextChapterAuditable(
    new MockProvider({ responses: [{ text: JSON.stringify({ proposals: [direction] }) }] }),
    root,
    1,
    new Date("2026-09-01T00:00:00.000Z"),
  );
  if (!result.proposal) throw new Error("fixture proposal missing");
  return result.proposal;
}

function seedPovKnowledge(root: string): void {
  writeFileSync(join(root, "scenes", "s002.md"), [
    "---", "id: s002", "status: canonical", "title: 第二章", "chapter_ids: [2]",
    "pov_character_id: char-a", "must_not_happen: 不得让角色直接说出密门真相", "---", "",
  ].join("\n"), "utf8");
  appendEvent(root, {
    chapter_index: 1, sequence: 0, event_type: "knowledge_changed", dimension: "knowledge",
    snapshot_after: { character_id: "char-a", fact_id: "weather", state: "known", text: "角色知道北闸会在雨夜关闭" },
    source: "manual_edit",
  });
  appendEvent(root, {
    chapter_index: 1, sequence: 1, event_type: "knowledge_changed", dimension: "knowledge",
    snapshot_after: { character_id: "char-b", fact_id: "other-secret", state: "known", text: "OTHER_CHARACTER_SECRET" },
    source: "manual_edit",
  });
  appendEvent(root, {
    chapter_index: 1, sequence: 2, event_type: "knowledge_changed", dimension: "knowledge",
    snapshot_after: {
      character_id: "char-a", fact_id: "door-truth", state: "excluded",
      exclusion: "不得把密门后的内容写成角色已知", text: "RAW_EXCLUDED_SECRET",
    },
    source: "manual_edit",
  });
  appendEvent(root, {
    chapter_index: 2, sequence: 0, event_type: "knowledge_changed", dimension: "knowledge",
    snapshot_after: { character_id: "char-a", fact_id: "future", state: "known", text: "SAME_CHAPTER_FUTURE_SECRET" },
    source: "manual_edit",
  });
}

describe("auditable writing context (P0-W1)", () => {
  it("POV P3 只给当前角色截止章前已知事实与脱敏 exclusion", () => {
    const root = makeRoot();
    seedPovKnowledge(root);
    const context = buildAuditableProposalContext(root, 1);
    expect(context.rendered_text).toContain("角色知道北闸会在雨夜关闭");
    expect(context.rendered_text).toContain("不得把密门后的内容写成角色已知");
    expect(context.rendered_text).toContain("不得让角色直接说出密门真相");
    expect(context.rendered_text).not.toContain("OTHER_CHARACTER_SECRET");
    expect(context.rendered_text).not.toContain("RAW_EXCLUDED_SECRET");
    expect(context.rendered_text).not.toContain("SAME_CHAPTER_FUTURE_SECRET");
    expect(context.source_manifest).toContainEqual(expect.objectContaining({
      source_id: "pov:char-a:chapter:2", source_type: "pov_knowledge", truncated: false,
    }));
  });

  it("BM25 只纳入 hash 可复核的当前/历史 chapter_text；未来与 stale 均排除", () => {
    const root = makeRoot(2);
    const ch1 = chapterBody(root, 1).body;
    const ch2 = chapterBody(root, 2).body;
    const valid = [
      ...chunkChapterText(ch1, { chapterIndex: 1, contentHash: contentHashOf(ch1) }),
      ...chunkChapterText(ch2, { chapterIndex: 2, contentHash: contentHashOf(ch2) }),
    ];
    const stale: RagChunk = {
      ...valid[0],
      chunk_id: "stale-1",
      text: "KEYSTONE STALE_SHOULD_NOT_ENTER",
      source_content_hash: "0".repeat(64),
    };
    const future: RagChunk = {
      ...valid[0],
      chunk_id: "future-3",
      chapter_index: 3,
      text: "KEYSTONE FUTURE_SHOULD_NOT_ENTER",
      source_content_hash: "1".repeat(64),
    };
    rebuildRagIndex(root, [...valid, stale, future], new Date("2026-09-01T00:00:00.000Z"));

    const context = buildAuditableProposalContext(root, 2);
    expect(context.p4_ranking).toBe("bm25");
    expect(context.rendered_text).toContain("第 1 章 KEYSTONE 正文结尾");
    expect(context.rendered_text).not.toContain("STALE_SHOULD_NOT_ENTER");
    expect(context.rendered_text).not.toContain("FUTURE_SHOULD_NOT_ENTER");
    expect(context.source_manifest.filter((source) => source.source_type === "chapter_text")
      .every((source) => Number(source.open_target?.chapter_index) <= 2)).toBe(true);
    expect(context.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "future_chapter_excluded", "rag_source_stale",
    ]));
  });

  it("无 RAG 索引时确定性降级，仍给出可审计 P0/P1 输入", () => {
    const root = makeRoot();
    const first = buildAuditableProposalContext(root, 1);
    const second = buildAuditableProposalContext(root, 1);
    expect(first.context_hash).toBe(second.context_hash);
    expect(first.rendered_text).toContain("续写提案任务");
    expect(first.warnings).toContainEqual(expect.objectContaining({ code: "rag_index_missing" }));
  });

  it("安全提案保存 actual base、manifest 与确定性 proposal_id", async () => {
    const root = makeRoot();
    const context = buildAuditableProposalContext(root, 1);
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ proposals: [direction] }) }] });
    const result = await proposeNextChapterAuditable(provider, root, 1, new Date("2026-09-01T00:00:00.000Z"));
    const record = result.proposal!;
    expect(record.base_content_hash).toBe(contentHashOf(chapterBody(root, 1).body));
    expect(record.context_hash).toBe(context.context_hash);
    expect(record.source_manifest.length).toBeGreaterThan(0);
    expect(record.proposals[0].proposal_id).toMatch(/^proposal_[0-9a-f]{20}$/);
    expect(provider.calls[0].messages[1].content).toBe(context.rendered_text);
  });

  it("同 run 重试 provider 前拒绝覆盖旧回执", async () => {
    const root = makeRoot();
    const now = new Date("2026-09-01T00:00:00.000Z");
    const firstProvider = new MockProvider({ responses: [{ text: JSON.stringify({ proposals: [direction] }) }] });
    const first = await proposeNextChapterAuditable(firstProvider, root, 1, now);
    const file = join(root, ".assistant", "proposals", `next-001-${first.proposal!.run_id}.json`);
    const before = readFileSync(file, "utf8");
    const second = new MockProvider({ responses: [] });
    await expect(proposeNextChapterAuditable(second, root, 1, now)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(second.calls).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("provider 期间仅 warnings 漂移也拒绝落盘(RV-11)", async () => {
    const root = makeRoot();
    rebuildRagIndex(root, [], new Date("2026-09-01T00:00:00.000Z"));
    const base = new MockProvider({ responses: [{ text: JSON.stringify({ proposals: [direction] }) }] });
    const racing: Provider = {
      async complete(request) {
        const response = await base.complete(request);
        unlinkSync(join(root, ".assistant", "rag-index.json"));
        return response;
      },
    };

    await expect(proposeNextChapterAuditable(
      racing,
      root,
      1,
      new Date("2026-09-01T00:00:00.000Z"),
    )).rejects.toMatchObject({ code: "CONFLICT" });
    const proposals = join(root, ".assistant", "proposals");
    expect(existsSync(proposals) ? readdirSync(proposals).filter((name) => name.startsWith("next-001-")) : []).toEqual([]);
  });
});

describe("frozen proposal generation and adoption (P0-W1)", () => {
  it.each(["missing", "ambiguous"] as const)("安全生成遇到 %s POV 时 provider=0 且零候选", async (variant) => {
    const root = makeRoot();
    if (variant === "ambiguous") {
      for (const [slug, pov] of [["s-a", "char-a"], ["s-b", "char-b"]] as const) {
        writeFileSync(join(root, "scenes", `${slug}.md`), [
          "---", `id: ${slug}`, "status: canonical", `title: ${slug}`, "chapter_ids: [2]",
          `pov_character_id: ${pov}`, "---", "",
        ].join("\n"), "utf8");
      }
    }
    const proposal = await proposeNextChapterAuditable(
      new MockProvider({ responses: [{ text: JSON.stringify({ proposals: [direction] }) }] }),
      root, 1, new Date("2026-09-01T00:02:00.000Z"),
    );
    const provider = new MockProvider({ responses: [] });
    await expect(generateNextChapterFromProposal(provider, root, {
      runId: proposal.proposal!.run_id,
      proposalId: proposal.proposal!.proposals[0].proposal_id,
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(provider.calls).toEqual([]);
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(false);
  });

  it("同模型生成与独立审查是两次 run，审查复用同一脱敏 POV 边界并落 receipt", async () => {
    const root = makeRoot();
    seedPovKnowledge(root);
    const record = await freezeProposal(root);
    const provider = new MockProvider({ responses: [
      { text: "第二章候选" },
      { text: JSON.stringify({ findings: [], verdict: "pass" }) },
    ] });
    await generateNextChapterFromProposal(provider, root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    });
    const reviewed = await reviewChapterCandidate(provider, root, 2, "002", new Date("2026-09-01T00:01:00.000Z"));
    expect(reviewed.review?.verdict).toBe("pass");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].messages[1].content).toContain("角色知道北闸");
    expect(provider.calls[1].messages[1].content).toContain("第二章候选");
    expect(provider.calls[1].messages[1].content).toContain("角色知道北闸");
    expect(provider.calls[1].messages[1].content).not.toContain("OTHER_CHARACTER_SECRET");
    expect(reviewed.review?.pov_context_receipt?.source_manifest).toContainEqual(expect.objectContaining({
      source_type: "pov_knowledge", truncated: false,
    }));
  });

  it("独立审查 provider 期间 POV/知识漂移 → 审查回执零落盘", async () => {
    const root = makeRoot();
    seedPovKnowledge(root);
    const record = await freezeProposal(root);
    await generateNextChapterFromProposal(new MockProvider({ responses: [{ text: "第二章候选" }] }), root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    });
    const base = new MockProvider({ responses: [{ text: JSON.stringify({ findings: [], verdict: "pass" }) }] });
    const racing: Provider = {
      async complete(request) {
        const response = await base.complete(request);
        appendEvent(root, {
          chapter_index: 1, sequence: 3, event_type: "knowledge_changed", dimension: "knowledge",
          snapshot_after: { character_id: "char-a", fact_id: "late", state: "known", text: "调用期间新知识" },
          source: "manual_edit",
        });
        return response;
      },
    };
    await expect(reviewChapterCandidate(racing, root, 2, "002")).rejects.toMatchObject({ code: "CONFLICT" });
    const reviewDir = join(root, ".assistant", "reviews");
    expect(existsSync(reviewDir) ? (await import("node:fs")).readdirSync(reviewDir) : []).toEqual([]);
  });

  it("安全候选在审查前丢失 POV Scene → provider=0 且候选保持 pending", async () => {
    const root = makeRoot();
    const record = await freezeProposal(root);
    await generateNextChapterFromProposal(new MockProvider({ responses: [{ text: "第二章候选" }] }), root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    });
    rmSync(join(root, "scenes", "s002.md"));
    const provider = new MockProvider({ responses: [] });
    await expect(reviewChapterCandidate(provider, root, 2, "002")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(provider.calls).toEqual([]);
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(true);
  });

  it("独立审查后知识漂移 → adopt prepare 保持 pending 且零正文写", async () => {
    const root = makeRoot();
    seedPovKnowledge(root);
    const record = await freezeProposal(root);
    await generateNextChapterFromProposal(new MockProvider({ responses: [{ text: "第二章候选" }] }), root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    });
    await reviewChapterCandidate(
      new MockProvider({ responses: [{ text: JSON.stringify({ findings: [], verdict: "pass" }) }] }),
      root, 2, "002",
    );
    appendEvent(root, {
      chapter_index: 1, sequence: 3, event_type: "knowledge_changed", dimension: "knowledge",
      snapshot_after: { character_id: "char-a", fact_id: "late", state: "known", text: "审查后新知识" },
      source: "manual_edit",
    });
    expect(() => prepareReviewedChapterCandidateAdopt(root, "002")).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(true);
    expect(existsSync(join(root, "chapters", "002.md"))).toBe(false);
  });

  it("安全生成只消费 run_id/proposal_id；调用方伪造 title/premise 不进入输入", async () => {
    const root = makeRoot();
    const record = await freezeProposal(root);
    const selected = record.proposals[0];
    const provider = new MockProvider({ responses: [{ text: "第二章候选" }] });
    const result = await generateNextChapterFromProposal(provider, root, {
      runId: record.run_id,
      proposalId: selected.proposal_id,
      proposalTitle: "FORGED_TITLE",
      premise: "FORGED_PREMISE",
    } as never);
    expect(result.ok).toBe(true);
    expect(provider.calls[0].messages[1].content).toContain("冻结方向");
    expect(provider.calls[0].messages[1].content).not.toContain("FORGED_TITLE");
    const raw = readFileSync(join(root, "chapters", "pending", "002.md"), "utf8");
    expect(raw).toContain(`proposal_run_id: ${JSON.stringify(record.run_id)}`);
    expect(raw).toContain(`proposal_id: ${JSON.stringify(selected.proposal_id)}`);
    expect(raw).toMatch(/context_hash: [0-9a-f]{64}/);
  });

  it("provider 前来源漂移 → 零调用、零候选", async () => {
    const root = makeRoot();
    const record = await freezeProposal(root);
    const chapter = join(root, "chapters", "001.md");
    writeFileSync(chapter, readFileSync(chapter, "utf8") + "\n调用前漂移\n");
    const provider = new MockProvider({ responses: [] });
    await expect(generateNextChapterFromProposal(provider, root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.calls).toEqual([]);
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(false);
  });

  it("冻结回执 manifest/warnings 被改写 → provider 前拒绝", async () => {
    const root = makeRoot();
    const record = await freezeProposal(root);
    const file = join(root, ".assistant", "proposals", `next-001-${record.run_id}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8")) as typeof record;
    stored.warnings = [{ code: "rag_no_match", message: "FORGED" }];
    writeFileSync(file, JSON.stringify(stored, null, 2) + "\n", "utf8");
    const provider = new MockProvider({ responses: [] });
    await expect(generateNextChapterFromProposal(provider, root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.calls).toEqual([]);
  });

  it("provider 后来源漂移 → 候选落盘前拒绝", async () => {
    const root = makeRoot();
    const record = await freezeProposal(root);
    const base = new MockProvider({ responses: [{ text: "第二章候选" }] });
    const racing: Provider = {
      async complete(request) {
        const response = await base.complete(request);
        const chapter = join(root, "chapters", "001.md");
        writeFileSync(chapter, readFileSync(chapter, "utf8") + "\n调用后漂移\n");
        return response;
      },
    };
    await expect(generateNextChapterFromProposal(racing, root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(false);
  });

  it("采用前来源漂移 → 保持 pending，正文零写", async () => {
    const root = makeRoot();
    const record = await freezeProposal(root);
    await generateNextChapterFromProposal(new MockProvider({ responses: [{ text: "第二章候选" }] }), root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    });
    const chapter = join(root, "chapters", "001.md");
    writeFileSync(chapter, readFileSync(chapter, "utf8") + "\n采用前漂移\n");
    await expect(adoptChapterCandidate(root)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(true);
    expect(existsSync(join(root, "chapters", "002.md"))).toBe(false);
  });

  it("审批准备后、执行前来源漂移 → 事务 validate 再次拒绝", async () => {
    const root = makeRoot();
    const record = await freezeProposal(root);
    await generateNextChapterFromProposal(new MockProvider({ responses: [{ text: "第二章候选" }] }), root, {
      runId: record.run_id,
      proposalId: record.proposals[0].proposal_id,
    });
    await reviewChapterCandidate(
      new MockProvider({ responses: [{ text: JSON.stringify({ findings: [], verdict: "pass" }) }] }),
      root,
      2,
      "002",
    );
    const prepared = prepareReviewedChapterCandidateAdopt(root, "002");
    const chapter = join(root, "chapters", "001.md");
    writeFileSync(chapter, readFileSync(chapter, "utf8") + "\n审批窗口漂移\n");
    await expect(executeReviewedChapterCandidateAdopt(prepared)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(true);
    expect(existsSync(join(root, "chapters", "002.md"))).toBe(false);
  });
});
