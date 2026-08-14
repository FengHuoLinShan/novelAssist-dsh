---
name: novelcraft-outline
description: NovelCraft 大纲领域: 小说总纲(revision 体系)、P20 当前层创作(剧情线/篇章纲/Planned Scene)、手动结构分析、Scene 工作台与融合。大纲类任务先读本 skill。
whenToUse: 作者要规划总纲、剧情线、篇章纲、Scene, 或做结构分析时。
---

# NovelCraft 大纲

## 事实模型(简明)

- 总纲: story_outline_heads(每项目唯一 current 指针) + 不可变 revisions;
  采用 = 写 source=ai_generated 的新 revision(CAS + idempotency key)。
- 剧情线 plot_threads(作者侧信息推进聚合根) → 篇章纲 outline_arcs(只引用
  既有剧情线) → Planned Scene scenes(最小叙事单元, 可跨章)。
- 伏笔/揭示: foreshadowing_plans / reveal_plans 是信息推进的确定性投影,
  不独立创作。
- Scene 融合建议 scene_fusion_suggestions(pending/adopted/dismissed/stale)。

## 工作流

1. **总纲**: POST /api/outline/story-outline/generate(strict preview, 三类审计:
   证据/外部正史污染/世界规则) → 作者编辑 → /generate/apply(只接受
   task_id + 编辑后内容 + CAS base)。P20 三层同模式: POST /api/outline/generate
   (target=plot_thread|outline_arc|planned_scene)。
2. **手动分析**: POST /api/outline/analyze —— 必须先完成参考资料确认
   (context/confirm); 输出只读 Markdown, 无 apply, 不写资产。
3. **Scene 工作台**: 融合预览 /scene-workbench/fusion/preview(-task),
   保存显式; 拆分/重排走确定性端点。

## 审计与预算(不要绕过)

- 候选+审计+最多两次语义修订共享同一阶段预算(30 分钟/1800s)。
- 审计发现的问题必须逐项执行修正或清空引用标记 uncertain; 作者明确排除的
  内容不得以问题/选项/例子形式复活。
- P20 不跨层: 总纲方向冲突只报告, 不越权改写; 篇章纲缺剧情线返回
  needs_author_decision, 不暗建线程。

## agent 纪律

- 预览/分析结果都不可直接生效; apply 必须作者显式发起。
- 结构分析引用实际剧情线/篇章/Scene, 区分「资料支持 / 结构推断 / 建议」。
- 已物化章节的事实须有输入证据支持; 原创推进只能放未来并标注为提案。
