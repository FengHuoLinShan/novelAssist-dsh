# R0 · llm_step Prompt/Spec 目录(catalog)

> 来源 commit: `a257df23e773db6e843f3dda81b855008558e6e7`(origin/main, 分支 `codex/m4-dsh-plugin-rewrite`)
> 提取日期: 2026-08-14
> 提取范围(权威来源优先):
> - `docs/prompts/Prompt体系设计.md`(清单与分工, 简称 **P体系**)
> - `docs/agent/dsh-rebuild/自主智能式作家助手设计.md`(编排脑/内容手分工、llm_step 原语契约、R0 产出定义, 简称 **自主智能式**)
> - `backend/prompts/*.md`(静态 system scaffold, 10 份)
> - `backend/tools/prompt_contracts/contracts/*.json`(21 份开发期漂移契约, 字段级权威)
> - 旧代码调用点: `backend/modules/{imports,outline,writing,world,rag,interaction}/**`、`backend/infrastructure/llm/prompt_loader.py`
>
> 说明: 本项目约定只写规格不写代码; 每条结论标来源; 不确定处标【待定】。字段表与字段级摘要均为
> 规格摘要(非逐字 JSON Schema); 权威字段定义见契约 JSON 与 prompt 文件。用户语言优先, raw ID/JSON
> 只出现在字段表技术列。旧代码常量如无特别说明, 均为「默认值, 可被项目级 deep-import 设置或环境变量覆盖」。

## 通用约定(所有 llm_step 共有)

- **llm_step 原语契约**(自主智能式 §12): `{spec_ref|prompt, input, output_schema, budget, timeout} → {result, journal, usage}`, **必须带 output_schema**。旧实现载体 = `backend/infrastructure/llm/agent_step_harness.py` 的 `run_managed_structured`(managed_llm_step + 内部桥 + 快照)。
- **双模型面**(自主智能式 §4): 编排脑 = deepseek-v4-flash/high effort(观察/计划/验证/复核/分组/对话); 内容手 = 用户自定(切分/语义补全/融合判断/实体别名关系/结构分析)。正文与抽取质量只由内容手决定; 验证者与生成者不同族做交叉检查。
- **注入纪律**(P体系 §1/§6): system scaffold 静态; 正文/作者输入/项目资料作为「fenced 不可信 user/context 数据」注入, 不能覆盖 system 权限; LLM 输出经 Pydantic schema 校验, 不直接写已采用/正史状态; `status/needs_review/数据库ID/持久化动作` 由确定性代码与 materializer 决定。
- **统一输出纪律**(P体系): 结构化 step 从首次请求即携带完整 `OUTPUT_CONTRACT`(exact JSON Schema), 不靠校验失败后的 repair 才告知字段; `repair` 只修 JSON 结构, 不重新判断语义; 语义问题走「有界语义修订」或降级, 不走 JSON 重试。
- **预算/超时口径**: 以下「超时」为单 step 的端到端 wall-clock(含 provider + schema repair), 来源代码常量; 多处写明「候选 + 审计 + 修订共享同一预算」。

---

## 1. 深度导入(imports)内容手步骤

M4 落点: `@novelcraft/imports` 插件(自主智能式 §22.3), 六阶段编排(§6)调用 `@novelcraft/llm-step`。
所有步骤经 `@novelcraft/context` 的 `compile_phase1a_context` 等确定性 helper 供给上下文(§12)。

### 1.1 scene_slicing(Phase 1a 主窗口切分)

- **用途一句话**: 把连续正文切成「可独立规划、修订、续写和检查的因果叙事单元」Scene, 并声明窗口左右延续关系。
- **输入**: 当前窗口冻结章节正文(前一章尾部 ≤2000 字边界 + 当前窗口)、`author_safe` 人物 Top-6 / 非人物世界对象 Top-16、相关 active Scene/篇章纲/剧情线。来源: P体系 §5「Scene 切分与深化」; `modules/imports/phase1a_context.py`(PHASE1A_LEFT_BOUNDARY_CHAR_LIMIT=2000、TOP_K=6/16)。
- **输出 Schema**(契约 `phase1a_scene_slicing.json`, schema_model `SceneSlicingOutput`): `window_edges`(窗口左右延续诊断, 不落库)、`scenes[]`: `title / goal / core_conflict / core_conflict_status / start_chapter / end_chapter / start_anchor / end_anchor / boundary_status / boundary_basis / confidence`。禁 `status`。真实无冲突时 `core_conflict=null + core_conflict_status=not_applicable`。
- **预算/温度/超时/重试**: temp `0.2`、max_tokens `8192`(PHASE1A_SCENE_MAX_TOKENS)、timeout `900s`(PHASE1A_SCENE_SLICING_TIMEOUT_SECONDS)、schema 修复 `1` 次(PHASE1A_STRUCTURED_MAX_FIX_ATTEMPTS)、并发 `50`(PHASE1A_SCENE_SLICING_CONCURRENCY)。来源: `modules/imports/workflow_llm_adapters.py:28-36,535`、`scene_slicing.py:28-29`。
- **降级**: 边界两侧伪造 anchor 不允许; anchor 未定位走 anchor_repair; 覆盖空洞走 gap_recovery; 重叠/空洞由确定性 materializer 统一协调后按整个 gap 原子应用, 失败保留精确整章 fallback、不部分采用(P体系 §5)。
- **调用点**: `modules/imports/workflow_scene_phase.py` → `workflow_llm_adapters.py` step `phase1a_scene_slicing`; 单章重切经微工作流「Scene 重切」(自主智能式 §10)。
- **M4 落点**: `llm_step(spec=scene_slicing)` 由 `@novelcraft/imports` 在 Stage 2「地图」fan-out 的每章子代理内调用(自主智能式 §6), output_schema=SceneCandidates → `stage_candidates(scenes)`。

### 1.2 scene_anchor_repair(Phase 1a anchor 修复)

- **用途一句话**: 对已锁定 Scene 只做「定位」, 在冻结正文中找回唯一起止 anchor, 不重新切分。
- **输入**: 锁定 Scene 卡、起止章节正文、相邻已验证边界。来源: P体系 §5; `workflow_llm_adapters.py:572`。
- **输出 Schema**(契约 `phase1a_scene_anchor_repair.json`, `SceneAnchorRepairOutput`): `status(resolved|partial|unresolved) / start_anchor / end_anchor / reason`。禁 `title/goal/core_conflict/scene_chunks`。
- **预算/温度/超时/重试**: temp `0`、max_tokens `32768`、timeout `900s`(复用 slicing)、修复 `1` 次。来源: `workflow_llm_adapters.py:631,638-643`。
- **降级**: `partial`/`unresolved` 合法; 不得为满足 schema 伪造另一侧 anchor(P体系 §5)。
- **调用点**: `workflow_llm_adapters.py` step `phase1a_scene_anchor_repair`(由 `scene_slicing.py` 对 unresolved Scene 触发)。
- **M4 落点**: `llm_step(spec=scene_anchor_repair)` 由 `@novelcraft/imports` 在 Stage 2 验证/修复环调用。

### 1.3 scene_gap_recovery(Phase 1a 连续缺口恢复)

- **用途一句话**: 一次消费完整连续覆盖缺口, 按正文顺序返回 extend_left / new_scene / extend_right segments。
- **输入**: 完整连续缺口正文、左右 Scene 卡、边界正文、相关结构上下文。
- **输出 Schema**(契约 `phase1a_scene_recovery.json`, `SceneRecoveryOutput`): `status / left_right_relation / segments[] {disposition, title, goal, core_conflict, core_conflict_status, start_chapter, end_chapter, start_anchor, end_anchor, boundary_status, boundary_basis, confidence} / reason`。禁 `scene_chunks`。
- **预算/温度/超时/重试**: temp `0.1`、max_tokens `8192`(PHASE1A_CHAPTER_RECOVERY_MAX_TOKENS)、timeout `900s`、修复 `1` 次。来源: `workflow_llm_adapters.py:37,752,757-759`。
- **降级**: 恢复结果必须通过唯一 anchor/offset/顺序/无重叠/无空洞/source hash/邻居存在性校验, 按整个 gap 原子应用; 失败保留精确整章 fallback(P体系 §5)。
- **调用点**: `workflow_llm_adapters.py` step `phase1a_missing_chapter_recovery`。
- **M4 落点**: `llm_step(spec=scene_gap_recovery)` 由 `@novelcraft/imports` 在窗口协调后按缺口调用。

### 1.4 scene_enrichment(Phase 1b Scene 深化)

- **用途一句话**: 为每个 Scene 卡补全情绪节拍、必发生/必不发生、叙事标签与叙事功能, 不重读整章。
- **输入**: 按 `scene_chunks` 重验物化的完整 Scene 正文(不裁剪)、当前与相邻 Phase 1a Scene 卡、相关 active Scene/篇章/剧情线、人物 Top-6 / 非人物对象 Top-16、context/source fingerprint。来源: P体系 §5; `scene_enrichment.py`。
- **输出 Schema**(契约 `phase1b_scene_enrichment.json`, `SceneEnrichmentOutput`): `emotional_beat / must_happen / must_not_happen / narrative_tag / narrative_function / basis / uncertain_fields / confidence`。禁 `status`。空值且未列入 `uncertain_fields` = 明确不适用; 列入 = 证据不足。
- **预算/温度/超时/重试**: temp `0.2`、max_tokens `32768`(PHASE1B_ENRICH_MAX_TOKENS)、timeout `1200s`(PHASE1B_ENRICH_TIMEOUT_SECONDS)、重试 `1` 次(PHASE1B_ENRICH_MAX_RETRIES)、并发 `200`。来源: `workflow_llm_adapters.py:37-38,1068`、`scene_enrichment.py:19-21`。另内部 compact 决策 reducer: max_tokens `128`、timeout `420s`、temp `0`(`phase1b_fusion` step, `workflow_llm_adapters.py:28-29,938`)。
- **降级**: provider/schema 失败保留空语义 + `narrative_tag=draft` 并进复核; `imported` 历史值提交时归一为 `draft`, 来源由 `source=deep_import` 表达(P体系 §5)。
- **调用点**: `workflow_llm_adapters.py` step `phase1b_enrichment`(由 `scene_enrichment.py`/`workflow_scene_phase.py` 调用)。
- **M4 落点**: `llm_step(spec=scene_enrichment)` 由 `@novelcraft/imports` Stage 2 完成切分后批量调用。

### 1.5 scene_fusion(Phase 1c 边界复核 + 融合)

- **用途一句话**: 先按窗口复核相邻候选边界关系(boundary_review), 再对确属同一 Scene 的连通组综合统一 Scene 卡(synthesis)。
- **输入**: 按窗口成组的完整候选序列与正文、相关长篇结构上下文; 单步最多 20 个 Scene。
- **输出 Schema**(契约 `phase1c_boundary_review.json` `SceneBoundaryReviewOutputContract`): `boundaries[] {left_candidate_id, right_candidate_id, relation(same_scene|duplicate|overlap|separate|uncertain), fusion_intent, basis, uncertainties, confidence} / candidate_concerns[]`。禁 `scene_chunks/chapter_ids/status`。
- **输出 Schema**(契约 `phase1c_scene_synthesis.json` `SceneFusionSynthesisOutputContract`): `title / goal / core_conflict / core_conflict_status / emotional_beat / must_happen / must_not_happen / narrative_tag / narrative_function / basis / uncertain_fields / confidence`。禁 `scene_chunks/chapter_ids/status/source`。
- **预算/温度/超时/重试**: temp `0.1`(两个子步同一函数)、timeout `1200s`(PHASE1C_TIMEOUT_SECONDS)、修复 `1` 次。来源: `workflow_llm_adapters.py:39,1241`。
- **降级**: 只有来源精确、无 concern/uncertainty 且边界高置信的连通组才进 synthesis; 低置信/含 uncertain 结果只形成建议不自动采用; 边界复核不移动边界不改写 Scene 卡(P体系 §5)。
- **调用点**: `workflow_llm_adapters.py` step `phase1c_boundary_review` / `phase1c_scene_synthesis`(由 `scene_fusion_phase1c.py` 调用)。
- **M4 落点**: `llm_step(spec=scene_fusion)` 由 `@novelcraft/imports` Stage 2 收尾调用; Scene 工作台融合复用同一 synthesis contract(见 §2.5)。

### 1.6 entity_extraction(Phase 2a Scene 世界对象抽取)

- **用途一句话**: 从单个锁定 Scene 识别「长期创作资产」(非 NER)——世界对象、持久 Delta 与不确定项。
- **输入**: 一个锁定 Scene 的完整精确正文、锁定 Scene 卡、相关结构、前序证据、`entity-xxx` 既有身份候选。关系/新别名不属于本契约。
- **输出 Schema**(契约 `scene_entity_extraction.json` + prompt `scene_entity_extraction.md`): `entities[] {name, entity_type, summary, public_info, hidden_truth, importance, identity_disposition(new|existing|uncertain), matched_existing_ref, basis, uncertainties[], evidence_quotes[], confidence} / delta_events[] {subject_name, category, field, old, new, description, basis, uncertainties[], evidence_quotes[], confidence} / uncertain_items[] {description, reason, evidence_quotes[]}`。禁 `status/relations/aliases/suggested_action/needs_review`。每个可物化实体至少一条逐字证据。
- **预算/温度/超时/重试**: temp `0.3`、timeout = 项目 LLM timeout + 60s 宽限(PHASE2_SCENE_TIMEOUT_GRACE_SECONDS)、max_tokens `32768`(PHASE2_BULK_MAX_TOKENS / PARALLEL_MAX_TOKENS)、重试上限 `3`(MAX_PHASE2_SCENE_RETRIES)。来源: `entity_extraction/scene_entity_llm_adapters.py:95`、`scene_entity_config.py:20-33`。
- **降级**: 无法可靠判断进 `uncertain_items`; 确定性 materializer 重验项目归属/逐字证据/身份引用, 异常进 `uncertain_items` 或待处理; 仅保存授权快照后允许候选写入, 保留 `auto_ingested`/workflow/证据/回滚元数据(P体系 §5「抽取类」)。
- **调用点**: `entity_extraction/scene_entity_llm_adapters.py` step `imports.scene_entity.extraction.structured`(由 `scene_entity_extraction.py`/`workflow_entity_phase.py` 调用)。
- **M4 落点**: `llm_step(spec=entity_extraction)` 由 `@novelcraft/imports` Stage 3「世界」调用。

### 1.7 alias_relation(Phase 2b 别名 + 关系)

- **用途一句话**: 独占新别名与对象关系判定, 输出当前 Scene 带来的增量(反事实判断), 不建新对象。
- **输入**: 同一份冻结 Scene 完整正文、相关结构、`entity-xxx` 身份候选、`relation-xxx` 既有关系引用; 不接数据库 ID、不裁剪输入。
- **输出 Schema**(契约 `phase2_alias_relation.json` v3 + prompt `alias_relation_extraction.md`): `aliases[] {entity_ref, alias, alias_type(name|title|nickname|alias|translation|abbreviation), identity_scope(durable|context_bound|uncertain), identity_basis, evidence_quotes[], confidence} / relations[] {source_ref, target_ref, relation_type, persistence_scope(enduring|stateful), directionality(directed|symmetric), claim_status(established|reaffirmed|changed|ended), previous_relation_ref, description, strength, basis, evidence_quotes[], confidence} / uncertain_items[] {kind, related_refs[], mention_or_claim, reason, evidence_quotes[]}`。禁 `status/needs_review/suggested_action`。`evidence_quotes` 为必填证据字段。
- **预算/温度/超时/重试**: temp `0.2`、单次 LLM timeout `600s`(PHASE2_ALIAS_RELATION_LLM_TIMEOUT_SECONDS)、整阶段 total timeout `1200s`(PHASE2_ALIAS_RELATION_TOTAL_TIMEOUT_SECONDS)、并发 `4`、Scene 字符上限 `3200`/实体索引 `3600`。来源: `scene_entity_llm_adapters.py:345`、`scene_entity_config.py:35-40`。
- **降级**: 别名不创建重复对象, 作为带 `identity_scope`/依据/快照来源的待复核内联证据写入目标对象; 关系只写待复核候选或补充证据, 不自动覆盖/废弃已采用关系(P体系 §5)。
- **调用点**: `entity_extraction/scene_entity_llm_adapters.py` step `imports.scene_entity.alias_relation.structured`(由 `workflow_entity_phase.py` 调用)。
- **M4 落点**: `llm_step(spec=alias_relation)` 由 `@novelcraft/imports` Stage 3「世界」调用。

### 1.8 structure_analysis(Phase 3 简单结构分析)

- **用途一句话**: 从已确认 Scene 证据归纳剧情线/篇章/伏笔/揭示/转折的「简单结构」提案, 进入 Stage 4 结构。
- **输入**: 确定性上下文编译(原语)结果 + 已确认 Scene 证据。
- **输出 Schema**(契约 `phase3_structure_simple.json`, `SimpleStructureOutput`): `plot_threads[] {title, thread_type, current_stage, confidence, supporting_scene_ids...} / arcs[] {title, summary, confidence...} / foreshadowing[] {title, summary...} / reveals[] {title, summary...} / turning_points[] / uncertain_items[]`。禁 `status`; `supporting_scene_ids` 为必填证据字段; `turning_points/uncertain_items` 仅诊断不落库。
- **预算/温度/超时/重试**: temp `0.2`、max_tokens `32768`、timeout `1200s`(PHASE3_STRUCTURE_TIMEOUT_SECONDS)。来源: `outline/generation/parser.py:317,56`、`workflow_structure_phase.py:21`。step `outline.structure_parser.simple_output.structured`。
- **降级**: 结构分析失败只降级、不进 Stage 5; `turning_points/uncertain_items` 仅诊断。
- **调用点**: `modules/outline/generation/parser.py`(step `outline.structure_parser.simple_output.structured`), 由 `workflow_structure_phase.py` 编排。
- **M4 落点**: `llm_step(spec=structure_analysis)` 由 `@novelcraft/imports` Stage 4「结构」调用(自主智能式 §6: 内容手此时最吃质量), 结果 `stage_candidates(structure)`。

### 1.9 dedup_judge(去重 L1/L2 判定)

- **用途一句话**: 对同名候选组判定「同一/不同」, 带来源 Scene 证据 + 置信度; L1 由编排脑初判、L2 仅低置信组由内容手二判。
- **输入**: 归一化名分组后的候选 + 来源 Scene 证据。
- **输出 Schema**: 同一/不同判定 + 证据 + 置信度。旧代码无独立 prompt 文件/契约 JSON【待定: 需在 R0 规则目录补充去重输出契约】; 现有实体融合判定在 `modules/world/entity_fusion.py`(temp `0.1`), 结构去重判定在 `modules/outline/structure_dedup.py`(temp `0.1`, step `outline.structure_dedup.decision.structured`)。
- **预算/温度/超时/重试**: temp `0.1`(两处)。来源: `entity_fusion.py:1346`、`structure_dedup.py:610`。
- **降级**: 去重可逆(候选态合并免费可逆; 已采用合并新增 `merge_records` 可回滚); 拒绝/失败 fail-closed; 误合走 L4 `split_merge` 微工作流(自主智能式 §6.1)。
- **调用点**: `modules/world/entity_fusion.py`(机制底座 `/api/world/entities/fusion-suggestions`)、`modules/outline/structure_dedup.py`。
- **M4 落点**: `llm_step(spec=dedup_judge)` 由 `@novelcraft/imports` L1/L2 去重管道调用(§6.1), 或 `@novelcraft/assistant` 去重雷达触发; 合并执行走 `@novelcraft/store` 的 `merge_entities/split_merge/attach_alias` 原语。

---

## 2. outline 结构创作

M4 落点: `@novelcraft/outline` 插件(§22.3)。

### 2.1 story_outline_generate(小说总纲 strict preview)

- **用途一句话**: 世界设定之后、正式写作之前创设/修订长篇总纲(上位创作依据)。
- **输入**: 项目概况、作者意图、世界书简介/页面、核心规则、显式选择或自动 Top-K 的人物/对象、可选当前总纲; 不加载章节正文/Scene/RAG/PlotThread/伏笔/揭示。system 只加载 `story_outline.md`。
- **输出 Schema**(契约 `story_outline.json`, `StoryOutlineContent`): `title / creative_core {premise, tone_and_reader_promise, story_engine, ending_direction?} / outline_markdown / major_storylines[] {name, narrative_function, trajectory, intersections, resolution_direction} / macro_movements[] {name, story_state_change, advanced_storylines} / open_decisions[] {question, why_it_matters, options}`。禁 `id/novel_id/status/version_number/chapter_index/chapter_ids/start_chapter/end_chapter`。
- **预算/温度/超时/重试**: temp `0.55`、timeout `1800s`(STORY_OUTLINE_TIMEOUT_SECONDS)、三类审计 temp `0.0`(evidence/external_canon/world_rule)、语义修订最多重生 1 次。来源: `outline/story_outline_generation.py:43,568,732`。step `outline.story_outline.generate.structured`。
- **降级**: 结果只是可编辑 preview, 不写 revision; provider 上下文超限任务失败不静默摘要; 精确章号由本地确定性守卫兜底拒绝; 采用需显式 `apply` + CAS + idempotency key(P体系 §5「小说总纲类」)。
- **调用点**: `outline/story_outline_generation.py`(step `outline.story_outline.generate.structured` + `.evidence_audit/.external_canon_audit/.world_rule_audit` + `.evidence_revision`), 由 `StoryOutlineGenerationService` 编排。
- **M4 落点**: `llm_step(spec=story_outline_generate)` 由 `@novelcraft/outline` 在写作前计划台调用; apply = `adopt` + commit。

### 2.2 outline_generate(P20 三类当前层创作: plot_thread / outline_arc / planned_scene)

- **用途一句话**: 每次只提出当前层可编辑建议(剧情线 / 篇章纲 / Planned Scene), 不一次生成整套大纲, 不进入生成中心。
- **输入**: 总纲(上位依据)+ 作者指令 + 确认上下文 + 已有资产, 全部作为 fenced 不可信 user JSON; 首次请求即在 system 携带完整 JSON Schema。
- **输出 Schema**(契约 `p20_plot_thread.json` / `p20_outline_arc.json` / `p20_planned_scene.json`):
  - plot_thread: `result / reuse_judgments[] {existing_thread_ref, judgment, basis} / threads[] {proposal_ref, target_thread_ref, name, thread_type, summary, visible_goal, hidden_truth, start_chapter, planned_payoff_chapter, current_stage, related_character_refs, related_entity_refs, reader_known_state, author_known_state, information_movements[] {movement_ref, information_subject, surface_understanding, hidden_content, target_ref, nodes[] {kind(seed|reinforce|payoff|partial_reveal|full_reveal), content, chapter_hint, scene_ref, trigger, effect}, basis, uncertain_fields, confidence}, basis, uncertain_fields, confidence} / story_outline_conflict / author_decisions`。
  - outline_arc: `result / arcs[] {proposal_ref, target_arc_ref, title, arc_index, start_chapter, end_chapter, arc_goal, core_conflict, main_opposition, entry_hook, midpoint_turn, climax, result_state, next_hook, related_thread_refs, related_character_refs, related_entity_refs, basis, uncertain_fields, confidence} / story_outline_conflict / author_decisions`。
  - planned_scene: `result / scenes[] {proposal_ref, target_scene_ref, parent_arc_ref, title, planned_start_chapter, planned_end_chapter, goal, core_conflict, core_conflict_status, emotional_beat, must_happen, must_not_happen, narrative_tag, narrative_function, pov_character_ref, related_thread_refs, related_character_refs, related_entity_refs, basis, uncertain_fields, confidence} / story_outline_conflict / author_decisions`。
  - 三者禁 `id/novel_id/status/source/needs_review`; planned_scene 另禁 `scene_chunks/chapter_ids`。均允许 `no_change` 与 `needs_author_decision`。
- **预算/温度/超时/重试**: temp `0.55`、timeout `1800s`(P20_TIMEOUT_SECONDS)、候选 + 三类审计 + 最多两次完整语义修订 + 复审共享同一 30 分钟阶段预算; 确认编译要求 `budget_tokens=0`; 人物最多 6、非人物对象最多 16。来源: `outline/p20_service.py:53,191,407`; P体系 §5「P20 当前层结构创作类」。step `outline.p20.{target}.structured`。
- **降级**: 审计给出字段/短引用修正须逐项执行; 无法可靠修正则清空引用并标记 uncertain; 缺必要线程返回 `needs_author_decision` 不跨层暗建; provider 上下文超限任务失败不静默摘要。
- **调用点**: `outline/p20_service.py`(step `outline.p20.{target}.structured`), 由 `P20GenerationService` 编排。
- **M4 落点**: `llm_step(spec=outline_generate, target=plot_thread|outline_arc|planned_scene)` 由 `@novelcraft/outline` 调用(自主智能式 §20.6: outline_analyze/generate/story_outline → trigger 或 llm_step)。

### 2.3 p20_semantic_audit(三类独立审计: evidence / scope_rule / author_instruction)

- **用途一句话**: 对 P20 候选并行执行项目证据与外部正史污染、层级权限/世界规则、作者指令忠实性三类独立审计。
- **输入**: 候选当前层 preview + `authoritative_project_context` + 作者指令(target/mode/instruction)。
- **输出 Schema**(`P20SemanticAudit`, `outline/p20_schemas.py:54-67`): `verdict(pass|revise) / violations[]`(字符串, 上限 20; pass 时必为空, revise 时非空)。
- **预算/温度/超时/重试**: temp `0.0`、timeout `1800s`、format_repair `1` 次、max_fix_attempts `2`、permission_level=suggest、read_only。来源: `p20_service.py:332-416`。step `outline.p20.{target}.{evidence_canon|scope_rule|author_instruction}_audit.{round}`。
- **降级**: 确定性 violations(引用完整性/信息时序)与三类审计合并去重后上限 20; 有 violation → verdict=revise 进有界语义修订; 不因审计模型创意偏好要求修改(P体系 §5)。
- **调用点**: `outline/p20_service.py` 的 `_run_audit`(三个 prompt 文件 `p20_evidence_audit.md` / `p20_scope_rule_audit.md` / `p20_author_instruction_audit.md`)。
- **M4 落点**: `llm_step(spec=p20_semantic_audit, facet=evidence|scope_rule|author_instruction)` 由 `@novelcraft/outline` 在候选生成后并行 `parallel` 验证(§14 原语映射)。

### 2.4 outline_analyze(手动大纲结构分析)

- **用途一句话**: 作为长篇小说叙事顾问回答作者指定的大纲结构问题(自由中文 Markdown, 只读)。
- **输入**: confirmation 固定的分析范围(`chapter_index..visible_until_chapter`)内 Scene 按叙事顺序 + 重叠篇章/剧情线/伏笔揭示 + 关联人物 Top-6 / 世界对象 Top-16; confirmation 指纹一致才消费。
- **输出**: 自由中文 Markdown, 只读分析, 不提供 apply、不写任何资产(P体系 §5「手动大纲分析类」)。
- **预算/温度/超时/重试**: temp `0.3`、timeout `1800s`(P20_TIMEOUT_SECONDS)。来源: `outline/ai_workflow_service.py:641,253`。step `outline.ai_workflow.analyze.generate`。
- **降级**: 显式范围未加载/指纹不一致 → 确认或回放失败关闭; 结果只读, 无降级写库路径。
- **调用点**: `outline/ai_workflow_service.py`(step `outline.ai_workflow.analyze.generate`)。
- **M4 落点**: `llm_step(spec=outline_analyze)` 由 `@novelcraft/outline` 经剧情雷达/写作台触发。

### 2.5 scene_fusion_draft(Scene 工作台融合 synthesis v2)

- **用途一句话**: 同步只读地把作者选中的多个 Scene 综合成统一语义草稿, 不写任何 Scene。
- **输入**: 选中 Scene 卡(≤20)+ 经 writing range ref 重验的精确 SceneSpan 正文 + 相关 active Scene/篇章/剧情线/伏笔揭示/人物 Top-6/对象 Top-16。
- **输出 Schema**: 复用 `SceneFusionSynthesisOutputContract`(同 §1.5 synthesis): `title/goal/core_conflict/core_conflict_status/emotional_beat/must_happen/must_not_happen/narrative_tag/narrative_function/basis/uncertain_fields/confidence`。章节映射/chunk/POV/状态/provenance 由 outline 确定性逻辑保持。
- **预算/温度/超时/重试**: temp `0.2`、timeout `1800s`(SCENE_FUSION_TIMEOUT_SECONDS)。来源: `outline/scene_fusion_draft.py:37,559`。step `outline.scene_fusion.synthesis.v2`(+`.revision.v2` 有界修订)。
- **降级**: 调用失败只返回带 warning + uncertain 状态的确定性草稿, 不写任何 Scene; 保存仍需用户显式选择; 失效的 must-not 边界由语义审计要求一次有界修订(P体系 §5「Scene 工作台融合类」)。
- **调用点**: `outline/scene_fusion_draft.py`(step `outline.scene_fusion.synthesis.v2`), 由 Scene 工作台调用。
- **M4 落点**: `llm_step(spec=scene_fusion_draft)` 由 `@novelcraft/outline` Scene 工作台调用。

---

## 3. writing 正文

M4 落点: `@novelcraft/writing` 插件(§22.3), 停靠舱 + 修订中心。

### 3.1 writing_generate(正文候选生成)

- **用途一句话**: 作为长篇小说共同创作者, 直接输出可审阅的正文候选(默认整章替换稿 / 续写模式追加)。
- **输入**: 已确认上下文(当前 Scene、当前章活跃剧情线、相关人物/物品, 人物上限 6、对象上限 16), 作为有边界 user/context 数据; 续写模式接收锁定 base draft 完整正文。
- **输出**: 可审阅文本候选(非 JSON、非提纲); 结果只保存为 candidate, 需作者显式采用。
- **预算/温度/超时/重试**: temp `0.7`、timeout `1800s`(WRITING_GENERATION_TIMEOUT_SECONDS)。来源: `writing/services.py:81,1574`。step `writing.generation.candidate.generate`。
- **降级**: 确定性 materializer 拒绝擅增长期规则/承诺/期限/关系变化/重大后果; 失败保留候选不写正史。
- **调用点**: `writing/services.py`(step `writing.generation.candidate.generate`)。
- **M4 落点**: `llm_step(spec=writing_generate)` 由 `@novelcraft/writing` 写作台/续写提案微工作流调用(§20.9: writing_generate → 续写提案微工作流)。

### 3.2 pov_generation(单角色 POV 正文候选)

- **用途一句话**: 同一 LLM step 在确认记录同时指定 Scene + character reveal + POV 人物时切换为单角色有限视角, 输出整章替换候选。
- **输入**: 三类上下文——① POV 档案/经 CharacterKnowledge 过滤的对象/他人可观察信息/当前 Scene 证据(影响角色认知); ② Scene 目标/冲突/must/must_not/剧情线公开进展(仅 `director_only` 叙事指导); ③ compiler warning(资料缺口)。目标章已有正文时作为锁定 JSON 注入。
- **输出 Schema**(prompt 内联 `writing/pov_generation.py`): `pov_state / draft_prose / uncertainties`(仅三顶层字段; `draft_prose` 为主要成果)。
- **预算/温度/超时/重试**: temp `0.7`、timeout `1800s`(与 writing_generate 共用)。来源: `writing/services.py:1574`、`pov_generation.py:16`(POV_PROMPT_NAME=`writing_pov_character`)。step 复用 `writing.generation.candidate.generate`。
- **降级**: hidden guard 的 `passed` 仅表示未发现明显角色知识越权, 不等同整体事实/质量通过; 输出经 parser + hidden guard 确定性检查, 只进待审阅 candidate(P体系 §5「单角色 POV 正文候选」)。
- **调用点**: `writing/services.py`(GenerationProfile.POV_CHARACTER 分支), prompt `writing/pov_generation.py`。
- **M4 落点**: `llm_step(spec=pov_generation)` 由 `@novelcraft/writing` 调用(§20.9: pov_generation → llm_step)。

### 3.3 semantic_review(章完成语义近读)

- **用途一句话**: 对冻结正文/合同做分块独立近读, 产出 finding-bound 审查结果(修订中心一等公民)。
- **输入**: 冻结正文 + 合同, 分 chunk 处理(`writing.semantic_review.chunk_N`)。
- **输出 Schema**: 分块 findings(字段级见 `writing/semantic_review.py` 内联 contract)【待定: 无契约 JSON, 字段以代码 `semantic_review.py` 为准】。
- **预算/温度/超时/重试**: temp `0.1`、timeout `1800s`(SEMANTIC_REVIEW_TIMEOUT_SECONDS)。来源: `writing/semantic_review.py:35,286`。step `writing.semantic_review.chunk_N`。
- **降级**: findings 只进收件箱/修订中心, 不写正文; 采用需作者显式。
- **调用点**: `writing/semantic_review.py`(step `writing.semantic_review.chunk_N`), 由写作雷达异步触发(自主智能式 §7)。
- **M4 落点**: `llm_step(spec=semantic_review)` 由 `@novelcraft/writing` 写作后评审台/修订中心调用(§17.4)。

### 3.4 targeted_revision(finding-bound 返修)

- **用途一句话**: 针对 semantic_review findings 输出定向修订稿。
- **输入**: 冻结正文 + 选定 findings。
- **输出 Schema**: 修订后文本(diff 预览)【待定: 无契约 JSON, 以 `semantic_review.py` 为准】。
- **预算/温度/超时/重试**: temp `0.4`、timeout `1800s`。来源: `writing/semantic_review.py:576`。step `writing.targeted_revision.generate`。
- **降级**: 修订只进待审阅候选; 失败不改写正文。
- **调用点**: `writing/semantic_review.py`(step `writing.targeted_revision.generate`)。
- **M4 落点**: `llm_step(spec=targeted_revision)` 由 `@novelcraft/writing` 修订中心调用。

> 注: 另有 `writing/conflict_ai.py`(step `writing.conflict_check.ai_review.structured` temp 0.2 / `ai_suggestion.structured` temp 0.3)为确定性冲突检查的 AI 辅助面, docs/prompts 无契约条目, 见结尾对照表。

---

## 4. world 世界(生成中心 + 问答 + 世界书 + 地图册)

M4 落点: `@novelcraft/world` 插件(§22.3); 五模式从「并列 UI」变「编排脑按意图调用的内容手步骤」(§19)。

### 4.1 world_creation_chat(自由共创对话)

- **用途一句话**: 世界观自由共创(不写资产), 模型按对话状态自主选择发散/比较/质疑/验证前提/收束, 直接回应作者。
- **输入**: 作者已选目标(世界对象/完善现有页/新建页)+ 对话状态 + 资料(可参考但不可信)。
- **输出**: 普通文本(非 JSON/协议), 调用层包进 `{reply}` schema 校验非空与长度。
- **预算/温度/超时/重试**: temp `0.8`、timeout `1800s`(WORLD_GENERATION_TIMEOUT_SECONDS)、空文本同阶段重试 1 次。来源: `world_generation_center_service.py:110,441`。operation `world.generation.chat`。
- **降级**: 自由聊天不启用 JSON mode; 偶发空文本重试一次, 不把任意原始输出当业务响应; 该 step 无创建 Scene/改总纲/跨模块工具能力(P体系 §5「生成中心世界设定共创」)。
- **调用点**: `world_generation_center_service.py`(operation `world.generation.chat`)。
- **M4 落点**: `llm_step(spec=world_creation_chat)` 由助手对话本身调用(§19: 编排脑按意图路由)。

### 4.2 world_convergence(只读收束 map/reduce)

- **用途一句话**: 作者点击「收束本轮」后, 把当前对话窗口/粘贴材料/页面 baseline 汇聚为最多 7 张决定卡(确定性 map/reduce)。
- **输入**: 带 hash 的 typed source manifest; 超预算时固定字符预算顺序 map + 固定二叉 reduce。
- **输出 Schema**(`GeneratedWorldGenerationConvergenceOutput`): 决定卡分配 source key + `retained_source_keys` / `shared_source_keys`; `workflow_preset=world_core` 时加 `can/cannot/cost/failure/maintenance` 规则。
- **预算/温度/超时/重试**: temp `0.0`(map/reduce 均 0)、整轮 1800s 端到端预算; 漏项/未知 key/未声明重复修复 1 次。来源: `world_generation_center_service.py:2559`(map)、reduce temp 0.0。operation `world.generation.convergence`。
- **降级**: 修复仍失败返回不完整预览; 不创建 suggestion; 结果如需采用须作者另行保存 checkpoint + adoption package(确定性, 不调模型)(P体系 §5)。
- **调用点**: `world_generation_center_service.py`(operation `world.generation.convergence`)。
- **M4 落点**: `llm_step(spec=world_convergence)` 由「补设定」微工作流内部步调用(§19)。

### 4.3 world_exploration(一跳探索 preview)

- **用途一句话**: 作者从当前世界书页请求相邻新页面时, 只读给出最多 3 个深度 1 缺口或停止原因。
- **输入**: 同一份 typed source manifest; 每项须引用已知 source key。
- **输出 Schema**(`GeneratedWorldGenerationExplorationOutput`): 最多 3 个一跳缺口或停止原因。
- **预算/温度/超时/重试**: temp `0.2`、timeout `1800s`; 未知 key 修复 1 次。来源: `world_generation_center_service.py:2216`。operation `world.generation.exploration`。
- **降级**: 不能写页面正文/递归找下一跳/调工具/建 suggestion; snapshot 变化调用前 fingerprint 拒绝(P体系 §5)。
- **调用点**: `world_generation_center_service.py`(operation `world.generation.exploration`)。
- **M4 落点**: `llm_step(spec=world_exploration)` 由建议雷达「可探索缺口」卡片触发(§19)。

### 4.4 world_semantic_inspection(当前页检修)

- **用途一句话**: 检修冻结页面当前版本, 产出 findings 供复核。
- **输入**: 冻结页当前版本的 source manifest。
- **输出 Schema**(`GeneratedWorldSemanticInspectionOutput`): findings。
- **预算/温度/超时/重试**: temp `0.0`、timeout `1800s`; 最多 2 次尝试。来源: `world_generation_center_service.py:2256`。operation `world.generation.semantic_inspection`。
- **降级**: findings 只进信号卡(四动词), 不自动改页。
- **调用点**: `world_generation_center_service.py`(operation `world.generation.semantic_inspection`)。
- **M4 落点**: `llm_step(spec=world_semantic_inspection)` 由一致性雷达/世界一致性台触发(§19)。

### 4.5 world_conversation_decision_state(多轮决策状态编译)

- **用途一句话**: 结构化生成前, 按时间顺序编译作者当前目标/已确认要求/已否定内容/禁用专名/未决项/命名权限与「谁能知道/如何表达」边界, 不继续创作。
- **输入**: 多轮对话(作者修订 + 助手回应); 后续生成只消费此决策状态, 不重放可能含作废方案的助手历史。
- **输出 Schema**: `decision_state`(字段级见 `world_generation_center_service.py` 内联 contract)。
- **预算/温度/超时/重试**: temp `0.0`、timeout `1800s`。来源: `world_generation_center_service.py:1038`。step `world.generation.conversation_decision_state`。
- **降级**: 禁用/未经允许专名触发确定性守卫并同预算重生成; 连续违反则不创建 suggestion(P体系 §5)。
- **调用点**: `world_generation_center_service.py`(step `world.generation.conversation_decision_state`)。
- **M4 落点**: `llm_step(spec=world_conversation_decision_state)` 由 `@novelcraft/world` 在结构化建议前调用。

### 4.6 world_core_entity(世界对象建议收束)

- **用途一句话**: 忠实收束一个待处理世界对象建议(不二次随机重设计)。
- **输入**: 当前工作稿 + 作者指令 + generation_center 上下文。
- **输出 Schema**(契约 `world_generation_core_entity.json`, `GeneratedObjectDraftOutput`): `name / summary / public_info / hidden_truth / importance_level / reveal_level / details / character_card / review_notes`。禁 `status/approved_by/novel_id/id`。
- **预算/温度/超时/重试**: temp `0.35`、timeout `1800s`。来源: `world_generation_center_service.py:1261`。step `world.generation.core_entity.structured`(+`.quality_review` 第二遍)。
- **降级**: 只进 pending suggestion; 目标类型由作者选; 模型不能发布页面/写 canonical(P体系 §5)。
- **调用点**: `world_generation_center_service.py`(step `world.generation.core_entity.structured`)。
- **M4 落点**: `llm_step(spec=world_core_entity)` 由 `@novelcraft/world` 生成中心调用。

### 4.7 world_bible_page(整页重构提案)

- **用途一句话**: 综合完整工作稿 + 作者指令 + 项目背景生成整页重构提案。
- **输入**: 当前页 + 工作稿 + 作者指令 + 项目背景。
- **输出 Schema**(契约 `world_generation_world_bible_page.json`, `GeneratedWorldBiblePageProposal`): `title / page_type / overview / sections[] {source_section_key, section_type, title, body_markdown, linked_asset_keys} / linked_asset_keys / design_rationale / review_notes`。禁 `novel_id/page_id/section_id/status/version_number/projection_policy/sensitivity_hint`。
- **预算/温度/超时/重试**: temp `0.35`、timeout `1800s`。来源: `world_generation_center_service.py:1350`。step `world.generation.world_bible_page.structured`。
- **降级**: 不降低既有 projection/sensitivity; 已否定方案不复活; 只进 pending。
- **调用点**: `world_generation_center_service.py`(step `world.generation.world_bible_page.structured`)。
- **M4 落点**: `llm_step(spec=world_bible_page)` 由 `@novelcraft/world` 生成中心调用。

### 4.8 world_bible_new_page(全新页面提案)

- **用途一句话**: 生成完整新页面, 按资料自身选组织方式, 不强制固定章节模板。
- **输入**: 探索选中项 + 证据 + 作者指令 + 项目背景。
- **输出 Schema**(契约 `world_generation_world_bible_new_page.json`, `GeneratedWorldBibleNewPageProposal`): `title / page_type / overview / sections[] {section_type, title, body_markdown, linked_asset_keys} / linked_asset_keys / design_rationale / review_notes / source_revision(可选整页来源修订)`。禁同 4.7。
- **预算/温度/超时/重试**: temp `0.35`、timeout `1800s`。来源: `world_generation_center_service.py:1414`。step `world.generation.world_bible_new_page.structured`。
- **降级**: 只有具体内容改变才写两条 pending suggestion; 不自动应用或再探索(P体系 §5)。
- **调用点**: `world_generation_center_service.py`(step `world.generation.world_bible_new_page.structured`)。
- **M4 落点**: `llm_step(spec=world_bible_new_page)` 由 `@novelcraft/world` 生成中心调用。

### 4.9 world_ask(作者问答)

- **用途一句话**: 只根据当前项目作者可见证据生成带引用回答或明确拒答(查事实/比较关系/追来源)。
- **输入**: 当前项目 + 作者可见性 + 正式 source version + 最多 5 个回读来源 + 有界 `SOURCE_EVIDENCE`。
- **输出 Schema**: 每条实质主张须用服务端 `citation_key`; 证据不足以支持结论时 `no_answer=true` + claims 空。snapshot prompt name `world.ask.v1`。
- **预算/温度/超时/重试**: temp `0.0`、timeout `1800s`(_TIMEOUT_SECONDS); 未知 key 修复 1 次。来源: `ask_world_service.py:42,408`。step `world.ask`。
- **降级**: 无相关证据服务在模型调用前拒答; 仍无合法引用失败; 回答只读, 保存 pending 是独立显式动作(P体系 §5)。
- **调用点**: `ask_world_service.py`(step `world.ask`)。
- **M4 落点**: `llm_step(spec=world_ask)` 保留原语(插件已有 `novelcraft_ask_engine`)+ 剧情雷达默认答复(§19)。

### 4.10 world_bible_synopsis(世界观简介刷新)

- **用途一句话**: 把已采用世界事实压缩组织为作者版 P1 世界观简介, 不裁决正史。
- **输入**: 确定性排序/去重/冲突排除/预算裁剪后的来源 manifest(世界书正文/简介/引用资料作为不可信 user/context 数据)。
- **输出 Schema**(契约 `world_bible_synopsis.json`, `WorldBibleSynopsisStructuredOutput`): `sections[] {title, claims[] {text, source_keys}} / omitted_reasons`。禁 `novel_id/id/status/version_number`。每实质段落至少引用一个服务端短 source key。
- **预算/温度/超时/重试**: temp `0.2`、timeout `1800s`(WORLD_BIBLE_SYNOPSIS_TIMEOUT_SECONDS)、`_MAX_SYNOPSIS_TOKENS=4000`、schema repair 最多 2 次。来源: `world_bible_synopsis_service.py:47-48,1132`。step `world.world_bible.synopsis.structured`。
- **降级**: 无法归因内容丢弃; 冲突时排除页面片段保留冲突提示; 只写不可变派生 revision, 不改正史对象/世界书正文; 只属 `author_safe/author_full`(P体系 §5「世界书简介类」)。
- **调用点**: `world_bible_synopsis_service.py`(step `world.world_bible.synopsis.structured`)。
- **M4 落点**: `llm_step(spec=world_bible_synopsis)` 由 `@novelcraft/world` 世界书简介刷新任务调用。

### 4.11 map_atlas_plan(地图册层级规划)

- **用途一句话**: 把已确认资料规划为最多 20 页地图册层级; 图片 Prompt 交给固定 Image API。
- **输入**: `world.map_atlas.generate` 编译的 author-full canonical 资料 + RAG `map_atlas` 证据 + 可选工作稿; 每批 5 个地点提取空间线索。
- **输出 Schema**(`AtlasPlan`): 最多 20 页、无环、父级先于子级、默认不深于街道; 每页直接来源/AI 视觉补全/冲突/标注; 来源短引用须属当前 `novel_id`。step `world.map_atlas.plan.structured`。
- **预算/温度/超时/重试**: 规划 temp `0`、max_tokens `4000`; 图片 Prompt temp `0.2`、max_tokens `12000`。来源: `world/map_atlas_workflow.py:761-762,1501-1502`。
- **降级**: 成图不出现文字/字母/数字/方向箭头/距离/比例尺/图例/层级标签; 图片模型不输出结构化业务状态、不把视觉补全写回正式资料(P体系 §5「AI 地图册规划与图片 Prompt」)。
- **调用点**: `world/map_atlas_workflow.py`(step `world.map_atlas.plan.structured`; 图片走 `gpt-image-2` Image API)。
- **M4 落点**: `llm_step(spec=map_atlas_plan)` 由 `@novelcraft/world` map 子系统调用; 图片模型非 llm_step(直连 Image API)。

---

## 5. rag 检索重排序

### 5.1 rag_reranker(RAG 证据重排序)

- **用途一句话**: 只在确定性混合检索 + embedding 去重之后, 对 `2*top_k` 候选池判断证据价值并排序/弃权(不回答案/不创作/不裁决事实)。
- **输入**: `retrieval_mode(search|context|extraction)` + 可选下游 purpose + 原始召回分 + 完整候选 chunk 正文(不裁剪)。
- **输出 Schema**(契约 `rag_reranker.json`, `RerankerOutput`): `support_status(supported|partially_supported|unsupported|uncertain) / confidence / basis / ranked_candidates[] {candidate_ref, evidence_role(direct|supporting|counterevidence|topical_only|irrelevant), relevance_score, basis, uncertain} / uncertainties`。禁 `id/novel_id/source/needs_review`。
- **预算/温度/超时/重试**: temp `0.1`、timeout `1800s`(RERANKER_TOTAL_TIMEOUT_SECONDS)、unsupported 弃权置信度 0.8、topical 最低分 0.2。来源: `rag/reranker.py:22-30,245`。step `rag.reranker.generate`。默认关闭(`RERANKER_ENABLED`)。
- **降级**: 高置信 `unsupported` 返回空结果(真正 abstention); `uncertain`/低置信/provider/schema 失败保留原排序并告警; `extraction` 不采用仅主题相关片段(P体系 §5「RAG 证据重排序类」)。
- **调用点**: `modules/rag/reranker.py`(step `rag.reranker.generate`), 由 `search/context/extraction` 在候选数 > top_k 时调用。
- **M4 落点**: `llm_step(spec=rag_reranker)` 由 `@novelcraft/rag` 作为 `@novelcraft/context` 供给原语时调用(§20.7)。

---

## 6. interaction RP 互动

M4 落点: `@novelcraft/preset`(companion preset)+ DSH 会话(§20.11); interaction 是独立私人故事领域, 不与作者资产雷达混用。

### 6.1 interaction_story(RP 故事正文)

- **用途一句话**: 输出可见 RP 故事正文 + 可选隐藏尾部元数据(标题/发展提示/行动选项/是否结束)。
- **输入**: 用户开场 + 代码级选中路径 + 当前有效总回顾; 未选 sibling/失败残段/隐藏项目 ID/作者资产不进上下文。
- **输出 Schema**(`interaction/prompts.py`, version `interaction-story-v2`): 正文后可带固定边界标记的可选 JSON 尾块 `{response_kind, suggested_title, branch_hint, story_ended, action_suggestions}`。
- **预算/温度/超时/重试**: temp 默认 `0.8`(profile 可覆盖)、max_tokens `8192`(STORY_OUTPUT_TOKENS; 看海模式 `4096`)。来源: `interaction/generation.py:1160`、`prompts.py:13-14`。
- **降级**: 尾块缺失/截断/schema 无效只丢弃附加信息, 不判废正文; 行动选项无法可靠提出可返回 0 个不重试; selection epoch/节点创建/分支/停止/owner 隔离全由代码决定(P体系 §5「RP 互动故事与回顾」)。
- **调用点**: `modules/interaction/prompts.py`(版本 `interaction-story-v2`), 由 `interaction/generation.py` 流式组装。
- **M4 落点**: `llm_step(spec=interaction_story)` 由 DSH 会话 RP 对话入口调用(流式特例维持 local/SSE 判断)。

### 6.2 interaction_summary(RP 回顾)

- **用途一句话**: 一次生成新分段概要与更新后总回顾(七分区)。
- **输入**: 本次新增已选故事 + 已有手工总回顾(活动基线)。
- **输出 Schema**(`interaction-summary-v1` / `interaction-summary-output-v1`): `segment_summary` + `overview`(世界与起点/我的角色/当前局面/重要人物与势力/关键转折/正在发展/必须继续记住七分区)。
- **预算/温度/超时/重试**: temp `0.2`、max_tokens `12000`(SUMMARY_OUTPUT_TOKENS)。来源: `interaction/generation.py:1173`、`prompts.py:15,17-18`。
- **降级**: 传闻/误解/局部认知保留不确定性, 不补出用户未体验的幕后答案; 旧原文不能越过手工总回顾复活被删改说法。
- **调用点**: `modules/interaction/prompts.py`(版本 `interaction-summary-v1` / `interaction-summary-output-v1`)。
- **M4 落点**: `llm_step(spec=interaction_summary)` 由 DSH 会话 RP 回顾任务调用。

---

## 7. 覆盖对照表(docs/prompts 清单 vs 旧代码调用点)

> 标记: ✅ 双方一致; ⚠️ docs 有契约但无独立 prompt 文件/代码侧窄; ➕ 代码有调用但 docs 清单无契约条目。

| Prompt/Spec | docs/prompts 清单(P体系 §2) | 旧代码调用点 | 契约 JSON | 状态 |
|---|---|---|---|---|
| scene_slicing | ✅(Phase 1a, 内联) | `workflow_llm_adapters.py` step `phase1a_scene_slicing` | `phase1a_scene_slicing.json` | ✅ |
| scene_anchor_repair | ✅(Phase 1a) | step `phase1a_scene_anchor_repair` | `phase1a_scene_anchor_repair.json` | ✅ |
| scene_gap_recovery | ✅(Phase 1a continuous-gap) | step `phase1a_missing_chapter_recovery` | `phase1a_scene_recovery.json` | ✅ |
| scene_enrichment | ✅(Phase 1b) | step `phase1b_enrichment`(+内部 `phase1b_fusion` reducer) | `phase1b_scene_enrichment.json` | ✅ |
| scene_fusion(1c) | ✅(Phase 1c boundary+synthesis) | step `phase1c_boundary_review` / `phase1c_scene_synthesis` | `phase1c_boundary_review.json` / `phase1c_scene_synthesis.json` | ✅ |
| entity_extraction | ✅ `scene_entity_extraction.md` | step `imports.scene_entity.extraction.structured` | `scene_entity_extraction.json` | ✅ |
| alias_relation | ✅ `alias_relation_extraction.md` | step `imports.scene_entity.alias_relation.structured` | `phase2_alias_relation.json` | ✅ |
| structure_analysis | ✅(Phase 3, 内联) | `outline/generation/parser.py` step `outline.structure_parser.simple_output.structured` | `phase3_structure_simple.json` | ✅ |
| dedup_judge | ⚠️(§6.1 语义, 无独立 prompt 文件) | `world/entity_fusion.py`、`outline/structure_dedup.py` | 无 | ⚠️【待定: 输出契约需在 R0 规则目录补】 |
| phase2_world_extraction(legacy 窗口级) | ⚠️(§3 契约提及, 设计已由 scene 级取代) | step `phase2_world_extraction` | `phase2_world_extraction.json` | ⚠️(遗留并行路径) |
| story_outline_generate | ✅ `story_outline.md` | `outline/story_outline_generation.py` step `outline.story_outline.generate.structured` + 3 审计 | `story_outline.json` | ✅ |
| outline_generate(P20×3) | ✅ `p20_plot_thread/outline_arc/planned_scene.md` | `outline/p20_service.py` step `outline.p20.{target}.structured` | `p20_*.json` ×3 | ✅ |
| p20_semantic_audit(×3) | ✅ `p20_evidence/scope_rule/author_instruction_audit.md` | `outline/p20_service.py` `_run_audit` | 无(用 `P20SemanticAudit`) | ⚠️(无契约 JSON, schema 在 `p20_schemas.py`) |
| outline_analyze | ✅ `outline/ai_workflow_service.py` 内联 | step `outline.ai_workflow.analyze.generate` | 无 | ⚠️ |
| scene_fusion_draft(工作台) | ✅ `scene_fusion_draft.py` 内联 | step `outline.scene_fusion.synthesis.v2` | 复用 `phase1c_scene_synthesis.json` | ✅ |
| writing_generate | ✅ `writing/services.py` 内联 | step `writing.generation.candidate.generate` | 无 | ⚠️ |
| pov_generation | ✅(§5 单角色 POV) | `writing/pov_generation.py`(复用 generate step) | 无 | ⚠️ |
| semantic_review | ✅ `writing/semantic_review.py` 内联 | step `writing.semantic_review.chunk_N` | 无 | ⚠️ |
| targeted_revision | ✅ 同上 | step `writing.targeted_revision.generate` | 无 | ⚠️ |
| world_creation_chat | ✅ 内联 | operation `world.generation.chat` | 无 | ⚠️ |
| world_convergence | ✅ 内联 | operation `world.generation.convergence` | 无 | ⚠️ |
| world_exploration | ✅ 内联 | operation `world.generation.exploration` | 无 | ⚠️ |
| world_semantic_inspection | ✅ 内联 | operation `world.generation.semantic_inspection` | 无 | ⚠️ |
| world_conversation_decision_state | ✅(§5) | step `world.generation.conversation_decision_state` | 无 | ⚠️ |
| world_core_entity | ✅ 内联 | step `world.generation.core_entity.structured` | `world_generation_core_entity.json` | ✅ |
| world_bible_page | ✅ 内联 | step `world.generation.world_bible_page.structured` | `world_generation_world_bible_page.json` | ✅ |
| world_bible_new_page | ✅ 内联 | step `world.generation.world_bible_new_page.structured` | `world_generation_world_bible_new_page.json` | ✅ |
| world_ask | ✅ `ask_world_service.py` 内联 | step `world.ask` | 无 | ⚠️ |
| world_bible_synopsis | ✅ 内联 | step `world.world_bible.synopsis.structured` | `world_bible_synopsis.json` | ✅ |
| map_atlas_plan | ✅ `map_atlas_workflow.py` 内联 | step `world.map_atlas.plan.structured`(+ Image API) | 无 | ⚠️ |
| rag_reranker | ✅ `rag_reranker.md` | step `rag.reranker.generate` | `rag_reranker.json` | ✅ |
| interaction_story | ✅ `interaction/prompts.py` | `interaction-story-v2` | 无 | ⚠️ |
| interaction_summary | ✅ `interaction/prompts.py` | `interaction-summary-v1` / `-output-v1` | 无 | ⚠️ |
| (generation_prompt_template_service) | ✅(§2 模板, 非 LLM step) | 模板渲染, 非 llm_step | 无 | ➕(不是 prompt, 是作者模板运行时 validator) |
| writing_conflict_ai | ➕(docs 无条目) | `writing/conflict_ai.py` step `writing.conflict_check.ai_review/ai_suggestion` | 无 | ➕ |
| outline_structure_dedup | ➕(docs 无条目) | `outline/structure_dedup.py` step `outline.structure_dedup.decision.structured` | 无 | ➕ |

**对照结论**:
1. 有契约 JSON(21 份)的 step 是 M4 spec 的最高优先级权威; 其余「内联无契约」的 step(尤其 writing 4 项、world 10 项、interaction 2 项、outline_analyze、dedup_judge、p20_semantic_audit)其 output_schema/降级条款需在 R0 继续从代码 Pydantic schema 补全为正式 spec 文件(§24.1 第二步要求「每份含 output_schema + 预算 + 温度」)。
2. `phase2_world_extraction` 是遗留窗口级路径(contract v1), 与 scene 级 `entity_extraction`/`alias_relation` 并存; M4 以 scene 级为准, 遗留路径标记退役候选。
3. `generation_prompt_template_service`(作者自定义模板)不是 llm_step, 是「模板渲染 + 运行时 validator」, 落在 `@novelcraft/world` 的页面/提示词模板资源(§19), 不入 spec 目录。
4. `writing_conflict_ai` 与 `outline_structure_dedup` 是「确定性规则 + AI 辅助」的窄步骤, docs 清单未单列; 建议 R0 在 rules 目录记录其确定性规则主体, AI 辅助面按上面 temperature 记录即可。
