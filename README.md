# novelAssist-dsh

**NovelCraft M4** —— 「自主智能式作家助手」的 DSH 插件族 monorepo。旧 FastAPI/PG/Vue 引擎
已于 2026-08-14 退役(归档于 annotated tag `old-engine`); 本仓库只承载 M4 纯 TS 确定性
核心 + DSH 挂载适配 + web 客户端。

- 形态: fork deepseek-harness 的独立仓库(ADR-0017), remote origin =
  https://github.com/FengHuoLinShan/novelAssist-dsh.git(PUBLIC)
- 分支: `main`(唯一主干); 迁移基点 annotated tag `dsh`; 旧引擎归档 tag `old-engine`

## 结构

| 目录 | 内容 |
|---|---|
| `packages/novelcraft/` | 16 个纯 TS 包: vault/store/llm-step/writing/imports/world/outline/memory/context/rag/rag-bge(可选 BGE 嵌入后端, N22)/assistant(13 核心)+ dsh(唯一 DSH 接触面)+ client(双面包 UI)+ trace(trace contract 框架)+ preset |
| `specs/` | R0 规格: assets(资产 schema)/ prompts(catalog 34 spec)/ rules(store-rules R1–R64 + policy-defaults)/ adjudications(五批裁定, N1–N25) |
| `docs/adr/` | ADR-0016(M4 重写)/ 0017(仓库形态 + 挂载)/ 0018(DSH 共享层政策) |
| `docs/agent/dsh-rebuild/` | M4 交接/设计/验收文档(单一事实入口: 跨会话交接.md; 总进度: STATUS-M4.md) |
| `starter/` | 一键安装 starter |

## 核心原则

- **文件是唯一真相**: 每书一个 git 仓库(vault), 资产 = frontmatter 文件 + git commit; 派生
  索引任何时刻可全量重建; git 本身就是回滚面。
- **核心包零 DSH 运行时依赖**: 内容手/编排为纯 TS 确定性库, DSH 接触面唯一收敛在
  `@novelcraft/dsh`。
- **adopt 必过 approval**: 采用类资产写入由助手 agent 经 DSH approval(fail-closed,
  allowed-once 只放行一次); 客户端 RPC 通道(loopback)只读信号 + 记录决定, 不写资产。
- **内容手受控**: 每个 llm_step 带 output_schema/预算/超时/journal, 由确定性工作流编排。

## 快速开始

```sh
npm install
npm test            # 440 测试全绿
npm run typecheck   # 零错误
npm run build --workspaces   # 全部分包构建(注意: 需按拓扑序, 见 docs/agent/dsh-rebuild/跨会话交接.md)
```

## 文档

- 架构事实/安全边界/坑清单/复现命令: `docs/agent/dsh-rebuild/跨会话交接.md`
- 总进度: `docs/agent/dsh-rebuild/STATUS-M4.md`
- seam 契约: `packages/novelcraft/README.md` + `dsh/README.md` + `client/README.md`
- 设计: `docs/agent/dsh-rebuild/自主智能式作家助手设计.md`(D1–D25)
