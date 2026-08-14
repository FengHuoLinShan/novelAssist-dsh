# Phase A 设计 — DSH 侧车骨架 + outline_analyze 试点

> 依据: ADR-0014(Accepted)。本文细化 Phase A 的切入 seam、协议与验收。

## 1. 试点工作流选择与链路事实

outline_analyze(模块 tasks.py:227-260): recovery_policy=auto_requeue, max_attempts=2,
retry_transient_llm_errors=True。
链路: handler → OutlineAIWorkflowService.analyze_for_task(ai_workflow_service.py:124)
→ confirmation 重编译(指纹一致校验)→ 经 run_managed_generate(agent_step_harness.py:847)
调用 client.generate → 自由 Markdown 结果(只读, 无 apply/写库)。

选择理由: 只读无写回、单 step、有 confirmation 门禁、失败语义清晰, 风险最低。

## 2. 切入 seam: agent_step_harness 信封层

run_managed_generate / run_managed_structured 是所有 34 个工作流的共享信封入口。
Phase A 在此加执行器开关(配置 LLM_STEP_EXECUTOR=local|dsh-sidecar, 默认 local):
- local: 现有实现, 行为不变。
- dsh-sidecar: 信封执行(journal/预算/超时/可重试分类/provenance)委托侧车;
  Python 侧保留上下文编译、prompt 组装、Pydantic materializer(第三层校验)。

这样试点不改 outline 服务代码, 任何走 run_managed_* 的工作流都自动获得切换能力。

## 3. harness 接线的关键事实与 snapshot 传递

- LLMClient(client.py 已核对): _runtime_scope 携带 novel_id/profile_source
  (bind_runtime_scope, client.py:408);_profile_summary 为 sanitized 摘要;
  from_resolved_profile 是唯一业务构造路径。
- run_managed_*(agent_step_harness.py:847/888) 只接收 client+request+信封参数,
  拿不到 task.meta 里的 llm_execution_snapshot。因此 snapshot 传递采用
  ContextVar: 任务 handler 在 restore_project_llm_execution_settings 之后调用
  dsh_step_bridge.set_step_snapshot(snapshot) 设置当前执行上下文的非 secret 快照;
  harness 的 dsh-sidecar 分支读取该 ContextVar, 缺失时显式失败(fail-closed, 不静默回退)。
- 试点只在 OutlineAIWorkflowService._open_task_llm_client(ai_workflow_service.py:90)
  一处设置 ContextVar;Phase C 推广到全部任务 handler 的 snapshot 恢复点。

## 4. 侧车与桥接协议

- dsh-sidecar/: Node 服务(pnpm, 依赖 @deepseek-ai/dsh rc.6 锁定)。每 novel_id 一个
  DSH headless session(独立 workspace 目录), 进程内 cordis 树注册
  managed_llm_step 工具(权限 read/suggest/draft/act-with-confirmation,
  autonomous 拒绝; 输出 JSON Schema 校验)。
- FastAPI 内部端点(service token 鉴权, 仅 loopback/内网):
  - POST /internal/llm/step-token: 按 secret-free snapshot 语义签发一次性运行配置
    (provider 固定、base_url/model、漂移 hash 校验、有效期 ≤ 一次执行), 不含 Key。
  - POST /internal/llm/generate: 侧车回调, Python client 执行真实 provider 调用
    (Key 永不离开 FastAPI 进程)。
- 侧车端点: POST /steps (system_prompt/messages/output_schema/permission/budget/
  timeout/step_token) → {text 或 json, journal, provenance}。

### 密钥保管取舍(已决策: 方案 B)
- 方案 A(Key 下发侧车内存): 侧车用 DSH 原生 llm adapter; Key 暴露面扩大到侧车进程。
- **方案 B(Key 永驻 FastAPI, 默认)**: 侧车工具 execute 时回调 /internal/llm/generate,
  DSH 提供工具流水线/journal/信封, Python 保持既有 client 语义(限流/熔断/重试/脱敏)。
  与"密钥保护"不变量完全一致; DSH 原生 llm adapter 接入留 Phase C 评估。
- 理由: 安全不变量优先; DSH 化体现在信封/流水线/session, 不体现在 Key 搬运。

## 4. Phase A 交付物

1. dsh-sidecar/ Node 工程(ts, 单测, managed_llm_step 工具 + /steps 端点)。
2. FastAPI: infrastructure/llm/dsh_executor.py(executor 开关 + step-token + 回调
   /internal/llm/generate 的路由注册, 仅内网); config LLM_STEP_EXECUTOR。
3. harness 层分流: run_managed_* 在 dsh-sidecar 模式下构造 step 请求并解析响应。
4. 测试: pytest mock 侧车(信封字段等价断言); 侧车 vitest 单测; outline_analyze 模块
   测试回归; 新旧实现同输入同输出对比 fixture。

## 5. 验收门禁

- outline 模块测试 + harness 测试全绿; make lint; docs-check。
- 对照清单 §6 回填: "outline_analyze 信封侧车执行" 一行证据。
- 行为等价断言: journal 字段(开始/结束/耗时/error_kind/degraded)、provenance 白名单、
  可重试分类、超时语义与 local 实现逐项一致。
