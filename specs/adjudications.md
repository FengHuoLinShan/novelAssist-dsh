# R0 资产规格裁定记录(用户已确认)

- 裁定日期: 2026-08-14, 用户对 18 条裁定全部确认
- 效力: 本文件是 specs/assets/*.md 与 specs/prompts/catalog.md 中全部【待定】标注的
  **最终裁定**; 各 spec 文件内的【待定】标记以此为准, 不逐一回改。
- 关联决策: 设计文档决策表 D26

| # | 裁定 | 决定 |
|---|---|---|
| 1 | story-outline 落点 | `structure/outline.md` |
| 2 | reveal plan 落点 | `structure/reveal.md`(与伏笔配对, 不合一) |
| 3 | 候选正文落点 | `chapters/pending/*.md`; adopt = copy-on-adopt 移入 `chapters/{NNN}.md` + git commit |
| 4 | 派生审查/回执类(冲突检查/问题项/语义审查/POV 元数据) | `.assistant/reviews/*.json`, 不进文件夹真相 |
| 5 | merge_records 落点 | `.assistant/merge-log.jsonl` |
| 6 | Scene 历史状态 candidate/proposal | 并入 `draft`, 状态机瘦身为 draft/canonical/deprecated |
| 7 | version_number | 保留为可选 frontmatter(审计/历史列表用); 版本真相由 git commit 承接 |
| 8 | narrative_tag / narrative_function 双轨 | 合并为单一 `narrative_tag` |
| 9 | structure_meta 嵌套 dict | 平铺为 frontmatter 顶层字段(好 diff/手改) |
| 10 | thread_type / current_stage | 开放字符串 + policy.yml 推荐目录(与「复核类型只推荐」一致) |
| 11 | planned_payoff_scene 整数索引 | 改为 slug 引用(统一 id 引用约定) |
| 12 | 健康键命名统一 | 由 specs/rules/store-rules.md 定命名规范 |
| 13 | KnowledgeTag 落点 | 对象 frontmatter 派生字段 `tags: []`, 索引可重建, 不独立成文件 |
| 14 | content_json 动态属性 | 保留为 frontmatter JSON 键; 常用字段可升顶层 |
| 15 | profile_field | 保留在 Character 扩展(1:1 并入对象正文) |
| 16 | importance | 保留为可选字段(剧情雷达排序) |
| 17 | checkpoint/adoption 子类型 | 收敛为 `world/pending/*.md` 的 target_type 枚举, 不单列子类型 |
| 18 | 图片(D19) | Spec 保留 image_version 并标注「v1 不实现」; 未来按需独立插件 |

## 第二批(R0 rules 批次, 2026-08-14 用户确认, D27)

| # | 裁定 | 决定 |
|---|---|---|
| N1 | 健康键命名统一(R62) | 信号词汇表按域前缀 6 键: `scene_unreviewed / scene_unassigned_chapter / scene_missing_setup / scene_needs_organize / structure_needs_review / structure_unassigned` |
| N2 | slug 命名规范(R63) | id = 文件名 slug; 引用写裸 slug(kind 由目录上下文给出); 幂等键(entity_key/provenance_key/content_hash)算法不动 |
| N3 | 4 个缺默认的新键 | `watch.notify_threshold=5`、`repair.max_rounds=3`、`dedup.l2_threshold=0.5`、`alias.attach_confidence=0.8` |
| N4 | CONTEXT_BUDGET 归属 | helper 内置常量, 不进 policy.yml |
| N5 | llm.yml 与 policy.yml 键划分 | provider 级(temperature/top_p/max_tokens/timeout/model)→ llm.yml; workflow 级(并发/预算/阈值/降级/守望)→ policy.yml; prompt 契约固定值 → spec 目录 |
| N6 | 并发口径冲突 | 以 `deep_import_settings` 项目可调值为权威, 模块常量仅代码兜底 |
| N7 | world_ask 超时常量名 | 实现期回源码核对(实现备忘) |
| N8 | policy.yml schema 校验归属 | `@novelcraft/store` 负责(版本号 + JSON Schema) |
| N8 | policy.yml schema 校验归属 | `@novelcraft/store` 负责(版本号 + JSON Schema) |
| N9 | book.yml 字段名(vault 实现期裁定) | **以 specs/assets/small-modules.md 的旧代码映射为权威**: `target_length`(short/medium/novel/epic)+ `current_stage`(world_building/outlining/writing/revising), 不用 `target_scale`/`stage` |
| N10 | slugify 中文标题(vault 实现期裁定) | **保留 CJK 字符**(id 可含中文, 如「诡秘之主」), 仅归一空白、剔除路径非法字符、限长 64; 冲突加短后缀; 纯非法/空抛错 |
| N10 | slugify 中文标题(vault 实现期裁定) | **保留 CJK 字符**(id 可含中文, 如「诡秘之主」), 仅归一空白、剔除路径非法字符、限长 64; 冲突加短后缀; 纯非法/空抛错 |
| N11 | relations 存储形态(store 实现期裁定) | 对象 frontmatter `relations: []` 为源, 有向对由索引派生(不做独立文件) |
| N12 | 结构资产粒度(store 实现期裁定) | **目录化**: `structure/threads/<slug>.md`、`structure/arcs/<slug>.md`、`structure/foreshadowing/<slug>.md`、`structure/reveal/<slug>.md`; 总纲保持 `structure/outline.md` 单文件。每资产一文件 = 细粒度 CAS/手改/git diff |
| N13 | content_hash 格式(store 实现期裁定) | 存储用纯 64 位 hex; 读入时兼容 `sha256:` 前缀 |
