import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { realpathSync } from 'node:fs';
import { llmErrorCode } from '@novelcraft/llm-step';
import * as store from '@novelcraft/store';
import * as writing from '@novelcraft/writing';
import { GateDeniedError, GateRequiredError } from '../approval/gate.js';
import { DeepImportDeniedError } from '../deep-import.js';
import type { NovelCraftService } from '../service.js';

export const render = (_args: unknown, value: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(value) },
];

/** DSH seam 唯一错误映射: 失败必须进入宿主 HarnessError/isError 通道。 */
export function toolError(
  err: unknown,
  fallback: { code: string; message: string } = {
    code: 'NOVELCRAFT_TOOL_ERROR',
    message: 'NovelCraft 工具执行失败, 已停止后续动作',
  },
): HarnessError {
  if (err instanceof HarnessError) return err;
  if (err instanceof WorkspaceIsolationError) {
    return new HarnessError(err.message, 'WORKSPACE_ISOLATION', { cause: err });
  }
  if (err instanceof GateDeniedError || err instanceof DeepImportDeniedError) {
    return new HarnessError(err.message, `APPROVAL_${err.decision.toUpperCase().replace('-', '_')}`, { cause: err });
  }
  if (err instanceof GateRequiredError) {
    return new HarnessError(err.message, 'APPROVAL_REQUIRED', { cause: err });
  }
  if (err instanceof store.StoreError) {
    return new HarnessError(`store: ${err.message}`, `STORE_${err.code}`, { cause: err });
  }
  if (err instanceof writing.TextIntakeError) {
    return new HarnessError(err.message, `INTAKE_${err.code}`, { cause: err });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new HarnessError('工具执行已取消', 'ABORTED', { cause: err });
  }
  return new HarnessError(fallback.message, fallback.code, { cause: err });
}

export function llmError(kind: string | undefined, message: string | undefined): HarnessError {
  return new HarnessError(message || '模型步骤失败', llmErrorCode(kind));
}

/** N34 工作区隔离错误。 */
export class WorkspaceIsolationError extends Error {
  constructor(reason: string) {
    super(`工作区隔离失败: ${reason}`);
    this.name = 'WorkspaceIsolationError';
  }
}

export function sessionIdOf(exec: { agent?: unknown }): string {
  const sessionId = (exec.agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new WorkspaceIsolationError('无 agent session id, 拒绝访问任意 vault');
  }
  return sessionId;
}

/** 只允许当前 agent session 绑定的 canonical vault root。 */
export async function resolveBoundRoot(
  service: NovelCraftService,
  exec: { agent?: unknown },
  requested?: unknown,
): Promise<string> {
  const sessionId = sessionIdOf(exec);
  const binding = await service.vaults.resolve(sessionId);
  if (!binding) {
    throw new WorkspaceIsolationError(`session ${sessionId} 未绑定 vault, 拒绝`);
  }
  const boundRoot = binding.root;
  if (requested !== undefined) {
    if (typeof requested !== 'string') {
      throw new WorkspaceIsolationError(`root 参数必须是字符串, got ${typeof requested}`);
    }
    let realBound: string;
    let realRequested: string;
    try {
      realBound = realpathSync(boundRoot);
      realRequested = realpathSync(requested);
    } catch (err) {
      throw new WorkspaceIsolationError(`无法解析 root 真实路径: ${(err as Error).message}`);
    }
    if (realBound !== realRequested) {
      throw new WorkspaceIsolationError(
        `root(${requested}) 与 session 绑定 vault(${boundRoot}) 的 canonical 根不一致, 拒绝跨工作区访问`,
      );
    }
  }
  return boundRoot;
}
