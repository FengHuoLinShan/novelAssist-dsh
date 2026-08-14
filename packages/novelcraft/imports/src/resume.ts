// imports · 恢复与幂等续跑(imports.md「ImportWorkflowRun/attempt」M4 简化)。
// M4 下无 worker lease: 恢复 = 读 checkpoint + 重跑各阶段, 阶段函数幂等
// (provenance_key skip / entity_key 去重 / 结构按 workflow 覆盖)保证不重复产出。
import { existsSync } from "node:fs";
import { paths } from "@novelcraft/vault";
import { readCheckpoint } from "./plan.js";

export interface ResumeStatus {
  resumable: boolean;
  workflow_id?: string;
  reason: string;
  /** 各阶段幂等重跑说明(编排层据此决定从哪阶段续) */
  safe_to_rerun: string[];
}

export function resumeImport(root: string): ResumeStatus {
  const cp = readCheckpoint(root);
  if (!cp?.plan) {
    return { resumable: false, reason: "无 checkpoint, 无中断的导入可恢复", safe_to_rerun: [] };
  }
  const hasScenes = existsSync(paths(root).scenes.dir);
  return {
    resumable: true,
    workflow_id: cp.plan.workflow_id,
    reason: hasScenes ? "已有 Scene 提交, 重跑会按 provenance_key 跳过已提交项" : "尚无 Scene 提交, 从切分阶段重跑",
    safe_to_rerun: [
      "planImport(同 scope 幂等)",
      "sliceChapterBatch(失败章重跑)",
      "enrichSceneBatch(失败 Scene 重跑)",
      "commitScenes(provenance_key 幂等 skip)",
      "extractEntityBatch(entity_key 去重 + 同名复用)",
      "analyzeStructure(同 workflow 覆盖)",
    ],
  };
}
