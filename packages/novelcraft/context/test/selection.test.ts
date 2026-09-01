import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeFrontmatter } from "@novelcraft/store";
import { initVault } from "@novelcraft/vault";
import {
  assertSelectedVaultSourcesCurrent,
  compileSelectedVaultContext,
  type SelectedVaultSourceRule,
} from "../src/index.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "context-selection-"));
  roots.push(value);
  initVault(value, { title: "选择测试", language: "zh" });
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

const classify = (ref: string): SelectedVaultSourceRule | undefined =>
  /^world\/objects\/[^/]+\.md$/.test(ref)
    ? { tier: "P1", source_type: "world_entity", current_statuses: ["canonical"], working_statuses: ["draft"] }
    : undefined;

describe("compileSelectedVaultContext(explicit selection)", () => {
  it("只读取显式 canonical 来源并产 actual manifest/snapshot", () => {
    const r = root();
    const file = join(r, "world", "objects", "clock.md");
    const raw = serializeFrontmatter({ id: "clock", kind: "object", name: "钟", status: "canonical" }, "规则正文");
    writeFileSync(file, raw, "utf8");
    const result = compileSelectedVaultContext(r, {
      task: "世界讨论",
      scope: "world",
      selection: { instruction: "检查规则", source_refs: ["world/objects/clock.md"] },
      classify,
    });
    expect(result.rendered_text).toContain("检查规则");
    expect(result.rendered_text).toContain(raw);
    expect(result.source_manifest.map((source) => source.source_id)).toEqual([
      "author-instruction",
      "vault:world/objects/clock.md",
    ]);
    expect(result.source_snapshot).toHaveLength(1);
    expect(() => assertSelectedVaultSourcesCurrent(r, result.source_snapshot)).not.toThrow();
    writeFileSync(file, `${raw}\n变化`, "utf8");
    expect(() => assertSelectedVaultSourcesCurrent(r, result.source_snapshot)).toThrow(/漂移/);
  });

  it("draft 必须显式允许；重复、越界、非白名单与 symlink 均 fail-closed", () => {
    const r = root();
    const rel = "world/objects/draft.md";
    writeFileSync(
      join(r, rel),
      serializeFrontmatter({ id: "draft", kind: "object", name: "草稿", status: "draft" }, "待定"),
      "utf8",
    );
    const base = { task: "x", scope: "world" as const, classify };
    expect(() => compileSelectedVaultContext(r, {
      ...base,
      selection: { instruction: "x", source_refs: [rel] },
    })).toThrow(/状态不可用/);
    expect(compileSelectedVaultContext(r, {
      ...base,
      selection: { instruction: "x", source_refs: [rel], include_working_drafts: true },
    }).source_snapshot[0].source_status).toBe("draft");
    expect(() => compileSelectedVaultContext(r, {
      ...base,
      selection: { instruction: "x", source_refs: [rel, rel], include_working_drafts: true },
    })).toThrow(/唯一/);
    expect(() => compileSelectedVaultContext(r, {
      ...base,
      selection: { instruction: "x", source_refs: ["../secret.md"] },
    })).toThrow(/source_ref 非法/);
    expect(() => compileSelectedVaultContext(r, {
      ...base,
      selection: { instruction: "x", source_refs: ["chapters/001.md"] },
    })).toThrow(/白名单/);
    symlinkSync(join(r, rel), join(r, "world", "objects", "link.md"));
    expect(() => compileSelectedVaultContext(r, {
      ...base,
      selection: { instruction: "x", source_refs: ["world/objects/link.md"], include_working_drafts: true },
    })).toThrow(/symlink/i);
  });
});
