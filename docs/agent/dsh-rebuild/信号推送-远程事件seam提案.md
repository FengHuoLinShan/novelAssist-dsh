# 信号推送 seam 提案(真 mux 推送, ADR-0018 §1 前置件)

- 状态: Implemented(方案 B 已裁定并落地; 上游 Discussion #1289 已提交; 去 fork 化待上游回应)
- 关联: ADR-0018 §1(有界改造 + 上游回馈)、ADR-0018 §2(信号推送双层落地)
- 日期: 2026-08-14

## 0. 结论(修正此前盘点)

真 mux 推送的 seam 在 DSH rc.6 **已经存在且三角色完整**, 不是"缺 seam", 而是"词表封闭"。
此前 `packages/novelcraft/client/README.md` 与
`docs/agent/dsh-rebuild/client-迭代-验收.md` 记的"插件唯一数据面是 connection.rpc.call /
需动 connection+runtime"是盘点遗漏, 本提案一并修正: 最小改造 = 给
`@deepseek-ai/dsh-api-remotes` 的 allowlist 加一条(单包), 而非改 connection + runtime。

## 1. 已核实事实(源码)

- **消费面已存在**: `ctx.remote.$on(event, listener)`(Typert 类型化), 已有消费者
  (`packages/extensions/cordis-client-runner/src/client/index.ts:295`、
  `packages/extensions/ui-cordis/src/client/index.ts:73`)。
- **Provider(host)已存在**: `packages/host/apiproxy/src/api-proxy.ts:3620-3633` 对
  allowlist 每个名字 `ctx.on(name, …)` → 打包 `{type:'host/remote-event', event, args}` 帧。
- **Provider(client)已存在**: `packages/client/runtime/src/client/index.ts:204` 起
  `onHostEnvelope` 把 `host/remote-event` 帧 `ctx.remote.$dispatch(event, args)` 扇出。
- **唯一缺口**: `packages/api/remotes/src/remote-events.ts` 的
  `API_REMOTE_FORWARDED_EVENTS` 是 11 条 `as const` 封闭 allowlist; `types.ts` 用
  `TypertRemoteEventSelection extends Record<ApiRemoteForwardedEvent, true>` 锁住 `$on`
  键面(不在表内 → `TypertRemoteEvent` 为 `never`)。

## 2. 三角色映射(seam 已完整)

| 角色 | 现状 |
|---|---|
| Service Definition | `ctx.remote`(`TypertClientRemote.$on` / `$dispatch`) |
| Service Provider | host `api-proxy` 转发循环 + client runtime `onHostEnvelope` 桥 |
| Consumer | 插件 `ctx.remote.$on('event', listener)` |

结论: 无需新增 capability seam, 只需扩 allowlist 词表。

## 3. 缺口与两方案

| | 方案 A(特定事件) | 方案 B(通用推送通道, **已裁定**) |
|---|---|---|
| allowlist 改动 | 加 `novelcraft/signals-changed`; 每加一个事件再动一次共享层 | 只加一条 `client/push`, args = `[channel, payload]` |
| host 侧 | `ctx.emit('novelcraft/signals-changed', payload)` | `ctx.emit('client/push', 'novelcraft/signals-changed', payload)` |
| client 侧 | `ctx.remote.$on('novelcraft/signals-changed', …)` | `ctx.remote.$on('client/push', (channel, payload) => …)` 按 channel 过滤 |
| 上游接受度 | 低(DSH 核心 allowlist 混入 novelcraft 词表) | 高(通用插件→客户端推送能力, 符合"一切皆插件") |
| 未来扩展 | 每个新推送事件都要再动共享层 | 新频道零共享层改动 |

**裁定(2026-08-14)**: 采用方案 B。方案 A 未采用(DSH 核心 allowlist 不混入下游词表)。

## 4. 窄缝 patch 面(单包 `@deepseek-ai/dsh-api-remotes`)

1. `remote-events.ts`: `API_REMOTE_FORWARDED_EVENTS` 加 `'client/push'`。
2. `types.ts`(或新文件): `declare module '@deepseek-ai/cordis' { interface Events {
   'client/push'(channel: string, payload: JsonValue): void } }`。声明合并模式同
   `llm/adapters-updated`(见 `packages/llm/llm/src/types.ts:23`)。

api-proxy 已 import 该包, 事件增强自动进其编译面, `ctx.on('client/push', …)` 类型化;
单包 pnpm patch 即可, **无需改 connection / runtime / api 帧类型**。

> 注: 本仓库用 npm workspaces(非 pnpm), 落地时优先 `patch-package`(npm 等价物)或最小
> rescope fork(ADR-0018 §1 选型 2), 不硬套"pnpm patch"。

## 5. 接线(挂载后)

- host `@novelcraft/dsh`: 信号产出点(radar 落盘、inbox act、深度导入收尾等)
  `ctx.emit('client/push', 'novelcraft/signals-changed', payload)`。
- client `@novelcraft/client`: `ctx.remote.$on('client/push', (channel, payload) => {
  if (channel === 'novelcraft/signals-changed') refresh() })`, 替换退避基线轮询的即时性
  (退避轮询保留为雷达后台产出的兜底)。

## 6. 去 fork 化条件(ADR-0018 §1 纪律)

上游把通用 `client/push`(或等价通用通道)合入 allowlist 后, 删除本 patch、回到 npm 锁版
消费; 登记见 ADR-0018「改造登记」。

## 7. 上游回馈(已提交)

上游关闭 GitHub issue、且 CONTRIBUTING 声明暂不接受外部 PR, 反馈唯一通道是 GitHub
Discussions。已提交(分类 Ideas):

- **Discussion #1289** — "Idea: generic host→client push channel for plugin events
  (`client/push`)"：https://github.com/deepseek-ai/deepseek-harness/discussions/1289

正文要点: ① allowlist 封闭(`API_REMOTE_FORWARDED_EVENTS` 11 条)挡住插件自定义推送;
② 提议加一条通用 `client/push`(args `[channel, payload]`); ③ 反问上游是否更想要一等
`ctx.clientEvents` Service Definition / Provider / Consumer seam; 已明确告知本地 fork 会
先 patch 过渡。
