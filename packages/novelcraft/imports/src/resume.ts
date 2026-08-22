// imports · 恢复与幂等续跑(imports.md「ImportWorkflowRun/attempt」M4 简化)。
// M4 下无 worker lease: 恢复 = 读 checkpoint + 重跑各阶段, 阶段函数幂等
// (provenance_key skip / entity_key 去重 / 结构按 workflow 覆盖)保证不重复产出。
// N34/ADR-0023 §6 + 独立审查 P5(审查项 5 收口): resume 必须强制「当前执行画像指纹」与
// 「checkpoint 记录指纹」都存在且完全匹配 —— 任一缺失或 mismatch → resumable:false
// (fail-closed: 不沿用无法验证执行画像一致的旧 checkpoint, 移除旧 checkpoint fail-open)。
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

export interface ResumeOptions {
  /**
   * 当前编排启动解析一次的执行画像指纹(fingerprintExecutionProfile)。必填(strict,
   * 审查项 5): resume 必须同时持有「当前指纹」与「checkpoint 指纹」且完全匹配,
   * 任一缺失 → resumable:false(fail-closed, 不沿用旧 checkpoint fail-open)。
   * 调用方(DSH resume 路径)必须传入指纹; 无指纹的旧调用面不再放行。
   */
  profileFingerprint: string;
}

export function resumeImport(root: string, options: ResumeOptions): ResumeStatus {
  const cp = readCheckpoint(root);
  if (!cp?.plan) {
    return { resumable: false, reason: "无 checkpoint, 无中断的导入可恢复", safe_to_rerun: [] };
  }
  // 审查项 5: checkpoint 指纹必须存在 —— 旧版/仅 planImport 阶段形态(未记录指纹)无法
  // 验证执行画像一致, 拒绝续跑(fail-closed, 移除旧 checkpoint fail-open)。
  if (cp.profile_fingerprint === undefined) {
    return {
      resumable: false,
      reason:
        "checkpoint 未记录执行画像指纹(旧版/仅 planImport 形态), 无法验证执行画像一致, 拒绝续跑" +
        "(fail-closed, N34/审查项 5)。请重新授权导入以在新执行画像下重跑, 或清理 .assistant/checkpoint.json",
      safe_to_rerun: [],
    };
  }
  if (cp.profile_fingerprint !== options.profileFingerprint) {
    return {
      resumable: false,
      reason:
        `执行画像指纹变化, 拒绝续跑旧 run(旧 ${cp.profile_fingerprint.slice(0, 12)}… ≠ 新 ` +
        `${options.profileFingerprint.slice(0, 12)}…; N34/审查项 5)。请确认执行配置后重新授权导入, 或清理 .assistant/checkpoint.json`,
      safe_to_rerun: [],
    };
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
