# @novelcraft/preset

NovelCraft 的 source-only profile bundle(ADR-0016 §22.3): 9 册 Skill + 4 套 agent preset。
当前包是私有工作区发布物, 不把 `plugin add` 冒充安装完成。

## 组成

- `skills/novelcraft-*`(9 册): core / imports / interaction / map / ops / outline /
  rag-context / world / writing。由 preset 内的 DSH 原生 `skill-filesystem` provider 发现,
  由 `tool-skill` consumer 注入目录并按需加载正文。
- `presets/novelcraft-{author,companion,import-review,worldbuilder}`(4 套):
  author/import-review/worldbuilder 只挂原生 Skill consumer 与 NovelCraft 领域工具;
  companion 是 D23 明确延期占位, 不提供 RP、Shell 或文件能力。

## 与核心包的分工

- preset 只携带知识、人设和 DSH 原生 Skill 接线, 不携带领域实现;
- 实现逻辑在其余 `@novelcraft/*` 包(纯 TS 确定性核心 + DSH seam, 见 monorepo README);
- skills 已逐册校对为 M4 语义(工作区路径/确定性函数引用/git 与 approval 纪律,
  不再出现 HTTP 端点或 async_tasks 描述; 2026-08-14 校对完成, 9/9)。

## 当前使用方式

DSH agent preset root 直接指向本包的 `presets/` 目录; preset 以 `baseUrl` 相对定位同包
`skills/`。不要只复制单个 preset 子目录, 否则会破坏该相对关系。`npm test -w
@novelcraft/preset` 使用锁定的 DSH rc.8 provider 验证 9/9 枚举和正文加载。
