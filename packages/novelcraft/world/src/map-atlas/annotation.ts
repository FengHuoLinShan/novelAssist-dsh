// world/map-atlas · 可移动文字标注 CRUD(Phase 4; spec map-atlas.md §2.2 annotations; 移植 service.py update_annotation 471-511)。
// 校验: label 非空、坐标 0–1、target_node_ref 仅可指向已 adopted 节点;
// 更新后重算 page content_hash; 单 commit。标注页可为候选或已采用页(非 rejected/deprecated)。
// N35/ADR-0024: annotation 作者编辑是封闭例外(不过 ApprovalGate), 但只改固定 annotations
// 字段 + content_hash CAS(必填, 缺失拒绝零写) + ADR-0021 事务; 正文与未知 frontmatter
// 逐字/语义保留(只覆写 annotations/content_hash 两个字段)。
// ops 为严格 discriminated union(add/update/delete): 未知 op/未知字段/缺必填字段一律拒绝,
// 绝不把拼写错误当 delete; 批量 op 全量校验先行 + 单 commit, 任一失败零提交零残留。
//
// 写面(N35 唯一待接线点已收敛, 2026-08-16): 生产写路径 = 本模块的 async transactional
// API(addAtlasAnnotationTx / updateAtlasAnnotationTx / deleteAtlasAnnotationTx /
// applyAtlasAnnotationOpsTx), 统一经 writePageFileTx → @novelcraft/store.executeTransaction
// (kind='canonical', ADR-0021 §1–§8): 任何首写之前完成 读取/解析/严格 ops/双 CAS/固定字段
// 产出完整 output bytes, 由执行器 preflight 内容 CAS + 每目标写前复核 + intent 耐久化 +
// 崩溃恢复兜底; 业务写面不再直接 writeFileSync/gitAdd/gitCommit(N32 §6)。旧 sync API
// (addAtlasAnnotation / updateAtlasAnnotation / deleteAtlasAnnotation /
// applyAtlasAnnotationOps)保持兼容(仅测试/历史调用方; 中间态显式安全写面), DSH queue 只
// 调用 transactional API。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { guardPath, paths } from "@novelcraft/vault";
import {
  executeTransaction,
  gitAdd,
  gitCommit,
  gitHead,
  parseFrontmatter,
  serializeFrontmatter,
  sha256Hex,
  StoreError,
  type TransactionOptions,
  type TransactionResult,
} from "@novelcraft/store";
import { readAtlasTree } from "./read.js";
import { computeAtlasPageContentHash } from "./write.js";
import type { AtlasAnnotation, AtlasAnnotationOp, AtlasPage } from "./types.js";

/** 坐标 0–1 闭区间(spec §2.2)。 */
function assertCoord(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new StoreError("VALIDATION_FAILED", `${name} 必须在 0–1 闭区间(实际 ${value})`);
  }
}

/** 各 op 允许的字段白名单(N35: 未知字段一律拒绝, 不猜测)。 */
const OP_ALLOWED_KEYS: Record<AtlasAnnotationOp["op"], ReadonlySet<string>> = {
  add: new Set(["op", "label", "position_x", "position_y", "target_node_ref"]),
  update: new Set(["op", "id", "label", "position_x", "position_y", "target_node_ref"]),
  delete: new Set(["op", "id"]),
};

/**
 * 严格 discriminated union 解析(N35): 拒绝未知 op(绝不把拼写错误当 delete)、
 * 未知字段、缺必填字段(add: label/position_x/position_y; update/delete: id);
 * update 无任何变更字段也拒绝(空补丁 = 调用方错误, 零写)。返回归一化 op。
 */
function parseAnnotationOp(raw: unknown): AtlasAnnotationOp {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new StoreError("VALIDATION_FAILED", `非法标注 op(须为对象): ${JSON.stringify(raw)}`);
  }
  const o = raw as Record<string, unknown>;
  const op = o.op;
  if (op !== "add" && op !== "update" && op !== "delete") {
    throw new StoreError(
      "VALIDATION_FAILED",
      `未知标注 op: ${String(op)}(仅 add/update/delete; 绝不把拼写错误当 delete)`,
    );
  }
  for (const key of Object.keys(o)) {
    if (!OP_ALLOWED_KEYS[op].has(key)) {
      throw new StoreError("VALIDATION_FAILED", `op ${op} 含未知字段: ${key}(白名单: ${[...OP_ALLOWED_KEYS[op]].join("/")})`);
    }
  }
  if (op === "add") {
    const { label, position_x, position_y, target_node_ref } = o;
    if (typeof label !== "string" || label.trim().length === 0) {
      throw new StoreError("VALIDATION_FAILED", "add op 缺必填 label(非空字符串)");
    }
    if (typeof position_x !== "number") {
      throw new StoreError("VALIDATION_FAILED", "add op 缺必填 position_x(0–1 数字)");
    }
    if (typeof position_y !== "number") {
      throw new StoreError("VALIDATION_FAILED", "add op 缺必填 position_y(0–1 数字)");
    }
    assertCoord(position_x, "position_x");
    assertCoord(position_y, "position_y");
    if (target_node_ref !== undefined && target_node_ref !== null && typeof target_node_ref !== "string") {
      throw new StoreError("VALIDATION_FAILED", "add target_node_ref 必须是字符串或 null");
    }
    return {
      op: "add",
      label: label.trim(),
      position_x,
      position_y,
      ...(target_node_ref !== undefined ? { target_node_ref: target_node_ref as string | null } : {}),
    };
  }
  if (op === "update") {
    const { id, label, position_x, position_y, target_node_ref } = o;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new StoreError("VALIDATION_FAILED", "update op 缺必填 id(非空字符串)");
    }
    if (label !== undefined && (typeof label !== "string" || label.trim().length === 0)) {
      throw new StoreError("VALIDATION_FAILED", "update label 必须为非空字符串");
    }
    if (position_x !== undefined) {
      if (typeof position_x !== "number") {
        throw new StoreError("VALIDATION_FAILED", "update position_x 必须是 0–1 数字");
      }
      assertCoord(position_x, "position_x");
    }
    if (position_y !== undefined) {
      if (typeof position_y !== "number") {
        throw new StoreError("VALIDATION_FAILED", "update position_y 必须是 0–1 数字");
      }
      assertCoord(position_y, "position_y");
    }
    if (target_node_ref !== undefined && target_node_ref !== null && typeof target_node_ref !== "string") {
      throw new StoreError("VALIDATION_FAILED", "update target_node_ref 必须是字符串或 null");
    }
    const patch: { label?: string; position_x?: number; position_y?: number; target_node_ref?: string | null } = {};
    if (label !== undefined) patch.label = label.trim();
    if (position_x !== undefined) patch.position_x = position_x;
    if (position_y !== undefined) patch.position_y = position_y;
    if (target_node_ref !== undefined) patch.target_node_ref = target_node_ref as string | null;
    if (Object.keys(patch).length === 0) {
      throw new StoreError("VALIDATION_FAILED", "update op 无任何变更字段(label/position_x/position_y/target_node_ref)");
    }
    return { op: "update", id, ...patch };
  }
  // delete: 字段白名单已保证只剩 op/id; 缺 id 在此拒绝。
  if (typeof o.id !== "string" || o.id.trim().length === 0) {
    throw new StoreError("VALIDATION_FAILED", "delete op 缺必填 id(非空字符串)");
  }
  return { op: "delete", id: o.id };
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

/** 页面文件快照: 解析后的 AtlasPage + 原始 frontmatter 数据 + 正文原样切片 + 原始字节
 * (N35 保留语义; bytes 供事务写面作 expected 整文件 sha256 基线)。 */
function loadPageFile(root: string, pageId: string): { page: AtlasPage; file: string; data: Record<string, unknown>; body: string; bytes: string } {
  const pending = paths(root).world.atlas.pendingPageFile(pageId);
  const adopted = paths(root).world.atlas.pageFile(pageId);
  const file = existsSync(pending) ? pending : existsSync(adopted) ? adopted : null;
  if (!file) throw new StoreError("NOT_FOUND", `地图页不存在: ${pageId}`);
  const bytes = readFileSync(file, "utf8");
  const { data, body } = parseFrontmatter(bytes);
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
  return { page, file, data, body, bytes };
}

/**
 * 本页文件相对 root 的完整精确 POSIX pathspec(单文件, 绝对路径 → 相对, `/` 分隔);
 * 前缀 `:(literal)` 关闭 git pathspec 的 glob/magic 解释——slug 段虽经
 * assertSafePathSegment 校验, 但可能含 `*?:[]` 等字面字符, literal 保证精确命中。
 * 依据: ADR-0021 §6 业务写面禁用 `git add -A`; N35 标注写不捕获无关改动。
 * 仅旧 sync 兼容面(中间态安全写面)使用; 事务写面由 executeTransaction 以 writeSet
 * 相对路径直接约束。
 */
function relPosixPathspec(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
  return `:(literal)${rel}`;
}

/**
 * ⚠ 旧 sync 兼容写面(保持 addAtlasAnnotation/updateAtlasAnnotation/deleteAtlasAnnotation/
 * applyAtlasAnnotationOps 旧 API 行为不变; N35 收敛后仅测试/历史调用方使用)。
 * 中间态显式安全写面: guardPath + 完整精确相对 POSIX pathspec + 单 git commit(绝无
 * git add -A, 绝不捕获 writeSet 外改动, 失败零 git 残留)。生产写路径一律走
 * writePageFileTx(ADR-0021 事务)。
 */
function writePageFile(
  root: string,
  file: string,
  data: Record<string, unknown>,
  annotations: AtlasAnnotation[],
  contentHash: string,
  body: string,
  message: string,
): void {
  const abs = guardPath(root, file); // R9
  mkdirSync(path.dirname(abs), { recursive: true });
  // 只覆写 annotations + content_hash: 其余 frontmatter 原值 + 正文逐字保留(N35)。
  writeFileSync(abs, serializeFrontmatter({ ...data, annotations, content_hash: contentHash }, body), "utf8");
  // N35/ADR-0021 §6: 标注写只改本页文件(annotations + content_hash), git add 用完整精确
  // 相对 POSIX pathspec(绝不 -A); 作者手改/编辑器自动保存等 writeSet 外改动不进本 commit。
  gitAdd(root, [relPosixPathspec(root, abs)]);
  gitCommit(root, message);
}

/**
 * N35 事务写面选项。
 * - expectedContentHash: 业务页面 content_hash CAS 基线(队列载荷 base_content_hash 同源;
 *   N35 必填于 applyAtlasAnnotationOpsTx)。与 TargetSpec.expected.sha256(整文件字节 sha256)
 *   **分别校验、勿混淆**: 前者在计划时刻与事务 validate 回调复核(语义 CAS), 后者由
 *   executeTransaction preflight 内容 CAS 校验(字节 CAS)。缺失时仅整文件字节 CAS 生效。
 * - expectedHead: 生成计划时的 HEAD 快照(ADR-0021 §4 背景 4 封闭生成→启动窗口);
 *   缺省 = 计划时刻当前 HEAD。
 * - txOptions: 事务执行器选项透传(测试注入 gates/faults 用; 生产缺省)。
 */
export interface AtlasAnnotationTxOptions {
  expectedContentHash?: string;
  expectedHead?: string;
  txOptions?: TransactionOptions;
}

/**
 * N35/ADR-0021 统一事务写面(唯一生产写面; 替代旧的 writePageFile 直接写):
 * 在任何首写之前完成 读取/解析/严格 ops/双 CAS/固定字段 → 产出完整 output bytes →
 * executeTransaction(root, { kind:'canonical', purpose, writeSet:[{ path, expected:
 * { absent:false, sha256: <当前文件完整字节 sha256> }, output }], expectedHead:
 * 生成快照, validate: 业务 content_hash 复核 })。绝不直接 writeFileSync/gitAdd/gitCommit;
 * 内容 CAS 失败/预存 staged/崩溃均由执行器 intent 矩阵零写收敛(ADR-0021 §1–§8)。
 */
async function writePageFileTx(
  root: string,
  file: string,
  bytes: string,
  data: Record<string, unknown>,
  annotations: AtlasAnnotation[],
  contentHash: string,
  body: string,
  message: string,
  opts: AtlasAnnotationTxOptions,
): Promise<TransactionResult> {
  const abs = guardPath(root, file); // R9: 目标必须位于 vault 内
  // 只覆写 annotations + content_hash: 其余 frontmatter 原值 + 正文逐字保留(N35)。
  const output = serializeFrontmatter({ ...data, annotations, content_hash: contentHash }, body);
  const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
  const expectedFileSha256 = sha256Hex(bytes); // 整文件字节 sha256(内容 CAS 唯一基线, §1/§4)
  return executeTransaction(
    root,
    {
      kind: "canonical",
      purpose: message,
      writeSet: [
        {
          path: rel,
          expected: { absent: false, sha256: expectedFileSha256 },
          output,
        },
      ],
      // 生成计划时刻的 HEAD 快照: 封闭生成→启动窗口(§4 背景 4); 期间任何外部提交 →
      // STALE_BASELINE 零写(不覆盖新 HEAD 之上的页面)。
      expectedHead: opts.expectedHead ?? gitHead(root),
      // 业务 content_hash CAS 在事务 preflight 内复核(与整文件 sha256 分别校验;
      // currentBytes 为执行器 preflight 实读字节, 失配即拒绝, intent 建立前零副作用)。
      validate: (spec, ctx) => {
        if (opts.expectedContentHash === undefined) return;
        const { data: current } = parseFrontmatter(ctx.currentBytes ?? "");
        const actual = String(current.content_hash ?? "");
        if (actual !== opts.expectedContentHash) {
          throw new StoreError(
            "CONFLICT",
            `content_hash 失配(preflight 复核): 期望 ${opts.expectedContentHash}, 实际 ${actual}(目标 ${spec.path})`,
          );
        }
      },
    },
    opts.txOptions,
  );
}

function assertAnnotatable(page: AtlasPage): void {
  if (page.review_status === "rejected" || page.review_status === "deprecated") {
    throw new StoreError("VALIDATION_FAILED", `${page.review_status} 页不可标注(历史页只读)`);
  }
}

/** 业务 content_hash CAS 前置校验(N35: 缺失/失配在计划时刻拒绝, 零写零事务)。 */
function assertBusinessCas(page: AtlasPage, expected: string | undefined, what: string): void {
  if (expected === undefined) return;
  if (expected !== page.content_hash) {
    throw new StoreError("CONFLICT", `content_hash 失配(${what}): 期望 ${expected}, 实际 ${page.content_hash}`);
  }
}

/** 新增标注(旧 sync 兼容面; 生产走 addAtlasAnnotationTx)。返回新 annotation id。 */
export function addAtlasAnnotation(
  root: string,
  pageId: string,
  input: { label: string; position_x: number; position_y: number; target_node_ref?: string | null },
): string {
  const { page, file, data, body } = loadPageFile(root, pageId);
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
  writePageFile(root, file, data, next.annotations, next.content_hash, body, `atlas: add annotation ${pageId}#${id}`);
  return id;
}

/** 更新标注(label/坐标/target; 旧 sync 兼容面; 生产走 updateAtlasAnnotationTx)。 */
export function updateAtlasAnnotation(
  root: string,
  pageId: string,
  annotationId: string,
  patch: { label?: string; position_x?: number; position_y?: number; target_node_ref?: string | null },
): AtlasAnnotation {
  const { page, file, data, body } = loadPageFile(root, pageId);
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
  writePageFile(root, file, data, next.annotations, next.content_hash, body, `atlas: update annotation ${pageId}#${annotationId}`);
  return nextAnn;
}

/**
 * 批量应用标注 ops(旧 sync 兼容面; 生产走 applyAtlasAnnotationOpsTx):
 * 全部 op 先在内存工作副本上严格校验(parseAnnotationOp: 未知 op/未知字段/缺字段拒绝,
 * 绝不把拼写错误当 delete)并应用 → 单 commit; 中途任何 op 非法 → 零提交零残留。
 * expectedContentHash 必填(N35): 缺失 → VALIDATION_FAILED 零写; 失配(stale)→ CONFLICT 零写。
 * 队列载荷的 base_content_hash 同样必填(缺失/陈旧拒绝, 见 dsh 层 applyAtlasAnnotationQueue)。
 */
export function applyAtlasAnnotationOps(
  root: string,
  pageId: string,
  ops: AtlasAnnotationOp[],
  opts?: { expectedContentHash?: string },
): { applied: number; content_hash: string } {
  const { page, file, data, body } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  if (opts?.expectedContentHash === undefined) {
    throw new StoreError("VALIDATION_FAILED", "applyAtlasAnnotationOps 必须携带 expectedContentHash CAS(N35; 缺失拒绝零写)");
  }
  if (opts.expectedContentHash !== page.content_hash) {
    throw new StoreError("CONFLICT", `content_hash 失配(队列 base=${opts.expectedContentHash}, 实际 ${page.content_hash})`);
  }
  // 全量解析先行(任一 op 非法 → 整批拒绝零写, 绝不部分应用)。
  const parsed = ops.map((raw) => parseAnnotationOp(raw));
  let anns = [...page.annotations];
  for (const op of parsed) {
    if (op.op === "add") {
      validateAnnotation(root, op);
      anns = [
        ...anns,
        {
          id: `ann-${randomBytes(4).toString("hex")}`,
          label: op.label,
          position_x: op.position_x,
          position_y: op.position_y,
          sort_order: anns.length,
          ...(op.target_node_ref != null ? { target_node_ref: op.target_node_ref } : {}),
        },
      ];
    } else if (op.op === "update") {
      const found = anns.find((a) => a.id === op.id);
      if (!found) throw new StoreError("NOT_FOUND", `标注不存在: ${op.id}`);
      validateAnnotation(root, op);
      const merged: AtlasAnnotation = {
        ...found,
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...(op.position_x !== undefined ? { position_x: op.position_x } : {}),
        ...(op.position_y !== undefined ? { position_y: op.position_y } : {}),
        ...(op.target_node_ref !== undefined
          ? op.target_node_ref === null
            ? { target_node_ref: undefined }
            : { target_node_ref: op.target_node_ref }
          : {}),
      };
      anns = anns.map((a) => (a.id === op.id ? merged : a));
    } else {
      if (!anns.some((a) => a.id === op.id)) throw new StoreError("NOT_FOUND", `标注不存在: ${op.id}`);
      anns = anns.filter((a) => a.id !== op.id);
    }
  }
  const base: Omit<AtlasPage, "content_hash"> = { ...page, annotations: anns };
  const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
  writePageFile(root, file, data, next.annotations, next.content_hash, body, `atlas: apply annotations ${pageId}(${parsed.length} ops)`);
  return { applied: parsed.length, content_hash: next.content_hash };
}

/** 删除标注(旧 sync 兼容面; 生产走 deleteAtlasAnnotationTx)。 */
export function deleteAtlasAnnotation(root: string, pageId: string, annotationId: string): void {
  const { page, file, data, body } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  if (!page.annotations.some((a) => a.id === annotationId)) {
    throw new StoreError("NOT_FOUND", `标注不存在: ${annotationId}`);
  }
  const base: Omit<AtlasPage, "content_hash"> = {
    ...page,
    annotations: page.annotations.filter((a) => a.id !== annotationId),
  };
  const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
  writePageFile(root, file, data, next.annotations, next.content_hash, body, `atlas: delete annotation ${pageId}#${annotationId}`);
}

// ============================================================================
// N35/ADR-0021 async transactional API(唯一生产写面; 统一走 writePageFileTx)
// ============================================================================

/**
 * 新增标注(N35 事务写面): 计划时刻完成读取/校验/CAS 与 output bytes 产出后,
 * 经 executeTransaction(kind='canonical')单 commit; 失败零写。返回新 annotation id。
 */
export async function addAtlasAnnotationTx(
  root: string,
  pageId: string,
  input: { label: string; position_x: number; position_y: number; target_node_ref?: string | null },
  opts: AtlasAnnotationTxOptions = {},
): Promise<string> {
  const { page, file, data, body, bytes } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  assertBusinessCas(page, opts.expectedContentHash, "add 基线");
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
  await writePageFileTx(root, file, bytes, data, next.annotations, next.content_hash, body, `atlas: add annotation ${pageId}#${id}`, opts);
  return id;
}

/** 更新标注(label/坐标/target; N35 事务写面)。 */
export async function updateAtlasAnnotationTx(
  root: string,
  pageId: string,
  annotationId: string,
  patch: { label?: string; position_x?: number; position_y?: number; target_node_ref?: string | null },
  opts: AtlasAnnotationTxOptions = {},
): Promise<AtlasAnnotation> {
  const { page, file, data, body, bytes } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  assertBusinessCas(page, opts.expectedContentHash, "update 基线");
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
  await writePageFileTx(root, file, bytes, data, next.annotations, next.content_hash, body, `atlas: update annotation ${pageId}#${annotationId}`, opts);
  return nextAnn;
}

/**
 * 批量应用标注 ops(N35 事务写面; DSH queue 唯一入口):
 * 全部 op 先在内存工作副本上严格校验(parseAnnotationOp: 未知 op/未知字段/缺字段拒绝,
 * 绝不把拼写错误当 delete)并应用 → 完整 output bytes → executeTransaction 单 commit;
 * 中途任何 op 非法 → 零提交零残留。expectedContentHash 必填(N35): 缺失 →
 * VALIDATION_FAILED 零写; 失配(stale)→ CONFLICT 零写; 执行器整文件字节 CAS 失配 →
 * STALE_BASELINE 零写。
 */
export async function applyAtlasAnnotationOpsTx(
  root: string,
  pageId: string,
  ops: AtlasAnnotationOp[],
  opts: AtlasAnnotationTxOptions & { expectedContentHash: string },
): Promise<{ applied: number; content_hash: string }> {
  const { page, file, data, body, bytes } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  if (opts.expectedContentHash === undefined) {
    throw new StoreError("VALIDATION_FAILED", "applyAtlasAnnotationOpsTx 必须携带 expectedContentHash CAS(N35; 缺失拒绝零写)");
  }
  assertBusinessCas(page, opts.expectedContentHash, "队列 base");
  // 全量解析先行(任一 op 非法 → 整批拒绝零写, 绝不部分应用)。
  const parsed = ops.map((raw) => parseAnnotationOp(raw));
  let anns = [...page.annotations];
  for (const op of parsed) {
    if (op.op === "add") {
      validateAnnotation(root, op);
      anns = [
        ...anns,
        {
          id: `ann-${randomBytes(4).toString("hex")}`,
          label: op.label,
          position_x: op.position_x,
          position_y: op.position_y,
          sort_order: anns.length,
          ...(op.target_node_ref != null ? { target_node_ref: op.target_node_ref } : {}),
        },
      ];
    } else if (op.op === "update") {
      const found = anns.find((a) => a.id === op.id);
      if (!found) throw new StoreError("NOT_FOUND", `标注不存在: ${op.id}`);
      validateAnnotation(root, op);
      const merged: AtlasAnnotation = {
        ...found,
        ...(op.label !== undefined ? { label: op.label } : {}),
        ...(op.position_x !== undefined ? { position_x: op.position_x } : {}),
        ...(op.position_y !== undefined ? { position_y: op.position_y } : {}),
        ...(op.target_node_ref !== undefined
          ? op.target_node_ref === null
            ? { target_node_ref: undefined }
            : { target_node_ref: op.target_node_ref }
          : {}),
      };
      anns = anns.map((a) => (a.id === op.id ? merged : a));
    } else {
      if (!anns.some((a) => a.id === op.id)) throw new StoreError("NOT_FOUND", `标注不存在: ${op.id}`);
      anns = anns.filter((a) => a.id !== op.id);
    }
  }
  const base: Omit<AtlasPage, "content_hash"> = { ...page, annotations: anns };
  const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
  await writePageFileTx(root, file, bytes, data, next.annotations, next.content_hash, body, `atlas: apply annotations ${pageId}(${parsed.length} ops)`, opts);
  return { applied: parsed.length, content_hash: next.content_hash };
}

/** 删除标注(N35 事务写面)。 */
export async function deleteAtlasAnnotationTx(
  root: string,
  pageId: string,
  annotationId: string,
  opts: AtlasAnnotationTxOptions = {},
): Promise<void> {
  const { page, file, data, body, bytes } = loadPageFile(root, pageId);
  assertAnnotatable(page);
  assertBusinessCas(page, opts.expectedContentHash, "delete 基线");
  if (!page.annotations.some((a) => a.id === annotationId)) {
    throw new StoreError("NOT_FOUND", `标注不存在: ${annotationId}`);
  }
  const base: Omit<AtlasPage, "content_hash"> = {
    ...page,
    annotations: page.annotations.filter((a) => a.id !== annotationId),
  };
  const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
  await writePageFileTx(root, file, bytes, data, next.annotations, next.content_hash, body, `atlas: delete annotation ${pageId}#${annotationId}`, opts);
}
