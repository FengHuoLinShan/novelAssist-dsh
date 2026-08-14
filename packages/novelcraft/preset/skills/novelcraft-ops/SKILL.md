---
name: novelcraft-ops
description: NovelCraft 操作手册(M4): 编排目标/任务形态、恢复、git 回滚、收件箱与阈值。触发长任务或诊断"卡住"时先读本 skill。
whenToUse: 触发深度导入/审查等长任务、处理中断恢复、诊断失败、管理收件箱时。
---

# NovelCraft 操作手册(M4)

## 任务形态(无 async_tasks; 编排真相在 DSH)

- 长目标 = DSH goal(事件溯源, 跨轮延续); 阶段检查点 = .assistant/checkpoint.json;
  批内并行 fan-out = DSH workflow 脚本(挂载阶段)。
- 资产变更 = git commit; 任何一步可 revert。

## 恢复与幂等

- 深度导入: resumeImport 读 checkpoint; 各阶段重跑幂等(provenance_key/entity_key
  跳过, 不重复产出)。
- 写作: ingest 同 hash 跳过; 候选写入即 commit(保 adopt 前置工作区干净, R17)。

## 收件箱与节奏(§9/§11)

- 阈值触发: 待确认 ≥ notify_threshold(默认 5, N3)亮宠物; 无每日摘要(D6)。
- 四动词: 采纳(adopt, approval)/ 打回(必带理由 → calibration)/ 改一改(microflow)/
  先放着(defer); 动作不可重复。

## 诊断

- 失败分类: provider_retryable(重试 ≤2)/ provider_fatal / timeout / schema_violation
  (修复重试 1)/ budget_exceeded —— 向作者用可读语言转述, 不暴露 raw。
