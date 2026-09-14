# M14-A 连续性对照报告与裁定草案(2026-09-14, 基线 `4db3df9b6`)

> 后续开发计划 §4h 批 A(H-A1/H-A2/H-A3/H-A5)产出。对照方向(2026-09-14 讨论裁定):
> **以本仓 catalog 28 条/台账设计意图为行、父仓 9 个 rule code 为语义参考列**——底座不同
> (父仓 PostgreSQL 事件派生投影 vs 本仓 vault 文件 + git),本仓是重构设计而非父仓同步。
> 「真实缺口」判定式 = 本仓设计意图承诺覆盖 + 仅由现有 vault 资产(frontmatter/edges/
> scene_index/memory)可确定性构造 + 现有检测面静默,三者同时成立。
> 两仓 ADR-0018–0024 同号不同义,引用必带仓限定。父仓全程只读(铁律 8)。
> 本文 §6 为裁定草案: **用户采纳后才誊入 `specs/adjudications.md` 并分配 N 号**。

## 1. 父仓 9 个 rule code 冻结卡(H-A1)

检查器入口: `WritingConflictCheckService.create_check` → `_continuity_rule_items`
(`backend/modules/writing/services.py:1843`)。信任门: checkpoint 须 `status=="ready"` 且
(`source=="system_generated"` 或 `confirmed==True`),否则该维度记 `not_checked` 不出规则
(services.py:1869-1884)。**三维输入全部来自 `memory_scene_checkpoints.state_json`**(事件
派生场景投影, story/continuity/models.py:241; 投影写点 scene_projection.py:521-549);
space 组另读 outline scene 与已采用地图事实。

| rule code | 输入真相源 | 错误意义(作者语言) | 行为测试 |
|---|---|---|---|
| space_exit_state_mismatch | scene `structure_meta.exit_state` + `pov_character_id` 对比 locations checkpoint `character_locations[pov]`(services.py:1918-1938) | 主角这场戏结束时的所在地点与记忆里的可追溯位置对不上 | 未见专测 |
| space_simultaneous_presence | locations `state_json.changes[]` 按(对象,时点)分组(services.py:1940-1963) | 同一个人同一时刻被记在两个地方 | test_conflict_checks.py:247(断言 366-371) |
| space_route_not_declared | 位置迁移对 + world 已采用地图关系 `list_adopted_map_continuity_facts`(仅 adopted + saved revision + 来源有效, relation ∈ adjacent/connects/passes_through/entrance_to; map_atlas_facade.py:15-102, services.py:1964-1993) | 角色在两地间移动, 但已采用地图里没有声明这两地相通 | test_conflict_checks.py:443(断言 518-521) |
| time_order_cycle | timeline checkpoint `state_json.facts[]` 先后关系 DFS 找环(services.py:2036-2037, 2282-2302) | 你确认过的时间先后关系绕成了环 | test_conflict_checks.py:247(368 行) |
| time_simultaneous_order_conflict | timeline facts 同时标记与先后标记冲突(services.py:2038-2041) | 两件事既被标成"同时发生"又被排了先后 | 未见专测 |
| time_anchor_conflict | fact `field_path` + 时点分组锚值(services.py:2042-2043) | 同一时点被记了两条互相矛盾的时间锚 | 未见专测 |
| logic_claim_conflict | causality checkpoint `state_json.claims[]`(services.py:2090-2091) | 同一时点同一条事实被记成两个互斥的值 | 未见专测 |
| logic_precondition_missing | claims 的 `meta.required_preconditions`(services.py:2092-2099) | 剧情明确要求的前提条件到现在还没满足 | test_conflict_checks.py:247(369 行) |
| logic_commitment_unmet | claims 的 `meta.due_scene_index` 到期未兑现(services.py:2100-2106) | 约定到某个场景前兑现的承诺已经过期还没兑现 | test_conflict_checks.py:247(370 行) |

**失败方式(九条共通)**: `_continuity_item`(services.py:2118-2162)产出 item——严重度
固定 `medium`、`needs_review=True`、`location_json` 带 rule_code/evidence_refs/
`continuity_confirmation`;持久化 `writing_conflict_checks/items` 两表,经
`POST/GET /api/writing/conflict-checks` 返回;**不阻断发布**(发布仅归档最近检查快照),
作者可 PATCH 状态或走确认接口核销。

**四阶段数据流**: ①事件摄取(2210c3aac): 深导入场景实体抽取组装 `MemoryDeltaEventIngest`
→ `memory_events` 表, event_type 新增 `timeline_changed`/`causality_changed`;
②contract 版本化(de9846689): V2=6 维(增 timeline、causality),投影按 V2 建
checkpoint,版本写进 Evidence 编译元数据供 stale 重验; ③确定性检查(c4d178706): 上述
九规则落 writing_conflict_* 两表; ④作者确认事实(f54b1972e): 见 §5。

## 2. 本仓对照面(已提交事实)

- catalog 28 条(`evals/continuity-benchmark/catalog.json`): 26 covered + 2 llm-only,
  其中 N54 批 2 新增 8 项确定性检测(radar-continuity.ts 七项归 risk 面 +
  outline `sceneIndexConflicts` 归 health 面)。输入全部为 vault frontmatter/edges/
  scene_index/import-log。
- 本仓资产模型决定性事实(2026-09-14 逐一核于 packages/novelcraft):
  ①Scene/章 frontmatter **无**逐场角色位置/在场字段(全仓无 location/presence 类键);
  ②`memory/events.jsonl` 有 `appendEvent` 原语但**无生产 writer**(N46 review 已撤回
  写点,仅 dossier/POV 读面投影);
  ③map atlas **无** adjacency/connects/passes_through/entrance_to 关系类型(全仓无此词表)。

## 3. H-A2 映射表

### 3.1 本仓 28 条 × 父仓 9 规则

本仓 26 条 covered(ingest 2 / dedup 2 / suggest 1 / risk 2 / health 6 / relations 1 /
pov 2 / knowledge 2 / N54 批 2 八项)与 2 条 llm-only(pov-violation-in-prose /
knowledge-leak-in-prose)在用户效果上与父仓 9 规则**全部不相交**——本仓条目面向
结构资产与计划健康(章序/伏笔/剧情线/关系悬空/POV 声明),父仓 9 条面向事件派生的
时空/因果状态。判档: 全部 `ours-only`(本仓设计独有,父仓对照面无对应物,非缺陷)。

### 3.2 父仓 9 规则逐条判档

| rule code | 判档 | 理由(回到两仓已提交源码) |
|---|---|---|
| space_exit_state_mismatch | not-representable | 需 scene exit_state 契约 + locations 事件投影,本仓均无(§2 ①②) |
| space_simultaneous_presence | not-representable | 需 locations changes 事件流,本仓无(§2 ②) |
| space_route_not_declared | not-representable | 双重缺失: 位置事件(§2 ②)+ 地图 adjacency 关系词表(§2 ③) |
| time_order_cycle | not-representable | 需 timeline 事实事件; 本仓 §6.18.6 已裁定不建时间线模型 |
| time_simultaneous_order_conflict | not-representable | 同上 |
| time_anchor_conflict | not-representable | 同上 |
| logic_claim_conflict | not-representable | 需 causality claims 事件流,本仓无(§2 ②) |
| logic_precondition_missing | not-representable | 同上 |
| logic_commitment_unmet | **partial** | 用户效果与本仓 `risk-foreshadow-overdue`(planned_payoff < 当前最大章且无 reveals_foreshadowing 边)部分重叠——都是「承诺到期未兑现」;但真相源不同(事件 claims.due_scene_index vs 结构 frontmatter)。未覆盖切片(事件派生承诺)需事件摄取,同 not-representable |

`not-representable` 按批 A 验收纪律**不记为缺陷**: 它是底座差异的正当结果(本仓
§6.18.6 不建时间线、N46 事件写点 reserved、铁律 2 文件唯一真相)。

**计划偏差注记(H-A2)**: 任务表要求「对 partial/parent-only 用隔离临时 Vault 证明能否
推导」。本批未跑探针: 全部候选在 schema 层即证否(探针无法制造任何资产中不存在的字段),
临时 Vault 只能重复证明「检测器无输入可读」,证据强度不高于 §2 的三条全仓词表核实。
如评审认为仍需实证,可补一条「空场景 vault 上九规则对应检测面静默」的负例探针。

## 4. H-A3 裁定草案一: 移植清单为空, 批 A 零代码收口

- **移植清单 = 空**: 父仓 9 条全部 not-representable(1 条 partial 的未覆盖切片同); 本仓
  检测面在其设计意图内未发现「承诺覆盖 + 可确定性构造 + 现有检测面静默」三满足的场景。
- **H-A4 标记 skipped**(受 H-A3 闸门),不写代码。空移植清单是批 A 的合法完成态。
- **同构观察**(不构成移植): 父仓九规则「severity 固定 medium + 不阻断发布 + 待处理建议
  通道」与本仓 radar signal 语义(risk/health 面 + reconcile 对账契约)同构; 若未来重开,
  移植路径即 N54 批 2 姿势(core 加法检测器归 risk/health,无新雷达面/工具/git writer)。
- **重开条件(任一)**: ①N46 后续批次落地 memory 事件生产写点,使 timeline/causality/
  locations 维度有真相源; ②本仓 Scene/地图资产模型新增出场位置或空间关系字段;
  ③用户裁定引入时间线模型(推翻 §6.18.6)。届时按本文 §1 冻结卡逐项重估。

## 5. H-A5 裁定草案二: `manual_correction` payload 语义评估(只评估, 不实施)

### 5.1 父仓参考模型(f54b1972e, 已核实锚点)

- 请求 schema `WritingContinuityConfirmationRequest`(writing/schemas.py:556-569,
  `extra="forbid"`): `novel_id`、`content`(原文,重算 hash 比对)、
  `expected_item_updated_at`(乐观锁)、`category`、`field_path`、`old_value`、
  `new_value`、`evidence_summary`、`confirmed: Literal[True]`;跨模块契约
  `ConfirmedContinuityEventIngest`(continuity/contracts.py:80-91)增补 `dimension` 与
  `idempotency_key`。
- 幂等与 stale 三道闸(services.py:1414-1526): request_hash 命中返回原 event;
  幂等键 `writing_conflict_item:{item.id}` 仓储层去重; item updated_at 漂移 409 /
  正文 content_hash 漂移 409 / 当前 checkpoint id ≠ 检查时上下文 `checkpoint_versions`
  同维度 id 则 409。
- 写点语义: 向 `memory_events` 追加 `event_type="manual_correction"`、
  `source="author_confirmation"`,随后 supersede 下游 checkpoint/快照并重建,
  `mark_asset_context_changed`;item 置 `resolved` 并写 `continuity_receipt`。
- 行为测试: test_conflict_checks.py:525(幂等 + stale 409 + contract_version==2)、
  :623(拒其他 kind 与跨项目);并发幂等 e2e
  test_scene_memory_checkpoint_concurrency.py:124。

### 5.2 本仓约束(N46 已裁定, 草案不得违反)

①manual_correction 首版 reserved——payload/合并语义明确前拒绝写; ②普通正文发布只快照
已有事件,不从新正文造事件; ③写点接入前须先改 `(chapter_index,sequence,id)` 排序(加法);
④append 失败容错降级不回滚正文(账本是派生真相可重建); ⑤sequence 派生方案
`chapterCoverage.lastSequence+1`;⑥本仓无「冲突检查 item」实体——父仓确认绑在
writing_conflict_items 上,本仓没有对应物,触发上下文需另行裁定。

### 5.3 五轴问题清单(待裁定)

1. **写入语义**: payload 的 `category`/`field_path` 词表(自由文本 vs 白名单
   dimension+field)?`snapshot_after` 记什么(N46 ①口径: 摘要哈希,不含正文)?
   与 entity_created/updated 事件的投影合并/覆盖语义?
2. **排序**: `(chapter_index,sequence,id)` 加法先行(N46 ③既定);本仓无 scene_sequence
   概念,章内单调是否足够?跨章「后来修正前面章」的重放顺序如何定义?
3. **重放**: `projectWorldState` 对 manual_correction 的 apply 规则(覆盖/追加/作废既有
   事件投影)?与既有 created_at 排序读面的兼容窗口?
4. **下游失效**: 本仓无 checkpoint/snapshot 派生链(dossier 每次全量重读 events),
   失效语义自然简化为「重读即新」;但确认后 RAG/lexical 索引与收件箱 signal 是否需标脏
   或联动?
5. **审批与入口**: 确认动作必须经 agent 工具 + ApprovalGate allowed-once(铁律 3,
   client 零 canonical 写);无 conflict item 可绑时,确认事件的触发工具形态(独立
   `novelcraft_memory_correct`? 还是挂在收件箱 signal 决议上?)与回执形态
   (continuity_receipt 等价物进工具回执/收件箱?)。

### 5.4 建议性 payload 骨架(提案非定论, 采纳后才分配 N 号)

```jsonc
{
  "event_type": "manual_correction",
  "source": "author_confirmation",      // 与 N46 原设想 "manual_edit" 二选一, 待裁定
  "chapter_index": 3,                    // 目标章
  "sequence": "<chapterCoverage.lastSequence+1>",  // 派生(N46 ⑤), 无槽位占用
  "dimension": "timeline|causality|locations|knowledge",  // 白名单, 待裁定
  "field_path": "character.林岚.location",
  "old_value": "...", "new_value": "...",
  "evidence_summary": "作者语言简述, 不含正文原文",
  "idempotency_key": "manual_correction:{chapter_index}:{content_hash 前 12}",
  "snapshot_after": { "content_hash": "...", "commit": "...", "corrected_field_digest": "..." }
}
```

写链位置建议: dsh 新工具(加法)→ ApprovalGate allowed-once → `appendEvent` →
dossier 读面自动反映(无需 supersede);trace 词表加法(memory_correction_appended/
_rejected)进 contract 断言。排序加法(N46 ③)是该写点的硬前置。

## 6. 裁定入口

本文 §4/§5 为草案。用户逐条采纳/修改后: 誊入 `specs/adjudications.md` 分配新 N 号;
§4 采纳 = 批 A 正式零代码收口; §5 采纳 = 另立 manual_correction 实施子批(排序加法先行)。
