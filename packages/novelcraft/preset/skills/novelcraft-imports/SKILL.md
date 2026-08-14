---
name: novelcraft-imports
description: NovelCraft 深度导入(M4 六阶段): 文本停靠、计划授权、Scene 切分/补全/融合、实体/别名关系、结构分析、去重 L0–L4 与恢复。导入类任务先读本 skill。
whenToUse: 作者要导入作品、跑深度导入、复核导入结果/去重报告、恢复中断的导入时。
---

# NovelCraft 深度导入(M4)

## 入口与限制

- 拖文件(DSH 网页原生接收)或粘贴 → 统一转 .txt/.md 停靠到 imports/(D9a,
  不保留原格式); 文件夹守望 v1 不做。
- 六阶段由 @novelcraft/imports 的确定性函数执行: planImport(授权快照,
  authorization_confirmed 强制)→ sliceChapterBatch(1a)→ enrichSceneBatch(1b)
  → fuseSceneBatch(1c)→ commitScenes(provenance_key 幂等)→ extractEntityBatch(2a)
  → aliasRelationBatch(2b)→ analyzeStructure(3)→ dedupReport/applyDedup(L0–L3)。
- 编排真相 = .assistant/checkpoint.json; 重跑幂等(provenance_key/entity_key 跳过),
  resumeImport 给续跑说明; 每步资产变更 = git commit。

## 阶段语义(M4 落点)

1. **地图(1a–1c)**: 候选只在内存/checkpoint; commitScenes 落 scenes/*.md
   (status=draft, provenance_key sha256 与来源顺序无关); 锚点冲突 fail-closed;
   narrative_tag imported→draft(截断 32)。
2. **世界(2a/2b)**: 候选落 world/pending/*.md(entity_key 去重, 同名同型
   canonical ≥0.88 复用); 别名只附着不建新对象; 关系 create-or-merge。
3. **结构(3)**: 同 workflow 且置信 ≥0.96 才自动应用, 落 structure/ 目录;
   低置信仅计数报告。
4. **去重(L0–L3)**: 报告一次确认(§6.1 形态); applyDedup 需 approval;
   候选态合并可逆(source 置 merged + merged_into, 证据并入 target)。

## 授权与复核纪律(agent 必守)

- planImport 未 confirmed 抛错; 授权范围写入 checkpoint 后不可变。
- 降级条款(policy.yml): 1b 失败空语义进复核; 2b 失败只降级不丢对象;
  1a 重叠整章 fallback 不部分采用。
- 低置信/冲突/无法消歧 → 收件箱信号, 不替作者决定。
