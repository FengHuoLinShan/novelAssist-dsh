// context · 可审计安全入口(P0-C1)。旧 compileContext() 保持不变；新消费方只使用
// rendered_text，manifest 只包含真正进入该文本的来源。预算是现有启发式估算器的硬上限。
import { createHash } from "node:crypto";
import {
  CONTEXT_BUDGET_DEFAULT,
  estimateContextTokens,
  type CompileOptions,
  type ContextSection,
} from "./context.js";

export interface AuditableContextSource {
  tier: ContextSection["tier"];
  name: string;
  content: string;
  source_id: string;
  source_type: string;
  source_status?: string;
  open_target?: Record<string, unknown>;
}

export interface AuditableSourceRef {
  source_id: string;
  source_type: string;
  name: string;
  source_status?: string;
  open_target?: Record<string, unknown>;
  /** 原始来源全文 hash。 */
  source_hash: string;
  /** 实际送入的来源片段 hash（不含渲染标题/截断标记）。 */
  included_content_hash: string;
  /** UTF-16 索引，当前截断只保留头部。 */
  included_range: { start: 0; end: number };
  truncated: boolean;
}

export type AuditableContextWarning =
  | { code: "source_truncated"; source_id: string; message: string }
  | { code: "source_omitted"; source_id: string; message: string };

export interface AuditableCompiledContext {
  task: string;
  scope: CompileOptions["scope"];
  rendered_text: string;
  total_tokens: number;
  budget_tokens: number;
  source_manifest: AuditableSourceRef[];
  omitted_source_ids: string[];
  warnings: AuditableContextWarning[];
  selected_asset_ids: Record<string, string[]>;
  context_hash: string;
}

const TIERS: Array<ContextSection["tier"]> = ["P0", "P1", "P2", "P3", "P4"];
const SCOPES: Array<CompileOptions["scope"]> = ["project", "world", "world_character", "arc", "chapter", "full"];
const TRUNCATED = "\n…(截断)";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!wellFormed(value)) throw new Error("open_target 含非法 Unicode");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("open_target 数字必须有限");
    return value;
  }
  if (!value || typeof value !== "object") throw new Error("open_target 必须是 JSON 值");
  if (seen.has(value)) throw new Error("open_target 不得循环引用");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new Error("open_target 数组不得稀疏");
      return value.map((item) => canonicalValue(item, seen));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("open_target 必须是普通对象");
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => {
          if (!wellFormed(key)) throw new Error("open_target key 含非法 Unicode");
          return [key, canonicalValue((value as Record<string, unknown>)[key], seen)];
        }),
    );
  } finally {
    seen.delete(value);
  }
}

function block(source: AuditableContextSource, content: string, truncated: boolean): string {
  return `## [${source.tier}] ${source.name}\n${content}${truncated ? TRUNCATED : ""}`;
}

function render(blocks: string[]): string {
  return blocks.join("\n\n");
}

/** 不在 UTF-16 surrogate pair 中间截断。 */
function safePrefixEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

function maxPrefix(
  source: AuditableContextSource,
  priorBlocks: string[],
  budget: number,
): string {
  let low = 0;
  let high = source.content.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const end = safePrefixEnd(source.content, mid);
    const candidate = render([...priorBlocks, block(source, source.content.slice(0, end), true)]);
    if (estimateContextTokens(candidate) <= budget) low = mid;
    else high = mid - 1;
  }
  const end = safePrefixEnd(source.content, low);
  const content = source.content.slice(0, end);
  return content && estimateContextTokens(render([...priorBlocks, block(source, content, true)])) <= budget
    ? content
    : "";
}

function validate(
  opts: CompileOptions,
  sources: AuditableContextSource[],
): { budget: number; sources: AuditableContextSource[] } {
  if (!opts || typeof opts !== "object" || typeof opts.task !== "string" || !opts.task.trim()) {
    throw new Error("task 必填");
  }
  if (!wellFormed(opts.task)) throw new Error("task 含非法 Unicode");
  if (!SCOPES.includes(opts.scope)) throw new Error("scope 非法");
  const budget = opts.budget_tokens ?? CONTEXT_BUDGET_DEFAULT;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("budget_tokens 必须是正安全整数");
  if (!Array.isArray(sources)) throw new Error("sources 必须是数组");
  const ids = new Set<string>();
  const normalized: AuditableContextSource[] = [];
  for (const raw of sources as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("source 必须是对象");
    const source = raw as AuditableContextSource;
    if (!TIERS.includes(source.tier)) throw new Error(`source ${source.source_id} tier 非法`);
    if (typeof source.source_id !== "string" || typeof source.source_type !== "string" ||
      !source.source_id.trim() || !source.source_type.trim()) throw new Error("source_id/source_type 必填");
    if (!wellFormed(source.source_id) || !wellFormed(source.source_type) || /[\r\n\u2028\u2029]/.test(source.source_id + source.source_type)) {
      throw new Error("source_id/source_type 必须是合法单行 Unicode");
    }
    if (typeof source.name !== "string" || !source.name.trim() || /[\r\n\u2028\u2029]/.test(source.name)) {
      throw new Error("source name 必须是非空单行文本");
    }
    if (!wellFormed(source.name)) throw new Error("source name 含非法 Unicode");
    if (typeof source.content !== "string" || !source.content.trim()) {
      throw new Error(`source ${source.source_id} content 为空`);
    }
    if (!wellFormed(source.content)) throw new Error(`source ${source.source_id} content 含非法 Unicode`);
    if (source.source_status !== undefined &&
      (typeof source.source_status !== "string" || !wellFormed(source.source_status))) {
      throw new Error(`source ${source.source_id} source_status 非法`);
    }
    if (ids.has(source.source_id)) throw new Error(`source_id 重复: ${source.source_id}`);
    ids.add(source.source_id);
    const openTarget = source.open_target === undefined
      ? undefined
      : canonicalValue(source.open_target) as Record<string, unknown>;
    if (openTarget !== undefined && (openTarget === null || Array.isArray(openTarget))) {
      throw new Error(`source ${source.source_id} open_target 必须是对象`);
    }
    normalized.push({
      ...source,
      ...(openTarget !== undefined ? { open_target: openTarget } : {}),
    });
  }
  return { budget, sources: normalized };
}

/**
 * 加法式安全编译器：优先级稳定，唯一 rendered_text 不超过估算预算，
 * manifest/回执严格由实际保留片段生成。
 */
export function compileAuditableContext(
  opts: CompileOptions,
  input: { sources: AuditableContextSource[] },
): AuditableCompiledContext {
  if (!input || typeof input !== "object") throw new Error("input 必填");
  const validated = validate(opts, input.sources);
  const budget = validated.budget;
  const sources = validated.sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => TIERS.indexOf(a.source.tier) - TIERS.indexOf(b.source.tier) || a.index - b.index)
    .map(({ source }) => source);
  const blocks: string[] = [];
  const manifest: AuditableSourceRef[] = [];
  const omitted: string[] = [];
  const warnings: AuditableContextWarning[] = [];

  for (const source of sources) {
    const full = render([...blocks, block(source, source.content, false)]);
    let included = source.content;
    let truncated = false;
    if (estimateContextTokens(full) > budget) {
      included = maxPrefix(source, blocks, budget);
      truncated = included.length > 0;
    }
    if (!included) {
      omitted.push(source.source_id);
      warnings.push({
        code: "source_omitted",
        source_id: source.source_id,
        message: `预算未纳入来源 ${source.source_id}`,
      });
      continue;
    }
    blocks.push(block(source, included, truncated));
    manifest.push({
      source_id: source.source_id,
      source_type: source.source_type,
      name: source.name,
      ...(source.source_status !== undefined ? { source_status: source.source_status } : {}),
      ...(source.open_target !== undefined ? { open_target: source.open_target } : {}),
      source_hash: sha256(source.content),
      included_content_hash: sha256(included),
      included_range: { start: 0, end: included.length },
      truncated,
    });
    if (truncated) {
      warnings.push({
        code: "source_truncated",
        source_id: source.source_id,
        message: `来源 ${source.source_id} 按估算预算截断`,
      });
    }
  }

  const renderedText = render(blocks);
  const selected = new Map<string, string[]>();
  for (const source of manifest) {
    const ids = selected.get(source.source_type) ?? [];
    ids.push(source.source_id);
    selected.set(source.source_type, ids);
  }
  const selectedAssetIds = Object.fromEntries(selected);
  const sourceTuples = sources.map((source) => ({
    tier: source.tier,
    source_id: source.source_id,
    source_type: source.source_type,
    name: source.name,
    source_status: source.source_status ?? null,
    open_target: canonicalValue(source.open_target ?? null),
    source_hash: sha256(source.content),
  }));
  const contextHash = sha256(JSON.stringify({
    task: opts.task,
    scope: opts.scope,
    budget_tokens: budget,
    rendered_text_hash: sha256(renderedText),
    source_tuples: sourceTuples,
    included: manifest.map((source) => ({
      source_id: source.source_id,
      included_content_hash: source.included_content_hash,
      included_range: source.included_range,
      truncated: source.truncated,
    })),
    omitted_source_ids: omitted,
  }));

  return {
    task: opts.task,
    scope: opts.scope,
    rendered_text: renderedText,
    total_tokens: estimateContextTokens(renderedText),
    budget_tokens: budget,
    source_manifest: manifest,
    omitted_source_ids: omitted,
    warnings,
    selected_asset_ids: selectedAssetIds,
    context_hash: contextHash,
  };
}
