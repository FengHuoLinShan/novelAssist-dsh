# @novelcraft/vault

NovelCraft M4(ADR-0016)R1 内核包: 工作区初始化、路径规范、slug、读写门禁。

纯 TS, strict 模式; 零 DSH 依赖、零 LLM、纯确定性; git 操作用
`node:child_process` 调 git CLI(见 `../README.md` 工程约定)。

## API(src/index.ts)

| 导出 | 职责 | 规则 |
|---|---|---|
| `initVault(rootPath, bookMeta)` | 建 §22.2 目录树骨架 + book.yml + `git init`; 已存在幂等返回 | §22.2 |
| `resolveVaultRoot(startPath)` | 向上找 book.yml 定位 vault 根; 找不到抛错 | R9 |
| `paths(root)` | §22.2 全表路径常量 + 拼接函数(含 adjudications #1–#5, N12 目录化) | §22.2 |
| `guardPath(root, p)` | 防路径穿越(规范化后仍在 root 内, 否则抛错) | R9 |
| `readAsset` / `writeAsset` | 带 guard 读写; 写前建父目录 | R9/R12 |
| `slugify(title, existing?)` | 保留 CJK/仅剔非法字符/限长 64/冲突去重; id = slug | N10/R63 |

## book.yml 字段(N9, 以 specs/assets/small-modules.md §1.1 为权威)

| 字段 | 类型 | 必填 | 默认/枚举 |
|---|---|---|---|
| `title` | string | 是 | 去首尾空白, 拒空字节与纯空白 |
| `genre` | string | 否 | 开放字符串 |
| `tone` | string | 否 | 开放字符串 |
| `language` | string | 是 | 默认 `zh` |
| `target_length` | enum | 否 | `short / medium / novel / epic` |
| `current_stage` | enum | 否 | `world_building / outlining / writing / revising` |
| `default_reveal_policy` | enum | 是 | 默认 `author_safe`; 白名单 `author_safe / author_only / reader_known / public` |

book.yml 模板:

```yaml
title: "诡秘之主"
genre: "克苏鲁/蒸汽朋克"
tone: "悬疑"
language: "zh"
target_length: "novel"
current_stage: "writing"
default_reveal_policy: "author_safe"
```

## slugify(N10 / R63)

`slugify(title, existing?)` → id = 文件名 slug, id 可含中文:

- 保留 CJK 字符(如「诡秘之主」→「诡秘之主」);
- 归一空白: 连续空白 → 单个 `-`;
- 仅剔除文件系统路径非法字符 `/ \ : * ? " < > |`(映射为 `-`)与控制字符(移除);
- 限长 64(截断后去尾部 `-`);
- 空结果或只剩非法字符时抛错;
- 冲突去重: 传入 `existing: Set<string>` 时同名追加 `-2`/`-3` 短后缀, 不修改传入 set。

## 命名裁定记录

- **N9 · book.yml 字段名**: 以 Spec 为权威, 用旧代码字段名 `target_length` /
  `current_stage`, 不用 `target_scale`/`stage`。
- **N10 · slugify 保留 CJK**: 中文书名不再丢成空串; 仅剔除路径非法字符与控制字符,
  冲突加短后缀去重。
- **N12 · structure 目录化**: `structure/threads/<slug>.md`、`structure/arcs/<slug>.md`、
  `structure/foreshadowing/<slug>.md`、`structure/reveal/<slug>.md`(每资产一文件),
  `structure/outline.md` 保持单文件。
- **目录树骨架 = 仅目录 + book.yml + .git**; 固定文件(book.yml、outline.md、
  events.jsonl、policy.yml 等)由 init/store/outline 按内容落盘, 其余为目录。

## 命令

```sh
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json → dist/
```
