// @novelcraft/dsh-client · 浏览器半身: 宠物(会话头动作)+ 收件箱面板。
// 数据 = /novelcraft loopback RPC(宿主读 .assistant/signals + jobs);
// 四动词回宿主 assistant.act。UI 只呈现作者语言, 不暴露 raw JSON/内部枚举。
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 会话头插槽由 ui-conversation 声明(type-only, 激活 SlotMap 合并)。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PetAction } from './PetAction.tsx'
import type { PetActionProps } from './PetAction.tsx'
import { StoryMapAction } from './StoryMapAction.tsx'
import type { StoryMapActionProps } from './StoryMapAction.tsx'
import { WritingDeskAction } from './WritingDeskAction.tsx'
import type { WritingDeskActionProps } from './WritingDeskAction.tsx'
import type { ChapterDossierProps } from './ChapterDossier.tsx'
import { ModelPresetsAction } from './ModelPresetsAction.tsx'
import { MapAtlasAction } from './MapAtlasAction.tsx'
import type { MapAtlasActionProps } from './MapAtlasAction.tsx'
import type { ModelPresetsActionProps } from './ModelPresetsAction.tsx'
import { ChapterWorkspaceView } from './ChapterWorkspaceView.tsx'
import type { ChapterWorkspaceViewProps } from './ChapterWorkspaceView.tsx'
import { WorkflowAction } from './WorkflowAction.tsx'
import type { WorkflowActionProps } from './WorkflowAction.tsx'
import { en, NS, zh, type NovelcraftKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** NovelCraft 守望(宠物/收件箱)文案。 */
    'novelcraft': NovelcraftKey
  }
}

export type { PetActionProps, StoryMapActionProps, WritingDeskActionProps, ChapterDossierProps, ModelPresetsActionProps, MapAtlasActionProps, ChapterWorkspaceViewProps, WorkflowActionProps }
export { NS }
export { PetAction } from './PetAction.tsx'
export { StoryMapAction } from './StoryMapAction.tsx'
export { WritingDeskAction } from './WritingDeskAction.tsx'
export { ChapterDossier } from './ChapterDossier.tsx'
export { ModelPresetsAction } from './ModelPresetsAction.tsx'
export { MapAtlasAction } from './MapAtlasAction.tsx'
export { ChapterWorkspaceView } from './ChapterWorkspaceView.tsx'
export { WorkflowAction } from './WorkflowAction.tsx'

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
  const t = ctx.locale.bind(NS)
  const actionSlot = () => ({ connection })
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'novelcraft-workflows',
      order: 35,
      locale: NS,
      inject: (): { connection: RpcCaller | undefined } => actionSlot(),
    }, WorkflowAction),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'novelcraft-pet',
      // 会话进程类动作之后(job-list order 20; 守望常驻其右)。
      order: 30,
      locale: NS,
      inject: (): { connection: RpcCaller | undefined } => actionSlot(),
    }, PetAction),
  )
  ctx.slots.inject(
    'conversation.view',
    () => ctx.slots.register({
      name: 'conversation.view',
      id: 'novelcraft-chapters',
      order: 20,
      locale: NS,
      label: () => t('chapter.view'),
      inject: (): { connection: RpcCaller | undefined } => actionSlot(),
    }, ChapterWorkspaceView),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'novelcraft-story-map',
      order: 40,
      locale: NS,
      inject: (): { connection: RpcCaller | undefined } => actionSlot(),
    }, StoryMapAction),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'novelcraft-writing-desk',
      order: 50,
      locale: NS,
      inject: (): { connection: RpcCaller | undefined } => actionSlot(),
    }, WritingDeskAction),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'novelcraft-model-presets',
      order: 60,
      locale: NS,
      inject: (): { connection: RpcCaller | undefined } => actionSlot(),
    }, ModelPresetsAction),
  )
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'novelcraft-map-atlas',
      order: 70,
      locale: NS,
      inject: (): { connection: RpcCaller | undefined } => actionSlot(),
    }, MapAtlasAction),
  )

  // 订阅宿主推送(ADR-0018 §1): client/push 帧到达 → 广播 DOM 事件, useWatch 据此即时刷新。
  // ctx.remote 是字符串键 Map(dsh-api-gateway/lib/client.js), 运行时无事件名校验; 服务缺省静默。
  const remote = ctx.get('remote') as
    | { $on(event: string, listener: (...args: unknown[]) => void): () => void }
    | undefined
  if (remote) {
    ctx.effect(
      () =>
        remote.$on('client/push', (channel) => {
          if (channel === 'novelcraft/signals-changed') {
            window.dispatchEvent(new CustomEvent('novelcraft:signals-changed'))
          }
        }),
      'novelcraft: remote push subscription',
    )
  }
}
