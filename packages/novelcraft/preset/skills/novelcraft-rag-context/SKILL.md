---
name: novelcraft-rag-context
description: NovelCraft 检索与上下文编译(M4): rag 索引可重建、EmbeddingBackend 可插拔、Tier P0–P4 上下文编译。涉及检索/上下文先读本 skill。
whenToUse: 检索设定、重建索引、编译上下文、诊断检索质量时。
---

# NovelCraft 检索与上下文(M4)

## RAG(@novelcraft/rag)

- 章节切块(chunkChapterText): index_version=cn-novel-v1, visibility 默认 author_only;
  chunk 是派生索引, 可全量重建(R12)——文件是唯一真相。
- 索引落 .assistant/rag-index.json; 嵌入后端可插拔(D16: provider 嵌入 API 或本地模型)。
- v1 检索 = 文本包含粗排; 嵌入接入后由 backend 排序。

## 上下文编译(@novelcraft/context, 确定性)

- compileContext: Tier P0(任务指令)→P1(焦点章)→P2(结构)→P3(世界)→P4(RAG 补强);
  超预算截断/驱逐(事件流可审计); CONTEXT_BUDGET 默认 4000 内置(N4)。
- 编译摘要是作者语言(不暴露 raw JSON); 供计划确认/成本预告。

## 纪律

- 检索只读; 重建索引不影响文件真相; 编译结果不进资产。
