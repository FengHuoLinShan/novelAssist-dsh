# 世界地图册(map atlas)实施计划 — 不含生图模块

> 日期: 2026-08-15
> 目标: 把父仓库 / `old-engine` 中 `world/map_atlas_*` 的能力迁移到 novelAssist-dsh M4,
> **明确不实现图片生成**。落地为 `@novelcraft/world` 的 map 子系统 + DSH 工具/客户端读面。
> 关联整理: `docs/agent/dsh-rebuild/地图能力整理.md`

---

## 1. 范围裁定

### 1.1 本轮做

| 能力 | 说明 |
|---|---|
| 地图册层级规划 | initial / update / rebuild 三种 run; `style_note`、工作稿开关、室内图开关保留 |
| 空间事实提取 | 每批 5 个地点、最多核对 20 个已采用 location; 空间事实只作规划输入 |
| 来源上下文编译 | 已采用地点对象 + 世界书 canonical/draft + RAG `map_atlas` 证据; 8000 字/地点、40000 字/批上限 |
| AtlasPlan 校验 | ≤20 页、无环、父级先于子级、层级严格递降、来源必须来自当前 vault |
| 候选 run / 页面 / 节点 | 文件真相落盘; run 状态机; 候选页 review |
| Prompt 产物 | 每页 `visual_brief` + `prompt` + evidence/source_manifest + 初始文字标签建议; prompt 仅作外部生图参考 |
| 地图页构成 | **已采用地图页 = 本地图片 + 可移动自定义文字标签**; 没有图片的页面不得进入「我的地图册」 |
| 空页占位 | 允许只设定层级/地点的 adopted 空节点占位; 作者先点进空页, 再上传对应图片 |
| 地图册生命周期 | 图片页 adopt / reject / archive / restore; 空节点占位单独 adopt; 祖先节点随首页原子 adopt |
| 地图册树/读面 | 本次结果(review)与我的地图册(atlas)两种视图; atlas 树同时显示图片页与空页占位 |
| 客户端面板 | 层级树 + 图片预览 + 可移动文字标签编辑 + Prompt/证据/来源/缺图态 |

### 1.2 明确不做(生图相关; 本地路径导入见附录 A)

- 不调用 `gpt-image-2` / Image API; 不生成图片字节。
- 不做 S3/MinIO 等在线对象存储、图片 URL、缩略图服务、删除补偿。
- 不做 `generation_choice=internal`、`prompt_review → generating` 状态机、provider_in_flight /
  uploaded / retry_requires_confirmation / 重复扣费确认。
- 不做页面 regenerate / edit(蒙版)/ retry / 图片 reference image 读取。
- 不做 `layout` / `quality` / `review_image_prompts` 三个纯图片参数(API 不接收)。
- 不做旧六边形动态地图(已废弃)。

> **本地路径图片导入**(已确认): 作者提供本机图片路径(仍不调用生图 API)，
> 上述「上传/图片存储/图片字节读写」限制需按 **附录 A: 允许上传地图图片的增量方案** 调整。
>
> 本机使用口径(用户已确认): 项目与 DSH 一起在本机运行，不上线部署；图片**不推送 GitHub**。
> 所谓「上传」= 解析本机文件路径 → 校验 → 最多复制/整理到 vault 本地图片目录;
> 不做浏览器字节上传，也不把图片二进制纳入 git 提交。

### 1.3 裁定状态

**用户已确认(2026-08-15)**:
- `prompt_only` 页面**不能 adopt**; 地图册页面必须由「图片 + 可移动自定义文字标签」组成。
- 允许纯粹的层级/地点**空页占位节点**先进入地图册(adopted node 但无图片页)，供作者
  点进去后再上传对应图片。
- 本机运行; 图片 = 解析本机路径 + `mode=copy` 整理进本地图片目录; 不 push GitHub;
  克隆后缺图显示缺图态。

**文字标签通道已确认 = L1**: UI 提供直观快捷编辑(拖动/改名/增删，本地即时反馈)，
但 client 不直接写资产; 保存时只写 annotation intent 队列，由助手 agent 调
`novelcraft_map_atlas_annotation` 工具应用。L2 不采用，其利弊记录见文末「L2 未采用说明」。

**仍待确认**:
1. 规划 run 同步执行: 首版用 `novelcraft_map_atlas_plan` 工具同步执行(同 deep_import 模式，
   timeout 3600s)，不做 ctx.jobs 队列; run JSON 提供 checkpoint/续跑。
2. adopt/restore/空节点占位 adopt 必经 ApprovalGate: 客户端对图片/状态只读;
   `reject/archive` 建议也走同一工具。
3. `map_atlas_plan` 预算按 catalog 4000 tokens: 旧代码实际使用 12000; 若 20 页 schema
   修复频繁失败，下一轮裁定提升为 12000。

---

## 2. 文件模型(文件真相，无数据库)

```
<vault>/
  world/atlas/
    nodes/<slug>.md              # 已采用/暂存节点(provisional | adopted)
    pages/<slug>.md              # 已采用图片页(图片 + 标签)
    pending/nodes/<slug>.md      # 本轮候选节点
    pending/pages/<slug>.md      # 本轮候选页面
  .assistant/atlas/
    runs/<run-id>.json           # run 状态/plan/snapshot/journal(工作产物, git 提交)
    annotation-queue/<page-ref>.json  # UI 标签编辑 intent(L1, 只记录不落资产)
    decisions/<page-ref>.json    # 客户端记录的 review 意图(可选，只记录不落资产)
```

### 2.1 node frontmatter

```yaml
id: cover
parent_ref: null
location_ref: null        # world/objects 的 location slug(裸 slug)
semantic_key: entity:长安  # 或 path:<parent>:<hash>
level: cover              # cover/world/region/city/district/street/interior
title: 封面
summary: ...
status: provisional       # provisional | adopted
sort_order: 0
```

- `status=adopted` 且没有任何 adopted page 的节点 = **空页占位**; 在 atlas 树中可点击，
  点击后进入「待上传图片」页。该状态由 read 面派生，不需要单独字段。


### 2.2 page frontmatter

```yaml
id: page-<node-slug>
run_ref: <run-id>
node_ref: cover
generation_status: review_ready  # prompt_only | review_ready
review_status: candidate         # candidate | adopted | rejected | deprecated
title: 封面
visual_brief: ...
prompt: ...
image:                           # prompt_only 时缺省
  file: images/<page-slug>/v1.png
  media_type: image/png
  sha256: <sha256>
  width: 1920
  height: 1080
  byte_size: 123456
evidence:
  supported: []
  visual_fill: []
  conflicts: []
source_manifest: []
annotations:
  - id: ann-<slug>
    label: 长安
    position_x: 0.5
    position_y: 0.3
    target_node_ref: city-changan
    sort_order: 0
review_note: null
adopted_at: null
rejected_at: null
deprecated_at: null
content_hash: <sha256>
```

- `review_status` 是页面生命周期真相; `status` 字段只在 node 使用。
- **adopt 前置**: `generation_status=review_ready` 且 `image.file` 存在并通过校验。
  `prompt_only` 只能作为生图 Prompt 参考，不能 adopt。
- 候选页先写 `world/atlas/pending/pages/`，adopt 时原子迁移到 `world/atlas/pages/`，
  与 `world/pending → world/objects` 同构。
- 节点按需 materialize 到 `pending/nodes/`; 首张图片页 adopt 时把祖先链一次性
  provisional→adopted 并迁入 `nodes/`。没有图片时也可单独 adopt 空节点占位。
- 文字标签(annotation)是页面的一部分: 每个标签有归一化坐标(0–1)、可选目标节点、
  排序号; 进入地图册后仍可新增/改名/拖动/删除。
- 历史不硬删: reject/deprecated 只改状态，git 保留版本。

### 2.3 run JSON 字段(核心)

```json
{
  "schema_version": 1,
  "id": "atlas-run-...",
  "run_kind": "initial",
  "status": "planning",
  "options": { "style_note": "", "include_working_drafts": false, "include_interiors": false, "full_rebuild": false },
  "context_hash": "",
  "source_manifest": [],
  "spatial_evidence": {},
  "atlas_plan": { "style_brief": "", "nodes": [] },
  "planned_page_count": 0,
  "checkpoint": "spatial:2",
  "error_code": null,
  "error_message": null,
  "journal": []
}
```

---

## 3. 迁移映射(旧引擎 → M4)

| 旧引擎 | M4 方案 |
|---|---|
| `map_atlas_runs/nodes/pages/annotations` 四表 | `world/atlas/**` 文件 + `.assistant/atlas/runs/*.json` |
| `run_kind initial/update/rebuild` | 保留三态; 恢复 `upload`(本地路径导入); 删除 edit/regenerate |
| `status planning/prompt_review/generating/...` | 简化为 `planning → review_ready / failed` |
| spatial evidence 每批 5、最多 20 地点 | 新 spec `map_spatial_facts` + 同规则 |
| `map_atlas_plan` + AtlasPlan 校验 | 新 spec `map_atlas_plan` + `validateAtlasPlan()` 纯函数 |
| semantic_key `entity:{id}` / `path:{parent}:{hash}` | `entity:{location_slug}` / `path:{parent_semantic}:{hash}` |
| 候选节点提案 + 首页 adopt 祖先链 | `pending/nodes` + `adoptAtlasPage()`; 空节点占位可单独 `adoptAtlasPlaceholder()` |
| page adopt/reject/archive/restore | `reviewAtlasPage()`(core)+ approval-gated dsh 工具; 只允许 `review_ready` 图片页 adopt |
| prompt get/update/confirm | get/update 保留; **confirm 移除**(无站内生图) |
| annotation 坐标编辑 | **本轮一等能力**: 新增/改名/拖动/删除 + 目标节点跳转; 写通道见 Phase 6 |
| node 手动调层级 | 第二优先，本轮可选实现 |
| S3 / gpt-image-2 / AI edit / retry | **out of scope**; 本地路径 upload 在 scope(附录 A) |
| `/api/world/map-atlas` 22 端点 | 收敛为 5–6 个 DSH 工具 + 1 个 client 读端点(+可选 annotation 写端点) |

---

## 4. 分阶段 Plan

### Phase 0 — Spec / 裁定(先冻结，后编码)

产出:
- `docs/adr/0020-map-atlas-m4-file-model.md`(Accepted):
  文件布局、无图片边界、prompt_only 不可 adopt、空节点占位、annotation 编辑(L1
  intent 队列 + agent 工具应用)、semantic_key、review 动作边界。
- `specs/assets/map-atlas.md`(新): node/page/run 字段表 + 状态机 + 完整性规则。
- `specs/prompts/catalog.md`:
  - §4.11 补 `map_spatial_facts`(temp 0 / max_tokens 4000 / 900s / 每批 5 地点)
  - `map_atlas_plan` 补输出 schema 要点(≤20、层级、来源白名单)
- `specs/rules/policy-defaults.md`: 确认 `budget.map_atlas.max_pages=20`、
  `batch_locations=5`、规划预算 4000; 新增 spatial facts 降级规则。
- `specs/adjudications.md` 增补 N23: 本轮 no-image-generation scope、`prompt_only` 不可 adopt、
  `空节点占位可 adopt` 与本地图片路径导入写边界。
- 更新 `novelcraft-map` / `novelcraft-world` skills 的口径。

验收: 文档无矛盾; catalog spec 可被 `registerSpec` 消费的字段齐备。

### Phase 1 — vault 路径 + 基础读面(@novelcraft/vault + @novelcraft/world)

工作:
- `@novelcraft/vault` 加法:
  - `VaultPaths` 增加 `atlas` 字段与 `world.atlas` 子路径(pending/nodes、pending/pages、
    nodes、pages、images)、`.assistant.atlas` 子路径(runs)。
  - `initVault` 建目录并把 `world/atlas/images/` 写入 `.gitignore`; 不改变现有字段。
- 新建 `world/src/map-atlas/`:
  - `types.ts`: `AtlasLevel / RunKind / RunStatus / PageReviewStatus / AtlasNode / AtlasPage /
    AtlasRun / AtlasPlan / SpatialFact / SourceRef / Evidence / AtlasAnnotation`
  - `read.ts`: `readAtlasTree(root)`(含空页占位与 `image_missing`)、`readAtlasRun(root, runId)`、
    `latestAtlasRun(root)`、`listAtlasHistory(root)`
  - `write.ts`: `writeAtlasNode / writeAtlasPage / writeAtlasRun / writeAtlasImage`(guardPath +
    文本 git add/commit; 图片只写本地 gitignore 目录，绝不 git add)
- 测试: 路径创建幂等; 空 vault 读面; tree 排序/历史派生。

验收: `npm test -w @novelcraft/vault` + `-w @novelcraft/world` 绿; typecheck 零错误。

### Phase 2 — 地图上下文编译 + 空间事实提取

工作:
- `context.ts`:
  - 选择 canonical `entity_type=location` 对象，排序: 已有 atlas 节点优先 > 世界书链接优先 >
    importance/name; 最多 20。
  - 读 `bible/*.md`: canonical 必选; `include_working_drafts=true` 时 draft 可选;
    标题/链接命中 location 的页面; 每地点 wiki≤3 页。
  - `@novelcraft/rag` `searchRag`(topK=5, purpose=map_atlas)补充正文证据。
  - 预算: 每地点 wiki+RAG ≤8000 字, 每批 ≤40000 字; 生成 source manifest 与
    `location_source_hashes`。
- `spatial.ts`:
  - 注册并调用 `llm_step(spec=map_spatial_facts)`, 每批 5 地点。
  - 校验 location_key / source_keys 必须来自 packet; basis 枚举; 每地点 ≤12 条,
    每批 ≤60 条; 支持 conflict 上限。
  - 确定性 partition: explicit→supported、inferred/working→visual_fill、
    conflicting→conflicts。
  - 来源指纹复用: 与最近一次成功 run 的 `spatial_evidence.source_fingerprint` 相同且未
    degraded → 直接复用 facts(等价旧 `_spatial_fingerprint` 缓存)。
- 降级: RAG 失败只减少证据不失败; 空间事实单批失败记录 `all_batches_failed` /
  `degraded`; 无地点 → `insufficient_sources`。
- 测试: MockProvider 返回合法/非法 facts; 批边界; 指纹复用; RAG 缺索引降级。

验收: 行为契约测试覆盖 catalog §4.11 输入约束; 所有失败路径不写 canonical。

### Phase 3 — AtlasPlan 生成、校验与 run 落盘

工作:
- `plan.ts`:
  - 注册 `map_atlas_plan` spec(schema = AtlasPlan 精简 JSON schema)。
  - 移植 `_plan_prompt`: 最多 20 页、父先于子、默认不深于 street、interior 需授权、
    来源不得伪造、working 不能单独支撑 supported、annotations 不展示方向/距离/比例。
  - `validateAtlasPlan(plan, manifest, opts)` 纯函数: plan_key 唯一/模式、父级先序、
    层级严格递降、location 唯一、来源白名单、annotation target 存在、cover/world 无父。
  - update 约束: 只有 changed semantic key / missing location / new source 才允许生成
    新节点; 无变化 → review_ready 空 plan。
  - `planMapAtlas(root, provider, opts)` orchestrator:
    1. 读取/创建 run(status=planning);
    2. compile context → context_hash;
    3. spatial facts(带 checkpoint, 可续跑);
    4. 生成 AtlasPlan → validate;
    5. materialize candidate nodes + `prompt_only` 候选页到 pending(Prompt 参考, 不可 adopt);
    6. run status=review_ready, journal 记录每个 llm_step;
    7. git add/commit(候选与 run 均为工作产物)。
  - 失败 fail-closed: 不产出 adopted 资产; run status=failed + error_code。
- 测试: 层级非法/来源伪造/更新越权/无来源/空 plan; resume 从 checkpoint 续跑;
  同一 options + 已完成 run 不重复跑。

验收: `@novelcraft/world` 测试全绿; demo 可用 MockProvider 跑通 20 页以内规划。

### Phase 4 — 图片导入、占位与生命周期(核心写面)

工作:
- `image.ts`:
  - `importAtlasImage(root, filePath, target, opts)`:
    * 只接受宿主本机绝对路径; `stat/read` 在插件进程执行;
    * 校验 magic bytes / ≤50MB / 尺寸范围 / sha256(附录 A.3);
    * 复制到 `world/atlas/images/<page-slug>/<attempt>.<ext>`, 不 git add;
    * 若目标节点已有 `prompt_only` 候选页 → 把图片挂到该页并置 `review_ready`;
      否则新建 `upload` run + 候选页;
    * 上传到空页占位节点或已 adopted 节点均可(后者 = 画廊追加)。
- `review.ts`:
  - `adoptAtlasPage(root, pageRef, {confirmConflicts, expectedContentHash, note})`:
    * 前置: git 干净、page 候选存在、content_hash CAS;
    * **必须 `generation_status=review_ready` 且 `image.file` 存在**; `prompt_only` 拒绝;
    * conflicts 存在且未确认 → 拒绝;
    * 原子 adopt 祖先链: pending nodes → adopted nodes(循环/层级再校验);
    * page: pending/pages → pages, review_status=adopted, adopted_at;
    * 单次 git commit(不含图片目录)。
  - `adoptAtlasPlaceholder(root, nodeRef, opts)`: 只把候选节点 adopt 为空页占位，
    不要求图片、不创建 page; approval-gated; 单 commit。
  - `rejectAtlasPage` / `archiveAtlasPage` / `restoreAtlasPage`: 状态迁移 + git commit;
    restore 时重新 adopt 祖先链。
  - `updateAtlasPrompt(root, pageRef, prompt, expectedContentHash)`: 仅 `prompt_only`
    候选可改。
  - (可选)`updateAtlasNode`: 已采用节点调 parent/level/title/sort_order; 循环与层级校验。
- `annotations.ts`:
  - `addAtlasAnnotation / updateAtlasAnnotation / deleteAtlasAnnotation`:
    校验 label 非空、坐标 0–1、target_node_ref 仅可指向已 adopted 节点;
    更新后重算 page content_hash; 单 commit。
- 状态机:
  ```
  prompt_only(规划参考, 不可 adopt)
  prompt_only --import image--> review_ready
  review_ready --adopt--> adopted --archive--> deprecated --restore--> adopted
  review_ready --reject--> rejected(终态)
  candidate node --adopt placeholder--> adopted(空页占位)
  ```
- 测试: prompt_only 拒 adopt、缺图拒 adopt、冲突门禁、CAS 失配、多级祖先原子性、
  空占位 adopt、画廊追加、annotation CRUD、历史页不硬删、restore 祖先补齐。

验收: 写操作全部单 commit + 失败零残留; 图片目录始终不出现在 `git add` 列表。

### Phase 5 — DSH 工具与挂载(@novelcraft/dsh)

工作:
- `service.ts` 便捷方法:
  - `planMapAtlas(root, opts)` = `withResolvedDefaults` provider + world.planMapAtlas;
  - `viewMapAtlas(root, runId?)` 只读;
  - `importAtlasImage(root, filePath, target, opts)` 本地路径导入候选图;
  - `reviewMapAtlasGuarded(agent, root, target, action, opts, note)`:
    adopt/restore/adopt-placeholder 过 ApprovalGate; reject/archive 也经工具执行;
  - `applyAtlasAnnotations(root, pageRef, ops?)`: 应用 UI 队列或直接 ops; 标签编辑
    为作者内容编辑，不走 ApprovalGate; 页面 adopt/status 写照旧过 ApprovalGate。
- 新工具:
  1. `novelcraft_map_atlas_plan`
     - 参数: root / style_note / include_working_drafts / include_interiors / full_rebuild
     - timeout 3600s; 返回 run_id / status / planned_page_count / evidence_summary / message。
  2. `novelcraft_map_atlas_view`
     - 参数: root / run_id?
     - 返回 review 或 atlas tree: 图片页 / 空页占位 / prompt_only 候选 / image_missing。
  3. `novelcraft_map_atlas_upload`
     - 参数: root / file_path / node_ref 或 {title, level, parent_ref}
     - 本机路径导入; 候选写入不过 approval; adopt 另行审批。
  4. `novelcraft_map_atlas_review`
     - 参数: root / page_ref 或 node_ref / action(adopt|adopt_placeholder|reject|
       archive|restore) / confirm_conflicts / expected_content_hash / note
     - adopt/adopt_placeholder/restore 经 ApprovalGate(fail-closed)。
  5. `novelcraft_map_atlas_annotation`
     - 参数: root / page_ref / ops?(**省略时消费 `.assistant/atlas/annotation-queue/`**)
     - **主路径 = 无 ops**: 工具直接读取 UI 已落盘的队列文件，按队列逐条 apply;
       agent 只负责触发，不生成/翻译任何坐标。
     - `ops` 仅在调用方已经有精确结构化数据时使用; 工具**拒绝自然语言坐标描述**，
       不提供“往上一点/右移一点”的模糊换算。
     - 应用作者标签编辑: 校验 label/坐标/目标节点 + content_hash CAS, 单 commit, 清队列;
     - 标签是作者内容编辑，**不走 ApprovalGate**(adopt 类动作照旧 approval)。
  6. (可选)`novelcraft_map_atlas_update_prompt`
- 工具描述写入 `novelcraft-map` / `novelcraft-world` skill。
- 测试: FakeApproval 验证 allowed-once / rejected / unavailable; 上传路径导入不误 git add
  图片; annotation 校验失败零残留。

验收: dsh 测试全绿; 工具数 14 → 19/20(按可选 update_prompt 计)。

### Phase 6 — 客户端图片/标签面板 + 交付

工作:
- `client/src/wire.ts`: 增 `atlas/view` 读端点与 `atlas/annotation-request` 决策端点;
  `AtlasViewValue` = bound/run/reviewTree/atlasTree/image meta/labels/missing/queue 状态。
- `client/src/rpc.ts`: `atlasView` handler → `world.readAtlasTree/readAtlasRun`;
  小图(≤2–5MB)可选 base64 预览; 大图只回元数据与本地相对路径。
- `client/src/client/MapAtlasAction.tsx`: 会话头动作，Modal:
  - tab「本次规划」/「我的地图册」;
  - 左侧层级树: 图片页 + **空页占位节点**(点击进入「待上传图片」态);
  - 右侧页面卡: 图片预览、标题/level/visual_brief/prompt(一键复制)/evidence/
    sources/conflict 警告/缺图态;
  - **文字标签层**: 在图片上新增/改名/拖动/删除标签, 坐标归一化到 0–1,
    目标节点跳转仅允许指向已 adopted 节点。
- 标签编辑 = **L1 + 快捷编辑桥**(已确认):
  - UI 本地交互照常直接: 双击加标签、拖动改位置、行内改名、删除、undo 本地步骤;
    所有改动先更新本地画布状态，并标 dirty。
  - 用户点「保存标签」(或拖拽结束 debounce 后自动保存)时，client 调用
    `atlas/annotation-request` RPC; 该 RPC **不写 page 资产**，只把精确 ops 写入
    `.assistant/atlas/annotation-queue/<page-ref>.json` 并 push 一条信号。
  - 队列即坐标级描述，**机器生成、机器消费**，不经过自然语言翻译:

    ```json
    {
      "page_ref": "page-changan",
      "base_content_hash": "sha256...",
      "ops": [
        {"op": "update", "id": "ann-1", "position_x": 0.512, "position_y": 0.345},
        {"op": "add",    "id": "ann-9", "label": "洛阳", "position_x": 0.2, "position_y": 0.8},
        {"op": "delete", "id": "ann-2"}
      ]
    }
    ```

    坐标一律是相对图片宽高的归一化值 `0..1`，不用像素值，避免缩放/分辨率漂移。
  - 助手 agent 收到信号后调用 `novelcraft_map_atlas_annotation(root, page_ref)`，
    **只消费队列、不生成坐标**; 工具做 label/坐标/目标节点校验 + content_hash CAS，
    单 commit 应用并清队列。
  - **LLM 不确定性边界**: agent 的 LLM 只决定“现在调用这个工具”，不参与坐标生成、
    不把“往右上移一点”换算成数值; 因此不会引入操作上的不精确。残余不确定性只有
    “何时调用”，通过信号 `proposed_action` 直接写明工具名/page_ref 来收敛。
  - UI 在队列未消费前显示「待应用 N 个标签修改」; 应用失败时保留本地草稿和错误提示，
    用户可重试或让 agent 修。
  - 标签是作者内容编辑，可逆且字段受限，**不走 ApprovalGate**; 页面 adopt/status
    写仍按铁律走 ApprovalGate。
- `scripts/m7-map-atlas-demo.mjs`: MockProvider 建 vault → 规划 → adopt 空占位 →
  本机图片路径导入 → 小图预览 → approval adopt 图片页 → 标签 CRUD → tree。
- 文档收尾: 更新 `地图能力整理.md`、`STATUS-M4.md`、`跨会话交接.md` 能力清单/工具数/测试数。
- 全量验收: `npm test`、`npm run typecheck`、拓扑序 build。

验收: 空页占位可点击; 缺图态不渲染标签层; 标签拖动保存后坐标 0–1; 客户端零控制台错误;
demo 可复现。

---

## 5. 关键确定性规则(测试锚点)

1. 层级: cover/world 必须根; 父级 rank 严格大于子级; interior 仅在显式开启时允许。
2. 节点数: plan nodes ≤20; location_entity 唯一; plan_key 唯一且先父后子。
3. 来源: 每条 source 必须可解析到 source_manifest 的同一 source_id/hash/open_target;
   working 不能单独支撑 supported。
4. 空间事实: location_key 与 source_keys 必须是服务端 packet 中的逐字 key; 不得推理坐标。
5. 更新: update run 只允许规划已变化/缺失/新来源节点; 无变化直接 review_ready。
6. 采用: 候选页 adopt 前必须 git 干净 + content_hash CAS + 冲突确认 + **存在本地图片**;
   `prompt_only` 不可 adopt; 祖先链原子采用。
7. 历史: rejected/deprecated 只改状态，不物理删除; 图片不进入 git 历史。
8. 无生图: 全仓不出现 gpt-image-2 / Image API 调用; 图片只能由本机路径导入并写入
   gitignore 图片目录。
9. 标签: label 非空; 坐标 0–1; target_node_ref 必须指向已 adopted 节点; 标签写不改变
   image/status/title/prompt。
10. 空占位: adopted 节点可以没有 page; adopted page 不能没有 image。
11. 标签队列: UI 产生的 annotation ops 是坐标级机器描述; 应用工具只消费队列或精确 ops，
    拒绝自然语言坐标描述; 坐标恒为归一化 0–1。

---

## 6. 建议执行顺序与依赖

```
Phase 0(spec/裁定)
  → Phase 1(vault/world 文件地基)
    → Phase 2(context/spatial)
      → Phase 3(plan/run)
        → Phase 4(review/lifecycle)
          → Phase 5(dsh 工具)
            → Phase 6(client + demo + 全量验收)
```

每阶段独立 commit，不破坏现有 440 测试。核心包只做加法：新增文件/导出/可选路径字段，
不改 `storyMap`、`imports`、`store.adopt` 等既有接口。

---

## 7. 明确不做 / 后置

- 后置 1: AI 图片生成/编辑/重试(生图 API、蒙版编辑、reference image 生成)。
- 后置 2: map observations / 空间事实回写正式资产(仍只读规划)。
- 后置 3: ctx.jobs 队列化与进度轮询(先同步工具 + run checkpoint)。
- 后置 4: 世界书 publish-impact 与 map atlas 的联动(等 bible lifecycle 完整)。
- 后置 5: Story Map 视觉时间线(另一条线，不在本计划)。

---

## 附录 A: 允许上传地图图片的增量方案

> 前提不变: **仍不调用 gpt-image-2 / 任何生图 API**。只增加「作者上传图片 → 成为候选页 →
> review/adopt」这一条非生成路径。

### A.1 对原计划的影响总览

| 原计划条目 | 允许上传后的变化 |
|---|---|
| 范围 | 「无图片模块」变为「无生图模块; 允许图片摄入」 |
| 页面状态机 | 不再恒为 `prompt_only`; 增加 `uploaded → review_ready` 路径 |
| run 类型 | 恢复 `run_kind=upload`(每次上传一个独立 1 页 run) |
| 文件模型 | 新增本地图片目录(本地保留、gitignore)与 page 图片元数据 |
| 写通道 | 只接受宿主可读的本机绝对路径; 经工具解析/校验后复制进 vault; 不给 client 开字节上传 |
| 客户端 | 图片预览 + 可移动自定义文字标签编辑 + 空页占位; 上传入口是「填本机路径」 |
| 存储 | 图片目录加入 .gitignore, 仅本机保留; git 只提交 page/node/run 文本 |
| 工具面 | 新增 upload / review(含 adopt_placeholder) / annotation 工具 |
| 测试 | 增加图片魔数/尺寸/大小/去重/画廊/CAS 测试 |
| 规则 8 | 改为「不出现生图 API 调用; 本地图片只写 gitignore 图片目录」 |

### A.2 文件模型增量

```
world/atlas/
  images/<page-slug>/<attempt>.png|jpg   # 本地图片字节, gitignore, 不提交 GitHub
```

说明: 不设 `pending/images`。候选页与已采用页的图片都按 page-slug 归入同一本地目录,
页面是否 candidate/adopted 由 page frontmatter 的 `review_status` 决定; adopt 时无需移动
二进制文件。

- `initVault` 的 `.gitignore` 增加 `world/atlas/images/`(与 `.assistant/rag-index.json`
  同类处理): 图片只存在于本机 vault, git 不跟踪、不 commit、不 push。
- git 只提交 page/node/run 的文本文件; page 里的 `image.file` 是相对路径引用。
  换机器/缺图时 read 面返回 `image_missing=true`, 页面文本与证据仍可读。

- 页面 frontmatter 增加:

```yaml
generation_choice: upload          # prompt_only 候选页无 image 字段
image:
  file: images/<page-slug>/v1.png
  media_type: image/png            # image/png | image/jpeg
  sha256: <sha256>
  width: 1920
  height: 1080
  byte_size: 123456
```

- 页面状态机扩展:

```
(prompt_only) --upload--> uploaded --validate--> review_ready
(review_ready) --adopt--> adopted
(uploaded/review_ready) --reject--> rejected
adopted --archive--> deprecated --restore--> adopted
```

- `prompt_only` 是规划产物，**不可 adopt**，只作外部生图 Prompt 参考。
- `review_ready` 是有真实图片的候选页，可 adopt。
- adopted 节点可以暂时没有 page = 空页占位(可点击并进入待上传态)。
- 上传到已有 adopted 节点(含空页占位)时 = 给该节点补图或追加画廊页; 上传到新位置时
  创建 provisional 节点，adopt 时原子采用祖先链。

### A.3 上传校验(纯 TS，不引入 Pillow)

优先方案: v1 接受原样 PNG/JPEG，不转码、不生成缩略图:

1. 文件大小 ≤50MB(与旧引擎一致)。
2. magic bytes: PNG `\x89PNG\r\n\x1a\n`; JPEG `\xff\xd8\xff`。
3. 纯 TS 读头部:
   - PNG: IHDR 取 width/height/bit depth/color type;
   - JPEG: 扫描 SOF0/SOF2 取尺寸; 可选解析 EXIF orientation。
4. 尺寸上下限(如 16×16 ~ 8192×8192)防解压炸弹。
5. `sha256` 计算并写 page frontmatter; adopt 用其做 CAS。
6. `guardPath` + 文件名白名单，禁止路径穿越; 扩展名与 magic bytes 一致。

如后续要求「去 EXIF / 统一转不透明 PNG」，再引入 `sharp` 作为可选依赖或独立
`@novelcraft/map-image` 包; 首版不把它加进主依赖链。

### A.4 上传 = 本机路径导入(已按用户口径简化)

采用 **方案 U1(本地路径)**, 取消浏览器字节上传(U2)与 N19 字节上传例外讨论。

工具/服务入口: `novelcraft_map_atlas_upload(root, file_path, node_ref | {title, level, parent_ref})`

执行流程:
1. `file_path` 必须是宿主本机可读的绝对路径; 由 dsh 工具在插件进程内 `stat/read`，
   不经过 agent 沙箱文件工具(与 `ingest_text_file` 同口径)。
2. 纯 TS 校验 magic bytes / ≤50MB / 尺寸范围 / sha256(见 A.3)。
3. 复制(整理)到 `world/atlas/images/<page-slug>/<attempt>.<ext>`; 扩展名由 magic bytes
   决定, 不使用用户文件名作为路径段。
4. 若目标节点已有 `prompt_only` 候选页 → 图片挂到该页并置 `review_ready`(保留原
   prompt/evidence/source); 否则新建 `upload` run + 候选页。
5. 创建/更新候选 page 的 markdown 文本:
   - `generation_choice: upload`、`generation_status: review_ready`;
   - `image: {file, media_type, sha256, width, height, byte_size}`。
6. `git add` 只添加 run/page/node 的文本文件; **绝不 `git add` 图片目录**(已在 .gitignore)。
7. 候选写入不过 approval; 后续 adopt 仍必经 ApprovalGate。
8. 默认 `mode=copy`; 「只记录原路径不复制」(`mode=link`)不在本期范围，避免外部路径失效。

上传到空页占位节点 = 给该空页补图; 上传到已有图片节点 = 画廊追加;
上传到新位置 = 创建 provisional 节点，adopt 时原子采用祖先链。

### A.5 客户端展示与文字标签编辑

- 上传入口不在 client; UI 只显示「请让助手使用本机路径导入地图图片」的说明。
- `atlas/view` 返回 image 元数据(路径/尺寸/sha256/大小)。预览:
  1. 小图(≤2–5MB)由 host RPC 读取本地文件后返回 `{mimeType, base64}`;
  2. 大图只显示元数据 + 本地相对路径，不做 base64/流式传输。
- 地图页 = 图片 + 可移动文字标签:
  - 标签层在图片画布上渲染; 支持新增/改名/拖动/删除;
  - 坐标归一化 0–1, 随缩放同步;
  - 目标节点跳转仅允许指向已 adopted 节点。
- 标签写入通道 = **L1 + 快捷编辑桥**，见主计划 Phase 6。

### A.6 存储与回滚(本机优先，不上传 GitHub)

- 图片目录 `world/atlas/images/` 写入 vault `.gitignore`，本地文件系统保留;
  GitHub 仓库只接收文本资产与代码，**不接收图片二进制**。
- 因此无需 LFS、无需 200MB 软 quota; 本地磁盘不足由操作系统/用户自行管理，
  可只做一条 `byte_size` 超限拒绝(单图 ≤50MB)。
- 回滚口径:
  - 文本资产(page/node/annotation 字段/run)照常 git commit, 历史可回滚;
  - 图片不进入 git 历史; reject/deprecated 只改 page 状态文本，图片文件保留在本地
    `images/` 下作为本地历史;
  - 显式清理只允许删除 `rejected` 候选图，禁止改写 git 历史、禁止 force push。
- 换机/克隆后缺图是预期状态: read 面标记 `image_missing=true`，不影响规划与文本地图页。

### A.7 对 Phase 的增量改动

| Phase | 增量 |
|---|---|
| Phase 0 | ADR-0020 增加本地图片目录/gitignore/路径导入条款; 增加 N24 裁定(本地路径导入写边界) |
| Phase 1 | vault paths 增加 `world/atlas/images`; 图片读写 guard + gitignore |
| Phase 2 | 无变化(规划与空间事实不接触图片) |
| Phase 3 | 规划产出 `prompt_only` 候选页(不可 adopt) + 候选空节点占位 |
| Phase 4 | 新增 `importAtlasImage` / `adoptAtlasPlaceholder` / annotation CRUD; 只允许图片页 adopt |
| Phase 5 | 新增 upload / review(adopt_placeholder) / annotation 工具; adopt 与占位 adopt 照旧 approval |
| Phase 6 | `MapAtlasAction` 显示图片 + 可拖动标签 + 空页占位; `atlas/view` 返回 image meta(可选小图 base64) |
| 验收 | 新增路径导入/空占位/标签 CRUD 单测与集成 demo; 规则 8/9/10 落地 |

### A.8 裁定状态

**用户已确认**:
- `prompt_only` 页面不能 adopt; 地图册页必须 = 图片 + 可移动自定义文字标签。
- 允许 adopted 空节点占位，先点进空页再上传图片。
- 图片默认 `mode=copy` 整理进本地 `world/atlas/images/`; 克隆后缺图显示缺图态。
- 标签编辑 = **L1 + 快捷编辑桥**: UI 直接拖动编辑，但 client 只写 annotation intent
  队列，实际应用由 `novelcraft_map_atlas_annotation` 工具执行。

**仍待确认(与主计划 1.3 相同)**:
1. 规划 run 同步执行、adopt 审批边界、`map_atlas_plan` 4000 tokens 预算是否按主计划默认执行?

---

## 附录 B: L2 未采用说明(优缺点存档)

L2 = 给 client RPC 开一个仅限 `annotations` 字段的受控写例外，让 UI 直接写 page 资产。

**优点**:
1. 交互最顺: 拖动/改名/增删即时持久化，无 agent 排队与信号等待，无“待应用”中间态。
2. 链路最短: client → host 校验 → page 文件，一次往返; 不需要队列、不需要助手在场。
3. 对低风险、高频、可逆的标签微调最匹配; git 仍提供历史回滚。

**缺点**:
1. 破坏 N19 干净边界，开第二个 client 写资产例外; 未来容易继续用“只改一个小字段”为由
   扩大例外面。
2. client 侧变成写通道，攻击面/误操作面增大; host 必须做更严格 guard、字段白名单、
   CAS、防 stale write 与防越界。
3. 拖拽高频写入需要 debounce/合并/冲突 UI; 与 agent 工具并发改同一页时需要额外锁序。
4. 审计弱于工具路线: 修改不经过 agent journal/tool trace，只能靠 git diff 追。
5. 测试成本高: 需要覆盖恶意 payload、跨 page、超大坐标/标签、并发 CAS 等。

**结论**: 为守住「client RPC 只读信号 + 记录决定 + 不写资产」的铁律，选 L1;
用「乐观 UI + intent 队列 + agent 工具应用」补足交互体验。