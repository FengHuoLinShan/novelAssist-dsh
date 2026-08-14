# R0 资产规格裁定记录(用户已确认)

- 裁定日期: 2026-08-14, 用户对 18 条裁定全部确认
- 效力: 本文件是 specs/assets/*.md 与 specs/prompts/catalog.md 中全部【待定】标注的
  **最终裁定**; 各 spec 文件内的【待定】标记以此为准, 不逐一回改。
- 关联决策: 设计文档决策表 D26

| # | 裁定 | 决定 |
|---|---|---|
| 1 | story-outline 落点 | `structure/outline.md` |
| 2 | reveal plan 落点 | `structure/reveal.md`(与伏笔配对, 不合一) |
| 3 | 候选正文落点 | `chapters/pending/*.md`; adopt = copy-on-adopt 移入 `chapters/{NNN}.md` + git commit |
| 4 | 派生审查/回执类(冲突检查/问题项/语义审查/POV 元数据) | `.assistant/reviews/*.json`, 不进文件夹真相 |
| 5 | merge_records 落点 | `.assistant/merge-log.jsonl` |
| 6 | Scene 历史状态 candidate/proposal | 并入 `draft`, 状态机瘦身为 draft/canonical/deprecated |
| 7 | version_number | 保留为可选 frontmatter(审计/历史列表用); 版本真相由 git commit 承接 |
| 8 | narrative_tag / narrative_function 双轨 | 合并为单一 `narrative_tag` |
| 9 | structure_meta 嵌套 dict | 平铺为 frontmatter 顶层字段(好 diff/手改) |
| 10 | thread_type / current_stage | 开放字符串 + policy.yml 推荐目录(与「复核类型只推荐」一致) |
| 11 | planned_payoff_scene 整数索引 | 改为 slug 引用(统一 id 引用约定) |
| 12 | 健康键命名统一 | 由 specs/rules/store-rules.md 定命名规范 |
| 13 | KnowledgeTag 落点 | 对象 frontmatter 派生字段 `tags: []`, 索引可重建, 不独立成文件 |
| 14 | content_json 动态属性 | 保留为 frontmatter JSON 键; 常用字段可升顶层 |
| 15 | profile_field | 保留在 Character 扩展(1:1 并入对象正文) |
| 16 | importance | 保留为可选字段(剧情雷达排序) |
| 17 | checkpoint/adoption 子类型 | 收敛为 `world/pending/*.md` 的 target_type 枚举, 不单列子类型 |
| 18 | 图片(D19) | Spec 保留 image_version 并标注「v1 不实现」; 未来按需独立插件 |

## 第二批(R0 rules 批次, 2026-08-14 用户确认, D27)

| # | 裁定 | 决定 |
|---|---|---|
| N1 | 健康键命名统一(R62) | 信号词汇表按域前缀 6 键: `scene_unreviewed / scene_unassigned_chapter / scene_missing_setup / scene_needs_organize / structure_needs_review / structure_unassigned` |
| N2 | slug 命名规范(R63) | id = 文件名 slug; 引用写裸 slug(kind 由目录上下文给出); 幂等键(entity_key/provenance_key/content_hash)算法不动 |
| N3 | 4 个缺默认的新键 | `watch.notify_threshold=5`、`repair.max_rounds=3`、`dedup.l2_threshold=0.5`、`alias.attach_confidence=0.8` |
| N4 | CONTEXT_BUDGET 归属 | helper 内置常量, 不进 policy.yml |
| N5 | llm.yml 与 policy.yml 键划分 | provider 级(temperature/top_p/max_tokens/timeout/model)→ llm.yml; workflow 级(并发/预算/阈值/降级/守望)→ policy.yml; prompt 契约固定值 → spec 目录 |
| N6 | 并发口径冲突 | 以 `deep_import_settings` 项目可调值为权威, 模块常量仅代码兜底 |
| N7 | world_ask 超时常量名 | 实现期回源码核对(实现备忘) |
| N8 | policy.yml schema 校验归属 | `@novelcraft/store` 负责(版本号 + JSON Schema) |
| N8 | policy.yml schema 校验归属 | `@novelcraft/store` 负责(版本号 + JSON Schema) |
| N9 | book.yml 字段名(vault 实现期裁定) | **以 specs/assets/small-modules.md 的旧代码映射为权威**: `target_length`(short/medium/novel/epic)+ `current_stage`(world_building/outlining/writing/revising), 不用 `target_scale`/`stage` |
| N10 | slugify 中文标题(vault 实现期裁定) | **保留 CJK 字符**(id 可含中文, 如「诡秘之主」), 仅归一空白、剔除路径非法字符、限长 64; 冲突加短后缀; 纯非法/空抛错 |
| N10 | slugify 中文标题(vault 实现期裁定) | **保留 CJK 字符**(id 可含中文, 如「诡秘之主」), 仅归一空白、剔除路径非法字符、限长 64; 冲突加短后缀; 纯非法/空抛错 |
| N11 | relations 存储形态(store 实现期裁定) | 对象 frontmatter `relations: []` 为源, 有向对由索引派生(不做独立文件) |
| N12 | 结构资产粒度(store 实现期裁定) | **目录化**: `structure/threads/<slug>.md`、`structure/arcs/<slug>.md`、`structure/foreshadowing/<slug>.md`、`structure/reveal/<slug>.md`; 总纲保持 `structure/outline.md` 单文件。每资产一文件 = 细粒度 CAS/手改/git diff |
| N13 | content_hash 格式(store 实现期裁定) | 存储用纯 64 位 hex; 读入时兼容 `sha256:` 前缀 |

## 第三批(关系模型批次, 2026-08-14 用户确认, ADR-0019)

| # | 裁定 | 决定 |
|---|---|---|
| N14 | 结构资产关系表示法 | 结构资产(thread/arc/scene/foreshadowing/reveal)与对象一样以顶层 `relations: []` 有向对为关系写面(对齐 N11); `target` = 裸 slug, 目标 kind 由 type 白名单约束; `status` 默认 `canonical` |
| N15 | relation type 枚举 + 白名单 | 核心 type 进 store 硬校验(确定性); type 表达关系语义、不编码源 kind; 每类资产 schema 声明允许 type 子集 + 目标 kind 约束; 扩展 type 走 policy 白名单。7 个核心 type 见 ADR-0019 附录 A |
| N16 | 身份锚与关系边分层 | 必填单目标身份锚(`reveal.target_type/target_id`、`scene.pov_character_id`)保留顶层字段、不进 relations; 仅可选多目标关联走 `relations` |
| N17 | `related_*_ids` 兼容投影 | 读面把 `related_*_ids` 展开为等价有向边并与 `relations` 并集去重; 写端已自然收敛到 `relations`(M4 无生产工作流写散字段)、读端长期保留(只做加法, 不删字段); `reveal.related_thread_ids` 必填已放宽(「未归类」=「无边」, 2026-08-14 用户裁定) |

## 第四批(M5 体验闭环批次, 2026-08-14 用户确认——M5 计划评审通过)

| # | 裁定 | 决定 |
|---|---|---|
| N18 | imports/*.md 与 chapters/*.md 对应关系(imports.md §129【待定】关闭) | **一导入文件一原文停靠**(imports/<slug>.md, frontmatter 带 import_record_id/file_name/file_type/file_size/total_chapters); **chapters/*.md 是章节正文唯一落点**(importTextChapters 直接落库, 无独立停靠层); import-log.jsonl 承载 ImportRecord(§41) |
| N19 | client RPC 写边界收窄 | 客户端通道(loopback)维持「只读信号 + 记录决定 + 不写资产」; **唯一例外: presets/select 经 selectPresetInLlmYml 只写 .assistant/llm.yml 的 preset 单键**(配置非资产, 不过 approval; 其余键原样保留, 非法预设名拒绝) |
| N20 | 内容手模型预设层归属 | DSH 无模型预设层(agent-presets 不拥有模型路由, 上游勘察结论)→ **插件自建薄层**: ContentPreset 类型在 llm-step, 注册表存 novelcraft domain KV(presets 表 ∪ 种子), llm.yml preset 键引用(每书), 执行链经 withResolvedDefaults/mergeStepOverrides 注入 runStep/deepImport/propose/generate; 重内容流程由编排脑以子代理发起, agentOptions {provider, model} 取当前预设(DSH 原生 seam); 编排脑模型切换 = DSH 原生(/model), 零代码 |

## 第五批(M6 RAG 插件化分层批次, 2026-08-14 用户确认)

| # | 裁定 | 决定 |
|---|---|---|
| N21 | RAG 三层架构裁定 | **L0 = BM25+字 bigram 确定性召回(默认)**, 零 LLM 依赖、恒可复现; **L1 = `llm_step(spec=rag_rerank)` 内容手精排**(默认开, 对召回候选按相关性重排返回 `ranked_ids`); **L2 = 本地 BGE 向量召回**(llm.yml 设 `embedding: bge-local-v1` 启用, 可选包动态加载)。**逐层静默降级**: L1 失败回退 L0、L2 失败回退文本检索, 检索永不阻断写作; 嵌入与精排失败只在结果 `degraded` 字段留痕(`rerank_failed`/`embedding_failed`)。依据: 铁律 5(内容手受控, llm_step 带 output_schema/预算/超时)+ 铁律 2(文件真相、派生可重建); 检索是只读辅助面, 不因模型不可用阻塞写作主链。影响面: `@novelcraft/rag`(L0/L1 实现 + EmbeddingBackend 接口)、`@novelcraft/llm-step`(rag_rerank spec)、`@novelcraft/dsh`(novelcraft_rag_search 工具 + degraded 字段) |
| N22 | 嵌入模型资产与打包裁定 | **模型权重不进 git / npm 主包**: 首次启用懒下载到 `$DSH_HOME/novelcraft/models`(transformers.js 缓存层保证, 幂等可复现); **@novelcraft/rag-bge 为可选包**(dsh `optionalDependencies` + 动态 import, 缺包全链自动降级); **向量 = rag-index.json 派生字段**(可全量重建), **不引入向量数据库/外部进程**。依据: 铁律 2(不另建数据库/队列; 派生索引任何时刻可全量重建); 模型资产不随主包分发, 下载放权给 transformers.js 缓存层。影响面: `@novelcraft/rag-bge`(新增第 16 包)、`@novelcraft/rag`(EmbeddingBackend seam)、`@novelcraft/dsh`(optionalDependencies + novelcraft_rag_embed 工具)、vault gitignore(`.assistant/rag-index.json` 不提交) |
| N25 | rag_rerank 命名与契约口径 | M6 实现 spec 名 rag_rerank（简化契约 ranked_ids，N21 默认开）；catalog §5.1 旧名 rag_reranker 的完整 RerankerOutput（support_status/证据角色/弃权）暂缓；catalog 与 policy-defaults 键名统一为 rag_rerank。依据: M7 review 命名冲突修复 + N21 |
| N24 | rag_rerank 预算修正 | budgetTokens 2048→4096：默认 recall=20 × PREVIEW_CHARS=200 输入估算 ≈2625 token（CJK/1.6 启发式）超原预算，L1 精排恒 budget_exceeded 降级，违反 N21 默认开；4096 覆盖默认召回集且 checkBudget 仅比输入估算，输出上限放宽无害（ranked_ids 实际输出约百 token）。依据: M7 review + N21 + 铁律5 |
| N26 | memory scene_id 锚点与第二幂等键 | MemoryEvent 增补可选 scene_id（Scene slug 弱绑定无 FK，对齐 writing.md:136）；scene_id+scene_sequence 同在时启用 (scene_id, scene_sequence) 唯一性拒绝（small-modules.md:140 第二幂等键）；chapter+sequence 主键与 eventId 不变，旧事件无 scene_id 不破坏。依据: M7 review + small-modules.md:112/140/142 |
