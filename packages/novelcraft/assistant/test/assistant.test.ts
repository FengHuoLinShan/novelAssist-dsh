// R6 assistant 核心行为契约(设计文档 §8/§9/§11 + N1/N3)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import {
  appendCalibration,
  createSignal,
  HEALTH_KEYS,
  inboxView,
  isStale,
  needsAttention,
  pushSignal,
  readCalibration,
  recordRejection,
  sortInbox,
} from "../src/index";
import { act } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "nca-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("createSignal(§8 信号模型)", () => {
  it("合法创建, 状态 open", () => {
    const s = createSignal({
      radar: "dedup",
      severity: "risk",
      title: "「苏婉」与「红衣女子」疑似同一人",
      evidence: ["第 7 章: ……"],
      proposed_action: "合并为同一实体",
      reversibility: true,
      confidence: 0.8,
    });
    expect(s.status).toBe("open");
    expect(s.radar).toBe("dedup");
  });
  it("非法 radar/severity/空 title/无 evidence/越界 confidence 拒绝", () => {
    const base = { radar: "dedup" as const, severity: "risk" as const, title: "t", evidence: ["e"], proposed_action: "a", reversibility: true };
    expect(() => createSignal({ ...base, radar: "nope" as never })).toThrow(/radar/);
    expect(() => createSignal({ ...base, severity: "boom" as never })).toThrow(/severity/);
    expect(() => createSignal({ ...base, title: "  " })).toThrow(/title/);
    expect(() => createSignal({ ...base, evidence: [] })).toThrow(/evidence/);
    expect(() => createSignal({ ...base, confidence: 1.5 })).toThrow(/confidence/);
  });
});

describe("sortInbox(§9 风险前置)", () => {
  it("conflict > risk > note > hint", () => {
    const mk = (severity: Parameters<typeof createSignal>[0]["severity"]) =>
      createSignal({ radar: "writing", severity, title: severity, evidence: ["e"], proposed_action: "a", reversibility: false });
    const sorted = sortInbox([mk("hint"), mk("conflict"), mk("note"), mk("risk")]);
    expect(sorted.map((s) => s.severity)).toEqual(["conflict", "risk", "note", "hint"]);
  });
});

describe("isStale(§8 新鲜度)", () => {
  it("正文哈希变化 → 过期; 未标 expires 不过期", () => {
    const s = createSignal({
      radar: "writing", severity: "note", title: "t", evidence: ["e"],
      proposed_action: "a", reversibility: false,
      expires_when_draft_changes: true,
      target: { content_hash: "aaa" },
    });
    expect(isStale(s, "bbb")).toBe(true);
    expect(isStale(s, "aaa")).toBe(false);
    const s2 = createSignal({ radar: "plot", severity: "note", title: "t", evidence: ["e"], proposed_action: "a", reversibility: false });
    expect(isStale(s2, "zzz")).toBe(false);
  });
});

describe("inboxView / needsAttention(N3 阈值)", () => {
  it("只列 open 且新鲜的信号, 阈值 5 触发", () => {
    const root = makeRoot();
    for (let i = 0; i < 4; i++) {
      pushSignal(root, { radar: "suggest", severity: "note", title: `t${i}`, evidence: ["e"], proposed_action: "a", reversibility: false });
    }
    expect(needsAttention(root)).toBe(false);
    pushSignal(root, { radar: "suggest", severity: "note", title: "t4", evidence: ["e"], proposed_action: "a", reversibility: false });
    expect(needsAttention(root)).toBe(true);
    expect(inboxView(root)).toHaveLength(5);
  });
});

describe("act(§9 四动词)", () => {
  it("accept → adopt 描述符, 状态 accepted, 重复动作拒绝", () => {
    const root = makeRoot();
    const s = pushSignal(root, { radar: "dedup", severity: "risk", title: "合并 A/B", evidence: ["e"], proposed_action: "merge", reversibility: true });
    const d = act(root, { signalId: s.id, action: "accept" });
    expect(d.kind).toBe("adopt");
    expect(d.signal.status).toBe("accepted");
    expect(() => act(root, { signalId: s.id, action: "accept" })).toThrow(/已处理/);
  });
  it("reject 必须带理由 → 校准可读回", () => {
    const root = makeRoot();
    const s = pushSignal(root, { radar: "dedup", severity: "risk", title: "合并 A/B", evidence: ["e"], proposed_action: "merge", reversibility: true });
    expect(() => act(root, { signalId: s.id, action: "reject" })).toThrow(/理由/);
    act(root, { signalId: s.id, action: "reject", reason: "这两个不是同一人" });
    recordRejection(root, s.id, "这两个不是同一人");
    expect(readCalibration(root).some((c) => c.value === s.id)).toBe(true);
  });
  it("modify → microflow 描述符(去重修复)", () => {
    const root = makeRoot();
    const s = pushSignal(root, { radar: "dedup", severity: "risk", title: "合并 A/B", evidence: ["e"], proposed_action: "merge", reversibility: true });
    const d = act(root, { signalId: s.id, action: "modify", reason: "改成合并 A/C", modified: { title: "合并 A/C" } });
    expect(d.kind).toBe("microflow");
    expect(d.microflow).toBe("去重修复");
  });
  it("defer → record, 状态 deferred", () => {
    const root = makeRoot();
    const s = pushSignal(root, { radar: "suggest", severity: "note", title: "t", evidence: ["e"], proposed_action: "a", reversibility: false });
    const d = act(root, { signalId: s.id, action: "defer" });
    expect(d.kind).toBe("record");
    expect(d.signal.status).toBe("deferred");
  });
});

describe("calibration(append-only, 与 policy 覆盖链兼容)", () => {
  it("追加 + 读回 key/value/reason", () => {
    const root = makeRoot();
    appendCalibration(root, { key: "alias_attach_confidence", value: "0.9", reason: "此书同名不同人习惯" });
    const entries = readCalibration(root);
    expect(entries.some((e) => e.key === "alias_attach_confidence" && e.value === "0.9")).toBe(true);
  });
});

describe("HEALTH_KEYS(N1 六键词汇表)", () => {
  it("固定 6 键", () => {
    expect(HEALTH_KEYS).toEqual([
      "scene_unreviewed", "scene_unassigned_chapter", "scene_missing_setup",
      "scene_needs_organize", "structure_needs_review", "structure_unassigned",
    ]);
  });
});
