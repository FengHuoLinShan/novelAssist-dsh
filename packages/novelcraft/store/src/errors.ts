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
  | 'INVALID_REF'
  | 'INVALID_TARGET'
  | 'VALIDATION_FAILED'
  | 'MERGE_TYPE_MISMATCH'
  | 'MERGE_NOT_FOUND'
  | 'MERGE_SELF'
  | 'DUPLICATE_ALIAS'
  | 'INVALID_ALIAS'
  | 'GIT_ERROR';

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
