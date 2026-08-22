// ADR-0021 崩溃恢复入口(N32 / §8) —— recovery.ts
//
// 公共恢复调用面(thin wrapper over execute.ts): 发现 `.git/novelcraft-transactions/`
// 下未完成 intent → 先验证(schema/大小/txid/路径白名单由 intent.ts 保证; kind
// 注册表/plan digest 重推导/run_bootstrap allowlist 由 convergeIntent 保证), 再按
// §7 状态矩阵收敛:
//   BEFORE/OUTPUT 任意组合是可恢复的合法 partial(state/checkpoint/run_bootstrap
//   补完, canonical 条件回滚); CONFLICT、intent 外 staged、未知 Git lock 或路径
//   能力不匹配 → 保留现场 fail-closed。HEAD 已前进不自动等于冲突: 先按 §6 在可达
//   历史验证唯一 tx commit, 找到 → “commit 已成功”只收尾; 未找到且 ref 仍为 base
//   HEAD 才可继续/回滚; HEAD 前进且不存在该 commit → 外部 ref 竞争, 停止并重新
//   规划, 绝不 force。
//
// 单向依赖 execute.js(无循环): 锁/intent 编解码/状态矩阵/收敛实现全在 execute.ts。

import {
  convergeIntent,
  recoverInterruptedTransactions as recoverAll,
  type PerTxReport,
  type RecoveryReport,
  type VaultLock,
} from './execute.js';
import { acquireVaultWriteLock } from './lock.js';
import { listIntents, readIntent } from './intent.js';

export type { PerTxReport, RecoveryReport, VaultLock } from './execute.js';
// intent 记录形态由 intent.ts 提供(execute.ts 已转发使用); 这里透传类型便于调用方。
export type { IntentRecord, IntentTargetEntry, IntentBlobSet, LoadedIntent } from './intent.js';
export { TransactionError, CrashSimulatedError, isCrashSimulated, executeTransaction, makeTxid, verifyCommittedPlanSource } from './execute.js';

/** 只读列出 vault 中现存中断事务(未取锁; 诊断/测试用)。 */
export function listInterruptedIntents(root: string): string[] {
  return listIntents(root)
    .filter((e) => e.valid && e.ready && e.validTxid)
    .map((e) => e.name);
}

/** 读取单个 intent(未取锁; 诊断/测试用; 损坏/半写抛 IntentError)。 */
export function readIntentRecord(root: string, txid: string): ReturnType<typeof readIntent> {
  return readIntent(root, txid);
}

/**
 * 收敛单个中断事务(N32 §8): 只认 intent 登记的 txid/仓库; CONFLICT/无效 intent
 * 保留现场 fail-closed, 需人工修复; `force` 不能绕过未收敛 intent(§8)。
 * 独立调用时自行获取生产 per-vault 锁; 可传入已持有锁复用。
 */
export async function recoverTransaction(
  root: string,
  txid: string,
  opts: { lock?: VaultLock; lockStaleMs?: number } = {},
): Promise<PerTxReport> {
  const lock = opts.lock ?? (await acquireVaultWriteLock(root, { waitMs: 0, staleMs: opts.lockStaleMs ?? 1 }));
  const ownLock = opts.lock === undefined;
  try {
    const loaded = readIntent(root, txid);
    return convergeIntent(root, txid, loaded.record);
  } finally {
    if (ownLock) lock.release();
  }
}

/**
 * 公共恢复入口(N32 §8): 发现未完成 intent → 全部收敛(含半写残留清理), 返回逐事务
 * 报告与未收敛清单(unresolved)。执行器入口内部也调用同一实现(execute.ts)以保证
 * 「收敛完成前不开始任何新事务」; 本函数仅增加独立取锁/释放语义。
 */
export async function recoverInterruptedTransactions(
  root: string,
  opts: { lock?: VaultLock; lockStaleMs?: number } = {},
): Promise<RecoveryReport> {
  return recoverAll(root, opts);
}