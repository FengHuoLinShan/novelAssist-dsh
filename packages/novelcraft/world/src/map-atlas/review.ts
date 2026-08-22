// world/map-atlas · 页面/节点生命周期写面(Phase 4; 计划 §4 Phase 4; spec map-atlas.md §3 状态机)。
// adopt 类(adoptAtlasPage/adoptAtlasPlaceholder/restoreAtlasPage)必经注入的 approve(fail-closed, 铁律 3)。
//
// N32/ADR-0021 P1: 全部生命周期写面不再直接 writeFileSync + gitAdd + gitCommit, 改为
// @novelcraft/store.executeCanonicalWrite(kind='canonical'):
//   - 任何首写前(审批前)构造**完整确定性 writeSet**(页面/节点移动 = 新路径建 + 旧路径删;
//     祖先链 = 逐节点 move; 日志/状态 = 目标更新), expected = 计划/审批时刻读到的最新字节
//     sha256, output = 落盘字节; 审批后**不重新读取/不刷新基线**(ADR §4 背景 4 / N32);
//   - 内容哈希 CAS / stale baseline / 任何预存 staged(STAGED_CONFLICT)/ 崩溃后 durable
//     intent 条件回滚由事务层承接; writeSet 外无关 unstaged/untracked 允许(ADR §1);
//   - 图片字节永不进事务 writeSet(N29)。
// 移植: 旧引擎 service.py review_page(417-469)/_adopt_ancestors(1049-1070)/_adopt_proposed_path(1071-1140)。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { guardPath, paths } from "@novelcraft/vault";
import {
  executeCanonicalWrite,
  gitHead,
  parseFrontmatter,
  serializeFrontmatter,
  StoreError,
  type TransactionOptions,
  type TxLocalTarget,
} from "@novelcraft/store";
import type { ApprovalDecision } from "@novelcraft/trace";
import { readAtlasTree } from "./read.js";
import { computeAtlasPageContentHash } from "./write.js";
import {
  ATLAS_LEVEL_RANK,
  type AtlasAnnotation,
  type AtlasNode,
  type AtlasPage,
} from "./types.js";

/** adopt 类审批回调(dsh 层接 ApprovalGate; 测试注入 allow/deny)。 */
export type AtlasApprove = (action: string, summary: string, items: string[]) => Promise<ApprovalDecision>;

// ============================================================================
// 内部: frontmatter 读写(计划时刻读字节 → 计划输出, 不经 git; 事务统一落盘)
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

/** 计划输出目标(R9): guardPath + vault 根级逐段 symlink 检查(防 temp+rename 写穿内部
 * symlink); 相对 vault 根的 POSIX 路径由事务执行器归一化。 */
function planWriteTarget(root: string, abs: string, content: string, currentBytes: string | null): TxLocalTarget {
  const g = guardPath(root, abs);
  const rel = path.relative(path.resolve(root), g).split(path.sep).join("/");
  return { path: rel, current: currentBytes, output: content };
}

// ============================================================================
// 前置: 页面/节点定位与校验
// ============================================================================

function findPendingPage(root: string, pageId: string): { page: AtlasPage; file: string; bytes: string } {
  const file = paths(root).world.atlas.pendingPageFile(pageId);
  if (!existsSync(file)) {
    throw new StoreError("NOT_FOUND", `候选页不存在: ${pageId}`);
  }
  return { page: readPageFile(file), file, bytes: readFileSync(file, "utf8") };
}

function findAdoptedPage(root: string, pageId: string): { page: AtlasPage; file: string; bytes: string } {
  const file = paths(root).world.atlas.pageFile(pageId);
  if (!existsSync(file)) {
    throw new StoreError("NOT_FOUND", `已采用页不存在: ${pageId}`);
  }
  return { page: readPageFile(file), file, bytes: readFileSync(file, "utf8") };
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
 * 候选页 adopt 前置门禁(审批前运行, 产出审批摘要 + 强制 CAS 基线; 审批后不重读)。
 * 返回最新快照; 与旧 findCandidatePage 语义一致(R17/CAS: 审批期间并发修改由事务
 * expected 字节 CAS 在 preflight 拒绝)。
 */
function findCandidatePage(root: string, pageId: string, opts: AdoptAtlasPageOptions): { page: AtlasPage; file: string; bytes: string } {
  const { page, file, bytes } = findPendingPage(root, pageId);
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
  return { page, file, bytes };
}

/** restore 前置: adopted 目录下 deprecated 页 + CAS(审批前运行; 审批后不重读)。 */
function findDeprecatedPage(root: string, pageId: string, expectedContentHash?: string): { page: AtlasPage; file: string; bytes: string } {
  const { page, file, bytes } = findAdoptedPage(root, pageId);
  if (page.review_status !== "deprecated") {
    throw new StoreError("VALIDATION_FAILED", `restore 要求 deprecated: ${pageId}(${page.review_status})`);
  }
  assertCas(page, expectedContentHash);
  return { page, file, bytes };
}

/** 占位 adopt 前置: 候选节点存在且仍 provisional(审批前运行; 审批后不重读)。 */
function assertPendingNodePreflight(root: string, nodeId: string): void {
  const pendingFile = paths(root).world.atlas.pendingNodeFile(nodeId);
  if (!existsSync(pendingFile)) {
    throw new StoreError("NOT_FOUND", `候选节点不存在: ${nodeId}`);
  }
  const node = readNodeFile(pendingFile);
  if (node.status !== "provisional") {
    throw new StoreError("VALIDATION_FAILED", `节点 ${nodeId} 非 provisional 状态(${node.status}), 拒绝 adopt`);
  }
}

/**
 * 祖先链原子 adopt 写面计划(旧 _adopt_ancestors/_adopt_proposed_path):
 * 沿 parent_ref 链把 pending 节点移入 nodes/ 并置 adopted; 已 adopted 保持不变。
 * 预检: 节点存在(缺失 = 层级已变化拒)、循环检测、cover/world 无父、父 rank 严格大于子。
 * **审批前**把每一 pending 节点的「删除源 + 新建目标」写入 targets(字节 CAS 基线封存),
 * 返回被 adopt 的节点 id 列表; 审批后不重读、直接执行事务(N32/ADR-0021 §4)。
 */
function planAncestorAdopt(root: string, startNodeId: string, targets: TxLocalTarget[]): string[] {
  const p = paths(root);
  const visited = new Set<string>();
  const adoptedIds: string[] = [];
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
  // 生成 pending → adopted 移动计划(只移 pending 的; not txn 直接写, 由事务统一落盘)。
  for (const node of chain) {
    const pendingFile = p.world.atlas.pendingNodeFile(node.id);
    if (existsSync(pendingFile)) {
      const bytes = readFileSync(pendingFile, "utf8"); // 审批/计划时刻字节(字节 CAS 基线)。
      const adoptedNode: AtlasNode = { ...node, status: "adopted" };
      targets.push(planWriteTarget(root, p.world.atlas.nodeFile(node.id), nodeToFile(adoptedNode), null));
      targets.push({ path: relOfRoot(root, pendingFile), current: bytes, output: undefined });
      adoptedIds.push(node.id);
    }
  }
  return adoptedIds;
}

/** 相对 vault 根的 POSIX 路径(事务 writeSet 路径形态)。 */
function relOfRoot(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join("/");
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
  /** N32 内部测试 seam: 执行器选项透传。 */
  tx?: TransactionOptions;
}

/**
 * 采用候选页(计划 Phase 4; 状态机 review_ready --adopt--> adopted):
 * 前置 git 干净 + CAS + generation_status=review_ready + image.file 存在(prompt_only 拒绝, N28)
 * + conflicts 门禁 + 祖先链原子 adopt; canonical 事务单 commit(图片目录永不 enter writeSet, N29)。
 */
export async function adoptAtlasPage(
  root: string,
  pageId: string,
  opts: AdoptAtlasPageOptions,
  approve: AtlasApprove,
): Promise<{ page: AtlasPage; adoptedNodeIds: string[] }> {
  // ═══ 审批前(计划时刻): 全量读取 + CAS + 祖先链移动计划 → 完整确定性 writeSet ═══
  const pre = findCandidatePage(root, pageId, opts); // 审批摘要 + 强制 CAS 基线(不重读)。
  const snapHead = gitHead(root); // 封闭生成→审批→事务启动窗口(ADR §4 背景 4)。
  const targets: TxLocalTarget[] = [];
  const adoptedNodeIds: string[] = [];
  adoptedNodeIds.push(...planAncestorAdopt(root, pre.page.node_ref, targets)); // 祖先链 + 节点 CAS 封存。
  const adopted: AtlasPage = {
    ...pre.page,
    review_status: "adopted",
    adopted_at: new Date().toISOString(),
    review_note: opts.note ?? pre.page.review_note,
  };
  // 页面移动: 新路径建 + 候选路径删(move 语义, git D+A)。
  targets.push(planWriteTarget(root, paths(root).world.atlas.pageFile(pageId), pageToFile(adopted), null));
  targets.push({ path: relOfRoot(root, pre.file), current: pre.bytes, output: undefined });
  // ═══ 审批(审批后不重读、不刷新基线; 事务 preflight 字节 CAS 承接审批窗口竞争) ═══
  await assertApproved(approve, "map_atlas.adopt_page", `采用地图页 ${pre.page.title}(${pageId})`, [pageId, pre.page.node_ref]);
  await executeCanonicalWrite(root, targets, { purpose: `atlas: adopt page ${pageId}`, expectedHead: snapHead, ...(opts.tx ? { tx: opts.tx } : {}) });
  return { page: adopted, adoptedNodeIds };
}

/** 空页占位 adopt(计划 Phase 4): 只 adopt 候选节点(含祖先链), 不要求图片/不建 page; approval-gated。 */
export async function adoptAtlasPlaceholder(
  root: string,
  nodeId: string,
  approve: AtlasApprove,
  opts: { tx?: TransactionOptions } = {},
): Promise<{ adoptedNodeIds: string[] }> {
  // 审批前(计划时刻): 节点校验 + 祖先链移动计划 → 完整确定性 writeSet。
  assertPendingNodePreflight(root, nodeId);
  const snapHead = gitHead(root);
  const targets: TxLocalTarget[] = [];
  const adoptedNodeIds: string[] = [];
  adoptedNodeIds.push(...planAncestorAdopt(root, nodeId, targets));
  // 审批后不重读; 事务 preflight 字节 CAS 承接审批窗口竞争(CONFLICT fail-closed)。
  await assertApproved(approve, "map_atlas.adopt_placeholder", `采用空页占位节点 ${nodeId}`, [nodeId]);
  await executeCanonicalWrite(root, targets, { purpose: `atlas: adopt placeholder ${nodeId}`, expectedHead: snapHead, ...(opts.tx ? { tx: opts.tx } : {}) });
  return { adoptedNodeIds };
}

/** 驳回候选页(review_ready → rejected 终态; prompt_only 不可驳回, 移植锚点 Phase 4; 候选面操作, 无需 approval)。 */
export async function rejectAtlasPage(
  root: string,
  pageId: string,
  opts?: { note?: string; expectedContentHash?: string; tx?: TransactionOptions },
): Promise<AtlasPage> {
  const { page, file, bytes } = findPendingPage(root, pageId);
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
  await executeCanonicalWrite(root, [
    { path: relOfRoot(root, file), current: bytes, output: pageToFile(rejected) },
  ], { purpose: `atlas: reject page ${pageId}`, ...(opts?.tx ? { tx: opts.tx } : {}) });
  return rejected;
}

/** 归档已采用页(adopted → deprecated; 历史页不硬删, 计划 Phase 4)。 */
export async function archiveAtlasPage(
  root: string,
  pageId: string,
  opts?: { expectedContentHash?: string; tx?: TransactionOptions },
): Promise<AtlasPage> {
  const { page, file, bytes } = findAdoptedPage(root, pageId);
  if (page.review_status !== "adopted") {
    throw new StoreError("VALIDATION_FAILED", `archive 要求 adopted: ${pageId}(${page.review_status})`);
  }
  assertCas(page, opts?.expectedContentHash);
  const archived: AtlasPage = { ...page, review_status: "deprecated", deprecated_at: new Date().toISOString() };
  await executeCanonicalWrite(root, [
    { path: relOfRoot(root, file), current: bytes, output: pageToFile(archived) },
  ], { purpose: `atlas: archive page ${pageId}`, ...(opts?.tx ? { tx: opts.tx } : {}) });
  return archived;
}

/** 恢复归档页(deprecated → adopted; 重新 adopt 祖先链; approval-gated)。 */
export async function restoreAtlasPage(
  root: string,
  pageId: string,
  approve: AtlasApprove,
  opts?: { expectedContentHash?: string; tx?: TransactionOptions },
): Promise<{ page: AtlasPage; adoptedNodeIds: string[] }> {
  // 审批前(计划时刻): deprecated 页 + CAS + 祖先链移动计划 → 完整确定性 writeSet。
  const pre = findDeprecatedPage(root, pageId, opts?.expectedContentHash);
  const snapHead = gitHead(root);
  const targets: TxLocalTarget[] = [];
  const adoptedNodeIds: string[] = [];
  adoptedNodeIds.push(...planAncestorAdopt(root, pre.page.node_ref, targets)); // 祖先补齐(缺失/pending → adopt)。
  const restored: AtlasPage = { ...pre.page, review_status: "adopted", deprecated_at: null, adopted_at: new Date().toISOString() };
  targets.push({ path: relOfRoot(root, pre.file), current: pre.bytes, output: pageToFile(restored) });
  // 审批后不重读; 事务 preflight 字节 CAS 承接审批窗口竞争(CONFLICT fail-closed)。
  await assertApproved(approve, "map_atlas.restore_page", `恢复地图页 ${pre.page.title}(${pageId})`, [pageId, pre.page.node_ref]);
  await executeCanonicalWrite(root, targets, { purpose: `atlas: restore page ${pageId}`, expectedHead: snapHead, ...(opts?.tx ? { tx: opts.tx } : {}) });
  return { page: restored, adoptedNodeIds };
}

/**
 * 更新 prompt(仅 prompt_only 候选页; CAS; canonical 事务单 commit; content_hash 必随 prompt 重算)。
 * 候选面操作, 无审批; 仍走事务以获得内容 CAS + 崩溃恢复兜底。
 */
export async function updateAtlasPrompt(
  root: string,
  pageId: string,
  prompt: string,
  expectedContentHash?: string,
  opts?: { tx?: TransactionOptions },
): Promise<AtlasPage> {
  const { page, file, bytes } = findPendingPage(root, pageId);
  if (page.generation_status !== "prompt_only" || page.review_status !== "candidate") {
    throw new StoreError("VALIDATION_FAILED", `仅 prompt_only 候选页可改 prompt: ${pageId}`);
  }
  assertCas(page, expectedContentHash);
  const base: Omit<AtlasPage, "content_hash"> = { ...page, prompt };
  const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) }; // 一致性: 改 prompt 必重算。
  await executeCanonicalWrite(root, [
    { path: relOfRoot(root, file), current: bytes, output: pageToFile(next) },
  ], { purpose: `atlas: update prompt ${pageId}`, ...(opts?.tx ? { tx: opts.tx } : {}) });
  return next;
}

/**
 * 已采用节点调整(parent/level/title/sort_order; 循环与 rank 校验; canonical 事务单 commit)。
 */
export async function updateAtlasNode(
  root: string,
  nodeId: string,
  patch: { parent_ref?: string | null; level?: AtlasNode["level"]; title?: string; sort_order?: number },
  opts?: { tx?: TransactionOptions },
): Promise<AtlasNode> {
  const p = paths(root);
  const file = p.world.atlas.nodeFile(nodeId);
  if (!existsSync(file)) throw new StoreError("NOT_FOUND", `已采用节点不存在: ${nodeId}`);
  const bytes = readFileSync(file, "utf8");
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
  await executeCanonicalWrite(root, [
    { path: relOfRoot(root, file), current: bytes, output: nodeToFile(next) },
  ], { purpose: `atlas: update node ${nodeId}`, ...(opts?.tx ? { tx: opts.tx } : {}) });
  return next;
}
