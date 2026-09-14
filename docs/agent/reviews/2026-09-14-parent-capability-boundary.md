# 父仓库能力边界勘察(2026-09-14, 基线 `4db3df9b6`)

> 方法: 两个只读勘察子代理分头摸父仓库 `ai-writing-assist`(后端能力面 / 前端·产品·部署面),
> 本仓侧对载荷数字做了复核抽查。2026-09-14 又从两仓当前代码、父仓机器清单、
> 远端 ref 与公网只读接口独立复算; 本文已按复算结果订正, 见 §7。
> 父仓库全程只读(铁律 8); 本文引用的父仓状态以 2026-09-14 HEAD `4db3df9b6` 为准,
> 后续引用须重新核实。本文是 N58/M14(后续开发计划 §4h)的依据文档, 数字重审结论
> 已同步《能力图-ai-writing-assist.md》头部注记与台账 §6.1/§6.25。

## 0. 结论一句话

父仓已从「工程验证系统」进化为**挂公网(novel.zhh.se)的双入口 Alpha 产品**(作者工作台 +
RP 私人故事), 后端能力边界显著外扩: 端点 412→519、表 100→115、任务 handler 37→47、
ADR 25→32; 新增三大全新能力域(匿名公开 RP、公开只读演示及登录后可编辑副本、世界库·共创·评审治理)并在
**既有** `story/continuity` 模块上落成时空连续性四阶段扩展——后者与本仓 M13-B 刚落地的
八项确定性检测器正面收敛, 是 M14 对齐批的首要对照对象。

## 1. 基线推进与数字重审

| 维度 | `8c1516daf`(能力图基准) | `fede3bd72`(N52 对齐点) | `4db3df9b6`(本次) | 口径 |
|---|---|---|---|---|
| HTTP 端点 | 412 | 425 | **519** | router 装饰器 `@get/@post/...` 于 backend/{app,modules,...}(排除 .venv/tests); 本仓独立复核吻合 |
| ORM 表 | 100 | 101 | **115** | 唯一 `__tablename__` 赋值(排除 tests)=115; 迁移文件 46→56, +15 张具名新表 0 删除(名单经评审逐张复核吻合) |
| 任务 handler | 37 | 37 | **47** | `@task_handler(` 注册调用(排除 registry.py docstring 示例) |
| ADR | 25 | 27 | **32** | docs/adr/ 下 md 文件(除 README; 含 7 篇无编号主题 ADR); 本仓独立复核吻合 |
| 路由文件 | 19 | 19 | **20** | 含 `APIRouter` 的 backend py 文件(新增 = modules/assistant/api.py); 本仓独立复核吻合。注意: 能力图 §0 的「15 条前端一级路由」是另一维度, 勿混 |

父仓当前 `scripts/check_architecture_docs.py` 另独输出 **9 个业务模块 / 115 张 ORM 表 /
47 个 task handler / 16 条前端路由 / 32 篇 ADR**。「20 个后端路由文件」与「16 条前端
路由」是两种口径, 不可互换。

推进节奏: `8c..fede3bd72`(121 commits)后端近乎冻结(+13 端点, 重心在前端/CI/RP);
**`fede3bd72..HEAD`(274 commits)是后端增量主体(+94 端点; 8c 以来共 +107, 几乎全部落在
此段)**。只更新到 fede3bd72 的基线会严重低估后端漂移。

新增 7 篇 ADR: 0018 versioned-author-source-context-for-rp、0019 local-theme-resource-packages
(纯前端)、0020 world-library-topics-and-workspace、0021 world-cocreation-session-persistence、
0022 world-review-ownership、0023 bounded-agent-runtime、0024 anonymous-public-demo-rp。

> **两仓 ADR 撞号警示(N58 纪律 3, 评审修正: 全段撞号)**: 父仓与本仓 ADR 编号独立,
> 父仓本轮新增的 **0018–0024 七篇与本仓同号段 0018–0024 全部同号不同义**——本仓
> 0018=共享层政策/0019=结构关系模型/0020=地图册文件模型/0021=vault 写事务/
> 0022=resumable workflow runs(批 B 对照锚点)/0023=deep-import job 托管/0024=capability
> 三分法。任何文档/注释/裁定引用 ADR 编号必须带「父仓/本仓」限定, 违者 review 必修。

## 2. 后端能力增量(按域)

### 2.1 三大全新能力域 + 既有模块四阶段扩展(`fede3bd72..HEAD`)

1. **匿名公开演示 RP**(父仓 ADR-0024, `1afc5561a`/`91971f7f5`/`fc35d51e7`):
   免注册匿名账号体验固定作品版本的 RP。`POST /api/auth/anonymous-rp` +
   `interaction/api.py` demo_router; 三层 env 门禁(`PUBLIC_DEMO_ENABLED`/
   `PUBLIC_DEMO_RP_ENABLED`/`PUBLIC_DEMO_RP_SOURCE_REVISION_ID`, `core/config.py:480-489`),
   配置非法即整线静默 inert(fail-closed); 24h idle/absolute 会话 + HttpOnly Cookie +
   每小时级联清理; 访客自备 DeepSeek Key 只在 SSE 请求头临时构建 client(不落
   Cookie/DB/快照/日志/worker); 禁看海循环/后台连续性/web search/导入。
2. **公开只读演示 + 登录后可编辑副本**(`fc35d51e7`, 新表 `demo_project_copies`): 演示源只暴露
   published 章节; 登录 owner 可幂等创建一份可编辑副本, 只拷持久作者资产(20+ 表)
   (`428e3a70c`), 读者身份与作者 workspace 摘要隔离(`dafef5e90`/`8b8193d31`)。
3. **世界库/共创会话/评审治理**(父仓 ADR-0020/0021/0022): 该能力簇 +36 端点、+8 张相关表
   (5 张 `world_library_*` + 2 张 `world_cocreation_*` + `world_validation_review_items`), review ownership +
   impact preview + author adjudication(`c7278293e`/`0f6d3232d`/`632b6953d`/`ab8f826c6`)。
4. **时空连续性管线(既有模块上的四阶段扩展)**: `backend/modules/story/continuity/`
   在 8c 时代已存在。本窗口的能力锚点为 `de9846689`(scene memory contract 版本化)、
   `2210c3aac`(temporal/causal 事件摄取)、`c4d178706`(确定性检查, 主体落
   `writing/services.py`)、`f54b1972e`(作者确认事实); 运行时语义顺序是事件摄取→版本化
   checkpoint 投影→确定性检查→作者确认, 不把这个顺序当 commit 拓扑。
   **与本仓 M13-B(§4d)正面收敛。**

### 2.2 次级增量

- **有界 agent runtime**(父仓 ADR-0023): 新表 `assistant_runs/watches/notices/
  action_batches` + 新 `modules/assistant/api.py`(17 端点); 默认 `ASSISTANT_ENABLED=false`。
- **地图图集深化**: 统一空间结构与图集(`fe3deb82f`)、评审历史+排练(`40734638e`)、
  可恢复 focused one-hop 检索(`b4909a3fb`); 新表 `map_atlas_revisions`。
- **导入有界评审解决**: `29a1a174b` bounded review resolution + `424749166` 可恢复定向
  补全; imports +12 端点。**与本仓 ADR-0022 durable driver/M13-C job 托管同域。**
- **(8c..fede 段)RP 源资料版本化**(父仓 ADR-0018, `81fcaee2c`, 新表
  `interaction_source_revisions`)、RAG 有界查询规划(`3d6425e3b`/`4f35de755`)、
  可评审 AI 任务预检(`e1aef90bb`)、RP 记忆评测门禁(`44a3d5653`, 判定 non_ready 维持 §6.20 口径)。

### 2.3 数据模型(+15 张, 0 删除)

assistant_action_batches/assistant_notices/assistant_runs/assistant_watches、
demo_project_copies、interaction_source_revisions、map_atlas_revisions、
world_cocreation_sessions/world_cocreation_messages、world_library_topics/
topic_members/favorites/recents/workspace_profiles、world_validation_review_items。

## 3. 前端/产品/部署边界

- **产品形态**: Vue 3.5 + Vite 8 hash 路由 + island 懒加载; 「单一作者工作区」信息架构
  收拢(today→writing 规范化), home 只剩作家/RP 双入口; author workspace 重设计收官
  (`07b69d800` 引入 ShellApp/Sidebar/Topbar + 本地主题包, `e580950bc` 收官 546 files,
  含 Apple 设计审计与组件动效规则)。
- **公开 demo 边界**(README + new-user-guide + 公网只读探测): 代码支持固定作品只读浏览与匿名
  演示 RP; 2026-09-14 公网 `/api/auth/config` 实测为 `demo.enabled=true`、`demo.rp_enabled=false`,
  因而当前对外只有只读演示, 匿名演示 RP 仍在 flag 后。启用后也不能看海/后台连续性/
  续写/web search/导入/写回原作。
- **主题系统**(父仓 ADR-0019): 纯前端本地 `.nctheme.zip`(Worker 解压 + manifest 校验 +
  IndexedDB 存储不上服务器)。#134 缘起首次生产发布翻车(资产白名单不认 zip MIME),
  发布合同脚本自动回滚, 回滚状态记录于 `62d0fd1e8`。
- **移动端**: 系统性响应式适配(多断点覆盖 390–1100; @media 规则散布数十文件, 具体口径
  未复核) + 2026-09-11 专项审计(`ui-size-audit.md`, 71 条论断三轮复核)落地四批修复;
  已知残留 761–1099px 中档缝隙。
- **部署/CI**: 生产 compose 声明 10 个 service(7 个默认 + 1 个 `search` profile + 2 个 `ops`
  profile; digest 钉死 + read_only/cap_drop 加固)+ openresty +
  Cloudflare Tunnel(公网 novel.zhh.se, `verify_public.sh` 全绿合同); CI 为同工作流 +
  `scripts/classify_ci_changes.py` 按改动分流(PR 按影响面选门禁, main 全量)。
- **文档面**: 出现面向最终用户层(new-user-guide.md + .docx + user-personas.md 产品判据),
  与开发文档分层。

## 4. 能力边界判定

| 已对外(公网) | 已入 main 但在 flag/部署配置后 | 内部/实验 |
|---|---|---|
| **实测入口**: HTTPS/健康接口、邮箱认证配置已启用、公开只读 demo 项目可读, 下发 bundle 含作者/RP 双入口。**已提交对外合同(本轮未登录/未调 provider 复验)**: 作者主链、登录 RP 私人故事、登录后演示副本、本地主题包、失败自动回滚的发布合同 | 匿名演示 RP(三层 `PUBLIC_DEMO_*` 门禁; 公网当前 `rp_enabled=false`); RAG query planner/reranker(compose 默认 false); Assistant(父仓 ADR-0023, `ASSISTANT_ENABLED=false`); `debug_api` 只在非 public 模式注册 | 演示 source 物化脚本(dry-run 默认); 跨作品 crossover/项目共享/公开发布(README 明示非目标); 761–1099px 响应式缝隙; 高级生成工具定位为内部恢复工具 |

## 5. 对本仓的对齐含义(N58/M14 的输入)

### 5.1 收敛点(值得对照, M14 批 A/批 B)

1. **连续性管线 ↔ M13-B**(最优先): 父仓四阶段(事件摄取→contract 版本化→确定性检查→
   作者确认事实)vs 本仓 N54 catalog 28 条 + radar-continuity 七检测器 + scene_index
   冲突。须产出逐检测器对照表; 确定性且落本仓 vault 资产模型的缺口才移植(照 M13-B
   批 2 姿势); 需要 timeline 服务的不做(§6.18.6 维持)。**作者确认事实**(`f54b1972e`)
   是本仓 N46 memory 写点(manual_correction)reserved 的直接参考模型——只评估 payload
   语义出新裁定, 不直接实施。
2. **导入恢复语义 ↔ ADR-0022/M13-C**: 父仓 bounded review resolution/可恢复定向补全 vs
   本仓四窗口/checkpoint/N40 对账。产出对照记录; 实缺口另立实施批。
3. **世界库/共创/评审治理 ↔ world 工具组(7)+生成中心**: 表模型↔文件模型语义鸿沟大,
   入候选评估区逐能力裁定, 不整域移植。
4. **有界 agent runtime(watches/notices) ↔ M13-A 常驻状态面 + M13-C 通知**: 大概率记
   观察(本仓已有等价面: afterMutation 漏斗 + followup/inject 混合通知)。

### 5.2 不对齐维持(父仓产品面, N58 防回流)

匿名公开 RP/公开只读演示及登录后可编辑副本/公网部署线(hosted 多用户形态, 本仓是本地 DSH 插件, D23 与
多用户/云同步边界不变); 主题包机制(N52 维持); 面向最终用户的产品文档/截图门面; 镜像
digest/部署栈(本仓无镜像分发); 付费评测(维持需用户裁决)。

### 5.3 §4b 遗留候选的新上下文

- **client 窄屏 P1**: 父仓 `ui-size-audit.md`(71 条审计三轮复核 + 断点矩阵 + 四批修复)
  提供了可照抄的审计方法; 本仓批实施时照此法建本仓 client 的尺寸审计。
- **CI PR/main 分流**: 父仓已从 51 项分流演化为单工作流 + `classify_ci_changes.py`
  改动分类器; 本仓评估时学模式不学数字(N52 口径维持)。

## 6. 证据锚点(代表 commit)

- 匿名 RP: `1afc5561a` `91971f7f5` `de8e6598f`; 边界收紧系列 `9645583bb` `54403c5fe`
  `cb57018aa` `67d736ca8`(PR #135/#137/#139)。
- 公开副本: `fc35d51e7` `428e3a70c` `dafef5e90` `8b8193d31`。
- 世界库/共创/评审: `c7278293e` `0f6d3232d` `632b6953d` `ab8f826c6`。
- 连续性: `2210c3aac` `de9846689` `c4d178706` `f54b1972e`(backend/modules/story/continuity/)。
- agent runtime: 新 `backend/modules/assistant/{api.py,tasks.py}`(父仓 ADR-0023)。
- 导入: `29a1a174b` `424749166`; 图集: `fe3deb82f` `40734638e` `b4909a3fb`。
- 前端重设计: `07b69d800` `e580950bc`(PR #132 `f5a0ce61b`/`d67daf8ca` CI 对齐);
  主题资产: PR #134 `9750fefe0` + 回滚记录 `62d0fd1e8`。
- 部署/CI: `95cdb151c`/`a8c331024`(MinIO 官方 registry)、`4d1034732`(pcre2 patch)、
  `c2bf4d336`(world bible CI 超时, PR #133)、`classify_ci_changes.py`。

## 7. 勘察口径与复核状态

- 两仓基线: 父仓 `HEAD`/`origin/main`/远端 `refs/heads/main` 均为 `4db3df9b6`, 工作树干净;
  本仓复核起点 `HEAD`/`origin/main`/远端均为 `57dd276b`, 只有既存未跟踪 `docs/agent/drafts/`。
- 历史区间: `8c1516daf..fede3bd72` = 121 commits, `fede3bd72..4db3df9b6` = 274,
  合计 395; 端点按生产 Python 路径中 FastAPI 装饰器计数为 412/425/519,
  后端路由文件为 19/19/20, ADR 文件为 25/27/32, 迁移文件为 46/47/56。
- 父仓机器清单 `PYTHONDONTWRITEBYTECODE=1 python3 scripts/check_architecture_docs.py` 实际通过,
  输出 9 个业务模块/115 张 ORM 表/47 个 task handler/16 条前端路由/32 篇 ADR;
  handler 37/37/47 另经 `@task_handler(` 注册口径复算。
- `fede3bd72..4db3df9b6` 的 `world/api.py` 端点由 136→172(+36, 0 删除),
  `world/map_atlas_api.py` 由 22→35(+13), 合计对应 world 域 158→207(+49)。
- 表清单 100/101/115; 8c→当前精确新增 §2.3 所列 15 张、0 删除。其中
  `world_library_*` 是 5 张, 与 2 张 `world_cocreation_*` 及 1 张 review 表合计 8 张;
  原文「6 张 `world_library_*`」已订正。
- `story/continuity` 在 8c/fede/当前均有 16 个 tracked 文件; 本窗口其中 10 个文件发生变化,
  净变化 +323/−180。父仓确定性检查在 `writing/services.py` 内共 9 个 rule code
  (space/time/logic 各 3); 「既有模块扩展」成立, 「新域」不成立。
- 生产只读探测: `https://novel.zhh.se/` 与 `/api/health` 返回 200/healthy+connected;
  `/api/auth/config` 返回 `auth_mode=public`、`email_enabled=true`、`demo.enabled=true`、
  `demo.rp_enabled=false`; 该配置指向的 `/api/projects/{id}?demo=1` 可读, 已下发 JS bundle 含作者/RP
  双入口文案。本轮未登录、未调 provider, 不将源码/单测扩大为
  公网业务全链验收。
- compose 当前声明 10 个 service: 7 个默认服务、1 个 `search` profile 服务、2 个 `ops`
  profile 服务; 原文「生产 9 服务」已订正。
