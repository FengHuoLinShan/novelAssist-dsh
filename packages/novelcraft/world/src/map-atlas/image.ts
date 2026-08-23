// world/map-atlas · 本地图片导入(Phase 4; 计划 附录 A.3; N29 写边界)。
// 只接受宿主本机绝对路径; magic bytes + 尺寸 + ≤50MB 校验; 复制到 images/<page-slug>/v<N>.<ext>,
// 图片永不 git add(gitignore 兜底 + writeAtlasImage 内部约束); 文本写面单 commit。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { consumeFileIntake, paths, stageFileIntake, type StagedFileIntake } from "@novelcraft/vault";
import { StoreError } from "@novelcraft/store";
import { readAtlasTree } from "./read.js";
import { computeAtlasPageContentHash, writeAtlasCandidates, writeAtlasRun } from "./write.js";
import type { AtlasImage, AtlasNode, AtlasPage, AtlasRun } from "./types.js";

/** 图片上限 50MB(附录 A.3)。 */
export const ATLAS_IMAGE_MAX_BYTES = 50 * 1024 * 1024;
/** 尺寸范围(附录 A.3)。 */
export const ATLAS_IMAGE_MIN_DIM = 16;
export const ATLAS_IMAGE_MAX_DIM = 8192;

interface ImageProbe {
  ext: "png" | "jpg";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

/** 下一 attempt 编号 = 现存 v<N> max+1(图片不进 git, 删中间版本后不可撞号覆盖)。 */
function nextAttempt(imagesDir: string): string {
  if (!existsSync(imagesDir)) return "v1";
  const nums = readdirSync(imagesDir)
    .map((f) => /^v(\d+)\./.exec(f)?.[1])
    .filter((v): v is string => typeof v === "string")
    .map(Number);
  return `v${(nums.length > 0 ? Math.max(...nums) : 0) + 1}`;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** magic bytes + 尺寸探测(只认 PNG/JPEG; A.3)。 */
function probeImage(buf: Buffer): ImageProbe {
  const bytes = buf.length;
  const sha256 = sha256Hex(buf);
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR @ 16(width BE32)/20(height BE32)
  if (bytes >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { ext: "png", width, height, bytes, sha256 };
  }
  // JPEG: FF D8 FF; 扫描 SOF0/1/2(0xFFC0-0xFFC2)取尺寸
  if (bytes >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let off = 2;
    while (off + 9 < bytes) {
      if (buf[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xc2) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        return { ext: "jpg", width, height, bytes, sha256 };
      }
      const segLen = buf.readUInt16BE(off + 2);
      off += 2 + segLen;
    }
    throw new StoreError("VALIDATION_FAILED", "JPEG 未找到 SOF 段(尺寸不可读)");
  }
  throw new StoreError("VALIDATION_FAILED", "不支持的图片格式(仅 PNG/JPEG, magic bytes 校验)");
}

function validateImage(bytes: Buffer): ImageProbe {
  if (bytes.byteLength > ATLAS_IMAGE_MAX_BYTES) {
    throw new StoreError("VALIDATION_FAILED", `图片超过 50MB 上限(${bytes.byteLength} bytes)`);
  }
  const probe = probeImage(bytes);
  if (
    probe.width < ATLAS_IMAGE_MIN_DIM || probe.height < ATLAS_IMAGE_MIN_DIM
    || probe.width > ATLAS_IMAGE_MAX_DIM || probe.height > ATLAS_IMAGE_MAX_DIM
  ) {
    throw new StoreError(
      "VALIDATION_FAILED",
      `图片尺寸 ${probe.width}x${probe.height} 越界(需 ${ATLAS_IMAGE_MIN_DIM}~${ATLAS_IMAGE_MAX_DIM})`,
    );
  }
  return probe;
}

export function stageAtlasImageIntake(
  root: string,
  sessionId: string,
  fileName: string,
  bytes: Uint8Array,
  nodeRef: string,
): StagedFileIntake {
  validateImage(Buffer.from(bytes));
  const tree = readAtlasTree(root);
  if (![...tree.nodes, ...tree.pendingNodes].some((node) => node.id === nodeRef)) {
    throw new StoreError("NOT_FOUND", `目标节点不存在: ${nodeRef}`);
  }
  return stageFileIntake(root, sessionId, {
    kind: "atlas-image",
    fileName,
    bytes,
    metadata: { node_ref: nodeRef },
  });
}

export function importStagedAtlasImage(
  root: string,
  sessionId: string,
  receiptId: string,
): { page: AtlasPage; run?: AtlasRun } {
  return consumeFileIntake(root, sessionId, receiptId, "atlas-image", ({ bytes, metadata }) => {
    const nodeRef = metadata.node_ref;
    if (!nodeRef) throw new StoreError("VALIDATION_FAILED", "图片收据缺少目标节点");
    return importAtlasImageBytes(root, bytes, { nodeRef });
  });
}

export interface ImportAtlasImageOptions {
  /** 上传到 prompt_only 候选页时的目标页 id; 缺省 = 该节点下第一个 prompt_only 候选页。 */
  pageRef?: string;
}

/**
 * 导入本机图片到目标节点(计划 Phase 4):
 * 目标节点必须存在(pending 或 adopted); 若节点有 prompt_only 候选页 → 挂图并置 review_ready;
 * 否则新建 upload run + 候选页(generation_choice=upload)。画廊追加 = 对已有 adopted 页节点再建新候选页。
 * 候选写入不过 approval(N29); 文本单 commit, 图片字节永不进 git。
 */
export function importAtlasImage(
  root: string,
  filePath: string,
  target: { nodeRef: string },
  opts?: ImportAtlasImageOptions,
): { page: AtlasPage; run?: AtlasRun } {
  if (!path.isAbsolute(filePath)) {
    throw new StoreError("VALIDATION_FAILED", `只接受宿主本机绝对路径: ${filePath}`);
  }
  if (!existsSync(filePath)) {
    throw new StoreError("NOT_FOUND", `图片文件不存在: ${filePath}`);
  }
  const size = statSync(filePath).size;
  if (size > ATLAS_IMAGE_MAX_BYTES) {
    throw new StoreError("VALIDATION_FAILED", `图片超过 50MB 上限(${size} bytes)`);
  }
  return importAtlasImageBytes(root, readFileSync(filePath), target, opts);
}

/** Frozen-byte image importer; the public agent seam reaches this only through a session receipt. */
export function importAtlasImageBytes(
  root: string,
  input: Uint8Array,
  target: { nodeRef: string },
  opts?: ImportAtlasImageOptions,
): { page: AtlasPage; run?: AtlasRun } {
  const bytes = Buffer.from(input);
  const probe = validateImage(bytes);

  const p = paths(root);
  const tree = readAtlasTree(root);
  const node: AtlasNode | undefined = [...tree.nodes, ...tree.pendingNodes].find((n) => n.id === target.nodeRef);
  if (!node) {
    throw new StoreError("NOT_FOUND", `目标节点不存在: ${target.nodeRef}`);
  }
  const atlasDir = p.world.atlas.dir;

  // 目标 prompt_only 候选页(显式 pageRef 或该节点首个 prompt_only 候选)。
  const candidates = tree.pendingPages.filter(
    (pg) => pg.node_ref === target.nodeRef && pg.generation_status === "prompt_only" && pg.review_status === "candidate",
  );
  const targetPage = opts?.pageRef
    ? candidates.find((pg) => pg.id === opts.pageRef)
    : candidates[0];

  if (targetPage) {
    const imagesDir = path.join(atlasDir, "images", targetPage.id);
    const attempt = nextAttempt(imagesDir);
    const image: AtlasImage = {
      file: `images/${targetPage.id}/${attempt}.${probe.ext}`,
      media_type: probe.ext === "png" ? "image/png" : "image/jpeg",
      sha256: probe.sha256,
      width: probe.width,
      height: probe.height,
      byte_size: probe.bytes,
    };
    const base: Omit<AtlasPage, "content_hash"> = {
      ...targetPage,
      generation_choice: "upload", // A.4 step5: 挂图即标记本地导入来源(不在 content_hash 内, 无 CAS 影响)
      image,
      generation_status: "review_ready",
    };
    const next: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
    writeAtlasCandidates(root, [], [next], `atlas: import image -> ${targetPage.id}`, {
      images: [{ pageSlug: targetPage.id, attempt, bytes, ext: probe.ext }],
    });
    return { page: next };
  }

  // 无 prompt_only 候选 → 新建 upload run + 候选页(画廊追加同路径)。
  const runId = `upload-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const pageId = `pg-up-${runId.slice(7)}`;
  const imagesDir = path.join(atlasDir, "images", pageId);
  const attempt = nextAttempt(imagesDir);
  const image: AtlasImage = {
    file: `images/${pageId}/${attempt}.${probe.ext}`,
    media_type: probe.ext === "png" ? "image/png" : "image/jpeg",
    sha256: probe.sha256,
    width: probe.width,
    height: probe.height,
    byte_size: probe.bytes,
  };
  const base: Omit<AtlasPage, "content_hash"> = {
    id: pageId,
    run_ref: runId,
    node_ref: target.nodeRef,
    generation_choice: "upload",
    generation_status: "review_ready",
    review_status: "candidate",
    title: node.title,
    visual_brief: "",
    prompt: "",
    image,
    evidence: { supported: [], visual_fill: [], conflicts: [] },
    source_manifest: [],
    annotations: [],
    review_note: null,
    adopted_at: null,
    rejected_at: null,
    deprecated_at: null,
  };
  const page: AtlasPage = { ...base, content_hash: computeAtlasPageContentHash(base) };
  const run: AtlasRun = {
    schema_version: 1,
    id: runId,
    run_kind: "upload",
    status: "review_ready",
    checkpoint: "review",
    options: { style_note: "", include_working_drafts: false, include_interiors: false, full_rebuild: false },
    context_hash: "",
    source_manifest: [],
    spatial_evidence: {},
    atlas_plan: { style_brief: "", nodes: [] },
    planned_page_count: 1,
    journal: [],
    error_code: null,
    error_message: null,
    created_at: new Date().toISOString(),
  };
  writeAtlasRun(root, run);
  writeAtlasCandidates(root, [], [page], `atlas: import image -> ${pageId}`, {
    images: [{ pageSlug: pageId, attempt, bytes, ext: probe.ext }],
  });
  return { page, run };
}
