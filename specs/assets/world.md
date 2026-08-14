# world 资产规格(R0 提取)

- 来源 commit: a257df23e
- 提取日期: 2026-08-14
- 提取范围: 以下旧 Python 代码文件(均位于 `backend/modules/world/`):
  - `models/core.py`、`models/common.py`、`models/worldbuilding.py`、`models/character.py`、`models/profiles.py`、`models/__init__.py`
  - `schemas.py`、`contracts.py`、`asset_state.py`
  - `services/core/entity_service.py`、`entity_alias_service.py`、`entity_relation_service.py`、`entity_type_transition_service.py`、`dedup_service.py`、`entity_types.py`
  - `services/worldbuilding/suggestion_queue_service.py`、`world_bible_service.py`、`world_bible_lifecycle_service.py`、`knowledge_tag_service.py`、`adoption_package_service.py`、`shared.py`
  - `entity_fusion.py`
- 背景映射依据: `docs/agent/dsh-rebuild/自主智能式作家助手设计.md` §22.2(文件夹真相)、§19(生成中心)、§6.1(去重 L0–L4)、§24.2(frontmatter 草案)。

> 说明: 本文件只写「创作资产 schema + 状态机 + 完整性规则」, 不覆盖 API 请求/响应信封。所有字段的「M4 落点」为 §22.2 的文件夹真相路径; 旧表映射按 `表名.列名` 给出。不确定处一律标【待定】。

---

## 世界对象 CoreEntity(M4 落点: `world/objects/*.md`(canonical)+ `world/pending/*.md`(draft/candidate/merged 等未采用态))

### 语义

统一的核心实体 = 所有世界对象的正史记录(人物/地点/势力/物品/事件/种族/规则/秘密等, 共用一个对象表)。正史(已采用)对象落在 `world/objects/`, 待处理候选落在 `world/pending/`, adopt = 从 pending 移入 objects 并 commit(§22.2)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 稳定标识; M4 由旧 UUID 派生为文件名/slug(如 `obj_klein`) |
| kind | string | 是 | 实体类型(旧 `entity_type`, 自由字符串; 系统目录见下) |
| name | string | 是 | 实体名称 |
| status | enum | 是 | 见状态机; canonical/pending 之外的历史态映射见下 |
| aliases | list\<string\|object\> | 否 | 别名列表, 附着本对象, 不建新对象(见「别名」节) |
| summary | string | 否 | 概要 |
| public_info | string | 否 | 对外公开信息(读者可见) |
| hidden_truth | string | 否 | 隐藏真相(仅作者视角) |
| importance | float | 否 | 重要性 0.0~1.0 |
| importance_level | enum | 否 | core/important/normal/temporary |
| reveal_level | enum | 否 | author_only/hinted/revealed/fully_known |
| evidence | list\<ref\> | 否 | 证据引用(source/quote), 溯源用 |
| workflow | string | 否 | 来源 workflow(如 import-deep) |
| adopted_at | datetime | 否 | 采用时间(adopt 时写入) |
| content_hash | string | 否 | 内容哈希; 每次内容变更更新, 工作区脏时拒绝 adopt(§22.2/§24.2) |
| 扩展体 | object | 否 | kind 相关的强类型扩展(character/event/profile 档案), 并入对象正文而非独立文件 |

### 状态机

```
draft / candidate ──adopt(promote)──▶ canonical
draft / candidate ──merge/alias──▶ merged(标记 merged_into, 不硬删)
draft / candidate ──reject 建议──▶ ignored(兼容影子归档)
canonical ──delete(软删)──▶ deprecated
```

- 仅 `draft/candidate` 可提升为 `canonical`(来源: `entity_service.py` promote 677–681)。
- `delete` = 软删: 已 `deprecated` 再删为 no-op; 从不物理删除(来源: `entity_service.py` delete 595–616)。
- 合并/别名归并: candidate 置 `merged` 并在 `content_json.merged_into` 记录目标, 不硬删(来源: `dedup_service.py` 530–541、`entity_alias_service.py` 1052–1062)。
- 作者面向投影(来源: `asset_state.py` 12–32): `active` = {active, canonical, confirmed, published}; `review` = {candidate, conflicted, draft, needs_review, pending, processing, proposal}; `archived` = {accepted, deprecated, ignored, merged, rejected, rolled_back}。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | core_entities.id | UUID → 文件名/slug |
| kind | core_entities.entity_type | 系统目录 + 作者自定义; 见 `entity_types.py` SYSTEM_ENTITY_TYPE_CATALOG(20 类) |
| name | core_entities.name | — |
| status | core_entities.status | — |
| summary | core_entities.summary | — |
| public_info | core_entities.public_info | — |
| hidden_truth | core_entities.hidden_truth | — |
| importance / importance_level | core_entities.importance / importance_level | — |
| reveal_level | core_entities.reveal_level | — |
| aliases | core_entities.content_json.aliases | JSONB, 非独立表 |
| (动态属性) | core_entities.content_json | JSONB; _meta 存 source/needs_review/suggested_action 等 |
| 扩展体 character | characters.* | entity_id PK+FK 1:1(见下「扩展资产」) |
| 扩展体 event | events.* | entity_id PK+FK 1:1 |
| 扩展体 profile | *_profiles / generic_entity_profiles | 强类型/通用档案 |
| 图片 | core_entities.image_version / image_updated_at | 见「图片字段」节【待定】 |

### 完整性规则(必须在 @novelcraft/store 保留的确定性规则)

- **别名不建新对象**: 别名只附着已有 `core_entities.content_json.aliases`; 实体抽取时别名一律挂到已有对象, 不重复建实体(来源: AGENTS.md「实体抽取只保留长期创作资产」、`entity_alias_service.py` 全文、§22.2「别名不建新对象 → object frontmatter aliases: []」)。
- **已采用不硬删除**: canonical 对象删除 = 置 `deprecated` + 打快照, 不物理删除; git 历史天然保留(来源: `entity_service.py` delete 579–650、§22.2)。
- **adopt 门禁**: 只有 `draft/candidate` 可 promote 为 canonical; 已 canonical 对象不能走普通 update 直接改 status=canonical, 必须走 promote(来源: `entity_service.py` 439–442、677–681)。
- **建议影子隔离**: `compatibility_shadow=True` + `suggestion_id` 的实体(待处理建议的兼容影子)只能经建议队列裁决/编辑, 不能直接 CRUD(来源: `entity_service.py` 571–577、`entity_alias_service.py` 183–195)。
- **类型切换门禁**: 改变 `entity_type` 必须过 `EntityTypeTransitionService`, 且当存在依赖当前类型的专属数据(character/event/location/species 扩展、知识引用、活跃档案、活跃建议/冲突)时拒绝(来源: `entity_type_transition_service.py` 39–200)。
- **合并/归并可逆且不硬删**: 合并把 source 置 `merged`, 继承别名、迁移关系、去重自环, 不在库中抹掉 source(来源: `dedup_service.py` 494–541)。
- **novel_id 隔离**: 所有读写按 novel_id 过滤; M4 下每书一个文件夹 + 每书一个 session(来源: 各服务 `parse_uuid(novel_id)`、§22.2)。
- **派生索引可重建**: search_text / pinyin / embedding 只是检索加速, 非真相; M4 由 sqlite domain KV 派生索引全量重建(来源: `models/core.py` 97–113、§22.2「索引规则」)。

### 待定

- 【待定】`content_json` 中除 `aliases`/`_meta` 外的自由动态属性在 frontmatter 的具体落法(展开为独立字段还是保留自由 KV)。
- 【待定】`image_version` / `image_updated_at` / `has_image` 是否保留——见「图片字段」节(D19 决策 v1 砍掉)。
- 【待定】`importance/importance_level/reveal_level` 三档层级是否继续作为 frontmatter 一等字段, 还是并入 `content` 派生。

---

## 扩展资产: 人物 Character / 事件 Event / 世界观档案 Profile(落点: 并入对应 `world/objects/*.md` 正文)

### 语义

CoreEntity 的 1:1 扩展, 按 `kind` 存在: character(人物档案)、event(事件时序)、强类型/通用 profile(种族/势力/地点/规则/物品/秘密档案)。M4 下并入对象文件正文, 不独立成文件(【待定】)。

### 旧表映射(备查)

- `characters`(entity_id PK+FK → core_entities): role/appearance/personality/desire/fear/secret/weakness/current_goal/current_state/current_emotion/stance/voice_style/behavior_rules/relationship_summary/aliases/meta(来源: `models/character.py` 33–145)。
- `events`(entity_id PK+FK): source_chapter_id/location_entity_id/timeline_order/occurrence_time_label(来源: `models/core.py` 176–217)。
- `*_profiles`(species/faction/location/rule/item/secret, `_ProfileMixin`)+ `generic_entity_profiles` + `entity_profile_templates`(来源: `models/profiles.py` 28–190)。

### 完整性规则

- 扩展与对象同生命周期: 扩展的 PK/FK 绑定 core_entities.id; 对象软删/合并时扩展同步处理(character 同步见 `dedup_service.py` `_sync_character_on_merge`)。
- 类型切换时强类型档案迁移有「活跃档案一致性」门禁, 档案与当前类型不一致时拒绝迁移(来源: `entity_type_transition_service.py` `_migrate_profile` 368–382)。

---

## 别名 Alias(M4 落点: 对象 frontmatter `aliases: []`, 不独立成文件)

### 语义

同一对象的其他称呼(小名/代称/身份)。**别名永远附着已有对象, 不创建新实体**; 深度导入产生的重复名一律挂别名或复核, 不新建重复实体。

### frontmatter 字段(aliases 数组元素的 dict 形态)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| alias | string | 是 | 别名文本(去首尾空白) |
| type | string | 否 | 别名类型(name/alias 等; `suggest_alias_type` 给推荐值) |
| status | enum | 否 | candidate/canonical/confirmed/ignored/conflicted |
| source | string | 否 | manual / deep_import / 来源 module |
| confidence | float | 否 | 0~1 置信度 |
| quote / evidence_refs | string / list | 否 | 原文依据与证据引用 |
| workflow_id / scene_id / scene_index / source_chapter_index | 混合 | 否 | 来源溯源 |
| needs_review / reviewed_at / reviewed_by / reviewed_from | 混合 | 否 | 复核状态与审计 |
| user_edited / edited_at / edited_by | 混合 | 否 | 人工编辑标记 |

### 状态机

```
candidate ──accept/adopt──▶ canonical(confirmed)
candidate ──ignore──▶ ignored
confirmed/canonical 可编辑文本/类型或移动到另一对象
导入重复不降级已采用别名(见完整性规则)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| aliases[] | core_entities.content_json.aliases | JSONB; 历史兼容纯 string 形态 |
| (legacy) | characters.aliases | 旧人物别名 JSON, 已被 content_json.aliases 取代 |

### 完整性规则(必须在 store 保留的确定性规则)

- **别名不建新对象**: `resolve_candidate_as_alias` 把 candidate 对象归并为 target 的别名并置 candidate 为 `merged`(来源: `entity_alias_service.py` 937–1092)。
- **别名去重**: 归一化(合并空白 + casefold)后重复 → 拒绝创建(409)/拒绝移动(来源: `entity_alias_service.py` 205–219、739–743)。
- **已采用别名不被导入降级**: `append_candidate_alias` 遇到已存在且非 candidate 或非 deep_import 的别名直接返回 False, 不改动其生命周期/provenance(来源: `entity_alias_service.py` 1126–1160)。
- **别名目标必须是活跃对象**: 目标 status ∈ {draft, canonical, candidate}; compatibility_shadow 目标禁止(来源: `entity_alias_service.py` 40、174–195)。
- **复核 CAS**: 别名复核用 `execution_fingerprint` 防 stale, 指纹不一致 → stale_execution(来源: `entity_alias_service.py` 652–655、`review_batch`)。
- **导入回滚只归档未复核候选别名**: `rollback_deep_import_candidates_by_workflow` 只把 source=deep_import 且未人工编辑的 candidate 别名置 ignored(来源: `entity_alias_service.py` 1180–1228)。

---

## 关系 EntityRelation(M4 落点: relations 索引(可重建), 反向关系由索引派生)

### 语义

两个世界对象之间的有向关系边(source → relation_type → target), 带章节/事件追溯与原文依据。M4 中关系是「派生索引」, 任何时刻可由对象文件全量重建(§22.2)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 关系稳定标识 |
| source_ref | string | 是 | 源对象引用(旧 source_id) |
| target_ref | string | 是 | 目标对象引用(旧 target_id) |
| relation_type | string | 是 | 关系类型(自由字符串) |
| description | string | 否 | 关系描述 |
| strength | float | 否 | 关系强度 0.0~1.0 |
| quote | string | 否 | 原文依据 |
| source_chapter_id | string | 否 | 来源章节 |
| caused_by_event_id | string | 否 | 导致此关系的事件 |
| status | enum | 是 | candidate/canonical/deprecated |
| review_meta | object | 否 | 来源/证据/复核审计元数据 |

### 状态机

```
candidate ──accept/adopt──▶ canonical
candidate ──ignore──▶ deprecated
canonical ──delete(软删)──▶ deprecated
合并时: 同名同向边去重 → 被并入边置 deprecated(不硬删)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | entity_relations.id | — |
| source_ref / target_ref | entity_relations.source_id / target_id | FK core_entities.id |
| relation_type | entity_relations.relation_type | — |
| description / strength | entity_relations.description / strength | — |
| quote | entity_relations.quote | — |
| source_chapter_id | entity_relations.source_chapter_id | FK imported_chapters.id |
| caused_by_event_id | entity_relations.caused_by_event_id | — |
| status | entity_relations.status | candidate/canonical/deprecated |
| review_meta | entity_relations.review_meta | JSONB 审计 |

### 完整性规则(必须在 store 保留的确定性规则)

- **同向同型边去重**: (source, target, relation_type) 唯一; create 重复 → 409(来源: `entity_relation_service.py` 306–314、`find_duplicate_relation`)。
- **关系不自动归并(已采用边)** : `create_or_merge` 遇已 canonical 且 incoming 非 canonical 的边 → 仅返回 `deduplicated`, **不改动** 其内容/来源/强度, 等待作者显式决策(来源: `entity_relation_service.py` 366–374)。
- **已采用不硬删除**: 关系删除/忽略/被合并 → `deprecated`, 不物理删除(来源: `entity_relation_service.py` `review_batch` ignore/merge、`rollback_deep_import_candidates_by_workflow`)。
- **端点必须是活跃对象**: source/target status ∈ {canonical, draft, candidate} 且非 compatibility_shadow(来源: `entity_relation_service.py` 57–120)。
- **自环禁止**: create 时 source==target 拒绝; 合并只清理迁移产生的自环, 不碰 target 原有合法自环(来源: `entity_relation_service.py` 95–96、`dedup_service.py` 507–514)。
- **合并关系迁移**: merge 实体时把 candidate 的关系迁移到 target, 同名边合并描述并置旧边 deprecated(来源: `dedup_service.py` `_migrate_relations` 707–774)。
- **复核 CAS**: 关系复核用 group `execution_fingerprint` 防 stale(来源: `entity_relation_service.py` 765–768)。

---

## 待处理建议 CreationSuggestion(M4 落点: `world/pending/*.md`(suggestion queue = pending/ 目录)+ 收件箱信号卡)

### 语义

所有 AI/导入产出的「待处理建议」统一入队, 不直接写已采用资产。adopt = 经建议队列裁决 + approval。§19 明确: suggestions(typed 待处理)在 M4 = `stage_candidates(world_suggestion)` → 收件箱信号卡 → adopt + approval。

### frontmatter 字段(建议头 + 按 target_type 的 payload)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 建议稳定标识 |
| source_module | string | 是 | 来源模块(world/imports/deep_import 等) |
| review_group | string | 是 | 复核分组(如 import 工作流/生成中心) |
| target_type | enum | 是 | core_entity / core_entity_draft / entity_relation / entity_alias / profile_field / world_bible_page_draft / world_core_checkpoint / world_adoption_package |
| action_schema | string | 是 | payload 的 schema 版本(如 v1) |
| payload | object | 是 | 按 target_type 强类型校验的提案体 |
| evidence_refs | list\<ref\> | 否 | 证据引用 |
| risk_level | enum | 否 | low/medium/high/critical |
| status | enum | 是 | pending → accepted/rejected(见状态机) |
| suggested_action | string | 否 | 建议动作(adopt/merge_with(...) 等) |
| confidence | float | 否 | 置信度(用于信号排序) |
| revision_link | object | 否 | 前后继建议链(修订链) |

### 状态机

```
pending ──confirm──▶ accepted(单赢家, CAS claim)
pending ──reject──▶ rejected(归档兼容影子)
pending/processing = review 面; accepted/rejected = archived 面
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | creation_suggestion_queue.id | — |
| source_module | creation_suggestion_queue.source_module | — |
| review_group | creation_suggestion_queue.review_group | — |
| target_type | creation_suggestion_queue.target_type | — |
| action_schema | creation_suggestion_queue.action_schema | — |
| payload | creation_suggestion_queue.payload_json | JSONB, 按 target_type 校验 |
| evidence_refs | creation_suggestion_queue.evidence_refs_json | — |
| risk_level | creation_suggestion_queue.risk_level | — |
| status | creation_suggestion_queue.status | — |
| result_ref + revision_link | creation_suggestion_queue.result_ref_json | 采纳结果引用与修订链 |

### 完整性规则(必须在 store 保留的确定性规则)

- **建议只进待处理**: LLM/导入产物只写 `creation_suggestion_queue`, 不直接写已采用资产; 采用必经队列 + approval(来源: `suggestion_queue_service.py` 79–99 注释、AGENTS.md「普通 LLM 输出只进入待处理建议」)。
- **单赢家裁决**: confirm/reject 共用 CAS claim, 重复裁决只有一个生效(来源: `suggestion_queue_service.py` `_claim_pending`、1056–1059)。
- **采纳前重验**: apply 前对 payload 强类型重验; adoption package 用 preview_hash CAS; 世界书 draft 建议走 generation-center draft endpoint 重验后只写工作稿(来源: §19、`suggestion_queue_service.py` `_validated_payload_json`、422–426)。
- **reject 归档影子**: 拒绝 core_entity 建议时把兼容影子置 `ignored` 并写 suggestion_disposition=rejected(来源: `suggestion_queue_service.py` `_archive_compatibility_shadow` 1074–1108)。
- **采纳目标必须是已采用对象**: merge/alias 裁决的 target 必须 canonical(来源: `suggestion_queue_service.py` `_require_canonical_target` 942–955)。
- **关系建议经 create_or_merge**: 关系建议 adopt 时走 `create_or_merge`(去重、已 canonical 边不动), 而非盲建(来源: `suggestion_queue_service.py` 521–535)。

### 待定

- 【待定】`profile_field` 建议在 M4 的落点(强类型档案并入对象正文后, profile_field 是否还存在)。
- 【待定】`world_core_checkpoint`(只读收敛检查点)与 `world_adoption_package` 是否继续作为建议子类型保留, 或分别下沉为独立文件形态(见「采纳包」节)。

---

## 世界书页面 WorldBiblePage(M4 落点: `bible/*.md`, frontmatter status: draft/canonical)

### 语义

世界书手册页面(世界观设定页), 分「已发布页面(canonical)」与「服务器工作稿(draft)」。发布 = adopt + commit; publish-impact = 只读插件(§22.2)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 页面稳定标识 |
| page_type | string | 是 | 页面类别(custom/background/species/faction/location/rule/secret) |
| page_key | string | 是 | 唯一 slug(novel_id+page_key 唯一) |
| title | string | 是 | 标题 |
| status | enum | 是 | draft/canonical/archived(见状态机) |
| body / free_text | string | 否 | 自由正文 |
| sections | list\<section\> | 否 | 结构化小节(markdown/checklist/asset_collection) |
| linked_asset_refs | list\<ref\> | 否 | 链接到 canonical 资产的引用(sha256 引用) |
| activation_defaults | object | 否 | 激活默认值 |
| template_key / template_version | string / int | 否 | 来源模板 |
| version_number | int | 是 | 版本号(每次发布 +1) |
| content_hash | string | 否 | 内容哈希(CAS + 派生失效) |

### 状态机

```
draft ──publish/adopt──▶ canonical(新页 version=1; 旧页 version+1)
canonical ──再编辑──▶ 新工作稿(draft)──publish──▶ canonical(version+1)
canonical ──软删──▶ archived
```

- 已采用状态集合 = {canonical, confirmed}(来源: `world_bible_lifecycle_service.py` 143)。
- 一页同时只有一个活跃工作稿(唯一约束 `uq_world_bible_page_active_draft`); 有活跃工作稿时不允许直接改已发布页(来源: `world_bible_lifecycle_service.py` 197–198)。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | world_bible_pages.id | — |
| page_type / page_key / title | world_bible_pages.page_type / page_key / title | — |
| status | world_bible_pages.status | — |
| body / free_text | world_bible_pages.free_text | — |
| sections | world_bible_pages.sections_json | 每节 section_id/type/title/body_markdown/sort_order/linked_asset_ref_hashes/projection_policy/sensitivity_hint |
| linked_asset_refs | world_bible_pages.linked_asset_refs_json | — |
| activation_defaults | world_bible_pages.activation_defaults_json | — |
| template_key / template_version | world_bible_pages.template_key / template_version | — |
| version_number | world_bible_pages.version_number | — |
| 工作稿 | world_bible_page_drafts.* | base_version_number 为发布 CAS 基线 |
| 版本快照 | world_bible_page_revisions.* | snapshot_json + revision_reason 不可变版本 |

### 完整性规则(必须在 store 保留的确定性规则)

- **发布 CAS**: 发布工作稿时校验 `draft.base_version_number == page.version_number`, 不一致 → ConflictError(「页面在草稿创建后被修改」)(来源: `world_bible_lifecycle_service.py` 657–660)。
- **已采用不硬删**: 页面发布逐版累加 version_number, 旧版本进 `world_bible_page_revisions` 快照; 软删归档而非物理删除(来源: `world_bible_lifecycle_service.py` `_record_adopted_page_change`、`_add_revision`)。
- **content_hash 派生失效**: `source_content_hash` 覆盖 title/page_type/free_text/sections/linked_asset_refs/template/version; 页面内容变更即触发派生(投影/简介)失效标记(来源: `world_bible_lifecycle_service.py` 1148–1177、§22.2「content_hash 进 frontmatter」)。
- **发布影响只读重验**: publish-impact 是只读确定性引用影响预演; 发布时可选 `expected_impact_scope_hash` 重验, 引用变化 → 拒绝发布(来源: `world_bible_lifecycle_service.py` 628–634、§19 publish-impact)。
- **页面提案只能走 lifecycle**: 生成中心产出的页面提案(world_bible_page_draft 建议)只能作为工作稿, 经 lifecycle 发布为 canonical, 不直接写已采用页(来源: `suggestion_queue_service.py` 422–426、`world_bible_lifecycle_service.py` publish_draft)。

---

## 融合建议 fusion-suggestions(M4 落点: 去重 L0–L4 主战场; 底座 = `merge_entities / split_merge / attach_alias` 原语)

### 语义

世界对象「是否应合并/设为别名」的 LLM 提案(去重雷达核心)。§6.1: 哲学「合并可逆、去重越激进越好」; L0 确定性规则 → L1/L2 判同一 → L3 merge_candidates(CAS) → L4 自然语言修复。§22.6 保留 `merge_entities/split_merge/attach_alias` 原语。

### frontmatter 字段(一条融合建议)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| action | enum | 是 | merge / alias_only / keep_separate / needs_review |
| source_entity_id / source_entity_name / source_status | string / string / enum | 是 | 源对象 |
| target_entity_id / target_entity_name / target_status | string / string / enum | 是 | 目标对象 |
| recommended_primary_entity_id | string | 否 | 推荐的保留主侧 |
| similarity_score | float | 否 | 相似度(>=0.84 才进入候选对) |
| match_method | string | 否 | normalized_exact_name / summary_overlap 等 |
| confidence | float | 否 | 置信度 0~1 |
| reason | string | 否 | 判同一理由 |
| alias | string | 否 | 建议别名(alias_only 时) |
| evidence_anchors | list\<ref\> | 否 | 证据锚点(manuscript/entity_summary) |
| source/target semantic_fingerprint / execution_fingerprint | string | 是 | CAS 指纹 |
| requires_canonical_confirmation | bool | 否 | 双方皆 canonical 时需二次确认 |

### 状态机

建议 = 提案态(候选), 应用需 `confirmed=true`; merge/alias_only 涉及已采用(canonical)对象需 `allow_canonical_merge / allow_canonical_alias` 二次确认; 应用后 source → merged(可逆, L4 split)。

### 旧表映射

无独立持久表; 建议是任务产物, 基于 `core_entities` + `entity_relations` + `entity_revisions`, 应用落到 `MergeResult` 统计(aliases_inherited/relations_migrated/relations_deduplicated/self_loops_cleaned)。旧 API 底座 = `/api/world/entities/fusion-suggestions`(已在插件白名单)(来源: `entity_fusion.py`、§6.1)。

### 完整性规则(必须在 store 保留的确定性规则)

- **合并可逆**: 候选态合并免费可逆; 已采用合并新增 `merge_records`(source_ids→target_id、provenance、workflow、可回滚标记); merge 不删 source(历史状态优先)(来源: §6.1「可逆合并语义」)。
- **已采用对象合并/设别名需二次确认**: source 为 canonical 且未 `allow_canonical_merge/alias` → `confirmation_required` / 跳过(来源: `entity_fusion.py` 743–755、1086–1094)。
- **同类型才可融合 + 跨书禁止**: 融合组必须单一 entity_type; 跨 novel 拒绝(来源: `entity_fusion.py` 729–730、`dedup_service.py` 453–457)。
- **确定性规则先行(L0)** : 归一化名完全相同且同型 → 直接合并; `_deterministic_decision` 置信 >=0.98 直接 merge、keep_separate 直接保留, 不走 LLM(来源: `entity_fusion.py` `_candidate_pairs` exact_groups、`_decide` 1310–1314)。
- **执行时 CAS 重验**: 应用建议前校验 source/target execution_fingerprint 与 semantic_fingerprint, 不符 → stale_suggestion(来源: `entity_fusion.py` 733–739、`_revalidate_task_batch`)。
- **同组原子应用**: group apply 任一项失败整体 raise(由调用方 savepoint 回滚)(来源: `entity_fusion.py` `apply_group` 679–680)。

---

## 知识标签 KnowledgeTag(M4 落点: 【待定】§22.2 未显式列出; 建议落在对象 frontmatter 派生字段或 `.assistant/` 索引)

### 语义

「知识域标签」体系: 给人物/资产打「种族/地点/势力/职业」等知识标签, 用于控制「谁(角色)知道什么」。分 手动标签、派生标签(由确定性规则从对象属性/关系派生)、排除(exclusion)、作者锁(author_locked)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| slug | string | 是 | 唯一标签键(novel_id+slug 唯一, 如 `species:<id>`/`location:<id>`/`faction:<id>`/`profession:<slug>`) |
| name | string | 是 | 展示名(如「种族：精灵」) |
| source | enum | 否 | manual / derived_species / derived_location / derived_faction / system_profession / confirmed_suggestion |
| description | string | 否 | 说明 |
| status | enum | 否 | 软删归档态 |
| (授权) grant_source | enum | 否 | 授权来源 manual / derived |
| (授权) source_ref_type / source_ref_id / source_scene_id / source_chapter_index / source_memory_id | 混合 | 否 | 授权溯源 |
| (授权) author_locked | bool | 否 | 作者锁, 阻止自动删除 |
| (排除) reason | string | 否 | 排除理由 |

### 状态机

派生标签由确定性规则在来源对象变更时同步(sync_derived_tags): 来源为 canonical 时派生; 排除(exclusion)阻止派生; author_locked 阻止自动删除; 手动授权与排除并存时排除优先。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| slug / name / source / description | knowledge_tags.slug / name / source / description | — |
| (人物授权) | character_knowledge_tags.* | character_id/tag_id/grant_source/author_locked + 溯源列 |
| (资产授权) | asset_knowledge_tags.* | target JSON + target_hash + tag_id |
| (排除) | knowledge_tag_exclusions.* | character_id/tag_id/reason/source |

### 完整性规则(必须在 store 保留的确定性规则)

- **派生标签确定性**: 种族(character.meta.worldbuilding.species_entity_id)、地点(location_entity_id)、职业(profession_label → 系统职业标签)、势力(relation_type=member_of 且 canonical) 四路派生; 仅当来源对象 status ∈ {canonical, confirmed} 时生效(来源: `knowledge_tag_service.py` `_desired_derived_tags` 157–230、`shared.py` CONFIRMED_STATUSES)。
- **排除优先于派生, 作者锁优先于自动删除**: `sync_derived_tags` 先剔除 exclusion, 再对 `author_locked` 的授权不删除(来源: `knowledge_tag_service.py` 124–152)。
- **slug 唯一**: (novel_id, slug) 唯一约束(来源: `models/worldbuilding.py` 475)。

### 待定

- 【待定】M4 落点未在 §22.2 明确; 知识标签是否降级为对象/人物 frontmatter 的派生字段 + 索引, 或进入 `.assistant/` 索引目录, 需另行裁定。
- 【待定】`asset_knowledge_tags`(资产级 target JSON + target_hash)在 M4 的等价形态。

---

## 图片字段 image_version(M4 落点: 【待定】D19 决策 v1 砍掉对象图片能力)

### 语义

对象图片版本标识: `image_version`(UUID 版本号)、`image_updated_at`、`has_image`(派生)。旧引擎对世界对象图片有受限例外门禁(owner + novel_id、PNG/JPEG、<6MiB、<=4096×4096、服务端去元数据转 WebP)。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| image_version | core_entities.image_version | UUID |
| image_updated_at | core_entities.image_updated_at | — |
| has_image | core_entities(派生属性) | image_version 非空 |

### 完整性规则

- 图片是受限例外上传(不是通用文件上传), 门禁不扩权(来源: AGENTS.md「世界对象图片是受限例外」)。
- 类型切换涉及图片时需 `require_image_type_change_quota`(来源: `entity_type_transition_service.py` 64–66)。

### 待定

- 【待定】**D19 已确认 v1 砍掉对象图片能力(6MiB/WebP 门禁)**, 未来按需作独立插件; 因此 `image_version` 相关字段与门禁在 M4 初版不落地, 仅作为 Spec 保留。

---

## 世界采纳包 adoption package + 收敛检查点 world_core_checkpoint(M4 落点: `world/pending/*.md`(target_type=world_adoption_package 建议)+ adopt + approval)

### 语义

把一批「来源已授权、作者已确认」的世界资产变更(对象/关系/页面)作为**一个显式、确定性采纳单元**整体采用。`world_core_checkpoint` 是只读收敛检查点(不可采纳), 只做来源与决策记录。

### frontmatter 字段(采纳包)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| schema_version | string | 是 | 固定 `world_adoption_package.v1` |
| source_manifest_hash | string | 是 | 来源清单哈希 |
| checkpoint_suggestion_id / checkpoint_manifest_hash | string / string | 否 | 检查点血缘(成对出现) |
| items | list\<item\> | 是 | 每项 kind(核心对象/关系/世界书页)+ disposition(include/open/rejected)+ authority_kind(author_seed/canonical_baseline/manuscript_observation/generated_bridge)+ source_refs + baseline + typed payload |

每项 payload 的 operation:
- core_entity: `create`(提供 entity)/ `promote`(提供 entity_id + typed baseline)/ `existing_ref`(仅引用)。
- entity_relation: `create`/`promote`/`existing_ref`。
- world_bible_page: `create`/`replace`(replace 需 page_id + expected_page_version)。

### 状态机

```
pending ──preview(preview_hash)──▶ (预览, 不落库)
pending ──apply(preview_hash CAS)──▶ accepted(仅 disposition=include 的项被采纳)
checkpoint: 只读, 永不被采纳
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| 建议头 | creation_suggestion_queue.* | target_type=world_adoption_package, action_schema=world_adoption_package.v1 |
| 检查点头 | creation_suggestion_queue.* | target_type=world_core_checkpoint, action_schema=world_core_checkpoint.v1 |
| items → 对象/关系/页面 | core_entities / entity_relations / world_bible_pages | 采纳时按 operation 写入对应资产 |

### 完整性规则(必须在 store 保留的确定性规则)

- **采纳 = 显式确定性 + approval**: 只 `disposition=include` 的项被采纳; open/rejected 不落资产(来源: `adoption_package_service.py` apply 494、573、664)。
- **preview_hash CAS**: apply 前 `expected_preview_hash` 与重算值不一致 → ConflictError(「preview again」); 已 accepted 包重复 apply 也校验(来源: `adoption_package_service.py` 460–489)。
- **promote 需 typed baseline**: core_entity promote 项要求 `baseline.expected_status ∈ {draft,candidate}` + `expected_fingerprint`(服务端指纹权威)(来源: `schemas.py` `WorldAdoptionBaseline`、`WorldAdoptionPackageItem` 3297–3301)。
- **来源覆盖必须完整**: 来源清单覆盖不完整时拒绝应用(来源: `adoption_package_service.py` 481–482)。
- **页面项只能走 lifecycle**: world_bible_page 项经 `preview_package_page` + `preview_publish_impact` 重验后经 lifecycle 发布, 不直接写 canonical(来源: `adoption_package_service.py` 664–698)。

### 待定

- 【待定】adoption package 在 M4 是否作为「一次 approval 携带采纳清单摘要」的直接对应物(§6.1 风险前移), 还是并入统一收件箱信号卡。

---

## 附: 完整性规则总索引(供 @novelcraft/store 逐条落地)

| # | 规则 | 来源 |
|---|---|---|
| R1 | 别名不建新对象, 一律附着已有对象 | `entity_alias_service.py`、AGENTS.md |
| R2 | 已采用(canonical)对象/关系/页面默认不硬删除, 转历史态(deprecated/archived/merged) | `entity_service.py` delete、`entity_relation_service.py`、`world_bible_lifecycle_service.py` |
| R3 | adopt/promote 仅从 draft/candidate; 已采用再改必须走 promote, 不走普通 update | `entity_service.py` 439–442、677–681 |
| R4 | 待处理建议(含兼容影子)只能经建议队列裁决 | `suggestion_queue_service.py`、`entity_service.py` 571–577 |
| R5 | 关系同向同型去重; review-only 导入不改已采用边(不自动归并) | `entity_relation_service.py` 306–374 |
| R6 | 合并/归并可逆, source 置 merged 不硬删; 已采用对象合并需二次确认 | `dedup_service.py`、`entity_fusion.py` |
| R7 | 世界书发布 CAS(base_version) + content_hash 派生失效 + 发布影响只读重验 | `world_bible_lifecycle_service.py` |
| R8 | 所有复核/采纳用 execution_fingerprint / preview_hash CAS 防 stale | `entity_alias_service.py`、`entity_relation_service.py`、`adoption_package_service.py` |
| R9 | novel_id 隔离(每书一文件夹 + 每书一 session) | 各服务 parse_uuid(novel_id)、§22.2 |
| R10 | 知识标签派生确定性 + 排除优先 + 作者锁优先 | `knowledge_tag_service.py` |
| R11 | 类型切换需硬依赖门禁 + 档案一致性 | `entity_type_transition_service.py` |
| R12 | 检索/别名/关系/覆盖率只是派生索引, 可全量重建; 文件是唯一真相 | §22.2「索引规则」 |

---

## 待定汇总

1. 【待定】`content_json` 自由动态属性在 frontmatter 的落法。
2. 【待定】图片字段 `image_version`(D19 v1 砍掉, 未来独立插件)。
3. 【待定】知识标签体系的 M4 落点(§22.2 未列出)。
4. 【待定】`profile_field` 建议类型与强类型档案(profiles)在 M4 是否保留独立形态。
5. 【待定】`importance/importance_level/reveal_level` 是否继续作为一等 frontmatter 字段。
6. 【待定】`world_core_checkpoint` / `world_adoption_package` 是否继续作为建议子类型。
