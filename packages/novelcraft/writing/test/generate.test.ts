// writing · 续写提案第二阶段行为契约(§17.5.3; writing_generate spec)。
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { generateNextChapter, ingestChapter } from "../src/index";

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
});
