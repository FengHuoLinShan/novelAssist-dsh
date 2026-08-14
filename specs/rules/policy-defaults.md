# R0 · policy.yml 默认值草案(policy-defaults)

- 来源 commit: `a257df23e773db6e843f3dda81b855008558e6e7`(origin/main, 分支 `codex/m4-dsh-plugin-rewrite`)
- 提取日期: 2026-08-14
- 提取范围:
  - `specs/prompts/catalog.md`(预算/温度/超时/并发/降级)
  - `specs/assets/{imports,world,outline,writing,small-modules}.md`(阈值/预算/门禁)
  - 旧代码常量: `backend/shared/deep_import_settings.py`(深度导入预算默认与范围)、各模块常量
  - 设计文档 §13(policy.yml 字段)、§6.1(去重激进度)、§24

> 本文件是 `policy.yml`(设计 §13「策略即数据」)的默认值草案: 每行给「默认值 + 覆盖链 + 建议键名」。
> 不确定处标【待定】。旧代码常量如无特别说明, 均为「默认值, 可被项目级 deep-import 设置或环境变量覆盖」。

## 0. 覆盖链与键名约定

- **旧引擎覆盖链**(`shared/deep_import_settings.py`): `环境变量 > projects.settings.deep_import.{phase}.{key} > DEEP_IMPORT_DEFAULT_SETTINGS`, 均经 `DEEP_IMPORT_SETTING_LIMITS` 范围校验; 快照冻结(`_deep_import_settings_frozen`)后环境变量失效。环境变量名 = `{PHASE.upper()}_{key.upper()}`, global 相前缀 `DEEP_IMPORT_`(如 `PHASE1A_SCENE_SLICING_TIMEOUT_SECONDS`)。
- **M4 覆盖链**:
  - provider/model/参数(temperature / top_p / max_tokens / timeout)→ `.assistant/llm.yml`(项目级 LLM 设置, **Key 不进文件**)→ policy.yml(workflow 级默认)→ 代码默认。
  - 流程阈值/预算/并发/降级 → `policy.yml`(策略即数据)→ `.assistant/calibration.md`(per-book 校准增量)→ 代码默认。
- **建议键名风格**: 沿 §13 的点分键(`dedup.merge_bias`、`watch.notify_threshold`), llm_step 参数统一 `llm.steps.<spec>.<param>`, 流程预算统一 `import.<phase>.<key>` / `budget.*` / `concurrency.*`。

---

## 1. 温度常量(`llm.steps.<spec>.temperature`)

| spec(内容手步骤) | 默认值 | 覆盖链 | 建议 policy.yml 键 |
|---|---|---|---|
| scene_slicing | 0.2 | llm.yml / policy.yml / 默认 | `llm.steps.scene_slicing.temperature` |
| scene_anchor_repair | 0 | 同上 | `llm.steps.scene_anchor_repair.temperature` |
| scene_gap_recovery | 0.1 | 同上 | `llm.steps.scene_gap_recovery.temperature` |
| scene_enrichment(1b) | 0.2(内部 fusion reducer 0) | 同上 | `llm.steps.scene_enrichment.temperature` / `...fusion_reducer.temperature` |
| scene_fusion(1c boundary+synthesis) | 0.1 | 同上 | `llm.steps.scene_fusion.temperature` |
| entity_extraction | 0.3 | 同上 | `llm.steps.entity_extraction.temperature` |
| alias_relation | 0.2 | 同上 | `llm.steps.alias_relation.temperature` |
| structure_analysis | 0.2 | 同上 | `llm.steps.structure_analysis.temperature` |
| dedup_judge(L1/L2) | 0.1(entity_fusion 与 structure_dedup 两处) | 同上 | `llm.steps.dedup_judge.temperature` |
| story_outline_generate | 0.55(三类审计 0.0) | 同上 | `llm.steps.story_outline.temperature` / `...audit.temperature` |
| outline_generate(P20) | 0.55(三类审计 0.0) | 同上 | `llm.steps.outline_generate.temperature` / `...audit.temperature` |
| p20_semantic_audit | 0.0 | 同上 | `llm.steps.p20_semantic_audit.temperature` |
| outline_analyze | 0.3 | 同上 | `llm.steps.outline_analyze.temperature` |
| scene_fusion_draft(工作台) | 0.2 | 同上 | `llm.steps.scene_fusion_draft.temperature` |
| writing_generate | 0.7 | 同上 | `llm.steps.writing_generate.temperature` |
| pov_generation | 0.7 | 同上 | `llm.steps.pov_generation.temperature` |
| semantic_review | 0.1 | 同上 | `llm.steps.semantic_review.temperature` |
| targeted_revision | 0.4 | 同上 | `llm.steps.targeted_revision.temperature` |
| writing_conflict_ai | ai_review 0.2 / ai_suggestion 0.3 | 同上 | `llm.steps.conflict_ai.review.temperature` / `...suggestion.temperature` |
| world_creation_chat | 0.8 | 同上 | `llm.steps.world_creation_chat.temperature` |
| world_convergence | 0.0(map/reduce 均 0) | 同上 | `llm.steps.world_convergence.temperature` |
| world_exploration | 0.2 | 同上 | `llm.steps.world_exploration.temperature` |
| world_semantic_inspection | 0.0 | 同上 | `llm.steps.world_semantic_inspection.temperature` |
| world_conversation_decision_state | 0.0 | 同上 | `llm.steps.world_decision_state.temperature` |
| world_core_entity | 0.35 | 同上 | `llm.steps.world_core_entity.temperature` |
| world_bible_page | 0.35 | 同上 | `llm.steps.world_bible_page.temperature` |
| world_bible_new_page | 0.35 | 同上 | `llm.steps.world_bible_new_page.temperature` |
| world_ask | 0.0 | 同上 | `llm.steps.world_ask.temperature` |
| world_bible_synopsis | 0.2 | 同上 | `llm.steps.world_bible_synopsis.temperature` |
| map_atlas_plan | 0 | llm.yml / policy.yml / 默认 | `llm.steps.map_atlas_plan.temperature` |
| map_spatial_facts | 0 | 同上 | `llm.steps.map_spatial_facts.temperature` |
| rag_rerank | 0.1 | llm.yml / policy.yml / 默认 | `llm.steps.rag_rerank.temperature` |
| interaction_story | 0.8(profile 可覆盖) | preset profile / llm.yml / 默认 | `llm.steps.interaction_story.temperature` |
| interaction_summary | 0.2 | 同上 | `llm.steps.interaction_summary.temperature` |

来源: `specs/prompts/catalog.md` §1–§6 各节「预算/温度」; 各模块常量(如 `p20_service.py:53`、`writing/services.py:81`)。

---

## 2. 超时常量(`llm.steps.<spec>.timeout_seconds` / `import.<phase>.<key>`)

| 常量 | 默认值(秒) | 旧覆盖链(env / deep_import 键) | 建议 policy.yml 键 |
|---|---|---|---|
| scene_slicing 超时 | 900 | `PHASE1A_SCENE_SLICING_TIMEOUT_SECONDS` / `phase1a.scene_slicing_timeout_seconds` | `llm.steps.scene_slicing.timeout_seconds` |
| scene_anchor_repair 超时 | 900(复用 slicing) | 同上 | `llm.steps.scene_anchor_repair.timeout_seconds` |
| scene_gap_recovery 超时 | 900 | 同上 | `llm.steps.scene_gap_recovery.timeout_seconds` |
| scene_enrichment(1b)超时 | 1200(内部 reducer 420) | `PHASE1B_ENRICH_TIMEOUT_SECONDS` / `phase1b.enrich_timeout_seconds` | `llm.steps.scene_enrichment.timeout_seconds` |
| scene_fusion(1c)超时 | 1200 | `phase1c.timeout_seconds` | `llm.steps.scene_fusion.timeout_seconds` |
| entity_extraction 超时 | 项目 LLM timeout + 60 宽限 | `DEEP_IMPORT_STRUCTURED_TIMEOUT_GRACE_SECONDS` / `global.structured_timeout_grace_seconds` | `llm.steps.entity_extraction.timeout_grace_seconds` |
| alias_relation 超时 | 单步 600 / 整阶段 1200 | `phase2.alias_relation_llm_timeout_seconds` / `alias_relation_total_timeout_seconds` | `llm.steps.alias_relation.timeout_seconds` / `...total_timeout_seconds` |
| structure_analysis 超时 | 1200 | `PHASE3_STRUCTURE_TIMEOUT_SECONDS` / `phase3.structure_timeout_seconds` | `llm.steps.structure_analysis.timeout_seconds` |
| story_outline_generate 超时 | 1800 | `STORY_OUTLINE_TIMEOUT_SECONDS` | `llm.steps.story_outline.timeout_seconds` |
| outline_generate(P20)超时 | 1800(候选+审计+修订共享 30 分钟阶段预算) | `P20_TIMEOUT_SECONDS` | `llm.steps.outline_generate.timeout_seconds` / `...phase_budget_seconds` |
| p20_semantic_audit 超时 | 1800 | `P20_TIMEOUT_SECONDS` | `llm.steps.p20_semantic_audit.timeout_seconds` |
| outline_analyze 超时 | 1800 | `P20_TIMEOUT_SECONDS` | `llm.steps.outline_analyze.timeout_seconds` |
| scene_fusion_draft 超时 | 1800 | `SCENE_FUSION_TIMEOUT_SECONDS` | `llm.steps.scene_fusion_draft.timeout_seconds` |
| writing_generate 超时 | 1800 | `WRITING_GENERATION_TIMEOUT_SECONDS` | `llm.steps.writing_generate.timeout_seconds` |
| pov_generation 超时 | 1800(与 writing_generate 共用) | 同上 | `llm.steps.pov_generation.timeout_seconds` |
| semantic_review 超时 | 1800 | `SEMANTIC_REVIEW_TIMEOUT_SECONDS` | `llm.steps.semantic_review.timeout_seconds` |
| targeted_revision 超时 | 1800 | — | `llm.steps.targeted_revision.timeout_seconds` |
| world_*(chat/convergence/...)超时 | 1800 | `WORLD_GENERATION_TIMEOUT_SECONDS` | `llm.steps.world.*.timeout_seconds` |
| world_bible_synopsis 超时 | 1800 | `WORLD_BIBLE_SYNOPSIS_TIMEOUT_SECONDS` | `llm.steps.world_bible_synopsis.timeout_seconds` |
| world_ask 超时 | 1800 | `WORLD_ASK_TIMEOUT_SECONDS`【待定: 精确 env 名未在 catalog 列全】 | `llm.steps.world_ask.timeout_seconds` |
| rag_rerank 超时 | 1800 | `RERANKER_TOTAL_TIMEOUT_SECONDS` | `llm.steps.rag_rerank.timeout_seconds` |
| map_spatial_facts 超时 | 900 | —(M4 map atlas 批次) | `llm.steps.map_spatial_facts.timeout_seconds` |
| map_atlas_plan 规划 run | 3600(工具级同步执行) | —(M4 map atlas 批次) | (工具 timeout, 非 llm_step 单步) |
| 用户可设 timeout 上界 | 1–3600 | `settings.timeout`(llm.yml) | `llm.yml.timeout` |

---

## 3. max_tokens / 预算常量

| 常量 | 默认值 | 旧覆盖链 | 建议 policy.yml 键 |
|---|---|---|---|
| scene_slicing max_tokens | 8192 | `PHASE1A_SCENE_MAX_TOKENS` / `phase1a.scene_max_tokens` | `llm.steps.scene_slicing.max_tokens` |
| scene_anchor_repair max_tokens | 32768 | — | `llm.steps.scene_anchor_repair.max_tokens` |
| scene_gap_recovery max_tokens | 8192 | `PHASE1A_CHAPTER_RECOVERY_MAX_TOKENS` | `llm.steps.scene_gap_recovery.max_tokens` |
| scene_enrichment max_tokens | 32768(reducer 128 / small_sample 6144) | `phase1b.enrich_max_tokens` / `reducer_max_tokens` / `small_sample_max_tokens` | `llm.steps.scene_enrichment.max_tokens` |
| entity_extraction max_tokens | 32768 | `phase2.parallel_scene_max_tokens`(min/max 均 32768) | `llm.steps.entity_extraction.max_tokens` |
| structure_analysis max_tokens | 32768 | `phase3.structure_max_tokens` | `llm.steps.structure_analysis.max_tokens` |
| world_bible_synopsis max_tokens | 4000 | `WORLD_BIBLE_SYNOPSIS_MAX_TOKENS` | `llm.steps.world_bible_synopsis.max_tokens` |
| map_atlas_plan max_tokens | 4000(旧引擎实际 12000, 见 map_atlas 段) | — | `llm.steps.map_atlas_plan.max_tokens` |
| map_spatial_facts max_tokens | 4000 | — | `llm.steps.map_spatial_facts.max_tokens` |
| interaction_story max_tokens | 8192(看海 4096) | `STORY_OUTPUT_TOKENS` | `llm.steps.interaction_story.max_tokens` |
| interaction_summary max_tokens | 12000 | `SUMMARY_OUTPUT_TOKENS` | `llm.steps.interaction_summary.max_tokens` |
| phase0 窗口预算 | target_input_chars 72000 / max_chapters_per_window 20 / min_max_tokens 13000 / max_max_tokens 32768 | `phase0.*` | `import.phase0.target_input_chars` 等 |
| 用户可设 max_tokens 上界 | 1–200000 | `settings.max_tokens`(llm.yml) | `llm.yml.max_tokens` |

---

## 4. 并发 / 批量 / 规模上限

| 常量 | 默认值 | 旧覆盖链 / 来源 | 建议 policy.yml 键 |
|---|---|---|---|
| scene_slicing 并发 | 50 | `PHASE1A_SCENE_SLICING_CONCURRENCY`(scene_slicing.py:28) | `concurrency.scene_slicing` |
| scene_enrichment 并发 | 200 | `workflow_llm_adapters.py:37-38,1068` | `concurrency.scene_enrichment` |
| phase1c 融合并发 | 20 | `phase1c.concurrency` | `concurrency.phase1c` |
| phase2 窗口并发 / 并行 Scene | 20 / 25 | `phase2.world_window_concurrency` / `parallel_scene_concurrency` | `concurrency.phase2.window` / `.parallel_scene` |
| phase2 批大小 / 批并发 | 12 / 6 | `phase2.batch_size_scenes` / `batch_concurrency` | `concurrency.phase2.batch_size` / `.batch_concurrency` |
| alias_relation 并发 | 4 | `phase2.alias_relation_concurrency` | `concurrency.alias_relation` |
| 每章窗口章节上限 / 右重叠 | 20 / 2 | `phase0.max_chapters_per_window` / `right_overlap_chapters` | `import.phase0.max_chapters_per_window` / `.right_overlap_chapters` |
| 边界上下文字符数 | 2000 | `phase1c.boundary_context_chars` | `import.phase1c.boundary_context_chars` |
| Scene 上下文 Top-K | 人物 Top-6 / 非人物对象 Top-16 | 各 phase1a/1b context 常量 | `context.character_top_k` / `context.entity_top_k` |
| scene_fusion / scene_fusion_draft 单步 Scene 数 | ≤20 | catalog §1.5/§2.5 | `budget.scene_fusion.max_scenes` |
| world_convergence 决定卡 | ≤7 | catalog §4.2 | `budget.world_convergence.max_cards` |
| world_exploration 一跳缺口 | ≤3 | catalog §4.3 | `budget.world_exploration.max_gaps` |
| world_ask 回读来源 | ≤5 | catalog §4.9 | `budget.world_ask.max_sources` |
| map_atlas 规划页数 / 每批地点 | ≤20 页 / 每批 5 | catalog §4.11 | `budget.map_atlas.max_pages` / `.batch_locations` |

---

## 5. 去重与置信阈值(`dedup.*` / `alias.*`)

| 常量 | 默认值 | 来源 | 建议 policy.yml 键 |
|---|---|---|---|
| 融合候选对相似度门槛 | 0.84 | `entity_fusion.py`(fusion-suggestions) | `dedup.candidate_similarity` |
| 判同一相似度阈值 | 0.88 | `scene_entity_persistence.py:65` | `dedup.merge_similarity` |
| 确定性直判置信 | ≥0.98 直接 merge / keep_separate | `entity_fusion.py:1310-1314` | `dedup.deterministic_confidence` |
| phase1c 自动融合置信 | 0.92 | `phase1c.auto_merge_confidence`(deep_import_settings.py) | `dedup.phase1c_auto_merge` |
| 结构去重自动应用置信 | ≥0.96(且同 workflow) | `deep_import_dedup.py:60-66` | `dedup.structure_auto_confidence` |
| L1 合并偏置(激进/保守) | 默认激进(D18 不设显式拨杆) | 设计 §6.1 | `dedup.merge_bias` |
| L2 二判门槛 | 【待定】§13 只列键名, 未在代码定值 | 设计 §13 | `dedup.l2_threshold` |
| 别名附着置信 | 【待定】§13 只列键名 | 设计 §13 | `alias.attach_confidence` |
| RAG reranker unsupported 弃权 / topical 最低分 | 0.8 / 0.2 | `rag/reranker.py:22-30,245` | `rag.reranker.unsupported_threshold` / `.topical_min_score` |
| RAG reranker 开关 | 默认关 | `RERANKER_ENABLED` | `rag.reranker.enabled` |

---

## 6. 上下文编译预算(`context.*`)

| 常量 | 默认值 | 来源 | 建议 policy.yml 键 |
|---|---|---|---|
| 总 token 预算 | 4000 | `CompileOptions.budget_tokens`(contracts.py) | `context.budget_tokens` |
| RAG 检索上限 | 8 | `CompileOptions.top_k` | `context.top_k` |
| Scene 前序邻居 | 2(最大 4) | `CompileOptions.prior_neighbor_limit` | `context.prior_neighbor_limit` / `.prior_neighbor_max` |
| 分类预算 core_entities / normal_entities / characters / memory / foreshadowing / timeline / geo_relations / relationship_edges / plot_threads / rag_chunks | 8 / 8 / 6 / 10 / 5 / 8 / 10 / 12 / 8 / 8 | `contracts.py:418-429`(CONTEXT_BUDGET) | `context.budget.<category>` |
| tier 淘汰顺序 | P0 永不淘汰 → P4→P3 整段移除 → P2 逐条裁剪 → P1 前段摘要压缩 | `compiled_context.py:31-45,103-288` | `context.tiers`(固定, 不开放覆盖) |

> 【待定】`CONTEXT_BUDGET` 分类默认是进 policy.yml 还是 helper 内置常量(small-modules.md 待定)。

---

## 7. 审查 / 冲突 / 导入等其他上限

| 常量 | 默认值 | 来源 | 建议 policy.yml 键 |
|---|---|---|---|
| 独立语义审查分片上限 | 全书 ≤24 分片 | `semantic_review.py:35-37,252-269` | `review.max_shards` |
| 单分片字符预算 | 80000 | 同上 | `review.shard_char_limit` |
| P20 审计 violations 上限 | 20(合并去重后) | `p20_service.py`(P20SemanticAudit) | `review.p20_max_violations` |
| 冲突检查正文摘录 | 前 4000 字 | `writing_conflict_checks.scope` | `review.conflict_excerpt_chars` |
| story_outline 字段上限 | title ≤255 / outline_markdown ≤200000 / 三类列表各 ≤100 | `story_outline_schemas.py` | `budget.story_outline.*` |
| 总纲幂等键长度 | 8–128 | `story_outline_schemas.py` | `budget.idempotency_key_len` |
| 导入文件大小 / 类型 | ≤50MB; .txt/.epub/.html/.htm/.mobi/.azw3 | AGENTS.md / CLAUDE.md | `import.max_file_size` / `import.allowed_types` |
| 对象图片 | 6MiB / ≤4096×4096 / PNG·JPEG→WebP(D19 v1 砍) | AGENTS.md / 设计 D19 | `import.image.*`(v1 不落地) |
| alias_relation Scene/索引字符上限 | 3200 / 3600(回退 30) | `phase2.alias_relation_*` | `import.phase2.alias_relation_scene_char_limit` 等 |
| RAG embedding 维度 | 768 | `rag/models.py` | `rag.embedding_dim`(插件内置) |

---

## 8. 编排与守望(§13 policy 键)

| 键 | 默认值 | 来源 | 建议 policy.yml 键 |
|---|---|---|---|
| 编排脑模型 pin | deepseek-v4-flash + high effort | 设计 §4/§13 | `orchestrator.model` |
| 待确认积压通知阈值 | 【待定】§13 只列键名 | 设计 §13 | `watch.notify_threshold` |
| 低频深度巡检 | 默认关 | 设计 §11/§13 | `watch.deep_sweep` |
| ralph 修复环轮数上限 | 【待定】§13 只列键名 | 设计 §13 | `repair.max_rounds` |
| 去重激进度 | 默认激进(D18, 不设显式拨杆) | 设计 §6.1/§13 | `dedup.merge_bias` / `dedup.l2_threshold` |
| 降级条款(固定文本) | 1b 空语义进复核 / 2b 只降级不丢对象 / 1a 重叠整章 fallback | 设计 §13、catalog §1 | `degradation.*`(固定条款, 不开放覆盖) |

---

## 9. map_atlas 世界地图册(map atlas 批次, 2026-08-15, N28/N29)

| 常量 | 默认值 | 来源 | 建议 policy.yml 键 |
|---|---|---|---|
| map_atlas 规划页数 | ≤20 | 计划 §1.1/§5 规则 2 | `budget.map_atlas.max_pages` |
| map_atlas 每批地点 | 5 | 计划 §1.1/§2 | `budget.map_atlas.batch_locations` |
| map_atlas 最多核对已采用 location | ≤20 | 计划 §1.1/§2 | `budget.map_atlas.max_locations` |
| map_atlas_plan 规划 budgetTokens | 4000(旧引擎实际 12000, 见下注) | catalog §4.11 / 计划 §1.3 待确认项 3 | `llm.steps.map_atlas_plan.budget_tokens` |
| map_spatial_facts budgetTokens | 4000 | catalog §4.12 | `llm.steps.map_spatial_facts.budget_tokens` |
| map_spatial_facts 单地点/单批输入上限 | 8000 字 / 40000 字 | 计划 §2 | `budget.map_atlas.spatial_chars_per_location` / `.spatial_chars_per_batch` |
| map_spatial_facts 事实上限 | 每地点 ≤12 条 / 每批 ≤60 条 | 计划 §2 | `budget.map_atlas.spatial_facts_per_location` / `.spatial_facts_per_batch` |
| 地图图片单文件 / 尺寸 | ≤50MB; 16×16 ~ 8192×8192 | 计划 附录 A.3 | `import.map_atlas_image.max_file_size` / `.min_dim` / `.max_dim` |

**spatial facts 降级规则**(计划 §2 Phase 2):
- 单批失败 → 记 `degraded`, **降级不失败**(不阻断规划);
- 全批失败 → 记 `all_batches_failed`;
- RAG 失败 → 只减少证据, 不失败;
- 无地点 → `insufficient_sources`。

> **map_atlas_plan 规划预算默认口径**(计划 §1.3 待确认项 3): 默认 4000 tokens; 旧引擎实际使用
> 12000。若 20 页 schema 修复频繁失败, 下一轮裁定提升为 12000。本段不改变 §1/§2/§3 表中
> `map_atlas_plan`/`map_spatial_facts` 的温度/超时/max_tokens 行(已随本批次去生图改写)。

---

## 10. 待定汇总

1. 【待定】`watch.notify_threshold` / `repair.max_rounds` / `dedup.l2_threshold` / `alias.attach_confidence` 的具体默认数值(设计 §13 只列键名, 本 commit 代码未定义)——需在实现期补默认。
2. 【待定】`CONTEXT_BUDGET` 分类默认进 policy.yml 还是 helper 内置常量(small-modules.md 待定)。
3. 【待定】温度/超时/max_tokens 是否全部进 policy.yml; provider 级参数(temperature/top_p/max_tokens/timeout)应归 `.assistant/llm.yml`, workflow 级默认归 policy.yml——两层的键划分需定稿。
4. 【待定】`world_ask` 超时 env 常量精确名(catalog 记为 `_TIMEOUT_SECONDS`, 未列全名)。
5. 【待定】`scene_enrichment 并发 200` 与 `deep_import_settings.py` 的 phase2 并发键(20/25/12/6)口径不一致——本草案两者并列, 以 deep_import_settings 为项目可调默认、模块常量为代码兜底, 需裁定唯一权威。
6. 【待定】policy.yml 的 schema 版本号与校验规则(§13「版本化 + schema 校验」)在 M4 由哪个插件负责(倾向 store)。
