// assistant · 连续性雷达行为契约(N54/M13-B 批 2: gap 8 项中的 7 项; 幂等 + 双向对账 +
// 与既有检测器的判别)。scene_index_conflict(第 8 项)归健康面, 见本文件末 describe 与
// outline 包 sceneIndexConflicts 单测。断言注释引 N54。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import {
  collectContinuityRadarHits,
  listSignals,
  loadSignal,
  runRadarSweep,
  runRadarSweepAtomic,
  scanRiskContinuityRadar,
} from "../src/index";

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ncc-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seedChapter(root: string, index: number) {
  writeFileSync(
    join(root, "chapters", `${String(index).padStart(3, "0")}.md`),
    `---\nchapter_index: ${index}\nstatus: published\ncontent_hash: "h${index}"\ntitle: 第${index}章\n---\n`,
    "utf8",
  );
}

function seedBase(root: string) {
  for (let i = 1; i <= 3; i++) seedChapter(root, i);
}

function writeAsset(root: string, rel: string, fm: Record<string, unknown>) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}]`);
    else if (typeof value === "string") lines.push(`${key}: ${JSON.stringify(value)}`);
    else lines.push(`${key}: ${value}`);
  }
  writeFileSync(join(root, rel), `${lines.join("\n")}\n---\n`, "utf8");
}

describe("collectContinuityRadarHits(七项确定性检测器, N54)", () => {
  it("reveal_before_plant: 最早揭示章早于埋设章 → risk; 不早于 → 零命中", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "structure/foreshadowing/f1.md", {
      id: "f1", status: "canonical", name: "信物", planned_seed_chapter: 3,
    });
    writeAsset(root, "structure/reveal/r1.md", {
      id: "r1", status: "canonical", title: "早期揭示", target_type: "foreshadowing",
      target_id: "f1", secret_summary: "来历",
      reveal_stages: [{ stage_index: 0, chapter_index: 1, reveal_content: "点破" }],
      relations: [{ target: "f1", type: "reveals_foreshadowing", status: "canonical" }],
    });
    const r = scanRiskContinuityRadar(root);
    expect(r.created).toBeGreaterThanOrEqual(1);
    expect(loadSignal(root, "risk-reveal-before-plant-r1-f1")?.severity).toBe("risk");

    // 多条 reveals_foreshadowing 边(评审 P1-1): 同一 reveal 提前揭示两个伏笔 → 两条独立
    // 信号不撞 id(只带 reveal.slug 会同 id 异 logical_key 使整轮对账抛错)。
    writeAsset(root, "structure/foreshadowing/f2.md", { id: "f2", status: "canonical", name: "信物乙", planned_seed_chapter: 3 });
    writeAsset(root, "structure/reveal/r1.md", {
      id: "r1", status: "canonical", title: "早期揭示", target_type: "foreshadowing",
      target_id: "f1", secret_summary: "来历",
      reveal_stages: [{ stage_index: 0, chapter_index: 1, reveal_content: "点破" }],
      relations: [
        { target: "f1", type: "reveals_foreshadowing", status: "canonical" },
        { target: "f2", type: "reveals_foreshadowing", status: "canonical" },
      ],
    });
    expect(() => scanRiskContinuityRadar(root)).not.toThrow();
    expect(loadSignal(root, "risk-reveal-before-plant-r1-f2")).toBeDefined();

    // 负例: 揭示在第 3 章(=埋设章)不早于 → 该类零命中。
    const clean = makeRoot();
    seedBase(clean);
    writeAsset(clean, "structure/foreshadowing/f1.md", { id: "f1", status: "canonical", name: "信物", planned_seed_chapter: 3 });
    writeAsset(clean, "structure/reveal/r1.md", {
      id: "r1", status: "canonical", title: "揭示", target_type: "foreshadowing",
      target_id: "f1", secret_summary: "来历",
      reveal_stages: [{ stage_index: 0, chapter_index: 3 }],
      relations: [{ target: "f1", type: "reveals_foreshadowing", status: "canonical" }],
    });
    expect(collectContinuityRadarHits(clean).filter((h) => h.id.startsWith("risk-reveal-before-plant-"))).toHaveLength(0);
  });

  it("thread_range_invalid: 倒置/越界/<1 → risk; 合法范围零命中", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "structure/threads/t-rev.md", { id: "t-rev", status: "canonical", title: "倒叙", thread_type: "subplot", start_chapter: 5, end_chapter: 2 });
    // 规划未来章(end 9 > 已写最大章 3)不报——与 foreshadow_overdue「计划点未到不超期」
    // 同口径(评审 P1-3), 只报 <1 与倒置。
    writeAsset(root, "structure/threads/t-future.md", { id: "t-future", status: "canonical", title: "远期", thread_type: "subplot", start_chapter: 1, end_chapter: 9 });
    writeAsset(root, "structure/threads/t-ok.md", { id: "t-ok", status: "canonical", title: "合法", thread_type: "main", start_chapter: 1, end_chapter: 3 });
    scanRiskContinuityRadar(root);
    expect(loadSignal(root, "risk-thread-range-invalid-t-rev")?.severity).toBe("risk");
    expect(loadSignal(root, "risk-thread-range-invalid-t-future")).toBeUndefined();
    expect(loadSignal(root, "risk-thread-range-invalid-t-ok")).toBeUndefined();
  });

  it("arc_thread_range_mismatch: 篇章纲章跨不含线程章跨 → risk; 含则零命中", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "structure/arcs/act1.md", { id: "act1", status: "canonical", title: "第一幕", chapter_range: [1, 2], related_thread_ids: ["t-long", "t-in"] });
    writeAsset(root, "structure/threads/t-long.md", { id: "t-long", status: "canonical", title: "长线", thread_type: "main", start_chapter: 1, end_chapter: 3 });
    writeAsset(root, "structure/threads/t-in.md", { id: "t-in", status: "canonical", title: "内线", thread_type: "main", start_chapter: 1, end_chapter: 2 });
    // spec 字段表形态的 arc(start_chapter/end_chapter, 评审 P1-4 双认)。
    writeAsset(root, "structure/arcs/act2.md", { id: "act2", status: "canonical", title: "第二幕", start_chapter: 1, end_chapter: 2, related_thread_ids: ["t-long"] });
    scanRiskContinuityRadar(root);
    expect(loadSignal(root, "risk-arc-thread-range-mismatch-act1-t-long")?.severity).toBe("risk");
    expect(loadSignal(root, "risk-arc-thread-range-mismatch-act2-t-long")?.severity).toBe("risk");
    expect(loadSignal(root, "risk-arc-thread-range-mismatch-act1-t-in")).toBeUndefined();
  });

  it("thread_orphan: 无 serves_thread 挂靠 → note; scene related_thread_ids 挂靠后零命中(与 structure_unassigned 判别)", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "structure/threads/t-lost.md", { id: "t-lost", status: "canonical", title: "孤儿", thread_type: "subplot" });
    scanRiskContinuityRadar(root);
    const sig = loadSignal(root, "risk-thread-orphan-t-lost");
    expect(sig?.severity).toBe("note"); // 提醒级, 与 risk 检测器分级一致(§11)
    expect(sig?.title).toContain("孤儿");

    // 挂靠后(负例): scene related_thread_ids 投影出 serves_thread 边 → 孤儿消失。
    writeAsset(root, "scenes/s1.md", {
      id: "s1", status: "draft", title: "挂靠", source: "deep_import", scene_index: 0,
      chapter_ids: [1], reviewed_at: "2026-09-08T00:00:00Z", goal: "g", core_conflict: "c",
      must_happen: "m", must_not_happen: "n", related_thread_ids: ["t-lost"],
    });
    const r2 = scanRiskContinuityRadar(root);
    expect(r2.resolved).toBeGreaterThanOrEqual(1);
    expect(loadSignal(root, "risk-thread-orphan-t-lost")?.status).toBe("resolved");
  });

  it("reveal_target_dangling: target_id 悬空 → risk; 对象存在则零命中", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "structure/reveal/r-ghost.md", { id: "r-ghost", status: "canonical", title: "幽灵", target_type: "world_entity", target_id: "no-such", secret_summary: "s" });
    writeAsset(root, "structure/reveal/r-ok.md", { id: "r-ok", status: "canonical", title: "正常", target_type: "world_entity", target_id: "obj-1", secret_summary: "s" });
    writeAsset(root, "world/objects/obj-1.md", { id: "obj-1", name: "实体一", kind: "location", status: "canonical", aliases: [], evidence: ["第1章", "第2章"] });
    scanRiskContinuityRadar(root);
    expect(loadSignal(root, "risk-reveal-target-dangling-r-ghost")?.severity).toBe("risk");
    expect(loadSignal(root, "risk-reveal-target-dangling-r-ok")).toBeUndefined();
  });

  it("payoff_scene_dangling: planned_payoff_scene 悬空 → risk; Scene 存在则零命中", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "structure/foreshadowing/f-pay.md", { id: "f-pay", status: "canonical", name: "旧约", planned_seed_chapter: 1, planned_payoff_chapter: 3, planned_payoff_scene: "s-nope" });
    writeAsset(root, "structure/foreshadowing/f-ok.md", { id: "f-ok", status: "canonical", name: "新约", planned_payoff_scene: "s-real" });
    writeAsset(root, "scenes/s-real.md", { id: "s-real", status: "draft", title: "兑现", scene_index: 0 });
    scanRiskContinuityRadar(root);
    expect(loadSignal(root, "risk-payoff-scene-dangling-f-pay")?.severity).toBe("risk");
    expect(loadSignal(root, "risk-payoff-scene-dangling-f-ok")).toBeUndefined();
  });

  it("legacy_edge_dangling: related_*_ids 投影悬空 → risk; 显式 relations 悬空归 risk-dangling- 不双报(判别)", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "structure/threads/t-legacy.md", { id: "t-legacy", status: "canonical", title: "旧字段", thread_type: "subplot", related_character_ids: ["no-such-char"] });
    // 显式 relations 悬空(写入绕过校验的存量): 归 radar-risk 既有 risk-dangling-, 不归本检测器。
    writeAsset(root, "structure/foreshadowing/f-rel.md", {
      id: "f-rel", status: "canonical", name: "信物",
      relations: [{ target: "t-missing", type: "serves_thread", status: "canonical" }],
    });
    const r = scanRiskContinuityRadar(root);
    const ids = listSignals(root).map((s) => s.id);
    expect(ids.some((id) => id.startsWith("risk-legacy-edge-dangling-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("risk-dangling-"))).toBe(true); // radar-risk 既有面负责显式边
    // 同一条显式悬空边不产生 legacy 信号: legacy 命中只来自 related_*_ids 投影。
    const legacyHits = collectContinuityRadarHits(root).filter((h) => h.id.startsWith("risk-legacy-edge-dangling-"));
    expect(legacyHits).toHaveLength(1); // 只有 t-legacy 的 references_character
    expect(r.created).toBeGreaterThanOrEqual(1);
  });

  it("幂等与双向对账(N54 ③): 二扫零新建; 条件消失自动 resolved; 问题回来重开(resolved → open)", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "structure/reveal/r-ghost.md", { id: "r-ghost", status: "canonical", title: "幽灵", target_type: "world_entity", target_id: "no-such", secret_summary: "s" });
    const r1 = scanRiskContinuityRadar(root);
    expect(r1.created).toBeGreaterThanOrEqual(1);
    const r2 = scanRiskContinuityRadar(root);
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBeGreaterThanOrEqual(1);

    writeAsset(root, "world/objects/fixed-obj.md", { id: "fixed-obj", name: "实体", kind: "location", status: "canonical", aliases: [], evidence: ["第1章", "第2章"] });
    writeAsset(root, "structure/reveal/r-ghost.md", { id: "r-ghost", status: "canonical", title: "修好", target_type: "world_entity", target_id: "fixed-obj", secret_summary: "s" });
    const r3 = scanRiskContinuityRadar(root);
    expect(r3.resolved).toBeGreaterThanOrEqual(1);
    expect(loadSignal(root, "risk-reveal-target-dangling-r-ghost")?.status).toBe("resolved");

    // 问题回来 → 重开(裁决不复活: 新观察重新 open)。
    writeAsset(root, "structure/reveal/r-ghost.md", { id: "r-ghost", status: "canonical", title: "又坏", target_type: "world_entity", target_id: "no-such", secret_summary: "s" });
    const r4 = scanRiskContinuityRadar(root);
    expect(r4.reopened).toBeGreaterThanOrEqual(1);
    expect(loadSignal(root, "risk-reveal-target-dangling-r-ghost")?.status).toBe("open");
  });
});

describe("risk 面接线(N54: radar-risk + 连续性合并一次对账)", () => {
  it("runRadarSweep 与 runRadarSweepAtomic 的 risk 面均含连续性命中, 且既有风险语义不变", async () => {
    const root = makeRoot();
    seedBase(root);
    // 既有风险面: 伏笔超期; 连续性: 兑现 Scene 悬空。
    writeAsset(root, "structure/foreshadowing/watch.md", { id: "watch", status: "canonical", name: "怀表", planned_payoff_chapter: 2 });
    writeAsset(root, "structure/foreshadowing/f-pay.md", { id: "f-pay", status: "canonical", name: "旧约", planned_payoff_scene: "s-nope" });
    const sync = runRadarSweep(root);
    expect(sync.results.risk?.created).toBeGreaterThanOrEqual(2);
    expect(loadSignal(root, "risk-foreshadow-overdue-watch")).toBeDefined();
    expect(loadSignal(root, "risk-payoff-scene-dangling-f-pay")).toBeDefined();

    const atomic = makeRoot();
    seedBase(atomic);
    writeAsset(atomic, "structure/foreshadowing/watch.md", { id: "watch", status: "canonical", name: "怀表", planned_payoff_chapter: 2 });
    writeAsset(atomic, "structure/foreshadowing/f-pay.md", { id: "f-pay", status: "canonical", name: "旧约", planned_payoff_scene: "s-nope" });
    const atomicResult = await runRadarSweepAtomic(atomic);
    expect(atomicResult.results.risk?.created).toBeGreaterThanOrEqual(2);
    expect(loadSignal(atomic, "risk-foreshadow-overdue-watch")).toBeDefined();
    expect(loadSignal(atomic, "risk-payoff-scene-dangling-f-pay")).toBeDefined();
  });
});

describe("scene_index_conflict(N54/M13-B 批 2 第 8 项, 健康面)", () => {
  it("同章重复 scene_index → health-scene_index_conflict-chapter-<n>(risk); 不同索引零命中", () => {
    const root = makeRoot();
    seedBase(root);
    writeAsset(root, "scenes/s-a.md", { id: "s-a", status: "draft", title: "甲", scene_index: 1, chapter_ids: [2] });
    writeAsset(root, "scenes/s-b.md", { id: "s-b", status: "draft", title: "乙", scene_index: 1, chapter_ids: [2] });
    const r = runRadarSweep(root);
    expect(r.results.writing?.created).toBeGreaterThanOrEqual(1);
    const sig = loadSignal(root, "health-scene_index_conflict-chapter-2");
    expect(sig?.severity).toBe("risk");
    expect(sig?.evidence.join(" ")).toContain("s-a");
    expect(sig?.evidence.join(" ")).toContain("s-b");

    // 负例: 不同索引。
    const clean = makeRoot();
    seedBase(clean);
    writeAsset(clean, "scenes/s-a.md", { id: "s-a", status: "draft", title: "甲", scene_index: 1, chapter_ids: [2] });
    writeAsset(clean, "scenes/s-b.md", { id: "s-b", status: "draft", title: "乙", scene_index: 2, chapter_ids: [2] });
    runRadarSweep(clean);
    expect(loadSignal(clean, "health-scene_index_conflict-chapter-2")).toBeUndefined();
  });
});
