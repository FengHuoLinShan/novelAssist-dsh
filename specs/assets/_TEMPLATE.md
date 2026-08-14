# <模块> 资产规格(R0 提取)

- 来源 commit: a257df23e
- 提取日期: 2026-08-14
- 提取范围: backend/modules/<模块>/<文件列表>

## <资产名 1>(M4 落点: <工作区文件路径>)

### 语义

一句话说明这是什么资产(作者语言)。

### frontmatter 字段

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| id | string | 是 | 稳定标识 |
| status | enum | 是 | 见状态机 |

### 状态机

```
draft → canonical(adopt)
canonical → deprecated(替换/删除, 不硬删)
```

### 旧表映射

| frontmatter 字段 | 旧表.列 | 备注 |
|---|---|---|
| id | core_entities.id | UUID → 文件名/slug |

### 完整性规则(必须在 store 插件保留的确定性规则)

- 规则 1(来源: <file>:<lines>)
- ...

### 待定

- 【待定】某字段在 M4 是否保留

---

(下一个资产同结构)
