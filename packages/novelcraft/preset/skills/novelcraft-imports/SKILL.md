---
name: novelcraft-imports
description: NovelCraft 深度导入流水线: 上传限制、三阶段(Scene 切分→世界对象/别名关系→剧情结构)、授权快照、恢复/放弃、待处理复核。导入类任务先读本 skill。
whenToUse: 作者要导入作品、跑深度导入、复核导入结果、恢复中断的导入时。
---

# NovelCraft 深度导入

## 入口与限制

- 上传: POST /api/imports/upload; 仅 .txt/.epub/.html/.htm/.mobi/.azw3,
  ≤50MB; import_records 只存元数据不存原文。
- 深度导入: POST /api/imports/deep(三阶段流水线)或分阶段
  /stages/scenes | world-objects | plot-structure。
- 恢复: POST /api/imports/deep/resume;放弃: /deep/abandon(返回清理摘要)。

## 三阶段(与结果语义)

1. **Phase1 Scene 切分/深化/融合**: 1a 主窗口切分 + anchor repair +
   continuous-gap recovery; 1b 语义补全; 1c 边界审查与综合。结果 = Scene
   candidate/draft(source=deep_import, 带 auto_ingested/workflow/证据/回滚元数据)。
2. **Phase2 世界对象/别名关系**: 2a 对象抽取(scene_entity_extraction.md,
   每 Scene 并发 25); 2b 别名与关系(alias_relation_extraction.md,
   只输出本 Scene 增量)。结果 = candidate + needs_review, 不自动覆盖已采用。
3. **Phase3 剧情结构**: 结构资产带 workflow 溯源。

## 授权与复核纪律(agent 必守)

- 首次启动需持久化授权快照(user_authorized_pipeline + authorization_confirmed);
  授权范围在任务保存后不可变。
- 规则明确且可回滚的结果可自动采用; 冲突/低置信/无法消歧 → 待处理。
- 导入后的待处理项(对象/别名/关系/Scene)必须作者逐项或分批确认;
  agent 复核时给出来源 Scene 与证据, 不替作者决定采用/忽略。
- 失败降级: Phase1b provider 失败 → 空语义进复核; Phase2b 失败只降级不丢对象;
  Phase1a 重叠 → 整章 fallback, 不部分采用。

## 与 dsh-rebuild 的关系

- Phase2a 抽取 step 已接入 dsh-sdk 通道并验收(见功能对照清单 §6)。
