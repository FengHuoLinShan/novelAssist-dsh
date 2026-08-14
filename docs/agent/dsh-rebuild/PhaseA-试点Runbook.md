# Phase A outline_analyze 试点 Runbook

> 状态: 待 harness 接线完成后执行。真实 provider 需账户 Key, 只作手动验收;
> CI 覆盖为单测(harness 分支等价断言 + 桥接 27 测试)与插件级 mock 端到端。

## 前置

1. 依赖: uv sync --extra dsh(装 deepseek-harness-sdk + runtime-bin)。
2. 插件宿主依赖: cd dsh/novelcraft-runtime && npm ci(host node_modules)。
3. 环境(API 进程与 worker 进程共用):
   - INTERNAL_BRIDGE_SECRET=<随机 32B+>(必填, 否则桥禁用)
   - LLM_STEP_EXECUTOR=dsh-sdk
   - DSH_RUNTIME_CORDIS_CONFIG=<repo>/dsh/novelcraft-runtime/cordis.yml
   - DSH_RUNTIME_INTERNAL_BASE=http://127.0.0.1:<API 端口>
   - DSH_RUNTIME_PORT_BASE=3311

## 步骤

1. 启动 API(make dev 的 api 进程)+ worker。
2. 确认运行时被懒启动: worker 日志/侧车 stderr 出现
   [novelcraft-runtime] /steps listening on 127.0.0.1:3311。
3. 前端大纲页执行一次"手动大纲分析"(先完成参考资料确认 confirmAiReference)。
4. 观察: 任务创建 → worker 领取 → harness dsh-sdk 分支 → 池取运行时 →
   POST /steps → 插件 ctx.tools.execute → 回调 API /internal/llm/generate →
   真实 provider → 结果流回 → 任务 done, 结果 Markdown 出现在分析结果卡。
5. 等价核对: journal/provenance 字段与 local 模式同 schema; 失败注入
   (停 API 的 internal 端点或给错误 Key)验证错误分类与任务失败文案。

## 回滚

LLM_STEP_EXECUTOR=local(默认)即回到既有实现, 无迁移、无数据变化。

## 已知限制(Phase A)

- 单 worker 单实例池; 多 worker 需端口偏移或调度层(Phase B 处理)。
- structured(schema_ref)回调扩展未实现前, dsh-sdk 模式仅覆盖
  run_managed_generate 类工作流(outline_analyze 属此类)。
