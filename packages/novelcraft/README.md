# packages/novelcraft

M4 插件族 monorepo(ADR-0016 §22.3)。核心规则: **插件核心逻辑 = 纯 TS 确定性库
(不依赖 DSH 运行时, 可用 vitest 直测); Cordis/DSH seam 适配层后置(R1 不写)**。

## R1 范围(内核)

| 包 | 职责 | 规格来源 |
|---|---|---|
| `vault` | 工作区初始化、路径规范、读写门禁 | specs/rules/store-rules.md §8 + specs/adjudications.md N1/N2 + 设计文档 §22.2 |
| `store` | frontmatter 校验、adopt+commit、CAS、merge/split/attach_alias、索引重建 | specs/rules/store-rules.md R1–R64(可测部分)+ specs/adjudications.md 两批 |

## 工程约定

1. 纯 TS, strict 模式; 无 DSH 依赖(R1 阶段); git 操作用 `node:child_process` 调 git CLI。
2. 测试 = vitest, 每个行为契约一条测试, 断言写进测试注释引规则编号(R#)。
3. 索引 = 纯函数「扫描文件 → 索引 JSON」; sqlite/ctx.storage 适配层留到插件挂载阶段。
4. 所有写操作先校验再落盘; adopt 前检查工作区脏状态(CAS)。
5. 资产 frontmatter 字段表以 specs/assets/*.md + specs/adjudications.md 为唯一权威。

## 阶段进度

| 阶段 | 状态 | 计划 |
|---|---|---|
| R0 Spec 提取 | ✅ specs/(assets/prompts/rules + 两批裁定) | — |
| R1 内核 vault/store | ✅ 97 测试全绿 | — |
| R2 llm-step | 🔄 实现中(重派发: 内置 schema 校验器, 零网络依赖) | — |
| R3 writing 垂直切片 | 📋 计划 | writing/PLAN.md |
| R4 imports 六阶段 | 📋 计划 | imports/PLAN.md |
| R5–R7 | 📋 计划 | 后续阶段-PLAN.md |

## DSH 挂载阶段 seam 契约(R6/R7 前置, 现在定清)

以下适配器**本阶段不实现**(保持核心零 DSH 依赖), 但接口形状现在定死, 后续
挂载阶段照此实现, 核心包不得回头改接口:

| seam | 接口形状 | 归属包 |
|---|---|---|
| LLM 真 provider | `Provider`(llm-step 的接口): 实现 `complete(req)` 内部转 DSH `ctx.llm` 调用; model/temperature 取自 ResolvedPolicy | llm-step 适配层 |
| 凭据 | DSH credentials 子系统读取 Key; `.assistant/llm.yml` 只存预设名与参数, 不存 Key(D13/§22.5) | llm-step 适配层 |
| 审批 | `ApprovalGate.request({action, summary, items}) → allowed-once/rejected`(包 DSH approval 服务, fail-closed) | store 适配层 |
| 长任务/守望 | 雷达调度 → DSH `ctx.jobs`(每雷达一轮 = 一个 job)+ `ctx.schedule`(低频巡检, 默认关 D6)+ goal(整体目标) | assistant 适配层 |
| 会话/工作区绑定 | 每书一个 DSH session 绑定一个 vault 根(D17); 子代理 prompt 注入书名/路径(§14) | vault 适配层 |
| 存储索引 | `rebuildIndex` 产物 → `ctx.storage` domain KV(sqlite)的可选持久化; 文件仍为唯一真相(§22.2) | store 适配层 |
| client UI | client-modules 注入: 宠物/收件箱/写作台读 `.assistant/signals/*.json` 与 reviews(§17); 动作回调走核心包的确定性函数 | client 包 |
