---
name: novelcraft-map
description: NovelCraft 剧情地图(M4): map observations/空间事实 → 剧情雷达与 Story Map 读面; 世界地图册(map atlas)规划/审核/图片导入。地图类任务先读本 skill。
whenToUse: 涉及地图状态、空间事实、剧情地图(Story Map)展示、世界地图册(map atlas)规划/审核/图片导入时。
---

# NovelCraft 剧情地图(M4)

## Story Map / map observations

- map observations 是派生读面(源数据在 scenes/memory/世界对象); 文件真相优先。
- Story Map(§17.5): 章 × 线索 × Scene 时间线视图; 数据来自剧情雷达读面
  (memory.projectWorldState + outline 结构)。
- 章节档案(§17.5.1): 剧情地图/写作台的章节行可点开整页档案(Scene 分解/人物在场/POV/
  伏笔种下-回收对账/设定引用/节奏/审查/信号); 纯读, 不写资产。
- 纪律: 地图展示不改资产; 修订提案进收件箱。

## 世界地图册 map atlas(M4, 无生图; 随 Phase 5 落地)

- 空间事实提取: `llm_step(spec=map_spatial_facts)`(catalog §4.12), 每批 5 地点, 只作规划输入,
  不回写正式资产。
- 层级规划: `llm_step(spec=map_atlas_plan)`(catalog §4.11), 最多 20 页、层级严格递降、
  interior 需显式授权; **M4 不生图**(N28), `prompt` 仅为外部生图参考文本产物。
- `prompt_only` 页面仅参考、**不可 adopt**; 地图册页必须 = 本地图片 + 可移动自定义文字标签。
- 空页占位: 允许 adopted 空节点占位先进入地图册, 作者点进去后再上传图片。
- 本机路径导入(N29): 「上传」= 解析本机绝对路径 + 校验 + `mode=copy` 复制到
  `world/atlas/images/`(gitignore, 不 push GitHub); 图片字节绝不 `git add`; 候选写入不过
  approval, adopt 必经 ApprovalGate(fail-closed); 换机/克隆缺图 → 读面 `image_missing=true`。
- 文字标签 = L1 + 快捷编辑桥: UI 直接拖动/改名/增删(本地即时反馈), 保存只写 annotation intent
  队列, 由助手 agent 调 `novelcraft_map_atlas_annotation` 工具应用; 工具只消费队列或精确 ops,
  拒绝自然语言坐标描述, 坐标恒归一化 0–1; 标签是作者内容编辑, 不走 ApprovalGate。

### 工具清单预告(随 Phase 5 落地)

1. `novelcraft_map_atlas_plan` — 规划 run **同步执行**(同 deep_import 模式, timeout 3600s),
   返回 run_id/status/planned_page_count/evidence_summary/message。
2. `novelcraft_map_atlas_view` — 只读: review 或 atlas tree(图片页/空页占位/prompt_only 候选/
   image_missing)。
3. `novelcraft_map_atlas_upload` — 本机路径导入候选图(候选不过 approval)。
4. `novelcraft_map_atlas_review` — action=adopt|adopt_placeholder|reject|archive|restore;
   adopt/adopt_placeholder/restore 过 ApprovalGate(fail-closed)。
5. `novelcraft_map_atlas_annotation` — 应用 UI 队列或精确 ops(标签编辑不过 approval)。
6. (可选)`novelcraft_map_atlas_update_prompt` — 仅 prompt_only 候选可改 Prompt。

> 上述工具尚未实现, 属 Phase 5 交付范围; 挂载前不承诺可直接调用, 仅作能力口径预告。
