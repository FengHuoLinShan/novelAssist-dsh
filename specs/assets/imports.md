# imports 资产规格(R0 提取)

- 来源 commit: a257df23e
- 提取日期: 2026-08-14
- 提取范围:
  - backend/modules/imports/models.py
  - backend/modules/imports/schemas.py
  - backend/modules/imports/workflow_schemas.py
  - backend/modules/imports/llm_schemas.py
  - backend/modules/imports/adoption_policy.py
  - backend/modules/imports/deep_import_dedup.py
  - backend/modules/imports/workflow_runs.py
  - backend/modules/imports/scene_candidates.py
  - backend/modules/imports/scene_commit.py
  - backend/modules/imports/scene_fusion.py
  - backend/modules/imports/entity_extraction/scene_entity_config.py
  - backend/modules/imports/entity_extraction/scene_entity_checkpoint.py
  - backend/modules/imports/entity_extraction/scene_entity_snapshots.py
  - backend/modules/imports/entity_extraction/scene_entity_persistence.py
- 参考: backend/modules/imports/README.md、CLAUDE.md;docs/agent/dsh-rebuild/自主智能式作家助手设计.md §6、§6.1、§22.2、§24

## M4 落点总览(§22.2, imports 相关行)

| 旧语义 | M4 落法 |
|---|---|
| import_records | imports/*.md + imports/import-log.jsonl |
| imported_chapters(原文停靠) | imports/*.md;正文采纳后 → chapters/*.md |
| Scene 正式资产 | scenes/*.md(frontmatter: id/status/chapter_ids/evidence/content_hash) |
| 待处理实体候选 | world/pending/*.md(frontmatter: status/evidence/confidence/suggested_action) |
| 已采用实体 | world/objects/*.md(status: canonical) |
| 别名不建新对象 | object frontmatter `aliases: []` |
| 关系/反向关系 | relations 索引(可重建) |
| 结构资产 | structure/threads.md arcs.md foreshadowing.md |
| 授权快照 / 编排状态 / checkpoint | .assistant/checkpoint.json + .assistant/policy.yml |
| async_tasks / 进度 | session log + checkpoint.json + DSH jobs(长任务) |
| revision / CAS | git commit(adopt=一次 commit;content_hash 进 frontmatter) |
| 已采用不硬删除 | git 历史 + 墓碑文件 |

---

## ImportRecord(导入记录)(M4 落点: imports/import-log.jsonl + imports/*.md)

### 语义

记录每一次小说文件导入的结果元数据(不存正文), 用于导入历史、重复导入幂等与失败诊断。

### frontmatter 字段(import-log.jsonl 记录)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 导入记录稳定标识(UUID → slug) |
| novel_id | string | 是 | 所属书籍 |
| file_name | string | 是 | 原始文件名(basename 化) |
| file_type | enum | 是 | txt/epub/html/htm/mobi/azw3 |
| file_size | int | 是 | 文件字节数 |
| total_chapters | int | 是 | 解析出的章节总数 |
| imported_chapters | int | 是 | 成功导入章节数 |
| status | enum | 是 | 见状态机 |
| error_message | string | 否 | status=failed 时的脱敏错误信息 |

### 状态机

```
pending → processing → done
                     → failed
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | import_records.id | UUID → slug |
| novel_id | import_records.novel_id | FK projects.id |
| file_name | import_records.file_name | 写入前 basename sanitize |
| file_type | import_records.file_type | 白名单外拒绝 |
| file_size | import_records.file_size | ≤ 50MB |
| total_chapters | import_records.total_chapters | |
| imported_chapters | import_records.imported_chapters | |
| status | import_records.status | pending/processing/done/failed |
| error_message | import_records.error_message | 脱敏, 不含敏感配置 |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 幂等键: (novel_id, file_name) 在 status='done' 时唯一(partial unique index)——同书同文件只允许一条 done 记录(来源: models.py:64-74)。
- 文件类型白名单 `.txt/.epub/.html/.htm/.mobi/.azw3`, 上限 50MB;文件名不信任原始路径, 必须先 `os.path.basename` 防路径穿越(来源: CLAUDE.md:8-10)。
- 正文原文不得存入导入记录, 只存文件名/类型/大小/章节数/状态/错误信息(来源: CLAUDE.md:6)。
- 不长时间卡 processing;成功、失败、空内容都必须落到明确状态;失败保留可读但不泄露敏感配置(来源: CLAUDE.md:11-12)。

### 待定

- 【待定】import-log.jsonl 的每行粒度: 一条 import record 对应一行, 还是一文件多行;M4 下「文件」是否仍以单文件上传为主。

---

## ImportedChapter(导入章节停靠)(M4 落点: imports/*.md;正文采纳后 → chapters/*.md)

### 语义

导入解析出的章节正文的原始停靠, 是深度导入(Scene 切分/实体抽取)与正文 draft 之间的事实来源。

### frontmatter / 结构字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| chapter_index | int | 是 | 章节序号 |
| title | string | 是 | 章节标题 |
| content | string | 是 | 章节正文(导入原文停靠) |
| is_analyzed | bool | 是 | 是否已完成实体/关系提取 |
| import_record_id | string | 是 | 归属导入记录 |

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| chapter_index | imported_chapters.chapter_index | |
| title | imported_chapters.title | |
| content | imported_chapters.content | 导入原文, 非最终正文 |
| is_analyzed | imported_chapters.is_analyzed | |
| import_record_id | imported_chapters.import_record_id | FK import_records.id |
| novel_id | imported_chapters.novel_id | FK projects.id |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 导入原文与最终正文分离:imported_chapters 是来源停靠, 解析结果经 writing.facade.create_draft 写正文 draft, 二者不可混同(来源: README:11-12)。
- is_analyzed 标记深度导入是否已消费该章, 是增量导入/去重的输入(来源: models.py:115-120)。

### 待定

- 【待定】M4 下 imports/*.md 是否与最终 chapters/*.md 直接对应(一文件一章), 还是保留独立停靠层。

---

## Scene 候选(中间产物)(M4 落点: 工作区临时产物, 仅存 session log / checkpoint.json, 不落 scenes/)

### 语义

Scene 正式写入前的中间观察/融合候选(Phase 0/1a/1b/1c), 是「候选态」而非资产, 提交后即被正式 Scene 替代。

### 关键结构字段(SceneCandidate / FinalSceneCandidate)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| candidate_id | string | 是 | 候选标识(缺省按 phase-operation-source-chapters 派生) |
| source_round | enum | 是 | A / B(首轮/加固轮) |
| source_chapter_indices | list[int] | 是 | 来源章节(去重升序) |
| source_candidate_ids | list[string] | 是 | 融合来源候选集 |
| operation | enum | 是 | kept/merged/split/reordered/rewritten |
| quality | enum | 是 | high/low/failed |
| confidence | float | 是 | 0.0–1.0 |
| fallback_required | bool | 是 | 是否降级/保底产物 |
| needs_review / review_reason | bool / string | 是 | 复核标记与理由 |
| phase | enum | 否 | phase1b_fusion/phase1b_enrichment/phase1a_fallback/phase1c_fusion |
| payload / diagnostics | dict | 否 | 原始输出与诊断摘要(不含正文) |

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| — | 无持久表 | 候选仅存于 workflow/task result;见 scene_candidates.py:36-54、scene_fusion.py:388-398 |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 候选不直接写正式 Scene;必须先经 reducer 产 FinalSceneCandidate 再 commit(来源: scene_candidates.py:1-2、scene_fusion.py:134-137)。
- 融合 operation 归一: keep/merge/拆分/排序/重写 等中文别名一律归一到 kept/merged/split/reordered/rewritten(来源: scene_fusion.py:238-258)。
- 候选 payload/diagnostics 只保留摘要, 不保存正文/raw prompt(来源: README:208-210)。

### 待定

- 【待定】M4 下「候选」是否仍在 checkpoint.json 中显式持久化, 还是仅存在于编排脑会话内存。

---

## Scene 正式提交(Scene commit 语义)(M4 落点: scenes/*.md)

### 语义

深度导入把融合后的 Scene 候选幂等写为正式 Scene 资产(附证据、来源章节与精确正文 span), 是结构层事实。

### frontmatter 字段(scenes/*.md, 依据 §24.2 草案 + scene_commit._build_scene_data)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 稳定标识(scene_index 派生, 如 s012) |
| status | enum | 是 | 见状态机(commit 落 draft) |
| chapter_ids | list[int] | 是 | 来源章节 |
| title | string | 是 | Scene 标题 |
| goal / core_conflict | string | 否 | 目标/核心冲突 |
| emotional_beat | string | 否 | 情绪节拍 |
| must_happen / must_not_happen | string | 否 | 必发生/必不发生项 |
| narrative_tag | enum | 否 | draft/hook/inciting_incident/rising_action/climax/valley/transition/payoff |
| scene_chunks | list | 是 | 精确正文 span(见下) |
| evidence | list | 是 | {source, quote} 证据引用 |
| content_hash | string | 是 | 正文内容哈希(变更即更新) |
| provenance_key | string | 是 | 幂等键(sha256, 与来源顺序无关) |
| workflow / adopted_at | string | 是 | provenance 溯源 |

scene_chunks 子字段(SceneChunk):

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| chapter_index | int | 是 | 章节序号 |
| start_paragraph / end_paragraph | int | 否 | 段落范围 |
| start_offset / end_offset | int | 否(成对) | 精确字符偏移(必须同供同缺) |
| source_draft_id / source_content_hash | string | 否(成对) | 冻结正文来源绑定 |
| anchor_hash / anchor_excerpt | string | 否 | 切分锚点 |

### 状态机

```
candidate → draft(commit 写入)
draft → canonical(adopt)
canonical → deprecated(替换/删除, 软废弃, 不硬删)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | scenes.id | scene_index 派生 |
| status | scenes.status | commit 落 draft;outline 状态机 |
| chapter_ids | scenes.chapter_ids | 由 source_chapter_indices 生成 |
| title/goal/core_conflict/emotional_beat/must_happen/must_not_happen/narrative_tag | scenes.* | 同名列(见 _build_scene_data) |
| scene_chunks | scenes.scene_chunks | JSON, 精确 span |
| provenance_key | scenes.structure_meta.provenance_key | 幂等键落 structure_meta |
| evidence | scenes.structure_meta(workflow_id/confidence/needs_review 等) | 证据经 context 证据链 |
| source | scenes.source | 固定 deep_import |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 幂等键 provenance_key = sha256(workflow_id, candidate_id, source_candidate_ids 排序, fusion_operation, source_chapter_indices 排序), 与来源顺序无关(来源: scene_commit.py:40-59)。
- 幂等提交: 按 provenance_key 查已存在 Scene——存在非 deprecated → skip;只存在 deprecated → conflict 不写;否则 create(来源: scene_commit.py:165-217)。
- 精确 span 不重叠断言: 任何两候选在同章内 (start_offset, end_offset) 重叠即整体 fail-closed 拒绝(来源: scene_commit.py:245-285)。
- 冻结源覆盖断言: 一旦候选带冻结 draft/hash, 所有 chunk 必须精确且无空洞、从 offset 0 覆盖到正文末尾、hash 与当前 draft 一致、章节覆盖与 start/end 完全一致, 否则拒绝写入(来源: scene_commit.py:288-446)。
- 默认 status='draft'、source='deep_import';structure_meta 记录 workflow_id/provenance_key/confidence/needs_review/review_reason/语义字段状态(来源: scene_commit.py:449-564)。
- narrative_tag 归一: imported → draft, 截断 32 字符(来源: scene_commit.py:17、482-486)。
- needs_review 决定 adopted vs review;无 review 标记的工作资产才计 adopted(来源: README:112)。

### 待定

- 【待定】scenes/*.md 的 evidence 具体结构(§24.2 示例为 source+quote, 旧 context 证据链含 context_snapshot_id/claim_path);M4 是否保留完整双向证据引用需在 context 规格确认。

---

## DeepImportProgress / DeepImportStep(工作流进度状态机)(M4 落点: .assistant/checkpoint.json + session log + DSH jobs)

### 语义

深度导入/分阶段自动提取的进度投影, 用于前端展示、中断检测与恢复入口判断。

### 关键字段(DeepImportProgress)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| workflow_id | string | 否 | 业务 workflow 标识(与 task_id 一致) |
| workflow_type | enum | 是 | deep_import/scene_auto_extraction/world_object_auto_extraction/plot_structure_auto_extraction |
| stage | enum | 否 | scenes/world_objects/plot_structure(分阶段标识) |
| adoption_policy | string | 是 | user_authorized_pipeline |
| phase | enum | 是 | pending/running/done/failed |
| quality_status | enum | 是 | pending/complete/partial/failed |
| current_step | enum | 否 | scene_segmentation/entity_extraction/structure_analysis |
| total_steps / completed_steps | int / list | 是 | 3 / 已完成步骤列表 |
| interrupted / recoverable / recovery_required | bool | 是 | 中断/可恢复/需恢复确认 |
| degraded / degraded_reason | bool / string | 否 | 是否有批次降级及原因 |
| authorization_snapshot / llm_execution_snapshot / asset_summary | dict | 是 | 授权/LLM/资产结果快照 |
| checkpoints / phase_artifacts / acceptance_checks / progress_events | dict/list | 否 | compact 摘要(不含正文/API key/raw prompt) |

### 状态机(DeepImportStep 枚举 + phase)

```
步骤: scene_segmentation → entity_extraction → structure_analysis(串行;分阶段只跑对应 step)

phase: pending → running → done
                       → failed → (recovery_required) → resume/abandon
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| progress(整体) | async_tasks.progress / import_workflow_runs.progress | 权威进度落 run.progress, 投影到 task |
| workflow_id | import_workflow_runs.id(=task_id) | v1 兼容 |
| workflow_type/stage | import_workflow_runs.workflow_type / .stage | |
| phase | import_workflow_runs.status | pending/running/done/failed |
| recovery_required | import_workflow_runs.recovery_required | |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 进度/checkpoint/phase_artifacts/progress_events 只保留 compact 信息, 不含正文、API key、raw prompt、raw LLM 输出(来源: workflow_schemas.py:128-153、README:208-210)。
- total_steps 固定 3;completed_steps 去重;步骤确定性推进, 不因重跑重复计数(来源: workflow_schemas.py:14-22、71-74)。
- 中断/恢复标志由 worker stale 扫描收敛, 不是进度自我声明;前端仅在 available_actions 含 resume+abandon 时展示恢复(来源: README:172-175)。

### 待定

- 【待定】DSH jobs 与 checkpoint.json 的分工: 进度实时性走 DSH job, 持久恢复事实走 checkpoint.json 的边界仍需在 M1/M2 过程形态确认。

---

## authorization_snapshot(授权快照)与 adoption policy(M4 落点: .assistant/checkpoint.json + .assistant/policy.yml)

### 语义

流水线启动时作者显式确认的资产采用授权范围与时间快照, 是自动写入派生/已采用资产的唯一凭据。

### 字段(build_authorization_snapshot 产出)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| adoption_policy | enum | 是 | user_authorized_pipeline(唯一受支持) |
| authorization_confirmed | bool | 是 | 必须 true |
| authorized_at | string | 是 | ISO UTC 时间戳 |
| scope.novel_id / start_chapter / end_chapter / stage | string/int/enum | 是 | 授权范围 |
| auto_adopt | list | 是 | scene_without_review_flags / working_structure_asset |
| review | list | 是 | scene_needs_review/entity_candidate/relation_candidate/alias_candidate/uncertain_structure |
| not_adopted | list | 是 | ignored/temporary_only/provenance_conflict |
| provenance_required | list | 是 | source/workflow_id/scene_or_chapter_evidence |
| rollback | dict | 是 | {supported: true, mode: workflow_owned_soft_deprecate} |

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| authorization_snapshot | import_workflow_runs.authorization_snapshot | JSON, 提交时冻结, 投影到 async_tasks.meta/result |
| adoption_policy | import_workflow_runs.authorization_snapshot.adoption_policy | |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 仅 `user_authorized_pipeline` 受支持;`authorization_confirmed` 必须 true, 否则拒绝建快照(来源: adoption_policy.py:8-27)。
- 默认不授权: 缺少显式 authorization_confirmed=true 在入队前拒绝(来源: README:102)。
- 快照提交时冻结;恢复 fail-closed: 快照缺失、未确认、策略不支持、或 scope 与 run 章节范围不一致 → 拒绝执行(来源: README:102)。
- 自动写入仅限 auto_adopt;review 项进入待处理;低置信不得自动升 canonical(来源: adoption_policy.py:38-49、README:112)。
- 回滚模式固定 workflow_owned_soft_deprecate(软废弃, 不硬删)(来源: adoption_policy.py:55-58)。

### 待定

- 【待定】policy.yml(§13 策略即数据)中 adoption 相关默认值是否与 snapshot 的 auto_adopt/review/not_adopted 清单一一对应, 需在 rules/ 规格定稿。

---

## asset_summary(资产结果汇总)(M4 落点: .assistant/checkpoint.json 的 workflow 结果, 非持久 frontmatter 资产)

### 语义

一次 workflow 结束后按「已采用 / 待复核 / 未采用」聚合的资产计数, 供去重报告与收件箱展示。

### 结构字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| adopted / review / not_adopted | int | 是 | 三项互斥合计 |
| by_kind.scene/entity/relation/alias/structure | dict | 是 | 每类资产各含 adopted/review/not_adopted |

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| asset_summary | import_workflow_runs.progress.asset_summary(经 async_tasks.result 返回) | 由 quality_stats 派生 |

### 完整性规则(必须在 store 插件保留的确定性规则)

- ASSET_KINDS 固定 (scene, entity, relation, alias, structure);OUTCOME_KEYS 固定 (adopted, review, not_adopted);缺失 phase 统计显式记 0(来源: adoption_policy.py:11-12、README:112)。
- adopted/review/not_adopted 互斥, 总和 = 本次资产总数;结构资产按总数 clamp(来源: adoption_policy.py:133-164、README:112)。
- entity 的 review = 创建数 - temporary_only;not_adopted = ignored + temporary_only;同 workflow 去重被软废弃的重复结构计入 not_adopted(来源: adoption_policy.py:101-122、README:112)。

### 待定

- 【待定】asset_summary 在 M4 收件箱的呈现是否仍按 by_kind 分桶, 还是按去重报告(§6.1)重排为「高置信合并 / 不确定组」。

---

## 结构去重建议(structure dedup)(M4 落点: structure/threads.md arcs.md foreshadowing.md + relations 索引;merge_records 落点【待定】)

### 语义

Phase 3 完成后对剧情线/弧/伏笔/揭示做的同 workflow 去重建议与高置信自动应用。

### 字段(structure suggestion)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| asset_type | enum | 是 | plot_thread/outline_arc/foreshadowing_plan/reveal_plan |
| action | enum | 是 | merge/deprecate_duplicate |
| source_asset_id / source_title | string | 是 | 来源资产 |
| target_asset_id / target_title | string | 是 | 目标资产 |
| recommended_primary_asset_id | string | 否 | 推荐保留主资产 |
| confidence | float | 是 | 0–1 |
| match_method | string | 否 | 匹配方法 |
| requires_confirmation | bool | 是 | 是否需作者确认 |
| source_workflow_id / target_workflow_id | string | 否 | 归属 workflow(同 workflow 判定依据) |

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| suggestion | outline 融合/结构去重建议队列 | 经 outline facade suggest_structure_dedup/apply_structure_dedup |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 仅自动应用「source_workflow_id == target_workflow_id == 当前 workflow_id」且 confidence >= 0.96 且 action ∈ {merge, deprecate_duplicate} 的建议(来源: deep_import_dedup.py:60-66)。
- 跨旧资产建议只写任务结果、不自动应用(来源: README:53-54)。
- 去重失败降级: 返回 degraded=1、error_kind=structure_dedup_failed、suggestions=[], 不抛异常(来源: deep_import_dedup.py:36-53)。
- 同一资产出现在多个 suggestion pair 中只计一次;按当前 workflow 的唯一资产计算 review/not_adopted(来源: README:112)。

### 待定

- 【待定】§6.1 提出已采用合并新增 merge_records(source_ids → target_id、provenance、workflow、可回滚标记), 但 §22.2 未给出其 M4 文件夹落点;merge_records 落在对象 frontmatter 还是独立索引需定稿。

---

## 实体候选与去重(entity candidate)(M4 落点: world/pending/*.md → 采纳后 world/objects/*.md)

### 语义

Phase 2a 从 Scene 正文抽出的长期世界对象候选, 经确定性去重后落待处理或复用已有对象。

### 字段(ExtractedEntity / Phase2aEntityObservation)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| name | string | 是 | 对象名 |
| entity_type(→ M4 kind) | enum | 是 | 20 类之一(见下) |
| summary / public_info / hidden_truth | string | 否 | 概述/公开信息/隐藏真相 |
| importance | float | 是 | 0.0–1.0 |
| suggested_action | enum | 是 | create_new/link_to_existing/ignore/temporary_only |
| identity_disposition | enum | 是 | new/existing/uncertain(P13 判断) |
| matched_existing_ref | string | 否 | identity_disposition=existing 时必填 |
| confidence | float | 是 | 0.0–1.0 |
| aliases / evidence_quotes | list | 否 | 别名/逐字证据 |

entity_type 枚举(20 类): character/location/faction/organization/species/group/item/object/event/rule/power_system/secret/legend/resource/concept/creature/skill/ability/artifact/other;中文别名(人物/角色/地点/势力/种族/物品/事件/神器…)归一(来源: llm_schemas.py:20-90)。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| kind | core_entities.entity_type | 20 枚举校验后写入 |
| name | core_entities.name | |
| summary/public_info/hidden_truth/importance | core_entities.* | |
| status | core_entities.status | 候选落 candidate, created_by=ai_import |
| provenance/evidence | core_entities.content_json._meta | workflow_id/scene_id/scene_provenance_key/source_chapter_index/confidence |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 幂等键 entity_key = (entity_type 小写, name 去多余空白), 同批内同名同型只建一次(来源: scene_entity_persistence.py:37-38)。
- 精确同名同型 working 实体 → 确定性复用(canonical/draft/candidate), 不受模型 create_new/link_to_existing 影响, 避免重跑制造影子候选(来源: scene_entity_persistence.py:740-769、README:48)。
- 高置信去重阈值 similarity_score >= 0.88 才判为同一(来源: scene_entity_persistence.py:65)。
- entity_type 必须落在 20 枚举, 否则 ValueError 拒绝;深度导入不创建/复用项目自定义类型(来源: llm_schemas.py:93-97、README:47)。
- 候选默认 status=candidate;temporary_only 落 content_json._meta.temporary=true;低置信不自动升 canonical(来源: scene_entity_persistence.py:845-857、README:112)。
- 证据引用带 visible_until_chapter=source_chapter_index, 只对当前可见范围生效(来源: scene_entity_persistence.py:247-294)。

### 待定

- 【待定】core_entities 精确列名(如 public_info/hidden_truth 是否独立列还是入 content_json)属于 world 模块, 本提取范围未含 world/models.py, 需 world 规格确认。

---

## 别名候选(alias candidate)(M4 落点: world/objects/*.md frontmatter `aliases: []`)

### 语义

Phase 2b 判定的同一对象的别名/称呼, 附着已有对象, 不创建新实体。

### 字段(ExtractedAlias / normalize_candidate_alias_item)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| entity_ref | string | 是 | 指向已知对象的 prompt 引用 |
| alias | string | 是 | 别名文本 |
| alias_type | enum | 是 | name/title/nickname/alias/translation/abbreviation |
| identity_scope | enum | 是 | durable/context_bound/uncertain |
| identity_basis | string | 是 | 判定依据 |
| evidence_quotes | list | 是 | 逐字证据(≥1) |
| confidence | float | 是 | 0.0–1.0 |
| status | enum | 是 | candidate(持久化时固定) |
| needs_review | bool | 是 | true(候选态) |

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| aliases[] | entity_aliases.*(表名【待定】) | 经 append_candidate_alias 附着, status=candidate |
| review_meta | entity_aliases.review_meta(【待定】) | identity_scope/identity_basis/evidence_quotes/prompt_entity_ref/context_fingerprint |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 别名只附着已有对象(append_candidate_alias), 不创建重复实体(来源: persistence.py:425-446、AGENTS.md、§22.2)。
- 写入前 fail-closed 校验: entity_ref 可解析且在本 novel active;identity_scope != uncertain;证据逐字在当前 Scene;非占位词;不与已知名/别名重复(来源: scene_entity_persistence.py:396-423)。
- 占位词拒绝: 变量/variable/placeholder/未知/unknown/某人/某物/n/a/none(来源: scene_entity_persistence.py:23-35、71-73)。

### 待定

- 【待定】entity_aliases 精确表名与列名属于 world 模块, 本提取范围未含;是否以对象 frontmatter 内嵌 aliases 列表为准仍待 world 规格确认。

---

## 关系候选(relation candidate)(M4 落点: relations 索引(可重建))

### 语义

Phase 2b 判定的对象间持久联系/持续状态, 落候选或补证据, 不自动融合/废弃已采用关系。

### 字段(Phase2bRelationObservation / ExtractedRelation)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| source_ref / target_ref | string | 是 | 两端点引用(需可解析为对象) |
| relation_type | string | 是 | 关系类型(缺省 related_to) |
| persistence_scope | enum | 是 | enduring/stateful/episodic/uncertain |
| directionality | enum | 是 | directed/symmetric |
| claim_status | enum | 是 | established/reaffirmed/changed/ended |
| previous_relation_ref | string | 条件 | 非 established 时必填 |
| description / basis | string | 是 | 描述/依据 |
| strength | float | 否 | 0.0–1.0 |
| evidence_quotes | list | 是 | 逐字证据(≥1) |
| confidence | float | 是 | 0.0–1.0 |

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| relations | entity_relations.*(表名【待定】) | create_or_merge_relation, status=candidate |
| review_meta | entity_relations.review_meta(【待定】) | workflow_id/scene_id/quote/context_snapshot_id |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 端点必须不同且都在本 novel active(来源: llm_schemas.py:706-709、persistence.py:505-512)。
- established 不得带 previous_relation_ref;reaffirmed/changed/ended 必须带(来源: llm_schemas.py:710-715)。
- persistence_scope ∈ {episodic, uncertain} 不入库, 只保留诊断(来源: persistence.py:515-516)。
- established 与已有 frozen 关系同型同端点 → 判重复不写(来源: persistence.py:490-518)。
- create-or-merge 结果 action ∈ {created, merged, deduplicated};只写候选或补证据, 不自动融合对象/覆盖/废弃已采用关系(来源: persistence.py:942-993、README:46)。
- 证据逐字在当前 Scene;找不到证据整条拒写(来源: persistence.py:94-100)。

### 待定

- 【待定】relations 索引(可重建)的存储形态: 独立索引文件 vs 由对象 frontmatter 派生, 需 world 规格确认。

---

## Phase 2 checkpoint(场景级检查点)(M4 落点: .assistant/checkpoint.json 的 checkpoints 摘要 + session log)

### 语义

Phase 2a/2b 逐 Scene 执行的可恢复检查点, 记录每个 Scene 的完成状态、产物 id 与输入指纹, 用于中断续跑。

### 字段(build_scene_checkpoint 产出)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| scene_id / scene_index | string/int | 是 | 场景标识 |
| status | enum | 是 | done/skipped/failed/… |
| created_entity_ids / created_relation_ids / created_delta_ids | list | 是 | 该 Scene 产物 id |
| retry_count | int | 是 | 重试次数 |
| workflow_id / scene_provenance_key | string | 是 | 归属 workflow / 幂等键 |
| input_fingerprint | string | 否 | 输入指纹(缺失视为旧 checkpoint) |
| source / auto_ingested | string/bool | 是 | deep_import / true |
| error / error_kind | string | 否 | 失败诊断 |

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| checkpoints | import_workflow_runs.checkpoints | JSON, 按 scene 索引或 phase2.scenes 列表 |

### 完整性规则(必须在 store 插件保留的确定性规则)

- input_fingerprint = sha256(Scene 语义字段 + 实际消费正文 + context_fingerprint + prompt contract version);只有 done/skipped 且指纹与当前输入一致才允许跳过, 否则 fail-safe 重跑(来源: scene_entity_checkpoint.py:115-179、README:44)。
- checkpoint 兼容三种嵌套形态: 顶层按 scene_id dict / phase2.scenes 列表 / scenes 列表(来源: scene_entity_checkpoint.py:182-205)。
- 阶段内修复只覆盖失败 checkpoint, 保留其他已完成或来源不完整 checkpoint;不得把已完成 Scene 扩大为重跑范围(来源: README:39)。

### 待定

- 【待定】M4 下 checkpoint 与 DSH session/job 恢复的边界: 哪些字段必须持久化进 checkpoint.json, 哪些可从 session log 重建。

---

## ImportWorkflowRun / attempt(workflow run 与恢复语义)(M4 落点: .assistant/checkpoint.json + session log + DSH jobs)

### 语义

imports 拥有的持久化 workflow 状态与写权限所有权(owner), 以 task_id + generation + attempt + lease 围栏每次可写 attempt。

### 字段(ImportWorkflowRun)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| task_id | string | 是 | 队列任务(unique, 幂等) |
| novel_id | string | 是 | 所属书籍 |
| workflow_type | enum | 是 | deep_import/scene_auto_extraction/world_object_auto_extraction/plot_structure_auto_extraction |
| stage | enum | 否 | scenes/world_objects/plot_structure |
| start_chapter / end_chapter | int | 是 | 章节范围(start≥1, end≥start) |
| status | enum | 是 | 见状态机 |
| generation | int | 是 | resume 时 +1 |
| owner_task_id / owner_attempt / owner_lease_id | string/int/string | 否 | owner CAS 三元组 |
| recovery_required | bool | 是 | 需恢复确认 |
| authorization_snapshot / llm_execution_snapshot | dict | 是 | 授权/脱敏 LLM 快照 |
| prepare_checkpoint / checkpoints / progress | dict | 是 | 准备期冻结元数据/检查点/进度 |

### 状态机

```
run: pending → running → done | failed | cancelled
async_tasks 状态收敛(reconcile): cancelled/done/failed/running 反写 run
failed + recovery_required → resume → pending(gen+1)
                           → abandon → cancelled(整批软废弃回滚)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| (run 状态) | import_workflow_runs.* | async_tasks 是队列/lease 投影 |
| workflow_id | import_workflow_runs.id(=task_id) | v1 兼容 |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 每 novel 最多一个 pending/running 或 recovery-required run(partial unique index)(来源: models.py:139-149)。
- owner CAS: 每次可写操作(require_owner)必须 task_id + generation + owner_task_id + owner_attempt + owner_lease_id + status='running' 全匹配, 失配抛 OwnershipLost 回滚(来源: workflow_runs.py:367-417)。
- checkpoint/complete/fail 均先 require_owner;工作区脏或 owner 失配拒绝写(来源: workflow_runs.py:419-463)。
- resume 仅 failed + recovery_required;generation+1 → pending;abandon 仅 failed + recovery_required → cancelled(来源: workflow_runs.py:465-498)。
- abandon 回滚按 novel_id + workflow_id 整批软废弃 Scene/世界对象/候选关系/候选别名/结构资产, Memory DeltaLog meta.rolled_back=true;不碰其他 workflow/小说或 user_edited 资产;回滚幂等(来源: README:127)。
- 恢复 fail-closed: 授权快照缺失/未确认/策略不支持/scope 与 run 不一致 → 拒绝执行(来源: README:102)。

### 待定

- 【待定】M4 下 owner fencing(attempt/lease/generation)如何映射到 DSH job 的原生 lease/attempt 语义, 需在 M1/M2 的 jobs seam 规格确认;old owner_token 是否仍有独立意义待定。

---

## 附: 通用确定性约束(跨资产)

- novel_id 隔离: 所有业务读写按 novel_id 过滤;M4 下每书一个文件夹 + 每书一个 DSH session, scope 子系统做会话内分区(来源: AGENTS.md、§22.2)。
- 已采用对象不硬删除, 优先历史状态(git 历史天然保留;删除 = 新 commit 移除 + 墓碑文件)(来源: AGENTS.md、§22.2)。
- LLM 输出只进待处理建议或临时预览;仅经持久化用户授权(adoption_policy + authorization_snapshot)的自动流水线可写允许的派生/已采用资产, 且保存授权范围/来源/workflow/可编辑/可回滚标记(来源: AGENTS.md、adoption_policy.py)。
- 证据/溯源双向可追溯: provenance 存「哪次 workflow/哪条 session 记录/证据引用」(来源: §22.4)。
