---
name: novelcraft-core
description: NovelCraft 产品的不变量红线、M4 架构(文件夹真相 + 插件族)与集成边界。任何涉及 NovelCraft 项目数据的任务(世界/大纲/写作/导入/RP)必须先读本 skill, 再读对应领域 skill。
whenToUse: 用户要求操作 NovelCraft 项目数据、触发 AI 工作流、解释设计约束, 或不确定某项操作是否被允许时。
---

# NovelCraft 核心不变量(agent 版红线手册, M4)

## 一句话架构

NovelCraft = DSH + @novelcraft 插件族 + 每书一个工作区文件夹(ADR-0016)。
**文件夹是唯一真相**(章节/Scene/对象/结构/记忆/世界书全部文件化);
版本与回滚 = git; 派生索引(sqlite KV / rag-index.json)可全量重建。
DSH 是编排层, 不是事实源——写已采用资产永远经 approval(fail-closed)。

## 工作区(~/Novels/<书名>/)

```
book.yml                    项目档案(target_length/current_stage, N9)
chapters/{NNN}.md           正文(draft; Word 写完同步进来, D8/D9a)
chapters/pending/           候选正文(copy-on-adopt)
scenes/*.md                 Scene(s001…; chapter_ids/scene_chunks)
world/objects/*.md          已采用实体(canonical)
world/pending/*.md          待处理候选(suggestion queue = 此目录)
structure/{threads,arcs,foreshadowing,reveal}/ + outline.md
memory/events.jsonl         事件溯源(append-only, 幂等)
bible/*.md                  世界书(draft/canonical)
imports/*.md                导入原文停靠(统一 .txt/.md)
.assistant/                 policy.yml / llm.yml / calibration.md /
                            checkpoint.json / signals/ / reviews/ / merge-log.jsonl
```

## 不可违反(违者立即停止)

1. **书域隔离**: 一次只为一本书工作; 每书一个工作区(D17); 跨书需显式切换。
2. **密钥保护**: Key 只存 DSH credentials, 永不写入工作区文件(D13);
   不得向用户询问/转述任何 Key。
3. **AI 不越权**: LLM 产出只进 pending/候选/收件箱信号; 写正史必过 approval
   (fail-closed); adopt = git commit, 已采用不硬删(git 历史天然保留)。
4. **编排边界**: 内容质量只由内容手(llm_step, 用户选定模型)决定; 编排脑
   (默认 deepseek-v4-flash+high)只观察/计划/验证/复核/对话, 推理不承载内容质量。
   - 模型分工与预设(N20/D13): 编排脑切换直接用 DSH 原生模型切换(/model 或输入框模型
     入口, 会话即生效); 简单任务子代理 = deepseek-v4-flash(max effort)。
     内容手由「预设卡」承载: 预设面板选卡(写作日/导入日/精修校对等)写入该书
     .assistant/llm.yml 的 preset 键, 执行链(runStep/deepImport/propose/generate)自动
     注入 provider/model/参数; 重内容流程(如深度导入)以子代理发起时,
     agentOptions {provider, model} 取当前预设。Key 永不进预设与文件(铁律 6)。
5. **用户语言**: 作者语言沟通; 不暴露 raw JSON/内部枚举/文件路径细节;
   诊断信息进次级入口。
6. **降级与确定性**: 阈值/预算/降级条款在 .assistant/policy.yml(agent 必读、
   不得自创); 确定性规则(merge/CAS/状态机)由 @novelcraft/store 执行, 不得绕过。

## 结果语义(必须区分)

| 语义 | M4 落点 | agent 可做的动作 |
|---|---|---|
| 待处理建议 | world/pending/*.md、收件箱信号 | 列表/汇总/解释/等待确认 |
| 预览(preview) | chapters/pending/、bible draft | 展示/编辑/等待 adopt |
| 已采用资产 | canonical 文件(git 提交) | 只读; 修改走既有流程 + approval |
| 候选正文(candidate) | chapters/pending/*.md | 审阅/放弃/等待作者采用 |

## 关键文档(回答具体问题前先读)

- specs/(资产/规则/裁定: adjudications.md 是全部裁定的权威记录)
- docs/agent/dsh-rebuild/自主智能式作家助手设计.md(决策 D1–D27)
- docs/adr/0016-m4-dsh-plugin-rewrite.md
- packages/novelcraft/README.md(工程约定 + DSH seam 契约)

## 与作者协作的确认协议

- 破坏性/采用类动作: 先展示「将写入什么/影响范围/来源/可回滚标记」,
  得作者明确同意后才触发 adopt/merge(approval fail-closed)。
- 低置信、冲突、无法消歧: 留在待处理/收件箱并向作者解释, 不擅自选择。
- 每次会话开始: 确认当前书(哪个工作区), 不跨书混用上下文。
