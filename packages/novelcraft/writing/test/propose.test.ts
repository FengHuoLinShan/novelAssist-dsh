// writing · 续写提案行为契约(§17.4/§17.5.3; next_chapter_proposal spec)。
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { ingestChapter, latestProposal, proposeNextChapter } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncp-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  ingestChapter(root, { chapterIndex: 1, text: "第一章正文结尾", source: "paste" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const proposal = {
  title: "雨夜对峙",
  premise: "主角与反派在桥头摊牌",
  basis: ["推进主线"],
  cost: "约 3000 字",
  risk: "需先补「桥」的设定",
};

describe("proposeNextChapter(计划台续写提案)", () => {
  it("落 .assistant/proposals/, 字段完整(§17.5.3)", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ proposals: [proposal] }) }],
    });
    const r = await proposeNextChapter(provider, root, 1);
    expect(r.ok).toBe(true);
    expect(r.proposal!.proposals).toHaveLength(1);
    expect(r.proposal!.next_chapter).toBe(2);
    expect(r.proposal!.proposals[0].basis).toContain("推进主线");
    const file = join(
      root,
      ".assistant",
      "proposals",
      `next-001-${r.proposal!.run_id}.json`,
    );
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("雨夜对峙");
  });

  it("provider 失败 / 无 proposals → ok:false 不落盘", async () => {
    const root = makeRoot();
    const boom = new MockProvider({ retryable: false, responses: [{ throwError: new Error("boom") }] });
    const r = await proposeNextChapter(boom, root, 1);
    expect(r.ok).toBe(false);
    expect(latestProposal(root)).toBeUndefined();

    const empty = new MockProvider({ responses: [{ text: JSON.stringify({ proposals: [] }) }] });
    const r2 = await proposeNextChapter(empty, root, 1);
    expect(r2.ok).toBe(false);
    expect(latestProposal(root)).toBeUndefined();
  });

  it("latestProposal 读回最新一条", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [
        { text: JSON.stringify({ proposals: [proposal] }) },
        { text: JSON.stringify({ proposals: [{ ...proposal, title: "第二条" }] }) },
      ],
    });
    await proposeNextChapter(provider, root, 1);
    await proposeNextChapter(provider, root, 1);
    const latest = latestProposal(root)!;
    expect(latest.proposals[0].title).toBe("第二条");
  });
});
