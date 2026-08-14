// @novelcraft/dsh · NovelCraftService(挂载阶段的唯一服务插件)。
// 组装全部 seam 适配器, 以 ctx.novelcraft 服务暴露给 agent 组合/其他插件;
// 并把核心包 facade 命名空间挂在此处(供 client module、skills、子代理组合消费)。
// 依据: 设计文档 §22.3(插件族, 经 DSH seam 互连)、seam 契约(packages/novelcraft/README.md)。
import { Context, Service } from '@deepseek-ai/cordis';
import * as assistant from '@novelcraft/assistant';
import * as context from '@novelcraft/context';
import * as imports from '@novelcraft/imports';
import * as llmStep from '@novelcraft/llm-step';
import * as memory from '@novelcraft/memory';
import * as outline from '@novelcraft/outline';
import * as rag from '@novelcraft/rag';
import * as store from '@novelcraft/store';
import * as world from '@novelcraft/world';
import * as writing from '@novelcraft/writing';
import { ApprovalGate } from './approval/gate.js';
import { Config, type Config as ConfigType } from './config.js';
import { deepImport, type DeepImportOptions } from './deep-import.js';
import { RadarScheduler } from './jobs/radar.js';
import { DshProvider } from './llm/provider.js';
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
  world: typeof world;
  outline: typeof outline;
  memory: typeof memory;
  rag: typeof rag;
  context: typeof context;
  assistant: typeof assistant;
}

export const FACADES: NovelcraftFacades = {
  store,
  llmStep,
  writing,
  imports,
  world,
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
    this.vaults = new SessionVaultBinder(config, this.cache);
    this.radars = new RadarScheduler(ctx);
    this.toolDisposers = registerNovelcraftTools(ctx, this);
    ctx.effect(() => () => {
      for (const dispose of this.toolDisposers) dispose();
    });
  }

  /** 便捷: 内容手一步调用(默认模型 = Config.llm; 调用方 overrides 优先)。 */
  runStep(req: llmStep.StepRequest): Promise<llmStep.StepResult> {
    return llmStep.runStep(this.llmProvider, req);
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
}
