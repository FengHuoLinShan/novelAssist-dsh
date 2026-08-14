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

## 约定(继承 specs/README.md 与设计文档 §15)

- 行为契约 + trace contract + vitest mock seam; 核心包零 DSH 依赖, DSH 接触面
  唯一收敛在 @novelcraft/dsh;
- 旧引擎(novelAssist-dsh 侧)已退役, 归档 tag `old-engine`; ai-writing-assist main 的旧引擎保留 + 旧数据不迁移(D15); 新工作一律在 novelAssist-dsh 的 main 提交, push origin;
  **禁止反向改动父仓库 ai-writing-assist(含其 main, 用户指示, 2026-08-14)** —— 只读。
