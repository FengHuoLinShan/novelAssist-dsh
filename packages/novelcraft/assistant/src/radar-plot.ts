// assistant · 剧情雷达(plot-, 确定性, 非 LLM, 零 DSH 依赖)。
// 依据: 设计文档 §7 剧情雷达(当前剧情状态摘要、进度感)、§11 剧情摘要永远一句话、作者语言、零 raw 数据
// (点击宠物的默认答复)。
// v1 不产生收件箱卡片: 剧情面 = 摘要数据源; scanPlotRadar 保留对账语义(空命中集), 未来加卡片时旧信号自动结算。
import { storyMap, type StoryMap } from "@novelcraft/store";
import { inboxView } from "./inbox.js";
import { reconcileRadarSignals, type RadarReconcileResult } from "./radar-utils.js";

/** 确定性一句话剧情摘要(作者语言, §7/§11): 章数/最新章/当前篇章/未回收伏笔/待确认。 */
export function plotSummaryLine(root: string): string {
  const map = storyMap(root);
  const openCount = inboxView(root).length;
  return plotSummaryFromStoryMap(map, openCount);
}

/** sweep 已有 snapshot 时复用，避免再次扫描 Vault/Signal。 */
export function plotSummaryFromStoryMap(map: StoryMap, openCount: number): string {
  const maxChapter = map.chapters.reduce((m, c) => Math.max(m, c.index), 0);
  const latest = map.chapters.find((c) => c.index === maxChapter);

  // 未回收伏笔 = 无 reveals_foreshadowing 边指向它的 foreshadowing(ADR-0019 附录 A)。
  const uncollected = map.foreshadowing.filter(
    (f) => !map.edges.some((e) => e.type === "reveals_foreshadowing" && e.target === f.slug),
  ).length;

  // 当前章落入 chapter_range 的 arc 名; 多个取 name 字典序首个(确定性); 无则「未归档」。
  const currentArc = map.arcs
    .filter((a) => a.chapter_range?.includes(maxChapter))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))[0];

  const latestText = latest
    ? latest.title
      ? `第 ${latest.index} 章《${latest.title}》`
      : `第 ${latest.index} 章`
    : "无";
  const arcText = currentArc ? currentArc.name : "未归档";
  return [
    `全书 ${map.chapters.length} 章`,
    `最新: ${latestText}`,
    `篇章: ${arcText}`,
    `未回收伏笔 ${uncollected} 条`,
    `待处理 ${openCount} 件`,
  ].join(" · ");
}

/** 剧情雷达 v1: 不产卡片, 空命中对账(未来加卡片时旧 plot- 信号自动结算)。 */
export function scanPlotRadar(root: string, now?: Date): RadarReconcileResult {
  return reconcileRadarSignals(root, "plot-", [], now);
}
