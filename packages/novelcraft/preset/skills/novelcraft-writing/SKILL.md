---
name: novelcraft-writing
description: NovelCraft 写作(M4 停靠舱 + 修订中心): 文本停靠、语义审查、定向返修、候选采用、写作台四模式。写作类任务先读本 skill。
whenToUse: 作者同步章节、要审查/修订、采用候选、或问写作台怎么用时。
---

# NovelCraft 写作(M4)

## 文本流(编辑外置, D8)

- 正文在 Word; 项目只做停靠与版本: 拖文件/粘贴 → 纯文本归一 → chapters/{NNN}.md
  (ingestChapter, 幂等: 同 hash 跳过)。
- 每次同步 = 一个新版本(git commit); content_hash 变化 → 相关信号自动过期(§8)。

## 文本入库协议(Track 1, D9a)

- 作者给手稿文件(拖入会话产生路径/直接发路径) → **先用 read 工具预览前 ~100 行**
  确认章节标题结构(第X章/Chapter N/序章), 再调
  `novelcraft_ingest_file {root, file_path, start_chapter?, force?}`。
- 入库是确定性的: imports/<slug>.md 原文停靠 + chapters/NNN.md(默认接现有最大章之后;
  同号章内容冲突默认跳过, 作者确认后 force 覆盖)+ imports/import-log.jsonl
  (同文件重复导入自动跳过)。
- 粘贴流: 作者粘贴正文 → 用 write 工具落 imports/ 下临时 .md → 同走 novelcraft_ingest_file。
- v1 只收 .txt/.md(其他格式请作者另存为纯文本); 乱码(非 UTF-8)会被拒绝并提示转码;
  >50MB 请拆分。
- 入库后用作者语言报告(章数/跳过/冲突), 并建议下一步跑深度导入(novelcraft_deep_import);
  摄入雷达会自动把「章待增量导入」对账进收件箱。

## 闭环(全部确定性函数, @novelcraft/writing)

1. reviewChapter: 语义审查 → findings 落 .assistant/reviews/(N4), 失败不写。
2. applyRevision: 选定 findings → targeted_revision(内容手)→
   chapters/pending/{NNN}.md 候选(候选写入即 commit)。
3. adoptChapterCandidate: copy-on-adopt 覆盖同章(git 保留旧版)+ 脏工作区拒绝。
4. rejectFinding: 打回标记(幂等); 打回理由进校准。

## 写作台四模式(§17.4, 半屏 D10)

- 写作前·计划台: 下一步提案 2–3 条; 写作中·参照台: 本 Scene 人物/设定/必发生项简报;
- 写作后·评审台: 审查/冲突/修订卡; 守望: 六雷达 + 收件箱 + 宠物。

## 纪律

- 候选正文只读(仅 adopt/reject); 修订回 Word = 可复制修订块(v1);
- 采用必过 approval; 非法 finding 引用拒绝。
