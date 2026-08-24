// assistant 核心 · 收件箱(R6 纯 TS 部分)。
// 依据: 设计文档 §9(四动词) + §11(阈值触发 N3: notify_threshold=5)。
// 本层只做「决定记录 + 动作描述符」; 实际资产写入由上层调用 store 完成
// (adopt/merge 等), 收件箱永不直接改资产。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { assertNoSymlinkOnPath, guardPath, paths } from "@novelcraft/vault";
import {
  createSignal,
  isStale,
  RADARS,
  SEVERITIES,
  SIGNAL_STATUSES,
  sortInbox,
  type RadarKind,
  type Severity,
  type Signal,
  type SignalStatus,
} from "./signals.js";

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

/**
 * guardPath 之后对最终目标追加 vault 根级逐段 symlink 检查(R9): guardPath 的
 * real containment 会放行指向 vault 内其他文件的 symlink(同目录 a.json →
 * b.json), 跟随读写会把对 a 的写落到 b(审批看到 a 不能改 b);
 * assertNoSymlinkOnPath 从 vault 根逐段 lstat, 任一已存在组件是 symlink 一律
 * fail-closed(目录级 symlink 已由 paths() 构造层拒绝, 此处封住文件级)。
 */
function guardedSignalFile(root: string, dir: string, name: string): string {
  const file = guardPath(dir, name);
  assertNoSymlinkOnPath(root, file);
  return file;
}

/** 保存信号(单文件即状态, 覆盖写)。 */
export function saveSignal(root: string, signal: Signal): void {
  const dir = paths(root).assistant.signals;
  // R9 containment: 以 .assistant/signals 为限定根——id 含 `../`、指向目录外
  // 的 symlink 或 vault 内同目录 symlink → 拒绝(fail-closed), 无法经信号 id
  // 跨目录写 vault 外文件或改写其他信号。
  const file = guardedSignalFile(root, dir, `${signal.id}.json`);
  writeFileSync(file, serializeSignal(signal), "utf8");
}

/** Signal 的唯一落盘编码，供原子 state transaction 复用。 */
export function serializeSignal(signal: Signal): string {
  return JSON.stringify(signal, null, 2) + "\n";
}

/** 带 R9 路径门禁读取原始字节；原子事务用它建立精确 CAS。 */
export function readSignalBytes(root: string, signalId: string): string | undefined {
  const dir = paths(root).assistant.signals;
  const file = guardedSignalFile(root, dir, `${signalId}.json`);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8");
}

/** 读单信号; 不存在返回 undefined。 */
export function loadSignal(root: string, signalId: string): Signal | undefined {
  const dir = paths(root).assistant.signals;
  const file = guardedSignalFile(root, dir, `${signalId}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as Signal;
}

/**
 * 最小 Signal shape 校验(R12 目录容错): 内容不合规返回 null(按文件 skip),
 * 防垃圾对象进入 sortInbox(缺字段会让排序/过滤崩)。JSON.parse 失败直接抛,
 * 由调用方 try/catch 按文件跳过。
 * 必检字段至少 id/status/radar/severity/title/proposed_action 类型 + evidence 数组;
 * observed_at 是 sortInbox 的排序键, 缺失会让排序崩, 一并纳入最小 shape。
 */
function signalFromJson(text: string): Signal | null {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string") return null;
  if (typeof s.status !== "string" || !SIGNAL_STATUSES.includes(s.status as SignalStatus)) return null;
  if (typeof s.radar !== "string" || !RADARS.includes(s.radar as RadarKind)) return null;
  if (typeof s.severity !== "string" || !SEVERITIES.includes(s.severity as Severity)) return null;
  if (typeof s.title !== "string") return null;
  if (typeof s.proposed_action !== "string") return null;
  if (!Array.isArray(s.evidence) || !s.evidence.every((e) => typeof e === "string")) return null;
  if (typeof s.observed_at !== "string") return null;
  return s as unknown as Signal;
}

/** 列出全部信号(读 signals 目录)。 */
export function listSignals(root: string): Signal[] {
  const dir = paths(root).assistant.signals;
  if (!existsSync(dir)) return [];
  const signals: Signal[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    // R9: 逐文件 guard + symlink 检查——signals 内 .json symlink(指向目录外或
    // vault 内同目录)一律 fail-closed 抛错。guard 保持在 try/catch 外: 路径
    // 逃逸等安全错误必须抛, 不得被坏 JSON 容错吞掉; 只对 read/JSON parse/
    // 最小 Signal shape 错误按文件 skip。
    const file = guardedSignalFile(root, dir, f);
    try {
      const signal = signalFromJson(readFileSync(file, "utf8"));
      if (signal !== null) signals.push(signal);
    } catch {
      // 单个普通损坏/不合规信号文件跳过(收件箱/watch RPC 不因一个坏文件崩)。
    }
  }
  return signals;
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
