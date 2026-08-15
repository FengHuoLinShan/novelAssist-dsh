// world/map-atlas · 可移动文字标注 CRUD(Phase 4; spec map-atlas.md §2.2 annotations; 移植 service.py update_annotation 471-511)。
// 校验: label 非空、坐标 0–1、target_node_ref 仅可指向已 adopted 节点;
// 更新后重算 page content_hash; 单 commit。标注页可为候选或已采用页(非 rejected/deprecated)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { guardPath, paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, parseFrontmatter, serializeFrontmatter, StoreError } from "@novelcraft/store";
import { readAtlasTree } from "./read.js";
import { computeAtlasPageContentHash } from "./write.js";
import type { AtlasAnnotation, AtlasPage } from "./types.js";

/** 坐标 0–1 闭区间(spec §2.2)。 */
function assertCoord(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new StoreError("VALIDATION_FAILED", `${name} 必须在 0–1 闭区间(实际 ${value})`);
  }
}

function validateAnnotation(root: string, input: { label?: string; position_x?: number; position_y?: number; target_node_ref?: string | null }): void {
  if (input.label !== undefined && input.label.trim().length === 0) {
    throw new StoreError("VALIDATION_FAILED", "annotation label 必填且非空");
  }
  if (input.position_x !== undefined) assertCoord(input.position_x, "position_x");
  if (input.position_y !== undefined) assertCoord(input.position_y, "position_y");
  // target 仅可指向已 adopted 节点(移植: 旧引擎 target 必须指向有 adopted page 的节点)。
  if (input.target_node_ref !== undefined && input.target_node_ref !== null) {
    const tree = readAtlasTree(root);
    const target = tree.nodes.find((n) => n.id === input.target_node_ref);
    if (!target || target.status !== "adopted") {
      throw new StoreError("VALIDATION_FAILED", `annotation target 必须是已 adopted 节点: ${input.target_node_ref}`);
    }
  }
}

function loadPageFile(root: string, pageId: string): { page: AtlasPage; file: string } {
  const pending = paths(root).world.atlas.pendingPageFile(pageId);
  const adopted = paths(root).world.atlas.pageFile(pageId);
  const file = existsSync(pending) ? pending : existsSync(adopted) ? adopted : null;
  if (!file) throw new StoreError("NOT_FOUND", `地图页不存在: ${pageId}`);
  const { data } = parseFrontmatter(readFileSync(file, "utf8"));
  const page: AtlasPage = {
    id: String(data.id ?? ""),
    run_ref: String(data.run_ref ?? ""),
    node_ref: String(data.node_ref ?? ""),
    ...(data.generation_choice === "upload" ? { generation_choice: "upload" as const } : {}),
    generation_status: String(data.generation_status ?? "prompt_only") as AtlasPage["generation_status"],
    review_status: String(data.review_status ?? "candidate") as AtlasPage["review_status"],
    title: String(data.title ?? ""),
    visual_brief: String(data.visual_brief ?? ""),
    prompt: String(data.prompt ?? ""),
    ...(data.image && typeof data.image === "object" ? { image: data.image as AtlasPage["image"] } : {}),
    evidence: (data.evidence as AtlasPage["evidence"]) ?? { supported: [], visual_fill: [], conflicts: [] },
    source_manifest: Array.isArray(data.source_manifest) ? (data.source_manifest as AtlasPage["source_manifest"]) : [],
    annotations: Array.isArray(data.annotations) ? (data.annotations as AtlasAnnotation[]) : [],
    review_note: (data.review_note as string | null) ?? null,
    adopted_at: (data.adopted_at as string | null) ?? null,
    rejected_at: (data.rejected_at as string | null) ?? null,
    deprecated_at: (data.deprecated_at as string | null) ?? null,
    content_hash: String(data.content_hash ?? ""),
  };
  return { page, file };
}

function writePageCommit(root: string, file: string, page: AtlasPage, message: string): void {
  const fm: Record<string, unknown> = {
    id: page.id,
    run_ref: page.run_ref,
    node_ref: page.node_ref,
  };
  if (page.generation_choice === "upload") fm.generation_choice = page.generation_choice;
  fm.generation_status = page.generation_status;
  fm.review_status = page.review_status;
  fm.title = page.title;
  fm.visual_brief = page.visual_brief;
  fm.prompt = page.prompt;
  if (page.image) fm.image = page.image;
  fm.evidence = page.evidence;
  fm.source_manifest = page.source_manifest;
  fm.annotations = page.annotations;
  fm.review_note = page.review_note;
  fm.adopted_at = page.adopted_at;
  fm.rejected_at = page.rejected_at;
  fm.deprecated_at = page.deprecated_at;
  fm.content_hash = page.content_hash;
  const abs = guardPath(root, file); // R9
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, serializeFrontmatter(fm, `# ${page.title}\n`), "utf8");
  gitAdd(root);
  gitCommit(root, message);
}

function assertAnnotatable(page: AtlasPage): void {
  if (page.review_status === "rejected" || page.review_status === "deprecated") {
    throw new StoreError("VALIDATION_FAILED", `${page.review_status} 页不可标注(历史页只读)`);
  }
}

/** 新增标注(返回新 annotation id)。 */
export function addAtlasAnnotation(
  root: string,
  pageId: string,
  input: { label: string; position_x: number; position_y: number; target_node_ref?: string | null },
): string {
  const { page, file } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  validateAnnotation(root, input);
  const id = `ann-${randomBytes(4).toString("hex")}`;
  const annotation: AtlasAnnotation = {
    id,
    label: input.label.trim(),
    position_x: input.position_x,
    position_y: input.position_y,
    sort_order: page.annotations.length,
    ...(input.target_node_ref != null ? { target_node_ref: input.target_node_ref } : {}),
  };
  const base: Omit<AtlasPage, "content_hash"> = { ...page, annotations: [...page.annotations, annotation] };
  const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
  writePageCommit(root, file, next, `atlas: add annotation ${pageId}#${id}`);
  return id;
}

/** 更新标注(label/坐标/target)。 */
export function updateAtlasAnnotation(
  root: string,
  pageId: string,
  annotationId: string,
  patch: { label?: string; position_x?: number; position_y?: number; target_node_ref?: string | null },
): AtlasAnnotation {
  const { page, file } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  const found = page.annotations.find((a) => a.id === annotationId);
  if (!found) throw new StoreError("NOT_FOUND", `标注不存在: ${annotationId}`);
  validateAnnotation(root, patch);
  const nextAnn: AtlasAnnotation = {
    ...found,
    ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
    ...(patch.position_x !== undefined ? { position_x: patch.position_x } : {}),
    ...(patch.position_y !== undefined ? { position_y: patch.position_y } : {}),
    ...(patch.target_node_ref !== undefined
      ? patch.target_node_ref === null
        ? { target_node_ref: undefined } // null = 清除指向
        : { target_node_ref: patch.target_node_ref }
      : {}),
  };
  const base: Omit<AtlasPage, "content_hash"> = {
    ...page,
    annotations: page.annotations.map((a) => (a.id === annotationId ? nextAnn : a)),
  };
  const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
  writePageCommit(root, file, next, `atlas: update annotation ${pageId}#${annotationId}`);
  return nextAnn;
}

/** 删除标注。 */
export function deleteAtlasAnnotation(root: string, pageId: string, annotationId: string): void {
  const { page, file } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  if (!page.annotations.some((a) => a.id === annotationId)) {
    throw new StoreError("NOT_FOUND", `标注不存在: ${annotationId}`);
  }
  const base: Omit<AtlasPage, "content_hash"> = {
    ...page,
    annotations: page.annotations.filter((a) => a.id !== annotationId),
  };
  const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
  writePageCommit(root, file, next, `atlas: delete annotation ${pageId}#${annotationId}`);
}
