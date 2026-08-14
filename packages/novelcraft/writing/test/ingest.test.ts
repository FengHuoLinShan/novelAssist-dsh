// R3 停靠行为契约(PLAN.md 步骤 1)
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { contentHashOf, ingestChapter, normalizeChapterText } from "../src/index";

const dirs: string[] = [];
function makeVault() {
  const root = mkdtempSync(join(tmpdir(), "ncw-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    import("node:fs").then((fs) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

describe("normalizeChapterText", () => {
  it("去 BOM + CRLF→LF(章节停靠归一)", () => {
    expect(normalizeChapterText("\uFEFF第一行\r\n第二行")).toBe("第一行\n第二行");
  });
  it("折叠连续空行为一个空行", () => {
    expect(normalizeChapterText("a\n\n\n\nb")).toBe("a\n\nb");
  });
  it("清除行尾空白(哈希稳定)", () => {
    expect(normalizeChapterText("a   \nb\t")).toBe("a\nb");
  });
});

describe("ingestChapter(PLAN.md 步骤 1)", () => {
  it("写入 chapters/NNN.md, frontmatter 含 status/content_hash/provenance", () => {
    const root = makeVault();
    const r = ingestChapter(root, {
      chapterIndex: 3,
      text: "第三章正文",
      source: "word-paste",
      title: "雨夜",
    });
    expect(r.skipped).toBe(false);
    const raw = readFileSync(join(root, "chapters", "003.md"), "utf8");
    expect(raw).toContain("chapter_index: 3");
    expect(raw).toContain("status: draft");
    expect(raw).toContain(`content_hash: ${r.contentHash}`);
    expect(raw).toContain('source: "word-paste"');
    expect(raw).toContain('title: "雨夜"');
    expect(raw).toContain("第三章正文");
  });

  it("幂等: 同内容二次停靠 skipped=true 且文件不变", () => {
    const root = makeVault();
    const first = ingestChapter(root, { chapterIndex: 1, text: "正文", source: "paste" });
    const before = readFileSync(join(root, "chapters", "001.md"), "utf8");
    const second = ingestChapter(root, { chapterIndex: 1, text: "正文", source: "paste" });
    expect(second.skipped).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
    expect(readFileSync(join(root, "chapters", "001.md"), "utf8")).toBe(before);
  });

  it("内容变化 → 覆盖写入且哈希变化(旧版由 git 保留)", () => {
    const root = makeVault();
    const a = ingestChapter(root, { chapterIndex: 2, text: "v1", source: "paste" });
    const b = ingestChapter(root, { chapterIndex: 2, text: "v2", source: "paste" });
    expect(b.skipped).toBe(false);
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it("非法章节索引拒绝", () => {
    const root = makeVault();
    expect(() => ingestChapter(root, { chapterIndex: 0, text: "x", source: "s" }))
      .toThrow(/chapterIndex/);
  });
});

describe("contentHashOf(N13)", () => {
  it("纯 64 位 hex", () => {
    const h = contentHashOf("abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
