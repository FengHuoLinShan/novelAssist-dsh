# ADR-0025 — 源码分发与运行时画像(monorepo/DSH 插件源码分发, 不 npm 发布)

- **状态**: Accepted(2026-08-15, 用户确认裁定 N36); **implemented and verified**;
  Node 版本条款于 2026-08-24 被 N37 **部分取代**
- **日期**: 2026-08-15
- **取代/补充**: 补充 ADR-0017(独立 fork 仓库形态)的分发方式与 ADR-0023(N34, Node
  engines/CI)的发布侧约束; 对齐 N21/N22(可选包与嵌入模型策略)。**不取代**任何现有 ADR。
- **设计依据**: N36(2026-08-15 用户确认; 已录入 `specs/adjudications.md` 第八批)、
  ADR-0017(仓库形态/构建链)、ADR-0023(N34 engines 与 CI)、N21/N22(RAG 三层与
  `@novelcraft/rag-bge` 可选包)、`docs/agent/dsh-rebuild/跨会话交接.md`(构建拓扑序)。

## 背景

ADR-0017 定了「独立 fork 仓库」形态, 但分发/发布方式未裁定。若不裁定, 存在三条歧路:

1. **npm 发布与否**: 若发布, 就要承担公共 semver、registry 供应链与「旧版本永远可拉」
   的兼容义务; 单用户自用的 M4 没有这个需求。
2. **可选依赖默认装不装**: `@novelcraft/rag-bge`(transformers.js, N22)若随默认安装,
   安装体积与 `npm audit` 审计面都会被拖大; 但它是 N21 的 L2 向量召回能力, 不能丢。
3. **依赖审计的已知风险怎么处理**: 依赖树存在 high 级漏洞且上游暂无修复, 若用
   `overrides` 破坏性强修, 可能打破与 DSH rc 线的兼容(ADR-0018 的窄缝政策)。

## 决策

### 1. M4 仅源码分发, 不 npm 发布

- M4 的唯一分发形态 = **monorepo / DSH 插件源码**(用户 clone 仓库后本地安装加载),
  **不 npm 发布**任何 `@novelcraft/*` 包。
- 各 workspace 声明 **`private: true`**, 作为「禁止 publish」的发布标志。

### 2. 仓库可见性与 workspace private 不矛盾

- **仓库可见性不在本 ADR 强制范围**; PUBLIC 是当前允许事实(公开源码, 便于克隆/协作/
  审计), 与 npm workspace private 不矛盾: `private: true` 是 **npm 发布标志**(禁止
  `npm publish` 该 workspace), 不是仓库可见性标志; 二者语义不同、可同时成立。公开仓库
  + private workspace = 源码可见但不可发布。

### 3. 不承担公共 semver

- 版本号仅供本地/内部引用(workspace 依赖解析、锁文件), **不承诺公共 semver 兼容
  语义**; 不发布即无外部消费者, 无兼容义务。

### 4. 保留可复现构建链与所需本地构建产物

- 源码是唯一真相; **保留可复现构建链**(构建按拓扑序 vault→trace→store→llm-step→…,
  见跨会话交接.md)与**本地加载运行所需的构建产物**, 便于直接加载运行, 不依赖发布物。
- **不强制 dist 提交进 git**: 是否跟踪 dist 由实施期/仓库政策定, 本 ADR 不强制。

### 5. Node 运行时与 CI 同 N34

- **N37 补充裁定(当前约束)**: Node engines 声明 **`>=24.11.0`**，默认与 BGE CI
  均固定 **Node 24.11.0**。此变更只取代 N34/N36 的 Node 版本与 matrix 条款。
- **原 N36 记录(已部分取代)**: `^22.19.0 || >=24.0.0`，CI 覆盖 22.19 / 24。

### 6. 可选依赖策略: 默认 omit optional, 显式 BGE profile 单独验证

- `@novelcraft/rag-bge`(transformers.js)保持 optionalDependencies + 动态 import
  (N21/N22)。
- **默认安装 profile 使用 `omit=optional`**: 默认安装不含可选包, 体积与审计面最小。
- **显式 BGE profile 才 include optional**, 并在该 profile 下**单独跑 test 与 audit**:
  **BGE 测试必须通过**(BGE 能力有独立验证门, 不进默认门; 默认门不含 BGE)。

### 7. 依赖审计与基线比较: 既知 4 high / 0 critical, 禁止新增

- 依赖审计**被采集并与基线比较**: 基线 = **既知 4 high / 0 critical**; 只允许基线内
  既知 4 high 存在, **禁止新增 high/critical**(新增即审计失败); **不要求零漏洞**。
- 4 high 均上游暂无修复 = **已知风险**: 登记记录(风险清单/文档), **不阻塞**默认安装
  与发布流程(本就不发布), 不引入破坏性修复。

### 8. 约束: 无破坏性 override, 不移出 monorepo, 运行时默认 embedding off

- **不使用破坏性 `overrides`** 强修依赖(保护与 DSH rc 线的兼容, 对齐 ADR-0018 窄缝
  政策); high 漏洞以登记跟踪代替。
- **不把 rag-bge 移出 monorepo**(不拆独立仓库/独立发布通道)。
- 运行时**默认 embedding off**: 仅当 llm.yml 显式启用(`embedding: bge-local-v1`,
  N21)才尝试加载; **缺包全链自动降级**(L2 失败回退文本检索, 逐层静默降级, 检索永不
  阻断写作, N21/N22), 缺失只留 `degraded` 标记。

## 失败关闭与边界

- 可选包缺失 → embedding 功能不可用但不炸链: 降级留痕(`embedding_failed`), 默认路径
  根本不含该依赖(omit optional)。
- **不承诺**: 依赖零漏洞(基线为既知 4 high / 0 critical, 但禁止新增 high/critical);
  不承诺公共 semver 兼容(§3); 不承诺 npm registry 分发(§1)。
- `private: true` 被误移除 = 发布意图变化, 需重新裁定后再动, 不作为常规操作。

## 未采用方案

- **A. npm 发布全部包**: 承担公共 semver 与供应链义务, 与单用户自用不符; 未采用。
- **B. 默认安装全部可选依赖**: 拖大体积与审计面, 4 high 的暴露面随之扩大; 未采用
  (默认 omit optional)。
- **C. 用破坏性 overrides 强修 high 漏洞**: 可能破坏与 DSH rc 线的兼容(ADR-0018),
  且上游无修复时无效; 未采用(登记跟踪)。
- **D. 在本 ADR 强制仓库可见性**: 可见性不在本 ADR 强制范围——本 ADR 只约束 workspace
  `private: true` 的发布语义; PUBLIC 是当前允许事实, 不在此否决 private 仓库。
- **E. rag-bge 拆出独立仓库/独立版本线**: 移出 monorepo, 增加分发与版本协调成本;
  未采用(§8)。

## 影响

- 工程: workspace `package.json` 保持 `private: true`，engines 当前为 `>=24.11.0`
  (N37)；CI 默认 profile `omit=optional` + 显式 BGE profile 单独 test/audit job
  (BGE 测试必须通过); audit 采集并与基线比较(4 high / 0 critical, 禁止新增
  high/critical); 风险清单登记既知 4 high。
- 文档: 安装说明区分默认 profile 与 BGE profile; 声明「PUBLIC 为当前允许事实(可见性
  不在本 ADR 强制范围)、workspace private、不发布、不承担公共 semver」。
- 验证要求: CI 固定 Node 24.11.0；默认安装断言不含可选包；BGE profile 单独
  test **必须通过**、audit 与基线比较(4 high / 0 critical, 新增 high/critical 即失败);
  缺包降级行为有 vitest 契约(断言注释引 N36, 引用 N21/N22 降级语义);
  完成标准 `npm test` 全绿 + `npm run typecheck` 零错误。
- 文档: N36 已录入第八批；Node 版本补充裁定 N37 已录入第九批并在 ADR 索引标记部分取代。

## 实施期开放项

1. 4 high 的登记位置(如 `docs/agent/dsh-rebuild/` 下风险清单或 STATUS-M4 风险段)留
   实现期定; 「不破坏性修复、登记跟踪」已是裁定。
