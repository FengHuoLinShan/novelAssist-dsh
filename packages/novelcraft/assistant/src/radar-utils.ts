// assistant · 五面雷达通用对账层(确定性, 非 LLM, 零 DSH 依赖)。
// 把 health.ts 的 processHit + 反向对账一般化(设计文档 §11 静默纪律 + 双向对账):
//   正向: 无信号 → pushSignal(open); resolved → 重新 open 刷新 observed_at(问题回来);
//         open/accepted/rejected/deferred → 不动(不复活、不覆盖);
//   反向: idPrefix 前缀的 open 信号不在本次命中集 → resolved(条件消失自动结算)。
// 语义与 scanHealthSignals(health.ts)完全一致; 计数口径同 health.ts。
import { listSignals, loadSignal, pushSignal, saveSignal } from "./inbox.js";
import type { CreateSignalInput, Signal } from "./signals.js";

export interface RadarReconcileResult {
  /** 本次新建的信号数 */
  created: number;
  /** 已存在且状态未变的信号数(幂等) */
  skipped: number;
  /** 本次自动结算(open → resolved)的信号数 */
  resolved: number;
  /** 本次重新开放(resolved → open)的信号数 */
  reopened: number;
  /** 当前命中总数(created + skipped + reopened) */
  total: number;
}

/**
 * 一般化 health.ts 对账(§11 静默纪律 + 双向对账): hits 的 id 必须确定性。
 * idPrefix 为雷达归属判别(如 "ingest-"); 反向对账只结算该前缀的 open 信号。
 */
export function reconcileRadarSignals(
  root: string,
  idPrefix: string,
  hits: CreateSignalInput[],
  now: Date = new Date(),
): RadarReconcileResult {
  let created = 0;
  let skipped = 0;
  let resolved = 0;
  let reopened = 0;
  let total = 0;
  const hitIds = new Set<string>();

  const processHit = (input: CreateSignalInput): void => {
    const id = input.id!;
    hitIds.add(id);
    total += 1;
    const existing = loadSignal(root, id);
    if (!existing) {
      pushSignal(root, input);
      created += 1;
      return;
    }
    if (existing.status === "resolved") {
      // 问题回来了: 重新开放(刷新观察时间, 清除结算时间)。
      saveSignal(root, {
        ...existing,
        status: "open",
        observed_at: now.toISOString(),
        decided_at: undefined,
      });
      reopened += 1;
      return;
    }
    // open/accepted/rejected/deferred: 不复活、不覆盖。
    skipped += 1;
  };

  for (const h of hits) processHit(h);

  // 反向对账: 条件已消失的 open 信号 → resolved。
  for (const s of listSignals(root)) {
    if (!s.id.startsWith(idPrefix)) continue;
    if (s.status !== "open") continue;
    if (hitIds.has(s.id)) continue;
    const next: Signal = { ...s, status: "resolved", decided_at: now.toISOString() };
    saveSignal(root, next);
    resolved += 1;
  }

  return { created, skipped, resolved, reopened, total };
}
