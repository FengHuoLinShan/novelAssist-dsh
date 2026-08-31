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
| N23 | validateFrontmatter 接入写链 | validateFrontmatter 接入 adopt（含 softDelete/建议迁移）与 merge 写路径及核心包落盘前校验；校验对象为最终落盘 frontmatter（状态迁移/索引/id 赋值后），缺 id 确定性补 id=slug；失败抛 StoreError(VALIDATION_FAILED) fail-closed、无部分写入；chapter_candidate 复用 chapter schema。依据: M7 review（校验器零生产调用方致字段漂移潜伏）+ 铁律2/5 + ADR-0019 P3 同构 |

## 第六批(M7 批次, 2026-08-15)

| # | 裁定 | 决定 |
|---|---|---|
| N27 | catalog 预算/参数转录进 builtin specs(M7 Phase E) | 口径: **temperature/timeout 按 catalog 原样转录**(catalog 秒 → timeoutMs 毫秒), **budgetTokens 仅在 spec 最坏情况输入估算 ≤ catalog max_tokens 时转录 catalog 值**, 输入可能超过则保持 `budgetTokens: 0`。**转录清单**: `entity_extraction`(temp 0.1→0.3、budgetTokens 0→32768, catalog §1.6; timeout 保持 600_000ms, §1.6 为「项目 LLM timeout+60s」公式无字面秒数)、`structure_analysis`(temp 0.3→0.2、timeoutMs 1800000→1200000, catalog §1.8)。**输入主导豁免清单**(输入上界由调用方控制, 不转录 catalog max_tokens): `structure_analysis`(§1.8 max_tokens 32768, 输入=确定性上下文编译+多章/整场 Scene 证据拼接可能超过)、`rag_rerank`(§3.6 budget 2048 < 默认召回集输入估算 ≈2625 token(N24), 保持 N24 的 4096)、`alias_relation`(§1.7 无 max_tokens 行, 输入=整场 Scene 正文+实体索引)。**注意**: `step.ts` 把 budgetTokens 同时作 provider max_tokens(`maxTokens = budgetTokens \|\| undefined`), 故豁免项(budgetTokens=0)的输出上限也不受 budgetTokens 约束, 由调用方 overrides 或 Provider 侧默认承接。其余 23 个已注册 spec(world/outline/imports/writing + 其余 builtin)与 catalog 转录核对一致(temp/timeout 已一致; catalog 无 max_tokens → 0 保持), 无改动。依据: M7 Phase E + 铁律5 + N24 |
| N30 | writing 审查回执 finding_id/severity 对齐 | ReviewFinding 增 finding_id=finding_<sha256前20>（chapter_index+稳定内容字段派生，确定性）；severity 存储词表 blocker/major/minor（writing.md:284），摄入归一化 high/medium/low→blocker/major/minor（未知值 fail-closed 丢弃该 finding，不落盘）；新增 rejectFindingById 与 applyRevision findingIds 绑定（加法-only，铁律4，旧 index 路径保留）；返修校验 finding_ids 属冻结回执 + 基线 content_hash 未变（writing.md:353）。client 仅消费 finding_count，零契约冲击。依据: M7 review + writing.md:283/284/332/353 + 铁律4/5 |
| N31 | 审批门旁路收口(M7 Phase F) | ①world 写面(createObject/updateObject)收口: NovelCraftService 增 worldCreateGuarded/worldUpdateGuarded 经 ApprovalGate(allowed-once, fail-closed), facades.world 两写函数改为指向 guarded 方法的拒绝存根; ②imports 结构资产 ≥0.96 不再直置 canonical, 统一落 draft, 升格走 novelcraft_store_adopt 审批门; client RPC 保持只读不动。依据: M7 review(审批门旁路面) + 铁律3/5 + N23 |

## 第七批(map atlas 批次, 2026-08-15 用户确认)

编号说明: 本批次为 N28/N29; N27/N30 属并行 M7 批次(第六批)。

依据: 计划 §1.3 + 附录 A(用户已确认)+ 铁律 2(文件唯一真相)、铁律 3(adopt 必过 approval fail-closed)、铁律 8(父仓库 ai-writing-assist 只读, 本批次一切改动只在 novelAssist-dsh 本仓库)。

| # | 裁定 | 决定 |
|---|---|---|
| N28 | 本轮 no-image-generation scope + prompt_only 不可 adopt + 空节点占位可 adopt | M4 世界地图册不实现图片生成: 不调用 `gpt-image-2` / Image API、不生成图片字节; 不做 S3/MinIO 在线对象存储、图片 URL、缩略图、删除补偿; 不做 `generation_choice=internal`、`prompt_review → generating` 状态机、`provider_in_flight/uploaded/retry_requires_confirmation/重复扣费确认`; 不做页面 regenerate/edit(蒙版)/retry/图片 reference image 读取; 不做 `layout/quality/review_image_prompts` 三个纯图片参数。地图册页面必须 = 「本地图片 + 可移动自定义文字标签」, `prompt_only` 页面(仅外部生图 Prompt 参考文本)不能 adopt。允许纯粹层级/地点的 adopted 空页占位节点先进入地图册(无图片页), 作者点进去后再上传对应图片。prompt 仅为外部生图参考文本产物, M4 不生图。依据: 计划 §1.2/§1.3 + 附录 A.8 + 铁律 2/3 + 计划 §5 规则 8/10 |
| N29 | 本地图片路径导入写边界 | 图片摄入只接受宿主本机可读的绝对路径, 由 dsh 工具在插件进程内 `stat/read`(同 `ingest_text_file` 口径), 不走浏览器字节上传、不经 agent 沙箱文件工具; 默认 `mode=copy`(`mode=link` 不在本期); 校验 magic bytes/≤50MB/尺寸 16×16~8192×8192/sha256 后复制(整理)到 `world/atlas/images/<page-slug>/<attempt>.<ext>`(扩展名由 magic bytes 决定, 不用用户文件名作路径段); 该目录写入 vault `.gitignore`, 仅本地保留; `git add` 只添加 run/page/node 文本文件, **绝不 git add 图片字节**; 图片不 push GitHub; 候选写入不过 approval, adopt 仍必经 ApprovalGate(fail-closed); 换机/克隆后缺图由读面标记 `image_missing=true`(文本页仍可读)。依据: 计划 §1.2 注 + 附录 A.1/A.2/A.3/A.4/A.6 + 铁律 2/3 |

## 第八批(全代码库 Review 架构闭环, 2026-08-15 用户确认)

依据: `docs/agent/reviews/full-codebase-review.md` §4; 铁律 1(核心包零 DSH 依赖)、铁律 2(文件唯一真相)、铁律 3(adopt approval fail-closed)、铁律 4(核心接口只做加法)、铁律 8(父仓库只读)。本批裁决均为 **Accepted、implementation pending**，不得写成已经落地。

| # | 裁定 | 决定 |
|---|---|---|
| N32 | Vault Git 目标路径级写事务 | 统一 `VaultWriteTransaction`：调用方在首写前声明完整 write set 并完成内容/路径/frontmatter/CAS preflight；允许 write set 外无关 unstaged/untracked，任何预存 staged 一律 fail-closed；每 vault 使用跨进程锁，文件以同目录临时文件 + rename 原子替换，Git 仅精确 stage/commit 声明路径且提交前复核 staged 集与目标 hash；失败时只回滚仍等于本事务输出 hash 的路径，检测到外部后续编辑则不覆盖并报告人工恢复；commit 是 canonical 事务终点，业务写面禁用 `git add -A`。该协议提供目标路径级隔离，不把不遵守锁的外部编辑器视为受控并发方。依据: ADR-0021 + Review P1。 |
| N33 | 逐批 checkpoint / resume 与恢复审批 | deep-import 与 map-atlas 采用统一的不可变 workflow run 协议：指纹覆盖源内容 hash、policy、非 secret ExecutionProfile、workflow/schema/prompt 版本；批次按“结果原子落盘 → checkpoint 提交 → 推进游标”持久化；输入变化不得续跑，`force=true` 永远创建新 workflow 且不覆盖旧 run；canonical apply 仍逐目标 CAS + provenance/idempotency 校验。已提交写入可由 Git/provenance 识别并只补状态，未写 adopt 必须重新审批，写前崩溃不得复用 allowed-once；恢复仍需 LLM 时只对剩余批次重新请求范围/成本授权，不重复已完成批次。Key/secret 不进入 manifest、journal 或 fingerprint。依据: ADR-0022 + Review checkpoint P2。 |
| N34 | DSH session/watch 生命周期与 ExecutionProfile | `session/created` 仅按绝对 cwd 自动绑定已有 vault，绝不自动建书；插件加载/HMR 扫描 live sessions 补建，`session/disposed` 按 vault 引用计数，最后一个活跃 session 离开后停 timer。守望由 Node 托管、与浏览器刷新/断线无关；按活跃 vault 启停，持久记录 `last_completed_at/next_due_at/config_fingerprint`，过期最多补跑一次，每 vault/radar 防重入且每 radar 一 job；不承诺 Node 停止时 24/7 运行。编排启动时解析不可变 ExecutionProfile，所有内部 llm-step 统一继承 timeout 等默认值，请求级 override 优先。Node engines 对齐 DSH：`^22.19.0 || >=24.0.0`，CI 至少覆盖 22.19/24。依据: ADR-0023 + Review lifecycle P2。 |
| N35 | NovelCraftService capability API 安全默认 | 公开服务面收敛为 `capabilities.read/propose/adoptGuarded`；raw adopt/merge/write orchestration 移入 internal 且不从主 exports 导出；旧 `facades` 只可作为 deprecated 的安全别名过渡，不得继续暴露 raw 写旁路。保留 ADR-0020 的地图 annotation 作者编辑通道作为 `propose.authorEdit.annotations` 封闭例外：不过 ApprovalGate，但只能改固定 `annotations` 字段，强制 `base_content_hash` CAS、受控队列/精确结构化来源与 ADR-0021 事务，不得扩大为 raw canonical writer。该边界用于防止正常插件误绕 approval，不宣称能隔离同进程恶意代码；直接 import 核心包的进程级权限治理不在本 capability API 的安全承诺内。核心包继续零 DSH runtime import，采用类写入仍由 `@novelcraft/dsh` ApprovalGate fail-closed。依据: ADR-0024 + ADR-0020 + N31 + Review facades P2。 |
| N36 | M4 源码分发、Node 与可选 BGE 安装策略 | M4 近期仅作 monorepo/DSH 插件源码分发，不发布 npm 包、不承诺公共 semver；各 workspace 标记 `private: true`，仓库本身可保持 PUBLIC，二者不冲突。保留源码与本地构建产物；Node 基线同 N34。`@novelcraft/rag-bge`/Transformers 链保持 monorepo 内 optional adapter，默认安装 profile 省略 optional，显式 BGE profile 才 include optional 并单独 test/audit；运行时 embedding 默认 off、缺包逐层降级。已知 4 个无上游修复 high 持续登记，不使用破坏性 override，也不拆出独立仓库。依据: ADR-0025 + N21/N22 + Review 发布 P2/P3。 |

## 第九批(测试/回归流程压缩, 2026-08-24 用户确认)

| # | 裁定 | 决定 |
|---|---|---|
| N37 | Node 24 单版本运行时与 CI | 本仓库只支持 Node `>=24.11.0`；默认 profile 与显式 BGE profile 的 CI 均固定 Node `24.11.0`，不再维护 Node 22 兼容矩阵。默认 profile 已覆盖 `@novelcraft/rag`，BGE profile 只追加 `@novelcraft/rag-bge` 能力测试与 BGE audit，避免重复 gate。**本裁定仅取代 N34/N36 的 Node 版本与 CI matrix 条款**；session/watch、ExecutionProfile、源码分发、optional BGE、audit baseline 等其余约束继续有效。 |

## 第十批(M10-A LLM 内容步 runtime 收口, 2026-08-31)

依据: 后续开发计划.md §0(插件边界纪律)/§2.A-探测(A1 宿主能力探测报告) + 铁律 4(核心包只加法)/铁律 5(内容手受控) + 上游 deepseek-harness AGENTS.md("模型可见⟺可回放"、"Plugins, not loop changes")。

| # | 裁定 | 决定 |
|---|---|---|
| N38 | schema 首轮注入采用 schema 文本注入; promptBody 加法组装; 回执不截断 | ①rc.8 `@deepseek-ai/dsh-llm` 的 `GenerateOptions` 无 response_format/json_schema 字段(A1 探测, types.d.ts:332), **不使用** `tools` 通道伪装 tool-call 承载结构化输出(超出宿主对该 seam 的文档化用途, 且需适配器新增 tool-call 块解析、污染 session log 工具语义), **不触碰**共享层加 response_format(ADR-0018 纪律, 能不触碰就不触碰)。②输出契约(OUTPUT_CONTRACT = JSON Schema 文本)注入 system 槽尾部, `outputFormat=text` 不注入; 组装在 core `llm-step` 完成(`prompt-body.ts` 加法导出: composeSystemPrompt/renderOutputContract/legacySystemPrompt/promptHash/outputSchemaHash), dsh DshProvider 只透传 system, 零适配器改动。③`LlmStepSpec.promptBody` 可选字段(加法): 存在时以其为 system 主体; 缺省回退 legacy description/inputNotes 摘要路径且**字节级不变**(golden 测试锁定)。缺 promptBody 的 json spec 自本裁定起同样注入输出契约(这是 M10-A 的目的性行为变更: 模型从此首轮即见 schema, 对齐源系统 OUTPUT_CONTRACT 语义)。④模型可见⟺可回放: 每次 attempt 的 journal 条目附 `promptHash`(sha256 前 16 hex)与 `schemaInjection` 模式; `StepResult.promptFingerprint`(systemPromptHash/schemaInjection/outputSchemaHash, 加法可选字段)成功与失败均携带。⑤`novelcraft_llm_step` 工具回执去 8000 字截断, 完整回传 text/journal(逐字段 JSON 投影)/spec_ref/contract_version/三指纹字段。去条件(重开须新裁定): 宿主 dsh-llm 契约新增 response_format/structured 字段时重新探测; 或实测文本注入结构遵循度不足且经产品裁决接受 tools 通道复杂度。 |

| N39 | 预算估算并入 system 提示; 回执上界走 Config; trace 指纹透传 | M10 Track A review 修复三裁定: ①`checkBudget` 输入估算并入 system 提示文本(`req.input + composed.text`)——N38 注入后 json spec 的 system 含完整 JSON Schema, 只按 input 估算会系统性低估; budget_exceeded 消息改为「输入(含 system 提示)估算」。②`novelcraft_llm_step` 回执正文上界 `Config.llm.receiptMaxChars`(2,000–2,000,000, 缺省 65,536)——去 8000 硬截断(N38 ⑤)后的防失控上限, 超界截断并在尾部显式注记(不静默丢内容); 可调参数走 Config。③`ProviderRequest.promptHash/schemaInjection`(加法)由 runStep 组装时填充, imports 两处 tracedProvider 透传进 trace `llm_step` 事件(`LlmStepEvent` 加法可选字段)——trace/journal 双面可回放, 对齐 Track A 验收措辞。附带修复: llm_step 工具 `max_tokens/timeout_ms` 参数恢复显式 undefined 判断(零值不吞, 与 preset.ts 审查项 4 同原则; max_tokens=0 = 不限输出合法语义, timeout_ms=0 由 core deadline 响亮失败)。依据: M10-A review 问题清单 #1/#3/#4/#6 + N38 + 上游 AGENTS.md(可调参数走 Config/失败要响/模型可见⟺可回放)。 |

| N40 | 长任务恢复面工具组(workflow_inspect/resume/start_new/abandon) | M10-B1/B2 落地: ①core imports 加法 `run-listing.ts`(listWorkflowRuns: 枚举 `.assistant/import-runs/` 与 `.assistant/atlas/runs/` 两 namespace 的 manifest, 白名单字段提取, 坏/缺 manifest 容错列出 corrupt, 纯读零写); ②dsh `workflow-face.ts` 四动作: inspect=只读(read 声明表); resume=checkpoint scope 绑定校验(workflowId 尾段含 checkpoint plan id, 不匹配 fail-closed)后复用 deepImport 续跑路径(authorize_deep_import_resume 只请求剩余, N33 P2 既有语义); start_new=DeepImportOptions.force(加法, uniqueRunId 附加时间戳+随机熵段 → classification 恒 new 全 scope 授权)——**completed run 的重放从此有显式选择路径**(注: 旧 deep_import 工具同 scope 调用仍走隐式 resume 语义, 全 completed 时零授权重收尾; 其描述已加指引「显式重放/重开请改用 workflow_inspect 与 workflow_start_new」); abandon=审批(abandon_workflow_run)通过后删 run 目录+绑定 checkpoint 并精确 git 提交(store gitAdd/gitCommit 允许表内), **不触碰 canonical 创作资产**(铁律 2: git 是回滚面, 资产撤销走 git revert/版本面); ③工具组插件 `tools/workflow.ts`(novelcraftToolFactory, N34 隔离)+`NovelcraftWorkflowToolsPlugin`(internal 面)+`config.tools.workflow` 开关; capability 归位: inspect→read, resume/start_new/abandon→adoptGuarded; 同步四处(隔离矩阵 25、preset 内联清单、README、交接 §4.2)。Track B review 修复(2026-08-31, P0+4×P1+6×P2 全闭): ①P0 abandon 的 workflow_id 过 assertSafePathSegment 单段校验 + listWorkflowRuns 枚举存在性双门(穿越串/不存在 id 零审批零删除, rmSync 目标永限于枚举确认过的目录); ②abandon 前置 R17 洁净门禁(hasUncommittedOutside(removed 豁免集), 预存 staged 外部内容 DIRTY_WORKSPACE 拒绝)且仅终态(completed/failed/provider_outcome_unknown/unreadable)可清理, 审批摘要明示 durable intent 孤儿风险; ③resume 前置三重校验(枚举存在/非 force run/ checkpoint 绑定)+ 执行后对账(实际 workflow_id ≠ 请求 id → WORKFLOW_RESUME_DRIFTED, 输入/画像/策略漂移不再静默变新 run); ④force 段加随机熵(同毫秒不撞 id); abandon 返回真实 HEAD sha; abandon 审批透传 signal。v1 范围限定: resume/start_new 同步执行(job 托管 ADR-0023 后续增量); resume 仅支持 checkpoint 可读且绑定的 deep-import run(否则指引 start_new); map-atlas run 仅支持 inspect/abandon(其 plan 流程自管); resume 成功路径(真实续跑)与 force identity 差异的行为级测试随 B3 job 托管增量补齐。依据: 后续开发计划.md §2 Track B + ADR-0022/N33 + 铁律 2/3 + N35。 |

## 第十一批(M10-C 写面收敛, 2026-08-31)

依据: 后续开发计划.md §2 Track C + 台账 §6.24.1 + ADR-0021 §6(精确 pathspec) + 铁律 2/4。

| # | 裁定 | 决定 |
|---|---|---|
| N41 | 预存 staged 门禁(hasStagedOutside)与写面收口 | ①store 加法 `hasStagedOutside(repoDir, allowed)`: 只挡 porcelain 第一列(index)非空且非 '?' 的**预存 staged**——这是裸 `git commit` 会实际卷入的唯一部分; untracked/unstaged 不会被精确 pathspec 的 git add 卷入, 不因此拒绝(作者外部编辑器的正常未提交改动不受影响, 与 hasUncommittedOutside 全严格语义的关键区别)。rename/copy 双端都在允许范围才干净(AND 语义, 单端豁免不放行); 允许项支持 `:(literal)` pathspec 前缀剥离与尾 `/` 目录前缀。②四处写面 gitAdd 前加门禁: writing/generateNextChapter(双门禁: LLM 前置 + commit 前复检, imports 形态)、world/map-atlas write 三处(writeCommitted/writeAtlasRun/writeAtlasCandidates)、dsh workflowAbandon(豁免集用目录前缀, run 内 staged 残留不挡清理目标)。**行为变更**: 预存 staged 场景从「被裸 commit 卷入」改为「DIRTY_WORKSPACE 拒绝」——旧容忍被判定为缺陷(map-atlas 旧"预暂存随 commit 走"用例改写为拒绝专测)。③service.refreshIndex 删除无 consumer 的 index cache 写(putIndex 全仓零读取方, 死写); NovelcraftCache.putIndex/getIndex 能力面保留(铁律 4)。④后置项(记入计划): RAG 派生 writer 的 change plan→fresh 零写重构、signal state/CAS 强化、writing/revise/review、world/generation、outline/structure 等其余裸 commit 点的门禁补齐(review 已列清单)。依据: M10-C review + Track B review P1-2 + imports assertImportWorkspaceClean 先例。 |

| N42 | 书库生命周期公开化(book 工具组)与 client 路径旁路删除 | M11 落地: ①dsh `book-face.ts` 三动作: bookList=只读枚举 vaultsDir 下含 book.yml 的目录(title 容错读 frontmatter, 缺省目录名)+当前会话绑定标记(read 声明表); bookCreate=审批后 ensureVault 幂等初始化(已存在返回既有不动文件); bookOpen=审批后 binder.bindSession 原子切换会话绑定(引用计数/watch 语义由 binder 管; 书不存在 BOOK_NOT_FOUND 指引)。②工具组 `tools/book.ts`(3 工具, novelcraftBookToolsPlugin + config.tools.book 开关)+capability 归位(list→read, create/open→adoptGuarded; 审批在 service 方法内, 工具只经 capabilities——N35); **隔离形态**: 三工具均为「未绑定也可用」的发现/创建/首绑入口(M11 的目的, N34 矩阵为其加例外——情形 2/3 跳过 book 组), 无 agent 一律 WORKSPACE_ISOLATION(execute 自验 requireAgentForBooks); **不接受模型提供的绝对路径**——目标书一律按书名经 rootForBook(validateBookDirName+guardPath 防穿越)。③client rpc.ts 删除 workspacePath 旁路(§6.13: 路径不是绑定权威, sessionId 是唯一 root 解析面; 未绑定呈现未绑定态不再向上猜路径); wire.ts 类型字段保留为兼容冗余。④books/list client wire 后置到 client 迭代(与 B4 工作流卡同批)。同步四处: 矩阵 28(含例外注释)/preset 28 清单/README/交接。M11 review 修复(2026-08-31, 2×P0+1×P1+9×P2 全闭): ①P0 工厂对全部工具无条件 resolveBoundRoot → 未绑定会话在工厂层被拒, book 组「未绑定可用」完全不成立 —— 加 bindRoot: 'none' 第三模式(工厂跳过 root 解析), book 三工具用之, run.root 类型放宽为可选 + 非 none 工具消费点统一 requireRoot(run) 收窄(fail-closed), afterMutation 对 undefined root 直返; 补未绑定会话 list/create/open 成功正例(首绑入口不再死锁)。②P0 client rpc.ts 的 workspacePath 删除在首次提交中静默失败(python 替换无 assert)造成记录失实 —— 已真正落地(resolveRoot 只认 sessionId, 旧回退测试反转为新语义断言)。③P1 book_open 不驱动守望生命周期 —— binder.bindSession 返回加 deactivatedRoot(切走后旧 root 引用归零时), book_open 经 NodeRuntime.activate/deactivate 透传驱动(与 session 事件同一面, 不引入第二套生命周期)。④P2: 存在性/书名校验先于审批(open 的 BOOK_NOT_FOUND/create 的 validateBookDirName 均零审批拒绝; open 摘要写明从哪本切到哪本)/矩阵例外注释重写(写明 bindRoot='none' 与正例位置)/requireAgentForBooks 迁移 tools/shared.ts(工具纪律归工具层)/capabilities 注释错位修正/书名穿越负例测试。依据: 后续开发计划.md M11 + 台账 §6.13 + N34 精神 + 铁律 3。 |

## 第十二批(M12-a 生成域接线首切片, 2026-08-31)

| # | 裁定 | 决定 |
|---|---|---|
| N43 | worldCreate/worldUpdate 工具入口; outline/生成中心工具组的 preview/apply 拆分前置设计 | ①`novelcraft_world_create`/`novelcraft_world_update` 两工具补齐(N31 起能力已注册 adoptGuarded 表、service 方法与 N32 事务接线齐备, 本批只补作者可达入口): 归 writing 工具组(无独立前缀); JsonValue 数组参数逐项字符串校验 fail-closed; 行为测试锁定(审批拒绝零写/审批后精确提交/update 整组替换+未知 slug 拒绝); 四处同步至 30 工具。②**裁定推迟**: outline 生成面(generateStoryOutline/generateOutlineItem)与 world 生成中心五模式的工具化**必须先做 preview/apply 拆分**(core 加法: preview 不写资产 + 生成产物暂存面 + apply 显式)——现状两函数直写 canonical 资产, 直接包工具只能整段 adoptGuarded(生成即写), 违背台账 §6.18.2「preview→编辑→采用」与 §6.17 生成中心语义; 该拆分是 M12-b 的首要任务, 本批不预建不冒充。M12-a review 修复(2026-08-31, 无 P0, 1×P1+5×P2 全闭): ①P1 entity_type 全链路无白名单(core object schema 对 kind 只有类型检查, 非法串静默写入并被 relations 判定悄悄排除)→ 工具层白名单 fail-fast(零审批拒绝); **core kind enums 补齐记 M12-b**(加法, 消既有非法 kind 数据的兼容评估后做)。②P2: update 描述去掉「对象名」误导(只接受 slug)/slug 死代码 Date.now() 兜底删除(core)/空 patch 工具层早拒(避免无意义审批+重排提交)/strList 提为单次调用/测试补强(非法 kind 零审批、空 patch 早拒、update 审批拒绝零写、description 整段替换、tags 已有组整组替换、未知 slug 零审批断言)。已知边界(记 M12-b): slug 坍缩错误语义(不同名字折同 slug 时「对象已存在」与真实原因不符)。依据: 后续开发计划.md M12 + 台账 §6.17/§6.18 + N35。 |
