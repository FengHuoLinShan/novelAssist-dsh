// @novelcraft/dsh-client · node 半身宿主插件: 在 /api 共享通道下注册
// /api/novelcraft 精确 Fetch 路由(浏览器半身走同源 fetch)。
// 约束: 不得改回 connection.rpc.handle——dsh 0.1.5-rc.2 起 client-connection
// 自身 inject 不再含 webServer, 该 API 对第三方插件构造性损坏
// (owner.webServer 必抛 "without inject"); 必须走 connection.fetch.register
// (由 client-connection 已挂载的 /api 路由伺服, Host/Origin + BrowserAuth 围栏一致)。
// 浏览器半身见 src/client/(exports["./client"], dsh.client 声明)。
// 依据: DSH client-modules 双面包模式(dsh-client-connection + client-modules
// 扫描 exports["./client"]); 设计文档 §17(宠物/收件箱读信号, 动作回核心函数)。
import type { Context } from '@deepseek-ai/cordis';
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection';
import { createNovelcraftHandlers } from './rpc.js';
import { ENDPOINTS, RPC_FETCH_PATH } from './wire.js';

/**
 * Fetch 路由结构面。不走 dsh-client-connection 的 ConnectionFetchRoute 类型:
 * 本仓锁定的 0.1.2-rc.1 类型 ConnectionFetchMethod 尚无 'POST'(0.1.5-rc.2 才加入),
 * 而两版运行时都按注册时的 methods 集合分发、无值域校验, 此处按运行时契约声明。
 */
interface HostFetchRoute {
  readonly path: string;
  readonly methods: readonly string[];
  readonly fetch: (request: Request) => Promise<Response>;
}

export const name = 'novelcraft-client';

/** 依赖宿主 client-connection(提供 ctx.connection)。 */
export const inject = ['connection'];

export { RPC_FETCH_PATH, ENDPOINTS };
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
  OutlinePreviewCard,
  OutlineSourceOption,
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
  WorldWorkspacePayload,
  WorldWorkspaceValue,
  WorldObjectCard,
  BiblePageCard,
} from './wire.js';
export type { NovelcraftHostService } from './rpc.js';
export { createNovelcraftHandlers, wireRefError } from './rpc.js';

/** 宿主插件体: 注册 Fetch 路由, 返回 disposer 走 effect。 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as
    | { fetch: { register(route: HostFetchRoute): () => Promise<void> } }
    | undefined;
  if (!connection?.fetch?.register) {
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
      [ENDPOINTS.worldWorkspace]: (p) => handlers.worldWorkspace(p),
    };
    const route = routes[endpoint];
    if (route === undefined) {
      return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${endpoint}`, details: {} } };
    }
    return route(payload as never);
  };
  const jsonResponse = (status: number, body: RpcResult<unknown>): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const disposer = connection.fetch.register({
    path: RPC_FETCH_PATH,
    methods: ['POST'],
    fetch: async (request): Promise<Response> => {
      const message = await request.json().catch(() => null) as { endpoint?: unknown; payload?: unknown } | null;
      if (!message || typeof message.endpoint !== 'string') {
        return jsonResponse(400, {
          ok: false,
          error: { code: 'bad-request', message: 'expected {endpoint, payload} envelope', details: {} },
        });
      }
      // 信封 payload 可为 null/缺省: 归一为 {} 让各端点走自己的作者语言校验,
      // 而不是在解引用处抛 TypeError(无端点区分 null 与 {})。
      const payload = message.payload ?? {};
      // 处理器异常折叠为 RpcResult(旧 rpc 通道由宿主 rpcFetchHandler 兜底;
      // Fetch 路由契约要求自行兜底, 否则异常穿成无体 4xx/5xx)。
      let result: RpcResult<unknown>;
      try {
        result = await handler(message.endpoint, payload, request.signal);
      } catch (error) {
        result = {
          ok: false,
          error: { code: 'internal', message: `endpoint ${message.endpoint} handler failed: ${String(error)}`, details: {} },
        };
      }
      return jsonResponse(200, result);
    },
  });
  ctx.effect(() => () => {
    void disposer();
  });
}
