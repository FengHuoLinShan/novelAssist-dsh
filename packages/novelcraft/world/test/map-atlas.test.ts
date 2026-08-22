// world/map-atlas 行为契约(map-atlas 实施计划 §2/§4 Phase 1; N28/N29)。
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { initVault, paths } from "@novelcraft/vault";
import { gitAdd, gitCommit, gitStatusPorcelain } from "@novelcraft/store";
import {
  ATLAS_LEVEL_RANK,
  readAtlasRun,
  readAtlasTree,
  latestAtlasRun,
  listAtlasHistory,
  writeAtlasCandidates,
  writeAtlasImage,
  writeAtlasNode,
  writeAtlasPage,
  writeAtlasRun,
} from "../src/index";
import type { AtlasNode, AtlasPage, AtlasRun } from "../src/index";

/**
 * symlink 能力探测(平台允许时才跑 symlink 回归; Windows 无特权进程创建 symlink
 * 会抛 EPERM/ENOSYS → 整组测试 skip)。
 */
let symlinkCapable: boolean | undefined;
function symlinksSupported(): boolean {
  if (symlinkCapable === undefined) {
    const probe = mkdtempSync(join(tmpdir(), "ncma-link-"));
    try {
      const target = join(probe, "t");
      const link = join(probe, "l");
      writeFileSync(target, "x");
      symlinkSync(target, link);
      symlinkCapable = true;
    } catch {
      symlinkCapable = false;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  }
  return symlinkCapable;
}

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncma-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeNode(overrides: Partial<AtlasNode> & { id: string }): AtlasNode {
  return {
    parent_ref: null,
    location_ref: null,
    semantic_key: `entity:${overrides.id}`,
    level: "world",
    title: overrides.id,
    status: "adopted",
    sort_order: 0,
    ...overrides,
  };
}

function makePage(overrides: Partial<AtlasPage> & { id: string; node_ref: string }): AtlasPage {
  return {
    run_ref: "atlas-run-1",
    generation_status: "review_ready",
    review_status: "adopted",
    title: overrides.id,
    visual_brief: "",
    prompt: "",
    evidence: { supported: [], visual_fill: [], conflicts: [] },
    source_manifest: [],
    annotations: [],
    review_note: null,
    adopted_at: null,
    rejected_at: null,
    deprecated_at: null,
    content_hash: "sha256-deadbeef",
    ...overrides,
  };
}

describe("readAtlasTree(§2 文件模型; N28/N29)", () => {
  it("空 vault / 目录不存在 → 空结构, 不抛错", () => {
    const root = makeRoot();
    const t = readAtlasTree(root);
    expect(t.nodes).toEqual([]);
    expect(t.pages).toEqual([]);
    expect(t.pendingNodes).toEqual([]);
    expect(t.pendingPages).toEqual([]);
    expect(t.tree).toEqual([]);
  });

  it("node/page 写入→读回 round-trip(adopted → nodes/ + pages/)", () => {
    const root = makeRoot();
    writeAtlasNode(root, makeNode({ id: "cover", level: "cover", title: "封面", sort_order: 0 }));
    writeAtlasPage(
      root,
      makePage({
        id: "page-cover",
        node_ref: "cover",
        review_status: "adopted",
        title: "封面",
        visual_brief: "长安城俯瞰",
        annotations: [{ id: "ann-1", label: "长安", position_x: 0.5, position_y: 0.3, sort_order: 0 }],
      }),
      { adopted: true },
    );
    const t = readAtlasTree(root);
    expect(t.nodes.map((n) => n.id)).toEqual(["cover"]);
    expect(t.nodes[0].title).toBe("封面");
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].node_ref).toBe("cover");
    expect(t.pages[0].annotations[0].label).toBe("长安");
    expect(t.pendingNodes).toEqual([]);
    expect(t.pendingPages).toEqual([]);
  });

  it("generation_choice 仅 'upload' 时序列化/读回(specs/assets/map-atlas.md)", () => {
    const root = makeRoot();
    writeAtlasPage(root, makePage({ id: "page-upl", node_ref: "cover", review_status: "candidate", generation_choice: "upload" }));
    writeAtlasPage(root, makePage({ id: "page-plain", node_ref: "cover", review_status: "candidate" }));
    const t = readAtlasTree(root);
    const byId = new Map(t.pendingPages.map((p) => [p.id, p]));
    expect(byId.get("page-upl")!.generation_choice).toBe("upload");
    expect(byId.get("page-plain")!.generation_choice).toBeUndefined();
  });

  it("pending 与 adopted 分区正确(provisional → pending/nodes)", () => {
    const root = makeRoot();
    writeAtlasNode(root, makeNode({ id: "adopted", status: "adopted" }));
    writeAtlasNode(root, makeNode({ id: "candidate", status: "provisional" }));
    writeAtlasPage(root, makePage({ id: "page-adopted", node_ref: "adopted", review_status: "adopted" }), { adopted: true });
    writeAtlasPage(root, makePage({ id: "page-candidate", node_ref: "candidate", review_status: "candidate", generation_status: "review_ready" }));
    const t = readAtlasTree(root);
    expect(t.nodes.map((n) => n.id)).toEqual(["adopted"]);
    expect(t.pendingNodes.map((n) => n.id)).toEqual(["candidate"]);
    expect(t.pages.map((p) => p.id)).toEqual(["page-adopted"]);
    expect(t.pendingPages.map((p) => p.id)).toEqual(["page-candidate"]);
  });

  it("tree 排序确定性: sort_order 然后 title", () => {
    const root = makeRoot();
    writeAtlasNode(root, makeNode({ id: "root", level: "cover", title: "Root", sort_order: 0 }));
    writeAtlasNode(root, makeNode({ id: "beta", parent_ref: "root", level: "world", title: "Beta", sort_order: 0 }));
    writeAtlasNode(root, makeNode({ id: "alpha", parent_ref: "root", level: "world", title: "Alpha", sort_order: 0 }));
    writeAtlasNode(root, makeNode({ id: "gamma", parent_ref: "root", level: "world", title: "Alpha", sort_order: 1 }));
    const t = readAtlasTree(root);
    expect(t.tree.map((n) => n.node.id)).toEqual(["root"]);
    // sort_order 0(Alpha < Beta)先, 再 sort_order 1(gamma 同名 Alpha)。
    expect(t.tree[0].children.map((n) => n.node.id)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("is_placeholder 派生(N28): adopted 节点无 adopted page → true", () => {
    const root = makeRoot();
    writeAtlasNode(root, makeNode({ id: "empty", status: "adopted" }));
    writeAtlasNode(root, makeNode({ id: "filled", status: "adopted" }));
    writeAtlasPage(root, makePage({ id: "page-filled", node_ref: "filled", review_status: "adopted" }), { adopted: true });
    const t = readAtlasTree(root);
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    expect(byId.get("empty")!.is_placeholder).toBe(true); // N28 空页占位
    expect(byId.get("filled")!.is_placeholder).toBe(false);
    // provisional 节点不算占位。
    writeAtlasNode(root, makeNode({ id: "provisional", status: "provisional" }));
    const t2 = readAtlasTree(root);
    expect(t2.pendingNodes.find((n) => n.id === "provisional")!.is_placeholder).toBe(false);
  });

  it("image_missing 派生(N29): 有 image 元数据无本地文件 → true", () => {
    const root = makeRoot();
    writeAtlasPage(
      root,
      makePage({
        id: "page-x",
        node_ref: "cover",
        review_status: "adopted",
        image: { file: "images/page-x/v1.png", media_type: "image/png", sha256: "abc", width: 100, height: 100, byte_size: 8 },
      }),
      { adopted: true },
    );
    let t = readAtlasTree(root);
    expect(t.pages[0].image_missing).toBe(true); // 有 image.file 但文件不存在
    // 补上本地图片 → image_missing 翻转。
    writeAtlasImage(root, "page-x", "v1", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "png");
    t = readAtlasTree(root);
    expect(t.pages[0].image_missing).toBe(false);
  });

  it("prompt_only 页面无 image → image_missing 恒 false(非缺图, 而是未生成)", () => {
    const root = makeRoot();
    writeAtlasPage(root, makePage({ id: "page-prompt", node_ref: "cover", review_status: "candidate", generation_status: "prompt_only" }));
    const t = readAtlasTree(root);
    expect(t.pendingPages[0].image).toBeUndefined();
    expect(t.pendingPages[0].image_missing).toBe(false);
  });

  it.skipIf(!symlinksSupported())("R9: nodes/ 内 .md symlink 指向 vault 外 → readAtlasTree fail-closed 抛错, 不跟随读取", () => {
    const root = makeRoot();
    const outside = join(tmpdir(), `ncma-outside-${Date.now()}.md`);
    writeFileSync(outside, "---\nid: evil\n---\n外部正文\n");
    symlinkSync(outside, join(root, "world", "atlas", "nodes", "evil.md"));
    expect(() => readAtlasTree(root)).toThrow(/escapes vault root/);
    rmSync(outside, { force: true });
  });
});

describe("run 读写(.assistant/atlas/runs; §2.3)", () => {
  function makeRun(id: string, created_at: string): AtlasRun {
    return {
      schema_version: 1,
      id,
      run_kind: "initial",
      status: "planning",
      options: { style_note: "", include_working_drafts: false, include_interiors: false, full_rebuild: false },
      context_hash: "",
      source_manifest: [],
      spatial_evidence: {},
      atlas_plan: { style_brief: "", nodes: [] },
      planned_page_count: 0,
      checkpoint: "spatial:2",
      error_code: null,
      error_message: null,
      journal: [],
      created_at,
    };
  }

  it("writeAtlasRun → readAtlasRun round-trip; latest/listAtlasHistory 按时间确定性排序", () => {
    const root = makeRoot();
    writeAtlasRun(root, makeRun("atlas-run-1", "2026-08-15T00:00:00.000Z"));
    writeAtlasRun(root, makeRun("atlas-run-2", "2026-08-15T00:00:01.000Z"));

    const r1 = readAtlasRun(root, "atlas-run-1");
    expect(r1.id).toBe("atlas-run-1");
    expect(r1.run_kind).toBe("initial");
    expect(r1.status).toBe("planning");
    expect(r1.checkpoint).toBe("spatial:2");

    expect(latestAtlasRun(root)!.id).toBe("atlas-run-2"); // 最新在前
    expect(listAtlasHistory(root).map((r) => r.id)).toEqual(["atlas-run-2", "atlas-run-1"]);
  });

  it("无 run 时 latestAtlasRun → null, listAtlasHistory → []", () => {
    const root = makeRoot();
    expect(latestAtlasRun(root)).toBeNull();
    expect(listAtlasHistory(root)).toEqual([]);
  });

  it("readAtlasRun 不存在 → 抛错(与 readObject 同口径)", () => {
    const root = makeRoot();
    expect(() => readAtlasRun(root, "missing")).toThrow(/不存在/);
  });

  it("截断/损坏 run JSON: listAtlasHistory/latest 跳过单个坏文件, readAtlasRun 明确报错", () => {
    const root = makeRoot();
    writeAtlasRun(root, makeRun("atlas-run-1", "2026-08-15T00:00:00.000Z"));
    writeAtlasRun(root, makeRun("atlas-run-2", "2026-08-15T00:00:01.000Z"));
    // 手写截断 JSON(模拟写盘中断)。
    writeFileSync(
      join(paths(root).assistant.atlas.runs, "atlas-run-broken.json"),
      '{"schema_version": 1, "id": "atlas-run-broken"',
      "utf8",
    );
    // 列表/latest 跳过损坏 run(其余完好 run 正常排序)。
    expect(listAtlasHistory(root).map((r) => r.id)).toEqual(["atlas-run-2", "atlas-run-1"]);
    expect(latestAtlasRun(root)!.id).toBe("atlas-run-2");
    expect(latestAtlasRun(root, { excludeId: "atlas-run-2" })!.id).toBe("atlas-run-1");
    // readAtlasRun 指定坏文件仍明确报错(不静默吞掉)。
    expect(() => readAtlasRun(root, "atlas-run-broken")).toThrow(/损坏/);
  });

  it("writeAtlasRun 原子替换: 同目录临时文件 + rename, 无 .tmp 残留且不进 git", () => {
    const root = makeRoot();
    const runsDir = paths(root).assistant.atlas.runs;
    writeAtlasRun(root, makeRun("atlas-run-1", "2026-08-15T00:00:00.000Z"));
    // 无临时文件残留; 工作区干净; git 中无 .tmp。
    expect(readdirSync(runsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })).not.toContain(".tmp");
    // 同 id 重写 = 原子替换, 读者永远读到完整 JSON(新内容)。
    writeAtlasRun(root, makeRun("atlas-run-1", "2026-08-15T00:00:02.000Z"));
    expect(readAtlasRun(root, "atlas-run-1").created_at).toBe("2026-08-15T00:00:02.000Z");
    expect(readdirSync(runsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it.skipIf(!symlinksSupported())("R9: 预置固定名 `${file}.tmp` symlink 不被跟随(不再使用固定临时名)", () => {
    const root = makeRoot();
    const runsDir = paths(root).assistant.atlas.runs;
    const outside = join(tmpdir(), `ncma-tmp-escape-${Date.now()}.tmp`);
    // 旧实现的固定临时名(攻击者预置 dangling symlink → vault 外文件); 新实现用
    // 同目录不可预测唯一名 + O_EXCL, 绝不触碰该固定名。
    symlinkSync(outside, join(runsDir, "atlas-run-1.json.tmp"));
    try {
      writeAtlasRun(root, makeRun("atlas-run-1", "2026-08-15T00:00:00.000Z"));
      // run 正常原子落盘; 外部目标不产生 / 不被写入(vault 零外溢)。
      expect(readAtlasRun(root, "atlas-run-1").id).toBe("atlas-run-1");
      expect(existsSync(outside)).toBe(false);
      // 预置链接原样保留(未被覆盖、未被删除; existsSync 跟随 dangling symlink 返回
      // false, 故用目录枚举断言链接条目仍在)。
      expect(readdirSync(runsDir)).toContain("atlas-run-1.json.tmp");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it.skipIf(!symlinksSupported())("R9: runs/ 内 .json symlink 指向 vault 外 → listAtlasHistory/latestAtlasRun fail-closed 抛错", () => {
    const root = makeRoot();
    writeAtlasRun(root, makeRun("atlas-run-1", "2026-08-15T00:00:00.000Z")); // 基线完好 run
    const outside = join(tmpdir(), `ncma-outside-run-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify(makeRun("evil", "2026-08-15T00:00:03.000Z")));
    symlinkSync(outside, join(paths(root).assistant.atlas.runs, "evil.json"));
    // 逃逸 symlink 是安全违规 → fail-closed(区别于坏普通 JSON 的跳过)。
    expect(() => listAtlasHistory(root)).toThrow(/escapes vault root/);
    expect(() => latestAtlasRun(root)).toThrow(/escapes vault root/);
    rmSync(outside, { force: true });
  });

  it.skipIf(!symlinksSupported())("R9: readAtlasRun 的 runId 经 symlink 逃逸或穿越 → fail-closed 抛错", () => {
    const root = makeRoot();
    const outside = join(tmpdir(), `ncma-outside-run2-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify(makeRun("evil", "2026-08-15T00:00:03.000Z")));
    symlinkSync(outside, join(paths(root).assistant.atlas.runs, "evil.json"));
    // runs dir containment: 指向 vault 外的 symlink → 拒绝跟随。
    expect(() => readAtlasRun(root, "evil")).toThrow(/escapes vault root/);
    // 纯 lexical 穿越 runId 同样拒绝。
    expect(() => readAtlasRun(root, "../evil")).toThrow(/escapes vault root/);
    rmSync(outside, { force: true });
  });
});

describe("writeAtlasImage(§4 Phase 1; N29 图片不进 git)", () => {
  it("只写本地图片目录; git status 干净且图片文件在磁盘", () => {
    const root = makeRoot();
    // N32: initVault 已创建精确 bootstrap HEAD；无需制造空 baseline commit。
    const rel = writeAtlasImage(root, "page-x", "v1", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "png");
    expect(rel).toBe("images/page-x/v1.png");
    expect(existsSync(join(root, "world", "atlas", "images", "page-x", "v1.png"))).toBe(true);
    // N29: 图片被 gitignore, 不产生未提交改动。
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("支持 sourcePath 复制模式", () => {
    const root = makeRoot();
    const src = join(tmpdir(), `ncma-src-${Date.now()}.png`);
    rmSync(src, { force: true });
    // 写一个源文件供复制。
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const rel = writeAtlasImage(root, "page-y", "v2", src, "png");
      expect(rel).toBe("images/page-y/v2.png");
      expect(existsSync(join(root, "world", "atlas", "images", "page-y", "v2.png"))).toBe(true);
    } finally {
      rmSync(src, { force: true });
    }
  });

  it("guardPath/路径段拒绝 ../ 穿越(N29)", () => {
    const root = makeRoot();
    expect(() => writeAtlasImage(root, "../evil", "v1", new Uint8Array([1]), "png")).toThrow(/非法路径段/);
    expect(() => writeAtlasImage(root, "page", "..", new Uint8Array([1]), "png")).toThrow(/非法路径段/);
    expect(() => writeAtlasImage(root, "page", "v1", new Uint8Array([1]), "../evil")).toThrow(/非法图片扩展名|非法路径段/);
    // writeAtlasNode 的 id 含可逃逸的 ../ → 动态构造器 assertSafePathSegment 拒绝
    // (早于 guardPath; vault 构造器 fail-closed, 见路径构造缺口修复)。
    expect(() =>
      writeAtlasNode(root, makeNode({ id: "../../../../outside", level: "world" })),
    ).toThrow(/非法路径段|escapes vault root/);
  });

  it("非法扩展名拒绝(A.3 白名单)", () => {
    const root = makeRoot();
    expect(() => writeAtlasImage(root, "page", "v1", new Uint8Array([1]), "gif")).toThrow(/非法图片扩展名/);
  });
});

describe("写面 gitAdd 精确 pathspec(绝不 -A; 含删除; 保留无关 staged/unstaged; ADR-0021 §6)", () => {
  /** HEAD commit 的文件清单(相对 root, 逐行 trim; git show 输出首行必为空行)。 */
  const lastCommitFiles = (r: string) =>
    execFileSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: r, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
  /** raw porcelain 行(保留状态列位; 前导空格 = unstaged, "M " = staged)。 */
  const dirty = (r: string) =>
    execFileSync("git", ["status", "--porcelain"], { cwd: r, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .sort();

  it("writeAtlasNode(writeCommitted): 只 stage node 文件; 无关 untracked/modified/deleted 不进 commit 且状态原样", () => {
    const root = makeRoot();
    const p = paths(root);
    // 无关 tracked 文件(种子 commit)。
    const tracked = p.world.objectFile("unrelated-tracked");
    writeFileSync(tracked, "v1\n", "utf8");
    gitAdd(root, [tracked]);
    gitCommit(root, "seed");
    // 无关 unstaged 三态: untracked / modified / deleted(-A 会被扫入 commit, 精确 pathspec 必须原样保留)。
    writeFileSync(join(root, "stray.txt"), "stray\n", "utf8"); // untracked(根含 tracked 文件, 不折叠目录)
    writeFileSync(tracked, "v2\n", "utf8"); // tracked → unstaged modified
    const goner = p.world.objectFile("unrelated-goner");
    writeFileSync(goner, "g\n", "utf8");
    gitAdd(root, [goner]);
    gitCommit(root, "seed2");
    rmSync(goner); // tracked → unstaged deleted

    writeAtlasNode(root, makeNode({ id: "n1" }));

    // commit 只含本次写的 node 文件(完整精确路径, 非目录前缀/非 ./ 开头)。
    expect(lastCommitFiles(root)).toEqual([relative(root, p.world.atlas.nodeFile("n1"))]);
    // 无关改动全部保持原状(仍 unstaged/untracked, 未被 -A 扫入)。
    expect(dirty(root)).toEqual([
      ` D ${relative(root, goner)}`, // unstaged deleted
      ` M ${relative(root, tracked)}`, // unstaged modified
      "?? stray.txt", // untracked
    ]);

    // 同 id 重写 = 覆盖已有跟踪文件: 仍是「精确 pathspec 的修改」, 只影响该文件。
    writeAtlasNode(root, makeNode({ id: "n1", title: "封面重写" }));
    expect(lastCommitFiles(root)).toEqual([relative(root, p.world.atlas.nodeFile("n1"))]);
    expect(dirty(root)).toEqual([
      ` D ${relative(root, goner)}`,
      ` M ${relative(root, tracked)}`,
      "?? stray.txt",
    ]);
  });

  it("writeAtlasRun: 只 stage run 文件; 无关 unstaged 不进 commit; 预暂存无关项不被 gitAdd 触碰", () => {
    const root = makeRoot();
    const p = paths(root);
    // 无关 unstaged(untracked)。
    writeFileSync(join(root, "stray.txt"), "stray\n", "utf8");
    // 无关 pre-staged(gitAdd 不得改写其索引状态; 其随 commit 走是全索引 gitCommit 的既有契约)。
    const preStaged = p.world.objectFile("pre-staged");
    writeFileSync(preStaged, "s\n", "utf8");
    gitAdd(root, [preStaged]);

    const run: AtlasRun = {
      schema_version: 1,
      id: "r1",
      run_kind: "initial",
      status: "planning",
      options: { style_note: "", include_working_drafts: false, include_interiors: false, full_rebuild: false },
      context_hash: "",
      source_manifest: [],
      spatial_evidence: {},
      atlas_plan: { style_brief: "", nodes: [] },
      planned_page_count: 0,
      checkpoint: "spatial:2",
      error_code: null,
      error_message: null,
      journal: [],
      created_at: "2026-08-15T00:00:00.000Z",
    };
    writeAtlasRun(root, run);

    const head = lastCommitFiles(root);
    expect(head).toContain(relative(root, p.assistant.atlas.runFile("r1")));
    expect(head).toContain(relative(root, preStaged)); // 预暂存项既存契约, 非本次 gitAdd 引入
    expect(head).not.toContain("stray.txt"); // 无关 unstaged 未被 -A 扫入
    expect(dirty(root)).toEqual(["?? stray.txt"]); // 无关 untracked 原样保留在工作区
  });

  it("writeAtlasCandidates: 单 commit 只含全部候选文件; 无关 unstaged 不进", () => {
    const root = makeRoot();
    const p = paths(root);
    writeFileSync(join(root, "stray.txt"), "stray\n", "utf8");
    writeAtlasCandidates(
      root,
      [makeNode({ id: "nA", status: "provisional" })],
      [makePage({ id: "pgA", node_ref: "nA", review_status: "candidate" })],
      "atlas: test candidates",
    );
    expect(lastCommitFiles(root).sort()).toEqual(
      [
        relative(root, p.world.atlas.pendingNodeFile("nA")),
        relative(root, p.world.atlas.pendingPageFile("pgA")),
      ].sort(),
    );
    expect(dirty(root)).toEqual(["?? stray.txt"]);
  });

  it("writeAtlasCandidates 空写面: 零 git 动作(不 commit, 预暂存无关项不被扫入)", () => {
    const root = makeRoot();
    const p = paths(root);
    const preStaged = p.world.objectFile("pre-staged");
    writeFileSync(preStaged, "s\n", "utf8");
    gitAdd(root, [preStaged]);
    writeAtlasCandidates(root, [], [], "atlas: empty candidates");
    // 零新 commit(initVault bootstrap 之后仍是 1 个)。
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim()).toBe("1");
    // 预暂存项仍只暂存、未提交(空 pathspec 的 git add 是 no-op, 严禁退化为 -A)。
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(staged).toEqual([relative(root, preStaged)]);
  });
});

describe("ATLAS_LEVEL_RANK(规则 1 层级锚点)", () => {
  it("父级 rank 严格大于子级", () => {
    expect(ATLAS_LEVEL_RANK.cover).toBeGreaterThan(ATLAS_LEVEL_RANK.world);
    expect(ATLAS_LEVEL_RANK.world).toBeGreaterThan(ATLAS_LEVEL_RANK.region);
    expect(ATLAS_LEVEL_RANK.region).toBeGreaterThan(ATLAS_LEVEL_RANK.city);
    expect(ATLAS_LEVEL_RANK.city).toBeGreaterThan(ATLAS_LEVEL_RANK.district);
    expect(ATLAS_LEVEL_RANK.district).toBeGreaterThan(ATLAS_LEVEL_RANK.street);
    expect(ATLAS_LEVEL_RANK.street).toBeGreaterThan(ATLAS_LEVEL_RANK.interior);
  });
});
