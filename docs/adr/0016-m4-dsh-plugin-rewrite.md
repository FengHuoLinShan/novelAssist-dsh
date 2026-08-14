# ADR-0016 — M4 级彻底重写: NovelCraft 作为 DSH 插件族与文件夹真相产品(自主智能式作家助手)

- **状态**: Accepted(2026-08-14, 用户确认: 按本 ADR 进入 M4 重构开发; 开发在新 worktree
  `codex/m4-dsh-plugin-rewrite` 分支进行, dsh-rebuild worktree 的残留改动保留不动)
- **编号说明**: 本文档在 dsh-rebuild worktree 起草时为 ADR-0015; 因 main 的 docs/adr 已有
  另一份 ADR-0014(世界对象图片), 而侧车 ADR(0014-dsh-sidecar-ai-infrastructure)从未入
  main, 并入新分支时取号 **0016** 避免编号冲突。
- **日期**: 2026-08-14
- **取代**: 侧车 ADR(`0014-dsh-sidecar-ai-infrastructure`, 仅存在于 dsh-rebuild 分支,
  未入 main)的实施路线(Phase A–E 侧车方案)。该 ADR 保留为历史记录; 其修订三的鉴权实现
  (account_agent_tokens + 代理服务令牌)属旧引擎侧, 随旧引擎退役。本 ADR 通过后,
  侧车 ADR 标记 Superseded(已在该分支完成)。
- **设计依据**: `docs/agent/dsh-rebuild/自主智能式作家助手设计.md`(决策 D1–D25 已确认)

## 背景

dsh-rebuild worktree(分支 `dsh-rebuild`, 31 commits, 未合并)按 ADR-0014 完成了
「DSH 侧车替换共享 AI 基础设施」的 Phase A–D, 后被用户叫停。用户随后裁定最终形态为
**M4 级彻底重写**: 一切皆插件 + 文件夹真相 + profile 即产品, 引擎/PG/Vue 全部退役;
并明确「忽略原项目铁律限制」做设计。本 ADR 把该裁定与设计成果落为仓库级决定,
逐条声明对现行铁律的偏离, 并裁定旧 31 commits 的去留。

## 决策

### 1. 产品形态: DSH profile + @novelcraft 插件族

- 产品 = DSH + 13 个 `@novelcraft/*` Cordis 插件 + 一个 profile bundle(设计文档 §22.3);
  插件之间只经 DSH seam(storage/llm/jobs/approval/credentials/scope/client-modules)互连,
  不互相 import。
- 单用户自用, 不保留账号隔离(D11); 一本书 = 一个工作区, 会话与工作区绑定(D17)。

### 2. 文件夹真相(folder-as-truth)

- 每书一个工作区 `~/Novels/<书名>/`(设计文档 §22.2 目录树): 正文/Scene/对象/待处理/
  结构/记忆/世界书/导入全部文件化; **90 表语义映射为文件 + git**(CAS = commit,
  待处理状态机 = pending/ 目录 + frontmatter, 已采用不硬删除 = git 历史)。
- sqlite domain KV(`ctx.storage`)只是**派生索引, 可全量重建**; 文件是唯一真相。

### 3. 模型与凭据(D13/D14)

- 编排脑默认 deepseek-v4-flash + high, **保留 DSH 原生模型切换与多模型接入**;
  内容层同样经 DSH 切换模型; 支持双模型/多模型**预设保存**。
- Key 全部走 DSH credentials 子系统, 不进工作区文件; llm_step 直连 ctx.llm,
  无 FastAPI 内部桥。
- **无隐私模式**(D14): 编排脑可见章节原文; 纪律条款进 novelcraft-core skill
  (原文不进任何产出、不对外转发)。

### 4. 深度导入与自主助手(设计文档 §5–§11, §17)

- 深度导入从确定性流水线改为 **DSH 目标循环 + 六阶段**(摄入/意向/地图/世界/结构/守望);
  去重 L0–L4 默认激进(D18: 无显式拨杆, 自然语言可临时调整, per-book 校准收敛)。
- 六雷达(摄入/去重/建议/剧情/风险/写作)+ 收件箱 + 宠物; 采用类写操作必过 DSH approval
  (fail-closed)。
- 写作台四模式; 正文编辑外置于 Word, 项目只做文本停靠(D8/D9/D9a); 单屏分屏(D10)。
- 自然语言微工作流首批 6 条(D7); 无每日摘要, 事件/阈值触发(D6)。

### 5. 落地顺序与退出点(设计文档 §16)

- R0–R7: Spec 提取 → 内核(vault/store)→ 内容手(llm-step)→ writing 垂直切片 → imports
  → 其余领域 → assistant → client + 发布。
- **旧引擎保留至 R4 之后才退役**; R0–R3 失败可退回 M1(HTTP 插件)/M2(MCP 挂载)零损失。
- 旧 PG 数据**不迁移**(D15), 只要求行为/功能等价; 如需留存, R4 后提供一次性导出工具
  (不进产品)。

### 6. 开源分发(设计文档 §21/§22)

- monorepo `packages/novelcraft/*`, 发布拆 npm 包(D22); `novelcraft-starter` profile
  bundle 一键安装; mock 测试面随包发布。
- DSH 锁 0.1.0-rc.6 起步, seam 兼容矩阵写进 starter(D21)。

## 对现行铁律的逐条偏离声明

| # | 现行铁律(来源) | 偏离 | 理由 | 替代保障 |
|---|---|---|---|---|
| 1 | 不实现自治/多 Agent 运行时; LLM step 必须由确定性业务工作流编排(AGENTS.md) | M4 以 DSH goal/workflow/subagent/ralph 为核心编排, agent 自行编排任务 | 用户指示: agent 思维模式即目标形态 | 写正史必过 approval(fail-closed); llm_step 必带 output_schema/budget/timeout/journal; trace contract 锁编排纪律; policy.yml 锁阈值与降级条款 |
| 2 | 带 novel_id 的业务 LLM 服务必须经 `open_project_llm_client()` 与项目快照(AGENTS.md) | M4 无引擎, llm_step 直连 ctx.llm + DSH credentials | 引擎退役 | Key 只存 DSH credentials, 不进文件; per-book 预设引用; 内容质量只由内容手模型决定 |
| 3 | LLM 输出只进待处理/预览; 自动流水线需持久化授权(AGENTS.md) | 去重 L0–L3 自动合并候选(激进, D4/D18) | 合并可逆, 作者确认负担是旧流程最大痛点 | 候选态合并免费可逆; 已采用走 merge_records + split; 一次确认报告; 打回理由进 per-book 校准 |
| 4 | 默认栈 FastAPI + PG async 队列 + Vue 3(ADR-0009) | 全部退役, 换 TS monorepo + DSH | M4 目标形态 | ADR-0009 后续标记 Superseded(另立说明); 旧仓库归档为 Spec |
| 5 | 跨模块只依赖 contracts/facade/DI port(AGENTS.md) | 新库跨模块依赖 DSH seam(service/provider/consumer) | 代码库整体更换 | seam 依赖清单随 starter 发布; 插件独立版本化, 缺陷可单包回退 |
| 6 | 文稿导入白名单 .txt/.epub/.html/.htm/.mobi/.azw3 ≤50MB(AGENTS.md) | 拖拽/粘贴统一转 .txt/.md(D9a), 纯文本解析 | 编辑外置后导入面变化 | 大小上限与格式约束进 policy.yml; 原白名单精神保留 |
| 7 | 世界对象图片门禁(6MiB/WebP, 受限例外)(AGENTS.md) | v1 砍掉对象图片(D19) | 无 Web 上传面; 未来按需独立插件 | 未来恢复时按原门禁标准实现 |
| 8 | 危险操作保留二次确认(AGENTS.md) | 保持 | — | approval(fail-closed)+ git 可回滚 |
| 9 | 生产只经 release.sh 部署 origin/main 固定 commit(AGENTS.md) | M4 发布形态 = npm 包 + profile bundle, 无服务器部署 | 产品形态改变 | 仓库协作协议(不直接提交 main、分支评审)保留 |
| 10 | novel_id 隔离为所有读写一等键(AGENTS.md) | 隔离载体改为工作区 + 会话绑定 + scope 子系统 | 多租户退化为一人多书(D11) | 每书一工作区物理分区; 跨书操作需显式切换工作区 |

## 旧 dsh-rebuild 31 commits 去留裁定

- **复用为 Spec/参考**: 桥接协议、运行时池、skills 9 册、presets 4 套、契约门禁、
  `dsh-plugin/test/mock-engine.mjs`——skills/presets/mock 面直接平移, 其余作 Spec。
- **改造平移**: `dsh-plugin/host` 8 工具的设计价值保留, 实现按插件族(§22.3)重切。
- **废弃**: Phase A–E 路线(HTTP 侧车)、引擎侧 dsh-sdk 分支(`LLM_STEP_EXECUTOR`)。
- worktree 两个调试残留(`_dbg_components` 等)**直接回滚**(D24)。

## 结果(预期)

- 新增: TS monorepo `packages/novelcraft/*`; R0 产出 `specs/`(资产 schema、prompt/spec
  目录、规则目录, 设计文档 §24); `novelcraft-starter`。
- 退役时间线: R4 后 FastAPI/PG/worker/docker-compose/Vue console 退役; 旧仓库归档为
  Spec(不作运行时代码)。
- 测试: 行为契约(对 R0 规则目录)+ trace contract + vitest mock seam(设计文档 §15)。
- 验收: 全局 DoD 见设计文档 §25。

## 未采用方案

- **M1(HTTP 插件外挂, 即档 A 现状)**: 引擎仍在, 编排升级有限; 保留为过程形态与退出点。
- **M2(MCP 挂载)**: 零重写但仍是外部进程; 保留为过程形态/外部客户端(Claude Desktop 等)
  可选面。
- **M3(强制层 TS 化但保留 PG/引擎进程)**: 半吊子——数据迁移负担仍在, seam 收益拿不全。
- **隐私模式(编排脑不可见原文)**: 用户明确不做(D14)。

## 待确认事项

1. 本 ADR 状态 Proposed, 需用户评审确认后转为 Accepted 方可启动 R0。
2. 通过后联动: ADR-0014 标记 Superseded; ADR-0009 的退役另立说明;
   `docs/architecture/architecture-documents.toml` 与 ADR 索引同步;
   dsh-rebuild 分支的合并策略(§23: 继续在该 worktree 开发, 不先合并 main)。
