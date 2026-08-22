# ADR-0022 — 可恢复工作流运行(逐批 checkpoint + resume, 不重跑已完成批次)

- **状态**: Accepted(2026-08-15, 用户确认裁定 N33); **implemented and verified**
- **日期**: 2026-08-15
- **取代/补充**: 补充 ADR-0021(事务)与 ADR-0020(地图册 run 文件)之上的一层: 长工作流
  (deep_import 六阶段、多章生成)的持久化断点与恢复协议。**不取代**任何现有 ADR。
- **设计依据**: N33(2026-08-15 用户确认; 已录入 `specs/adjudications.md` 第八批)、
  ADR-0021(writeSet 事务 + **durable transaction intent + recovery path 契约**; 本 ADR
  只引用该契约的语义, 不重复定义)、ADR-0020(`.assistant/atlas/runs/` 文件模型)、
  ADR-0016 §2(文件唯一真相 + git 回滚面)、`packages/novelcraft/imports`
  (`runDeepImport` seam)、`packages/novelcraft/dsh/README.md`(ctx.jobs / RadarScheduler
  的 job 语义)。

## 背景

长工作流(deep_import 六阶段、多章内容生成)在 DSH job 中运行, 单轮可能跨越数十分钟与
多次 LLM 调用。当前没有持久化断点: 关机、进程崩溃、job 被取消后, 一切重来——要么重跑
全部批次(重复 LLM 成本与时间), 要么凭内存状态恢复(进程外不可靠, DSH job 状态是运行时
态, 进程退出即失)。

同时两条铁律直接约束恢复协议的设计: 铁律 6(Key/secret 只走 DSH credentials, 不落盘)、
铁律 3(adopt 必过 approval, allowed-once 只放行一次, rejected/cancelled/unavailable 一律
拒绝)。因此「恢复」绝不能退化成「把审批决定和密钥存起来复用」。

恢复协议必须额外解决两个崩溃时点问题: **① 状态事务内部的崩溃中间态**——result 写、
receipt 写、stage、commit 之间的任意崩溃点不能只靠「写前/写后」两分, 否则 partial
artifact/receipt/stage 无法判定归属与去向; **② canonical apply 缺独立持久状态**——
apply 若只是 artifact cursor 的别名, 恢复无法区分「结果已产出未采用」与「已采用」, 也
无法安全地重新审批或去重。两处都以 ADR-0021 的 durable transaction intent + recovery
path 契约为锚(§3、§5、§6)。

## 决策

### 1. 每 run 不可变目录(不可变 = identity/输入快照与既有 artifacts, manifest 原子推进)

- 每 run 一个**不可变 run 目录** `.assistant/import-runs/<workflow_id>/`: 一次 run 一个
  目录。**「不可变」仅指**: ① workflow identity 与输入快照(指纹)一经创建不再变;
  ② 既有 batch artifacts 一旦落盘**不覆盖、不重写**。目录本身**追加**新批次 artifact,
  **manifest 以原子替换推进**(§3 的 checkpoint 游标更新), 不违反不可变语义。
- 目录与 manifest 均走 git 提交(文件真相, git 即回滚面)。
- **首次创建(run 目录、manifest、run plan)一律走受限 `run_bootstrap` state
  transaction**(ADR-0021 新增的 bootstrap kind, 属 checkpoint/state 类): 目标限定固定
  机器状态 namespace(§2 穷尽规则与 ADR-0021 的规范化 path allowlist)、全部目标
  **expected absent**、全新 `<workflow_id>`; intent **自描述输入 fingerprint 与 plan
  digest**——此时尚无已提交 run plan 可对账, 自描述即校验锚, 恢复时按 §4 先收敛该
  intent 并补完同一事务(§5.1, **不得回滚**), **不以「尚无已提交 run plan」为由死锁或
  放弃**。
- atlas 等其它工作流**复用同一协议**, 使用自身 run namespace(与 ADR-0020 已定的
  `.assistant/atlas/runs/<run-id>.json` 兼容, 不重复造轮子)。

### 2. manifest 内容(文件真相的恢复依据)

manifest 记录: workflow 版本、schema 版本、prompt 版本、每章/每目标内容 hash、policy、
**解析后的非 secret execution config**(模型名/参数/预算/超时等; **不含任何 API Key /
secret**——凭据只存在 DSH credentials 子系统, 铁律 6)、**计算批次游标与 workflow/phase
游标(两者区分, 见 §3/§6)**、**observed result hash(事后观测值, 见下)**、
provenance/idempotency 键、状态(`planned` / `running` / `waiting_approval` /
`completed` / `rejected` / `failed` / `superseded`); **canonical apply 单元单独分节
记录**(apply plan + apply 状态机, 见 §6), 不与批次 artifact 状态混为一谈。
- **穷尽规则：所有 Git-backed run-state mutation 都必须走 ADR-0021 带 durable intent 的
  checkpoint/state transaction，无例外**：run/manifest 创建与替换(**首次创建走受限
  `run_bootstrap` state transaction, 见 §1**)、batch/run plan、
  artifact+receipt、任意计算/workflow/phase cursor、apply plan、`waiting_approval` /
  `applying` / `applied` / `rejected` / `skipped` / `failed` / `superseded` 状态及 apply receipt。
  禁止任何“裸写 + 共享 index stage + 裸 commit”旁路；每个 state commit 都使用私有 exact
  tree、txid/run/batch/plan digest 身份与 `update-ref` CAS。
- **每批一条批次记录**, 记录必须可区分三态推进(字段名实现期定, **语义固定**):
  - `artifact_written`: **durable intent 已建立**(该批 result 事务已耐久化, 见 §3),
    artifact/receipt 落盘与 stage 均属该事务的 partial 中间态, 尚未 commit;
  - `artifact_committed`: artifact 已随 checkpoint commit 进入 git 历史, cursor 未推进;
  - `cursor_advanced`: 计算批次 cursor 已推进, 该批 artifact 流水线确认完成。
- **三态是逻辑状态, 不是必须由 rename 后另一次 manifest 更新写入的字段**: 可由「已提交
  批次计划 + **durable intent** + 确定性 artifact 路径 + 文件系统/Git 历史」推断并与
  manifest 对账; manifest 中的状态字段只是该状态的**缓存/记录**, 可能 stale(如事务
  中途崩溃、manifest 尚未更新), 恢复器必须按上述依据**重建**(见 §5), 不依赖「事务完成
  之后另一次 manifest 状态更新」。
- 批次记录含该批 `batch_id`、**确定性 artifact 路径**、input hash、output schema
  版本/phase/ordinal(见 §3); **不登记「预期 result/artifact hash」——result hash 不可
  事前派生**: 输入/schema 无法预测输出内容, 事前只能确定 batch_id、artifact 路径、input
  hash、schema 版本; result_hash 是输出**规范化、确定性序列化为最终 artifact 字节后**,
  对**这些精确字节**计算的**观测值**, 与其承载的 receipt bytes 一起**在内存/事务临时区
  生成(不先单独落盘)**, 作为同一 state transaction 的计划输出随 durable intent 耐久化,
  与 artifact **同事务**落盘并 commit(§3); **不存在「receipt 先单独落盘」的时点**, 也
  **不写入 artifact 自身**——artifact 自描述不含自身的 hash, 避免「hash 嵌入被 hash 的
  字节」的自引用(见 §3)。

### 3. 逐批 checkpoint 协议(顺序固定, 崩溃可判定)

每批严格按序执行五步, 任意两步之间崩溃都能从「已提交批次计划 + **durable intent** +
文件系统 + git 历史」判断落到哪一步:

0. **批次计划先行提交**: **任何 LLM/provider 调用前**，先用 ADR-0021 state transaction
   （durable intent + 私有 exact tree + ref CAS）把该批计划持久化并提交——
   稳定 `batch_id`、**确定性 artifact 路径**、input hash、output schema 版本/phase/
   ordinal; `batch_id` 与路径由**已提交 run plan**(run identity + phase + batch
   ordinal/输入 slice)**确定性重建**, 不依赖内存顺序——崩溃后即使 manifest 尚未推进,
   也能从已提交计划精确寻址批次与 artifact 路径。
1. **provider 调用与输出定型(内存/事务临时区, 不落盘)**: provider 输出完成后先
   **规范化、确定性序列化形成最终 artifact bytes**, **再对这些精确字节计算
   `result_hash`(observed artifact hash, 事后观测)**, **生成 receipt bytes**(含
   result_hash 与该批归属)。**此时尚无任何工作树/index 变更**。
2. **创建 durable transaction intent(ADR-0021 契约)**: 把 **artifact bytes 与
   receipt/manifest 更新作为同一 state transaction 的计划输出**创建 intent, **在首个
   工作树/index 变更前耐久化 intent**(txid 唯一标识该事务); 事务执行期间的
   partial artifact/receipt/stage 均由该 txid intent 识别。
3. **执行 state transaction**：写入计划输出 → 用 ADR-0021 私有 index 冻结 exact tree →
   `commit-tree` → `update-ref` CAS。**最终 artifact** 与含 observed `result_hash` 的独立批次
   receipt/manifest 更新在**同一 txid、同一 exact-tree commit** 中进入历史；commit identity
   同时绑定 run、`batch_id` 与 plan digest，历史判据不只看 HEAD。
4. **advance cursor（计算批次 cursor）**：通过另一笔带 intent 的 ADR-0021 state transaction
   更新并提交 manifest 游标。该 cursor 只跟踪 artifact 已提交，不替代 canonical apply
   状态机；含 adopt 的批，workflow/phase 游标的越过另受 apply 终态门控。

- **每批稳定 `batch_id`**: 由 run identity(`<workflow_id>`) + phase + batch
  ordinal/输入 slice **确定性派生**, 不依赖内存顺序——恢复时按 batch_id 精确寻址;
  batch_id 与确定性 artifact 路径均由已提交 run plan 重建(见步骤 0)。
- **result artifact 自描述**: artifact 内只写入 `batch_id`、input hash、schema 版本/
  phase/ordinal 等归属元数据与 payload, **不含 artifact 自身的 result_hash**(observed
  hash 只存在于独立 receipt/manifest 与 durable intent, 消除自引用), 恢复时脱离
  manifest 也能独立校验归属与内容(manifest/receipt 记录观测, artifact 是事实)。
- 步骤之间有**四个崩溃窗口**, 以 durable intent 为锚(执行规则见 §5): ① **计划提交后、
  intent 耐久化前**(provider 调用中或响应后、intent 建立前崩溃 =
  `provider_outcome_unknown`, 该批无任何持久化产物, 恢复须重新授权后才可重试, 见
  §5.0/§8); ② **intent 已建立、state commit 未完成**(partial artifact/receipt/stage
  任意中间态, 由同 txid intent 识别, **必须补完同一事务**(无安全回滚选项, 见 §5.1));
  ③ **commit 后、cursor
  推进前**(见 §5.2); ④ **cursor 已越过但 commit/artifact 缺失或无法对账** = 损坏
  fail-closed(见 §5.3)。保证**已产出有效 artifact 的批次绝不重调 LLM**。

### 4. resume 入口顺序与 fail-closed

1. 取得 per-vault lock；2. **先**枚举、严格验证并按 ADR-0021 收敛 `.git` 中所有 durable
   intents（含 manifest/cursor/apply state 事务与首次创建的 `run_bootstrap` intent），处理
   可验证的私有 index/ref/index-lock；3. intent 收敛后才读取工作树 manifest、校验必需字段
   与 input/config fingerprint；4. 再进入普通 resume。可能正处于 partial replace/index 状态
   的 manifest 不能先于 intent 被信任。
- **有效 `run_bootstrap` intent 先收敛, 不因尚无已提交 plan 死锁**: 校验其固定机器
  namespace、全部目标 expected absent、新 `<workflow_id>` 与自描述 fingerprint/plan digest
  后, 按 §5.1 **补完同一 state 事务(不得回滚)**; 不以「没有已提交 run plan 可对账」为由
  跳过、放弃、改写或回滚该 intent。
- intent 收敛后，输入 fingerprint 变化、force 之外的新 workflow、manifest 仍缺失/损坏，
  或存在无有效 intent 覆盖的 staged/lock，才拒绝 resume；不猜测、不自动清理外部状态。
- `force`/新输入总是创建新 `<workflow_id>` 与 run 目录，不覆盖旧 run；但 force 只有在
  **所有旧 durable intents 已成功收敛清理之后**才可创建新的 bootstrap run——收敛清理只能
  是协议自身完成(§5.1 补完同一事务、§5.2 补推进)，或**经人工修复后按协议收敛清理**；
  `CONFLICT`/无效 intent 保留现场 fail-closed 并报告，**不能仅以移动/隔离 intent 绕过该
  全局门**。
- 尚未审批/未请求审批不是入口拒绝项；未写 apply 恢复至 `waiting_approval` 后发起新审批。

### 5. 崩溃窗口的可执行恢复规则(保证已产出有效 artifact 的批不重调 LLM)

恢复严格遵守 §4“intent 先于 manifest”的入口顺序。所有 intent 收敛后，恢复器仍**不直接
信任 manifest 的状态字段**：
先由已提交 run plan 确定性重建每批的 `batch_id` 与 artifact 路径, 再以「durable
intent + 文件系统 + git 历史」推断逻辑状态(`planned`(无 intent、无 artifact) /
`artifact_written`(intent 已建、commit 未完成, 含 partial 中间态) /
`artifact_committed`(已进历史、cursor 未推进) / `cursor_advanced`), 与 manifest
对账——manifest 字段只是缓存, stale 属正常(如事务中途崩溃、状态更新前崩溃), 恢复器以
重建为准并据实修正; 无法对账才按损坏处理(§5.3)。**唯一目标是「跳过/收尾已产出有效
artifact 的批次」——任何校验不过的批次绝不重调 LLM**(LLM 调用即成本, 只能由人工修复
或 force 新 run 解除)。

#### 5.0 窗口〇: 批次计划已提交、durable intent 未建立(provider_outcome_unknown)

- 判定: 逻辑状态 = `planned`: 已提交批次计划中有该批, 但**无该批的 durable intent、
  确定性路径无 artifact**——provider 调用中崩溃、或响应后 intent 建立前崩溃, 均属
  **`provider_outcome_unknown`**(进行中的单次 LLM 请求与已返回但未持久化的响应都视为
  结果未知; 该批没有任何可对账的持久化产物)。
- 恢复: **不得自动重调 provider**; 恢复时对该批**重新请求范围/成本授权**(§8), 授权后
  才可重新执行该批(该批可能已消耗一次调用但结果未知, 重试成本须经授权); 这不是「重跑
  已完成批次」——该批从未确认完成。该批若含 adopt 写入, 重新执行到 apply 边界时按
  §6/§7 发起**新的审批**(旧 allowed-once decision 不因恢复而复用、不重放)。

#### 5.1 窗口一: durable intent 已建立、state commit 未完成

- 判定: 逻辑状态 = `artifact_written`: 存在**有效 durable intent**(txid 可识别、计划
  输出可读), 但该事务未 commit(commit 不在 git 历史)。**覆盖 manifest 该批仍为
  `planned` 的情形**(intent 耐久化后、事务完成前崩溃, manifest 状态更新前即崩溃)
  ——manifest 字段 stale 时, 恢复器以「已提交批次计划 + durable intent + 文件系统/git
  历史」重建, 不以 manifest 字段为判据。partial artifact/receipt/stage **任意组合的
  中间态**均由同一 txid intent 识别。
- 恢复同一 txid 的 state transaction：按 ADR-0021 `BEFORE/OUTPUT/CONFLICT` 矩阵核对
  artifact、receipt 与 manifest 计划字节；`BEFORE` 项从 intent 临时区补写，`OUTPUT` 复用。
  **可验证的 state 事务必须补完同一事务——不存在「安全回滚后重新授权重调」选项**：
  合法 partial 通过私有 index 重建同一 exact tree、创建/验证 tx commit 并 ref CAS；cursor
  再通过独立 state transaction 推进。**不主动回滚、不丢弃、不重调 provider**；该批也
  **不得降级为 `provider_outcome_unknown`(§5.0)后重新授权重试**——§5.0 的重新授权只适用
  于窗口〇(intent 从未建立)。`CONFLICT` 项保留现场并 fail-closed(见下条)。
- intent kind/path capability、plan digest、字节或 Git lock 无法验证，或存在 `CONFLICT`
  项 → **保留现场、隔离/报告并停止，fail-closed**：不自动回滚为可重跑状态、不静默清除；
  只允许人工修复或 force，且 force 创建新 bootstrap run 前必须先**经人工修复、再按协议
  收敛清理全部旧 intent**(§4)——不得仅以隔离/移动 intent 绕过冲突/损坏现场。
- 不能仅凭「文件存在」采用: 原子写只保证整文件替换的原子性, 不保证文件内容是完整
  结果; 未 commit 的 artifact 一律以 intent 计划输出与校验为准。

#### 5.2 窗口二: state commit 已完成、cursor 未推进

- 判定: 逻辑状态 = `artifact_committed`: artifact 已随 checkpoint commit 进入 git
  历史——**git 历史即判据**, 不以 manifest 字段为准(stale 时以 git 历史对账修正);
  cursor 未推进。
- 恢复：在当前可达历史按 txid/run/`batch_id`/plan digest 定位唯一 checkpoint commit，验证
  parent/exact tree、artifact 与 receipt 同 commit、输入/schema，并重算 artifact 精确字节
  hash 对比 receipt observed hash；一致后通过带 intent 的 state transaction 幂等推进 cursor，
  不重跑 provider。后续无关 commit 不影响识别。
- 校验失败 → 隔离/报告并 fail-closed, 恢复停止, 只允许修复或 force 新 run。

#### 5.3 损坏判定: cursor 已推进但 commit/artifact 缺失, 或无法对账

- 批次逻辑状态为 `cursor_advanced`(或游标已越过该批)但对应 artifact 不在 git 历史,
  或已提交批次计划与 durable intent/文件系统/git 历史**无法对账**(如批次计划缺失、
  batch_id 冲突、确定性路径上的 artifact 归属不符、intent 缺失但存在其声称的变更),
  或存在**无有效 intent 覆盖的 staged 残留** → **损坏, fail-closed**, 拒绝恢复; 只允许
  人工修复或 force 新 run, 不静默补造 artifact、不重跑该批 LLM、**不把无 intent 的
  staged 并入任何提交**。
- manifest 落后于已提交计划/intent/文件系统/git 历史属**正常 stale**, 由 §5 对账规则
  修正, 不视为损坏。

#### 5.4 atlas 等复用协议的 resume

- 先**聚合所有已确认 completed 的批次 artifact**(以 git 历史 + 校验为准, 含窗口一补
  提交与窗口二补推进的结果), 再处理 next cursor 续跑; **不重跑、不丢弃已提交批**。

### 6. canonical apply 独立持久单元/状态机(不由 artifact cursor 代替)

- **apply 不是 artifact cursor 的别名**: artifact commit 只证明「结果已产出并进入 git
  历史」, 不证明「已采用到 vault 工作区(canonical apply)」。canonical apply 是
  **独立持久单元/状态机**, 有自己持久化的 apply plan 与状态记录(manifest 分节记录,
  §2), 与计算批次 cursor 明确区分(§3 步骤 4)。
- **状态机**: `waiting_approval → applying → applied | rejected | skipped`(可增加
  `failed` 作为异常终态, 人工处置)。`applied` / `rejected` / `skipped` 是终态。
- artifact commit 后，通过 state transaction 原子提交 apply plan + `waiting_approval`。
  plan 固定 writeSet、artifact hash、各目标 generation-time expected states、run/`batch_id`/
  checkpoint commit、apply_id、plan digest 与 provenance/idempotency key；不得在审批时刷新
  expected state。若 plan 事务自身中断，§4 先收敛 intent；若尚未建立 intent，则可由已提交
  artifact 确定性重建并新建 plan，不重调 provider。
- **状态机规则（每个箭头都是带 intent 的 state transaction）**：
  1. `waiting_approval` 发起一次新 ApprovalGate 请求；decision/token 不落盘。
  2. allowed-once 后先提交 `applying + canonical_txid/apply_id/plan_digest`，再启动 ADR-0021
     canonical transaction。该事务用私有 exact tree 与 ref CAS，不接触共享 staged。
  3. canonical tx 未 commit 或中断：ADR-0021 按矩阵条件回滚；随后 state transaction 把
     apply 单元退回 `waiting_approval`，下次必须重新审批，旧 decision 不复用。
  4. canonical tx 已 commit 而 apply receipt/status 未推进：在当前可达历史按 txid/apply_id/
     plan digest 找到唯一 commit，并验证 parent/tree/writeSet/output blobs；随后 state
     transaction 补 receipt + `applied`。不依赖当前 worktree 内容，不重复审批或写入。
  5. rejected/cancelled/unavailable 通过 state transaction 进入 `rejected` 或 `skipped`，
     绝不 apply；`failed`/`superseded` 同样只能通过 state transaction 记录。
- workflow/phase cursor 只有在 apply 的 `applied/rejected/skipped` 终态 commit 可验证后，才能
  通过另一笔 state transaction 越过；计算批次 cursor 不代表 apply 完成。apply 目标按 plan
  依赖顺序推进，不并行乱序。

### 7. approval 语义: 决定不可复用, 未写即重新审批

- **未写 apply(含旧 allowed-once 已放行但写前崩溃)恢复时回到 `waiting_approval`/
  写入边界, 必须发起新的审批**(§6); 旧 decision 不复用——**approval decision 不是可
  复用 token**, allowed-once 只对当次请求生效, 恢复协议不序列化、不重放任何审批决定;
  新审批的结果同样是一次性的, 仍受「写前崩溃 → 再次重新审批」约束。
- **rejected / cancelled / unavailable 按该工作流既有规则处理**: apply 单元进入
  `rejected`(终止该 adopt)或 `skipped`(可选阶段跳过), **绝不静默 apply**(§6); run 是否
  允许新 run 由 force / 新动作语义决定, 恢复协议不替它放行或锁死。
- **「尚未审批/未请求审批」不是 resume 入口的拒绝项**: 恢复推进到未写 apply 的写入
  边界时进入审批等待并发起新审批, 不整体拒绝 resume(见「失败关闭与边界」)。
- 恢复协议本身不含 API Key/secret: manifest、apply plan 与恢复路径不读、不写、不携带
  凭据。

### 8. 恢复的成本授权与进度展示

- 恢复时若剩余批次仍需 LLM, 对**剩余批次重新请求范围/成本授权**(含预算估算), 并展示
  **完成/剩余**与估算; **不重跑已完成批次**(结果 hash 命中即跳过, 不重复计费)。
- **`provider_outcome_unknown` 批(§5.0)重试前必须单独重新授权**: 该批可能已消耗一次
  调用但结果未知, 不得在旧授权下自动重调; 授权后才可重新执行该批。
- **缺凭据只在下一剩余批确需 LLM 时阻止该批**: 不提前因缺凭据拒绝整个 resume; 剩余批
  无需 LLM(如纯落盘/收尾批)时继续推进, 到确需 LLM 的批次再按缺凭据 fail-closed 处理。

## 失败关闭与边界

- 必须先按 §4 收敛所有有效 intent；**只有其后**仍存在输入指纹变化、force 之外的新
  workflow、manifest 缺失/损坏、无 intent 的 staged 或未知 Git lock，才拒绝普通 resume。
  不允许让 partial manifest 在 intent 恢复前阻断自身恢复。
- **「尚未审批/未请求审批」不在入口拒绝之列**: 未写 apply 恢复时进入
  `waiting_approval`/写入边界并**发起新的审批**(§6/§7), 不整体拒绝 resume、不静默
  apply; 旧 allowed-once decision 不因恢复而复活。
- **rejected / cancelled / unavailable 的审批结果按该工作流既有规则落地**: apply 单元
  进入 `rejected` 或 `skipped`, **绝不静默 apply**; 终态是否可发起新 run 由 force /
  新动作语义处理, 恢复协议不代其决定。
- **缺凭据**不在入口拒绝之列: 仅在**下一剩余批确需 LLM** 时阻止该批(fail-closed),
  不提前拒绝整个 resume。
- **恢复器以重建的逻辑状态为准, 不信任 manifest 状态字段的即时性**: 「已提交批次计划
  + durable intent + 确定性路径 + 文件系统/Git 历史」是判据, manifest 字段只缓存/记录
  该状态; stale 属正常(如 intent 耐久化后、事务完成前崩溃)并对账修正, 对账失败才按
  损坏处理(§5.3)。
- `.assistant/import-runs`、atlas run namespace 等机器状态目录只允许本协议写入；任何绕过
  intent 的外部编辑、symlink、路径穿越或未知 staged 都按 `CONFLICT`/损坏处理，不自动采用。
  这不限制 writeSet 外普通作者文件的 unstaged/untracked 存在。
- **result hash 不可事前派生、不写入 artifact 自身**: 事前仅能确定 batch_id、artifact
  路径、input hash、schema 版本; 先把输出**规范化、确定性序列化形成最终 artifact
  字节**, 再对**这些精确字节**计算 result_hash(observed artifact hash)——**与 receipt
  bytes 一起在内存/事务临时区生成, 作为同一 state transaction 的计划输出随 durable
  intent 耐久化, 与 artifact 同事务落盘并 commit; 不存在「receipt 先单独落盘」的时点**,
  也不写回 artifact(把 hash 嵌进被 hash 的字节会构成自引用, 使「对精确字节重算 hash」
  无法成立)。窗口一恢复: 重算现有字节 hash 并与 **intent 计划输出中的 observed
  result_hash** 比较, 一致则补完同一事务(缺 receipt/manifest 更新则补写后 commit);
  窗口二/已提交状态: 重算 artifact 精确字节 hash 与**同一 commit 的 receipt** observed
  result_hash 比较。**不存在「预期 result/artifact hash」**(intent 与 receipt 中的
  result_hash 都是对最终字节的事后观测值)。
- 已完成批次以 Git/provenance 为准, 不凭内存或运行时状态。
- 崩溃窗口的恢复语义: 窗口〇(§5.0, 计划已提交、intent 未建立)为
  `provider_outcome_unknown`——**不得自动重调 provider**, 对该批重新授权后才重试;
  窗口一(§5.1, intent 已建立、commit 未完成, **含 manifest 仍为 planned 但存在同 txid
  partial artifact/receipt/stage 的情形**)以 txid intent 识别, 校验计划输出并补完/提交
  **同一事务**——有效 intent 一律补完, 不主动回滚/丢弃、不降级为 `provider_outcome_unknown`;
  `CONFLICT`/无法验证时保留现场 fail-closed, 只人工修复或 force(force 仅在所有旧
  intent 收敛清理后才可创建新 bootstrap run, 不得以隔离/移动绕过); 窗口二(§5.2)以 git 历史为
  判据、校验后幂等推进 cursor; **已产出有效 artifact 的批都不重调 LLM**。损坏判定
  (§5.3)只允许修复或 force 新 run; **无有效 intent 的 staged 一律 fail-closed, 不并入
  任何提交**。
- **apply 边界(§6)**: apply 是独立持久状态机; commit 前中断 → ADR-0021 recovery 条件
  回滚并回 `waiting_approval`(重新审批); commit 后状态未推进 → Git/provenance 识别
  applied, **不重复审批、不重复写入**; rejected/cancelled/unavailable 进入
  `rejected`/`skipped`, 绝不 apply; workflow/phase cursor 只在 apply 终态后越过。
- 恢复绝不覆盖、绝不删除任何既有 artifact、apply 结果与 git 历史; 未通过校验的
  artifact 一律隔离并报告, 保持原状供人工判定。
- **边界**: 恢复是「续跑未完成批次」协议, 不是回放工具——不重放已提交结果, 不重放
  审批决定, 不重复 canonical write/provider; 也不承诺恢复出运行时的临时状态
  (`provider_outcome_unknown` 的调用结果视为未知, 重新授权后重试)。

## 未采用方案

- **A. 用 DSH job 状态/job store 存 checkpoint**: 运行时态, 进程退出即失, 且非文件真相;
  未采用。
- **B. 数据库/队列 checkpoint**: 违反铁律 2; 未采用。
- **C. 整个工作流重跑**: 重复 LLM 成本, 与「不重跑已完成批次」目标冲突; 仅作为无
  checkpoint 时的兜底, 未采用为主路径。
- **D. manifest 内嵌 Key/secret**: 违反铁律 6; 未采用。
- **E. 把 approval 决定序列化进 manifest 供恢复复用**: 违反铁律 3 的 allowed-once /
  fail-closed 语义; 未采用。
- **F. 用 artifact cursor 兼任 canonical apply 状态(apply 不设独立状态机)**: 无法区分
  「已产出未采用」与「已采用」, 审批/写入门控失去依据, 「commit 后状态未推进」场景
  无法安全去重; 未采用。
- **G. `provider_outcome_unknown` 时自动重调 provider**: 可能重复计费与重复副作用,
  绕过成本授权; 未采用(必须重新授权后重试)。
- **H. receipt 先单独落盘、再随 checkpoint commit**: 产生「receipt 已落盘但 artifact
  未落盘/未 commit」等中间态, 恢复时点矛盾(旧文「receipt 写后 commit 前崩溃」与
  「receipt 尚未创建」并存); 未采用(receipt 与 artifact 同为同一 state transaction 的
  计划输出)。
- **I. 窗口一可验证 state 事务「安全回滚 + 重新授权后重调」**: 把已建立 durable intent
  且计划输出可读的批次降级为未发生, 与「已产出有效 artifact 的批绝不重调 LLM」直接
  矛盾, 且「回滚还是补完」的可选项制造恢复判定分歧; 未采用(窗口一有效 intent 一律
  补完同一事务, 仅窗口〇可重新授权后重试)。

## 影响

- 影响面: **imports + world/map-atlas + trace + dsh** 四层, 全部只做加法(铁律 4):
  - **imports**: `runDeepImport` 增加 checkpoint/resume seam, 既有签名不变, resume 为
    新导出; manifest 类型与校验进 store 或 imports 包; **apply plan 与 apply 状态机
    类型**进 store 或 imports 包。
  - **world/map-atlas**: 复用同一协议(run namespace 与 ADR-0020 的
    `.assistant/atlas/runs/<run-id>.json` 兼容); map-atlas resume **必须合并此前成功
    批次的持久结果**——只补状态与续跑剩余批, 不重跑、不丢弃已提交批。
  - **trace**: contract 事件词表补 checkpoint/resume 事件(可断言「不重跑已完成批次」)
    与 apply 状态机事件。
  - **dsh**: job 层挂恢复入口(对齐 ctx.jobs / RadarScheduler 语义); apply 的 approval
    经 ApprovalGate(铁律 3, allowed-once / fail-closed), 恢复入口本身不接触凭据
    (铁律 6)。
- 验证要求: vitest 行为契约, 断言注释引 N33——覆盖输入变化拒绝 resume、force 新 run
  不覆盖旧 run、**resume 入口不因「尚未审批/未请求审批」整体拒绝**、审批通过但写前
  崩溃不复用(恢复时发起**新**审批)、rejected/cancelled/unavailable 不静默 apply、
  manifest 无 secret(断言不含凭据字段)、恢复成本授权流程; 批次计划先行提交与崩溃窗口
  逐条可断言(MockProvider 计数断言**已产出有效 artifact 的批 provider 调用不增加**;
  MockApproval 计数断言**未写 apply 恢复时发起新审批、旧 decision 不重放**):
  ① 批次计划先行提交: 每批 LLM 调用前批次计划已提交进 git 历史; batch_id 与确定性
  artifact 路径可由已提交 run plan 重建, 即使 manifest 状态字段 stale(如事务中途崩溃
  未更新即崩溃)恢复器仍能定位 artifact;
  ② **进程 kill 穷尽所有 run-state mutation**：run/manifest/run plan 首次创建(受限
  `run_bootstrap`)、batch plan、artifact+receipt、每种 cursor、apply plan、每个 apply 状态
  与 receipt 都在 intent、worktree write、private-index/tree、commit object、ref CAS、共享-index
  安装各点 kill；恢复必须先收敛 intent 再读 manifest，有效 intent 同 txid 补完(不主动回滚)
  或 canonical 按 kind 条件回滚，无 intent 的 staged/未知 lock fail-closed;
  ③ 窗口〇(计划已提交、intent 未建立): `provider_outcome_unknown`——**不得自动重调**
  (重新授权前 MockProvider 计数不增加), 恢复时对该批**重新请求范围/成本授权**(授权
  流程断言)后才重试; 该批含 adopt 时重新执行走到 apply 边界发起**新**审批(MockApproval
  计数增加);
  ④ 窗口一（intent 已建立、commit 未完成，含 partial artifact/receipt/private-index）：
  `BEFORE/OUTPUT` 合法组合按同一 txid 补齐计划字节、重建 exact tree、ref CAS；cursor 另走
  state transaction；**有效 intent 一律补完同一事务**——不主动回滚/丢弃、不降级为
  `provider_outcome_unknown`(该批不得被重新授权重试, MockProvider/MockApproval 计数不增加)；
  `CONFLICT`/intent 损坏隔离/报告并 fail-closed，不重调 LLM、不重授权重试该批;
  ⑤ 窗口二(commit 后 cursor 前): 以 git 历史识别已提交 artifact 与 receipt(git 历史
  即判据, manifest stale 以 git 为准), 校验 run identity/`batch_id`/输入 hash/schema
  并**重算 artifact 精确字节 hash 与同一 commit 的 receipt 中 observed `result_hash`
  对比** → 幂等推进 cursor, 不重跑 provider;
  ⑥ cursor 已推进但 artifact/commit 缺失或无法对账 → 拒绝 resume(fail-closed);
  ⑦ atlas resume 先聚合已确认 completed 批次再处理 next cursor;
  ⑧ `batch_id` 派生稳定性(同 run identity/phase/ordinal 恒等)与 artifact 自描述字段
  (`batch_id`/输入 hash/schema 版本/phase/ordinal 归属元数据)断言——**artifact 不含
  自身 hash(无自引用)**: 对精确字节重算 hash 与 intent/receipt 中 observed 值一致,
  且 artifact 字节内容不因 hash 写入而改变; **result hash 为事后观测**——断言
  intent/receipt 中的 result hash 仅在最终 artifact 字节确定后出现, 事前不可派生;
  ⑨ apply plan+`waiting_approval`、allowed 后 `applying+canonical_txid`、各终态/receipt
  都是独立 state transaction；canonical commit 前中断回滚并新审批，commit 后状态中断则
  从可达历史按 txid/apply_id/plan digest 识别且不重复写入/审批；
  ⑩ 计算批次 cursor 与 apply 依赖分离，workflow/phase cursor 只在 apply 终态 commit 后
  通过 state transaction 越过；
  ⑪ 注入后续无关 commit、作者后续编辑、机器 namespace 外部改动、未知 index/ref lock：
  前两者不妨碍识别已成功 tx commit，后两者 fail-closed；artifact+receipt 必须同 exact-tree
  commit；
  ⑫ `run_bootstrap`(首次 run/manifest/run plan 创建): 固定机器 namespace、全部目标
  expected absent、新 `<workflow_id>`、intent 自描述 fingerprint/plan digest; 仅存 bootstrap
  intent、尚无已提交 run plan 时恢复仍收敛并**补完同一 state 事务(不得回滚)**(不死锁);
  所有旧 intent(含冲突/损坏)成功收敛清理前(仅经人工修复后按协议收敛清理, 不得以隔离/
  移动绕过)force 不得创建新 bootstrap run。完成标准 `npm test` 全绿 +
  `npm run typecheck` 零错误。
- 文档: N33 已录入 `specs/adjudications.md` 第八批; `docs/adr/README.md` 索引已更新;
  本 ADR 引用的 durable transaction intent + recovery path 契约定义于 ADR-0021。

## 实施期开放项

1. `<workflow_id>` 的命名/指纹算法(输入指纹 + workflow 版本)留实现期定, 但「force 新
   workflow 必为新 run 目录」已是裁定, 不可违背。
2. apply plan 的持久化位置/形态(manifest 分节 vs 独立文件)、`failed` 状态的处置流程,
   以及 `provider_outcome_unknown` 的判定边界(超时/取消/连接中断的归类, 按 §5.0 语义
   落地)留实现期定, 不上升为裁定。
