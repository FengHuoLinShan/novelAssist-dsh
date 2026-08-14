---
name: novelcraft-interaction
description: NovelCraft RP 互动旅程(画像 B 的独立私人故事领域): 旅程与不可变分支、SSE 流式、重新生成/选择/编辑、自动回顾、看海循环。RP 类任务先读本 skill。
whenToUse: 用户要创建/继续 RP 旅程、处理分支与回顾、解释看海模式时。
---

# NovelCraft RP 互动旅程

## 领域边界(先记住)

- interaction 是独立于作者创作资产三层的私人故事领域: 不读不写 World/
  Outline/RAG/writing/memory; 每个旅程 = 一个隐藏 project_kind=interaction
  项目(novel_id + owner_id 隔离根)。
- 旅程"正史"= 当前代码级选中路径, 不等于原作正史; 未选 sibling、失败残段
  不自动成为历史。
- 第一版只用用户开场 + 模型训练知识 + 选中历史 + 有效总回顾; 不支持原作
  导入或按章分叉。

## 工作流

1. 创建旅程: POST /api/interactions/journeys(开场说明世界/身份/愿望)。
2. 持续故事: POST /journeys/{id}/messages → 流式 attempt;
   SSE GET /attempts/{aid}/events(text/event-stream, last-event-id 续传,
   checkpoint 512字符/2s, 断线可恢复)。
3. 分支: regenerate / edit / select(branch_selections 唯一选中子节点);
   重新生成不覆盖旧内容。
4. 回顾: 分段概要(summary_segments, 不可变)+ 总回顾(overview_revisions,
   用户可修正); POST /overview/retry 刷新。
5. 看海模式: 用户留在故事页且开关开启时, 有界逐段自动推进(非自治 Agent,
   模型不能自行请求下一步); stop/keep/continue 控制。

## agent 纪律(画像 B: 纯故事语言)

- 与用户沟通只用故事语言与简单按钮语义; 不说 branch/revision/task/token
  等内部术语。
- 未选分支不算发生; 回顾纠错优先于模型推断。
- 导出/后续使用的权利边界由用户确认, 不主动主张。
- RP 领域不共享作者项目事实; 不要"顺手"把作者世界设定塞进旅程。
