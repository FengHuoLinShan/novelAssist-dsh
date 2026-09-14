# M14-B 导入恢复语义对照报告与裁定草案(2026-09-14, 基线 `4db3df9b6`)

> 后续开发计划 §4h 批 B(H-B1..H-B4)产出。对照锚点: 父仓 `29a1a174b`(bounded review
> resolution)+ `424749166`(可恢复定向补全)及当前实现/测试(以 HEAD `4db3df9b6` 为准,
> commit 只作历史锚点);本仓 `imports/src/{recovery-protocol,run-engine,git-run-persistence,
> deep-import-workflow}.ts` + `dsh/src/` 四工具与 job 托管及 N40/M13-C 测试;本仓 ADR-0022
> 只作应然合同不代替实现。父仓全程只读(铁律 8);两仓 ADR-0018–0024 同号不同义,引用必带仓限定。
> 批 B 验收纪律: 不将父仓 PostgreSQL task/run 表复制到本仓;不把「有 resume 方法」当作语义
> 对齐;结论必须带中断点、provider/审批计数、持久化字节或 Git 证据。实缺口边界
> (2026-09-14 讨论裁定): 纯加法 vault 文件/字段可进,事件账本/时间线模型/数据库/队列等价物
> 一律 deferred。本文 §4 为裁定草案: **用户采纳后才誊入 `specs/adjudications.md` 并分配 N 号**。

## 1. H-B1 冻结对照面(证据摘要, 全锚点在子代理取证记录)

**父仓侧**(imports 域): 身份=`import_workflow_runs`(workflow_id==task_id,每项目一活动 run
部分唯一索引,coalescing reuse_active);授权=`build_authorization_snapshot` **持久化可复用**
(targeted `freeze_completion_permission` 冻 source_manifest+hash+roots+范围+max_depth=1;
executor_grants 允许同授权换 task 禁改范围);cursor=run.checkpoints/progress JSON 列 +
targeted `root_position`/`next_batch` + resolution 组级 judgment 缓存;provider unknown=
context snapshot 留 running、120 分钟维护转 stale、`transport_retries=False`;apply=submit
逐 item 过审→suggestion→apply expected_preview_hash CAS + author_decision 按 candidate
fingerprint CAS(decision_key 幂等);rollback=逆序撤销 packages + receipts 落库,冲突计数
→partial,无需 recovery 状态;secret-free snapshot(provider/model/hash,Key 不落 task.meta)。

**本仓侧**: 身份=确定性内容寻址(workflowId=`<imp|atlas>-<fingerprint16>-<uniqueRunId>`,
batchId 确定性派生,expected-absent 唯一权威);授权=ApprovalGate allowed-once **不落盘**
(resume 只弹 remaining∪outcome-unknown 批,窗口〇重试必须重新授权);cursor={phase,ordinal}
严格前向,双工件 run 目录 + `.assistant/checkpoint.json` + import-trace.jsonl,loadRunState
收敛 intents + 与 HEAD 已提交字节逐文档对账;provider unknown=manifest 写
provider_outcome_unknown 携 budgetSpent 停止,绝不自动 retry,重试需重新 allowed-once 且
预算恢复预扣;apply=waiting_approval→applying(durable txid)→applied 状态机 +
ADR-0021(本仓)canonical 事务 + probe 三态收敛;四崩溃窗口显式状态机(窗口〇/一/二/损坏,
git 崩溃注入测试);**无 rollback 概念**(撤销面=git 历史);secret 词表拒绝 + Key 只走
DSH credentials(铁律 6)。

## 2. H-B2 语义矩阵(12 轴; 档=本仓相对父仓)

| # | 轴 | 档 | 要点(证据见 §1 锚点) |
|---|---|---|---|
| 1 | 任务/批次身份 | equivalent | 父仓 task_id+唯一索引+coalescing;本仓内容寻址 workflowId/batchId+expected-absent。同输入恒同 ID 两边都成立 |
| 2 | 冻结输入与授权 | equivalent(形态差) | 父仓授权 snapshot 持久可复用(同授权换 task);本仓 allowed-once 不落盘、resume 只弹剩余批——保守姿势系 N40/本仓 ADR-0022 已裁定,不作缺口 |
| 3 | 证据粒度 | equivalent | 父仓 source_refs+quote 唯一定位;本仓 sourceIds/sourceHashes+ApplyRecord 字节级 expected CAS |
| 4 | checkpoint/cursor | equivalent | 父仓 run JSON 列+next_batch+judgment 缓存;本仓双工件+严格前向 cursor+字节对账。父仓 progress JSON 损坏静默回退且无测试(父仓侧弱点,不作对齐依据) |
| 5 | provider unknown | **stronger(本仓)** | 本仓 unknown 是一等终态+预算记账+重新授权门;父仓靠 120 分钟维护流程转 stale |
| 6 | 四崩溃窗口 | **stronger(本仓)** | 本仓窗口〇/一/二/损坏显式状态机+git 崩溃注入测试;父仓是通用 lease fence+域 reconcile,无窗口级形式化 |
| 7 | apply/审批 | equivalent | 父仓逐 item author_decision(fingerprint CAS);本仓批级审批+durable txid 状态机。逐条分辨率差属于评审 UX 域,越出恢复语义对照面(见 §4 不评注记) |
| 8 | partial/deferred/ambiguous | equivalent | 父仓 defer 是一等运行状态(defer-resume);本仓中断+resume 同效(续剩余),deferred 仅「候选不采用」语义——用户效果等价 |
| 9 | resume/start-new/abandon/rollback | **weaker(本仓, 仅 rollback)** | resume/start-new/abandon 三动作语义齐备(三重前置/force 新 ID/kill 前置+R17 门禁);**rollback 无此概念**——父仓有运行时逆序撤销(receipts 落库、e2e 锁「undo 保留作者后来编辑」),本仓撤销面=裸 git 历史 |
| 10 | CAS/幂等 | equivalent | 父仓条件更新+preview_hash CAS;本仓字节级 expected+预存 staged STAGED_CONFLICT(约束更严,注记) |
| 11 | secret 零落盘 | equivalent | 父仓 secret-free snapshot+Key 不落 task.meta;本仓 secret 词表拒绝+Key 只走 DSH credentials |
| 12 | 作者回执 | equivalent | 父仓 task 投影 API+review-summary+proactive 通知;本仓句柄即返+followup/inject 三通道+trace+inspect |

## 3. H-B3 最小行为证据(两仓已提交 focused tests; 父仓只读)

| 行为 | 父仓证据 | 本仓证据 | 档 |
|---|---|---|---|
| 已完成单元不重跑 | test_targeted_completion.py:440;test_review_resolution.py:88/:174;test_workflow_orchestration.py:686/:710;test_workflow_runs.py:110 | run-engine.test.ts:446/:472;git-run-persistence.test.ts:583;deep-import-workflow.test.ts itSlow(provider 5→10 只补 2a 后) | equivalent |
| 未明确/过期授权 fail-closed | test_targeted_completion.py:165;test_completion_control.py:76;world test_review_resolution.py:65/:83;imports test_review_resolution.py:244(注:「时间性过期」无实现无测试,失效全来自 fingerprint 漂移) | run-engine.test.ts:336/:363/:587;dsh deep-import.test.ts:430(弹窗恰好一次);workflow-tools.test.ts:212 | equivalent |
| 中断后只续剩余 | test_targeted_completion_integration.py:294/:384/:351/:498;test_completion_control.py:24/:101 | run-engine.test.ts:446;窗口链 :384/:411/:430;git-run-persistence.test.ts:417/:436/:458 | equivalent |
| 重复请求不重复采用 | test_targeted_completion_integration.py:195;test_targeted_completion.py:40;test_workflow_runs.py:168/:211/:344;e2e test_review_resolution_concurrency.py:25 | run-engine.test.ts:616/:472/:665;trace-contract.test.ts:355/:292 | equivalent |
| 损坏现场保留 | integration :425/:572;e2e :83/:130;world :21/:128/:185;test_scene_commit.py:105/:136/:519/:562;abandon test_workflow_orchestration.py:775/:802 | run-engine.test.ts:485/:501;git-run-persistence.test.ts:531/:544/:558/:474/:488/:504/:521;recovery-protocol.test.ts:84/:98;workflow-tools.test.ts:317/:301 | equivalent |

**测试薄弱如实标注**: 父仓——`imports_completion_review` 提醒发布路径无直接测试、
progress JSON 损坏回退分支无测试; 本仓——「resume 且全部 completed→零范围授权重收尾」
dsh 侧无直接测试(仅注释与 inspect 语义)、durable driver materialize 幂等命中与
「completed run 经工具整体重放不双写」无专门端到端测试。薄弱不构成缺口裁定依据,
记观察。

## 4. H-B4 裁定草案

1. **主体结论: 无需对齐行动。** 12 轴中 11 轴 equivalent(其中 provider unknown 与
   四崩溃窗口本仓 stronger),五行为全部 equivalent 且两仓均有测试锁定。父仓
   PostgreSQL task/run 表模型不复制(批 B 验收纪律);授权持久化(executor_grants/
   同授权换 task)不引入——本仓 allowed-once 不落盘是 N40/本仓 ADR-0022 已裁定保守姿势;
   defer 一等运行状态不引入(本仓中断+resume 用户效果等价);逐 item author_decision
   分辨率不评(属评审 UX/世界审查域,越出本对照面,如需另立议题)。
2. **唯一实缺口候选: 领域化 rollback(撤销一次已完成 run 的采用)。** 当前 weaker
   (§2 轴 9): 父仓可逆序撤销 packages 且 e2e 锁定「undo 保留作者后来编辑」,本仓只有
   裸 git 历史,作者无法领域化识别并撤销「某次导入/补全 run 的采用结果」。满足实缺口
   三条件: ①减少重复 provider/采用(撤销错误采用免于人工翻历史重建甚至重跑导入);
   ②不引入数据库/队列——纯加法可实现: 读 run 工件(manifest/receipt/trace)确定性识别
   该 run 的精确 commit 序列,以**新 commit revert**(不 rewrite 历史,铁律 2 git 即
   回滚面);③与既有面同构: revert 预检冲突即 fail-closed 保留现场(照窗口三姿势),
   回执=新 revert commit hash + 冲突清单。
3. **若采纳**: 另立实施子批(建议名 `workflow_rollback`,命名随批裁定): 工具加法
   (workflow 组第 5 工具需过 §0 纪律——39 工具清单/MATRIX/preset/README seam 矩阵同步,
   或裁定为 inspect 子动作以保 39 面, 二选一);v1 范围限 deep-import/atlas 已完成 run,
   要求 run 目录与 checkpoint 可绑定、HEAD 线性、run 后无外部提交混入 writeSet,
   冲突 fail-closed;测试必须含「undo 保留作者后来编辑」负例(父仓 e2e 同款语义)。
4. **若采纳后仍判定价值不足**(git revert 已够用): 则批 B 文档收口,记重开条件
   (出现「作者误采用后人工翻历史」的真实摩擦记录)。
5. **明确不做**: 不复制父仓 task/run 表;不引入授权持久化/executor_grants;不引入
   defer 一等状态;不把父仓 progress JSON 静默回退、授权时间性过期缺失当作本仓参照
   (父仓侧弱点,反向参照)。

## 5. 裁定入口

本文 §4 为草案。用户采纳/修改后: 誊入 `specs/adjudications.md` 分配新 N 号;
采纳 §4.2 → 另立 rollback 实施子批;采纳 §4.4 → 批 B 文档收口。
