---
name: novelcraft-ops
description: NovelCraft 任务队列的操作手册: 触发/轮询/恢复/取消/诊断, 任务状态与 available_actions 语义, 长任务失败与恢复路径。任何"触发 AI 工作流并跟踪进度"的操作先读本 skill。
whenToUse: 触发深度导入/生成/审查等长任务、轮询进度、处理中断恢复、诊断失败、或用户问"任务卡住了怎么办"时。
---

# NovelCraft 任务操作手册

## 任务模型

- 入口: 前端触发端点返回 task_id(201/202), 任务落 PostgreSQL async_tasks;
  轮询 `GET /api/tasks/{task_id}?novel_id=<当前项目>`。
- 状态机: pending → running → done | failed | cancelled。
- available_actions: cancel / resume / abandon / retry / dismiss —— 只执行
  服务端给出的可用动作, 不要自行发明。
- recovery_policy: auto_requeue(自动重排)/ manual_resume(需恢复)/
  restart_origin / never_retry。前端显示「自动提取需要恢复」时, 走
  resume(继续)或 abandon(放弃并清理), 二者都保留已保存的阶段结果。
- 任务结果含 progress、result、lifecycle; 私有字段(以 _ 开头)永不出现在
  公开任务 API——不要向作者转述内部字段。

## 关键工作流触发端点(全部要求当前项目 novel_id)

- 深度导入: POST /api/imports/deep;分阶段 /stages/scenes|world-objects|plot-structure;
  恢复 /deep/resume;放弃 /deep/abandon。
- 大纲: POST /api/outline/story-outline/generate(总纲)、/generate(P20 三层)、
  /analyze(手动分析, 需先 context/confirm 确认参考资料);apply 见
  /generate/apply、/story-outline/generate/apply。
- 写作: POST /api/writing/generate、/semantic-reviews、/targeted-revisions、
  /conflict-checks/{id}/ai-review-task;采用 POST /drafts/{id}/adopt。
- 世界: POST /api/world/generation-center/suggestions/task、
  /alias-relations/extract(需 context_confirmation_id)、
  /entities/fusion-suggestions;地图册 /api/world/map-atlas/{novel_id}/runs。
- RAG: POST /api/rag/rebuild、/retry-embeddings。

## 轮询与恢复纪律(agent 侧)

1. 触发前: 确认当前项目; 需要参考资料确认的工作流先做
   POST /api/context/confirm(否则任务会被拒)。
2. 触发后: 用任务 ID 轮询; 页面隐藏/离开时前端会暂停轮询并持久化
   localStorage(novel_active_workflows_v1)——不要重复触发同一工作流,
   先查有无活跃任务(任务合并 coalescing 会拒绝重复提交)。
3. 失败: 先读任务 error_message(脱敏文案)与 available_actions;
   可重试类错误(超时/限流)按 retry;manual_resume 类引导作者恢复或放弃。
4. 取消: 说明「已保存的阶段结果仍保留」; 不要声称可以撤销已采用内容。

## 诊断(次级入口, 用户语言)

- 「后台任务失败, 请稍后重试」= 通用失败文案; 具体原因在服务端日志,
  agent 不猜测, 可建议作者稍后重试或联系检查运行日志。
- 状态 unknown = 「状态暂不可用」, 不是失败; 保留卡片, 稍后再查。

## 与 dsh-rebuild 的关系

- 任务真相源仍是 PG async_tasks; DSH 运行时只承载 managed step 信封
  (LLM_STEP_EXECUTOR=dsh-sdk 时)。任务语义、恢复、合并行为与此前一致。
