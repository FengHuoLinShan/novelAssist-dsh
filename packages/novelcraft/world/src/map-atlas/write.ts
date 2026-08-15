// world/map-atlas · 写面(guardPath 校验 + 文本 git add/commit; 图片只写本地 gitignore 目录)。
// 依据: map-atlas 实施计划 §2/§4 Phase 1/附录 A.2(N28/N29)。
// 铁律: 图片字节绝不 git add; 文本资产(page/node/run)每次写 = guardPath + gitAdd + 单 gitCommit。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureVaultGitignore, guardPath, paths } from '@novelcraft/vault';
import { gitAdd, gitCommit, serializeFrontmatter } from '@novelcraft/store';
import type { AtlasNode, AtlasPage, AtlasRun } from './types.js';

/** 允许的图片扩展名(A.3: 首版原样接受 PNG/JPEG; 扩展名必须与 magic bytes 一致, 本阶段仅白名单)。 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg'] as const;

/** 防穿越的路径段白名单: 拒绝空/./..与任何分隔符/控制字符。 */
function assertSafeSegment(seg: string, name: string): void {
  if (!seg || seg === '.' || seg === '..') {
    throw new Error(`atlas: ${name} 非法路径段: ${JSON.stringify(seg)}`);
  }
  if (/[/\\]/.test(seg) || /[\u0000-\u001f\u007f]/.test(seg)) {
    throw new Error(`atlas: ${name} 非法路径段: ${JSON.stringify(seg)}`);
  }
}

/** guardPath 校验 + 写文本 + git add/commit(单次原子提交)。 */
function writeCommitted(root: string, absFile: string, content: string, message: string): void {
  const p = guardPath(root, absFile); // 防路径穿越(R9)。
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  gitAdd(root);
  gitCommit(root, message);
}

/** §2.1 node frontmatter(确定性字段顺序)。 */
function nodeFrontmatter(node: AtlasNode): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    id: node.id,
    parent_ref: node.parent_ref,
    location_ref: node.location_ref,
    semantic_key: node.semantic_key,
    level: node.level,
    title: node.title,
  };
  if (node.summary !== undefined) fm.summary = node.summary;
  fm.status = node.status;
  fm.sort_order = node.sort_order;
  return fm;
}

/** §2.2 page frontmatter(确定性字段顺序; image 缺省 = prompt_only)。 */
function pageFrontmatter(page: AtlasPage): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    id: page.id,
    run_ref: page.run_ref,
    node_ref: page.node_ref,
  };
  // generation_choice 仅 'upload' 时序列化(位置在 node_ref 之后, 对齐 specs/assets/map-atlas.md 字段序)。
  if (page.generation_choice === 'upload') fm.generation_choice = page.generation_choice;
  fm.generation_status = page.generation_status;
  fm.review_status = page.review_status;
  fm.title = page.title;
  fm.visual_brief = page.visual_brief;
  fm.prompt = page.prompt;
  if (page.image) fm.image = page.image;
  fm.evidence = page.evidence;
  fm.source_manifest = page.source_manifest;
  fm.annotations = page.annotations;
  fm.review_note = page.review_note;
  fm.adopted_at = page.adopted_at;
  fm.rejected_at = page.rejected_at;
  fm.deprecated_at = page.deprecated_at;
  fm.content_hash = page.content_hash;
  return fm;
}

/**
 * 写节点: adopted(或显式 opts.adopted)→ nodes/, 否则 → pending/nodes/。
 * 每次写 = guardPath + git add/commit。
 */
export function writeAtlasNode(root: string, node: AtlasNode, opts?: { adopted?: boolean }): void {
  const adopted = opts?.adopted ?? node.status === 'adopted';
  const p = paths(root);
  const file = adopted ? p.world.atlas.nodeFile(node.id) : p.world.atlas.pendingNodeFile(node.id);
  const content = serializeFrontmatter(nodeFrontmatter(node), `# ${node.title}\n`);
  writeCommitted(root, file, content, `atlas: write node ${node.id}`);
}

/**
 * 写页面: adopted(或显式 opts.adopted)→ pages/, 否则 → pending/pages/。
 * 每次写 = guardPath + git add/commit。
 */
export function writeAtlasPage(root: string, page: AtlasPage, opts?: { adopted?: boolean }): void {
  const adopted = opts?.adopted ?? page.review_status === 'adopted';
  const p = paths(root);
  const file = adopted ? p.world.atlas.pageFile(page.id) : p.world.atlas.pendingPageFile(page.id);
  const content = serializeFrontmatter(pageFrontmatter(page), `# ${page.title}\n`);
  writeCommitted(root, file, content, `atlas: write page ${page.id}`);
}

/** 写 run JSON(.assistant/atlas/runs/<id>.json); run 是工作产物, 提交。 */
export function writeAtlasRun(root: string, run: AtlasRun): void {
  const p = paths(root);
  const file = p.assistant.atlas.runFile(run.id);
  const toWrite: AtlasRun = { ...run };
  if (toWrite.created_at === undefined) {
    toWrite.created_at = new Date().toISOString(); // 工作产物; 用于确定性排序。
  }
  writeCommitted(root, file, JSON.stringify(toWrite, null, 2) + '\n', `atlas: write run ${run.id}`);
}

/**
 * 批量写候选(Phase 3 materialize): pending nodes + pending pages 一次写完, **单 git commit**。
 * 逐文件 guardPath; 任一失败抛错前不写 git(失败零残留的 git 面; 文件残留由调用方重试覆盖)。
 */
export function writeAtlasCandidates(
  root: string,
  nodes: AtlasNode[],
  pages: AtlasPage[],
  message: string,
): void {
  const p = paths(root);
  const files: Array<{ abs: string; content: string }> = [];
  for (const node of nodes) {
    const abs = guardPath(root, p.world.atlas.pendingNodeFile(node.id));
    files.push({ abs, content: serializeFrontmatter(nodeFrontmatter(node), `# ${node.title}\n`) });
  }
  for (const page of pages) {
    const abs = guardPath(root, p.world.atlas.pendingPageFile(page.id));
    files.push({ abs, content: serializeFrontmatter(pageFrontmatter(page), `# ${page.title}\n`) });
  }
  for (const f of files) {
    mkdirSync(path.dirname(f.abs), { recursive: true });
    writeFileSync(f.abs, f.content, 'utf8');
  }
  gitAdd(root);
  gitCommit(root, message);
}

/**
 * 写本地图片字节到 `world/atlas/images/<page-slug>/<attempt>.<ext>`。
 * - 绝不 gitAdd 图片路径(N29): 图片只存本地 gitignore 目录, 不进入 git 历史。
 * - `input` 为 Uint8Array(Buffer)时直接写字节; 为 string 时按本机 sourcePath 复制。
 * - 返回相对 `world/atlas` 的路径(如 `images/<page-slug>/v1.png`), 可直接写入 page.image.file。
 */
export function writeAtlasImage(
  root: string,
  pageSlug: string,
  attempt: string,
  input: Uint8Array | string,
  ext: string,
): string {
  const normExt = ext.toLowerCase().replace(/^\./, '');
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(normExt)) {
    throw new Error(`atlas: 非法图片扩展名 ${JSON.stringify(ext)}(白名单: ${IMAGE_EXTENSIONS.join('/')})`);
  }
  assertSafeSegment(pageSlug, 'pageSlug');
  assertSafeSegment(attempt, 'attempt');

  const relFromAtlas = path.posix.join('images', pageSlug, `${attempt}.${normExt}`);
  const abs = guardPath(root, path.join('world', 'atlas', relFromAtlas)); // 防穿越(R9)。

  // N29: 先确保 gitignore 行存在(即便旧 vault 未跑迁移, 也绝不把图片写进 git add -A)。
  ensureVaultGitignore(root, ['world/atlas/images/']);
  mkdirSync(path.dirname(abs), { recursive: true });
  if (typeof input === 'string') {
    if (!existsSync(input)) throw new Error(`atlas: 图片源文件不存在: ${input}`);
    writeFileSync(abs, readFileSync(input));
  } else {
    writeFileSync(abs, input);
  }
  return relFromAtlas;
}
