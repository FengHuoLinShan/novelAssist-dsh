# M4 重构开发状态(novelAssist-dsh / main)

## 位置

- 仓库: /Users/tywww/Desktop/项目/novelAssist-dsh(独立仓库, remote origin = https://github.com/FengHuoLinShan/novelAssist-dsh.git, PUBLIC)
- 分支: main(默认), 迁移基点为 annotated tag `dsh`(2026-08-14 完成)
- 旧 worktree /Users/tywww/Desktop/项目/ai-writing-assist-m4-rebuild(codex/m4-dsh-plugin-rewrite)已冻结, 不动
- 治理文档: docs/adr/0016-m4-dsh-plugin-rewrite.md(Accepted)、
  docs/adr/0017-m4-repo-form-and-mounting.md(Accepted: fork 仓库形态 + 挂载授权)、
  docs/agent/dsh-rebuild/自主智能式作家助手设计.md(决策 D1–D25)
- DSH 参考 checkout: /Users/tywww/Desktop/项目/deepseek-harness(浅克隆, head 47f9438,
  只读参考; 构建链以 npm rc.6 官方包为准)
- 旧 dsh-rebuild worktree: 仅保留为历史/参考; 其残留改动不动(用户指示); 侧车 ADR 已标 Superseded

## 进度

- [x] ADR-0016 Accepted(在 dsh-rebuild 中为 0015, 入新分支取号 0016 避撞)
- [x] specs/ 骨架(README + assets 模板)
- [x] R0 资产 schema 提取: 5 份规格已产出并抽验(specs/assets/*.md, 共 2834 行)
- [x] R0 prompt/spec 目录提取: specs/prompts/catalog.md(32 spec, 已抽验)
- [x] R0 规则目录提取: specs/rules/{store-rules,policy-defaults}.md(已 QA)
- [x] 18 条落点裁定已确认(specs/adjudications.md, D26)
- [x] R1 内核完成并集成验收: vault 29 测试 + store 68 测试
- [x] R2 完成: @novelcraft/llm-step(19 测试)
- [x] R3 完成: writing 垂直切片闭环(15 测试 + r3-demo); store chapter 采用语义修正
- [x] R4 完成: imports 全六阶段 + L0–L3 去重 + 恢复(19 测试 + r4a/r4b demo)
- [x] R5 完成: world(6)/outline(7)/memory(5)/context(5)/rag(4)+ assistant 核心先行(11)
- [x] R7a preset/starter: skills 9 册 M4 校对 + presets 4 套 + starter 安装文档
- [x] **挂载阶段 A(ADR-0017)**: `@novelcraft/dsh` 适配包 31 测试全绿 +
  `scripts/m5-mount-demo.mjs` 集成 demo + CLI 端到端(dump-config 合成 +
  `--profile web --patch` 真实 boot 零错误)。全仓 **223 测试全绿, typecheck 零错误**。
- [x] **client 阶段(B) v1**: `@novelcraft/dsh-client` 双面包(宠物四态 + 收件箱四动词/
  键盘流 + `/novelcraft` loopback RPC)8 测试全绿 + tsdown 构建链 + 真实 web 端到端
  (boot 清单/bundle 200/playwright 浏览器零错误); 验收快照见
  docs/agent/dsh-rebuild/客户端阶段-验收.md。全仓 **231 测试全绿**。
- [x] **trace contract 测试框架(C)**: `@novelcraft/trace`(trace/assert/mock, 17 测试)+ `imports` 的 `runDeepImport` 编排 seam(11 测试); 全仓 **259 测试全绿, typecheck 零错误**; 验收见 docs/agent/dsh-rebuild/trace-contract-验收.md
- [x] **C 的 DSH 挂载收尾**: `@novelcraft/dsh` 新增 `deepImport` 便捷方法 + `novelcraft_deep_import` 工具(runtime.provider=DshProvider、approve=ApprovalGate fail-closed、trace=ImportTraceSink 落 .assistant/import-trace.jsonl), 3 测试
- [x] **client 迭代**: 剧情地图(`store.storyMap` + story/map 端点 + StoryMapAction)+ 写作台四模式(writing/desk 端点 + WritingDeskAction, 守望/计划/评审/参照 tab), 4 测试; 全仓 **304 测试全绿, typecheck 零错误**; 验收见 docs/agent/dsh-rebuild/client-迭代-验收.md
- [x] 信号主动推送(轮询→mux): ADR-0018 定 DSH 共享层政策; 短轮询过渡 + 真 mux 推送均已落地——scripts/apply-dsh-patches.mjs 加 client/push allowlist + @novelcraft/dsh emit + @novelcraft/dsh-client ctx.remote.$on 订阅(seam 提案见 信号推送-远程事件seam提案.md); 上游 Discussion #1289 回应后去 fork 化
- [x] 仓库迁出: codex/m4-dsh-plugin-rewrite → 独立仓库 novelAssist-dsh(annotated tag `dsh`, 2026-08-14)
- [x] **结构资产统一关系模型(ADR-0019)**: Accepted + P0–P3 全落地——`validateRelations`/`assertValidRelations`(7 type 枚举 + 源/目标白名单 + 自环/悬空/端点 kind, 写链硬错)、结构资产 schema `relations: 'list'`、`VaultIndex.relations` 全资产有向图(`sourceKind` 标注源)、`storyMap().edges`(显式边 + `related_*_ids` 兼容投影并集去重, N17)、`planned_payoff_scene` 兑现 #11 slug、reveal required 放宽(「未归类」=「无边」); 剧情地图三缺口关闭, 验收见 client-迭代-验收.md
- [x] **旧引擎退役(novelAssist-dsh 侧)**: 本仓库携带的 FastAPI/PG/Vue 旧引擎副本(backend/frontend-console/deploy/docker/docker-compose/Makefile/start.sh/tools/workflows + 旧 docs 与顶层旧文档)已删除, 归档于 annotated tag `old-engine`; 仓库现为纯 M4 DSH 插件 monorepo(重写 README/AGENTS/CLAUDE + 最小 ci.yml)
- [x] **续写提案第二阶段验收(fail-closed)**: 新增 `dsh/test/continuation-e2e.test.ts` 6 条端到端契约(计划台提案 → 正文候选 chapters/pending → 审批门控采用; allowed-once 放行 + rejected/cancelled/unavailable 三态拒绝, 铁律 3/5); 口径修正: 候选采用 kind=`chapter_candidate`(copy-on-adopt R34); dsh 42 测试, **全仓 310 测试全绿, typecheck 零错误**; 验收见 docs/agent/dsh-rebuild/续写提案-验收.md
- [x] **剧情地图关系边 UI**: StoryMapAction 新增「关系边」Section(按 7 type 分组 + 彩色徽章 + 未知 type 兜底, deprecated 删除线弱化, 中英双语 story.edge.*), 纯展示零写操作; 浏览器级核验: scratch boot + @novelcraft/dsh-client bundle 200 + 控制台/页面/请求错误 0, 截图 /tmp/nc-web.png(Modal 自动点击受 scratch GUI 工作区引导门限, 读图待确认)
- [ ] 旧引擎退役(ai-writing-assist main): 父仓库 main 的旧 FastAPI/PG/Vue 引擎保留, 退役时机另行裁决(ADR-0017 §1)。**【用户明确指示】不得反向改动父仓库 ai-writing-assist(含其 main)** —— 只读, 不回写/不退役/不同步

## M5 体验闭环(2026-08-14, 四 Track)

- [x] **Track 1 文本入库闭环**: writing 包 splitChapterText(确定性章节切分: 第X章/Chapter N/序章楔子番外)+ importTextChapters(门禁/编码护栏/幂等/冲突保护)+ import-log.jsonl(N18 裁定: 一导入文件一停靠, chapters/*.md 唯一落点); dsh `novelcraft_ingest_file` 工具(宿主侧读文件); novelcraft-writing skill 入库协议; scripts/m5-ingest-demo.mjs 全链冒烟
- [x] **Track 2 五面雷达 + 事件触发**: assistant 五面确定性扫描器(radar-ingest/dedup/suggest/risk 新文件 + plot 一句话摘要 plotSummaryLine)+ reconcileRadarSignals 对账层(health.ts 范式一般化)+ runRadarSweep; dsh radar-hooks(ingest/deep_import/adopt/generate 成功后自动对账 + 推送, §11)+ `novelcraft_radar_sweep` 工具; client watch/state 增 plotSummary, 宠物静默态点击显示当前剧情(§9 默认答复)
- [x] **Track 3 章节档案(§17.5.1)**: store.chapterDossier 纯读组装(Scene 分解/人物在场/POV/伏笔对账/设定引用/节奏, 容错降级); client chapter/dossier 端点(合并审查/信号/提案读面)+ ChapterDossier 视图; 剧情地图与写作台章节行钻取
- [x] **Track 4 内容手模型预设(N20)**: llm-step ContentPreset/种子预设 + ProviderRequest/StepRequest.overrides 增 provider 路由 + policy preset 键 + selectPresetInLlmYml(N19 单键写); dsh ContentPresetRegistry(domain KV presets 表∪种子)+ withResolvedDefaults/mergeStepOverrides 注入链(runStep/deepImport/propose/generate)+ DshProvider req.provider 直通; client presets/list+presets/select 端点与预设卡面板; 编排脑 = DSH 原生切换(零代码, 写进 novelcraft-core skill)
- 裁定: specs/adjudications.md 第四批 N18/N19/N20; 全仓测试 **368 全绿**, typecheck 零错误(HEAD e7209da0)

## M6 RAG 插件化分层(2026-08-14, 三层检索, 提交区间 2b73f871..209b633a 四笔)

- [x] **Track A1 L0 确定性召回 + 增量索引**: rag 包 BM25+字 bigram 词法召回(默认, 零 LLM 依赖);
  chunk 派生索引 .assistant/rag-index.json 增量同步(syncRagIndex); vault gitignore 增
  .assistant/rag-index.json(派生索引不提交 git, 可全量重建); chapters/pending 不入索引
- [x] **Track A1 收尾 L1 内容手精排**: llm-step 内置 spec `rag_rerank`(2048/temp 0.1/120s,
  schema `ranked_ids[]`)+ rag `rerankWithProvider`(默认开; 失败回退 BM25 原序, 检索不阻断写作)
- [x] **Track A3 检索工具 + 事件钩子**: dsh 第 13 工具 `novelcraft_rag_search`(root/query/top_k/
  rerank)+ adopt/ingest/deep_import 事件钩子(fireRagHook)增量维护索引; 结果带 degraded 字段
- [x] **Track B L2 可选 BGE 向量召回**: 新增第 16 包 `@novelcraft/rag-bge`(可选, dsh
  optionalDependencies + 动态 import, 缺包全链自动降级); llm.yml 设 `embedding: bge-local-v1`
  启用; 模型懒下载 `$DSH_HOME/novelcraft/models`(transformers.js 缓存层); 第 14 工具
  `novelcraft_rag_embed` 批量补向量(中断可重入); 向量 = rag-index.json 派生字段, 失败回退文本检索
- 裁定: specs/adjudications.md 第五批 N21/N22; 工具数 **12 → 14**; 全仓测试 **440 全绿**,
  typecheck 零错误(HEAD 209b633a)

## M7 review 修复批次(多模块 review 后续修复, 提交区间 2114657f..15e6c166 七笔)

- [x] **Phase A 文档同步**(2114657f): M7 批次基线(v4-flash 子代理 10 单元 + 汇总 review 后续
  修复: 契约漂移/文档滞后/审批门旁路)
- [x] **Phase D rag_rerank 预算转录**(1f617388, N24): rag_rerank 内容手预算转录
- [x] **Phase B 字段漂移**(7ff5747f, N14/N26): 对象写端统一 kind; 关系写面 N14 list 形态对象边对
  story-map/radar 可见; 结构与场景与 outline 必填补齐 reveal fail-closed; memory scene_id
  第二幂等键
- [x] **Phase C validateFrontmatter 接入写链**(90e3c4a7, N23): adopt/merge/world/outline/imports
  落盘前 fail-closed; validateFrontmatterForWrite 补 id=slug; writing 候选补 source/content_hash
- [x] **Phase E catalog 预算/温度/超时转录**(bc6644cc, N27): entity_extraction/structure_analysis
  预算/温度/超时转录 + 输入主导豁免清单 + specs-transcription 钉死测试
- [x] **Phase G writing 回执**(fb7408ad, N30): finding_id=finding_<sha256-20>; severity
  blocker/major/minor 摄入归一化; rejectFindingById; applyRevision 基线哈希校验
- [x] **Phase F 审批门收口**(15e6c166, N31): imports 结构资产落 draft 升格走审批门; dsh
  worldCreateGuarded/worldUpdateGuarded + facades.world 写存根 GateRequiredError
- 执行模式: 实现全部由 deepseek-v4-flash 子代理(workflow 编排, provider deepseek-official)
  完成, 主会话编排 + 逐 Phase diff 复核 + 全量门禁 + 提交
- 裁定: specs/adjudications.md 第六批 N23–N31(M7 占 N23/N24/N25/N26/N27/N30/N31;
  N28/N29 属并行的第七批 map-atlas 批次); 全仓测试 **517 全绿**, typecheck 零错误(HEAD 15e6c166)

## M7 map-atlas(世界地图册文件模型迁移, 提交区间 ddce06fe..Phase 6)

- [x] **Phase 0 契约**(ddce06fe): ADR-0020 + specs/assets/map-atlas.md + catalog §4.11(无生图)/
  §4.12(map_spatial_facts) + policy §9 + 裁定第七批 N28(不生图/prompt_only 不可 adopt/空页占位可 adopt)/
  N29(本地图片路径导入写边界, 图片 gitignore) + skills 预告 + 实施计划/移植锚点。
- [x] **Phase 1 文件基建**(ea251ed8): vault world.atlas/assistant.atlas 路径组 + gitignore images/;
  world map-atlas types/read/write(nodes/pages/pending/images/runs, guardPath+单 commit); 66 测试。
- [x] **Phase 2 上下文+空间事实**(5825baf1 + review 修复 4f765282): compileAtlasContext(canonical 地点 ≤20 /
  8000 字预算 / 确定性 context_hash) + extractSpatialFacts(批 5 / 白名单逐条丢 / 三桶分区 / 指纹复用 +
  checkpoint 续跑); catalog §4.12 精确口径。
- [x] **Phase 3 AtlasPlan 编排**(3b275244): planMapAtlas orchestrator(7 步 / update 无变化短路不调 LLM /
  fail-closed plan_validation_failed) + 校验器纯函数族(结构 8 条含⑦ M4 翻转父 rank>子 / 来源白名单 +
  open_target 逐字段 + working 不独撑 / 语义键 entity:{slug}+path:{父}:{sha256前20} / update 三规则);
  review 修 H1(prevManifest 排除本轮 run)/M3(budgetTokens=0 输入主导豁免, N27)。
- [x] **Phase 4 生命周期**(5f20c065 + d67be28f): adoptAtlasPage(CAS+有图门禁+conflicts 确认+祖先链原子
  adopt+approve fail-closed+单 commit) / adoptAtlasPlaceholder 空占位 / reject(review_ready 限定,
  prompt_only 拒) / archive(不硬删) / restore(祖先补齐+刷新 adopted_at) / updateAtlasPrompt /
  updateAtlasNode(新父必须 adopted); importAtlasImage(magic bytes PNG/JPEG+≤50MB+16~8192px+sha256,
  图片永不 git add); annotation CRUD(ann- 前缀/坐标 0–1/target 仅 adopted/hash 重算)。
- [x] **Phase 5 DSH 工具**(805a37a0): 6 新工具(14→20) map_atlas_plan(timeout 3600s, evidence_summary)/
  view/upload(附录 A.2 provisional 节点)/review(5 action 枚举收窄, adopt 类 ApprovalGate)/
  annotation(队列主路径 + base_content_hash CAS + 单 commit 原子, 规则 11)/update_prompt;
  FakeApproval 三态端到端。
- [x] **Phase 6 客户端+交付**: client wire/rpc atlas/view(读)+atlas/annotation-request(只落队列+信号,
  不写资产, 铁律 3) + MapAtlasAction(本次规划/我的地图册双 tab, 空页占位可点, 缺图态不渲染标签层,
  标签双击加/拖动/改名/删除 → 保存入队, 坐标恒 0–1) + scripts/m7-map-atlas-demo.mjs(全环可复现)。
- 全仓测试 **589 全绿**, typecheck 零错误; 每 Phase 独立 commit + 独立 review(发现均修复后提交)。

## 全代码库 Review 架构闭环(2026-08-15)

- [x] 用户确认第八批裁决 N32–N36：Vault 目标路径级 Git 事务、逐批 checkpoint/resume、DSH session/watch 生命周期与 ExecutionProfile、安全默认 capability API、M4 源码分发/Node/BGE optional 策略。
- [x] ADR-0021–0025 已实现并完成验证，关联 `docs/agent/reviews/full-codebase-review.md` §4。
- [x] 按依赖顺序完成 ADR-0021 → ADR-0023 ExecutionProfile 基础 seam → ADR-0022 → ADR-0024 → ADR-0023 session/watch 生命周期 → ADR-0025；全仓 `build`、`typecheck`、`npm test`、静态/分发/audit gates 与独立复审均通过。

## 「一切皆插件」架构优化(2026-08-25)

- [x] A–G 七阶段完成(工具层包装器/afterMutation 副作用唯一入口/核心包 UI 读面加法导出/
  service 瘦身/capabilities 数据驱动/包内工具组插件 + config.tools 开关/client 经
  service.ui 走 seam 去核心包运行时依赖); 每阶段独立 commit + 全仓 build/test/typecheck/
  distribution 全绿后推送。
- [x] 实证记录两处 cordis rc.8 行为: 嵌套 ctx.plugin 子插件构造器抛错被静默吞掉(默认组装
  因此保持同步注册); inject 缺服务 = 插件等待不启动(非报错)。
- [x] H: N32 全局 git transaction 收口(2026-08-25): commitScenesTx/applyAliasRelationChangesTx
  (executeCanonicalWrite 单事务原子 + faults 注入契约测试)、素材入库同步补偿回滚 +
  material intake 精确自动 commit、深导异常路径 state commit(checkpoint 事务化因 §8
  planSource bootstrap 限制主动放弃, 见交接 §7 条目 11)。

## 约定(继承 specs/README.md 与设计文档 §15)

- 行为契约 + trace contract + vitest mock seam; 核心包零 DSH 依赖, DSH 接触面
  唯一收敛在 @novelcraft/dsh;
- 旧引擎(novelAssist-dsh 侧)已退役, 归档 tag `old-engine`; ai-writing-assist main 的旧引擎保留 + 旧数据不迁移(D15); 新工作一律在 novelAssist-dsh 的 main 提交, push origin;
  **禁止反向改动父仓库 ai-writing-assist(含其 main, 用户指示, 2026-08-14)** —— 只读。

## M10 起后续批次(2026-08-31 制定, 权威计划见 `后续开发计划.md`)

排序依据台账 §6.24(按用户效果); 所有任务受 `后续开发计划.md` §0 插件边界纪律统领
(core 只加法 / capability 三分归位 / 新工具走工具组插件 + 同步四处 / 模型可见⟺可回放)。

- [x] **M10 P0 收口轮**(2026-08-31 完成, 三 Track 各附整批 review + 修复; 裁定 N38–N41):
  - [x] Track A LLM 内容步 runtime 收口(§6.23, A1–A6 全 ☑): schema 文本注入(system 槽
    OUTPUT_CONTRACT)+promptBody 加法+journal/回执指纹(promptHash/schemaInjection/
    effective 参数)+DshProvider readiness(listProviders live 目录 fail-closed)。
    review: 1×P1(工具零值吞没)+7×P2 全修(N39)。
  - [x] Track B 长任务恢复面(§6.9/§6.6, B1/B2/B5 ☑): workflow 工具组 4 工具(inspect→
    read; resume/start_new/abandon→adoptGuarded)+completed replay 显式化(force 时间戳
    +随机熵)+同步四处(矩阵 25)。review: P0(abandon 路径穿越)+4×P1+6×P2 全修(N40):
    单段校验+枚举存在性双门、R17 staged 门禁、resume 三重前置+执行后对账。
  - [x] Track C 写面收敛(C1 ☑ / C2 ◐ / C3 半项): store 加法 hasStagedOutside(只挡预存
    staged)+四处写面门禁(generate 双门禁)+refreshIndex 死写删除。review: 2×P1+6×P2
    全修(N41): rename AND 语义、门禁位置、单测矩阵。
  - 后置独立增量(N40/N41 记录): B3 deep-import job 托管(ADR-0023)+B4 client 工作流卡;
    RAG change plan→fresh 零写; signal CAS 强化; 其余裸 commit 点门禁。
- [x] **M11 多书生命周期**(2026-08-31 完成, N42 + review 修复): book 工具组 3(list→read;
  create/open→adoptGuarded) + bindRoot:'none' 第三模式(未绑定可用的首绑入口) + client
  workspacePath 旁路删除 + 守望生命周期驱动(binder deactivatedRoot + NodeRuntime 透传)。
- [x] **M12 生成域与证据链接线**(2026-09-01 完成, N43-N47):
  - M12-a: world_create/world_update 工具(N31 能力入口化, entity_type 白名单)。
  - M12-b: outline preview/apply 拆分(core preview.ts 暂存 proposals 不写资产 → apply
    审批后白名单透传 canonical 写) + 9 工具(outline×4 + world 生成中心×5, §6.17/6.18.2);
    kind enums(object 层收紧 + imports 归一化缝合 deep-import 链) + slug 坍缩区分。
  - M12-c: context 编译器进写作链(N45, Tier P0-P4 预算编译, review P0 空壳输入修复);
    memory 读面接线(N46, dossier 按故事顺序投影; 写点按 §6.18.4 reserved 裁定回撤);
    RAG typed result(N47, total/truncated/recall_capped + open_target)。
  - 39 工具/16 包全绿; 各切片独立 review + 修复(P0×2/P1 若干全闭, 追记 N43-N47)。
- [ ] **M12 生成域与证据链接线**(切片级, 依赖 M10-A): outline/world 生成中心工具组
  (preview→propose, apply→adoptGuarded)、世界书 draft→publish、memory/context 接线、
  RAG current-source typed result + open target、穿插体验迭代(交接 §7 条目 10)。
- 明确不做: RP(D23)/对象图片(D19)/带批注 .docx(D20)/站内生图(ADR-0020)/多用户云同步/
  统一 timeline service(§6.18.6)/回收站(§6.13.6)。
