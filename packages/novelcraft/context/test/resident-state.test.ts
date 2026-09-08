// resident-state 行为契约(N53 / M13-A): 确定性快照编译 + 预算降级渲染。
import { describe, expect, it } from "vitest";
import {
  buildResidentState,
  estimateContextTokens,
  renderResidentState,
  RESIDENT_FORESHADOWING_TOP_N,
} from "../src/index";

const baseInput = {
  book: "长夜",
  chapters: [
    { index: 1, title: "北风" },
    { index: 2, title: "旧约" },
    { index: 9, title: "断桥" },
  ],
  scenes: [
    { slug: "s1", status: "canonical" },
    { slug: "s2", status: "canonical" },
    { slug: "s3", status: "draft" },
  ],
  threads: [
    { slug: "t1", name: "复仇线", status: "canonical" },
    { slug: "t2", name: "身世线", status: "draft" },
  ],
  arcs: [{ slug: "a1", name: "第一卷", status: "canonical" }],
  foreshadowing: [
    { slug: "f1", name: "玉佩", status: "canonical", plannedPayoffChapter: 3, revealed: false },
    { slug: "f2", name: "密信", status: "canonical", plannedPayoffChapter: 5, revealed: false },
    { slug: "f3", name: "旧伤", status: "canonical", plannedPayoffChapter: 7, revealed: true },
    { slug: "f4", name: "归档物", status: "archived", plannedPayoffChapter: 1, revealed: false },
    { slug: "f5", name: "未来物", status: "canonical", plannedPayoffChapter: 20, revealed: false },
  ],
  openSignals: [
    { severity: "risk" },
    { severity: "risk" },
    { severity: "note" },
  ],
};

describe("buildResidentState(纯派生)", () => {
  it("章游标取最大 index; 逾期=计划回收章<当前最大章且未 reveal 且未 archived", () => {
    const s = buildResidentState(baseInput);
    expect(s.latestChapter).toEqual({ index: 9, title: "断桥" });
    expect(s.chapterCount).toBe(3);
    // f1(3<9 未揭示)与 f2(5<9 未揭示)逾期; f3 已揭示、f4 已归档、f5 未到期。
    expect(s.overdueForeshadowingTotal).toBe(2);
    expect(s.overdueForeshadowing.map((f) => f.name)).toEqual(["玉佩", "密信"]);
  });
  it("状态计数键按码元序(不依赖输入顺序)", () => {
    const a = buildResidentState(baseInput);
    const b = buildResidentState({
      ...baseInput,
      scenes: [...baseInput.scenes].reverse(),
      threads: [...baseInput.threads].reverse(),
    });
    expect(Object.keys(a.sceneStatus)).toEqual(Object.keys(b.sceneStatus));
    expect(a.sceneStatus).toEqual({ canonical: 2, draft: 1 });
  });
  it("逾期 top-N 截断且按计划回收章升序再按名", () => {
    const many = Array.from({ length: RESIDENT_FORESHADOWING_TOP_N + 3 }, (_, i) => ({
      slug: `f${i}`,
      name: `伏笔${i}`,
      status: "canonical",
      plannedPayoffChapter: i + 1,
      revealed: false,
    }));
    const s = buildResidentState({
      ...baseInput,
      foreshadowing: many,
    });
    expect(s.overdueForeshadowing).toHaveLength(RESIDENT_FORESHADOWING_TOP_N);
    expect(s.overdueForeshadowingTotal).toBe(RESIDENT_FORESHADOWING_TOP_N + 3);
    expect(s.overdueForeshadowing[0].name).toBe("伏笔0");
  });
  it("空 vault 容错: 无章节无结构无信号", () => {
    const s = buildResidentState({
      book: "",
      chapters: [],
      scenes: [],
      threads: [],
      arcs: [],
      foreshadowing: [],
    });
    expect(s.book).toBe("未知书名");
    expect(s.latestChapter).toBeUndefined();
    expect(s.overdueForeshadowingTotal).toBe(0);
    expect(s.openSignals).toEqual([]);
  });
});

describe("renderResidentState(确定性 + 预算降级)", () => {
  it("同输入字节级一致(golden 锚)", () => {
    const s = buildResidentState(baseInput);
    const r1 = renderResidentState(s);
    const r2 = renderResidentState(buildResidentState(baseInput));
    expect(r1).toBe(r2);
    expect(r1).toContain("《长夜》");
    expect(r1).toContain("最新第 9 章「断桥」");
    expect(r1).toContain("逾期伏笔: 2 条");
    expect(r1).toContain("计划第 3 章回收");
    expect(r1).toContain("note 1 / risk 2");
  });
  it("预算充足含全部段落; 最小预算严守上界并保留书名行与游标", () => {
    const s = buildResidentState(baseInput);
    const full = renderResidentState(s, { maxTokens: 600 });
    expect(full).toContain("剧情线:");
    expect(full).toContain("场景:");

    const longBook = { ...s, book: "长".repeat(1_000) };
    const compact = renderResidentState(longBook, { maxTokens: 200 });
    expect(compact).toContain("书名: 《长");
    expect(compact).toContain("最新第 9 章");
    expect(compact).toContain("…(截断)");
    expect(estimateContextTokens(compact)).toBeLessThanOrEqual(200);
    expect(() => renderResidentState(s, { maxTokens: 199 })).toThrow(/maxTokens/);
  });
  it("无逾期伏笔时不出现伏笔行; 无信号时显示 0", () => {
    const s = buildResidentState({ ...baseInput, foreshadowing: [], openSignals: [] });
    const r = renderResidentState(s);
    expect(r).not.toContain("逾期伏笔");
    expect(r).toContain("待处理信号: 0");
  });
  it("vault 自由文本含 {{变量}} 时统一中和: 渲染无裸 {{, 硬截断路径同样安全(N53 二轮评审 P1)", () => {
    const hostile = buildResidentState({
      book: "草{{draft}}稿".repeat(100),
      chapters: [{ index: 1, title: "{{spoiler}}" }, { index: 2, title: "正常" }],
      scenes: [{ slug: "s1", status: "{{evil}}" }],
      threads: [],
      arcs: [],
      foreshadowing: [
        { slug: "f1", name: "{{leak}}", status: "canonical", plannedPayoffChapter: 1, revealed: false },
      ],
      openSignals: [{ severity: "{{risk}}" }],
    });
    for (const maxTokens of [600, 200]) {
      const r = renderResidentState(hostile, { maxTokens });
      // N53 二轮评审 P1: 裸 {{ 会让宿主 dsh-system-prompt interpolate 抛 unknown
      // prompt variable, 打断该会话每次请求的快照渲染——任何预算档都必须中和。
      expect(r).not.toContain("{{");
      expect(r).toContain("草");
      if (maxTokens === 600) {
        expect(r).toContain("稿");
        expect(r).toContain("逾期伏笔: 1 条");
        expect(r).toContain("{\u200b{leak}"); // 明细中的伏笔名也被中和
      }
    }
  });
});
