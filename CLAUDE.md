# CLAUDE.md

本文件是 novelAssist-dsh 编码 Agent 的开发导航; 硬约束、协作协议和停止条件以 `AGENTS.md` 为准。
重大架构决定需用户确认或 ADR。

## 包结构(`packages/novelcraft/*`, 16 包)

| 层 | 包 | 职责 |
|---|---|---|
| 事实层 | vault / store / world / memory | 工作区初始化与路径、frontmatter 校验/adopt+commit/索引重建、世界对象与记忆 |
| 结构层 | outline | threads/arcs/Scene 与结构计划 |
| 辅助层 | imports / context / rag / rag-bge(可选) / writing | 六阶段深度导入、确定性上下文编译、检索(BM25+精排+可选 BGE 向量, L0/L1/L2)、正文审查/修订 |
| 编排核心 | llm-step / trace / assistant | 内容手原语(schema/预算/超时/journal)、trace contract 事件/断言/mock、信号/收件箱/校准 |
| DSH 接触面 | dsh(唯一) | DshProvider/ApprovalGate/domain/jobs/vault 绑定/tools 14 工具 |
| 客户端 | client | 双面包: node 半身 loopback RPC + 浏览器半身(宠物/收件箱/剧情地图/写作台) |
| 发布 | preset | skills/presets 校对 |

## 模型分工

- 探索任务交给 Explore 子代理(只读, 不带文件); 主会话接收结论。
- 执行交给子代理(deepseek-v4-flash)后, 主会话必须 review 其产出再集成。

## 常用命令

```sh
npm test                    # 全仓 440 测试
npm run typecheck           # 全仓零错误
npm test -w @novelcraft/<pkg>
npm run build --workspaces  # 注意拓扑序: vault→trace→store→llm-step→rag→rag-bge→memory→world→context→outline→assistant→writing→imports→dsh→client→preset
```

## 关键约定(实现前必读)

- seam 契约: `packages/novelcraft/README.md` + `dsh/README.md` + `client/README.md`;
  核心包零 DSH 依赖, 接触面唯一收敛在 `@novelcraft/dsh`。
- 每书一个 vault(git 仓库), 文件唯一真相; 资产 frontmatter 字段表以 `specs/assets/*.md` +
  `specs/adjudications.md` 为权威。
- 测试 = vitest 行为契约, 断言注释引规则/裁定编号; 阶段函数用 MockProvider/MockApproval 驱动。
- 权威文档: `docs/agent/dsh-rebuild/跨会话交接.md`(单一事实入口)、
  `STATUS-M4.md`(总进度)、`自主智能式作家助手设计.md`(D1–D25)、
  `docs/adr/0016|0017|0018`(M4 重写/仓库形态/共享层政策)。

## 旧引擎已退役

旧 FastAPI/PG/Vue 引擎(backend/frontend-console/deploy 等)已随退役删除, 归档于 annotated
tag `old-engine`; 需要旧实现时 `git checkout old-engine -- <path>` 只读参考, 不回写。
