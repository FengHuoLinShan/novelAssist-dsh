// Track 1a 文本入库行为契约。
// 依据: specs/assets/imports.md §41(ImportRecord)幂等键语义(同书同文件唯一 done)、
// §95(ImportedChapter 原文停靠); adjudications N13(content_hash 纯 64 位 hex);
// D9a(任何来源统一转纯文本, 本模块只接收纯文本)。
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MAX_IMPORT_FILE_SIZE, validateImportFile } from "@novelcraft/store";
import {
  appendImportLog,
  importTextChapters,
  readImportLog,
  splitChapterText,
} from "../src/index";

const dirs: string[] = [];
function makeVault() {
  const root = mkdtempSync(join(tmpdir(), "nct-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    import("node:fs").then((fs) => fs.rmSync(d, { recursive: true, force: true }));
  }
});

describe("splitChapterText(确定性章节切分)", () => {
  it("第X章模式: 前言计数 + 顺序与 title/text 正确", () => {
    const text =
      "前言第一段\n前言第二段\n\n第1章 风起\n夜色如墨。\n剑光乍现。\n\n第2章 云涌\n雷声轰鸣。";
    const r = splitChapterText(text);
    expect(r.warnings).toEqual([]);
    // imports.md §95 语义: 前言不进章节, 仅记归一后字符数。
    expect(r.preambleChars).toBe("前言第一段\n前言第二段".length); // 11
    expect(r.chapters).toHaveLength(2);
    expect(r.chapters[0]).toEqual({
      index: 1,
      title: "第1章 风起",
      text: "夜色如墨。\n剑光乍现。",
    });
    expect(r.chapters[1]).toEqual({ index: 2, title: "第2章 云涌", text: "雷声轰鸣。" });
  });

  it("Chapter N(大小写不敏感) + 序章/楔子/番外", () => {
    const text =
      "序章\n序章正文在此。\n\nChapter 1: 初见\n风从窗隙间涌入。\n\nchapter 2 风起\n风起于青萍之末。\n\n楔子\n楔子之引。\n\n番外 夜谈\n夜谈之言。";
    const r = splitChapterText(text);
    expect(r.warnings).toEqual([]);
    expect(r.preambleChars).toBe(0);
    expect(r.chapters.map((c) => c.title)).toEqual([
      "序章",
      "Chapter 1: 初见",
      "chapter 2 风起",
      "楔子",
      "番外 夜谈",
    ]);
    expect(r.chapters[1].index).toBe(2);
    expect(r.chapters[4].text).toBe("夜谈之言。");
  });

  it("Markdown 标题与长网文章名仍能稳定分章", () => {
    const longTitle = "第2章 " + "很长但仍是合法标题".repeat(6);
    const r = splitChapterText(`# 第一章 风起\n正文一。\n\n## ${longTitle}\n正文二。`);
    expect(r.warnings).toEqual([]);
    expect(r.chapters.map((chapter) => chapter.title)).toEqual(["第一章 风起", longTitle]);
    expect(r.chapters.map((chapter) => chapter.text)).toEqual(["正文一。", "正文二。"]);
  });

  it("零命中 → 全文作单章(title 空串) + no_headings 警告", () => {
    const text = "只有一段文字\n没有章节标题";
    const r = splitChapterText(text);
    expect(r.warnings).toContain("no_headings");
    expect(r.preambleChars).toBe(0);
    expect(r.chapters).toEqual([{ index: 1, title: "", text: "只有一段文字\n没有章节标题" }]);
  });
});

describe("importTextChapters 门禁与护栏", () => {
  it(".docx 拒绝(白名单外, R31), 不写任何文件", () => {
    const root = makeVault();
    const r = importTextChapters(root, {
      fileName: "book.docx",
      text: "第1章 风起\n正文",
      source: "t",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("docx");
    expect(r.warnings).toEqual([]);
    expect(existsSync(join(root, "imports", "import-log.jsonl"))).toBe(false);
    expect(existsSync(join(root, "chapters", "001.md"))).toBe(false);
  });

  it("v1 仅放行 .txt/.md: 白名单内 .html 仍拒绝(作者语言)", () => {
    const root = makeVault();
    const r = importTextChapters(root, {
      fileName: "book.html",
      text: "第1章 风起\n正文",
      source: "t",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("v1 仅支持 .txt/.md");
  });

  it("门禁单测: 超过 50MB 拒绝(R31 / imports.md §41 ≤50MB)", () => {
    const g = validateImportFile("big.txt", MAX_IMPORT_FILE_SIZE + 1);
    expect(g.ok).toBe(false);
    expect(g.reason).toContain("50MB");
  });

  it("U+FFFD 占比 >1% 拒绝(提示转码 UTF-8)", () => {
    const root = makeVault();
    // 2 个 U+FFFD / 17 字符 ≈ 11.8% > 1%
    const text = "第一章正文\uFFFD\uFFFD" + "正常".repeat(5);
    const r = importTextChapters(root, { fileName: "bad.txt", text, source: "t" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("UTF-8");
    expect(existsSync(join(root, "imports", "import-log.jsonl"))).toBe(false);
  });

  it("超过 20,000 字却未识别到标题时停止写入", () => {
    const root = makeVault();
    const r = importTextChapters(root, { fileName: "long.txt", text: "正文".repeat(10_001), source: "t" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("未识别到章节标题");
    expect(existsSync(join(root, "imports", "import-log.jsonl"))).toBe(false);
    expect(existsSync(join(root, "chapters", "001.md"))).toBe(false);
  });
});

describe("importTextChapters 正常导入", () => {
  it("3 章 → chapters/001..003.md + imports/<slug>.md 停靠 + import-log 一行 done(索引从 1 起)", () => {
    const root = makeVault();
    const text =
      "第1章 风起\n风起于青萍之末。\n第2章 云涌\n乌云压城城欲摧。\n第3章 雷动\n雷霆万钧。";
    const r = importTextChapters(root, {
      fileName: "test-novel.txt",
      text,
      source: "unit-test",
    });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(3);
    expect(r.imported).toBe(3);
    expect(r.skipped).toBe(0);
    expect(r.conflicts).toEqual([]);
    expect(r.importId).toMatch(/^imp-/);
    expect(r.warnings).toEqual([]);
    expect(r.preambleChars).toBe(0);
    // D9a 纯文本 → chapters/{NNN}.md; 无既有章节时从 1 起。
    expect(r.chapters?.map((c) => c.index)).toEqual([1, 2, 3]);
    for (const c of r.chapters ?? []) {
      expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/); // N13: 纯 64 位 hex
      expect(c.skipped).toBe(false);
    }
    const ch1 = readFileSync(join(root, "chapters", "001.md"), "utf8");
    expect(ch1).toContain("chapter_index: 1");
    expect(ch1).toContain('title: "第1章 风起"');
    expect(ch1).toContain("风起于青萍之末。");
    expect(readFileSync(join(root, "chapters", "003.md"), "utf8")).toContain("雷霆万钧。");
    // 原文停靠 imports/<slug>.md(imports.md §95: 原文停靠, 与最终正文分离)。
    const parked = readFileSync(join(root, "imports", "test-novel.md"), "utf8");
    expect(parked).toContain(`import_record_id: ${r.importId}`);
    expect(parked).toContain('file_name: "test-novel.txt"');
    expect(parked).toContain("file_type: txt");
    expect(parked).toContain("file_size: ");
    expect(parked).toContain("total_chapters: 3");
    expect(parked).toContain("imported_at: ");
    expect(parked).toContain('source: "unit-test"');
    expect(parked).toContain("第1章 风起\n风起于青萍之末。");
    // import-log 一行 done(imports.md §41: (novel_id, file_name) done 记录唯一)。
    const log = readImportLog(root);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe("done");
    expect(log[0].file_name).toBe("test-novel.txt");
    expect(log[0].file_type).toBe("txt");
    expect(log[0].total_chapters).toBe(3);
    expect(log[0].imported_chapters).toBe(3);
    expect(log[0].file_size).toBe(Buffer.byteLength(text, "utf8"));
    expect(log[0].novel_id).toBe(basename(root));
  });

  it("已有 001/002 时默认从 003 续接(startChapter 缺省)", () => {
    const root = makeVault();
    const first = importTextChapters(root, {
      fileName: "a.txt",
      text: "第1章 甲\n甲之正文。\n第2章 乙\n乙之正文。",
      source: "t",
    });
    expect(first.imported).toBe(2);
    const second = importTextChapters(root, {
      fileName: "b.txt",
      text: "第3章 丙\n丙之正文。",
      source: "t",
    });
    expect(second.ok).toBe(true);
    expect(second.chapters?.map((c) => c.index)).toEqual([3]);
    expect(readFileSync(join(root, "chapters", "003.md"), "utf8")).toContain("丙之正文。");
    expect(existsSync(join(root, "chapters", "004.md"))).toBe(false);
  });

  it("同 file_name 二次导入 → duplicate_import, 文件不变(imports.md §41 幂等键)", () => {
    const root = makeVault();
    const text = "第1章 风起\n风起之章。\n第2章 云涌\n云涌之章。";
    const first = importTextChapters(root, { fileName: "dup.txt", text, source: "t" });
    expect(first.imported).toBe(2);
    const beforeCh1 = readFileSync(join(root, "chapters", "001.md"), "utf8");
    const beforeLog = readFileSync(join(root, "imports", "import-log.jsonl"), "utf8");
    const second = importTextChapters(root, { fileName: "dup.txt", text, source: "t" });
    expect(second.ok).toBe(true);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(0);
    expect(second.total).toBe(0);
    expect(second.importId).toBe(first.importId);
    expect(second.warnings).toContain("duplicate_import");
    // 整体跳过: 不写任何文件(章节与日志均不变)。
    expect(readFileSync(join(root, "chapters", "001.md"), "utf8")).toBe(beforeCh1);
    expect(readFileSync(join(root, "imports", "import-log.jsonl"), "utf8")).toBe(beforeLog);
    expect(readImportLog(root)).toHaveLength(1);
  });

  it("同 file_name 但内容变化时拒绝静默跳过", () => {
    const root = makeVault();
    const first = importTextChapters(root, { fileName: "changed.txt", text: "第1章 旧稿\n旧正文。", source: "t" });
    expect(first.ok).toBe(true);
    const second = importTextChapters(root, { fileName: "changed.txt", text: "第1章 新稿\n新正文。", source: "t" });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("内容已改变");
    expect(second.warnings).toContain("source_changed");
    expect(readImportLog(root)).toHaveLength(1);
  });

  it("冲突保护: 目标 002.md 内容不同 → 002 进 conflicts 且内容不变; force 后覆盖", () => {
    const root = makeVault();
    // 预先手写 chapters/002.md(不同内容, 伪造 content_hash)。
    writeFileSync(
      join(root, "chapters", "002.md"),
      "---\nchapter_index: 2\nstatus: draft\ncontent_hash: " +
        "a".repeat(64) +
        "\n---\n手写内容\n",
      "utf8",
    );
    const text =
      "第1章 风起\n风起于青萍之末。\n第2章 云涌\n乌云压城城欲摧。\n第3章 雷动\n雷霆万钧。";
    const r = importTextChapters(root, {
      fileName: "c.txt",
      text,
      source: "t",
      startChapter: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.imported).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.conflicts).toEqual([2]);
    expect(r.chapters?.find((c) => c.index === 2)?.skipped).toBe(true);
    // 冲突章不覆盖: 手写内容原样保留。
    expect(readFileSync(join(root, "chapters", "002.md"), "utf8")).toContain("手写内容");
    expect(readFileSync(join(root, "chapters", "002.md"), "utf8")).not.toContain("乌云压城城欲摧。");
    expect(readFileSync(join(root, "chapters", "001.md"), "utf8")).toContain("风起于青萍之末。");
    expect(readFileSync(join(root, "chapters", "003.md"), "utf8")).toContain("雷霆万钧。");
    // force:true → 覆盖(不同 file_name 二次导入避开幂等键)。
    const r2 = importTextChapters(root, {
      fileName: "c2.txt",
      text,
      source: "t",
      startChapter: 1,
      force: true,
    });
    expect(r2.ok).toBe(true);
    expect(r2.conflicts).toEqual([]);
    expect(readFileSync(join(root, "chapters", "002.md"), "utf8")).toContain("乌云压城城欲摧。");
  });

  it("空文本/全空白 → ok:false, 不写任何文件", () => {
    const root = makeVault();
    const r = importTextChapters(root, { fileName: "empty.txt", text: "", source: "t" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("空");
    expect(existsSync(join(root, "imports", "import-log.jsonl"))).toBe(false);
    expect(existsSync(join(root, "chapters", "001.md"))).toBe(false);

    const r2 = importTextChapters(root, { fileName: "ws.txt", text: "  \n\t\n  ", source: "t" });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain("空");
  });
});

describe("import-log(imports.md §41 ImportRecord)", () => {
  it("appendImportLog 追加一行; readImportLog 坏行跳过容忍", () => {
    const root = makeVault();
    appendImportLog(root, {
      id: "imp-1",
      novel_id: "x",
      file_name: "a.txt",
      file_type: "txt",
      file_size: 3,
      total_chapters: 1,
      imported_chapters: 1,
      status: "done",
    });
    appendImportLog(root, {
      id: "imp-2",
      novel_id: "x",
      file_name: "b.txt",
      file_type: "txt",
      file_size: 3,
      total_chapters: 1,
      imported_chapters: 1,
      status: "failed",
      error_message: "boom",
    });
    // 手写一行坏行: 读取时跳过并容忍, 不影响其余行。
    appendFileSync(join(root, "imports", "import-log.jsonl"), "not-json\n", "utf8");
    const recs = readImportLog(root);
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.id)).toEqual(["imp-1", "imp-2"]);
    expect(recs[1].error_message).toBe("boom");
  });

  it("日志不存在 → []", () => {
    const root = makeVault();
    expect(readImportLog(root)).toEqual([]);
  });
});
