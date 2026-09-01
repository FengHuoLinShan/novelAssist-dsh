import fs from 'node:fs';
import path from 'node:path';

export function readText(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

export function writeText(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** 递归列出 dir 下的文件, 返回相对 dir 的路径(以 '/' 分隔), 排序后确定性输出。 */
export function listFilesRecursive(dir: string): string[] {
  const base = path.resolve(dir);
  if (!fs.existsSync(base)) return [];
  const baseStat = fs.lstatSync(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new Error(`scan root must be an ordinary directory: ${base}`);
  }
  const out: string[] = [];
  const stack: string[] = [base];
  while (stack.length) {
    const d = stack.pop()!;
    const stat = fs.lstatSync(d);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`scan directory replaced by symlink/non-directory: ${d}`);
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}
