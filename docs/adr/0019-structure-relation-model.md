# ADR-0019 — 结构资产统一关系模型(relations 有向对收敛 + 跨类关系索引)

- **状态**: Accepted(2026-08-14, 用户裁定: `serves_thread` 统一四类源; reveal.target /
  scene.pov_character_id 作为身份锚保留顶层字段; type 不编码源 kind; 附录 A 7 type 定稿)
- **日期**: 2026-08-14
- **取代/补充**: 补充 ADR-0016 §2「文件夹真相」的关系表示法; 对齐 `specs/adjudications.md`
  N11(对象 relations 存储形态)。**不取代** N11, 把它的有向对模型从世界对象扩展到结构资产。
- **设计依据**: `specs/assets/outline.md`(Scene/PlotThread/OutlineArc/ForeshadowingPlan/
  RevealPlan 字段表)、`specs/adjudications.md`(#9 structure_meta 平铺 / #11 planned_payoff_scene
  改 slug / N11 relations 有向对 / N12 结构资产目录化)、`packages/novelcraft/store` 现状。

## 背景

M4 下关系有两种并存表示法, 且**只有一种是索引化的一等公民**:

| 资产 | 关系表示 | 是否进 `VaultIndex.relations` |
|---|---|---|
| 世界对象(world/objects、world/pending) | 统一 `relations: []` 有向对 `{target, type, status}`(N11) | ✅ `rebuildIndex` 扫描并产出有向对 |
| 结构资产(thread/arc/scene/foreshadowing/reveal) | 散字段 `related_thread_ids` / `related_character_ids` / `related_entity_ids` / `related_memory_ids` | ❌ 不进索引; `storyMap()` 现拼跨类边 |

证据: `store/src/index.ts` 的 `rebuildIndex()` 只扫 `world/objects` + `world/pending` 的
`data.relations`; `store/src/story-map.ts:2-3` 注释明确「跨类关系边不在 VaultIndex.relations 里,
由本函数直读 frontmatter 的 related_*_ids 组装」。

剧情地图三个未完成项(foreshadowing↔reveal 配对、scene↔thread 边、跨类关系索引)是**同一缺口
的首批暴露**: 结构资产没有统一关系模型。散字段模式每新增一条边要同时改 frontmatter 字段、
schema 声明、校验、读面组装、测试、spec/文档六处; 且无法表达「thread X 经 arc Y 影响哪些
scene」这类跨两步图查询。按散字段继续补, 字段会随边数持续爆炸。

## 决策

### 1. 关系写面统一: 结构资产也走 `relations: []` 有向对

结构资产(thread/arc/scene/foreshadowing/reveal)与对象一样, 以 frontmatter 顶层
`relations: []` 为关系写面, 元素形状与 N11 一致:

```yaml
# structure/reveal/身世.md
relations:
  - target: 怀表          # 裸 slug, 指向 foreshadowing(目录上下文给 kind)
    type: reveals_foreshadowing
    status: canonical
  - target: 主线          # 指向 thread
    type: serves_thread
```

- `target` = 裸 slug(N2); 目标 kind 由 `type` 白名单约束, 不靠字段名隐含。
- `status` 沿 N11 默认 `canonical`。
- 现有 `related_*_ids` 字段**保留**, 作为高频关系的便捷投影与兼容层(见 §3), 不立即删除。

### 2. relation `type` 枚举 + (sourceKind, type) 白名单

- 核心 relation type 枚举进 store 硬校验(确定性, 不依赖 LLM), 初表见附录 A。
- 每类资产的 schema 声明**允许的 type 子集**与**目标 kind 约束**, 越界/端点 kind 不符 → 拒绝
  (与 `store-rules.md:278`「拒绝自环与影子端点」一致)。
- 扩展类型走 policy 白名单(与「复核类型只推荐」的口径一致), 不硬编码死枚举; 但核心类型
  必须进 store 以保证确定性校验与测试覆盖。
- **type 表达关系语义, 不编码源 kind**: 源 kind 由目录上下文给定(N2)。「关联剧情线」统一为
  `serves_thread`, 源是 arc 还是 scene 由源文件所在目录区分, 不另设 `advances_arc` 之类
  「源 kind + 目标」的复合 type。
- **身份锚与关系边分层**: 必填单目标身份锚(如 `reveal.target_type/target_id`、
  `scene.pov_character_id`)是资产的存在理由, **保留顶层字段、不进 relations**; 只有
  可选多目标关联才走 `relations`(见附录 A)。

### 3. `related_*_ids` 降级为兼容投影

- 读面(`storyMap` / 索引)把 `related_*_ids` 展开为等价有向边, 与 `relations` 边**并集去重**。
- 写面: 新资产/新工作流写 `relations`; 旧 `related_*_ids` 字段**读时继续兼容**, 写端逐步
  废弃(废弃节奏见 §5, 不违反「核心包只做加法」)。
- 这避免「回头改接口」: `related_*_ids` 的既有消费者不破, 新能力走统一边。

### 4. 跨类关系索引: `VaultIndex.relations` 扩展为全资产有向图

- `rebuildIndex()` 除世界对象外, 增加扫描结构资产目录 + scene 的 `relations` 字段, 产出
  **跨类有向对**(source/kind 由目录上下文给定), 仍是纯派生、可全量重建、非编辑入口。
- `storyMap`、结构健康信号、context 编译、写作雷达统一消费这一个索引, 不再各自现拼边。

### 5. 演进路径(只做加法, 兼容存量)

| 阶段 | 动作 | 破坏性 |
|---|---|---|
| P0 | 新增 `validateRelations()`: 校验 relations 边自环/悬空/type 白名单/端点 kind | 加法 |
| P1 | 结构资产 schema 加 `relations: 'list'`; `rebuildIndex` 扫结构资产目录进 `VaultIndex.relations` | 加法 |
| P2 | `storyMap` 改消费统一索引, 三缺口(配对/场景线/弧线)以 type 枚举表达; `related_*_ids` 作兼容投影返回 | 读面切换, 写面兼容 |
| P3 | 新工作流写 `relations`; `related_*_ids` 写端逐步废弃, 读端长期保留 | 长期收敛 |

## 未采用方案

- **A 纯散字段(仅补三条边的 related_*_ids)**: 短期最省, 但字段爆炸 + 无法图查询, 每半年
  重演一次「加边要动六处」; 未采用。
- **B 一步到位纯 relations(删除 related_*_ids)**: 对作者 frontmatter 手写/diff/spec 字段表
  不友好, 且破坏既有 `storyMap`/context/健康扫描消费者, 违反「只做加法」; 未采用, 保留为
  长期终点(§3 收敛方向)。
- **C 关系表/数据库外键**: 违反 ADR-0016「文件唯一真相」与「不另建数据库/队列」; 未采用。

## 影响

- 新增: `relations` 字段进结构资产 schema; `validateRelations()`; `VaultIndex.relations`
  扩展为跨类; relation type 枚举 + 白名单进 store 与 specs。
- 兼容: `related_*_ids` 读面继续返回, 现有测试不破(新增断言覆盖并集去重与展开等价)。
- 契约: `VaultIndex`、`StoryMap` 是跨包消费的读面形状; 本 ADR 只做加法(新导出/新字段),
  不改变既有函数签名, 符合「核心包不得回头改接口」。
- 文档: `specs/assets/outline.md` 补结构资产 relations 字段; `specs/adjudications.md` 补
  N14+(关系模型裁定编号)与 type 枚举; 本 ADR 转 Accepted 后同步 `docs/adr/README.md` 索引。

## 待确认事项

1. ~~本 ADR 状态 Proposed~~ **已转 Accepted**(2026-08-14 用户确认)。
2. ~~附录 A 的 type 枚举完整性 / `reveals_target` 去留~~ **已裁定(用户)**: `serves_thread`
   统一四类源(scene/arc/foreshadowing/reveal); `reveal.target_type/target_id` 与
   `scene.pov_character_id` 作为身份锚**保留顶层字段、不进 relations**; type 不编码源 kind
   (删 `advances_arc`), 源 kind 由目录上下文给定。附录 A 已按此回写为 7 个 type。
3. §3 兼容投影的废弃节奏: `related_*_ids` 写端何时停止。**当前事实**: M4 无任何生产工作流
   写 `related_*_ids`(写入路径只透传 title/summary/relations 等), 写端已自然收敛到
   `relations`; 读端长期保留展开投影(N17)。「正式禁用写端」不再单独设置门禁, 以本事实为准。
4. ~~`reveal.related_thread_ids` 必填放宽~~ **已裁定(用户, 2026-08-14)**: 现在放宽——
   `related_thread_ids` 从 reveal required 列表移除, 「未归类」=「无边」; 已兑现于
   `store/src/frontmatter.ts` reveal schema。
5. ~~validateRelations 接入写链语义~~ **已裁定(用户, 2026-08-14)**: 接入 + 硬错拒绝。
   写结构资产(store 直写 / outline.writeStructureAsset / imports.writeStructFile)前调用
   `assertValidRelations()`, 失败抛 `StoreError(VALIDATION_FAILED)`, 与 adopt fail-closed 一致。

## 附录 A: relation type 枚举初表(核心, 进 store 硬校验)

type 表达关系语义、不编码源 kind; 身份锚不进 relations。两类共 7 个 type:

### 结构归属边

| type | 目标 kind | 允许源 kind(精确自 specs 字段表) | 语义 | 对应存量字段 |
|---|---|---|---|---|
| `serves_thread` | thread | scene / arc / foreshadowing / reveal | 关联剧情线(源 kind 由目录区分) | 各类 `related_thread_ids` |
| `belongs_to_arc` | arc | scene | Scene 隶属篇章 | scene.structure_meta.parent_outline_arc_id |
| `reveals_foreshadowing` | foreshadowing | reveal | 揭示回收伏笔(配对) | 新增 |
| `pays_off_in_scene` | scene | foreshadowing | 伏笔兑现 Scene | planned_payoff_scene(#11 改 slug) |

### 引用边(指向世界资产)

| type | 目标 kind | 允许源 kind | 语义 | 对应存量字段 |
|---|---|---|---|---|
| `references_character` | character | thread / arc / scene | 关联人物 | related_character_ids |
| `references_entity` | entity | thread / arc / scene / foreshadowing | 关联实体 | related_entity_ids |
| `references_memory` | memory | thread | 关联记忆 | related_memory_ids |

### 保留顶层字段(身份锚, 不并入 relations)

- `reveal.target_type` / `reveal.target_id`(必填单目标, reveal 的存在理由与查询键)。
- `scene.pov_character_id`(单目标身份锚)。

> 注 1: 源 kind 允许集严格取自 `specs/assets/outline.md` 字段表, 不凭语义扩写——例如
> `related_memory_ids` 仅 thread 持有, `related_character_ids` 不含 foreshadowing/reveal。
> 注 2: `thread` 之间的互证/关联(如「互证回响」)暂未列入, 待实际需求出现时以新 type 或
> `serves_thread` 登记, 走 §2 扩展白名单。
