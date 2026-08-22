# NovelCraft M4 全代码库 Review

> 范围：`novelAssist-dsh` 当前 `main` 工作树；不含只读父仓库 `ai-writing-assist`。
> 方法：包图/发布面审计、源码分层审查、审批与路径威胁建模、行为复现、全量测试/类型/构建/依赖审计。
> 状态：已完成；两轮独立 final diff review 的 Blocker/P1 均已闭环；剩余架构项已于 2026-08-15 裁决为 N32–N36，当前为 Accepted、implementation pending。

## 1. 基线

- 分支：`main...origin/main [ahead 7]`，Review 开始时工作树干净。
- 规模：16 个 npm workspaces，661 个 tracked files，189 个 TS/TSX 文件，约 30,850 行，65 个测试文件。
- Review 前：589 项测试通过；全仓 typecheck 与拓扑构建通过。
- 依赖基线：生产依赖审计有 4 个 high，均来自可选 `@novelcraft/rag-bge → @huggingface/transformers@4.2.0` 链且无上游修复；开发依赖另有 Vitest 2.x critical。
- 边界基线：13 个确定性核心包无 `@deepseek-ai/*` runtime import，DSH 依赖仅位于 `@novelcraft/dsh`。

## 2. 结论摘要

Review 发现的最高风险集中在四类：

1. **工作区隔离**：`guardPath` 只做 lexical containment，vault 内 symlink 可读写 vault 外；若干按 ID/目录枚举的消费者还会直接跟随 symlink。
2. **审批边界**：deep import Phase 2b 在 Scene 审批后直接改 canonical 对象 aliases/relations；DSH deep import 把范围授权 `confirmed` 硬编码为 true；`NovelCraftService.facades` 暴露若干原始写面。
3. **覆盖与并发正确性**：Scene 编号按文件数分配、结构/正文候选可静默覆盖；atlas 审批前 CAS 在等待期间失效；多处批量写缺少事务化 preflight。
4. **运行时可靠性**：`llm-step` 的 timeout 仅 abort，provider 忽略 signal 时永久挂起；client 有缺失 RPC dispatcher、双重 `RpcResult` 解包、轮询/响应竞态；CI 构建顺序和 workspace 依赖声明不完整。

已确认的 Blocker/P1 已在本轮直接修复并补回归；统一 Git 事务、checkpoint 协议、宿主生命周期、capability API 与发布策略已形成 N32–N36/ADR-0021–0025，后续按依赖顺序实施。

## 3. 已修复

### 3.1 工作区隔离与输入边界

- `vault.guardPath` 增加 lexical + realpath containment；支持尚不存在目标，拒绝有效/悬空 symlink 逃逸；typed `paths()` 另拒绝 vault 内跨 kind symlink。
- `SessionVaultBinder.rootForBook` 只接受单个非空目录名，拒绝 `..`、绝对路径、分隔符和控制字符。
- 全部动态资产构造器集中校验单文件路径段；`store.resolveAsset` 校验显式路径与请求 kind 相容，并统一转译为 `StoreError(PATH_TRAVERSAL)`。
- chapter/candidate 源与 adopt 派生目标在写前复检 symlink；world object、assistant signal、atlas/client wire 与 deep-import trace 引用按限定目录做 containment/运行时校验。
- 目录扫描不再跟随 `.md/.json` symlink 读取 vault 外文件；普通坏 JSON 按文件跳过，安全逃逸仍 fail-closed。
- client inbox action、atlas page/run/signal refs 和归一化坐标增加运行时验证。

### 3.2 审批、CAS 与写入正确性

- deep import Phase 2b 改为“只读 propose → 汇总实际变更 → 独立审批 → CAS apply”；空计划不审批，拒绝/不可用时零 canonical 写，commit 成功后才记录 adopt。
- deep import 在计划和 LLM 调用前请求范围授权，不再自证 `confirmed: true`；范围、Scene adopt、Phase 2b 三次授权互不复用。
- 正常 complete/rejected 闭环把 checkpoint/trace 精确提交为单个 state commit；范围外 staged/unstaged/untracked 文件一律 fail-closed，不再留下永久脏 vault。
- `store.adopt(expectedContentHash)` 在当前 hash 缺失时 fail-closed。
- atlas prompt 修改重算 `content_hash`；atlas adopt/restore/placeholder 在审批后强制复核页面与整条祖先链快照；run JSON 使用唯一独占临时文件原子替换。
- Scene 编号改为现存最大序号 + 1；批量写在首个 write 前完成目标冲突与 frontmatter preflight，并只 stage 精确目标。
- 同标题结构资产、generate/revise 的同章 pending candidate 不再静默覆盖；返修候选采用前复核基线正文 hash，缺失基线章统一报 `BAD_CANDIDATE`。
- `updateObject` 使用统一 frontmatter parser 返回的 body，避免手工 delimiter 切片损坏正文。
- frontmatter parser 按原始 offset 扫描，opening/closing 只接受列 0 delimiter，并逐字节保留 body 的 CRLF/无尾换行。

### 3.3 LLM 与 DSH 运行时

- `llm-step` 用 wall-clock race 保证 provider 忽略 AbortSignal 时仍按时返回；timer 清理且迟到 rejection 被观察。
- retryable provider 错误耗尽后保持 `provider_retryable`，不再误报 `schema_violation`。
- 5 个长时 LLM 工具把 `ToolRunContext.signal` 贯通到 DSH provider。
- workspace manifests 补齐 `context → store`、`dsh → trace`、client UI slots。

### 3.4 Client、发布与 CI

- dispatcher 注册 atlas view/annotation endpoints。
- 修复 `call<T>` 已解包后仍按 `RpcResult<T>` 使用的成功路径崩溃。
- 修复轮询卸载后 zombie schedule、chapter dossier 旧响应覆盖、新旧 modify 参数丢失。
- workspace dependency audit 接入根脚本/CI；CI 使用完整拓扑并包含 `rag-bge`。
- tsdown 迁移 deprecated `external/noExternal` 配置。
- Vitest 升至修复线 3.2.x，依赖审计 critical 清零。
- 文档移除易漂移的硬编码测试数并校正 DSH 工具数。

## 4. 架构裁决（Accepted、implementation pending）/ 已知限制

本节原“待架构裁决”项目已由用户于 2026-08-15 确认为 N32–N36；完整约束见 [`specs/adjudications.md`](../../../specs/adjudications.md) 第八批与 ADR-0021–0025。以下状态表示决策已生效，但实现尚未完成，不得误记为已修复。

### P1 — Git 写事务与提交隔离（N32 / ADR-0021）

采用统一的目标路径级 `VaultWriteTransaction`：调用方声明完整 write set，允许范围外无关 unstaged/untracked，任何预存 staged fail-closed；全量 preflight、目标 CAS、per-vault 跨进程锁、原子文件替换、精确 pathspec stage/commit、提交前 staged/hash 复核。失败只回滚仍等于本事务输出 hash 的文件，外部后续编辑不得覆盖；业务写面禁用 `git add -A`。该改动横跨 store/world/outline/writing/imports，须先落统一 helper 再逐包迁移。

### P2 — Checkpoint/恢复协议（N33 / ADR-0022）

- deep-import 与 map-atlas 采用不可变 workflow run + 逐批结果协议；指纹覆盖源内容、policy、非 secret ExecutionProfile 与 workflow/schema/prompt 版本。
- 批次必须按“结果原子落盘 → checkpoint 提交 → 推进游标”执行；输入变化不得 resume，`force=true` 总是新建 workflow。
- canonical apply 保留逐目标 CAS/provenance；已提交写入只补状态，未写 adopt 重新审批，allowed-once 不持久化复用。
- 恢复若仍需调用 LLM，只对剩余批次重新请求范围/成本授权，不重复已完成批次。

### P2 — DSH 宿主生命周期 seam（N34 / ADR-0023）

- `session/created` 仅按绝对 cwd 绑定已有 vault；插件加载/HMR 扫描 live sessions；`session/disposed` 以 vault 引用计数释放 watcher。
- 守望由 Node 托管、与浏览器断线无关，按活跃 vault 启停；持久化完成/到期时间与配置指纹，过期最多补跑一次，每 vault/radar 防重入且每 radar 一 job。不承诺 Node 停止时 24/7 运行。
- 编排启动时解析不可变 ExecutionProfile，deep-import/writing/atlas 内部步骤统一继承 `llm.yml` timeout 等默认值，请求级 override 优先。
- Node engines 对齐 DSH：`^22.19.0 || >=24.0.0`；CI 至少覆盖 22.19 与 24。

### P2 — 原始 facades 权限面（N35 / ADR-0024）

公开服务面改为安全默认的 `capabilities.read/propose/adoptGuarded`；raw adopt/merge/write orchestration 移入 internal 且不从主 exports 导出。旧 `facades` 最多保留 deprecated 的安全别名。该约束用于防止正常插件误绕 approval，不宣称能隔离同进程恶意代码；直接 import 核心包的进程级治理不属于该 API 的安全承诺。

### P2/P3 — 发布策略与可选模型依赖（N36 / ADR-0025）

- M4 仅作 monorepo/DSH 插件源码分发，各 workspace `private: true`，不发布 npm 包、不承诺公共 semver；仓库当前可为 PUBLIC，npm workspace private 与仓库可见性不冲突，且仓库可见性不由 N36 强制。
- `@novelcraft/rag-bge` 保持仓内 optional adapter；默认安装 profile 省略 optional，显式 BGE profile 才安装并单独 test/audit。Transformers/ONNX/Sharp 链的 4 个无修复 high 继续登记，不做破坏性 override。
- Node 与 CI 版本政策并入 N34，不再维持 Node 20 支持口径。

### P3 — Client/工具体验债（无需 ADR）

- Inbox 先移除未实现的键盘 1–4 承诺；2/3 交互语义另列产品项。
- MapAtlas save 增加本地 revision/dirty generation，防止旧成功响应覆盖后续编辑；run 读写 guard root 对称性作为实现加固项。
- frontmatter 对非法缩进 closing delimiter 先提供只读 lint；迁移必须预览、审批并形成 Git commit。
- `llm_step` 增加 `truncated` 标志；工具异常逐步统一为 typed error envelope。

## 5. 安全与依赖审计

- 未发现真实 secret；仅 vendored/upstream 文档示例占位值。
- 核心包未发现 DSH runtime import。
- DSH credentials 只消费宿主能力；`.assistant/llm.yml` 不保存 Key。
- 生产依赖的 4 high 均在可选 BGE 链；无可用自动修复。
- Vitest 直接 critical 已通过升级清除。

## 6. 最终验证

- `npm run check:deps`：通过；22/22 parser self-tests，审计 123 个 `src` 文件，workspace bare imports 均已声明。
- `npm test`：通过；15 个带测试的 workspace 共 **795/795** 项。
- `npm run typecheck`：通过；全部声明 typecheck 的 workspace 零错误。
- 拓扑 build：通过；15 个可构建包按 `vault → … → client` 全部成功，data-only `preset` 无 build script。
- `npm audit --omit=dev`：4 high / 0 critical；`npm audit`：4 high / 0 critical，均为已记录的可选 BGE 链。
- `git diff --check`：通过；staging 为空，无 debug/probe 临时文件。
- 核心包 DSH import/dependency gate：通过；DSH 接触面仍仅在 `dsh`/`client` 两个宿主包。

## 7. 变更纪律

本轮未 commit、未 push、未修改父仓库 `ai-writing-assist`，未执行破坏性 Git 操作。
