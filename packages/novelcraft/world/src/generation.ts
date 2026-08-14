// world · 生成中心五模式编排(§19 映射: 五模式 = 编排脑按意图调用的内容手步骤)。
// 本层 = runStep 包装 + 结果落点; 不写已采用资产(建议只进 pending)。
import { writeFileSync } from "node:fs";
import { paths, slugify } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider, StepResult } from "@novelcraft/llm-step";
import { gitAdd, gitCommit } from "@novelcraft/store";
import { registerWorldSpecs } from "./specs-world.js";

export type ChatReply = StepResult & { reply?: string };

/** 4.1 共创对话(不写资产)。 */
export async function worldChat(provider: Provider, input: string): Promise<ChatReply> {
  registerWorldSpecs();
  const r = await runStep(provider, { specRef: "world_creation_chat", input });
  return { ...r, reply: r.ok ? String((r.result as { reply?: string }).reply ?? "") : undefined };
}

/** 4.2 只读收束。 */
export async function worldConverge(provider: Provider, input: string): Promise<StepResult> {
  registerWorldSpecs();
  return runStep(provider, { specRef: "world_convergence", input });
}

/** 4.3 一跳探索(不创建资产)。 */
export async function worldExplore(provider: Provider, input: string): Promise<StepResult> {
  registerWorldSpecs();
  return runStep(provider, { specRef: "world_exploration", input });
}

/** 4.4 页面检修(findings 供复核)。 */
export async function worldInspect(provider: Provider, input: string): Promise<StepResult> {
  registerWorldSpecs();
  return runStep(provider, { specRef: "world_semantic_inspection", input });
}

/** 4.6 世界对象建议 → world/pending(待处理建议, 不自动采用)。 */
export async function suggestEntity(
  provider: Provider,
  root: string,
  input: string,
): Promise<{ ok: boolean; slug?: string; error?: StepResult["error"] }> {
  registerWorldSpecs();
  const r = await runStep(provider, { specRef: "world_core_entity", input });
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.result as Record<string, unknown>;
  const name = String(p.name ?? "");
  if (!name) return { ok: false, error: { kind: "schema_violation", message: "建议缺 name" } };
  const slug = slugify(`obj-${name}`) || `obj-${Date.now()}`;
  const lines = [
    "---",
    `name: ${JSON.stringify(name)}`,
    "status: candidate",
    `target_type: core_entity`,
    `confidence: ${typeof p.confidence === "number" ? p.confidence : 0.6}`,
  ];
  if (p.summary) lines.push(`summary: ${JSON.stringify(p.summary)}`);
  if (p.reveal_level) lines.push(`reveal_level: ${JSON.stringify(p.reveal_level)}`);
  lines.push("---", "");
  writeFileSync(paths(root).world.pendingFile(slug), lines.join("\n") + `# ${name}\n\n${p.summary ?? ""}\n`, "utf8");
  gitAdd(root);
  gitCommit(root, `world suggest: ${slug}`);
  return { ok: true, slug };
}

/** 4.7/4.8 世界书页面建议 → 落 bible/ 为 draft 提案文件(apply 走 store adopt bible_page)。 */
export async function suggestBiblePage(
  provider: Provider,
  root: string,
  input: string,
  opts: { isNewPage?: boolean } = {},
): Promise<{ ok: boolean; slug?: string; error?: StepResult["error"] }> {
  registerWorldSpecs();
  const r = await runStep(provider, {
    specRef: opts.isNewPage ? "world_bible_new_page" : "world_bible_page",
    input,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const p = r.result as Record<string, unknown>;
  const title = String(p.title ?? "");
  if (!title) return { ok: false, error: { kind: "schema_violation", message: "提案缺 title" } };
  const slug = slugify(title) || `page-${Date.now()}`;
  const sections = (Array.isArray(p.sections) ? p.sections : []) as Array<Record<string, unknown>>;
  const bodyMd = sections
    .map((s) => `## ${String(s.title ?? "")}\n\n${String(s.body_markdown ?? "")}`)
    .join("\n\n");
  const lines = [
    "---",
    `title: ${JSON.stringify(title)}`,
    "status: draft", // 页面提案 = 工作稿, 发布走 world bible 流程(§19)
    `page_type: ${JSON.stringify(String(p.page_type ?? ""))}`,
  ];
  lines.push("---", "");
  writeFileSync(paths(root).bible.bibleFile(slug), lines.join("\n") + `# ${title}\n\n${String(p.overview ?? "")}\n\n${bodyMd}\n`, "utf8");
  gitAdd(root);
  gitCommit(root, `world bible suggest: ${slug}`);
  return { ok: true, slug };
}
