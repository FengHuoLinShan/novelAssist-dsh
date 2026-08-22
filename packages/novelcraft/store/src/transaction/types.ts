// ============================================================================
// ADR-0021(N32) store 事务 · 版本化类型层(zero IO, 纯类型 + 不可变约束)。
//
// 本文件只声明事务域的类型: expected state、write target、transaction kind、
// 版本化 intent/plan/result/status 信封; 规范化(路径/哈希/去重/排序)、校验与
// 序列化逻辑全部在 `./codec.ts`, 本文件不实现任何函数。
//
// 全局约定(所有读者/执行器必须遵守, 均经 codec 强制, fail-closed):
//   - txid = canonical `tx-` + 64 位小写 hex(统一形态, digest 可重推导);
//   - kind = ADR-0021 §8 封闭注册表(裁定 union, 未知值一律拒绝, 不降级);
//   - ref = 完整 `refs/heads/*`, 用 git check-ref-format 等价规则(拒 one-level、
//     `.lock` 段与 dot 段);
//   - 路径字段 = 严格相对 POSIX 路径(拒绝绝对/`..`/`.`/空段/反斜杠/控制字符/
//     任意大小写 `.git` 保留段), 与 ADR-0021 §8「拒绝绝对路径、`..`、路径穿越」
//     及 N32 裁定一致;
//   - 内容摘要 = 纯 64 位小写 hex SHA-256(hash.ts 口径, 读入兼容 `sha256:` 前缀);
//   - git 对象 id(commit/blob/tree)= 40(SHA-1)或 64(SHA-256 仓库)位小写 hex;
//   - 任何数组字段都按路径字典序排序且同路径去重, 保证 canonicalJson 稳定,
//     plan/intent digest 可重推导(ADR-0021 §6/§8);
//   - 所有公开 parse/normalize/verify 对 top/expected/target/preSnapshot 嵌套
//     未知字段严格 fail-closed, 拒 accessor/Proxy/non-plain JSON(见 codec)。
//
// 依据: ADR-0021 §1(writeSet expected state 基线)、§4(expected absent/preflight)、
// §5(CAS_CONFLICT)、§6(plan digest = base + exact tree + full + actual)、
// §7(状态矩阵 BEFORE/OUTPUT/CONFLICT, BASE/OUTPUT/CONFLICT)、§8(版本化
// intent/schema 校验/kind 封闭注册表/run_bootstrap 例外)、N32(2026-08-15 裁定,
// specs/adjudications.md 第八批)。
// ============================================================================

/** 事务 kind —— ADR-0021 §8 封闭注册表; 恢复器按此重推导能力, kind 声明不自报即可信。
 *  - `canonical`   : adopt 类资产提交(未成功 commit 时只能条件回滚 + 重新审批, §7/§8);
 *  - `checkpoint`  : 机器状态 checkpoint commit(可自动补完, §8);
 *  - `state`       : 机器状态 namespace 提交(可自动补完, §8);
 *  - `run_bootstrap`: 首次 run 的受限创建(固定机器 namespace + 全目标 expected absent,
 *    自描述 fingerprint/plan digest, 补完不回滚, §8)。 */
export type TransactionKind = 'canonical' | 'checkpoint' | 'state' | 'run_bootstrap';

/** 内容/输出摘要: 纯 64 位小写 hex SHA-256。 */
export type Sha256Hex = string;

/** git 对象 id(commit/blob/tree): 40(默认 SHA-1)或 64(SHA-256 仓库)位小写 hex。 */
export type GitObjectId = string;

/** git 文件 mode(blob 身份的一部分): 普通/可执行/符号链接(git-transaction 同族)。 */
export type GitFileMode = '100644' | '100755' | '120000';

// ----------------------------------------------------------------------------
// ExpectedState —— 生成计划时的期望状态, 是内容 CAS 的唯一基线(ADR-0021 §1/§4)。
// 事务绝不把「事务启动时读到的任意新内容」自动当基线(ADR-0021 §4, Review P1)。
// ----------------------------------------------------------------------------

export type ExpectedState =
  | {
      readonly kind: 'present';
      /** 期望当前内容 hash(64 hex; 输入兼容 `sha256:` 前缀, 由 codec 归一)。 */
      readonly contentSha256: Sha256Hex;
      /** 生成时基于其推导输出的期望 HEAD(commit id 或 `refs/heads/*` ref), 必要时携带(ADR-0021 §1)。 */
      readonly baseRef?: string;
      /** 生成时基于的期望 blob id, 必要时携带(ADR-0021 §1)。 */
      readonly baseBlob?: GitObjectId;
    }
  | {
      /** 期望目标不存在(ADR-0021 §1/§8: run_bootstrap 全目标 expected absent)。 */
      readonly kind: 'absent';
    };

// ----------------------------------------------------------------------------
// WriteTarget —— writeSet 的单个目标(目标路径级隔离, 事务只 touch writeSet 内路径,
// ADR-0021 §1)。归一形态: 路径已严格相对 POSIX, bytes 变体携带计划输出字节的
// SHA-256 与长度、git 文件 mode 与 git blob OID 身份(原始字节不进归一形态,
// 见 codec 注释)。未知 kind 一律拒绝, 不降级为 bytes 变体(审计 fail-closed)。
// ----------------------------------------------------------------------------

export type WriteTarget =
  | {
      readonly kind: 'bytes';
      /** 严格相对 POSIX 路径(已归一)。 */
      readonly path: string;
      /** 生成计划时的 expected state(唯一 CAS 基线)。 */
      readonly expected: ExpectedState;
      /** 计划输出字节的 SHA-256(写前/提交前复核点与 plan digest 依据, §5/§6)。 */
      readonly outputSha256: Sha256Hex;
      /** 计划输出字节数(复核/大小白名单用)。 */
      readonly outputByteLength: number;
      /** git 文件 mode 身份(缺省归一为 100644)。 */
      readonly mode: GitFileMode;
      /** 计划输出字节对应的 git blob OID 身份(40/64 hex; 执行器必须产出该 blob 才满足 digest)。 */
      readonly blob: GitObjectId;
    }
  | {
      readonly kind: 'delete';
      readonly path: string;
      /** 删除前期望状态(通常 `present`; `absent` = 已不存在, 由 preflight 判定 no-op)。 */
      readonly expected: ExpectedState;
    };

/**
 * 构建输入: 与 WriteTarget 同构, 但 bytes 变体允许直接携带 `bytes`(Uint8Array),
 * 由 codec 计算 outputSha256/outputByteLength 后归一为 WriteTarget。mode 缺省为
 * 100644; blob 身份(codec 无权推导仓库对象算法)必须显式声明。
 * 已归一形态(带 outputSha256/outputByteLength/mode/blob)也可直接传入, codec 只做再校验。
 */
export type WriteTargetInput =
  | {
      kind: 'bytes';
      path: string;
      expected: ExpectedState;
      bytes: Uint8Array;
      /** git 文件 mode 身份; 缺省归一为 100644。 */
      mode?: GitFileMode;
      /** git blob OID 身份(40/64 hex)——调用方必须显式声明。 */
      blob: string;
    }
  | WriteTarget;

// ----------------------------------------------------------------------------
// 状态矩阵分类(ADR-0021 §7)与生命周期阶段。
// ----------------------------------------------------------------------------

/** 恢复时 worktree 逐目标分类(ADR-0021 §7): 等于事务前快照 / 等于计划输出 / 两者都不等。 */
export type WorktreeState = 'BEFORE' | 'OUTPUT' | 'CONFLICT';

/** 恢复时共享 index 条目分类(ADR-0021 §7): 等于 base HEAD / 等于事务输出 / 冲突。 */
export type IndexEntryState = 'BASE' | 'OUTPUT' | 'CONFLICT';

export interface WorktreeStateEntry {
  readonly path: string;
  readonly state: WorktreeState;
}

export interface IndexStateEntry {
  readonly path: string;
  readonly state: IndexEntryState;
}

/** 事务生命周期阶段(ADR-0021 §4/§5/§7/§8; 恢复路径与正常路径共用)。 */
export type TransactionPhase =
  | 'preflight' // §4 全量 preflight 通过前 / 任一失败 → 零写入
  | 'intent_persisted' // §8 耐久化 intent 已建立(承诺「崩溃可恢复」的起点)
  | 'applying' // §5 逐目标同目录 temp + rename 原子替换
  | 'committed' // §6 ref CAS 成功(canonical 终点, 不因 receipt 失败回滚)
  | 'rolled_back' // §7 条件回滚完成(仅 OUTPUT→BEFORE/BASE→新 HEAD 条件迁移)
  | 'aborted' // §2/§4/§5 fail-closed 拒绝, intent 建立前零副作用
  | 'recovery_required' // §8 存在未收敛 intent, 新事务入口先收敛再开始
  | 'recovered' // §8 恢复路径收敛完成(补完/回滚)
  | 'cleaned_up'; // §8 intent 目录已清理, 不残留

/** 事务终局结果(outcome, ADR-0021 §6/§7/§8)。 */
export type TransactionOutcome =
  | 'committed' // 成功 commit + ref CAS(§6)
  | 'rolled_back' // 条件回滚完成(§7)
  | 'noop' // 无实际变化(§4 剔除 no-op 目标后为空集 / 幂等命中)
  | 'aborted' // 全量 preflight 前 fail-closed, 零写入(§4)
  | 'recovered_committed' // 恢复路径验证后补完并 commit(§8)
  | 'recovered_rolled_back'; // 恢复路径验证后条件回滚重审批(§8)

/** intent 清理状态(ADR-0021 §8: 成功 commit 或安全回滚完成后清理 intent 目录)。 */
export type CleanupState = 'pending' | 'completed';

// ----------------------------------------------------------------------------
// 事务前快照(preflight 记录, 仅用于 §7 失败回滚, 不是 CAS 基线——ADR-0021 §4)。
// ----------------------------------------------------------------------------

export type PreTargetSnapshot =
  | { readonly kind: 'absent'; readonly contentSha256?: never }
  | { readonly kind: 'present'; readonly contentSha256: Sha256Hex };

export interface PreSnapshotEntry {
  readonly path: string;
  readonly state: PreTargetSnapshot;
}

// ----------------------------------------------------------------------------
// 版本化信封 1: TransactionPlan —— 不可变计划 + plan digest(ADR-0021 §6)。
//
// digest = sha256(canonicalJson(version/txid/kind/ref/baseHead/exactTree/
// fullWriteSet/actualWriteSet)); 不覆盖自身(自引用会破坏重推导)。base HEAD、
// 冻结的 exact tree OID、完整声明集(full)与实际变化集(actual, full 的有序子集,
// 空 = no-op)共同界定不可变计划; 恢复时按 txid/plan digest 定位唯一 commit 并
// 验证 parent/exact tree/full/actual 与输出 blob identities(ADR-0021 §6/§8)。
// ----------------------------------------------------------------------------

export interface TransactionPlan {
  /** plan schema 版本(白名单校验, ADR-0021 §8)。 */
  readonly version: 1;
  readonly txid: string;
  readonly kind: TransactionKind;
  /** 目标 branch(refs/heads/*, ADR-0021 §1/§8; update-ref CAS 目标)。 */
  readonly ref: string;
  /** base HEAD commit id(40/64 hex)。 */
  readonly baseHead: GitObjectId;
  /** 冻结的 exact tree OID(40/64 hex)——`base HEAD tree + 实际变化集` 的 write-tree 结果(§6)。 */
  readonly exactTree: GitObjectId;
  /** 完整声明 writeSet(已排序去重, §1/§4; 调用方声明, 不补不猜)。 */
  readonly fullWriteSet: readonly WriteTarget[];
  /** 实际变化 writeSet(剔除 no-op 后, §4)——full 的有序子集; 空 = 可表达的 no-op。 */
  readonly actualWriteSet: readonly WriteTarget[];
  /** plan digest: sha256(canonicalJson(payload 不含 digest))(§6; 覆盖 base+exactTree+full+actual)。 */
  readonly digest: Sha256Hex;
}

/** plan digest 的载荷(不含 digest 自身)。 */
export interface PlanPayload {
  readonly version: 1;
  readonly txid: string;
  readonly kind: TransactionKind;
  readonly ref: string;
  readonly baseHead: string;
  readonly exactTree: string;
  readonly fullWriteSet: readonly WriteTarget[];
  readonly actualWriteSet: readonly WriteTarget[];
}

export interface PlanInput {
  readonly txid: string;
  readonly kind: TransactionKind;
  readonly ref: string;
  readonly baseHead: string;
  /** 冻结的 exact tree OID(40/64 hex; 调用方在内容定型后声明)。 */
  readonly exactTree: string;
  /** 完整声明 writeSet(调用方声明, 不补不猜, §1)。 */
  readonly fullWriteSet: readonly WriteTargetInput[];
  /** 实际变化路径子集(缺省 = 全部 full; 空数组 = no-op)。 */
  readonly actualPaths?: readonly string[];
}

// ----------------------------------------------------------------------------
// 版本化信封 2: TransactionIntent —— 写前耐久化的恢复元数据(ADR-0021 §8)。
//
// 位于 .git 内部控制区(不进 index/commit), 原子写 + 就绪标记; plan 内嵌唯一
// 承载 fullWriteSet/actualWriteSet(不重复存储, 避免双源分叉); preSnapshot 路径
// 集合必须与 plan.fullWriteSet 完全一致(§4 每个目标都记录事务前快照)。
// ----------------------------------------------------------------------------

export interface TransactionIntent {
  /** intent schema 版本(白名单校验, ADR-0021 §8)。 */
  readonly version: 1;
  readonly txid: string;
  /** vault 根身份(绝对 realpath; 是恢复器对照用的身份字段, 不是目标路径, 不参与
   *  相对路径规则; 恢复时与当前仓库 realpath 比对, ADR-0021 §8「先验证 vault/root」)。 */
  readonly vaultRoot: string;
  readonly kind: TransactionKind;
  readonly ref: string;
  readonly baseHead: GitObjectId;
  /** 不可变计划(内含 plan digest 与 full/actual writeSet; 恢复时重推导并验证, §8)。 */
  readonly plan: TransactionPlan;
  /** 事务前持久快照(仅用于 §7 条件回滚; 不是 CAS 基线; 路径集合 = plan.fullWriteSet)。 */
  readonly preSnapshot: readonly PreSnapshotEntry[];
  /** intent 清理状态(§8)。 */
  readonly cleanup: CleanupState;
  /** intent 建立时刻(ISO-8601 UTC)。 */
  readonly createdAt: string;
  /** intent digest: sha256(canonicalJson(payload 不含 digest))(§6/§8 重推导)。 */
  readonly digest: Sha256Hex;
}

export interface IntentInput {
  readonly txid: string;
  readonly vaultRoot: string;
  readonly kind: TransactionKind;
  readonly ref: string;
  readonly baseHead: string;
  /** 冻结的 exact tree OID(40/64 hex)。 */
  readonly exactTree: string;
  /** 完整声明 writeSet(调用方声明, 不补不猜, §1)。 */
  readonly fullWriteSet: readonly WriteTargetInput[];
  /** 实际变化路径子集(缺省 = 全部 full; 空数组 = no-op)。 */
  readonly actualPaths?: readonly string[];
  readonly preSnapshot: readonly PreSnapshotEntry[];
  /** 缺省 = 当前 UTC ISO-8601(测试请显式传入以保持确定性)。 */
  readonly createdAt?: string;
  /** 缺省 = 'pending'。 */
  readonly cleanup?: CleanupState;
}

// ----------------------------------------------------------------------------
// 版本化信封 3: TransactionStatus —— 恢复/进行中的逐目标分类视图(ADR-0021 §7/§8)。
// ----------------------------------------------------------------------------

export interface TransactionStatus {
  readonly version: 1;
  readonly txid: string;
  readonly kind: TransactionKind;
  readonly phase: TransactionPhase;
  /** 逐目标 worktree 分类(已按路径排序; BEFORE/OUTPUT 任意组合是合法 partial, §7)。 */
  readonly worktree: readonly WorktreeStateEntry[];
  /** 共享 index 条目分类(已按路径排序; 空 = index 无本事务条目 = BASE, §7)。 */
  readonly index: readonly IndexStateEntry[];
  readonly planDigest: Sha256Hex;
  /** 状态快照时刻(ISO-8601 UTC)。 */
  readonly updatedAt: string;
  /** sha256(canonicalJson(payload 不含 digest)); 恢复器对照快照是否被篡改。 */
  readonly digest: Sha256Hex;
}

export interface StatusInput {
  readonly txid: string;
  readonly kind: TransactionKind;
  readonly phase: TransactionPhase;
  readonly worktree?: readonly WorktreeStateEntry[];
  readonly index?: readonly IndexStateEntry[];
  readonly planDigest: string;
  readonly updatedAt?: string;
}

// ----------------------------------------------------------------------------
// 版本化信封 4: TransactionResult —— 终局 receipt(ADR-0021 §6/§7; commit 是
// canonical 终点, 不因后续状态 receipt 失败而回滚历史)。
// ----------------------------------------------------------------------------

export interface TransactionResult {
  readonly version: 1;
  readonly txid: string;
  readonly kind: TransactionKind;
  readonly outcome: TransactionOutcome;
  readonly ref: string;
  readonly baseHead: GitObjectId;
  /** 成功 commit/恢复补完产生的 commit id(其余 outcome 缺省)。 */
  readonly newHead?: GitObjectId;
  readonly planDigest: Sha256Hex;
  /** 终局逐目标 worktree 分类(§7)。 */
  readonly worktree: readonly WorktreeStateEntry[];
  /** 终局共享 index 条目分类(§7)。 */
  readonly index: readonly IndexStateEntry[];
  readonly createdAt: string;
  /** sha256(canonicalJson(payload 不含 digest)); 可验证的收据摘要。 */
  readonly digest: Sha256Hex;
}

export interface ResultInput {
  readonly txid: string;
  readonly kind: TransactionKind;
  readonly outcome: TransactionOutcome;
  readonly ref: string;
  readonly baseHead: string;
  readonly newHead?: string;
  readonly planDigest: string;
  readonly worktree?: readonly WorktreeStateEntry[];
  readonly index?: readonly IndexStateEntry[];
  readonly createdAt?: string;
}