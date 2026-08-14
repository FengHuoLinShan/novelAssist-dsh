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
import { act, inboxView, plotSummaryLine, scanHealthSignals, type InboxAction, type Signal } from '@novelcraft/assistant';
import { DEFAULT_CONTENT_PRESETS, resolvePolicy, selectPresetInLlmYml } from '@novelcraft/llm-step';
import { chapterDossier, rebuildIndex, storyMap } from '@novelcraft/store';
import { latestProposal, type ProposalRecord } from '@novelcraft/writing';
import type {
  ChapterDossierAsset,
  ChapterDossierPayload,
  ChapterDossierValue,
  ContentPresetCard,
  InboxActPayload,
  InboxActValue,
  InboxListPayload,
  InboxListValue,
  PresetsListPayload,
  PresetsListValue,
  PresetsSelectPayload,
  PresetsSelectValue,
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

/** 预设条目的结构形状(宿主 presets.list 返回 / llm-step ContentPreset 的投影)。 */
export type PresetLike = {
  name: string;
  label?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout_ms?: number;
};

/** 宿主侧的 novelcraft 服务结构面(运行时 ctx.get('novelcraft'), 不硬依赖 @novelcraft/dsh)。 */
export interface NovelcraftHostService {
  vaults: {
    /** 会话 → vault 绑定(D17); 未绑定 undefined。 */
    resolve(sessionId: string): Promise<{ book: string; root: string } | undefined>;
    /** 任意路径 → 最近 vault 根; 未找到 undefined。 */
    resolveFromPath(startPath: string): { book: string; root: string } | undefined;
  };
  /** 内容手预设卡注册表(N20: seed ∪ domain KV presets 表; 最小 profile 可缺省, 缺省时种子兜底)。 */
  presets?: {
    list(): Promise<PresetLike[]>;
  };
  /** 宿主配置(内容手默认路由 Config.llm; 缺省兜底 deepseek/deepseek-chat)。 */
  config?: { llm?: { provider: string; model: string } };
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

/** 未绑定缺省档案(全空, 不炸通道)。 */
const EMPTY_DOSSIER: ChapterDossierAsset = {
  chapter: null,
  scenes: [],
  characters: [],
  pov: [],
  foreshadowing: { planted: [], activeThrough: [], duePayoff: [] },
  reveals: [],
  referencedObjects: [],
  rhythm: { wordCount: 0, sceneCount: 0, avgSceneLength: 0 },
};

/** 指定 next_chapter 的最新一条续写提案(文件名序取最后, 与 writing.latestProposal 同口径; 无则 undefined)。 */
function latestProposalForChapter(root: string, nextChapter: number): ProposalRecord | undefined {
  const dir = path.join(root, '.assistant', 'proposals');
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(readFileSync(path.join(dir, files[i]), 'utf8')) as ProposalRecord;
      if (rec.next_chapter === nextChapter) return rec;
    } catch {
      // 非法 JSON 跳过(§17.5.1 容错)
    }
  }
  return undefined;
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

/** 内容手默认路由: 宿主 Config.llm; 缺省兜底 deepseek/deepseek-chat。 */
function defaultRouteOf(svc: NovelcraftHostService | undefined): { provider: string; model: string } {
  const p = svc?.config?.llm?.provider;
  const m = svc?.config?.llm?.model;
  return p && m ? { provider: p, model: m } : { provider: 'deepseek', model: 'deepseek-chat' };
}

/** 宿主预设面(list)容错读: 缺面/抛错 → 空数组(调用方种子兜底)。 */
async function listPresets(svc: NovelcraftHostService | undefined): Promise<PresetLike[]> {
  try {
    return (await svc?.presets?.list?.()) ?? [];
  } catch {
    return [];
  }
}

/** 预设卡纯 JSON 投影 + source 标注(种子 = DEFAULT_CONTENT_PRESETS 名单; 其余 stored)。 */
function presetCard(p: PresetLike, seedNames: ReadonlySet<string>): ContentPresetCard {
  return {
    name: p.name,
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.provider !== undefined ? { provider: p.provider } : {}),
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
    ...(p.top_p !== undefined ? { top_p: p.top_p } : {}),
    ...(p.max_tokens !== undefined ? { max_tokens: p.max_tokens } : {}),
    ...(p.timeout_ms !== undefined ? { timeout_ms: p.timeout_ms } : {}),
    source: seedNames.has(p.name) ? 'seed' : 'stored',
  };
}

/** 已注册 provider 路由 id 列表(ctx.llm); 服务缺省/抛错 → 空数组, 不炸。 */
function listAvailableProviders(ctx: Context): string[] {
  try {
    const llm = ctx.get('llm') as { listProviders?: () => string[] } | undefined;
    return llm?.listProviders?.() ?? [];
  } catch {
    return [];
  }
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
      // 剧情雷达摘要(§9: 宠物静默态点击的默认答复; 确定性, 失败兜底空串)。
      let plotSummary = '';
      try {
        plotSummary = plotSummaryLine(binding.root);
      } catch {
        plotSummary = '';
      }
      return rpcOk({
        bound: { book: binding.book, root: binding.root },
        open,
        attention: open >= threshold,
        threshold,
        radarRunning,
        plotSummary,
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
        return rpcOk({ bound: null, book: '', chapters: [], scenes: [], threads: [], arcs: [], foreshadowing: [], reveals: [], edges: [] });
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
          edges: m.edges,
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

    async chapterDossier(payload: ChapterDossierPayload): Promise<RpcResult<ChapterDossierValue>> {
      const binding = await resolveRoot(novelcraft, payload);
      if (!binding) {
        return rpcOk({ bound: null, dossier: EMPTY_DOSSIER, review: null, signals: [], proposal: null });
      }
      try {
        // 坏数据容错: 非有限数 → 0(该章通常不存在 → chapter=null 兜底, 不炸)。
        const idx = Number.isFinite(payload.chapterIndex) ? Math.trunc(payload.chapterIndex) : 0;
        // 资产面: store.chapterDossier(逐资产容错自组装, §17.5.1)。
        const dossier = chapterDossier(binding.root, idx);
        // 读面: 本章最新审查 / 本章 open 信号(inboxView 已滤 open+新鲜) / next_chapter==N 最新提案。
        const reviews = readReviewCards(binding.root).filter((r) => r.chapter_index === idx);
        const review = reviews.length > 0 ? reviews[reviews.length - 1] : null;
        const signals = inboxView(binding.root)
          .filter((s) => s.target?.chapter_index === idx)
          .map(card);
        const proposal = latestProposalForChapter(binding.root, idx);
        return rpcOk({
          bound: { book: binding.book, root: binding.root },
          dossier,
          review: review
            ? {
                review_id: review.review_id,
                verdict: review.verdict,
                finding_count: review.finding_count,
                reviewed_at: review.reviewed_at,
              }
            : null,
          signals,
          proposal: proposal
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

    async presetsList(payload: PresetsListPayload): Promise<RpcResult<PresetsListValue>> {
      const binding = await resolveRoot(novelcraft, payload);
      // 注册表(种子 ∪ 存储); 无 presets 面(最小 profile)→ 种子兜底, 不炸。
      const registered = await listPresets(novelcraft);
      const list = registered.length > 0 ? registered : DEFAULT_CONTENT_PRESETS;
      const seedNames = new Set(DEFAULT_CONTENT_PRESETS.map((s) => s.name));
      return rpcOk({
        bound: binding ? { book: binding.book, root: binding.root } : null,
        presets: list.map((p) => presetCard(p, seedNames)),
        active: binding ? (resolvePolicy(binding.root).llm.preset ?? null) : null,
        defaultRoute: defaultRouteOf(novelcraft),
        availableProviders: listAvailableProviders(ctx),
      });
    },

    async presetsSelect(payload: PresetsSelectPayload): Promise<RpcResult<PresetsSelectValue>> {
      const binding = await resolveRoot(novelcraft, payload);
      if (!binding) {
        return rpcFail('未绑定工作区: 请先在助手侧打开这本书的会话(每书一会话, D17)。');
      }
      const name = payload.preset ?? null;
      // 校验: 非 null 时预设必须存在(注册表 ∪ 种子); 不存在 → 拒绝, 不写文件(N19 写边界)。
      if (name !== null) {
        const registered = await listPresets(novelcraft);
        const known = registered.length > 0 ? registered : DEFAULT_CONTENT_PRESETS;
        const found = known.find((p) => p.name === name);
        if (!found) {
          return rpcFail(`预设不存在: ${name}`);
        }
        // 写边界(N19): 只允许经 selectPresetInLlmYml 写 llm.yml 的 preset 单键(配置非资产, 不过 approval)。
        try {
          selectPresetInLlmYml(binding.root, name);
        } catch (err) {
          return rpcFail(err instanceof Error ? err.message : String(err));
        }
        const route = defaultRouteOf(novelcraft);
        const provider = found.provider ?? route.provider;
        const model = found.model ?? route.model;
        const label = found.label ?? name;
        return rpcOk({
          ok: true,
          active: resolvePolicy(binding.root).llm.preset ?? null,
          message: `内容手已切到「${label}」(${provider}·${model})`,
        });
      }
      // name === null: 恢复默认(移除 llm.yml 的 preset 键, 其余键原样保留)。
      try {
        selectPresetInLlmYml(binding.root, null);
      } catch (err) {
        return rpcFail(err instanceof Error ? err.message : String(err));
      }
      return rpcOk({
        ok: true,
        active: resolvePolicy(binding.root).llm.preset ?? null,
        message: '已恢复默认(内容手继承助手配置)',
      });
    },
  };
}

export { ENDPOINTS };
