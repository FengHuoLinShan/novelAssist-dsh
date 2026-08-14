// @novelcraft/dsh · RAG 索引事件触发(设计 §11: 事件驱动, 非定时刷屏)。
// 工具事件 → 确定性增量索引同步: adopt/ingest/deep_import 后内容变化, 增量重建
// .assistant/rag-index.json(派生索引 R12, 文件仍是唯一真相)。
// 与 radar-hooks.ts 同款纪律: 钩子为尽力而为的副作用, 任何异常不外抛, 不破坏主工具
// 调用链; 无 UI 面, 不推送(无 pushSignalsChanged)。
import type { Context } from '@deepseek-ai/cordis';
import * as rag from '@novelcraft/rag';
import { ensureVaultGitignore } from '@novelcraft/vault';

/**
 * RAG 索引事件钩子(§11 事件驱动同款依据): 先补旧 vault 的 .gitignore(派生索引不提交
 * git), 再增量同步 rag-index.json; 失败吞掉返回 undefined, 不阻塞主工具调用链。
 */
export function fireRagHook(ctx: Context, root: string): rag.RagSyncStats | undefined {
  void ctx; // 签名对齐 fireRadarHooks; 索引同步是纯文件操作, 无 ctx 依赖。
  try {
    ensureVaultGitignore(root, ['.assistant/rag-index.json']);
    return rag.syncRagIndex(root);
  } catch {
    // 索引是派生数据(R12), 可随时全量重建; 失败不进主调用链, 不打扰作者。
    return undefined;
  }
}
