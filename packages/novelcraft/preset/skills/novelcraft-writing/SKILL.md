---
name: novelcraft-writing
description: "NovelCraft 写作(M4 停靠舱 + 修订中心): 会话授权文本导入、语义审查、定向返修、候选采用与写作台。写作类任务先读本 skill。"
whenToUse: 作者同步章节、要审查/修订、采用候选、或问写作台怎么用时。
---

# NovelCraft 写作(M4)

## 文本流(编辑外置, D8)

- 单章持续编辑、版本对比和候选审查使用当前会话的「章节正文」标签页；整稿外置同步仍在
  「写作台 → 导入」选择 UTF-8 `.txt/.md`,
  由页内面板生成会话绑定收据。工具不读取模型提供的主机路径。
- 标签页保存只暂存 session-bound receipt；随后必须调用
  `novelcraft_chapter_version(action=save, receipt_id=...)` 并通过 approval。成功后恰好一个
  Git 版本；history/diff/restore 也走同一工具，restore 生成新 commit，不改写 Git 历史。

## 文本入库协议(Track 1, D9a)

- 若对话中还没有文件收据, 请作者先在「写作台 → 导入」选文件; 不要询问或推测本机路径。
- 收件箱出现「手稿已授权」信号后, 从 proposed_action 取得 receipt_id 并调
  `novelcraft_ingest_file {root, receipt_id, start_chapter?, force?}`。
- 入库是确定性的: imports/<slug>.md 原文停靠 + chapters/NNN.md(默认接现有最大章之后;
  同号章内容冲突默认跳过, 作者确认后 force 覆盖)+ imports/import-log.jsonl
  (同文件重复导入自动跳过)。
- 当前工具不提供 read/write/Shell, 也没有主机路径或粘贴临时文件旁路。
- v1 收据链支持 `.txt/.md`; 乱码(非 UTF-8)会被拒绝并提示转码;
  >50MB 请拆分。
- 入库后用作者语言报告(章数/跳过/冲突), 并建议下一步跑深度导入(novelcraft_deep_import);
  摄入雷达会自动把「章待增量导入」对账进收件箱。

## 当前可执行面

- `available-now`: `novelcraft_ingest_file`, `novelcraft_propose_next_chapter`,
  `novelcraft_generate_next_chapter`, `novelcraft_chapter_version`,
  `novelcraft_chapter_review`。
- 审查闭环必须按顺序执行：`review target=current` → 选择稳定 `finding_id` → `revise` 产
  candidate → `review target=candidate` → 只有 fresh 机械 `pass` 才 `adopt`。candidate adopt
  即使从通用 `novelcraft_store_adopt` 进入，也会复用同一 writing 领域门并通过 approval。
- `reject_finding` 必须带作者理由；模型自由文本 verdict 不直接充当采用许可。未知 severity、
  找不到原文 quote、正文/候选漂移、缺独立审查或 approval 非 allowed-once 均 fail-closed。

## 写作台(§17.4, 半屏 D10)

- 写作前·计划台: 下一步提案 2–3 条; 写作中·参照台: 本 Scene 人物/设定/必发生项简报;
- 写作后·评审台: 审查/冲突/修订卡; 守望: 六雷达 + 收件箱 + 宠物。
- 导入: 仅承载浏览器选文件与会话收据; 章节切分、冲突裁决和后续深导入继续在对话中完成。
- 「章节正文」是唯一持续工作区：正文/标题编辑、Git history/diff/restore、current finding
  选择、candidate 正文与独立审查/采用都在此标签；实际模型调用和采用继续回到当前对话执行。

## 纪律

- 候选正文只读；当前没有候选 discard/reject 终点或 Word 同步回执，不要声称已实现；
- 采用必过 approval; 非法 finding 引用拒绝。
