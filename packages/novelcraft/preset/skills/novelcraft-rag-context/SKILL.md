---
name: novelcraft-rag-context
description: NovelCraft 检索与上下文: RAG 检索/索引/重排(证据价值与 abstention)、参考资料确认(confirmAiReference)、上下文编译与审计。检索与确认类任务先读本 skill。
whenToUse: 作者要检索正文证据、重建索引、修复 embedding、或在 AI 动作前确认参考资料时。
---

# NovelCraft 检索与上下文

## 分工(一句话)

RAG 负责"找"; context 负责"选、裁、确认、追踪"; 领域模块决定能不能写、
写成什么状态。检索只是输入链路, 不是答案。

## RAG

- 检索: POST /api/rag/retrieve(混合检索 + 可选 LLM 证据重排)。
  重排(rag.reranker, RERANKER_ENABLED 默认关)只排证据价值:
  direct/supporting/counterevidence/topical_only; 高置信 unsupported 返回空
  (真 abstention); 失败保留原排序并告警。
- 索引: POST /api/rag/rebuild(rag_reindex_novel)、/retry-embeddings
  (embedding 失败重试)、/prewarm; embedding 失败不阻塞索引(warnings +
  重试任务)。
- 证据呈现: 检索结果带 chunk 来源(章节/Scene/可见性); 区分证据角色。

## 上下文确认(手动 AI 动作前置门禁)

- AI 动作前: POST /api/context/confirm 固定范围(章节/模式/包含待处理/
  激活规则/备注)与 compile_options; 后续任务校验 confirmation 新鲜度,
  不一致拒绝执行。
- context_confirmations 记录作者确认; context_snapshots 审计自动流水线。
- agent 纪律: 未经作者确认范围, 不触发手动 AI 工作流; 确认后不要擅自
  扩大范围。

## 可见性(不要越界)

- rag_chunks.visibility: author_only / author_safe / reader_known / public;
  世界对象 reveal_level 同理。agent 只为作者服务, 使用 author 可见集,
  不向读者语境泄露未来揭示。
