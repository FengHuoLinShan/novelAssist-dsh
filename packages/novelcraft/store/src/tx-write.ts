// @novelcraft/store · 业务 canonical 写面的统一事务 helper(ADR-0021/N32 P1)。
//
// 迁移后的 store/world 各 canonical writer 不再直接 writeFileSync + gitAdd + gitCommit,
// 而是在**首写之前**以本 helper 构造完整确定性 writeSet(含移动/删除、日志/祖先链),
// 把每目标「计划/审批时刻的当前字节 + 计划输出字节」作为 expected/output 传给
// executeTransaction(kind='canonical'): 内容字节 CAS + frontmatter/路径/R9 symlink
// preflight 由业务层与执行器共同完成, 任何预存 staged fail-closed(STAGED_CONFLICT),
// writeSet 外无关 unstaged/untracked 允许(ADR §1), 崩溃由 durable intent 条件回滚/
// 补完(ADR §7/§8), intent 建立前零工作树/index/ref 副作用。
//
// 约定:
//   - 「计划/审批时刻」字节必须在审批前定型并随本请求传入, 不得在审批后刷新
//     (ADR §4 背景 4 / N32: 事务绝不把事务启动时读到的任意新内容自动当基线);
//   - output 省略 = 删除该目标(move 的旧路径即以此表达);
//   - 事务失败统一映射为业务 StoreError(见 mapTxError), 保持业务侧既有错误码语义;
//   - 本 helper 与执行器均不 import 任何 @deepseek-ai/*(铁律 1, 核心包零 DSH 依赖)。

import {
  executeTransaction,
  TransactionError,
  type TargetSpec,
  type TransactionOptions,
  type TransactionResult,
} from './transaction/execute.js';
import { sha256Hex } from './hash.js';
import { StoreError } from './errors.js';

/** 单目标计划态: 计划/审批时刻的当前文件字节 + 计划输出。 */
export interface TxLocalTarget {
  /** vault 相对 POSIX 路径(正斜杠, 归一化; 执行器按 codec 白名单强校验)。 */
  path: string;
  /** 计划/审批时刻读到的当前文件字节; null = 目标当前不存在。 */
  current: string | null;
  /** 计划输出字节; 省略 = 删除该目标(移动源/删除面)。 */
  output?: string;
}

export interface TxCanonicalWriteOptions {
  /** 事务用途(人类可读诊断; 进 request.purpose)。 */
  purpose: string;
  /** 生成/审批定稿时的 HEAD(封闭生成→启动窗口, ADR §4 背景 4); 缺省 = 不设。 */
  expectedHead?: string;
  /** 业务 preflight 复核(映射执行器 validate 回调; 抛错 = intent 建立前零写拒绝)。 */
  validate?: (path: string, currentBytes: string | null, currentHead: string) => void;
  /** 执行器选项透传(测试注入 gates/faults 用; 生产缺省)。 */
  tx?: TransactionOptions;
}

/** 计划态目标 → 执行器 writeSet(kind='canonical', ADR §4 expected-state 唯一基线)。 */
export function buildTxWriteSet(targets: TxLocalTarget[]): TargetSpec[] {
  return targets.map((t) => ({
    path: t.path,
    expected:
      t.current === null
        ? { absent: true, sha256: '' }
        : { absent: false, sha256: sha256Hex(t.current) },
    // 纯删除目标(absent=false + 无 output)与创建/更新目标照传; 删除不存在的
    // 目标(absent=true + 无 output)是调用方计划错误 → 由执行器 INVALID_REQUEST 拒绝。
    ...(t.output !== undefined ? { output: t.output } : {}),
  }));
}

/** 审批前封存的 canonical 写计划；只能由 prepareCanonicalWrite 创建。 */
export interface PreparedCanonicalWrite {
  readonly root: string;
  readonly targets: readonly Readonly<TxLocalTarget>[];
  readonly opts: Readonly<TxCanonicalWriteOptions>;
}
const trustedCanonicalPlans = new WeakSet<object>();

export function prepareCanonicalWrite(
  root: string,
  targets: readonly TxLocalTarget[],
  opts: TxCanonicalWriteOptions,
): PreparedCanonicalWrite {
  const prepared = Object.freeze({
    root,
    targets: Object.freeze(targets.map((target) => Object.freeze({ ...target }))),
    opts: Object.freeze({ ...opts }),
  });
  trustedCanonicalPlans.add(prepared);
  return prepared;
}

/** 批准后只执行审批前封存的 bytes/writeSet/HEAD，不重新读取或刷新基线。 */
export async function executePreparedCanonicalWrite(prepared: PreparedCanonicalWrite): Promise<TransactionResult> {
  if (!trustedCanonicalPlans.has(prepared) || !Object.isFrozen(prepared)) {
    throw new StoreError('VALIDATION_FAILED', 'canonical write plan 非可信或已被修改');
  }
  const writeSet = buildTxWriteSet([...prepared.targets]);
  const { root, opts } = prepared;
  try {
    return await executeTransaction(
      root,
      {
        kind: 'canonical',
        purpose: opts.purpose,
        writeSet,
        ...(opts.expectedHead !== undefined ? { expectedHead: opts.expectedHead } : {}),
        ...(opts.validate !== undefined
          ? {
              validate: (spec, ctx) =>
                opts.validate!(spec.path, ctx.currentBytes, ctx.currentHead),
            }
          : {}),
      },
      opts.tx,
    );
  } catch (err) {
    throw mapTxError(err);
  }
}

/** 统一 canonical 事务便利入口；需跨审批窗口时必须显式 prepare/execute。 */
export async function executeCanonicalWrite(
  root: string,
  targets: TxLocalTarget[],
  opts: TxCanonicalWriteOptions,
): Promise<TransactionResult> {
  return executePreparedCanonicalWrite(prepareCanonicalWrite(root, targets, opts));
}

/**
 * 事务失败 → 业务 StoreError 映射(只做错误面切换, 业务签名语义不变):
 * 预存 staged = STAGED_CONFLICT; 陈旧基线/写前复核/ref CAS 竞争等 = CONFLICT;
 * 其余(锁忙/未收敛 intent/未知 lock/GIT_ERROR 等)原样向上抛(事务错误本身已带
 * 稳定 code, 不作为新 StoreError 码登记, 保持错误类型只做加法)。
 */
export function mapTxError(err: unknown): unknown {
  if (err instanceof TransactionError) {
    if (err.code === 'STAGED_CONFLICT') {
      return new StoreError('STAGED_CONFLICT', err.message, err.details);
    }
    if (
      err.code === 'STALE_BASELINE' ||
      err.code === 'CAS_CONFLICT' ||
      err.code === 'REF_CAS_CONFLICT' ||
      err.code === 'SHARED_INDEX_CONFLICT' ||
      err.code === 'EXTERNAL_REF_RACE'
    ) {
      return new StoreError('CONFLICT', err.message, err.details);
    }
    return err;
  }
  return err;
}
