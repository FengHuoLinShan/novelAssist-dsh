# M4 重构开发状态(codex/m4-dsh-plugin-rewrite)

## 位置

- worktree: /Users/tywww/Desktop/项目/ai-writing-assist-m4-rebuild
- 分支: codex/m4-dsh-plugin-rewrite(tracking origin/main, 基点 a257df23e)
- 治理文档: docs/adr/0016-m4-dsh-plugin-rewrite.md(Accepted)、
  docs/agent/dsh-rebuild/自主智能式作家助手设计.md(决策 D1–D25)
- 旧 dsh-rebuild worktree: 仅保留为历史/参考; 其残留改动不动(用户指示); 侧车 ADR 已标 Superseded

## 进度

- [x] ADR-0016 Accepted(在 dsh-rebuild 中为 0015, 入新分支取号 0016 避撞)
- [x] specs/ 骨架(README + assets 模板)
- [x] R0 资产 schema 提取: 5 份规格已产出并抽验(specs/assets/*.md, 共 2834 行)
- [x] R0 prompt/spec 目录提取: specs/prompts/catalog.md(32 spec, 已抽验)
- [x] R0 规则目录提取: specs/rules/{store-rules,policy-defaults}.md(已 QA)
- [x] 18 条落点裁定已确认(specs/adjudications.md, D26)
- [ ] R0 规则目录提取(merge/去重/CAS/世界书 lifecycle/降级条款 → policy.yml 默认值)
- [x] R1 内核完成并集成验收: vault 29 测试(dist 发布, N9/N10/N12)+ store 68 测试
  (frontmatter/adopt/merge/dedup/index/health/git, R1–R64 可测规则全覆盖); 根
  workspaces 97/97 全绿, typecheck 零错误; 两包经 vault dist 直接依赖, 无 alias 残留
- [x] R2 完成: @novelcraft/llm-step(19 测试)
- [x] R3 完成: writing 垂直切片闭环(15 测试 + r3-demo); store chapter 采用语义修正
- [x] R4 完成: imports 全六阶段 + L0–L3 去重 + 恢复(19 测试 + r4a/r4b demo)
- [ ] R5 其余领域(部分先行: memory 5 测试 / assistant 核心 11 测试)→ R6 → R7 client + 发布

## 约定(继承 specs/README.md 与设计文档 §15)

- 行为契约 + trace contract + vitest mock seam; 只写规格不写代码;
- 旧引擎保留至 R4 后退役; 旧数据不迁移(D15)。
