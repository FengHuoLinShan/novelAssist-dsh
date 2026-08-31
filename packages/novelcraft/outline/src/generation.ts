// outline · 结构创作编排(总纲/P20/分析, catalog §2 包装; 结果落结构资产)。
import { runStep } from "@novelcraft/llm-step";
import type { Provider, StepResult } from "@novelcraft/llm-step";
import { registerOutlineSpecs } from "./specs-outline.js";
import { writeOutline, writeStructureAsset } from "./structure.js";

/** 2.1 总纲生成 → structure/outline.md(draft; 采用/revisions 由 git 承接)。 */
export async function generateStoryOutline(
  provider: Provider,
  root: string,
  input: string,
  opts: { workflowId?: string } = {},
): Promise<{ ok: boolean; error?: StepResult["error"] }> {
  registerOutlineSpecs();
  const r = await runStep(provider, { specRef: "story_outline_generate", input });
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.result as Record<string, unknown>;
  const meta: Record<string, unknown> = { title: p.title ?? "总纲" };
  if (p.creative_core) meta.creative_core = p.creative_core;
  if (p.open_decisions) meta.open_decisions = p.open_decisions;
  // B3: specs-outline.ts story_outline_generate outputSchema 声明 major_storylines/
  // macro_movements 但从未持久化 → 现写入 outline.md frontmatter(frontmatter.ts:513 required)。
  if (p.major_storylines) meta.major_storylines = p.major_storylines;
  if (p.macro_movements) meta.macro_movements = p.macro_movements;
  writeOutline(root, { ...meta, outline_markdown: String(p.outline_markdown ?? "") }, {
    workflowId: opts.workflowId,
    message: "outline: story outline generated",
  });
  return { ok: true };
}

/** P20 生成输出 → 结构资产 frontmatter 的确定性映射(2.2 与 preview apply 共用同一语义)。 */
export function outlineItemFrontmatter(content: Record<string, unknown>): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    title: String(content.title ?? content.name ?? "未命名"),
    summary: String(content.summary ?? content.trajectory ?? ""),
    confidence: typeof content.confidence === "number" ? content.confidence : 0.8,
  };
  if (typeof content.name === "string" && content.name) fm.name = content.name;
  if (typeof content.thread_type === "string" && content.thread_type) fm.thread_type = content.thread_type;
  if (typeof content.target_type === "string" && content.target_type) fm.target_type = content.target_type;
  if (typeof content.target_id === "string" && content.target_id) fm.target_id = content.target_id;
  if (typeof content.secret_summary === "string" && content.secret_summary) fm.secret_summary = content.secret_summary;
  if (Array.isArray(content.relations)) fm.relations = content.relations;
  return fm;
}

/** 2.2 P20 当前层创作 → 对应结构资产目录(thread/arc)。 */
export async function generateOutlineItem(
  provider: Provider,
  root: string,
  target: "plot_thread" | "outline_arc",
  input: string,
  opts: { workflowId?: string } = {},
): Promise<{ ok: boolean; slug?: string; error?: StepResult["error"] }> {
  registerOutlineSpecs();
  const r = await runStep(provider, { specRef: "outline_generate", input: `【target: ${target}】\n${input}` });
  if (!r.ok) return { ok: false, error: r.error };
  const content = (r.result as { content?: Record<string, unknown> }).content ?? (r.result as Record<string, unknown>);
  const kind = target === "plot_thread" ? "thread" : "arc";
  // 映射逻辑抽为 outlineItemFrontmatter(与 preview apply 共用同一语义, M12-b/N44)。
  const fm = outlineItemFrontmatter(content);
  const slug = writeStructureAsset(root, kind, fm, opts);
  return { ok: true, slug };
}

/** 2.4 大纲分析(结果不写结构资产, 交收件箱)。 */
export async function analyzeOutline(provider: Provider, input: string): Promise<StepResult> {
  registerOutlineSpecs();
  return runStep(provider, { specRef: "outline_analyze", input });
}

/** 2.5 Scene 融合 synthesis(输出合成卡, 落点由调用方决定)。 */
export async function sceneFusionDraft(provider: Provider, input: string): Promise<StepResult> {
  registerOutlineSpecs();
  return runStep(provider, { specRef: "scene_fusion_draft", input });
}
