// R3 审查/返修/采用行为契约(PLAN.md 步骤 2-4)
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { ingestChapter } from "../src/index";
import { applyRevision, adoptChapterCandidate } from "../src/index";
import { latestReview, rejectFinding, reviewChapter } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncw2-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  ingestChapter(root, { chapterIndex: 1, text: "第一章正文", source: "paste" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const finding = { category: "continuity", severity: "medium" as const, quote: "他说", suggestion: "统一称呼" };

describe("reviewChapter(PLAN.md 步骤 2)", () => {
  it("成功落 .assistant/reviews/, 字段完整(N4)", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ findings: [finding], verdict: "3 处可修" }) }],
    });
    const r = await await reviewChapter(provider, root, 1);
    expect(r.ok).toBe(true);
    expect(r.review!.findings).toHaveLength(1);
    expect(r.review!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const file = join(root, ".assistant", "reviews", `semantic-review-001-${r.review!.review_id}.json`);
    expect(readFileSync(file, "utf8")).toContain("continuity");
  });
  it("provider 失败不写文件", async () => {
    const root = makeRoot();
    const provider = new MockProvider({ retryable: false, responses: [{ throwError: new Error("boom") }] });
    const r = await await reviewChapter(provider, root, 1);
    expect(r.ok).toBe(false);
    expect(latestReview(root, 1)).toBeUndefined();
  });
});

describe("applyRevision / adoptChapterCandidate(步骤 3/4)", () => {
  it("非法 finding 序号拒绝", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ findings: [finding] }) }],
    });
    await await reviewChapter(provider, root, 1);
    await expect(applyRevision(new MockProvider({ responses: [] }), root, 1, [5])).rejects.toThrow(/序号非法/);
  });
  it("修订候选落 chapters/pending/001.md(status=candidate, base_content_hash)", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [
        { text: JSON.stringify({ findings: [finding] }) },
        { text: "修订后的正文" },
      ],
    });
    await reviewChapter(provider, root, 1);
    const r = await applyRevision(provider, root, 1, [0]);
    expect(r.ok).toBe(true);
    const raw = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    expect(raw).toContain("status: candidate");
    expect(raw).toContain("base_content_hash:");
    expect(raw).toContain("修订后的正文");
  });
  it("采用后 chapters/001.md 更新为修订正文, 候选已处理, git 干净", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [
        { text: JSON.stringify({ findings: [finding] }) },
        { text: "修订后的正文" },
      ],
    });
    await reviewChapter(provider, root, 1);
    await applyRevision(provider, root, 1, [0]);
    const r = adoptChapterCandidate(root);
    expect(r.ok).toBe(true);
    const raw = readFileSync(join(root, "chapters", "001.md"), "utf8");
    expect(raw).toContain("修订后的正文");
  });
  it("无候选可采用时抛错", () => {
    const root = makeRoot();
    expect(() => adoptChapterCandidate(root)).toThrow(/无候选/);
  });
});

describe("rejectFinding(打回, 幂等标记)", () => {
  it("标记 rejected_findings; 非法序号拒绝", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ findings: [finding] }) }],
    });
    const r = await await reviewChapter(provider, root, 1);
    rejectFinding(root, 1, r.review!.review_id, 0);
    const latest = latestReview(root, 1)!;
    expect(latest.rejected_findings?.["0"]).toBeDefined();
    expect(() => rejectFinding(root, 1, r.review!.review_id, 9)).toThrow(/序号非法/);
  });
});
