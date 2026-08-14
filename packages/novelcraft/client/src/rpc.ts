// @novelcraft/client · node 半身: /novelcraft loopback RPC 通道处理器。
// 依据: 设计文档 §9/§17(宠物/收件箱读 .assistant/signals; 动作回调走核心包
// 确定性函数); §22.3(client seam = client-modules)。
// 数据路径: 浏览器 → ctx.connection.rpc.call('/novelcraft', endpoint, payload)
// → 本处理器(宿主) → @novelcraft/assistant 确定性函数(文件真相)。
// 采用类资产写入不在此通道 —— UI 的四动词只记录决定(assistant.act),
// adopt 由助手 agent 经 DSH approval 执行(§9 fail-closed)。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api';
import { act, inboxView, scanHealthSignals, type InboxAction, type Signal } from '@novelcraft/assistant';
import { resolvePolicy } from '@novelcraft/llm-step';
import { rebuildIndex, storyMap } from '@novelcraft/store';
import { latestProposal } from '@novelcraft/writing';
import type {
  InboxActPayload,
  InboxActValue,
  InboxListPayload,
  InboxListValue,
  ReviewCard,
  SignalCard,
  StoryMapPayload,
  StoryMapValue,
  WatchStatePayload,
  WatchStateValue,
  WritingDeskPayload,
  WritingDeskValue,
} from './wire.js';
import { ENDPOINTS } from './wire.js';

/** 宿主侧的 novelcraft 服务结构面(运行时 ctx.get('novelcraft'), 不硬依赖 @novelcraft/dsh)。 */
export interface NovelcraftHostService {
  vaults: {
    /** 会话 → vault 绑定(D17); 未绑定 undefined。 */
    resolve(sessionId: string): Promise<{ book: string; root: string } | undefined>;
    /** 任意路径 → 最近 vault 根; 未找到 undefined。 */
    resolveFromPath(startPath: string): { book: string; root: string } | undefined;
  };
}

interface JobsHostService {
  list(): Array<{ kind?: string; status?: string }>;
}

/** 统一错误包装(RpcError code 用 internal; 消息作者语言)。 */
export function rpcFail<T>(message: string): RpcResult<T> {
  return { ok: false, error: { code: 'internal', message, details: {} } };
}

export function rpcOk<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

function card(signal: Signal): SignalCard {
  return {
    id: signal.id,
    radar: signal.radar,
    severity: signal.severity,
    title: signal.title,
    evidence: signal.evidence,
    proposed_action: signal.proposed_action,
    reversibility: signal.reversibility,
    status: signal.status,
    observed_at: signal.observed_at,
  };
}

/** 读各章最新语义审查(.assistant/reviews/*.json)的摘要卡(评审台)。 */
function readReviewCards(root: string): ReviewCard[] {
  const dir = path.join(root, '.assistant', 'reviews');
  if (!existsSync(dir)) return [];
  const out: ReviewCard[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as {
        review_id?: string; chapter_index?: number; verdict?: string;
        findings?: unknown[]; reviewed_at?: string;
      };
      out.push({
        review_id: typeof rec.review_id === 'string' ? rec.review_id : f.replace(/\.json$/, ''),
        chapter_index: typeof rec.chapter_index === 'number' ? rec.chapter_index : 0,
        verdict: typeof rec.verdict === 'string' ? rec.verdict : '',
        finding_count: Array.isArray(rec.findings) ? rec.findings.length : 0,
        reviewed_at: typeof rec.reviewed_at === 'string' ? rec.reviewed_at : '',
      });
    } catch {
      // 非法 JSON 跳过
    }
  }
  return out.sort((a, b) => a.chapter_index - b.chapter_index || a.reviewed_at.localeCompare(b.reviewed_at));
}

/** 解析 vault 根: sessionId 优先, 其次 workspacePath 向上找; 都不可用 → undefined。 */
async function resolveRoot(
  svc: NovelcraftHostService | undefined,
  payload: { sessionId?: string; workspacePath?: string },
): Promise<{ book: string; root: string } | undefined> {
  if (!svc) return undefined;
  if (payload.sessionId) {
    const binding = await svc.vaults.resolve(payload.sessionId);
    if (binding) return binding;
  }
  if (payload.workspacePath) {
    return svc.vaults.resolveFromPath(payload.workspacePath);
  }
  return undefined;
}

/** 构造端点处理器(测试可直接调用, 不经 HTTP)。 */
export function createNovelcraftHandlers(ctx: Context) {
  const novelcraft = ctx.get('novelcraft') as NovelcraftHostService | undefined;

  return {
    async watchState(payload: WatchStatePayload): Promise<RpcResult<WatchStateValue>> {
      const binding = await resolveRoot(novelcraft, payload);
      if (!binding) {
        return rpcOk({ bound: null, open: 0, attention: false, threshold: 5, radarRunning: false });
      }
      const policy = resolvePolicy(binding.root);
      const open = inboxView(binding.root).length;
      const threshold = policy.watch.notify_threshold;
      let radarRunning = false;
      try {
        const jobs = ctx.get('jobs') as JobsHostService | undefined;
        radarRunning = (jobs?.list() ?? []).some(
          (j) => j.kind === 'novelcraft-radar' && (j.status === 'running' || j.status === 'stopping'),
        );
      } catch {
        radarRunning = false;
      }
      return rpcOk({
        bound: { book: binding.book, root: binding.root },
        open,
        attention: open >= threshold,
        threshold,
        radarRunning,
      });
    },

    async inboxList(payload: InboxListPayload): Promise<RpcResult<InboxListValue>> {
      const binding = await resolveRoot(novelcraft, payload);
      if (!binding) {
        return rpcOk({ bound: null, signals: [], threshold: 5 });
      }
      const policy = resolvePolicy(binding.root);
      const signals = inboxView(binding.root);
      return rpcOk({
        bound: { book: binding.book, root: binding.root },
        signals: signals.map(card),
        threshold: policy.watch.notify_threshold,
      });
    },

    async inboxAct(payload: InboxActPayload): Promise<RpcResult<InboxActValue>> {
      const binding = await resolveRoot(novelcraft, payload);
      if (!binding) {
        return rpcFail('未绑定工作区: 请先在助手侧打开这本书的会话(每书一会话, D17)。');
      }
      try {
        const descriptor = act(binding.root, {
          signalId: payload.signalId,
          action: payload.action as InboxAction,
          ...(payload.reason ? { reason: payload.reason } : {}),
          ...(payload.action === 'modify'
            ? {
                modified: {
                  ...(payload.modifiedTitle ? { title: payload.modifiedTitle } : {}),
                  ...(payload.modifiedProposedAction
                    ? { proposed_action: payload.modifiedProposedAction }
                    : {}),
                },
              }
            : {}),
        });
        const guide =
          descriptor.kind === 'adopt'
            ? '已记录采纳决定。资产采用请让助手执行(必经审批, §9)。'
            : descriptor.kind === 'microflow'
              ? `已路由微工作流「${descriptor.microflow ?? ''}」(由助手执行)。`
              : '已记录决定。';
        return rpcOk({
          ok: true,
          action: descriptor.action,
          kind: descriptor.kind,
          ...(descriptor.microflow ? { microflow: descriptor.microflow } : {}),
          message: guide,
        });
      } catch (err) {
        return rpcFail(err instanceof Error ? err.message : String(err));
      }
    },

    async storyMap(payload: StoryMapPayload): Promise<RpcResult<StoryMapValue>> {
      const binding = await resolveRoot(novelcraft, payload);
      if (!binding) {
        return rpcOk({ bound: null, book: '', chapters: [], scenes: [], threads: [], arcs: [], foreshadowing: [], reveals: [] });
      }
      try {
        const m = storyMap(binding.root);
        return rpcOk({
          bound: { book: binding.book, root: binding.root },
          book: m.book,
          chapters: m.chapters,
          scenes: m.scenes,
          threads: m.threads,
          arcs: m.arcs,
          foreshadowing: m.foreshadowing,
          reveals: m.reveals,
        });
      } catch (err) {
        return rpcFail(err instanceof Error ? err.message : String(err));
      }
    },

    async writingDesk(payload: WritingDeskPayload): Promise<RpcResult<WritingDeskValue>> {
      const binding = await resolveRoot(novelcraft, payload);
      if (!binding) {
        return rpcOk({ bound: null, book: '', chapters: [], threads: [], arcs: [], signals: [], objects: [], reviews: [], proposals: null });
      }
      try {
        // 打开写作台即刷新结构健康信号(确定性 + 幂等, §20.6)。
        scanHealthSignals(binding.root);
        const m = storyMap(binding.root);
        const index = rebuildIndex(binding.root);
        const proposal = latestProposal(binding.root);
        return rpcOk({
          bound: { book: binding.book, root: binding.root },
          book: m.book,
          chapters: m.chapters,
          threads: m.threads.map((t) => ({ slug: t.slug, name: t.name, thread_type: t.thread_type, status: t.status })),
          arcs: m.arcs.map((a) => ({ slug: a.slug, name: a.name, status: a.status })),
          signals: inboxView(binding.root).map(card),
          objects: index.objects.map((o) => ({ slug: o.slug, name: o.name, kind: o.kind, status: o.status })),
          reviews: readReviewCards(binding.root),
          proposals: proposal
            ? {
                run_id: proposal.run_id,
                chapter_index: proposal.chapter_index,
                next_chapter: proposal.next_chapter,
                generated_at: proposal.generated_at,
                proposals: proposal.proposals,
              }
            : null,
        });
      } catch (err) {
        return rpcFail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export { ENDPOINTS };
