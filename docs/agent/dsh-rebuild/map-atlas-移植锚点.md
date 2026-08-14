# map-atlas 旧引擎移植锚点(主会话 review 用)

> 来源: `old-engine` tag 的 `backend/modules/world/map_atlas_{workflow,schemas,service,storage}.py`。
> 本文是主会话 review 各 Phase 的对照清单; 实现细节以计划文 `map-atlas-实施计划.md` 为权威。
> 查看方式: `git show old-engine:<path> | sed -n '<行区间>p'`。

## Phase 2 — 上下文编译 + 空间事实(workflow.py)

| 锚点 | 位置 | 确定性规则 |
|---|---|---|
| `_spatial_query` | 63-66 | name+aliases+固定空间词; 模型不得发明实体身份 |
| `_compile_context` | 350-377 | canonical 资料 + 可选工作稿编译 |
| `_spatial_evidence` | 407-820 | 地点选 canonical `entity_type=location`; 排序 = 已有 atlas 节点优先 > 世界书链接优先 > importance 降序 > name > id; ≤20 地点; 每地点 wiki ≤3 页; 每地点 wiki+RAG ≤8000 字(两族各先保 1 条, 首条 4000); 每批 ≤40000 |
| 批大小 | schemas.py 95-108 | 每批 ≤5 地点、每地点 ≤12 条、每批 ≤60 条; source_keys 1–5 条且逐字来自 packet; statement ≤1000 |
| 指纹复用 | 686-730, `_spatial_fingerprint` 869-886 | fingerprint = sha256(schema_version=1 + 地点 id/name/aliases/sources 排序); 复用条件: 同 fingerprint + 非 degraded + 非 all_batches_failed + 所有 fact source_keys ⊆ 当前 manifest keys |
| 分桶 `_spatial_fact_buckets` | 822-868 | basis=conflicting→conflicts(≤20 条); inferred 或来源含 working→visual_fill; 否则 explicit→supported(各 ≤50 条); location_key 不在 packet → 丢弃计 invalid |
| `_changed_spatial_location_keys` | 887-910 | update 模式: 按 location_id 比 source_hash 列表 → `entity:{location_id}` 变化集 |
| `_spatial_planning_context` | 911-933 | 规划注入: 12 条/地点、40000 字总量、按 key 排序确定性拼接 |

## Phase 3 — AtlasPlan 生成/校验

| 锚点 | 位置 | 规则 |
|---|---|---|
| `_plan_prompt` | 68-110 | 全文中文化移植; 规则 8 条(≤20 页/父先子/默认最深 street/室内需授权/working 不独撑 supported/annotations 无方向距离比例/来源不伪造 open_target/地点全名入 visual_brief); update 模式换行话术 |
| 层级 rank | schemas.py 12-20 | cover=0 world=1 region=2 city=3 district=4 street=5 interior=6 |
| AtlasPlan 校验器 | schemas.py 182-230 | ①location 唯一 ②plan_key 唯一 ③supported 必须有 retained source ④parent_plan_key 与 existing_parent_node_id 互斥 ⑤cover/world 必根 ⑥父必须先出现(seen 集) ⑦父 rank 严格 < 子 ⑧annotation target_plan_key 必须在 plan 内 |
| `_validate_plan_sources` | 934-981 | 每条 source 必须命中 manifest(source_type+source_id); open_target 必须与 canonical 逐字段一致(除 novel_id); working 不能单独支撑 supported; 校验后回填 canonical title/summary/hash/status |
| `_plan_semantic_keys` | 982-1007 | `entity:{location_id}` 或 `path:{parent_semantic}:{slug(title)}`; M4 改为 location_slug |
| `_validate_update_targets` | 1008-1046 | update run: 新 location 必须在 missing 集; 新 path 节点必须有新 formal source; 已存在 semantic_key 必须在 changed 集否则拒 |
| `_changed_update_targets` / `_new_source_identities` | 1047-1106 | changed = 来源 hash 变化的 semantic_key(含同 source 牵连节点); new = 当前 manifest 中新增/hash 变/status 变的 formal source |
| 预算 | catalog §4.11 | temp 0 / max_tokens 4000(旧 12000 暂不提); run 同步执行 timeout 3600s(deep_import 同构) |

## Phase 4 — 图片导入/生命周期(service.py)

| 锚点 | 位置 | 规则 |
|---|---|---|
| `review_page` | 417-469 | CAS(expected_updated_at → M4 content_hash); adopt/reject 要求 candidate+review_ready; prompt_only 拒; adopt 查 conflicts 未确认拒; archive 要求 adopted; restore 要求 deprecated 且重新 adopt 祖先; review_note 记录 |
| `_adopt_ancestors` | 1049-1070 | 沿 parent 链全置 adopted; 循环检测; 节点缺失 = 层级已变化拒 |
| `_adopt_proposed_path` | 1071-1140+ | 候选提案一致性校验; cover/world 有父拒; 循环拒 |
| `update_annotation` | 471-511 | target 必须指向有 adopted page 的节点(M4: 已 adopted 节点) |
| 上传(附录 A.3) | — | ≤50MB; PNG `\x89PNG\r\n\x1a\n` / JPEG `\xff\xd8\xff`; 尺寸 16×16–8192×8192; sha256; 扩展名由 magic bytes 决定; mode=copy; 绝不 git add 图片 |

## 状态机(M4 收敛)

```
run:     planning → review_ready | failed                    (删 prompt_review/generating/partial/paused/completed)
page:    prompt_only --upload--> review_ready --adopt--> adopted --archive--> deprecated --restore--> adopted
         review_ready --reject--> rejected(终态)
node:    provisional --adopt(随首页祖先链 或 adoptPlaceholder)--> adopted
```

## review 检查点(每阶段通用)

1. 无生图: 全仓 grep 不得出现 `gpt-image` / Image API 调用(N28)
2. 图片目录绝不进 git add(N29); gitignore 幂等
3. 核心包零 `@deepseek-ai/*` import; 只做加法
4. 写操作单 commit + 失败零残留; adopt 类过 ApprovalGate(fail-closed)
5. 测试断言注释引规则号(R#/N#); MockProvider/MockApproval 注入
