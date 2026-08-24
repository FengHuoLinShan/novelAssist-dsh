// assistant · 五面雷达行为契约(设计文档 §7 六雷达 / §11 打扰分级与静默纪律 / N3 阈值; 幂等 + 双向对账)。
// 临时目录建最小 vault(initVault + 直接写 frontmatter 文件构造场景), 风格同 test/health.test.ts。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import {
  collectRiskRadarHits,
  inboxView,
  listSignals,
  loadSignal,
  plotSummaryLine,
  pushSignal,
  reconcileRadarSignals,
  runRadarSweep,
  runRadarSweepAtomic,
  scanDedupRadar,
  scanIngestRadar,
  scanPlotRadar,
  scanRiskRadar,
  scanSuggestRadar,
  signalIdFromKey,
  signalLogicalKey,
} from "../src/index";

const dirs: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ncr-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 写 chapters/{NNN}.md(§22.2 三零填充)。 */
function seedChapter(root: string, index: number, title?: string) {
  writeFileSync(
    join(root, "chapters", `${String(index).padStart(3, "0")}.md`),
    [
      "---",
      `chapter_index: ${index}`,
      "status: published",
      'content_hash: "abc123"',
      title ? `title: ${title}` : "",
      "---",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
    "utf8",
  );
}

/** 写 scenes/{slug}.md, chapter_ids 关联章节。 */
function seedScene(root: string, slug: string, chapterIds: number[]) {
  writeFileSync(
    join(root, "scenes", `${slug}.md`),
    [
      "---",
      `id: ${slug}`,
      "status: draft",
      `title: ${slug}`,
      "source: deep_import",
      `chapter_ids: [${chapterIds.join(", ")}]`,
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** 写 world/objects/{slug}.md(值经 JSON.stringify 保证 YAML 合法)。 */
function seedObject(root: string, slug: string, fm: Record<string, unknown>) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "");
  writeFileSync(join(root, "world", "objects", `${slug}.md`), lines.join("\n"), "utf8");
}

/** 写 world/pending/{slug}.md 候选。 */
function seedPending(root: string, slug: string, fm: Record<string, unknown>) {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "");
  writeFileSync(join(root, "world", "pending", `${slug}.md`), lines.join("\n"), "utf8");
}

const ZERO = { created: 0, skipped: 0, resolved: 0, reopened: 0, total: 0 };

describe("scanIngestRadar(§7 摄入雷达)", () => {
  it("import-log 有 failed → risk 信号; 坏行跳过; done 记录不产信号", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "imports", "import-log.jsonl"),
      [
        JSON.stringify({ id: "i1", novel_id: "x", file_name: "第一章.txt", status: "failed", error_message: "解析失败", total_chapters: 3 }),
        "this-is-not-json",
        JSON.stringify({ id: "i2", novel_id: "x", file_name: "第二章.txt", status: "done", total_chapters: 3 }),
        "",
      ].join("\n"),
      "utf8",
    );
    const r = scanIngestRadar(root);
    expect(r.created).toBe(1); // §11: risk 进角标, 非静默堆积。
    const id = signalIdFromKey("ingest-failed-", signalLogicalKey("ingest", "failed", "i1", "第一章.txt"));
    const sig = loadSignal(root, id);
    expect(sig?.severity).toBe("risk");
    expect(sig?.title).toBe("导入失败: 第一章.txt");
    expect(sig?.evidence).toContain("解析失败"); // evidence 带 error_message。
    expect(sig?.proposed_action).toBe("检查文件后重新导入");
  });

  it("章无 Scene 覆盖 → note; 二次扫描幂等(skipped); 补上 Scene 后三扫自动 resolved(§11 对账语义)", () => {
    const root = makeRoot();
    seedChapter(root, 1, "第一章");
    writeFileSync(
      join(root, "imports", "import-log.jsonl"),
      JSON.stringify({ id: "i1", novel_id: "x", file_name: "坏书.txt", status: "failed", error_message: "坏", total_chapters: 0 }) + "\n",
      "utf8",
    );
    const r1 = scanIngestRadar(root);
    expect(r1.created).toBe(2); // failed + uncovered-ch1。
    expect(loadSignal(root, "ingest-uncovered-ch1")?.severity).toBe("note"); // §11: note 静默堆积。
    expect(loadSignal(root, "ingest-uncovered-ch1")?.proposed_action).toBe("对该章跑深度导入或手动关联 Scene");

    const r2 = scanIngestRadar(root);
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(2); // 幂等, 不重复堆积。

    seedScene(root, "s001", [1]); // 补上 Scene 覆盖第 1 章。
    const r3 = scanIngestRadar(root);
    expect(r3.resolved).toBe(1); // 条件消失 → open 信号自动结算(§11 静默纪律 + 双向对账)。
    expect(r3.skipped).toBe(1); // failed 记录仍在 → 命中保持。
    expect(loadSignal(root, "ingest-uncovered-ch1")?.status).toBe("resolved");
    expect(loadSignal(root, "ingest-uncovered-ch1")?.decided_at).toBeDefined();
  });
});

describe("scanDedupRadar(§7 去重雷达)", () => {
  it("两 canonical 同名同型 → 一条 risk; 作者 reject 后再扫不复活(状态仍 rejected)", () => {
    const root = makeRoot();
    seedObject(root, "a", { name: "苏 婉", entity_type: "character", status: "canonical" });
    seedObject(root, "b", { name: "苏  婉", entity_type: "character", status: "canonical" }); // 空白变体归一化后同名(R28)。
    const r1 = scanDedupRadar(root);
    expect(r1.created).toBe(1);
    const id = signalIdFromKey("dedup-l0-", signalLogicalKey("dedup", "l0", "character", "苏 婉"));
    const sig = loadSignal(root, id);
    expect(sig?.severity).toBe("risk"); // §11: risk 进角标。
    expect(sig?.title).toBe("『苏 婉』『苏  婉』疑似同一对象"); // 名称按 slug 排序。
    expect(sig?.proposed_action).toContain("去重修复");

    // 作者打回(直接改信号文件, 同 health.test.ts 手法)。
    writeFileSync(
      join(root, ".assistant", "signals", `${id}.json`),
      JSON.stringify({ ...sig, status: "rejected", decided_at: "2026-08-14T00:00:00Z" }, null, 2) + "\n",
      "utf8",
    );
    const r2 = scanDedupRadar(root);
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(loadSignal(root, id)?.status).toBe("rejected"); // 同 observation 不复活、不覆盖。
  });

  it("pending 归一化名命中 canonical aliases(不命中 name)→ hint(attach_alias 候选)", () => {
    const root = makeRoot();
    seedObject(root, "suwan", { name: "苏婉", entity_type: "character", status: "canonical", aliases: ["红衣女子"] });
    seedPending(root, "red", { name: "红衣女子", entity_type: "character", status: "pending" });
    const r = scanDedupRadar(root);
    expect(r.created).toBe(1);
    const hint = loadSignal(root, "dedup-alias-red");
    expect(hint?.severity).toBe("hint"); // §11: hint 静默堆积, 不打断。
    expect(hint?.title).toBe("『红衣女子』可能是『苏婉』的别名");
    expect(hint?.proposed_action).toBe("确认后附着别名(attach_alias)");
  });
});

describe("scanSuggestRadar(§7 建议雷达)", () => {
  it("evidence 0 条与 1 条各产信号; 2 条不产; 非 canonical 不产", () => {
    const root = makeRoot();
    seedObject(root, "empty", { name: "林晚", entity_type: "character", status: "canonical", evidence: [] });
    seedObject(root, "thin", { name: "林父", entity_type: "character", status: "canonical", evidence: ["第1章: 提及家世"] });
    seedObject(root, "rich", { name: "苏婉", entity_type: "character", status: "canonical", evidence: ["第1章", "第2章"] });
    seedObject(root, "drafty", { name: "草稿", entity_type: "character", status: "draft", evidence: [] });
    const r = scanSuggestRadar(root);
    expect(r.created).toBe(2);
    expect(loadSignal(root, "suggest-thin-empty")?.title).toBe("『林晚』的设定只出现 0 次, 建议补设定");
    expect(loadSignal(root, "suggest-thin-thin")?.title).toBe("『林父』的设定只出现 1 次, 建议补设定");
    expect(loadSignal(root, "suggest-thin-rich")).toBeUndefined();
    expect(loadSignal(root, "suggest-thin-drafty")).toBeUndefined();
    expect(loadSignal(root, "suggest-thin-empty")?.severity).toBe("note"); // §11: note 静默堆积。
  });
});

describe("scanRiskRadar(§7 风险雷达)", () => {
  it("伏笔 planned_payoff_chapter=3 且最大章=9 且无 reveal 边 → risk; 加 reveal 边后自动 resolved", () => {
    const root = makeRoot();
    for (let i = 1; i <= 9; i++) seedChapter(root, i, `第${i}章`);
    writeFileSync(
      join(root, "structure", "foreshadowing", "watch.md"),
      [
        "---",
        "id: watch",
        "status: draft",
        "name: 怀表",
        "planned_payoff_chapter: 3",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const r1 = scanRiskRadar(root);
    expect(r1.created).toBe(1);
    const sig = loadSignal(root, "risk-foreshadow-overdue-watch");
    expect(sig?.severity).toBe("risk");
    expect(sig?.title).toBe("『怀表』伏笔计划第 3 章回收, 目前已写到第 9 章");
    expect(sig?.proposed_action).toBe("安排回收或调整计划回收点");

    // reveal 资产经 relations 边 reveals_foreshadowing 指向该伏笔(ADR-0019 附录 A)。
    writeFileSync(
      join(root, "structure", "reveal", "origin.md"),
      [
        "---",
        "id: origin",
        "status: draft",
        "target_type: foreshadowing",
        "target_id: watch",
        'secret_summary: "怀表来历"',
        "relations:",
        "  - target: watch",
        "    type: reveals_foreshadowing",
        "    status: canonical",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const r2 = scanRiskRadar(root);
    expect(r2.resolved).toBe(1); // 已回收 → 条件消失自动结算(§11 对账语义)。
    expect(loadSignal(root, "risk-foreshadow-overdue-watch")?.status).toBe("resolved");
  });

  it("章断档(001/003)→ note", () => {
    const root = makeRoot();
    seedChapter(root, 1, "第一章");
    seedChapter(root, 3, "第三章");
    const r = scanRiskRadar(root);
    expect(r.created).toBe(1);
    const sig = loadSignal(root, "risk-chapter-gap-2");
    expect(sig?.severity).toBe("note"); // §11: note 静默堆积。
    expect(sig?.title).toBe("第 2 章缺失(章序号断档)");
  });

  it("悬空关系 → risk(完整 logical key 的 bounded hash id)", () => {
    const root = makeRoot();
    seedObject(root, "a", {
      name: "苏婉",
      entity_type: "character",
      status: "canonical",
      relations: [{ target: "ghost", type: "references", status: "canonical" }],
    });
    const r = scanRiskRadar(root);
    expect(r.created).toBe(1);
    const id = signalIdFromKey("risk-dangling-", signalLogicalKey("risk", "dangling_relation", "a", "ghost", "references"));
    const sig = loadSignal(root, id);
    expect(sig?.severity).toBe("risk");
    expect(sig?.title).toBe("关系边悬空: a → ghost");
    expect(sig?.proposed_action).toBe("修正或删除该关系");
  });

  it("长引用不因公共前缀碰撞；同名跨 kind 各有独立 logical key", () => {
    const root = makeRoot();
    const shared = "x".repeat(80);
    seedObject(root, "a", { name: "同名", entity_type: "character", status: "canonical", relations: [{ target: `${shared}-a`, type: "references", status: "canonical" }] });
    seedObject(root, "b", { name: "同名", entity_type: "character", status: "canonical" });
    seedObject(root, "c", { name: "同名", entity_type: "location", status: "canonical", relations: [{ target: `${shared}-b`, type: "references", status: "canonical" }] });
    seedObject(root, "d", { name: "同名", entity_type: "location", status: "canonical" });
    const dangling = collectRiskRadarHits(root).filter((hit) => hit.id?.startsWith("risk-dangling-"));
    expect(dangling).toHaveLength(2);
    expect(new Set(dangling.map((hit) => hit.id)).size).toBe(2);
    expect(scanDedupRadar(root).created).toBe(2);
    const dedup = listSignals(root).filter((signal) => signal.id.startsWith("dedup-l0-"));
    expect(new Set(dedup.map((signal) => signal.logical_key)).size).toBe(2);
  });
  it("对象 relations(list 形态)边对 radar 可见: 指向已存在对象不误报悬空(N11/N14)", () => {
    const root = makeRoot();
    seedObject(root, "a", {
      name: "苏婉",
      entity_type: "character",
      status: "canonical",
      relations: [{ target: "b", type: "associate", status: "candidate" }], // 铁律5: LLM 产出默认候选
    });
    seedObject(root, "b", { name: "克莱恩", entity_type: "character", status: "canonical" });
    const r = scanRiskRadar(root);
    // 对象边已进 index.relations 且 target 可解析 → 不产悬空 risk。
    expect(r.created).toBe(0);
    expect(loadSignal(root, "risk-dangling-a-b")).toBeUndefined();
  });
});

describe("plotSummaryLine / scanPlotRadar(§7 剧情雷达)", () => {
  it("摘要含章数/最新章/篇章/未回收伏笔/待确认; v1 不产收件箱卡片", () => {
    const root = makeRoot();
    seedChapter(root, 1, "第一章");
    seedChapter(root, 2, "第二章");
    seedChapter(root, 3, "第三章");
    writeFileSync(
      join(root, "structure", "arcs", "v1.md"),
      [
        "---",
        "id: v1",
        "status: draft",
        "title: 第一卷",
        "chapter_range: [3]",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "structure", "foreshadowing", "watch.md"),
      [
        "---",
        "id: watch",
        "status: draft",
        "name: 怀表",
        "planned_payoff_chapter: 9",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    pushSignal(root, { radar: "suggest", severity: "note", title: "t", evidence: ["e"], proposed_action: "a", reversibility: false });

    const line = plotSummaryLine(root);
    expect(line).toContain("全书 3 章");
    expect(line).toContain("最新: 第 3 章《第三章》");
    expect(line).toContain("篇章: 第一卷"); // 当前章 3 落入 arc chapter_range。
    expect(line).toContain("未回收伏笔 1 条");
    expect(line).toContain("收件箱待确认 1 件");

    // §7 剧情面 = 摘要数据源: v1 不产卡片(空命中对账)。
    const r = scanPlotRadar(root);
    expect(r).toEqual(ZERO);
    expect(inboxView(root)).toHaveLength(1);
  });
});

describe("runRadarSweep(§7 六雷达巡检)", () => {
  it("默认五面结果齐全 + plotSummary; 单面 radars:['risk'] 只跑 risk", () => {
    const root = makeRoot();
    seedChapter(root, 1, "第一章");
    writeFileSync(
      join(root, "imports", "import-log.jsonl"),
      JSON.stringify({ id: "i1", novel_id: "x", file_name: "坏书.txt", status: "failed", error_message: "坏", total_chapters: 0 }) + "\n",
      "utf8",
    );
    seedObject(root, "x1", { name: "同名", entity_type: "character", status: "canonical" });
    seedObject(root, "x2", { name: "同名", entity_type: "character", status: "canonical" });

    const s = runRadarSweep(root);
    expect(Object.keys(s.results).sort()).toEqual(["dedup", "ingest", "risk", "suggest", "writing"]);
    expect(typeof s.plotSummary).toBe("string");
    expect(s.plotSummary.length).toBeGreaterThan(0);

    const s2 = runRadarSweep(root, { radars: ["risk"] });
    expect(Object.keys(s2.results)).toEqual(["risk"]);
    expect(typeof s2.plotSummary).toBe("string");
  });

  it("新 observation 刷新证据并重开；统一 scan clock；碰撞时零写", () => {
    const root = makeRoot();
    const t0 = new Date("2026-08-24T01:02:03.000Z");
    const key = signalLogicalKey("test", "mutable");
    const id = signalIdFromKey("risk-test-", key);
    const base = {
      id, logical_key: key, radar: "risk" as const, severity: "risk" as const,
      title: "旧观察", evidence: ["旧证据"], proposed_action: "复核", reversibility: true,
    };
    reconcileRadarSignals(root, "risk-test-", [base], t0);
    expect(loadSignal(root, id)?.observed_at).toBe(t0.toISOString());
    reconcileRadarSignals(root, "risk-test-", [], new Date("2026-08-24T02:00:00.000Z"));
    const t1 = new Date("2026-08-24T03:00:00.000Z");
    const reopened = reconcileRadarSignals(root, "risk-test-", [{ ...base, title: "新观察", evidence: ["新证据"] }], t1);
    expect(reopened.reopened).toBe(1);
    expect(loadSignal(root, id)).toMatchObject({ status: "open", title: "新观察", evidence: ["新证据"], observed_at: t1.toISOString() });

    const before = listSignals(root).length;
    expect(() => reconcileRadarSignals(root, "risk-collision-", [
      { ...base, id: "risk-collision-same", logical_key: signalLogicalKey("collision", "a") },
      { ...base, id: "risk-collision-same", logical_key: signalLogicalKey("collision", "b") },
    ])).toThrow(/碰撞/);
    expect(listSignals(root)).toHaveLength(before);
  });

  it("atomic sweep 将一轮 Signal 变化提交为一个 state transaction", async () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "imports", "import-log.jsonl"),
      JSON.stringify({ id: "atomic-1", file_name: "坏书.txt", status: "failed", error_message: "坏" }) + "\n",
      "utf8",
    );
    const before = (await import("@novelcraft/store")).gitHead(root);
    const first = await runRadarSweepAtomic(root, { radars: ["ingest", "suggest"] });
    const after = (await import("@novelcraft/store")).gitHead(root);
    expect(first.results.ingest?.created).toBe(1);
    expect(after).not.toBe(before);
    const changed = (await import("@novelcraft/store")).gitRead(root, ["show", "--pretty=", "--name-only", after]);
    expect(changed.split(/\r?\n/).filter(Boolean).every((path) => path.startsWith(".assistant/signals/"))).toBe(true);
    const second = await runRadarSweepAtomic(root, { radars: ["ingest", "suggest"] });
    expect(second.results.ingest?.skipped).toBe(1);
    expect((await import("@novelcraft/store")).gitHead(root)).toBe(after);
  });

  it("空 vault(仅 book.yml + 目录骨架)→ 全面零计数不炸", () => {
    const root = makeRoot();
    expect(scanIngestRadar(root)).toEqual(ZERO);
    expect(scanDedupRadar(root)).toEqual(ZERO);
    expect(scanSuggestRadar(root)).toEqual(ZERO);
    expect(scanRiskRadar(root)).toEqual(ZERO);
    expect(scanPlotRadar(root)).toEqual(ZERO);
    const s = runRadarSweep(root);
    for (const k of ["ingest", "dedup", "suggest", "risk", "writing"] as const) {
      expect(s.results[k]).toEqual(ZERO);
    }
    expect(s.plotSummary).toContain("全书 0 章");
  });
});
