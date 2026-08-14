# NovelCraft Starter

M4 重构(ADR-0016)的一键安装入口: **装完 DSH, 装好 profile, 开始写书**。

## 前置

- Node ≥ 22
- DSH `@deepseek-ai/dsh` **0.1.0-rc.6**(D21 锁定; 兼容矩阵见下)
- 作者在 DSH 侧保存模型连接(编排脑默认 deepseek-v4-flash + high, D13)

## 安装(发布后)

```sh
# 1. 安装插件族(发布后): dsh 是唯一 DSH 接触面(挂载阶段 A, ADR-0017),
#    其余核心包是它的纯 TS 依赖, 随 npm 自动拉取。
dsh plugin add @novelcraft/dsh @novelcraft/preset @novelcraft/client

# 2. profile patch 加一行(见 dev-profile/cordis.patch.yml):
#    plugins:
#      novelcraft: { name: "@novelcraft/dsh", config: { vaultsDir: ~/Novels } }

# 3. 装 agent presets
#    packages/novelcraft/preset/presets/novelcraft-* → $DSH_HOME/.agent-presets/<name>/

# 4. 开 DSH web, 说「新建一本书」——插件会在 ~/Novels/<书名>/ 建工作区
```

## 开发模式(本仓库内)

挂载阶段(A)已完成并验证:

- 单元测试: `cd packages/novelcraft/dsh && npm test`(31 条 seam 行为契约,
  真实 cordis/storage/storage-json/storage-domain/llm + 假 approval/jobs/credentials)。
- 集成 demo: `node scripts/m5-mount-demo.mjs` 纯 node 跑通挂载全链
  (vault 初始化 → 索引 → 收件箱 → llm_step → 审批采用 → 雷达 job → 会话回查)。
- 进 DSH profile 热开发: 在 profile 的 `cordis.patch.yml` 注入 `@novelcraft/dsh`
  (见 `dev-profile/` 示例); client UI 待 client 阶段(B)。

## 一句话开始

> 「新建一本书, 导入我拖给你的 Word 文本, 做一次深度导入, 然后陪我把这一卷写完。」

助手会: 建工作区 → 停靠章节 → 计划协商 → 六阶段导入 → 去重报告一次确认 →
六雷达守望 → 写作中参照/写作后评审 → 修订候选采用(全部经 approval)。

## 兼容矩阵(D21)

| 依赖面 | 版本 | 备注 |
|---|---|---|
| DSH | 0.1.0-rc.6 | 锁版本; 升级窗口随官方破坏性变更公告单独评估 |
| seam: llm / approval / storage-domain / jobs / credentials / tools | rc.6 行为 | **挂载阶段 A 已实现**于 `@novelcraft/dsh`(peer deps); 升级前跑其 31 条行为契约 |
| seam: client-modules / schedule | rc.6 行为 | client UI 待 client 阶段(B); 低频巡检默认关(D6) |
| Node | ≥ 22 | |
| git | 任意现代版本 | 每书一个 git 仓库(版本真相) |

## 数据与安全(继承设计文档)

- 每书一个工作区文件夹(D17); 版本 = git commit; 已采用不硬删。
- Key 只存 DSH credentials, 不进工作区文件(D13/§22.5)。
- 写正史永远过 DSH approval(fail-closed); 编排脑可见原文(D14, 原文不进任何产出)。
- 无账号隔离(单用户自用, D11); 多书 = 多工作区物理分区。
