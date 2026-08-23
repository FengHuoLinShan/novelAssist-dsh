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

- 现状: 宠物四态事件触发短轮询 + 退避(ADR-0018 §2); 收件箱挂载/手动/u 键/动作后即时刷新。
- 核实: 真推送 seam 已存在(host api-proxy 按 API_REMOTE_FORWARDED_EVENTS allowlist 转发
  host/remote-event 帧 → client runtime 扇出到 ctx.remote.$on); 缺口是 allowlist 封闭(11 条)。
- 落点(ADR-0018): 真 mux 推送已落地——scripts/apply-dsh-patches.mjs 给
  @deepseek-ai/dsh-api-remotes 的 allowlist 加通用 client/push + @novelcraft/dsh emit +
  @novelcraft/dsh-client ctx.remote.$on 订阅(seam 提案见
  docs/agent/dsh-rebuild/信号推送-远程事件seam提案.md); 上游 Discussion #1289 回应后去
  fork 化; 本包内「事件触发短轮询 + 退避」作兜底保留。

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
npm run build:client -w @novelcraft/dsh-client   # 浏览器 bundle(tsdown)
```

## 剩余

- [x] 信号主动推送: ADR-0018 + 窄缝补丁已落地(client/push 真推送 + 短轮询兜底, 见 ③)。
- [x] 剧情地图: foreshadowing↔reveal 配对(`reveals_foreshadowing` 边)、scene↔thread slug 引用边(`serves_thread`)、跨类关系索引(`VaultIndex.relations` 全资产有向图 + `storyMap().edges`; ADR-0019 Accepted, P0–P3 落地: validateRelations 写链硬错 + related_*_ids 兼容投影并集去重; 图/边 UI 已完成: StoryMapAction「关系边」Section
  (7 type 彩色徽章 + 删除线弱化 + 双语))。
- [x] 写作台: 计划台续写提案(proposeNextChapter → writing.proposeNextChapter + novelcraft_propose_next_chapter 工具, 计划 tab 展示)、健康信号扫描器→pushSignal 落盘(assistant.scanHealthSignals, 幂等确定性 id)。
- [ ] 旧引擎退役(ai-writing-assist main, 父仓库旧引擎保留, 时点待用户; novelAssist-dsh 侧已退役, 见 旧引擎退役-验收.md)。
