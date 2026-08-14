# @novelcraft/client — DSH web client-module(阶段 B 已实现)

宠物(四态)/ 收件箱(卡片 + 四动词 + 键盘流)/ 剧情地图 / 写作台四模式的 DSH web
客户端插件(设计文档 §9/§17)。双面包: node 半身 = `/novelcraft` loopback RPC 通道;
浏览器半身 = 会话头宠物动作 + 收件箱面板 + 剧情地图 + 写作台(四模式 tab)。

## 数据与动作路径(安全边界)

- **读**: 浏览器 → `connection.rpc.call('/novelcraft', ...)` → 宿主处理器 →
  `@novelcraft/assistant` 确定性函数(读 `.assistant/signals/*.json`, 文件真相)。
- **四动词**: `inbox/act` 只执行 `assistant.act`(记录决定); **adopt 类资产写入
  不在此通道** —— 采纳决定后由助手 agent 经 DSH approval 执行(§9 fail-closed)。
- 通道 authority = `loopback`(单用户本机); 载荷校验在处理器内, 未绑定工作区 →
  capability 缺省, 不炸通道。

## 端点契约(src/wire.ts 为唯一 wire 权威)

| 端点 | 载荷 → 值 |
|---|---|
| `watch/state` | {sessionId?, workspacePath?} → {bound, open, attention, threshold, radarRunning}(宠物四态) |
| `inbox/list` | 同上 → {bound, signals[], threshold}(卡片 = 作者语言字段) |
| `inbox/act` | + {signalId, action, reason?, ...} → {ok, kind: adopt/microflow/record, microflow?, message} |
| `story/map` | {sessionId?, workspacePath?} → {bound, book, chapters, scenes, threads, arcs, foreshadowing, reveals}(剧情地图) |
| `writing/desk` | 同上 → {bound, book, chapters, threads, arcs, signals, objects, reviews}(写作台四模式) |

四态判定: 待确认(open ≥ threshold, N3=5)> 忙碌(novelcraft-radar job 运行中)>
微光(0 < open < threshold)> 静默。键盘流: j/k 选择、1/2/3/4 四动词、u 刷新、Esc 关闭。

## 构建(D21 锁 rc.6)

- 宿主半身: `npm run build:host`(tsc → dist/index.js, 供 Loader 装载);
- 浏览器半身: `npm run build:client`(tsdown + vendor 的 DSH 共享预设
  `build/tsdown.client.ts` → dist/client.js, closure-factory + 纯度门禁;
  externals = platform 模块表: react / ui-primitives / ui-slots / …);
- 装载: profile patch 加一行 `{ name: "@novelcraft/client" }`; client-modules
  扫描要求 package.json 带 `dsh.client` 声明 **且 exports 暴露 `./package.json`**
  (否则 `require.resolve('<pkg>/package.json')` 失败 → 不进 boot 清单, 实现期实测发现)。

## 验证

- 宿主半身: `npm test`(8 条 RPC 处理器行为契约: 未绑定缺省 / 阈值触发 /
  workspacePath 回退 / 四动词 / 微工作流路由 / 作者语言错误)。
- E2E(已验): `--profile web --patch` 注入两行(dsh + client)→ dump-config 合成 →
  全树 boot 零错误 → 真实 web 服务 boot 清单含 `@novelcraft/client`(inject 边齐全)
  → `/plugins/@novelcraft/client/client.js` 200 → headless Chrome 渲染无控制台错误。

## 阶段状态

- [x] 宠物四态 + 收件箱(四动词 + 键盘流 + 中英文案)
- [x] /novelcraft RPC 通道(loopback, 宿主处理器 + 浏览器 hooks)
- [x] 构建链(vendor 预设)+ E2E 挂载验证
- [x] 剧情地图(story/map 端点 + StoryMapAction 面板)
- [x] 写作台四模式(writing/desk 端点 + WritingDeskAction 面板, 守望/计划/评审/参照 tab)
- [ ] 信号变化主动推送(现为 5s 轮询 + 动作后即时刷新; 真 mux 推送需 DSH 共享层暴露订阅 seam, 见 §信号推送)

## 信号推送(轮询 → mux)现状

- 现状: 宠物四态经 useWatch 固定 5s 轮询 watch/state; 收件箱在挂载/手动/u 键/动作后
  即时刷新(不轮询)。四动词后 inbox/act 已即时刷新收件箱。
- 阻塞(实现期核实): DSH rc.6 平台模块表(build-tools/web/src/platform.ts)不暴露
  connection 事件/订阅 seam; ConnectionHandle.start(sinks) 的 mux 帧订阅被 runtime
  单持有者独占(second call throws)。插件唯一数据面是 connection.rpc.call。
- 落地路径: (a) 本包内把固定轮询改事件触发短轮询/退避(无跨层风险, 未做); (b) 宿主向
  mux 发信号帧 + runtime/平台模块暴露订阅 seam —— 需动 DSH 共享层, 属上层确认/ADR 范畴。
