# ADR-0017 — M4 仓库形态(独立 fork 仓库)与挂载阶段授权

- **状态**: Accepted(2026-08-14, 用户裁定: 挂载阶段 A 启动; DSH 源码 checkout 构建链授权;
  合并策略 = 不并入 main, 分支独立为新仓库并 fork deepseek-harness)
- **日期**: 2026-08-14
- **取代/补充**: 补充 ADR-0016 的「待确认事项」(合并策略、挂载阶段入口、构建链来源)

## 背景

ADR-0016 落地后, M4 重写在 `codex/m4-dsh-plugin-rewrite` 分支上完成了 R0–R7 的纯 TS
确定性核心(11 包 192 测试, 验收汇总 `docs/agent/dsh-rebuild/验收汇总-M4.md`), 剩余工作为:
① DSH 挂载阶段(13 核心包 → Cordis 服务插件 seam 适配); ② client UI; ③ trace contract
框架; ④ 仓库形态与旧引擎退役的裁决。用户逐条裁定如下。

## 决策

### 1. 合并策略: 不并入 main, 独立为新仓库并 fork DSH

- `codex/m4-dsh-plugin-rewrite` 分支**永不并入 ai-writing-assist 的 main**; main 继续不动。
- 该分支后续整体迁出为**独立新仓库**, 形态为 **fork `deepseek-harness`**:
  - 上游 `https://github.com/deepseek-harness/deepseek-harness`(MIT; 当前 rc 线,
    参考 checkout 已浅克隆至 `~/Desktop/项目/deepseek-harness`, head `47f9438`);
  - `packages/novelcraft/*`(13 核心包 + 本阶段新增的 `@novelcraft/dsh` 适配包)作为该
    fork 的 workspace 扩展包, 依赖 DSH rc.6 官方 npm 包;
  - ai-writing-assist 主仓库只保留「指针」(docs 链接), 不承载 M4 代码。
- **旧引擎退役**: 旧 FastAPI/PG/Vue 引擎继续留在 ai-writing-assist main, 退役时机
  另行裁决(验收汇总-M4 DoD 对照项 ⑤); M4 不删除、不回写 main。

### 2. 挂载阶段(A): 入口与形态

- 挂载阶段 = 把 13 核心包接入 DSH rc.6 seam, 产出**可运行的服务插件适配层 + 验证方式**。
- 实现形态: 新增独立适配包 **`@novelcraft/dsh`**(位于 `packages/novelcraft/dsh/`),
  13 核心包**保持零 DSH 运行时依赖不变**(seam 契约不变, 核心包不得回头改接口):
  - `ctx.llm` → llm-step `Provider` 适配(DshProvider);
  - `ctx.approval` → store `ApprovalGate`(allowed-once / fail-closed);
  - `ctx.storageDomain` → `rebuildIndex` 派生索引缓存(文件仍为唯一真相);
  - `ctx.jobs`(+ `ctx.schedule`, 默认关 D6)→ assistant 雷达调度;
  - `ctx.credentials` → 内容手 Key 解析面(Key 不进工作区文件);
  - 会话↔工作区绑定(vault, D17: 一书一会话一 vault 根);
  - client-modules: host 侧注册面在挂载阶段定型, client UI 本体留 R7/client 阶段(B)。
- 编排脑仍为 DSH 原生模型切换(flash+high 账户连接), 不在本包实现; 内容手默认路由
  经本包 Config 声明, 运行时由 DSH 模型切换覆盖。

### 3. 构建链: npm 官方 rc.6 包为准, 源码 checkout 为参考

- 依赖锁定 `@deepseek-ai/*@0.1.0-rc.6`(D21), 从 npm registry 安装;
- DSH 源码 checkout(`~/Desktop/项目/deepseek-harness`, 浅克隆)作为**参考与构建链来源**
  (web client 打包、seam 文档、升级窗口对照), 不修改、不发布;
- 本阶段产出全部在 `packages/novelcraft/dsh/` 内自洽可测(vitest + 进程内集成 demo),
  CLI 端到端(profile 加载本地插件)为验收增强项。

### 4. 验证方式(本阶段 DoD)

1. 单元测试: 真实 Cordis Context(`@deepseek-ai/cordis`)+ 内存 fake services
   (llm/jobs/approval/credentials)验证每个适配器(覆盖 fail-closed 与错误分类);
2. 集成 demo: 真实 dsh 包(storage + storage-json + storage-domain + llm + jobs-local
   + approval)进程内组合, 跑通「vault 初始化 → adopt(approval gate)→ llm_step
   (DshProvider → 注册的 fake LlmAdapter)→ 索引 → domain 缓存 → 收件箱 act →
   雷达 job」全链;
3. 检查点 commit 于 `codex/m4-dsh-plugin-rewrite`(不进 main)。

## 待确认事项(后续裁决, 不阻塞本阶段)

- client UI(B)与 trace contract(C)的启动顺序;
- fork 新仓库的具体创建时点(等挂载/client 阶段完成后再迁);
- 旧引擎退役仪式(删除/归档/保留只读)与主仓库指针文档形式。

## 影响

- 主仓库 main: 无代码变更; 文档增加指向本 ADR 的链接(随 fork 迁出时同步)。
- dsh-rebuild 旧 worktree: 处置维持 ADR-0016 §23 三分类, 不动。
- 安全: 全部继承 ADR-0016(单用户自用、novel_id=工作区隔离、approval fail-closed、
  credentials 不落盘)。
