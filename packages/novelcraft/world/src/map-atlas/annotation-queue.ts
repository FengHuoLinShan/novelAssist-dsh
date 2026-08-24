// world · 地图册标注队列消费(N35 唯一受控结构化入口; 加法导出)。
// 把此前散在 @novelcraft/dsh(消费)与 client(状态计数)的队列扫描逻辑收敛为本包
// 单一实现。队列 = .assistant/atlas/annotation-queue/*.json, 载荷 schema 固定
// (封闭 provenance): { page_ref, base_content_hash, ops }。
//   - base_content_hash 必填(N35): 缺失/非字符串 → 拒绝(零写, 队列文件保留待修);
//   - 未知顶层字段 → 拒绝(固定 provenance, 不猜测);
//   - 写只走 applyAtlasAnnotationOpsTx(async transactional, ADR-0021);
//   - 单文件失败不阻塞其余(错误汇总返回); 成功后删除队列文件。
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { applyAtlasAnnotationOpsTx } from "./annotation.js";
import type { AtlasAnnotationOp } from "./types.js";

/** 队列载荷(封闭三键; 未知键拒绝)。 */
export interface AtlasAnnotationQueuePayload {
  page_ref: string;
  base_content_hash: string;
  ops: AtlasAnnotationOp[];
}

/** 队列消费结果(与既有宿主面同形)。 */
export interface AtlasAnnotationQueueResult {
  files: number;
  applied: number;
  failed: number;
  errors: string[];
}

/** 队列只读状态(UI 面板数据源; 坏文件容错跳过)。 */
export interface AtlasAnnotationQueueStatus {
  files: number;
  ops: number;
  pages: string[];
}

function listQueueFiles(queueDir: string): string[] {
  if (!existsSync(queueDir)) return [];
  // R9(目录枚举扫描): 只接收 .json 普通文件; symlink(含指向 vault 外)与伪装成
  // .json 的目录一律忽略, 不跟随——外部 JSON 不被应用、不被删除。
  return readdirSync(queueDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
}

/**
 * 消费标注队列: 逐文件严格校验(封闭 schema + CAS 必填)→ applyAtlasAnnotationOpsTx
 * (事务零写收敛)→ 成功删文件; 失败汇总返回不阻塞其余。
 */
export async function consumeAtlasAnnotationQueue(root: string): Promise<AtlasAnnotationQueueResult> {
  const queueDir = paths(root).assistant.atlas.annotationQueue;
  const files = listQueueFiles(queueDir);
  let applied = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const file of files) {
    const abs = `${queueDir}/${file}`;
    try {
      const payload = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
      // 固定 provenance 封闭 schema: 只认 page_ref/base_content_hash/ops 三键(不猜测)。
      for (const key of Object.keys(payload)) {
        if (key !== "page_ref" && key !== "base_content_hash" && key !== "ops") {
          throw new Error(`队列文件含未知字段 ${key}(固定 schema: page_ref/base_content_hash/ops)`);
        }
      }
      const pageRef = payload.page_ref;
      const baseHash = payload.base_content_hash;
      const ops = payload.ops;
      if (typeof pageRef !== "string" || pageRef.length === 0) throw new Error("队列文件缺 page_ref");
      if (typeof baseHash !== "string" || baseHash.length === 0) {
        throw new Error("队列文件缺 base_content_hash(CAS 必填, N35; 缺失拒绝零写)");
      }
      if (!Array.isArray(ops) || ops.length === 0) throw new Error("队列文件缺 ops[]");
      const r = await applyAtlasAnnotationOpsTx(root, pageRef, ops as AtlasAnnotationOp[], {
        expectedContentHash: baseHash, // CAS: 防 stale 覆盖(N35; 必填, 失配 CONFLICT 零写)
      });
      applied += r.applied;
      rmSync(abs); // 成功后清队列(计划: 应用后清队列)。
    } catch (err) {
      failed += 1;
      errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { files: files.length, applied, failed, errors };
}

/** 队列只读状态: 文件数/ops 总数/涉及页(去重稳定序)。 */
export function atlasAnnotationQueueStatus(root: string): AtlasAnnotationQueueStatus {
  const queueDir = paths(root).assistant.atlas.annotationQueue;
  const files = listQueueFiles(queueDir);
  const pages: string[] = [];
  let ops = 0;
  for (const file of files) {
    try {
      const q = JSON.parse(readFileSync(`${queueDir}/${file}`, "utf8")) as {
        page_ref?: unknown;
        ops?: unknown;
      };
      if (typeof q.page_ref === "string" && q.page_ref.length > 0 && !pages.includes(q.page_ref)) {
        pages.push(q.page_ref);
      }
      if (Array.isArray(q.ops)) ops += q.ops.length;
    } catch {
      // 非法队列文件跳过(容错)。
    }
  }
  return { files: files.length, ops, pages };
}
