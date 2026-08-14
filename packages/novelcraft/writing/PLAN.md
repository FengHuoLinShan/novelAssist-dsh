# R3 · writing 垂直切片计划(首个用户可用闭环)

> 依据: ADR-0016 §16 R3; 设计文档 §17.2/§17.4; specs/assets/writing.md;
> specs/prompts/catalog.md §3; adjudications N4/N13。

## 目标

拖 Word 文本(纯文本, D9a 转换在 DSH 网页层)→ `chapters/{NNN}.md` 停靠 →
`semantic_review`(内容手)→ findings → 修订卡 → 定向返修候选 → adopt=commit。
**这是 M4 第一个端到端可演示闭环。**

## 范围(闭环最小集)

1. **停靠** `ingestChapter(root, {chapterIndex, text, source})`
   - 文本归一(去 BOM、行尾统一、连续空行折叠); 写 `chapters/{NNN}.md`
   - frontmatter: status=draft、content_hash(纯 hex, N13)、source
   - 幂等: 同 content_hash 且文件存在 → 跳过返回
2. **审查** `reviewChapter(provider, root, chapterIndex)`
   - 读冻结正文 → `runStep(provider, spec=semantic_review)`(llm-step 包)
   - findings 落 `.assistant/reviews/semantic-review-{chapter}-{runId}.json`(N4 落点)
   - 每条 finding: id/severity/category/quote/suggestion(来源 catalog §3.3, 字段以
     specs/assets/writing.md 语义审查节为准, 未定处标【待定】)
3. **修订卡动作**(上层 UI 的四动词在本包映射为确定性操作):
   - `applyRevision(root, chapterIndex, findingIds)` → 调 llm-step(spec=targeted_revision)
     → 候选写 `chapters/pending/{NNN}.md`(status=candidate, 附 base_content_hash/finding_ids)
   - `rejectFinding(root, reviewId, findingId)` → 在 review json 里记录 rejected
4. **采用** `adoptChapterCandidate(root, chapterIndex)` → 复用 store 的 copy-on-adopt
   (pending → chapters/{NNN}.md 新版本 + git commit; 脏工作区拒绝, R17)

## 依赖

- `@novelcraft/vault`: paths/readAsset/writeAsset
- `@novelcraft/store`: chapter frontmatter 校验、adopt、git、hash
- `@novelcraft/llm-step`: runStep + MockProvider(测试与 demo 用; 真 provider 后置)

## 验收

- vitest 行为契约: 停靠幂等/哈希、findings 结构、非法 finding id 拒绝、
  候选 adopt 后 chapters 更新且 git 干净、脏工作区拒绝 adopt、review json 幂等追加
- **手动闭环 demo**: `scripts/r3-demo.mjs`(MockProvider)跑通
  停靠→审查→修订→采用, 逐阶段打印产物摘要——「用户可见闭环」的直接证据

## 非目标(留后)

- writing_generate / pov_generation(续写提案微工作流 → R6)
- 冲突检查 AI 面、写作雷达自动触发(→ R6 assistant)
- client UI / 宠物(→ R7)
