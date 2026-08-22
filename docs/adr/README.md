# 架构决策索引(M4 / novelAssist-dsh)

本目录只保留 novelAssist-dsh(M4 DSH 插件重写)的架构决策。旧 FastAPI/PG/Vue 引擎的 ADR
(0001–0014 及主题 ADR)已随旧引擎退役移除, 归档于 annotated tag `old-engine`。

| ADR | 状态 | 当前约束 |
|---|---|---|
| [ADR-0016](0016-m4-dsh-plugin-rewrite.md) | Accepted | M4 彻底重写: NovelCraft 作为 DSH 插件族 + 文件夹真相产品, 取代侧车路线。 |
| [ADR-0017](0017-m4-repo-form-and-mounting.md) | Accepted | 独立 fork 仓库形态、挂载阶段授权、构建链以 npm rc.6 官方包为准。 |
| [ADR-0018](0018-m4-dsh-shared-layer-policy.md) | Accepted | DSH 共享层默认不改、窄缝例外(pnpm patch / 最小 fork)+ 上游回馈四条纪律。 |
| [ADR-0019](0019-structure-relation-model.md) | Accepted | 结构资产统一 relations 有向对(对齐 N11)+ 跨类关系索引; related_*_ids 降级为兼容投影, 只做加法渐进收敛。 |
| [ADR-0020](0020-map-atlas-m4-file-model.md) | Accepted | 世界地图册(map atlas)M4 文件模型: world/atlas/** 文件真相 + 无生图边界 + prompt_only 不可 adopt + 空页占位 + 标签 L1 队列 + 本机路径图片导入(N28/N29)。 |
| [ADR-0021](0021-vault-write-transactions.md) | Accepted / implemented & verified | Vault 目标路径级写事务：声明 write set、staged fail-closed、CAS、精确提交、条件回滚与跨进程锁(N32)。 |
| [ADR-0022](0022-resumable-workflow-runs.md) | Accepted / implemented & verified | deep-import/map-atlas 不可变 run 与逐批恢复协议；force 新 run；剩余 LLM 批次重新授权(N33)。 |
| [ADR-0023](0023-dsh-lifecycle-execution-profile.md) | Accepted / implemented & verified | DSH session→vault 生命周期、Node 托管守望、单次补跑及统一 ExecutionProfile/Node matrix(N34)。 |
| [ADR-0024](0024-capability-api-boundary.md) | Accepted / implemented & verified | NovelCraftService 公开 capability API 安全默认，raw 写面内部化；不宣称同进程恶意代码隔离(N35)。 |
| [ADR-0025](0025-source-distribution-runtime-profile.md) | Accepted / implemented & verified | M4 源码分发、workspace private、DSH Node 基线与默认省略 optional BGE 的安装策略(N36)。 |

## 状态约定

- **Proposed**：尚未批准或尚未成为实现约束。
- **Accepted**：已批准，后续实现必须遵守。
- **Implemented**：Accepted 决策已经在当前代码兑现。
- **Partially superseded**：部分原决策已被后续实现或决策取代。
- **Superseded**：原决策已被后续 ADR 完整取代。
- **Index**：细化导航，不制造第二个权威决策源。
