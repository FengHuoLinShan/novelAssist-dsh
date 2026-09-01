// @novelcraft/dsh · ExecutionProfile 组合器(N34 / ADR-0023 §6)。
// 独立审查 P1/P2 + 审查项 1/2/4 修复: DSH 不再自持一份 ExecutionProfile 类型/校验 ——
//   生产唯一使用 @novelcraft/llm-step 的 ExecutionProfile / parseExecutionProfile /
//   fingerprintExecutionProfile / applyExecutionProfileToRequest(核心包唯一真源,
//   DSH 不保留不兼容接口)。本模块只做「组合 raw 数据」: 插件 Config.llm(最低层)→
//   ContentPresetRegistry(llm.yml preset 引用卡, N20)→ strict llm.yml 直键(N5)
//   三条来源合并成普通数据对象(raw, 只含白名单键), 然后一律交给 core
//   parseExecutionProfile 做最终校验 + 深冻结 —— version/source/policy/
//   contractVersions 全部由本组合器确定性生成(不来自自由输入)。
// fail-closed(ADR-0023 失败关闭): 非法 preset(引用名缺失/卡非法)/strict llm.yml
//   未知键·secret·非数字·小数·越界·temperature/provider/model 非法/组合后越界
//   一律在 provider 前抛 ExecutionProfileError —— 编排启动失败, 不带半解析配置跑。
// root 缺省(未绑定 vault)→ 仍组合 raw 并最终走 core parse(无 root 也校验,
//   插件 Config 越界同样 fail-closed, 不跳过校验面)。
// 不记录 secret(铁律 6/N5): 本模块只搬运 provider/model/温度/预算/超时等执行级参数,
//   llm.yml 依 N5 只存预设名与参数、Key 永不进文件; 错误消息不含任何密钥材料。
//
// 审查项 1(provenance brand): parseExecutionProfile 产出的对象带 opaque brand
//   (core 模块私有 WeakSet, isExecutionProfile 为唯一判定面)。requireTrustedExecutionProfile
//   供所有接收 profile 参数的 DSH 入口使用: 普通对象(哪怕字段合法/已冻结)一律拒绝 ——
//   外部 plain profile 无法伪造 brand、无法跳过 root 解析; 内部透传(resolveProfile 产出
//   后经 runStep/contentProviderFor 等传递)经 brand 零重解析验证。
// 审查项 2(单次快照): llm.yml 只读取一次 immutable 文本快照
//   (readExecutionLlmYmlSnapshot), preset 名与直键从同一文档解析 —— 消除
//   「resolveForBook 读一次、直键再读一次」的双读 TOCTOU(文件在两次读之间被改写时,
//   旧实现可能用版本 A 的 preset 名 + 版本 B 的直键组合出混合配置)。
// 审查项 4(top_p): 组合链不再丢弃 llm.yml/preset 的 top_p —— 进入 core strict
//   参数面(ExecutionProfile.top_p / ProviderRequest.top_p)与 fingerprint。
import path from 'node:path';
import {
  contractVersionsFromSpecs,
  isExecutionProfile,
  parseExecutionProfile,
  parseLlmYmlStrict,
  readExecutionLlmYmlSnapshot,
} from '@novelcraft/llm-step';
import type { ExecutionProfile, StrictLlmYml } from '@novelcraft/llm-step';
import type { LlmRoute } from '../config.js';
import type { ContentPresetRegistry } from './preset.js';

/** ExecutionProfile 数值边界(llm-step validateContentPreset 同款口径: policy-defaults §2/§3)。
 *  保留导出供上层/测试辨识; 组合后 raw 的统一校验仍走 core parseExecutionProfile。 */
export const PROFILE_TIMEOUT_MS_MIN = 1_000;
export const PROFILE_TIMEOUT_MS_MAX = 3_600_000;
export const PROFILE_MAX_TOKENS_MIN = 1;
export const PROFILE_MAX_TOKENS_MAX = 200_000;

/** fail-closed 错误类别(N34: 非法 preset / strict llm.yml / timeout / budget / 伪造 profile)。 */
export type ExecutionProfileErrorCode =
  | 'INVALID_PRESET'
  | 'INVALID_LLM_YML'
  | 'INVALID_TIMEOUT'
  | 'INVALID_BUDGET'
  | 'INVALID_PROFILE';

/** ExecutionProfile 解析失败(编排启动失败, fail-closed; 在 provider/审批之前抛)。 */
export class ExecutionProfileError extends Error {
  readonly code: ExecutionProfileErrorCode;
  /** 类别标记(供上层/测试辨识 fail-closed 来源; 消息不含 secret)。 */
  readonly kind = 'ExecutionProfileError' as const;

  constructor(code: ExecutionProfileErrorCode, message: string) {
    super(message);
    this.name = 'ExecutionProfileError';
    this.code = code;
  }
}

/**
 * 不可变执行画像(N34 §6): 编排启动解析一次、core 深冻结后透传。
 * 类型面 = @novelcraft/llm-step 的 ExecutionProfile(核心包唯一真源, 白名单 12 键,
 * version/source/policy/contractVersions 由组合器确定性生成); 本模块不定义
 * 自己的 ExecutionProfile 形状(独立审查 P1: 不保留 DSH 不兼容接口)。
 */
export type { ExecutionProfile } from '@novelcraft/llm-step';

interface DshProfileProvenance {
  root?: string;
  specRefsKey: string;
}
/** DSH-private provenance: core parse alone is public and therefore is not an authority token. */
const DSH_PROFILE_PROVENANCE = new WeakMap<object, DshProfileProvenance>();
const specRefsKey = (refs?: readonly string[]) => JSON.stringify([...(refs ?? [])].sort());
const rootKey = (root?: string) => root === undefined ? undefined : path.resolve(root);

/**
 * 公开入口接收 profile 参数时重新走 core parse(独立审查 P4):
 * 传入值(即使伪造: 越界/未知键/非纯对象/未冻结可变对象)一律重新校验并深冻结,
 * 不可绕过冻结与 strict; 合法输入返回新的深冻结等价对象。
 * 注意: 入口安全边界已升级为 requireTrustedExecutionProfile(brand 校验, 审查项 1)——
 * 本函数保留为显式「重新校验/重新品牌化」工具(调用方确认输入经过 core parse 即可),
 * 不用于接受未经验证的外部输入。
 */
export function reparseExecutionProfile(profile: ExecutionProfile): ExecutionProfile {
  return parseExecutionProfile(profile);
}

/**
 * 验证 profile 的 opaque provenance(审查项 1): 只有经 core parseExecutionProfile
 * 产出的对象(携带模块私有 brand, isExecutionProfile 判定)通过; 任何普通对象
 * (哪怕字段全合法/已冻结/展开副本)一律 INVALID_PROFILE fail-closed ——
 * 外部 plain profile 不得跳过 root 解析(config < preset < strict llm.yml 组合)。
 * 内部透传(resolveProfile 入口解析一次后经 runStep/contentProviderFor/deepImport
 * 等传递)经 brand 零重解析验证(O(1) WeakSet 判定, 不触发注册表/文件读取)。
 */
export function requireTrustedExecutionProfile(
  profile: ExecutionProfile,
  root?: string,
  options?: ResolveExecutionProfileOptions,
): ExecutionProfile {
  const provenance = isExecutionProfile(profile) ? DSH_PROFILE_PROVENANCE.get(profile) : undefined;
  const expectedRoot = rootKey(root);
  const expectedSpecs = options?.specRefs === undefined ? undefined : specRefsKey(options.specRefs);
  if (
    provenance === undefined ||
    provenance.root !== expectedRoot ||
    (expectedSpecs !== undefined && provenance.specRefsKey !== expectedSpecs)
  ) {
    throw new ExecutionProfileError(
      'INVALID_PROFILE',
      'profile 必须由当前 vault/契约的 resolveExecutionProfile 解析产生(跨 vault、普通对象或 core-only profile 均拒绝, fail-closed)',
    );
  }
  return profile;
}

/** 组合后 raw 的越界预检(保 INVALID_TIMEOUT/INVALID_BUDGET 类别可辨识;
 *  最终权威校验仍是 core parseExecutionProfile, 此处只是类别前置)。 */
function validateProfileParams(v: Record<string, unknown>): void {
  if (
    v.timeoutMs !== undefined &&
    (typeof v.timeoutMs !== 'number' ||
      v.timeoutMs < PROFILE_TIMEOUT_MS_MIN ||
      v.timeoutMs > PROFILE_TIMEOUT_MS_MAX)
  ) {
    throw new ExecutionProfileError(
      'INVALID_TIMEOUT',
      `timeout_ms 越界: ${String(v.timeoutMs)}(合法 ${PROFILE_TIMEOUT_MS_MIN}–${PROFILE_TIMEOUT_MS_MAX}ms; fail-closed, N34)`,
    );
  }
  if (
    v.maxTokens !== undefined &&
    (typeof v.maxTokens !== 'number' ||
      !Number.isInteger(v.maxTokens) ||
      v.maxTokens < PROFILE_MAX_TOKENS_MIN ||
      v.maxTokens > PROFILE_MAX_TOKENS_MAX)
  ) {
    throw new ExecutionProfileError(
      'INVALID_BUDGET',
      `max_tokens 越界: ${String(v.maxTokens)}(合法 ${PROFILE_MAX_TOKENS_MIN}–${PROFILE_MAX_TOKENS_MAX} 整数; fail-closed, N34)`,
    );
  }
}

/** 仅并入已定义字段(undefined 不覆盖上层值)。 */
function assignDefined(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined) target[k] = v;
  }
}

/** 组合 profile 的格式版本(确定性常量; 不随配置内容变化)。 */
export const PROFILE_FORMAT_VERSION = '1.0.0';

export interface ResolveExecutionProfileOptions {
  /**
   * contractVersions 的 spec 引用集(默认 = 注册表全部已注册 spec, 排序确定):
   * 契约版本从 spec registry 构造(独立审查 P2/R6), 不接收自由填写的 secret 值。
   */
  specRefs?: readonly string[];
}

/**
 * 解析一次不可变 ExecutionProfile(N34 §6 / ADR-0023 §6)。
 * 覆盖链(低→高): 插件 Config.llm → 该书 preset 卡(注册表, 引用即严格校验) →
 * strict llm.yml 直键(provider/model/temperature/top_p/max_tokens/timeout_ms, N5 键划分,
 * 单次快照解析, 未知键/secret/非法形态 fail-closed)。
 * 组合结果为普通数据对象 → 统一交给 core parseExecutionProfile(最终校验 + 深冻结):
 *   - version = PROFILE_FORMAT_VERSION(确定性常量);
 *   - source = 组合来源审计串(确定性: dsh:composed[:preset:<名>]);
 *   - policy = 生效预设名(无预设则不出现);
 *   - contractVersions = contractVersionsFromSpecs(注册表构造, 确定性);
 * 解析失败(非法 preset / strict llm.yml / 越界 / core 校验)→ 抛
 * ExecutionProfileError 或 ProfileValidationError(fail-closed), 由编排入口在启动时
 * 承接 —— 任何 provider 调用、审批请求或文件写入发生之前。
 * root 缺省(未绑定 vault)→ 仅插件 Config 层组合, 仍最终走 core parse(无 root 也校验)。
 */
export async function resolveExecutionProfile(
  registry: ContentPresetRegistry,
  config: LlmRoute,
  root?: string,
  options: ResolveExecutionProfileOptions = {},
): Promise<ExecutionProfile> {
  const raw: Record<string, unknown> = { version: PROFILE_FORMAT_VERSION };
  assignDefined(raw, {
    provider: config.provider,
    model: config.model,
    reasoning_effort: config.reasoningEffort,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    workflowBudget: config.workflowBudget,
  });

  if (root) {
    // 审查项 2: llm.yml 只读取一次 immutable 文本快照(readExecutionLlmYmlSnapshot),
    // preset 名与直键从同一文档(同一 parseLlmYmlStrict 结果)解析 —— 不存在
    // 「resolveForBook 读一次、直键再读一次」的双读 TOCTOU(两次读之间文件被改写时,
    // 旧实现可能组合出「版本 A 的 preset 名 + 版本 B 的直键」的混合配置)。
    let llm: StrictLlmYml;
    try {
      const llmText = readExecutionLlmYmlSnapshot(root);
      llm = llmText === undefined ? {} : parseLlmYmlStrict(llmText);
    } catch (err) {
      if (err instanceof Error && err.name === 'LlmYmlError') {
        throw new ExecutionProfileError('INVALID_LLM_YML', err.message);
      }
      throw err;
    }

    // preset 卡(N20): 同一快照解析出的 preset 名 → 注册表。strict: 引用名缺失/卡本身
    // 非法 → INVALID_PRESET(不静默回退, 区别于 legacy resolveDefaults 的 fail-soft)。
    // resolvePresetByName 只查注册表+校验卡, 不再读文件(单次快照面内完成)。
    if (llm.preset !== undefined) {
      const preset = await registry.resolvePresetByName(llm.preset, { strict: true });
      // strict 模式下 resolvePresetByName 对缺失/非法卡已抛 INVALID_PRESET, 此处兜底
      // (类型面防御, 不可达分支)。
      if (preset === undefined) {
        throw new ExecutionProfileError(
          'INVALID_PRESET',
          `llm.yml 引用预设「${llm.preset}」在注册表中不存在(fail-closed, N34)`,
        );
      }
      assignDefined(raw, {
        provider: preset.provider,
        model: preset.model,
        reasoning_effort: preset.reasoning_effort,
        temperature: preset.temperature,
        top_p: preset.top_p,
        maxTokens: preset.max_tokens,
        timeoutMs: preset.timeout_ms,
        workflowBudget: preset.workflow_budget,
      });
      raw.policy = preset.name;
    }

    // strict llm.yml 直键覆盖预设同名参数(N5 键划分: llm.yml 是项目级 LLM 设置)。
    // 审查项 4: top_p 同样进入组合(不再静默丢弃)—— 进入 core strict 参数面/指纹。
    assignDefined(raw, {
      provider: llm.provider,
      model: llm.model,
      reasoning_effort: llm.reasoning_effort,
      temperature: llm.temperature,
      top_p: llm.top_p,
      maxTokens: llm.max_tokens,
      timeoutMs: llm.timeout_ms,
      workflowBudget: llm.workflow_budget,
    });
  }

  // 来源审计串 + 契约版本集(确定性生成, 不来自自由输入; R6: 从 spec registry 构造)。
  const presetName = typeof raw.policy === 'string' ? raw.policy : undefined;
  raw.source = presetName ? `dsh:composed:preset:${presetName}` : 'dsh:composed';
  const contractVersions = contractVersionsFromSpecs(options.specRefs);
  if (Object.keys(contractVersions).length > 0) raw.contractVersions = contractVersions;

  // Current DSH GenerateOptions has no top_p transport. Reject during orchestration profile
  // resolution (before approval/provider/fallback) so workflows cannot mask the unsupported option.
  if (raw.top_p !== undefined) {
    throw new ExecutionProfileError('INVALID_PROFILE', '当前 DSH LLM 传输契约不支持 top_p');
  }
  // 越界类别前置(INVALID_TIMEOUT/INVALID_BUDGET 可辨识), 最终权威校验 = core parse。
  validateProfileParams(raw);
  const profile = parseExecutionProfile(raw);
  DSH_PROFILE_PROVENANCE.set(profile, {
    root: rootKey(root),
    specRefsKey: specRefsKey(options.specRefs),
  });
  return profile;
}
