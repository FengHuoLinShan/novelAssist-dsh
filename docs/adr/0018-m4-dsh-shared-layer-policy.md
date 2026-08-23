# ADR-0018 — M4 DSH 共享层改造政策(有界改造 + 上游回馈)

- **状态**: Accepted(2026-08-14, 用户裁定: 共享层政策 = 有界改造 + 上游回馈; 本轮信号
  推送先落地事件触发短轮询过渡, 不动共享层)
- **日期**: 2026-08-14
- **取代/补充**: 取代 ADR-0017 §3「构建链」中的绝对冻结立场(「不修改、不发布」); 其余
  (锁 `@deepseek-ai/*@0.1.0-rc.6`、源码 checkout 只读参考)不变。补充 ADR-0017
  「待确认事项」中信号推送的落地路径。
- **设计依据**: ADR-0016、ADR-0017; 实机核实结论见 `packages/novelcraft/client/README.md`
  §信号推送 与 `docs/agent/dsh-rebuild/client-迭代-验收.md` §③。

## 背景

novelAssist-dsh 是 fork `deepseek-harness` 的独立仓库, 但当前只持有 `packages/novelcraft/*`
覆盖层, `@deepseek-ai/*` 全部作为 peerDependencies(^0.1.0-rc.6)从 npm 消费, 未 vendor
任何 DSH 源码。**「DSH 共享层」**指 `@deepseek-ai/*` 平台/运行时层(core / client / api /
connection / runtime / web / storage / llm 等, 上游 deepseek-harness `packages/` 那 ~50
个包); `@novelcraft/*` 是覆盖层, 只经 DSH seam 互连(ADR-0016 §1), DSH 接触面唯一收敛在
`@novelcraft/dsh`(ADR-0017 §2)。

首个逼出该决定的需求是 client 信号推送(宠物四态)。实机核实:

- `connection.rpc.call` 是一元 request/response, 无 server→client 推送通道
  (`packages/client/connection/src/rpc.ts`);
- `ConnectionHandle.start(sinks)` 是单持有者的 mux 帧流, runtime 对象层独占, 第二次调用
  throw(`packages/client/connection/src/client/index.ts`);
- 真推送 seam 其实**已存在且三角色完整**: host `api-proxy` 按 `API_REMOTE_FORWARDED_EVENTS`
  allowlist 转发 `host/remote-event` 帧, client runtime 扇出到 `ctx.remote.$on`; 缺口只是
  allowlist 封闭(11 条 `as const`)。

因此真 mux 推送的最小改造 = 给 `@deepseek-ai/dsh-api-remotes` 的 allowlist 加一条(单包
pnpm patch), 而非改 connection + runtime; seam 提案见
`docs/agent/dsh-rebuild/信号推送-远程事件seam提案.md`。本 ADR 裁定「何时允许改、怎么改、
怎么退」。

## 决策

### 1. 共享层改造政策: 默认不改, 窄缝例外

- **默认立场**: `@deepseek-ai/*` 继续从 npm 锁版消费, 不修改、不发布(继承 ADR-0017 §3
  的默认面)。
- **窄缝例外**: 仅当某能力被上游 seam 明确卡死、且 @novelcraft 层无等价工作区时, 才允许
  改造共享层, 且按以下优先级选型:
  1. `pnpm patch`(版本作用域, 升级时重放并复核);
  2. 不得已才最小 rescope fork(仅 fork 需改的切片, 如 `dsh-api-remotes`), 其余包继续 npm。
- **每个窄缝改造必须满足四条纪律**:
  - **登记**: 在本文档「改造登记」或后续专表登记 patch/fork(包名、版本、目的、影响面);
  - **上游回馈**: 同时向上游 deepseek-harness 提 Discussion(上游关闭 issue 且暂不接受
    外部 PR, 反馈走 GitHub Discussions; 附最小复现与建议 seam 形状), 并在登记里链接;
  - **去 fork 化条件**: 写明「上游落地后移除 patch/fork、回到 npm」的触发条件;
  - **测试**: patch 行为有 vitest(真实 Cordis + 内存 fake)覆盖, fail-closed 与错误分类
    沿用 `@novelcraft/dsh` 的测试标准。
- **不采用**全量 vendor 整棵 `@deepseek-ai` 树; 若未来出现多个独立共享层需求, 另立 ADR
  升级政策并重估(届时本 ADR 被取代)。

### 2. 信号推送: 双层落地

- **本轮(2026-08-14)**: `@novelcraft/dsh-client` 落地「事件触发短轮询 + 退避」, 不动共享层:
  - 挂载 / 窗口聚焦 / 可见性恢复 / 动作后 → 立即刷新并把退避重置到短间隔;
  - 快照无变化时退避延长(封顶), 有变化时回到短间隔;
  - 保留一个非零基线轮询, 以捕获雷达后台产出(忙碌→待确认 的状态跃迁)。
- **真 mux 推送**: 按第 1 条走窄缝改造(上游 issue + pnpm patch `dsh-api-remotes` 的
  allowlist), 作为独立后续项, 不在本轮实现; seam 提案见
  `docs/agent/dsh-rebuild/信号推送-远程事件seam提案.md`。

### 3. 边界声明

- `@novelcraft/*` 覆盖层: 核心包保持零 DSH 运行时依赖, seam 契约不变(ADR-0017 §2);
- `@deepseek-ai/*` 共享层: 本 ADR 之后仅在 §1 例外下被改造, 且不改变 @novelcraft 对 DSH
  seam 的依赖方式。

## 对 ADR-0017 的取代/补充

ADR-0017 §3 的「不修改、不发布」由「绝对冻结」改为「默认冻结 + 本 ADR §1 窄缝例外」。
锁 rc.6、源码 checkout 参考、构建链以 npm 官方包为准的其余立场不变。

## 未采用方案

- **A 纯消费冻结**: 工作区会累积, 真推送无限期被封顶 → 未采用, 但保留为默认面。
- **C 全量 fork + vendor 整棵树**: 升级=rebase 一棵 ~50 包的树; DSH 尚 rc 预发布、
  `SESSION_FORMAT_VERSION=0` 无兼容承诺, 维护最重 → 未采用, 保留为未来升级选项。
- **D 上游先行**: 时间线不可控, 不足以作为唯一政策 → 并入 §1「上游回馈」纪律, 不单独成立。

## 改造登记

- 信号推送(通用 `client/push` 通道): 已向上游提交 Discussion #1289
  (https://github.com/deepseek-ai/deepseek-harness/discussions/1289)。窄缝 patch 已落地:
  `scripts/apply-dsh-patches.mjs`(postinstall 幂等, 给 dsh-api-remotes 的 allowlist 加
  `client/push`)+ `@novelcraft/dsh` emit(`src/push.ts` + tools 三处)+ `@novelcraft/dsh-client`
  订阅(`ctx.remote.$on` → DOM 事件 → useWatch 刷新)。去 fork 化: 上游合入等价通道后删补丁。

## 影响

- 共享层任何改造必须过 §1 四条纪律, 否则不得改动 `@deepseek-ai/*` 相关面。
- 本轮代码变更: `@novelcraft/dsh-client` 的 `useWatch` 轮询策略(§2), 无跨包 seam 变化。
- 上游 Discussion 落地后回填登记, 并触发对应 patch/fork 的去 fork 化。

## 待确认事项

- 真 mux 推送窄缝 patch 的落地时点(上游 Discussion #1289 已提交, 待 upstream 表态后定)。
