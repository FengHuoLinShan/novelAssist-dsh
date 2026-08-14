// @novelcraft/client · 浏览器半身: 宠物(会话头动作)+ 收件箱面板。
// 数据 = /novelcraft loopback RPC(宿主读 .assistant/signals + jobs);
// 四动词回宿主 assistant.act。UI 只呈现作者语言, 不暴露 raw JSON/内部枚举。
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 会话头插槽由 ui-conversation 声明(type-only, 激活 SlotMap 合并)。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PetAction } from './PetAction.tsx'
import type { PetActionProps } from './PetAction.tsx'
import { en, NS, zh, type NovelcraftKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** NovelCraft 守望(宠物/收件箱)文案。 */
    'novelcraft': NovelcraftKey
  }
}

export type { PetActionProps }
export { NS }
export { PetAction } from './PetAction.tsx'

/** 浏览器侧连接投影(结构面; 与 dsh-client-connection/client 的 ConnectionHandle 对齐)。 */
export interface RpcCaller {
  rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
  }
}

/** 依赖: 插槽/文案/连接(宿主 channel 的浏览器投影)。 */
export const inject = ['slots', 'locale', 'connection']

/**
 * 客户端插件体: 注册文案字典 + 会话头宠物动作。
 * @param ctx - 客户端 Cordis 根。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'novelcraft: dictionaries')
  const connection = ctx.get('connection') as RpcCaller | undefined
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'novelcraft-pet',
      // 会话进程类动作之后(job-list order 20; 守望常驻其右)。
      order: 30,
      locale: NS,
      inject: (): { connection: RpcCaller | undefined } => ({ connection }),
    }, PetAction),
  )
}
