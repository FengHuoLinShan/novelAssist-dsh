# ai-writing-assist 能力图(截至 8c1516daf)

> 审计基准: 父仓库 `ai-writing-assist` HEAD `8c1516daf`("fix(writing): bind semantic review to
> confirmed context"), 审计日期 2026-08-31。父仓库只读(铁律 8), 本文档仅为重构参考。
>
> **文档定位**: 本文是父仓库能力的**自包含全景图**, 以父仓库为中心描述"它现在有什么"。
> 与《功能对照清单.md》的分工: 对照清单 §1–§5 是 5337fbcd3 旧快照的历史审计、§6 是与
> dsh 现状的**对照切片**; 本文是**当前 HEAD 的源系统侧事实**, 全量清单与裁定均以本文为准
> 覆盖旧快照数字。重构时先读本文建立能力全景, 再到对照清单 §6 查对应切片的差距。

## 0. 规模快照(与旧快照的漂移)

| 维度 | 5337fbcd3(旧台账 §1–§5) | 当前 HEAD 8c1516daf | 核实方式 |
|---|---|---|---|
| 业务模块 | 13 个目录 | **8 个 owner 模块**(settings/rag/context/outline/memory 五目录已物理删除, 非兼容壳) | `git ls-files backend/modules`; ADR-0015 |
| ORM 表 | 90 张 | **100 张** | `scripts/check_architecture_docs.py` 机器清单 |
| API 端点 | 357 个 | **412 个**(409 router + 3 main 内联) | AST 静态解析 |
| 任务 handler | ~30 | **37 个**(含 3 个退役 stub、4 个非 LLM) | `app/task_runtime.py` 注册表 |
| 前端一级路由 | 14 条 | **15 条**(其中 4 条为兼容重定向) | `frontend-console/router.js` routes 表 |
| ADR | — | **25 篇** | `docs/adr/` |
| 旧兼容挂载 | — | `/api/rag/*`、`/api/context/*`、`/api/settings/*` 已**退场删除**; 保留 `/api/outline/*` 与 `/api/novels/{id}/memories` 为 canonical 路径 | 39c3878f0 |

架构机器清单口径(`make docs-check`): `8 business modules, 100 ORM tables, 30 task handlers,
15 frontend routes, 25 ADR files`(handler 数 30 与注册表 37 的差异 = 3 退役 stub + 4 global
清理/确定性任务不计入业务口径)。

## 1. 系统总览

### 1.1 产品定位与双画像

- 定位: **NovelCraft, 结构化创作引擎**(非全自动正文生成)。核心差异 = 两条路径都不把模型
  刚输出的内容当无条件真相: 作者路径区分候选与正式资产, AI 产出只进 preview/suggestion/
  candidate, 作者显式采用才落正史; RP 路径只让代码级选中的历史进入上下文
  (`README.md`、`docs/00_整体设计.md`)。
- 双画像(`docs/product/user-personas.md`):
  - **画像 A 长篇作者**: 要世界长期记忆、来源证据、版本回滚、AI 不越权决定正史。
  - **画像 B RP 用户**: 自然语言开场、分支探索、回顾、低摩擦重抽; 第一版**不读**作者
    World/Outline/RAG/writing/memory, 不支持原作导入/按章分叉/公开分享。
- 账号体系: 公开浏览器账号(邮箱 OTP + Authing 微信互斥主身份, ADR-0010); 线上
  novel.zhh.se, 用户自连 API Key。**dsh 已裁定单用户本机替代(D11), 此层不迁移**。
- "明确不做"(`docs/00_整体设计.md`): 多 Agent 协同写正文、未授权自动合并、
  Neo4j/GraphRAG、项目共享/协作权限、商业功能。

### 1.2 架构分层(8 模块)

```
事实层     project, world(含 story/continuity 记忆事件账本)
结构层     story(= outline_state 总纲/P20/Scene + continuity 记忆)
辅助层     imports(导入流水线), evidence(= indexing RAG + compilation 上下文),
           writing(正文)
层外       account(账户/会话/Key), interaction(RP 旅程)
```

- 跨模块只允许依赖对方 `contracts.py`/`facade.py`/DI port(父仓 `AGENTS.md:54-58`);
  实测环依赖(story↔world、project↔account)靠延迟 import + 薄 facade 解环。
- DI 组合根 `backend/app/bootstrap.py:69-110`, key 仍保留旧域名(rag.*/outline.*/context.*
  /memory.*)——ADR-0015 裁定"不改 DI key/表名/task type/wire"。

### 1.3 技术栈与外部依赖

| 依赖 | 用途 |
|---|---|
| Python 3.12 + FastAPI + SQLAlchemy 2.0 + Pydantic v2 | 后端 |
| PostgreSQL 17 + pgvector(Vector 768, HNSW) + pg_trgm | 全部 100 张表; `rag_chunks`/`core_entities` 向量列; `search_text` 生成列 |
| **无 Redis/Celery** | 任务队列表 `async_tasks` + `FOR UPDATE SKIP LOCKED`(`backend/infrastructure/tasks/__init__.py`) |
| MinIO(S3 兼容, 私有双桶) | 地图册图片(`MAP_ATLAS_S3_*`, PNG ≤50MB/8192²) + 对象图片(`WORLD_OBJECT_S3_BUCKET`, WebP 多变体); 32GiB 单盘硬上限(ADR-0014) |
| BGE 本地嵌入 | `BAAI/bge-base-zh-v1.5` ONNX int8 独立子进程, 批队列背压 |
| Vue 3 SFC 渐进迁移(已完成, ADR-0009) | 原生 JS 骨架(router/state/api)+ Vue shell + 按路由懒加载 island |

## 2. 能力域总图(一页导航)

| # | 能力域 | owner 模块 | API 前缀(端点数) | 核心数据 | 对照清单切片 |
|---|---|---|---|---|---|
| 1 | 账户与身份 | account | `/api/auth`、`/api/account`(28) | accounts/web_sessions/凭据 9 表 | §6.13(dsh 去账号) |
| 2 | 项目与工作区 | project | `/api/projects`(25) | projects/偏好/作者任务 4 表 | §6.13 |
| 3 | LLM 连接与路由 | account+project | settings 端点 | account_llm_credentials/global_llm_defaults | §6.23.6 |
| 4 | 文件导入与深度导入 | imports | `/api/imports`(9) | import_records/imported_chapters/import_workflow_runs 3 表 | §6.6、§6.14 |
| 5 | 世界事实底座 | world | `/api/world` 实体部分(≈60) | core_entities/relations/aliases/revisions 等 core+character 7 表 | §6.10 |
| 6 | 世界正典权威(Phase 0) | world | `/api/world/canon*`(5) | world_assertions/canon_revisions/canon_heads 4 表 | §6.17 |
| 7 | 世界书与生成中心 | world | `/api/world/bible*`、`/generation-center`(≈55) | bible 20 张表 | §6.17 |
| 8 | 知识边界与读者揭示 | world | knowledge-tags/reveal(3+投入各域) | character_knowledge/tags/policies 7 表 | §6.12.7 |
| 9 | 故事结构(总纲/P20/Scene) | story | `/api/outline`(55)+`/api/story`(31) | outline_state 11 表 | §6.18 |
| 10 | 记忆与连续性 | story/continuity | `/api/novels/{id}/memories`(11) | memory 5 表(事件账本) | §6.18.4 |
| 11 | 证据域(RAG+上下文) | evidence | `/api/evidence/*`(30) | indexing 3 表 + compilation 7 表 | §6.11、§6.12 |
| 12 | 正文写作与审查 | writing | `/api/writing`(23) | writing_drafts/conflict 3 表 | §6.15–6.16 |
| 13 | Story 派生资产 | story | `/api/story`(人物卡/剧本) | story 4 表 | §6.18 |
| 14 | AI 地图册 | world | `/api/world/map-atlas`(22) | map_atlas 4 表 + S3 | §6.19 |
| 15 | RP 互动旅程 | interaction | `/api/interactions`(32) | interaction 7 表 | §6.20(dsh 已延期) |
| 16 | 长任务与恢复 | infrastructure/tasks | `/api/tasks`(4)+operation receipts | async_tasks 1 表 | §6.9 |
| 17 | 前端工作台 | frontend-console | 15 路由(4 兼容) | — | §6.22 |

## 3. 能力域详述

### 3.1 账户与身份(account)

- 能力: 邮箱 OTP 注册/登录/敏感操作再认证(`email_login_challenges`, code 只存 digest);
  Authing 微信 OIDC 扫码(互斥主身份); 单会话 cookie(token/CSRF 双 digest、idle+absolute
  双过期、可 revoke); 30 天延期删除(`pending_deletion`+purge_after); 安全事件账本; 政策
  同意版本; 法务页(`/legal/*` 公开 HTML)。
- 鉴权三模式(`core/config.py:186-201`): `local / closed_test / public` 互斥, 启动强校验;
  public 下禁 DEBUG、强制 HTTPS、关 docs。
- owner 门禁: `AccountAuthMiddleware`(仅 public)+ `facade.current_account_id()`;
  跨 owner 统一 404 掩蔽(`project/services.py:570-597`)。
- novel_id 门禁: `project/facade.py:169-237` 四件套——`require_active_project`(共享行锁)、
  `require_interaction_project`、`require_any_active_project`、
  `require_active_project_exclusive`(短独占锁, 绝不跨 LLM I/O 持有)。novel_id 统一经
  `core/api_params.py` UUID 校验。
- CSRF 三层: 应用级 XHR 头校验(`main.py:472-481`) + 路由级 `require_xhr_request` +
  public 模式 Origin+HMAC token。速率限制: 进程内令牌桶(`app/http_rate_limit.py`)。
- **dsh 参考**: 去账号是已裁定替代; 但 novel_id 门禁语义(行锁/独占锁/404 掩蔽)对应 dsh
  的 vault 绑定 fail-closed, 语义应保留。

### 3.2 项目与工作区(project)

- 能力: 多项目 CRUD + 软删除回收站(恢复/批量永久删除原子操作); `project_kind` 区分
  author/interaction 两类工作区; 项目设置(题材/基调/阶段/目标字数/揭示策略进入导入、总纲
  与 Evidence context); 项目/账户两级作者偏好(日目标/字体/专注模式, 单字段重置白名单);
  作者轻量待办(author_tasks 五 scope); 项目主页聚合读模型(workspace-summary)与续作指针;
  智能去重扫描(smart_dedup, LLM 融合判定 + 工作台裁决 supersede)。
- 数据: `projects`(settings JSON、deleted_at)、`project_author_preferences`、
  `project_author_tasks`、`smart_dedup_workbench_decisions`(部分唯一索引保单条有效裁决)。
- **dsh 参考**: 多书生命周期/回收站/元数据生效面差距见对照清单 §6.13; dsh 的
  `book.yml`/`policy.yml` 对应此处, 但"文件存在≠设置生效"。

### 3.3 LLM 连接与路由(account+project)

- Provider: 唯一 transport `OpenAIProvider`(AsyncOpenAI 兼容); **16 个 provider 模板**
  (deepseek/kimi/qwen-dashscope/zhipu/baichuan/minimax/hunyuan/qianfan/stepfun/yi/
  mimo/openrouter/siliconflow/volcengine-ark/aihubmix/openai-compatible,
  `infrastructure/llm/profiles.py:66-283`); 账号级白名单 {deepseek, kimi}(Kimi 需 env 开关)。
- Key: Fernet envelope 加密存 `account_llm_credentials`(owner+provider 唯一, 防重放指纹);
  **接受 Key 前必须通过最小真实调用验证**(LLMHealthChecker 30s); 余额查询(DeepSeek/Kimi)。
- Active route: `global_llm_defaults` head 选择当前 provider; 运行时解析
  `resolve_account_llm_runtime_profile`(身份字段不跨连接覆盖, 仅调优字段叠加)。
- Secret-free 执行快照: `build_project_llm_execution_snapshot` 冻结 provider/model/参数/
  hash 不含 Key(`project/llm_runtime.py:90-133`); 恢复时版本/novel_id/漂移全 fail-closed,
  Key 取轮换后当前值; 任务提交时快照写入 `task.meta`。
- 出网门禁: public 模式强制 HTTPS + 拒私有地址 + 未配代理时 hostname 必须属内置 provider
  (`infrastructure/llm/egress.py:37-139`)。
- 图像: 独立图像供应商连接(gpt-image-2), `image_runtime.py`。
- **dsh 参考**: DSH 宿主已拥有 credentials/settings/route; dsh 不再建 provider 注册表,
  直接接宿主 exact-route(§6.23.6)。

### 3.4 文件导入与深度导入(imports)

- 基础导入: 浏览器 multipart 上传(≤50MiB), 白名单 `.txt/.epub/.html/.htm/.mobi/.azw3`
  (mobi/azw3 锁定依赖下未证实可用); done/failed 历史保留。
- 深度导入(六段流水线, `manual_resume` 恢复): Phase0 确定性规划 → 1a 切分(+anchor repair/
  gap recovery) → 1b 深化 → 1c 融合 → Phase2 对象抽取(2a 实体/2b 别名关系) → Phase3
  剧情结构。**每次新 run 显式范围授权并持久化 run-local snapshot**; resume 复用原 scope;
  abandon 回滚 workflow 资产。规则明确可回滚的结果自动采用, 冲突/低置信进待处理。
- 三个 stage 可独立提交(scenes/world-objects/plot-structure), 也服务手写正文。
- 数据: `import_workflow_runs`(owner_task_id/owner_attempt/owner_lease_id fencing、
  generation 代次、每项目至多一个活动 run 部分唯一索引)。
- 上下文快照: 每次真实 LLM 调用前持久化 context snapshot(审计记录), 紧凑元数据长期保留、
  rendered_context 30 天/200 条先到先清(`workflows/ai-import-persistent-context-snapshot.md`)。
- **dsh 参考**: dsh 已有六阶段 durable workflow + ApprovalGate; 缺用户可达的
  list/status/resume/abandon(§6.6/§6.9)。

### 3.5 世界事实底座(world core)

- CoreEntity 统一实体: entity_type(含作者自定义 1-64 字符, ADR-0005 可逆 Profile 迁移)/
  name/summary/public_info/**hidden_truth**/importance/reveal_level(author_only→
  fully_known)/embedding(768)/search_text(pg_trgm)/pinyin/image_version。
- 人物档案(characters 1:1 扩展): desire/fear/secret/weakness/current_goal/current_emotion/
  behavior_rules; **人物不再是独立模块**(character-module-merge-to-world ADR)。
- 关系(entity_relations): relation_kind 七类 Check(state/social/spatial/causal/temporal/
  epistemic/intentional), status candidate/canonical/deprecated, review_meta 审计。
- 别名: 独立审查队列 + 批量裁决(review-batch wire); 未知旧关系类型不猜 `state`(语义保真)。
- 事件(events): timeline_order、location 关联。
- 版本: `entity_revisions` 完整快照(ai_import/manual_edit/rollback/batch_update)+
  `text_archive` 长文本归档; 回滚端点两个(rollback/rollback-by-revision)。
- 融合: LLM 实体融合建议(不改实体, 作者采用才生效); merge/resolve-as-alias/promote。
- 审查工作台: 对象/别名/关系三队列 + 全部; 单项决定收进右侧面板(取消回队列保留
  fingerprint 草稿); merge/reuse/ignore 与批量动作保留确认。
- **dsh 参考**: 身份合流/关系生命周期是 P1 缺口(§6.10.4); 对象图片 v1 不迁移(D19/ADR-0016)。

### 3.6 世界正典权威 Canon(ADR-0017, Phase 0)

- 每项目一个空 C0 + CAS head(`world_canon_heads`) + 追加式不可变 `CanonRevision`
  (`world_canon_revisions`: novel+version 唯一、decision digest、父修订复合 FK)。
- 原子事实断言 `world_assertions`(regime='objective_world.v1'、novel+content_digest 唯一
  幂等; **当前不准入断言**)。
- **唯一 Admit 事务**准入(canon/admissions/preview→admissions→revert); authorizer 只能是
  项目 owner 账户(AI/worker 不能授权); family cutover 单向(v1 只允许
  formal-disabled→canon-owned); 所有 formal family 当前仍 `formal-disabled`。
- **dsh 参考**: Phase 0 内核是"确认裁定", Phase 1+ cutover 是延期项, 重构不得把
  formal family 当作既有能力。

### 3.7 世界书与生成中心(worldbuilding)

- World Bible: canonical 页面(novel+page_key 唯一、sections_json)与**独立服务器工作稿**
  (单活动草稿); 发布影响预演(publish-impact); 不可变 revision + 恢复为草稿; 页面模板
  (含不可变版本); 自定义类别; **页面不是事实源**(只组织叙述)。
- 世界观简介: LLM 派生不可变 synopsis revision + head(钉住/自动刷新授权/stale)。
- 上下文投影: `world_bible_page_projections` 缓存 + stale 标记 + 确定性刷新任务。
- 世界书目录导入(ADR-0016): 受限文本目录(.md/.txt/.json/.yaml, 单文件 2MiB/总量 25MiB/
  2000 文件), 预览→apply; **外部内容永不成为可执行配置**; 校验政策须作者激活。
- World Validation: 确定性+语义校验 run(targeted/full, verdict/gate 全 Check, 每项目至多
  一个活动 full run); **fail/author-required/stale 回执不可绕过发布门禁**。
- 生成中心(ADR-0007, OwnerAiDrawer 承接): 四模式——共创 chat(只读)/收束 convergence
  (map-reduce)/探索 exploration(≤3 个一跳缺口)/检修 semantic-inspection; 三类 target
  (core_entity/world_bible_page/world_bible_new_page), 页面生成是**完整提案非 patch**;
  页面建议只能落工作稿; 决策编译、质量审查(.quality_review)、作者决定审计
  (.author_decision_audit); 检查点 `world_design_checkpoint.v1` 与采纳包
  `world_adoption_package.v1`(保存不调模型); 自定义 Prompt 模板(不可变版本+validator);
  视觉简报(visual brief); 交接 markdown 导出。
- 统一待处理: `creation_suggestion_queue`(跨模块创设建议)与 `conflict_check_queue`
  (世界冲突/叙事风险)。
- 问世界(ask-world): 基于可见证据的问答, 带引用可复核/引用重开+新鲜度, 无证据时模型零
  调用(no_answer); 作者显式保存才建待处理建议。
- 知识图谱(只读)。
- **dsh 参考**: 内容步/schema/文件真相可复用; 世界书读写工作台、多轮来源 receipt、历史
  恢复、采纳包、validation/health 均未对齐(§6.17)。

### 3.8 知识边界与读者揭示(world)

- `CharacterKnowledge`: 人物×目标稀疏 checkpoint, knowledge_level 七值(unknown/rumor/
  partial/full/false_belief/restricted/misunderstood, DECISIONS.md 2026-07-04), 按章截止。
- 知识域标签: knowledge_tags + character/asset 授权 + author_locked(事件派生标签需
  provenance+author_locked 才能自动回滚) + 派生排除表。
- 可见性策略(`knowledge_visibility_policies`)与读者揭示点(`reader_reveal_policies`,
  reveal_chapter_index/public_baseline); `core_entities.reveal_level` 与
  `rag_chunks.visibility` 分层硬过滤(ADR-0004); 项目 `default_reveal_policy`。
- Scene POV: 结构化有限视角生成切换(`writing/pov_generation.py`); hidden guard 在候选
  文本级(未按章取 checkpoint、失败不直接阻断采用——已知缺口)。
- **dsh 参考**: dsh 无任何人物知识资产/投影/消费者, 不能由字段名声称防剧透(§6.12.7)。

### 3.9 故事结构(story/outline_state)

- 总纲: `story_outline_revisions` 不可变修订(novel+version 唯一、idempotency_key 唯一、
  request/content_hash、base/restored_from 链)+ head 指针; AI 生成走 strict preview
  (story_outline prompt + 三审计), **显式 apply 才写 `source=ai_generated` revision**;
  可恢复的预览编辑路由页(本地恢复提示/版本冲突 rebase)。
- P20 三层: 剧情线(plot_threads: visible_goal vs hidden_truth、reader/author_known_state)/
  篇章纲(outline_arcs)/Scene 卡(scenes); 当前层生成(三个 prompt + 并行三审计
  evidence/external-canon/world-rule + 最多 2 次语义修订, 共享 1800s 预算); 可编辑
  preview(含 no_change/needs_author_decision), fingerprint+savepoint 原子 apply;
  **PlotThread movement 确定性投影到伏笔/揭示两张表**(ADR-0008)。
- 信息推进: 伏笔计划(foreshadowing: seed/reinforce/payoff)与揭示计划(reveals: stages)。
- Scene 工作台: 场景表(热区/健康度过滤 needs_organize 等)、Scene↔章节映射
  (scene_chapter_links/chunks)、重排/拆分(断章)、**AI 融合建议**(fusion preview 任务,
  逐项处理/忽略; 持久化 `scene_fusion_suggestions`)、多选批量操作、移入历史。
- 结构生成: analyze(只读 markdown)/generate/apply, 需 context_confirmation_id。
- Scene→正文: `scene_spans` 派生读模型(anchor_hash)、按可见游标的防剧透摘要
  (`scene_summary_checkpoints`, 游标 4 元组唯一)。
- 大纲 AI 跟随当前层级, **P20 不进生成中心**(ADR-0008)。
- **dsh 参考**: 数据词汇可表达; 作者行为链(preview→采用→投影)未成立; dsh 的
  story map/章节档案是新增读面, 不得冒充统一叙事时间线(§6.18.6)。

### 3.10 记忆与连续性(story/continuity)

- **事件账本是真相源**: `memory_events` 每章/每 Scene 变化事件((novel,chapter,sequence)
  与 (novel,scene,scene_sequence) 双唯一, snapshot_before/after), **重放可得任意章全景**。
- 物化: `memory_snapshots`(每 10 章全量, current/stale) + `memory_scene_checkpoints`
  (分维度轻量状态, is_current 部分唯一 + supersedes_id 软链) + `memory_scene_snapshots`
  (stage0/周期/章末稀疏全量) + `delta_log` 旁路。
- 行为: Scene 锚定事件按业务顺序重放; **Scene 重跑替换该段并失效后续系统 checkpoint/
  snapshot**; 普通正文发布只快照已有事件(不从新正文补事件); rebuild 从修正点重建;
  scene-checkpoints ensure/rebuild/repair; panorama 章节世界全景读面。
- **dsh 参考**: dsh 的 `memory/events.jsonl` 有原语无生产 writer/reader; 按故事顺序投影
  而非 created_at 是关键语义(§6.18.4)。

### 3.11 证据域(evidence = indexing + compilation)

- **indexing(RAG)**: `rag_chunks`(source_type/content_mode canonical|working/章节字符
  offset/visibility 四级/embedding_status/index_version); 混合检索(pgvector + pg_trgm);
  embedding 本地 BGE(批队列背压, query/document 分离双队列); 章节新鲜度
  `rag_index_state`(requested vs indexed hash, task fencing); rebuild 按章节范围/
  retry-embeddings/prewarm; 实体出场派生索引(`rag_entity_appearances`, 可重建);
  可选 reranker(`rag.reranker`, RERANKER_ENABLED 默认关, 高置信 unsupported 返回空)。
- **compilation(上下文)**: **作者确认制**——`context_confirmations`(确认即门禁: action/
  task/scope/context_mode/selected/excluded/result_refs/stale_reasons)+
  `context_confirmation_asset_refs` 精确失效索引; `context_snapshots` 每次 AI 调用审计
  快照(workflow/phase/prompt_hash/model/rendered_context 带 TTL, 三态 running/succeeded/
  failed, stale_running 120 分钟转 failed); evidence_links(字段→原文出处, TargetRef+
  claim_path); retrieval_traces(隐私安全诊断); activation profiles(确定性版本化激活规则,
  修订不可变); scene lens(Scene 安全 POV 认知 + world-state checkpoint); compile_with_tiers
  产出可审查 CompiledContext IR; render Markdown; evidence grep/search/read/inspect/trace;
  快照维护(默认 dry-run)。
- 消费: 所有 AI 任务的强制前置(context_confirmation_id); Evidence/Writing 消费 panorama/
  Scene lens; 写作侧 409 stale 保护。
- **dsh 参考**: dsh 有 L0/L1/L2 搜索原语; confirmation/snapshot/trace 体系与"证据可供
  资产生成信任"的差距见 §6.12.5; 快照生命周期两份 workflow 文档写于 context 独立期,
  owner 现为 evidence/compilation。

### 3.12 正文写作与审查(writing)

- 版本事实源(`writing_drafts`): novel+chapter+version 唯一、content_hash、status
  draft/published/candidate/canonical/deprecated; 四种写入模式(发布/更新/显式留版
  checkpoint/放弃 discard 返回基线); **published 不可变 copy-on-write**; deprecated 不重排
  版本号; autosave 合并标脏 working 索引; 删除单版本至少留 1; 整章软废弃。
- AI 生成: candidate 不入工作稿; 显式 adopt 为工作稿; 单角色 POV 变体; provenance +
  conflict snapshot 归档。
- 独立语义审查: 冻结正文 + 原 confirmation 编译上下文(`writing.semantic_review.chunk_N`),
  findings 驱动**定向返修**(targeted_revision 生成新 candidate supersedes 原稿, 不覆盖);
  HEAD 提交即"bind semantic review to confirmed context"。
- 冲突检查: Scene 写作冲突(范围/含候选可选), AI 软复核 + 单条修复建议(同步/任务化两
  种), items 状态 open/resolved/ignored/later; **冲突检查不自动改文**。
- 发布链: 原位提升 published + 入队 `publish_chapter`(RAG 索引 + memory 快照, 非 LLM,
  restart_origin)。
- 前端: 3s 自动保存、本地草稿备份(localStorage, 备份不可用徽章)、版本对比/恢复、409
  expected_version 冲突保护、专注模式、窄屏速记模式、导出当前显示章 .txt(无整书/带批注
  docx)。
- **dsh 参考**: 高频单章闭环 dsh 已成立(rc.8); 自动保存/checkpoint/discard、正式发布、
  POV、来源审计差距见 §6.15–6.16。

### 3.13 Story 派生资产(story)

- 人物时点卡: `story_character_cards` head(novel+scene+character 唯一, current_version,
  stale/stale_reason)+ 不可变 revisions(content_hash、context_snapshot_id 溯源);
  preview_only 生成任务, 作者采用后写入。
- Scene 剧本: 多文件槽(novel+scene+file_key 唯一), **current 与 adopted 双指针分离**
  (采纳/取消采纳/归档修订); 生成/保存/本地备份 + 离开确认。
- 反应推演 proposals(带 warnings); Scene 模拟推演(simulate); 一键链(card→reaction→
  script)。
- 原则: Story 层不写回 World/Memory/Writing(adopted-only Writing read seam)。
- **dsh 参考**: dsh 无此层; 深导入 Phase 1c 的 Scene 融合决定不生效问题见 §6.18.5。

### 3.14 AI 地图册(world/map_atlas, ADR-0012)

- **旧动态地图(六边形/Map Fact/`/api/world/maps*`)已破坏性删除, 无兼容端点**(取代
  ADR-0003)。
- 工作流: author-full 已确认资料→空间事实/层级计划(`world.map_atlas.plan.structured`,
  ≤20 页层级计划)→**可选 Prompt 审查**(prompt_review 阶段逐页编辑, 站内/站外生成选择)
  →生图(固定 `gpt-image-2`, 私有 S3 不可变 attempt key)→独立候选采用(candidate/adopted/
  rejected/deprecated; 采用只改画廊, 不写回 World/正文事实)。
- 恢复: manual_resume×20; 停止(生成完当前页)/暂停检查/继续/重试; 费用未知确认重试
  (`retry_requires_confirmation`); 每次编辑新建 page(derived_from 链); 参考图 ≤7 +
  PNG 蒙版; 上传地图替代生成。
- 跨 run 稳定层级节点(`map_atlas_nodes`: novel+semantic_key 唯一, provisional/adopted);
  标注点(位置 0~1 Check);"为何这样画"证据区(直接支持/AI 补全/冲突/来源清单)。
- 删除竞态: 项目 share/exclusive lock + 两个 global 清理任务(S3 前缀幂等清理)。
- **dsh 参考**: dsh 的 Map Atlas 已有安全外部交接主链; ADR-0020 确认不做站内生图(§6.19)。

### 3.15 RP 互动旅程(interaction)

- 独立隐藏 interaction 项目(每旅程 1:1); 不读不写作者正史。
- 消息树: 不可变节点(parent 自引用分支)+ 代码级分支选择(`interaction_branch_selections`)
  + **selection epoch 乐观纪元**(attempt 带 started_selection_epoch 冲突检测)。
- 生成: SSE 流式(`interaction-story-v2`, offset 续流/reset/chunk/status, 断线 1s 重试至
  60s)、停止/重试/继续/**保留部分结果 keepPartial**、重新生成/编辑用户消息; attempt 8 态
  + owner+idempotency_key 唯一 + llm_execution_snapshot; 尾块 framer。
- 回顾: 分段摘要(`interaction_summary_segments`, journey+path_hash 唯一)+ 不可变总览
  修订(7 段结构); **看海(see_sea)自适应模式**(确认弹窗+偏好记忆+断连自动关闭)。
- 生命周期: 归档/恢复/删除/重命名/导出(md 完整 / txt 纯故事); 心跳/离开上报;
  composer 草稿本地暂存(100k 上限)。
- **dsh 参考**: D23 已确认延后至 R6 后; 不为主线预建实现(§6.20)。

### 3.16 长任务、进度与恢复(infrastructure/tasks)

- 队列: PostgreSQL `async_tasks` + SKIP LOCKED; lease fence(claim 生成 lease_id,
  heartbeat/finalize/checkpoint 全部条件 UPDATE, rowcount=0 即租约失效且业务写回滚);
  handler session 包装(commit 前过 fence + commit guard)。
- **Keyed coalescing**(ADR-0011): coalescing_key = SHA-256(canonical JSON), DB partial
  unique 保证同 key 至多一个 pending + 一个 running; 两种模式 reuse_active/
  one_pending_follower; pg_advisory_xact_lock 串行化; 固定 4 类 scope(imports 五工作流/
  page_projection/chapter_index/entity_activity)。
- 恢复策略四种: auto_requeue(退避 1,2,4,8,16,30s)/manual_resume(标 interrupted,
  用户显式继续, 如深导入)/restart_origin(如 publish_chapter)/never_retry; stale 心跳
  扫描(30s 心跳/120s gap); 启动时 4 个领域 owner reconciler, 恢复失败 fail-closed。
- **Operation receipts**(ADR-0013): 作者 AI 长任务由前端生成 UUID operation_id +
  submission_fingerprint, 服务端同指纹复用原任务(含终态)、异请求 409; **不建全局任务
  中心/跨设备锁**; 只在原页恢复(localStorage receipt + 1.5s 轮询)。
- 对外 API 仅 4 个(POST/GET/cancel/retry); 通用提交需 generic_submit_schema(当前无
  handler 注册)。
- **dsh 参考**: ADR-0023"显式长 job 由 Node 托管"尚未接到创作工具; 作者不能离开/重开/
  继续/放弃是当前差距(§6.9)。

### 3.17 前端工作台(frontend-console)

- 栈: 原生 JS 骨架(router.js hash 双格式 + state.js Proxy + api.js/apiContracts.js 约
  180 条契约) + Vue shell + 按路由懒加载 island; 禁 v-html、无 Vue Router/Pinia。
- 15 条路由(§5 全表): home(双入口)/project/journeys/interaction/today→writing 兼容/
  world(bible/objects/review/relations/aliases)/rag(search/status)/outline(story-outline/
  arcs/threads/scenes)/scene 兼容/writing(?home=1 首页模式)/map/generate 兼容(→OwnerAi
  抽屉)/llm 兼容/settings/project-settings。
- 横切: 空/载/错/冲突态分层(temporary 可重试/inaccessible 401→account/4xx/stale 代次
  丢弃); "失败保留旧数据+警告条"; keep-alive 全删, 离开即卸载(ADR-0009 附录 A, 显式
  session 重建); 写作本地草稿备份; 窄屏 760/1100 断点 + 移动底栏; 可访问性(aria-live/
  焦点捕获恢复/Escape 层级/reduced-motion); 三主题 + RP 独立纯白壳; CSP; errorLogger
  错误编号化(50 条/脱敏/keepalive 上报); 账号失效事件强制安全刷新; 浏览器存储按账号
  scope。
- **dsh 参考**: dsh 已从 agent-only 进入 agent-first 主链(14 loopback 端点 + rc.8
  conversation.view); World/Story operation、统一返回目标、390px 行为未闭合(§6.22)。

## 4. API 端点全量清单(412 个)

挂载入口 `backend/app/main.py:748-774`。按模块: system 3 + debug 3(仅非 public) +
tasks 4 + account 28 + imports 9 + interaction 32 + project 25 + world 158 +
evidence 30 + story 97 + writing 23。

### 4.1 system/debug/tasks(10)
- `GET /api/health`(DB 探活 degraded 503)、`GET /api/health/llm`(不读凭据)、`GET /`(模块清单)。
- debug(仅非 public): frontend-errors POST/GET/DELETE。
- `POST /api/tasks`、`GET /api/tasks/{id}`、`POST .../cancel`、`POST .../retry`。

### 4.2 account(28)
- `/api/auth`: config; email/request-code、email/verify; me; logout; reauth/email/*×2;
  wechat/start、wechat/callback、reauth/wechat/start。
- `/api/account`: deletion GET/POST/DELETE。
- `/api/account/settings`: llm-connections GET; image-connection GET/PUT/DELETE;
  llm-connections/{provider} PUT/DELETE + activate POST; llm-balances GET;
  llm-defaults GET/PUT; author-preferences GET/PUT; refresh POST(调试);
  projects-using-defaults GET(project 挂入)。
- `/legal/terms`、`/legal/privacy`(公开 HTML, 无 /api 前缀)。

### 4.3 imports(9)
upload POST; 列表/详情 GET; deep POST(独占锁); stages/scenes、stages/world-objects、
stages/plot-structure POST; deep/resume、deep/abandon POST。

### 4.4 interaction(32)
journeys CRUD + messages + path-index + tree + attempts(events SSE/stop/keep/continue/
retry)+ nodes(continue-from-here/regenerate/edit/select/branches)+ modes PATCH +
heartbeat/leave + preferences(+see-sea-notice) + title + overview(GET/PUT/retry) +
archive/restore + export + 详情。

### 4.5 project(25)
CRUD; recycle-bin GET + permanent-delete POST(原子); llm/provider-templates GET;
llm-settings GET/PUT + effective-llm-settings + effective-author-preferences +
field/{name} DELETE(D4 白名单); smart-dedup/scan|apply POST; workspace-summary GET;
author-tasks GET/POST/PATCH; restore POST; permanent DELETE; author-preferences
GET/PUT/DELETE(field)。

### 4.6 world(158 = /api/world 136 + map-atlas 22)
- **canon(5)**: head GET; revisions/{id} GET; admissions/preview、admissions POST;
  revert POST。
- **图谱(1)**: knowledge-graph GET。
- **生成中心/问世界(9)**: chat、convergence、exploration、semantic-inspection POST;
  ask-world POST + citations/open + suggestions; suggestions POST + suggestions/task POST。
- **Prompt 模板(9)**: generation-prompt-templates GET/POST + validate/preview POST +
  {id} GET/PUT/DELETE + revisions GET + copy POST。
- **profiles(4)**: GET; {id} GET/PUT; migrate-generic POST。
- **bible(45)**: pages GET/POST + {id} GET/PATCH + revisions GET + revisions/{v}/
  restore-draft POST + refresh-projection/organize POST; categories GET/POST + {id} PATCH;
  drafts GET/POST + {id} GET/PATCH/DELETE + publish POST + publish-impact GET +
  apply-template POST; imports/preview POST + {id} GET + apply POST; validation-policy
  GET + activate POST; validation-runs POST/GET + latest + {id} GET + {id}/accept-warnings
  POST; synopsis GET + refresh POST + auto-refresh PATCH + revisions GET + {id}/restore
  POST + unpin POST; templates GET; page-templates GET/POST + {id} PATCH + revisions GET
  + revisions/{v}/restore-draft POST。
- **检查点/采纳包(7)**: core-checkpoints、design-checkpoints POST;
  adoption-packages POST + {id} GET + preview GET + apply POST。
- **建议/冲突(10)**: suggestions GET + {id}/confirm|edit-confirm|merge|resolve-as-alias|
  reject POST + apply-page-draft POST; conflicts GET + {id}/resolve POST。
- **角色知识标签(3)**: characters/{id}/knowledge-tags/{tag}/exclude POST/DELETE + lock POST。
- **实体核心(21)**: entity-types、review-type-catalog GET; entities GET/POST + {id}
  GET/PUT/DELETE + image PUT/GET + merge/resolve-as-alias/promote POST + relations/
  revisions GET + rollback/rollback-by-revision POST; alias-relations/extract POST;
  fusion-suggestions POST + apply POST; _test/.../text-archive POST(测试种子)。
- **事件(5)**、**关系(8)**(review-groups/review-batch)、**人物(9)**(characters CRUD +
  knowledge GET/POST + {id} PUT/DELETE)、**批次/别名(8)**(entity-batches、aliases
  review-groups/review-batch)。
- **map-atlas(22)**: runs POST + latest/{id} GET + stop/resume POST + results GET +
  confirm-prompts POST; atlas GET; pages/history GET + {id}/prompt GET/PATCH + upload
  POST + adopt/reject/archive/restore/retry/regenerate/edit POST + image GET;
  nodes/{id} PATCH; annotations/{id} PATCH。

### 4.7 evidence(30)
- indexing(8): chunks POST/GET; retrieve POST; metrics GET; prewarm/rebuild/retry-
  embeddings POST; chunks/split POST(预览不落库)。
- compilation(22): scene-lens POST; compile/render POST; confirm POST; evidence-health
  GET; retrieval-traces GET; evidence grep/search/read/inspect/trace POST;
  activation-profiles GET/POST + {id} PATCH + publish POST + revisions GET + {v}/
  restore-draft POST; activation-preview GET(legacy)/POST(typed);
  snapshots GET + maintenance POST(dry-run 默认) + {id} GET。

### 4.8 story(97 = /api/story 31 + /api/outline 55 + memories 11)
- /api/story: character-cards CRUD + revisions + restore + archive; script-files +
  revisions + adopt/unadopt/archive; scenes/{id}/story-context; tasks/character-card|
  reaction|script|one-click POST(202); scenes/{id}/character-cards(+generate)、scripts
  (+generate)、reactions/generate、simulate POST。
- /api/outline: story-outline GET + revisions POST/GET + {id} GET/apply POST + generate
  POST + generate/apply POST; threads CRUD; arcs CRUD; scene-workbench GET + review/
  source-mapping/review POST + mapping PATCH + chapters/{i}/scenes POST(挂载/新建)+
  merge|split|fusion preview|apply POST + fusion-suggestions GET + dismiss POST +
  replacement-suggestions/apply POST; scenes CRUD + ordered/by-chapter GET + reorder/
  split POST; analyze/generate/generate-apply POST; foreshadowing CRUD; reveals CRUD。
- /api/novels/{id}/memories: panorama GET; events GET + {id}/timeline GET;
  snapshots/capture POST + snapshots GET; rebuild POST; status GET;
  scene-checkpoints GET + ensure/rebuild/repair POST。

### 4.9 writing(23)
conflict-checks POST/GET + {id} GET + ai-review POST + ai-review-task POST;
conflict-check-items/{id} PATCH + ai-suggestion POST + ai-suggestion-task POST;
drafts/autosave POST; generate POST; semantic-reviews POST; targeted-revisions POST;
drafts POST(发布) + {id} GET/adopt POST/PUT(checkpoint: copy-on-write)/checkpoint POST/
discard POST/DELETE; chapters/{i} DELETE(软废弃) + draft GET + versions GET; chapters GET。

## 5. 任务 handler 与 AI 工作流全表(37 handler)

注册组合根 `backend/app/task_runtime.py:10-27`。恢复策略: auto=auto_requeue(退避重试),
manual=manual_resume, restart=restart_origin。

| 任务类型 | 模块 | 功能 | 策略 |
|---|---|---|---|
| rag_index_chapter | evidence | 单章切块入 RAG + 触发 embedding | auto×2 |
| rag_reindex_novel | evidence | 项目级全量重建 | auto×2 |
| rag_reannotate_entities | evidence | 刷新实体链接(不 embedding) | auto×2 |
| rag_retry_embeddings | evidence | 重试失败 embedding | auto×2 |
| map_atlas_generate | world | 地图册生成工作流 | manual×20 |
| map_atlas_storage_cleanup | world | S3 幂等清理(global) | auto |
| world_object_image_cleanup | world | 对象图片版本清理(global) | auto |
| world_validation | world | 冻结校验 run(语义 packet) | auto×2 |
| world_alias_relation_extraction | world | 手动别名/关系补抽 | auto×2 |
| world_entity_fusion_suggestions | world | LLM 融合建议(不改实体) | auto×2 |
| world_generation_suggestion | world | 生成中心结构化建议(任务模式) | auto×2 |
| world_bible_projection_refresh | world | 页面投影刷新(确定性) | auto×2 |
| world_bible_synopsis_refresh | world | 简介修订刷新(LLM) | auto×2 |
| deep_import | imports | 深度导入全流水线 | manual |
| scene_auto_extraction | imports | Scene 提取(Phase0/1a/1b/1c+commit) | manual |
| world_object_auto_extraction | imports | 对象/别名/关系(Phase2a/2b) | manual |
| plot_structure_auto_extraction | imports | 剧情线(Phase3) | manual |
| smart_dedup_scan | project | 智能去重扫描 | auto×2 |
| interaction_story_generate | interaction | RP 流式生成(framer+分段 checkpoint) | restart |
| interaction_summary_refresh | interaction | RP 概要+总回顾 | auto×2 |
| story_character_card_generate | story | 人物卡 preview | auto×2 |
| story_reaction_propose | story | 反应 proposals preview | auto×2 |
| story_scene_script_generate | story | 剧本 preview | auto×2 |
| story_one_click | story | card→reaction→script 链 | auto×2 |
| story_outline_generate | story | 总纲 strict preview(不写资产) | auto×2 |
| plot_structure_generate | story | **退役 stub** | restart |
| chapter_card_extraction | story | **退役 stub** | restart |
| chapter_scene_generate | story | **退役 stub** | restart |
| outline_analyze | story | 结构分析(只读 markdown) | auto×2 |
| outline_generate | story | P20 当前层 preview | auto×2 |
| scene_fusion_preview | story | Scene 融合 LLM 预览 | auto×2 |
| publish_chapter | writing | 发布三步: RAG 索引+memory 快照(非 LLM) | restart |
| writing_generate | writing | 正文候选生成(含 POV 变体) | auto×2 |
| writing_semantic_review | writing | 独立语义审查 | auto×2 |
| writing_targeted_revision | writing | 冻结 finding 定向返修 | auto×2 |
| writing_conflict_ai_review | writing | 冲突 AI 软复核 | auto×2 |
| writing_conflict_item_ai_suggestion | writing | 冲突项建议 | auto×2 |

非任务型 LLM 流(同步内联): 世界生成中心 chat/convergence/exploration/inspection、
ask_world、rag reranker、地图册 plan、语义审查同步端点、冲突同步复核等。
文件式 prompt 仅 10 个(`backend/prompts/`: story_outline、p20×6、scene_entity_extraction、
alias_relation_extraction、rag_reranker), 其余为内联 step(权威清单
`docs/prompts/Prompt体系设计.md`; 开发期漂移检查 `backend/tools/prompt_contracts/` 19 份
JSON, `make prompt-contracts`)。

## 6. 数据模型全表(100 张)与不变量

### 6.1 按模块计数
account 9 / project 4 / world 43(core 5+character 2+authority 4+profiles 8+
worldbuilding 20+map_atlas 4) / story 20(outline_state 11+continuity 5+story 4) /
evidence 10(compilation 7+indexing 3) / interaction 7 / imports 3 / writing 3 /
infrastructure(async_tasks) 1。

### 6.2 核心不变量机制(落表)
- **不可变 revision + head 指针**(11 处): story_outline、world_canon、world_bible_synopsis、
  character_card、scene_script、interaction_overview、entity_profile_template、
  generation_prompt_template、world_bible_page_template、context_activation_profile、
  world_bible_page。修订行带 version 唯一 + digest + base/restored_from 链。
- **写权 fencing**: rag_index_state 与 import_workflow_runs 的 task_id+generation+
  owner_attempt+owner_lease_id; async_tasks.novel_id 插入后不可变(ORM 事件强制)。
- **候选→审查→采用**: map_atlas_pages.review_status / nodes.status /
  entity_relations.status / writing_drafts.status(candidate/canonical)/
  creation_suggestion_queue / conflict_check_queue / scene_fusion_suggestions /
  smart_dedup(superseded_at)。显示态投影 `world/asset_state.py`(active/review/archived
  三态, conflicted/needs_review 是注意原因非主状态)。
- **软删除**: 仅 projects.deleted_at(回收站)+accounts.pending_deletion; 行级无通用软删,
  历史靠不可变 revision/supersede。
- **事件账本**: memory_events(真相源, 双唯一序)→ snapshots/checkpoints(部分唯一 is_current
  + supersedes 软链)。
- **幂等**: world_assertions.content_digest; story_outline.idempotency_key;
  interaction_attempts.idempotency_key; enqueue operation+fingerprint。
- **揭示分级**: core_entities.reveal_level / rag_chunks.visibility 四级 /
  knowledge_visibility_policies / reader_reveal_policies / reveal_plans /
  projects.default_reveal_policy。

### 6.3 迁移里程碑(46 个, 单线链 20260703→20260827)
squash 基线(frozen DDL SHA256 校验)→ novel_evidence → world_bible_v2 → story_outline →
account_system(多租户转折)→ **20260812_ai_map_atlas(删 12 张 legacy map_*)** →
world_object_images → story_scene_assets → relation_alias_kinds →
**20260827_world_authority_phase0(Canon 4 表)** → project_author_tasks(head)。

## 7. LLM / Embedding 基础设施

- **ManagedLLMStep**(`infrastructure/llm/agent_step_harness.py`): 权限阶梯 read/suggest/
  draft/act_with_confirmation, **`autonomous` 直接拒绝**; wall-clock 超时; AgentRunJournal
  记录 started/ended+error_kind; provenance 经 contextvar 合并进任务 result。
- **结构修复单层**(`client.py generate_structured`): 首轮即带完整 JSON Schema
  (OUTPUT_CONTRACT)→ 容错 JSON 解析(截断括号补全)→ 截断检测+预算扩 40000 重试 →
  partial_list_fields 逐项保留 → fix_prompt 重试 → 格式转换兜底; diagnostics 不含原始
  响应。
- **并发/熔断**: 进程级 semaphore + token bucket RPM, 全项目共享; 熔断按
  (project:/system, chat/embedding, 规范化 endpoint) 分桶, **熔断门禁先于 RPM**; cooldown
  后单探针 half-open; 256 项 LRU; 确定性错误不计数; 所有路径(含 embedding)统一走 limiter,
  业务不得绕过。
- **Embedding**: BGE ONNX 独立子进程; query/document 分离双队列; maxsize 硬背压;
  批量失败降级可恢复; direct fallback(测试); prewarm。
- **诊断/脱敏**: redact_diagnostic 统一日志脱敏; health 分层诊断(DNS/代理/模型/聊天)绝不
  回传 Key; token_estimation。

## 8. 治理裁定速查(25 篇 ADR 归类)

### 8.1 确认(可直接继承的裁定)
0001(world→memory 快照形状)、0002(受限 BaseCRUD)、0005(自定义实体类型+可逆迁移)、
0006(页面非事实源/激活规则版本化)、0007(生成中心统一, **删 4 个旧 AI 接口**)、
0008(P20 跟随层级/信息推进确定性投影)、0009+附录A(Vue 迁移完成/删 keep-alive)、
0010(公开账号/Key 归账户级)、0011(keyed coalescing/领域 owner 分离)、0012(地图册/
**破坏性删旧地图**)、0013(operation receipts/不建全局任务中心)、0014(对象图片+32GiB
单盘上限/无图片备份是接受的风险)、0016(世界书导入治理/校验回执门禁)、0017(Canon
Phase 0/owner-only 授权)、character-merge-to-world、world-services-layout、
背压/CSP 主 ADR + 两篇细化索引。

### 8.2 删除裁定(不得在 dsh 复活)
旧 Leaflet 动态地图(0003 Superseded+0012)、keep-alive 活 DOM(0009A)、4 个世界书旧 AI
接口(0007)、旧兼容包与 `/api/rag|context|settings/*` 挂载(0015, 39c3878f0 退场)、
character/timeline/geo/review 独立模块、按 offset 断章入口(outline-writing ADR
Partially superseded, 2026-07-22 取消)。

### 8.3 延期(不得当作当前能力)
ADR-0005 备选 C(自定义类型模板/动态 Prompt)、ADR-0013 跨设备锁/全局任务中心、ADR-0016
validation run 自动清理、**ADR-0017 formal family 准入与 Phase 1+ cutover(当前全部
formal-disabled)**、context snapshot 回放/diff/定时清理/Context Validity、RP 的原作
导入/按章分叉/公开分享。

### 8.4 部分完成(勿当作既成事实)
imports 子包拆分(仅 entity_extraction 落地)、ADR-0015(兼容退场已完成但 wire/DI key
保形)、hidden guard 未按章取 checkpoint、来源重开/人工修复 UI 不完整。

### 8.5 轻量决策(DECISIONS.md, 2026-07-04 World Bible First-Version Scope)
不做仪表盘/健康百分比(改按需一致性检查报告); 知识七值且 knowledge_level 是唯一覆盖深度
字段; background_group 不是资产类型(= entity_type="group"); 可见性 v1 只执行
public/tag/private+CharacterKnowledge 覆盖; 世界事实统一 TargetRef 寻址; 读者安全是进度
相关计算非存储布尔; 派生标签排除走独立表; 事件派生标签需 provenance+author_locked;
页面只组织叙述不拥有事实; 深导入只记事实大纲不做叙事知识选择。

## 9. 对 dsh 重构的使用指引

1. **读图顺序**: 本文 §2/§3 建立能力全景 → 《功能对照清单.md》§6.2 技术证据矩阵与
   §6.6–6.23 切片查差距 → 父仓库锚点核实细节。
2. **语义优先**: 重构参考的核心不是接口形状, 而是**行为契约**: 候选先审查后采用、来源
   冻结、published copy-on-write、事件账本重放、confirmation 门禁、reveal 分层过滤、
   owner-only Canon 授权。这些在 dsh 的等价物见对照清单各切片"最小合同"节。
3. **已裁定替代**(dsh 侧已有结论, 不从父仓库继承): 去账号(D11)、Word 外置(D8/D20)、
   不做站内生图(ADR-0020)、对象图片 v1 不迁移(D19)、RP 延期(D23)、不做带批注 docx(D20)。
4. **漂移警戒**: 父仓库仍活跃(本文基准 8c1516daf); 旧台账 §1–§5 的 14 路由/90 表/357
   端点/34 工作流是历史盘点, 引用时以本文数字覆盖。
5. **更新协议**: 父仓库显著漂移时(新模块/新表/新 ADR), 更新本文 §0 规模快照与受影响
   能力域, 并在 §0 改基准 commit; 对照切片仍归对照清单。

---

*本文由 2026-08-31 五路并行审计(模块/API、任务/工作流/LLM、数据、前端/流程、治理文档)
综合产出; 各节锚点格式 `相对 ai-writing-assist 根路径:行号`, 行号为基准 commit 时点。*
