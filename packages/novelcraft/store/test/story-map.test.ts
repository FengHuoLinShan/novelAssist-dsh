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
  });
});
