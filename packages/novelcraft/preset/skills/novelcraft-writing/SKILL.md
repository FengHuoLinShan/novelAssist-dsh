---
name: novelcraft-writing
description: "NovelCraft 写作(M4 停靠舱 + 修订中心): 会话授权文本导入、语义审查、定向返修、候选采用与写作台。写作类任务先读本 skill。"
whenToUse: 作者同步章节、要审查/修订、采用候选、或问写作台怎么用时。
---

# NovelCraft 写作(M4)

## 文本流(编辑外置, D8)

- 正文可外置编辑; 在当前会话的「写作台 → 导入」选择 UTF-8 `.txt/.md`,
  由页内面板生成会话绑定收据。工具不读取模型提供的主机路径。
- 摄入幂等与冲突保护已存在, 但完整多文件 transaction/Git commit point 仍待收口,
  不能宣称每次同步已经形成一个可恢复版本。

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
  `novelcraft_generate_next_chapter`, `novelcraft_store_adopt(kind=chapter_candidate)`；
  `novelcraft_llm_step(spec=semantic_review)` 只返回 raw review preview。
- `core-only`: `reviewChapter`/`applyRevision`/`rejectFinding` 与正文 update/version/restore
  尚未组成 public tool/client 竖切, 不应由 Skill 假装已落 `.assistant/reviews` 或修订候选。

## 写作台(§17.4, 半屏 D10)

- 写作前·计划台: 下一步提案 2–3 条; 写作中·参照台: 本 Scene 人物/设定/必发生项简报;
- 写作后·评审台: 审查/冲突/修订卡; 守望: 六雷达 + 收件箱 + 宠物。
- 导入: 仅承载浏览器选文件与会话收据; 章节切分、冲突裁决和后续深导入继续在对话中完成。

## 纪律

- 候选正文只读(仅 adopt/reject); 修订回 Word = 可复制修订块(v1);
- 采用必过 approval; 非法 finding 引用拒绝。
