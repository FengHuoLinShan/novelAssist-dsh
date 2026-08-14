# Writing 资产规格(R0 提取)

- 来源 commit: a257df23e
- 提取日期: 2026-08-14
- 提取范围: backend/modules/writing/{models.py, schemas.py, contracts.py, conflict_evidence.py, source_hashing.py, manuscript_source.py, pov_generation.py}; 状态机/规则检查与软冲突/审查语义另据 services.py、repositories.py、conflict_ai.py、semantic_review.py、facade.py、README.md

## 章节正文(M4 落点: `chapters/{NNN}.md`)

### 语义

每章一篇的正文事实。作者在 Word 写完、经停靠舱同步进来的正文(M4 下每次同步 = 一次 git commit)；正文即 markdown 正文体，版本历史由 git 白拿。旧引擎里它是 `writing_drafts` 表里状态为 `draft / published / canonical` 的"工作稿面"，是章节最新稿、项目统计、原文检索与 RAG 事实源的唯一来源(来源: services.py:192-247, README.md:118-119)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| chapter_index | int | 是 | 章节索引(从 1 起)；M4 下由文件名数字承载(`003.md` → 3) |
| title | string | 否 | 章节标题(旧列 title, 可空) |
| status | enum | 是 | 见状态机; working 面 = `draft / published / canonical` |
| content_hash | string(64) | 是 | 正文 SHA-256(UTF-8 hex), 用于来源引用与索引新鲜度校验 |
| provenance | object | 否 | 来源追踪: `source` / `version_origin` / `base_draft_id` / `deprecated_from_status` / `adopted_*` 等 |
| conflict_check_snapshot | object | 否 | 发布时归档的最近一次冲突检查快照(旧列 conflict_check_snapshot_json) |

### 状态机

```
draft ──publish(有实质变化)──────────▶ published        (原位提升, 不再加版本)
published ──暂存编辑(copy-on-write)───▶ draft(新版本, origin=auto)
draft ──checkpoint────────────────────▶ draft(新版本, origin=manual)
draft ──discard / delete──────────────▶ deprecated(软删, 回退到 base 版本)
published ──delete────────────────────▶ deprecated
candidate ──adopt─────────────────────▶ draft(新版本) 且 candidate→deprecated
candidate ──reject / delete───────────▶ deprecated(记录 rejected_at/by)
deprecated = 终态(软删除, 版本号永不重排)
```

- M4 映射: working 面的 `draft/published/canonical` 合并为 `chapters/*.md` + git commit; "发布" = 一次 commit + `content_hash` 进 frontmatter; 版本号 = git commit(§22.2 表格「revision / CAS」行)。
- `canonical` 是兼容状态: 出现在 `WORKING_DRAFT_STATUSES` 与 `content_mode="working"` 校验中, 但旧引擎未显式写入该状态(实际发布态是 `published`)。见 repositories.py:23、manuscript_source.py:265-277。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| chapter_index | writing_drafts.chapter_index | 文件名数字 |
| title | writing_drafts.title | |
| status | writing_drafts.status | 值域见状态机 |
| content_hash | writing_drafts.content_hash | 旧引擎为 64 位 hex, 无 `sha256:` 前缀 |
| provenance | writing_drafts.provenance_json | JSON 字典 |
| conflict_check_snapshot | writing_drafts.conflict_check_snapshot_json | 发布快照, 不含正文 text_range |
| 版本号 | writing_drafts.version_number | 旧为 1 递增 + UNIQUE(novel_id, chapter_index, version_number); M4 由 git commit 取代 |
| id | writing_drafts.id | UUID → 章节文件名/序号 |

### 完整性规则(必须在 store 插件保留的确定性规则)

- content_hash = SHA-256(正文 UTF-8 字节), 每次正文变更必须重算(来源: source_hashing.py:8-9, repositories.py:50/622/656, services.py:656)。
- 版本号原子递增: 旧引擎 = `SELECT MAX(version_number)+1` + 唯一约束 + advisory lock 串行化同章版本/内容写(来源: repositories.py:641-665, 667-686); M4 下该串行化语义由 git commit 的原子性承接, 但「并发采用/发布串行化」仍必须保留。
- published/canonical 版本不得原地修改; published 首次编辑 copy-on-write 为新 `draft` 版本(来源: repositories.py:205-206, 618-619; services.py:465-490)。
- 乐观锁/多 Tab 保护: `expected_version` / `expected_updated_at` 校验, 仅章节最新 working 版本可被暂存/checkpoint/发布, 过期返回冲突(来源: services.py:611-637; README.md:230-235)。
- 软删除: 删除只把状态置 `deprecated` 并记录 `deprecated_from_status`(原状态), 版本号永不重排, 不硬删正文(来源: repositories.py:230-245; services.py:693-739)。
- 自动版本判定只比较正文且忽略 Unicode 空白(`substantive_text`), 不改写作者原文; 标题/纯空白改动不自动留版(来源: source_hashing.py:12-24)。
- 来源范围引用新鲜度: `SourceRangeRefContract` 的 `source_hash`(整篇) 与 `range_hash`(区间) 必须在读取时重算匹配, 正文或版本变化后引用 stale, 拒绝读取(来源: manuscript_source.py:158-177)。
- 候选(candidate)不进入章节最新稿、项目统计、原文 grep 与 RAG working 来源; 只有 `draft/published/canonical` 参与(来源: repositories.py:23, README.md:119)。
- 发布时归档最近冲突检查快照到正文, 快照保留 `source`/`open_target`、不保留正文 `text_range`, 之后问题状态变化不回写该快照(来源: services.py:787, README.md:259)。

### 待定

- 【待定】`content_hash` 在 M4 frontmatter 的统一格式(旧引擎为纯 hex, §24.2 草案示例带 `sha256:` 前缀)。
- 【待定】`version_number` 是否在 M4 保留为显式 frontmatter 字段(§22.2 语义上已由 git commit 取代, 但历史列表/审计视图可能需要一个稳定序号)。
- 【待定】`canonical` 状态在 M4 是否保留为独立枚举, 或与 `published` 合并为单一「已采用」态。

---

## 候选正文 / AI 建议(M4 落点: 【待定】, 见本节省)

### 语义

AI 生成但尚未采用的正文建议: 生成中心整章建议(`writing_generate`, 含 POV 续写)、定向返修结果(`writing_targeted_revision`)。候选只读、不覆盖正文、不自动发布; 作者采用(adopt)后才成为章节工作稿。旧引擎以 `writing_drafts` 表 `status="candidate"` 承载, API/契约投影为 `display_state="review"`、`source="ai_generated"`(来源: services.py:367-423, schemas.py:16-63, README.md:108)。

### frontmatter 字段(候选 provenance 关键项)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| status | enum | 是 | `candidate` |
| content_hash | string(64) | 是 | 候选正文 SHA-256 |
| source | enum | 是 | `writing_generate` / `writing_targeted_revision` |
| provenance.source_task_id | string | 是 | 生成任务 ID |
| provenance.context_confirmation_id | string | 是 | 冻结的上下文确认 ID |
| provenance.scene_execution_bundle_hash | string | 否 | 冻结的 Scene 执行 bundle hash |
| provenance.upstream_manifest | array | 否 | 冻结的上游来源清单 |
| provenance.base_draft_id | string | 否 | 续写/返修基线的版本 ID |
| provenance.review_required | bool | 否 | 采用前是否强制独立语义审查 |
| provenance.independent_review | object | 否 | 已完成的独立审查回执(见「独立语义审查」) |
| provenance.managed_llm_steps | array | 否 | secret-free 受管生成步骤记录(无 Key/正文/prompt) |

### 状态机

```
candidate ──adopt(copy-on-adopt)──▶ draft(工作稿新版本) + candidate→deprecated
candidate ──reject / delete───────▶ deprecated(保留原状态 + rejected_at/rejected_by)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| status | writing_drafts.status | `candidate` 与工作稿同表不同状态 |
| source / provenance | writing_drafts.provenance_json | |
| content_hash | writing_drafts.content_hash | |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 采用 = copy-on-adopt: 新建最高 `version_number` 的普通 `draft`, 写入 `adopted_from_candidate_id / adopted_at / adopted_by`; 原 candidate 改 `deprecated` 并记录 `adoption_result_draft_id`(来源: services.py:367-423)。
- 采用前 fail-closed 上游校验: 仅当正文 source 为生成类且 `context_confirmation_id` 仍新鲜、`scene_execution_bundle_hash` 与当前 Scene 一致、且(若 `review_required`)独立审查 verdict=pass 且 `draft_hash` 匹配时才能采用, 否则返回冲突(来源: semantic_review.py:86-129)。
- 拒绝 = 软废弃: 保留完整版本、原状态与 `rejected_at / rejected_by` 审计, 不硬删正文(来源: services.py:714-739, README.md:235-236)。
- 候选只读: 不得通过普通暂存/发布接口修改或恢复; 只能经 adopt 或 reject 迁移(来源: README.md:233-235)。
- 同一确认重复入队时, 最后绑定的任务取代旧任务, 旧结果不写 candidate(来源: README.md:207-208)。

### 待定

- 【待定】候选正文在 M4 工作区的落点: §22.2 未给出候选正文目录(仅 `world/pending/` 为世界对象候选)。合理推断为 `chapters/` 下带 `status: candidate` 的候选文件或 `.assistant/` 下 pending 候选, adopt = 移入 working 位置 + 一次 commit(原子); 需 R0 后裁定。
- 【待定】候选的 `pov_state` / `uncertainties`(POV 元数据)在 M4 是否随 candidate 落盘, 或只作审查期临时视图。

---

## 写作冲突检查(M4 落点: 【待定】, 派生结果非长期创作资产)

### 语义

一次针对某章/Scene 的「剧情设定冲突检查」记录。规则层为确定性 Scene 语义承诺检查(must_happen / must_not_happen 短语匹配), AI 软冲突为显式追加、不影响规则层(来源: services.py:992-1064, README.md:254/261)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| chapter_index | int | 是 | 检查目标章 |
| scene_id | string | 否 | 关联 Scene(跨模块弱绑定, 无 FK) |
| draft_id | string | 否 | 关联正文版本(旧 FK `SET NULL`) |
| version_number | int | 否 | 关联正文版本号 |
| scope | object | 是 | 检查范围快照(chapter/scene/draft/version/content_excerpt 前 4000 字/字符数/sources) |
| include_candidates | bool | 是 | 是否含待确认对象(默认 false) |
| status | enum | 是 | `completed` / `degraded`(来源不可用降级) |
| summary_json | object | 是 | 汇总: total/open_high_count/by_severity/degraded_sources |
| ai_review_enabled | bool | 是 | 是否已追加 AI 软冲突 |
| ai_review_status | enum | 是 | `not_requested / running / done / failed / partial` |
| ai_review_model / ai_review_error | string | 否 | AI 复核所用模型 / 失败原因 |

### 状态机

```
[规则检查] completed / degraded(来源不可用, 如 outline Scene 缺失 → degraded_sources 记 "outline")
ai_review_status: not_requested → running → done / failed / partial
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| chapter_index | writing_conflict_checks.chapter_index | |
| scene_id | writing_conflict_checks.scene_id | |
| draft_id | writing_conflict_checks.draft_id | |
| status | writing_conflict_checks.status | completed/degraded |
| summary_json | writing_conflict_checks.summary_json | 内部 `_ai_review_task_id` 不出 API/快照 |
| ai_review_* | writing_conflict_checks.ai_review_* | |
| scope | writing_conflict_checks.scope | |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 规则层与 AI 层隔离: LLM 失败只把 `ai_review_status` 置 `failed`, 不删除规则层结果(来源: README.md:266)。
- 内部任务 owner(`_ai_review_task_id`)不进入 API 响应与发布快照(来源: repositories.py:27-31)。
- AI 复核与修复建议必须先有 action 匹配(`writing.conflict_check.ai_review` / `ai_suggestion`)且确认范围(chapter_index/scene_id)与检查一致的确认记录(来源: conflict_ai.py:1187-1207, README.md:263-267)。
- 发布章节时把最近一次检查快照归档进正文 `conflict_check_snapshot_json`(来源: services.py:787, README.md:259)。

### 待定

- 【待定】M4 落点: 冲突检查是过程派生结果, 非长期创作资产; 可能落 `.assistant/signals/*.json`(§22.2)或作为修订台即时派生(规则可由 Scene frontmatter + 正文即时重建, 无需落盘)。
- 【待定】`scene_id` 的弱绑定(无 FK)在 M4 是否改为 scene 文件引用字符串。

---

## 写作冲突问题项(M4 落点: 【待定】, 随检查记录)

### 语义

单条冲突问题: 规则命中(确定性)或 AI 软冲突判断(带置信度), 各带证据定位与可选的 AI 修复建议。证据是轻量、可打开来源的定位信息, 不是正文引用(来源: models.py:157-213, conflict_evidence.py)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| check_id | string | 是 | 所属检查(旧 FK `CASCADE`) |
| kind | string(64) | 是 | 见下方 kind 枚举(规则 2 种 + AI 10 种) |
| severity | enum | 是 | 规则层 `high/medium`; AI 层 `low/medium/high` |
| source_module | string | 是 | 规则层 `outline`; AI 层 `ai` |
| source_type | string | 否 | `scene.must_happen` / `scene.must_not_happen` / `llm.soft_conflict` |
| source_id | string | 否 | 来源对象 ID(Scene ID / check ID) |
| evidence_summary | string | 是 | 问题一句话 + 证据摘录 |
| location_json | object | 否 | 见下方证据结构 |
| is_ai_judgment | bool | 是 | 是否 AI 软冲突 |
| needs_review | bool | 是 | 是否需作者复核(依赖待确认对象时为 true) |
| status | enum | 是 | `open / resolved / ignored / later` |
| confidence | float | 否 | AI 置信度 0–1(规则层无) |
| source_confirmation_id | string | 否 | AI 软冲突所用上下文确认 ID |
| llm_rationale | string | 否 | AI 判断理由 |
| suggestion_status | enum | 是 | `not_requested / running / done / failed` |
| ai_suggestion | string | 否 | 最新 AI 修复建议(JSON) |
| suggestion_confirmation_id / suggestion_error | string | 否 | 建议所用确认 ID / 失败原因 |

### kind 枚举

- 规则层(确定性): `forbidden_present`(正文出现 Scene 禁止发生项, severity=high)、`required_missing`(正文未覆盖 Scene 必须发生项, severity=medium)。来源: services.py:1320-1389。
- AI 软冲突(来源: schemas.py:494-505): `motivation_gap` / `emotion_jump` / `foreshadowing_misfire` / `premature_reveal` / `implicit_lore_conflict` / `voice_or_pov_drift` / `scene_goal_drift` / `scene_commitment_missing` / `scene_forbidden_deviation` / `continuity_soft_risk`。

### 证据结构(location_json, 来源: conflict_evidence.py:8-34)

| 字段 | 类型 | 语义 |
|---|---|---|
| source.module | string | 来源模块(outline/…) |
| source.type / source.id / source.label | string | 来源类型/ID/作者语言标签 |
| source.field | string | 来源字段名(作者语言, 如「必须发生」「禁止发生」) |
| source.excerpt | string | 来源摘录 |
| open_target | object | 前端可打开目标: `{kind: outline_scene, scene_id}` / 带 `text_range` |
| needs_review_reason | string | 候选证据需复核的原因 |
| text_range | object | 正文命中区间(仅实时检查; 发布快照剔除) |

### 状态机

```
item.status: open → resolved / ignored / later
suggestion_status: not_requested → running → done / failed
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| check_id | writing_conflict_items.check_id | CASCADE |
| kind / severity / source_* | writing_conflict_items.kind / severity / source_module / source_type / source_id | |
| evidence_summary | writing_conflict_items.evidence_summary | |
| location_json | writing_conflict_items.location_json | |
| is_ai_judgment / needs_review | writing_conflict_items.is_ai_judgment / needs_review | |
| status / confidence | writing_conflict_items.status / confidence | |
| llm_rationale / source_confirmation_id | writing_conflict_items.llm_rationale / source_confirmation_id | |
| suggestion_* / ai_suggestion | writing_conflict_items.suggestion_* / ai_suggestion | |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 规则层确定性: 只做 Scene `must_happen`/`must_not_happen` 短语级字面匹配; 语义承诺不要求逐字复现(来源: services.py:1320-1389; conflict_ai.py:1352-1353)。
- AI 输出逐条 schema 校验, 非法条目丢弃并计入 `summary_json.ai_review.discarded_count`(来源: conflict_ai.py:1150-1184)。
- AI 修复建议只写回该问题项的 `ai_suggestion`, 不改正文/Scene/世界对象/记忆/正史资产; 不得输出自动补丁(来源: conflict_ai.py:1358-1362, README.md:267-268)。
- 发布快照剔除正文 `text_range`, 只保留 `source`/`open_target`(来源: conflict_evidence.py:37-49, README.md:259)。

### 待定

- 【待定】M4 落点: 与检查同, 派生结果; 倾向不落盘或随检查一起落 `.assistant/`。
- 【待定】`kind` 值域是否并入 `policy.yml` 作为可扩展规则集, 或保持硬编码枚举。

---

## 独立语义审查(M4 落点: 【待定】, 派生回执)

### 语义

与正文生成器分离的「独立审稿人」工作流: 冻结目标正文 hash + 相邻章回归上下文 + Scene 执行 bundle, 输出每条有正文位置的 finding + verdict + coverage; 机械检查通过不代表文学通过。回执写入目标正文的 `provenance.independent_review`(来源: semantic_review.py:132-492)。

### frontmatter 字段(回执 schema `writing_semantic_review.v1`)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| review_task_id | string | 是 | 审查任务 ID |
| scope | enum | 是 | `selection / volume / book` |
| verdict | enum | 是 | `pass` / `needs_revision`(无 blocker/major 为 pass) |
| blocking_count | int | 是 | blocker+major 计数 |
| coverage | object | 是 | target_draft_ids / target_chapters / adjacent_regression_draft_ids / frozen_manifest_hash / chunk_count |
| frozen_manifest | array | 是 | 冻结的 draft_id/chapter_index/content_hash/scene_execution_bundle_hash/role |
| findings | array | 是 | 见下方 finding 结构 |
| not_checked | array | 是 | 被丢弃/非目标位置项 |
| reviewer_separate_from_generator | bool | 是 | 恒 true |

finding 结构(来源: schemas.py:378-408):

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| finding_id | string | 是 | 由内容稳定 hash 派生(`finding_<hash20>`) |
| severity | enum | 是 | `blocker / major / minor` |
| category | enum | 是 | `contract_omission / pov_boundary / continuity / causality / character_voice / pacing / literary_quality / copy_error` |
| location | object | 是 | `{draft_id, chapter_index, excerpt, start_hint, end_hint}` |
| message | string | 是 | 问题描述 |
| contract_refs | array | 否 | 引用的 Scene 合同字段 |
| preserve | array | 否 | 返修时必须保留的内容 |

### 状态机

```
(无独立状态; 回执 verdict = pass / needs_revision, 由正文 provenance.independent_review 承载)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| independent_review | writing_drafts.provenance_json.independent_review | 无独立表, 回执存于目标正文 provenance |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 审查冻结语义: 冻结正文 content_hash + Scene bundle hash + 相邻章; 审查期间或落库前任何变化 → 丢弃过时结果, 返回冲突(来源: semantic_review.py:330-399, 430-433)。
- 分片上限: 全书审查最多 24 个可验证分片, 单分片 80000 字符预算(来源: semantic_review.py:35-37, 252-269)。
- 位置校验: 只接受落在 targets 且章号一致、excerpt 能在正文中定位的 finding, 否则入 `not_checked`(来源: semantic_review.py:401-422)。
- 独立审稿人原则: `reviewer_separate_from_generator=true`, 机械检查不能签署文学 pass(来源: semantic_review.py:490-491)。
- 采用候选前, `independent_review.verdict=pass` 且 `draft_hash == content_hash` 是硬门(来源: semantic_review.py:121-129)。

### 待定

- 【待定】M4 落点: 审查回执是派生结果, 可能落 `.assistant/` 或随 candidate/正文 provenance 内联; 修订中心(§17.5)将其作一等公民卡片展示。
- 【待定】finding 的 `category` 8 值是否进 `policy.yml` 可扩展。

---

## 定向返修(M4 落点: 同「候选正文」, 产出为 candidate)

### 语义

针对一次已完成审查中选定的 finding 生成新候选, 不覆盖原稿; 返修候选必须再经独立审查通过才能采用。旧引擎无独立表, 产出为 `writing_drafts` 表 `status="candidate"` 且 `source="writing_targeted_revision"`(来源: semantic_review.py:494-675)。

### frontmatter 字段(候选 provenance 关键项)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| source | enum | 是 | `writing_targeted_revision` |
| base_draft_id | string | 是 | 返修基线版本 ID |
| base_content_hash | string | 是 | 基线正文 hash(返修后变化则拒绝套用旧问题) |
| review_task_id | string | 是 | 来源审查任务 |
| finding_ids | array | 是 | 选定修复的 finding ID 集(须与审查回执一致) |
| preserve | array | 否 | 审查标记需保留的内容 |
| must_not_change | array | 否 | Scene `must_not_happen` + preserve 合并的不可改清单 |
| supersedes | string | 是 | 被取代的基线 draft_id |
| review_required | bool | 是 | 恒 true(采用前须再审) |
| independent_review | object | 否 | 置空, 等待再审 |

### 状态机

```
(返修是生成 candidate 的动作; candidate 状态机见「候选正文」)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| 全部 | writing_drafts.provenance_json | 返修与生成 candidate 同表不同 provenance |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 返修必须绑定冻结审查回执: `finding_ids` 与回执 findings 一致、finding 属于目标正文、基线 `content_hash` 与 `scene_execution_bundle_hash` 未变, 否则拒绝(来源: semantic_review.py:514-553)。
- 返修后基线正文或 Scene 合同变化 → 丢弃过时结果, 不写 candidate(来源: semantic_review.py:633-644)。
- 返修只处理选定 finding, 严格保留 preserve 与 must_not_change, 不扩展世界设定、不改无关段落(来源: semantic_review.py:574-583)。

### 待定

- 【待定】M4 落点: 同候选正文; 修订中心以「卡片 + diff + 可复制修订块」呈现(§17.5)。
- 【待定】`supersedes` 链在 M4 是否用 git 提交关系表达, 或保留为 provenance 字段。

---

## POV 生成结果(M4 落点: `draft_prose` → 候选正文; 其余为审查元数据【待定】)

### 语义

单角色有限视角的正文生成: 从指定角色的有限经验与认知出发, 输出结构化对象。`draft_prose` 是可直接替换目标章的完整候选正文; `pov_state` 是可检查的角色状态摘要; `uncertainties` 是实质影响写作的资料不确定性。Scene/剧情线导演信息只引导情节, 不得变成角色已知事实(来源: pov_generation.py:16-47)。

### frontmatter 字段(输出 schema)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| pov_state.perceived_facts | array[string] | 否 | 角色此刻可感知/已知的关键事实 |
| pov_state.interpretation | string | 否 | 角色对局面的理解(可能错误/不完整) |
| pov_state.current_intention | string | 否 | 角色此刻意图 |
| pov_state.withheld_known_information | array[string] | 否 | 角色已知但此刻选择不表达的信息 |
| draft_prose | string | 是 | 完整、连贯、可直接替换目标章的正文候选 |
| uncertainties | array[string] | 否 | 会实质影响写作的上下文不确定性; 无则为空数组 |

隐藏守卫结果(确定性 POV 泄漏诊断, 来源: pov_generation.py:179-229):

| 字段 | 类型 | 语义 |
|---|---|---|
| status | enum | `passed / warning / failed`(解析失败或命中 error 级词 → failed) |
| findings | array | 命中守卫词条: rule/severity/field_path/generated_excerpt(redacted)/source_type/source_id/source_label |
| warnings | array | 解析警告码: `json_repaired / missing_pov_state / pov_parse_failed` |

### 状态机

```
(生成结果进入 candidate 状态机; 守卫 status 只决定是否提示, 不自动否决)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| draft_prose | writing_drafts.content | 作为 candidate 正文落库 |
| pov_state / uncertainties / guard findings | writing_drafts.provenance_json.pov_validation | 审查元数据(见 schemas.py:40-48 投影出 pov_risk/parse_warning/fact_risk) |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 输出必须是只含 `pov_state / draft_prose / uncertainties` 三顶层字段的 JSON; 缺失 draft_prose 判失败(来源: pov_generation.py:42-47, 142-144)。
- 单次 JSON 修复尝试: 去围栏、裁到首尾大括号、修尾部逗号、只补行首已知键前缺的逗号(不动 prose 内部文本)(来源: pov_generation.py:152-176)。
- 隐藏守卫是确定性文本级 POV 泄漏诊断(NFKC + 去空白小写匹配), 命中只产生 redacted finding, 不把原文带出产出物(来源: pov_generation.py:313-325, README.md:748-749)。
- 解析失败(`pov_parse_failed`)时状态判 `failed`; 仅命中 warning 级守卫判 `warning`(来源: pov_generation.py:217-224)。
- 有锁定章节时 `draft_prose` 须保留未要求改动的原文、既有事实与叙事顺序(来源: pov_generation.py:45, 259-267)。

### 待定

- 【待定】`pov_state` / `uncertainties` 是否作为 candidate frontmatter 长期保留, 或只作审查期临时元数据(旧引擎投影为 `pov_validation` 存进 provenance)。
- 【待定】隐藏守卫词条来源(frozen guard terms)在 M4 由哪个资产供给(现来自 outline hidden evidence 冻结)。
