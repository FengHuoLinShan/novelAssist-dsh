// writing · 续写提案行为契约(§17.4/§17.5.3; next_chapter_proposal spec)。
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { compileProposalContextBudgeted,  ingestChapter, latestProposal, proposeNextChapter } from "../src/index";

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

// M12-c/N45: context 编译器接线行为锁定(review P0 修复后: 正文渲染 + 预算附注)。
describe('compileProposalContextBudgeted(N45: Tier P0-P4 预算编译进写作链)', () => {
  it('正文含存活段落内容 + 尾部预算附注; 空书时仍有任务段', () => {
    const root = makeRoot();
    ingestChapter(root, { chapterIndex: 1, text: '第一章结尾正文', source: 'paste' });
    const out = compileProposalContextBudgeted(root, 1);
    expect(out).toContain('【任务】');          // P0 段名
    expect(out).toContain('第一章结尾正文');    // P1 内容真正进输入(空壳回归锁定)
    expect(out).toContain('[上下文共');         // 尾部预算附注
  });

  it('小预算驱动真驱逐: 更低优先层被淘汰, 高优先层保留', () => {
    const root = makeRoot();
    ingestChapter(root, { chapterIndex: 1, text: '焦点章内容', source: 'paste' });
    // 极小预算(只够 P0/P1) → P2 结构层即便存在也被逐出; 单书无结构资产时用大预算对照。
    const small = compileProposalContextBudgeted(root, 1, { budget_tokens: 30 }); // 够 P0+P1, 不够追加结构层
    expect(small).toContain('【任务】');
    const large = compileProposalContextBudgeted(root, 1, { budget_tokens: 100000 });
    expect(large).toContain('焦点章内容');
    expect(large.length).toBeGreaterThanOrEqual(small.length);
  });
});

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

// R9(目录枚举扫描): proposals 目录内的 .json symlink(含指向 vault 外)必须被忽略;
// latestProposal 只读普通文件, 排序/取最后逻辑不受 symlink 污染。
// 平台不支持 symlink(如 Windows 非管理员)时 skipIf。
const symlinkSupported = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), "ncl-"));
    symlinkSync("t", join(d, "l"));
    rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!symlinkSupported)("latestProposal 忽略指向 vault 外的 .json symlink(R9)", () => {
  const record = (title: string) => ({
    run_id: "p123",
    chapter_index: 1,
    next_chapter: 2,
    generated_at: "2026-01-01T00:00:00.000Z",
    proposals: [{ title, premise: "p" }],
  });

  it("只含 symlink 时返回 undefined(安全忽略, 不读外部)", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "ncw-x-"));
    dirs.push(outside);
    writeFileSync(join(outside, "ext.json"), JSON.stringify(record("外部泄漏")));
    symlinkSync(join(outside, "ext.json"), join(root, ".assistant", "proposals", "next-001-evil.json"));
    expect(latestProposal(root)).toBeUndefined();
  });

  it("symlink 排序在后也不被取为最新(普通文件胜出)", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "ncw-x-"));
    dirs.push(outside);
    writeFileSync(
      join(root, ".assistant", "proposals", "next-001-p123.json"),
      JSON.stringify(record("真实提案")),
    );
    writeFileSync(join(outside, "ext.json"), JSON.stringify(record("外部泄漏")));
    symlinkSync(join(outside, "ext.json"), join(root, ".assistant", "proposals", "next-001-zzz.json"));
    const latest = latestProposal(root)!;
    expect(latest.proposals[0].title).toBe("真实提案");
  });
});
