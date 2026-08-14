// context · 确定性上下文编译(R5, small-modules §4 契约; 零 LLM)。
// Tier P0–P4 预算淘汰; CONTEXT_BUDGET 内置常量(N4, 不进 policy.yml)。
import type { Frontmatter } from "@novelcraft/store";

export const CONTEXT_BUDGET_DEFAULT = 4000; // N4: helper 内置
export const TOP_K_DEFAULT = 8;
export const PRIOR_NEIGHBOR_DEFAULT = 2;
export const PRIOR_NEIGHBOR_MAX = 4;

export interface CompileOptions {
  task: string;
  scope: "project" | "world" | "world_character" | "arc" | "chapter" | "full";
  budget_tokens?: number;
  top_k?: number;
  chapter_index?: number;
  prior_neighbor_limit?: number;
  include_pending_objects?: boolean;
  user_note?: string;
  mode?: "writing" | "debug";
}

export interface ContextSection {
  tier: "P0" | "P1" | "P2" | "P3" | "P4";
  name: string;
  content: string;
  tokens: number;
}

export interface BudgetEvent {
  tier: string;
  name: string;
  action: "include" | "truncate" | "evict";
  tokens: number;
}

export interface CompiledContext {
  task: string;
  scope: string;
  sections: ContextSection[];
  total_tokens: number;
  budget_tokens: number;
  evicted_keys: string[];
  budget_events: BudgetEvent[];
  confirmation: {
    selected_asset_ids: Record<string, string[]>;
    warnings: string[];
  };
}

/** 估算(与 llm-step 同启发式: CJK/1.6, 拉丁/4)。 */
export function estimateContextTokens(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f)) cjk += 1;
    else latin += 1;
  }
  return Math.ceil(cjk / 1.6 + latin / 4);
}

/** Tier 划分(确定性): P0 任务与指令 → P1 焦点章 → P2 结构 → P3 世界 → P4 RAG 补强。 */
export interface ContextInput {
  sections: Array<{ tier: "P0" | "P1" | "P2" | "P3" | "P4"; name: string; content: string }>;
}

/** 编译: 按 tier 顺序装入, 超预算截断/驱逐(先 P4 后 P3…), 产出摘要与事件。 */
export function compileContext(opts: CompileOptions, input: ContextInput): CompiledContext {
  if (!opts.task.trim()) throw new Error("task 必填");
  const budget = opts.budget_tokens ?? CONTEXT_BUDGET_DEFAULT;
  const order: Array<ContextSection["tier"]> = ["P0", "P1", "P2", "P3", "P4"];
  const byTier = (t: ContextSection["tier"]) => input.sections.filter((s) => s.tier === t);

  const sections: ContextSection[] = [];
  const events: BudgetEvent[] = [];
  const evicted: string[] = [];
  let used = 0;

  for (const tier of order) {
    for (const raw of byTier(tier)) {
      const tokens = estimateContextTokens(raw.content);
      const remain = budget - used;
      if (tokens <= remain) {
        sections.push({ tier: raw.tier, name: raw.name, content: raw.content, tokens });
        events.push({ tier, name: raw.name, action: "include", tokens });
        used += tokens;
      } else if (remain >= 64) {
        // 截断(保留头部, 标注省略)
        const head = raw.content.slice(0, Math.floor(raw.content.length * (remain / tokens) * 0.8)) + "\n…(截断)";
        const headTokens = estimateContextTokens(head);
        sections.push({ tier: raw.tier, name: raw.name, content: head, tokens: headTokens });
        events.push({ tier, name: raw.name, action: "truncate", tokens: headTokens });
        used += headTokens;
      } else {
        evicted.push(raw.name);
        events.push({ tier, name: raw.name, action: "evict", tokens: 0 });
      }
    }
  }

  const warnings: string[] = [];
  if (evicted.length > 0) warnings.push(`预算内驱逐 ${evicted.length} 个资料区: ${evicted.join(", ")}`);

  return {
    task: opts.task,
    scope: opts.scope,
    sections,
    total_tokens: used,
    budget_tokens: budget,
    evicted_keys: evicted,
    budget_events: events,
    confirmation: {
      selected_asset_ids: Object.fromEntries(
        input.sections.map((s) => [s.name, sections.filter((x) => x.name === s.name).map(() => s.name)]),
      ),
      warnings,
    },
  };
}

/** 编译摘要(作者语言, Stage 1 成本预告的一部分; 不暴露 raw JSON)。 */
export function contextSummary(compiled: CompiledContext): string {
  const byTier = compiled.sections
    .map((s) => s.tier)
    .filter((t, i, a) => a.indexOf(t) === i)
    .join(" → ");
  const evictNote = compiled.evicted_keys.length > 0 ? `, 预算内未纳入: ${compiled.evicted_keys.join("/")}` : "";
  return `上下文共 ${compiled.total_tokens}/${compiled.budget_tokens} tokens, 层级 ${byTier}${evictNote}`;
}

// 供上层按需读取场景 frontmatter(类型位)
export type { Frontmatter };
