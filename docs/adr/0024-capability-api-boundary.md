# ADR-0024 — Capability API 边界(read / propose / adoptGuarded, raw 写面收进 internal)

- **状态**: Accepted(2026-08-15, 用户确认裁定 N35); **implemented and verified**
- **日期**: 2026-08-15
- **取代/补充**: 收口 N31(审批门旁路)之后的剩余旁路面: 把 `NovelCraftService` 的 raw
  写面从公共导出面移走, 以 capabilities 三分法定义公开 API 边界。**不取代**任何现有 ADR。
- **设计依据**: N35(2026-08-15 用户确认; 已录入 `specs/adjudications.md` 第八批)、
  N31(审批门旁路收口)、铁律 1(核心包零 DSH 依赖)/3(adopt 必过 approval fail-closed)/
  4(只做加法)、`packages/novelcraft/dsh`(service.ts / facades / index.ts 导出面)、
  `packages/novelcraft/store`(adopt.ts/merge.ts)。

## 背景

N31 已收口 world 直写与 imports 结构资产直置 canonical 两条旁路, 但 `NovelCraftService`
仍暴露两类未收敛面:

1. **facades 直通核心包写面**: `facades.<pkg>` 命名空间把 store 的 raw adopt/merge 等
   直接暴露给组合代码/未来插件, 不经 ApprovalGate 即可写 canonical——审批门只是「当前
   没有旁路调用方」, 不是「结构上不可旁路」。
2. **公共导出面无分级**: `service` 的读、写 pending、adopt 三类能力在同一平面, 调用方
   没有「我该用哪个入口」的显式信号; 而 adopt 类工具是否审批门控散落在各工具描述里。

需要把「哪些入口允许不经审批写 pending、哪些必经审批写 canonical」固化为 API 结构,
而不是靠文档约定。

## 决策

### 1. `service.capabilities` 按 read / propose / adoptGuarded 三分

- **read**: 只读查询面(索引、读取、storyMap、dossier 等), 无写。
- **propose**: 写待处理/草稿面(`world/pending`、draft 资产、候选产物等), 不过
  ApprovalGate——这些产物本身不可见为 canonical。**保留 ADR-0020 §5 的受限作者编辑例外**:
  `propose.authorEdit.annotations` 可修改已 adopted 地图页的 `annotations` 字段而不过
  ApprovalGate, 但只能消费受控 annotation queue/精确结构化 ops、必须携
  `base_content_hash` CAS, 且只可通过 ADR-0021 目标路径事务改写固定字段；它不是页面
  adopt/status 迁移, 不得借此暴露 raw page writer 或改写其它 canonical 字段。
- **adoptGuarded**: canonical **adopt/status/资产升格**写面, **必经 ApprovalGate**
  (allowed-once 只放行一次, rejected/cancelled/unavailable 一律拒绝, fail-closed;
  对齐铁律 3)。
- 公开入口按三分法组织, 调用方按语义选入口, 不再有「直通 adopt」的灰色面；上述
  annotation 是既有 ADR-0020 作者编辑通道的封闭例外, 不是第四类 capability。

### 2. dsh 服务面的 raw 写面移入 internal, 主 exports 不导出

- **收口只针对 `@novelcraft/dsh` 的 NovelCraftService / facades 服务面**: raw
  adopt/merge 等不经审批的 canonical 写函数从该服务面的公共导出移除——**dsh 主 exports
  不再导出**; 仅 dsh internal 入口(同包内部 / 白名单测试)可见。
- **核心 `packages/novelcraft/*` 既有的 raw 导出不得删除、不得改签名**(铁律 4 只做
  加法): store.adopt/merge 等仍是核心包的既有导出面(dsh 与测试的正常依赖面), 本 ADR
  不触碰。

### 3. facades 仅保留 deprecated 安全别名/拒绝存根, 不继续 raw adopt/merge

- 既有 `facades` 命名空间**仅保留 deprecated 安全别名**(指向 guarded 方法的包装或拒绝
  存根, 如 N31 已做的 facades.world 拒绝存根), 保证既有消费者不破(铁律 4, 只做加法);
- **不继续提供 raw adopt/merge**: 别名本身不再直通核心包写面, 新代码一律走
  capabilities。

### 4. 边界声明: 这是防误用 API 边界, 不是同进程恶意代码沙箱

- 本 ADR 的结构是「让正确调用方不容易走错门」的**防误用边界**。
- **不是同进程恶意代码沙箱**: 直接 import 核心包(`store.adopt` 等)仍可能绕过
  capabilities/审批——**真正隔离不在承诺内**, 不假装、不宣称、不为此引入运行时隔离
  机制; 核心包 raw 导出保留与此边界一致(本 ADR 不删除、不改动核心包导出面)。

### 5. 审批语义与核心包依赖不变

- 核心包保持**零 DSH 依赖**(铁律 1): 审批逻辑只存在于 `@novelcraft/dsh` 的
  ApprovalGate 适配层, 核心包不感知、不内嵌 DSH。
- DSH 审批保持 fail-closed: 服务缺失 / 无 agent / 异常 → `unavailable` 拒绝, 不因
  API 面调整而放宽。

## 失败关闭与边界

- adoptGuarded 的任何非 `allowed-once` 结果 → 拒绝, canonical adopt/status 面零写入。
- `propose.authorEdit.annotations` 只允许固定字段 + CAS + 受控队列/精确结构化输入 +
  ADR-0021 事务；任一条件缺失即拒绝, 不得扩大成通用 canonical writer。
- deprecated 别名指向拒绝存根/guard 包装: 误调不静默通过; 别名输出 deprecation 信号。
- **边界**: 直接 import 核心包绕过 = 已知边界, 记录不承诺; 隔离超出本 ADR 范围。

## 未采用方案

- **A. 同进程运行时沙箱/强制隔离**: 超出范围且不可靠(同进程内没有可靠隔离), 与 §4
  边界声明一致; 未采用。
- **B. 立即删除 facades / raw 面**: 破坏既有消费者与测试, 违反铁律 4 只做加法; 未采用
  (deprecated 别名过渡)。
- **C. 核心包内嵌审批逻辑**: 违反铁律 1(核心包零 DSH 依赖), 审批必须收敛在 dsh 层;
  未采用。
- **D. 引入权限 token / 角色系统**: 单用户自用场景过度设计; 未采用。

## 影响

- 新增(只做加法): `service.capabilities` 三分面; internal 入口; facades deprecated
  安全别名(复用 N31 的拒绝存根模式)。**@novelcraft/dsh 的**既有服务导出面不删, 仅从
  「主 exports 直通 raw」改为「internal + deprecated 别名」; **核心
  `packages/novelcraft/*` 的既有 raw 导出保持不变**(铁律 4, 只做加法)。
- dsh 工具注册: adopt 类工具(store_adopt、map_atlas_review 等)的审批门控语义由
  capabilities.adoptGuarded 承接, 工具描述与实现一致。
- 验证要求: vitest 行为契约, 断言注释引 N35——断言 **@novelcraft/dsh 主 exports** 不含
  raw adopt/merge(核心包 raw 导出保留且签名不变)、deprecated 别名不直通核心包写面、
  capabilities 三分语义(propose 候选面不过审批 / adoptGuarded 非 allowed-once 一律拒绝)、
  annotation 作者编辑例外只改固定字段且强制 CAS/受控来源/ADR-0021 事务、直接 import
  核心包的边界用例(记录为已知边界而非承诺);
  完成标准 `npm test` 全绿 + `npm run typecheck` 零错误。
- 文档: N35 已录入 `specs/adjudications.md` 第八批; `docs/adr/README.md` 索引已更新。

## 实施期开放项

1. deprecated 别名的移除时点不设硬期限: 以「M4 无生产调用方」为事实(同 ADR-0019 §3
   口径), 新代码走 capabilities, 别名长期保留兼容。
