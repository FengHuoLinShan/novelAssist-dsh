---
name: novelcraft-outline
description: "NovelCraft 结构面(M4): Scene/线程/篇章/总纲、结构健康信号、总纲生成与 P20。大纲类任务先读本 skill。"
whenToUse: 操作 Scene、生成/修订总纲、P20 结构创作、看结构健康信号时。
---

# NovelCraft 结构(M4)

## 资产与落点

- scenes/*.md(Scene 卡: chapter_ids/goal/core_conflict/must_happen/narrative_tag);
- structure/threads/ arcs/ foreshadowing/ reveal/(每资产一文件, N12)+ outline.md(总纲单文件);
- 结构创作: llm_step(spec=story_outline_generate / outline_generate / outline_analyze /
  scene_fusion_draft / p20_semantic_audit), 由 @novelcraft/outline 编排。

## 当前可执行面

- `available-now`: `novelcraft_llm_step` 可运行已注册 spec, 但只返回原始受 schema 约束的
  preview; `novelcraft_store_adopt` 只能采用已经存在的 draft/candidate。
- `core-only`: 总纲/Scene 生成、分析、融合与 P20 函数尚未组成 public capability/tool/client
  竖切; Skill 不应声称对话已把结果写入结构资产。

## 结构健康信号(N1 六键)

- Scene 四键(确定性, store computeSceneHealth):
  scene_unreviewed / scene_unassigned_chapter / scene_missing_setup / scene_needs_organize;
- 结构资产两键: structure_needs_review / structure_unassigned。
- 信号进收件箱(写作雷达面); 正文一变自动过期。

## 纪律

- 总纲 revisions 由 git 承接; 生成结果落 draft, 采用走 adopt+approval;
- narrative_tag 单轨(合并 narrative_function, D26#8); structure_meta 平铺顶层。
