// outline 行为契约(specs/assets/outline.md + N1/N12 + catalog §2)
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit } from "@novelcraft/store";
import { analyzeOutline, generateOutlineItem, generateStoryOutline, listScenes, readOutline, sceneFusionDraft, sceneHealthSignals, structureHealthSignals, writeOutline, writeStructureAsset } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "nco-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sceneHealthSignals(N1 四键)", () => {
  it("未关联章节 + 未复核 → 两键", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "scenes", "s001.md"),
      '---\nid: s001\nstatus: draft\ntitle: S1\nsource: deep_import\n---\n',
    );
    gitAdd(root); gitCommit(root, "scene");
    const signals = sceneHealthSignals(listScenes(root));
    expect(signals[0].keys).toContain("scene_unreviewed");
    expect(signals[0].keys).toContain("scene_unassigned_chapter");
    // N1 富化: 带 title + 证据明细(缺设定 → goal)。
    expect(signals[0].title).toBe("S1");
    const missing = signals[0].details.find((d) => d.key === "scene_missing_setup");
    expect(missing?.missing).toContain("goal");
  });
});

describe("structureHealthSignals(N1 后两键)", () => {
  it("thread 无 related → structure_unassigned", () => {
    const root = makeRoot();
    writeStructureAsset(root, "thread", { title: "主线", summary: "s" });
    const signals = structureHealthSignals(root);
    expect(signals.some((s) => s.keys.includes("structure_unassigned"))).toBe(true);
  });
});

describe("总纲 outline.md 单文件(adjudication #1)", () => {
  it("写读回, outline_markdown 在正文", () => {
    const root = makeRoot();
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一" });
    const o = readOutline(root)!;
    expect(o.title).toBe("总纲");
    expect(o.outline_markdown).toContain("# 卷一");
    expect(existsSync(join(root, "structure", "outline.md"))).toBe(true);
  });
});

describe("结构创作编排(catalog §2)", () => {
  it("总纲生成落 outline.md", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ title: "总纲", outline_markdown: "卷一", open_decisions: [] }) }],
    });
    const r = await generateStoryOutline(provider, root, "写总纲");
    expect(r.ok).toBe(true);
    expect(readOutline(root)?.title).toBe("总纲");
  });
  it("P20 thread 落 structure/threads/", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ target: "plot_thread", content: { title: "主线", summary: "s", confidence: 0.9 } }) }],
    });
    const r = await generateOutlineItem(provider, root, "plot_thread", "生成主线");
    expect(r.ok).toBe(true);
    expect(r.slug).toBeTruthy();
    expect(existsSync(join(root, "structure", "threads", r.slug + ".md"))).toBe(true);
  });
  it("analyze 不写资产", async () => {
    const root = makeRoot();
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ analysis: "结构清晰" }) }] });
    const r = await analyzeOutline(provider, "大纲文本");
    expect(r.ok).toBe(true);
    expect(listScenes(root)).toHaveLength(0);
  });
  it("sceneFusionDraft 返回合成卡", async () => {
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ title: "合成场景", confidence: 0.9 }) }] });
    const r = await sceneFusionDraft(provider, "两卡");
    expect(r.ok).toBe(true);
    expect((r.result as { title: string }).title).toBe("合成场景");
  });
});
