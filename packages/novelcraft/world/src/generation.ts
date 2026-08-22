// world · 生成中心五模式编排(§19 映射: 五模式 = 编排脑按意图调用的内容手步骤)。
// 本层 = runStep 包装 + 结果落点; 不写已采用资产(建议只进 pending)。
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guardPath, paths, slugify } from "@novelcraft/vault";
import { runStep } from "@novelcraft/llm-step";
import type { Provider, StepResult } from "@novelcraft/llm-step";
import { gitAdd, gitCommit, serializeFrontmatter, validateFrontmatterForWrite } from "@novelcraft/store";
import { registerWorldSpecs } from "./specs-world.js";

export type ChatReply = StepResult & { reply?: string };

/**
 * vault 内绝对路径 → 相对 root 的 POSIX pathspec(git 以 root 为 cwd; `/` 归一全平台
 * 可接受; 与 imports/src/alias-relation.ts relativePathOf 同款)。gitAdd 精确范围用:
 * 只 stage 本操作实际落盘的文件, 绝不 -A(N32: 业务写面禁用 git add -A; R17: 只提交
 * 本操作范围, 不捕获无关用户改动)。git add <path> 对新增/修改/删除一律按路径处理,
 * 已跟踪文件的删除同样被 stage(不依赖 -A 的"含删除"语义)。
 */
function relOf(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join("/");
}

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
  // 确定性字段(specs/assets/world.md: LLM schema 禁 id/status 且无 entity type):
  // id=slug、kind='object' 一律代码补全; status 语义不变(candidate 待审批,
  // 死路修复: 补 id/kind 后候选可经 store adopt(object) candidate→canonical 采用)。
  const fm: Record<string, unknown> = {
    id: slug,
    kind: "object",
    name: name.trim(),
    status: "candidate",
    target_type: "core_entity",
    confidence: typeof p.confidence === "number" ? p.confidence : 0.6,
  };
  if (p.summary !== undefined && p.summary !== "") fm.summary = String(p.summary);
  if (p.reveal_level !== undefined && p.reveal_level !== "") fm.reveal_level = String(p.reveal_level);
  // N23: 落盘前 schema 校验, issues 非空 fail-closed 不写。
  let checked: Record<string, unknown>;
  try {
    checked = validateFrontmatterForWrite("object", fm, slug);
  } catch (err) {
    return { ok: false, error: { kind: "schema_violation", message: err instanceof Error ? err.message : String(err) } };
  }
  // R9 写目标 containment + 冲突 fail-closed: 以 world/pending 为 guardPath root
  // (lexical+real)——同名已有 symlink 逃逸 → 拒绝跟随写 vault 外; 同名候选已存在
  // → 拒绝覆盖。
  const pendingDir = paths(root).world.pending;
  const file = guardPath(pendingDir, `${slug}.md`);
  if (existsSync(file)) throw new Error(`候选已存在: ${slug}`);
  writeFileSync(file, serializeFrontmatter(checked, `# ${name}\n\n${p.summary ?? ""}\n`), "utf8");
  // gitAdd 收窄(N32/R17): 只 stage 本操作落盘的这一个候选文件 —— 完整精确相对 POSIX
  // pathspec(`:(literal)` 防 slug 中 glob 字符如 `[`/`]` 被 git 当通配符), 绝不 -A。
  gitAdd(root, [`:(literal)${relOf(root, file)}`]);
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
  // 确定性字段(specs/assets/world.md bible_page 必填 id/page_key/version_number):
  // id=slug、page_key=slug、version_number=0 一律代码补全, LLM 禁止生成(输出被忽略)。
  // status draft = 页面提案工作稿, 发布走 world bible 流程(§19)。
  const fm: Record<string, unknown> = {
    id: slug,
    page_key: slug,
    version_number: 0,
    title,
    status: "draft",
    page_type: String(p.page_type ?? ""),
  };
  // N23: 写前校验最终落盘 frontmatter(bible_page schema), issues 非空 fail-closed 不写。
  let checked: Record<string, unknown>;
  try {
    checked = validateFrontmatterForWrite("bible_page", fm, slug);
  } catch (err) {
    return { ok: false, error: { kind: "schema_violation", message: err instanceof Error ? err.message : String(err) } };
  }
  // R9 写目标 containment + 冲突 fail-closed: 以 world/bible 为 guardPath root
  // (lexical+real)——同名已有 symlink 逃逸 → 拒绝跟随写 vault 外; 同名页面已存在
  // → 拒绝覆盖。
  const bibleDir = paths(root).bible.dir;
  const file = guardPath(bibleDir, `${slug}.md`);
  if (existsSync(file)) throw new Error(`页面已存在: ${slug}`);
  writeFileSync(
    file,
    serializeFrontmatter(checked, `# ${title}\n\n${String(p.overview ?? "")}\n\n${bodyMd}\n`),
    "utf8",
  );
  // gitAdd 收窄(N32/R17): 只 stage 本操作落盘的这一个页面提案文件 —— 完整精确相对
  // POSIX pathspec(`:(literal)` 防 glob 字符), 绝不 -A。
  gitAdd(root, [`:(literal)${relOf(root, file)}`]);
  gitCommit(root, `world bible suggest: ${slug}`);
  return { ok: true, slug };
}
