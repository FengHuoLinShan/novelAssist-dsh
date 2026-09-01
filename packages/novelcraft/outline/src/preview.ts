// outline · 生成 preview/apply 拆分(M12-b/N44 加法, 台账 §6.18.2 语义)。
// 现状 generateStoryOutline/generateOutlineItem 直写 canonical 结构资产 —— 包工具即
// 冒充 preview。本文件拆两段:
//   preview*: 跑 runStep → 生成产物落 .assistant/proposals/(机器态暂存, 照
//     writing.proposeNextChapter 的 ProposalRecord 先例), **不写 structure 资产**;
//   apply*: 读暂存记录(按 run_id) → writeOutline/writeStructureAsset(canonical 写,
//     由 DSH 侧在 adoptGuarded 审批内执行)。
// 暂存记录带 promptFingerprint(模型可见⟺可回放)与 input 摘要 hash, apply 时校验
// 记录完整性; 记录是 .assistant 机器态, 不经审批(与 proposals 先例同口径)。
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { guardPath, paths } from "@novelcraft/vault";
import { runStep, type Provider, type StepResult } from "@novelcraft/llm-step";
import { registerOutlineSpecs } from "./specs-outline.js";
import { writeOutline, writeStructureAsset } from "./structure.js";
import { outlineItemFrontmatter } from "./generation.js";
import {
  assertSelectedVaultSourcesCurrent,
  compileSelectedVaultContext,
  type AuditableContextWarning,
  type AuditableSourceRef,
  type SelectedSourceSnapshot,
  type SelectedVaultSourceRule,
  type VaultContextSelection,
} from "@novelcraft/context";

export type OutlineContextSelection = VaultContextSelection;

export interface OutlineContextReceipt {
  context_hash: string;
  budget_tokens: number;
  total_tokens: number;
  source_manifest: AuditableSourceRef[];
  omitted_source_ids: string[];
  warnings: AuditableContextWarning[];
  source_snapshot: SelectedSourceSnapshot[];
}

/** preview 暂存记录(机器态; canonical 写只发生在 apply)。 */
export interface OutlinePreviewRecord {
  kind: "story_outline" | "outline_item";
  run_id: string;
  /** outline_item 的 target(preview 时锁定, apply 沿用)。 */
  target?: "plot_thread" | "outline_arc";
  generated_at: string;
  /** 输入摘要 sha256 前 16 hex(apply 时可对当前输入做一致性提示, 不强制)。 */
  input_hash: string;
  /** 生成产物(与 spec outputSchema 对齐的对象)。 */
  result: Record<string, unknown>;
  /** 模型可见指纹(N38: promptFingerprint 透传, 可回放审计)。 */
  prompt_fingerprint?: {
    system_prompt_hash: string;
    schema_injection: string;
    output_schema_hash: string;
  };
  context_receipt?: OutlineContextReceipt;
}

function outlineSourceRule(ref: string): SelectedVaultSourceRule | undefined {
  if (ref === "structure/outline.md") {
    return { tier: "P1", source_type: "story_outline", current_statuses: ["current"], default_status: "current" };
  }
  if (/^structure\/(threads|arcs|foreshadowing|reveal)\/[^/]+\.md$/.test(ref)) {
    return { tier: "P2", source_type: "structure_asset", current_statuses: ["canonical"], working_statuses: ["draft"] };
  }
  if (/^scenes\/[^/]+\.md$/.test(ref)) {
    return { tier: "P2", source_type: "scene", current_statuses: ["canonical"], working_statuses: ["draft"] };
  }
  if (/^world\/objects\/[^/]+\.md$/.test(ref) || /^world\/[^/]+\.md$/.test(ref)) {
    return { tier: "P3", source_type: "world_entity", current_statuses: ["canonical"], working_statuses: ["draft", "candidate"] };
  }
  if (/^bible\/[^/]+\.md$/.test(ref)) {
    return { tier: "P3", source_type: "bible_page", current_statuses: ["canonical"], working_statuses: ["draft"] };
  }
  return undefined;
}

export function buildOutlineSelectedContext(
  root: string,
  task: "story_outline" | "outline_item",
  selection: OutlineContextSelection,
) {
  return compileSelectedVaultContext(root, {
    task: task === "story_outline" ? "生成小说总纲 preview" : "生成 P20 结构资产 preview",
    scope: task === "story_outline" ? "project" : "arc",
    selection,
    classify: outlineSourceRule,
  });
}

function receiptOf(context: ReturnType<typeof buildOutlineSelectedContext>): OutlineContextReceipt {
  return {
    context_hash: context.context_hash,
    budget_tokens: context.budget_tokens,
    total_tokens: context.total_tokens,
    source_manifest: context.source_manifest,
    omitted_source_ids: context.omitted_source_ids,
    warnings: context.warnings,
    source_snapshot: context.source_snapshot,
  };
}

function inputHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

function proposalDirectory(root: string, create = false): string | undefined {
  const dir = guardPath(root, paths(root).assistant.proposals);
  if (!existsSync(dir)) {
    if (!create) return undefined;
    mkdirSync(dir, { recursive: true });
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("preview proposals 路径必须是 vault 内普通目录");
  return dir;
}

function writePreview(root: string, record: OutlinePreviewRecord): string {
  proposalDirectory(root, true);
  const name =
    record.kind === "story_outline"
      ? `outline-${record.run_id}`
      : `outline-item-${record.target}-${record.run_id}`;
  const file = guardPath(root, paths(root).assistant.proposalFile(name));
  if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) throw new Error(`preview 记录已存在，拒绝覆盖: ${name}`);
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return file;
}

function readPreview(root: string, kind: OutlinePreviewRecord["kind"], runId: string): OutlinePreviewRecord {
  const dir = proposalDirectory(root);
  // 按命名约定定位(run_id 是 p<base36 ts> 段, 匹配唯一)。
  // 匹配带 target(review P2-3): outline_item 的匹配含 target 段, 消除不同 target
  // 同 run_id 时宽匹配选错记录的歧义; proposalFile 对 target 的 slug 化保持 ASCII 安全。
  const dirEntries = dir === undefined ? [] : listProposalFiles(dir);
  const match =
    kind === "story_outline"
      ? dirEntries.find((n) => n === `outline-${runId}.json`)
      : dirEntries.find((n) => n.startsWith("outline-item-") && n.includes(`-${runId}.json`));
  if (dir === undefined || match === undefined) {
    throw new Error(
      `preview 记录不存在: ${kind}/${runId}。请先生成 preview(.assistant/proposals/ 下无对应记录)`,
    );
  }
  const file = guardPath(root, `${dir}/${match}`);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`preview 记录不是普通文件: ${match}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`preview 记录损坏(非 JSON): ${match}: ${(err as Error).message}`);
  }
  const record = parsed as OutlinePreviewRecord;
  if (record?.kind !== kind || record?.run_id !== runId || typeof record.result !== "object" || record.result === null) {
    throw new Error(`preview 记录形态不符: ${match}(kind/run_id/result 校验失败, fail-closed)`);
  }
  return record;
}

function listProposalFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
}

/** Author workbench read: valid ordinary outline preview files, newest first. */
export function listOutlinePreviews(root: string): OutlinePreviewRecord[] {
  const dir = proposalDirectory(root);
  if (dir === undefined) return [];
  const records: OutlinePreviewRecord[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^outline(?:-item-(?:plot_thread|outline_arc))?-.+\.json$/.test(entry.name)) continue;
    try {
      const file = guardPath(root, `${dir}/${entry.name}`);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const record = JSON.parse(readFileSync(file, "utf8")) as OutlinePreviewRecord;
      const expected = record.kind === "story_outline"
        ? `outline-${record.run_id}.json`
        : record.kind === "outline_item" && (record.target === "plot_thread" || record.target === "outline_arc")
          ? `outline-item-${record.target}-${record.run_id}.json`
          : "";
      if (
        entry.name === expected && typeof record.run_id === "string" &&
        typeof record.generated_at === "string" && record.result && typeof record.result === "object"
      ) records.push(record);
    } catch {
      // A broken machine-state record is omitted from the author read view; apply remains fail-closed.
    }
  }
  return records.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
}

function runIdOf(now: Date): string {
  // 时间戳+随机熵(M12-b review P2-3): 同毫秒并发 preview 不得同 run_id(文件静默覆盖/
  // 宽匹配歧义); 熵段 6 hex 足够单毫秒内去重。
  return `p${now.getTime().toString(36)}${randomUUID().replaceAll("-", "").slice(0, 6)}`;
}

/** 总纲 preview: 生成 → 暂存 .assistant/proposals/, 不写 structure/outline.md。 */
export async function previewStoryOutline(
  provider: Provider,
  root: string,
  input: string,
  now: Date = new Date(),
): Promise<{ ok: true; file: string; record: OutlinePreviewRecord } | { ok: false; error: StepResult["error"] }> {
  registerOutlineSpecs();
  const r = await runStep(provider, { specRef: "story_outline_generate", input });
  if (!r.ok) return { ok: false, error: r.error };
  const record: OutlinePreviewRecord = {
    kind: "story_outline",
    run_id: runIdOf(now),
    generated_at: now.toISOString(),
    input_hash: inputHash(input),
    result: r.result as Record<string, unknown>,
    ...(r.promptFingerprint !== undefined
      ? {
          prompt_fingerprint: {
            system_prompt_hash: r.promptFingerprint.systemPromptHash,
            schema_injection: r.promptFingerprint.schemaInjection,
            output_schema_hash: r.promptFingerprint.outputSchemaHash,
          },
        }
      : {}),
  };
  return { ok: true, file: writePreview(root, record), record };
}

/** Public safe path: explicit source selection + actual manifest + post-provider drift check. */
export async function previewStoryOutlineSelected(
  provider: Provider,
  root: string,
  selection: OutlineContextSelection,
  now: Date = new Date(),
): Promise<{ ok: true; file: string; record: OutlinePreviewRecord } | { ok: false; error: StepResult["error"] }> {
  registerOutlineSpecs();
  const context = buildOutlineSelectedContext(root, "story_outline", selection);
  const r = await runStep(provider, { specRef: "story_outline_generate", input: context.rendered_text });
  if (!r.ok) return { ok: false, error: r.error };
  const current = buildOutlineSelectedContext(root, "story_outline", selection);
  if (current.context_hash !== context.context_hash) throw new Error("outline selected context 在 provider 调用期间漂移");
  const record: OutlinePreviewRecord = {
    kind: "story_outline",
    run_id: runIdOf(now),
    generated_at: now.toISOString(),
    input_hash: inputHash(context.rendered_text),
    result: r.result as Record<string, unknown>,
    context_receipt: receiptOf(context),
    ...(r.promptFingerprint !== undefined
      ? { prompt_fingerprint: {
          system_prompt_hash: r.promptFingerprint.systemPromptHash,
          schema_injection: r.promptFingerprint.schemaInjection,
          output_schema_hash: r.promptFingerprint.outputSchemaHash,
        } }
      : {}),
  };
  return { ok: true, file: writePreview(root, record), record };
}

/** P20 当前层 preview: 生成 → 暂存, 不写 thread/arc 资产。 */
export async function previewOutlineItem(
  provider: Provider,
  root: string,
  target: "plot_thread" | "outline_arc",
  input: string,
  now: Date = new Date(),
): Promise<
  | { ok: true; file: string; record: OutlinePreviewRecord }
  | { ok: false; error: StepResult["error"] }
> {
  registerOutlineSpecs();
  const r = await runStep(provider, { specRef: "outline_generate", input: `【target: ${target}】\n${input}` });
  if (!r.ok) return { ok: false, error: r.error };
  const record: OutlinePreviewRecord = {
    kind: "outline_item",
    target,
    run_id: runIdOf(now),
    generated_at: now.toISOString(),
    input_hash: inputHash(input),
    result: r.result as Record<string, unknown>,
    ...(r.promptFingerprint !== undefined
      ? {
          prompt_fingerprint: {
            system_prompt_hash: r.promptFingerprint.systemPromptHash,
            schema_injection: r.promptFingerprint.schemaInjection,
            output_schema_hash: r.promptFingerprint.outputSchemaHash,
          },
        }
      : {}),
  };
  return { ok: true, file: writePreview(root, record), record };
}

export async function previewOutlineItemSelected(
  provider: Provider,
  root: string,
  target: "plot_thread" | "outline_arc",
  selection: OutlineContextSelection,
  now: Date = new Date(),
): Promise<{ ok: true; file: string; record: OutlinePreviewRecord } | { ok: false; error: StepResult["error"] }> {
  registerOutlineSpecs();
  const context = buildOutlineSelectedContext(root, "outline_item", selection);
  const input = `【target: ${target}】\n${context.rendered_text}`;
  const r = await runStep(provider, { specRef: "outline_generate", input });
  if (!r.ok) return { ok: false, error: r.error };
  const current = buildOutlineSelectedContext(root, "outline_item", selection);
  if (current.context_hash !== context.context_hash) throw new Error("outline item selected context 在 provider 调用期间漂移");
  const record: OutlinePreviewRecord = {
    kind: "outline_item",
    target,
    run_id: runIdOf(now),
    generated_at: now.toISOString(),
    input_hash: inputHash(input),
    result: r.result as Record<string, unknown>,
    context_receipt: receiptOf(context),
    ...(r.promptFingerprint !== undefined
      ? { prompt_fingerprint: {
          system_prompt_hash: r.promptFingerprint.systemPromptHash,
          schema_injection: r.promptFingerprint.schemaInjection,
          output_schema_hash: r.promptFingerprint.outputSchemaHash,
        } }
      : {}),
  };
  return { ok: true, file: writePreview(root, record), record };
}

/** apply 总纲 preview: 读暂存 → writeOutline(canonical; 调用方在审批内执行)。 */
export function applyStoryOutlinePreview(
  root: string,
  runId: string,
  opts: { workflowId?: string; override?: Record<string, unknown> } = {},
): void {
  const record = readPreview(root, "story_outline", runId);
  if (record.context_receipt) {
    assertSelectedVaultSourcesCurrent(root, record.context_receipt.source_snapshot);
  }
  // 白名单透传(review P2-4): 被编辑过的暂存不得注入任意未知 frontmatter 键/覆盖 status。
  const r = record.result;
  const allowed: Record<string, unknown> = {};
  for (const key of ["title", "creative_core", "major_storylines", "macro_movements", "open_decisions", "outline_markdown"]) {
    if (r[key] !== undefined) allowed[key] = r[key];
  }
  const merged = { ...allowed, ...(opts.override ?? {}) };
  writeOutline(root, merged, { workflowId: opts.workflowId, message: `outline: apply preview ${runId}` });
}

export function applyStoryOutlinePreviewSelected(
  root: string,
  runId: string,
  opts: { workflowId?: string; override?: Record<string, unknown> } = {},
): void {
  const record = readPreview(root, "story_outline", runId);
  if (!record.context_receipt) throw new Error(`preview ${runId} 缺 selected context receipt`);
  applyStoryOutlinePreview(root, runId, opts);
}

/** apply P20 当前层 preview: 读暂存 → writeStructureAsset(返回 slug)。 */
export function applyOutlineItemPreview(
  root: string,
  runId: string,
  opts: { workflowId?: string; override?: Record<string, unknown> } = {},
): string {
  const record = readPreview(root, "outline_item", runId);
  if (record.context_receipt) {
    assertSelectedVaultSourcesCurrent(root, record.context_receipt.source_snapshot);
  }
  if (record.target === undefined) {
    throw new Error(`preview 记录缺 target(outline_item 必填): ${runId}`);
  }
  const kind = record.target === "plot_thread" ? "thread" : "arc";
  const rawContent = record.result.content ?? record.result;
  const content = typeof rawContent === "object" && rawContent !== null ? (rawContent as Record<string, unknown>) : {};
  // 与 generateOutlineItem 同一映射(outlineItemFrontmatter), override 显式覆盖。
  const fm = { ...outlineItemFrontmatter(content), ...(opts.override ?? {}) };
  return writeStructureAsset(root, kind, fm, { workflowId: opts.workflowId });
}

export function applyOutlineItemPreviewSelected(
  root: string,
  runId: string,
  opts: { workflowId?: string; override?: Record<string, unknown> } = {},
): string {
  const record = readPreview(root, "outline_item", runId);
  if (!record.context_receipt) throw new Error(`preview ${runId} 缺 selected context receipt`);
  return applyOutlineItemPreview(root, runId, opts);
}
