import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { ingestChapter } from "@novelcraft/writing";
import { gitAdd, gitCommit } from "@novelcraft/store";
import { planImport } from "../src/index";

describe("dbg2", () => {
  it("porcelain after planImport", () => {
    const root = mkdtempSync(join(tmpdir(), "dbg-"));
    initVault(root, { title: "t", language: "zh" });
    ingestChapter(root, { chapterIndex: 1, text: "x", source: "paste" });
    gitAdd(root); gitCommit(root, "fixture init");
    const s1 = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    console.log("after fixture:", JSON.stringify(s1));
    planImport(root, { startChapter: 1, endChapter: 1, confirmed: true });
    const s2 = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    console.log("after planImport:", JSON.stringify(s2));
    console.log("gitignore raw:", JSON.stringify(execFileSync("cat", [".gitignore"], { cwd: root, encoding: "utf8" })));
    rmSync(root, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});