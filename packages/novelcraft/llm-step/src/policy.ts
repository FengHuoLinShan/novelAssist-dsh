// policy 覆盖链(N5 键划分): 默认值 → policy.yml → llm.yml → calibration.md。
// 默认值依据 specs/rules/policy-defaults.md; llm.yml 只承载 provider 级键
// (model/temperature/top_p/max_tokens/timeout), Key 绝不进文件(D13/§22.5)。
import { existsSync, readFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";

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
