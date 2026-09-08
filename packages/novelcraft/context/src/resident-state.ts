// resident-state · 常驻创作状态快照(N53 / M13-A): 纯编译器, 输入由 dsh 适配层采集。
// 设计: 不复用 compileContext(那是按预算驱逐的装箱器), 快照要求完整小体积、可反复重算、
// 字节级确定性(同输入同输出, 供 golden 测试与 hash 记录)。
// 精简 v1 范围(用户裁定 2026-09-08): 书名/章游标/结构与场景状态计数/逾期伏笔 top-N/
// open 信号按严重度计数; 不含正文、绝对路径、记忆投影明细。
import { estimateContextTokens } from "./context.js";

/** 逾期伏笔最多列出的条数(其余只计总数)。 */
export const RESIDENT_FORESHADOWING_TOP_N = 5;

/** dsh 适配层采集的原始读面(自持 plain 类型, 零跨包 import)。 */
export interface ResidentStateInput {
  book: string;
  chapters: Array<{ index: number; title?: string }>;
  scenes: Array<{ slug: string; status: string }>;
  threads: Array<{ slug: string; name: string; status: string }>;
  arcs: Array<{ slug: string; name: string; status: string }>;
  foreshadowing: Array<{
    slug: string;
    name: string;
    status: string;
    plannedPayoffChapter?: number;
    /** 已被 reveal 资产指向(dsh 层从 storyMap 派生)。 */
    revealed: boolean;
  }>;
  /** open 且未过期信号的严重度(inboxView 投影)。 */
  openSignals?: Array<{ severity: string }>;
}

/** 派生后的结构快照(全部确定性字段)。 */
export interface ResidentStateSnapshot {
  book: string;
  chapterCount: number;
  latestChapter: { index: number; title?: string } | undefined;
  /** status → 数量; 键按码元序(渲染确定性不依赖输入顺序)。 */
  arcStatus: Record<string, number>;
  threadStatus: Record<string, number>;
  sceneStatus: Record<string, number>;
  overdueForeshadowing: Array<{ name: string; plannedPayoffChapter: number }>;
  overdueForeshadowingTotal: number;
  openSignals: Array<{ severity: string; count: number }>;
}

function countByStatus(items: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function countSignals(openSignals: Array<{ severity: string }>): Array<{ severity: string; count: number }> {
  const counts: Record<string, number> = {};
  for (const s of openSignals) counts[s.severity] = (counts[s.severity] ?? 0) + 1;
  return Object.entries(counts)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([severity, count]) => ({ severity, count }));
}

/** 编译快照: 逾期伏笔 = plannedPayoffChapter < 当前最大章 且未被 reveal 且未 archived。 */
export function buildResidentState(input: ResidentStateInput): ResidentStateSnapshot {
  const latestChapter = input.chapters.length > 0
    ? input.chapters.reduce((acc, c) => (c.index > acc.index ? c : acc))
    : undefined;
  const currentMaxChapter = latestChapter?.index ?? 0;

  const overdue = input.foreshadowing
    .filter((f) =>
      f.status !== "archived"
      && !f.revealed
      && typeof f.plannedPayoffChapter === "number"
      && f.plannedPayoffChapter < currentMaxChapter)
    .map((f) => ({ name: f.name || f.slug, plannedPayoffChapter: f.plannedPayoffChapter! }))
    .sort((a, b) =>
      a.plannedPayoffChapter - b.plannedPayoffChapter
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    book: input.book || "未知书名",
    chapterCount: input.chapters.length,
    latestChapter,
    arcStatus: countByStatus(input.arcs),
    threadStatus: countByStatus(input.threads),
    sceneStatus: countByStatus(input.scenes),
    overdueForeshadowing: overdue.slice(0, RESIDENT_FORESHADOWING_TOP_N),
    overdueForeshadowingTotal: overdue.length,
    openSignals: countSignals(input.openSignals ?? []),
  };
}

export interface RenderResidentStateOptions {
  /** 渲染 token 上界(estimateContextTokens 口径); 超出按降级阶梯收缩。 */
  maxTokens?: number;
}

const RESIDENT_STATE_BUDGET_DEFAULT = 600;

function joinStatusCounts(label: string, counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return `${label}: 0`;
  return `${label}: ${entries.map(([k, v]) => `${k} ${v}`).join(" / ")}`;
}

function joinSignals(signals: Array<{ severity: string; count: number }>): string {
  if (signals.length === 0) return "待处理信号: 0";
  return `待处理信号: ${signals.map((s) => `${s.severity} ${s.count}`).join(" / ")}`;
}

function fullRender(s: ResidentStateSnapshot, overdueDetail: boolean, statusDetail: boolean): string {
  const lines: string[] = [`书名: 《${s.book}》`];
  lines.push(s.latestChapter
    ? `章节: 共 ${s.chapterCount} 章, 最新第 ${s.latestChapter.index} 章${s.latestChapter.title ? `「${s.latestChapter.title}」` : ""}`
    : "章节: 尚无章节");
  if (statusDetail) {
    lines.push(joinStatusCounts("剧情线", s.threadStatus));
    lines.push(joinStatusCounts("篇章", s.arcStatus));
    lines.push(joinStatusCounts("场景", s.sceneStatus));
  }
  if (s.overdueForeshadowingTotal > 0) {
    const head = overdueDetail
      ? s.overdueForeshadowing.map((f) => `「${f.name}」计划第 ${f.plannedPayoffChapter} 章回收`).join("、")
      : "";
    lines.push(`逾期伏笔: ${s.overdueForeshadowingTotal} 条${head ? `(${head})` : ""}`);
  }
  lines.push(joinSignals(s.openSignals));
  return lines.join("\n");
}

/**
 * 中和宿主 system-prompt 的严格 `{{}}` 变量插值(N53 二轮评审 P1): 快照正文嵌入
 * vault 自由文本(书名/章标题/伏笔名/状态键), 裸 `{{` 会让 dsh-system-prompt 的
 * interpolate 遇未知变量直接 throw, 打断该会话每次请求的快照渲染。零宽间隔后
 * 仍可读且不可再匹配变量语法。
 */
export function sanitizePromptVars(text: string): string {
  return text.replaceAll("{{", "{\u200b{");
}

/**
 * 渲染为紧凑中文文本(常驻 user-role snapshot 的正文)。
 * 超预算降级阶梯(确定性): ①去掉伏笔明细只留总数 → ②去掉状态计数行 → ③硬截断加省略标记;
 * 书名与章游标永不降级。所有返回文本经 sanitizePromptVars(预算口径同样按中和后文本)。
 */
export function renderResidentState(
  snapshot: ResidentStateSnapshot,
  opts: RenderResidentStateOptions = {},
): string {
  const maxTokens = opts.maxTokens ?? RESIDENT_STATE_BUDGET_DEFAULT;

  const levels = [
    sanitizePromptVars(fullRender(snapshot, true, true)),
    sanitizePromptVars(fullRender(snapshot, false, true)),
    sanitizePromptVars(fullRender(snapshot, false, false)),
  ];
  for (const text of levels) {
    if (estimateContextTokens(text) <= maxTokens) return text;
  }
  // 硬截断(保留头部, 标注省略): 比例迭代收敛到预算内。base 已中和, 切片与静态
  // 后缀拼接不会再产生新的 `{{`。
  const base = levels[levels.length - 1];
  let ratio = Math.min(0.9, maxTokens / Math.max(1, estimateContextTokens(base)));
  let text = base;
  for (let i = 0; i < 8 && estimateContextTokens(text) > maxTokens; i += 1) {
    text = base.slice(0, Math.max(1, Math.floor(base.length * ratio))) + "…(截断)";
    ratio *= 0.8;
  }
  return text;
}
