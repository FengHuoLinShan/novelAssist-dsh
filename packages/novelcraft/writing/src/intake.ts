import path from 'node:path';
import { MAX_IMPORT_FILE_SIZE, validateImportFile } from '@novelcraft/store';
import {
  consumeFileIntake,
  FileIntakeError,
  stageFileIntake,
  type FileIntakeErrorCode,
  type StagedFileIntake,
} from '@novelcraft/vault';
import { importTextChapters, type ImportReport } from './import-text.js';

export { FileIntakeError as TextIntakeError } from '@novelcraft/vault';
export type TextIntakeErrorCode = FileIntakeErrorCode;
export type StagedTextIntake = StagedFileIntake;

function decodeText(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new FileIntakeError('文件疑似二进制内容, 仅支持 UTF-8 文本', 'INVALID');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FileIntakeError('文件不是有效 UTF-8 文本, 请转码后重试', 'INVALID');
  }
}

function validateText(fileName: string, bytes: Uint8Array): void {
  const gate = validateImportFile(fileName, bytes.byteLength);
  if (!gate.ok) throw new FileIntakeError(gate.reason ?? '文件校验未通过', 'INVALID');
  const ext = path.extname(fileName).toLowerCase();
  if (ext !== '.txt' && ext !== '.md') throw new FileIntakeError('当前仅支持 .txt/.md UTF-8 文本', 'INVALID');
  if (bytes.byteLength > MAX_IMPORT_FILE_SIZE) throw new FileIntakeError('文件超过 50MB 上限', 'INVALID');
  decodeText(bytes);
}

export function stageTextIntake(
  root: string,
  sessionId: string,
  fileName: string,
  bytes: Uint8Array,
): StagedTextIntake {
  validateText(fileName, bytes);
  return stageFileIntake(root, sessionId, { kind: 'text', fileName, bytes });
}

export function importStagedTextIntake(
  root: string,
  sessionId: string,
  receiptId: string,
  opts: { startChapter?: number; force?: boolean } = {},
): ImportReport {
  return consumeFileIntake(root, sessionId, receiptId, 'text', ({ fileName, bytes, receiptId: id }) => {
    const report = importTextChapters(root, {
      fileName,
      text: decodeText(bytes),
      source: `intake:${id}`,
      ...(opts.startChapter !== undefined ? { startChapter: opts.startChapter } : {}),
      ...(opts.force ? { force: true } : {}),
    });
    if (!report.ok) throw new FileIntakeError(report.reason ?? '导入失败', 'FAILED');
    return report;
  });
}
