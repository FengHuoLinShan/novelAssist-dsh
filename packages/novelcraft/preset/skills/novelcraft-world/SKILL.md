---
name: novelcraft-world
description: NovelCraft 世界对象/别名/关系/世界书(M4 文件夹形态)+ 生成中心五模式。世界类任务先读本 skill。
whenToUse: 操作世界对象、复核待处理建议、生成中心对话/收束/探索/检修、世界书提案时。
---

# NovelCraft 世界(M4)

## 资产与落点

- 已采用对象: world/objects/*.md(canonical; aliases/tags/relations 在 frontmatter,
  N11/N13); 待处理建议: world/pending/*.md(队列即目录)。
- 别名不建新对象(R1); 已采用不硬删(git); 关系同向同型 create-or-merge。
- 世界书: bible/*.md(frontmatter status draft/canonical); 发布走 adopt+commit;
  页面建议是整页提案, apply 前重验 baseline。
- 确定性操作经 @novelcraft/world 的 CRUD 面; 合并/拆分经 @novelcraft/store
  (已采用合并需二次确认 R37)。

## 生成中心五模式(§19: 不再是并列 UI, 是编排脑按意图调用的内容手步骤)

| 作者意图 | 调用 |
|---|---|
| 自由共创对话 | llm_step(spec=world_creation_chat), 不写资产 |
| 「把这几页设定收束一下」 | llm_step(spec=world_convergence) 只读汇聚 |
| 「还有什么可挖的」 | llm_step(spec=world_exploration) ≤3 个一跳缺口 |
| 「检修这一页」 | llm_step(spec=world_semantic_inspection) findings 供复核 |
| 对象建议 | llm_step(spec=world_core_entity) → world/pending(不自动采用) |
| 页面提案 | llm_step(spec=world_bible_page / world_bible_new_page) → bible draft |

## 复核纪律

- 待处理建议 → 收件箱信号卡(四动词: 采纳/打回/改一改/先放着); 采纳必过 approval。
- 打回必带理由(进 calibration.md); 低置信/冲突保持待处理。
