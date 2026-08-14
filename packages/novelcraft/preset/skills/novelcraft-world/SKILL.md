---
name: novelcraft-world
description: NovelCraft 世界设定领域: 世界对象/别名/关系与待处理建议、世界书页面与草稿、生成中心共创、作者问答 world.ask、实体融合与手动补抽、世界书简介。世界类任务先读本 skill。
whenToUse: 作者要整理世界对象、审核待处理建议、共创设定、查问世界事实、维护世界书时。
---

# NovelCraft 世界设定

## 事实模型(简明)

- 对象根表 core_entities; 高频类型有 1:1 profile(species/faction/location/
  rule/item/secret); 别名内联在 content_json.aliases, 不建重复对象。
- 关系 entity_relations(canonical 边幂等); 人物 characters + 人物知识
  character_knowledge(稀疏覆盖)。
- 待处理: creation_suggestion_queue(创设建议)、conflict_check_queue(冲突)。
- 世界书: world_bible_pages(已采用组织页) + page_drafts(可丢弃工作稿) +
  page_revisions(发布即 revision); 简介 synopsis 是已采用派生资产
  (editable=false, rollback=true), 只服务作者。

## 工作流

1. **待处理建议**: GET /api/world/suggestions; 处理动作 confirm /
   edit-confirm / merge / resolve-as-alias / reject(全部等作者决定)。
   低置信或有未决项时提示「请核对」。
2. **生成中心**(作者共创, 不写库): chat(自由共创, 只返回 reply)、
   convergence(收束, 只读)、exploration(相邻缺口, 最多 3)、
   semantic-inspection(当前页检修); 结构化建议走
   /generation-center/suggestions/task(待处理队列)。世界核心收束产生
   world_core_checkpoint(不可采用)与 world_adoption_package(作者显式保存)。
3. **world.ask**: POST /api/world/ask-world, 只据当前项目作者可见证据回答
   (citation_key 引用); 无证据拒答(no_answer=true); 回答可另存为建议,
   不自动写设定。
4. **实体融合建议**: POST /entities/fusion-suggestions;应用需 confirmed=true
   (canonical 合并需 allow_canonical_merge/alias)。
5. **手动别名/关系补抽**: POST /alias-relations/extract, 必须先有新鲜的
   context_confirmation_id;结果 candidate + needs_review, 不自动覆盖。
6. **世界书简介**: /bible/synopsis/refresh(异步), 修订可 restore;
   自动维护开关单独控制。

## agent 纪律

- 世界事实的唯一权威是已采用资产; 生成中心的对话/收束内容不是事实,
  除非作者显式保存/采用。
- 问答只引用服务端给的来源, 不凭模型记忆补设定; 无证据就明确说「证据不足」。
- 待处理建议: 解释每个建议的来源/影响/冲突点, 批量确认前逐项征得同意。
- 别名只挂已有对象; 不创建重复实体。
