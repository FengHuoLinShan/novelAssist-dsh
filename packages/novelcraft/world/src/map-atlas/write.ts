// world/map-atlas · 写面(guardPath 校验 + 文本 git add/commit; 图片只写本地 gitignore 目录)。
// 依据: map-atlas 实施计划 §2/§4 Phase 1/附录 A.2(N28/N29)。
// 铁律: 图片字节绝不 git add; 文本资产(page/node/run)每次写 = guardPath + gitAdd + 单 gitCommit;
//  gitAdd 一律用「本次操作涉及文件的完整精确相对 POSIX pathspec」(绝不 -A / 空 pathspec):
//  git ≥ 2.0 默认 pathspec 语义同时记录该路径的增/改/删, 无关 staged/unstaged 原样保留。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureVaultGitignore, guardPath, paths } from '@novelcraft/vault';
import { gitAdd, gitCommit, hasStagedOutside, serializeFrontmatter } from '@novelcraft/store';
import type { AtlasNode, AtlasPage, AtlasRun } from './types.js';

/** 候选页 content_hash(稳定字段确定性 sha256; adopt CAS/标注更新用; Phase 3/4 共享)。 */
export function computeAtlasPageContentHash(page: Omit<AtlasPage, 'content_hash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        node_ref: page.node_ref,
        title: page.title,
        visual_brief: page.visual_brief,
        prompt: page.prompt,
        evidence: page.evidence,
        sources: page.source_manifest.map((s) => {
          const identity = `${s.source_type}:${s.source_id}:${s.source_hash ?? ''}`;
          return s.included_content_hash === undefined && s.included_range === undefined && s.truncated === undefined
            ? identity // 旧资产保持原 content_hash 投影。
            : {
                identity,
                included_content_hash: s.included_content_hash ?? null,
                included_range: s.included_range ?? null,
                truncated: s.truncated ?? null,
              };
        }),
        annotations: page.annotations,
        image: page.image ?? null,
      }),
      'utf8',
    )
    .digest('hex');
}

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

/**
 * 文件相对 root 的完整精确 POSIX pathspec(绝对路径 → 相对, `/` 分隔);
 * 前缀 `:(literal)` 关闭 git pathspec 的 glob/magic 解释——slug 段虽经
 * assertSafePathSegment/guardPath 校验, 但可能含 `*?:[]` 等字面字符, literal 保证精确命中。
 * 依据: ADR-0021 §6 业务写面禁用 `git add -A`; git ≥ 2.0 默认 pathspec 语义同时记录
 * 该路径的增/改/删(含删除), 无关 staged/unstaged 原样保留。
 */
function relPosixPathspec(root: string, abs: string): string {
  const rel = path.relative(path.resolve(root), abs).split(path.sep).join('/');
  return `:(literal)${rel}`;
}


/**
 * R17 洁净门禁(M10-C1): gitAdd/gitCommit 前确认范围外无未提交改动 —— 裸 git commit
 * 会把 index 里预存的 staged 外部文件一起提交(imports 既有纪律, Track C 收口到全部
 * 写面)。只挡 index 预存 staged(N41: untracked/unstaged 不被精确 pathspec 卷入,
 * 作者外部编辑正常态不拒绝)。exempt = 本次操作将要 stage 的 pathspec 集。
 */
function assertCleanOutside(root: string, exempt: readonly string[]): void {
  if (hasStagedOutside(root, exempt)) {
    throw new Error(
      'atlas: 工作区存在范围外未提交改动(含预存 staged), 拒绝提交以免卷入外部内容(R17/M10-C1)',
    );
  }
}

/** guardPath 校验 + 写文本 + git add/commit(单次原子提交)。 */
function writeCommitted(root: string, absFile: string, content: string, message: string): void {
  const p = guardPath(root, absFile); // 防路径穿越(R9)。
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
  // N35/ADR-0021 §6: 只 stage 本次写的这一个文件(完整精确相对 POSIX pathspec, 绝不 -A);
  // 作者手改/编辑器自动保存等写面外改动不进本 commit。R17 门禁防预存 staged 卷入(M10-C1)。
  assertCleanOutside(root, [relPosixPathspec(root, p)]);
  gitAdd(root, [relPosixPathspec(root, p)]);
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
  const file = guardPath(root, p.assistant.atlas.runFile(run.id)); // R9 防穿越(runFile 已单段校验 + guard)。
  const toWrite: AtlasRun = { ...run };
  if (toWrite.created_at === undefined) {
    toWrite.created_at = new Date().toISOString(); // 工作产物; 用于确定性排序。
  }
  const content = JSON.stringify(toWrite, null, 2) + '\n';
  mkdirSync(path.dirname(file), { recursive: true });
  // 原子替换: 同目录临时文件 + rename(读者/并发写永不读到半截 JSON)。
  // 临时文件在 rename 前即消失, 不会进入 gitAdd/commit; finally 清理残余。
  // R9: 固定名 `${file}.tmp` 可被预置 symlink 利用(writeFileSync 跟随链接写 vault 外),
  // 因此用不可预测唯一名(randomUUID) + guardPath + O_EXCL('wx'): 预置文件/链接 → EEXIST 拒绝。
  const tmp = guardPath(
    root,
    path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`),
  );
  let created = false;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    created = true;
    renameSync(tmp, file);
  } finally {
    // 仅清理本次确实创建的临时文件; 预置的异名文件(EEXIST 未创建)不触碰。
    if (created && existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* 清理失败不掩盖原错误 */
      }
    }
  }
  // N35/ADR-0021 §6: 只 stage run 文件本身(完整精确相对 POSIX pathspec, 绝不 -A)。
  // R17 门禁防预存 staged 卷入(M10-C1)。
  assertCleanOutside(root, [relPosixPathspec(root, file)]);
  gitAdd(root, [relPosixPathspec(root, file)]);
  gitCommit(root, `atlas: write run ${run.id}`);
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
  opts?: { images?: Array<{ pageSlug: string; attempt: string; bytes: Uint8Array; ext: string }> },
): void {
  // 图片字节先行落盘(writeAtlasImage 内部: 永不 git add, N29); 文本写面仍单 commit。
  for (const img of opts?.images ?? []) {
    writeAtlasImage(root, img.pageSlug, img.attempt, img.bytes, img.ext);
  }
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
  // N35/ADR-0021 §6: 只 stage 本次批量写的全部候选文件(完整精确相对 POSIX pathspec,
  // 绝不 -A); 空写面 → 无任何 git 动作(空 pathspec 的 git add 是 no-op, 且 gitCommit
  // 会扫入索引中无关的预暂存项)。
  if (files.length === 0) return;
  assertCleanOutside(root, files.map((f) => relPosixPathspec(root, f.abs)));
  gitAdd(root, files.map((f) => relPosixPathspec(root, f.abs)));
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
