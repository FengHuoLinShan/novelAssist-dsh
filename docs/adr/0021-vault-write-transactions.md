# ADR-0021 — Vault Git 目标路径级写事务(writeSet + 内容 CAS + 跨进程 per-vault 锁 + 崩溃恢复 intent)

- **状态**: Accepted(2026-08-15, 用户确认裁定 N32); **implemented and verified**
- **日期**: 2026-08-15
- **取代/补充**: 补充 ADR-0016 §2「文件夹真相」与 ADR-0017 §2 的 adopt 写链: 把 store 的
  单文件 adopt/merge 升级为多目标一致提交的事务协议, 并补足「进程在工作树写入或精确
  stage 后直接崩溃(异常回滚代码未运行)」的恢复协议(transaction intent, §8)。
  **不取代**任何现有 ADR。
- **设计依据**: N32(2026-08-15 用户确认; 已录入 `specs/adjudications.md` 第八批)、
  `specs/rules/store-rules.md`(store 落盘校验/自环与影子端点)、ADR-0019 P0(`assertValidRelations`
  硬错拒绝)、N23(validateFrontmatter 接入写链)、ADR-0022(N33: checkpoint commit 复用本
  事务语义, 其中断窗口依赖本协议的 intent 恢复落点)、`packages/novelcraft/store`(adopt.ts/
  merge.ts/git.ts)、`packages/novelcraft/dsh/README.md`(adopt 类工具审批门控)、
  `docs/agent/reviews/full-codebase-review.md`(Review P1 的两个 P1: CAS 陈旧基线未覆盖
  生成/审批→事务启动窗口; 失败回滚不还原 Git index)。

## 背景

store 现有写链以**单文件原子提交**为最小单元: adopt 一次提交一个目标, merge 逐目标提交。
但多目标业务(deep_import 六阶段 adopt、结构资产批量迁移、map atlas 的节点/pages adopt 链)
需要「writeSet 内目标要么全部落盘为一个一致提交, 要么全部不动」的语义, 单文件提交把一致性
义务推回给调用方, 中间态目标(已提交的 vs 未提交的)无法从 git 角度判断。

同时现状有六个未关闭的口子:

1. **`git add -A` 卷入无关改动**: 作者手改、编辑器自动保存的 writeSet 外文件会被同一个
   commit 带走, 污染回滚面——git 本是「每资产一文件 = 细粒度 CAS/手改/git diff」(N12)的回滚面。
2. **预存 staged 被覆盖**: 作者自行 `git add` 过的任何路径(整个 index 的预存 staged,
   不限 writeSet 内), 事务提交时会把它当作自己的内容一起提交, 丢失「作者显式暂存」信号
   ——N32 裁定: 任何预存 staged 一律 fail-closed 拒绝。
3. **无跨进程锁**: 编辑器、第二个插件进程并发写同一目标时, 单靠 temp+rename 只能保证单次
   替换原子, 无法防丢更新; 失败回滚也无判定依据, 可能把用户刚保存的编辑一并还原。
4. **CAS 基线取自事务启动时, 不覆盖「输出生成/审批 → 事务启动」窗口**: 输出内容在生成/
   审批时定型, 但若 preflight 在事务启动时才读当前内容并把它当 CAS 基线, 窗口内的外部改动
   会被静默当成新基线, 事务覆盖审批后的编辑而不报冲突。
5. **共享 index 的复验→commit 有 TOCTOU**：即使只精确 stage，外部 `git add/commit`
   仍可能在复验后抢占并污染提交；仅靠事后 unstage 无法撤销错误历史。
6. **崩溃窗口无恢复元数据**：若进程在 worktree、私有/共享 index、commit object、ref CAS
   或最终 index 安装中途退出，内存回滚不会运行；必须在首个副作用前持久化 transaction
   intent，才能判定继续、回滚或“commit 已成功仅补状态”。

## 决策

### 1. 事务边界 = 调用方声明的完整 writeSet

- 调用方在发起事务时**必须声明完整 writeSet**(目标路径全集, 不补不猜); 事务只 touch
  writeSet 内路径。
- writeSet **外**的 unstaged/untracked 无关改动**允许存在**: 不检查、不提交、不 reset、
  不迁移。这是目标路径隔离的核心: 事务的「干净」只对 writeSet 内成立。
- writeSet 每个目标必须携带**生成计划时的 expected state**: 期望内容 hash 或期望不存在
  (expected absent), 必要时连同期望的 HEAD/blob(生成时基于该 blob 推导输出)。expected
  state 在输出生成/审批完成时定型并随 writeSet 传入, 是内容 CAS 的**唯一基线**; 事务不
  自行推断基线。

### 2. fail-closed 前置: 整个 index 任何预存 staged 一律拒绝

- preflight 检查**整个 index**(不限 writeSet 内): **任何预存 staged** → 整个事务拒绝
  (`STAGED_CONFLICT`), 不自动清除、不自动并入。作者显式暂存是信号, 事务不替作者决定
  它的去留。
- 该检查同时保证**事务启动时整个 index 无 staged**, 是 §7 失败回滚时精确还原 index 的
  前提; 中断事务遗留的本事务 staged 由 §8 恢复路径在全局门**之前**收敛(只认可验证的
  本协议 intent), 收敛后新事务仍满足本前提。

### 3. 跨进程 per-vault 锁

- 每 vault 一把**跨进程锁**(锁文件 + 持有者 pid + 心跳/超时); 事务全程持锁, 释放于
  commit 或回滚之后。
- 获取失败 → 拒绝或按策略重试(fail-closed, 不无锁继续)。
- **边界声明**: 锁只约束「遵守本协议」的进程; **不声称能阻止不遵守锁的外部编辑器**。
  外部编辑并发时, 由 §4/§5 的 expected-state/CAS 拒绝并在报告中说明, 不静默覆盖(目标
  路径隔离, 不是编辑器互斥)。

### 4. 全量 preflight 通过后才首写

- 首写前完成全部检查, **任一失败 → 零写入返回**:
  - **陈旧基线检查(第一项)**: 逐目标比较当前状态与 writeSet 携带的 expected state(当前
    内容 hash == 期望 hash, 或目标应不存在时确认不存在; 必要时核对 HEAD/blob)。任一不符
    → `STALE_BASELINE`, 整个事务拒绝。**事务绝不把事务启动时读到的任意新内容自动当基线**。
  - N23 的 validateFrontmatter、ADR-0019 的 assertValidRelations 等其余检查。
- **ApprovalGate 是 dsh 调用方在纯核心事务之外取得的前置条件**(adopt 类必经,
  allowed-once / fail-closed): 核心事务 helper **不 import DSH**(铁律 1, 核心包零 DSH
  依赖), 审批由 `@novelcraft/dsh` 层完成; **审批通过后进入事务仍重新 preflight/CAS**——
  审批决定不替代事务内检查(「审批完成 → 事务启动」窗口同样适用 expected state 基线)。
- preflight 同时记录每个目标的**事务启动时字节快照**(存在状态 + 字节/hash; 新建目标记录
  为「不存在」), 该快照**仅用于 §7 失败回滚, 不是 CAS 基线**; 快照随 §8 的 intent 持久化,
  崩溃恢复时从持久快照读取。
- preflight 可从 writeSet 去掉 no-op 目标（expected state == 输出且当前已复核）；私有
  exact tree 的变化集必须恰等于剔除 no-op 后的实际变化集。
- **首写前先按 §8 耐久化 transaction intent**: preflight 全部通过后、任何工作树/index
  变更前, 先把事务的恢复元数据持久、原子地写入 vault 的 `.git`(§8); **intent 建立后才
  承诺「进程崩溃可恢复」**, intent 建立前崩溃 = 零工作树/index 副作用(与本节「任一失败
  → 零写入」一致)。计划输出字节在 intent 建立前定型(生成/审批已完成), intent 建立后
  输出内容不再可变。

### 5. 写入协议: 同目录 temp + rename, 乐观前置条件与并发边界

- 每个目标使用同目录临时文件 + rename 做单次原子替换；首写前复核全部目标、每个目标写前
  再复核当前状态仍等于生成计划时的 expected state，不符即 `CAS_CONFLICT`。事务启动时快照
  仅供回滚，不是 CAS 基线。
- **承诺边界必须诚实**：普通“hash/check → rename”不是文件系统原子 compare-and-swap。
  不遵守 per-vault 锁的编辑器仍可能在最后一次复核与 rename 之间写入；本协议承诺检测各复核点
  已可见的陈旧基线与竞争并 fail-closed，**不承诺物理上消除该窄竞态或绝对零丢失**。作者/外部
  工具不得在短暂 apply 窗口并发编辑同一目标；若未来要求对不协作进程也提供原子 CAS，必须
  引入平台文件原语并另立 ADR，不能继续把 check+rename 描述成真正原子 CAS。

### 6. Git 提交协议: 事务私有 index + exact tree + `update-ref` CAS

- 新事务仍要求**真实共享 index 起始无 staged**；未知 `.git/index.lock`、ref lock 或无法证明
  归属的 Git 临界区一律 fail-closed。私有 index 是提交隔离实现，不是允许用户保留预存 staged。
- 在 intent 管理目录内创建事务私有 index（`GIT_INDEX_FILE`），从 `base HEAD` 初始化，只把
  实际变化集的计划输出 blob 写入；业务写面禁用 `git add -A`。`git write-tree` 冻结
  `base HEAD tree + 实际变化集` 的 exact tree，其 tree hash、writeSet 与输出 blob hashes
  共同形成不可变 plan digest。
- 用 `git commit-tree <tree> -p <base HEAD>` 生成 commit object；commit message/trailer 必须
  带唯一 `txid`、事务用途及 plan digest。冻结 tree 后 hook 不得改变提交内容；如需业务 hook，
  必须在冻结前运行，随后重新做全部 preflight/CAS/tree 校验。自动事务不依赖可修改 index 的
  pre-commit/commit-msg hook 来定义提交内容。
- **提交前复核点（紧邻 `update-ref` CAS 之前）**：所有目标 rename 完成后、持有可验证的
  Git/index 临界区时，重新 hash 全 writeSet 工作树并要求每个目标均等于计划 output；同时
  复核 ref 仍为 base、私有 index 的 exact tree 与 plan digest 未变。任一不符 → 不
  `update-ref`，按 §7 状态矩阵条件回滚/报告，不 force。这是可检测的提交前复核点，不声称
  消除不协作编辑器在最后一次复核与 CAS 之间残留的窄竞态。
- 用 `git update-ref <branch> <newCommit> <baseHEAD>` CAS 推进分支。外部 commit 先推进 ref 时
  CAS 失败，不 force、不覆盖；重试必须基于新 HEAD 重新计划、审批与 preflight。**commit/ref
  成功是 canonical 终点**，不因后续状态 receipt 失败而回滚历史。
- 共享 index 只在可验证归属的 index lock/等价原子临界区内同步：构建与新 HEAD 一致的最终
  index 并原子安装；外部 index 内容、未知 lock 或归属不明时不覆盖、不清理，fail-closed
  报告。崩溃后仅当 intent+txid 且无活跃 Git 操作能证明 lock 属本事务时才可回收。
- 恢复时不以“当前 HEAD 相对 base 的总 diff”判断成功，而在当前可达历史中定位带 txid/
  plan digest 的唯一 commit，并验证 parent、exact tree、writeSet 与输出 blobs；因此后续无关
  commit或作者继续编辑工作树不会造成假阴性，外部恰好提交相同字节也不会造成假阳性。

### 7. 失败/崩溃状态矩阵与条件回滚

- intent 持久化每个目标的事务前快照。恢复时 worktree 逐目标分类：
  `BEFORE`（等于事务前快照/原本不存在）、`OUTPUT`（等于计划输出）、`CONFLICT`（两者都不等）；
  共享 index 条目分类为 `BASE`（等于 base HEAD）、`OUTPUT`（等于事务输出）、`CONFLICT`。
- `BEFORE/OUTPUT` 的任意组合都是合法 partial state，不能把尚未写入的 `BEFORE` 误判为外部
  冲突。只有 `CONFLICT`、intent 外 staged/path 或无法验证归属的 lock 才 fail-closed，且不
  覆盖、不 unstage、不删除。
- checkpoint/state 事务可把 `BEFORE` 补成 `OUTPUT` 并完成 exact-tree/ref CAS；canonical
  adopt 在尚无成功 commit 时只能把 `OUTPUT` 条件恢复为 `BEFORE`（新建文件安全删除），
  `BEFORE` 保持不动，然后交还上层重新审批。绝不 `restore HEAD` 或无条件 reset。
- 私有 index/共享 index 的恢复同样只允许本事务可证明的 `OUTPUT → BASE/新 HEAD` 条件迁移；
  外部条目保持并报告。成功 commit 后的复核是“分支历史中存在经验证的 tx commit，且相对
  **新 HEAD** 无未提交的本事务残留”，不是“工作树无事务输出”——事务输出本就应成为新
  HEAD 内容。
- 进程内异常与进程崩溃使用同一矩阵；差别仅在崩溃时由 §8 的 durable intent 恢复入口执行。

### 8. 崩溃恢复: 写前耐久化 transaction intent, 中断事务可安全完成或条件回滚

**写前耐久化(intent 是「崩溃可恢复」的承诺起点)**

- 在**首个工作树/index 变更之前**, 先把事务的恢复元数据写成**持久、原子**的 transaction
  intent, 存于 vault 的 `.git` 内(建议 `.git/novelcraft-transactions/<txid>/`, 具体路径
  实施期可定)。位于 `.git` 内 = 天然不进 index, 不会被任何 `add` 卷入 commit。intent 写
  入必须原子并耐久化(目录内临时写 + 原子 rename + 就绪标记/fsync, 或等价单文件原子写):
  不存在可被误当有效的半写 intent。
- intent 使用版本化 schema 与字段/大小白名单，至少记录：`txid`、目标 branch/ref、
  `base HEAD`、完整/实际变化 writeSet、调用方 expected states、计划输出 bytes/blob hashes、
  事务前持久快照、私有 index/tree/commit object 状态、预期共享-index 终态、plan digest、
  事务 kind 声明与清理状态。
- intent 中的 kind/恢复策略只是**待验证声明**，不能自报即可信。恢复器必须用封闭事务类型
  注册表、已提交 run/apply plan digest 与规范化 path allowlist 重推导：只有明确的机器状态
  namespace 可作为 checkpoint/state 自动补完；任何 canonical/adopt 路径在未成功 commit 时
  只能条件回滚并重新审批。
- **封闭的 `run_bootstrap` 例外（capability 重推导处）**：首次 run 还没有已提交 plan，
  其能力不由已提交 plan digest 推导，而由封闭注册表 + 固定机器 run namespace allowlist +
  全目标 expected absent + 新唯一 `workflow_id`/run 目录 + self-describing input/config
  fingerprint + intent 内 plan digest 重推导共同界定；绝不允许 canonical/adopt 路径、
  绝不允许覆盖既有 run。有效、可验证 bootstrap state intent **必须补完同一事务**，不得
  主动回滚——不会因缺已提交 plan 死锁；`CONFLICT`/无效 intent 保留现场 fail-closed，
  需人工修复，`force` 不能绕过未收敛 intent。除本例外，其余 state/apply 恢复仍要求
  已提交 plan digest。
- 所有 intent/快照/输出路径必须归一化并限制在当前 vault/受控 `.git` 子目录，拒绝绝对路径、
  `..`、路径穿越、目标或父目录 symlink、非法 txid、超限内容与未知 schema；`.git` intent 是
  本地临时信任边界，但恢复器不盲信其内容。
- intent 是**临时恢复元数据, 不是资产/数据库/队列**(铁律 2: 不构成第二真相源, 只位于
  `.git` 内部控制区); 成功 commit 或安全回滚完成后**清理**(删除 intent 目录), 不残留。
- **只有 intent 耐久化建立后才承诺「进程崩溃可恢复」**; intent 建立前崩溃 = 零工作树/
  index 副作用(事务尚未首写); 崩溃于 intent 写入之中 = 无就绪标记的半写残留, 恢复时忽略
  并清理, 该事务视为未开始。

**崩溃点与入口**

- 进程可能崩溃于 worktree partial、私有 index/tree、commit object、ref CAS、共享 index
  原子安装或状态 receipt 任一点；共同特征是 intent 已建立而事务尚未完全收尾。
- 任何事务入口发现存在未完成 intent → **先进入恢复路径**收敛该中断事务, 收敛(清理
  intent)完成前不开始任何新事务; 收敛完成后新事务才按 §2 正常进入。
- **N32 不变**: 新事务入口若 index 有 staged 且**没有可验证的本协议 intent**, 仍
  `STAGED_CONFLICT`(§2); **只有「恢复同一已登记中断事务」可在全局 staged 门之前进入
  专用 recovery path**——恢复路径只认 intent 登记的 txid/仓库, 不把外部 staged 冒充成
  自有事务, 不自动清除任何 staged。

**恢复验证(fail-closed: 先验证, 后动作)**

- 先验证 version/schema/大小、vault/root、txid、目标 branch、base HEAD、已提交 plan digest、
  kind/path capability、writeSet/expected/output hashes、私有 index/tree/commit object、共享
  index/lock 与 ref 状态；任一身份或权限无法重推导即 fail-closed，不动作。
- 再按 §7 对每个 worktree/index 目标分类。`BEFORE/OUTPUT` 任意组合是可恢复的合法 partial；
  `CONFLICT`、intent 外 staged、未知 Git lock 或路径能力不匹配才是不允许自动收敛的外部变化。
- HEAD 已前进不自动等于冲突：先按 §6 在当前可达历史查找并验证唯一 tx commit。找到则进入
  “commit 已成功”收尾；未找到且 ref 仍为 base HEAD 才可继续或回滚；HEAD 前进且不存在该
  commit 表示外部 ref 竞争，停止并重新规划，绝不 force。

**按重推导 kind 完成或回滚**

- **checkpoint/state**（且全部路径命中机器状态 allowlist）：验证 intent 中输出/临时文件/
  receipt 后，把 `BEFORE` 补成 `OUTPUT`，重建私有 exact tree，按 §6 创建 commit 并 ref CAS；
  不重复业务 provider。ref 成功后受控同步共享 index，复核相对新 HEAD 无未提交事务残留。
- **canonical adopt**：
  - 历史中不存在经验证 tx commit → 按 §7 把 `OUTPUT` 条件回滚为 `BEFORE`，清理私有 index/
    自有 lock/intent，交还上层重新审批；allowed-once 不持久化、不重放，核心恢复器不 import
    DSH、不自行审批。
  - 当前可达历史存在唯一、parent/tree/writeSet/blobs/txid/plan digest 全匹配的 tx commit →
    canonical 已成功，不回滚、不重做；仅补上层状态 receipt、受控同步 index 并清理 intent。
- intent 建立后首写前崩溃时全部目标为 `BEFORE/BASE`：state 可继续，canonical 视为尚未写并
  回到重新审批。恢复完成后必须满足：tx commit 成功且相对当前新 HEAD 无本事务未提交残留，
  或已完整回到 BEFORE/BASE；自有私有 index/lock/intent 已清理。

## 失败关闭与边界

- intent 建立前：任何预存 staged、未知 Git lock、锁获取失败、陈旧 expected state、
  preflight/CAS 失败都必须零工作树/index/ref 副作用。
- intent 建立后：仅 §7 的合法 partial matrix 可自动收敛；`CONFLICT`、能力/plan digest 不符、
  未知 staged/lock 一律保留现场并 fail-closed。无有效 intent 的 staged 仍为
  `STAGED_CONFLICT`，不能借恢复路径并入。
- ref CAS 失败不重写历史；canonical 无成功 tx commit 时条件回滚并重新审批；已成功 tx commit
  以当前可达历史中的唯一 identity/provenance 为准，不因 receipt/index 同步失败撤销。
- **边界**：Git 提交内容由私有 exact tree + ref CAS 保证，不受共享 index TOCTOU 影响；文件
  目标对不遵守锁的外部编辑器只在多个明确复核点提供乐观检测，check→rename 窄窗口不具备
  物理原子 CAS 保证。锁/CAS 是降低丢更新风险和 fail-closed 的机制，不是文件系统屏障。

## 未采用方案

- **A. `git add -A` + 单 commit**: 把 writeSet 外无关改动卷进事务 commit, 污染回滚面,
  与 N12「细粒度 CAS/手改/git diff」矛盾; 未采用。
- **B. 事务日志/数据库中间态**: 违反铁律 2(文件唯一真相, 不另建数据库/队列); 未采用。
- **C. 无锁乐观写**: 跨进程丢更新, CAS 也救不回「双方都基于旧内容写」的竞态; 未采用。
- **D. 整个仓库级锁/preflight**: 过度侵入, 与「writeSet 外允许无关 unstaged/untracked」
  的裁定矛盾; 未采用。
- **E. 失败时无条件回滚 / restore HEAD**: 可能抹掉用户并发编辑与目标原有未提交内容
  (§7 的事务前快照判定即为此而设); 未采用。
- **F. 以事务启动时状态为新 CAS 基线**: 把启动时读到的内容自动当基线, 会静默覆盖
  「输出生成/审批后、事务启动前」的外部改动, 丢陈旧基线检测; 未采用。
- **G. 失败时无条件 unstage / reset index**: 会抹掉回滚窗口内外部后续 staging 的信号,
  与「外部编辑保留并报告」矛盾; 未采用。
- **H. 仅进程内 try/finally 回滚, 不持久化 intent**: 无法覆盖 SIGKILL/断电/未捕获异常
  (回滚代码未运行)的崩溃点, 残留的工作树输出与 staged blob 无法归属、无法安全收敛; 未
  采用。
- **I. 崩溃恢复时重放/持久化复用 allowed-once 审批决定**: 违反铁律 3(审批决定不可复用,
  allowed-once 只放行一次); canonical adopt 中断一律条件回滚、交还上层重新审批; 未采用。
- **J. intent 写入工作树并随资产提交**: intent 是临时恢复元数据, 进 git 历史/工作树会
  污染回滚面与作者视角, 崩溃残留本身还会成为待处理噪音; 置于 `.git` 内部控制区、不进
  index; 未采用。

## 影响

- 新增（只做加法，铁律 4）：store 事务原语（expected-state preflight、乐观复核、状态矩阵、
  持久快照）、transaction intent 写/读/验证/清理与恢复入口；git 层新增私有 index、exact
  tree、`commit-tree`、`update-ref` CAS、可验证共享-index lock/同步及按 txid/plan digest 搜索
  可达历史的原语。既有 adopt/merge 签名不变，内部切换到事务语义或作为单目标特例。
- dsh 层: adopt 类工具(store_adopt、map_atlas_review 等)与 imports 六阶段 adopt 统一走
  事务 + ApprovalGate——审批在**纯核心事务外**由 dsh 调用方取得(核心事务 helper 不
  import DSH, 铁律 1), 审批后进入事务仍重新 preflight/CAS; 业务写面禁止 `git add -A`
  成为工具层约束。
- 验证要求：vitest/进程集成契约均注释引 N32，覆盖：①共享 index 任何预存 staged、未知
  index/ref lock、陈旧 expected state均在 intent 前零副作用拒绝；②私有 index 从 base HEAD
  构建的 exact tree 只含实际变化集，无关 unstaged/untracked 永不进 commit；③外部 ref 抢先
  前进使 `update-ref` CAS 失败，不 force；④冻结 tree 前后 hook 不得改提交内容；⑤在 write、
  private-index、commit object、ref CAS、共享-index 安装各点 kill，按 intent 与可达历史幂等
  收敛；⑥ `BEFORE/OUTPUT` 与 `BASE/OUTPUT` 所有 partial 组合，state 补完而 canonical 回滚
  重审批；⑦任一 `CONFLICT`、外部 staged/lock、kind/path/plan digest 不符均保留并拒绝；
  ⑧后续外部 commit 或作者编辑后仍能按 txid/plan digest 找到成功 commit，外部相同字节不被
  误认；⑨intent schema/大小/path traversal/symlink 校验；⑩MockApproval 断言 canonical
  未 commit 不重放 allowed-once；⑪提交前复核点：`update-ref` CAS 前重新 hash 全 writeSet
  工作树且均等于计划 output，并复核 ref 仍 base、private exact tree/plan digest 未变，
  任一不符不 update-ref、按状态矩阵条件回滚/报告。对不协作编辑器只测试明确复核点的
  冲突检测，不虚构 check→rename 物理原子性。完成标准 `npm test` 全绿 + `npm run
  typecheck` 零错误。
- 文档: N32 已录入 `specs/adjudications.md` 第八批; `docs/adr/README.md` 索引已更新。

## 实施期开放项

1. 锁实现细节(锁文件位置、心跳间隔、超时值、获取失败重试策略)留给实现期按
   `store-rules.md` 落地, 不上升为裁定。
2. expected state 的表示与传递(字段形态: 期望内容 hash / expected absent / 必要时
   HEAD/blob)与错误分类(`STALE_BASELINE` / `CAS_CONFLICT` / `STAGED_CONFLICT` 的具体
   错误码与报告格式)留给实现期按 `store-rules.md` 落地, 不上升为裁定。
3. 私有 index 文件布局、共享 index lock 的具体原子安装方式、业务 hook 的命令/超时与
   可达历史查询优化留实现期定；不得改变 exact tree、ref CAS 和未知 lock fail-closed 语义。
4. intent 目录/单文件形态、fsync 边界、快照格式、txid 生成、恢复触发时机与进程存活判定
   留实现期定；不得弱化版本化 schema、能力重推导和 tx commit 身份验证。
