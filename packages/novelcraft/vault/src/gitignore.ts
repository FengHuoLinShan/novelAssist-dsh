// ensureVaultGitignore — 幂等维护 vault 根 .gitignore(M6 Track A1)。
// - .gitignore 不存在则创建;
// - 已存在的行不重复追加(按整行精确比对);
// - 返回实际新追加的行(未新增则返回 [])。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function ensureVaultGitignore(root: string, entries: readonly string[]): string[] {
  const file = join(root, '.gitignore');
  const raw = existsSync(file) ? readFileSync(file, 'utf8') : '';
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
  writeFileSync(file, raw + suffix, 'utf8');
  return added;
}
