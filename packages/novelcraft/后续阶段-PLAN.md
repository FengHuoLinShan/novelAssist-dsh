# R5/R6/R7 计划(后续阶段蓝图)

> 依据: ADR-0016 §16 R5–R7; 设计文档 §7–§11/§17/§22.3; specs/assets/*.md;
> specs/prompts/catalog.md 各域; adjudications 两批。

## R5 · 剩余领域插件(world / outline / memory / context / rag)

| 包 | 核心(纯 TS 确定性) | 内容步(catalog 引用) | 备注 |
|---|---|---|---|
| `@novelcraft/world` | 对象/别名/关系/世界书 CRUD 面(薄封装 store)、待处理队列读面、知识标签(tags 派生, N13 裁定)、去重报告组装 | catalog §4 的 11 spec(生成中心五模式/问答/世界书/地图册, §19 映射) | merge/split/attach_alias 已由 store 提供, 本包只做编排面 |
| `@novelcraft/outline` | Scene/threads/arcs 结构操作、结构健康信号(scene_* 四键 + structure_* 两键, N1)、总纲 outline.md 单文件读写 | catalog §2 的 5 spec(analyze/generate/story-outline/dedup/p20) | narrative_tag 合并(R64)、structure_meta 平铺(裁定#9) |
| `@novelcraft/memory` | events.jsonl 事件溯源(幂等键、append-only)、派生投影(snapshot/delta/checkpoint, 可重建) | 无 LLM | 事件 schema 以 small-modules §2 为准 |
| `@novelcraft/context` | 确定性上下文编译(Tier P0–P4 预算淘汰, CONTEXT_BUDGET 内置 N4)、编译摘要 | 无 LLM | 输入输出契约以 small-modules §4 为准 |
| `@novelcraft/rag` | chunk 落盘/索引重建、嵌入后端注入接口(D16: provider API 或本地模型, 可插拔) | 嵌入调用走注入的 Provider 接口 | 检索质量非 v1 门槛 |

验收: 各包 vitest 行为契约(对 specs/assets + store-rules 相关规则)+ 根全绿。

## R6 · assistant(六雷达 + 信号 + 收件箱 + 守望)

- **纯 TS 核心**(本阶段): 信号 schema(§8 统一形状)、收件箱逻辑(四动词 → 确定性动作映射:
  采纳→adopt、打回→记录理由进 calibration、改一改→微工作流触发接口、先放着→延迟)、
  信号新鲜度(正文 content_hash 变化 → 信号过期)、阈值触发(notify_threshold=5, N3)、
  per-book 校准笔记读写(calibration.md)。
- **DSH 挂载阶段**(后续): 雷达调度(jobs/schedule/goal seam)、宠物/收件箱 client 面(R7)。
- 微工作流目录 `microflows.yml` 首批 6 条(D7)的**确定性骨架**: 每个 microflow =
  参数 schema + 阶段函数引用(去重修复→world.applyDedup 子集、Scene 重切→imports
  sliceChapterBatch、补设定→world 生成中心 spec、审章→writing.semantic_review、
  改对象名→store rename、续写提案→writing_generate 接口)。
- 验收: 信号/收件箱/新鲜度/校准的行为契约测试。

## R7 · client 模块 + 发布

- `@novelcraft/client`: DSH web client-module(clientModules seam, `window.__DSH_BOOT__`
  注入)——宠物(四态: 静默/微光/忙碌/待确认角标)、收件箱(卡片 + 四动词 + 键盘流 j/k/1-4/u)、
  写作台四模式(§17.4, 半屏布局 D10)、剧情地图(Story Map)。
  **注意**: 需 DSH 源码 checkout 构建 client 插件(dsh-rebuild 最终报告 §2.3 缺口 3 已记录
  此依赖), 实现期再核实 client-modules 的构建链。
- `novelcraft-starter`: profile bundle(plugins + presets + skills + 示例 vault)+
  一键安装文档 + seam 兼容矩阵(D21: 锁 rc.8)。
- 发布: npm 拆包发布 @novelcraft/*; monorepo 版本策略(D22)。

## 贯穿约定(所有后续阶段)

1. 核心逻辑一律纯 TS 确定性库 + vitest 直测; DSH seam(jobs/schedule/goal/ctx.llm/
   approval/credentials/client-modules)只在挂载阶段接, 且用注入接口保持可 mock。
2. 每条测试注释引规则/裁定编号; 行为契约 = 对 specs/ 的唯一回归面(§15)。
3. 每阶段完成: 包内全绿 + 根 `npm test --workspaces` 全绿 + typecheck 零错误 +
   检查点 commit(不进 main, 只在 codex/m4-dsh-plugin-rewrite)。
