import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@novelcraft/store";
import { assertNoSymlinkOnPath, guardPath } from "@novelcraft/vault";
import {
  compileAuditableContext,
  type AuditableCompiledContext,
  type AuditableContextSource,
} from "./auditable.js";
import type { CompileOptions, ContextSection } from "./context.js";

export interface SelectedVaultSourceRule {
  tier: ContextSection["tier"];
  source_type: string;
  current_statuses: readonly string[];
  working_statuses?: readonly string[];
  default_status?: string;
  name?: string;
}

export interface VaultContextSelection {
  instruction: string;
  source_refs?: readonly string[];
  include_working_drafts?: boolean;
  budget_tokens?: number;
}

export interface SelectedSourceSnapshot {
  path: string;
  source_hash: string;
  source_status: string;
}

export interface SelectedVaultContext extends AuditableCompiledContext {
  source_snapshot: SelectedSourceSnapshot[];
}

const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function normalizedRef(ref: unknown): string {
  if (typeof ref !== "string" || !ref || ref.includes("\\") || path.posix.isAbsolute(ref) ||
      path.posix.normalize(ref) !== ref || ref.startsWith("../") || /[\u0000-\u001f\u007f-\u009f]/.test(ref)) {
    throw new Error(`source_ref 非法: ${JSON.stringify(ref)}`);
  }
  return ref;
}

export function compileSelectedVaultContext(
  root: string,
  opts: {
    task: string;
    scope: CompileOptions["scope"];
    selection: VaultContextSelection;
    classify: (ref: string) => SelectedVaultSourceRule | undefined;
  },
): SelectedVaultContext {
  if (!opts.selection || typeof opts.selection.instruction !== "string" || !opts.selection.instruction.trim()) {
    throw new Error("instruction 必填");
  }
  const refs = [...(opts.selection.source_refs ?? [])].map(normalizedRef);
  if (refs.length > 32 || new Set(refs).size !== refs.length) {
    throw new Error("source_refs 必须唯一且不超过 32 项");
  }
  const sources: AuditableContextSource[] = [{
    tier: "P0",
    name: "作者任务",
    content: opts.selection.instruction,
    source_id: "author-instruction",
    source_type: "instruction",
    source_status: "confirmed",
    open_target: { kind: "instruction" },
  }];
  const snapshot: SelectedSourceSnapshot[] = [];
  for (const ref of refs) {
    const rule = opts.classify(ref);
    if (rule === undefined) throw new Error(`source_ref 不在本任务白名单: ${ref}`);
    const file = guardPath(root, ref);
    assertNoSymlinkOnPath(root, file);
    if (!statSync(file).isFile()) throw new Error(`source_ref 不是普通文件: ${ref}`);
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) throw new Error(`source_ref 为空: ${ref}`);
    const parsed = parseFrontmatter(raw);
    const declared = parsed.data.status;
    const status = typeof declared === "string" && declared ? declared : (rule.default_status ?? "current");
    const current = rule.current_statuses.includes(status);
    const working = rule.working_statuses?.includes(status) === true;
    if (!current && !(working && opts.selection.include_working_drafts === true)) {
      throw new Error(`source_ref 状态不可用于本任务: ${ref} status=${status}`);
    }
    const sourceHash = hash(raw);
    snapshot.push({ path: ref, source_hash: sourceHash, source_status: status });
    sources.push({
      tier: rule.tier,
      name: rule.name ?? ref,
      content: raw,
      source_id: `vault:${ref}`,
      source_type: rule.source_type,
      source_status: status,
      open_target: { path: ref },
    });
  }
  const compiled = compileAuditableContext(
    {
      task: opts.task,
      scope: opts.scope,
      ...(opts.selection.budget_tokens !== undefined
        ? { budget_tokens: opts.selection.budget_tokens }
        : {}),
    },
    { sources },
  );
  if (!compiled.source_manifest.some((source) => source.source_id === "author-instruction")) {
    throw new Error("context budget 无法容纳作者任务");
  }
  return { ...compiled, source_snapshot: snapshot };
}

export function assertSelectedVaultSourcesCurrent(
  root: string,
  snapshot: readonly SelectedSourceSnapshot[],
): void {
  for (const source of snapshot) {
    const ref = normalizedRef(source.path);
    const file = guardPath(root, ref);
    assertNoSymlinkOnPath(root, file);
    if (!statSync(file).isFile() || hash(readFileSync(file, "utf8")) !== source.source_hash) {
      throw new Error(`selected source 已漂移: ${ref}`);
    }
  }
}
