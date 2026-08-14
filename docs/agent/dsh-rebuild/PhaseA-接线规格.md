# Phase A 接线规格 — run_managed_* 的 dsh-sdk 执行分支

> 本规格给实现子代理。依据: ADR-0014(含修订)、PhaseA-设计.md、harness 实际代码
> (agent_step_harness.py:723-845, 847-941+)。

## 0. 前置事实(已核对)

- ManagedLLMStep.run: journal.record("started"/"ended", name, elapsed_ms, error_kind,
  degraded, details{token_usage, quality_stats, ...});timeout 用 asyncio.wait_for;
  异常经 _classify_step_exception 分类; 返回 StepExecutionResult(含 journal_events=
  journal.model_dump())。
- run_managed_generate/run_managed_structured(harness.py:847/888): 构造 provenance →
  _collect_managed_llm_provenance → step.run(lambda: client.generate(_structured)) →
  _unwrap_step_result。
- 实现子代理须先读 _unwrap_step_result 与 _classify_step_exception 的全部语义,
  dsh 分支的失败路径必须与其逐一等价(含 raise 类型与 degraded 状态)。

## 1. 快照传递(ContextVar)

- dsh_step_bridge 模块提供 set_step_snapshot(snapshot: dict) / get_step_snapshot() /
  clear_step_snapshot()(ContextVar, 默认 None)。
- 试点接入点: OutlineAIWorkflowService._open_task_llm_client(ai_workflow_service.py:90)
  在 restore_project_llm_execution_settings 成功后 set_step_snapshot(llm_execution_snapshot),
  client close 后 clear。注意该函数同时被其他 outline 任务使用, 接入不得改变 local
  模式行为(只有 executor=dsh-sdk 时 harness 才读该 ContextVar)。
- dsh 分支若 get_step_snapshot() 为 None: raise RuntimeError(fail-closed, 明确文案
  "dsh-sdk executor requires a project LLM execution snapshot"), 不得静默回退 local。

## 2. run_managed_generate 的 dsh-sdk 分支

- 构造 DshStepRequest: step_name/permission_level(枚举转 wire 值)/messages(request.messages
  序列化为 dict)/output_kind="text"/timeout_seconds=timeout/context_budget(budget 相关字段
  按 ContextBudget 可序列化子集)/step_token=sign_step_token(payload{snovel_id, provider_id,
  exp, nonce, snapshot}, settings.internal_bridge_secret)。
- novel_id/provider_id 来源: client._runtime_scope["novel_id"] 与 snapshot 的 provider_id
  (snapshot 结构与 build_project_llm_execution_snapshot 输出一致, 见 llm_runtime.py:90)。
- runner.execute_step(request) 同步/异步返回 DshStepResponse{status, text, json_data,
  usage, journal_events, error}。
- 结果装配(与 local 完全同形):
  - succeeded: journal_events 逐条用 self.journal 等价结构重放(实现时直接构造
    AgentRunJournal 并 record 等价事件, 或让 dsh 侧 journal_events 直接映射为
    model_dump 形状后以同等字段构造 StepExecutionResult)——最终必须保证
    journal_events 与 local 模式同 schema。
  - failed/degraded: 按 error.error_kind 构造与 _classify_step_exception 一致的
    异常并走 _unwrap_step_result 既有路径(保持 raise 语义)。
- provenance: build_managed_llm_provenance/_collect_managed_llm_provenance 在分支前
  照常执行(与 local 相同)。

## 3. run_managed_structured 的 dsh-sdk 分支

- output_kind="json", output_schema=schema.model_json_schema(); 同时附
  schema_ref={"module": schema.__module__, "qualname": schema.__qualname__}(仅限
  模块路径以 "modules." 或 "shared." 开头, 否则拒绝)。
- 校验与修复归属不变: 回调端点 /internal/llm/generate 在 API 进程按 schema_ref 导入
  Pydantic 类(白名单前缀校验, issubclass(BaseModel)), 调用既有 client.generate_structured
  (max_fix_attempts/fix_prompt/partial_list_fields/diagnostics/format_repair_attempts
  全部随请求透传), 因此结构化修复预算与 Pydantic 校验语义完全由既有代码承担。
- 回调响应: {status:"ok", content(json 可序列化对象), usage, finish_reason} 或
  {status:"error", error_kind, message(脱敏)}; 修复失败时的 error_kind 与既有
  LLMInvalidResponseError 分类一致。

## 3.5 回调端点 structured 扩展(Phase A 收尾包之后实现)

InternalGenerateRequest 增加可选字段: schema_ref{module, qualname}(二者均须以
"modules." 或 "shared." 开头, 否则 400) 与 structured 参数 max_fix_attempts/
fix_prompt/partial_list_fields/format_repair_attempts/diagnostics。
端点行为: 带 schema_ref 时 importlib.import_module(module) + getattr(qualname),
校验 issubclass(BaseModel)(失败 → error_kind=invalid_response), 调用
client.generate_structured(request, Model, **structured 参数)(校验与修复预算完全由
既有代码承担), 成功返回 {status:"ok", json_data: model_dump(mode="json"),
usage, finish_reason}; 失败走既有错误分类。
安全: 导入路径白名单(modules./shared. 前缀)是唯一动态导入面; 该机制仅承载仓库
自身代码路径, 不接受模型输出作为 module/qualname(值由 harness 从 schema 类派生,
非 LLM 输出)。仍不得 eval/exec。

## 4. 配置与开关

- settings.llm_step_executor: "local"(默认)|"dsh-sdk"。仅显式配置 dsh-sdk 才走分支。
- settings.internal_bridge_secret 为空时, sign_step_token 直接 raise(因此 dsh-sdk
  模式 + 未配 secret = 任务失败并带清晰错误, fail-closed)。

## 5. 测试(新增 backend/tests/unit/test_dsh_step_harness.py)

- 用 autospec=True mock dsh_step_bridge 的 runner: 断言 local 模式行为不变、
  dsh 分支的请求字段(含 snapshot 传递与 token 签名调用)、succeeded 与 failed 两路的
  StepExecutionResult/journal_events 形状等价、快照缺失 fail-closed、schema_ref
  白名单拒绝。
- 不 import Mock 于生产代码。

## 6. 验收

- backend/tests/unit/test_dsh_step_harness.py + test_dsh_step_bridge.py 全绿;
  infrastructure/llm 与 outline 既有测试不回归; ruff check 通过。
- 对照清单 §6 回填: "run_managed_* dsh-sdk 分支 + 等价断言" 一行。
