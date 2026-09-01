// @novelcraft/dsh · 内容手预设卡注册表 + 注入链(N20, D13)。
// DSH 无模型预设层(agent-presets 不拥有模型路由, 上游勘察结论), 本模块是插件自建薄层:
//   - 预设存 novelcraft domain KV(presets 表, 全局跨书); 种子预设兜底(DEFAULT_CONTENT_PRESETS);
//   - .assistant/llm.yml 的 preset 键(每书)引用预设名(N5: 只存预设名与参数, Key 永不进文件);
//   - withResolvedDefaults 把预设注入 Provider 默认(llm-step 加法: ProviderRequest.provider);
//   - 执行链注入点: service.runStep / deepImport / proposeNextChapter / generateNextChapter
//     (关死 llm.yml 此前不进执行路径的缺口 E8);
//   - withAbortSignal: 工具/编排取消信号(exec.signal)与此书内容手调用合并,
//     任一 abort 即中止(工具取消贯通, 见 tools.ts 五工具)。
// 与 DSH 的统一面 = provider/model 路由同源(ctx.llm 已注册 provider); 重内容流程由编排脑
// 以子代理发起, agentOptions {provider, model} 取当前预设(DSH 原生 seam)。
// 独立审查 P2 修复:
//   - mergeStepOverrides 全部显式 undefined 判断(temperature=0/maxTokens 等合法零值
//     不被 truthiness 吞掉);
//   - withResolvedDefaults 在包装 Provider 上附着 executionDefaults(llm-step 加法),
//     内部「裸 runStep(provider, req)」也继承 timeout/maxTokens/temperature/model;
//   - resolveForBook(strict) 的 preset 名读取走 strict llm.yml 单次快照解析
//     (resolveExecutionLlmYml, 未知键/secret/非法形态 fail-closed, N34)。
import type { Context } from '@deepseek-ai/cordis';
import {
  DEFAULT_CONTENT_PRESETS,
  createWorkflowBudget,
  findPreset,
  resolveExecutionLlmYml,
  resolvePolicy,
  validateContentPreset,
} from '@novelcraft/llm-step';
import type {
  ContentPreset,
  Provider,
  ProviderRequest,
  ProviderResponse,
  StepExecutionDefaults,
} from '@novelcraft/llm-step';
import { ExecutionProfileError } from './execution-profile.js';
import type { NovelcraftCache } from '../storage/domain.js';

/** 注入到内容步的默认面(从预设 + llm.yml 直键解析; 请求级 overrides 优先)。
 *  审查项 4: top_p 与 temperature 同级进入注入面(传输契约不支持处由 DshProvider 明确拒绝)。 */
export interface ResolvedContentDefaults {
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  maxTokens?: number;
  timeoutMs?: number;
  workflowBudget?: number;
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
      ...(preset.reasoning_effort !== undefined ? { reasoning_effort: preset.reasoning_effort } : {}),
      ...(preset.temperature !== undefined ? { temperature: preset.temperature } : {}),
      ...(preset.top_p !== undefined ? { top_p: preset.top_p } : {}),
      ...(preset.max_tokens !== undefined ? { max_tokens: preset.max_tokens } : {}),
      ...(preset.timeout_ms !== undefined ? { timeout_ms: preset.timeout_ms } : {}),
      ...(preset.workflow_budget !== undefined ? { workflow_budget: preset.workflow_budget } : {}),
    });
    return [];
  }

  /** 删除存储层卡(种子不可删; 不存在 → false)。 */
  async remove(name: string): Promise<boolean> {
    return this.cache.deletePreset(name);
  }

  /** 按名解析预设卡(不读文件; 供单次快照组合面使用, 审查项 2):
   *  strict: 引用名缺失/卡本身非法 → 抛 ExecutionProfileError(INVALID_PRESET,
   *  fail-closed) —— 在 provider 前拒绝, 不静默回退。 */
  async resolvePresetByName(
    name: string,
    opts?: { strict?: boolean },
  ): Promise<ContentPreset | undefined> {
    const preset = findPreset(await this.list(), name);
    if (opts?.strict) {
      if (!preset) {
        throw new ExecutionProfileError(
          'INVALID_PRESET',
          `llm.yml 引用预设「${name}」在注册表中不存在(fail-closed, N34)`,
        );
      }
      const issues = validateContentPreset(preset);
      if (issues.length > 0) {
        throw new ExecutionProfileError(
          'INVALID_PRESET',
          `llm.yml 引用预设「${name}」非法: ${issues[0]}(fail-closed, N34)`,
        );
      }
    }
    return preset;
  }

  /** 解析某书的生效预设: llm.yml preset 名 → 注册表查找。
   *  legacy 语义(无 opts): 未设/未找到 → undefined(fail-soft, 既有调用面不变)。
   *  opts.strict(N34 ExecutionProfile 编排路径, 加法): preset 名读取走 strict llm.yml
   *  单次快照解析(未知键/secret/非法形态 → INVALID_LLM_YML fail-closed); 引用名存在
   *  但注册表缺失/卡本身非法 → 抛 ExecutionProfileError(INVALID_PRESET, fail-closed) ——
   *  在 provider 前拒绝, 不静默回退。
   *  注意: ExecutionProfile 组合路径(resolveExecutionProfile)不再走本函数读文件 ——
   *  组合面先 readExecutionLlmYmlSnapshot 单次读、再以同一快照解析的 preset 名调
   *  resolvePresetByName(审查项 2: 消除双读 TOCTOU)。 */
  async resolveForBook(root: string, opts?: { strict?: boolean }): Promise<ContentPreset | undefined> {
    let name: string | undefined;
    if (opts?.strict) {
      // 执行入口: strict 单次快照解析(N34; LlmYmlError → ExecutionProfileError)。
      try {
        name = resolveExecutionLlmYml(root).preset;
      } catch (err) {
        if (err instanceof Error && err.name === 'LlmYmlError') {
          throw new ExecutionProfileError('INVALID_LLM_YML', err.message);
        }
        throw err;
      }
    } else {
      name = resolvePolicy(root).llm.preset; // legacy 兼容(fail-soft, 非执行入口)
    }
    if (!name) return undefined;
    return this.resolvePresetByName(name, opts);
  }

  /** 解析内容步默认面: 预设 ← llm.yml 直键(model/temperature/top_p/max_tokens/timeout_ms)覆盖。 */
  async resolveDefaults(root: string | undefined): Promise<ResolvedContentDefaults> {
    if (!root) return {};
    const preset = await this.resolveForBook(root);
    const llm = resolvePolicy(root).llm;
    return {
      ...(preset?.provider ? { provider: preset.provider } : {}),
      ...(preset?.model ? { model: preset.model } : {}),
      ...(preset?.reasoning_effort !== undefined ? { reasoning_effort: preset.reasoning_effort } : {}),
      ...(preset?.temperature !== undefined ? { temperature: preset.temperature } : {}),
      ...(preset?.top_p !== undefined ? { top_p: preset.top_p } : {}),
      ...(preset?.max_tokens !== undefined ? { maxTokens: preset.max_tokens } : {}),
      ...(preset?.timeout_ms !== undefined ? { timeoutMs: preset.timeout_ms } : {}),
      // llm.yml 直键覆盖预设同名参数(N5 键划分: llm.yml 是项目级 LLM 设置)。
      ...(llm.model ? { model: llm.model } : {}),
      ...(llm.reasoning_effort !== undefined ? { reasoning_effort: llm.reasoning_effort } : {}),
      ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
      ...(llm.top_p !== undefined ? { top_p: llm.top_p } : {}),
      ...(llm.max_tokens !== undefined ? { maxTokens: llm.max_tokens } : {}),
      ...(llm.timeout_ms !== undefined ? { timeoutMs: llm.timeout_ms } : {}),
    };
  }
}

/**
 * Provider 包装: 注入解析默认面(请求级字段优先)。timeoutMs 不进 ProviderRequest
 * (超时在 runStep 层由 overrides.timeoutMs 承接, 见 service.runStep 的合并)。
 * 独立审查 P2 修复: 包装结果同时附着 executionDefaults(llm-step 加法)——内部
 * 「裸 runStep(provider, req)」(imports/writing/world/rag)不经 overrides 即继承
 * timeout/maxTokens/temperature/model; 请求级字段仍优先(complete 处合并, 双保险)。
 */
export function withResolvedDefaults(inner: Provider, defaults: ResolvedContentDefaults): Provider {
  const executionDefaults: StepExecutionDefaults = {
    ...(defaults.provider !== undefined ? { provider: defaults.provider } : {}),
    ...(defaults.model !== undefined ? { model: defaults.model } : {}),
    ...(defaults.reasoning_effort !== undefined ? { reasoning_effort: defaults.reasoning_effort } : {}),
    ...(defaults.temperature !== undefined ? { temperature: defaults.temperature } : {}),
    ...(defaults.top_p !== undefined ? { top_p: defaults.top_p } : {}),
    ...(defaults.maxTokens !== undefined ? { maxTokens: defaults.maxTokens } : {}),
    ...(defaults.timeoutMs !== undefined ? { timeoutMs: defaults.timeoutMs } : {}),
  };
  const wrapped: Provider = {
    executionDefaults,
    ...(defaults.workflowBudget !== undefined
      ? { workflowBudget: createWorkflowBudget(defaults.workflowBudget) }
      : {}),
    complete(req: ProviderRequest): Promise<ProviderResponse> {
      return inner.complete({
        ...req,
        ...(req.provider ?? defaults.provider) !== undefined
          ? { provider: req.provider ?? defaults.provider }
          : {},
        ...(req.model ?? defaults.model) !== undefined ? { model: req.model ?? defaults.model } : {},
        ...(req.reasoning_effort ?? defaults.reasoning_effort) !== undefined
          ? { reasoning_effort: req.reasoning_effort ?? defaults.reasoning_effort }
          : {},
        ...(req.temperature ?? defaults.temperature) !== undefined
          ? { temperature: req.temperature ?? defaults.temperature }
          : {},
        ...(req.top_p ?? defaults.top_p) !== undefined
          ? { top_p: req.top_p ?? defaults.top_p }
          : {},
        ...(req.maxTokens ?? defaults.maxTokens) !== undefined
          ? { maxTokens: req.maxTokens ?? defaults.maxTokens }
          : {},
      });
    },
  };
  return wrapped;
}

/**
 * Provider 包装: 取消信号贯通(工具/编排层 exec.signal → 内容手调用)。
 * complete 时把 outerSignal(工具取消)与 req.signal(llm-step 每步 timeout controller)
 * 合并到单个 AbortController —— 任一 abort 即中止下游调用; 调用前任一源已 abort 则
 * 合并 signal 同步立即 abort(不等流建立); complete 结束时 finally 移除全部 listener。
 * 两源皆缺省时原样透传(零开销, 不新建 controller)。
 * P2 修复: 转发 inner.executionDefaults —— 包装链(AbortSignal/Default 组合)不得剥掉
 * 执行画像 seam, 否则裸 runStep 丢失 timeout/maxTokens/temperature/model 继承。
 */
export function withAbortSignal(inner: Provider, outerSignal?: AbortSignal): Provider {
  const wrapped: Provider = {
    ...(inner.executionDefaults !== undefined
      ? { executionDefaults: inner.executionDefaults }
      : {}),
    ...(inner.workflowBudget !== undefined ? { workflowBudget: inner.workflowBudget } : {}),
    complete(req: ProviderRequest): Promise<ProviderResponse> {
      const reqSignal = req.signal;
      if (!outerSignal && !reqSignal) return inner.complete(req);
      const controller = new AbortController();
      const targets: Array<[AbortSignal, () => void]> = [];
      const listen = (signal: AbortSignal) => {
        const onAbort = () => controller.abort(signal.reason);
        targets.push([signal, onAbort]);
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', onAbort, { once: true });
      };
      if (outerSignal) listen(outerSignal);
      if (reqSignal) listen(reqSignal);
      const cleanup = () => {
        for (const [signal, onAbort] of targets) signal.removeEventListener('abort', onAbort);
      };
      try {
        return inner.complete({ ...req, signal: controller.signal }).finally(cleanup);
      } catch (err) {
        cleanup(); // 同步抛错也要清理(complete 实现异常时 finally 不会执行)。
        throw err;
      }
    },
  };
  return wrapped;
}

/** StepRequest.overrides 合并(请求级优先); 供 service.runStep 用。
 *  独立审查 P2 修复: 全部显式 undefined 判断 —— temperature=0/maxTokens 等
 *  合法零值请求 override 不被 truthiness 吞掉。 */
export function mergeStepOverrides(
  defaults: ResolvedContentDefaults,
  overrides: import('@novelcraft/llm-step').StepRequest['overrides'],
): import('@novelcraft/llm-step').StepRequest['overrides'] {
  const out: NonNullable<import('@novelcraft/llm-step').StepRequest['overrides']> = {};
  const provider = overrides?.provider ?? defaults.provider;
  if (provider !== undefined) out.provider = provider;
  const model = overrides?.model ?? defaults.model;
  if (model !== undefined) out.model = model;
  const reasoningEffort = overrides?.reasoning_effort ?? defaults.reasoning_effort;
  if (reasoningEffort !== undefined) out.reasoning_effort = reasoningEffort;
  const temperature = overrides?.temperature ?? defaults.temperature;
  if (temperature !== undefined) out.temperature = temperature;
  const top_p = overrides?.top_p ?? defaults.top_p;
  if (top_p !== undefined) out.top_p = top_p;
  const maxTokens = overrides?.maxTokens ?? defaults.maxTokens;
  if (maxTokens !== undefined) out.maxTokens = maxTokens;
  const timeoutMs = overrides?.timeoutMs ?? defaults.timeoutMs;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  return out;
}

/** 占位: ctx 参数预留给未来按宿主能力(可用 provider 列表)过滤。 */
export function createPresetRegistry(_ctx: Context, cache: NovelcraftCache): ContentPresetRegistry {
  return new ContentPresetRegistry(cache);
}
