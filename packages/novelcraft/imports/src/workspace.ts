// imports · 批量写面前的工作区洁净门禁(R17 范围语义)+ 深导完成的 state commit。
// commitScenes/analyzeStructure 等批量写入前先验证: 除导入工作流自身工件之外
// 无任何未提交/未暂存改动, 否则 DIRTY_WORKSPACE fail-closed(metadata: store-rules.md
// R17「有未暂存/未提交变更(且不属于本次操作范围)→ 拒绝」; spec: specs/assets/imports.md)。
// commitImportState: runDeepImport 正常完成(rejected 闭环与 complete 闭环)后把
// 本流程工件精确 stage + 恰一次 audit/state commit —— checkpoint/trace 必须进 git
// 历史(trace contract §15/§22.2: 事件可回滚可审计), 否则深导一结束工作区就永久脏,
// 后续 store adopt 的全局洁净检查(R17)被深导自身工件卡死。
// fail-closed: 普通 `git commit` 会把 index 里预存的 staged 外部文件一起提交, 故
// helper 最前先过 assertImportWorkspaceClean(自身工件豁免、范围外任何改动含预存
// staged 一律 DIRTY_WORKSPACE), 绝不捕获外部文件。
import { gitAdd, gitCommit, gitStatusEntries, hasUncommittedOutside, isGitRepo, StoreError } from "@novelcraft/store";

/**
 * 导入工作流自身工件(本次操作范围, 不视为脏; 也是 state commit 唯一允许的路径集):
 * - .assistant/checkpoint.json: 授权快照 + 阶段进度(planImport/writeCheckpoint 写);
 * - .assistant/import-trace.jsonl: 深度导入 trace 事件流(DSH ImportTraceSink 写)。
 * 其余任何未提交改动(章节/对象/结构/手改)一律视为脏, 拒绝整批写入 / 不被 state commit 捕获。
 */
export const IMPORT_OWNED_ARTIFACTS: readonly string[] = [
  ".assistant/checkpoint.json",
  ".assistant/import-trace.jsonl",
];

/** 批量写前门禁: 非 git 仓库 → NOT_A_GIT_REPO; 范围外脏改动 → DIRTY_WORKSPACE。 */
export function assertImportWorkspaceClean(root: string): void {
  if (!isGitRepo(root)) {
    throw new StoreError("NOT_A_GIT_REPO", `工作区不是 git 仓库: ${root}`);
  }
  if (hasUncommittedOutside(root, IMPORT_OWNED_ARTIFACTS)) {
    throw new StoreError(
      "DIRTY_WORKSPACE",
      "工作区存在未提交改动(非导入流程工件), 拒绝整批写入 (R17)",
    );
  }
}

/**
 * 深导正常完成后的 audit/state commit(fail-closed, 只提交本流程工件):
 * - 前置 assertImportWorkspaceClean: 自身工件豁免, 范围外任何改动(未跟踪/未暂存/预存
 *   staged/rename 双路径)一律 DIRTY_WORKSPACE —— 普通 `git commit` 会把 index 里预存的
 *   staged 外部文件一起提交, 故工作区(除工件外)不干净即拒绝, 绝不捕获外部文件;
 * - 通过后基于 gitStatusEntries(porcelain -z 结构化精确解析)判定 IMPORT_OWNED_ARTIFACTS
 *   中哪些有变化(未跟踪 ?? / 已修改 / 已暂存), 只 stage 有变化的工件路径
 *   (gitAdd 精确相对路径, 绝不 -A);
 * - 两个工件均无变化 → 不 commit(幂等重跑且 checkpoint 内容一致时零提交);
 * - trace 为内存 sink(无 .assistant/import-trace.jsonl 文件)时只提交 checkpoint;
 * - 恰一次 commit, 消息前缀 `deep-import state`(审计/测试断言面)。
 */
export function commitImportState(root: string): void {
  // fail-closed 前置门禁(自身工件豁免): 范围外任何 staged/unstaged/untracked 一律拒绝。
  assertImportWorkspaceClean(root);
  const changed = gitStatusEntries(root)
    .filter((e) => IMPORT_OWNED_ARTIFACTS.includes(e.path))
    .map((e) => e.path);
  if (changed.length === 0) return; // 均无变化不 commit
  gitAdd(root, changed);
  gitCommit(root, `deep-import state: ${changed.join(", ")}`);
}