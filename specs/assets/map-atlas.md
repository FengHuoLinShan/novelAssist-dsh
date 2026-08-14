# map atlas 资产规格(R0 提取)

- 来源 commit: M4 无对应旧表(旧引擎 map_atlas 四表归档于 annotated tag `old-engine`)
- 提取日期: 2026-08-15
- 提取范围(权威来源优先):
  - `docs/agent/dsh-rebuild/map-atlas-实施计划.md`(§2 文件模型 / §5 关键确定性规则 / 附录 A, 简称「计划」)
  - `docs/adr/0020-map-atlas-m4-file-model.md`(ADR-0020)
  - 旧引擎只读参考: `old-engine:backend/modules/world/map_atlas_{models,schemas,workflow,storage}.py`、`old-engine:docs/modules/15_map.md`
  - 背景映射: `specs/assets/world.md`(世界对象 location slug)、`specs/prompts/catalog.md` §4.11/§4.12

> 说明: 本文件只写「创作资产 schema + 状态机 + 完整性规则」。图片字节不是 git 资产(落在本地
> `world/atlas/images/`, gitignore); run JSON / annotation 队列 / decisions 是 `.assistant/`
> 工作产物。所有字段的「M4 落点」为 ADR-0020 的文件布局路径。与计划文如有出入以计划文为准
> (见 ADR-0020 附录 A)。

---

## 地图册节点 AtlasNode(M4 落点: `world/atlas/nodes/*.md`(adopted)+ `world/atlas/pending/nodes/*.md`(provisional))

### 语义

地图册层级树的一个节点: 结构层级(cover/world/region/city/district/street/interior)或地点
(挂 `location_ref`)。节点跨 run 复用; 首张图片页 adopt 时把祖先链一次性 provisional→adopted
并迁入 `nodes/`(计划 §2.2)。`status=adopted` 且无 adopted page 的节点 = **空页占位**(读面派生)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 稳定标识 = 文件名/slug(如 `cover`、`city-changan`) |
| parent_ref | string\|null | 是 | 父节点裸 slug; `cover`/`world` 为 `null`(必须根) |
| location_ref | string\|null | 否 | `world/objects` 的 location 裸 slug; 非地点节点为 `null` |
| semantic_key | string | 是 | `entity:{location_slug}`(地点)或 `path:{parent_semantic}:{hash}`(结构节点) |
| level | enum | 是 | `cover/world/region/city/district/street/interior` 七级(见状态机层级约束) |
| title | string | 是 | 展示名 |
| summary | string | 否 | 概要 |
| status | enum | 是 | `provisional \| adopted`(见状态机) |
| sort_order | int | 否 | 同级排序号 |

### 状态机

```
provisional ──adopt(随首页原子采用祖先链)──▶ adopted
provisional ──adopt placeholder(空页占位单独采用)──▶ adopted
adopted ──(读面派生)──▶ 空页占位(adopted 且无 adopted page)
```

- `status=adopted` 且没有任何 adopted page 的节点 = **空页占位**, 在 atlas 树可点击、进入
  「待上传图片」态。该状态由 read 面派生, 不需要单独字段(计划 §2.1)。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id / parent_ref / location_ref / semantic_key / level / title / summary / status / sort_order | `map_atlas_nodes.*` | 旧 UUID → 文件名/slug; 旧 `plan_key` 语义并入 `semantic_key` |

### 完整性规则(必须在 @novelcraft/world 保留的确定性规则)

- **层级**: `cover`/`world` 必须根(`parent_ref=null`); 其余节点 `parent_ref` 非空且父级 rank
  严格大于子级 rank(cover=6 > world=5 > region=4 > city=3 > district=2 > street=1 > interior=0);
  `interior` 仅在显式开启时允许(计划 §5 规则 1)。
- **location_entity 唯一**: 已采用/候选节点的 `location_ref` 不重复(计划 §5 规则 2)。
- **id 唯一且先父后子**: 节点 id 唯一; 物化/校验顺序父先于子(计划 §5 规则 2)。
- **祖先链原子采用**: 首张图片页 adopt 或空占位 adopt 时, 祖先链一次性 provisional→adopted,
  循环与层级再校验, 单次 git commit(计划 Phase 4)。

---

## 地图册页面 AtlasPage(M4 落点: `world/atlas/pages/*.md`(adopted)+ `world/atlas/pending/pages/*.md`(candidate))

### 语义

地图册的一页 = **本地图片 + 可移动自定义文字标签**; 没有图片的页面不得进入「我的地图册」。
`prompt_only` 是规划产物(仅外部生图参考), 不可 adopt; `review_ready` 是有真实图片的候选页, 可
adopt。`review_status` 是页面生命周期真相; `status` 字段只在 node 使用(计划 §2.2)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | `page-<node-slug>` |
| run_ref | string | 是 | 来源 run id |
| node_ref | string | 是 | 归属节点裸 slug |
| generation_choice | enum | 否 | `upload`(本地路径导入的图片页); `prompt_only` 候选页无此字段 |
| generation_status | enum | 是 | `prompt_only \| review_ready` |
| review_status | enum | 是 | `candidate \| adopted \| rejected \| deprecated`(见状态机) |
| title | string | 是 | 页面标题 |
| visual_brief | string | 否 | 视觉简报(外部生图参考) |
| prompt | string | 否 | 生图 Prompt(外部生图参考文本; M4 不生图) |
| image | object | 否 | `prompt_only` 时缺省; 见 `image` 子字段表 |
| evidence | object | 否 | `supported[]` / `visual_fill[]` / `conflicts[]`(来源证据分组) |
| source_manifest | list\<ref\> | 否 | 来源清单(每条须可解析到 run `source_manifest` 同一 source_id/hash/open_target) |
| annotations | list\<annotation\> | 否 | 可移动文字标签; 见 `annotations` 子字段表 |
| review_note | string | 否 | 复核备注 |
| adopted_at | datetime | 否 | adopt 时写入 |
| rejected_at | datetime | 否 | reject 时写入 |
| deprecated_at | datetime | 否 | archive 时写入 |
| content_hash | string | 是 | 内容哈希; 每次内容变更更新, adopt/标签应用用其做 CAS |

### image 子字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| file | string | 是 | 相对路径 `images/<page-slug>/<attempt>.<ext>` |
| media_type | enum | 是 | `image/png \| image/jpeg` |
| sha256 | string | 是 | 图片 sha256(adopt CAS 用) |
| width | int | 是 | 像素宽 |
| height | int | 是 | 像素高 |
| byte_size | int | 是 | 字节数 |

### annotations 子字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | `ann-<slug>` |
| label | string | 是 | 标签文本(非空) |
| position_x | float | 是 | 归一化坐标 0–1 |
| position_y | float | 是 | 归一化坐标 0–1 |
| target_node_ref | string | 否 | 目标节点裸 slug; **仅可指向已 adopted 节点** |
| sort_order | int | 否 | 排序号 |

### 状态机

```
prompt_only ──upload(本机路径导入)──▶ review_ready
review_ready ──adopt──▶ adopted ──archive──▶ deprecated ──restore──▶ adopted
review_ready ──reject──▶ rejected(终态)
```

- `prompt_only` 只能作为生图 Prompt 参考, **不能 adopt**(计划 §2.2/附录 A.8)。
- adopt 前置: `generation_status=review_ready` 且 `image.file` 存在并通过校验; 缺图/prompt_only
  → 拒绝(计划 §2.2)。
- 上传到已有 adopted 节点(含空页占位)= 补图或画廊追加; 上传到新位置 = 创建 provisional 节点,
  adopt 时原子采用祖先链(计划 附录 A.2)。
- 历史不硬删: reject/deprecated 只改状态, git 保留版本; 图片文件保留在本地 `images/` 下作为
  本地历史(计划 §2.2/附录 A.6)。
- 注: 计划 附录 A.2 曾写 `uploaded` 中间态, 已按主计划 §2.2/Phase 4 统一为不落地(见 ADR-0020
  附录 A)。

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| run_ref / node_ref / generation_status / review_status | `map_atlas_pages.*` | 旧 `status planning/prompt_review/generating/...` 简化为 `prompt_only\|review_ready` + `review_status` 四态 |
| image.file / sha256 / width / height / byte_size | 旧 S3 `map-atlas/{novel_id}/pages/{page_id}/attempts/.../image.png` 元数据 | S3 → 本地 gitignore 目录; 相对路径引用 |
| annotations[] | `map_atlas_annotations.*` | 旧坐标像素 → 归一化 0–1 |

### 完整性规则(必须在 @novelcraft/world 保留的确定性规则)

- **prompt_only 不可 adopt**: adopt 前置 `generation_status=review_ready` 且 `image.file` 存在
  并通过校验(计划 §5 规则 6/10)。
- **adopt 门禁**: 候选页 adopt 前必须 git 干净 + content_hash CAS + 冲突确认(conflicts 存在且
  未确认 → 拒绝)+ 存在本地图片(计划 §5 规则 6)。
- **历史不硬删**: rejected/deprecated 只改状态不物理删除; 图片不进入 git 历史(计划 §5 规则 7)。
- **空占位**: adopted 节点可以没有 page; adopted page 不能没有 image(计划 §5 规则 10)。

---

## 地图册 run AtlasRun(M4 落点: `.assistant/atlas/runs/<run-id>.json`, 工作产物, git 提交)

### 语义

一次地图册规划/上传的执行单元, 承载 run 状态、plan、snapshot、journal 与 checkpoint。是工作
产物(非创作资产), 与候选 node/page 一样 git 提交, 图片字节除外。

### 字段(核心, 计划 §2.3)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| schema_version | int | 是 | 固定 `1` |
| id | string | 是 | `atlas-run-...` |
| run_kind | enum | 是 | `initial \| update \| rebuild \| upload`(upload 为本地路径导入的 1 页 run) |
| status | enum | 是 | `planning \| review_ready \| failed`(见状态机) |
| options | object | 是 | `style_note` / `include_working_drafts` / `include_interiors` / `full_rebuild` |
| context_hash | string | 是 | 上下文指纹(来源与选项的哈希) |
| source_manifest | list\<ref\> | 是 | 来源清单(节点/页面来源须可解析到它) |
| spatial_evidence | object | 否 | 空间事实(含 `source_fingerprint` 供指纹复用) |
| atlas_plan | object | 是 | `style_brief` + `nodes[]`(规划结果) |
| planned_page_count | int | 是 | 规划页数(≤20) |
| checkpoint | string | 否 | 续跑标记(如 `spatial:2`) |
| error_code | string | 否 | `failed` 时的错误码 |
| error_message | string | 否 | 错误信息 |
| journal | list | 是 | 每个 llm_step 的记录(attempt/duration/usage/error) |

### 状态机

```
planning ──▶ review_ready(规划成功)
planning ──▶ failed(规划失败, fail-closed; error_code 记录)
(review_ready 可经 checkpoint 续跑; 同一 options + 已完成 run 不重复跑)
```

- 失败 fail-closed: 不产出 adopted 资产; run status=failed + error_code(计划 Phase 3)。
- upload run: 目标节点已有 `prompt_only` 候选页 → 图片挂到该页并置 `review_ready`; 否则新建
  upload run + 候选页(计划 Phase 4)。

### 旧表映射

| 字段 | 旧表.列 | 备注 |
|---|---|---|
| id / run_kind / status / options / source_manifest / atlas_plan / journal | `map_atlas_runs.*` | 旧 `status planning/prompt_review/generating/...` 简化为 `planning\|review_ready\|failed`; 旧四表 → JSON 文件 |

### 完整性规则

- **run 状态机**: 只允许 `planning → review_ready` 或 `planning → failed`; upload run 直接落
  review_ready 候选页(计划 §3/Phase 3)。
- **checkpoint 续跑**: spatial facts 带 checkpoint, 可续跑; 来源指纹与最近成功 run 相同且未
  degraded → 复用 facts(计划 Phase 2)。

---

## 空间事实 SpatialFact(M4 落点: 派生/规划输入, 不独立成文件; 进 run `spatial_evidence`)

### 语义

每批 5 个地点提取的空间事实, **只作规划输入, 不回写正式资产**(计划 §1.1/§7 后置 2)。由
`llm_step(spec=map_spatial_facts)` 产出, 确定性 partition: `explicit→supported`、
`inferred/working→visual_fill`、`conflicting→conflicts`。

### 字段(schema 要点)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| locations[].location_key | string | 是 | 必须逐字来自服务端 packet |
| locations[].facts[].statement | string | 是 | 空间事实陈述 |
| locations[].facts[].basis | enum | 是 | `explicit \| inferred \| working \| conflicting` |
| locations[].facts[].source_keys | list\<string\> | 是 | 必须逐字来自 packet |

### 完整性规则

- **逐字 key**: `location_key` 与 `source_keys` 必须是服务端 packet 中的逐字 key; 不得推理坐标
  (计划 §5 规则 4)。
- **数量上限**: 每地点 ≤12 条, 每批 ≤60 条; 支持 conflict 上限(计划 Phase 2)。
- **降级**: 单批失败记 `degraded`, 不阻断; 全批失败记 `all_batches_failed`; RAG 失败只减少证据
  不失败; 无地点 → `insufficient_sources`(计划 Phase 2)。

---

## 标签意图队列 annotation-queue(M4 落点: `.assistant/atlas/annotation-queue/<page-ref>.json`, 只记录不落资产)

### 语义

UI 标签编辑(L1)的 intent 队列: client 把坐标级 ops 落盘到队列 + push 信号, 助手 agent 调
`novelcraft_map_atlas_annotation` 工具只消费队列、不生成坐标(计划 §6)。

### 字段(schema 要点, 计划 §6 示例)

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| page_ref | string | 是 | 目标页 |
| base_content_hash | string | 是 | 应用前 CAS 基线 |
| ops[] | list | 是 | `op`(add/update/delete)、`id`、`label`(add/update)、`position_x/y`(add/update, 0–1) |

### 完整性规则

- **坐标级机器描述**: ops 机器生成、机器消费, 坐标恒归一化 0–1; 工具拒绝自然语言坐标描述
  (计划 §5 规则 11)。
- **标签写不改 image/status/title/prompt**: 标签写只改 annotations + 重算 content_hash(计划
  §5 规则 9)。

---

## 完整性规则总索引(供 @novelcraft/world 逐条落地, 计划 §5)

| # | 规则 | 可测试断言口径 |
|---|---|---|
| 1 | 层级 | `cover`/`world` parent_ref=null; 非根节点父 rank > 子 rank; interior 仅显式开启时允许 |
| 2 | 节点数 | plan nodes ≤20; location_ref 唯一; 节点 id 唯一且先父后子 |
| 3 | 来源 | 每条 source 可解析到 source_manifest 同一 source_id/hash/open_target; working 不能单独支撑 supported |
| 4 | 空间事实 | location_key/source_keys 逐字来自 packet; 不得推理坐标 |
| 5 | 更新 | update run 只允许规划已变化/缺失/新来源节点; 无变化 → review_ready 空 plan |
| 6 | 采用 | 候选页 adopt 前 git 干净 + content_hash CAS + 冲突确认 + 存在本地图片; prompt_only 不可 adopt; 祖先链原子采用 |
| 7 | 历史 | rejected/deprecated 只改状态不物理删除; 图片不进入 git 历史 |
| 8 | 无生图 | 全仓不出现 gpt-image-2 / Image API 调用; 图片只能本机路径导入并写入 gitignore 图片目录 |
| 9 | 标签 | label 非空; 坐标 0–1; target_node_ref 指向已 adopted 节点; 标签写不改 image/status/title/prompt |
| 10 | 空占位 | adopted 节点可以没有 page; adopted page 不能没有 image |
| 11 | 标签队列 | UI ops 是坐标级机器描述; 工具只消费队列或精确 ops; 拒绝自然语言坐标; 坐标恒 0–1 |

---

## 待定 / 口径(逐条关闭或显式列出)

1. 【已关/口径】**规划 run 同步执行**(计划 §1.3 待确认 1): 首版用 `novelcraft_map_atlas_plan`
   工具同步执行(同 deep_import 模式, timeout 3600s), 不做 ctx.jobs 队列; run JSON 提供
   checkpoint/续跑。后续 ctx.jobs 队列化为后置 3。
2. 【已关/口径】**adopt 审批边界**(计划 §1.3 待确认 2): adopt/adopt_placeholder/restore 必经
   ApprovalGate(fail-closed); reject/archive 也走同一工具(不过 approval)。
3. 【已关/口径】**map_atlas_plan 预算 4000**(计划 §1.3 待确认 3): 默认 4000 tokens; 旧引擎实际
   12000; 若 20 页 schema 修复频繁失败, 下一轮裁定提升 12000(见 policy-defaults map_atlas 段)。
4. 【显式后置】AI 图片生成/编辑/重试(后置 1); map observations 回写正式资产(后置 2); ctx.jobs
   队列化与进度轮询(后置 3); 世界书 publish-impact × map atlas 联动(后置 4); Story Map 视觉
   时间线(后置 5)。
5. 【待定】`update_prompt` 工具(计划 §5 可选工具)是否落地, 工具数 14 → 19 或 20 按此定。
