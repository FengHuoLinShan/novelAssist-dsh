---
name: novelcraft-world
description: NovelCraft 世界对象/别名/关系/世界书(M4 文件夹形态)+ 生成中心五模式。世界类任务先读本 skill。
whenToUse: 操作世界对象、复核待处理建议、生成中心对话/收束/探索/检修、世界书提案时。
---

# NovelCraft 世界(M4)

## 资产与落点

- 已采用对象: world/objects/*.md(canonical; aliases/tags/relations 在 frontmatter,
  N11/N13); 待处理建议: world/pending/*.md(队列即目录)。
- 别名不建新对象(R1); 已采用不硬删(git); 关系同向同型 create-or-merge。
- 世界书: bible/*.md(frontmatter status draft/canonical); 发布走 adopt+commit;
  页面建议是整页提案, apply 前重验 baseline。
- 世界对象创建/更新、五种生成模式与世界书草稿已有公开工具；合并/拆分与世界书历史仍是 `core-only`。
- UI 选中的资料标识必须原样传给 `source_refs`；不得只按同名标题猜来源。draft 来源只有作者显式勾选时才传 `include_working_drafts=true`。

## 当前可执行面

- `available-now`: `novelcraft_world_chat/converge/explore/inspect/bible_suggest`、
  `novelcraft_world_create/update`、
  `novelcraft_inbox_view`/`novelcraft_inbox_act` 记录复核决定,
  `novelcraft_store_adopt` 审批采用既有候选, 以及 6 个 `novelcraft_map_atlas_*` 工具。
- `core-only`: 世界对象 merge/split、世界书 history 与生成中心多轮会话编排。

## 生成中心五模式(§19: 不再是并列 UI, 是编排脑按意图调用的内容手步骤)

| 作者意图 | 调用 |
|---|---|
| 自由共创对话 | `novelcraft_world_chat`, 不写资产 |
| 「把这几页设定收束一下」 | `novelcraft_world_converge`, 只读汇聚 |
| 「还有什么可挖的」 | `novelcraft_world_explore`, ≤3 个一跳缺口 |
| 「检修这一页」 | `novelcraft_world_inspect`, findings 供复核 |
| 对象创建/更新 | `novelcraft_world_create/update`, ApprovalGate 后精确写入 |
| 页面提案 | `novelcraft_world_bible_suggest`, 只落 bible draft；发布再走 adopt |

## 复核纪律

- 待处理建议 → 收件箱信号卡(四动词: 采纳/打回/改一改/先放着); 采纳必过 approval。
- 打回必带理由(进 calibration.md); 低置信/冲突保持待处理。

## 世界地图册 map atlas(无生图; Phase 5 已落地 6 工具)

- 落点: `world/atlas/{nodes,pages,pending/nodes,pending/pages,images}/` + `.assistant/atlas/runs/*.json`
  (文件真相, ADR-0020); 图片目录 `world/atlas/images/` 写入 vault `.gitignore`。
- 内容步: `llm_step(spec=map_spatial_facts)`(每批 5 地点, 只读规划输入)+
  `llm_step(spec=map_atlas_plan)`(≤20 页, 层级严格递降)。**M4 不生图**(N28), `prompt` 仅为外部
  生图参考文本; `prompt_only` 页面不可 adopt。
- 空页占位: adopted 节点可无 page; 作者在地图册选中节点后选 PNG/JPEG,
  页内面板产生锁定 session + 节点的收据, agent 工具只消费 receipt。图片字节绝不 `git add`、不 push GitHub; adopt 必经
  ApprovalGate(fail-closed)。
- 文字标签 = L1 intent 队列 + `novelcraft_map_atlas_annotation` 工具应用(不过 approval);
  工具只消费队列或精确 ops, 拒绝自然语言坐标, 坐标恒 0–1。
- 工具预告(Phase 5): `novelcraft_map_atlas_plan/view/upload/review/annotation`
  (+可选 `update_prompt`); 规划 run 同步执行, adopt/adopt_placeholder/restore 过 ApprovalGate,
  reject/archive 经工具执行。
