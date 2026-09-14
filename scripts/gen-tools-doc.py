#!/usr/bin/env python3
"""从 packages/novelcraft/dsh/src/ 工具声明重新生成 docs/TOOLS.md。

用法: python3 scripts/gen-tools-doc.py
发版后运行一次, 并把输出中的版本号改到当前发布版本。
"""

import glob
import os
import re

GROUPS = {
    "book.ts": "书库",
    "workflow.ts": "深度导入 / 工作流",
    "world.ts": "世界",
    "outline.ts": "大纲与生成",
    "writing.ts": "写作",
    "map-atlas.ts": "地图册",
    "tools.ts": "存储 / 检索 / 系统面",
}
ORDER = ["书库", "深度导入 / 工作流", "写作", "大纲与生成", "世界", "地图册", "存储 / 检索 / 系统面"]
VERSION = "0.1.3"


def clean(desc: str) -> str:
    desc = re.sub(r"\((?:[^()]*)?(?:N\d+|M1\d|§|P20)[^()]*\)", "", desc)
    desc = re.sub(r"\s+", " ", desc).strip(" ,;、")
    if len(desc) > 90:
        cut = desc[:88]
        m = max(cut.rfind(x) for x in "、,;;(")
        desc = cut[:m].rstrip(" ,;、(") + "……"
    return desc


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    rows: dict[str, list[tuple[str, str]]] = {}
    files = sorted(glob.glob(os.path.join(root, "packages/novelcraft/dsh/src/tools/*.ts")))
    files.append(os.path.join(root, "packages/novelcraft/dsh/src/tools.ts"))
    for f in files:
        base = os.path.basename(f)
        src = open(f, encoding="utf8").read()
        for m in re.finditer(r"name:\s*[\"'`]?(novelcraft_[a-z_]+)[\"'`]?", src):
            tail = src[m.end(): m.end() + 1200]
            dm = re.search(r"description:\s*[`'\"]([^`'\"]{10,})", tail)
            d = clean(dm.group(1)) if dm else ""
            rows.setdefault(GROUPS.get(base, base), []).append((m.group(1), d))

    lines = [
        "# 工具清单(novelcraft-dsh)",
        "",
        f"> 由 `packages/novelcraft/dsh/src/` 工具声明源码提取( scripts/gen-tools-doc.py ), 对应 novelcraft-dsh **{VERSION}**。",
        "> 描述为运行时声明的节选; 各工具的读写能力(只读/需审批)经 DSH capability 注册, 审批语义见仓库 README「核心原则」。",
        "",
    ]
    total = sum(len(v) for v in rows.values())
    lines += [f"共 **{total}** 个工具。", ""]
    for g in ORDER:
        items = sorted(rows.get(g, []))
        if not items:
            continue
        lines += [f"## {g}({len(items)})", ""]
        lines += [f"- **`{n}`** — {d or '(描述见源码)'}" for n, d in items]
        lines.append("")
    out = os.path.join(root, "docs", "TOOLS.md")
    open(out, "w", encoding="utf8").write("\n".join(lines) + "\n")
    print(f"wrote {out}: {total} tools")


if __name__ == "__main__":
    main()
