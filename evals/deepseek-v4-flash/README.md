# DeepSeek V4 Flash 项目任务评测

当前只提供无网络、无 Key、provider 调用恒为 0 的 dry-run：

```bash
npm run eval:pilot:dry-run
npm run eval:pilot:dry-run -- --authorization evals/deepseek-v4-flash/authorization.example.json
npm run eval:pilot:self-test
```

`catalog.json` 覆盖 12 类任务；首轮只有 structure analysis、continuation proposal、chapter prose、
semantic review 四链进入 pilot。`fixtures.json` 是 12 份合成资料，四链各 3 份；每份重复 3 次，
形成 36 个 logical calls。RAG 弃权和 POV/知识边界在对应生产合同闭合前保持 `blocked`，不计通过率。

`authorization.example.json` 故意保留空授权人、时间、价格快照和输出目录，因此不能用于付费执行。
未来如获用户对费用与数据范围的明确授权，真实 runner 仍必须：

- 先冻结并校验清单全部字段和 calls/tokens/cost 硬上限；
- 只通过 DSH `ctx.llm`、`DshProvider`、`llm-step` 调用，不直连 HTTP、不读取 Key；
- 每次保存 route/model/effort/prompt/context/schema hash、finish、完整 usage、延迟与错误分类；
- 输出滚动别名时保留 `rolling_alias=true`，不声称冻结了不可见的后端版本；
- 输出匿名化后再由作者盲评，不把厂商 benchmark 当项目质量结论。

当前 `--execute` 会明确失败。这是付费门，不是尚未运行却伪装成功的功能。
