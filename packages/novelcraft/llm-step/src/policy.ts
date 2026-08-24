// policy 覆盖链(N5 键划分): 默认值 → policy.yml → llm.yml → calibration.md。
// 默认值依据 specs/rules/policy-defaults.md; llm.yml 只承载 provider 级键
// (model/temperature/top_p/max_tokens/timeout), Key 绝不进文件(D13/§22.5)。
// N34/ADR-0023 §6(独立审查 P3 修复): 本文件新增 strict llm.yml 单次快照解析
// (parseLlmYmlStrict / resolveExecutionLlmYml)—— 执行入口(DSH ExecutionProfile 组合)
// 一律走 strict: 未知键/secret/非法 preset 类型/非数字/NaN/小数/越界/temperature/
// provider/model 全部 fail-closed; 一次 readFileSync 即单次快照, 不存在
// 「读两次文件、两次内容不一致」的 TOCTOU。legacy resolvePolicy 保持兼容
// (policy.yml/calibration 与其他非执行消费方仍可用), 但执行入口不使用它。
import { existsSync, readFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { isDeniedSecretKey } from "./secret-keys.js";

export interface ResolvedPolicy {
  // workflow 级(policy.yml 可覆盖)
  dedup: {
    merge_bias: number;
    l2_threshold: number;
  };
  alias: { attach_confidence: number };
  watch: { notify_threshold: number; deep_sweep: boolean };
  repair: { max_rounds: number };
  // provider 级(llm.yml 可覆盖; 默认空 = 由调用方/spec 决定)
  llm: {
    /** 内容手预设卡名(N20; llm.yml 只存预设名与参数, Key 永不进文件, N5) */
    preset?: string;
    model?: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    timeout_ms?: number;
    /** 嵌入后端(可选, L2; llm.yml 键: off | bge-local-v1) */
    embedding?: string;
  };
  // per-book 校准(calibration.md 显式覆盖)
  calibration: Record<string, string>;
}

/** 默认值(policy-defaults.md + N3 裁定) */
export const POLICY_DEFAULTS: ResolvedPolicy = {
  dedup: { merge_bias: 0.5, l2_threshold: 0.5 },
  alias: { attach_confidence: 0.8 },
  watch: { notify_threshold: 5, deep_sweep: false },
  repair: { max_rounds: 3 },
  llm: {},
  calibration: {},
};

/** 极简 YAML key: value 行解析(顶层 + 一层两空格缩进的嵌套键)。 */
function parseFlatYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let parent: string | null = null;
  const scalar = (v: string): unknown => {
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v === "" || v === "null") return v === "" ? "" : null;
    return v.replace(/^["']|["']$/g, "");
  };
  for (const line of text.split("\n")) {
    const t = line.replace(/#.*$/, "").trimEnd();
    if (!t.trim() || t.trimStart().startsWith("---")) continue;
    const nested = t.match(/^  ([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (nested && parent) {
      out[`${parent}.${nested[1]}`] = scalar(nested[2].trim());
      continue;
    }
    const m = t.match(/^([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const v = raw.trim();
    if (v === "") {
      parent = key; // 嵌套节头
      continue;
    }
    parent = null;
    out[key] = scalar(v);
  }
  return out;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** 加载并合并覆盖链; 任一文件缺失容错(空 vault 也能跑)。 */
export function resolvePolicy(root: string): ResolvedPolicy {
  const p = paths(root);
  const base = structuredClone(POLICY_DEFAULTS);
  const read = (file: string) =>
    existsSync(file) ? parseFlatYaml(readFileSync(file, "utf8")) : {};

  const policyYml = read(p.assistant.policy);
  base.dedup.merge_bias = num(policyYml["dedup.merge_bias"], base.dedup.merge_bias);
  base.dedup.l2_threshold = num(policyYml["dedup.l2_threshold"], base.dedup.l2_threshold);
  base.alias.attach_confidence = num(
    policyYml["alias.attach_confidence"],
    base.alias.attach_confidence,
  );
  base.watch.notify_threshold = num(
    policyYml["watch.notify_threshold"],
    base.watch.notify_threshold,
  );
  base.watch.deep_sweep = bool(policyYml["watch.deep_sweep"], base.watch.deep_sweep);
  base.repair.max_rounds = num(policyYml["repair.max_rounds"], base.repair.max_rounds);

  const llmYml = read(p.assistant.llm);
  base.llm.preset = str(llmYml.preset);
  base.llm.model = str(llmYml.model);
  base.llm.temperature = llmYml.temperature === undefined ? undefined : num(llmYml.temperature, NaN);
  base.llm.top_p = llmYml.top_p === undefined ? undefined : num(llmYml.top_p, NaN);
  base.llm.max_tokens = llmYml.max_tokens === undefined ? undefined : num(llmYml.max_tokens, NaN);
  base.llm.timeout_ms = llmYml.timeout_ms === undefined ? undefined : num(llmYml.timeout_ms, NaN);
  base.llm.embedding = str(llmYml.embedding);
  if (Number.isNaN(base.llm.temperature)) delete base.llm.temperature;
  if (Number.isNaN(base.llm.top_p)) delete base.llm.top_p;
  if (Number.isNaN(base.llm.max_tokens)) delete base.llm.max_tokens;
  if (Number.isNaN(base.llm.timeout_ms)) delete base.llm.timeout_ms;

  const calibration = read(p.assistant.calibration);
  base.calibration = Object.fromEntries(
    Object.entries(calibration).map(([k, v]) => [k, String(v ?? "")]),
  );

  return base;
}

// ===========================================================================
// strict llm.yml 单次快照解析(N34 / ADR-0023 §6, 执行入口 fail-closed)。
// legacy resolvePolicy(上方)保持兼容供非执行消费方; 执行入口(DSH ExecutionProfile
// 组合)一律走本解析: 未知键/secret/非法 preset 类型/非数字/NaN/小数/越界/
// temperature/provider/model 全部 fail-closed, 不带半解析配置跑。
// ===========================================================================

/** strict llm.yml 解析结果(全部字段可选; 出现即已通过严格校验)。 */
export interface StrictLlmYml {
  /** 内容手预设卡名(N20; 必须 slug 风格字符串) */
  preset?: string;
  /** DSH provider 路由覆盖(可选; 非空无空白字符串) */
  provider?: string;
  /** 模型 id 覆盖(可选; 非空无空白字符串) */
  model?: string;
  /** 单步温度 [0,2] 有限数字 */
  temperature?: number;
  /** top_p [0,1] 有限数字 */
  top_p?: number;
  /** 单次输出 token 上限(1–200000 整数, 拒绝小数表示) */
  max_tokens?: number;
  /** 单步超时毫秒(1000–3600000 整数, 拒绝小数表示) */
  timeout_ms?: number;
  /** 工作流累计 token 预算(1–1000000000 整数) */
  workflow_budget?: number;
  /** 嵌入后端(off | bge-local-v1) */
  embedding?: string;
}

/** strict llm.yml 解析失败(fail-closed 承载; 编排捕获即启动失败, 不静默回退)。 */
export class LlmYmlError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`llm.yml 解析失败: ${issues.join("; ")}`);
    this.name = "LlmYmlError";
    this.issues = issues;
  }
}

const STRICT_KNOWN_KEYS = new Set([
  "preset",
  "provider",
  "model",
  "temperature",
  "top_p",
  "max_tokens",
  "timeout_ms",
  "workflow_budget",
  "embedding",
]);
/** 整数键: 拒绝任何小数表示(10.0 也算小数表示, 一律 fail-closed)。 */
const STRICT_INT_KEYS = new Set(["max_tokens", "timeout_ms", "workflow_budget"]);
const STRICT_STRING_KEYS = new Set(["preset", "provider", "model", "embedding"]);
const PRESET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,48}$/;
const NO_WS_RE = /^\S+$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function strictStringValue(key: string, raw: string, lineNo: number): { value?: string; issue?: string } {
  // 数字形态的 raw 对字符串键一律类型错误; 值不回显(审查项 7: 可能含 secret 材料)。
  if (NUMERIC_RE.test(raw)) return { issue: `第 ${lineNo} 行 ${key} 必须是字符串(数字形态不接受)` };
  const value = raw.replace(/^["']|["']$/g, "");
  if (key === "preset" && !PRESET_RE.test(value)) {
    return { issue: `第 ${lineNo} 行 preset 必须是非空 slug(字母数字起头, 可含 - 与 _, ≤49 字)` };
  }
  if ((key === "provider" || key === "model") && (!NO_WS_RE.test(value) || value.length > (key === "provider" ? 64 : 128))) {
    return { issue: `第 ${lineNo} 行 ${key} 必须是非空无空白字符串(≤${key === "provider" ? 64 : 128})` };
  }
  if (key === "embedding" && value !== "off" && value !== "bge-local-v1") {
    return { issue: `第 ${lineNo} 行 embedding 必须是 off | bge-local-v1` };
  }
  return { value };
}

/**
 * strict 单次快照解析(纯函数, 输入为一次读取的文本快照):
 * 任何非法输入 → 抛 LlmYmlError(issues 完整列出)。
 * 审查项 7: 错误只报「行号 + 通用原因 + 键名」, 绝不回显行原文/值 —— malformed 行
 * (如 `api_key = sk-...`)可能含 secret 材料, 值一律不进入错误消息。
 */
export function parseLlmYmlStrict(text: string): StrictLlmYml {
  const issues: string[] = [];
  const out: StrictLlmYml = {};
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const rawLine = lines[i];
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    const t = line.trim();
    if (!t || t.startsWith("---")) continue;
    // 只接受顶层 `key: value` 行(嵌套节/其他形态一律 fail-closed)。
    const m = /^([A-Za-z0-9_.\-]+):\s*(.*)$/.exec(line);
    if (!m) {
      issues.push(`第 ${lineNo} 行格式无法解析(仅支持顶层 key: value 行)`);
      continue;
    }
    const [, key, raw] = m;
    const v = raw.trim();
    if (v === "") {
      issues.push(`第 ${lineNo} 行键 ${key} 缺值(嵌套节不允许出现在执行面 llm.yml)`);
      continue;
    }
    if (seen.has(key)) {
      issues.push(`第 ${lineNo} 行重复键: ${key}(严格解析拒绝重复)`);
      continue;
    }
    seen.add(key);
    if (isDeniedSecretKey(key)) {
      issues.push(`第 ${lineNo} 行敏感键拒绝进入执行配置: ${key}(N5: Key 永不进文件/配置面)`);
      continue;
    }
    if (!STRICT_KNOWN_KEYS.has(key)) {
      issues.push(`第 ${lineNo} 行未知键: ${key}(白名单: ${[...STRICT_KNOWN_KEYS].sort().join("/")})`);
      continue;
    }
    if (STRICT_STRING_KEYS.has(key)) {
      const r = strictStringValue(key, v, lineNo);
      if (r.issue) {
        issues.push(r.issue);
        continue;
      }
      (out as Record<string, string>)[key] = r.value as string;
      continue;
    }
    // 数字键: 非数字形态 → 非数字 fail-closed; NaN 不可能来自文本形态, 仍兜底拒绝。
    // 值一律不回显(审查项 7: 行值可能含 secret 材料)。
    if (!NUMERIC_RE.test(v)) {
      issues.push(`第 ${lineNo} 行 ${key} 必须是非空数字`);
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || Number.isNaN(n)) {
      issues.push(`第 ${lineNo} 行 ${key} 必须是有限数字`);
      continue;
    }
    if (STRICT_INT_KEYS.has(key) && v.includes(".")) {
      issues.push(`第 ${lineNo} 行 ${key} 必须是整数(拒绝小数表示)`);
      continue;
    }
    if (key === "temperature" && (n < 0 || n > 2)) {
      issues.push(`第 ${lineNo} 行 temperature 越界(合法 [0,2])`);
      continue;
    }
    if (key === "top_p" && (n < 0 || n > 1)) {
      issues.push(`第 ${lineNo} 行 top_p 越界(合法 [0,1])`);
      continue;
    }
    if (key === "max_tokens" && (!Number.isInteger(n) || n < 1 || n > 200_000)) {
      issues.push(`第 ${lineNo} 行 max_tokens 越界(合法 1–200000 整数)`);
      continue;
    }
    if (key === "timeout_ms" && (!Number.isInteger(n) || n < 1_000 || n > 3_600_000)) {
      issues.push(`第 ${lineNo} 行 timeout_ms 越界(合法 1000–3600000 整数)`);
      continue;
    }
    if (key === "workflow_budget" && (!Number.isInteger(n) || n < 1 || n > 1_000_000_000)) {
      issues.push(`第 ${lineNo} 行 workflow_budget 越界(合法 1–1000000000 整数)`);
      continue;
    }
    (out as Record<string, number>)[key] = n;
  }
  if (issues.length > 0) throw new LlmYmlError(issues);
  return out;
}

/**
 * 单次读取 .assistant/llm.yml 的 immutable 文本快照(审查项 2):
 * 一次 readFileSync 后返回同一份字符串 —— 调用方(preset 名解析与直键解析)从同一
 * 文档快照解析, 不存在「先读 A 后读 B、两次内容不一致」的 TOCTOU。
 * 文件缺失 → undefined(合法, 调用方视为空配置); 读取失败(IO)→ 原样抛出。
 */
export function readExecutionLlmYmlSnapshot(root: string): string | undefined {
  const file = paths(root).assistant.llm;
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8");
}

/**
 * 按 root 读取并 strict 解析 .assistant/llm.yml(执行入口)。
 * 单次快照: 一次 readFileSync 后只解析内存文本(经 readExecutionLlmYmlSnapshot)——
 * 不存在「读两次文件、内容不一致」的 TOCTOU; 文件缺失 → 空配置(合法);
 * 内容非法 → 抛 LlmYmlError(fail-closed, 只报行号/通用原因, 不回显值)。
 */
export function resolveExecutionLlmYml(root: string): StrictLlmYml {
  const text = readExecutionLlmYmlSnapshot(root);
  if (text === undefined) return {};
  return parseLlmYmlStrict(text);
}
