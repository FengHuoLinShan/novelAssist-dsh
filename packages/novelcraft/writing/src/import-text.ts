// Track 1a 文本入库: 纯文本 → 确定性章节切分 → chapters/{NNN}.md 落库 +
// imports/<slug>.md 原文停靠 + imports/import-log.jsonl。
// 依据: specs/assets/imports.md §41(ImportRecord)/§95(ImportedChapter);
// adjudications N13(content_hash 纯 64 位 hex); D9a(任何来源统一转纯文本, 本模块只接收纯文本)。
// 确定性、零 LLM、零 DSH 依赖。
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { relative } from "node:path";
import { paths, readAsset, slugify, writeAsset } from "@novelcraft/vault";
import { gitAdd, gitCommit, sha256Hex, validateImportFile } from "@novelcraft/store";
import { chapterBodyText, contentHashOf, ingestChapter, normalizeChapterText } from "./ingest.js";
import { appendImportLog, importLogPath, readImportLog } from "./import-log.js";

// ============================================================================
// 确定性章节切分
// ============================================================================

export interface ParsedChapter {
  /** 文本内顺序, 从 1 起(与落库章节 index 解耦; 落库 index 由 startChapter 决定) */
  index: number;
  /** 标题行 trim 后的文本; 零命中时为空串 */
  title: string;
  /** 该标题行之后到下一标题行之前的正文(首尾 trim) */
  text: string;
}

export interface SplitChapterResult {
  chapters: ParsedChapter[];
  /** 首个标题行前的前言归一后字符数(前言不进章节) */
  preambleChars: number;
  warnings: string[];
}

/** 行首标题模式；兼容 Markdown 标题，100 字上限可覆盖常见网文章名而不吞正文段落。 */
const ZH_HEADING_RE = /^第[0-9零一二三四五六七八九十百千万两]+[章节回卷幕部](?:\s*[:：\-—]?\s*.*)?$/;
const EN_HEADING_RE = /^chapter\s+\d+(?:\s*[:：\-—]?\s*.*)?$/i;
const SPECIAL_HEADING_RE = /^(序章|楔子|番外(?:\s+.*)?|尾声|后记)$/;

function headingTitle(line: string): string | null {
  const raw = line.trim();
  const markdown = raw.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
  const title = (markdown?.[1] ?? raw).trim();
  if (title.length === 0 || title.length > 100) return null;
  return ZH_HEADING_RE.test(title) || EN_HEADING_RE.test(title) || SPECIAL_HEADING_RE.test(title)
    ? title
    : null;
}

/** 确定性章节切分: 行首标题(第X章/Chapter N/序章楔子番外尾声后记)→ 章节; 标题前 → 前言。 */
export function splitChapterText(text: string): SplitChapterResult {
  const lines = text.split(/\r?\n/);
  const headings: Array<{ line: number; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const title = headingTitle(lines[i]);
    if (title !== null) headings.push({ line: i, title });
  }

  if (headings.length === 0) {
    // 零命中 → 全文作单章(title 空串), 记 no_headings 警告。
    return {
      chapters: [{ index: 1, title: "", text: lines.join("\n").trim() }],
      preambleChars: 0,
      warnings: ["no_headings"],
    };
  }

  // 首个标题行前内容 = 前言, 不进章节; preambleChars = 归一后字符数。
  const preambleLines = lines.slice(0, headings[0].line);
  const preamble = preambleLines.join("\n").trim();
  const preambleChars = preamble.length === 0 ? 0 : normalizeChapterText(preamble).length;

  const chapters: ParsedChapter[] = [];
  for (let h = 0; h < headings.length; h++) {
    const start = headings[h].line;
    const end = h + 1 < headings.length ? headings[h + 1].line : lines.length;
    const title = headings[h].title;
    const body = lines.slice(start + 1, end).join("\n").trim();
    chapters.push({ index: h + 1, title, text: body });
  }

  return { chapters, preambleChars, warnings: [] };
}

// ============================================================================
// 文本入库
// ============================================================================

export interface ImportTextOptions {
  /** 原始文件名(可带路径; 入库一律 basename 化) */
  fileName: string;
  /** 纯文本内容(UTF-8; D9a: 转换在 DSH 网页层完成) */
  text: string;
  /** 来源标记(进 imports/<slug>.md frontmatter 与章节 provenance.source) */
  source: string;
  /** 落库起始章节 index; 缺省 = 现有 chapters/NNN.md 最大 index + 1(无则 1) */
  startChapter?: number;
  /** force=true 时目标章节内容不同也直接覆盖(默认冲突保护跳过) */
  force?: boolean;
}

export interface ImportReport {
  ok: boolean;
  reason?: string;
  importId?: string;
  total?: number;
  imported?: number;
  skipped?: number;
  conflicts?: number[];
  chapters?: Array<{ index: number; title: string; contentHash: string; skipped: boolean }>;
  warnings: string[];
  preambleChars?: number;
}

/**
 * 文本入库主流程(步骤见 Track 1a):
 * 1 门禁(R31: 白名单 + 50MB + basename 净化; v1 额外只放行 .txt/.md)
 * 2 编码护栏(U+FFFD 占比 >1% 拒绝)
 * 3 归一 → 确定性章节切分
 * 4 幂等(imports.md §41: 同名 done 记录先以原文 hash 核对；漂移则拒绝静默跳过)
 * 5 原文停靠 imports/<slug>.md
 * 6 章节落库(冲突保护 / force 覆盖)
 * 7 追加 import-log.jsonl(spec ImportRecord)
 * 失败(门禁/编码/空文本)→ {ok:false}, 不写任何文件、不写 log。
 */
export function importTextChapters(root: string, opts: ImportTextOptions): ImportReport {
  const base = path.basename(opts.fileName);
  const fileSize = Buffer.byteLength(opts.text, "utf8");

  // 1. 门禁(R31 / imports.md §41: 白名单 .txt/.epub/.html/.htm/.mobi/.azw3, ≤50MB, basename 防穿越)。
  const gate = validateImportFile(base, fileSize);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason ?? "导入文件校验未通过", warnings: [] };
  }
  const ext = path.extname(base).toLowerCase();
  if (ext !== ".txt" && ext !== ".md") {
    // v1 仅放行纯文本(D9a: 统一纯文本), 其余白名单扩展名也拒绝, 作者语言提示。
    return { ok: false, reason: "v1 仅支持 .txt/.md, 请先另存为纯文本", warnings: [] };
  }

  // 2. 编码护栏: U+FFFD 占比 >1% → 拒绝(提示转码 UTF-8)。
  if (replacementCharRatio(opts.text) > 0.01) {
    return {
      ok: false,
      reason: "检测到乱码字符(U+FFFD), 请先将文件转码为 UTF-8 后重试",
      warnings: [],
    };
  }

  // 3. 归一 → 章节切分。
  const normalized = normalizeChapterText(opts.text);
  if (normalized.trim() === "") {
    return { ok: false, reason: "导入文本为空, 无法解析章节", warnings: [] };
  }
  const split = splitChapterText(normalized);
  if (split.warnings.includes("no_headings") && normalized.length > 20_000) {
    return {
      ok: false,
      reason: "长稿未识别到章节标题，已停止写入。请使用“第X章”或 Markdown“# 第X章”标题后重试",
      warnings: split.warnings,
    };
  }
  const sourceContentHash = sha256Hex(normalized);

  // 4. 幂等: 同 file_name + 归一化内容 hash 才整体跳过；同名内容漂移 fail-closed。
  const p = paths(root);
  const existing = readImportLog(root).find(
    (r) => r.file_name === base && r.status === "done",
  );
  if (existing) {
    if (existing.content_hash !== sourceContentHash) {
      return {
        ok: false,
        reason: existing.content_hash === undefined
          ? "同名文件已有旧导入记录但无法核对内容，请改名后重试"
          : "同名文件内容已改变，请改名后重试以保留两次导入来源",
        warnings: [...split.warnings, "source_changed"],
      };
    }
    return {
      ok: true,
      skipped: 0,
      imported: 0,
      total: 0,
      chapters: [],
      conflicts: [],
      warnings: [...split.warnings, "duplicate_import"],
      importId: existing.id,
    };
  }

  // 5-7 批量原子收口(N32 同步面, 交接 §7 条目 11):
  // - 首写前逐文件快照原字节; 任何中途异常 → 恢复快照(新建删除/覆写还原)后重抛,
  //   零部分写入残留(补偿回滚; 进程级崩溃的 durable 原子由 imports 侧 Tx 变体承接);
  // - 全部成功后按精确 pathspec 单 commit(「素材先提交」—— commitScenes 的 R17
  //   DIRTY_WORKSPACE 门自此满足, 深导可直接续跑)。
  const importId = `imp-${Date.now()}`;
  const slug = slugify(base.replace(/\.[^.]*$/, ""));
  const importFile = p.imports.importFile(`${slug}.md`);
  const importedAt = new Date().toISOString();
  const touched: Array<{ abs: string; original: string | null }> = [];
  const recordTouched = (abs: string): void => {
    if (!touched.some((t) => t.abs === abs)) {
      touched.push({ abs, original: existsSync(abs) ? readFileSync(abs, "utf8") : null });
    }
  };

  let imported = 0;
  let skipped = 0;
  const conflicts: number[] = [];
  const chaptersReport: NonNullable<ImportReport["chapters"]> = [];
  try {
    // 5. 原文停靠 imports/<slug>.md(正文 = 归一后全文; imports.md §95 原文停靠)。
    const fmLines = [
      "---",
      `import_record_id: ${importId}`,
      `file_name: ${yamlString(base)}`,
      `file_type: ${ext.slice(1)}`,
      `file_size: ${fileSize}`,
      `source_content_hash: ${sourceContentHash}`,
      `total_chapters: ${split.chapters.length}`,
      `imported_at: "${importedAt}"`,
      `source: ${yamlString(opts.source)}`,
      "---",
      "",
    ];
    recordTouched(importFile);
    writeAsset(root, importFile, fmLines.join("\n") + normalized + "\n");

    // 6. 章节落库: 起始 index = startChapter ?? 现有最大 index + 1(无则 1); 逐章冲突保护。
    const startChapter = opts.startChapter ?? maxChapterIndex(root) + 1;
    for (const ch of split.chapters) {
      const chapterIndex = startChapter + ch.index - 1;
      const target = p.chapters.chapterFile(chapterIndex);
      const contentHash = contentHashOf(chapterBodyText(ch.text));

      // 冲突判定: 目标已存在且内容 hash 不同(含无法读到 hash 的手写文件)→ !force 时跳过。
      const existingRaw = existsSync(target) ? readAsset(root, target) : null;
      if (existingRaw !== null) {
        const m = existingRaw.match(/^content_hash:\s*([0-9a-f]{64})/m);
        const sameHash = m !== null && m[1] === contentHash;
        if (!sameHash && !opts.force) {
          conflicts.push(chapterIndex);
          skipped += 1;
          chaptersReport.push({ index: chapterIndex, title: ch.title, contentHash, skipped: true });
          continue;
        }
      }

      // 同 hash → ingestChapter 自然幂等跳过; 不同 hash + force → 覆盖写入。
      recordTouched(target);
      const r = ingestChapter(root, {
        chapterIndex,
        text: ch.text,
        source: `import:${base}`,
        title: ch.title || undefined,
      });
      if (r.skipped) skipped += 1;
      else imported += 1;
      chaptersReport.push({ index: chapterIndex, title: ch.title, contentHash, skipped: r.skipped });
    }

    // 7. 追加 import-log.jsonl(imports.md §41 ImportRecord 字段; 有 conflicts 且无 force 时仍 done)。
    recordTouched(importLogPath(root));
    appendImportLog(root, {
      id: importId,
      novel_id: path.basename(root),
      file_name: base,
      file_type: ext.slice(1),
      file_size: fileSize,
      total_chapters: split.chapters.length,
      imported_chapters: imported,
      content_hash: sourceContentHash,
      status: "done",
    });
  } catch (err) {
    // 补偿回滚: 恢复每个首写前快照(新建 → 删除; 覆写 → 还原), 零部分残留后重抛。
    for (const t of touched) {
      try {
        if (t.original === null) rmSync(t.abs, { force: true });
        else writeFileSync(t.abs, t.original, "utf8");
      } catch {
        // 单文件恢复失败不掩盖原异常(极端 fs 故障; 文件真相可由 git/重导修复)。
      }
    }
    throw err;
  }

  // 素材先提交: 精确 pathspec 单 commit(绝不 -A 卷入并发用户编辑)。
  if (touched.length > 0) {
    gitAdd(root, touched.map((t) => relative(root, t.abs).split("\\").join("/")));
    gitCommit(root, `material intake: ${base} (${imported} chapters)`);
  }

  // 8. 完整报告。
  return {
    ok: true,
    importId,
    total: split.chapters.length,
    imported,
    skipped,
    conflicts,
    chapters: chaptersReport,
    warnings: split.warnings,
    preambleChars: split.preambleChars,
  };
}

/** U+FFFD 占比(编码护栏判定)。 */
function replacementCharRatio(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (const ch of text) {
    if (ch === "\uFFFD") count += 1;
  }
  return count / text.length;
}

/** chapters/ 下现有 NNN.md 的最大 index; 无则 0(起始 index 由此 +1)。 */
function maxChapterIndex(root: string): number {
  const dir = paths(root).chapters.dir;
  if (!existsSync(dir)) return 0;
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = /^(\d{3})\.md$/.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/** 最小 YAML 双引号转义(确定性 frontmatter 输出)。 */
function yamlString(value: string): string {
  return (
    '"' +
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}
