# 父仓 ai-writing-assist PR 进展对齐分析(2026-09-07)

> 性质: 文档批(N52)。只读分析父仓自台账基线 `8c1516daf`(2026-08-31 审计)以来的
> PR 进展, 逐项判定对齐关系, 提出本仓对齐方向; 不实现任何候选项本身。
> 铁律 8: 父仓库全程只读, 本轮未改动其任何文件、分支或远端。

## 1. 审计基线

| 仓库 | 基线 | 说明 |
|---|---|---|
| ai-writing-assist | origin/main `fede3bd72`(#118 合并点, 2026-09-07 13:06Z) | 本轮新审计基线; 本地 `ahead 2`(`956354f84` perf(world) 别名读路径优化 + `605660598` merge), 按 §6.25 协议**只进候选区**, 不计入已确认契约 |
| novelAssist-dsh | main `0d9f665f`(N51 落地后) | 本批文档改动随下一提交入库 |

事实核对方式: `gh pr list/view`(GitHub 真实 PR 元数据)+ 父仓 `docs/adr/0019*.md`
与 README 只读查看 + `git log origin/main..HEAD`。Open PR #119/#116/#108/#106 均为
dependabot 依赖升级, 无契约意义。

## 2. 父仓新漂移(基线 `8c1516daf` 之后合并的 PR)

| PR | 合并时间 | 内容(经 PR 正文核实) |
|---|---|---|
| #109 | 09-01 | 认证前选择作者/RP 入口; 目的地跨刷新与 OAuth 式重定向保留; 切换模式时归还键盘焦点 |
| #110 | 09-02 | **RP 长记忆 source-grounded(大型)**: 新增 RP source revision API 与 `20260901_rp_source_context` migration; interaction 固定 story 输入 + 剩余 ≤16K source 预算传 Evidence, required source 放不下失败关闭; `</SOURCE_REFERENCE_DATA>` 渲染边界转义。付费 eval: 官方 `deepseek-v4-flash`, 4,040,787 input + 58,672 output = 4,099,459 total tokens, probe repair 12 次; sealed production holdout 42 候选, production B 相对 A case +3 / fact +3 / L3-sim 盲评 +0.233766 / severe spoiler 0, 但只保留 6/7 用户明确修正且能力边界 case 失败 → **frozen test 判定 `non_ready`, 生产 activation path 已删除**; reviewer 为 Codex 模拟真人教师(`codex-teacher-sim-v1`), 明确标注不冒充真人; 决定记 MEM-DEC-078~080 |
| #113 | 09-02 | 修 #110 合并后的镜像漏洞门禁与筛选焦点 E2E(发布工程) |
| #115 | 09-07 | 前端镜像固定 libuuid `2.42.3-r1`, Trivy HIGH 清零(CVE-2026-80256)(部署安全) |
| #117 | 09-07 | CI 分流: 共享变更分类脚本按完整 base/head 差异选步骤(删除/重命名两侧均纳入, 未知路径全量, 读取失败阻断); 相关 PR 复用现有 **51 项浏览器冒烟**, 远端 3 分 23 秒(此前完整任务 11 分钟, 单次约 -69%); main 保持完整回归 + Ask World 非阻断报告; 镜像扫描/SBOM/恢复演练/固定 SHA 发布保留 |
| #118 | 09-07 | **工作台现代化 + 本地主题包(ADR-0019)**: 作者工作台/手机写作/RP 统一现代简约外观; `nc-theme` 三态 `light/dark/system`(`data-theme` 为解析后值, 旧主题迁移浅/深色); `ThemePackageV1` 本地 ZIP 接口(theme.json + assets/ + 可选 LICENSE, 禁导入 CSS/JS/HTML/SVG/远程地址), IndexedDB `nc-theme-packages` 存储, fflate 同源模块 Worker 受限解压(输入/字节/数量/时间四限), CSP 不加 eval/外部域名/blob worker; 验证 2237 单测 + 240 浏览器用例 + 8 主题专项 |

**直推 main 提交(不经 PR, 评审补充核对)**: `git log --first-parent --no-merges
8c1516daf..fede3bd72` 共 **95 个**(09-01×6、09-02×86、09-07×3), 其中域级后端 feat 四项
——`3d6425e3b` feat(evidence) bounded RAG query planning、`4f35de755` feat(rag) harden
retrieval planning and source checks、`08a1af1b2` feat(ai) evidence-gated review
workflows、`a95bfd5b7` feat(interaction) RP source setup 分步引导(另有 `0cc412c5a`
feat(frontend) RP 历史原地重生成)——其余为前端修复/测试对齐/文档。本轮只做粗粒度
归类, **未逐项判定**; 台账 §6.0 快照相对 `fede3bd72` 已部分过时(尤其 evidence/RAG
检索加固与 RP 前端体验两域), 后续按 §6.25 协议在相关切片核对时吸收。

## 3. 结构性结论

1. **父仓 main 零 DSH 化迹象**: `deepseek-harness`/`Cordis` 在 `fede3bd72` 全树 grep
   0 命中; `novelcraft` 仅 README 品牌 5 处与 vite 测试临时目录前缀
   (`novelcraft-runtime-asset-`)1 处两类**非运行时**命中。M4 DSH 路线仍只在归档分支
   `archive/m4-dsh-plugin-rewrite`(冻结 2026-08-14)。**本仓** ADR-0017
   (m4-repo-form-and-mounting)分工(旧引擎演进在父仓 main, DSH 路线整体在本仓)
   不变, 不存在重复实现风险。注意: 父仓自己的 `docs/adr/0017` 是世界事实权威 ADR,
   与分工裁定无关。
2. **品牌合流**: 父仓 README 现名「NovelCraft｜AI 长篇创作与私人故事引擎」, 与本仓
   `@novelcraft/*` 包名/`novelcraft-dsh` 公开包一致。记为观察项, 无代码动作。
3. **父仓自证 RP 记忆未达生产门槛**: #110 的 frozen test 判定 `non_ready` + 生产激活
   路径删除, 客观支持本仓 D23(RP 延后 R6 后)裁定的正确性——父仓自身也不认为 RP
   长记忆当前可生产启用。
4. **父仓演进重心**: 前端现代化/主题/移动体验(#118)、CI 效率(#117)、部署安全
   (#115)与 RP 域深化(#110)。**六个已合并 PR 范围内**后端业务契约(API/schema/wire)
   无用户可见变化; 直推提交另有 evidence/RAG 检索加固与 evidence-gated review
   workflows(见 §2 末注, 未逐项判定), `100 表/412 端点`等能力图头部数字本轮不重审。

## 4. PR 逐项对齐判定

| PR | 本仓对应状态 | 判定 | 行动 |
|---|---|---|---|
| #109 认证前双入口 | 本仓是 DSH 宿主内插件, 入口/认证归宿主 web, 插件无此面 | **不对齐(范围外)** | 无; 防回流记 N52 |
| #110 RP 长记忆 | D23 已确认 RP 延后 R6 后(§6.20); interaction 仅 truthful 占位 | **不对齐(已裁定延期)**; 但其**评测纪律**(冻结 holdout + 真实付费调用 + readiness 判定门禁 + 失败不调参不重跑)与本仓「零付费 36-call dry-run」框架同构, 是可借鉴的工程范式 | §6.20 记「父仓 readiness 转 ready」重开信号; 付费评测纪律记为需用户裁决候选(费用/数据授权), 不排程 |
| #113/#115 发布工程/镜像 CVE | 本仓分发形态是 npm tarball(无镜像); 供应链由 check:audit-gate(high=0/critical=0)+ N51 隔离安装烟测覆盖 | **已等价覆盖** | 无 |
| #117 CI 分流 | 本仓 CI(含 N51 新增 pack→隔离安装→烟测链)目前 PR/main 同面; 未测得分流收益 | **部分; 学模式不学数字** | 候选: N51 落地后先量 CI 各段时长, PR 路径瘦身为「受影响面 + 冒烟」、main 全量; 具体项数按本仓测试形态自定, 不复制 51 项 |
| #118 工作台现代化+主题 | client 为 DSH 宿主 web 内嵌面板(service.ui); §6.22 已记 390px/焦点/窄屏缺口; 交接 §7 条目 10 已有「窄屏角标+底部抽屉」待办; 主题(浅/深/系统)是否可做取决于宿主是否向插件面板暴露主题 seam, 未探测 | **部分; 缺口在移动/窄屏与主题适配** | ①窄屏/移动批优先级提升(父仓已把手机完整工作流列为一等公民); ②rc.1 主题能力探测(照 A1 宿主探测先例): 有 seam 才评估浅/深适配, 无则 truthful 不做; ③主题包机制(ThemePackageV1/ZIP/IndexedDB)属独立前端壳能力, 本仓无此形态, 不做 |

## 5. 对齐方向(四类)

1. **立即(本批, 文档)**: 台账 §6.1 追加漂移、§6.20 记重开信号、§6.24/§6.25 更新;
   本分析文档; 后续开发计划新增「父仓对齐增量」节; N52 裁定。
2. **下批实现候选**(详表见后续开发计划新节): client 窄屏/移动批提级; rc.1 主题
   能力探测; CI PR/main 分流评估(先量时长); 性能基线挂「真实一书手动验收」批
   (父仓本地未推送的 world 读路径性能探针/基线工作是同一信号, 记候选区)。
3. **需用户裁决(仅记录不排程)**: 付费评测——沿用既有裁定先例(未获费用与数据授权
   前不运行付费小说评测); 父仓 #110 已示范完整门禁形态(冻结 holdout/标注模拟
   reviewer/失败即停/不调参), 重开时按该范式设计。
4. **明确不对齐(防回流, N52)**: RP 记忆特性本身(D23); 认证前多入口(#109);
   主题包机制(ADR-0019 ThemePackageV1/ZIP/IndexedDB——本仓只做宿主 seam 探测);
   镜像 CVE 修复(#115, 无镜像分发); 复制父仓 CI 冒烟具体数字(只取 PR 冒烟/main
   全量模式)。

## 6. 验证与复现

- 事实来源: `gh pr view 109/110/117/118 --json title,body`(GitHub PR 正文, 含
  usage/token 数、non_ready 判定、ADR 引用)、`gh pr list --state merged/open`、
  `git log --first-parent --no-merges 8c1516daf..fede3bd72`(直推提交归类, 95 个)、
  父仓 `docs/adr/0019-*.md`(只读)、父仓 `git log origin/main..HEAD`(候选区 2 提交)、
  父仓 `README.md` 头部(品牌名)、`git grep "deepseek-harness\|Cordis\|novelcraft"
  fede3bd72`(零运行时命中核对)。
- 父仓只读声明: 本轮对 ai-writing-assist 仅执行 `git log/status`、`gh pr`、文件
  读取; 零写入、零分支操作、零 push。
- 本仓门禁(N51 落地复跑, 2026-09-07): `npm test` 16/16 workspace 全绿;
  `npm run typecheck` 零错误; `check:deps`/`check:git-writers`/`check:distribution`/
  `check:audit-gate` 全绿。本批为文档批, 不改代码, 上述门禁结果即为本批基线。

## 7. 本批落点

- 新增: 本文档。
- 更新: `功能对照清单.md`(§6.1 漂移条目与基线、§6.20 重开信号、§6.24 注记、
  §6.25 核对行)、`后续开发计划.md`(§4b 父仓对齐增量)、`specs/adjudications.md`
  (N52)、`docs/agent/dsh-rebuild/跨会话交接.md`(指针)。
