// writing · 续写提案第二阶段行为契约(§17.5.3; writing_generate spec)。
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, gitLogSubjects, gitStatusEntries } from "@novelcraft/store";
import { applyRevision, generateNextChapter, ingestChapter, reviewChapter } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncg-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  ingestChapter(root, { chapterIndex: 1, text: "第一章正文结尾", source: "paste" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const finding = { category: "continuity", severity: "medium" as const, quote: "他说", suggestion: "统一称呼" };

describe("generateNextChapter(选定方向 → 正文候选)", () => {
  it("候选写 chapters/pending/002.md(status=candidate, 下一章序号)", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: "第二章正文候选" }],
    });
    const r = await generateNextChapter(provider, root, 1, {
      proposalTitle: "雨夜对峙",
      premise: "主角与反派在桥头摊牌",
    });
    expect(r.ok).toBe(true);
    const file = join(root, "chapters", "pending", "002.md");
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("status: candidate");
    expect(raw).toContain("chapter_index: 2");
    // N23: chapter_candidate 必填 status/content_hash/source。
    expect(raw).toContain("source: writing_generate");
    expect(raw).toMatch(/content_hash: [0-9a-f]{64}/);
    expect(raw).toContain("proposal_title: \"雨夜对峙\"");
    expect(raw).toContain("第二章正文候选");
  });

  it("provider 失败 → ok:false 不写候选", async () => {
    const root = makeRoot();
    const boom = new MockProvider({ retryable: false, responses: [{ throwError: new Error("boom") }] });
    const r = await generateNextChapter(boom, root, 1, { proposalTitle: "雨夜对峙" });
    expect(r.ok).toBe(false);
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(false);
  });

  it("目标下一章已存在 → provider 前 CONFLICT", async () => {
    const root = makeRoot();
    ingestChapter(root, { chapterIndex: 2, text: "作者正文", source: "paste" });
    const provider = new MockProvider({ responses: [{ text: "不应消费" }] });
    await expect(generateNextChapter(provider, root, 1, { proposalTitle: "t" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(provider.calls).toHaveLength(0);
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(false);
  });

  it("git 精确暂存候选文件(完整相对 POSIX pathspec, 绝不 -A); 无关用户改动保留", async () => {
    const root = makeRoot();
    gitAdd(root); gitCommit(root, "fixture init"); // 基线 commit: chapters/001.md 成为 tracked
    // 用户无关改动: 已跟踪章节追加内容(未暂存) + 未跟踪草稿文件(未添加)。
    const ch1 = join(root, "chapters", "001.md");
    writeFileSync(ch1, readFileSync(ch1, "utf8") + "\n用户备注\n", "utf8");
    writeFileSync(join(root, "notes.md"), "用户草稿", "utf8");
    const commitsBefore = gitLogSubjects(root).length;

    const r = await generateNextChapter(new MockProvider({ responses: [{ text: "第二章正文候选" }] }), root, 1, { proposalTitle: "t" });
    expect(r.ok).toBe(true);

    // 本次 commit 的树精确 = 仅候选文件(完整相对 POSIX pathspec, 绝非 -A 扫入无关改动)。
    const committed = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    expect(committed).toEqual(["chapters/pending/002.md"]);
    expect(gitLogSubjects(root).length).toBe(commitsBefore + 1);
    expect(gitLogSubjects(root)[0]).toBe("generate candidate ch2");
    // 无关改动留在工作区原样未动: tracked 001.md 仍未暂存修改(索引列空、工作区列 M)…
    const st = new Map(gitStatusEntries(root).map((e) => [e.path, e.status]));
    expect(st.get("chapters/001.md")).toBe(" M");
    // …未跟踪 notes.md 仍是 ??(没被 git add 卷入 index / commit)。
    expect(st.get("notes.md")).toBe("??");
  });
});

// 已证实候选覆盖修复: generateNextChapter / applyRevision 都写 chapters/pending/{NNN}.md,
// 两侧写前目标已存在 → 抛清楚 CONFLICT; 不改旧文件、不新增 commit。双向覆盖测试:
describe("pending 候选覆盖保护(双向)", () => {
  it("M10-C1/N41 R17 门禁: 预存 staged 外部内容 → LLM 前 DIRTY_WORKSPACE(零 provider 零写)", async () => {
    const root = makeRoot();
    // 预存 staged 范围外文件(模拟崩溃事务残留/手动 stage)。
    writeFileSync(join(root, "evil.md"), "e\n", "utf8");
    const { gitAdd } = await import("@novelcraft/store");
    gitAdd(root, ["evil.md"]);
    const provider = new MockProvider({ responses: [{ text: "不应被调用" }] });
    await expect(generateNextChapter(provider, root, 1, { proposalTitle: "t" }))
      .rejects.toMatchObject({ code: "DIRTY_WORKSPACE" });
    expect(provider.calls).toHaveLength(0); // LLM 前置拒绝, 零 provider 成本
    expect(existsSync(join(root, "chapters", "pending", "002.md"))).toBe(false); // 零写
  });

  it("M10-C1/N41 幂等重试: 上次残留的目标 staged 在豁免集内 → 放行", async () => {
    const root = makeRoot();
    // 上次 generate 在 gitAdd 后、commit 前崩溃: 目标候选已 staged。
    const pending = join(root, "chapters", "pending");
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "002.md"), "---\nchapter_index: 2\nstatus: candidate\n---\n旧候选");
    const { gitAdd } = await import("@novelcraft/store");
    gitAdd(root, ["chapters/pending/002.md"]);
    const provider = new MockProvider({ responses: [{ text: "新候选正文" }] });
    // 目标候选已存在(残留) → CONFLICT 先于门禁(wx 覆盖保护语义不变)。
    await expect(generateNextChapter(provider, root, 1, { proposalTitle: "t" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("generate 重跑 → 目标候选已存在 → CONFLICT, 不改旧文件不新增 commit", async () => {
    const root = makeRoot();
    const first = await generateNextChapter(new MockProvider({ responses: [{ text: "第二章正文候选" }] }), root, 1, { proposalTitle: "t" });
    expect(first.ok).toBe(true);
    const file = join(root, "chapters", "pending", "002.md");
    const before = readFileSync(file, "utf8");
    const commitsBefore = gitLogSubjects(root).length;
    await expect(generateNextChapter(new MockProvider({ responses: [] }), root, 1, { proposalTitle: "t2" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(file, "utf8")).toBe(before); // 旧候选未被覆盖
    expect(gitLogSubjects(root).length).toBe(commitsBefore); // 不新增 commit
  });
  it("applyRevision 重跑 → 目标候选已存在 → CONFLICT, 不改旧文件不新增 commit", async () => {
    const root = makeRoot();
    await reviewChapter(new MockProvider({ responses: [{ text: JSON.stringify({ findings: [finding] }) }] }), root, 1);
    const first = await applyRevision(new MockProvider({ responses: [{ text: "修订后的正文" }] }), root, 1, [0]);
    expect(first.ok).toBe(true);
    const file = join(root, "chapters", "pending", "001.md");
    const before = readFileSync(file, "utf8");
    const commitsBefore = gitLogSubjects(root).length;
    await expect(applyRevision(new MockProvider({ responses: [] }), root, 1, [0]))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(file, "utf8")).toBe(before); // 旧候选未被覆盖
    expect(gitLogSubjects(root).length).toBe(commitsBefore); // 不新增 commit
  });
  it("交叉: generate 先写 002 → applyRevision(第 2 章)目标已存在 → CONFLICT", async () => {
    const root = makeRoot();
    await generateNextChapter(new MockProvider({ responses: [{ text: "第二章正文候选" }] }), root, 1, { proposalTitle: "t" });
    ingestChapter(root, { chapterIndex: 2, text: "第二章正文。", source: "paste" });
    await reviewChapter(new MockProvider({ responses: [{ text: JSON.stringify({ findings: [finding] }) }] }), root, 2);
    const file = join(root, "chapters", "pending", "002.md");
    const before = readFileSync(file, "utf8");
    await expect(applyRevision(new MockProvider({ responses: [] }), root, 2, [0]))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(file, "utf8")).toBe(before); // generate 的候选未被修订覆盖
  });
  it("交叉: applyRevision 先写 002 → generate(第 1 章)目标已存在 → CONFLICT", async () => {
    const root = makeRoot();
    ingestChapter(root, { chapterIndex: 2, text: "第二章正文。", source: "paste" });
    await reviewChapter(new MockProvider({ responses: [{ text: JSON.stringify({ findings: [finding] }) }] }), root, 2);
    await applyRevision(new MockProvider({ responses: [{ text: "第二章修订正文" }] }), root, 2, [0]);
    const file = join(root, "chapters", "pending", "002.md");
    const before = readFileSync(file, "utf8");
    await expect(generateNextChapter(new MockProvider({ responses: [] }), root, 1, { proposalTitle: "t" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(file, "utf8")).toBe(before); // 修订候选未被生成覆盖
  });
  it("并发回归: LLM 等待期间目标被另一流程创建 → 写前 'wx' 独占创建拒绝, 旧字节不变无 commit", async () => {
    const root = makeRoot();
    gitAdd(root); gitCommit(root, "fixture init"); // gitLogSubjects 前提: 至少一个 commit
    const commitsBefore = gitLogSubjects(root).length;
    const target = join(root, "chapters", "pending", "002.md");
    const base = new MockProvider({ responses: [{ text: "第二章正文候选" }] });
    const racing: Provider = {
      // 另一流程在 provider 返回前创建目标候选(模拟 LLM 等待窗口内的并发写入;
      // 早于 generate 的 existsSync fail-fast 检查, 晚于该检查才出现 → 只能靠 'wx' 兜底)。
      async complete(req) {
        const resp = await base.complete(req);
        writeFileSync(target, "并发创建的旧候选", "utf8");
        return resp;
      },
    };
    await expect(generateNextChapter(racing, root, 1, { proposalTitle: "t" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(target, "utf8")).toBe("并发创建的旧候选"); // 旧字节不变
    expect(gitLogSubjects(root).length).toBe(commitsBefore); // 无新 commit
  });
});
