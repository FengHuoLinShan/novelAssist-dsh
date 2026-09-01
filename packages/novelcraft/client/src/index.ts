// @novelcraft/dsh-client · node 半身宿主插件: 注册 /novelcraft loopback RPC 通道。
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
  AtlasAnnotationOpInput,
  AtlasAnnotationRequestPayload,
  AtlasAnnotationRequestValue,
  AtlasImageIntakeStagePayload,
  AtlasImageIntakeStageValue,
  AtlasLabelCard,
  AtlasNodeCard,
  AtlasPageCard,
  AtlasViewPayload,
  AtlasViewValue,
  BookCard,
  BooksListPayload,
  BooksListValue,
  ChapterDossierAsset,
  ChapterDossierPayload,
  ChapterDossierValue,
  ChapterEditStagePayload,
  ChapterEditStageValue,
  ChapterHistoryCard,
  ChapterReviewCard,
  ChapterReviewFindingCard,
  ChapterWorkspacePayload,
  ChapterWorkspaceValue,
  ContentPresetCard,
  DossierSceneCard,
  InboxActPayload,
  InboxActValue,
  InboxListPayload,
  InboxListValue,
  IntakeStagePayload,
  IntakeStageValue,
  ObjectCard,
  PresetsListPayload,
  PresetsListValue,
  PresetsSelectPayload,
  PresetsSelectValue,
  ReviewCard,
  SignalCard,
  StoryMapAssetCard,
  StoryMapPayload,
  StoryMapValue,
  WatchStatePayload,
  WatchStateValue,
  WritingDeskPayload,
  WritingDeskValue,
  WorkflowAuthorState,
  WorkflowRunCard,
  WorkflowViewPayload,
  WorkflowViewValue,
} from './wire.js';
export type { NovelcraftHostService } from './rpc.js';
export { createNovelcraftHandlers, wireRefError } from './rpc.js';

/** 宿主插件体: 注册通道, 返回 disposer 走 effect。 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as
    | { rpc: { handle(channel: string, handler: ConnectionRpcHandler, options: { authority: 'trusted-host' | 'loopback' }): () => Promise<void> } }
    | undefined;
  if (!connection?.rpc?.handle) {
    // 最小 profile/无 client-connection: 宿主半身静默(浏览器半身读 capability 缺省)。
    return;
  }
  const handler: ConnectionRpcHandler = async (endpoint, payload, _signal): Promise<RpcResult<unknown>> => {
    // Optional host services may mount after this client row; resolve them at request time.
    const handlers = createNovelcraftHandlers(ctx);
    // 分发表(与 ENDPOINTS 一一对应; 新端点 = 表加一行, 不再手写 switch)。
    const routes: Record<string, (payload: never) => Promise<RpcResult<unknown>>> = {
      [ENDPOINTS.watchState]: (p) => handlers.watchState(p),
      [ENDPOINTS.inboxList]: (p) => handlers.inboxList(p),
      [ENDPOINTS.inboxAct]: (p) => handlers.inboxAct(p),
      [ENDPOINTS.storyMap]: (p) => handlers.storyMap(p),
      [ENDPOINTS.writingDesk]: (p) => handlers.writingDesk(p),
      [ENDPOINTS.intakeStage]: (p) => handlers.intakeStage(p),
      [ENDPOINTS.intakeStageImage]: (p) => handlers.intakeStageImage(p),
      [ENDPOINTS.chapterDossier]: (p) => handlers.chapterDossier(p),
      [ENDPOINTS.chapterWorkspace]: (p) => handlers.chapterWorkspace(p),
      [ENDPOINTS.chapterStageEdit]: (p) => handlers.chapterStageEdit(p),
      [ENDPOINTS.presetsList]: (p) => handlers.presetsList(p),
      [ENDPOINTS.presetsSelect]: (p) => handlers.presetsSelect(p),
      [ENDPOINTS.presetsEffortSelect]: (p) => handlers.presetsEffortSelect(p),
      [ENDPOINTS.atlasView]: (p) => handlers.atlasView(p),
      [ENDPOINTS.atlasAnnotationRequest]: (p) => handlers.atlasAnnotationRequest(p),
      [ENDPOINTS.workflowView]: (p) => handlers.workflowView(p),
      [ENDPOINTS.booksList]: (p) => handlers.booksList(p),
    };
    const route = routes[endpoint];
    if (route === undefined) {
      return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${endpoint}`, details: {} } };
    }
    return route(payload as never);
  };
  const disposer = connection.rpc.handle(RPC_CHANNEL, handler, { authority: 'loopback' });
  ctx.effect(() => () => {
    void disposer();
  });
}
