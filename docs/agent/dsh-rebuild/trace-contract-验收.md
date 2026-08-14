# trace contract 测试框架 C 验收快照

- 日期: 2026-08-14(迁移后, novelAssist-dsh / main)
- 范围: 设计文档 §15「Trace contract」——新增确定性编排 seam `runDeepImport` +
  叶子包 `@novelcraft/trace`(零运行时依赖)。本轮只交付纯 TS seam, 不接 DSH 挂载适配。
- 实现:
  - `packages/novelcraft/trace`(新包): src/trace.ts(TraceEvent 判别联合 + TraceRecorder)、
    src/assert.ts(策略断言 DSL)、src/mock.ts(MockApproval + policy 默认值加载)、test/trace.test.ts
  - `packages/novelcraft/imports/src/orchestrate.ts`(加法): `runDeepImport(root, plan, runtime)`
    顺序串起六阶段; 依赖加 `@novelcraft/trace`; index.ts 导出新函数
  - `packages/novelcraft/imports/test/trace-contract.test.ts`: MockProvider + MockApproval
    跑 runDeepImport, 断言 §15 不变量

## 形态决策(与用户确认, 不重问)

1. 形态 A: 新增确定性编排 seam `runDeepImport` + trace 框架。
2. trace 框架放新叶子包 `@novelcraft/trace`(零运行时依赖)。
3. 本轮只交付纯 TS seam, 不接 DSH 挂载适配(skill 引用 runDeepImport 留后续)。

## 事件词表

begin_import / stage_candidates / checkpoint / llm_step / degradation / approval /
adopt / reject / complete_import(9 类, 判别联合, TraceRecorder 内存追加、有序)。

## 断言 DSL

- `assertOrdered(trace, before, after)`
- `assertEveryAdoptApproved(trace)`(每个 adopt 前必有 approval=allowed-once;
  rejected/unavailable 后不得有 adopt)
- `assertCheckpointAfterPhase(trace, phases)`
- `assertShardsWithinPolicy(trace, policy)`
- `assertDegradationClauses(trace, clauses)`

## 锁定的不变量(依据)

| 类 | 不变量 | 依据 |
|---|---|---|
| 顺序 | begin_import 先于 stage_candidates, stage_candidates 先于 adopt | §15、§12 |
| 审批 | adopt 必过 approval, fail-closed, 拒绝则无 commit | §9、§15、ApprovalGate |
| checkpoint | 每 phase 后必有 checkpoint; 续跑按 input_fingerprint 幂等 | §15、R42/R43 |
| 分片 | 批大小在 policy 上限内(1a 50 / 2a 12 / 2b 4) | specs/rules/policy-defaults.md |
| 降级 | 1b 空语义进复核 / 2b 只降级不丢对象 / 1a 整章 fallback 不部分采用 / 去重失败降级 | R52–R55、PLAN.md |
| 授权 | authorization_confirmed 强制 true、快照不可变、同 scope 幂等 | plan.ts、R42 节 |

## 验证矩阵(全部通过)

| 层 | 方式 | 结果 |
|---|---|---|
| 框架自测 | @novelcraft/trace vitest 17 条(记录器有序 + 断言 DSL 正反例 + MockApproval fail-closed + policy 默认) | ✅ |
| 编排行为契约 | @novelcraft/imports trace-contract 11 条(顺序/审批/checkpoint/分片/降级/授权) | ✅ |
| 全仓回归 | npm test 259 全绿 / npm run typecheck 零错误 | ✅ |

## 测试矩阵(全仓)

| 包 | 测试 | 包 | 测试 |
|---|---|---|---|
| vault | 29 | world | 6 |
| store | 68 | outline | 7 |
| llm-step | 19 | memory | 5 |
| writing | 15 | context | 5 |
| imports | 30 | rag | 4 |
| assistant | 15 | client | 8 |
| dsh | 31 | trace | 17 |
| **合计** | **259** | | |

## 复现

```sh
cd /Users/tywww/Desktop/项目/novelAssist-dsh
npm install
# 按拓扑序构建(workspaces 并行构建会因 dist 依赖顺序失败):
# vault→trace→store→llm-step→rag→memory→context→assistant→outline→world→writing→imports→dsh
npm test            # 259 测试全绿
npm run typecheck   # 零错误
```

## 边界与后续

- 只交付纯 TS seam; DSH 挂载适配(skill 引用 runDeepImport、ApprovalGate 注入 runtime.approve、
  trace sink 接 DSH 审计/日志)留后续。
- 去重失败降级(dedup_failed)条款在 trace 框架自测覆盖; runDeepImport 六阶段序列不含
  dedupReport/applyDedup(去重是独立步骤), 故编排测试锁定 1a/1b/2b 三条降级。
