# 工具清单(novelcraft-dsh)

> 由 `packages/novelcraft/dsh/src/` 工具声明源码提取( scripts/gen-tools-doc.py ), 对应 novelcraft-dsh **0.1.3**。
> 描述为运行时声明的节选; 各工具的读写能力(只读/需审批)经 DSH capability 注册, 审批语义见仓库 README「核心原则」。

共 **39** 个工具。

## 书库(3)

- **`novelcraft_book_create`** — 创建新书(审批后执行): 在 vaultsDir 下按书名初始化 vault(book.yml + 目录骨架 + git)。
- **`novelcraft_book_list`** — 枚举书库(vaultsDir)下的全部书: 书目录名/标题/根路径/当前会话是否绑定。
- **`novelcraft_book_open`** — 切换当前会话到既有书(审批后执行): 把本会话的工作区绑定切到目标书(后续工具的

## 深度导入 / 工作流(4)

- **`novelcraft_workflow_abandon`** — 放弃一个已终止(completed/failed/provider_outcome_unknown/损坏)的 durable run(审批后执行):
- **`novelcraft_workflow_inspect`** — 枚举本书的全部 durable manifest 工作流 run(深度导入 + 地图册目录形态)与恢复选项: 每个返回 kind/
- **`novelcraft_workflow_resume`** — 恢复中断的深度导入 run: 同步完成前置校验(枚举存在/非 start_new 强制 run/checkpoint 绑定
- **`novelcraft_workflow_start_new`** — 显式新开深度导入 run(force): 不复用同范围的旧 run, 请求全范围/成本授权。

## 写作(4)

- **`novelcraft_chapter_review`** — 单章审查闭环。review 可审 current 或 candidate；revise 只接受 fresh current review 的 finding_ids 并产新候选；
- **`novelcraft_chapter_version`** — 单章正文版本工作流。inspect/history/diff 为只读；save 消费章节页内编辑收据；
- **`novelcraft_generate_next_chapter`** — 续写提案第二阶段: 按选定方向生成下一章正文候选(writing_generate, 续写模式)。
- **`novelcraft_propose_next_chapter`** — 计划台续写提案: 基于总纲/剧情线/上一章结尾, 生成下一章 2–3 条续写方向(各带依据/成本/风险)。

## 大纲与生成(4)

- **`novelcraft_outline_apply`** — 采用总纲 preview(审批后执行): 把 .assistant/proposals/ 中该 run_id 的生成结果写入
- **`novelcraft_outline_item_apply`** — 采用 P20 当前层 preview(审批后执行): 把该 run_id 的生成结果写入 structure/(thread/arc
- **`novelcraft_outline_item_preview`** — 生成 P20 当前层(剧情线 plot_thread / 篇章纲 outline_arc)preview: 结果暂存
- **`novelcraft_outline_preview`** — 生成小说总纲 preview: 跑内容手(story_outline spec)并把结果暂存到 .assistant/proposals/

## 世界(7)

- **`novelcraft_world_bible_suggest`** — 世界生成中心·世界书页面建议: 生成页面提案并落 bible/ 为 draft 工作稿
- **`novelcraft_world_chat`** — 世界生成中心·共创聊天: 与内容手就世界设定自由共创对话, 纯 LLM 调用零写。
- **`novelcraft_world_converge`** — 世界生成中心·只读收束: 对给定设定材料做收敛分析(矛盾/缺口/可合并项), 零写。
- **`novelcraft_world_create`** — 创建世界对象(审批后执行): 写入 world/objects/。
- **`novelcraft_world_explore`** — 世界生成中心·一跳探索: 从既有设定出发探索相邻可能性(≤3 个方向), 不创建资产。
- **`novelcraft_world_inspect`** — 世界生成中心·页面检修: 对给定世界书页面/设定做语义检视, 返回 findings 供作者复核, 零写。
- **`novelcraft_world_update`** — 修改世界对象(审批后执行): 按对象 slug 定位 world/objects/ 内对象, 更新

## 地图册(6)

- **`novelcraft_map_atlas_annotation`** — 应用地图页文字标注: 只消费 .assistant/atlas/annotation-queue/ 队列文件(UI 已落盘的精确
- **`novelcraft_map_atlas_plan`** — 地图册规划: 编译 canonical 证据 → 空间事实 → LLM 产出 ≤20 页 AtlasPlan 并校验
- **`novelcraft_map_atlas_review`** — 地图页/节点生命周期: adopt(采用候选页, 需 review_ready+有图) / adopt_placeholder(采用空页占位节点) /
- **`novelcraft_map_atlas_update_prompt`** — 更新 prompt_only 候选页的外部生图参考文本(仅 prompt_only 候选可改; expected_content_hash 做 CAS)。
- **`novelcraft_map_atlas_upload`** — 消费用户在当前地图册选择图片后获得的会话收据(PNG/JPEG ≤50MB, 16~8192px):
- **`novelcraft_map_atlas_view`** — 地图册只读视图: 已采用树(图片页/空页占位/image_missing 派生位) + 候选(pending nodes/pages) + 指定或最近 run 摘要。

## 存储 / 检索 / 系统面(11)

- **`novelcraft_deep_import`** — 深度导入: 同步完成范围/参数校验后启动后台 job 并立即返回句柄(不再阻塞会话)。
- **`novelcraft_health_scan`** — 结构健康信号扫描: 确定性扫描 Scene 四键 + 结构资产两键, 把命中写成收件箱信号
- **`novelcraft_inbox_act`** — 收件箱四动词: accept 采纳(返回 adopt 指引)/ reject 打回并关闭/ modify 改一改(路由微工作流)/ defer 保留。
- **`novelcraft_inbox_view`** — 读收件箱: 全部新鲜信号(风险前置排序)。卡片含 id/radar/severity/title/proposed_action/status。
- **`novelcraft_ingest_file`** — 文本入库: 消费用户在当前写作台选择文件后获得的会话收据(.txt/.md, ≤50MB)
- **`novelcraft_llm_step`** — 内容手一步调用: 按 specRef 运行一次受控 LLM 步骤(schema 校验/预算/超时/journal)。
- **`novelcraft_radar_sweep`** — 雷达巡检: 五面确定性扫描器对账收件箱信号(摄入/去重/建议/风险/写作; 幂等落盘 +
- **`novelcraft_rag_embed`** — 批量嵌入: 对索引中待向量化片段(pending/failed 且无 vector)调用本地 BGE 嵌入后端生成向量
- **`novelcraft_rag_search`** — 语义检索: 在已索引片段(章节正文/角色/世界对象)中按查询找相关片段。BM25 召回 + 内容手精排
- **`novelcraft_store_adopt`** — 采用一个待处理/候选资产(copy-on-adopt 或状态迁移 + git commit)。
- **`novelcraft_store_index`** — 重建全书派生索引(对象/别名/关系/Scene/章节/结构), 并写入可选缓存。文件是唯一真相, 可随时重建。

