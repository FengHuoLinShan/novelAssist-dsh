// Session-bound browser intake. Frozen bytes live under .git and are consumed
// by one deterministic domain callback; no host path crosses the agent tool seam.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { assertNoSymlinkOnPath, assertSafePathSegment, guardPath } from './index.js';

const RECEIPT_SCHEMA = 'novelcraft.file-intake.v1';
const RECEIPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const FILE_INTAKE_MAX_BYTES = 50 * 1024 * 1024;
export type FileIntakeKind = 'text' | 'atlas-image';
type ReceiptStatus = 'ready' | 'done' | 'failed';

interface FileIntakeReceipt {
  schema: typeof RECEIPT_SCHEMA;
  id: string;
  kind: FileIntakeKind;
  session_key: string;
  file_name: string;
  byte_length: number;
  sha256: string;
  metadata: Record<string, string>;
  status: ReceiptStatus;
  created_at: string;
  completed_at?: string;
  result?: unknown;
  error?: string;
}

export type FileIntakeErrorCode =
  | 'INVALID'
  | 'NOT_FOUND'
  | 'SESSION_MISMATCH'
  | 'TAMPERED'
  | 'BUSY'
  | 'FAILED';

export class FileIntakeError extends Error {
  constructor(message: string, readonly code: FileIntakeErrorCode) {
    super(message);
    this.name = 'FileIntakeError';
  }
}

export interface StagedFileIntake {
  receiptId: string;
  fileName: string;
  byteLength: number;
  sha256: string;
}

export interface ConsumedFileIntake {
  receiptId: string;
  fileName: string;
  bytes: Buffer;
  metadata: Readonly<Record<string, string>>;
}

function sessionKey(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new FileIntakeError('会话标识缺失, 拒绝暂存文件', 'INVALID');
  }
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

function receiptFiles(root: string, key: string, id: string) {
  if (!RECEIPT_ID_RE.test(id)) throw new FileIntakeError('文件收据格式非法', 'INVALID');
  assertSafePathSegment(key, 'session key');
  assertSafePathSegment(id, 'receipt id');
  const dir = guardPath(root, path.join(root, '.git', 'novelcraft-intake', key));
  const receipt = guardPath(root, path.join(dir, `${id}.json`));
  const bytes = guardPath(root, path.join(dir, `${id}.bin`));
  const lock = guardPath(root, path.join(dir, `${id}.lock`));
  assertNoSymlinkOnPath(root, receipt);
  assertNoSymlinkOnPath(root, bytes);
  assertNoSymlinkOnPath(root, lock);
  return { dir, receipt, bytes, lock };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeFileName(fileName: string): string {
  if (typeof fileName !== 'string' || fileName.trim() === '' || fileName.length > 255) {
    throw new FileIntakeError('文件名无效', 'INVALID');
  }
  const base = fileName.split(/[\\/]/).pop() ?? '';
  if (base !== fileName) throw new FileIntakeError('文件名不得包含路径', 'INVALID');
  try {
    return assertSafePathSegment(base, 'file name');
  } catch (error) {
    throw new FileIntakeError(error instanceof Error ? error.message : '文件名无效', 'INVALID');
  }
}

function safeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key) || typeof value !== 'string' || value.length > 256) {
      throw new FileIntakeError('文件收据元数据非法', 'INVALID');
    }
    out[key] = value;
  }
  return out;
}

function parseReceipt(raw: string): FileIntakeReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new FileIntakeError('文件收据已损坏', 'TAMPERED');
  }
  if (typeof value !== 'object' || value === null) throw new FileIntakeError('文件收据已损坏', 'TAMPERED');
  const r = value as Partial<FileIntakeReceipt>;
  if (
    r.schema !== RECEIPT_SCHEMA || typeof r.id !== 'string' || !RECEIPT_ID_RE.test(r.id) ||
    (r.kind !== 'text' && r.kind !== 'atlas-image') ||
    typeof r.session_key !== 'string' || !/^[0-9a-f]{32}$/.test(r.session_key) ||
    typeof r.file_name !== 'string' || typeof r.byte_length !== 'number' ||
    !Number.isSafeInteger(r.byte_length) || r.byte_length < 1 || r.byte_length > FILE_INTAKE_MAX_BYTES ||
    typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256) ||
    typeof r.metadata !== 'object' || r.metadata === null || Array.isArray(r.metadata) ||
    !['ready', 'done', 'failed'].includes(String(r.status)) || typeof r.created_at !== 'string'
  ) {
    throw new FileIntakeError('文件收据字段非法', 'TAMPERED');
  }
  safeMetadata(r.metadata as Record<string, string>);
  return r as FileIntakeReceipt;
}

function writeReceipt(root: string, target: string, receipt: FileIntakeReceipt): void {
  const tmp = guardPath(root, `${target}.${randomUUID()}.tmp`);
  assertNoSymlinkOnPath(root, tmp);
  writeFileSync(tmp, JSON.stringify(receipt), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(tmp, target);
}

export function stageFileIntake(
  root: string,
  sessionId: string,
  input: { kind: FileIntakeKind; fileName: string; bytes: Uint8Array; metadata?: Record<string, string> },
): StagedFileIntake {
  const bytes = Buffer.from(input.bytes);
  if (bytes.byteLength === 0) throw new FileIntakeError('文件为空', 'INVALID');
  if (bytes.byteLength > FILE_INTAKE_MAX_BYTES) throw new FileIntakeError('文件超过 50MB 上限', 'INVALID');
  const fileName = safeFileName(input.fileName);
  const metadata = safeMetadata(input.metadata);
  const key = sessionKey(sessionId);
  const id = randomUUID();
  const files = receiptFiles(root, key, id);
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  assertNoSymlinkOnPath(root, files.dir);
  const digest = sha256(bytes);
  try {
    writeFileSync(files.bytes, bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(files.receipt, JSON.stringify({
      schema: RECEIPT_SCHEMA,
      id,
      kind: input.kind,
      session_key: key,
      file_name: fileName,
      byte_length: bytes.byteLength,
      sha256: digest,
      metadata,
      status: 'ready',
      created_at: new Date().toISOString(),
    } satisfies FileIntakeReceipt), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    rmSync(files.bytes, { force: true });
    rmSync(files.receipt, { force: true });
    throw error;
  }
  return { receiptId: id, fileName, byteLength: bytes.byteLength, sha256: digest };
}

export function consumeFileIntake<T>(
  root: string,
  sessionId: string,
  receiptId: string,
  kind: FileIntakeKind,
  consume: (input: ConsumedFileIntake) => T,
): T {
  const key = sessionKey(sessionId);
  const files = receiptFiles(root, key, receiptId);
  let receipt: FileIntakeReceipt;
  try {
    receipt = parseReceipt(readFileSync(files.receipt, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FileIntakeError('文件收据不存在或不属于当前会话', 'NOT_FOUND');
    }
    throw error;
  }
  if (receipt.id !== receiptId || receipt.session_key !== key) {
    throw new FileIntakeError('文件收据不属于当前会话', 'SESSION_MISMATCH');
  }
  if (receipt.kind !== kind) throw new FileIntakeError('文件收据类型不匹配', 'INVALID');
  if (receipt.status === 'done' && receipt.result !== undefined) return receipt.result as T;
  if (receipt.status === 'failed') {
    throw new FileIntakeError(receipt.error ?? '此前导入已失败, 请重新选择文件', 'FAILED');
  }

  let fd: number;
  try {
    fd = openSync(files.lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new FileIntakeError('文件正在导入, 请稍后重试', 'BUSY');
    }
    throw error;
  }
  closeSync(fd);

  try {
    const bytes = readFileSync(files.bytes);
    if (bytes.byteLength !== receipt.byte_length || sha256(bytes) !== receipt.sha256) {
      throw new FileIntakeError('暂存文件与收据不一致, 已拒绝导入', 'TAMPERED');
    }
    const rawResult = consume({ receiptId, fileName: receipt.file_name, bytes, metadata: receipt.metadata });
    const serialized = JSON.stringify(rawResult);
    if (serialized === undefined) throw new FileIntakeError('导入结果不可记录', 'FAILED');
    const result = JSON.parse(serialized) as T;
    writeReceipt(root, files.receipt, {
      ...receipt,
      status: 'done',
      completed_at: new Date().toISOString(),
      result,
    });
    rmSync(files.bytes, { force: true });
    return result;
  } catch (error) {
    try {
      writeReceipt(root, files.receipt, {
        ...receipt,
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : '导入失败',
      });
      rmSync(files.bytes, { force: true });
    } catch {
      // Preserve the original failure; the receipt remains fail-closed.
    }
    throw error;
  } finally {
    rmSync(files.lock, { force: true });
  }
}
