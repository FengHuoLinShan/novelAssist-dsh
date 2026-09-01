#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'novelcraft-vault-portability/v1';

function fail(message) {
  throw new Error(`vault portability: ${message}`);
}

function hashFile(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(file, 'r');
  try {
    for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; read = readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function manifest(root) {
  const entries = [];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) fail(`拒绝不可移植的符号链接: ${rel}`);
      if (stat.isDirectory()) {
        entries.push({ path: `${rel}/`, type: 'directory', mode: stat.mode & 0o777 });
        walk(full, rel);
      } else if (stat.isFile()) {
        entries.push({ path: rel, type: 'file', mode: stat.mode & 0o777, size: stat.size, sha256: hashFile(full) });
      } else {
        fail(`拒绝非普通文件/目录: ${rel}`);
      }
    }
  };
  walk(root);
  return entries;
}

function manifestHash(entries) {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function assertNoCredentialFiles(entries) {
  const blocked = entries.find((entry) => {
    const parts = entry.path.replace(/\/$/, '').split('/');
    const base = parts.at(-1)?.toLowerCase() ?? '';
    return base === '.env' || base.startsWith('.env.') ||
      base === 'credentials.json' || base === 'secrets.json' ||
      parts.some((part) => ['credentials', 'secrets'].includes(part.toLowerCase()));
  });
  if (blocked) fail(`vault 内发现凭据文件 ${blocked.path}；凭据必须留在 DSH credentials 子系统`);
}

function assertVaultShape(entries) {
  if (!entries.some((entry) => entry.path === 'book.yml' && entry.type === 'file')) {
    fail('源缺少 book.yml，不是 NovelCraft vault');
  }
  if (!entries.some((entry) => entry.path === '.git/' && entry.type === 'directory')) {
    fail('源缺少内嵌 .git 目录，无法保证版本历史可移植');
  }
}

function sameManifest(left, right) {
  return manifestHash(left) === manifestHash(right);
}

function sidecarOf(vault) {
  return `${vault}.manifest.json`;
}

export function verifyPortableVault(vaultPath) {
  const vault = realpathSync(path.resolve(vaultPath));
  if (!statSync(vault).isDirectory()) fail(`不是目录: ${vault}`);
  const sidecar = sidecarOf(vault);
  if (!existsSync(sidecar)) fail(`缺少清单: ${sidecar}`);
  const receipt = JSON.parse(readFileSync(sidecar, 'utf8'));
  if (receipt?.schema !== SCHEMA || !Array.isArray(receipt.entries)) fail(`清单形态非法: ${sidecar}`);
  if (receipt.manifest_sha256 !== manifestHash(receipt.entries)) fail(`清单自身哈希失配: ${sidecar}`);
  const current = manifest(vault);
  assertVaultShape(current);
  assertNoCredentialFiles(current);
  if (!sameManifest(receipt.entries, current)) fail(`vault 与清单不一致: ${vault}`);
  return { ok: true, vault, manifest_sha256: receipt.manifest_sha256, entries: current.length };
}

function assertSafeDestination(source, destination) {
  if (existsSync(destination)) fail(`目标已存在，拒绝覆盖: ${destination}`);
  if (existsSync(sidecarOf(destination))) fail(`目标清单已存在，拒绝覆盖: ${sidecarOf(destination)}`);
  const parent = realpathSync(path.dirname(destination));
  if (!statSync(parent).isDirectory()) fail(`目标父目录不可用: ${parent}`);
  const relative = path.relative(source, destination);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    fail('目标不得位于源 vault 内部');
  }
  return parent;
}

export function copyPortableVault(mode, sourcePath, destinationPath) {
  if (mode !== 'backup' && mode !== 'restore') fail(`未知模式: ${mode}`);
  const source = realpathSync(path.resolve(sourcePath));
  if (!statSync(source).isDirectory()) fail(`源不是目录: ${source}`);
  if (mode === 'restore') verifyPortableVault(source);
  const destination = path.resolve(destinationPath);
  const parent = assertSafeDestination(source, destination);
  const before = manifest(source);
  assertVaultShape(before);
  assertNoCredentialFiles(before);
  const digest = manifestHash(before);
  const token = randomUUID();
  const temporary = path.join(parent, `.${path.basename(destination)}.novelcraft-copy-${token}`);
  const sidecar = sidecarOf(destination);
  const sidecarTemporary = `${sidecar}.tmp-${token}`;
  let destinationCreated = false;
  try {
    cpSync(source, temporary, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const sourceAfter = manifest(source);
    const copied = manifest(temporary);
    if (!sameManifest(before, sourceAfter)) fail('复制期间源 vault 发生变化，已拒绝产出混合快照');
    if (!sameManifest(before, copied)) fail('复制后哈希复核失败');
    const receipt = {
      schema: SCHEMA,
      mode,
      created_at: new Date().toISOString(),
      source_name: path.basename(source),
      manifest_sha256: digest,
      entries: copied,
    };
    writeFileSync(sidecarTemporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, destination);
    destinationCreated = true;
    renameSync(sidecarTemporary, sidecar);
    return { ok: true, mode, source, destination, manifest_sha256: digest, entries: copied.length };
  } catch (error) {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
    if (existsSync(sidecarTemporary)) rmSync(sidecarTemporary, { force: true });
    if (destinationCreated && existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function selfTest() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'novelcraft-portability-'));
  try {
    const source = path.join(root, 'source');
    mkdirSync(path.join(source, '.git'), { recursive: true });
    mkdirSync(path.join(source, '.assistant', 'workflows'), { recursive: true });
    mkdirSync(path.join(source, 'world', 'atlas', 'images'), { recursive: true });
    writeFileSync(path.join(source, 'book.yml'), 'title: test\n');
    writeFileSync(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(path.join(source, '.assistant', 'workflows', 'run.json'), '{"status":"running"}\n');
    writeFileSync(path.join(source, 'world', 'atlas', 'images', 'map.bin'), Buffer.from([0, 1, 2, 255]));
    const sourceHash = manifestHash(manifest(source));
    const backup = path.join(root, 'backup');
    const restored = path.join(root, 'restored');
    copyPortableVault('backup', source, backup);
    verifyPortableVault(backup);
    copyPortableVault('restore', backup, restored);
    verifyPortableVault(restored);
    if (manifestHash(manifest(source)) !== sourceHash || manifestHash(manifest(restored)) !== sourceHash) {
      fail('self-test 源/恢复哈希不一致');
    }
    writeFileSync(path.join(backup, 'book.yml'), 'tampered\n');
    let rejected = false;
    try { verifyPortableVault(backup); } catch { rejected = true; }
    if (!rejected) fail('self-test 未拒绝被篡改备份');
    writeFileSync(path.join(source, '.env'), 'SECRET=must-not-copy\n');
    rejected = false;
    try { copyPortableVault('backup', source, path.join(root, 'blocked')); } catch { rejected = true; }
    if (!rejected || existsSync(path.join(root, 'blocked'))) fail('self-test 未拒绝 vault 内凭据');
    rmSync(path.join(source, '.env'));
    return { self_test: 'ok', entries: manifest(source).length, manifest_sha256: sourceHash };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--self-test') {
      process.stdout.write(`${JSON.stringify(selfTest())}\n`);
    } else if (args[0] === 'verify' && args.length === 2) {
      process.stdout.write(`${JSON.stringify(verifyPortableVault(args[1]))}\n`);
    } else if ((args[0] === 'backup' || args[0] === 'restore') && args.length === 3) {
      process.stdout.write(`${JSON.stringify(copyPortableVault(args[0], args[1], args[2]))}\n`);
    } else {
      fail('usage: vault-portability.mjs backup <vault> <new-dir> | restore <backup> <new-dir> | verify <vault> | --self-test');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
