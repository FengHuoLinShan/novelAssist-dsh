// @novelcraft/client · node 半身宿主插件: 注册 /novelcraft loopback RPC 通道。
// 浏览器半身见 src/client/(exports["./client"], dsh.client 声明)。
// 依据: DSH client-modules 双面包模式(dsh-client-connection + client-modules
// 扫描 exports["./client"]); 设计文档 §17(宠物/收件箱读信号, 动作回核心函数)。
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api';
import { createNovelcraftHandlers } from './rpc.js';
import { ENDPOINTS, RPC_CHANNEL } from './wire.js';

export const name = 'novelcraft-client';

/** 依赖宿主 client-connection(提供 ctx.connection)。 */
export const inject = ['connection'];

export { RPC_CHANNEL, ENDPOINTS };
export type {
  InboxActPayload,
  InboxActValue,
  InboxListPayload,
  InboxListValue,
  SignalCard,
  WatchStatePayload,
  WatchStateValue,
} from './wire.js';
export type { NovelcraftHostService } from './rpc.js';
export { createNovelcraftHandlers } from './rpc.js';

/** 宿主插件体: 注册通道, 返回 disposer 走 effect。 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as
    | { rpc: { handle(channel: string, handler: ConnectionRpcHandler, options: { authority: 'trusted-host' | 'loopback' }): () => Promise<void> } }
    | undefined;
  if (!connection?.rpc?.handle) {
    // 最小 profile/无 client-connection: 宿主半身静默(浏览器半身读 capability 缺省)。
    return;
  }
  const handlers = createNovelcraftHandlers(ctx);
  const handler: ConnectionRpcHandler = async (endpoint, payload, _signal): Promise<RpcResult<unknown>> => {
    switch (endpoint) {
      case ENDPOINTS.watchState:
        return handlers.watchState(payload as never);
      case ENDPOINTS.inboxList:
        return handlers.inboxList(payload as never);
      case ENDPOINTS.inboxAct:
        return handlers.inboxAct(payload as never);
      default:
        return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${endpoint}`, details: {} } };
    }
  };
  const disposer = connection.rpc.handle(RPC_CHANNEL, handler, { authority: 'loopback' });
  ctx.effect(() => () => {
    void disposer();
  });
}
