# packages/novelcraft

M4 插件族 monorepo(ADR-0016 §22.3)。核心规则: **插件核心逻辑 = 纯 TS 确定性库
(不依赖 DSH 运行时, 可用 vitest 直测); Cordis/DSH seam 适配层后置(R1 不写)**。

## R1 范围(内核)

| 包 | 职责 | 规格来源 |
|---|---|---|
| `vault` | 工作区初始化、路径规范、读写门禁 | specs/rules/store-rules.md §8 + specs/adjudications.md N1/N2 + 设计文档 §22.2 |
| `store` | frontmatter 校验、adopt+commit、CAS、merge/split/attach_alias、索引重建 | specs/rules/store-rules.md R1–R64(可测部分)+ specs/adjudications.md 两批 |

## 工程约定

1. 纯 TS, strict 模式; 无 DSH 依赖(R1 阶段); git 操作用 `node:child_process` 调 git CLI。
2. 测试 = vitest, 每个行为契约一条测试, 断言写进测试注释引规则编号(R#)。
3. 索引 = 纯函数「扫描文件 → 索引 JSON」; sqlite/ctx.storage 适配层留到插件挂载阶段。
4. 所有写操作先校验再落盘; adopt 前检查工作区脏状态(CAS)。
5. 资产 frontmatter 字段表以 specs/assets/*.md + specs/adjudications.md 为唯一权威。
