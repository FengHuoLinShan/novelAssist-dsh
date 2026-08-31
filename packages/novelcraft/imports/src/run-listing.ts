// imports · durable workflow run 只读枚举(M10-B1/N40 加法)。
// 扫描 vault 内两个 canonical run namespace(ADR-0022 §1/§2):
//   .assistant/import-runs/<run-id>/manifest.json  (deep-import)
//   .assistant/atlas/runs/<run-id>/manifest.json   (map-atlas)
// 逐 run 读 manifest 提取白名单字段(与 git-run-persistence MANIFEST_TOP_FIELDS 同词汇),
// 容错列出: 目录缺失 → 空表; 单 run manifest 坏/缺 → corrupt 标注仍列出(R12 目录容错口径)。
// 纯确定性读面, 零写、零 intent 收敛 —— 供 DSH workflowInspect 能力与作者恢复面消费。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ListedRunKind = "deep-import" | "map-atlas";

export interface ListedWorkflowRun {
  kind: ListedRunKind;
  /** run 目录(vault 相对 POSIX 路径) */
  run_dir: string;
  workflow_id: string;
  /** manifest.status 原值; manifest 不可读时为 "unreadable" */
  status: string;
  created_at?: string;
  cursor?: { phase: string; ordinal: number };
  batches: {
    total: number;
    /** state=completed/artifact_committed(确定性补 cursor, 不需 LLM) */
    completed: number;
    /** 其余状态(waiting/planned/running 等原始 state 计数) */
    other: number;
  };
  input_fingerprint?: string;
  profile_fingerprint?: string;
  /** manifest 缺失/坏 JSON/非对象的原因(容错列出, 不中断枚举) */
  corrupt?: string;
}

const RUN_NAMESPACES: ReadonlyArray<{ prefix: string; kind: ListedRunKind }> = [
  { prefix: ".assistant/import-runs", kind: "deep-import" },
  { prefix: ".assistant/atlas/runs", kind: "map-atlas" },
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readListedManifest(nsRoot: string, runId: string): Record<string, unknown> | string {
  const manifestPath = join(nsRoot, runId, "manifest.json");
  if (!existsSync(manifestPath)) return "manifest.json 缺失(bootstrap intent 未提交, 尚无完成批)";
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (err) {
    return `manifest.json 读取失败: ${(err as Error).message}`;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return "manifest.json 不是 JSON 对象";
    return parsed;
  } catch (err) {
    return `manifest.json 不是合法 JSON: ${(err as Error).message}`;
  }
}

/** 枚举 vault 内全部 durable run(两个 namespace; 目录序即返回序, 每域内按 runId 排序)。 */
export function listWorkflowRuns(root: string): ListedWorkflowRun[] {
  const out: ListedWorkflowRun[] = [];
  for (const { prefix, kind } of RUN_NAMESPACES) {
    const nsRoot = join(root, prefix);
    if (!existsSync(nsRoot)) continue;
    let entries: string[];
    try {
      entries = readdirSync(nsRoot).sort();
    } catch {
      continue; // namespace 目录不可读 → 该域空表(容错)
    }
    for (const runId of entries) {
      const runAbs = join(nsRoot, runId);
      let isDir = false;
      try {
        isDir = statSync(runAbs).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const runDir = `${prefix}/${runId}`;
      const manifest = readListedManifest(nsRoot, runId);
      if (typeof manifest === "string") {
        out.push({
          kind,
          run_dir: runDir,
          workflow_id: runId,
          status: "unreadable",
          batches: { total: 0, completed: 0, other: 0 },
          corrupt: manifest,
        });
        continue;
      }
      const batches = isPlainObject(manifest.batches) ? manifest.batches : {};
      let completed = 0;
      let other = 0;
      for (const raw of Object.values(batches)) {
        const state = isPlainObject(raw) ? raw.state : undefined;
        if (state === "completed" || state === "artifact_committed") completed += 1;
        else other += 1;
      }
      const cursorRaw = manifest.cursor;
      const cursor =
        isPlainObject(cursorRaw) && typeof cursorRaw.phase === "string" && typeof cursorRaw.ordinal === "number"
          ? { phase: cursorRaw.phase, ordinal: cursorRaw.ordinal }
          : undefined;
      out.push({
        kind,
        run_dir: runDir,
        workflow_id: runId,
        status: typeof manifest.status === "string" ? manifest.status : "unknown",
        ...(typeof manifest.createdAt === "string" ? { created_at: manifest.createdAt } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        batches: { total: completed + other, completed, other },
        ...(typeof manifest.inputFingerprint === "string" ? { input_fingerprint: manifest.inputFingerprint } : {}),
        ...(typeof manifest.profileFingerprint === "string"
          ? { profile_fingerprint: manifest.profileFingerprint }
          : {}),
      });
    }
  }
  return out;
}
