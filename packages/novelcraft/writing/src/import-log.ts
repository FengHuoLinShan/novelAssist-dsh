// Track 1a 导入日志: imports/import-log.jsonl(specs/assets/imports.md §41 ImportRecord)。
// 确定性追加式 jsonl; 读取时坏行跳过并容忍, 不抛错、不影响其余行。
// 幂等键语义见 imports.md §41 完整性规则: (novel_id, file_name) 在 status='done' 时唯一。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { guardPath, paths } from "@novelcraft/vault";

export interface ImportLogRecord {
  id: string;
  novel_id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  total_chapters: number;
  imported_chapters: number;
  status: "pending" | "processing" | "done" | "failed";
  error_message?: string;
}

const LOG_NAME = "import-log.jsonl";

/** 读导入日志; 文件不存在 → []。坏行(JSON 解析失败或形状不符)跳过容忍。 */
export function readImportLog(root: string): ImportLogRecord[] {
  const logPath = guardPath(root, path.join(paths(root).imports.dir, LOG_NAME));
  if (!existsSync(logPath)) return [];
  const records: ImportLogRecord[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isImportLogRecord(parsed)) records.push(parsed);
    } catch {
      // 坏行跳过并容忍(imports.md §41: 失败诊断不阻塞后续)。
    }
  }
  return records;
}

/** 追加一行导入记录(确保目录存在; JSON 一行 + \n, 追加式, 不重写)。 */
export function appendImportLog(root: string, rec: ImportLogRecord): void {
  const logPath = guardPath(root, path.join(paths(root).imports.dir, LOG_NAME));
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(rec) + "\n", "utf8");
}

function isImportLogRecord(v: unknown): v is ImportLogRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.novel_id === "string" &&
    typeof o.file_name === "string" &&
    typeof o.file_type === "string" &&
    typeof o.file_size === "number" &&
    typeof o.total_chapters === "number" &&
    typeof o.imported_chapters === "number" &&
    (o.status === "pending" ||
      o.status === "processing" ||
      o.status === "done" ||
      o.status === "failed")
  );
}
