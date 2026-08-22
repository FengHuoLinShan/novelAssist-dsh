// imports · 计划与授权(PLAN.md: planImport)。
// 依据: imports.md「authorization_snapshot」——authorization_confirmed 强制 true,
// 授权范围任务保存后不可变; 幂等(同 scope 已确认 → 返回已有)。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";

export interface ImportPlan {
  workflow_id: string;
  novel_title: string;
  start_chapter: number;
  end_chapter: number;
  steps: string[];
  /** 成本预告(步数估计, 作者语言) */
  cost_preview: string;
  authorization: {
    authorization_confirmed: boolean;
    authorized_at: string;
    adoption_policy: string;
    scope: { start_chapter: number; end_chapter: number; stage?: string };
  };
}

export interface CheckpointState {
  plan?: ImportPlan;
  phase_results?: Record<string, unknown>;
  /** N34/ADR-0023 §6 + 独立审查 P5: 编排启动解析一次的执行画像指纹。
   *  续跑/新 run 按此拒绝旧 run(执行画像变化不沿用旧 checkpoint)。 */
  profile_fingerprint?: string;
  /** P5/R6: 本次编排的契约版本集(从 spec registry 构造, 确定性)。 */
  contract_versions?: Record<string, string>;
}

export function readCheckpoint(root: string): CheckpointState | undefined {
  const file = paths(root).assistant.checkpoint;
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as CheckpointState;
}

export function writeCheckpoint(root: string, state: CheckpointState): void {
  writeFileSync(paths(root).assistant.checkpoint, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export interface CreateImportPlanOptions {
  startChapter: number;
  endChapter: number;
  confirmed: boolean;
  force?: boolean;
  highQuality?: boolean;
}

/** Pure plan constructor for durable drivers; performs no checkpoint/file write. */
export function createImportPlan(
  opts: CreateImportPlanOptions,
  now: Date = new Date(),
  workflowId = `imp-${now.getTime()}`,
): ImportPlan {
  if (opts.startChapter < 1 || opts.endChapter < opts.startChapter) {
    throw new Error("章节范围非法: 1 ≤ start ≤ end");
  }
  if (opts.confirmed !== true) {
    throw new Error("authorization_confirmed 必须为 true(授权快照强制, imports.md)");
  }
  return {
    workflow_id: workflowId,
    novel_title: "novel",
    start_chapter: opts.startChapter,
    end_chapter: opts.endChapter,
    steps: [
      "plan", "slice(1a)", "enrich(1b)", "fuse(1c)", "commit",
      "entities(2a)", "alias_relation(2b)", "structure(3)",
    ],
    cost_preview: `预计 ${opts.endChapter - opts.startChapter + 1} 章, 约 8 个阶段步骤(内容步逐批执行)。`,
    authorization: {
      authorization_confirmed: true,
      authorized_at: now.toISOString(),
      adoption_policy: "rules_with_review",
      scope: { start_chapter: opts.startChapter, end_chapter: opts.endChapter },
    },
  };
}

/** 生成计划 + 授权快照(legacy API: 同时写 checkpoint)。 */
export function planImport(
  root: string,
  opts: CreateImportPlanOptions,
  now: Date = new Date(),
): ImportPlan {
  if (opts.startChapter < 1 || opts.endChapter < opts.startChapter) {
    throw new Error("章节范围非法: 1 ≤ start ≤ end");
  }
  if (opts.confirmed !== true) {
    throw new Error("authorization_confirmed 必须为 true(授权快照强制, imports.md)");
  }
  const existing = readCheckpoint(root)?.plan;
  if (
    existing &&
    existing.authorization.authorization_confirmed &&
    existing.authorization.scope.start_chapter === opts.startChapter &&
    existing.authorization.scope.end_chapter === opts.endChapter
  ) {
    return existing; // 幂等: 同 scope 已授权
  }

  const plan = createImportPlan(opts, now);
  const state = readCheckpoint(root) ?? {};
  writeCheckpoint(root, { ...state, plan });
  return plan;
}
