# ADR-0020 — 世界地图册(map atlas)M4 文件模型(无生图模块)

- **状态**: Accepted(2026-08-15, 用户确认裁定 N28/N29)
- **日期**: 2026-08-15
- **取代/补充**: 新增(map atlas 首个专属 ADR); 对齐 ADR-0016 §2「文件夹真相」、ADR-0019
  关系模型、`specs/assets/world.md`(世界对象 location slug)。**不取代**任何现有 ADR。
- **设计依据**: `docs/agent/dsh-rebuild/map-atlas-实施计划.md`(本 ADR 的权威来源, 简称「计划」)、
  `specs/adjudications.md`(N28/N29)、`specs/assets/world.md`、`specs/prompts/catalog.md`
  §4.11/§4.12、`specs/rules/policy-defaults.md`。

## 背景(Context)

旧引擎的世界地图册是四张 PG 表(`map_atlas_runs/nodes/pages/annotations`)+ 私有 S3 图片存储
+ 固定 Image API(`gpt-image-2`)生图, 共 22 个 `/api/world/map-atlas` 端点。M4 下这三点都与
架构铁律冲突:

1. **数据库/对象存储**违反铁律 2(文件唯一真相 + git 回滚, 不另建数据库/队列)。
2. **站内生图**需要图片字节读写与 provider 计费语义, 与「本机运行、不上线部署、图片不 push
   GitHub」的用户口径不符, 且生图能力本就不是本轮目标。
3. **adopt/状态写**需要收敛到铁律 3(adopt 必过 approval, fail-closed)。

因此本 ADR 把 map atlas 落地为 `@novelcraft/world` 的 map 子系统 + 文件真相 + 本机路径图片
导入, **明确不实现图片生成**。能力盘点见 `docs/agent/dsh-rebuild/地图能力整理.md`(该文 §4.1
仍记录旧引擎生图 spec, 属 Phase 6 收尾前的能力背景, 非本次落地口径)。

## 决策(Decision)

### 1. 文件布局(文件真相, 无数据库)

```
<vault>/
  world/atlas/
    nodes/<slug>.md              # 已采用/暂存节点(provisional | adopted)
    pages/<slug>.md              # 已采用图片页(图片 + 标签)
    pending/nodes/<slug>.md      # 本轮候选节点
    pending/pages/<slug>.md      # 本轮候选页面
    images/<page-slug>/<attempt>.png|jpg   # 本地图片字节, gitignore, 不提交 GitHub
  .assistant/atlas/
    runs/<run-id>.json           # run 状态/plan/snapshot/journal(工作产物, git 提交)
    annotation-queue/<page-ref>.json  # UI 标签编辑 intent(L1, 只记录不落资产)
    decisions/<page-ref>.json    # 客户端记录的 review 意图(可选, 只记录不落资产)
```

- `world/atlas/**` 是**创作资产**(adopted 面 + pending 面); `.assistant/atlas/**` 是**工作产物**
  (run/journal/队列/决定记录), 两者都走 git 提交(图片目录除外, 见 §8/§9)。
- 候选页先写 `world/atlas/pending/pages/`, adopt 时原子迁移到 `world/atlas/pages/`, 与
  `world/pending → world/objects` 同构(计划 §2.2)。
- 节点按需 materialize 到 `pending/nodes/`; 首张图片页 adopt 时把祖先链一次性
  provisional→adopted 并迁入 `nodes/`(计划 §2.2)。字段表与状态机见
  `specs/assets/map-atlas.md`。

### 2. 无生图边界

- 全仓不出现 `gpt-image-2` / Image API 调用; 不生成图片字节(计划 §1.2、§5 规则 8)。
- 不做 S3/MinIO 等在线对象存储、图片 URL、缩略图服务、删除补偿。
- 不做 `generation_choice=internal`、`prompt_review → generating` 状态机、`provider_in_flight /
  uploaded / retry_requires_confirmation / 重复扣费确认`。
- 不做页面 regenerate / edit(蒙版)/ retry / 图片 reference image 读取。
- 不做 `layout` / `quality` / `review_image_prompts` 三个纯图片参数(API 不接收)。
- 不做旧六边形动态地图(已废弃)。
- 每页产出的 `visual_brief` + `prompt` **仅为外部生图参考文本产物**, 不进任何生图调用。

### 3. prompt_only 不可 adopt

- `prompt_only` 是规划产物: 只有 `visual_brief`/`prompt`/evidence/source_manifest/初始标签
  建议, 无 `image` 字段。它**只能作为外部生图参考, 不能 adopt**(计划 §1.3/§2.2/附录 A.8)。
- adopt 前置: `generation_status=review_ready` **且** `image.file` 存在并通过校验(计划 §2.2)。
  缺图 / prompt_only → 拒绝 adopt(fail-closed)。
- 地图册页面(「我的地图册」)必须由「本地图片 + 可移动自定义文字标签」组成; 没有图片的页面
  不得进入地图册(计划 §1.1)。

### 4. 空页占位节点

- `status=adopted` 且没有任何 adopted page 的节点 = **空页占位**(计划 §2.1)。
- 允许只设定层级/地点的 adopted 空节点占位先进入地图册; 作者点进空页后再上传对应图片
  (计划 §1.1/§1.3)。atlas 树同时显示图片页与空页占位。
- 该状态由读面派生(adopted node 且无 adopted page), **不新增单独字段**(计划 §2.1)。
- 空占位 adopt 走 `adoptAtlasPlaceholder()`, 与图片页 adopt 一样必经 ApprovalGate(§7)。

### 5. annotation 编辑 = L1 intent 队列 + agent 工具应用

- **文字标签通道 = L1(已确认)**: UI 提供直观快捷编辑(拖动/改名/增删, 本地即时反馈), 但
  client 不直接写资产; 保存时只写 annotation intent 队列, 由助手 agent 调
  `novelcraft_map_atlas_annotation` 工具应用(计划 §1.3/§6)。
- 队列是**坐标级机器描述, 机器生成、机器消费**, 不经过自然语言翻译; 坐标恒为归一化 `0..1`
  (计划 §6)。工具主路径 = 无 `ops` 参数, 直接读取 `.assistant/atlas/annotation-queue/` 按队列
  逐条 apply; agent 只负责触发, 不生成/翻译任何坐标。
- `ops` 参数仅在调用方已有精确结构化数据时使用; 工具**拒绝自然语言坐标描述**(「往上一点」等
  模糊换算), 不提供像素值坐标。
- 标签是作者内容编辑, **不走 ApprovalGate**; 页面 adopt/status 写照旧过 ApprovalGate(计划 §5)。
- **L2 未采用**(给 client RPC 开仅限 annotations 字段的受控写例外), 利弊存档见计划附录 B;
  结论摘要见本 ADR 附录 B。

### 6. semantic_key 口径

- 地点节点(entity): `entity:{location_slug}`, `location_slug` 是 `world/objects` 中 location
  对象的裸 slug(计划 §3「semantic_key」行、§2.1 示例 `entity:长安`)。
- 结构层级节点(cover/world/region/city/district/street/interior): `path:{parent_semantic}:{hash}`
  (父节点 semantic_key + 稳定 hash, 保证无地点语义下的唯一性; 计划 §3、§2.1 示例
  `path:<parent>:<hash>`)。
- `location_ref` 存裸 slug(与 semantic_key 的 `entity:` 段一致); 非地点节点 `location_ref=null`。

### 7. review 动作边界

| 动作 | 通道 | 是否过 ApprovalGate |
|---|---|---|
| adopt(图片页) | `novelcraft_map_atlas_review`(core `adoptAtlasPage`) | **是**(fail-closed) |
| adopt_placeholder(空节点占位) | 同上(core `adoptAtlasPlaceholder`) | **是**(fail-closed) |
| restore(deprecated → adopted) | 同上(core `restoreAtlasPage`) | **是**(fail-closed) |
| reject(candidate → rejected 终态) | 同上(core `rejectAtlasPage`) | 经工具执行(不过 approval) |
| archive(adopted → deprecated) | 同上(core `archiveAtlasPage`) | 经工具执行(不过 approval) |
| annotation(标签 CRUD) | `novelcraft_map_atlas_annotation` | **否**(作者内容编辑) |

- 客户端对图片/状态只读; review 意图由客户端记录到 `.assistant/atlas/decisions/`(只记录不落
  资产), 实际状态写由 agent 经工具执行(计划 §1.3/§5)。
- adopt/adopt_placeholder/restore 过 ApprovalGate 沿用铁律 3 的 `allowed-once` 语义
  (rejected/cancelled/unavailable 一律拒绝); reject/archive 建议也走同一工具, 保持状态迁移
  单 commit + 可回滚(计划 §1.3 待确认项 2 的默认口径)。

### 8. 本地图片路径导入(N29)

- 「上传」= 解析本机文件路径 → 校验 → 复制(整理)到 vault 本地图片目录; 不做浏览器字节上传,
  也不把图片二进制纳入 git 提交(计划 §1.2 注)。
- 只接受宿主本机可读的**绝对路径**, 由 dsh 工具在插件进程内 `stat/read`(同 `ingest_text_file`
  口径), 不经过 agent 沙箱文件工具(计划 附录 A.4)。
- 默认 `mode=copy`; 「只记录原路径不复制」(`mode=link`)不在本期范围(避免外部路径失效)。
- 校验(纯 TS, 不引入 Pillow): magic bytes(PNG/JPEG)、≤50MB、尺寸 16×16~8192×8192、sha256、
  guardPath + 文件名白名单, 扩展名与 magic bytes 一致(计划 附录 A.3)。
- 落地路径 `world/atlas/images/<page-slug>/<attempt>.<ext>`; 扩展名由 magic bytes 决定, 不使用
  用户文件名作为路径段(计划 附录 A.4)。候选写入不过 approval; 后续 adopt 仍必经 ApprovalGate。

### 9. 图片 gitignore, 不 push GitHub

- `initVault` 把 `world/atlas/images/` 写入 vault `.gitignore`(与 `.assistant/rag-index.json`
  同类处理); 图片只存在于本机 vault, git 不跟踪、不 commit、不 push(计划 附录 A.2/A.6)。
- git 只提交 page/node/run 的文本文件; page 里的 `image.file` 是相对路径引用。
- 换机/克隆后缺图是预期状态: 读面标记 `image_missing=true`, 页面文本与证据仍可读, 不影响规划
  与文本地图页(计划 附录 A.6)。
- 因此无需 LFS、无需 200MB 软 quota; 仅 `byte_size` 超限拒绝(单图 ≤50MB)。图片不进入 git 历史,
  reject/deprecated 只改 page 状态文本, 图片文件保留在本地 `images/` 下作为本地历史(计划 附录 A.6)。

## 未采用方案

- **L2(标签 client 直写例外)**: 见附录 B 摘要与计划附录 B。为守住「client RPC 只读信号 + 记录
  决定 + 不写资产」的铁律, 选 L1。
- **浏览器字节上传(U2)**: 取消; 只保留本机路径导入(U1)(计划 附录 A.4)。
- **`mode=link`(只记录原路径)**: 不在本期, 避免外部路径失效(计划 附录 A.4)。

## 影响(Consequences)

- 新增: `specs/assets/map-atlas.md`(node/page/run 字段表 + 状态机 + 完整性规则);
  `specs/prompts/catalog.md` §4.11 重写(去生图)+ §4.12 `map_spatial_facts`(新);
  `specs/rules/policy-defaults.md` map_atlas 段; `specs/adjudications.md` N28/N29。
- 实现(后续 Phase, 不在本 Phase 0): `@novelcraft/vault` 的 `VaultPaths.atlas` 子路径 +
  `.gitignore`; `@novelcraft/world` 的 `map-atlas/`(types/read/write/context/spatial/plan/
  image/review/annotations)+ `map_atlas_plan`/`map_spatial_facts` spec 注册; `@novelcraft/dsh`
  的 5–6 个工具(plan/view/upload/review/annotation[/update_prompt])。
- 契约: 本 ADR 只做加法(新目录/新文件/新导出/可选路径字段), 不改 `storyMap`、`imports`、
  `store.adopt` 等既有接口(计划 §6)。
- 文档: 本 ADR 转 Accepted 后需同步 `docs/adr/README.md` 索引(本 Phase 0 不处理, 留主会话 review
  一并提交)。`地图能力整理.md` §4.1 的旧生图 spec 描述待 Phase 6 收尾更新。

## 待确认事项

1. ~~本 ADR 状态~~ **已转 Accepted**(2026-08-15 用户确认 N28/N29)。
2. **规划 run 同步执行**(计划 §1.3 待确认项 1): 默认用 `novelcraft_map_atlas_plan` 工具同步执行
   (同 deep_import 模式, timeout 3600s), 不做 ctx.jobs 队列; run JSON 提供 checkpoint/续跑。
3. **`map_atlas_plan` 预算 4000**(计划 §1.3 待确认项 3): 默认按 catalog 4000 tokens; 旧引擎实际
   使用 12000; 若 20 页 schema 修复频繁失败, 下一轮裁定提升为 12000。已落 `policy-defaults`
   map_atlas 段。
4. **`update_prompt` 工具**(计划 §5): 可选工具, 工具数 14 → 19/20 按是否落地计。

## 附录 A: 与计划文的出入说明

> 本 ADR 与计划文如有出入, **以计划文为准**, 此处只记录已识别的出入并给出采用口径。

1. **`uploaded` 中间态**: 计划 附录 A.2 页面状态机写 `prompt_only --upload--> uploaded
   --validate--> review_ready`, 而主计划 §2.2(`generation_status` 仅 `prompt_only|review_ready`)
   与 Phase 4 状态机(`prompt_only --import image--> review_ready`)都不含 `uploaded` 中间态。
   **采用口径**: 以主计划 §2.2/Phase 4 为准, 不落地 `uploaded` 中间态; 上传即把图片挂到页并置
   `review_ready`。`specs/assets/map-atlas.md` 已按此统一。
2. **catalog §4.11/§4.12 归属**: 计划 Phase 0 写「§4.11 补 map_spatial_facts」, 但 §4.11 当前是
   `map_atlas_plan`。**采用口径**: §4.11 保留为 `map_atlas_plan`(重写去生图), §4.12 新增
   `map_spatial_facts`(以本任务指令为准)。

## 附录 B: L2 未采用说明摘要(计划附录 B)

L2 = 给 client RPC 开一个仅限 `annotations` 字段的受控写例外, 让 UI 直接写 page 资产。

- 优点: 交互最顺(即时持久化)、链路最短(client→host→page 一次往返)、最匹配低风险高频可逆的
  标签微调。
- 缺点: 破坏 N19 干净边界(开第二个 client 写资产例外)、client 变写通道(攻击面/误操作面增大)、
  拖拽高频写需 debounce/合并/锁序、审计弱(不经过 agent journal/tool trace)、测试成本高。
- **结论**: 为守住「client RPC 只读信号 + 记录决定 + 不写资产」的铁律, 选 L1; 用「乐观 UI +
  intent 队列 + agent 工具应用」补足交互体验。
