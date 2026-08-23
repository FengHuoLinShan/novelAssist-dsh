---
name: novelcraft-ops
description: "NovelCraft 操作手册(M4): 编排目标/任务形态、恢复、git 回滚、收件箱与阈值。触发长任务或诊断卡住时先读本 skill。"
whenToUse: 触发深度导入/审查等长任务、处理中断恢复、诊断失败、管理收件箱时。
---

# NovelCraft 操作手册(M4)

## 当前可执行面

- `available-now`: `novelcraft_inbox_view`/`novelcraft_inbox_act`,
  `novelcraft_radar_sweep`, `novelcraft_health_scan`, `novelcraft_store_index`。
- `core-only`: 深导入与地图册有 durable run/checkpoint, 但当前没有公开的 operation
  list/status/resume/stop/abandon。DSH goal 只保存对话目标, 不等于创作 job 控制器。
- 信号只能由确定性雷达/领域事件或明确 UI intent 产生; 模型没有任意 `signal_push` 工具。

## 恢复与幂等

- 深度导入: 核心可从 checkpoint 重建, 但作者恢复动作尚未公开。
- 写作: ingest 同 hash 跳过; 候选写入即 commit(保 adopt 前置工作区干净, R17)。

## 收件箱与节奏(§9/§11)

- 阈值触发: 待确认 ≥ notify_threshold(默认 5, N3)亮宠物; 无每日摘要(D6)。
- 四动词: 采纳(仅记录采用意图, 后续资产采用仍过 approval)/ 打回(必带理由)/ 改一改(microflow)/
  先放着(defer); 动作不可重复。

## 诊断

- 工具失败走 DSH 原生 `isError/HarnessError.code`, 不把 `{ok:false}` 当完成。按 code 恢复:
  `WORKSPACE_ISOLATION` 停止并绑定/切换当前书; `APPROVAL_REJECTED` 保留候选且不自动重试;
  `APPROVAL_CANCELLED` 回当前上下文; `APPROVAL_UNAVAILABLE` 先恢复审批通道;
  `STORE_STALE_BASELINE`/`STORE_CAS_CONFLICT` 先刷新; `LLM_PROVIDER_RETRYABLE` 只在无副作用时重试;
  `LLM_TIMEOUT`/`LLM_SCHEMA_VIOLATION` 向作者解释; `NOVELCRAFT_TOOL_ERROR` 停止, 不猜测重放。
- `empty/no_change/partial/conflict` 是成功结果, 依据 status/计数/coverage 继续, 不当作异常重试。
