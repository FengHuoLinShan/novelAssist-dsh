// R3 停靠: 纯文本 → chapters/{NNN}.md(确定性, 零 LLM)。
// 依据: specs/assets/writing.md「章节正文」; adjudications N13(hash 格式);
// PLAN.md 步骤 1。文本转换(D9a: 任何来源统一转纯文本)发生在 DSH 网页层,
// 本函数只接收已是纯文本的输入。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { paths, readAsset, writeAsset } from "@novelcraft/vault";

export interface IngestOptions {
  /** 章节索引, 从 1 起(文件名 NNN.md 承载) */
  chapterIndex: number;
  /** 纯文本正文(未经归一的原文) */
  text: string;
  /** 来源标记(如 "word-paste" / "drag:xxx.txt"), 进 provenance.source */
  source: string;
  /** 章节标题(可选) */
  title?: string;
}

export interface IngestResult {
  /** 章节文件路径(相对 vault 根) */
  file: string;
  /** 是否因同哈希已存在而跳过 */
  skipped: boolean;
  /** 归一化后的正文 SHA-256(纯 64 位 hex, N13) */
  contentHash: string;
}

/** 文本归一: 去 BOM、CRLF→LF、行尾空白清除、连续空行折叠为最多一个空行。
 *  归一保证「同一内容多次停靠」哈希稳定(幂等, writing.md content_hash 语义)。 */
export function normalizeChapterText(text: string): string {
  const withoutBom = text.replace(/^\uFEFF/, "");
  const lf = withoutBom.replace(/\r\n?/g, "\n");
  const trimmed = lf
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
  return trimmed.replace(/\n{3,}/g, "\n\n");
}

export function contentHashOf(normalizedText: string): string {
  return createHash("sha256").update(normalizedText, "utf8").digest("hex");
}

/** 生成章节 frontmatter(字段表: specs/assets/writing.md「章节正文」)。
 *  status 固定 draft(旧 working 面; published/canonical 走 store 状态机)。 */
export function chapterFrontmatter(input: {
  chapterIndex: number;
  contentHash: string;
  source: string;
  title?: string;
}): string {
  const lines = [
    "---",
    `chapter_index: ${input.chapterIndex}`,
    `status: draft`,
    `content_hash: ${input.contentHash}`,
    "provenance:",
    `  source: "${input.source}"`,
  ];
  if (input.title && input.title.trim()) {
    lines.splice(2, 0, `title: "${input.title.trim()}"`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

/** 停靠一章: 归一 → 哈希 → 幂等跳过 → 写 chapters/{NNN}.md。 */
export function ingestChapter(root: string, opts: IngestOptions): IngestResult {
  if (!Number.isInteger(opts.chapterIndex) || opts.chapterIndex < 1) {
    throw new Error("chapterIndex 必须是 ≥1 的整数");
  }
  const p = paths(root);
  const normalized = normalizeChapterText(opts.text);
  const contentHash = contentHashOf(normalized);
  const file = p.chapters.chapterFile(opts.chapterIndex);

  if (existsSync(file)) {
    const existing = readAsset(root, p.chapters.chapterFile(opts.chapterIndex));
    const m = existing.match(/^content_hash:\s*([0-9a-f]{64})/m);
    if (m && m[1] === contentHash) {
      return { file: p.chapters.chapterFile(opts.chapterIndex), skipped: true, contentHash };
    }
  }

  const body = chapterFrontmatter({
    chapterIndex: opts.chapterIndex,
    contentHash,
    source: opts.source,
    title: opts.title,
  });
  writeAsset(root, p.chapters.chapterFile(opts.chapterIndex), body + normalized + "\n");
  return { file, skipped: false, contentHash };
}


