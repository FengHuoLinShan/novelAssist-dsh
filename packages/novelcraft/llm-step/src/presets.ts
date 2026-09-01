// llm-step · 内容手预设卡(N20, D13 多模型预设保存)。
// 预设 = 命名的一组 provider/model/参数; llm.yml 只存预设名引用(§22.5), Key 永不进预设(铁律 6/N5)。
// 形态参考父仓库 CREATIVE_PRESETS 参数卡; 与其「前端硬编码、运行时无消费点」的教训不同,
// 本类型经 dsh 包 withResolvedDefaults 注入 StepRequest.overrides, 直连执行路径(E8 缺口)。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";

export interface ContentPreset {
  /** 预设名(llm.yml preset 键引用; slug 风格) */
  name: string;
  /** 作者语言显示名(卡片首行) */
  label?: string;
  /** DSH provider 路由(如 'deepseek'); 缺省 = 继承插件 Config.llm.provider */
  provider?: string;
  /** 模型 id; 缺省 = 继承插件 Config.llm.model */
  model?: string;
  /** Adapter-owned opaque reasoning effort id. */
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout_ms?: number;
  workflow_budget?: number;
}

/** 种子预设(可在预设面板增删改; 模型槽位按用户 DSH 已配置 provider 选择)。 */
export const DEFAULT_CONTENT_PRESETS: ContentPreset[] = [
  { name: "default", label: "默认(继承助手配置)" },
  // DeepSeek V4 thinking 模式忽略 temperature/top_p；种子卡只保留可执行的 high effort。
  { name: "writing-day", label: "写作日", provider: "deepseek", model: "deepseek-v4-pro", reasoning_effort: "high" },
  { name: "import-day", label: "导入日", provider: "deepseek", model: "deepseek-v4-flash", reasoning_effort: "high", timeout_ms: 900_000 },
  { name: "polish", label: "精修校对", provider: "deepseek", model: "deepseek-v4-pro", reasoning_effort: "high" },
];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;

/** 校验一条预设; 返回问题列表(空 = 合法)。上界沿 policy-defaults §2/§3(1–3600s / 1–200000 tokens)。 */
export function validateContentPreset(v: unknown): string[] {
  const issues: string[] = [];
  if (typeof v !== "object" || v === null) return ["预设必须是对象"];
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || !NAME_RE.test(o.name)) {
    issues.push("name 必填且为 slug 风格(字母数字起头, 可含 - 与 _, ≤49 字)");
  }
  if (o.label !== undefined && typeof o.label !== "string") issues.push("label 必须是字符串");
  if (o.provider !== undefined && (typeof o.provider !== "string" || o.provider === "")) {
    issues.push("provider 必须是非空字符串");
  }
  if (o.model !== undefined && (typeof o.model !== "string" || o.model === "")) {
    issues.push("model 必须是非空字符串");
  }
  if (o.reasoning_effort !== undefined && (typeof o.reasoning_effort !== "string" || !/^\S{1,64}$/.test(o.reasoning_effort))) {
    issues.push("reasoning_effort 必须是非空无空白标识(≤64)");
  }
  if (o.temperature !== undefined && (typeof o.temperature !== "number" || o.temperature < 0 || o.temperature > 2)) {
    issues.push("temperature 必须在 [0,2]");
  }
  if (o.top_p !== undefined && (typeof o.top_p !== "number" || o.top_p < 0 || o.top_p > 1)) {
    issues.push("top_p 必须在 [0,1]");
  }
  if (o.max_tokens !== undefined && (typeof o.max_tokens !== "number" || !Number.isInteger(o.max_tokens) || o.max_tokens < 1 || o.max_tokens > 200_000)) {
    issues.push("max_tokens 必须是 1–200000 的整数");
  }
  if (o.timeout_ms !== undefined && (typeof o.timeout_ms !== "number" || o.timeout_ms < 1_000 || o.timeout_ms > 3_600_000)) {
    issues.push("timeout_ms 必须在 1000–3600000");
  }
  if (o.workflow_budget !== undefined && (typeof o.workflow_budget !== "number" || !Number.isInteger(o.workflow_budget) || o.workflow_budget < 1 || o.workflow_budget > 1_000_000_000)) {
    issues.push("workflow_budget 必须是 1–1000000000 的整数");
  }
  return issues;
}

/** 宽容解析预设列表(来自 domain KV/配置): 非法条目跳过, 不炸。 */
export function parseContentPresets(v: unknown): ContentPreset[] {
  if (!Array.isArray(v)) return [];
  const out: ContentPreset[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (validateContentPreset(item).length > 0) continue;
    const p = item as ContentPreset;
    if (seen.has(p.name)) continue; // 同名去重(先见优先)
    seen.add(p.name);
    out.push({
      name: p.name,
      ...(p.label !== undefined ? { label: p.label } : {}),
      ...(p.provider !== undefined ? { provider: p.provider } : {}),
      ...(p.model !== undefined ? { model: p.model } : {}),
      ...(p.reasoning_effort !== undefined ? { reasoning_effort: p.reasoning_effort } : {}),
      ...(p.temperature !== undefined ? { temperature: p.temperature } : {}),
      ...(p.top_p !== undefined ? { top_p: p.top_p } : {}),
      ...(p.max_tokens !== undefined ? { max_tokens: p.max_tokens } : {}),
      ...(p.timeout_ms !== undefined ? { timeout_ms: p.timeout_ms } : {}),
      ...(p.workflow_budget !== undefined ? { workflow_budget: p.workflow_budget } : {}),
    });
  }
  return out;
}

/** 按名查预设; 无 → undefined(调用方 fail-soft 回退默认路由)。 */
export function findPreset(presets: ContentPreset[], name: string): ContentPreset | undefined {
  return presets.find((p) => p.name === name);
}

function selectLlmYmlKey(
  root: string,
  key: "preset" | "reasoning_effort" | "embedding",
  value: string | null,
): void {
  const file = paths(root).assistant.llm;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const out: string[] = [];
  let wrote = false;
  for (const line of lines) {
    if (!/^\s/.test(line) && line.match(/^([A-Za-z_]+)\s*:/)?.[1] === key) {
      if (value !== null) out.push(`${key}: ${value}`);
      wrote = true;
    } else {
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  if (!wrote && value !== null) out.push(`${key}: ${value}`);
  writeFileSync(file, out.join("\n") + "\n", "utf8");
}

/**
 * 把预设名写入 .assistant/llm.yml(N19: 只动 preset 一键; 其余键原样保留)。
 * name = null → 移除 preset 键(回退继承); 非法名抛错(NAME_RE 防 YAML 注入)。
 * 行级改写与 policy.ts parseFlatYaml 的读取口径一致(顶层 key: value)。
 */
export function selectPresetInLlmYml(root: string, name: string | null): void {
  if (name !== null && !NAME_RE.test(name)) {
    throw new Error(`预设名非法: ${name}(slug 风格, 字母数字起头)`);
  }
  selectLlmYmlKey(root, "preset", name);
}

/** 写入/清除书级 reasoning effort；live exact-model 校验由 DSH client face 在写前完成。 */
export function selectReasoningEffortInLlmYml(root: string, value: string | null): void {
  if (value !== null && !/^\S{1,64}$/.test(value)) {
    throw new Error("reasoning_effort 必须是非空无空白标识(≤64)");
  }
  selectLlmYmlKey(root, "reasoning_effort", value);
}
/** L2 嵌入后端合法值(llm.yml embedding 键)。 */
export type EmbeddingBackendKey = "off" | "bge-local-v1";

const EMBEDDING_KEYS: readonly string[] = ["off", "bge-local-v1"];

/**
 * 把嵌入后端写入 .assistant/llm.yml(M6 Track B: 只动 embedding 一键; 其余键原样保留)。
 * value = null → 移除 embedding 键(回退不启用); 非法值抛错且不写(文件内容不变)。
 * 行级改写与 policy.ts parseFlatYaml 的读取口径一致(顶层 key: value), 与
 * selectPresetInLlmYml 同款单键纪律。
 */
export function selectEmbeddingInLlmYml(root: string, value: "off" | "bge-local-v1" | null): void {
  if (value !== null && !EMBEDDING_KEYS.includes(value)) {
    throw new Error(`嵌入后端值非法: ${String(value)}(可选: off / bge-local-v1)`);
  }
  selectLlmYmlKey(root, "embedding", value);
}
