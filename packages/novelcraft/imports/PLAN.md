# R4 · imports 六阶段 + L0–L4 去重计划(最复杂编排域)

> 依据: ADR-0016 §16 R4; 设计文档 §5/§6/§6.1/§10; specs/assets/imports.md;
> specs/prompts/catalog.md §1(9 spec); specs/rules/store-rules.md(导入相关规则);
> adjudications 两批 + N3/N6/N12。

## 形态决策(与 R3 一致)

- **核心 = 纯 TS 确定性阶段函数**(每阶段一个函数, 顺序可测, MockProvider 驱动);
  **并行 fan-out 与 workflow 脚本属 DSH 挂载阶段**(pipeline 编排留在后面写),
  R4 只交付「每个批次单元可独立执行」的函数面, 保证脚本层零业务逻辑。
- 编排真相 = `.assistant/checkpoint.json` + session log(§22.2); 幂等续跑
  (input_fingerprint fail-safe, imports.md 的 checkpoint 规则)。

## 阶段函数(全部经 llm-step + store)

| 函数 | 内容步 spec | 产物 |
|---|---|---|
| `planImport(root, range, opts)` | 无 LLM(编排脑) | 阶段计划 + 成本预告 + 授权快照写入 checkpoint.json(begin_import 语义, authorization_confirmed 强制) |
| `sliceChapterBatch(provider, batch)` | scene_slicing / anchor_repair / gap_recovery | Scene 候选(临时, 不落 scenes/, imports.md 裁定) |
| `enrichSceneBatch(provider, scenes)` | scene_enrichment | 语义补全候选 |
| `fuseSceneBatch(provider, pairs)` | scene_fusion | 融合操作(operation 归一 R60) |
| `commitScenes(root, candidates)` | 无 LLM | scenes/*.md + 单次 git commit; provenance_key 幂等(R 幂等规则)、精确 span 不重叠 fail-closed、冻结源覆盖断言 |
| `extractEntityBatch(provider, scene)` | entity_extraction | world/pending/*.md(entity_key 去重、同名同型复用、0.88 阈值) |
| `aliasRelationBatch(provider, scene)` | alias_relation | 别名附着(只附着不建新对象)+ 关系(create-or-merge, N11) |
| `dedupeGroup(L1/L2)` | dedup_judge(仅 L2 低置信) | L1 分组判断(编排脑)+ L2 精判 + 去重报告(§6.1 形态) |
| `applyDedup(root, report)` | 无 LLM | store merge/split/attach_alias + merge-log(N4)+ 一次确认由上层 approval 门禁 |
| `analyzeStructure(provider, range)` | structure_analysis | structure/{threads,arcs,foreshadowing,reveal}/ + 置信 ≥0.96 才自动应用(R 结构去重) |
| `resumeImport(root)` | 无 LLM | 读 checkpoint.json 跳过已完成批次(幂等续跑) |

## 降级条款(进 policy + 每函数显式实现, catalog §1 + store-rules 降级节)

- 1b provider 失败 → 空语义进复核; 2b 失败只降级不丢对象; 1a 重叠 → 整章 fallback
  不部分采用; 其余以 store-rules 降级节为准。

## 验收

- vitest: 每阶段函数的行为契约(对 store-rules 导入相关规则逐条); 端到端顺序跑
  (MockProvider 脚本化响应)覆盖「六阶段全链 + 中断后 resumeImport 幂等续跑 +
  去重报告生成 + applyDedup 后 merge-log」。
- 手动 demo: `scripts/r4-demo.mjs`(MockProvider)对 3 章样章跑全链, 逐阶段打印
  产物与报告摘要。

## 非目标(留后)

- workflow 脚本/pipeline fan-out(DSH 挂载阶段)、ralph 修复环(R6)、
  摄入雷达自动触发(R6)、microflow 目录(去重修复/Scene 重切等 → R6)。
