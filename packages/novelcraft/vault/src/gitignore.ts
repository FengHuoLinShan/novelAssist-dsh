// ensureVaultGitignore — 幂等维护 vault 根 .gitignore(M6 Track A1)。
// - .gitignore 不存在则创建;
// - 已存在的行不重复追加(按整行精确比对);
// - 返回实际新追加的行(未新增则返回 [])。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNoSymlinkOnPath, guardPath } from './index.js';

export function ensureVaultGitignore(root: string, entries: readonly string[]): string[] {
  const file = join(root, '.gitignore');
  // R9: 读写前 guard + 逐段 symlink 检查。预置 symlink 会被 readFileSync/
  // writeFileSync 跟随: 指向外部(有效或 dangling)→ 越界读/写; 指向 vault 内
  // 其他文件 → 错写错误目标。一律 fail-closed(外部 dangling 由 guardPath 的
  // real 检查拒绝, 内部 symlink 由 assertNoSymlinkOnPath 拒绝)。
  const p = guardPath(root, file);
  assertNoSymlinkOnPath(root, p);
  const raw = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const existingLines = raw.length > 0 ? raw.split(/\r?\n/) : [];
  const present = new Set(existingLines);

  const added: string[] = [];
  for (const e of entries) {
    if (e.length === 0) continue;
    if (present.has(e)) continue;
    present.add(e);
    added.push(e);
  }
  if (added.length === 0) return [];

  const needsSep = raw.length > 0 && !raw.endsWith('\n');
  const suffix = (needsSep ? '\n' : '') + added.join('\n') + '\n';
  writeFileSync(p, raw + suffix, 'utf8');
  return added;
}
