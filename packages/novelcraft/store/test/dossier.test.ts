// store · chapterDossier(章节档案 §17.5.1)行为契约。
// 依据: 设计文档 §17.5.1(章节档案: Scene 分解/人物在场/POV/伏笔种下-回收对账/设定引用清单/节奏指标);
// specs/assets/outline.md「Scene frontmatter 字段表」(goal/core_conflict/must_happen/must_not_happen/
// narrative_tag/pov_character_id/chapter_ids, scene_index 排序键);
// specs/assets/writing.md「章节正文字段」(chapter_index/status/content_hash/title)。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appendEvent } from '@novelcraft/memory';
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { chapterDossier, serializeFrontmatter } from "../src/index.js";

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nc-dossier-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeMd(abs: string, fm: Record<string, unknown>, body = ""): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, serializeFrontmatter(fm, body), "utf8");
}

/** 直接写原始字节(绕过 serializeFrontmatter, 用于制造坏 frontmatter)。 */
function writeRaw(abs: string, content: string): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// 第 2 章正文: 去空白后恰 22 字符。
const CH2_BODY = "雨夜, 苏婉走进旧图书馆。\n\n她翻到那封泛黄的信。";

/** 最小 vault fixture: 3 章正文 + 2 Scene(挂第 2 章) + 2 人物/1 地点 + 2 伏笔 + 1 reveal。 */
function writeFixture(root: string): void {
  writeMd(path.join(root, "chapters", "001.md"), { chapter_index: 1, title: "第一章", status: "draft", content_hash: "h1" }, "第一章正文。");
  writeMd(path.join(root, "chapters", "002.md"), { chapter_index: 2, title: "第二章", status: "draft", content_hash: "h2" }, CH2_BODY);
  writeMd(path.join(root, "chapters", "003.md"), { chapter_index: 3, title: "第三章", status: "draft", content_hash: "h3" }, "第三章正文。");

  // 世界对象(outline.md: pov_character_id 指向 world 人物对象)
  writeMd(path.join(root, "world", "objects", "char-a.md"), { id: "char-a", kind: "character", name: "苏婉", status: "canonical" });
  writeMd(path.join(root, "world", "objects", "char-b.md"), { id: "char-b", kind: "character", name: "林一", status: "canonical" });
  writeMd(path.join(root, "world", "objects", "loc-1.md"), { id: "loc-1", kind: "location", name: "旧图书馆", status: "canonical" });

  // 2 个 Scene 挂第 2 章(scene_index 0/1; outline.md 字段表)
  writeMd(path.join(root, "scenes", "s-a.md"), {
    id: "s-a", status: "draft", scene_index: 0, title: "图书馆夜访", source: "manual", narrative_tag: "setup",
    goal: "苏婉发现线索", core_conflict: "守卫逼近", must_happen: "拿到信件", must_not_happen: "被发现",
    chapter_ids: [2], pov_character_id: "char-a",
    related_character_ids: ["char-a", "char-b"], related_entity_ids: ["loc-1"],
  });
  writeMd(path.join(root, "scenes", "s-b.md"), {
    id: "s-b", status: "draft", scene_index: 1, title: "走廊对峙", source: "manual", narrative_tag: "payoff",
    chapter_ids: [2], related_character_ids: ["char-b"],
  });

  // 伏笔: start_chapter=2 + planned_payoff_chapter=3; 另一条 chapter_range=[2,3](activeThrough)
  writeMd(path.join(root, "structure", "foreshadowing", "f-huai-biao.md"), {
    id: "f-huai-biao", status: "canonical", name: "怀表", start_chapter: 2, planned_payoff_chapter: 3,
  });
  writeMd(path.join(root, "structure", "foreshadowing", "f-xin.md"), {
    id: "f-xin", status: "canonical", name: "泛黄的信", start_chapter: 1, chapter_range: [2, 3],
  });

  // reveal: chapter_range=[3]
  writeMd(path.join(root, "structure", "reveal", "r-shenshi.md"), {
    id: "r-shenshi", status: "canonical", name: "身世揭示", target_type: "character", target_id: "char-a",
    secret_summary: "苏婉是遗孤", chapter_range: [3],
  });
}

// M12-c/N46: dossier 的记忆投影读面(§6.18.4 按故事顺序)。
describe('chapterDossier memory 投影(N46)', () => {
  it('无账本 → 空投影; 有事件 → 按章过滤统计', () => {
    const root = makeRoot();
    const empty = chapterDossier(root, 1);
    expect(empty.memory).toMatchObject({ events_total: 0, events_through_chapter: 0, entities_tracked: 0 });
    appendEvent(root, { chapter_index: 1, sequence: 0, event_type: 'manual_correction', snapshot_after: { saved: true }, source: 'manual_edit' });
    appendEvent(root, { chapter_index: 2, sequence: 0, event_type: 'manual_correction', snapshot_after: { saved: true }, source: 'manual_edit' });
    const d1 = chapterDossier(root, 1);
    expect(d1.memory.events_total).toBe(2);
    expect(d1.memory.events_through_chapter).toBe(1);
    expect(d1.memory.last_event_at).toBeTruthy();
  });

  it('N46 review: 账本由显式 appendEvent 驱动 —— 保存/读取面不自动合成事件(manual_correction reserved, §6.18.4)', () => {
    const root = makeRoot();
    // 反复 dossier 读取不产生事件
    chapterDossier(root, 1); chapterDossier(root, 1);
    expect(chapterDossier(root, 1).memory.events_total).toBe(0);
  });
});

describe("chapterDossier(章节档案, §17.5.1)", () => {
  it("第 2 章档案: 章节元 + Scene 分解 + 人物/POV + 伏笔种下 + 设定引用 + 节奏", () => {
    const root = makeRoot();
    writeFixture(root);
    const d = chapterDossier(root, 2);

    // 章正文元(writing.md: chapter_index/status/content_hash/title; wordCount=正文去空白字符数)
    expect(d.chapter).toMatchObject({ index: 2, title: "第二章", status: "draft", contentHash: "h2" });
    expect(d.chapter!.wordCount).toBe(22);
    expect(d.chapter!.wordCount).toBeGreaterThan(0);

    // Scene 分解: chapter_ids 含 2 的两条, 按 scene_index 排序; 字段齐全(outline.md 字段表)
    expect(d.scenes.map((s) => s.slug)).toEqual(["s-a", "s-b"]);
    expect(d.scenes[0]).toMatchObject({
      slug: "s-a", title: "图书馆夜访", status: "draft",
      goal: "苏婉发现线索", core_conflict: "守卫逼近",
      must_happen: "拿到信件", must_not_happen: "被发现",
      narrative_tag: "setup", pov_character_id: "char-a",
    });
    expect(d.scenes[1]).toMatchObject({ slug: "s-b", title: "走廊对峙", narrative_tag: "payoff" });

    // 人物在场: references_character 边 + related_character_ids 投影 + pov(N16 不进边, 从 fm 读); 去重
    expect(d.characters).toEqual([
      { slug: "char-a", name: "苏婉" },
      { slug: "char-b", name: "林一" },
    ]);

    // POV: scene slug → 解析后的人物名
    expect(d.pov).toEqual([{ scene: "s-a", character: "苏婉" }]);

    // 伏笔对账: planted = start_chapter==2; activeThrough = chapter_range 含 2 且非 planted
    expect(d.foreshadowing.planted).toEqual([{ slug: "f-huai-biao", name: "怀表" }]);
    expect(d.foreshadowing.activeThrough).toEqual([{ slug: "f-xin", name: "泛黄的信" }]);
    expect(d.foreshadowing.duePayoff).toEqual([]);

    // 设定引用: references_entity 边(related_entity_ids 投影) → 地点对象
    expect(d.referencedObjects).toEqual([{ slug: "loc-1", name: "旧图书馆", kind: "location" }]);

    // 节奏: avgSceneLength = wordCount/sceneCount 取整
    expect(d.rhythm).toEqual({ wordCount: 22, sceneCount: 2, avgSceneLength: 11 });

    // 第 3 章: duePayoff = planned_payoff_chapter==3; reveals = chapter_range 含 3
    const d3 = chapterDossier(root, 3);
    expect(d3.foreshadowing.duePayoff).toEqual([{ slug: "f-huai-biao", name: "怀表" }]);
    expect(d3.foreshadowing.activeThrough).toEqual([{ slug: "f-xin", name: "泛黄的信" }]);
    expect(d3.foreshadowing.planted).toEqual([]);
    expect(d3.reveals).toEqual([{ slug: "r-shenshi", name: "身世揭示" }]);
  });

  it("空章(存在但无 Scene): scenes=[] rhythm.sceneCount=0 avgSceneLength=0 不炸", () => {
    const root = makeRoot();
    writeFixture(root);
    const d = chapterDossier(root, 1);

    expect(d.chapter).toMatchObject({ index: 1, title: "第一章" });
    expect(d.scenes).toEqual([]);
    expect(d.characters).toEqual([]);
    expect(d.pov).toEqual([]);
    expect(d.rhythm).toEqual({ wordCount: 6, sceneCount: 0, avgSceneLength: 0 });
  });

  it("未导入章(文件不存在): chapter=null, 其余空(兜底 UI)", () => {
    const root = makeRoot();
    writeFixture(root);
    const d = chapterDossier(root, 9);

    expect(d.chapter).toBeNull();
    expect(d.scenes).toEqual([]);
    expect(d.characters).toEqual([]);
    expect(d.pov).toEqual([]);
    expect(d.foreshadowing).toEqual({ planted: [], activeThrough: [], duePayoff: [] });
    expect(d.reveals).toEqual([]);
    expect(d.referencedObjects).toEqual([]);
    expect(d.rhythm).toEqual({ wordCount: 0, sceneCount: 0, avgSceneLength: 0 });
  });

  it("脏数据容错: 一个 scene 文件 frontmatter 坏掉 → 整体不炸, 坏 scene 跳过", () => {
    const root = makeRoot();
    writeFixture(root);
    // 坏 frontmatter: 未闭合 YAML 序列(parseYaml 抛错; rebuildIndex 上抛为既有行为 → 档案降级自组装)
    writeRaw(
      path.join(root, "scenes", "s-bad.md"),
      "---\nid: s-bad\nstatus: draft\nscene_index: 9\nchapter_ids: [2\n---\n正文\n",
    );

    const d = chapterDossier(root, 2);
    // 坏 scene 跳过, 好 scene 保留(§17.5.1 容错契约)
    expect(d.scenes.map((s) => s.slug)).toEqual(["s-a", "s-b"]);
    expect(d.chapter).toMatchObject({ index: 2, status: "draft" });
    // 降级路径: 无 edges(rebuildIndex 上抛), 人物/设定经 scene frontmatter 直读(N17 投影同口径),
    // 名称解析降级为 slug
    expect(d.characters).toEqual([
      { slug: "char-a", name: "char-a" },
      { slug: "char-b", name: "char-b" },
    ]);
    expect(d.referencedObjects).toEqual([{ slug: "loc-1", name: "loc-1", kind: "" }]);
    expect(d.pov).toEqual([{ scene: "s-a", character: "char-a" }]);
  });
});
