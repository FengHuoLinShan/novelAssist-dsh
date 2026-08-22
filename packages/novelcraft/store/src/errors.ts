// store 的统一错误类型。所有确定性原语用带 code 的 StoreError 表达拒绝,
// 上层(编排脑/插件 seam)据此映射为冲突/需确认/非法迁移等用户语言。

export type StoreErrorCode =
  | 'PATH_TRAVERSAL'
  | 'NOT_FOUND'
  | 'NOT_A_GIT_REPO'
  | 'DIRTY_WORKSPACE'
  | 'ILLEGAL_TRANSITION'
  | 'CONFLICT'
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_ASSET_KIND'
  | 'BAD_CANDIDATE'
  | 'INVALID_REF'
  | 'INVALID_TARGET'
  | 'VALIDATION_FAILED'
  | 'MERGE_TYPE_MISMATCH'
  | 'MERGE_NOT_FOUND'
  | 'MERGE_SELF'
  | 'DUPLICATE_ALIAS'
  | 'INVALID_ALIAS'
  | 'GIT_ERROR'
  // ---- ADR-0021(N32) 事务类型/规范化层细分错误码(只做加法) ----
  // 严格相对 POSIX 路径规范化(codec.normalizeRelPath 一族; 含任意大小写 `.git` 保留段)
  | 'TX_PATH_EMPTY'
  | 'TX_PATH_ABSOLUTE'
  | 'TX_PATH_TRAVERSAL'
  | 'TX_PATH_SEGMENT'
  // 身份/格式校验(txid/kind/ref/hash/expected state/length)
  | 'TX_INVALID_TXID'
  | 'TX_INVALID_KIND'
  | 'TX_INVALID_REF'
  | 'TX_INVALID_SHA256'
  | 'TX_INVALID_OBJECT_ID'
  | 'TX_INVALID_EXPECTED_STATE'
  | 'TX_INVALID_BYTE_LENGTH'
  | 'TX_DUPLICATE_TARGET'
  // fail-closed 结构校验: 未知字段白名单(N32 白名单精神)与 non-plain/Proxy/accessor 拒收
  | 'TX_UNKNOWN_FIELD'
  | 'TX_NON_PLAIN_OBJECT'
  | 'TX_INVALID_TARGET_KIND'
  | 'TX_INVALID_MODE'
  // full/actual writeSet 关系(actual 必须是 full 的有序子集; no-op = 空 actual)
  | 'TX_WRITESET_MISMATCH'
  // intent/plan 验证与重推导(ADR-0021 §6 plan digest / §8 恢复器先验证后动作)
  | 'TX_INTENT_INVALID'
  | 'TX_PLAN_DIGEST_MISMATCH'
  | 'TX_INTENT_DIGEST_MISMATCH'
  // ADR-0021 §2/§4/§5 执行层错误分类(本层只登记类型, 执行器按 store-rules 落地)
  | 'STAGED_CONFLICT'
  | 'STALE_BASELINE'
  | 'CAS_CONFLICT';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly details?: unknown;

  constructor(code: StoreErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
  }
}
