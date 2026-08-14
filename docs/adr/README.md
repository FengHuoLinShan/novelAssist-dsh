# 架构决策索引(M4 / novelAssist-dsh)

本目录只保留 novelAssist-dsh(M4 DSH 插件重写)的架构决策。旧 FastAPI/PG/Vue 引擎的 ADR
(0001–0014 及主题 ADR)已随旧引擎退役移除, 归档于 annotated tag `old-engine`。

| ADR | 状态 | 当前约束 |
|---|---|---|
| [ADR-0016](0016-m4-dsh-plugin-rewrite.md) | Accepted | M4 彻底重写: NovelCraft 作为 DSH 插件族 + 文件夹真相产品, 取代侧车路线。 |
| [ADR-0017](0017-m4-repo-form-and-mounting.md) | Accepted | 独立 fork 仓库形态、挂载阶段授权、构建链以 npm rc.6 官方包为准。 |

## 状态约定

- **Proposed**：尚未批准或尚未成为实现约束。
- **Accepted**：已批准，后续实现必须遵守。
- **Implemented**：Accepted 决策已经在当前代码兑现。
- **Partially superseded**：部分原决策已被后续实现或决策取代。
- **Superseded**：原决策已被后续 ADR 完整取代。
- **Index**：细化导航，不制造第二个权威决策源。
