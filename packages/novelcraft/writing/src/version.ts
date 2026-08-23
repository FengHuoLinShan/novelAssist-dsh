import { existsSync, readFileSync } from 'node:fs';
import {
  contentHash,
  executePreparedCanonicalWrite,
  gitHead,
  parseFrontmatter,
  prepareCanonicalWrite,
  readChapterVersion,
  readCurrentChapter,
  serializeFrontmatter,
  StoreError,
  validateFrontmatterForWrite,
  type PreparedCanonicalWrite,
} from '@novelcraft/store';
import {
  consumeFileIntakeAsync,
  FileIntakeError,
  paths,
  stageFileIntake,
  type StagedFileIntake,
} from '@novelcraft/vault';
import { chapterBodyText } from './ingest.js';

export interface ChapterWriteResult {
  chapterIndex: number;
  contentHash: string;
  commit: string;
  skipped: boolean;
  source: 'browser-edit' | 'restore';
}

export interface PreparedChapterWrite {
  readonly chapterIndex: number;
  readonly contentHash: string;
  readonly source: ChapterWriteResult['source'];
  readonly summary: string;
  readonly write?: PreparedCanonicalWrite;
}

const trustedWrites = new WeakSet<object>();

function freezePrepared(input: PreparedChapterWrite): PreparedChapterWrite {
  const prepared = Object.freeze(input);
  trustedWrites.add(prepared);
  return prepared;
}

function indexOf(value: string | undefined): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) {
    throw new FileIntakeError('章节编辑收据缺少合法章节序号', 'INVALID');
  }
  return index;
}

function decode(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new FileIntakeError('章节正文包含 NUL, 已拒绝保存', 'INVALID');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FileIntakeError('章节正文不是有效 UTF-8', 'INVALID');
  }
}

function provenance(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function stageChapterEditIntake(
  root: string,
  sessionId: string,
  input: { chapterIndex: number; text: string; expectedContentHash?: string; expectedAbsent?: boolean; title?: string },
): StagedFileIntake {
  if (!Number.isInteger(input.chapterIndex) || input.chapterIndex < 1) {
    throw new FileIntakeError('chapterIndex 必须是 >=1 的整数', 'INVALID');
  }
  if (typeof input.text !== 'string' || input.text.trim() === '') {
    throw new FileIntakeError('章节正文不能为空', 'INVALID');
  }
  const expected = input.expectedAbsent
    ? 'absent'
    : input.expectedContentHash;
  if (expected !== 'absent' && !/^[0-9a-f]{64}$/.test(expected ?? '')) {
    throw new FileIntakeError('章节编辑缺少有效基线哈希', 'INVALID');
  }
  return stageFileIntake(root, sessionId, {
    kind: 'chapter-edit',
    fileName: `chapter-${String(input.chapterIndex).padStart(3, '0')}.md`,
    bytes: new TextEncoder().encode(input.text),
    metadata: {
      chapter_index: String(input.chapterIndex),
      expected_content_hash: expected ?? '',
      ...(input.title !== undefined ? { title: input.title } : {}),
    },
  });
}

function prepareChapterSave(
  root: string,
  input: { chapterIndex: number; text: string; expected: string; title?: string },
): PreparedChapterWrite {
  const body = chapterBodyText(input.text);
  const hash = contentHash(body);
  const abs = paths(root).chapters.chapterFile(input.chapterIndex);
  const file = `chapters/${String(input.chapterIndex).padStart(3, '0')}.md`;
  let currentRaw: string | null = null;
  let data: Record<string, unknown> = {};
  let currentBody: string | undefined;
  let currentTitle: string | undefined;

  if (existsSync(abs)) {
    if (input.expected === 'absent') {
      throw new StoreError('CONFLICT', `第 ${input.chapterIndex} 章已存在, 不能按新章保存`);
    }
    const current = readCurrentChapter(root, input.chapterIndex);
    if (current.contentHash !== input.expected) {
      throw new StoreError('CONFLICT', `第 ${input.chapterIndex} 章已变化, 请刷新后重试`);
    }
    currentRaw = readFileSync(abs, 'utf8');
    const parsed = parseFrontmatter(currentRaw);
    data = parsed.data as Record<string, unknown>;
    currentBody = parsed.body;
    currentTitle = typeof data.title === 'string' ? data.title : undefined;
  } else if (input.expected !== 'absent') {
    throw new StoreError('CONFLICT', `第 ${input.chapterIndex} 章已不存在, 不能覆盖保存`);
  }

  const nextTitle = input.title !== undefined ? input.title.trim() || undefined : currentTitle;
  if (currentBody === body && currentTitle === nextTitle) {
    return freezePrepared({
      chapterIndex: input.chapterIndex,
      contentHash: hash,
      source: 'browser-edit',
      summary: `第 ${input.chapterIndex} 章内容未变化`,
    });
  }

  const next: Record<string, unknown> = {
    ...data,
    chapter_index: input.chapterIndex,
    status: 'draft',
    content_hash: hash,
    provenance: {
      ...provenance(data.provenance),
      source: 'browser-edit',
      saved_at: new Date().toISOString(),
    },
  };
  if (nextTitle !== undefined) next.title = nextTitle;
  else delete next.title;
  const checked = validateFrontmatterForWrite('chapter', next, String(input.chapterIndex).padStart(3, '0'));
  const write = prepareCanonicalWrite(root, [{
    path: file,
    current: currentRaw,
    output: serializeFrontmatter(checked, body),
  }], {
    purpose: `save chapter ${input.chapterIndex}`,
    expectedHead: gitHead(root),
  });
  return freezePrepared({
    chapterIndex: input.chapterIndex,
    contentHash: hash,
    source: 'browser-edit',
    summary: `保存第 ${input.chapterIndex} 章正文`,
    write,
  });
}

export function prepareChapterRestore(
  root: string,
  chapterIndex: number,
  commit: string,
  expectedContentHash: string,
): PreparedChapterWrite {
  const current = readCurrentChapter(root, chapterIndex);
  if (current.contentHash !== expectedContentHash) {
    throw new StoreError('CONFLICT', `第 ${chapterIndex} 章已变化, 拒绝恢复旧版本`);
  }
  const version = readChapterVersion(root, chapterIndex, commit);
  if (current.body === version.body && current.title === version.title) {
    return freezePrepared({
      chapterIndex,
      contentHash: current.contentHash,
      source: 'restore',
      summary: `第 ${chapterIndex} 章已与所选版本一致`,
    });
  }
  const abs = paths(root).chapters.chapterFile(chapterIndex);
  const currentRaw = readFileSync(abs, 'utf8');
  const currentData = parseFrontmatter(currentRaw).data as Record<string, unknown>;
  const next: Record<string, unknown> = {
    ...currentData,
    chapter_index: chapterIndex,
    status: 'draft',
    content_hash: version.contentHash,
    provenance: {
      ...provenance(currentData.provenance),
      source: 'restore',
      restored_from_commit: version.commit,
      restored_at: new Date().toISOString(),
    },
  };
  if (version.title !== undefined) next.title = version.title;
  else delete next.title;
  const checked = validateFrontmatterForWrite('chapter', next, String(chapterIndex).padStart(3, '0'));
  const write = prepareCanonicalWrite(root, [{
    path: current.file,
    current: currentRaw,
    output: serializeFrontmatter(checked, version.body),
  }], {
    purpose: `restore chapter ${chapterIndex} from ${version.commit}`,
    expectedHead: current.head,
  });
  return freezePrepared({
    chapterIndex,
    contentHash: version.contentHash,
    source: 'restore',
    summary: `恢复第 ${chapterIndex} 章到 ${version.commit.slice(0, 12)} 的正文`,
    write,
  });
}

export async function executePreparedChapterWrite(prepared: PreparedChapterWrite): Promise<ChapterWriteResult> {
  if (!trustedWrites.has(prepared) || !Object.isFrozen(prepared)) {
    throw new StoreError('VALIDATION_FAILED', '章节写计划非可信或已被修改');
  }
  if (prepared.write === undefined) {
    return {
      chapterIndex: prepared.chapterIndex,
      contentHash: prepared.contentHash,
      commit: '',
      skipped: true,
      source: prepared.source,
    };
  }
  const result = await executePreparedCanonicalWrite(prepared.write);
  return {
    chapterIndex: prepared.chapterIndex,
    contentHash: prepared.contentHash,
    commit: result.commit,
    skipped: false,
    source: prepared.source,
  };
}

/** Receipt stays locked across the caller's approval + prepared transaction execution. */
export function consumeStagedChapterEdit(
  root: string,
  sessionId: string,
  receiptId: string,
  approveAndExecute: (prepared: PreparedChapterWrite) => Promise<ChapterWriteResult>,
): Promise<ChapterWriteResult> {
  return consumeFileIntakeAsync(root, sessionId, receiptId, 'chapter-edit', async ({ bytes, metadata }) => {
    const prepared = prepareChapterSave(root, {
      chapterIndex: indexOf(metadata.chapter_index),
      text: decode(bytes),
      expected: metadata.expected_content_hash ?? '',
      ...(metadata.title !== undefined ? { title: metadata.title } : {}),
    });
    if (prepared.write === undefined) return executePreparedChapterWrite(prepared);
    return approveAndExecute(prepared);
  });
}
