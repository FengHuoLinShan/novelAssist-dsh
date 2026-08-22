// R6 assistant 核心行为契约(设计文档 §8/§9/§11 + N1/N3)
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import {
  appendCalibration,
  createSignal,
  HEALTH_KEYS,
  inboxView,
  isStale,
  listSignals,
  loadSignal,
  needsAttention,
  pushSignal,
  readCalibration,
  recordRejection,
  saveSignal,
  sortInbox,
} from "../src/index";
import { act } from "../src/index";
import { buildMicroflowPlan, listMicroflows, routeMicroflow, validateMicroflowArgs } from "../src/index";

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

// 文件 symlink 探测(Windows 需开发者模式/管理员; 失败则整组跳过)。
let symlinkCapable: boolean | undefined;
function symlinksSupported(): boolean {
  if (symlinkCapable === undefined) {
    const probe = mkdtempSync(join(tmpdir(), "nca-link-"));
    try {
      const target = join(probe, "t");
      const link = join(probe, "l");
      writeFileSync(target, "x");
      symlinkSync(target, link);
      symlinkCapable = true;
    } catch {
      symlinkCapable = false;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }
  return symlinkCapable;
}

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

describe("listSignals(R12 目录容错 + R9 fail-closed)", () => {
  it("坏普通 JSON 与好 signal 并存 → 只返回好; 垃圾对象不进 sort", () => {
    const root = makeRoot();
    pushSignal(root, {
      radar: "dedup", severity: "risk", title: "合并 A/B", evidence: ["e"],
      proposed_action: "merge", reversibility: true,
    });
    const dir = paths(root).assistant.signals;
    // 普通损坏 JSON(非 symlink)与各种垃圾对象——全部按文件 skip。
    writeFileSync(join(dir, "broken.json"), "{not valid json", "utf8");
    writeFileSync(join(dir, "garbage.json"), JSON.stringify({ foo: 1 }), "utf8"); // 对象但非 Signal
    writeFileSync(join(dir, "array.json"), JSON.stringify([1, 2, 3]), "utf8"); // 顶层数组
    writeFileSync(join(dir, "missing-fields.json"), JSON.stringify({ id: "x", title: "缺字段" }), "utf8");
    writeFileSync(join(dir, "null.json"), "null", "utf8");
    const signals = listSignals(root);
    expect(signals).toHaveLength(1); // 只返回好信号
    expect(signals[0].title).toBe("合并 A/B");
    expect(inboxView(root)).toHaveLength(1); // 排序/过滤不被垃圾对象炸
    expect(needsAttention(root, 1)).toBe(true);
  });

  it("指向 vault 外 symlink 仍 fail-closed 抛(不吞、不读)", () => {
    const root = makeRoot();
    pushSignal(root, {
      radar: "suggest", severity: "note", title: "t", evidence: ["e"],
      proposed_action: "a", reversibility: false,
    });
    const dir = paths(root).assistant.signals;
    const outside = join(tmpdir(), `nca-outside-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(outside, JSON.stringify({ id: "evil", status: "open", radar: "risk", severity: "risk", title: "x", proposed_action: "x", evidence: ["e"], observed_at: "2026-01-01T00:00:00.000Z" }), "utf8");
    symlinkSync(outside, join(dir, "evil.json"));
    try {
      // 逐文件 guardPath 在 try/catch 外: 路径逃逸错误必须抛, 不得被坏 JSON 容错吞掉。
      expect(() => listSignals(root)).toThrow(/escapes vault root/i);
      expect(() => inboxView(root)).toThrow(/escapes vault root/i);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("saveSignal/loadSignal symlink fail-closed(R9: 同目录内部 symlink 不跟随, 审批看到 a 不能改 b)", () => {
  it.skipIf(!symlinksSupported())("内部 symlink a.json→b.json: save/load/act 拒绝, b 哨兵不变", () => {
    const root = makeRoot();
    const dir = paths(root).assistant.signals;
    const b = join(dir, "sig-b.json");
    const sentinel = JSON.stringify({
      id: "sig-b", status: "open", radar: "dedup", severity: "risk", title: "B",
      evidence: ["e"], proposed_action: "a", reversibility: true,
      observed_at: "2026-01-01T00:00:00.000Z",
    });
    writeFileSync(b, sentinel, "utf8");
    symlinkSync(b, join(dir, "sig-a.json")); // 同目录内部 symlink。
    const sigA = createSignal({ radar: "dedup", severity: "risk", title: "A", evidence: ["e"], proposed_action: "a", reversibility: true, id: "sig-a" });
    // guardPath 的 real containment 放行 root 内 symlink; 最终目标必须逐段 lstat 拒绝。
    expect(() => saveSignal(root, sigA)).toThrow(/symlink/i); // 写不跟随: a 不改 b。
    expect(readFileSync(b, "utf8")).toBe(sentinel); // b 哨兵不变。
    expect(() => loadSignal(root, "sig-a")).toThrow(/symlink/i); // 读不跟随。
    expect(() => act(root, { signalId: "sig-a", action: "accept" })).toThrow(/symlink/i); // 审批看到 a 不能改 b。
  });

  it.skipIf(!symlinksSupported())("listSignals/inboxView 遇内部 symlink fail-closed 抛(不吞)", () => {
    const root = makeRoot();
    pushSignal(root, { radar: "suggest", severity: "note", title: "t", evidence: ["e"], proposed_action: "a", reversibility: false });
    const dir = paths(root).assistant.signals;
    const b = join(dir, "sig-b.json");
    writeFileSync(b, JSON.stringify({ id: "sig-b", status: "open", radar: "dedup", severity: "risk", title: "B", evidence: ["e"], proposed_action: "a", reversibility: true, observed_at: "2026-01-01T00:00:00.000Z" }), "utf8");
    symlinkSync(b, join(dir, "sig-a.json"));
    // guard 在 try/catch 外: symlink 安全错误必须抛, 不得被坏 JSON 容错吞掉。
    expect(() => listSignals(root)).toThrow(/symlink/i);
    expect(() => inboxView(root)).toThrow(/symlink/i);
  });

  it.skipIf(!symlinksSupported())("外部 symlink 语义保持: saveSignal 拒绝, 外部哨兵不变", () => {
    const root = makeRoot();
    const outside = join(tmpdir(), `nca-out-sig-${Date.now()}.json`);
    writeFileSync(outside, "外部哨兵, 不得被改写");
    try {
      const dir = paths(root).assistant.signals;
      symlinkSync(outside, join(dir, "evil.json"));
      const s = createSignal({ radar: "dedup", severity: "risk", title: "t", evidence: ["e"], proposed_action: "a", reversibility: true, id: "evil" });
      expect(() => saveSignal(root, s)).toThrow(/escapes vault root/);
      expect(readFileSync(outside, "utf8")).toBe("外部哨兵, 不得被改写");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it.skipIf(!symlinksSupported())("悬空 symlink → loadSignal/saveSignal fail-closed(不跟随创建)", () => {
    const root = makeRoot();
    const dir = paths(root).assistant.signals;
    symlinkSync(join(dir, "no-such.json"), join(dir, "dangling.json"));
    expect(() => loadSignal(root, "dangling")).toThrow();
    const s = createSignal({ radar: "dedup", severity: "risk", title: "t", evidence: ["e"], proposed_action: "a", reversibility: true, id: "dangling" });
    expect(() => saveSignal(root, s)).toThrow();
  });

  it.skipIf(!symlinksSupported())("普通信号(无 symlink)save/load/act 行为不变", () => {
    const root = makeRoot();
    const s = createSignal({ radar: "dedup", severity: "risk", title: "合并 A/B", evidence: ["e"], proposed_action: "merge", reversibility: true, id: "sig-ok" });
    saveSignal(root, s);
    expect(loadSignal(root, "sig-ok")?.title).toBe("合并 A/B");
    expect(act(root, { signalId: "sig-ok", action: "accept" }).signal.status).toBe("accepted");
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

describe("microflows(D7 首批 6 条, R6 骨架)", () => {
  it("目录 6 条", () => {
    expect(listMicroflows()).toEqual(["去重修复", "Scene 重切", "补设定", "审章", "改对象名", "续写提案"]);
  });
  it("关键词路由(确定性兜底)", () => {
    expect(routeMicroflow("「红衣女子」和「苏婉」重复了")).toBe("去重修复");
    expect(routeMicroflow("第 3 章场景拆太细了")).toBe("Scene 重切");
    expect(routeMicroflow("补一下林晚的家族")).toBe("补设定");
    expect(routeMicroflow("随便聊聊天")).toBeNull();
  });
  it("参数校验: 缺参/类型错拒绝", () => {
    expect(validateMicroflowArgs("去重修复", {})).toHaveLength(1);
    expect(validateMicroflowArgs("去重修复", { targets: ["a"] })).toHaveLength(0);
    expect(validateMicroflowArgs("审章", { chapter: "三" })).toHaveLength(1);
  });
  it("计划: 合法参数给出阶段函数引用表", () => {
    const p = buildMicroflowPlan("Scene 重切", { chapters: [3] });
    expect(p.ok).toBe(true);
    expect(p.steps[0]).toEqual({ pkg: "imports", fn: "sliceChapterBatch", args: "chapterIndices=chapters" });
  });
});
