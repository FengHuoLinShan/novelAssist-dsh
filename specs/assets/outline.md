# outline 资产规格(R0 提取)

- 来源 commit: a257df23e
- 提取日期: 2026-08-14
- 提取范围: backend/modules/outline/ 下 `models.py`、`schemas.py`、`contracts.py`、
  `ai_workflow_service.py`、`generator.py`、`story_outline_schemas.py`、
  `story_outline_service.py`、`story_outline_repository.py`、
  `foreshadowing_repository.py`、`reveal_repository.py`、`reveal_visibility.py`、
  `scene_workbench.py`、`services.py`、`repositories.py`、`generation/models.py`、
  `generation/persister.py`、`p20_service.py`

> 约定: 本文件只描述「创作资产与状态机」, 不覆盖 API 请求/响应信封。raw ID/JSON
> 只出现在字段表技术列; 正文用作者语言。M4 落点依据设计文档 §22.2(文件夹真相)。
> 所有 `related_*_ids` / `*_id` 类引用在 M4 下统一落为**对象 slug 引用**(指向
> `world/objects/*.md` 或 `chapters/*.md` 的稳定 id), 不再是无意义 UUID。

---

## Scene(M4 落点: `scenes/*.md`)

### 语义

叙事结构的最小可编辑单元(作者语言: 一个场景/剧情单元, 挂在若干章节上)。一张 Scene 卡
回答「这一幕要发生什么、冲突是什么、读者的情感怎么走、什么必须/禁止发生」, 并通过
`chapter_ids` 与 `scene_chunks` 指向正文的物理位置。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string(slug) | 是 | 稳定标识(旧 UUID → 文件名/slug, 如 `s012`) |
| status | enum | 是 | `draft` / `canonical` / `deprecated`, 见状态机 |
| scene_index | int | 是 | 逻辑顺序索引(从 0 开始), 决定 Scene 排列 |
| title | string | 否 | 标题 |
| goal | string | 否 | Scene 目标(此 Scene 要完成什么) |
| core_conflict | string | 否 | 核心冲突 |
| emotional_beat | string | 否 | 情感节奏(读者情感走向) |
| must_happen | string | 否 | 必须发生的事件 |
| must_not_happen | string | 否 | 禁止发生的事件 |
| narrative_tag | enum | 是 | 叙事标签, 见 NarrativeTag 枚举(默认 `draft`) |
| source | enum | 是 | 来源 `manual` / `deep_import` / `ai_generated`(另有 `manual_fusion` / `mechanical_fusion` / `extractive`) |
| scene_chunks | list\<dict\> | 否 | 物理映射: Scene → Chapter 物理位置区间(每个 chunk 含 `chapter_id`/`chapter_index` 等) |
| chapter_ids | list\<string\> | 否 | 关联章节引用列表(章节编号/slug) |
| pov_character_id | string | 否 | POV 人物引用(指向 world 人物对象) |
| structure_meta | dict | 否 | 结构整理元信息(见下「structure_meta 子字段」) |
| relations | list\<dict\> | 否 | 统一关系边(ADR-0019 N14: 元素 `{target: slug, type, status}`, type 枚举与白名单见 adjudications N15) |
| content_hash | string | 是(adopt 时) | 内容 sha256(§22.2: 每次内容变更更新, 进 frontmatter) |
| evidence | list | 否 | 证据引用(§22.2/§24.2 指定, 旧代码无独立列, 由 source-mapping/provenance 派生) |

**structure_meta 子字段**(作者可见的整理状态, M4 建议提为 frontmatter 平铺或保留 dict):

| 子字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| planning_state | enum | 否 | `planned`(AI 规划但未落章节) / `materialized`(已挂章节或正文) |
| needs_review | bool | 否 | 是否需要复核(未复核信号依据之一) |
| reviewed_at | string | 否 | 复核时间戳(存在则不再算未复核) |
| user_edited | bool | 否 | 作者是否已手动改过(保护作者改动) |
| auto_ingested | bool | 否 | 是否自动导入(deep_import)产物 |
| source | enum | 否 | 复制自 `source` 列, 供过滤 |
| workflow_id | string | 否 | 产生它的工作流 id(供按来源追溯) |
| semantic_origin | enum | 否 | `phase1b_enrichment` / `phase1c_synthesis` / `author_reviewed_fusion` / `mechanical_fusion` / `p20_planned_scene` |
| semantic_field_statuses | dict | 否 | 各语义字段 `present` / `not_applicable` / `uncertain` |
| core_conflict_status | enum | 否 | core_conflict 语义状态 |
| narrative_function | string | 否 | 叙事功能(区别于 narrative_tag) |
| planned_chapter_range | dict | 否 | `{start, end}` 规划章节范围(p20 planned_scene) |
| parent_outline_arc_id / related_thread_ids / related_character_ids / related_entity_ids | list/string | 否 | 规划层关联引用(p20) |
| p20_basis / p20_uncertain_fields / p20_confidence | — | 否 | p20 规划依据/不确定字段/置信度 |

### 状态机

```
draft ──adopt──▶ canonical ──替换/删除(不硬删)──▶ deprecated
```

- 历史状态 `candidate` / `proposal` 在旧代码仍被当作「活动」状态参与筛选
  (`repositories.py:1197/1314/1449`、`structure_dedup.py:764`); M4 是否保留标【待定】。
- 旧表 `Scene.status` 为 String, 新 schema 对写入收窄为 `draft/canonical/deprecated`
  (`schemas.py:209/232`)。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | scenes.id | UUID → 文件名/slug |
| status | scenes.status | draft/canonical/deprecated(+候选值) |
| scene_index | scenes.scene_index | 保留整数, 排序键 |
| title | scenes.title | |
| goal | scenes.goal | |
| core_conflict | scenes.core_conflict | |
| emotional_beat | scenes.emotional_beat | |
| must_happen | scenes.must_happen | |
| must_not_happen | scenes.must_not_happen | |
| narrative_tag | scenes.narrative_tag | NarrativeTag 枚举 |
| source | scenes.source | manual/deep_import/ai_generated/… |
| scene_chunks | scenes.scene_chunks | JSON 列表 |
| chapter_ids | scenes.chapter_ids | JSON 列表; 另有派生索引 scene_chapter_links |
| pov_character_id | scenes.pov_character_id | 指向 core_entities |
| structure_meta | scenes.structure_meta | JSON dict |
| content_hash | (无旧列) | M4 新增, 见 §22.2 |
| evidence | (无旧列) | M4 新增, 由 span/映射证据派生 |

### 完整性规则(必须在 store 插件保留的确定性规则)

- **章节映射一致性**: `scene_chunks` 中出现的章节集合必须等于 `chapter_ids` 集合, 否则
  标记 `chunk_chapter_mismatch`(来源: `scene_workbench.py:2029-2036`)。
- **章节不重复**: `chapter_ids` 内不得有重复章节, 否则 `duplicate_chapter`
  (来源: `scene_workbench.py:2020-2021`)。
- **正文片段不重叠**: 同一源版本下, 两个 Scene 的 span 不得有字符区间重叠, 否则
  `overlapping_span`(来源: `scene_workbench.py:2022-2028, 2079-2119`)。
- **未关联章节**: `chapter_ids` 为空且 `planning_state != "planned"` → 健康信号
  `unassigned`(来源: `scene_workbench.py:1999-2001`)。
- **缺设定判定**: `goal` 为空, 或 `core_conflict/must_happen/must_not_happen` 存在
  「present 却无值 / not_applicable 却有值 / uncertain / 无状态且无值」任一情况 → `missing_setup`
  (来源: `services.py:91-113`)。
- **未复核判定**: `structure_meta.needs_review` 为真, 或 `source ∈ {deep_import, ai_generated}`
  且 `status ∈ {draft, candidate}` 且无 `reviewed_at`(来源: `scene_workbench.py:1993-1998`)。
- **已采用不硬删**: Scene 删除 = `status → deprecated`(来源: `services.py:654-661` 附近,
  `delete` 走 deprecate); M4 下删除 = 新 commit 移除 + 墓碑文件(§22.2)。
- **作者改动保护**: 对 `auto_ingested` 且未 `user_edited` 的 deep_import Scene 做字段编辑时,
  写入 `user_edited: true` + `edited_at`(来源: `services.py:228-251, 639-651`)。
- **adopt 即 commit**: 每次采用(adopt) = 一次 git commit + `content_hash` 更新; 工作区脏时
  拒绝 adopt(§22.2 行 700)。

### 待定

- 【待定】`candidate` / `proposal` 这两个历史状态在 M4 是否保留, 还是统一并入 draft。
- 【待定】`narrative_tag` 与 `structure_meta.narrative_function` 的双轨在 M4 是否合并。
- 【待定】`structure_meta` 是继续作为嵌套 dict, 还是把 `planning_state/needs_review/reviewed_at`
  等提为 frontmatter 平铺字段。

---

## PlotThread(M4 落点: `structure/threads.md`)

### 语义

剧情线 —— 贯穿多章的一条线索(主线/副线/暗线)。记录这条线想给读者的显性目标
(`visible_goal`)、隐藏真相(`hidden_truth`)、起止章节与当前阶段, 是「章 × 线索」剧情地图
的行维度。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string(slug) | 是 | 稳定标识 |
| status | enum | 是 | `draft` / `canonical` / `deprecated`, 见状态机 |
| name | string | 是 | 剧情线名称 |
| thread_type | string | 是 | 线类型(旧为自由字符串 ≤32, 常见 `main`) |
| summary | string | 否 | 概述 |
| visible_goal | string | 否 | 读者可见的目标 |
| hidden_truth | string | 否 | 隐藏真相(作者才知道) |
| start_chapter | int | 否 | 起始章节(≥1) |
| planned_payoff_chapter | int | 否 | 计划兑现章节(≥1) |
| current_stage | string | 否 | 当前阶段(旧为自由字符串, 如 `active`) |
| related_character_ids | list\<string\> | 否 | 关联人物引用 |
| related_entity_ids | list\<string\> | 否 | 关联实体引用 |
| related_memory_ids | list\<string\> | 否 | 关联记忆引用 |
| relations | list\<dict\> | 否 | 统一关系边(ADR-0019 N14, 同 Scene) |
| reader_known_state | string | 否 | 读者已知状态 |
| author_known_state | string | 否 | 作者已知状态 |
| provenance_meta | dict | 否 | 来源元信息(见下) |

**provenance_meta 子字段**(共享, 见 §「provenance_meta 公共子字段」):

| 子字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| source | enum | 否 | `manual` / `deep_import` / `ai_generated` |
| workflow_id | string | 否 | 产生工作流 id |
| auto_ingested | bool | 否 | 是否自动导入 |
| needs_review | bool | 否 | 是否需复核(旧 API 过滤键) |
| user_edited | bool | 否 | 作者是否改过 |
| confidence | float | 否 | 生成置信度 |
| review_reason | string | 否 | 需复核原因 |
| supporting_scene_ids | list | 否 | 支撑该线的 Scene 引用 |
| adopted_at | string | 否 | 采用时间(存在则 needs_review 置否) |

### 状态机

```
draft ──adopt──▶ canonical ──替换/删除──▶ deprecated
```

- 旧代码 status 为 String(≤32)默认 `draft`, 未用 Literal 强约束; 列表默认排除
  `deprecated`(`repositories.py:88`)。M4 统一为 draft → canonical → deprecated。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | plot_threads.id | |
| status | plot_threads.status | |
| name | plot_threads.name | |
| thread_type | plot_threads.thread_type | |
| summary | plot_threads.summary | |
| visible_goal | plot_threads.visible_goal | |
| hidden_truth | plot_threads.hidden_truth | |
| start_chapter | plot_threads.start_chapter | |
| planned_payoff_chapter | plot_threads.planned_payoff_chapter | |
| current_stage | plot_threads.current_stage | |
| related_character_ids | plot_threads.related_character_ids | JSON |
| related_entity_ids | plot_threads.related_entity_ids | JSON |
| related_memory_ids | plot_threads.related_memory_ids | JSON |
| reader_known_state | plot_threads.reader_known_state | |
| author_known_state | plot_threads.author_known_state | |
| provenance_meta | plot_threads.provenance_meta | JSON |

### 完整性规则

- 结构资产列表默认排除 `deprecated`; 未指定 status 时不返回已废弃
  (来源: `repositories.py:85-88`)。
- `related_thread_ids` 必须是同 novel 的有效 thread, 否则校验失败
  (来源: `services.py:85-88`)。
- Foreshadowing/Reveal 的「是否归类」判定以 PlotThread 的非 deprecated 集合为准
  (来源: `foreshadowing_repository.py:56-81`, `reveal_repository.py:52-77`)。
- 手动编辑自动导入(deep_import)产物时标记 `user_edited`
  (来源: `services.py:131-138`)。

### 待定

- 【待定】`thread_type` / `current_stage` 旧为自由字符串, M4 是否枚举化(如
  main/sub/mystery; stage 的 active/dormant/resolved)。

---

## OutlineArc(M4 落点: `structure/arcs.md`)

### 语义

篇章纲(卷/幕级弧线)。描述一段连续章节的整体起承转合: 篇章目标、核心冲突、主要对立、
入口钩子、中点转折、高潮、结果与钩向下一章的悬念。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string(slug) | 是 | 稳定标识 |
| status | enum | 是 | `draft` / `canonical` / `deprecated` |
| title | string | 是 | 篇章标题 |
| arc_index | int | 否 | 篇章序号(≥1) |
| start_chapter | int | 否 | 起始章节(≥1) |
| end_chapter | int | 否 | 结束章节(≥1) |
| arc_goal | string | 否 | 篇章目标 |
| core_conflict | string | 否 | 核心冲突 |
| main_opposition | string | 否 | 主要对立/反派力量 |
| entry_hook | string | 否 | 入口钩子 |
| midpoint_turn | string | 否 | 中点转折 |
| climax | string | 否 | 高潮 |
| result | string | 否 | 结果 |
| next_hook | string | 否 | 钩向下一章的悬念 |
| related_thread_ids | list\<string\> | 否 | 关联剧情线引用 |
| related_character_ids | list\<string\> | 否 | 关联人物引用 |
| related_entity_ids | list\<string\> | 否 | 关联实体引用 |
| relations | list\<dict\> | 否 | 统一关系边(ADR-0019 N14, 同 Scene) |
| provenance_meta | dict | 否 | 同 PlotThread 的 provenance_meta 公共子字段 |

### 状态机

同 PlotThread: `draft → canonical → deprecated`(旧 status 为 String, 默认 draft;
列表默认排除 deprecated)。

### 旧表映射

| frontmatter 字段 | 旧表.列 |
|---|---|
| id | outline_arcs.id |
| status | outline_arcs.status |
| title | outline_arcs.title |
| arc_index | outline_arcs.arc_index |
| start_chapter | outline_arcs.start_chapter |
| end_chapter | outline_arcs.end_chapter |
| arc_goal | outline_arcs.arc_goal |
| core_conflict | outline_arcs.core_conflict |
| main_opposition | outline_arcs.main_opposition |
| entry_hook | outline_arcs.entry_hook |
| midpoint_turn | outline_arcs.midpoint_turn |
| climax | outline_arcs.climax |
| result | outline_arcs.result |
| next_hook | outline_arcs.next_hook |
| related_thread_ids | outline_arcs.related_thread_ids |
| related_character_ids | outline_arcs.related_character_ids |
| related_entity_ids | outline_arcs.related_entity_ids |
| provenance_meta | outline_arcs.provenance_meta |

### 完整性规则

- `arc_index` / `start_chapter` / `end_chapter` 均 ≥1(`schemas.py:111-113`)。
- 同 PlotThread: 排除 deprecated、related 引用同 novel 校验、user_edited 标记。
- Scene 规划层的 `parent_outline_arc_id` 必须解析到真实 arc 引用
  (来源: `p20_service.py:971-974`)。

### 待定

- 【待定】arc 与章节区间(arc_index/start/end)是否要做「区间不重叠/按序」的确定性校验
  (旧代码未见强制)。

---

## StoryOutline · 总纲及其修订(M4 落点: 【待定】建议 `structure/outline.md`)

### 语义

小说级总纲(整本书的创意核心、主情节线、宏观运动与未决问题)。旧代码用
「不可变修订链 + 当前指针」实现: 每次采用生成一个新 revision(版本号递增), `head`
指向当前版本; apply 即「恢复某个版本为当前」, 带 CAS 与幂等。

### frontmatter 字段(内容部分)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| title | string | 是 | 总纲标题(≤255) |
| creative_core | object | 是 | 创意核心, 见子字段 |
| outline_markdown | string | 是 | 总纲正文 Markdown(≤200000) |
| major_storylines | list\<object\> | 是 | 主情节线(≤100 条), 见子字段 |
| macro_movements | list\<object\> | 是 | 宏观运动(≤100 段), 见子字段 |
| open_decisions | list\<object\> | 是 | 未决问题(≤100 项), 见子字段 |

**creative_core 子字段**: `premise`(必)、`tone_and_reader_promise`(必)、`story_engine`(必)、
`ending_direction`(选)。来源: `story_outline_schemas.py:54-58`。

**major_storylines 元素**: `name`、`narrative_function`、`trajectory`、`intersections[]`、
`resolution_direction`。来源: `story_outline_schemas.py:61-66`。

**macro_movements 元素**: `name`、`story_state_change`、`advanced_storylines[]`。
来源: `story_outline_schemas.py:69-72`。

**open_decisions 元素**: `question`、`why_it_matters`、`options[]`。
来源: `story_outline_schemas.py:75-78`。

**修订元字段(revision 层)**:

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| version_number | int | 是 | 单调递增版本号(≥1) |
| source | enum | 是 | `manual` / `ai_generated` / `restored` |
| base_revision_id | string | 否 | 基于哪个版本(CAS 依据) |
| restored_from_revision_id | string | 否 | apply 时被恢复的原版本 |
| idempotency_key | string | 是 | 幂等键(8–128, 同 novel 唯一) |
| content_hash | string | 是 | 内容 sha256(64 hex) |
| provenance | object | 是 | 见子字段(actor/note/client_ref/source_refs/story_execution_profile) |

### 状态机

总纲没有 draft/canonical 状态机; 其「版本」即状态:

```
head.current_revision_id  ──create_revision──▶ 新 revision 成为 current
                          ──apply_revision────▶ 恢复目标版本内容为新 revision, 成为 current
```

- 每次写入都产生新 revision, 旧 revision 不可变(不硬改不硬删)。
- `StoryOutlineHead` 每 novel 唯一指针(`story_outline_heads.novel_id` 唯一约束)。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| title | story_outline_revisions.title | |
| creative_core | story_outline_revisions.creative_core_json | JSON |
| outline_markdown | story_outline_revisions.outline_markdown | |
| major_storylines | story_outline_revisions.major_storylines_json | JSON |
| macro_movements | story_outline_revisions.macro_movements_json | JSON |
| open_decisions | story_outline_revisions.open_decisions_json | JSON |
| version_number | story_outline_revisions.version_number | |
| source | story_outline_revisions.source | manual/ai_generated/restored |
| base_revision_id | story_outline_revisions.base_revision_id | |
| restored_from_revision_id | story_outline_revisions.restored_from_revision_id | |
| idempotency_key | story_outline_revisions.idempotency_key | |
| content_hash | story_outline_revisions.content_hash | |
| provenance | story_outline_revisions.provenance_json | JSON |
| (当前指针) | story_outline_heads.current_revision_id | M4 → git HEAD |

### 完整性规则(revisions/apply 的 CAS 与幂等)

- **CAS**: apply/create 时 `base_revision_id` 必须等于 `head.current_revision_id`,
  否则冲突报错(来源: `story_outline_service.py:352-361`)。
- **幂等**: 相同 `idempotency_key` 命中已存在 revision; 若 `request_hash` 不一致则冲突
  (来源: `story_outline_service.py:337-350, 116-123`)。
- **content_hash**: `sha256(排序后的内容 JSON)`, 内容六字段(title/creative_core/
  outline_markdown/major_storylines/macro_movements/open_decisions)
  (来源: `story_outline_service.py:363-375, 521-529`)。
- **apply 保留内容**: apply_revision 深拷贝目标内容生成 `source="restored"` 的新 revision,
  `content_hash` 沿用目标 hash(来源: `story_outline_service.py:186-205`)。
- **并发**: 写前对 head 加行锁 + PG advisory 锁(`story_outline_repository.py:22-42`)。
  M4 下等价于「一次 adopt 一个 commit, 冲突用 git 拒绝」。
- **执行侧派生**: `story_execution_profile`(premise/tone/story_engine/ending_direction/
  major_storyline_directions/macro_state_changes)随 revision 固化, 供 Scene 执行时引用
  (来源: `story_outline_service.py:388-426`, `story_outline_schemas.py:81-93`)。

### 待定

- 【待定】总纲在 M4 工作区的落点: §22.2 未显式列出总纲路径, 建议 `structure/outline.md`
  (revision 链 → git commit 历史, `content_hash` 进 frontmatter)。
- 【待定】`version_number` 单调递增在 M4 是否退化为 git 提交序列, 不再单独存数字。

---

## ForeshadowingPlan(M4 落点: `structure/foreshadowing.md`)

### 语义

伏笔计划 —— 贯穿多章的伏笔链: 某处埋下(表面含义)、若干处强化、最终兑现(隐藏含义)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string(slug) | 是 | 稳定标识 |
| status | enum | 是 | `draft` / `canonical` / `deprecated` |
| name | string | 是 | 伏笔名称 |
| summary | string | 否 | 概述 |
| surface_meaning | string | 否 | 表面含义 |
| hidden_meaning | string | 否 | 隐藏含义 |
| planned_seed_chapter | int | 否 | 埋设章节(≥1) |
| planned_reinforce_chapters | list\<int\> | 否 | 强化章节列表(每项 ≥1) |
| planned_payoff_chapter | int | 否 | 兑现章节(≥1) |
| planned_payoff_scene | string(slug) | 否 | 兑现 Scene 引用(adjudication #11: 整数索引 → slug) |
| related_entity_ids | list\<string\> | 否 | 关联实体引用 |
| related_thread_ids | list\<string\> | 否 | 关联剧情线引用 |
| relations | list\<dict\> | 否 | 统一关系边(ADR-0019 N14, 同 Scene) |
| provenance_meta | dict | 否 | 同 PlotThread 公共子字段 |

### 状态机

同 PlotThread: `draft → canonical → deprecated`(旧 status String 默认 draft, 列表排除 deprecated)。

### 旧表映射

| frontmatter 字段 | 旧表.列 |
|---|---|
| id | foreshadowing_plans.id |
| status | foreshadowing_plans.status |
| name | foreshadowing_plans.name |
| summary | foreshadowing_plans.summary |
| surface_meaning | foreshadowing_plans.surface_meaning |
| hidden_meaning | foreshadowing_plans.hidden_meaning |
| planned_seed_chapter | foreshadowing_plans.planned_seed_chapter |
| planned_reinforce_chapters | foreshadowing_plans.planned_reinforce_chapters |
| planned_payoff_chapter | foreshadowing_plans.planned_payoff_chapter |
| planned_payoff_scene | foreshadowing_plans.planned_payoff_scene |
| related_entity_ids | foreshadowing_plans.related_entity_ids |
| related_thread_ids | foreshadowing_plans.related_thread_ids |
| provenance_meta | foreshadowing_plans.provenance_meta |

### 完整性规则

- **未归类判定**: `related_thread_ids` 与非 deprecated PlotThread 的交集为空 → 视为
  「未归入有效剧情线」(`unassigned=True` 过滤; 来源: `foreshadowing_repository.py:56-81`)。
- 章节字段边界: seed/reinforce/payoff ≥1, payoff_scene 为 slug(adjudication #11)
  (`schemas.py:675-678`)。
- 按 `planned_seed_chapter` 排序(`foreshadowing_repository.py:16, 49-52`)。

---

## RevealPlan(M4 落点: `structure/reveal/<slug>.md`, adjudication #2/N12 目录化)

### 语义

信息揭示计划 —— 对某个秘密(target)分层逐步披露: 每阶段在指定章节揭示一部分内容,
带触发条件与效果。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string(slug) | 是 | 稳定标识 |
| status | enum | 是 | `draft` / `canonical` / `deprecated` |
| target_type | string | 是 | 目标类型(如 world_entity / character, ≤32) |
| target_id | string | 是 | 目标对象引用 |
| secret_summary | string | 是 | 被隐藏的秘密 |
| reveal_stages | list\<object\> | 否 | 揭示阶段, 见子字段 |
| related_thread_ids | list\<string\> | 是 | 关联剧情线引用(空数组 = 尚未归类) |
| relations | list\<dict\> | 否 | 统一关系边(ADR-0019 N14, 同 Scene; 配对用 `reveals_foreshadowing`) |
| provenance_meta | dict | 否 | 同 PlotThread 公共子字段 |

**reveal_stages 元素**:

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| stage_index | int | 是 | 阶段序号(≥0) |
| chapter_index | int | 是 | 揭示章节(≥1) |
| reveal_content | string | 否 | 揭示的内容 |
| trigger | string | 否 | 触发条件 |
| effect | string | 否 | 效果 |

### 状态机

同 PlotThread: `draft → canonical → deprecated`(旧 status String 默认 draft)。

### 旧表映射

| frontmatter 字段 | 旧表.列 |
|---|---|
| id | reveal_plans.id |
| status | reveal_plans.status |
| target_type | reveal_plans.target_type |
| target_id | reveal_plans.target_id |
| secret_summary | reveal_plans.secret_summary |
| reveal_stages | reveal_plans.reveal_stages |
| related_thread_ids | reveal_plans.related_thread_ids |
| provenance_meta | reveal_plans.provenance_meta |

### 完整性规则

- **未归类判定**: 同 ForeshadowingPlan(`related_thread_ids` ∩ 非 deprecated thread 为空 →
  unassigned; 来源: `reveal_repository.py:52-77`)。
- **读者可见保守求值**: 对某 target 在截止章 `cutoff_chapter` 前, 只取
  `chapter_index < cutoff_chapter` 的已完成阶段, 取最大 `(chapter, stage_index)` 作为已揭示
  (不猜同章内顺序; 来源: `reveal_visibility.py:39-67`)。
- 按 `created_at` 排序(`reveal_repository.py:17, 49`)。

### 待定

- 【待定】`reveal_stages` 无 in-chapter offset, 同章内先后顺序在 M4 是否需要更细粒度。

---

## 派生索引与查询模型(M4 落点: 派生索引, 可全量重建, 不进文件夹真相)

以下旧表是**派生查询索引**, 非创作资产本体; M4 下由 `ctx.storage` 派生索引承担,
任何时刻可 `store rebuild-index` 重建(§22.2 行 711-713)。

| 旧表 | 用途 | M4 落点 |
|---|---|---|
| scene_spans | Scene → 正文物理片段(offset/段落/锚点, mapping_status: exact/reanchored/chapter_only/unresolved) | 派生索引, 可由正文 + Scene frontmatter 重建 |
| scene_chapter_links | Scene ↔ 章节编号查询索引 | 派生索引 |
| scene_summary_checkpoints | Scene 按可见截止位置的防剧透摘要 | 派生索引 |
| scene_fusion_suggestions | 持久 Scene 融合建议(pending/adopted/dismissed/stale) | 信号/收件箱(.assistant/signals/*.json) |

跨类关系索引(ADR-0019 §4): 结构资产 + Scene 的 `relations` 边与 `related_*_ids`
兼容投影统一进 `VaultIndex.relations`(sourceKind 标注源 kind), `storyMap().edges`
消费该索引, 仍为纯派生、可全量重建、非编辑入口。

来源: `models.py:248-410`, `schemas.py:539-610`; mapping_status 枚举见
`scene_workbench.py:103-108`。

---

## 结构健康信号(M4 落点: 写作雷达 + 收件箱 `.assistant/signals/*.json`)

四类 Scene 健康信号(作者语言 → 内部键), 是「结构健康 → 写作雷达 + 收件箱」的判定来源
(§20.6)。来源: `scene_workbench.py:74-79`。

| 内部键 | 作者语言 | 判定(来源) |
|---|---|---|
| unreviewed | 未复核 | needs_review 为真, 或 deep_import/ai_generated 且 draft/candidate 且无 reviewed_at(`scene_workbench.py:1993-1998`) |
| unassigned | 未关联章节 | chapter_ids 空且 planning_state ≠ planned(`scene_workbench.py:1999-2001`) |
| missing_setup | 缺设定 | `scene_has_missing_setup`(`services.py:91-113`) |
| needs_organize | 待整理 | 存在任一整理类 reason(`scene_workbench.py:2004-2005`) |

**整理类 reason 明细**(作者语言 → 内部键, 来源: `scene_workbench.py:81-89, 2008-2069`):

| 内部键 | 作者语言 |
|---|---|
| manual_organize | Scene 结构待确认(meta.needs_organize) |
| duplicate_chapter | Scene 内章节重复 |
| overlapping_span | Scene 正文片段与其他 Scene 重叠 |
| chunk_chapter_mismatch | 章节与正文分段不一致 |
| source_mapping_chapter_only | 正文定位仅精确到章节 |
| source_mapping_unresolved | 正文定位需重新确认 |
| pending_scene_fusion_suggestion | 有 Scene 融合建议待处理 |

> 注意: `unreviewed/unassigned/missing_setup` 三项是**健康键**(由确定性字段直接判定),
> `needs_organize` 是**聚合键**(由 reason 列表非空派生), 二者在 M4 收件箱中应区分呈现。

### 完整性规则

- 健康信号必须**确定性**、由 frontmatter 字段推导, 不得依赖 LLM 实时判断
  (来源: `scene_workbench.py:1972-2069` 全为纯字段推导)。
- 信号新鲜度: 用户手改文件后重建索引即一致(§22.2 行 711-713)。

### 待定

- 【待定】四类健康键之外, p20/去重层还有 `needs_review`(结构资产级)与
  `unassigned`(Foreshadowing/Reveal 级)两个**资产级**过滤键, 是否与 Scene 四键统一为
  一套「信号命名规范」需在 rules 目录另行裁定。

---

## 附录: 公共枚举与状态速查

| 概念 | 取值 | 来源 |
|---|---|---|
| Scene.status | draft / canonical / deprecated(候选: candidate/proposal) | `schemas.py:209/232`, `repositories.py:1197` |
| NarrativeTag | draft / hook / inciting_incident / rising_action / climax / valley / transition / payoff | `contracts.py:29-38` |
| SceneSemanticFieldStatus | present / not_applicable / uncertain | `contracts.py:15-20` |
| Scene.source | manual / deep_import / ai_generated / manual_fusion / mechanical_fusion / extractive | `models.py:211-216`, `scene_source_service.py:221-229` |
| mapping_status | exact / reanchored / chapter_only / unresolved | `scene_workbench.py:103-108` |
| planning_state | planned / materialized | `p20_service.py:935-952` |
| StoryOutline.source | manual / ai_generated / restored | `story_outline_schemas.py:208` |
