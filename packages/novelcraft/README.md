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
| R1–R5 核心包 | ✅ 11 包 192 测试全绿 | vault/store/llm-step/writing/imports/world/outline/memory/context/rag/assistant |
| R6 assistant | ✅ 核心(信号/收件箱/校准/微工作流 6 条) | radar 调度面 = 挂载阶段 |
| 挂载阶段(A, ADR-0017) | ✅ `@novelcraft/dsh` 适配包 31 测试全绿 + `scripts/m5-mount-demo.mjs` 全链 | 见 `dsh/README.md` seam 适配矩阵 |
| R7 client(B v1) | ✅ `@novelcraft/client` 双面包: 宠物四态 + 收件箱(四动词/键盘流)+ loopback RPC, 8 测试 + tsdown 构建链 + 真实 web 端到端 | client/README.md; 写作台四模式留后续迭代 |
| trace contract(C, §15) | ✅ `@novelcraft/trace`(trace/assert/mock)+ `imports` 的 `runDeepImport` 编排 seam | 见 docs/agent/dsh-rebuild/trace-contract-验收.md |
| 发布 | 📋 preset 已平移 + starter 已备 | starter/README.md |

## DSH 挂载阶段 seam 契约

以下契约在挂载阶段(A)已由 **`@novelcraft/dsh`** 实现(核心包接口未回头改动),
实现与测试见 `dsh/README.md` + `dsh/test/`:

| seam | 接口形状 | 归属包 |
|---|---|---|
| LLM 真 provider | `DshProvider`(llm-step `Provider`): `complete(req)` 内部转 DSH `ctx.llm` 调用; model/temperature 取自 ResolvedPolicy/overrides | `@novelcraft/dsh` llm 适配层 |
| 凭据 | DSH credentials 子系统读取 Key; `.assistant/llm.yml` 只存预设名与参数, 不存 Key(D13/§22.5) | `@novelcraft/dsh`(消费面) |
| 审批 | `ApprovalGate.request(agent, {action, summary, items}) → allowed-once/rejected`(包 DSH approval 服务, fail-closed) | `@novelcraft/dsh` 审批门 |
| 长任务/守望 | 雷达调度 → DSH `ctx.jobs`(每雷达一轮 = 一个 job)+ 可选 interval(D6 默认关); goal 归 DSH 会话级 goal | `@novelcraft/dsh` 雷达调度 |
| 会话/工作区绑定 | 每书一个 DSH session 绑定一个 vault 根(D17); 子代理 prompt 注入书名/路径(§14) | `@novelcraft/dsh` vault 绑定 |
| 存储索引 | `rebuildIndex` 产物 → novelcraft domain KV(可选持久化); 文件仍为唯一真相(§22.2) | `@novelcraft/dsh` storage 缓存 |
| 工具面 | `ctx.tools`: 20 工具: llm_step / store_index / store_adopt / inbox_view / inbox_act / signal_push / deep_import / propose_next_chapter / health_scan / generate_next_chapter / ingest_file / radar_sweep / rag_search / rag_embed / map_atlas_plan / map_atlas_view / map_atlas_upload / map_atlas_review / map_atlas_annotation / map_atlas_update_prompt（store_adopt 与 map_atlas_review 的 adopt 类动作审批门控 / inbox_act 四动词 / deep_import 六阶段 adopt 经审批门 + trace 落盘 + 完成后 state commit 收 checkpoint/trace 进 git; tools 服务缺失时静默跳过） | `@novelcraft/dsh` tools |
| client UI | client-modules 注入: 宠物/收件箱/写作台读 `.assistant/signals/*.json` 与 reviews(§17); 动作回调走核心包的确定性函数 | client 包(B 阶段) |
