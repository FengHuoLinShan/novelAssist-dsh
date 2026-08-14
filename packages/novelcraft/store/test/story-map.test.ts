// store · storyMap(剧情地图聚合)行为契约。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { serializeFrontmatter } from "../src/index.js";
import { storyMap } from "../src/index.js";

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nc-story-"));
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

describe("storyMap(剧情地图聚合)", () => {
  it("聚合 chapters/scenes + 四类结构资产(带深字段)", () => {
    const root = makeRoot();
    writeMd(path.join(root, "chapters", "001.md"), { title: "第一章" }, "正文");
    writeMd(path.join(root, "scenes", "s001.md"), { id: "s001", status: "draft", chapter_ids: [1], title: "初遇" });
    writeMd(path.join(root, "structure", "threads", "主线.md"), {
      id: "主线", status: "canonical", name: "主角成长", thread_type: "plot",
      start_chapter: 1, planned_payoff_chapter: 12, related_thread_ids: ["伏笔线"],
    });
    writeMd(path.join(root, "structure", "arcs", "第一卷.md"), { id: "第一卷", status: "canonical", title: "第一卷", chapter_range: [1, 6] });
    writeMd(path.join(root, "structure", "foreshadowing", "怀表.md"), { id: "怀表", status: "canonical", name: "怀表" });
    writeMd(path.join(root, "structure", "reveal", "身世.md"), {
      id: "身世", status: "canonical", name: "身世揭示", target_type: "thread", target_id: "主线",
      secret_summary: "主角是遗孤", related_thread_ids: ["主线"],
    });

    const m = storyMap(root);
    expect(m.book).toBe("测试书");
    expect(m.chapters).toHaveLength(1);
    expect(m.scenes[0]).toMatchObject({ slug: "s001", title: "初遇", chapters: ["1"] });
    expect(m.threads[0]).toMatchObject({ kind: "thread", name: "主角成长", thread_type: "plot", start_chapter: 1 });
    expect(m.arcs[0]).toMatchObject({ kind: "arc", name: "第一卷", chapter_range: [1, 6] });
    expect(m.foreshadowing).toHaveLength(1);
    expect(m.reveals[0]).toMatchObject({ kind: "reveal", target_type: "thread", target_id: "主线" });
  });

  it("空 vault: 各列表为空, book 兜底目录名", () => {
    const root = makeRoot();
    const m = storyMap(root);
    expect(m.book).toBe("测试书");
    expect(m.chapters).toHaveLength(0);
    expect(m.scenes).toHaveLength(0);
    expect(m.threads).toHaveLength(0);
    expect(m.edges).toEqual([]);
  });

  it("跨类边: 显式 relations + related_*_ids 兼容投影并集去重(ADR-0019 N14/N17)", () => {
    const root = makeRoot();
    writeMd(path.join(root, "structure", "threads", "主线.md"), {
      id: "主线", status: "canonical", name: "主角成长", thread_type: "plot",
      start_chapter: 1, planned_payoff_chapter: 12,
      related_character_ids: ["苏婉"],
    });
    writeMd(path.join(root, "structure", "foreshadowing", "怀表.md"), {
      id: "怀表", status: "canonical", name: "怀表",
      related_thread_ids: ["主线"],
      planned_payoff_scene: "s001",
      relations: [{ target: "主线", type: "serves_thread" }], // 显式边, 与投影重复
    });
    writeMd(path.join(root, "structure", "reveal", "身世.md"), {
      id: "身世", status: "canonical", name: "身世揭示", target_type: "character", target_id: "苏婉",
      secret_summary: "主角是遗孤", related_thread_ids: ["主线"],
      relations: [{ target: "怀表", type: "reveals_foreshadowing" }], // 配对边
    });
    writeMd(path.join(root, "scenes", "s001.md"), { id: "s001", status: "draft", chapter_ids: [1] });

    const m = storyMap(root);
    // 配对边(显式, 带 sourceKind)
    expect(m.edges).toContainEqual({ source: "身世", target: "怀表", type: "reveals_foreshadowing", status: "canonical", sourceKind: "reveal" });
    // 显式边优先, 与 related_thread_ids 投影去重后仅一条 serves_thread 边
    const threadEdges = m.edges.filter((e) => e.target === "主线" && e.type === "serves_thread" && e.source === "怀表");
    expect(threadEdges).toHaveLength(1);
    expect(threadEdges[0].sourceKind).toBe("foreshadowing");
    // reveal → thread 投影(身份锚 target_id 不进边, N16)
    expect(m.edges).toContainEqual({ source: "身世", target: "主线", type: "serves_thread", status: "canonical", sourceKind: "reveal" });
    // thread → character 投影
    expect(m.edges).toContainEqual({ source: "主线", target: "苏婉", type: "references_character", status: "canonical", sourceKind: "thread" });
    // pays_off_in_scene 投影(#11 slug)
    expect(m.edges).toContainEqual({ source: "怀表", target: "s001", type: "pays_off_in_scene", status: "canonical", sourceKind: "foreshadowing" });
    // 身份锚不产边
    expect(m.edges.some((e) => e.source === "身世" && e.target === "苏婉")).toBe(false);
  });

  it("对象 relations(list 形态)边进 storyMap.edges(对象缺省 sourceKind, N11/N14)", () => {
    const root = makeRoot();
    writeMd(path.join(root, "world", "objects", "obj-a.md"), {
      id: "obj-a", kind: "character", name: "苏婉", status: "canonical",
      relations: [{ target: "obj-b", type: "associate", status: "candidate" }],
    });
    writeMd(path.join(root, "world", "objects", "obj-b.md"), {
      id: "obj-b", kind: "character", name: "克莱恩", status: "canonical",
    });
    const m = storyMap(root);
    // 对象边 = 宿主对象 → 裸 slug 目标, sourceKind 缺省即对象(存量兼容)。
    expect(m.edges).toContainEqual({ source: "obj-a", target: "obj-b", type: "associate", status: "candidate" });
  });
});
