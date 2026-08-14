# M4 重构开发状态(codex/m4-dsh-plugin-rewrite)

## 位置

- worktree: /Users/tywww/Desktop/项目/ai-writing-assist-m4-rebuild
- 分支: codex/m4-dsh-plugin-rewrite(tracking origin/main, 基点 a257df23e)
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
- [ ] client 后续迭代: 写作台四模式 / 剧情地图 / 信号主动推送(轮询→mux 事件)
- [ ] trace contract 测试框架(C): 纯仓库工作, 设计文档 §15
- [ ] 仓库迁出: 分支 → 独立 fork deepseek-harness 新仓库(ADR-0017 §1, 时机待定)
- [ ] 旧引擎退役仪式(ai-writing-assist main, 时机另行裁决)

## 约定(继承 specs/README.md 与设计文档 §15)

- 行为契约 + trace contract + vitest mock seam; 核心包零 DSH 依赖, DSH 接触面
  唯一收敛在 @novelcraft/dsh;
- 旧引擎保留, 旧数据不迁移(D15); 本分支不进 main(ADR-0017)。
