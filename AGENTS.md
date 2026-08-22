# AGENTS.md

本文件是 novelAssist-dsh(M4 DSH 插件族 monorepo)所有编码 Agent 的硬约束与协作协议。
用户指令优先, 但不得绕过安全、工作区隔离、真实数据保护或危险操作确认。

## 架构铁律(不可违反)

1. **核心包零 DSH 运行时依赖**: `packages/novelcraft/*` 的 13 个核心包是纯 TS 确定性库,
   不 import 任何 `@deepseek-ai/*`; DSH 接触面唯一收敛在 `@novelcraft/dsh`。
2. **文件是唯一真相**: 每书一个 git 仓库(vault); 资产 = frontmatter 文件 + git commit,
   派生索引任何时刻可全量重建; git 本身就是回滚面。不另建数据库/队列。
3. **adopt 必过 approval(fail-closed)**: 采用类资产写入由助手 agent 经 DSH approval
   (allowed-once 只放行一次, rejected/cancelled/unavailable 一律拒绝); 客户端 RPC 通道
   (authority=loopback)只读信号 + 记录决定, **不写资产**。
4. **核心包不得回头改接口, 只做加法**: 新文件 + 新导出; 阶段函数保持可测
   (MockProvider/MockApproval 注入)。稳定 seam 见 `packages/novelcraft/README.md`。
5. **内容手受控**: llm_step 必须由确定性业务工作流编排, 带 output_schema/预算/超时/journal;
   不得自主选工具、跨模块编排或绕过确认。普通 LLM 输出只进待处理/临时预览。
6. **Key 与 secret**: Key 只走 DSH credentials 子系统; `.assistant/llm.yml` 只存模型名与
   参数(N5); 不落盘、不记录、不返回 Key。
7. **trace contract 锁编排纪律**: 深度导入等编排走 `@novelcraft/trace` 事件词表 +
   `@novelcraft/imports` 的 `runDeepImport` seam; adopt 序列/checkpoint/分片/降级逐条可断言。
8. **父仓库 ai-writing-assist 只读(用户明确指示, 2026-08-14)**: 不得反向改动父仓库
   `ai-writing-assist`(含其 main 分支)——不回写、不退役、不同步、不 cherry-pick;
   一切改动只发生在 novelAssist-dsh 本仓库。

## 测试与验证

- vitest 行为契约 + trace contract; 断言注释引规则编号(R#)/裁定编号(N#)。
- 完成标准: `npm test` 全仓测试全绿 + `npm run typecheck` 零错误。
- 构建按拓扑序(vault→trace→store→llm-step→…), 见 `docs/agent/dsh-rebuild/跨会话交接.md`。

## 协作与提交

- 只在 novelAssist-dsh 的 **main** 分支提交, push 到 origin(https://github.com/FengHuoLinShan/novelAssist-dsh.git)。
- 危险操作(删除/合并/废弃)保留二次确认; 不得 force push main、`reset --hard`。
- 旧引擎(FastAPI/PG/Vue)已退役: 需要时 checkout annotated tag `old-engine`, 不回写、不复活。
- 父仓库 `ai-writing-assist` 只读(铁律 8): 一切 push/分支/文档操作只在 novelAssist-dsh 本仓库。

## 停止并报告

- 需要用户确认 / Spec 矛盾 / 外部依赖连续 3 次不可用 / 同一测试修复 3 次仍失败 /
  需要未经确认的新架构。
- 立即停止: 真实数据丢失风险、工作区(`novel_id` 等价物 = vault 根)隔离泄漏、安全规则绕过、
  未确认的破坏性 Git 操作。
