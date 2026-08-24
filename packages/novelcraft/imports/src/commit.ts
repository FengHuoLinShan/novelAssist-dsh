// imports · Scene 正式提交(imports.md「Scene 正式提交」)。
// provenance_key 幂等(sha256 与来源顺序无关)、span/锚点冲突 fail-closed、
// narrative_tag 归一(R61: imported→draft, 截断 32)。
// 批量安全(已证实覆盖修复): 整批 provenance/锚点/目标文件冲突 + frontmatter 校验
// 全部先于任何 write; scene id 按现存合法 scene_index/slug 最大值+1(不复用空洞);
// 同批重复 provenance/锚点不产生两份; 目标文件已存在绝不覆盖; 写前范围外脏工作区
// 抛 DIRTY_WORKSPACE(R17); gitAdd 传本批精确相对文件(不 -A 扫入无关改动)。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, parseFrontmatter, StoreError, validateFrontmatter } from "@novelcraft/store";
import { executeCanonicalWrite, type TransactionOptions } from "@novelcraft/store";
import type { SceneCandidate } from "./stages.js";
import { assertImportWorkspaceClean } from "./workspace.js";

export interface CommitResult {
  created: string[];
  skipped: string[];
  conflicts: string[];
  fallbacks: number;
}

/** 幂等键(imports.md: sha256(workflow_id, candidate_id, source_candidate_ids 排序,
 *  fusion_operation, source_chapter_indices 排序), 与来源顺序无关)。 */
export function provenanceKey(input: {
  workflowId: string;
  candidateId: string;
  sourceCandidateIds: string[];
  operation: string;
  sourceChapterIndices: number[];
}): string {
  const payload = JSON.stringify([
    input.workflowId,
    input.candidateId,
    [...input.sourceCandidateIds].sort(),
    input.operation,
    [...input.sourceChapterIndices].sort((a, b) => a - b),
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/** narrative_tag 归一(R61): imported→draft; 截断 32; 非法→draft。 */
export function normalizeNarrativeTag(tag: string | undefined): string {
  const base = tag === "imported" ? "draft" : (tag ?? "draft");
  return base.slice(0, 32) || "draft";
}

function slugifyId(sceneIndex: number): string {
  return `s${String(sceneIndex).padStart(3, "0")}`;
}

interface ExistingScene {
  slug: string;
  fm: Record<string, unknown>;
}

function listExistingScenes(root: string): ExistingScene[] {
  const dir = paths(root).scenes.dir;
  if (!existsSync(dir)) return [];
  // R9(目录枚举扫描): 只接收 .md 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .map((f) => {
      const raw = readFileSync(`${dir}/${f}`, "utf8");
      const { data } = parseFrontmatter(raw);
      return { slug: f.replace(/\.md$/, ""), fm: data as Record<string, unknown> };
    });
}

/**
 * 现存合法 scene_index / sNNN slug 的最大值 + 1(已证实覆盖修复: 不再用
 * existing.length+1 —— 空洞/软删下会复用已存在 slug 并 writeFileSync 覆盖)。
 * 非法/缺失 scene_index 忽略; 所有现存 slug 数字(含 deprecated)计入, 复不复用。
 */
function nextSceneIndex(existing: ExistingScene[]): number {
  let max = 0;
  for (const e of existing) {
    const si = typeof e.fm.scene_index === "number" ? e.fm.scene_index : Number(e.fm.scene_index);
    if (Number.isInteger(si) && si >= 1) max = Math.max(max, si);
    const m = /^s(\d+)$/.exec(e.slug);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n)) max = Math.max(max, n);
    }
  }
  return max + 1;
}

function buildSceneFm(c: SceneCandidate, index: number, workflowId: string, contentHash: string): Record<string, unknown> {
  const key = provenanceKey({
    workflowId,
    candidateId: c.candidate_id,
    sourceCandidateIds: c.source_candidate_ids,
    operation: c.operation,
    sourceChapterIndices: c.source_chapter_indices,
  });
  const fm: Record<string, unknown> = {
    id: slugifyId(index),
    status: "draft",
    // B3 必填补齐(frontmatter.ts:436): scene required=id/status/scene_index/narrative_tag/source。
    scene_index: index, // 序贯整数, 与 id(slug 数字)同源
    source: "deep_import", // 深度导入写点语义(imports.md; source 枚举见 specs/assets/outline.md:586)
    chapter_ids: c.source_chapter_indices,
    title: c.payload.title,
    narrative_tag: normalizeNarrativeTag(c.payload.narrative_tag),
    content_hash: contentHash,
    provenance_key: key,
    workflow: workflowId,
  };
  if (c.payload.goal) fm.goal = c.payload.goal;
  if (c.payload.core_conflict) fm.core_conflict = c.payload.core_conflict;
  if (c.payload.emotional_beat) fm.emotional_beat = c.payload.emotional_beat;
  if (c.payload.must_happen) fm.must_happen = c.payload.must_happen;
  if (c.payload.must_not_happen) fm.must_not_happen = c.payload.must_not_happen;
  if (c.needs_review) {
    fm.needs_review = true;
    fm.review_reason = c.review_reason;
  }
  if (c.fallback_required) fm.fallback_required = true;
  return fm;
}

function serializeFm(fm: Record<string, unknown>): string {
  const lines = ["---", ...Object.entries(fm).map(([k, v]) => scalar(k, v)), "---", ""];
  return lines.join("\n");
}

function scalar(key: string, v: unknown): string {
  if (typeof v === "string") return `${key}: ${JSON.stringify(v)}`;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x === "number")) return `${key}: [${v.join(", ")}]`;
    return `${key}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`;
  }
  return `${key}: ${JSON.stringify(v)}`;
}

interface PlannedScene {
  slug: string;
  file: string;
  key: string;
  fm: Record<string, unknown>;
}

/**
 * Scene 提交计划的单个写目标(N33 durable driver 用; 纯计划, 不落盘):
 * relativePath = vault 相对 POSIX 路径(scenes/<slug>.md); bytes = 最终文件字节;
 * expected = 生成时钉定的期望状态(Scene 目标必须 absent —— 已存在绝不覆盖)。
 */
export interface SceneCommitFile {
  readonly relativePath: string;
  readonly bytes: string;
  readonly expected: { readonly absent: boolean; readonly sha256: string };
}

/** 纯计划 seam(N33/ADR-0022 §6): 只读快照 + 内存计算最终 Scene 写集, 零文件写。 */
export interface SceneCommitPlan {
  readonly files: readonly SceneCommitFile[];
  readonly created: string[];
  readonly skipped: string[];
  readonly conflicts: string[];
  readonly fallbacks: number;
}

/**
 * 纯 Scene 提交计划(N33 durable driver 的 pure generation seam; 零写入):
 * - provenance: 现存非 deprecated 同 key → skip; 仅 deprecated → conflict;
 *   本批内重复 provenance(同候选重复入参)→ 只落一份, 其余 skip;
 * - 锚点: 现存同章同 start_anchor 或本批已认领 → conflict fail-closed(不生成两份);
 * - 目标文件: 现存 slug / 本批已认领 slug → conflict, 绝不覆盖;
 * - 校验: 全部候选的最终 fm 先按 'scene' schema 校验(N23), 任一项失败 → 整批零写入;
 * - 返回 files(相对路径 + 最终字节 + expected absent)——adopt 落盘由调用方
 *   (runDeepImport 的 commitScenes 或 durable driver 的 RunApplyPort)执行。
 */
export function planSceneCommit(
  root: string,
  candidates: SceneCandidate[],
  opts: { workflowId: string },
): SceneCommitPlan {
  const existing = listExistingScenes(root);
  const result: { created: string[]; skipped: string[]; conflicts: string[]; fallbacks: number }
    = { created: [], skipped: [], conflicts: [], fallbacks: 0 };

  const byKey = new Map<string, ExistingScene>(
    existing.filter((e) => e.fm.status !== "deprecated" && !!e.fm.provenance_key)
      .map((e) => [String(e.fm.provenance_key), e]),
  );
  const deprecatedKeys = new Set(
    existing.filter((e) => e.fm.status === "deprecated" && !!e.fm.provenance_key)
      .map((e) => String(e.fm.provenance_key)),
  );
  const anchorMap = new Map<string, string>(); // `${chapter}:${anchor}` → slug(现存活锚点)
  for (const e of existing) {
    const chapters = (e.fm.chapter_ids as number[]) ?? [];
    const chunks = (e.fm.scene_chunks as Array<Record<string, unknown>>) ?? [];
    for (const ch of chapters) {
      for (const ck of chunks) {
        const anchor = String(ck.anchor_hash ?? ck.anchor_excerpt ?? "");
        if (anchor) anchorMap.set(`${ch}:${anchor}`, e.slug);
      }
    }
  }
  const existingSlugs = new Set(existing.map((e) => e.slug));

  let nextIndex = nextSceneIndex(existing);
  const planned: PlannedScene[] = [];
  const claimedAnchors = new Set<string>(); // 本批已认领 `${chapter}:${anchor}`
  const claimedSlugs = new Set<string>(); // 本批已认领目标 slug
  const seenKeys = new Set<string>(); // 本批已见 provenance key

  for (const c of candidates) {
    if (c.fallback_required) result.fallbacks += 1;
    const key = provenanceKey({
      workflowId: opts.workflowId,
      candidateId: c.candidate_id,
      sourceCandidateIds: c.source_candidate_ids,
      operation: c.operation,
      sourceChapterIndices: c.source_chapter_indices,
    });
    if (byKey.has(key)) {
      result.skipped.push(c.candidate_id);
      continue;
    }
    if (deprecatedKeys.has(key)) {
      result.conflicts.push(c.candidate_id);
      continue;
    }
    if (seenKeys.has(key)) {
      // 同批重复 provenance(同候选重复入参)→ 只落一份, 不生成两份。
      result.skipped.push(c.candidate_id);
      continue;
    }
    seenKeys.add(key);

    const anchor = c.payload.start_anchor;
    const chapter = c.source_chapter_indices[0];
    const anchorKey = anchor && chapter !== undefined ? `${chapter}:${anchor}` : "";
    if (anchorKey && (anchorMap.has(anchorKey) || claimedAnchors.has(anchorKey))) {
      result.conflicts.push(`${c.candidate_id}(锚点冲突)`);
      continue;
    }
    if (anchorKey) claimedAnchors.add(anchorKey);

    const slug = slugifyId(nextIndex);
    const file = paths(root).scenes.sceneFile(slug);
    // 目标存在绝不覆盖(现存 slug 或本批已认领)。
    if (existingSlugs.has(slug) || claimedSlugs.has(slug)) {
      result.conflicts.push(`${c.candidate_id}(目标文件已存在: ${slug})`);
      continue;
    }
    claimedSlugs.add(slug);
    const contentHash = createHash("sha256")
      .update(JSON.stringify(c.payload))
      .digest("hex");
    planned.push({ slug, file, key, fm: buildSceneFm(c, nextIndex, opts.workflowId, contentHash) });
    nextIndex += 1;
  }

  // === 整批 frontmatter 校验(N23): 任一项失败 → 抛错且零写入(不产生部分文件)。 ===
  for (const p of planned) {
    const issues = validateFrontmatter("scene", p.fm);
    if (issues.length > 0) {
      const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      throw new StoreError("VALIDATION_FAILED", `scene ${p.slug} frontmatter 校验失败: ${detail}`, issues);
    }
  }

  // === 计划输出(此时 provenance/锚点/目标文件/校验已全部通过; 零文件写)。 ===
  const files: SceneCommitFile[] = planned.map((p) => ({
    relativePath: `scenes/${p.slug}.md`,
    bytes: serializeFm(p.fm) + "\n",
    expected: { absent: true, sha256: "" }, // 目标必须 absent(绝不覆盖)
  }));
  return {
    files,
    created: planned.map((p) => p.slug),
    skipped: result.skipped,
    conflicts: result.conflicts,
    fallbacks: result.fallbacks,
  };
}

/**
 * 提交候选(整批原子校验 + 批量写入; 语义与 planSceneCommit 一致):
 * - 写前门禁: 范围外脏工作区 → DIRTY_WORKSPACE(R17);
 * - gitAdd 只传本批精确相对文件, 且仅有 created 时 commit。
 */
export function commitScenes(
  root: string,
  candidates: SceneCandidate[],
  opts: { workflowId: string },
): CommitResult {
  // R17: 写前范围外脏工作区拒绝(imports 自身工件除外)。
  assertImportWorkspaceClean(root);
  const plan = planSceneCommit(root, candidates, opts);

  // === 写(plan 已全量校验; 目标已确认 absent, 不覆盖)。 ===
  const relPaths: string[] = [];
  for (const f of plan.files) {
    writeFileSync(path.join(root, f.relativePath), f.bytes, "utf8");
    relPaths.push(f.relativePath);
  }
  const result: CommitResult = {
    created: [...plan.created],
    skipped: [...plan.skipped],
    conflicts: [...plan.conflicts],
    fallbacks: plan.fallbacks,
  };

  if (result.created.length > 0) {
    // gitAdd 传本批精确相对文件(不 -A 扫入无关改动)。
    gitAdd(root, relPaths);
    gitCommit(root, `deep-import scenes commit: +${result.created.length} scenes`);
  }
  return result;
}

/**
 * N32 事务版 Scene 提交(加法导出; 深导编排的主路径): 同 R17 门禁 + 整批校验,
 * 写入走 executeCanonicalWrite(创建写: current=null, output=整文件字节)——
 * 整批单事务原子提交, 中途异常/崩溃零部分写入(durable intent 收敛回滚)。
 * 同步版保留为兼容面。
 */
export async function commitScenesTx(
  root: string,
  candidates: SceneCandidate[],
  opts: { workflowId: string; tx?: TransactionOptions },
): Promise<CommitResult> {
  // R17: 写前范围外脏工作区拒绝(imports 自身工件除外)。
  assertImportWorkspaceClean(root);
  const plan = planSceneCommit(root, candidates, opts);
  const result: CommitResult = {
    created: [...plan.created],
    skipped: [...plan.skipped],
    conflicts: [...plan.conflicts],
    fallbacks: plan.fallbacks,
  };
  if (result.created.length > 0) {
    await executeCanonicalWrite(
      root,
      plan.files.map((f) => ({ path: f.relativePath, current: null, output: f.bytes })),
      {
        purpose: `deep-import scenes commit: +${result.created.length} scenes`,
        ...(opts.tx !== undefined ? { tx: opts.tx } : {}),
      },
    );
  }
  return result;
}