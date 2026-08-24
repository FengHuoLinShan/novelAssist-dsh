// @novelcraft/dsh-client · node 半身: /novelcraft loopback RPC 通道处理器。
// 依据: 设计文档 §9/§17(宠物/收件箱读 .assistant/signals; 动作回调走宿主服务面);
// §22.3(client seam = client-modules, 不直接 import 核心包运行时)。
// 数据路径: 浏览器 → ctx.connection.rpc.call('/novelcraft', endpoint, payload)
// → 本处理器(宿主) → ctx.novelcraft.ui(read/view/stage/records/config, 铁律 3:
// 本通道零正史写, adopt 由助手 agent 经 DSH approval 执行, §9 fail-closed)。
// 核心包仅作 type-only import(零运行时依赖; 运行时数据面全部经宿主 ui seam)。
import type { Context } from '@deepseek-ai/cordis';
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api';
import type { HealthScanResult, Signal } from '@novelcraft/assistant';
import type { ResolvedPolicy } from '@novelcraft/llm-step';
import type {
  ChapterDiff,
  ChapterDossier,
  ChapterHistoryCardView,
  CurrentChapter,
  StoryMap,
  VaultIndex,
} from '@novelcraft/store';
import type { StagedFileIntake } from '@novelcraft/vault';
import type {
  AtlasAnnotationQueueStatus,
  AtlasNodeView,
  AtlasPageView,
  AtlasRun,
  AtlasTree,
} from '@novelcraft/world';
import type {
  ChapterCandidateSnapshot,
  ProposalRecord,
  ReviewRecord,
  ReviewSummaryCard,
} from '@novelcraft/writing';
import type {
  ChapterDossierAsset,
  ChapterDossierPayload,
  ChapterDossierValue,
  ChapterEditStagePayload,
  ChapterEditStageValue,
  ChapterWorkspacePayload,
  ChapterWorkspaceValue,
  ChapterReviewCard,
  ContentPresetCard,
  InboxActPayload,
  InboxActValue,
  InboxListPayload,
  InboxListValue,
  IntakeStagePayload,
  IntakeStageValue,
  PresetsListPayload,
  PresetsListValue,
  AtlasAnnotationRequestPayload,
  AtlasAnnotationRequestValue,
  AtlasImageIntakeStagePayload,
  AtlasImageIntakeStageValue,
  AtlasLabelCard,
  AtlasNodeCard,
  AtlasPageCard,
  AtlasViewPayload,
  AtlasViewValue,
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
import { ENDPOINTS, MAX_TEXT_INTAKE_BYTES } from './wire.js';

function decodeIntakeBase64(encoded: unknown): Buffer {
  const maxBase64Length = Math.ceil(MAX_TEXT_INTAKE_BYTES / 3) * 4;
  if (
    typeof encoded !== 'string' || encoded.length === 0 || encoded.length > maxBase64Length ||
    encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error('文件内容编码非法或超过 50MB');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength > MAX_TEXT_INTAKE_BYTES || bytes.toString('base64') !== encoded) {
    throw new Error('文件内容编码非法或超过 50MB');
  }
  return bytes;
}

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

/** 页内章节编辑收据输入(与宿主 ui.stage 同形)。 */
interface ChapterEditStageInput {
  chapterIndex: number;
  text: string;
  expectedContentHash?: string;
  title?: string;
}

/**
 * 宿主侧的 novelcraft 服务结构面(运行时 ctx.get('novelcraft'), 不硬依赖 @novelcraft/dsh)。
 * ui = 客户端数据面(只读聚合 view / 冻结读 read / 收据暂存 stage / 决定记录 records /
 * 配置 config); 由 @novelcraft/dsh 的 service.ui 结构性满足。
 */
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
  /** 客户端数据面(@novelcraft/dsh service.ui 的结构子集)。 */
  ui: {
    read: {
      inbox(root: string): Signal[];
      chapterCurrent(root: string, chapterIndex: number): CurrentChapter;
      chapterDiff(root: string, chapterIndex: number, fromCommit: string, toCommit?: string): ChapterDiff;
      chapterReview(
        root: string,
        chapterIndex: number,
        target: 'current' | 'candidate',
        ref?: string,
      ): ReviewRecord | undefined;
      viewMapAtlas(root: string, runId?: string): { tree: AtlasTree; run: AtlasRun | null };
    };
    view: {
      vaultPolicy(root: string): ResolvedPolicy;
      plotSummary(root: string): string;
      storyMap(root: string): StoryMap;
      chapterIndex(root: string): VaultIndex;
      reviewSummaries(root: string): ReviewSummaryCard[];
      latestProposal(root: string): ProposalRecord | undefined;
      latestProposalForChapter(root: string, nextChapter: number): ProposalRecord | undefined;
      chapterDossier(root: string, chapterIndex: number): ChapterDossier;
      chapterHistoryCards(root: string, chapterIndex: number): ChapterHistoryCardView[];
      chapterCandidate(root: string, chapterIndex: number, ref: string): ChapterCandidateSnapshot;
      pendingChapterRefs(root: string): number[];
      scanHealth(root: string): Promise<HealthScanResult>;
      atlasQueueStatus(root: string): AtlasAnnotationQueueStatus;
      atlasImagePreview(root: string, file: string, mediaType: string, byteSize: number): string | undefined;
      presetSeeds(): PresetLike[];
    };
    stage: {
      stageTextIntake(root: string, sessionId: string, fileName: string, bytes: Uint8Array): StagedFileIntake;
      stageAtlasImageIntake(
        root: string,
        sessionId: string,
        fileName: string,
        bytes: Uint8Array,
        nodeRef: string,
      ): StagedFileIntake;
      stageChapterEditIntake(root: string, sessionId: string, input: ChapterEditStageInput): StagedFileIntake;
      queueAtlasAnnotations(
        root: string,
        pageRef: string,
        baseContentHash: string,
        ops: readonly unknown[],
      ): { file: string };
    };
    records: {
      actOnSignal(
        root: string,
        signalId: string,
        action: 'accept' | 'reject' | 'modify' | 'defer',
        opts?: { reason?: string; modifiedTitle?: string; modifiedProposedAction?: string },
      ): Promise<{
        action: string;
        kind: 'adopt' | 'microflow' | 'record';
        microflow?: string;
      }>;
    };
    config: {
      selectPreset(root: string, preset: string | null): void;
    };
  };
}

interface JobsHostService {
  list(): Array<{ kind?: string; status?: string }>;
}

/** 统一错误包装(RpcError code 用 internal; 消息作者语言)。 */
export function rpcFail<T>(message: string): RpcResult<T> {
  return { ok: false, error: { code: 'internal', message, details: {} } };
}

/** 收件箱四动词(与 wire InboxActPayload.action 对齐; 运行时判定用, 防恶意/损坏载荷)。 */
const INBOX_ACTIONS = ['accept', 'reject', 'modify', 'defer'] as const;

/**
 * wire 文件名级引用(page_ref / runId / signalId)运行时校验。
 *
 * 这些值会被宿主拼进落盘/读盘路径(signalFile/runFile/`${page_ref}.json`),
 * 单靠 guardPath 只能拦「逃出 vault 根」, 拦不住「../.assistant/signals/x」这类
 * vault 内跨目录写入。约定这些引用必须是「文件名」(不含路径分隔符), 否则直接拒绝:
 * - 非空字符串(空白修剪后非空);
 * - 长度 ≤ 128(合理上限; vault slug 限 64, 机器生成 id 更短);
 * - 非 '.' / '..';
 * - 不含 '/'、'\' 与任何控制字符。
 *
 * 返回作者语言错误消息; 合法返回 null。
 */
export function wireRefError(ref: unknown, label: string): string | null {
  if (typeof ref !== 'string' || ref.trim() === '') return `${label} 必填`;
  if (ref.length > 128) return `${label} 过长(≤128 字符)`;
  if (ref === '.' || ref === '..') return `${label} 非法: ${ref}`;
  if (/[\\/\u0000-\u001f\u007f]/.test(ref)) {
    return `${label} 含非法字符(不得含 /、\\ 与控制字符)`;
  }
  return null;
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

function chapterReviewCard(review: ReviewRecord, fresh: boolean): ChapterReviewCard {
  return {
    review_id: review.review_id,
    verdict: review.verdict ?? '',
    reviewed_at: review.reviewed_at,
    fresh,
    findings: review.findings.map((finding, index) => ({
      finding_id: finding.finding_id,
      category: finding.category,
      severity: finding.severity,
      quote: finding.quote,
      suggestion: finding.suggestion,
      rejected: review.rejected_findings?.[finding.finding_id] !== undefined ||
        review.rejected_findings?.[String(index)] !== undefined,
    })),
  };
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

/** 预设卡纯 JSON 投影 + source 标注(种子 = ui.view.presetSeeds() 名单; 其余 stored)。 */
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
    /** Browser-selected bytes only: issue a session-bound receipt; do not write book assets. */
  async intakeStage(payload: IntakeStagePayload): Promise<RpcResult<IntakeStageValue>> {
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      return rpcFail('缺少当前会话, 拒绝接收文件');
    }
    const binding = await novelcraft?.vaults.resolve(payload.sessionId);
    if (!binding) return rpcFail('当前会话未绑定 vault');
    if (typeof payload.file_name !== 'string') {
      return rpcFail('文件载荷格式错误');
    }
    if (!novelcraft?.ui) return rpcFail('宿主未提供 novelcraft UI 面');
    try {
      const bytes = decodeIntakeBase64(payload.bytes_base64);
      const staged = novelcraft.ui.stage.stageTextIntake(binding.root, payload.sessionId, payload.file_name, bytes);
      return rpcOk({
        receipt_id: staged.receiptId,
        file_name: staged.fileName,
        byte_length: staged.byteLength,
        sha256: staged.sha256,
        message: `已授权「${staged.fileName}」。返回对话说“导入刚才的手稿”即可。`,
      });
    } catch (error) {
      return rpcFail(error instanceof Error ? error.message : String(error));
    }
  },

  async intakeStageImage(payload: AtlasImageIntakeStagePayload): Promise<RpcResult<AtlasImageIntakeStageValue>> {
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) return rpcFail('缺少当前会话, 拒绝接收图片');
    const binding = await novelcraft?.vaults.resolve(payload.sessionId);
    if (!binding) return rpcFail('当前会话未绑定 vault');
    const nodeRefError = wireRefError(payload.node_ref, 'node_ref');
    if (nodeRefError) return rpcFail(nodeRefError);
    if (typeof payload.file_name !== 'string') return rpcFail('图片载荷格式错误');
    if (!novelcraft?.ui) return rpcFail('宿主未提供 novelcraft UI 面');
    try {
      const staged = novelcraft.ui.stage.stageAtlasImageIntake(
        binding.root,
        payload.sessionId,
        payload.file_name,
        decodeIntakeBase64(payload.bytes_base64),
        payload.node_ref,
      );
      return rpcOk({
        receipt_id: staged.receiptId,
        file_name: staged.fileName,
        byte_length: staged.byteLength,
        sha256: staged.sha256,
        node_ref: payload.node_ref,
        message: `已授权「${staged.fileName}」。返回对话说“导入刚才的地图图片”即可。`,
      });
    } catch (error) {
      return rpcFail(error instanceof Error ? error.message : String(error));
    }
  },

  async watchState(payload: WatchStatePayload): Promise<RpcResult<WatchStateValue>> {
    const binding = await resolveRoot(novelcraft, payload);
    if (!binding || !novelcraft?.ui) {
      return rpcOk({ bound: null, open: 0, attention: false, threshold: 5, radarRunning: false });
    }
    const policy = novelcraft.ui.view.vaultPolicy(binding.root);
    const open = novelcraft.ui.read.inbox(binding.root).length;
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
      plotSummary = novelcraft.ui.view.plotSummary(binding.root);
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
    if (!binding || !novelcraft?.ui) {
      return rpcOk({ bound: null, signals: [], threshold: 5 });
    }
    const policy = novelcraft.ui.view.vaultPolicy(binding.root);
    const signals = novelcraft.ui.read.inbox(binding.root);
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
    if (!novelcraft?.ui) return rpcFail('宿主未提供 novelcraft UI 面');
    // wire 校验(R9/N19 写边界; 防损坏/恶意载荷破坏信号文件):
    // signalId 必须可安全当文件名用; action 四动词之一; 字符串字段类型核对。
    const signalRefErr = wireRefError(payload.signalId, 'signalId');
    if (signalRefErr) return rpcFail(signalRefErr);
    if (!INBOX_ACTIONS.includes(payload.action)) {
      return rpcFail('action 非法: 必须 accept/reject/modify/defer 之一');
    }
    if (payload.reason !== undefined && typeof payload.reason !== 'string') {
      return rpcFail('reason 必须是字符串');
    }
    if (payload.modifiedTitle !== undefined && typeof payload.modifiedTitle !== 'string') {
      return rpcFail('modifiedTitle 必须是字符串');
    }
    if (payload.modifiedProposedAction !== undefined && typeof payload.modifiedProposedAction !== 'string') {
      return rpcFail('modifiedProposedAction 必须是字符串');
    }
    try {
      const descriptor = await novelcraft.ui.records.actOnSignal(
        binding.root,
        payload.signalId,
        payload.action,
        {
          ...(payload.reason ? { reason: payload.reason } : {}),
          ...(payload.action === 'modify'
            ? {
                ...(payload.modifiedTitle ? { modifiedTitle: payload.modifiedTitle } : {}),
                ...(payload.modifiedProposedAction
                  ? { modifiedProposedAction: payload.modifiedProposedAction }
                  : {}),
              }
            : {}),
        },
      );
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
    if (!binding || !novelcraft?.ui) {
      return rpcOk({ bound: null, book: '', chapters: [], scenes: [], threads: [], arcs: [], foreshadowing: [], reveals: [], edges: [] });
    }
    try {
      const m = novelcraft.ui.view.storyMap(binding.root);
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
    if (!binding || !novelcraft?.ui) {
      return rpcOk({ bound: null, book: '', chapters: [], threads: [], arcs: [], signals: [], objects: [], reviews: [], proposals: null });
    }
    try {
      const ui = novelcraft.ui;
      // 打开写作台即刷新结构健康信号(确定性 + 幂等, §20.6)。
      await ui.view.scanHealth(binding.root);
      const m = ui.view.storyMap(binding.root);
      const index = ui.view.chapterIndex(binding.root);
      const proposal = ui.view.latestProposal(binding.root);
      return rpcOk({
        bound: { book: binding.book, root: binding.root },
        book: m.book,
        chapters: m.chapters,
        threads: m.threads.map((t) => ({ slug: t.slug, name: t.name, thread_type: t.thread_type, status: t.status })),
        arcs: m.arcs.map((a) => ({ slug: a.slug, name: a.name, status: a.status })),
        signals: ui.read.inbox(binding.root).map(card),
        objects: index.objects.map((o) => ({ slug: o.slug, name: o.name, kind: o.kind, status: o.status })),
        reviews: ui.view.reviewSummaries(binding.root) as ReviewCard[],
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
    if (!binding || !novelcraft?.ui) {
      return rpcOk({ bound: null, dossier: EMPTY_DOSSIER, review: null, signals: [], proposal: null });
    }
    try {
      // 坏数据容错: 非有限/非正章节不下探严格的 vault.chapterFile 正整数门禁，
      // 直接返回空档案；合法数值仍按整数章读取。
      const idx = Number.isFinite(payload.chapterIndex) ? Math.trunc(payload.chapterIndex) : 0;
      if (idx < 1) {
        return rpcOk({
          bound: { book: binding.book, root: binding.root },
          dossier: EMPTY_DOSSIER,
          review: null,
          signals: [],
          proposal: null,
        });
      }
      const ui = novelcraft.ui;
      // 资产面: chapterDossier(逐资产容错自组装, §17.5.1)。
      const dossier = ui.view.chapterDossier(binding.root, idx);
      // 读面: 本章最新审查 / 本章 open 信号(inbox 已滤 open+新鲜) / next_chapter==N 最新提案。
      const reviews = ui.view.reviewSummaries(binding.root).filter((r) => r.chapter_index === idx);
      const review = reviews.length > 0 ? reviews[reviews.length - 1] : null;
      const signals = ui.read.inbox(binding.root)
        .filter((s) => s.target?.chapter_index === idx)
        .map(card);
      const proposal = ui.view.latestProposalForChapter(binding.root, idx);
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

  /** Sustained editor read model: exact session binding + strict current chapter selector. */
  async chapterWorkspace(payload: ChapterWorkspacePayload): Promise<RpcResult<ChapterWorkspaceValue>> {
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      return rpcOk({ bound: null, chapters: [], chapter: null, history: [], review: null, candidate: null, diff: null });
    }
    const binding = await novelcraft?.vaults.resolve(payload.sessionId);
    if (!binding || !novelcraft?.ui) return rpcOk({ bound: null, chapters: [], chapter: null, history: [], review: null, candidate: null, diff: null });
    const ui = novelcraft.ui;
    try {
      const index = Number.isInteger(payload.chapterIndex) && payload.chapterIndex >= 1
        ? payload.chapterIndex
        : 0;
      const chapters = ui.view.chapterIndex(binding.root).chapters
        .filter((chapter) => ['draft', 'published', 'canonical'].includes(chapter.status))
        .map((chapter) => ({ index: chapter.index, ...(chapter.title !== undefined ? { title: chapter.title } : {}) }));
      const knownIndexes = new Set(chapters.map((chapter) => chapter.index));
      for (const candidateIndex of ui.view.pendingChapterRefs(binding.root)) {
        if (knownIndexes.has(candidateIndex)) continue;
        chapters.push({ index: candidateIndex });
        knownIndexes.add(candidateIndex);
      }
      chapters.sort((left, right) => left.index - right.index);
      if (index === 0) {
        return rpcOk({ bound: { book: binding.book, root: binding.root }, chapters, chapter: null, history: [], review: null, candidate: null, diff: null });
      }
      let chapter: CurrentChapter | null = null;
      try {
        chapter = ui.read.chapterCurrent(binding.root, index);
      } catch (error) {
        if ((error as { code?: string }).code !== 'NOT_FOUND') throw error;
      }
      const history = chapter ? ui.view.chapterHistoryCards(binding.root, index) : [];
      const diff = chapter && payload.diffFromCommit
        ? ui.read.chapterDiff(binding.root, index, payload.diffFromCommit, chapter.head)
        : null;
      const currentReview = chapter ? ui.read.chapterReview(binding.root, index, 'current') : null;
      const review = currentReview && chapter
        ? chapterReviewCard(
            currentReview,
            currentReview.target_kind === 'current' && currentReview.target_content_hash === chapter.contentHash,
          )
        : null;
      let candidate: ChapterWorkspaceValue['candidate'] = null;
      try {
        const ref = String(index).padStart(3, '0');
        const snapshot = ui.view.chapterCandidate(binding.root, index, ref);
        const candidateReview = ui.read.chapterReview(binding.root, index, 'candidate', ref);
        candidate = {
          ref: snapshot.ref,
          source: snapshot.source,
          body: snapshot.body,
          content_hash: snapshot.contentHash,
          review: candidateReview
            ? chapterReviewCard(
                candidateReview,
                candidateReview.verdict === 'pass' &&
                  candidateReview.target_content_hash === snapshot.contentHash &&
                  candidateReview.target_file_hash === snapshot.fileHash,
              )
            : null,
        };
      } catch {
        // No exact current candidate for this chapter; history stays in Git/files.
      }
      return rpcOk({
        bound: { book: binding.book, root: binding.root },
        chapters,
        chapter: chapter ? {
          index: chapter.chapterIndex,
          ...(chapter.title !== undefined ? { title: chapter.title } : {}),
          status: chapter.status,
          body: chapter.body,
          content_hash: chapter.contentHash,
          head: chapter.head,
        } : null,
        history,
        review,
        candidate,
        diff: diff
          ? {
              from_commit: diff.from.commit,
              to_commit: diff.to.commit,
              patch: diff.patch,
              truncated: diff.truncated,
            }
          : null,
      });
    } catch (error) {
      return rpcFail(error instanceof Error ? error.message : String(error));
    }
  },

  /** Loopback stages immutable bytes only; the assistant tool owns approval + canonical write. */
  async chapterStageEdit(payload: ChapterEditStagePayload): Promise<RpcResult<ChapterEditStageValue>> {
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      return rpcFail('缺少当前会话, 拒绝保存章节');
    }
    const binding = await novelcraft?.vaults.resolve(payload.sessionId);
    if (!binding) return rpcFail('当前会话未绑定 vault');
    if (!novelcraft?.ui) return rpcFail('宿主未提供 novelcraft UI 面');
    try {
      const staged = novelcraft.ui.stage.stageChapterEditIntake(binding.root, payload.sessionId, {
        chapterIndex: payload.chapterIndex,
        text: payload.text,
        expectedContentHash: payload.expected_content_hash,
        ...(payload.title !== undefined ? { title: payload.title } : {}),
      });
      return rpcOk({
        receipt_id: staged.receiptId,
        chapter_index: payload.chapterIndex,
        byte_length: staged.byteLength,
        sha256: staged.sha256,
        message: `第 ${payload.chapterIndex} 章编辑已暂存, 正在交给助手审批保存。`,
      });
    } catch (error) {
      return rpcFail(error instanceof Error ? error.message : String(error));
    }
  },

  async presetsList(payload: PresetsListPayload): Promise<RpcResult<PresetsListValue>> {
    const binding = await resolveRoot(novelcraft, payload);
    // 注册表(种子 ∪ 存储); 无 presets 面(最小 profile)→ 种子兜底, 不炸。
    const seeds = novelcraft?.ui ? novelcraft.ui.view.presetSeeds() : [];
    const registered = await listPresets(novelcraft);
    const list = registered.length > 0 ? registered : seeds;
    const seedNames = new Set(seeds.map((s) => s.name));
    return rpcOk({
      bound: binding ? { book: binding.book, root: binding.root } : null,
      presets: list.map((p) => presetCard(p, seedNames)),
      active: binding && novelcraft?.ui ? (novelcraft.ui.view.vaultPolicy(binding.root).llm.preset ?? null) : null,
      defaultRoute: defaultRouteOf(novelcraft),
      availableProviders: listAvailableProviders(ctx),
    });
  },

  async presetsSelect(payload: PresetsSelectPayload): Promise<RpcResult<PresetsSelectValue>> {
    const binding = await resolveRoot(novelcraft, payload);
    if (!binding) {
      return rpcFail('未绑定工作区: 请先在助手侧打开这本书的会话(每书一会话, D17)。');
    }
    if (!novelcraft?.ui) return rpcFail('宿主未提供 novelcraft UI 面');
    const ui = novelcraft.ui;
    const name = payload.preset ?? null;
    // 校验: 非 null 时预设必须存在(注册表 ∪ 种子); 不存在 → 拒绝, 不写文件(N19 写边界)。
    if (name !== null) {
      const registered = await listPresets(novelcraft);
      const known = registered.length > 0 ? registered : ui.view.presetSeeds();
      const found = known.find((p) => p.name === name);
      if (!found) {
        return rpcFail(`预设不存在: ${name}`);
      }
      // 写边界(N19): 只允许经宿主 ui.config.selectPreset 写 llm.yml 的 preset 单键
      // (配置非资产, 不过 approval)。
      try {
        ui.config.selectPreset(binding.root, name);
      } catch (err) {
        return rpcFail(err instanceof Error ? err.message : String(err));
      }
      const route = defaultRouteOf(novelcraft);
      const provider = found.provider ?? route.provider;
      const model = found.model ?? route.model;
      const label = found.label ?? name;
      return rpcOk({
        ok: true,
        active: ui.view.vaultPolicy(binding.root).llm.preset ?? null,
        message: `内容手已切到「${label}」(${provider}·${model})`,
      });
    }
    // name === null: 恢复默认(移除 llm.yml 的 preset 键, 其余键原样保留)。
    try {
      ui.config.selectPreset(binding.root, null);
    } catch (err) {
      return rpcFail(err instanceof Error ? err.message : String(err));
    }
    return rpcOk({
      ok: true,
      active: ui.view.vaultPolicy(binding.root).llm.preset ?? null,
      message: '已恢复默认(内容手继承助手配置)',
    });
  },

  // ---- map-atlas(Phase 6; 只读视图 + 标注队列请求, 不写资产; 铁律 3) ----
  async atlasView(payload: AtlasViewPayload): Promise<RpcResult<AtlasViewValue>> {
    const binding = await resolveRoot(novelcraft, payload);
    const empty: AtlasViewValue = {
      bound: binding ? { book: binding.book, root: binding.root } : null,
      run: null,
      adopted: { nodes: [], pages: [] },
      pending: { nodes: [], pages: [] },
      queue: { files: 0, ops: 0, pages: [] },
    };
    if (!binding || !novelcraft?.ui) return rpcOk(empty);
    try {
      const ui = novelcraft.ui;
      const root = binding.root;
      // runId 是文件名级引用(runFile 拼接); wire 校验后再读, 非法直接拒绝(不落盘读写)。
      if (payload.runId) {
        const runRefErr = wireRefError(payload.runId, 'runId');
        if (runRefErr) return rpcFail(runRefErr);
      }
      const { tree, run } = ui.read.viewMapAtlas(root, payload.runId);
      const toLabels = (pg: AtlasPageView): AtlasLabelCard[] =>
        pg.annotations.map((a) => ({
          id: a.id,
          label: a.label,
          position_x: a.position_x,
          position_y: a.position_y,
          ...(a.target_node_ref !== undefined ? { target_node_ref: a.target_node_ref } : {}),
          ...(a.sort_order !== undefined ? { sort_order: a.sort_order } : {}),
        }));
      const toPageCard = (pg: AtlasPageView, level: string): AtlasPageCard => {
        let image: AtlasPageCard['image'];
        if (pg.image) {
          const preview = ui.view.atlasImagePreview(root, pg.image.file, pg.image.media_type, pg.image.byte_size);
          image = {
            file: pg.image.file,
            media_type: pg.image.media_type,
            width: pg.image.width,
            height: pg.image.height,
            byte_size: pg.image.byte_size,
            ...(preview !== undefined ? { preview_data_url: preview } : {}),
          };
        }
        return {
          id: pg.id,
          node_ref: pg.node_ref,
          title: pg.title,
          level,
          generation_status: pg.generation_status,
          review_status: pg.review_status,
          visual_brief: pg.visual_brief,
          prompt: pg.prompt,
          evidence: pg.evidence,
          ...(image ? { image } : {}),
          image_missing: pg.image_missing,
          annotations: toLabels(pg),
          content_hash: pg.content_hash,
        };
      };
      const toNodeCard = (n: AtlasNodeView): AtlasNodeCard => ({
        id: n.id,
        parent_ref: n.parent_ref,
        title: n.title,
        level: n.level,
        status: n.status,
        is_placeholder: n.is_placeholder,
      });
      const levelOf = (nodeRef: string): string =>
        [...tree.nodes, ...tree.pendingNodes].find((n) => n.id === nodeRef)?.level ?? 'world';
      const queue = ui.view.atlasQueueStatus(root);
      return rpcOk({
        bound: { book: binding.book, root },
        run: run
          ? {
              id: run.id,
              run_kind: run.run_kind,
              status: run.status,
              planned_page_count: run.planned_page_count,
              error_code: run.error_code,
              error_message: run.error_message,
              created_at: run.created_at ?? '',
            }
          : null,
        adopted: {
          nodes: tree.nodes.map(toNodeCard),
          pages: tree.pages.map((pg) => toPageCard(pg, levelOf(pg.node_ref))),
        },
        pending: {
          nodes: tree.pendingNodes.map(toNodeCard),
          pages: tree.pendingPages.map((pg) => toPageCard(pg, levelOf(pg.node_ref))),
        },
        queue: { files: queue.files, ops: queue.ops, pages: queue.pages },
      });
    } catch (err) {
      return rpcFail(err instanceof Error ? err.message : String(err));
    }
  },

  /**
   * 标注请求(计划 Phase 6 L1+快捷编辑桥): 不写 page 资产 —— 只把精确 ops 落盘
   * .assistant/atlas/annotation-queue/<page_ref>.json 并 push 一条信号(铁律 3: RPC 只记录)。
   * 应用由助手 agent 调 novelcraft_map_atlas_annotation 工具(CAS + 单 commit + 清队列)。
   */
  async atlasAnnotationRequest(payload: AtlasAnnotationRequestPayload): Promise<RpcResult<AtlasAnnotationRequestValue>> {
    const binding = await resolveRoot(novelcraft, payload);
    if (!binding) return rpcFail('未绑定 vault');
    if (!novelcraft?.ui) return rpcFail('宿主未提供 novelcraft UI 面');
    try {
      // page_ref 是文件名级引用(`${page_ref}.json` 拼接落队列); 校验不通过即拒绝,
      // 防止 '../.assistant/signals/x' 这类 vault 内跨目录写入(wireRefError 见上)。
      const pageRefErr = wireRefError(payload.page_ref, 'page_ref');
      if (pageRefErr) return rpcFail(pageRefErr);
      if (!Array.isArray(payload.ops) || payload.ops.length === 0) return rpcFail('ops 至少一条');
      // 只收精确结构化 ops; 坐标恒为归一化 0–1(规则 11), 不做任何自然语言换算。
      // 运行时逐条校验(防损坏/恶意载荷): op 枚举 + position_x/y 必须是有限 number 且 0–1。
      const ops = payload.ops as unknown[];
      for (const op of ops) {
        if (typeof op !== 'object' || op === null) return rpcFail('ops 每条必须是对象');
        const raw = op as { op?: unknown; position_x?: unknown; position_y?: unknown };
        if (
          typeof raw.op !== 'string' ||
          !['add', 'update', 'delete'].includes(raw.op)
        ) {
          return rpcFail(`非法 op: ${String(raw.op)}`);
        }
        for (const key of ['position_x', 'position_y'] as const) {
          const v = raw[key];
          if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
            return rpcFail(`${key} 必须是 0–1 的有限数(拒绝字符串/NaN/Infinity)`);
          }
        }
      }
      const { file } = novelcraft.ui.stage.queueAtlasAnnotations(
        binding.root,
        payload.page_ref,
        payload.base_content_hash,
        payload.ops,
      );
      return rpcOk({
        ok: true,
        queued: payload.ops.length,
        file,
        message: `已入队 ${payload.ops.length} 个标签修改; 助手将按队列应用(坐标级, 不经自然语言)。`,
      });
    } catch (err) {
      return rpcFail(err instanceof Error ? err.message : String(err));
    }
  },
  };
}

export { ENDPOINTS };
