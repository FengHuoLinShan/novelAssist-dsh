# NovelCraft Starter

M4 重构(ADR-0016)的一键安装入口: **装完 DSH, 装好 profile, 开始写书**。

## 前置

- Node ≥ 22
- DSH `@deepseek-ai/dsh` **0.1.0-rc.8**(D21 锁定; 兼容矩阵见下)
- 作者在 DSH 侧保存模型连接(编排脑默认 deepseek-v4-flash + high, D13)

## 当前 source-only 挂载

```sh
# 1. 在 DSH 开发 profile 挂本仓库 workspace 的 @novelcraft/dsh 与 @novelcraft/dsh-client。
# 2. 用 rc.8 patch-list 同时插入宿主与 UI 行(见 dev-profile/cordis.patch.yml)。
# 3. 将 DSH agent preset 的 system root 指向
#    <repo>/packages/novelcraft/preset/presets；不要只复制单个 preset 子目录。
# 4. 打开已初始化并绑定到 session 的 NovelCraft Vault。
```

## 开发模式(本仓库内)

挂载阶段(A)已完成并验证:

- 单元测试: `cd packages/novelcraft/dsh && npm test`(seam 行为契约,
  真实 cordis/storage/storage-json/storage-domain/llm + 假 approval/jobs/credentials)。
- 集成 demo: `node scripts/m5-mount-demo.mjs` 纯 node 跑通挂载全链
  (vault 初始化 → 索引 → 收件箱 → llm_step → 审批采用 → 雷达 job → 会话回查)。
- 进 DSH profile 热开发: 在 profile 的 `cordis.patch.yml` 注入 `@novelcraft/dsh`
  与 `@novelcraft/dsh-client`(见 `dev-profile/` 示例)。

## 一句话开始

> 在「写作台 → 导入」选好 `.txt/.md` 后说:「导入刚才的手稿, 做一次深度导入, 然后给我下一章提案。」

当前可执行链是: session 已绑定 Vault → `.txt/.md` 会话收据停靠 → 六阶段导入 → 收件箱复核 →
下一章提案/正文候选 → 候选独立审查 → DSH approval 采用。章节工作区负责长正文编辑、Git
历史/差异/恢复和审查结果定位；当前正文审查、按 finding 定向返修及候选采用/拒绝也都可由对话工具触发。
浏览器附件承运、自然语言新建多书和 RP 尚未形成公开端到端入口, 不在这里预先承诺。

## 兼容矩阵(D21)

| 依赖面 | 版本 | 备注 |
|---|---|---|
| DSH | 0.1.0-rc.8 | 精确锁版本; 升级窗口随官方破坏性变更公告单独评估 |
| seam: llm / approval / storage-domain / jobs / credentials / tools | rc.8 行为 | **挂载阶段 A 已实现**于 `@novelcraft/dsh`; 升级前跑全仓行为契约 |
| seam: client-modules / schedule / Skill | rc.8 行为 | client UI 与 9 册原生 Skill 已实现; 低频巡检默认关(D6) |
| Node | ≥ 22 | |
| git | 任意现代版本 | 每书一个 git 仓库(版本真相) |

## 数据与安全(继承设计文档)

- 每书一个工作区文件夹(D17); 版本 = git commit; 已采用不硬删。
- Key 只存 DSH credentials, 不进工作区文件(D13/§22.5)。
- 写正史永远过 DSH approval(fail-closed); 编排脑可见原文(D14, 原文不进任何产出)。
- 无账号隔离(单用户自用, D11); 多书 = 多工作区物理分区。
