import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initVault } from '@novelcraft/vault';
import { gitAdd, gitCommit, gitHead, gitStatusEntries } from '../src/git';
import { serializeFrontmatter, parseFrontmatter } from '../src/frontmatter';

export interface VaultFixture {
  root: string;
  cleanup: () => void;
}

export function tmpVault(): VaultFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvc-store-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 用 vault 初始化目录树 + git init(真实临时 git 仓库)。 */
export function initRepo(root: string): void {
  initVault(root, { title: '测试书' });
}

export function commitAll(root: string, msg = 'fixture'): string {
  gitAdd(root);
  // N32 bootstrapVaultGitHistory already committed book.yml/.gitignore. Legacy fixtures may
  // immediately call commitAll with no additional change; keep the existing HEAD deterministically.
  if (!gitStatusEntries(root).some((entry) => entry.status[0] !== ' ' && entry.status[0] !== '?')) {
    return gitHead(root);
  }
  return gitCommit(root, msg);
}

export function writeAsset(root: string, relPath: string, fm: Record<string, unknown>, body = ''): string {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, serializeFrontmatter(fm, body), 'utf8');
  return abs;
}

export function readFrontmatter(root: string, relPath: string): Record<string, unknown> {
  return parseFrontmatter(fs.readFileSync(path.join(root, relPath), 'utf8')).data;
}

export function readBody(root: string, relPath: string): string {
  return parseFrontmatter(fs.readFileSync(path.join(root, relPath), 'utf8')).body;
}
