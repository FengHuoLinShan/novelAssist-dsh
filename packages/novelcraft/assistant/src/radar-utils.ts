// assistant · 六面雷达通用对账层(确定性, 非 LLM, 零 DSH 依赖)。
// 同步入口保留兼容；生产巡检使用 atomic 入口，把一轮全部 Signal 变化收敛为
// 一个 @novelcraft/store state transaction。两条路径共享同一纯计划函数。
import { executeTransaction, gitRead, sha256Hex, type TargetSpec } from "@novelcraft/store";
import { listSignals, readSignalBytes, saveSignal, serializeSignal } from "./inbox.js";
import {
  createSignal,
  signalLogicalKey,
  signalObservationHash,
  type CreateSignalInput,
  type Signal,
} from "./signals.js";

export interface RadarReconcileResult {
  created: number;
  skipped: number;
  resolved: number;
  reopened: number;
  total: number;
}

export interface RadarSignalGroup {
  idPrefix: string;
  hits: CreateSignalInput[];
}

export interface AtomicRadarReconcileResult {
  results: RadarReconcileResult[];
  signals: Signal[];
}

interface ReconcilePlan {
  result: RadarReconcileResult;
  changed: Signal[];
  next: Signal[];
}

function observedSignal(input: CreateSignalInput, now: Date): Signal {
  if (input.id === undefined) throw new Error("雷达 hit.id 必须确定性提供");
  const logicalKey = input.logical_key ?? signalLogicalKey(input.radar, input.id);
  return createSignal({
    ...input,
    logical_key: logicalKey,
    observation_hash: input.observation_hash ?? signalObservationHash(input),
  }, now);
}

function refreshObservation(existing: Signal, observed: Signal, now: Date): Signal {
  return {
    ...observed,
    id: existing.id,
    status: "open",
    observed_at: now.toISOString(),
    decided_at: undefined,
    reject_reason: undefined,
  };
}

/** 首写前完成 shape、ID、logical-key 与既有数据碰撞检查。 */
function planReconciliation(
  current: readonly Signal[],
  idPrefix: string,
  hits: readonly CreateSignalInput[],
  now: Date,
): ReconcilePlan {
  const existingById = new Map<string, Signal>();
  const existingByKey = new Map<string, Signal>();
  for (const signal of current) {
    if (existingById.has(signal.id)) throw new Error(`既有 Signal id 碰撞: ${signal.id}`);
    existingById.set(signal.id, signal);
    if (signal.logical_key !== undefined) {
      const duplicate = existingByKey.get(signal.logical_key);
      if (duplicate !== undefined && duplicate.id !== signal.id) {
        throw new Error(`既有 Signal logical_key 碰撞: ${signal.logical_key}`);
      }
      existingByKey.set(signal.logical_key, signal);
    }
  }

  const observed = hits.map((hit) => observedSignal(hit, now));
  const hitIds = new Set<string>();
  const hitKeys = new Set<string>();
  for (const signal of observed) {
    if (hitIds.has(signal.id)) throw new Error(`本轮 Signal id 碰撞: ${signal.id}`);
    if (hitKeys.has(signal.logical_key!)) throw new Error(`本轮 Signal logical_key 碰撞: ${signal.logical_key}`);
    hitIds.add(signal.id);
    hitKeys.add(signal.logical_key!);
  }

  let created = 0;
  let skipped = 0;
  let resolved = 0;
  let reopened = 0;
  const changed = new Map<string, Signal>();
  const nextById = new Map(existingById);
  const activeIds = new Set<string>();

  for (const hit of observed) {
    const existing = existingByKey.get(hit.logical_key!) ?? existingById.get(hit.id);
    if (existing === undefined) {
      changed.set(hit.id, hit);
      nextById.set(hit.id, hit);
      activeIds.add(hit.id);
      created += 1;
      continue;
    }
    activeIds.add(existing.id);
    const previousHash = existing.observation_hash ?? signalObservationHash(existing);
    const changedObservation = previousHash !== hit.observation_hash;
    if (changedObservation || existing.status === "resolved") {
      const next = refreshObservation(existing, hit, now);
      changed.set(existing.id, next);
      nextById.set(existing.id, next);
      if (existing.status !== "open") reopened += 1;
      else skipped += 1;
      continue;
    }

    // 同 observation 保留作者决定；旧文件只补 identity/hash，不改观察时间。
    const metadataChanged = existing.logical_key !== hit.logical_key || existing.observation_hash !== hit.observation_hash;
    if (metadataChanged) {
      const next = { ...existing, logical_key: hit.logical_key, observation_hash: hit.observation_hash };
      changed.set(existing.id, next);
      nextById.set(existing.id, next);
    }
    skipped += 1;
  }

  for (const signal of current) {
    if (!signal.id.startsWith(idPrefix) || signal.status !== "open" || activeIds.has(signal.id)) continue;
    const next = { ...signal, status: "resolved" as const, decided_at: now.toISOString() };
    changed.set(signal.id, next);
    nextById.set(signal.id, next);
    resolved += 1;
  }

  return {
    result: { created, skipped, resolved, reopened, total: observed.length },
    changed: [...changed.values()],
    next: [...nextById.values()],
  };
}

/** 兼容同步入口：共享纯计划，完成碰撞检查后才逐文件保存。 */
export function reconcileRadarSignals(
  root: string,
  idPrefix: string,
  hits: CreateSignalInput[],
  now: Date = new Date(),
): RadarReconcileResult {
  const plan = planReconciliation(listSignals(root), idPrefix, hits, now);
  for (const signal of plan.changed) saveSignal(root, signal);
  return plan.result;
}

function committedPlanSource(root: string): { path: string; digest: string } {
  const path = "book.yml";
  const bytes = gitRead(root, ["show", `HEAD:${path}`], { raw: true });
  if (bytes.length === 0) throw new Error("HEAD:book.yml 缺失，无法授权 Signal state transaction");
  return { path, digest: sha256Hex(bytes) };
}

/** 多雷达一轮只读一次 Signal，并把全部变化写入一次 state transaction。 */
export async function reconcileRadarSignalGroupsAtomic(
  root: string,
  groups: readonly RadarSignalGroup[],
  now: Date = new Date(),
): Promise<AtomicRadarReconcileResult> {
  let current = listSignals(root);
  const results: RadarReconcileResult[] = [];
  const changed = new Map<string, Signal>();

  for (const group of groups) {
    const plan = planReconciliation(current, group.idPrefix, group.hits, now);
    results.push(plan.result);
    current = plan.next;
    for (const signal of plan.changed) changed.set(signal.id, signal);
  }
  if (changed.size === 0) return { results, signals: current };

  const writeSet: TargetSpec[] = [];
  for (const signal of changed.values()) {
    const currentBytes = readSignalBytes(root, signal.id);
    writeSet.push({
      path: `.assistant/signals/${signal.id}.json`,
      expected: currentBytes === undefined
        ? { absent: true, sha256: "" }
        : { absent: false, sha256: sha256Hex(currentBytes) },
      output: serializeSignal(signal),
    });
  }
  await executeTransaction(root, {
    kind: "state",
    purpose: "reconcile deterministic radar signals",
    planSource: committedPlanSource(root),
    writeSet,
  });
  return { results, signals: current };
}

export async function reconcileRadarSignalsAtomic(
  root: string,
  idPrefix: string,
  hits: CreateSignalInput[],
  now: Date = new Date(),
): Promise<RadarReconcileResult> {
  return (await reconcileRadarSignalGroupsAtomic(root, [{ idPrefix, hits }], now)).results[0];
}
