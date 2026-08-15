// @novelcraft/dsh · NovelCraftService(挂载阶段的唯一服务插件)。
// 组装全部 seam 适配器, 以 ctx.novelcraft 服务暴露给 agent 组合/其他插件;
// 并把核心包 facade 命名空间挂在此处(供 client module、skills、子代理组合消费)。
// 依据: 设计文档 §22.3(插件族, 经 DSH seam 互连)、seam 契约(packages/novelcraft/README.md)。
import { existsSync as existsSyncLocal, readdirSync as readdirSyncLocal, readFileSync, rmSync as rmFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import * as assistant from '@novelcraft/assistant';
import * as context from '@novelcraft/context';
import * as imports from '@novelcraft/imports';
import * as llmStep from '@novelcraft/llm-step';
import * as memory from '@novelcraft/memory';
import * as outline from '@novelcraft/outline';
import * as rag from '@novelcraft/rag';
import * as store from '@novelcraft/store';
import { ensureVaultGitignore, paths as pathsFor } from '@novelcraft/vault';
import * as world from '@novelcraft/world';
import * as writing from '@novelcraft/writing';
import { ApprovalGate, GateRequiredError } from './approval/gate.js';
import { Config, type Config as ConfigType } from './config.js';
import { deepImport, type DeepImportOptions } from './deep-import.js';
import { RadarScheduler } from './jobs/radar.js';
import { DshProvider } from './llm/provider.js';
import { ContentPresetRegistry, mergeStepOverrides, withResolvedDefaults } from './llm/preset.js';
import { NovelcraftCache } from './storage/domain.js';
import { registerNovelcraftTools } from './tools.js';
import { SessionVaultBinder } from './vault/binding.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    novelcraft: NovelCraftService;
  }
}

/** 核心包 facade 命名空间(与 13 包一一对应; 无 DSH 依赖, 可被组合代码直接消费)。 */
export interface NovelcraftFacades {
  store: typeof store;
  llmStep: typeof llmStep;
  writing: typeof writing;
  imports: typeof imports;
  world: WorldFacade;
  outline: typeof outline;
  memory: typeof memory;
  rag: typeof rag;
  context: typeof context;
  assistant: typeof assistant;
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
 * world facade 包装类型(N31, M7 Phase F): 读取面原样透传;
 * createObject/updateObject 两写函数收口为拒绝存根(采用类写入必过审批门, 铁律3)。
 */
export type WorldFacade = Omit<typeof world, 'createObject' | 'updateObject'> & {
  createObject: (root: string, input: WorldCreateInput) => never;
  updateObject: (root: string, slug: string, patch: WorldUpdatePatch) => never;
};

/** 写面拒绝存根工厂: 未经审批门调用采用类写操作 → 抛错(fail-closed, N31)。 */
function worldWriteStub(op: string): never {
  throw new GateRequiredError(
    `采用类写操作请经 NovelCraftService.worldCreateGuarded/worldUpdateGuarded（审批门, N31）: ${op}`,
  );
}

/** world 包装命名空间: 读面透传, 两写函数为拒绝存根(N31 + 铁律3)。 */
export const WORLD_FACADE: WorldFacade = {
  ...world,
  createObject: (root, input) => worldWriteStub(`world.createObject(${root}, ${input.name})`),
  updateObject: (root, slug) => worldWriteStub(`world.updateObject(${root}, ${slug})`),
};

export const FACADES: NovelcraftFacades = {
  store,
  llmStep,
  writing,
  imports,
  world: WORLD_FACADE,
  outline,
  memory,
  rag,
  context,
  assistant,
};

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
  /** 核心包 facade(agent 组合/其他插件经此消费, 不互相绕过 seam) */
  readonly facades: NovelcraftFacades = FACADES;
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
    this.toolDisposers = registerNovelcraftTools(ctx, this);
    ctx.effect(() => () => {
      for (const dispose of this.toolDisposers) dispose();
    });
  }

  /** 便捷: 内容手一步调用(默认 = Config.llm ← 该书预设(N20)/llm.yml 直键; 调用方 overrides 优先)。 */
  async runStep(req: llmStep.StepRequest, root?: string): Promise<llmStep.StepResult> {
    const defaults = await this.presets.resolveDefaults(root);
    return llmStep.runStep(this.llmProvider, {
      ...req,
      overrides: mergeStepOverrides(defaults, req.overrides),
    });
  }

  /** 内容手 Provider(注入该书预设默认面; 供 deepImport/propose/generate 等编排用)。 */
  async contentProviderFor(root?: string): Promise<llmStep.Provider> {
    return withResolvedDefaults(this.llmProvider, await this.presets.resolveDefaults(root));
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
    return this.approval.guard(agent, {
      action: `采用${kind}`,
      summary: note ?? `vault ${root} 中的 ${ref}`,
      items: [ref],
    }, async () => store.adopt(root, kind, ref, opts));
  }

  /** 便捷: 审批门控的 world 对象创建(采用类写入必过 approval, N31 + 铁律3 fail-closed)。 */
  worldCreateGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    input: WorldCreateInput,
    note?: string,
  ): Promise<string> {
    return this.approval.guard(agent, {
      action: '创建世界对象',
      summary: note ?? `vault ${root} 中的「${input.name}」`,
      items: [input.name],
    }, async () => world.createObject(root, input));
  }

  /** 便捷: 审批门控的 world 对象修改(采用类写入必过 approval, N31 + 铁律3 fail-closed)。 */
  worldUpdateGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    slug: string,
    patch: WorldUpdatePatch,
    note?: string,
  ): Promise<void> {
    return this.approval.guard(agent, {
      action: '修改世界对象',
      summary: note ?? `vault ${root} 中的 ${slug}`,
      items: [slug],
    }, async () => world.updateObject(root, slug, patch));
  }

  // ------------------------------------------------------------------
  // map-atlas(Phase 5; 计划 §4 Phase 5; catalog §4.11)
  // ------------------------------------------------------------------

  /** 便捷: 地图册规划(contentProvider + world.planMapAtlas; 工具级 timeout 3600s)。 */
  async planMapAtlas(root: string, opts: world.PlanMapAtlasOptions): Promise<world.PlanMapAtlasResult> {
    return world.planMapAtlas(root, await this.contentProviderFor(root), opts);
  }

  /** 便捷: 地图册只读视图(tree + 指定/最近 run; 只读直通不过审批)。 */
  viewMapAtlas(root: string, runId?: string): { tree: world.AtlasTree; run: world.AtlasRun | null } {
    return {
      tree: world.readAtlasTree(root),
      run: runId ? world.readAtlasRun(root, runId) : world.latestAtlasRun(root),
    };
  }

  /** 便捷: 本机图片导入候选(候选写入不过 approval, N29; adopt 另行审批)。 */
  importAtlasImage(
    root: string,
    filePath: string,
    target: { nodeRef: string },
    opts?: world.ImportAtlasImageOptions,
  ): { page: world.AtlasPage; run?: world.AtlasRun } {
    return world.importAtlasImage(root, filePath, target, opts);
  }

  /**
   * 便捷: 地图页/节点生命周期(审批门控, 铁律 3 fail-closed):
   * adopt / adopt_placeholder / restore 经 ApprovalGate; reject / archive 为候选/历史面操作, 直执行。
   */
  async reviewMapAtlasGuarded(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    target: { pageRef?: string; nodeRef?: string },
    action: 'adopt' | 'adopt_placeholder' | 'reject' | 'archive' | 'restore',
    opts: { confirmConflicts?: boolean; expectedContentHash?: string; note?: string } = {},
  ): Promise<{ ok: true; detail: string }> {
    const approve: world.AtlasApprove = async (a, summary, items) => {
      const decision = await this.approval.request(agent, { action: a, summary, items });
      // ApprovalDecision 无 cancelled: 一切非 allowed-once 均 fail-closed。
      return decision === 'allowed-once' ? 'allowed-once' : 'rejected';
    };
    switch (action) {
      case 'adopt': {
        if (!target.pageRef) throw new store.StoreError('VALIDATION_FAILED', 'adopt 需要 page_ref');
        const r = await world.adoptAtlasPage(root, target.pageRef, {
          confirmConflicts: opts.confirmConflicts,
          expectedContentHash: opts.expectedContentHash,
          note: opts.note,
        }, approve);
        return { ok: true, detail: `已采用地图页 ${r.page.id}(连带节点 ${r.adoptedNodeIds.join('/') || '无'})` };
      }
      case 'adopt_placeholder': {
        if (!target.nodeRef) throw new store.StoreError('VALIDATION_FAILED', 'adopt_placeholder 需要 node_ref');
        const r = await world.adoptAtlasPlaceholder(root, target.nodeRef, approve);
        return { ok: true, detail: `已采用空页占位节点 ${r.adoptedNodeIds.join('/')}` };
      }
      case 'reject': {
        if (!target.pageRef) throw new store.StoreError('VALIDATION_FAILED', 'reject 需要 page_ref');
        const page = world.rejectAtlasPage(root, target.pageRef, { note: opts.note, expectedContentHash: opts.expectedContentHash });
        return { ok: true, detail: `已驳回地图页 ${page.id}(终态 rejected)` };
      }
      case 'archive': {
        if (!target.pageRef) throw new store.StoreError('VALIDATION_FAILED', 'archive 需要 page_ref');
        const page = world.archiveAtlasPage(root, target.pageRef, { expectedContentHash: opts.expectedContentHash });
        return { ok: true, detail: `已归档地图页 ${page.id}(deprecated, 可 restore)` };
      }
      case 'restore': {
        if (!target.pageRef) throw new store.StoreError('VALIDATION_FAILED', 'restore 需要 page_ref');
        const r = await world.restoreAtlasPage(root, target.pageRef, approve, { expectedContentHash: opts.expectedContentHash });
        return { ok: true, detail: `已恢复地图页 ${r.page.id}(祖先链补齐 ${r.adoptedNodeIds.join('/') || '无'})` };
      }
    }
  }

  /** 便捷: 地图页标注 ops(作者内容编辑, 不过 ApprovalGate; 校验+hash 重算在 world 层)。 */
  applyAtlasAnnotations(
    root: string,
    pageRef: string,
    ops: world.AtlasAnnotationOp[],
    opts?: { expectedContentHash?: string },
  ): { applied: number; content_hash: string } {
    // 批量 = 全量校验先行 + 单 commit + CAS(计划 Phase 5 工具 5 / 规则 11; 中途失败零残留, 重试不重复)。
    return world.applyAtlasAnnotationOps(root, pageRef, ops, opts);
  }

  /** 便捷: 改 prompt_only 候选页 prompt(候选面, 不过审批)。 */
  updateAtlasPrompt(root: string, pageRef: string, prompt: string, expectedContentHash?: string): world.AtlasPage {
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
   * 便捷: 消费标注队列(主路径; 计划 Phase 5 工具 5):
   * 读 .assistant/atlas/annotation-queue/*.json({page_ref, ops[]}), 逐文件应用, 成功后删除队列文件;
   * 单文件失败不阻塞其余(错误汇总返回)。标注 = 作者内容编辑, 不过审批。
   */
  applyAtlasAnnotationQueue(root: string): { files: number; applied: number; failed: number; errors: string[] } {
    const dir = pathsFor(root).assistant.atlas.annotationQueue;
    if (!existsSyncLocal(dir)) return { files: 0, applied: 0, failed: 0, errors: [] };
    const files = readdirSyncLocal(dir).filter((f) => f.endsWith('.json')).sort();
    let applied = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const file of files) {
      const abs = path.join(dir, file);
      try {
        const payload = JSON.parse(readFileSync(abs, 'utf8')) as {
          page_ref?: string;
          ops?: world.AtlasAnnotationOp[];
          base_content_hash?: string;
        };
        if (!payload.page_ref || !Array.isArray(payload.ops)) {
          throw new Error('队列文件需 {page_ref, ops[], base_content_hash?}');
        }
        const r = this.applyAtlasAnnotations(root, payload.page_ref, payload.ops, {
          expectedContentHash: payload.base_content_hash, // CAS: 防 stale 覆盖(Phase 6 队列载荷)
        });
        applied += r.applied;
        rmFileSync(abs); // 成功后清队列(计划: 应用后清队列)。
      } catch (err) {
        failed += 1;
        errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { files: files.length, applied, failed, errors };
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

  /** 便捷: 深度导入六阶段(adopt 经审批门, trace 落 .assistant/import-trace.jsonl)。 */
  deepImport(
    agent: import('@deepseek-ai/dsh-agent').Agent | undefined,
    root: string,
    opts: DeepImportOptions,
  ): Promise<imports.DeepImportResult> {
    return deepImport(this, agent, root, opts);
  }

  /** 便捷: 计划台续写提案(内容手经该书预设面, 落 .assistant/proposals/)。 */
  async proposeNextChapter(root: string, chapterIndex: number): Promise<writing.ProposeResult> {
    return writing.proposeNextChapter(await this.contentProviderFor(root), root, chapterIndex);
  }

  /** 便捷: 续写提案第二阶段(选定方向 → writing_generate → chapters/pending 候选)。 */
  async generateNextChapter(
    root: string,
    chapterIndex: number,
    opts: writing.GenerateNextChapterOptions,
  ): Promise<writing.GenerateResult> {
    return writing.generateNextChapter(await this.contentProviderFor(root), root, chapterIndex, opts);
  }

  /** 便捷: 结构健康信号扫描(确定性, 幂等落盘收件箱)。 */
  scanHealth(root: string): assistant.HealthScanResult {
    return assistant.scanHealthSignals(root);
  }

  /**
   * 便捷: 文本入库(Track 1b, D9a 纯文本)。宿主侧读文件(插件进程内 fs,
   * 不经 agent 沙箱); 超 50MB 提前拒绝(store.MAX_IMPORT_FILE_SIZE, imports.md §41);
   * 成功后重建派生索引。chapters/*.md 为 draft 停靠(R3 语义), 非 adopt。
   */
  ingestTextFile(
    root: string,
    opts: { filePath: string; startChapter?: number; force?: boolean },
  ): writing.ImportReport {
    const size = statSync(opts.filePath).size; // 不存在则抛 ENOENT(工具层转作者语言)
    if (size > store.MAX_IMPORT_FILE_SIZE) {
      return {
        ok: false,
        reason: `文件超过 50MB 上限(imports.md §41), 请拆分后导入`,
        warnings: [],
      };
    }
    const text = readFileSync(opts.filePath, 'utf8');
    const report = writing.importTextChapters(root, {
      fileName: opts.filePath,
      text,
      source: `file:${path.basename(opts.filePath)}`,
      ...(opts.startChapter !== undefined ? { startChapter: opts.startChapter } : {}),
      ...(opts.force ? { force: true } : {}),
    });
    if (report.ok) this.refreshIndex(root);
    return report;
  }

  /** 便捷: 雷达巡检(默认五面; §11 事件/手动触发, 非定时)。 */
  radarSweep(root: string, radars?: assistant.RadarKind[]): assistant.SweepResult {
    return assistant.runRadarSweep(root, radars ? { radars } : {});
  }

  /** 便捷: RAG 索引增量同步(兼容旧 vault: 先补 .gitignore 再重建派生索引; R5/R12 可随时重建)。 */
  ragSync(root: string): rag.RagSyncStats {
    ensureVaultGitignore(root, ['.assistant/rag-index.json']);
    return rag.syncRagIndex(root);
  }

  /** 便捷: RAG 语义检索(L2 向量召回按 llm.yml embedding 键启用; rerank 默认开, 走该书预设面 N20, 失败自动降级)。 */
  async ragSearch(
    root: string,
    query: string,
    opts?: { topK?: number; rerank?: boolean },
  ): Promise<rag.RagSearchResult> {
    const provider = opts?.rerank !== false ? await this.contentProviderFor(root) : undefined;
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
      const m = await import('@novelcraft/rag-bge');
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
