import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initVault } from '@novelcraft/vault';
import { gitAdd, gitCommit, listChapterHistory, readCurrentChapter } from '@novelcraft/store';
import {
  consumeStagedChapterEdit,
  executePreparedChapterWrite,
  ingestChapter,
  prepareChapterRestore,
  stageChapterEditIntake,
} from '../src/index.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nc-writing-version-'));
  roots.push(root);
  initVault(root, { title: '版本写作', language: 'zh' });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function commitIngest(root: string, text: string, subject: string): string {
  ingestChapter(root, { chapterIndex: 1, text, source: 'test', title: '第一章' });
  gitAdd(root, ['chapters/001.md']);
  return gitCommit(root, subject);
}

describe('session-bound chapter save + restore (§6.15)', () => {
  it('holds the receipt through approval, commits one changed version, and replays idempotently', async () => {
    const root = makeRoot();
    commitIngest(root, '初稿', 'chapter v1');
    const current = readCurrentChapter(root, 1);
    const staged = stageChapterEditIntake(root, 'session-a', {
      chapterIndex: 1,
      text: '轻改后的正文',
      expectedContentHash: current.contentHash,
      title: current.title,
    });
    const approve = vi.fn(executePreparedChapterWrite);
    const result = await consumeStagedChapterEdit(root, 'session-a', staged.receiptId, approve);
    expect(result.skipped).toBe(false);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(approve).toHaveBeenCalledOnce();
    expect(readCurrentChapter(root, 1).body).toBe('轻改后的正文\n');
    expect(listChapterHistory(root, 1)).toHaveLength(2);

    const replay = await consumeStagedChapterEdit(root, 'session-a', staged.receiptId, approve);
    expect(replay).toEqual(result);
    expect(approve).toHaveBeenCalledOnce();
  });

  it('rejects a stale editor baseline before approval and preserves the newer chapter', async () => {
    const root = makeRoot();
    commitIngest(root, 'v1', 'chapter v1');
    const stale = readCurrentChapter(root, 1);
    const staged = stageChapterEditIntake(root, 'session-a', {
      chapterIndex: 1,
      text: 'stale edit',
      expectedContentHash: stale.contentHash,
    });
    commitIngest(root, 'v2 from Word', 'chapter v2');
    const approve = vi.fn(executePreparedChapterWrite);
    await expect(consumeStagedChapterEdit(root, 'session-a', staged.receiptId, approve)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(approve).not.toHaveBeenCalled();
    expect(readCurrentChapter(root, 1).body).toBe('v2 from Word\n');
  });

  it('restores an old blob as a new chapter commit and fixes legacy hash metadata', async () => {
    const root = makeRoot();
    const v1 = commitIngest(root, 'v1', 'chapter v1');
    commitIngest(root, 'v2', 'chapter v2');
    const before = readCurrentChapter(root, 1);
    const prepared = prepareChapterRestore(root, 1, v1, before.contentHash);
    const result = await executePreparedChapterWrite(prepared);
    expect(result.skipped).toBe(false);
    expect(result.commit).not.toBe(v1);
    expect(readCurrentChapter(root, 1).body).toBe('v1\n');
    expect(readFileSync(path.join(root, 'chapters/001.md'), 'utf8')).toContain(`restored_from_commit: ${v1}`);
    expect(listChapterHistory(root, 1)).toHaveLength(3);
  });
});
