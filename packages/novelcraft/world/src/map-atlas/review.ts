// world/map-atlas · 页面/节点生命周期写面(Phase 4; 计划 §4 Phase 4; spec map-atlas.md §3 状态机)。
// adopt 类(adoptAtlasPage/adoptAtlasPlaceholder/restoreAtlasPage)必经注入的 approve(fail-closed, 铁律 3);
// 所有写操作 = 前置校验 → 单 git commit; 失败零 git 残留。
// 移植: 旧引擎 service.py review_page(417-469)/_adopt_ancestors(1049-1070)/_adopt_proposed_path(1071-1140)。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { guardPath, paths } from "@novelcraft/vault";
import {
  gitAdd,
  gitCommit,
  hasUncommittedChanges,
  parseFrontmatter,
  serializeFrontmatter,
  StoreError,
} from "@novelcraft/store";
import type { ApprovalDecision } from "@novelcraft/trace";
import { readAtlasTree } from "./read.js";
import {
  ATLAS_LEVEL_RANK,
  type AtlasAnnotation,
  type AtlasNode,
  type AtlasPage,
} from "./types.js";

/** adopt 类审批回调(dsh 层接 ApprovalGate; 测试注入 allow/deny)。 */
export type AtlasApprove = (action: string, summary: string, items: string[]) => Promise<ApprovalDecision>;

// ============================================================================
// 内部: frontmatter 读写(与 write.ts 同构, 但支持移动 + 批量单 commit)
// ============================================================================

function readPageFile(file: string): AtlasPage {
  const { data } = parseFrontmatter(readFileSync(file, "utf8"));
  // 复用 read.ts 的宽松读面: 直接构造(字段与 pageFrontmatter 互逆)。
  return {
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
}

function readNodeFile(file: string): AtlasNode {
  const { data } = parseFrontmatter(readFileSync(file, "utf8"));
  return {
    id: String(data.id ?? ""),
    parent_ref: data.parent_ref == null ? null : String(data.parent_ref),
    location_ref: data.location_ref == null ? null : String(data.location_ref),
    semantic_key: String(data.semantic_key ?? ""),
    level: String(data.level ?? "world") as AtlasNode["level"],
    title: String(data.title ?? ""),
    ...(data.summary !== undefined ? { summary: String(data.summary) } : {}),
    status: String(data.status ?? "provisional") as AtlasNode["status"],
    sort_order: typeof data.sort_order === "number" ? data.sort_order : 0,
  };
}

function nodeToFile(node: AtlasNode): string {
  const fm: Record<string, unknown> = {
    id: node.id,
    parent_ref: node.parent_ref,
    location_ref: node.location_ref,
    semantic_key: node.semantic_key,
    level: node.level,
    title: node.title,
  };
  if (node.summary !== undefined) fm.summary = node.summary;
  fm.status = node.status;
  fm.sort_order = node.sort_order;
  return serializeFrontmatter(fm, `# ${node.title}\n`);
}

function pageToFile(page: AtlasPage): string {
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
  return serializeFrontmatter(fm, `# ${page.title}\n`);
}

/** 批量文本写 + 移动(写新内容后删旧路径), 最后单 commit(全部写盘成功后才 git)。 */
function commitAll(root: string, message: string, writes: Array<{ abs: string; content: string }>, moves: Array<{ from: string; to: string; content: string }>): void {
  for (const w of writes) {
    const abs = guardPath(root, w.abs); // R9: 所有落盘路径过守卫
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, w.content, "utf8");
  }
  for (const m of moves) {
    const to = guardPath(root, m.to);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, m.content, "utf8");
    if (existsSync(m.from)) unlinkSync(guardPath(root, m.from));
  }
  gitAdd(root);
  gitCommit(root, message);
}

// ============================================================================
// 前置: 页面/节点定位与校验
// ============================================================================

function findPendingPage(root: string, pageId: string): { page: AtlasPage; file: string } {
  const file = paths(root).world.atlas.pendingPageFile(pageId);
  if (!existsSync(file)) {
    throw new StoreError("NOT_FOUND", `候选页不存在: ${pageId}`);
  }
  return { page: readPageFile(file), file };
}

function findAdoptedPage(root: string, pageId: string): { page: AtlasPage; file: string } {
  const file = paths(root).world.atlas.pageFile(pageId);
  if (!existsSync(file)) {
    throw new StoreError("NOT_FOUND", `已采用页不存在: ${pageId}`);
  }
  return { page: readPageFile(file), file };
}

function assertCleanWorkspace(root: string): void {
  if (hasUncommittedChanges(root)) {
    throw new StoreError("DIRTY_WORKSPACE", "工作区存在未提交改动, 拒绝 adopt(R17/CAS)");
  }
}

function assertCas(page: AtlasPage, expectedContentHash?: string): void {
  if (expectedContentHash !== undefined && expectedContentHash !== page.content_hash) {
    throw new StoreError("CONFLICT", `content_hash 失配(期望 ${expectedContentHash}, 实际 ${page.content_hash})`);
  }
}

async function assertApproved(approve: AtlasApprove, action: string, summary: string, items: string[]): Promise<void> {
  const decision = await approve(action, summary, items);
  if (decision !== "allowed-once") {
    throw new StoreError("VALIDATION_FAILED", `${action} 审批未通过(${decision}), fail-closed`);
  }
}

/**
 * 祖先链原子 adopt(旧 _adopt_ancestors/_adopt_proposed_path):
 * 沿 parent_ref 链把 pending 节点移入 nodes/ 并置 adopted; 已 adopted 保持不变。
 * 预检: 节点存在(缺失 = 层级已变化拒)、循环检测、cover/world 无父、父 rank 严格大于子。
 * 返回 moves/写入计划(调用方单 commit)。
 */
function planAncestorAdopt(
  root: string,
  startNodeId: string,
  moves: Array<{ from: string; to: string; content: string }>,
  adoptedIds: string[],
): void {
  const p = paths(root);
  const visited = new Set<string>();
  let cursor: string | null = startNodeId;
  const chain: AtlasNode[] = [];
  while (cursor) {
    if (visited.has(cursor)) {
      throw new StoreError("VALIDATION_FAILED", `节点父链存在循环: ${cursor}`);
    }
    visited.add(cursor);
    const pendingFile = p.world.atlas.pendingNodeFile(cursor);
    const adoptedFile = p.world.atlas.nodeFile(cursor);
    if (existsSync(adoptedFile)) {
      const node = readNodeFile(adoptedFile);
      chain.push(node); // 已 adopted: 校验后保持。
      cursor = node.parent_ref;
      continue;
    }
    if (!existsSync(pendingFile)) {
      throw new StoreError("VALIDATION_FAILED", `节点 ${cursor} 不存在(层级已变化), 拒绝 adopt`);
    }
    const node = readNodeFile(pendingFile);
    chain.push(node);
    cursor = node.parent_ref;
  }
  // 链校验: cover/world 无父; 父 rank 严格大于子(沿链自叶向根)。
  const byId = new Map(chain.map((n) => [n.id, n]));
  for (const node of chain) {
    if ((node.level === "cover" || node.level === "world") && node.parent_ref) {
      throw new StoreError("VALIDATION_FAILED", `cover/world 节点不得有父: ${node.id}`);
    }
    if (node.parent_ref) {
      const parent = byId.get(node.parent_ref);
      if (parent && ATLAS_LEVEL_RANK[parent.level] <= ATLAS_LEVEL_RANK[node.level]) {
        throw new StoreError(
          "VALIDATION_FAILED",
          `父级 ${parent.id}(${parent.level}) rank 必须严格大于子级 ${node.id}(${node.level})`,
        );
      }
    }
  }
  // 生成 pending → adopted 移动计划(只移 pending 的)。
  for (const node of chain) {
    const pendingFile = p.world.atlas.pendingNodeFile(node.id);
    if (existsSync(pendingFile)) {
      const adoptedNode: AtlasNode = { ...node, status: "adopted" };
      moves.push({
        from: pendingFile,
        to: p.world.atlas.nodeFile(node.id),
        content: nodeToFile(adoptedNode),
      });
      adoptedIds.push(node.id);
    }
  }
}

// ============================================================================
// adopt / reject / archive / restore / update prompt / update node
// ============================================================================

export interface AdoptAtlasPageOptions {
  /** evidence.conflicts 非空时必须显式确认。 */
  confirmConflicts?: boolean;
  /** CAS: 期望的 page.content_hash。 */
  expectedContentHash?: string;
  note?: string;
}

/**
 * 采用候选页(计划 Phase 4; 状态机 review_ready --adopt--> adopted):
 * 前置 git 干净 + CAS + generation_status=review_ready + image.file 存在(prompt_only 拒绝, N28)
 * + conflicts 门禁 + 祖先链原子 adopt; 单 commit(图片目录永不 git add, N29)。
 */
export async function adoptAtlasPage(
  root: string,
  pageId: string,
  opts: AdoptAtlasPageOptions,
  approve: AtlasApprove,
): Promise<{ page: AtlasPage; adoptedNodeIds: string[] }> {
  assertCleanWorkspace(root);
  const { page, file } = findPendingPage(root, pageId);
  if (page.review_status !== "candidate") {
    throw new StoreError("VALIDATION_FAILED", `页 ${pageId} 非候选状态(${page.review_status})`);
  }
  assertCas(page, opts.expectedContentHash);
  if (page.generation_status !== "review_ready" || !page.image?.file) {
    throw new StoreError("VALIDATION_FAILED", `prompt_only 或无图页不能 adopt(N28): ${pageId}`);
  }
  const imageAbs = guardPath(root, path.join(paths(root).world.atlas.dir, page.image.file));
  if (!existsSync(imageAbs)) {
    throw new StoreError("VALIDATION_FAILED", `图片文件缺失(image_missing): ${page.image.file}`);
  }
  if ((page.evidence.conflicts?.length ?? 0) > 0 && opts.confirmConflicts !== true) {
    throw new StoreError("VALIDATION_FAILED", `页 ${pageId} 存在未确认 conflicts, 拒绝 adopt`);
  }
  await assertApproved(approve, "map_atlas.adopt_page", `采用地图页 ${page.title}(${pageId})`, [pageId, page.node_ref]);

  const moves: Array<{ from: string; to: string; content: string }> = [];
  const adoptedNodeIds: string[] = [];
  planAncestorAdopt(root, page.node_ref, moves, adoptedNodeIds);
  const adopted: AtlasPage = {
    ...page,
    review_status: "adopted",
    adopted_at: new Date().toISOString(),
    review_note: opts.note ?? page.review_note,
  };
  moves.push({ from: file, to: paths(root).world.atlas.pageFile(pageId), content: pageToFile(adopted) });
  commitAll(root, `atlas: adopt page ${pageId}`, [], moves);
  return { page: adopted, adoptedNodeIds };
}

/** 空页占位 adopt(计划 Phase 4): 只 adopt 候选节点(含祖先链), 不要求图片/不建 page; approval-gated; 单 commit。 */
export async function adoptAtlasPlaceholder(
  root: string,
  nodeId: string,
  approve: AtlasApprove,
): Promise<{ adoptedNodeIds: string[] }> {
  assertCleanWorkspace(root);
  const pendingFile = paths(root).world.atlas.pendingNodeFile(nodeId);
  if (!existsSync(pendingFile)) {
    throw new StoreError("NOT_FOUND", `候选节点不存在: ${nodeId}`);
  }
  await assertApproved(approve, "map_atlas.adopt_placeholder", `采用空页占位节点 ${nodeId}`, [nodeId]);
  const moves: Array<{ from: string; to: string; content: string }> = [];
  const adoptedNodeIds: string[] = [];
  planAncestorAdopt(root, nodeId, moves, adoptedNodeIds);
  commitAll(root, `atlas: adopt placeholder ${nodeId}`, [], moves);
  return { adoptedNodeIds };
}

/** 驳回候选页(review_ready → rejected 终态; prompt_only 不可驳回, 移植锚点 Phase 4; 候选面操作, 无需 approval)。 */
export function rejectAtlasPage(root: string, pageId: string, opts?: { note?: string; expectedContentHash?: string }): AtlasPage {
  const { page } = findPendingPage(root, pageId);
  if (page.review_status !== "candidate") {
    throw new StoreError("VALIDATION_FAILED", `页 ${pageId} 非候选状态(${page.review_status})`);
  }
  if (page.generation_status !== "review_ready") {
    throw new StoreError("VALIDATION_FAILED", `prompt_only 页不可驳回(无可处理图片): ${pageId}`);
  }
  assertCas(page, opts?.expectedContentHash);
  const rejected: AtlasPage = {
    ...page,
    review_status: "rejected",
    rejected_at: new Date().toISOString(),
    review_note: opts?.note ?? page.review_note,
  };
  commitAll(root, `atlas: reject page ${pageId}`, [{ abs: paths(root).world.atlas.pendingPageFile(pageId), content: pageToFile(rejected) }], []);
  return rejected;
}

/** 归档已采用页(adopted → deprecated; 历史页不硬删, 计划 Phase 4)。 */
export function archiveAtlasPage(root: string, pageId: string, opts?: { expectedContentHash?: string }): AtlasPage {
  const { page } = findAdoptedPage(root, pageId);
  if (page.review_status !== "adopted") {
    throw new StoreError("VALIDATION_FAILED", `archive 要求 adopted: ${pageId}(${page.review_status})`);
  }
  assertCas(page, opts?.expectedContentHash);
  const archived: AtlasPage = { ...page, review_status: "deprecated", deprecated_at: new Date().toISOString() };
  commitAll(root, `atlas: archive page ${pageId}`, [{ abs: paths(root).world.atlas.pageFile(pageId), content: pageToFile(archived) }], []);
  return archived;
}

/** 恢复归档页(deprecated → adopted; 重新 adopt 祖先链; approval-gated)。 */
export async function restoreAtlasPage(
  root: string,
  pageId: string,
  approve: AtlasApprove,
  opts?: { expectedContentHash?: string },
): Promise<{ page: AtlasPage; adoptedNodeIds: string[] }> {
  assertCleanWorkspace(root);
  const { page, file } = findAdoptedPage(root, pageId);
  if (page.review_status !== "deprecated") {
    throw new StoreError("VALIDATION_FAILED", `restore 要求 deprecated: ${pageId}(${page.review_status})`);
  }
  assertCas(page, opts?.expectedContentHash);
  await assertApproved(approve, "map_atlas.restore_page", `恢复地图页 ${page.title}(${pageId})`, [pageId, page.node_ref]);
  const moves: Array<{ from: string; to: string; content: string }> = [];
  const adoptedNodeIds: string[] = [];
  planAncestorAdopt(root, page.node_ref, moves, adoptedNodeIds); // 祖先补齐(缺失/pending → adopt)。
  const restored: AtlasPage = { ...page, review_status: "adopted", deprecated_at: null, adopted_at: new Date().toISOString() };
  commitAll(root, `atlas: restore page ${pageId}`, [{ abs: file, content: pageToFile(restored) }], moves);
  return { page: restored, adoptedNodeIds };
}

/** 更新 prompt(仅 prompt_only 候选页; CAS; 单 commit)。 */
export function updateAtlasPrompt(
  root: string,
  pageId: string,
  prompt: string,
  expectedContentHash?: string,
): AtlasPage {
  const { page } = findPendingPage(root, pageId);
  if (page.generation_status !== "prompt_only" || page.review_status !== "candidate") {
    throw new StoreError("VALIDATION_FAILED", `仅 prompt_only 候选页可改 prompt: ${pageId}`);
  }
  assertCas(page, expectedContentHash);
  const next: AtlasPage = { ...page, prompt };
  commitAll(root, `atlas: update prompt ${pageId}`, [{ abs: paths(root).world.atlas.pendingPageFile(pageId), content: pageToFile(next) }], []);
  return next;
}

/** 已采用节点调整(parent/level/title/sort_order; 循环与 rank 校验; 单 commit)。 */
export function updateAtlasNode(
  root: string,
  nodeId: string,
  patch: { parent_ref?: string | null; level?: AtlasNode["level"]; title?: string; sort_order?: number },
): AtlasNode {
  assertCleanWorkspace(root);
  const p = paths(root);
  const file = p.world.atlas.nodeFile(nodeId);
  if (!existsSync(file)) throw new StoreError("NOT_FOUND", `已采用节点不存在: ${nodeId}`);
  const node = readNodeFile(file);
  if (node.status !== "adopted") {
    throw new StoreError("VALIDATION_FAILED", `updateAtlasNode 仅支持已采用节点: ${nodeId}`);
  }
  const next: AtlasNode = {
    ...node,
    ...(patch.parent_ref !== undefined ? { parent_ref: patch.parent_ref } : {}),
    ...(patch.level !== undefined ? { level: patch.level } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.sort_order !== undefined ? { sort_order: patch.sort_order } : {}),
  };
  // 父引用校验(review 修): adopted 节点的父必须已 adopted 存在(spec 规则 6 祖先链原子采用)。
  if (next.parent_ref) {
    const parentFile = p.world.atlas.nodeFile(next.parent_ref);
    if (!existsSync(parentFile)) {
      throw new StoreError("VALIDATION_FAILED", `新父节点必须已 adopted 存在: ${next.parent_ref}`);
    }
  }
  // 循环校验: 沿 next 的新父链走(adopted+pending 并集), 不得回到自身。
  const tree = readAtlasTree(root);
  const byId = new Map<string, AtlasNode>(
    [...tree.nodes, ...tree.pendingNodes].map((n) => [n.id, n]),
  );
  byId.set(next.id, next);
  let cursor = next.parent_ref;
  const seen = new Set<string>([next.id]);
  while (cursor) {
    if (seen.has(cursor)) throw new StoreError("VALIDATION_FAILED", `parent 调整会产生循环: ${cursor}`);
    seen.add(cursor);
    cursor = byId.get(cursor)?.parent_ref ?? null;
  }
  // rank 校验: 父 rank > 子 rank(直接父与直接子)。
  if (next.parent_ref) {
    const parent = byId.get(next.parent_ref);
    if (parent && ATLAS_LEVEL_RANK[parent.level] <= ATLAS_LEVEL_RANK[next.level]) {
      throw new StoreError("VALIDATION_FAILED", `父 rank 必须严格大于子(${parent.level} vs ${next.level})`);
    }
  }
  for (const child of tree.nodes.filter((n) => n.parent_ref === next.id)) {
    if (ATLAS_LEVEL_RANK[next.level] <= ATLAS_LEVEL_RANK[child.level]) {
      throw new StoreError("VALIDATION_FAILED", `调整后 ${next.level} 不得低于子级 ${child.level}`);
    }
  }
  if ((next.level === "cover" || next.level === "world") && next.parent_ref) {
    throw new StoreError("VALIDATION_FAILED", "cover/world 节点不得有父");
  }
  commitAll(root, `atlas: update node ${nodeId}`, [{ abs: file, content: nodeToFile(next) }], []);
  return next;
}
