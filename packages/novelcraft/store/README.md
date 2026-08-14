# @novelcraft/store

NovelCraft M4(ADR-0016)R1 内核包: frontmatter 校验、adopt+commit、CAS、
merge/split/attach_alias、索引重建。

纯 TS, strict 模式; 零 DSH 依赖、零 LLM、纯确定性; git 操作用
`node:child_process` 调 git CLI(见 `../README.md` 工程约定)。

## 依赖

- 直接依赖 workspace 包 `@novelcraft/vault`(路径规范 + 读写门禁 + slugify)。
- 依赖 `yaml`(frontmatter 解析/序列化, 见 package.json)。

> **vault 依赖**: 直接依赖 workspace 包 `@novelcraft/vault` 的 dist 入口
> (`main: ./dist/index.js`), 无 `paths`/alias 覆盖; 路径表完全复用 vault 的
> `paths(root)`(含 N12 目录化结构路径 `structure.<kind>` 与 `<kind>File(slug)`),
> 无自声明路径表。

## API(src/index.ts)

| 模块 | 导出 | 规则 |
|---|---|---|
| `frontmatter.ts` | `parseFrontmatter` / `serializeFrontmatter` / `validateFrontmatter` / `SCHEMAS` / `canTransition` / `entityKey` / `provenanceKey` / `normalizeEntityType` / `normalizeOperation` / `normalizeNarrativeTag` / `validateImportFile` | R3/R18/R19/R21/R22/R24/R25/R29/R31/R60/R61/R64 |
| `adopt.ts` | `adopt`(object/scene/chapter_candidate/bible_page/thread/arc/foreshadowing/reveal)/ `softDelete` / `confirmSuggestion` / `rejectSuggestion` | R2/R3/R4/R7/R8/R17/R19/R32/R34 |
| `paths.ts` | `paths` / `resolveAsset` / `structureFile` / `assetKindFromPath`(+ vault 透传) | N2/N9/N10/N12 |
| `merge.ts` | `mergeEntities` / `splitMerge` / `attachAlias` / `readMergeLog` | R1/R6/R24/R25/R26/R36/R37 |
| `index.ts` | `rebuildIndex` | R12 |
| `git.ts` | `gitInit` / `gitStatusPorcelain` / `gitAdd` / `gitCommit` / `gitRevert` … | R14/R17 |
| `health.ts` | `HEALTH_KEYS` / `computeSceneHealth` / `filterActive` | N1/R20/R62 |
| `dedup.ts` | `dedupeByEntityKey` / `findExactEntity` / `l0ExactGroups` / `shouldAutoPromote` | R21/R23/R27/R28/R39 |

## 落地约定(确定性选择, 供上层/联调核对)

- **content_hash**: 纯 64 位 hex, 对「去 frontmatter 后的正文 body」求 SHA-256;
  读入兼容 `sha256:` 前缀(writing.md 待定项取旧引擎纯 hex 口径)。
- **关系(relations)**: 落在对象 frontmatter 的 `relations: []`(每项 `{target, type, status}`),
  索引重建时派生「有向对」, 反向关系由索引翻转派生。存储形态待 world 规格最终确认。
- **结构资产(N12)**: 目录化 `structure/threads/<slug>.md`、`structure/arcs/<slug>.md`、
  `structure/foreshadowing/<slug>.md`、`structure/reveal/<slug>.md`(每资产一文件,
  经 vault 的 `paths().structure.dir` 派生); `structure/outline.md` 单文件不变。
- **关系(N11)**: 对象 frontmatter `relations: []` 为源, 有向对由索引派生(不做独立文件)。
- **content_hash(N13)**: 存储纯 64 位 hex, 读入兼容 `sha256:` 前缀(见上)。
- **状态机**: 白名单见 `TRANSITIONS`(store-rules §2); 未列迁移一律拒绝。
- **merge-log**: `.assistant/merge-log.jsonl`(adjudication #5), 每条 merge 记录可逆,
  split 追加 split 记录并恢复 source 状态与继承别名。
- **book.yml(N9)**: 字段名为 `target_length`(short/medium/novel/epic)与
  `current_stage`(world_building/outlining/writing/revising), 不用旧名
  `target_scale`/`stage`; 枚举值直接复用 vault 的 `TARGET_LENGTHS`/`CURRENT_STAGES`。
- **slug(N10)**: id = 文件名 slug, 保留 CJK(中文 id 合法); 索引/引用逻辑用 basename
  派生 slug, 不假设 ASCII(见 `slugFromFilename`)。

## 命令

```sh
npm test          # vitest run(测试覆盖 R1–R64 可测断言, 逐条注释引规则编号)
npm run typecheck # tsc --noEmit
```

## 规则覆盖

R1 别名不建新对象 · R2 已采用不硬删 · R3 adopt 仅 draft/candidate · R4/R32 建议队列
单赢家 · R6 合并可逆+二次确认 · R7 世界书发布 CAS · R8 content_hash CAS · R9 路径穿越/
novel 隔离 · R12 索引重建幂等 · R17 工作区脏拒绝 adopt · R18/R19 章节 copy-on-write/
候选只读 · R20 排除 deprecated · R21 entity_key · R22 provenance_key · R23 精确复用 ·
R24 别名归一化 · R25 占位词 · R26 自环/端点 · R27/R39 低置信不自动升 · R28 L0 确定性 ·
R29 entity_type 20 枚举 · R31 导入门禁 · R36 目标 canonical · R37 二次确认 · R60
operation 归一 · R61/R64 narrative_tag 归一与合并 · N1 六键健康词汇表。
