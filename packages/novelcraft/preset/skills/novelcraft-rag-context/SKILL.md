---
name: novelcraft-rag-context
description: "NovelCraft 检索与上下文编译(M6): 三层 RAG(L0 BM25 / L1 内容手精排 / L2 可选 BGE 向量)、rag 索引可重建、Tier P0–P4 上下文编译。涉及检索/上下文先读本 skill。"
whenToUse: 检索设定、重建索引、编译上下文、诊断检索质量、启用嵌入后端时。
---

# NovelCraft 检索与上下文(M6)

## RAG 三层架构(@novelcraft/rag)

- **L0 确定性召回(默认)**: BM25 + 字 bigram 词法召回, 零 LLM 依赖、恒可复现; 章节正文/角色/
  世界对象切块(chunkChapterText), index_version=cn-novel-v1, visibility 默认 author_only;
  chunk 是派生索引, 可全量重建(R12)——文件是唯一真相。
- **L1 内容手精排(默认开)**: `llm_step(spec=rag_rerank)` 对召回候选按相关性重排
  (预算 4096 / temp 0.1 / 超时 120s), 返回 `ranked_ids`; 失败自动回退 L0 原序。
- **L2 本地 BGE 向量召回(可选)**: llm.yml 设 `embedding: bge-local-v1` 启用;
  @novelcraft/rag-bge 懒加载 transformers.js 本地模型, 失败回退文本检索。
- **降级链**: L2 失败→L0/L1, L1 失败→L0; 检索永不阻断写作, 失败只在结果 `degraded`
  字段留痕(`rerank_failed` / `embedding_failed`)。

## 检索工具(dsh)

- `novelcraft_rag_search`: 参数 `root`(vault 根绝对路径)/ `query` / `top_k`(缺省 8)/
  `rerank`(缺省 true; false = 纯 BM25 不调 LLM)。返回 hits/ranking/degraded/message。
  索引由事件钩子自动维护, 本工具只检索不建索引; 无索引时提示先入库/采用资产。
- `novelcraft_rag_embed`: 前置条件 = 该书 `.assistant/llm.yml` 设 `embedding: bge-local-v1`
  且 @novelcraft/rag-bge 已安装; 批量补向量逐批落盘 .assistant/rag-index.json(中断可重入);
  未启用时以 `RAG_EMBEDDING_UNAVAILABLE` 进入宿主失败通道, 先配置后重试。

## 索引维护纪律

- adopt/ingest/deep_import 事件钩子只同步词法索引; 不在工具返回后启动后台 embedding writer。
  向量补全只由显式 `novelcraft_rag_embed` 执行。
- .assistant/rag-index.json 是派生索引(向量为派生字段), 任何时刻可全量重建, 已入 vault
  .gitignore 不提交 git。

## 嵌入后端启用方法

1. 安装可选包: `npm i @novelcraft/rag-bge`(dsh optionalDependencies + 动态 import 兜底,
   缺包全链自动降级)。
2. 该书 `.assistant/llm.yml` 设 `embedding: bge-local-v1`。
3. 首次嵌入懒下载模型到 `$DSH_HOME/novelcraft/models`(transformers.js 缓存层, 幂等可复现);
   之后运行 `novelcraft_rag_embed` 批量补向量。

## 上下文编译(@novelcraft/context, 确定性)

- compileContext: Tier P0(任务指令)→P1(焦点章)→P2(结构)→P3(世界)→P4(RAG 补强);
  超预算截断/驱逐(事件流可审计); CONTEXT_BUDGET 默认 4000 内置(N4)。
- 编译摘要是作者语言(不暴露 raw JSON); 供计划确认/成本预告。

`core-only`: `compileContext` 当前没有稳定生成消费者或 public tool; 不能把其存在当成已冻结
来源 receipt。`available-now` 只有 `novelcraft_rag_search` 与显式 `novelcraft_rag_embed`。

## 纪律

- 检索只读; 重建索引不影响文件真相; 编译结果不进资产。`rag_search` 内嵌入/精排失败可降级;
  显式 `rag_embed` 后端不可用则报宿主错误, 不伪装成功。
