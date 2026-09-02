# R0 · 完整性规则目录(store-rules)

- 来源 commit: `a257df23e773db6e843f3dda81b855008558e6e7`(origin/main, 分支 `codex/m4-dsh-plugin-rewrite`)
- 提取日期: 2026-08-14
- 提取范围(汇总自已定稿 spec, 不回读代码):
  - `specs/assets/world.md`(已带 R1–R12 总索引)、`specs/assets/imports.md`、`specs/assets/outline.md`、
    `specs/assets/writing.md`、`specs/assets/small-modules.md`
  - `specs/prompts/catalog.md`(降级条款/预算/温度)
  - `docs/agent/dsh-rebuild/自主智能式作家助手设计.md` §6.1(去重 L0–L4)、§12(引擎原语)、§13(policy.yml)、
    §22.2(90 表语义→文件/git 映射)、§24(R0 产出定义)
- 落点: 本目录是 `@novelcraft/store` 插件的**逐条落地清单**; 每条规则都是确定性数据语义(非流程策略),
  可被行为契约测试断言(设计 §15 trace contract + §24.1「对每条规则有对应行为契约测试」)。

> 约定: 只写规格不写代码; 每条规则给「规则一句话 + 来源 + M4 落法 + 测试断言」; 不确定处标【待定】。
> `adopt` 在 M4 = 一次 `git commit` + `content_hash` 进 frontmatter; 已采用资产不硬删 = git 历史 + 墓碑文件。

## 编号与对齐约定(重要)

1. 规则编号全局唯一 `R1…Rn`。
2. **R1–R12 原样继承自 `specs/assets/world.md`「附: 完整性规则总索引」**, 语义与措辞不变, 仅补「M4 落法」与「测试断言」, 并按主题归入下面 8 节。R13 起为本批从其余 4 份 spec + catalog 汇总的新规则, 已与 R1–R12 去重。
3. 与 R1–R12 语义重叠的细目(如关系自环、端点活跃、别名归一化)在 world.md 正文「完整性规则」里存在但未进总索引, 本目录将它们**另立编号**(R24、R26 等)补齐。
4. 【待定】项集中在 §8, 明确标注「等待上层裁定」, 不作为 store 落地的确定性依据。

### 全量索引(R# → 规则名 → 所在节)

| # | 规则名 | 节 |
|---|---|---|
| R1 | 别名不建新对象 | §3 |
| R2 | 已采用不硬删除 | §4 |
| R3 | adopt/promote 仅从 draft/candidate | §2 |
| R4 | 待处理建议只能经建议队列裁决 | §4 |
| R5 | 关系同向同型去重; review-only 不改已采用边 | §3 |
| R6 | 合并/归并可逆; 已采用二次确认 | §3 |
| R7 | 世界书发布 CAS + content_hash 派生失效 + publish-impact | §6 |
| R8 | 复核/采纳 execution_fingerprint / preview_hash CAS | §1 |
| R9 | novel_id 隔离 | §1 |
| R10 | 知识标签派生确定性 + 排除/作者锁优先 | §3 |
| R11 | 类型切换硬依赖门禁 + 档案一致性 | §2 |
| R12 | 派生索引可重建; 文件是唯一真相 | §1 |
| R13 | 总纲 CAS 与幂等 | §1 |
| R14 | 并发写串行化(行锁/advisory/版本原子递增) | §1 |
| R15 | 章节乐观锁(expected_version / expected_updated_at) | §1 |
| R16 | 来源范围引用新鲜度(source_hash / range_hash) | §1 |
| R17 | 工作区脏拒绝 adopt(adopt=commit+content_hash) | §1 |
| R18 | 已采用版本不原地修改(copy-on-write) | §2 |
| R19 | 候选正文只读(仅 adopt/reject 迁移) | §2 |
| R20 | 结构资产列表默认排除 deprecated | §2 |
| R21 | entity_key 幂等键 | §3 |
| R22 | provenance_key 幂等提交 | §3 |
| R23 | 精确同名同型确定性复用 | §3 |
| R24 | 别名归一化去重 | §3 |
| R25 | 占位词/变量名拒绝 | §3 |
| R26 | 关系自环禁止 + 端点必须是活跃对象 | §3 |
| R27 | 结构去重自动应用条件 | §3 |
| R28 | 去重置信阈值分级(L0/L1/L2) | §3 |
| R29 | entity_type 20 枚举校验 | §3 |
| R30 | import-log 幂等键 | §3 |
| R31 | 导入文件门禁(白名单/50MB/basename/不存正文) | §3 |
| R32 | 单赢家裁决(CAS claim) | §4 |
| R33 | 采纳前重验 payload(preview_hash CAS) | §4 |
| R34 | copy-on-adopt(候选→draft 新建) | §4 |
| R35 | 采用前 fail-closed 上游校验 | §4 |
| R36 | 采纳目标必须是已采用对象 | §4 |
| R37 | 已采用对象合并/设别名二次确认 | §4 |
| R38 | 同组原子应用(整体回滚) | §4 |
| R39 | 低置信不自动升 canonical | §4 |
| R40 | 授权快照 fail-closed + 冻结不可变 | §5 |
| R41 | 自动写入仅限 auto_adopt; 回滚固定软废弃 | §5 |
| R42 | checkpoint input_fingerprint 一致才跳过 | §5 |
| R43 | 阶段内修复只覆盖失败 checkpoint | §5 |
| R44 | 每 novel 最多一个活跃 run | §5 |
| R45 | owner CAS(require_owner 全匹配) | §5 |
| R46 | resume/abandon 仅 failed + recovery_required | §5 |
| R47 | abandon 回滚整批软废弃 + 幂等 + 不碰 user_edited | §5 |
| R48 | 进度 compact + total_steps 固定 + 中断标志 stale 收敛 | §5 |
| R49 | memory checkpoint supersede / 人工修复 CAS | §5 |
| R50 | 世界书一页一活跃工作稿 | §6 |
| R51 | 页面提案只能走 lifecycle | §6 |
| R52 | 降级 1b: 空语义进复核 | §7 |
| R53 | 降级 2b: 只降级不丢对象 | §7 |
| R54 | 降级 1a: 重叠/空洞整章 fallback | §7 |
| R55 | 去重失败降级(不抛异常) | §7 |
| R56 | RAG reranker 降级(弃权/保留原序) | §7 |
| R57 | 世界生成/问答降级(不建 suggestion/拒答) | §7 |
| R58 | 审计/修订/正文降级(清空引用标 uncertain) | §7 |
| R59 | 冻结失效降级(审查/返修期间变化丢弃) | §7 |
| R60 | 融合 operation 归一 | §8 |
| R61 | narrative_tag 归一(imported→draft, 截断 32) | §8 |
| R62 | 健康键命名统一【待定】 | §8 |
| R63 | 幂等键/引用 slug 命名统一【待定】 | §8 |
| R64 | narrative_tag 与 narrative_function 双轨合并【待定】 | §8 |

---

## 1. CAS 与并发(版本冲突、预览指纹、工作区脏检查)

### R8 · 复核/采纳统一 CAS 指纹【继承 R8】

- **规则**: 所有复核(review)与采纳(apply/adopt)动作必须以 `execution_fingerprint` / `preview_hash` / `semantic_fingerprint` 比对当前资产状态, 指纹不一致 → `stale_execution` / `ConflictError`, 拒绝执行。
- **来源**: `specs/assets/world.md`(别名/关系/融合/采纳包各处); `entity_alias_service.py:652-655`、`entity_relation_service.py:765-768`、`entity_fusion.py:733-739`、`adoption_package_service.py:460-489`。
- **M4 落法**: store 在 adopt/review 前读取目标文件 `content_hash`(frontmatter)与请求携带的 `expected_*` 指纹比对; 不一致拒绝 commit(不产生新 commit)。
- **断言**: 对同一对象并发「作者改文件」+「旧指纹 adopt」→ 后者被拒; 预览后改内容再 apply → ConflictError。

### R9 · novel_id 隔离【继承 R9】

- **规则**: 一切业务读写按 `novel_id` 隔离; M4 下 = 每书一个文件夹 + 每书一个 DSH session, scope 子系统做会话内分区, 不得跨书读写。
- **来源**: `specs/assets/world.md`; 各服务 `parse_uuid(novel_id)`; 设计 §22.2「novel_id 隔离」行。
- **M4 落法**: store 所有文件读写以「工作区根路径」为边界(等价 novel_id 过滤), 禁止路径逃逸到书外。
- **断言**: 用书 A 的引用去读写书 B 的 `world/objects/` → 拒绝; 路径含 `../` 逃逸 → 拒绝。

### R12 · 派生索引可重建; 文件是唯一真相【继承 R12】

- **规则**: 别名索引/关系图/覆盖率/检索索引只是派生, 任何时刻可由文件夹真相全量重建(`store rebuild-index`); 用户手改文件后重建即一致。
- **来源**: `specs/assets/world.md`; 设计 §22.2「索引规则」、`models/core.py:97-113`。
- **M4 落法**: store 的 sqlite domain KV(`ctx.storage`)只存派生索引, 不存真相; 提供 `rebuild-index` 幂等重建。
- **断言**: 手改 `world/objects/*.md` 别名后 `rebuild-index`, 别名查找结果与文件一致; 删索引文件重建无损。

### R13 · 总纲 CAS 与幂等

- **规则**: 总纲 apply/create 时 `base_revision_id` 必须等于当前 `head.current_revision_id`, 否则冲突; 相同 `idempotency_key` 命中已存在 revision 且 `request_hash` 一致时幂等返回, `request_hash` 不一致则冲突。
- **来源**: `specs/assets/outline.md`「StoryOutline·完整性规则」; `story_outline_service.py:116-123,337-361`。
- **M4 落法**: 总纲落 `structure/outline.md`, revision 链 → git commit 历史; store 在 adopt 时比对 base 指针与 request_hash, 失配拒绝; `idempotency_key`(8–128)与 `content_hash` 进 frontmatter。
- **断言**: 并发两次 apply 同 base → 后到者冲突; 重放相同 key+hash → 不新增 revision; 相同 key 不同 hash → 冲突。

### R14 · 并发写串行化(行锁/advisory/版本原子递增)

- **规则**: 总纲写前对 head 加行锁 + PG advisory 锁; 章节版本号 `MAX(version_number)+1` + 唯一约束串行化; M4 下该串行化语义由 git commit 的原子性承接, 但「并发采用/发布串行化」仍必须保留。
- **来源**: `specs/assets/outline.md`(`story_outline_repository.py:22-42`)、`specs/assets/writing.md`(`repositories.py:641-686`)。
- **M4 落法**: store 对同一资产的一次 adopt = 一个原子 commit; 同资产并发 adopt 由 git 检出/合并冲突拒绝(后写者需 rebase 或拒绝)。
- **断言**: 两个并发的章节 publish/adopt 只有一个成为当前; 失败方收到冲突, 不产生交错历史。

### R15 · 章节乐观锁(expected_version / expected_updated_at)

- **规则**: 仅章节最新 working 版本可被暂存/checkpoint/发布; `expected_version` / `expected_updated_at` 校验失败(多 Tab 过期)→ 冲突, 拒绝写。
- **来源**: `specs/assets/writing.md`; `services.py:611-637`、`README.md:230-235`。
- **M4 落法**: store 以文件 frontmatter 的 `content_hash`(等价 expected_updated_at)与请求基线比对; 不一致拒绝写。
- **断言**: 两个 Tab 基于同一旧版本各自发布 → 后提交者冲突; 过期 expected_version 写 → 冲突。

### R16 · 来源范围引用新鲜度(source_hash / range_hash)

- **规则**: `SourceRangeRefContract` 的 `source_hash`(整篇)与 `range_hash`(区间)必须在读取时对当前正文重算匹配; 正文或版本变化后引用 stale, 拒绝读取。
- **来源**: `specs/assets/writing.md`; `manuscript_source.py:158-177`。
- **M4 落法**: store 校验正文引用时以 `chapters/*.md` 当前 `content_hash` 重算 source/range hash, 失配报 stale。
- **断言**: 正文改动后按旧 range 引用读取 → 拒绝; hash 匹配 → 放行。

### R17 · 工作区脏拒绝 adopt(adopt=commit+content_hash)

- **规则**: 每次 adopt = 一次 git commit + `content_hash` 更新进 frontmatter; 工作区存在未提交/脏改动时拒绝 adopt。
- **来源**: `specs/assets/outline.md`「Scene·完整性规则」、`specs/assets/small-modules.md` 附录; 设计 §22.2「revision/CAS」行(行 700)。
- **M4 落法**: store 的 adopt 原语先查工作区 `git status`; 有未暂存/未提交变更(且不属于本次 adopt 范围)→ 拒绝。
- **断言**: 手改文件未提交时调用 adopt → 拒绝; 干净工作区 adopt → 产生一个 commit 且 frontmatter.content_hash 更新。

---

## 2. 状态机迁移(所有资产的 status 合法迁移表)

> 下表为「合法迁移」白名单; 未列出的迁移一律非法, store 拒绝。所有「删除」均为软删(置终态 + 墓碑), 见 R2。

| 资产(M4 文件) | status 集合 | 合法迁移 |
|---|---|---|
| 世界对象 `world/objects/*.md` / `world/pending/*.md` | draft / candidate / canonical / merged / ignored / deprecated | draft\|candidate → canonical(adopt/promote); draft\|candidate → merged(merge/alias); draft\|candidate → ignored(reject); canonical → deprecated(软删) |
| 别名(对象 frontmatter `aliases[]`) | candidate / canonical(confirmed) / ignored / conflicted | candidate → canonical(accept); candidate → ignored; canonical 可编辑文本/类型或迁移到另一对象 |
| 关系 `entity_relations` | candidate / canonical / deprecated | candidate → canonical(accept); candidate → deprecated(ignore); canonical → deprecated(软删/被合并) |
| 建议 `world/pending/*.md`(suggestion queue) | pending → accepted / rejected | pending → accepted(confirm, 单赢家); pending → rejected |
| 世界书页 `bible/*.md` | draft / canonical / archived | draft → canonical(发布, version+1); canonical → draft(再编辑新工作稿); canonical → archived(软删) |
| Scene `scenes/*.md` | draft / canonical / deprecated | draft → canonical(adopt); canonical → deprecated(替换/删除) |
| 结构资产 threads/arcs/foreshadowing/reveal | draft / canonical / deprecated | draft → canonical(adopt); canonical → deprecated(替换/删除) |
| 章节正文 `chapters/*.md` | draft / published / canonical / candidate / deprecated | draft → published(有实质变化); published → draft(copy-on-write 新版本); candidate → draft(adopt)+candidate→deprecated; candidate → deprecated(reject); draft/published → deprecated(软删) |
| ImportRecord `imports/import-log.jsonl` | pending / processing / done / failed | pending → processing → done; pending → processing → failed |
| workflow run `.assistant/checkpoint.json` | pending / running / done / failed / cancelled | pending → running → done\|failed\|cancelled; failed+recovery_required → pending(resume, gen+1) \| cancelled(abandon) |

### R3 · adopt/promote 仅从 draft/candidate【继承 R3】

- **规则**: 仅 `draft/candidate` 可提升为 canonical; 已 canonical 对象不能走普通 update 直接改 status, 必须走 promote 原语。
- **来源**: `specs/assets/world.md`; `entity_service.py:439-442,677-681`。
- **M4 落法**: store 的 adopt 原语校验源文件 status ∈ {draft, candidate}, 否则拒绝; 已 canonical 文件只能经 promote 原语改内容。
- **断言**: 对 canonical 对象调 update 改 status → 拒绝; 对 draft 调 promote → 成功置 canonical。

### R11 · 类型切换硬依赖门禁 + 档案一致性【继承 R11】

- **规则**: 改变 `entity_type` 必须过 `EntityTypeTransitionService`; 存在依赖当前类型的专属数据(character/event/location/species 扩展、知识引用、活跃档案、活跃建议/冲突)时拒绝。
- **来源**: `specs/assets/world.md`; `entity_type_transition_service.py:39-200,368-382`。
- **M4 落法**: store 改对象 `kind` 时重验扩展体/引用一致性; 不一致拒绝 commit。
- **断言**: 把带 character 档案的对象改 kind=location → 拒绝; 无依赖对象改 kind → 允许。

### R18 · 已采用版本不原地修改(copy-on-write)

- **规则**: `published/canonical` 章节版本不得原地修改; 首次编辑 copy-on-write 为新 `draft` 版本(origin=auto)。
- **来源**: `specs/assets/writing.md`; `repositories.py:205-206,618-619`、`services.py:465-490`。
- **M4 落法**: store 对已采用章节的编辑生成新工作稿文件(新 commit), 不改已发布正文; 版本号由 git 历史承载。
- **断言**: 编辑 published 章 → 产生新 draft, 原 published 不变; 直接原地改 published → 拒绝。

### R19 · 候选正文只读(仅 adopt/reject 迁移)

- **规则**: candidate 正文不得经普通暂存/发布接口修改或恢复; 只能经 adopt 或 reject 迁移。
- **来源**: `specs/assets/writing.md`; `README.md:233-235`。
- **M4 落法**: store 对 `status: candidate` 的正文文件只开放 adopt/reject 两条原语。
- **断言**: 对 candidate 调 publish/edit → 拒绝; adopt → 转 draft; reject → deprecated。

### R20 · 结构资产列表默认排除 deprecated

- **规则**: 结构资产(threads/arcs/foreshadowing/reveal)列表默认排除 `deprecated`; 未指定 status 时不得返回已废弃。
- **来源**: `specs/assets/outline.md`「PlotThread·完整性规则」; `repositories.py:85-88`。
- **M4 落法**: store 的 read_structure 过滤 `status != deprecated`(除非显式请求历史)。
- **断言**: 读 threads 列表不含任何 deprecated; 显式历史视图可含。

---

## 3. 幂等与去重(entity_key / provenance_key / 别名 / 关系同向同型)

### R1 · 别名不建新对象【继承 R1】

- **规则**: 别名只附着已有对象的 `aliases[]`; 实体抽取/深度导入产生的新名一律挂别名或进复核, 不重复建实体。
- **来源**: `specs/assets/world.md`; `entity_alias_service.py`(全文)、AGENTS.md、设计 §22.2。
- **M4 落法**: store 的 attach_alias 原语只写目标对象 frontmatter `aliases: []`; 禁止以别名新建对象文件。
- **断言**: 导入「苏婉 = 红衣女子」只产生一个对象 + 一条别名, 对象数不增。

### R5 · 关系同向同型去重; review-only 不改已采用边【继承 R5】

- **规则**: (source, target, relation_type) 唯一, create 重复 → 409; review-only 导入遇已 canonical 且 incoming 非 canonical 的边仅返回 deduplicated, 不改其内容/来源/强度。
- **来源**: `specs/assets/world.md`; `entity_relation_service.py:306-374`。
- **M4 落法**: store 的 create_or_merge_relation 原语按 (source_ref, target_ref, relation_type) 唯一键去重; 已 canonical 边不自动归并。
- **断言**: 重复 create 同型同向边 → 拒绝; 导入对已采用边 → 原边内容不变。

### R6 · 合并/归并可逆; 已采用二次确认【继承 R6】

- **规则**: 合并把 source 置 `merged`(继承别名、迁移关系、去重自环)不硬删; 已采用对象合并需 `allow_canonical_merge/alias` 二次确认。
- **来源**: `specs/assets/world.md`; `dedup_service.py:494-541`、`entity_fusion.py:743-755`。
- **M4 落法**: store 的 merge_entities 原语写 `merge_records`(source_ids→target_id、provenance、workflow、可回滚标记), 保留 source 文件(墓碑); split_merge 原语可逆拆分。
- **断言**: merge 后 source 仍可查历史; 未二次确认的 canonical merge → 拒绝/confirmation_required; split 后可恢复。

### R10 · 知识标签派生确定性 + 排除/作者锁优先【继承 R10】

- **规则**: 种族/地点/职业/势力四路派生标签仅当来源对象 status ∈ {canonical, confirmed} 时生效; exclusion 优先于派生, author_locked 优先于自动删除; (novel_id, slug) 唯一。
- **来源**: `specs/assets/world.md`; `knowledge_tag_service.py:124-230`、`models/worldbuilding.py:475`。
- **M4 落法**: store 的 sync_derived_tags 确定性重建; 派生结果进派生索引(不写真相文件)。
- **断言**: 来源对象降为 draft → 派生标签消失; 加 exclusion → 对应派生不再生成; author_locked 授权不被自动删除。

### R21 · entity_key 幂等键

- **规则**: entity_key = (entity_type 小写, name 去多余空白); 同批内同名同型只建一次。
- **来源**: `specs/assets/imports.md`「实体候选·完整性规则」; `scene_entity_persistence.py:37-38`。
- **M4 落法**: store 在候选入队时按 entity_key 去重, 幂等键存 frontmatter。
- **断言**: 同批两个同名同型候选 → 只落一个对象; 不同型同名 → 两个。

### R22 · provenance_key 幂等提交

- **规则**: provenance_key = sha256(workflow_id, candidate_id, source_candidate_ids 排序, fusion_operation, source_chapter_indices 排序), 与来源顺序无关; 提交时按 key 查: 存在非 deprecated → skip, 仅 deprecated → conflict, 否则 create。
- **来源**: `specs/assets/imports.md`「Scene 正式提交·完整性规则」; `scene_commit.py:40-59,165-217`。
- **M4 落法**: store 的 Scene 提交原语以 provenance_key 幂等; 重跑同输入 → skip, 不产生重复 Scene。
- **断言**: 同 workflow 重跑 → 已存在 Scene 被 skip; 已 deprecated 同 key → conflict。

### R23 · 精确同名同型确定性复用

- **规则**: 精确同名同型的 working 实体 → 确定性复用(canonical/draft/candidate), 不受模型 `create_new/link_to_existing` 影响, 避免重跑制造影子候选。
- **来源**: `specs/assets/imports.md`; `scene_entity_persistence.py:740-769`、`README.md:48`。
- **M4 落法**: store 抽取落库前按 (kind, 归一化 name) 查已采用对象; 命中即复用, 不建新候选。
- **断言**: 模型判 create_new 但已有同名同型 canonical → 仍复用, 无新对象。

### R24 · 别名归一化去重

- **规则**: 别名归一化(合并空白 + casefold)后重复 → 拒绝创建(409)/拒绝移动。
- **来源**: `specs/assets/world.md`「别名·完整性规则」; `entity_alias_service.py:205-219,739-743`。
- **M4 落法**: store 的 attach_alias 按归一化键去重, 重复别名不入 frontmatter。
- **断言**: 对已有「Zhou Mingrui」再挂「zhou mingrui」→ 拒绝; 挂全新别名 → 成功。

### R25 · 占位词/变量名拒绝

- **规则**: 别名/实体名中的占位词(变量/variable/placeholder/未知/unknown/某人/某物/n/a/none)拒绝入候选。
- **来源**: `specs/assets/imports.md`「别名候选·完整性规则」; `scene_entity_persistence.py:23-35,71-73`。
- **M4 落法**: store 写候选前做占位词黑名单校验, 命中拒绝。
- **断言**: 别名「未知」→ 拒绝; 正常名 → 通过。

### R26 · 关系自环禁止 + 端点必须是活跃对象

- **规则**: create 时 source==target 拒绝; source/target status ∈ {canonical, draft, candidate} 且非 compatibility_shadow; 合并只清理迁移产生的自环, 不碰 target 原有合法自环。
- **来源**: `specs/assets/world.md`「关系·完整性规则」; `entity_relation_service.py:57-120`、`dedup_service.py:507-514`。
- **M4 落法**: store 的关系原语校验端点有效与非同点, 拒绝自环与影子端点。
- **断言**: 自环 create → 拒绝; 指向 pending 影子对象 → 拒绝; 合并后迁移自环被清理。

### R27 · 结构去重自动应用条件

- **规则**: 仅自动应用「source_workflow_id == target_workflow_id == 当前 workflow_id」且 confidence >= 0.96 且 action ∈ {merge, deprecate_duplicate} 的结构去重建议; 跨旧资产建议只写任务结果不自动应用。
- **来源**: `specs/assets/imports.md`「结构去重建议·完整性规则」; `deep_import_dedup.py:60-66`、`README.md:53-54`。
- **M4 落法**: store 的 apply_structure_dedup 原语校验同 workflow + 置信阈值 + action 白名单。
- **断言**: 跨 workflow 建议 → 不自动应用; 同 workflow 低置信(<0.96)→ 不自动应用。

### R28 · 去重置信阈值分级(L0/L1/L2)

- **规则**: L0 归一化名完全相同且同型 → 确定性直接合并; 确定性判定置信 >= 0.98 直接 merge / keep_separate 直接保留; L1/L2 判同一需 similarity_score >= 0.88(候选对门槛 >= 0.84)。
- **来源**: `specs/assets/imports.md`(`scene_entity_persistence.py:65`)、`specs/assets/world.md`(`entity_fusion.py:1310-1314`)、设计 §6.1。
- **M4 落法**: 阈值进 policy.yml(`dedup.*`); store 执行确定性 L0 合并, L1/L2 判定结果交编排脑, L3 走 merge_candidates(CAS)。
- **断言**: 同名同型两对象 → L0 自动合并; 相似度 0.90 → 判同一; 0.85 → 不确定进复核; >=0.98 → 不调 LLM 直判。

### R29 · entity_type 20 枚举校验

- **规则**: entity_type 必须落在 20 类枚举(character/location/faction/organization/species/group/item/object/event/rule/power_system/secret/legend/resource/concept/creature/skill/ability/artifact/other), 否则拒绝; 深度导入不创建/复用项目自定义类型。
- **来源**: `specs/assets/imports.md`; `llm_schemas.py:93-97`、`README.md:47`。
- **M4 落法**: store 写候选前校验 kind ∈ 枚举(中文别名归一后), 拒绝越界值。
- **断言**: kind 非法值 → 拒绝; 合法 20 类之一 → 通过。

### R30 · import-log 幂等键

- **规则**: (novel_id, file_name) 在 status='done' 时唯一(partial unique index)——同书同文件只允许一条 done 记录。
- **来源**: `specs/assets/imports.md`「ImportRecord·完整性规则」; `models.py:64-74`。
- **M4 落法**: store 写 import-log.jsonl 前按 (书, 文件名) 查 done；原文 `content_hash` 相同才幂等返回。hash 不同或旧记录无 hash 时 fail-closed，要求改名以保留两个来源，仍不产生第二条同名 done。
- **断言**: 同书同文件同 hash 重复导入 → 不产生第二条 done；同名不同 hash → 拒绝静默跳过；换文件 → 新记录。

### R31 · 导入文件门禁(白名单/50MB/basename/不存正文)

- **规则**: 文件类型白名单 `.txt/.epub/.html/.htm/.mobi/.azw3`, 上限 50MB; 文件名必须先 `os.path.basename` 防路径穿越; 正文原文不存导入记录, 只存文件名/类型/大小/章节数/状态/错误。
- **来源**: `specs/assets/imports.md`「ImportRecord·完整性规则」; `CLAUDE.md:6,8-10`、AGENTS.md。
- **M4 落法**: store/vault 摄入层校验扩展名、大小与文件名净化; import-log 只落元数据。
- **断言**: 上传 .docx / >50MB / `../` 路径 → 拒绝; 导入记录不含正文内容。

---

## 4. 采纳(adopt)规则(单赢家裁决、copy-on-adopt、已采用不硬删)

### R2 · 已采用不硬删除【继承 R2】

- **规则**: 已采用(canonical)对象/关系/页面/正文默认不硬删除, 转历史态(deprecated/archived/merged)并保留快照; 项目永久删除除外。
- **来源**: `specs/assets/world.md`; `entity_service.py:579-650`、AGENTS.md、设计 §22.2。
- **M4 落法**: store 的 delete 原语 = 新 commit 移除 + 墓碑文件; git 历史天然保留。
- **断言**: 删 canonical 对象 → 无物理删除, 历史可查; 软删后再删 → no-op。

### R4 · 待处理建议只能经建议队列裁决【继承 R4】

- **规则**: 待处理建议(含 compatibility_shadow 影子实体)只能经建议队列裁决/编辑, 不能直接 CRUD。
- **来源**: `specs/assets/world.md`; `suggestion_queue_service.py`、`entity_service.py:571-577`。
- **M4 落法**: `world/pending/*.md` 即队列; store 禁止对 pending 文件直接 promote, 只开放 confirm/reject。
- **断言**: 直接 CRUD pending 影子 → 拒绝; 经队列 confirm → 迁移 accepted。

### R32 · 单赢家裁决(CAS claim)

- **规则**: confirm/reject 共用 CAS claim(`_claim_pending`), 重复裁决只有一个生效。
- **来源**: `specs/assets/world.md`; `suggestion_queue_service.py:_claim_pending,1056-1059`。
- **M4 落法**: store 对同一 pending 建议的 confirm/reject 原子 claim, 二次裁决 no-op/拒绝。
- **断言**: 两次并发 confirm 同一条建议 → 仅一次 accepted; confirm 后再 reject → 拒绝。

### R33 · 采纳前重验 payload(preview_hash CAS)

- **规则**: apply 前对 payload 强类型重验; adoption package 用 `expected_preview_hash` 与重算值比对, 不一致 → ConflictError(「preview again」)。
- **来源**: `specs/assets/world.md`; `suggestion_queue_service.py:422-426`、`adoption_package_service.py:460-489`。
- **M4 落法**: store 的 apply/adopt 对 payload 做 schema 校验 + preview_hash CAS; 失配拒绝。
- **断言**: 预览后改 payload 再 apply → 冲突; schema 非法 payload → 拒绝。

### R34 · copy-on-adopt(候选→draft 新建)

- **规则**: 正文候选 adopt = 新建最高 version_number 的普通 draft(写入 adopted_from_candidate_id/adopted_at/adopted_by), 原 candidate 置 deprecated 并记录 adoption_result_draft_id。
- **来源**: `specs/assets/writing.md`「候选正文·完整性规则」; `services.py:367-423`。
- **M4 落法**: store 的 adopt(候选正文) = 复制候选为新工作稿文件 + commit + 原候选转墓碑。
- **断言**: adopt 候选 → 新 draft 出现、原 candidate 转 deprecated; 候选内容与草稿内容一致。

### R35 · 采用前 fail-closed 上游校验

- **规则**: 采用生成类正文前, 仅当 `context_confirmation_id` 仍新鲜、`scene_execution_bundle_hash` 与当前 Scene 一致、且(若 review_required)`independent_review.verdict=pass` 且 `draft_hash==content_hash` 时才能采用, 否则冲突。
- **来源**: `specs/assets/writing.md`; `semantic_review.py:86-129`。
- **M4 落法**: store 的 adopt 原语校验候选 provenance 的上游冻结引用, 任一失配拒绝。
- **断言**: 上下文确认过期/Scene 变更后 adopt → 拒绝; 全部新鲜且 review pass → 允许。

### R36 · 采纳目标必须是已采用对象

- **规则**: merge/alias 裁决的 target 必须 canonical(`_require_canonical_target`)。
- **来源**: `specs/assets/world.md`; `suggestion_queue_service.py:942-955`。
- **M4 落法**: store 的 merge/attach_alias 原语校验 target status=canonical。
- **断言**: 目标为 candidate 的 merge 裁决 → 拒绝; 目标 canonical → 允许。

### R37 · 已采用对象合并/设别名二次确认

- **规则**: source 为 canonical 且未 `allow_canonical_merge/alias` → 返回 `confirmation_required`/跳过。
- **来源**: `specs/assets/world.md`; `entity_fusion.py:743-755,1086-1094`。
- **M4 落法**: store 对 canonical 对象的 merge/alias 要求 approval 二次确认(approval 原语)。
- **断言**: 未确认的 canonical merge → confirmation_required; 确认后 → 执行。

### R38 · 同组原子应用(整体回滚)

- **规则**: 融合/采纳组 group apply 任一项失败整体 raise, 由调用方 savepoint 回滚, 不部分应用。
- **来源**: `specs/assets/world.md`; `entity_fusion.py:679-680`。
- **M4 落法**: store 的 batch adopt/merge 原子性 = 单 commit 承载整组, 任一失败不产生 commit。
- **断言**: 组内一项非法 → 整组无任何变更(无部分 commit)。

### R39 · 低置信不自动升 canonical

- **规则**: 低置信候选不得自动升 canonical; 候选默认 status=candidate, 低置信/uncertain 只进待处理。
- **来源**: `specs/assets/imports.md`(`scene_entity_persistence.py:845-857`、`README.md:112`)、`specs/assets/world.md`。
- **M4 落法**: store 的 auto-adopt 原语跳过低置信项; 只有授权清单内 + 达阈值的项才 promote。
- **断言**: 低置信候选在自动流水线后仍为 candidate, 不产生 canonical。

---

## 5. 恢复与 checkpoint(幂等续跑、授权快照不可变)

### R40 · 授权快照 fail-closed + 冻结不可变

- **规则**: 仅 `user_authorized_pipeline` 受支持; `authorization_confirmed` 必须 true; 快照提交时冻结, 恢复时快照缺失/未确认/策略不支持/scope 与 run 章节范围不一致 → 拒绝执行(默认不授权)。
- **来源**: `specs/assets/imports.md`「authorization_snapshot·完整性规则」; `adoption_policy.py:8-27`、`README.md:102`。
- **M4 落法**: `.assistant/checkpoint.json` 存授权快照, 写入后只读(不可变); store 每次可写操作前重验。
- **断言**: 无 authorization_confirmed → 入队前拒绝; 篡改/缺失快照 → 恢复拒绝。

### R41 · 自动写入仅限 auto_adopt; 回滚固定软废弃

- **规则**: 自动写入仅限 auto_adopt 清单(scene_without_review_flags / working_structure_asset); review 项进待处理; not_adopted 项不落资产; 回滚模式固定 `workflow_owned_soft_deprecate`(软废弃, 不硬删)。
- **来源**: `specs/assets/imports.md`; `adoption_policy.py:38-58`、`README.md:112`。
- **M4 落法**: store 的自动采纳原语只消费 auto_adopt 白名单; 回滚只置 deprecated 不删文件。
- **断言**: review 类资产经自动流水线后仍为待处理; abandon 回滚后资产软废弃而非消失。

### R42 · checkpoint input_fingerprint 一致才跳过

- **规则**: input_fingerprint = sha256(Scene 语义字段 + 实际消费正文 + context_fingerprint + prompt contract version); 只有 done/skipped 且指纹与当前输入一致才允许跳过, 否则 fail-safe 重跑。
- **来源**: `specs/assets/imports.md`「Phase 2 checkpoint·完整性规则」; `scene_entity_checkpoint.py:115-179`、`README.md:44`。
- **M4 落法**: store 续跑时对每个 checkpoint 重算输入指纹, 失配重跑(幂等续跑)。
- **断言**: 输入不变重跑 → skip; 正文/上下文变更 → 重跑该 Scene。

### R43 · 阶段内修复只覆盖失败 checkpoint

- **规则**: 阶段内修复只覆盖失败 checkpoint, 保留其他已完成或来源不完整 checkpoint; 不得把已完成 Scene 扩大为重跑范围。
- **来源**: `specs/assets/imports.md`; `README.md:39`。
- **M4 落法**: store 的 resume 只重放 failed 检查点, done/skipped 不动。
- **断言**: 修复循环只重跑失败 Scene, 已 done Scene 不被重跑。

### R44 · 每 novel 最多一个活跃 run

- **规则**: 每 novel 最多一个 pending/running 或 recovery-required run(partial unique index)。
- **来源**: `specs/assets/imports.md`「ImportWorkflowRun·完整性规则」; `models.py:139-149`。
- **M4 落法**: store 的 begin_import 前检查 `.assistant/checkpoint.json` 无活跃 run, 否则拒绝。
- **断言**: 已有 running run 时再 begin_import → 拒绝。

### R45 · owner CAS(require_owner 全匹配)

- **规则**: 每次可写操作 require_owner 必须 task_id + generation + owner_task_id + owner_attempt + owner_lease_id + status='running' 全匹配, 失配抛 OwnershipLost 回滚。
- **来源**: `specs/assets/imports.md`; `workflow_runs.py:367-417`。
- **M4 落法**: store 的 run 写原语按 owner 三元组 CAS; 映射到 DSH job 原生 lease/attempt(【待定: 边界见 imports.md 待定)。
- **断言**: owner 失配的 checkpoint/complete 写 → 拒绝; 匹配 → 通过。

### R46 · resume/abandon 仅 failed + recovery_required

- **规则**: resume 仅 failed + recovery_required → pending(generation+1); abandon 仅 failed + recovery_required → cancelled。
- **来源**: `specs/assets/imports.md`; `workflow_runs.py:465-498`。
- **M4 落法**: store 的 resume/abandon 原语校验前置状态。
- **断言**: 对 running run 调 abandon → 拒绝; failed+recovery_required → 允许。

### R47 · abandon 回滚整批软废弃 + 幂等 + 不碰 user_edited

- **规则**: abandon 回滚按 novel_id + workflow_id 整批软废弃 Scene/世界对象/候选关系/候选别名/结构资产, Memory DeltaLog meta.rolled_back=true; 不碰其他 workflow/小说或 user_edited 资产; 回滚幂等。
- **来源**: `specs/assets/imports.md`; `README.md:127`。
- **M4 落法**: store 的 abandon 原语对本次 workflow 产物批量置 deprecated, 跳过 user_edited; 幂等。
- **断言**: abandon 两次结果一致; 作者手改过的资产不被回滚。

### R48 · 进度 compact + total_steps 固定 + 中断标志 stale 收敛

- **规则**: 进度/checkpoint/phase_artifacts/progress_events 只保留 compact 信息(不含正文/API key/raw prompt/raw LLM 输出); total_steps 固定 3, completed_steps 去重; 中断/恢复标志由 worker stale 扫描收敛, 前端仅在 available_actions 含 resume+abandon 时展示恢复。
- **来源**: `specs/assets/imports.md`; `workflow_schemas.py:14-22,71-74,128-153`、`README.md:172-175,208-210`。
- **M4 落法**: store 写 checkpoint.json 前做 secret/正文脱敏; 进度由 DSH job 投影, 持久恢复事实落 checkpoint。
- **断言**: checkpoint.json 不含正文/Key; completed_steps 无重复; 非法 resume 入口被隐藏。

### R49 · memory checkpoint supersede / 人工修复 CAS

- **规则**: 只 supersede 同 Scene、同维度、system_generated 的 current 版本; manual/confirmed 版本始终保留; 人工修复必须带 expected_checkpoint_id + confirmed=true, 并发已更换时 409; 事件流变更先使该点及后续系统 checkpoint/稀疏快照失效。
- **来源**: `specs/assets/small-modules.md`「MemorySceneCheckpoint·完整性规则」; `repositories.py:971-973`、`schemas.py:261-304`。
- **M4 落法**: store 的 memory 重建/修复原语按 expected_checkpoint_id CAS, 保留 manual/confirmed。
- **断言**: supersede manual 版本 → 拒绝; 修复带过期 expected_checkpoint_id → 409。

---

## 6. 世界书 lifecycle(draft/canonical、发布 CAS、publish-impact)

### R7 · 世界书发布 CAS + content_hash 派生失效 + publish-impact【继承 R7】

- **规则**: 发布工作稿校验 `draft.base_version_number == page.version_number`, 不一致 → ConflictError; `source_content_hash` 覆盖 title/page_type/free_text/sections/linked_asset_refs/template/version, 内容变更即触发派生(投影/简介)失效; publish-impact 是只读确定性引用影响预演, 发布时可带 `expected_impact_scope_hash` 重验, 引用变化 → 拒绝。
- **来源**: `specs/assets/world.md`「WorldBiblePage·完整性规则」; `world_bible_lifecycle_service.py:628-660,1148-1177`。
- **M4 落法**: store 的 publish 原语比对 base_version(等价 CAS), 更新 content_hash 与派生失效标记; publish-impact 为只读插件。
- **断言**: 草稿创建后页面被改再发布 → ConflictError; 发布后内容变更 → 简介/投影标记失效; 引用变化未带期望 hash → 拒绝。

### R50 · 世界书一页一活跃工作稿

- **规则**: 一页同时只有一个活跃工作稿(唯一约束 `uq_world_bible_page_active_draft`); 有活跃工作稿时不允许直接改已发布页。
- **来源**: `specs/assets/world.md`「WorldBiblePage·状态机」; `world_bible_lifecycle_service.py:197-198`。
- **M4 落法**: store 校验每页至多一个 draft 文件; 已有 draft 时对 canonical 页的直改拒绝。
- **断言**: 同页第二个活跃工作稿 → 拒绝; 有 draft 时直改 canonical → 拒绝。

### R51 · 页面提案只能走 lifecycle

- **规则**: 生成中心产出的页面提案(world_bible_page_draft 建议)只能作为工作稿, 经 lifecycle 发布为 canonical, 不直接写已采用页。
- **来源**: `specs/assets/world.md`; `suggestion_queue_service.py:422-426`、`world_bible_lifecycle_service.py:publish_draft`。
- **M4 落法**: store 禁止页面提案直接写 canonical; 只允许入 pending/draft, 经 publish 原语采用。
- **断言**: 页面提案直接落 canonical → 拒绝; 经 draft→publish → 允许。

---

## 7. 降级条款(失败/低置信的确定性处置)

### R52 · 降级 1b: 空语义进复核

- **规则**: scene_enrichment(1b)provider/schema 失败保留空语义 + `narrative_tag=draft` 并进复核; `imported` 历史值提交时归一为 `draft`(来源由 source=deep_import 表达)。
- **来源**: `specs/prompts/catalog.md` §1.4 降级; P体系 §5。
- **M4 落法**: store 对 1b 失败结果写 status 候选/复核标记, 不伪造语义字段。
- **断言**: 1b 失败 → Scene 以 draft + 复核态入待处理, 不出现空目标/空冲突被误认 canonical。

### R53 · 降级 2b: 只降级不丢对象

- **规则**: 实体/别名/关系无法可靠判断时: 实体进 `uncertain_items`(不落长期资产)、别名作为带 identity_scope/依据/快照的待复核内联证据附着、关系只写待复核候选或补证据, 不自动覆盖/废弃已采用; 不建重复对象。
- **来源**: `specs/prompts/catalog.md` §1.6/§1.7 降级; P体系 §5「抽取类」。
- **M4 落法**: store 对低置信抽取产物只入 pending(不 promote), 已采用资产不动。
- **断言**: 低置信关系 → 不写 canonical 边、不废弃已有边; 低置信实体 → 无新 canonical 对象。

### R54 · 降级 1a: 重叠/空洞整章 fallback

- **规则**: Scene 覆盖恢复必须通过唯一 anchor/offset/顺序/无重叠/无空洞/source hash/邻居存在性校验, 按整个 gap 原子应用; 失败保留精确整章 fallback, 不部分采用。
- **来源**: `specs/prompts/catalog.md` §1.3 降级; P体系 §5。
- **M4 落法**: store 的 gap 应用为原子 commit, 校验失败回退到整章 fallback, 禁止部分 Scene 落库。
- **断言**: 覆盖有空洞 → 整章 fallback, 无部分 Scene; 校验全过 → 原子应用。

### R55 · 去重失败降级(不抛异常)

- **规则**: 结构去重失败返回 degraded=1、error_kind=structure_dedup_failed、suggestions=[], 不抛异常; 同一资产出现在多个 suggestion pair 只计一次。
- **来源**: `specs/assets/imports.md`「结构去重建议·完整性规则」; `deep_import_dedup.py:36-53`、`README.md:112`。
- **M4 落法**: store 的去重原语失败不中断 workflow, 结果标记 degraded。
- **断言**: 去重异常 → 结果 degraded 且 suggestions 为空, 工作流不崩。

### R56 · RAG reranker 降级(弃权/保留原序)

- **规则**: 高置信 unsupported 返回空结果(真正 abstention); uncertain/低置信/provider/schema 失败保留原排序并告警; extraction 模式不采用仅主题相关片段; 默认关闭(RERANKER_ENABLED)。
- **来源**: `specs/prompts/catalog.md` §5.1; `rag/reranker.py:22-30,245`。
- **M4 落法**: reranker 是派生步骤, 失败回退确定性排序; 开关进 policy.yml。
- **断言**: unsupported 高置信 → 空结果; 失败 → 原排序不丢; 关闭 → 跳过 rerank。

### R57 · 世界生成/问答降级(不建 suggestion/拒答)

- **规则**: 收敛修复仍失败返回不完整预览不建 suggestion; 世界问答无相关证据在模型调用前拒答, 仍无合法引用失败; 简介无法归因内容丢弃、冲突保留冲突提示; 探索不能写页面/递归/建 suggestion。
- **来源**: `specs/prompts/catalog.md` §4.2/§4.3/§4.9/§4.10 降级; P体系 §5。
- **M4 落法**: store 对世界生成产物只落 pending 或只读, 不自动 canonical; 问答无证据即拒答。
- **断言**: 收敛失败 → 无 suggestion 落库; 无证据 ask → 拒答(no_answer); 无法归因简介内容 → 丢弃。

### R58 · 审计/修订/正文降级(清空引用标 uncertain)

- **规则**: P20 审计的字段/短引用修正须逐项执行, 无法可靠修正则清空引用并标 uncertain, 缺必要线程返回 needs_author_decision 不跨层暗建; 正文 materializer 拒绝擅增长期规则/承诺/期限/关系变化/重大后果, 失败保留候选不写正史。
- **来源**: `specs/prompts/catalog.md` §2.2/§2.3/§3.1 降级; P体系 §5。
- **M4 落法**: store 对生成正文/结构做确定性 materializer 校验, 越权内容拒写正史。
- **断言**: 候选含擅增长期规则 → 拒写正史; 无法修正的引用 → 清空 + uncertain 而非编造。

### R59 · 冻结失效降级(审查/返修期间变化丢弃)

- **规则**: 独立审查/定向返修冻结目标 content_hash + Scene bundle hash + 相邻章; 审查期间或落库前任何变化 → 丢弃过时结果返回冲突; 返修后基线正文或 Scene 合同变化 → 不写 candidate。
- **来源**: `specs/assets/writing.md`; `semantic_review.py:330-399,430-433,633-644`。
- **M4 落法**: store 在写入审查回执/返修候选前重验冻结 hash, 失配丢弃。
- **断言**: 审查后正文变化 → 回执作废; 返修后基线变化 → 候选不落库。

---

## 8. 命名与 id 规范(此项含【待定】, 等待上层裁定)

### R60 · 融合 operation 归一

- **规则**: 融合 operation 的中文别名(keep/merge/拆分/排序/重写等)一律归一到 kept/merged/split/reordered/rewritten。
- **来源**: `specs/assets/imports.md`「Scene 候选·完整性规则」; `scene_fusion.py:238-258`。
- **M4 落法**: store 写候选 frontmatter 前做 operation 归一。
- **断言**: 输入「拆分」→ 存为 split; 未识别值 → 拒绝/归一失败。

### R61 · narrative_tag 归一(imported→draft, 截断 32)

- **规则**: narrative_tag 的 `imported` 历史值归一为 `draft`, 并截断到 32 字符; 默认 draft。
- **来源**: `specs/assets/imports.md`「Scene 正式提交·完整性规则」; `scene_commit.py:17,482-486`。
- **M4 落法**: store 写 Scene frontmatter 前归一 narrative_tag。
- **断言**: 输入 imported → 存 draft; 超长标签 → 截断 32。

### R62 · 健康键命名统一【待定】

- **规则**: Scene 层四健康键(unreviewed/unassigned/missing_setup/needs_organize)与结构资产级过滤键(needs_review/unassigned)是否统一为一套「信号命名规范」, 尚未裁定。
- **来源**: `specs/assets/outline.md`「结构健康信号·待定」。
- **M4 落法**: 等待上层裁定后再定 store 的信号 key 常量表; 在此之前按两套并存记录。
- **断言**: 【待定】暂不可测, 裁定后补充。

### R63 · 幂等键/引用 slug 命名统一【待定】

- **规则**: entity_key / provenance_key / occurrence_key / 各 `*_id` 引用在 M4 统一为 slug 引用(如 `obj_klein`、`s012`)的命名规范与边界, 尚未统一裁定。
- **来源**: `specs/assets/outline.md`(文件头引用约定)、`specs/assets/imports.md`、`specs/assets/world.md`。
- **M4 落法**: 等待统一命名规范; 在此之前 store 不硬编码 slug 规则。
- **断言**: 【待定】暂不可测, 裁定后补充。

### R64 · narrative_tag 与 narrative_function 双轨合并【已裁定 D26#8】

- **规则**: `narrative_tag` 与 `structure_meta.narrative_function` 合并为单一 `narrative_tag`。
- **来源**: `specs/assets/outline.md`「Scene·待定」; 裁定 `specs/adjudications.md` #8。
- **M4 落法**: store 的 Scene frontmatter 字段表只保留单一 `narrative_tag`; 旧
  `narrative_function` 值导入时并入 narrative_tag(超长截断 32, 见 R61)。
- **断言**: 含 narrative_function 的旧数据导入 → 落为单一 narrative_tag。

---

## 附: 待定汇总(需上层裁定)

1. §8 三项命名规范(R62/R63/R64)等待统一裁定。
2. ~~`structure_meta` 嵌套 vs 平铺~~ **已裁定 D26#9: 平铺为 frontmatter 顶层字段**(过滤键直接读顶层)。
3. owner fencing(attempt/lease/generation)映射到 DSH job 原生 lease/attempt 的边界(R45)。
4. `merge_records` 落在对象 frontmatter 还是独立索引(影响 R6 的可回滚标记落点)。
5. `candidate/proposal` 两个历史状态在 M4 是否并入 draft(影响 §2 迁移表)。
