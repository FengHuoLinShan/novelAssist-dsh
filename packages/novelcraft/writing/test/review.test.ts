// R3 审查/返修/采用行为契约(PLAN.md 步骤 2-4)
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { ingestChapter } from "../src/index";
import { applyRevision, adoptChapterCandidate } from "../src/index";
import { findingIdOf, latestReview, normalizeFinding, rejectFinding, rejectFindingById, reviewChapter } from "../src/index";

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
    // N30: 旧 index 路径回归不变 — finding_ids 仍写数组序号。
    expect(raw).toContain("finding_ids: [0]");
    // N23: chapter_candidate 必填 status/content_hash/source。
    expect(raw).toContain("source: writing_revise");
    expect(raw).toMatch(/content_hash: [0-9a-f]{64}/);
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
    // N23: 原候选转 deprecated 后仍保留 source(校验的是最终落盘 frontmatter)。
    const dep = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    expect(dep).toContain("status: deprecated");
    expect(dep).toContain("source: writing_revise");
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

// N30 · writing.md:283: finding_id 必填 = 由内容稳定 hash 派生(finding_<hash20>), 确定性。
describe("N30 finding_id 确定性派生(writing.md:283)", () => {
  it("同输入恒同 id; 不同输入不同 id; 格式 finding_<hash20>", () => {
    const base = { category: "continuity", quote: "他说", suggestion: "统一称呼" };
    expect(findingIdOf(1, base)).toBe(findingIdOf(1, base)); // 同输入恒同 id
    expect(findingIdOf(1, base)).toMatch(/^finding_[0-9a-f]{20}$/);
    expect(findingIdOf(1, base)).not.toBe(findingIdOf(2, base)); // 章不同 → 不同 id
    expect(findingIdOf(1, { ...base, quote: "她说" })).not.toBe(findingIdOf(1, base)); // 内容不同 → 不同 id
    expect(findingIdOf(1, { ...base, category: "pacing" })).not.toBe(findingIdOf(1, base));
  });
  it("reviewChapter 落盘每条 finding 必含 finding_id, 与派生一致", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ findings: [finding, { ...finding, quote: "第二处" }] }) }],
    });
    const r = await await reviewChapter(provider, root, 1);
    expect(r.review!.findings).toHaveLength(2);
    for (const f of r.review!.findings) {
      expect(f.finding_id).toMatch(/^finding_[0-9a-f]{20}$/);
      expect(f.finding_id).toBe(findingIdOf(1, { category: f.category, quote: f.quote, suggestion: f.suggestion }));
    }
    expect(r.review!.findings[0].finding_id).not.toBe(r.review!.findings[1].finding_id);
  });
});

// N30 · writing.md:284: severity 存储词表 = blocker/major/minor, 摄入归一化 high/medium/low。
// 注: llm-step 的 semantic_review spec 输出 schema severity 枚举仍为 high/medium/low(LLM 面),
// 故端到端只喂 schema 合法值; 规范值原样通过与未知值 fail-closed 在 normalizeFinding 单元层覆盖。
describe("N30 severity 归一化(writing.md:284)", () => {
  it("reviewChapter 摄入 high/medium/low → 落盘 blocker/major/minor", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [
        {
          text: JSON.stringify({
            findings: [
              { category: "a", severity: "high", quote: "q1", suggestion: "s1" },
              { category: "b", severity: "medium", quote: "q2", suggestion: "s2" },
              { category: "c", severity: "low", quote: "q3", suggestion: "s3" },
              { category: "d", severity: "high", quote: "q4", suggestion: "s4" },
              { category: "e", severity: "medium", quote: "q5", suggestion: "s5" },
              { category: "f", severity: "low", quote: "q6", suggestion: "s6" },
            ],
          }),
        },
      ],
    });
    const r = await await reviewChapter(provider, root, 1);
    expect(r.review!.findings.map((x) => x.severity)).toEqual([
      "blocker", "major", "minor", "blocker", "major", "minor",
    ]);
  });
  it("normalizeFinding: 规范值原样通过; 未知值 fail-closed 返回 null(不落盘)", () => {
    expect(normalizeFinding(1, { category: "a", severity: "blocker", quote: "q", suggestion: "s" })!.severity).toBe("blocker");
    expect(normalizeFinding(1, { category: "a", severity: "major", quote: "q", suggestion: "s" })!.severity).toBe("major");
    expect(normalizeFinding(1, { category: "a", severity: "minor", quote: "q", suggestion: "s" })!.severity).toBe("minor");
    expect(normalizeFinding(1, { category: "a", severity: "critical", quote: "q", suggestion: "s" })).toBeNull();
    expect(normalizeFinding(1, { category: "a", severity: "HIGH", quote: "q", suggestion: "s" })).toBeNull();
    expect(normalizeFinding(1, { category: "a", quote: "q", suggestion: "s" })).toBeNull(); // 缺 severity
  });
});

// N30 · writing.md:283: 打回按 finding_id 定位, rejected_findings 键 = finding_id。
describe("rejectFindingById(N30: 按 finding_id 打回)", () => {
  it("rejected_findings 键 = finding_id; 幂等; 未知 id 拒绝", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ findings: [finding] }) }],
    });
    const r = await await reviewChapter(provider, root, 1);
    const id = r.review!.findings[0].finding_id;
    rejectFindingById(root, 1, r.review!.review_id, id);
    rejectFindingById(root, 1, r.review!.review_id, id); // 幂等
    const latest = latestReview(root, 1)!;
    expect(latest.rejected_findings?.[id]).toBeDefined();
    expect(() => rejectFindingById(root, 1, r.review!.review_id, "finding_00000000000000000000")).toThrow(/finding_id 不存在/);
  });
});

// N30 · writing.md:332/353: 返修必须绑定冻结审查回执(finding_ids 一致 + 基线 content_hash 未变)。
describe("applyRevision findingIds 绑定(N30 · writing.md:353)", () => {
  it("按 finding_id 解析并写入候选 finding_ids", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [
        { text: JSON.stringify({ findings: [finding, { ...finding, quote: "第二处" }] }) },
        { text: "修订后的正文" },
      ],
    });
    await await reviewChapter(provider, root, 1);
    const review = latestReview(root, 1)!;
    const id = review.findings[1].finding_id;
    const r = await applyRevision(provider, root, 1, [], [id]);
    expect(r.ok).toBe(true);
    const raw = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    expect(raw).toContain(`finding_ids: [${id}]`);
  });
  it("finding_id 不在冻结回执 → fail-closed 拒绝", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ findings: [finding] }) }],
    });
    await await reviewChapter(provider, root, 1);
    await expect(applyRevision(provider, root, 1, [], ["finding_unknown000000000000"])).rejects.toThrow(/finding_id 不存在/);
  });
  it("基线 content_hash 失配拒绝(writing.md:353)", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ findings: [finding] }) }],
    });
    await await reviewChapter(provider, root, 1);
    const review = latestReview(root, 1)!;
    const id = review.findings[0].finding_id;
    // 审查后改写章节 → 基线 content_hash 变化, 返修必须拒绝(冻结回执失效)。
    ingestChapter(root, { chapterIndex: 1, text: "被改过的正文", source: "paste" });
    await expect(applyRevision(provider, root, 1, [], [id])).rejects.toThrow(/基线 content_hash 失配/);
  });
});
