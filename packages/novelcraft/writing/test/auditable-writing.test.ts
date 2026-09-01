import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider, type Provider } from "@novelcraft/llm-step";
import { chunkChapterText, rebuildRagIndex, type RagChunk } from "@novelcraft/rag";
import { initVault } from "@novelcraft/vault";
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

async function freezeProposal(root: string) {
  const result = await proposeNextChapterAuditable(
    new MockProvider({ responses: [{ text: JSON.stringify({ proposals: [direction] }) }] }),
    root,
    1,
    new Date("2026-09-01T00:00:00.000Z"),
  );
  if (!result.proposal) throw new Error("fixture proposal missing");
  return result.proposal;
}

describe("auditable writing context (P0-W1)", () => {
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
});

describe("frozen proposal generation and adoption (P0-W1)", () => {
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
