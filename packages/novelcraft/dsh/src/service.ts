// @novelcraft/dsh · NovelCraftService(挂载阶段的唯一服务插件)。
// 组装全部 seam 适配器, 以 ctx.novelcraft 服务暴露给 agent 组合/其他插件;
// 并把核心包 facade 命名空间挂在此处(供 client module、skills、子代理组合消费)。
// 依据: 设计文档 §22.3(插件族, 经 DSH seam 互连)、seam 契约(packages/novelcraft/README.md)。
import { createHash } from 'node:crypto';
import { Context, Service } from '@deepseek-ai/cordis';
import * as assistant from '@novelcraft/assistant';
import * as imports from '@novelcraft/imports';
import * as llmStep from '@novelcraft/llm-step';
import * as rag from '@novelcraft/rag';
import * as store from '@novelcraft/store';
import { ensureVaultGitignore } from '@novelcraft/vault';
import * as world from '@novelcraft/world';
import * as writing from '@novelcraft/writing';
import { ApprovalGate } from './approval/gate.js';
import { createNovelCraftCapabilities, type NovelCraftCapabilities } from './capabilities.js';
import { createNovelcraftClientFace, type NovelcraftUiFace } from './client-face.js';
import { Config, type Config as ConfigType } from './config.js';
import { deepImport, type DeepImportOptions } from './deep-import.js';
import * as workflowFace from './workflow-face.js';
import { DshRadarJobHost, RadarScheduler } from './jobs/radar.js';
import { ActiveVaultWatchScheduler, TransactionWatchStatePersistence } from './jobs/watch-state.js';
import { NovelcraftNodeRuntime } from './lifecycle/node-runtime.js';
import { DshProvider } from './llm/provider.js';
import { ContentPresetRegistry, mergeStepOverrides, withAbortSignal, withResolvedDefaults } from './llm/preset.js';
import { resolveExecutionProfile, requireTrustedExecutionProfile, type ExecutionProfile } from './llm/execution-profile.js';
import type { ResolveExecutionProfileOptions } from './llm/execution-profile.js';
import { planMapAtlasRun, reviewMapAtlasDecision } from './map-atlas-face.js';
import { optionalBgeLoader } from './optional-bge.js';
import { NovelcraftCache } from './storage/domain.js';
import { registerNovelcraftTools } from './tools.js';
import { pushSignalsChanged } from './push.js';
import { SessionVaultBinder } from './vault/binding.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    novelcraft: NovelCraftService;
  }
}

/** world.createObject 输入(与 @novelcraft/world 同形)。 */
export interface WorldCreateInput {
  name: string;
  entityType: string;
  aliases?: string[];
  tags?: string[];
  description?: string;
}

/** world.updateObject patch(与 @novelcraft/world 同形)。 */
export interface WorldUpdatePatch {
  name?: string;
  description?: string;
  tags?: string[];
}

/**
 * NovelCraft 挂载服务: 构造即组装 adapters; 工具注册容错(tools 服务缺失时
 * 跳过, 其余 seam 不受影响 —— 便于纯进程内测试与最小 profile)。
 */
export class NovelCraftService extends Service {
  static Config = Config;

  readonly config: ConfigType;
  /** llm-step Provider 的 DSH 实现(内容手直连 ctx.llm, §12/§22.5) */
  readonly llmProvider: DshProvider;
  /** ctx.approval 包装(fail-closed) */
  readonly approval: ApprovalGate;
  /** novelcraft domain 缓存(派生索引 + 会话绑定) */
  readonly cache: NovelcraftCache;
  /** 会话↔vault 绑定(D17) */
  readonly vaults: SessionVaultBinder;
  /** 内容手预设卡注册表(N20: domain KV 存储层 ∪ 种子层) */
  readonly presets: ContentPresetRegistry;
  /** 雷达巡检调度(ctx.jobs) */
  readonly radars: RadarScheduler;
  /** N34 Node-hosted one-timer-per-vault scheduler and real session lifecycle composition. */
  readonly watchScheduler: ActiveVaultWatchScheduler;
  readonly nodeRuntime: NovelcraftNodeRuntime;
  /** N35 防误用能力面；新插件只能按 read/propose/adoptGuarded 语义消费。 */
  readonly capabilities: NovelCraftCapabilities;
  /** 客户端 UI 面(loopback RPC 数据源: 只读聚合 + 收据暂存 + 决定记录 + 配置; 不写正史)。 */
  readonly ui: NovelcraftUiFace;
  private readonly toolDisposers: Array<() => void>;

  constructor(ctx: Context, config: ConfigType) {
    super(ctx, 'novelcraft');
    this.config = config;
    this.llmProvider = new DshProvider({
      ctx,
      provider: config.llm.provider,
      model: config.llm.model,
      sourcePlugin: '@novelcraft/dsh',
    });
    this.approval = new ApprovalGate(ctx);
    this.cache = new NovelcraftCache(ctx);
    this.presets = new ContentPresetRegistry(this.cache);
    this.vaults = new SessionVaultBinder(config, this.cache);
    this.radars = new RadarScheduler(ctx);
    const watchFingerprint = createHash('sha256').update(JSON.stringify({
      version: 1,
      enabled: config.watch.enabled,
      intervalMinutes: config.watch.intervalMinutes,
      radars: ['ingest', 'dedup', 'suggest', 'plot', 'risk', 'writing'],
    })).digest('hex');
    const radarHost = new DshRadarJobHost(this.radars, async (binding, radar) =>
      assistant.runRadarJobAtomic(binding.root, radar));
    const reportRuntimeError = (scope: string, error: unknown) => {
      console.error(`[novelcraft] ${scope}:`, error);
    };
    this.watchScheduler = new ActiveVaultWatchScheduler(
      new TransactionWatchStatePersistence(),
      radarHost,
      {
        enabled: config.watch.enabled,
        intervalMs: config.watch.intervalMinutes * 60_000,
        configFingerprint: watchFingerprint,
        onError: (root, error) => reportRuntimeError(`watch:${root}`, error),
      },
    );
    this.nodeRuntime = new NovelcraftNodeRuntime(
      ctx,
      this.vaults,
      this.watchScheduler,
      (operation, error) => reportRuntimeError(`session:${operation}`, error),
    );
    this.toolDisposers = [];
    // Establish rollback ownership before start/scan/tool registration can throw. Cordis awaits this
    // async disposer during normal unload and constructor rollback.
    ctx.effect(() => async () => {
      await this.nodeRuntime.stop();
      for (const dispose of this.toolDisposers) dispose();
      await this.cache.close();
    });
    this.nodeRuntime.start();
    this.capabilities = createNovelCraftCapabilities(this);
    this.ui = createNovelcraftClientFace(ctx, this);
    this.toolDisposers.push(...registerNovelcraftTools(ctx, this, config.tools));
  }

  /** 解析一次不可变 ExecutionProfile(N34 / ADR-0023 §6): 组合 Config.llm +
   *  ContentPresetRegistry(该书 preset 卡)+ resolvePolicy(llm.yml 直键), 冻结后返回;
   *  非法 preset/timeout/budget 在此抛 ExecutionProfileError(fail-closed, provider 前)。
   *  编排入口(deepImport/planMapAtlas/propose/generate/rag)启动时调用一次, 把返回的
   *  冻结 profile 透传给内部 runStep/contentProviderFor(带 profile 的调用不再解析)。
   *  options.specRefs: contractVersions 的固定 spec 引用集(deep import 用
   *  DEEP_IMPORT_SPEC_REFS, 确定性; 缺省 = 内置注册表)。 */
  resolveProfile(root?: string, options?: ResolveExecutionProfileOptions): Promise<ExecutionProfile> {
    return resolveExecutionProfile(this.presets, this.config.llm, root, options);
  }

  /** 便捷: 内容手一步调用(默认 = ExecutionProfile: Config.llm ← 该书预设(N20)/llm.yml
   *  直键; 调用方 overrides 优先)。profile 可显式传入已解析冻结的 ExecutionProfile
   *  (入口解析一次、内部透传, N34); 传入后不再按 root 解析。
   *  signal: 工具/编排取消信号, 与 llm-step 每步 timeout 合并贯通到 provider(加法)。
   *  审查项 1: profile 参数必须携带 opaque provenance brand(仅 resolveExecutionProfile
   *  解析产出; 普通对象即使字段合法也 INVALID_PROFILE fail-closed, 不得跳过 root 解析);
   *  内部透传(resolveProfile 产出)经 brand 零重解析验证。 */
  async runStep(
    req: llmStep.StepRequest,
    root?: string,
    signal?: AbortSignal,
    profile?: ExecutionProfile,
  ): Promise<llmStep.StepResult> {
    const resolved =
      profile !== undefined ? requireTrustedExecutionProfile(profile, root) : await this.resolveProfile(root);
    // 审查项 3: workflowBudget 真实继承 —— 单步 runStep 也按 ExecutionProfile.workflowBudget
    // 建一次累计 tracker(现有 RunStep budget API: runStep(provider, req, { budget })),
    // 超支在 provider 前 budget_exceeded(fail-closed); profile 未设 workflowBudget →
    // 不建 tracker, 行为不变。
    const budget =
      resolved.workflowBudget !== undefined
        ? llmStep.createWorkflowBudget(resolved.workflowBudget)
        : undefined;
    return llmStep.runStep(
      withAbortSignal(this.llmProvider, signal),
      {
        ...req,
        overrides: mergeStepOverrides(resolved, req.overrides),
      },
      budget !== undefined ? { budget } : undefined,
    );
  }

  /** 内容手 Provider(注入该书执行画像默认面; 供 deepImport/propose/generate 等编排用)。
   *   profile: 已解析冻结的 ExecutionProfile(入口解析一次、内部透传, N34);
   *   缺省时按 root 解析一次。
   *   signal: 工具/编排取消信号, 与 req.signal 合并贯通(相加 API)。
   *   审查项 1: profile 参数 brand 校验(同 runStep, 普通对象 fail-closed)。 */
  async contentProviderFor(root?: string, signal?: AbortSignal, profile?: ExecutionProfile): Promise<llmStep.Provider> {
    const resolved =
      profile !== undefined ? requireTrustedExecutionProfile(profile, root) : await this.resolveProfile(root);
    return withAbortSignal(
      withResolvedDefaults(this.llmProvider, resolved),
      signal,
    );
  }

  /** 便捷: 审批门控的 adopt(采用类写操作必过 approval, §9)。 */
  adoptGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    kind: store.AdoptableKind,
    ref: string,
    opts: store.AdoptOptions = {},
    note?: string,
  ): Promise<store.AdoptResult> {
    const prepared = kind === 'chapter_candidate'
      ? writing.prepareReviewedChapterCandidateAdopt(root, ref, opts)
      : store.prepareAdopt(root, kind, ref, opts);
    return this.approval.guard(agent, {
      action: `采用${kind}`,
      summary: note ?? `vault ${root} 中的 ${ref}`,
      items: [ref],
    }, async () => kind === 'chapter_candidate'
      ? writing.executeReviewedChapterCandidateAdopt(prepared)
      : store.executePreparedAdopt(prepared));
  }

  /** 正文当前事实与 Git 版本读面(§6.15): 零写、按章隔离。 */
  chapterCurrent(root: string, chapterIndex: number): store.CurrentChapter {
    return store.readCurrentChapter(root, chapterIndex);
  }

  chapterHistory(root: string, chapterIndex: number, limit = 20): store.ChapterHistoryEntry[] {
    return store.listChapterHistory(root, chapterIndex, limit);
  }

  chapterDiff(root: string, chapterIndex: number, fromCommit: string, toCommit?: string): store.ChapterDiff {
    return store.diffChapterVersions(root, chapterIndex, fromCommit, toCommit);
  }

  chapterReview(root: string, chapterIndex: number, target: 'current' | 'candidate', ref?: string): writing.ReviewRecord | undefined {
    return target === 'candidate'
      ? writing.latestCandidateReview(root, chapterIndex, ref ?? String(chapterIndex).padStart(3, '0'))
      : writing.latestReview(root, chapterIndex);
  }

  async reviewChapter(
    root: string,
    chapterIndex: number,
    target: 'current' | 'candidate',
    ref: string | undefined,
    signal?: AbortSignal,
    profile?: ExecutionProfile,
  ): Promise<writing.ReviewResult> {
    const resolved = profile !== undefined
      ? requireTrustedExecutionProfile(profile, root)
      : await this.resolveProfile(root);
    const provider = await this.contentProviderFor(root, signal, resolved);
    return target === 'candidate'
      ? writing.reviewChapterCandidate(provider, root, chapterIndex, ref ?? String(chapterIndex).padStart(3, '0'))
      : writing.reviewCurrentChapter(provider, root, chapterIndex);
  }

  async reviseChapter(
    root: string,
    chapterIndex: number,
    findingIds: string[],
    signal?: AbortSignal,
    profile?: ExecutionProfile,
  ): Promise<writing.ReviseResult> {
    const resolved = profile !== undefined
      ? requireTrustedExecutionProfile(profile, root)
      : await this.resolveProfile(root);
    return writing.applyReviewedRevision(
      await this.contentProviderFor(root, signal, resolved),
      root,
      chapterIndex,
      findingIds,
    );
  }

  async rejectChapterFinding(root: string, chapterIndex: number, reviewId: string, findingId: string, reason: string): Promise<void> {
    if (reason.trim() === '') throw new store.StoreError('VALIDATION_FAILED', '打回 finding 必须说明理由');
    const current = store.readCurrentChapter(root, chapterIndex);
    const review = writing.latestReview(root, chapterIndex);
    if (
      review?.review_id !== reviewId || review.target_kind !== 'current' ||
      review.target_content_hash !== current.contentHash
    ) {
      throw new store.StoreError('CONFLICT', `审查 ${reviewId} 已过期或不是第 ${chapterIndex} 章 current review`);
    }
    await writing.rejectFindingByIdTransactional(root, chapterIndex, reviewId, findingId, reason);
  }

  /** Candidate rejection is a writing-domain terminal action; it never mutates the current chapter. */
  rejectChapterCandidate(
    root: string,
    chapterIndex: number,
    ref: string,
    expectedContentHash: string,
    reason: string,
  ): Promise<writing.ChapterCandidateRejectResult> {
    return writing.rejectChapterCandidate(root, chapterIndex, ref, expectedContentHash, reason);
  }

  /** 页内编辑收据 → 审批 → 冻结 writeSet；loopback RPC 从不写正文。 */
  saveChapterGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    sessionId: string,
    receiptId: string,
  ): Promise<writing.ChapterWriteResult> {
    return writing.consumeStagedChapterEdit(root, sessionId, receiptId, (prepared) =>
      this.approval.guard(agent, {
        action: '保存章节正文',
        summary: prepared.summary,
        items: [`chapter:${prepared.chapterIndex}`],
      }, () => writing.executePreparedChapterWrite(prepared)));
  }

  /** 旧 blob 恢复为新章节版本；审批前冻结当前 hash/HEAD/writeSet。 */
  restoreChapterGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    chapterIndex: number,
    commit: string,
    expectedContentHash: string,
  ): Promise<writing.ChapterWriteResult> {
    const prepared = writing.prepareChapterRestore(root, chapterIndex, commit, expectedContentHash);
    if (prepared.write === undefined) return writing.executePreparedChapterWrite(prepared);
    return this.approval.guard(agent, {
      action: '恢复章节版本',
      summary: prepared.summary,
      items: [`chapter:${chapterIndex}`, `commit:${commit}`],
    }, () => writing.executePreparedChapterWrite(prepared));
  }

  /** 便捷: 审批门控的 world 对象创建(采用类写入必过 approval, N31 + 铁律3 fail-closed)。 */
  worldCreateGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    input: WorldCreateInput,
    note?: string,
  ): Promise<string> {
    const prepared = world.prepareCreateObject(root, input);
    return this.approval.guard(agent, {
      action: '创建世界对象',
      summary: note ?? `vault ${root} 中的「${input.name}」`,
      items: [input.name],
    }, async () => world.executePreparedCreateObject(prepared));
  }

  /** 便捷: 审批门控的 world 对象修改(采用类写入必过 approval, N31 + 铁律3 fail-closed)。 */
  worldUpdateGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    slug: string,
    patch: WorldUpdatePatch,
    note?: string,
  ): Promise<void> {
    const prepared = world.prepareUpdateObject(root, slug, patch);
    return this.approval.guard(agent, {
      action: '修改世界对象',
      summary: note ?? `vault ${root} 中的 ${slug}`,
      items: [slug],
    }, async () => world.executePreparedUpdateObject(prepared));
  }

  // ------------------------------------------------------------------
  // map-atlas(Phase 5; 计划 §4 Phase 5; catalog §4.11)
  // ------------------------------------------------------------------

  /** 地图册生产编排入口(N33): immutable run + artifact/receipt/cursor + apply probe。 */
  async planMapAtlas(
    root: string,
    opts: world.AtlasWorkflowOptions,
    signal?: AbortSignal,
    profile?: ExecutionProfile,
    agent?: import('@deepseek-ai/dsh-agent').Agent,
  ): Promise<world.AtlasWorkflowResult> {
    return planMapAtlasRun(this, root, opts, signal, profile, agent);
  }

  /** 便捷: 地图册只读视图(tree + 指定/最近 run; 只读直通不过审批)。 */
  viewMapAtlas(root: string, runId?: string): { tree: world.AtlasTree; run: world.AtlasRun | null } {
    return {
      tree: world.readAtlasTree(root),
      run: runId ? world.readAtlasRun(root, runId) : world.latestAtlasRun(root),
    };
  }

  /** llm_step 工具回执正文上界(M10-A review / N39 ②, read 声明表): Config.llm
   *  .receiptMaxChars 显式缺省 65,536 —— 工具经 capabilities.read 读取, 不直读 config。 */
  receiptLimit(): number {
    return this.config.llm.receiptMaxChars ?? 65_536;
  }

  /** 只读枚举 durable workflow runs + checkpoint 概要(M10-B1/N40, read 声明表)。 */
  workflowInspect(root: string): ReturnType<typeof workflowFace.workflowInspect> {
    return workflowFace.workflowInspect(root);
  }

  /** 恢复 deep-import run: checkpoint scope 续跑(授权只请求剩余, N33 P2 既有语义)。 */
  async workflowResumeGuarded(
    agent: Parameters<NovelCraftService['deepImport']>[0],
    root: string,
    workflowId: string,
    signal?: AbortSignal,
  ) {
    return workflowFace.workflowResumeGuarded(this, agent, root, workflowId, signal);
  }

  /** 显式新 run(force): 不复用同 scope 旧 run, 全 scope 授权(M10-B2: completed 重放显式化)。 */
  async workflowStartNewGuarded(
    agent: Parameters<NovelCraftService['deepImport']>[0],
    root: string,
    opts: import('./deep-import.js').DeepImportOptions,
    signal?: AbortSignal,
  ) {
    return workflowFace.workflowStartNewGuarded(this, agent, root, opts, signal);
  }

  /** 放弃 run: 审批 → 清理 run 目录(+绑定 checkpoint) → 精确 git 提交; 不动 canonical。 */
  async workflowAbandonGuarded(
    agent: Parameters<NovelCraftService['deepImport']>[0],
    root: string,
    args: { kind: 'deep-import' | 'map-atlas'; workflowId: string },
    signal?: AbortSignal,
  ) {
    return workflowFace.workflowAbandonGuarded(this, agent, root, args, signal);
  }

  /** 便捷: 消费当前会话已授权的图片收据(候选写入不过 approval, N29)。 */
  importAtlasImage(
    root: string,
    opts: { receiptId: string; sessionId: string },
  ): { page: world.AtlasPage; run?: world.AtlasRun } {
    return world.importStagedAtlasImage(root, opts.sessionId, opts.receiptId);
  }

  /**
   * 便捷: 地图页/节点生命周期(审批门控, 铁律 3 fail-closed):
   * adopt / adopt_placeholder / restore / archive 均经 ApprovalGate(allowed-once 只放行
   * 一次, rejected/cancelled/unavailable 一律拒绝, fail-closed; N35: archive 是 canonical
   * 资产状态迁移, 工具无旁路); reject 为候选面操作(候选 → rejected 终态, 非 canonical), 直执行。
   */
  reviewMapAtlasGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    target: { pageRef?: string; nodeRef?: string },
    action: 'adopt' | 'adopt_placeholder' | 'reject' | 'archive' | 'restore',
    opts: { confirmConflicts?: boolean; expectedContentHash?: string; note?: string } = {},
  ): Promise<{ ok: true; detail: string }> {
    return reviewMapAtlasDecision(this.approval, agent, root, target, action, opts);
  }

  /** 便捷: 改 prompt_only 候选页 prompt(候选面, 不过审批)。 */
  async updateAtlasPrompt(root: string, pageRef: string, prompt: string, expectedContentHash?: string): Promise<world.AtlasPage> {
    return world.updateAtlasPrompt(root, pageRef, prompt, expectedContentHash);
  }

  /** 便捷: 上传新位置 → provisional 候选节点(附录 A.2; 候选面不过审批)。 */
  async createAtlasUploadNode(
    root: string,
    input: { title: string; level: string; parent_ref?: string },
  ): Promise<string> {
    const title = input.title.trim();
    if (title.length === 0) throw new store.StoreError('VALIDATION_FAILED', '节点标题必填且非空');
    if (!(world.ATLAS_LEVELS as readonly string[]).includes(input.level)) {
      throw new store.StoreError('VALIDATION_FAILED', `非法层级 ${input.level}(白名单 ${world.ATLAS_LEVELS.join('/')})`);
    }
    // F4: semantic_key = path:{父语义|root}:{sha256(title)前20}(ADR-0020 §6 确定性口径)。
    let parentSemantic = 'root';
    if (input.parent_ref) {
      const tree = world.readAtlasTree(root);
      const parent = [...tree.nodes, ...tree.pendingNodes].find((n) => n.id === input.parent_ref);
      if (!parent) throw new store.StoreError('NOT_FOUND', `父节点不存在: ${input.parent_ref}`);
      parentSemantic = parent.semantic_key || 'root';
    }
    const slug = `up-${world.semanticPart(title)}-${Math.random().toString(36).slice(2, 6)}`;
    world.writeAtlasNode(root, {
      id: slug,
      parent_ref: input.parent_ref ?? null,
      location_ref: null,
      semantic_key: `path:${parentSemantic}:${world.semanticPart(title)}`,
      level: input.level as world.AtlasLevel,
      title,
      status: 'provisional',
      sort_order: 0,
    });
    return slug;
  }

  /**
   * 便捷: 消费标注队列(N35 唯一受控结构化入口; 实现已下沉 @novelcraft/world
   * consumeAtlasAnnotationQueue: 封闭三键 schema + CAS 必填 + 事务零写 + 单文件容错)。
   * 标注 = 作者内容编辑, 不过审批; 工具不得直接传 ops 绕过本队列(CAS 必填)。
   */
  async applyAtlasAnnotationQueue(root: string): Promise<{ files: number; applied: number; failed: number; errors: string[] }> {
    return world.consumeAtlasAnnotationQueue(root);
  }

  /** 便捷: 重建派生索引并把结果写入 domain 缓存(文件仍是唯一真相)。 */
  refreshIndex(root: string): store.VaultIndex {
    const index = store.rebuildIndex(root);
    void this.cache.putIndex(root, index.version, index).catch(() => {
      // 缓存是派生数据; 失败不影响索引读取面(下次重建覆盖)。
    });
    return index;
  }

  /** 便捷: 收件箱视图(新鲜信号, 风险前置)。 */
  inbox(root: string, currentContentHash?: string): assistant.Signal[] {
    return assistant.inboxView(root, currentContentHash);
  }

  /** 收件箱四动词(§9): 记录决定 + 尽力而为的信号变化推送(ADR-0018 通道缺省时静默)。
   *  资产写入另走采用/微工作流工具; 本方法不写 canonical 资产。 */
  actOnSignal(
    root: string,
    signalId: string,
    action: assistant.InboxAction,
    opts?: { reason?: string; modifiedTitle?: string; modifiedProposedAction?: string },
  ): assistant.ActionDescriptor {
    const descriptor = assistant.act(root, {
      signalId,
      action,
      ...(opts?.reason ? { reason: opts.reason } : {}),
      ...(action === 'modify'
        ? {
            modified: {
              ...(opts?.modifiedTitle ? { title: opts.modifiedTitle } : {}),
              ...(opts?.modifiedProposedAction ? { proposed_action: opts.modifiedProposedAction } : {}),
            },
          }
        : {}),
    });
    try {
      pushSignalsChanged(this.ctx, { root });
    } catch {
      // 推送是尽力而为副作用(同 afterMutation 纪律); 决定已落盘不受影响。
    }
    return descriptor;
  }

  /** 便捷: 深度导入六阶段(范围授权 + adopt/2b 独立审批门, trace 落 .assistant/import-trace.jsonl)。
   *   编排入口: profile 缺省时按 root 解析一次 ExecutionProfile(N34, fail-closed:
   *   非法 preset/timeout/budget 在范围授权前抛, 零审批零 provider 零文件写);
   *   profile 已传入(入口解析一次、内部透传)则不再解析。
   *   signal: 工具取消信号贯通到内容手调用(加法)。 */
  deepImport(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    opts: DeepImportOptions,
    signal?: AbortSignal,
    profile?: ExecutionProfile,
  ): Promise<imports.DeepImportResult> {
    return deepImport(this, agent, root, opts, signal, profile);
  }

  /** 便捷: 计划台续写提案(内容手经该书执行画像面, 落 .assistant/proposals/)。
   *   编排入口: profile 缺省时按 root 解析一次 ExecutionProfile(N34)并透传。
   *   signal: 工具取消信号贯通(加法)。 */
  async proposeNextChapter(
    root: string,
    chapterIndex: number,
    signal?: AbortSignal,
    profile?: ExecutionProfile,
  ): Promise<writing.ProposeResult> {
    // 审查项 1: profile 参数 brand 校验(fail-closed, 见 runStep; 普通对象不得跳过 root 解析)。
    const resolved =
      profile !== undefined ? requireTrustedExecutionProfile(profile, root) : await this.resolveProfile(root);
    return writing.proposeNextChapter(await this.contentProviderFor(root, signal, resolved), root, chapterIndex);
  }

  /** 便捷: 续写提案第二阶段(选定方向 → writing_generate → chapters/pending 候选)。
   *   编排入口: profile 缺省时按 root 解析一次 ExecutionProfile(N34)并透传。
   *   signal: 工具取消信号贯通(加法)。 */
  async generateNextChapter(
    root: string,
    chapterIndex: number,
    opts: writing.GenerateNextChapterOptions,
    signal?: AbortSignal,
    profile?: ExecutionProfile,
  ): Promise<writing.GenerateResult> {
    // 审查项 1: profile 参数 brand 校验(fail-closed, 见 runStep; 普通对象不得跳过 root 解析)。
    const resolved =
      profile !== undefined ? requireTrustedExecutionProfile(profile, root) : await this.resolveProfile(root);
    return writing.generateNextChapter(await this.contentProviderFor(root, signal, resolved), root, chapterIndex, opts);
  }

  /** 便捷: 结构健康信号扫描(确定性, 幂等落盘收件箱)。 */
  scanHealth(root: string): Promise<assistant.HealthScanResult> {
    return assistant.scanHealthSignalsAtomic(root);
  }

  /** 便捷: 消费当前会话已授权的文本收据; 成功后重建派生索引。 */
  ingestTextFile(
    root: string,
    opts: { receiptId: string; sessionId: string; startChapter?: number; force?: boolean },
  ): writing.ImportReport {
    const report = writing.importStagedTextIntake(root, opts.sessionId, opts.receiptId, {
      ...(opts.startChapter !== undefined ? { startChapter: opts.startChapter } : {}),
      ...(opts.force ? { force: true } : {}),
    });
    if (report.ok) this.refreshIndex(root);
    return report;
  }

  /** 便捷: 雷达巡检(默认五面; §11 事件/手动触发, 非定时)。 */
  radarSweep(root: string, radars?: assistant.RadarKind[]): Promise<assistant.SweepResult> {
    return assistant.runRadarSweepAtomic(root, radars ? { radars } : {});
  }

  /** 便捷: RAG 索引增量同步(兼容旧 vault: 先补 .gitignore 再重建派生索引; R5/R12 可随时重建)。 */
  ragSync(root: string): rag.RagSyncStats {
    ensureVaultGitignore(root, ['.assistant/rag-index.json']);
    return rag.syncRagIndex(root);
  }

  /** 便捷: RAG 语义检索(L2 向量召回按 llm.yml embedding 键启用; rerank 默认开, 走该书
   *  执行画像面 N20, 失败自动降级)。编排入口: profile 缺省时按 root 解析一次
   *  ExecutionProfile(N34)并透传给 rerank 内容手。 */
  async ragSearch(
    root: string,
    query: string,
    opts?: { topK?: number; rerank?: boolean },
    profile?: ExecutionProfile,
  ): Promise<rag.RagSearchResult> {
    // 审查项 1: profile 参数 brand 校验(fail-closed, 见 runStep; 普通对象不得跳过 root 解析)。
    const resolved =
      profile !== undefined ? requireTrustedExecutionProfile(profile, root) : await this.resolveProfile(root);
    const provider = opts?.rerank !== false ? await this.contentProviderFor(root, undefined, resolved) : undefined;
    const embeddingBackend = await this.embeddingBackendFor(root);
    return rag.searchRag(root, query, {
      ...(opts?.topK !== undefined ? { topK: opts.topK } : {}),
      ...(provider ? { provider } : {}),
      ...(embeddingBackend ? { embeddingBackend } : {}),
    });
  }

  /**
   * 便捷: L2 嵌入后端(root 的 llm.yml 设 embedding: bge-local-v1 时启用)。
   * @novelcraft/rag-bge 为可选依赖: 动态 import 失败 → undefined(全链可降级), 不阻塞。
   */
  async embeddingBackendFor(root?: string): Promise<rag.EmbeddingBackend | undefined> {
    if (!root) return undefined;
    try {
      const policy = llmStep.resolvePolicy(root);
      if (policy.llm.embedding !== 'bge-local-v1') return undefined;
    } catch {
      return undefined; // llm.yml 读取失败视为未启用。
    }
    try {
      const m = await optionalBgeLoader.load();
      if (typeof m.createBgeEmbeddingBackend !== 'function') return undefined;
      return m.createBgeEmbeddingBackend();
    } catch (err) {
      this.ctx.logger?.warn?.(
        '[novelcraft] L2 嵌入后端不可用: ' + (err instanceof Error ? err.message : String(err)),
      );
      return undefined;
    }
  }

  /** 便捷: 批量嵌入待向量化片段(L2; 后端不可用 → 全 0 + 提示消息, 不抛错)。 */
  async ragEmbed(root: string): Promise<rag.RagEmbedStats & { message?: string }> {
    const backend = await this.embeddingBackendFor(root);
    if (!backend) {
      return {
        embedded: 0,
        failed: 0,
        skipped: 0,
        message:
          '嵌入未启用或后端不可用(在 .assistant/llm.yml 设 embedding: bge-local-v1 并确保 @novelcraft/rag-bge 已安装)',
      };
    }
    return rag.embedPendingChunks(root, backend);
  }
}
