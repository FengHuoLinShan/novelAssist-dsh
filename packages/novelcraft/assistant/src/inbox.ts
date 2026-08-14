// assistant 核心 · 收件箱(R6 纯 TS 部分)。
// 依据: 设计文档 §9(四动词) + §11(阈值触发 N3: notify_threshold=5)。
// 本层只做「决定记录 + 动作描述符」; 实际资产写入由上层调用 store 完成
// (adopt/merge 等), 收件箱永不直接改资产。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@novelcraft/vault";
import { createSignal, isStale, sortInbox, type Signal, type SignalStatus } from "./signals";

export type InboxAction = "accept" | "reject" | "modify" | "defer";

export interface ActInput {
  signalId: string;
  action: InboxAction;
  /** 打回/修改必须带一句话理由(校准原料, §9) */
  reason?: string;
  /** modify: 修改后的 title/proposed_action(可选项) */
  modified?: { title?: string; proposed_action?: string };
}

export interface ActionDescriptor {
  signal: Signal;
  action: InboxAction;
  /** 上层据此执行: accept→adopt 对应资产; modify→触发微工作流; 其余无资产动作 */
  kind: "adopt" | "microflow" | "record";
  /** 微工作流名(modify 时给出, 供意图路由) */
  microflow?: string;
}

/** 保存信号(单文件即状态, 覆盖写)。 */
export function saveSignal(root: string, signal: Signal): void {
  const p = paths(root);
  writeFileSync(p.assistant.signalFile(signal.id), JSON.stringify(signal, null, 2) + "\n", "utf8");
}

/** 读单信号; 不存在返回 undefined。 */
export function loadSignal(root: string, signalId: string): Signal | undefined {
  const p = paths(root);
  const file = p.assistant.signalFile(signalId);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Signal;
}

/** 列出全部信号(读 signals 目录)。 */
export function listSignals(root: string): Signal[] {
  const p = paths(root);
  const dir = p.assistant.signals;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Signal);
}

/** 收件箱视图: 过滤新鲜信号, 风险前置排序(§8/§9)。 */
export function inboxView(root: string, currentContentHash?: string): Signal[] {
  const open = listSignals(root)
    .filter((s) => s.status === "open")
    .filter((s) => !isStale(s, currentContentHash));
  return sortInbox(open);
}

/** 待确认计数 + 阈值判定(N3: notify_threshold=5 → 亮宠物)。 */
export function needsAttention(root: string, threshold = 5, currentContentHash?: string): boolean {
  return inboxView(root, currentContentHash).length >= threshold;
}

/** 四动词动作(§9): 记录决定 + 返回动作描述符; 打回理由进校准(§13 per-book 校准)。 */
export function act(root: string, input: ActInput, now: Date = new Date()): ActionDescriptor {
  const signal = loadSignal(root, input.signalId);
  if (!signal) throw new Error(`信号不存在: ${input.signalId}`);
  if (signal.status !== "open") {
    throw new Error(`信号已处理(${signal.status}), 不可重复动作`);
  }
  if ((input.action === "reject" || input.action === "modify") && !input.reason?.trim()) {
    throw new Error("打回/改一改必须带一句话理由(校准原料)");
  }

  const statusMap: Record<InboxAction, SignalStatus> = {
    accept: "accepted",
    reject: "rejected",
    modify: "accepted", // 改一改 = 已处理(进入微工作流)
    defer: "deferred",
  };
  const next: Signal = { ...signal, status: statusMap[input.action], decided_at: now.toISOString() };
  if (input.action === "reject") next.reject_reason = input.reason;
  if (input.action === "modify") {
    next.title = input.modified?.title ?? next.title;
    next.proposed_action = input.modified?.proposed_action ?? next.proposed_action;
  }
  saveSignal(root, next);

  const descriptor: ActionDescriptor = {
    signal: next,
    action: input.action,
    kind: input.action === "accept" ? "adopt" : input.action === "modify" ? "microflow" : "record",
  };
  if (input.action === "modify") {
    descriptor.microflow = guessMicroflow(next);
  }
  return descriptor;
}

/** modify → 微工作流意图路由(首批 6 条, D7): 按 radar 猜测。 */
export function guessMicroflow(signal: Signal): string {
  switch (signal.radar) {
    case "dedup":
      return "去重修复";
    case "writing":
      return "审章";
    case "suggest":
      return "补设定";
    default:
      return "改对象名";
  }
}

/** 便捷入口: 新建并保存一条信号。 */
export function pushSignal(root: string, input: Parameters<typeof createSignal>[0]): Signal {
  const signal = createSignal(input);
  saveSignal(root, signal);
  return signal;
}
