// imports · Scene 正式提交(imports.md「Scene 正式提交」)。
// provenance_key 幂等(sha256 与来源顺序无关)、span/锚点冲突 fail-closed、
// narrative_tag 归一(R61: imported→draft, 截断 32)。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, parseFrontmatter, StoreError, validateFrontmatter } from "@novelcraft/store";
import type { SceneCandidate } from "./stages.js";

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
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(`${dir}/${f}`, "utf8");
      const { data } = parseFrontmatter(raw);
      return { slug: f.replace(/\.md$/, ""), fm: data as Record<string, unknown> };
    });
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

/** 提交候选: 同 provenance_key 非 deprecated → skip; deprecated → conflict;
 *  同章同 start_anchor 已存在 → conflict fail-closed; 否则 create(status=draft)+commit。 */
export function commitScenes(
  root: string,
  candidates: SceneCandidate[],
  opts: { workflowId: string },
): CommitResult {
  const existing = listExistingScenes(root);
  const byKey = new Map(existing.filter((e) => e.fm.status !== "deprecated").map((e) => [String(e.fm.provenance_key), e]));
  const anchorMap = new Map<string, string>(); // `${chapter}:${anchor}` → slug
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

  const result: CommitResult = { created: [], skipped: [], conflicts: [], fallbacks: 0 };
  let nextIndex = existing.length + 1;

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
    const deprecated = existing.find((e) => e.fm.provenance_key === key && e.fm.status === "deprecated");
    if (deprecated) {
      result.conflicts.push(c.candidate_id);
      continue;
    }
    const anchor = c.payload.start_anchor;
    const chapter = c.source_chapter_indices[0];
    if (anchor && chapter !== undefined && anchorMap.has(`${chapter}:${anchor}`)) {
      result.conflicts.push(`${c.candidate_id}(锚点冲突)`);
      continue;
    }
    const slug = slugifyId(nextIndex++);
    const file = paths(root).scenes.sceneFile(slug);
    const contentHash = createHash("sha256")
      .update(JSON.stringify(c.payload))
      .digest("hex");
    const fm = buildSceneFm(c, nextIndex - 1, opts.workflowId, contentHash);
    // N23(用户裁定): scene 落盘前按 'scene' schema 校验最终 fm(B3 已补 scene_index/source/narrative_tag),
    // 失败 fail-closed 不写字、不进 git commit(校验先于 writeFileSync)。
    const issues = validateFrontmatter("scene", fm);
    if (issues.length > 0) {
      const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      throw new StoreError("VALIDATION_FAILED", `scene ${slug} frontmatter 校验失败: ${detail}`, issues);
    }
    writeFileSync(file, serializeFm(fm) + "\n", "utf8");
    result.created.push(slug);
  }

  if (result.created.length > 0 || result.fallbacks > 0) {
    gitAdd(root);
    gitCommit(root, `deep-import scenes commit: +${result.created.length} scenes`);
  }
  return result;
}
