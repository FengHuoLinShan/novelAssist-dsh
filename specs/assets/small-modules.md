# 小模块资产规格(R0 提取)

- 来源 commit: a257df23e
- 提取日期: 2026-08-14
- 提取范围(文件列表):
  - backend/modules/project/{models.py, schemas.py, contracts.py, facade.py, services.py(部分)}
  - backend/modules/memory/{models.py, schemas.py, contracts.py, README.md}
  - backend/modules/rag/{models.py, schemas.py, chunk_annotation.py, metrics.py}
  - backend/modules/context/{models.py, contracts.py, services/compiled_context.py, facade.py(部分)}
  - backend/modules/settings/{models.py, schemas.py}
  - backend/modules/account/{models.py, constants.py}
  - backend/modules/interaction/{models.py}
  - 背景: docs/agent/dsh-rebuild/自主智能式作家助手设计.md §20、§21.1、§22.2

> 提取约定: 只写规格不写代码; 每条结论标注来源文件(行号区间); 不确定处标【待定】;
> 字段表四列 `字段 | 类型 | 必填 | 语义`; 旧表映射列格式 `表名.列名`;
> 覆盖范围 = 创作资产与状态机, 不含 API 请求/响应信封。

---

## 一、project(项目聚合 + 回收站)

### 1.1 Project — 书根聚合(M4 落点: `book.yml`)

#### 语义

一本书的根聚合: 书名、题材、基调、目标规模、创作语言、当前阶段、默认揭示策略。
M4 下是 `~/Novels/<书名>/book.yml`, 每书一个文件夹 + 每书一个 DSH session 即分区
(设计 §22.2)。

#### frontmatter 字段(book.yml)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id / novel_id | string | 是 | 稳定标识; M4 下由文件夹 + git 承载, 不落 raw UUID(见 §22.2) |
| title | string | 是 | 书名; 去首尾空白, 拒绝空字节与纯空白(schemas.py:18-25) |
| genre | string | 否 | 题材(如 玄幻/科幻/悬疑); 开放字符串(models.py:48-52) |
| tone | string | 否 | 风格基调(如 严肃/轻松/黑暗)(models.py:53-57) |
| language | string | 是 | 创作语言, 默认 `zh`(models.py:58-62) |
| target_length | enum | 否 | 目标规模: `short / medium / novel / epic`(models.py:64-68) |
| current_stage | enum | 否 | 当前阶段: `world_building / outlining / writing / revising`(models.py:69-73) |
| default_reveal_policy | enum | 是 | 默认揭示策略, 默认 `author_safe`; 白名单 `author_safe / author_only / reader_known / public`(schemas.py:47-53) |
| project_kind | enum | 是 | `author / interaction`; M4 下 book.yml 只记 author, interaction 是独立 RP 域(models.py:36-42, 设计 §20.11) |
| owner_id | — | 裁 | 单用户裁剪: 删除 owner 双门禁, 不落文件(models.py:28-35, 设计 §21.1) |
| settings | json | 否 | 旧项目级 JSON 配置(含 `llm` 子键与 `temporary_entity_expiry_chapters` 等); M4 拆到 `.assistant/llm.yml` 与 `.assistant/policy.yml`(models.py:80-85, profiles.py:345-360, 设计 §22.2) |
| deleted_at | — | 裁 | 软删除时间; M4 由 git 删除 commit + 墓碑文件表达(设计 §22.2) |

#### 状态机

```
active ──删除──▶ recycled(deleted_at 非空) ──永久删除(confirmed=true)──▶ deleted
   ▲                    │
   └────── restore ─────┘
```

- 软删除 = 移入回收站, 同一事务取消未完成任务(services.py:369-370);
- 永久删除必须 `confirmed=true`, 且只能删已在回收站的项目; 批量永久删除原子、
  任一不在回收站则整批拒绝(services.py:406-480, README.md:182-183)。

#### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| title | projects.title | 直接映射 |
| genre | projects.genre | 开放字符串, 无枚举约束 |
| tone | projects.tone | 开放字符串 |
| language | projects.language | 默认 `zh` |
| target_length | projects.target_length | short/medium/novel/epic |
| current_stage | projects.current_stage | world_building/outlining/writing/revising |
| default_reveal_policy | projects.default_reveal_policy | 白名单校验 |
| (回收站) | projects.deleted_at | NULL=未删除; M4 改 git 语义 |
| (owner) | projects.owner_id | M4 裁剪 |

#### 完整性规则

- 标题非空、去首尾空白、拒绝空字节(来源: project/schemas.py:18-25)。
- `default_reveal_policy` 白名单校验(来源: project/schemas.py:47-53, 73-81)。
- 回收站项目对业务入口统一 404, 不暴露存在性(来源: project/facade.py:69-76)。
- 永久删除是不可恢复的破坏性操作, 必须二次确认(来源: project/services.py:406-480)。

#### 待定

- 【待定】`language / target_length / current_stage / default_reveal_policy` 是否全部进
  book.yml frontmatter, 还是部分下沉到 `.assistant/policy.yml`(策略即数据, 设计 §20.10)。
- 【待定】`settings` 中 `temporary_entity_expiry_chapters` 等创作语义键在 M4 的落点
  (book.yml 还是 policy.yml)——本 commit 未在 project 模块内枚举全部 settings 键。

### 1.2 SmartDedupWorkbenchDecision(非 book 资产说明)

- 语义: 项目级智能去重工作台裁决(每对资产指纹的 `keep_separate` 处置)。
- M4 落点: 属编排层去重(L0–L4)裁决, 非文件夹真相资产; 由 world/outline 去重插件消费,
  不落 book.yml。仅记录「它不进入文件夹真相」这一结论
  (models.py:96-149, 设计 §20.4/§22.2)。

---

## 二、memory(事件溯源)

### 2.1 MemoryEvent — 事件溯源真相源(M4 落点: `memory/events.jsonl`)

#### 语义

世界状态变化事件; 重放可得任意章节的世界全景。M4 下是 `memory/events.jsonl`
逐行追加的事件流, 是唯一真相; 其余 memory 表都是可重建的派生投影(设计 §20.5/§22.2)。

#### 事件行字段(events.jsonl 每行一条)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 事件唯一标识(models.py:52-56) |
| chapter_index | int | 是 | 所属章节(models.py:63-67) |
| scene_id | uuid | 否* | Scene 时间锚点; 新事件必须提供(models.py:68-73) |
| scene_index | int | 否 | Scene 逻辑顺序冗余, 用于确定性重放(models.py:74-79) |
| scene_sequence | int | 否 | Scene 内事件顺序(models.py:80-84) |
| dimension | enum | 否 | `entities / relations / locations / knowledge`(models.py:85-90, contracts.py:13-18) |
| sequence | int | 是 | 章内事件顺序(models.py:91-95) |
| event_type | enum | 是 | `entity_created / entity_updated / entity_removed / entity_moved / relation_established / relation_ended / knowledge_changed / manual_correction`(schemas.py:23-34) |
| entity_id | uuid | 否 | 影响的实体 ID(models.py:102-107) |
| entity_type | string | 否 | 实体类型(models.py:108-112) |
| snapshot_before | json | 否 | 变化前状态(models.py:113-117) |
| snapshot_after | json | 是 | 变化后状态(models.py:118-122) |
| source | enum | 是 | `ai_extraction / manual_edit`, 默认 ai_extraction(models.py:123-128) |
| created_at | datetime | 是 | 写入时间(models.py:129-133) |

\* scene_id 标注「否」仅因旧数据可为 NULL; 新事件语义上必须提供(models.py:72)。

#### 状态机

事件流 append-only, 无状态机; 重建时按幂等键 upsert 并清理事件流之外的尾部事件
(README.md「数据表」段)。

#### 旧表映射

| 事件行字段 | 旧表.列 | 备注 |
|---|---|---|
| (全部) | memory_events.* | 一行事件 → 一行 JSONL |

#### 完整性规则

- 幂等键 `(novel_id, chapter_index, sequence)` 与 `(novel_id, scene_id, scene_sequence)`
  唯一(来源: memory/models.py:37-50)。
- 新事件必须带 scene_id 锚点; 缺锚点旧事件形成分维度 coverage gap, 不回退读当前 World
  (来源: memory/models.py:72, README.md「负责」段)。
- Scene 阶段从 stage0 空状态开始, 只重放该 Scene 及之前的 MemoryEvent
  (来源: README.md「负责」段)。
- 全景重放优先从最近快照 + 后续事件增量应用; 事件列表用
  `(chapter_index, sequence, id)` keyset 分批(来源: README.md「负责」段)。

#### 待定

- 【待定】events.jsonl 每行是否同时写入 `dimension`/`scene_sequence` 还是只写最小事件
  三元组(chapter_index/sequence/snapshot_after), 由 M4 插件按 Spec 定。

### 2.2 MemorySnapshot — 阶段性全景快照(M4 落点: 派生索引, 可重建)

#### 语义

每 10 章物化的世界全景节点, 仅用于查询加速(models.py:142-143)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | — |
| chapter_index | int | 是 | 快照对应章节 |
| status | enum | 是 | `current / stale`(models.py:163-168) |
| full_state | json | 是 | 完整世界状态 |
| events_until | int | 否 | 覆盖到第几个事件序号 |

#### 完整性规则

- 重建时旧 `current` 转 `stale`, 生成新 `current`; 历史 stale 保留不硬删
  (来源: README.md「负责」段)。
- `has_stale` 只表示「有章缺 current 替代」, 历史 stale 不误报待重建
  (来源: README.md「负责」段)。

### 2.3 DeltaLog — 实体变更差分日志(M4 落点: 派生索引, 可重建)

#### 语义

结构化字段 before/after 变更日志(models.py:189-191)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| entity_id | uuid | 否 | 关联实体 ID |
| character_id | uuid | 否 | 关联网格人物 ID |
| scene_index | int | 否 | 变更发生的 Scene |
| category | string | 是 | 变更类别 |
| field_path | string | 否 | 变更字段路径 |
| old_value | string | 否 | 变更前值(JSON 编码) |
| new_value | string | 否 | 变更后值 |
| source | enum | 是 | `ai_extraction / manual_edit / manual_rollback`(models.py:231-236) |
| meta | json | 否 | provenance/workflow 元数据 |

#### 完整性规则

- deep-import 回滚按 `novel_id + source + workflow_id + auto_ingested + rolled_back`
  过滤, 再按 ID keyset 分批加锁更新, 不扫描其他 workflow/项目(来源: README.md「负责」段)。

### 2.4 MemorySceneCheckpoint — Scene 分维度轻量状态(M4 落点: 派生投影)

#### 语义

Scene 结束后的单维度轻量状态 + 覆盖缺口; 历史版本只软 supersede, 不硬删
(models.py:254-255)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| scene_id | uuid | 是 | Scene 锚点 |
| scene_index | int | 是 | Scene 顺序 |
| stage_index | int | 是 | 阶段索引 |
| dimension | string | 是 | 维度(entities/relations/locations/knowledge) |
| status | enum | 是 | 默认 `ready`; 被 supersede 后 `superseded`(models.py:289, repositories.py:890) |
| source | string | 是 | 默认 `system_generated` |
| confirmed | bool | 是 | 是否人工确认 |
| is_current | bool | 是 | 每 (novel, scene, dimension) 唯一 current(models.py:260-267) |
| state_json | json | 是 | 状态体 |
| evidence_refs | list | 是 | 证据引用 |
| display_summary | string | 是 | 展示摘要 |
| source_hash | string | 是 | 来源 hash |
| gap_reason | string | 否 | 覆盖缺口原因 |
| retry_count | int | 是 | 定向重试次数 |
| decision_summary | string | 否 | 人工修复决定摘要 |
| supersedes_id | uuid | 否 | 被取代的旧版本 ID |

#### 完整性规则

- 只 supersede 同 Scene、同维度、`system_generated` 的 current 版本; `manual / confirmed`
  版本始终保留(来源: repositories.py:971-973, README.md「负责」段)。
- 人工修复必须带 `expected_checkpoint_id` + `confirmed=true`; 并发已更换时 409
  (来源: schemas.py:261-304, README.md「负责」段)。
- 任何 Scene 事件流变更先使该点及后续系统 checkpoint/稀疏快照失效(来源: README.md「负责」段)。

### 2.5 MemorySceneSnapshot — Scene 稀疏全量快照(M4 落点: 派生投影)

#### 语义

stage0、周期、章末、latest 的稀疏全量 Scene 快照(models.py:312-313)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| scene_id / scene_index | uuid/int | 否 | Scene 锚点 |
| stage_index | int | 是 | 阶段索引; 每 (novel, stage_index) 唯一 current(models.py:317-324) |
| snapshot_reasons | list | 是 | 触发原因 |
| full_state | json | 是 | 全量状态 |
| source_hash | string | 是 | — |
| is_current | bool | 是 | current 标记 |
| is_latest | bool | 是 | latest 标记 |

---

## 三、rag(检索 chunk / annotation / 指标)

> M4 落点: 嵌入后端可插拔(provider API / 本地模型)+ 索引可重建(设计 §20.7/§22.3)。
> chunk / annotation / 指标均属派生形态, 可从 chapters/scenes/world 原文全量重建
> (`store rebuild-index`, 设计 §22.2); 只记资产形态, 不记算法细节。

### 3.1 RagChunk — 检索 chunk(M4 落点: 派生索引, 可重建)

#### 语义

语义检索基本单元: 从正文/世界对象/大纲等原文切片 + 向量 + 关联元数据(models.py:44-45)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| source_type | enum | 是 | `chapter_text / world_entity / character / memory / outline`(models.py:66-72) |
| source_id | uuid | 否 | 来源对象 ID(批量导入可为空) |
| content_mode | enum | 是 | `canonical / working`(models.py:79-85) |
| source_content_hash | string | 否 | 建立时的正文版本 hash(64 hex) |
| chapter_index | int | 否 | 关联章节(从 1 起) |
| chunk_index | int | 否 | 章内序号(从 0 起) |
| start_offset / end_offset | int | 否 | 原文起止字符位 |
| char_count | int | 否 | 正文字符数 |
| text | string | 是 | 片段文本 |
| summary | string | 否 | 检索预览摘要 |
| entity_ids / character_ids / thread_ids | list | 是 | 关联 ID 列表(JSON) |
| scene_id / scene_span_id | uuid | 否 | 关联 Scene/SceneSpan(区间近似匹配) |
| visibility | enum | 是 | `author_only / author_safe / reader_known / public`, 默认 author_only(models.py:158-163) |
| importance | float | 是 | 0.0–1.0, 默认 0.5(models.py:164-169) |
| index_version | string | 是 | 索引版本, 默认 legacy; chapter_text 标注用 `cn-novel-v1`(chunk_annotation.py:11) |
| embedding_status | enum | 是 | `pending / pending_vectorization / succeeded / failed / skipped`(models.py:176-181) |
| embedding_error | string | 否 | embedding 失败原因 |
| index_warnings | list | 是 | 索引告警 |
| embedding | vector | 否 | pgvector(768 维)或二进制回退(models.py:37-41) |
| meta | json | 是 | 扩展元数据 |

#### 完整性规则

- `(novel_id, source_type, chapter_index, chunk_index)` 建立稳定检索顺序索引
  (来源: rag/models.py:48-57)。
- chapter_text chunk 的 annotation 固定 `visibility=reader_known`(chunk_annotation.py:142)。

### 3.2 annotation(chunk 标注形态)

#### 语义

正文切片 → RagChunk 的标注结果(不写算法): 通过项目词表匹配
`character_ids / entity_ids / thread_ids`, 按实体重要度计算 `importance`,
按 Scene/SceneSpan 区间解析 `scene_id / scene_span_id`, 写 `meta.{chapter_index, chunk_index}`
(chunk_annotation.py:98-150)。

#### 关键形态字段(固定值)

| 字段 | 固定/规则 | 来源 |
|---|---|---|
| source_type | `chapter_text` | chunk_annotation.py:126 |
| index_version | `cn-novel-v1` | chunk_annotation.py:11,144 |
| visibility | `reader_known` | chunk_annotation.py:142 |
| importance | 0.5 起点 + 实体重要度加成, 上限 1.0 | chunk_annotation.py:78-95 |

### 3.3 RagEntityAppearance — 实体出场派生索引

#### 语义

正文 chunk 派生的实体出场(可重建)(models.py:208-210)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| entity_id | uuid | 是 | CoreEntity ID(不建跨模块外键) |
| content_mode | enum | 是 | canonical / working |
| chapter_index | int | 是 | 出场章节 |
| scene_id | uuid | 否 | 精确 Scene; 无法定位按章节降级 |
| occurrence_key | string | 是 | `scene:<uuid>` 或 `chapter:<index>` |
| source_content_hash | string | 是 | 正文版本 hash |
| chunk_count | int | 是 | 同出场单元命中 chunk 数 |

### 3.4 RagIndexState — 章节索引新鲜度

#### 语义

每章每 content_mode 一条的索引请求与新鲜度状态(可重建)(models.py:275-277)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| chapter_index / content_mode | — | 是 | 联合唯一键 |
| requested_hash / indexed_hash | string | 否 | 请求/已索引正文 hash |
| status | string | 是 | 默认 pending |
| active_task_id | uuid | 否 | 当前有权提交结果的异步任务 |
| generation | int | 是 | 索引 owner 代次, owner 变化递增 |

### 3.5 RagMetrics — 检索质量指标(M4 落点: session log / KV 索引, 非文件夹资产)

#### 语义

运行时检索质量指标(查询数、降级率、空结果率、延迟、缓存命中、embedding 重试)
(metrics.py:19-39)。不落文件夹真相; M4 下进 session log 或派生 KV, 供风险雷达
(检索质量缺口)消费(设计 §20.7)。

#### 形态(快照字段, metrics.py:111-142)

query_count / degraded_rate / empty_rate / avg_latency_ms / embedding_avg_ms /
search_avg_ms / rerank_avg_ms / indexed_chunks_count / embedding_retry_failed_rate。

---

## 四、context(确定性上下文编译 helper 的输入输出契约)

> M4 落点: `compile_context` 升为编排脑调 llm_step 前的**确定性 helper**; 编译摘要供作者
> 确认(设计 §20.8)。资产形态 = 确定性编译 IR(输入 CompileOptions → 输出
> StructureContextBundle / CompiledContext)+ 编译快照/确认审计记录。

### 4.1 CompileOptions — 确定性 helper 输入契约

#### 语义

facade 与 compiler 之间的编译选项契约(contracts.py:17-93)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| novel_id | string | 是 | 项目 ID |
| task | string | 是 | 本次上下文编译任务描述 |
| scope | string | 是 | 编译范围(project/world/world_character/arc/chapter/full) |
| consumer_action | string | 否 | 后端确定的消费动作(如 writing.generate), 不接受前端伪造 |
| retrieval_purpose | string | 否 | 检索用途, 默认 generic_context |
| chapter_index / requested_chapter_index | int | 否 | 检索锚点 / 调用方确认目标章 |
| visible_until_chapter / visible_until_scene_id / visible_until_offset | — | 否 | 读者进度可见上界(未来章节硬过滤) |
| scene_id / arc_id / map_id / focus_entity_id | string | 否 | Scene/篇章/地图/对象焦点 |
| prior_neighbor_limit | int | 否 | Scene 前序邻居数, 默认 2, 最大 4 |
| entity_ids / character_ids / thread_ids / location_ids | list | 否 | 显式限定 ID 列表 |
| reveal_mode | enum | 否 | `author_safe / author_full / reader / character`, 默认 author_safe |
| viewpoint_character_id | string | 否 | character 视角必填 |
| enable_geo_filter | bool | 否 | 地缘可达性过滤 |
| mode | enum | 否 | `writing / debug` |
| budget_tokens | int | 否 | 总 token 预算, 默认 4000 |
| top_k | int | 否 | RAG 检索上限, 默认 8 |
| context_mode / content_mode | enum | 否 | canonical / working |
| include_pending_objects | bool | 否 | 是否含待确认对象 |
| excluded_asset_ids | dict[str,list] | 否 | 本次显式排除的资产 ID(排除语义) |
| user_note | string | 否 | 用户额外注意事项 |
| include_world_synopsis | bool | 否 | 作者模式加世界观简介 |
| selected_world_bible_draft_ids | list | 否 | 作者选择的 World Bible 工作稿 |
| activation_profile_id / version / rule_hash 等 | — | 否 | 激活规则版本固定(确定性回放) |
| outline_analysis_fingerprint / scene_state_fingerprint | string | 否 | 已确认编译指纹固定 |

### 4.2 StructureContextBundle — 结构化编译输出

#### 语义

Context Compiler 核心产出; 聚合各模块数据供 LLM prompt 使用(contracts.py:347-414)。

#### 形态字段(contracts.py:356-414)

| 字段 | 类型 | 语义 |
|---|---|---|
| novel_id / task / scope | — | 回显 |
| project / world_entities / characters / geo_locations / memory_records / timeline_events / plot_threads / rag_chunks / ... | 按 scope 加载 | 各模块数据(reader/character 视角不填 world_bible_synopsis) |
| reveal_mode / viewpoint_character_id | — | 揭示模式与视角 |
| budget_used | dict | 各分类已用预算 |
| warnings | list | 编译告警 |

### 4.3 CompiledContext + ContextSection — 预算分级 IR

#### 语义

按优先级 tier 组织 section 并执行分阶段预算淘汰的中间表示(compiled_context.py:31-92)。

#### ContextSection 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| key | string | 是 | section 标识 |
| tier | enum | 是 | P0/P1/P2/P3/P4(见下) |
| content | string | 是 | section 内容 |
| token_count | int | 是 | token 数 |
| truncatable_per_item | bool | 否 | 是否可逐条裁剪 |
| max_items | int | 否 | 条目上限 |
| title / preview / status / activation_reason | string | — | 展示与激活原因 |
| sources | list | — | 条目 provenance |
| can_exclude / excluded | bool | — | 排除语义标记 |
| truncated_reason | string | 否 | 裁剪原因 |

#### Tier 优先级(compiled_context.py:31-45)

| tier | 语义 |
|---|---|
| P0 | 强制, 永不淘汰(项目核心/作者备注) |
| P1 | 高优先级, 超预算 delta 压缩(保留前段摘要) |
| P2 | 中优先级, 超预算逐条裁剪 |
| P3 | 低优先级, 整段淘汰 |
| P4 | filler, 最先淘汰 |

#### 完整性规则(确定性预算淘汰, compiled_context.py:103-288)

- P0 永不淘汰; 超预算时按 P4→P3 整段移除 → P2 逐条裁剪 → P1 前段摘要压缩。
- 每次淘汰/裁剪写 `ContextBudgetEvent(section_key, event_type, reason, before/after_tokens, tier)`
  供作者确认(UI 编译摘要卡)。
- 淘汰/裁剪后同步裁剪 `sources`(保持条目 provenance 对齐, compiled_context.py:93-101)。

### 4.4 ContextConfirmation / ContextSnapshot — 编译快照与确认记录

#### 语义

- ContextConfirmation: 用户确认的 AI 参考资料编译摘要(models.py:57-59, contracts.py:96-118)。
- ContextSnapshot: 自动 AI 调用上下文审计快照(models.py:199-200, contracts.py:132-164)。

#### M4 落点

- 确认/快照是**审计记录**, 非文件夹真相; 落 `.assistant/checkpoint.json` 或 session log
  (设计 §22.2 的 `async_tasks/进度 → session log + checkpoint.json` 映射)。
- 排除语义字段 `excluded_asset_ids` / `include_pending_objects` 保留为确定性编译输入,
  不因审计迁移改变(models.py:104-121, 242-247)。

#### 完整性规则

- 确认记录含可重建编译的 `compile_options` 快照(contracts.py:110), 支持回放固定指纹
  (outline_analysis_fingerprint / scene_state_fingerprint)。

#### 待定

- 【待定】`ContextConfirmationAssetRef / EvidenceLink / ContextRetrievalTrace /
  ContextActivationProfile(Revision)` 是否在 M4 全部保留为文件夹真相, 还是全部下沉为
  可重建索引/审计——本提取只确认它们是确定性编译的旁路资产, 非正史事实。
- 【待定】`CONTEXT_BUDGET` 分类默认(contracts.py:418-429: core_entities=8、
  normal_entities=8、characters=6、memory=10、foreshadowing=5、timeline=8、
  geo_relations=10、relationship_edges=12、plot_threads=8、rag_chunks=8)在 M4 是进
  policy.yml(策略即数据)还是作为 helper 内置常量。

---

## 五、settings(项目 LLM 设置 + 作者偏好)

> M4 落点: `.assistant/llm.yml`(内容手 provider/model/参数, **Key 不进文件**)+
> `.assistant/policy.yml`(策略即数据)(设计 §20.10/§22.2)。

### 5.1 项目 LLM 设置(M4 落点: `.assistant/llm.yml`)

#### 语义

内容手 provider/model/参数; 非 secret 工作流设置(models.py:23-50, schemas.py:19-36)。

#### 字段(非 secret)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| provider_id | string | 否 | provider 标识(如 deepseek) |
| label | string | 否 | 展示名 |
| base_url | string | 否 | provider base URL |
| model | string | 否 | 模型名 |
| timeout | int | 否 | 超时(1–3600s) |
| max_tokens | int | 否 | 1–200000 |
| temperature | float | 否 | 0–2 |
| top_p | float | 否 | 0–1 |
| extra | json | 否 | 扩展参数 |
| creative_mode | string | 否 | 创作模式 |
| deep_import | json | 否 | 深度导入设置(D9 本期不写) |

#### 完整性规则

- **Key 不进文件**: api_key / api_keys_by_provider 是 secret, 由 `sanitize_project_settings`
  剔除并仅暴露 `api_key_configured`(profiles.py:345-360, 设计 §22.2)。
- effective 继承链: 每字段 `{value, source}`, source ∈ `project / global / system / unset`
  (schemas.py:11-16, 设计 D2)。

#### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| (非 secret 字段) | global_llm_defaults.* | owner 隔离; M4 owner 裁剪 |
| (非 secret 字段) | projects.settings.llm.* | 旧项目级 JSON → llm.yml |
| api_key | account_llm_credentials.encrypted_api_key | M4 走 DSH credentials/secret_store, 不落文件 |

### 5.2 AccountLLMCredential(账户级凭据, M4 走 DSH credentials)

- 语义: 账户级已验证加密 provider 凭据(models.py:53-77)。
- M4 落点: 由 DSH 原生多 provider/多模型凭据接管(设计 §20.1/§22.5), **不落文件夹**。
- 字段(供裁剪对照): owner_id, provider_id, encrypted_api_key(json), key_fingerprint,
  verified_at。

### 5.3 作者偏好(M4 落点: book.yml 或 `.assistant/`)

#### 语义

全局 + 项目级作者偏好(models.py:80-119)。

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| daily_goal | int | 否 | 每日字数目标(0–100000) |
| editor_font | string | 否 | 编辑器字体 |
| default_focus_mode | bool | 否 | 默认专注模式 |

#### 完整性规则

- 项目级 NULL = 继承全局(GlobalAuthorPreferences)(models.py:100-105, schemas.py:97-103)。
- 项目覆盖 PUT 全量替换, 缺失字段置 NULL = 恢复继承(schemas.py:97-103)。

#### 待定

- 【待定】作者偏好(daily_goal/editor_font/default_focus_mode)M4 落 book.yml 还是
  `.assistant/` 下独立偏好文件——设计 §22.2 未显式列出。

---

## 六、account(M4 裁剪为可选 token)

> M4 落点: 单用户裁剪——account 退化为「本机 + 可选 token」; owner 双门禁删除;
> novel_id 过滤保留(设计 §21.1)。本节只记「M4 不再需要什么、保留什么」, 不列字段表。

### 6.1 M4 不再需要(裁剪)

- **Account 生命周期状态机**(models.py:23-49): `status(active/pending_deletion/banned)`、
  `support_code`、`deletion_requested_at`、`purge_after`、`banned_at`、`legacy_claimed_at`
  ——全部删除; 单用户本机无账号生命周期。
- **AccountIdentity**(OIDC, models.py:52-69): provider/issuer/subject 身份联合——删除。
- **WebSession**(models.py:72-103): token_digest/csrf_digest/identity_type/超时/撤销——
  浏览器会话体系删除, 由 DSH 会话接管。
- **EmailLoginChallenge**(models.py:106-139): 邮件登录挑战——删除。
- **AccountSecurityEvent**(models.py:142-156): 安全事件审计——删除(单用户本机)。
- **AccountConsent**(models.py:159-175): 同意记录——删除。
- **owner_id 双门禁**: 所有模块 owner_id 外键 + account principal 门禁删除;
  每书一个文件夹 + 每书一个 DSH session 即数据分区(设计 §21.1/§22.2)。

### 6.2 M4 保留(可选 token)

- **可选 token**: 插件访问引擎/工作区的服务令牌, `authMode=none/bearer` 三模式现成
  (设计 §21.1); 编排脑与内容手凭据走 DSH 原生 credentials, 不落文件夹(设计 §22.5)。
- **novel_id 隔离**: 保留(多本书是数据分区, 非多租户)(设计 §21.1)。

#### 待定

- 【待定】设计 §2(事实基线)/§20.1 提到「agent tokens(ADR-0014 修订三已实现
  account_agent_tokens)」, 但本 commit(a257df23e)在 `backend/` 未找到
  `account_agent_tokens` 表或代码——M4 的 token 形态以设计为准还是以本 commit 代码为准
  需 triage。

---

## 七、interaction(仅记资产/数据结构, M4 延后至 R6 后)

> M4 落点: 独立 RP 私人故事领域, 与作者资产雷达互不混用; 数据结构语义保留, 流程延后至
> R6 后(设计 §20.11)。本节只记资产形态, 不深入流程。

### 7.1 InteractionJourney — RP 旅程(隐藏项目)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| novel_id | uuid | 是 | 隐藏 project(unique, 每旅程一个) |
| owner_id | uuid | 是 | M4 单用户裁剪 |
| title / title_source | string/enum | 是 | 标题与来源 `fallback/model/manual` |
| opening_text | string | 是 | 开场文本 |
| status | enum | 是 | `active / archived` |
| see_sea_enabled / action_options_enabled / setup_clarification_used | bool | 是 | 模式开关 |
| selected_leaf_node_id / selection_epoch | uuid/int | 是 | 当前选中叶节点与选中代次 |
| overview_head_revision_id / overview_epoch / overview_failure | — | 是 | 回顾头与失败态 |
| latest_activity_at | datetime | 是 | 最近活动 |

### 7.2 InteractionMessageNode — 消息树节点

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| journey_id / parent_node_id | uuid | 是/否 | 树父子; parent 可为空(根) |
| role | enum | 是 | `user / assistant` |
| message_kind | enum | 是 | `setup / story` |
| content | string | 是 | 消息内容 |
| completion_state | enum | 是 | `complete / partial` |
| end_reason / branch_hint | string | 否 | 结束原因/分支提示 |
| story_ended | bool | 是 | 是否结局 |
| action_suggestions | list | 是 | 动作建议 |
| token_estimate | int | 是 | token 估算 |
| origin_attempt_id | uuid | 否 | 产生本次消息的 attempt(unique) |

### 7.3 InteractionBranchSelection — 不可变选中历史

- 字段: journey_id、parent_key(36)、selected_child_node_id; `(journey_id, parent_key)`
  唯一(models.py:200-232)。
- 语义: 每个分支点唯一一次选中记录(不可变历史)。

### 7.4 InteractionGenerationAttempt — 生成尝试

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| journey_id / response_to_node_id / result_node_id | uuid | 是/是/否 | 响应锚点与产出节点 |
| idempotency_key | string | 是 | `(owner_id, idempotency_key)` 幂等 |
| request_kind / status | string/enum | 是 | 状态 `pending/preparing_context/running/awaiting_continue/completed/failed/cancelled/stopped` |
| visible_text / visible_offset / metadata_text | — | 是 | 流式可见文本与偏移 |
| finish_reason / error_kind / error_message | string | 否 | 结束/错误 |
| llm_execution_snapshot | json | 是 | 快照(secret-free) |
| context_path_hash / context_node_ids / reference_node_ids | — | 是 | 上下文路径 |
| continuation_count / usage / last_checkpoint_at | — | 是 | 续写计数与用量 |

### 7.5 InteractionSummarySegment — 摘要段

- 字段: start_node_id、end_node_id、path_hash、token_count、content、ordinal、producer、
  based_on_*_revision_id; `(journey_id, path_hash, end_node_id)` 唯一(models.py:341-378)。

### 7.6 InteractionOverviewRevision — 回顾版本

- 字段: anchor_node_id、path_hash、coverage_anchor/path、sections(json)、
  source(`automatic/manual`)、based_on_revision_id、promoted、producer
  (models.py:381-425)。

### 7.7 InteractionAccountPreference — RP 人机偏好

- 字段: owner_id、see_sea_notice_acknowledged(models.py:428-444); M4 单用户裁剪后
  仅保留 `see_sea_notice_acknowledged` 语义。

### M4 落点与完整性规则

- 隐藏项目(project_kind=interaction)在 M4 仍独立于作者资产文件夹, 或单独一个 RP 工作区
  (设计 §20.11)——【待定】是否落在 `~/Novels/` 下还是 DSH profile 侧。
- 不可变选中历史 + 回顾 = append-only/git 语义(设计 §22.2 已采用不硬删除的普遍映射)。
- 本模块「延后至 R6 后」, 故不在此展开状态机细节。

---

## 附: 跨模块通用完整性规则(store 插件必须保留的确定性规则)

- 已采用资产不硬删除; 删除/替换 = 新 commit + 墓碑文件, 历史由 git 保留(设计 §22.2)。
- 已采用资产每次 adopt = 一个 commit; `content_hash` 进 frontmatter; 工作区脏时拒绝 adopt
  (设计 §22.2)。
- 文件是唯一真相; sqlite domain KV(`ctx.storage`)只是派生索引, 可全量重建
  (`store rebuild-index`)(设计 §22.2)。
- provenance frontmatter 存「哪次 workflow / 哪条 session 记录 / 证据引用」, 双向可追溯
  (设计 §22.4)。
