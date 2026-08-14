# NovelCraft Starter

M4 重构(ADR-0016)的一键安装入口: **装完 DSH, 装好 profile, 开始写书**。

## 前置

- Node ≥ 22
- DSH `@deepseek-ai/dsh` **0.1.0-rc.6**(D21 锁定; 兼容矩阵见下)
- 作者在 DSH 侧保存模型连接(编排脑默认 deepseek-v4-flash + high, D13)

## 安装(发布后)

```sh
# 1. 安装插件族(发布后)
dsh plugin add @novelcraft/vault @novelcraft/store @novelcraft/llm-step \
  @novelcraft/imports @novelcraft/world @novelcraft/outline @novelcraft/writing \
  @novelcraft/memory @novelcraft/rag @novelcraft/context @novelcraft/assistant \
  @novelcraft/preset @novelcraft/client

# 2. 装 agent presets
#    packages/novelcraft/preset/presets/novelcraft-* → $DSH_HOME/.agent-presets/<name>/

# 3. 开 DSH web, 说「新建一本书」——插件会在 ~/Novels/<书名>/ 建工作区
```

## 开发模式(本仓库内)

在 DSH profile 的 `cordis.patch.yml` 注入本仓库各包的源码入口(见 `dev-profile/`
示例), 即可在 monorepo 内热开发。

## 一句话开始

> 「新建一本书, 导入我拖给你的 Word 文本, 做一次深度导入, 然后陪我把这一卷写完。」

助手会: 建工作区 → 停靠章节 → 计划协商 → 六阶段导入 → 去重报告一次确认 →
六雷达守望 → 写作中参照/写作后评审 → 修订候选采用(全部经 approval)。

## 兼容矩阵(D21)

| 依赖面 | 版本 | 备注 |
|---|---|---|
| DSH | 0.1.0-rc.6 | 锁版本; 升级窗口随官方破坏性变更公告单独评估 |
| seam: storage domain / jobs / scope / credentials / approval / client-modules | rc.6 行为 | 挂载阶段依赖; 升级前跑契约门禁(§15) |
| Node | ≥ 22 | |
| git | 任意现代版本 | 每书一个 git 仓库(版本真相) |

## 数据与安全(继承设计文档)

- 每书一个工作区文件夹(D17); 版本 = git commit; 已采用不硬删。
- Key 只存 DSH credentials, 不进工作区文件(D13/§22.5)。
- 写正史永远过 DSH approval(fail-closed); 编排脑可见原文(D14, 原文不进任何产出)。
- 无账号隔离(单用户自用, D11); 多书 = 多工作区物理分区。
