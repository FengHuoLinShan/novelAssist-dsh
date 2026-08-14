---
name: novelcraft-core
description: NovelCraft 产品的不变量红线、架构分层与 dsh-rebuild 集成边界。任何涉及 NovelCraft 项目数据的任务(世界/大纲/写作/导入/RP)必须先读本 skill, 再读对应领域 skill。
whenToUse: 用户要求操作 NovelCraft 项目数据、触发 AI 工作流、解释设计约束, 或不确定某项操作是否被允许时。
---

# NovelCraft 核心不变量(agent 版红线手册)

## 一句话架构

NovelCraft = FastAPI 网关(账户/OIDC/owner/novel_id/DB/schema/CAS) + PostgreSQL(90 表,
39 迁移) + Vue 前端(作者与 RP 双入口) + **DSH 运行时承载共享 AI 基础设施**
(managed_llm_step 工具 + loopback /steps, ADR-0014)。DSH 是信封/编排层,
**不是事实源**——事实只在 PG, 采用只经作者确认。

## 不可违反(违者立即停止)

1. **novel_id 隔离**: 任何查询/任务/恢复不得跨项目读写; agent 一次只为一个
   project 工作; 切换项目 = 新的确认上下文。
2. **密钥保护**: agent 永不接触账户 Key; Key 只在 FastAPI 进程
   (secret-free snapshot seam)。不得向用户询问/转述任何 Key。
3. **AI 不越权**: LLM 输出只进待处理建议/预览/候选; 已采用资产的写入必须经
   作者显式确认后的 apply/confirm 端点(CAS + provenance 重验)。agent 不得
   绕过确认直接改库或改已采用数据。
4. **确定性编排**: 业务 LLM step 只在确定性工作流内执行; agent 只编排
   「工作流的触发与验收」, 不代替工作流内部的上下文编译/materializer。
5. **用户语言**: 与作者沟通用中文用户语言; 不暴露 novel_id、task_type、
   raw JSON、prompt、token、内部枚举; 诊断信息进次级入口。
6. **回滚与历史**: 已采用对象不硬删除(项目永久删除除外); 修改走 revision/
   CAS; 未保存的草稿与任务进度不得因导航/刷新丢失。

## 结果语义(必须区分)

| 语义 | 含义 | agent 可做的动作 |
|---|---|---|
| 待处理建议 | LLM 输出等作者审核 | 列表/汇总/解释/等待确认 |
| 预览(preview) | 可编辑、未采用 | 展示/编辑/等待 apply |
| 已采用资产 | 正史/正式 | 只读; 修改需走既有流程 |
| 候选正文(candidate) | 未采用 AI 文本 | 审阅/放弃/等待作者采用 |

## dsh-rebuild 集成边界(ADR-0014)

- 执行开关 `LLM_STEP_EXECUTOR=local|dsh-sdk`(默认 local)。dsh-sdk 模式:
  FastAPI 经 deepseek-harness-sdk 启动 DSH 运行时(每 novel_id 一实例),
  运行时内 novelcraft-runtime 插件提供 managed_llm_step 工具与 loopback
  POST /steps; 真实 provider 调用由 FastAPI /internal/llm/generate 回调执行。
- 26 个 run_managed_* 调用点已接入 dsh 通道; 7 处有意直调保持 local
  (interaction 流式/回顾、map_atlas 空间事实与规划、生成中心 chat)。
- 范围边界与缺口见 docs/agent/dsh-rebuild/功能对照清单.md §6——引用它,
  不要口头扩大已实现范围。

## 关键文档(回答具体问题前先读)

- AGENTS.md(仓库硬约束)/ CLAUDE.md(开发导航)/ CONTEXT.md(领域词汇与语义)
- docs/agent/dsh-rebuild/功能对照清单.md(357 端点/90 表/34 工作流/验收状态)
- docs/adr/0014-dsh-sidecar-ai-infrastructure.md(集成架构与修订)
- docs/prompts/Prompt体系设计.md(工作流与输出契约)
- docs/product/user-personas.md(画像 A 作家 / 画像 B RP 用户)

## 与作者协作的确认协议

- 破坏性/采用类动作: 先展示「将写入什么/影响范围/来源/可回滚标记」,
  得到作者明确同意后才触发对应的 apply/confirm 端点。
- 低置信、冲突、无法消歧的结果: 保留在待处理区并向作者解释, 不擅自选择。
- 每次会话开始: 确认当前项目(作者选哪个作品), 不跨项目混用上下文。
