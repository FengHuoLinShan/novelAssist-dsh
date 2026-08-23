// R3 审查/返修/采用行为契约(PLAN.md 步骤 2-4)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, gitLogSubjects, gitStatusEntries, relOf } from "@novelcraft/store";
import { ingestChapter, contentHashOf, normalizeChapterText } from "../src/index";
import { applyRevision, adoptChapterCandidate, generateNextChapter } from "../src/index";
import {
  applyReviewedRevision,
  executeReviewedChapterCandidateAdopt,
  findingIdOf,
  latestReview,
  normalizeFinding,
  prepareReviewedChapterCandidateAdopt,
  rejectFinding,
  rejectFindingById,
  reviewChapter,
  reviewChapterCandidate,
  reviewCurrentChapter,
} from "../src/index";

const dirs: string[] = [];
function makeRootWithText(text: string) {
  const root = mkdtempSync(join(tmpdir(), "ncw2-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  ingestChapter(root, { chapterIndex: 1, text, source: "paste" });
  return root;
}
function makeRoot() {
  return makeRootWithText("第一章正文");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const finding = { category: "continuity", severity: "medium" as const, quote: "他说", suggestion: "统一称呼" };

// N32/ADR-0021 目标路径级语义: applyRevision 的 commit 只精确包含本次修订新写出的
// 候选文件(绝不 -A), 审查回执(reviewChapter 工件)与章节正文(ingest 工件)不被动卷入;
// 真实流程中各步骤自身的精确 commit 承接, 迁移期由 fixture 显式精确提交审查基线,
// 使采用门禁(R17 全工作区洁净)前工作区干净。
function commitReviewBaseline(root: string, chapterIndex: number): void {
  const review = latestReview(root, chapterIndex)!;
  gitAdd(root, [
    `chapters/${String(chapterIndex).padStart(3, "0")}.md`,
    relOf(root, paths(root).assistant.reviewFile(`semantic-review-${String(chapterIndex).padStart(3, "0")}-${review.review_id}`)),
  ]);
  gitCommit(root, `review baseline ch${chapterIndex}`);
}

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

describe("public current/candidate review gate (§6.16)", () => {
  it("strict current review 可按 finding id 返修；candidate 未独立 pass 不能采用", async () => {
    const root = makeRoot();
    gitAdd(root, ["chapters/001.md"]);
    gitCommit(root, "chapter baseline");
    const currentReview = await reviewCurrentChapter(new MockProvider({ responses: [{
      text: JSON.stringify({ findings: [{ ...finding, quote: "第一章正文" }], verdict: "随意文本" }),
    }] }), root, 1);
    expect(currentReview.review).toMatchObject({ target_kind: "current", verdict: "blocked" });
    const findingId = currentReview.review!.findings[0].finding_id;
    const revised = await applyReviewedRevision(
      new MockProvider({ responses: [{ text: "修订后的正文" }] }), root, 1, [findingId],
    );
    expect(revised.ok).toBe(true);
    expect(() => prepareReviewedChapterCandidateAdopt(root, "001")).toThrow(/独立审查 pass/);
  });

  it("candidate review 只以可定位 finding + 受控 severity 机械裁定；fresh pass 后采用", async () => {
    const root = makeRoot();
    gitAdd(root, ["chapters/001.md"]);
    gitCommit(root, "chapter baseline");
    await generateNextChapter(new MockProvider({ responses: [{ text: "第二章正文候选" }] }), root, 1, {
      proposalTitle: "方向",
    });
    const reviewed = await reviewChapterCandidate(
      new MockProvider({ responses: [{ text: JSON.stringify({ findings: [], verdict: "模型说不通过也不作数" }) }] }),
      root, 2, "002",
    );
    expect(reviewed.review).toMatchObject({ target_kind: "candidate", verdict: "pass", discarded_finding_count: 0 });
    const result = await executeReviewedChapterCandidateAdopt(prepareReviewedChapterCandidateAdopt(root, "002"));
    expect(result.targetRelPath).toBe("chapters/002.md");
    expect(readFileSync(join(root, "chapters", "002.md"), "utf8")).toContain("第二章正文候选");
  });

  it("作者已打回的 finding 不得再进入公开返修", async () => {
    const root = makeRoot();
    gitAdd(root, ["chapters/001.md"]);
    gitCommit(root, "chapter baseline");
    const reviewed = await reviewCurrentChapter(new MockProvider({ responses: [{
      text: JSON.stringify({ findings: [{ ...finding, quote: "第一章正文" }] }),
    }] }), root, 1);
    const id = reviewed.review!.findings[0].finding_id;
    rejectFindingById(root, 1, reviewed.review!.review_id, id, "这里是有意伏笔");
    await expect(applyReviewedRevision(new MockProvider({ responses: [] }), root, 1, [id])).rejects.toThrow(/已被作者打回/);
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
    commitReviewBaseline(root, 1); // N32: 回执是审查步骤工件, 修订 commit 不再 -A 扫入。
    await applyRevision(provider, root, 1, [0]);
    const r = await adoptChapterCandidate(root);
    expect(r.ok).toBe(true);
    const raw = readFileSync(join(root, "chapters", "001.md"), "utf8");
    expect(raw).toContain("修订后的正文");
    // N23: 原候选转 deprecated 后仍保留 source(校验的是最终落盘 frontmatter)。
    const dep = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    expect(dep).toContain("status: deprecated");
    expect(dep).toContain("source: writing_revise");
  });
  it("无候选可采用时抛错", async () => {
    const root = makeRoot();
    await expect(adoptChapterCandidate(root)).rejects.toThrow(/无候选/);
  });
});

// N32/ADR-0021 目标路径级写事务: applyRevision 的 git add 必须用完整精确的相对 POSIX
// pathspec(relOf 保证 '/' 分隔), 绝不 -A —— 只 stage 本次修订新写出的候选文件,
// 用户无关的暂存/未暂存/未跟踪改动一律不被动卷入本 commit(与 generateNextChapter 同款)。
describe("applyRevision git 精确暂存(N32: 完整相对 POSIX pathspec, 绝不 -A)", () => {
  it("本次 commit 的树精确 = 仅候选文件; 用户无关改动原样保留", async () => {
    const root = makeRoot();
    gitAdd(root); gitCommit(root, "fixture init"); // 基线 commit: chapters/001.md 成为 tracked
    // 用户无关改动: 已跟踪章节追加内容(未暂存) + 未跟踪草稿文件(未添加)。
    const ch1 = join(root, "chapters", "001.md");
    writeFileSync(ch1, readFileSync(ch1, "utf8") + "\n用户备注\n", "utf8");
    writeFileSync(join(root, "notes.md"), "用户草稿", "utf8");
    await reviewChapter(new MockProvider({ responses: [{ text: JSON.stringify({ findings: [finding] }) }] }), root, 1);
    const commitsBefore = gitLogSubjects(root).length;
    const r = await applyRevision(new MockProvider({ responses: [{ text: "修订后的正文" }] }), root, 1, [0]);
    expect(r.ok).toBe(true);

    // 本次 commit 的树精确 = 仅候选文件(完整相对 POSIX pathspec, 绝非 -A 扫入无关改动)。
    const committed = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    expect(committed).toEqual(["chapters/pending/001.md"]);
    expect(gitLogSubjects(root).length).toBe(commitsBefore + 1);
    expect(gitLogSubjects(root)[0]).toBe("revision candidate ch1");
    // 无关改动留在工作区原样未动: tracked 001.md 仍未暂存修改(索引列空、工作区列 M)…
    const st = new Map(gitStatusEntries(root).map((e) => [e.path, e.status]));
    expect(st.get("chapters/001.md")).toBe(" M");
    // …未跟踪 notes.md 仍是 ??(没被 git add 卷入 index / commit)。
    expect(st.get("notes.md")).toBe("??");
  });
});

// P1(用户裁定): adoptChapterCandidate 对 source=writing_revise 候选在 store.adopt 前做
// 修订基线校验(解析 base_chapter/base_content_hash, 重读当前正文 contentHashOf 比对);
// 缺字段/失配 fail-closed(候选/正文不变、无 commit); 普通 writing_generate 候选不强制。
describe("adoptChapterCandidate 修订基线校验(P1)", () => {
  async function makeRevisionCandidate(root: string): Promise<void> {
    const provider = new MockProvider({
      responses: [
        { text: JSON.stringify({ findings: [finding] }) },
        { text: "修订后的正文" },
      ],
    });
    await reviewChapter(provider, root, 1);
    commitReviewBaseline(root, 1); // N32: 回执是审查步骤工件, 修订 commit 不再 -A 扫入。
    await applyRevision(provider, root, 1, [0]);
  }

  it("正文未改 → 采用成功(P1 放行, 修订正文进 chapters/001.md)", async () => {
    const root = makeRoot();
    await makeRevisionCandidate(root);
    const r = await adoptChapterCandidate(root);
    expect(r.ok).toBe(true);
    const raw = readFileSync(join(root, "chapters", "001.md"), "utf8");
    expect(raw).toContain("修订后的正文");
    // 候选已处理(source 保留 writing_revise, N23 校验最终落盘 fm)。
    const dep = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    expect(dep).toContain("status: deprecated");
    expect(dep).toContain("source: writing_revise");
  });

  it("返修生成后正文被另改并 commit → 采用拒绝(CONFLICT), 候选/正文不变、无新 commit", async () => {
    const root = makeRoot();
    await makeRevisionCandidate(root);
    const pendingBefore = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    // 作者另改正文并 commit(返修候选的冻结基线因此失效)。
    ingestChapter(root, { chapterIndex: 1, text: "被另改的正文", source: "paste" });
    gitAdd(root);
    gitCommit(root, "author edit");
    const chapterAfterEdit = readFileSync(join(root, "chapters", "001.md"), "utf8");
    const commitsAfterEdit = gitLogSubjects(root).length;

    await expect(adoptChapterCandidate(root)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    // 候选未被采用/未改写; 正文保持作者版本; 无新增 commit。
    expect(readFileSync(join(root, "chapters", "pending", "001.md"), "utf8")).toBe(pendingBefore);
    expect(readFileSync(join(root, "chapters", "001.md"), "utf8")).toBe(chapterAfterEdit);
    expect(gitLogSubjects(root).length).toBe(commitsAfterEdit);
  });

  it("修订候选缺 base_chapter/base_content_hash → BAD_CANDIDATE fail-closed, 候选不变无 commit", async () => {
    const root = makeRoot();
    // 手造缺基线字段的 writing_revise 候选。
    writeFileSync(
      join(root, "chapters", "pending", "001.md"),
      `---\nchapter_index: 1\nstatus: candidate\ncontent_hash: ${"0".repeat(64)}\nsource: writing_revise\n---\n修订正文\n`,
    );
    gitAdd(root);
    gitCommit(root, "malformed candidate");
    const before = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    const commitsBefore = gitLogSubjects(root).length;

    await expect(adoptChapterCandidate(root)).rejects.toThrowError(
      expect.objectContaining({ code: "BAD_CANDIDATE" }),
    );
    expect(readFileSync(join(root, "chapters", "pending", "001.md"), "utf8")).toBe(before);
    expect(gitLogSubjects(root).length).toBe(commitsBefore);
  });

  it("base_chapter 文件缺失 → BAD_CANDIDATE 明确基线拒绝, 候选不变、无 commit", async () => {
    const root = makeRoot();
    // 手造引用不存在章节的 writing_revise 候选(chapter 9 无对应文件): 基线条目本身合法,
    // 但重读基线正文时 chapterBody 抛裸 Error('章节不存在') → 必须转 StoreError BAD_CANDIDATE
    // 明确基线拒绝(fail-closed, 零写入零 commit)。
    writeFileSync(
      join(root, "chapters", "pending", "001.md"),
      `---\nchapter_index: 1\nstatus: candidate\ncontent_hash: ${"0".repeat(64)}\nbase_chapter: 9\nbase_content_hash: ${"a".repeat(64)}\nsource: writing_revise\n---\n修订正文\n`,
    );
    gitAdd(root);
    gitCommit(root, "orphan-base candidate");
    const before = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    const commitsBefore = gitLogSubjects(root).length;

    await expect(adoptChapterCandidate(root)).rejects.toThrowError(
      expect.objectContaining({ code: "BAD_CANDIDATE", message: expect.stringContaining("修订基线") }),
    );
    expect(readFileSync(join(root, "chapters", "pending", "001.md"), "utf8")).toBe(before);
    expect(readFileSync(join(root, "chapters", "001.md"), "utf8")).toContain("第一章正文");
    expect(gitLogSubjects(root).length).toBe(commitsBefore);
  });

  it("旧约定兼容: 正文多尾换行(normalized 以 \\n / \\n\\n 结尾)的旧候选仍放行", async () => {
    // 旧候选冻结 = 章节存储 content_hash 字段 = hash(normalizeChapterText(原文)), 不含文件
    // 序列化换行; 正文文件 = 归一文本 + 恰好一个序列化换行(ingestChapter)。原文以 \n 或 \n\n
    // 结尾时 body 有 2~3 个尾换行: 剥一个序列化换行后恰好还原旧冻结值 —— 单剥(而非剥全部
    // 尾换行)才是与旧规范一致的还原(normalizeChapterText 最多保留一个尾空行)。
    for (const text of ["正文", "正文\n", "正文\n\n"]) {
      const root = makeRootWithText(text);
      const frozen = contentHashOf(normalizeChapterText(text)); // 旧候选冻结值(存储字段)
      writeFileSync(
        join(root, "chapters", "pending", "001.md"),
        `---\nchapter_index: 1\nstatus: candidate\ncontent_hash: ${"0".repeat(64)}\nbase_chapter: 1\nbase_content_hash: ${frozen}\nfinding_ids: [0]\nsource: writing_revise\n---\n修订正文\n`,
      );
      gitAdd(root);
      gitCommit(root, "old-convention candidate");
      const r = await adoptChapterCandidate(root);
      expect(r.ok).toBe(true);
      expect(readFileSync(join(root, "chapters", "001.md"), "utf8")).toContain("修订正文");
    }
  }, 10_000);

  it("旧约定不放宽到盲剥尾换行: 正文新增尾空行(已变更) → CONFLICT 拒绝", async () => {
    // 若盲目剥全部尾换行, 「正文新增尾空行」会被误判为 hash("正文")==冻结值而误放行;
    // 旧引擎 content_hash 同为精确字节哈希(source_hashing.hash_text), 尾空行差异 = 内容变更
    // → fail-closed 拒绝。
    const root = makeRootWithText("正文"); // 冻结时正文 = "正文", body "正文\n"
    const frozen = contentHashOf("正文");
    writeFileSync(
      join(root, "chapters", "pending", "001.md"),
      `---\nchapter_index: 1\nstatus: candidate\ncontent_hash: ${"0".repeat(64)}\nbase_chapter: 1\nbase_content_hash: ${frozen}\nfinding_ids: [0]\nsource: writing_revise\n---\n修订正文\n`,
    );
    gitAdd(root);
    gitCommit(root, "candidate");
    // 作者重停靠加入尾空行并 commit → 正文已变更(存储字段 hash 亦变)。
    ingestChapter(root, { chapterIndex: 1, text: "正文\n\n", source: "paste" });
    gitAdd(root);
    gitCommit(root, "author added trailing blank line");
    const before = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    const commitsBefore = gitLogSubjects(root).length;

    await expect(adoptChapterCandidate(root)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(readFileSync(join(root, "chapters", "pending", "001.md"), "utf8")).toBe(before);
    expect(gitLogSubjects(root).length).toBe(commitsBefore);
  });

  it("新约定严格(exact body hash): 正文被追加两个换行 → CONFLICT 拒绝", async () => {
    // 新候选冻结 contentHashOf(正文)(含文件序列化换行), 兼容路径只容忍恰好一个序列化换行;
    // 追加两个换行超出序列化边界 → 两种约定均失配, fail-closed 拒绝。
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [
        { text: JSON.stringify({ findings: [finding] }) },
        { text: "修订后的正文" },
      ],
    });
    await reviewChapter(provider, root, 1);
    await applyRevision(provider, root, 1, [0]);
    const pendingBefore = readFileSync(join(root, "chapters", "pending", "001.md"), "utf8");
    // 作者在正文文件尾部追加两个换行并 commit(超出单序列化换行容忍)。
    writeFileSync(join(root, "chapters", "001.md"), readFileSync(join(root, "chapters", "001.md"), "utf8") + "\n\n");
    gitAdd(root);
    gitCommit(root, "author appended two newlines");
    const commitsBefore = gitLogSubjects(root).length;

    await expect(adoptChapterCandidate(root)).rejects.toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(readFileSync(join(root, "chapters", "pending", "001.md"), "utf8")).toBe(pendingBefore);
    expect(gitLogSubjects(root).length).toBe(commitsBefore);
  });

  it("普通 writing_generate 候选不强制 base hash: 正文另改后仍可采用", async () => {
    const root = makeRoot();
    await generateNextChapter(new MockProvider({ responses: [{ text: "第二章正文候选" }] }), root, 1, {
      proposalTitle: "雨夜对峙",
    });
    // 作者另改正文并 commit(生成候选无基线强制, 采用不受影响)。
    ingestChapter(root, { chapterIndex: 1, text: "被另改的正文", source: "paste" });
    gitAdd(root);
    gitCommit(root, "author edit");
    const r = await adoptChapterCandidate(root);
    expect(r.ok).toBe(true);
    const raw = readFileSync(join(root, "chapters", "002.md"), "utf8");
    expect(raw).toContain("第二章正文候选");
  });
  it("并发回归: LLM 等待期间目标被另一流程创建 → 写前 'wx' 独占创建拒绝, 旧字节不变无 commit", async () => {
    const root = makeRoot();
    gitAdd(root); gitCommit(root, "fixture init"); // gitLogSubjects 前提: 至少一个 commit
    await reviewChapter(new MockProvider({ responses: [{ text: JSON.stringify({ findings: [finding] }) }] }), root, 1);
    const commitsBefore = gitLogSubjects(root).length;
    const target = join(root, "chapters", "pending", "001.md");
    const base = new MockProvider({ responses: [{ text: "修订后的正文" }] });
    const racing: Provider = {
      // 另一流程在 provider 返回前创建目标候选(模拟 LLM 等待窗口内的并发写入;
      // 早于 applyRevision 的 existsSync fail-fast 检查, 晚于该检查才出现 → 只能靠 'wx' 兜底)。
      async complete(req) {
        const resp = await base.complete(req);
        writeFileSync(target, "并发创建的旧候选", "utf8");
        return resp;
      },
    };
    await expect(applyRevision(racing, root, 1, [0])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(target, "utf8")).toBe("并发创建的旧候选"); // 旧字节不变
    expect(gitLogSubjects(root).length).toBe(commitsBefore); // 无新 commit
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
