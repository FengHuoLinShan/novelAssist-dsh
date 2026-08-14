---
name: novelcraft-writing
description: NovelCraft 写作工作台操作: 章节正文与版本、AI 正文候选(生成/续写/单角色 POV)、语义审查与定向返修、冲突检查、发布。写作类任务先读本 skill。
whenToUse: 作者要求写正文、生成候选、审查返修、处理冲突或发布章节时。
---

# NovelCraft 写作工作台

## 事实模型

- 正文真相源: writing_drafts 表, (novel_id, chapter_index, version_number)
  唯一; published 版本不可原地改, 修改产生新版本。
- AI 正文永远是 candidate(待审阅), 作者 POST /api/writing/drafts/{id}/adopt
  才进入工作稿/已发布。provenance 记录 source_confirmation_id 等。
- 版本历史 GET /api/writing/chapters/{chapter_index}/versions。

## 工作流

1. **正文生成**: POST /api/writing/generate(先 prepare_confirmed_ai_action
   确认参考资料)。模式: 完整替换 / 续写(锁定 base draft) / 单角色 POV
   (writing_pov_character: 输出 draft_prose + pov_state + uncertainties)。
   结果只进候选, 供作者审阅。
2. **语义审查**: POST /api/writing/semantic-reviews(冻结正文/合同的独立近读,
   findings 列表)。**定向返修**: POST /api/writing/targeted-revisions
   (finding-bound, 新候选 source=writing_targeted_revision)。
3. **冲突检查**: 规则检查 + AI 软判断(POST /conflict-checks/{id}/ai-review-task;
   逐项建议 POST /conflict-check-items/{id}/ai-suggestion-task)。AI 只追加
   软判断, 不自动修改正文。
4. **发布**: POST /api/writing/drafts(顺带 publish_chapter 任务)。发布失败
   时工作稿已保留——「工作稿已保留成功, 可以手动重试失败的步骤」。

## agent 纪律

- 生成/返修前: 确认参考资料(confirmation)已做且范围正确; 不越过作者确认
  直接采用任何候选。
- 候选审阅: 说明来源(工作流/模型)、与现有正文的差异点、author 需注意的
  低置信/uncertainties; 不替作者决定采用。
- POV 模式: director_only 内容不当作角色已知事实; hidden guard 的 passed
  不等于质量自动通过——如实传达 uncertainties。
- 冲突项: 只呈现规则证据与 AI 建议, 修复方式由作者选择。
