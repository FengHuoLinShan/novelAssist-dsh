// ADR-0021(N32) store 事务层 barrel —— 统一导出(集成要求: 单一导出面)。
//
// 并行模块(types/codec/lock/intent/git-transaction)与执行面(execute/recovery)经
// 本入口对外暴露; store 包 barrel(src/index.ts)再经 recovery 转出公共 seam。
// 零 DSH 依赖(铁律 1)。重名符号显式别名, 避免 `export *` 歧义:
//   - codec.computePlanDigest(PlanPayload 口径)与 execute.computePlanDigest
//     (tree+blobs 口径, 与 git-transaction 同构)并存 → 后者导出为 computeTxPlanDigest;
//   - types.TransactionResult/WorktreeState(信封类型)与执行面同名结果类型 →
//     后者导出为 TxExecutionResult/TxWorktreeState;
//   - execute.recoverInterruptedTransactions(实现)与 recovery 同名入口 →
//     经 recovery.js 的显式导出面暴露, 此处不再重复导出。

export * from './types.js';
export * from './codec.js';
export * from './lock.js';
export * from './intent.js';
// git-transaction: 显式再导出(codec 与 execute 均已导出 computePlanDigest, 与
// git-transaction 同名冲突 → 此处别名 computeGitTxPlanDigest, 消除 export * 歧义;
// 消费方均经 execute/codec 取同名实现, 语义不变)。
export {
  GitTransactionError,
  GitTransactionErrorCode,
  NOVELCRAFT_TX_DATE,
  ObjectFormat,
  isOid,
  buildEnv,
  pinArgs,
  RepoContext,
  resolveRepoContext,
  assertSafeRepoState,
  assertSharedIndexClean,
  ResolvedRef,
  resolveCurrentRef,
  TxFileMode,
  TxTargetWrite,
  CommitTxnParams,
  CommitTxnResult,
  buildTxCommitMessage,
  updateRefCas,
  commitTransaction,
  commitTransactionAsync,
  TxCommitIdentity,
  FoundTxCommit,
  computeExpectedTxCommitOid,
  findTxCommit,
  probeTxCommitForTargets,
  readCommittedFile,
  buildHeadIndexBytes,
  computePlanDigest as computeGitTxPlanDigest,
} from './git-transaction.js';

export {
  executeTransaction,
  runTransactionProcess,
  recoverTransactionProcess,
  attachWorkerIo,
  convergeIntent,
  classifyWorktreeTarget,
  classifyAllTargetsFromIntent,
  rollbackCanonical,
  completeStateTransaction,
  derivePlanIdentity,
  verifyCommittedPlanSource,
  makeTxid,
  currentBranch,
  TransactionError,
  CrashSimulatedError,
  isCrashSimulated,
  PerTxReport,
  RecoveryReport,
  ClassifiedTarget,
  DerivedPlan,
  TxKind,
  TX_KINDS,
  TargetSpec,
  StatePlanSource,
  TransactionRequest,
  TransactionOptions,
  GatePhase,
  GATE_PHASES,
  TxErrorCode,
  EMPTY_SHA,
  WORKTREE_TMP_PREFIX,
  computePlanDigest as computeTxPlanDigest,
  TransactionResult as TxExecutionResult,
  WorktreeState as TxWorktreeState,
  type VaultLock,
  type IntentRecord,
  type IntentBlobSet,
  type IntentTargetEntry,
} from './execute.js';

export { recoverTransaction, listInterruptedIntents, readIntentRecord } from './recovery.js';
