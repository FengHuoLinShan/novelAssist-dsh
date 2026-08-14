import { createHash } from 'node:crypto';

/** 纯确定性 SHA-256(hex)。正文 content_hash、provenance_key 的底层。 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 资产内容哈希 = 正文(去 frontmatter 后的 markdown body)UTF-8 字节的 SHA-256。
 * 统一为纯 64 位 hex 格式(与旧引擎 writing 一致, 见 specs/assets/writing.md);
 * 读入时兼容 `sha256:` 前缀。
 */
export function contentHash(body: string): string {
  return sha256Hex(body);
}

/** 读入 content_hash 时兼容 `sha256:` 前缀, 输出统一为纯 hex。 */
export function normalizeContentHash(hash: string): string {
  return String(hash ?? '').replace(/^sha256:/i, '').trim();
}
