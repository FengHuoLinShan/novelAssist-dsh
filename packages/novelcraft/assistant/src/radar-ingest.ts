// assistant · 摄入雷达(ingest-, 确定性, 非 LLM, 零 DSH 依赖)。
// 依据: 设计文档 §7 摄入雷达(「第 31 章已入库, 待增量导入」)、§11 打扰分级(risk 进角标, note 静默堆积)。
// 规则:
//   1. imports/import-log.jsonl(imports.md §41 ImportRecord)status='failed' → risk;
//      自己解析(不 import writing 包), 坏行跳过, 文件不存在当空; 只用 file_name/status/error_message/total_chapters。
//   2. 已入库章无 Scene 覆盖(chapter_ids 未挂任何 Scene)→ note。
// 对账: 全部经 reconcileRadarSignals(§11 静默纪律 + 双向对账)。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@novelcraft/vault";
import { rebuildIndex, type VaultIndex } from "@novelcraft/store";
import { reconcileRadarSignals, type RadarReconcileResult } from "./radar-utils.js";
import { signalIdFromKey, signalLogicalKey, type CreateSignalInput } from "./signals.js";

/** 只取本雷达关心的字段(imports.md §41 子集)。 */
interface ImportLogLine {
  id?: unknown;
  file_name?: unknown;
  status?: unknown;
  error_message?: unknown;
  total_chapters?: unknown;
}

/** 读 imports/import-log.jsonl; 文件不存在当空, 坏行跳过容忍(imports.md §41)。 */
function readImportLogLines(root: string): ImportLogLine[] {
  const file = join(paths(root).imports.dir, "import-log.jsonl");
  if (!existsSync(file)) return [];
  const out: ImportLogLine[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") out.push(parsed as ImportLogLine);
    } catch {
      // 坏行跳过并容忍: 失败诊断不阻塞后续记录。
    }
  }
  return out;
}

/** 摄入雷达全扫: 失败导入 + 章覆盖缺口 → 收件箱(幂等, 双向对账)。 */
export function scanIngestRadar(root: string, now?: Date): RadarReconcileResult {
  return reconcileRadarSignals(root, "ingest-", collectIngestRadarHits(root), now);
}

export function collectIngestRadarHits(root: string, index: VaultIndex = rebuildIndex(root)): CreateSignalInput[] {
  const hits: CreateSignalInput[] = [];

  // 1. 失败导入 → risk 信号(§7 摄入雷达)。
  for (const rec of readImportLogLines(root)) {
    if (rec.status !== "failed") continue;
    const file_name = typeof rec.file_name === "string" ? rec.file_name : "未知文件";
    const error_message = typeof rec.error_message === "string" ? rec.error_message : "";
    const evidence: string[] = [error_message.trim() ? error_message : "无错误详情"];
    if (typeof rec.total_chapters === "number" && rec.total_chapters > 0) {
      evidence.push(`共 ${rec.total_chapters} 章`);
    }
    const recordId = typeof rec.id === "string" && rec.id.trim() ? rec.id : file_name;
    const logicalKey = signalLogicalKey("ingest", "failed", recordId, file_name);
    hits.push({
      id: signalIdFromKey("ingest-failed-", logicalKey),
      logical_key: logicalKey,
      radar: "ingest",
      severity: "risk",
      title: `导入失败: ${file_name}`,
      evidence,
      proposed_action: "检查文件后重新导入",
      reversibility: true,
    });
  }

  // 2. 章无 Scene 覆盖 → note 信号(§7: 章已入库, 待增量导入/Scene 关联)。
  const covered = new Set<number>();
  for (const s of index.scenes) {
    for (const c of s.chapters) {
      const n = Number(c);
      if (Number.isFinite(n)) covered.add(n);
    }
  }
  for (const ch of index.chapters) {
    if (covered.has(ch.index)) continue;
    hits.push({
      id: `ingest-uncovered-ch${ch.index}`,
      logical_key: signalLogicalKey("ingest", "uncovered_chapter", ch.index),
      radar: "ingest",
      severity: "note",
      title: `第 ${ch.index} 章已入库, 待增量导入/Scene 关联`,
      evidence: [`章节 ${ch.index} 尚无 Scene 通过 chapter_ids 关联`],
      proposed_action: "对该章跑深度导入或手动关联 Scene",
      reversibility: true,
    });
  }

  return hits;
}
