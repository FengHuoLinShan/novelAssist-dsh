// outline 行为契约(specs/assets/outline.md + N1/N12 + catalog §2)
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, parseFrontmatter, validateFrontmatter } from "@novelcraft/store";
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

  it("写链硬错(ADR-0019 P3): 悬空 relations 拒绝写入, 文件不落盘", () => {
    const root = makeRoot();
    expect(() =>
      writeStructureAsset(root, "thread", {
        title: "主线",
        relations: [{ target: "不存在的对象", type: "references_entity" }],
      }),
    ).toThrowError(/relations 校验失败/);
    // 硬错后文件未落盘(fail-closed)
    expect(readdirSync(join(root, "structure", "threads"))).toEqual([]);
  });

  it("写链合法边(ADR-0019): 引用已存在的对象, 落盘成功", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "world", "objects", "霜华剑.md"),
      '---\nid: 霜华剑\nkind: item\nname: 霜华剑\nstatus: canonical\n---\n',
    );
    gitAdd(root); gitCommit(root, "obj");
    const slug = writeStructureAsset(root, "thread", {
      title: "主线",
      relations: [{ target: "霜华剑", type: "references_entity" }],
    });
    expect(slug).toContain("主线");
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

describe("写端 schema 必填补齐(B3)", () => {
  function readFm(root: string, rel: string): Record<string, unknown> {
    return parseFrontmatter(readFileSync(join(root, rel), "utf8")).data as Record<string, unknown>;
  }

  it("writeStructureAsset thread: id/name/thread_type 齐备且过 schema(frontmatter.ts:492)", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "thread", { title: "主线", summary: "s" });
    const fm = readFm(root, `structure/threads/${slug}.md`);
    expect(fm.id).toBe(slug); // id = slug(B3)
    expect(fm.name).toBe("主线"); // name 默认取 title(B3)
    expect(fm.thread_type).toBe("main");
    expect(validateFrontmatter("thread", fm as never)).toEqual([]);
  });

  it("writeStructureAsset arc: id 齐备且过 schema(frontmatter.ts:497)", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "arc", { title: "第一卷" });
    const fm = readFm(root, `structure/arcs/${slug}.md`);
    expect(fm.id).toBe(slug);
    expect(validateFrontmatter("arc", fm as never)).toEqual([]);
  });

  it("writeStructureAsset foreshadowing: name 齐备且过 schema(frontmatter.ts:502)", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "foreshadowing", { title: "怀表伏笔" });
    const fm = readFm(root, `structure/foreshadowing/${slug}.md`);
    expect(fm.id).toBe(slug);
    expect(fm.name).toBe("怀表伏笔"); // name 默认取 title(B3)
    expect(validateFrontmatter("foreshadowing", fm as never)).toEqual([]);
  });

  it("writeStructureAsset reveal: 缺 target 三件套 fail-closed 拒写, 文件不落盘(frontmatter.ts:508)", () => {
    const root = makeRoot();
    expect(() => writeStructureAsset(root, "reveal", { title: "秘密" })).toThrowError(/reveal 必填缺失/);
    expect(readdirSync(join(root, "structure", "reveal"))).toEqual([]);
  });

  it("writeStructureAsset reveal: target_type/target_id/secret_summary 齐备落盘且过 schema", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "reveal", {
      title: "秘密",
      target_type: "world_entity",
      target_id: "霜华剑",
      secret_summary: "剑是赝品",
    });
    const fm = readFm(root, `structure/reveal/${slug}.md`);
    expect(fm.target_type).toBe("world_entity");
    expect(fm.target_id).toBe("霜华剑");
    expect(fm.secret_summary).toBe("剑是赝品");
    expect(validateFrontmatter("reveal", fm as never)).toEqual([]);
  });

  it("writeOutline: creative_core/major_storylines/macro_movements/open_decisions 缺省补齐(frontmatter.ts:513)", () => {
    const root = makeRoot();
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一" });
    const o = readOutline(root)!;
    expect(o.creative_core).toEqual({});
    expect(o.major_storylines).toEqual([]);
    expect(o.macro_movements).toEqual([]);
    expect(o.open_decisions).toEqual([]);
  });

  it("generateStoryOutline 持久化 major_storylines/macro_movements/open_decisions 到 outline.md", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          title: "总纲",
          outline_markdown: "卷一",
          major_storylines: [{ name: "主线", narrative_function: "backbone" }],
          macro_movements: [{ name: "启幕", story_state_change: "平静→动乱" }],
          open_decisions: [{ question: "结局走向?" }],
        }),
      }],
    });
    const r = await generateStoryOutline(provider, root, "写总纲");
    expect(r.ok).toBe(true);
    const o = readOutline(root)!;
    expect((o.major_storylines as Array<{ name: string }>)[0].name).toBe("主线");
    expect((o.macro_movements as Array<{ name: string }>)[0].name).toBe("启幕");
    expect((o.open_decisions as Array<{ question: string }>)[0].question).toBe("结局走向?");
  });

  it("generateOutlineItem: content 透传 name/thread_type; reveal 三件套进 fm", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          target: "plot_thread",
          content: {
            title: "主线",
            name: "主角成长线",
            thread_type: "character",
            target_type: "character",
            target_id: "obj-klein",
            secret_summary: "克莱恩是穿越者",
            summary: "s",
            confidence: 0.9,
          },
        }),
      }],
    });
    const r = await generateOutlineItem(provider, root, "plot_thread", "生成主线");
    expect(r.ok).toBe(true);
    const fm = readFm(root, `structure/threads/${r.slug}.md`);
    expect(fm.id).toBe(r.slug);
    expect(fm.name).toBe("主角成长线");
    expect(fm.thread_type).toBe("character");
    // reveal 必填三件套经 content 透传(frontmatter.ts:508)
    expect(fm.target_type).toBe("character");
    expect(fm.target_id).toBe("obj-klein");
    expect(fm.secret_summary).toBe("克莱恩是穿越者");
    expect(validateFrontmatter("thread", fm as never)).toEqual([]);
  });
});
