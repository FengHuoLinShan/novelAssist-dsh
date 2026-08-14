# client 迭代 + C 挂载收尾 验收快照

- 日期: 2026-08-14(迁移后, novelAssist-dsh / main)
- 范围: ① C 的 DSH 挂载收尾(runDeepImport → dsh 工具); ② client 迭代(剧情地图 +
  写作台四模式); ③ 信号推送(轮询→mux)现状核查与落点。
- 实现:
  - `packages/novelcraft/dsh/src/deep-import.ts`(ImportTraceSink + deepImport)+
    `tools.ts` 新增 `novelcraft_deep_import` 工具 + `service.ts` 便捷方法
  - `packages/novelcraft/store/src/story-map.ts`(storyMap 纯读聚合)
  - `packages/novelcraft/client`: wire/rpc/host 半身 + StoryMapAction/WritingDeskAction 浏览器半身

## ① C 的 DSH 挂载收尾(seam 契约, packages/novelcraft/README.md)

| seam | 接线 | 关键行为 |
|---|---|---|
| provider | `service.llmProvider`(DshProvider → ctx.llm) | 内容步直连 ctx.llm, 无内部桥(§12/§22.5) |
| approve | `service.approval.request(agent, …)` | GateDecision 的 cancelled 视同 rejected(fail-closed, §9) |
| trace | `ImportTraceSink`(落 .assistant/import-trace.jsonl) | 事件按序补 seq/ts 追加 JSON 行, 进 git 回滚面(§15/§22.2) |
| 工具 | `novelcraft_deep_import` | root/start_chapter/end_chapter → 六阶段摘要; 同步执行(长任务留编排层分批) |

## ② 剧情地图 + 写作台四模式

| 块 | 数据面 | 端点 | UI |
|---|---|---|---|
| 剧情地图 | `store.storyMap`(threads/arcs/foreshadowing/reveals + Scene/章节覆盖, 直读结构资产 frontmatter) | story/map | StoryMapAction(会话头按钮 + Modal) |
| 写作台 | assistant 信号(守望)+ store.storyMap(计划)+ store.rebuildIndex(参照对象)+ .assistant/reviews 摘要(评审) | writing/desk | WritingDeskAction(四模式 tab) |

## ③ 信号推送(轮询 → mux)现状

- 现状: 宠物四态 5s 轮询 watch/state; 收件箱挂载/手动/u 键/动作后即时刷新。
- 阻塞(实现期核实): DSH rc.6 平台模块表不暴露 connection 事件/订阅 seam;
  ConnectionHandle.start(sinks) 的 mux 帧订阅被 runtime 单持有者独占。插件唯一
  数据面是 connection.rpc.call。
- 落点: 真 mux 推送需动 DSH 共享层(宿主发信号帧 + runtime/平台模块暴露订阅 seam),
  属上层确认/ADR 范畴; 本包内低成本「事件触发短轮询」未做(留待 ADR 后一并)。

## 验证矩阵(全部通过)

| 层 | 方式 | 结果 |
|---|---|---|
| dsh 挂载 | vitest 3 条(全链 adopt 过审批 + trace 落盘 / 拒绝 fail-closed / 工具摘要) | ✅ |
| store storyMap | vitest 2 条(聚合 + 空 vault 兜底) | ✅ |
| client 宿主 | vitest 2 条(story/map + writing/desk handler) | ✅ |
| client 构建 | build:host(tsc)+ build:client(tsdown, 纯度门禁 + CSS Modules) | ✅ |
| 全仓回归 | npm test 266 全绿 / npm run typecheck 零错误 | ✅ |

## 测试矩阵(全仓)

| 包 | 测试 | 包 | 测试 |
|---|---|---|---|
| vault | 29 | world | 6 |
| store | 70 | outline | 7 |
| llm-step | 19 | memory | 5 |
| writing | 15 | context | 5 |
| imports | 30 | rag | 4 |
| assistant | 15 | client | 10 |
| dsh | 34 | trace | 17 |
| **合计** | **266** | | |

## 复现

```sh
cd /Users/tywww/Desktop/项目/novelAssist-dsh
npm install
npm test            # 266 测试全绿
npm run typecheck   # 零错误
npm run build:client -w @novelcraft/client   # 浏览器 bundle(tsdown)
```

## 剩余

- [ ] 信号主动推送: 需 DSH 共享层 ADR(见 ③)。
- [ ] 剧情地图: foreshadowing↔reveal 配对、scene↔thread 外键、跨类关系索引(读面已就绪, 图/边增强留后)。
- [ ] 写作台: 计划台续写提案(proposeNextChapter 空引用未实现)、健康信号扫描器→pushSignal 落盘。
- [ ] 旧引擎退役仪式(ai-writing-assist main, 时点待用户)。
