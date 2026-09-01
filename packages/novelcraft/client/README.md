# @novelcraft/dsh-client — DSH web client-module(阶段 B 已实现)

宠物(四态)/ 收件箱(卡片 + 四动词 + 键盘流)/ 剧情地图 / 写作台 / 章节正文工作区的 DSH web
客户端插件(设计文档 §9/§17)。双面包: node 半身 = `/novelcraft` 认证 Connection RPC 通道;
浏览器半身 = 会话头宠物动作 + 收件箱面板 + 剧情地图 + 写作台。

## 数据与动作路径(安全边界)

- **读**: 浏览器 → `connection.rpc.call('/novelcraft', ...)` → 宿主处理器 →
  `@novelcraft/assistant` 确定性函数(读 `.assistant/signals/*.json`, 文件真相)。
- **四动词**: `inbox/act` 只执行 `assistant.act`(记录决定); **adopt 类资产写入
  不在此通道** —— 采纳决定后由助手 agent 经 DSH approval 执行(§9 fail-closed)。
- DSH `0.1.2-alpha.4` 在 handler 前执行 Host/Origin 围栏和浏览器会话认证;
  官方默认部署是 loopback，已无 method-level authority 参数。载荷校验仍在处理器内。
- **文件输入**: `intake/stage-text` 只接浏览器选定的 UTF-8 bytes, 产生当前
  session 绑定收据与导入意图; 零章节资产写入。资产入库由 agent 工具消费收据完成。
- **章节编辑**: DSH 原生 `conversation.view` 标签承载长正文、Git history/diff、候选采用/拒绝和
  finding 选择；`chapter/stage-edit` 只冻结当前会话编辑 bytes。save/restore/review/revise/adopt
  均提交到当前对话的领域工具，canonical 写仍只有 approval + transaction 一条通路。

## 端点契约(src/wire.ts 为唯一 wire 权威)

| 端点 | 载荷 → 值 |
|---|---|
| `watch/state` | {sessionId?, workspacePath?} → {bound, open, attention, threshold, radarRunning}(宠物四态) |
| `inbox/list` | 同上 → {bound, signals[], threshold}(卡片 = 作者语言字段) |
| `inbox/act` | + {signalId, action, reason?, ...} → {ok, kind: adopt/microflow/record, microflow?, message} |
| `story/map` | {sessionId?, workspacePath?} → {bound, book, chapters, scenes, threads, arcs, foreshadowing, reveals}(剧情地图) |
| `writing/desk` | 同上 → {bound, book, chapters, threads, arcs, signals, objects, reviews}(写作台四模式) |
| `intake/stage-text` | {sessionId, file_name, bytes_base64} → {receipt_id, file_name, byte_length, sha256, message} |
| `intake/stage-atlas-image` | + {node_ref} → 锁定当前 session/节点的图片 receipt |
| `chapter/workspace` | {sessionId, chapterIndex, diffFromCommit?} → strict current + history/diff + fresh review/candidate |
| `chapter/stage-edit` | {sessionId, chapterIndex, expected_content_hash, title?, text} → session-bound edit receipt；零章节资产写入 |

四态判定: 待确认(open ≥ threshold, N3=5)> 忙碌(novelcraft-radar job 运行中)>
微光(0 < open < threshold)> 静默。键盘流: j/k 选择、1/2/3/4 四动词、u 刷新、Esc 关闭。

## 构建(DSH `0.1.2-alpha.4`)

- 宿主半身: `npm run build:host`(tsc → dist/index.js, 供 Loader 装载);
- 浏览器半身: `npm run build:client`(tsdown + vendor 的 DSH 共享预设
  `build/tsdown.client.ts` → dist/client.js, closure-factory + 纯度门禁;
  externals = platform 模块表: react / ui-primitives / ui-slots / …);
- 装载: profile patch 加一行 `{ name: "@novelcraft/dsh-client" }`; client-modules
  扫描要求 package.json 带 `dsh.client` 声明 **且 exports 暴露 `./package.json`**
  (否则 `require.resolve('<pkg>/package.json')` 失败 → 不进 boot 清单, 实现期实测发现)。

## 验证

- 宿主半身: `npm test`(8 条 RPC 处理器行为契约: 未绑定缺省 / 阈值触发 /
  workspacePath 回退 / 四动词 / 微工作流路由 / 作者语言错误)。
- E2E(已验): `--profile web --patch` 注入两行(dsh + client)→ dump-config 合成 →
  全树 boot 零错误 → 真实 web 服务 boot 清单含 `@novelcraft/dsh-client`(inject 边齐全)
  → `/plugins/@novelcraft/dsh-client/client.js` 200 → headless Chrome 渲染无控制台错误。

## 阶段状态

- [x] 宠物四态 + 收件箱(四动词 + 键盘流 + 中英文案)
- [x] /novelcraft 认证 Connection RPC 通道(宿主处理器 + 浏览器 hooks)
- [x] 构建链(vendor 预设)+ E2E 挂载验证
- [x] 剧情地图(story/map 端点 + StoryMapAction 面板)
- [x] 写作台五面(writing/desk + intake/stage-text, 守望/计划/评审/参照/导入 tab)
- [x] `conversation.view` 章节工作区(编辑收据、Git history/diff/restore、finding→返修→候选复审→审批采用/拒绝释放 pending)
- [x] 事件触发短轮询 + 退避(ADR-0018 §2: 固定 5s 轮询退役; 挂载/聚焦/可见/动作后立即刷新并重置退避)
- [x] 事件触发刷新 + 非零退避轮询；不修改 DSH 运行时包(N50)

## 信号刷新现状

- 现状: 宠物四态经 useWatch 事件触发短轮询 + 退避(挂载/聚焦/可见性恢复立即刷新, 快照
  无变化退避延长、有变化回到短间隔, 保留非零基线轮询捕获雷达产出); 收件箱在挂载/手动/
  u 键/动作后即时刷新(不轮询)。四动词后 inbox/act 已即时刷新收件箱。
- DSH `0.1.2-alpha.4` 的 typed remote allowlist 不包含自定义 `client/push`。公开包因此只使用本包已有的
  动作后即时刷新、页面聚焦/可见性刷新和非零退避轮询；不打补丁、不写 `node_modules`。
