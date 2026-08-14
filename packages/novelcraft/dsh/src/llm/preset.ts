// @novelcraft/dsh · 内容手预设卡注册表 + 注入链(N20, D13)。
// DSH 无模型预设层(agent-presets 不拥有模型路由, 上游勘察结论), 本模块是插件自建薄层:
//   - 预设存 novelcraft domain KV(presets 表, 全局跨书); 种子预设兜底(DEFAULT_CONTENT_PRESETS);
//   - .assistant/llm.yml 的 preset 键(每书)引用预设名(N5: 只存预设名与参数, Key 永不进文件);
//   - withResolvedDefaults 把预设注入 Provider 默认(llm-step 加法: ProviderRequest.provider);
//   - 执行链注入点: service.runStep / deepImport / proposeNextChapter / generateNextChapter
//     (关死 llm.yml 此前不进执行路径的缺口 E8)。
// 与 DSH 的统一面 = provider/model 路由同源(ctx.llm 已注册 provider); 重内容流程由编排脑
// 以子代理发起, agentOptions {provider, model} 取当前预设(DSH 原生 seam)。
import type { Context } from '@deepseek-ai/cordis';
import {
  DEFAULT_CONTENT_PRESETS,
  findPreset,
  resolvePolicy,
  validateContentPreset,
} from '@novelcraft/llm-step';
import type { ContentPreset, Provider, ProviderRequest, ProviderResponse } from '@novelcraft/llm-step';
import type { NovelcraftCache } from '../storage/domain.js';

/** 注入到内容步的默认面(从预设 + llm.yml 直键解析; 请求级 overrides 优先)。 */
export interface ResolvedContentDefaults {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** 预设注册表: domain KV 存储层 ∪ 种子层(同名存储覆盖种子)。 */
export class ContentPresetRegistry {
  private readonly cache: NovelcraftCache;

  constructor(cache: NovelcraftCache) {
    this.cache = cache;
  }

  /** 全量预设(种子 ∪ 存储; 存储同名覆盖种子, 顺序: 种子在前)。 */
  async list(): Promise<ContentPreset[]> {
    let stored: ContentPreset[] = [];
    try {
      stored = await this.cache.listPresets();
    } catch {
      stored = []; // KV 不可用 → 只剩种子( fail-soft )
    }
    const byName = new Map<string, ContentPreset>();
    for (const p of DEFAULT_CONTENT_PRESETS) byName.set(p.name, p);
    for (const p of stored) byName.set(p.name, p);
    return [...byName.values()];
  }

  /** 新增/覆盖一张卡; 返回校验问题列表(空 = 成功)。 */
  async upsert(preset: ContentPreset): Promise<string[]> {
    const issues = validateContentPreset(preset);
    if (issues.length > 0) return issues;
    await this.cache.putPreset({
      name: preset.name,
      ...(preset.label !== undefined ? { label: preset.label } : {}),
      ...(preset.provider !== undefined ? { provider: preset.provider } : {}),
      ...(preset.model !== undefined ? { model: preset.model } : {}),
      ...(preset.temperature !== undefined ? { temperature: preset.temperature } : {}),
      ...(preset.top_p !== undefined ? { top_p: preset.top_p } : {}),
      ...(preset.max_tokens !== undefined ? { max_tokens: preset.max_tokens } : {}),
      ...(preset.timeout_ms !== undefined ? { timeout_ms: preset.timeout_ms } : {}),
    });
    return [];
  }

  /** 删除存储层卡(种子不可删; 不存在 → false)。 */
  async remove(name: string): Promise<boolean> {
    return this.cache.deletePreset(name);
  }

  /** 解析某书的生效预设: llm.yml preset 名 → 注册表查找; 未设/未找到 → undefined(fail-soft)。 */
  async resolveForBook(root: string): Promise<ContentPreset | undefined> {
    const name = resolvePolicy(root).llm.preset;
    if (!name) return undefined;
    return findPreset(await this.list(), name);
  }

  /** 解析内容步默认面: 预设 ← llm.yml 直键(model/temperature/max_tokens/timeout_ms)覆盖。 */
  async resolveDefaults(root: string | undefined): Promise<ResolvedContentDefaults> {
    if (!root) return {};
    const preset = await this.resolveForBook(root);
    const llm = resolvePolicy(root).llm;
    return {
      ...(preset?.provider ? { provider: preset.provider } : {}),
      ...(preset?.model ? { model: preset.model } : {}),
      ...(preset?.temperature !== undefined ? { temperature: preset.temperature } : {}),
      ...(preset?.max_tokens !== undefined ? { maxTokens: preset.max_tokens } : {}),
      ...(preset?.timeout_ms !== undefined ? { timeoutMs: preset.timeout_ms } : {}),
      // llm.yml 直键覆盖预设同名参数(N5 键划分: llm.yml 是项目级 LLM 设置)。
      ...(llm.model ? { model: llm.model } : {}),
      ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
      ...(llm.max_tokens !== undefined ? { maxTokens: llm.max_tokens } : {}),
      ...(llm.timeout_ms !== undefined ? { timeoutMs: llm.timeout_ms } : {}),
    };
  }
}

/**
 * Provider 包装: 注入解析默认面(请求级字段优先)。timeoutMs 不进 ProviderRequest
 * (超时在 runStep 层由 overrides.timeoutMs 承接, 见 service.runStep 的合并)。
 */
export function withResolvedDefaults(inner: Provider, defaults: ResolvedContentDefaults): Provider {
  return {
    complete(req: ProviderRequest): Promise<ProviderResponse> {
      return inner.complete({
        ...req,
        ...(req.provider ?? defaults.provider) !== undefined
          ? { provider: req.provider ?? defaults.provider }
          : {},
        ...(req.model ?? defaults.model) !== undefined ? { model: req.model ?? defaults.model } : {},
        ...(req.temperature ?? defaults.temperature) !== undefined
          ? { temperature: req.temperature ?? defaults.temperature }
          : {},
        ...(req.maxTokens ?? defaults.maxTokens) !== undefined
          ? { maxTokens: req.maxTokens ?? defaults.maxTokens }
          : {},
      });
    },
  };
}

/** StepRequest.overrides 合并(请求级优先); 供 service.runStep 用。 */
export function mergeStepOverrides(
  defaults: ResolvedContentDefaults,
  overrides: import('@novelcraft/llm-step').StepRequest['overrides'],
): import('@novelcraft/llm-step').StepRequest['overrides'] {
  const out: NonNullable<import('@novelcraft/llm-step').StepRequest['overrides']> = {};
  if (overrides?.provider ?? defaults.provider) out.provider = overrides?.provider ?? defaults.provider;
  if (overrides?.model ?? defaults.model) out.model = overrides?.model ?? defaults.model;
  if (overrides?.temperature ?? defaults.temperature) out.temperature = overrides?.temperature ?? defaults.temperature;
  if (overrides?.maxTokens ?? defaults.maxTokens) out.maxTokens = overrides?.maxTokens ?? defaults.maxTokens;
  if (overrides?.timeoutMs ?? defaults.timeoutMs) out.timeoutMs = overrides?.timeoutMs ?? defaults.timeoutMs;
  return out;
}

/** 占位: ctx 参数预留给未来按宿主能力(可用 provider 列表)过滤。 */
export function createPresetRegistry(_ctx: Context, cache: NovelcraftCache): ContentPresetRegistry {
  return new ContentPresetRegistry(cache);
}
