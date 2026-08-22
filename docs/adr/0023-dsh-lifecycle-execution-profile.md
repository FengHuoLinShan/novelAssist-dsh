# ADR-0023 — DSH 生命周期与执行画像(session/vault 生命周期 + Node 托管调度 + ExecutionProfile)

- **状态**: Accepted(2026-08-15, 用户确认裁定 N34); **implemented and verified**
- **日期**: 2026-08-15
- **取代/补充**: 补充 ADR-0017 §2(会话↔工作区绑定 D17、RadarScheduler 经 ctx.schedule/
  ctx.jobs)与 ADR-0016(内容手受控、llm-step 编排纪律)的生命周期与配置语义。**不取代**
  任何现有 ADR。
- **设计依据**: N34(2026-08-15 用户确认; 已录入 `specs/adjudications.md` 第八批)、
  `packages/novelcraft/dsh/README.md`(SessionVaultBinder / RadarScheduler / novelcraftDomain
  sessions)、N20(`withResolvedDefaults`/`mergeStepOverrides` 预设注入)、
  `docs/agent/dsh-rebuild/跨会话交接.md`(构建与挂载入口)。

## 背景

会话↔vault 绑定与雷达 timer 的现状生命周期依附 DSH session, 带来四个问题:

1. **session 生命周期 ≠ 服务生命周期**: 浏览器连接状态不应成为调度输入——若 radar
   timer/job 错误地跟着连接/watcher 状态走, 连接抖动即误停 Node 侧的巡检与内容生成
   job。调度只认**服务端真实 session created/disposed 事件**。
2. **session/created 无 vault 创建语义**: 若「绑定即创建」, 一个笔误的 cwd 会在磁盘上
   误建目录, 污染「vault 是唯一真相」的目录面(铁律 2)。
3. **雷达无补偿策略**: Node 长时间不运行时错过轮次, 重启后若追赶所有错过的轮次会形成
   追赶风暴; 防重入也未闭环。
4. **执行参数散落**: llm-step 的 timeout 等参数散落在 spec/调用点, 没有「编排启动时
   固定、请求级可覆盖」的统一语义。

## 决策

### 1. session/created 只绑定已有 vault, 绝不自动创建

- `session/created` 根据**绝对 cwd** 解析 vault 绑定: 仅当目录存在、且是已初始化的 vault
  (校验通过)时绑定; 不存在或校验失败 → 不绑定、**绝不自动创建**, 记录原因。
- **HMR / plugin load 时扫 live sessions 补建**: session 重建(热重载/插件重载)后, 遍历
  存活 session 按其 cwd 补建 vault 绑定, 不丢既有绑定。

### 2. session/disposed 引用计数, 最后 session 停 timer 并安全收尾

- 同一 vault 可有多个 session 绑定; 引用计数**只由服务端真实的 session created /
  disposed 事件增减**——**浏览器连接状态不作为调度输入**(断线/刷新不触发生命周期、不
  增减计数)。
- 计数 > 0 时该 vault 的 timer 运行; 计数归 0(**最后一个 session disposed**)才停 timer,
  并**请求取消该 vault 运行中的 radar jobs、安全收尾**。

### 3. Node job 独立于浏览器连接状态

- **显式长 job**(deep_import、writing 内容生成等)由 Node 托管, **不因浏览器断线或
  watcher/引用计数变化取消**; 其可恢复性由 ADR-0022 的 checkpoint/resume 承接, 不依赖
  session 存活。
- radar 类巡检 job 的取消只发生在 §2 的最后一个 session disposed 安全收尾; 其余场景
  job 继续运行到自然结束或被用户/成本授权取消。

### 4. 雷达调度: Node 托管、按活跃 vault 启停

- 调度器由 Node 托管, **按活跃 vault 启停**(有绑定 session 的 vault 才跑 timer)。
- 调度状态**持久化**, **真相落 vault 文件**(建议 `.assistant/watch-state.json`, 具体
  路径实施期定): `last_completed_at` / `next_due_at` / config fingerprint; **domain KV
  只能作可重建缓存**(可被清空, 由文件真相重建), 不另建数据库(铁律 2)。config
  fingerprint 变化即视为新配置周期。
- **过期最多补跑一次、不追赶风暴**: Node 停机期间错过的轮次, 恢复后最多补跑最近一轮,
  不逐轮追赶历史。
- **每 vault/radar 防重入, 每 radar 一个 job**(kind `novelcraft-radar`, 对齐
  RadarScheduler 现状); 防重入检查在 job 启动与调度两个入口都做。

### 5. 边界: 不承诺 Node 不运行时的 24/7

- 雷达是尽力而为的辅助面: Node 不运行时错过轮次是**预期状态**(§4 只补最近一轮),
  不保证 24/7 覆盖; vault 文件真相与 git 历史不受影响, 补跑后由派生索引收敛。

### 6. ExecutionProfile: 编排启动解析, 不可变, 请求级 override 优先

- 编排(deep_import、多章生成等)启动时**解析一次不可变 ExecutionProfile**(含 timeout、
  预算等执行级默认), 解析失败 → 编排启动失败(fail-closed, 不带半解析配置跑)。
- 内部所有 llm-step 调用**统一继承** profile 的 timeout 等默认; **请求级 override 优先**
  (对齐 N20 的 `withResolvedDefaults`/`mergeStepOverrides` 语义), 不逐调用点散写常量。

### 7. Node engines 跟随 DSH

- 包 `engines` 声明与 DSH 对齐: **`^22.19.0 || >=24.0.0`**; CI 矩阵覆盖 **22.19 / 24**
  两档(安装、测试、typecheck 全链验证)。

## 失败关闭与边界

- session/created 遇到不存在/未初始化目录 → 不绑定不创建并报告; 绑定失败不影响该
  session 其它能力。
- 防重入: 同 vault 同 radar 已有运行中 job → 拒绝新 job 启动(不叠跑)。
- ExecutionProfile 解析失败 → 编排启动失败, 不静默用缺省参数继续。
- **边界**: 不承诺 Node 不运行时的 24/7; 调度状态文件丢失/被清时由 config fingerprint
  + `last_completed_at` 重建, 最坏退化为补跑一轮, 不丢真相(domain KV 只是可重建缓存,
  不是真相)。

## 未采用方案

- **A. 把浏览器连接状态/watcher 引用当调度输入**: 连接抖动即误停/误调度 Node job;
  未采用(调度只认服务端真实 session 事件)。
- **B. session/created 自动创建 vault**: 误建目录、污染 vault 真相面; 未采用。
- **C. 追赶风暴(补跑全部错过轮次)**: 长时间停机后恢复会连续触发大量 LLM 成本; 未采用。
- **D. 每 vault 常驻进程**: 资源开销与调度复杂度不成比例; 未采用(单 Node 托管 +
  按活跃 vault 启停)。
- **E. ExecutionProfile 每次请求动态解析**: 不可复现、难以审计; 未采用(启动时解析一次,
  不可变)。
- **F. engines 只跟 DSH 最低版本**: 与 DSH 运行时要求不一致, CI 无法兜底; 未采用。

## 影响

- 新增(只做加法): dsh 包(config.ts 的 ExecutionProfile 解析、SessionVaultBinder 引用
  计数与补建、RadarScheduler 持久化(状态真相落 vault 文件, domain KV 只作缓存)/防重入/
  补跑一轮/最后 session disposed 取消 radar jobs)、assistant(雷达调度状态字段)、
  llm-step(profile 继承 seam, 对齐 N20)。
- 工程: 各包 `package.json` engines 声明 `^22.19.0 || >=24.0.0`; CI 矩阵加 22.19/24。
- 验证要求: vitest 行为契约, 断言注释引 N34——覆盖 cwd 不存在不创建、HMR 补建、引用
  计数只认服务端真实 session 事件(断线/刷新不增减计数)、最后 session disposed 停 timer
  并请求取消 radar jobs(显式长 job 不取消)、调度状态真相落 vault 文件(domain KV 被清
  可重建)、防重入拒绝、补跑至多一轮、profile 解析失败 fail-closed、override 优先;
  生命周期集成测试用真实 Cordis Context + 假 jobs/approval 驱动; 完成标准 `npm test`
  全绿 + `npm run typecheck` 零错误。
- 文档: N34 已录入 `specs/adjudications.md` 第八批; `docs/adr/README.md` 索引已更新。

## 实施期开放项

1. 调度状态文件的具体路径(建议 `.assistant/watch-state.json`)与格式留实施期定;
   「状态真相落 vault 文件 + domain KV 只作可重建缓存 + 指纹 + 补跑一轮」已是裁定,
   不可违背。
