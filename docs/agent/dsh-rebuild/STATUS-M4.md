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
- [x] **client 阶段(B) v1**: `@novelcraft/client` 双面包(宠物四态 + 收件箱四动词/
  键盘流 + `/novelcraft` loopback RPC)8 测试全绿 + tsdown 构建链 + 真实 web 端到端
  (boot 清单/bundle 200/playwright 浏览器零错误); 验收快照见
  docs/agent/dsh-rebuild/客户端阶段-验收.md。全仓 **231 测试全绿**。
- [x] **trace contract 测试框架(C)**: `@novelcraft/trace`(trace/assert/mock, 17 测试)+ `imports` 的 `runDeepImport` 编排 seam(11 测试); 全仓 **259 测试全绿, typecheck 零错误**; 验收见 docs/agent/dsh-rebuild/trace-contract-验收.md
- [x] **C 的 DSH 挂载收尾**: `@novelcraft/dsh` 新增 `deepImport` 便捷方法 + `novelcraft_deep_import` 工具(runtime.provider=DshProvider、approve=ApprovalGate fail-closed、trace=ImportTraceSink 落 .assistant/import-trace.jsonl), 3 测试
- [x] **client 迭代**: 剧情地图(`store.storyMap` + story/map 端点 + StoryMapAction)+ 写作台四模式(writing/desk 端点 + WritingDeskAction, 守望/计划/评审/参照 tab), 4 测试; 全仓 **304 测试全绿, typecheck 零错误**; 验收见 docs/agent/dsh-rebuild/client-迭代-验收.md
- [x] 信号主动推送(轮询→mux): ADR-0018 定 DSH 共享层政策; 短轮询过渡 + 真 mux 推送均已落地——scripts/apply-dsh-patches.mjs 加 client/push allowlist + @novelcraft/dsh emit + @novelcraft/client ctx.remote.$on 订阅(seam 提案见 信号推送-远程事件seam提案.md); 上游 Discussion #1289 回应后去 fork 化
- [x] 仓库迁出: codex/m4-dsh-plugin-rewrite → 独立仓库 novelAssist-dsh(annotated tag `dsh`, 2026-08-14)
- [x] **结构资产统一关系模型(ADR-0019)**: Accepted + P0–P3 全落地——`validateRelations`/`assertValidRelations`(7 type 枚举 + 源/目标白名单 + 自环/悬空/端点 kind, 写链硬错)、结构资产 schema `relations: 'list'`、`VaultIndex.relations` 全资产有向图(`sourceKind` 标注源)、`storyMap().edges`(显式边 + `related_*_ids` 兼容投影并集去重, N17)、`planned_payoff_scene` 兑现 #11 slug、reveal required 放宽(「未归类」=「无边」); 剧情地图三缺口关闭, 验收见 client-迭代-验收.md
- [x] **旧引擎退役(novelAssist-dsh 侧)**: 本仓库携带的 FastAPI/PG/Vue 旧引擎副本(backend/frontend-console/deploy/docker/docker-compose/Makefile/start.sh/tools/workflows + 旧 docs 与顶层旧文档)已删除, 归档于 annotated tag `old-engine`; 仓库现为纯 M4 DSH 插件 monorepo(重写 README/AGENTS/CLAUDE + 最小 ci.yml)
- [x] **续写提案第二阶段验收(fail-closed)**: 新增 `dsh/test/continuation-e2e.test.ts` 6 条端到端契约(计划台提案 → 正文候选 chapters/pending → 审批门控采用; allowed-once 放行 + rejected/cancelled/unavailable 三态拒绝, 铁律 3/5); 口径修正: 候选采用 kind=`chapter_candidate`(copy-on-adopt R34); dsh 42 测试, **全仓 310 测试全绿, typecheck 零错误**; 验收见 docs/agent/dsh-rebuild/续写提案-验收.md
- [x] **剧情地图关系边 UI**: StoryMapAction 新增「关系边」Section(按 7 type 分组 + 彩色徽章 + 未知 type 兜底, deprecated 删除线弱化, 中英双语 story.edge.*), 纯展示零写操作; 浏览器级核验: scratch boot + @novelcraft/client bundle 200 + 控制台/页面/请求错误 0, 截图 /tmp/nc-web.png(Modal 自动点击受 scratch GUI 工作区引导门限, 读图待确认)
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

## 约定(继承 specs/README.md 与设计文档 §15)

- 行为契约 + trace contract + vitest mock seam; 核心包零 DSH 依赖, DSH 接触面
  唯一收敛在 @novelcraft/dsh;
- 旧引擎(novelAssist-dsh 侧)已退役, 归档 tag `old-engine`; ai-writing-assist main 的旧引擎保留 + 旧数据不迁移(D15); 新工作一律在 novelAssist-dsh 的 main 提交, push origin;
  **禁止反向改动父仓库 ai-writing-assist(含其 main, 用户指示, 2026-08-14)** —— 只读。
