// outline 行为契约(specs/assets/outline.md + N1/N12 + catalog §2)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { StoreError, gitAdd, gitCommit, gitStatusEntries, relOf, parseFrontmatter, validateFrontmatter } from "@novelcraft/store";
import { analyzeOutline, buildOutlineSelectedContext, generateOutlineItem, generateStoryOutline, listOutlinePreviews, listScenes, readOutline, sceneFusionDraft, sceneHealthSignals, structureHealthSignals, writeOutline, writeStructureAsset } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "nco-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 测试侧 git CLI(只读断言; 生产实现经 store git 封装)。 */
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
}

/** HEAD commit 改动的文件列表(-z 未引号化输出, 非 ASCII 路径逐字; 断言 commit 原子性)。 */
function committedFiles(root: string): string[] {
  return git(root, ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", "HEAD"]).split("\0").filter(Boolean);
}

describe("sceneHealthSignals(N1 四键)", () => {
  it("未关联章节 + 未复核 → 两键", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "scenes", "s001.md"),
      '---\nid: s001\nstatus: draft\ntitle: S1\nsource: deep_import\n---\n',
    );
    gitAdd(root); gitCommit(root, "scene");
    const signals = sceneHealthSignals(listScenes(root));
    expect(signals[0].keys).toContain("scene_unreviewed");
    expect(signals[0].keys).toContain("scene_unassigned_chapter");
    // N1 富化: 带 title + 证据明细(缺设定 → goal)。
    expect(signals[0].title).toBe("S1");
    const missing = signals[0].details.find((d) => d.key === "scene_missing_setup");
    expect(missing?.missing).toContain("goal");
  });
});

describe("structureHealthSignals(N1 后两键)", () => {
  it("thread 无 related → structure_unassigned", () => {
    const root = makeRoot();
    writeStructureAsset(root, "thread", { title: "主线", summary: "s" });
    const signals = structureHealthSignals(root);
    expect(signals.some((s) => s.keys.includes("structure_unassigned"))).toBe(true);
  });

  it("写链硬错(ADR-0019 P3): 悬空 relations 拒绝写入, 文件不落盘", () => {
    const root = makeRoot();
    expect(() =>
      writeStructureAsset(root, "thread", {
        title: "主线",
        relations: [{ target: "不存在的对象", type: "references_entity" }],
      }),
    ).toThrowError(/relations 校验失败/);
    // 硬错后文件未落盘(fail-closed)
    expect(readdirSync(join(root, "structure", "threads"))).toEqual([]);
  });

  it("写链合法边(ADR-0019): 引用已存在的对象, 落盘成功", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "world", "objects", "霜华剑.md"),
      '---\nid: 霜华剑\nkind: item\nname: 霜华剑\nstatus: canonical\n---\n',
    );
    gitAdd(root); gitCommit(root, "obj");
    const slug = writeStructureAsset(root, "thread", {
      title: "主线",
      relations: [{ target: "霜华剑", type: "references_entity" }],
    });
    expect(slug).toContain("主线");
  });
});

describe("listOutlinePreviews(作者工作台读面)", () => {
  it("只读形态正确的普通文件，按生成时间倒序，坏记录和 symlink 忽略", () => {
    const root = makeRoot();
    const dir = join(root, ".assistant", "proposals");
    writeFileSync(join(dir, "outline-p1.json"), JSON.stringify({
      kind: "story_outline", run_id: "p1", generated_at: "2026-01-01T00:00:00Z", input_hash: "a", result: { title: "旧" },
    }));
    writeFileSync(join(dir, "outline-item-plot_thread-p2.json"), JSON.stringify({
      kind: "outline_item", target: "plot_thread", run_id: "p2", generated_at: "2026-02-01T00:00:00Z", input_hash: "b", result: { content: { title: "新" } },
    }));
    writeFileSync(join(dir, "outline-bad.json"), "{");
    symlinkSync(join(dir, "outline-p1.json"), join(dir, "outline-p3.json"));
    expect(listOutlinePreviews(root).map((record) => record.run_id)).toEqual(["p2", "p1"]);
  });

  it("proposals 根 symlink 不读取 Vault 外 preview", () => {
    const root = makeRoot();
    const dir = join(root, ".assistant", "proposals");
    const outside = mkdtempSync(join(tmpdir(), "nco-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "outline-pexternal.json"), JSON.stringify({
      kind: "story_outline", run_id: "pexternal", generated_at: "2026-09-01T00:00:00Z",
      input_hash: "x", result: { title: "EXTERNAL-OUTLINE-MARKER" },
    }));
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(outside, dir, "dir");
    expect(() => listOutlinePreviews(root)).toThrow(/symlink|escapes vault root/i);
  });
});

describe("总纲 outline.md 单文件(adjudication #1)", () => {
  it("写读回, outline_markdown 在正文", () => {
    const root = makeRoot();
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一" });
    const o = readOutline(root)!;
    expect(o.title).toBe("总纲");
    expect(o.outline_markdown).toContain("# 卷一");
    expect(existsSync(join(root, "structure", "outline.md"))).toBe(true);
  });
});

// gitAdd 精确 pathspec 契约(store git.ts:124 + relOf, 同 merge.ts 用法):
// writeOutline/writeStructureAsset 只暂存本操作文件(相对 repo 根的 POSIX 路径),
// 绝不 -A——无关的 unstaged/untracked(含删除)一律保持原状, 不卷入本 commit。
describe("写链 gitAdd 精确 pathspec(不 -A, 保留无关 staged/unstaged)", () => {
  /** 无关脏状态: unstaged 修改 + untracked + unstaged 删除(均为 -A 会卷入的对象)。 */
  function dirtyWorktree(root: string) {
    writeFileSync(join(root, "scenes", "u-mod.md"), '---\nid: u-mod\nstatus: draft\ntitle: UM\n---\n');
    writeFileSync(join(root, "scenes", "u-del.md"), '---\nid: u-del\nstatus: draft\ntitle: UD\n---\n');
    gitAdd(root); gitCommit(root, "base"); // 基线 commit(测试夹具, 允许全量)
    writeFileSync(join(root, "scenes", "u-mod.md"), '---\nid: u-mod\nstatus: draft\ntitle: UM2\n---\n'); // unstaged 修改
    writeFileSync(join(root, "scenes", "u-new.md"), '---\nid: u-new\nstatus: draft\ntitle: UN\n---\n'); // untracked
    rmSync(join(root, "scenes", "u-del.md")); // unstaged 删除
  }

  it("writeOutline: commit 只含 structure/outline.md, 无关状态原样保留", () => {
    const root = makeRoot();
    dirtyWorktree(root);
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一" });
    expect(committedFiles(root)).toEqual(["structure/outline.md"]); // 原子 commit, 无 -A 卷入
    const sig = gitStatusEntries(root).map((e) => `${e.status}|${e.path}`).sort();
    expect(sig).toEqual([" D|scenes/u-del.md", " M|scenes/u-mod.md", "??|scenes/u-new.md"].sort());
  });

  it("writeOutline 二次改写: 仍只含 outline.md(修改态同样精确)", () => {
    const root = makeRoot();
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一" });
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一之改" });
    expect(committedFiles(root)).toEqual(["structure/outline.md"]);
    expect(gitStatusEntries(root)).toEqual([]); // 工作区干净
  });

  it("writeStructureAsset: commit 只含本资产文件, 无关状态原样保留", () => {
    const root = makeRoot();
    dirtyWorktree(root);
    const slug = writeStructureAsset(root, "arc", { title: "第一卷" });
    expect(committedFiles(root)).toEqual([`structure/arcs/${slug}.md`]);
    const sig = gitStatusEntries(root).map((e) => `${e.status}|${e.path}`).sort();
    expect(sig).toEqual([" D|scenes/u-del.md", " M|scenes/u-mod.md", "??|scenes/u-new.md"].sort());
  });

  it("精确 pathspec 含删除: 已删除的 outline.md 经同款 relOf pathspec 单独暂存删除", () => {
    const root = makeRoot();
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一" });
    rmSync(join(root, "structure", "outline.md")); // 路径被删(worktree 无文件, index 仍有)
    gitAdd(root, [relOf(root, join(root, "structure", "outline.md"))]);
    expect(gitStatusEntries(root)).toContainEqual({ status: "D ", path: "structure/outline.md" });
  });
});

describe("结构创作编排(catalog §2)", () => {
  it("selected outline target 进入预算内 P0 与 context_hash(RV-05)", () => {
    const root = makeRoot();
    const selection = { instruction: "根据已确认资料生成结构资产", budget_tokens: 200 };
    const thread = buildOutlineSelectedContext(root, "outline_item", selection, "plot_thread");
    const arc = buildOutlineSelectedContext(root, "outline_item", selection, "outline_arc");
    expect(thread.rendered_text).toContain("【target: plot_thread】");
    expect(arc.rendered_text).toContain("【target: outline_arc】");
    expect(thread.context_hash).not.toBe(arc.context_hash);
    expect(thread.total_tokens).toBeLessThanOrEqual(thread.budget_tokens);
  });

  it("总纲生成落 outline.md", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ title: "总纲", outline_markdown: "卷一", open_decisions: [] }) }],
    });
    const r = await generateStoryOutline(provider, root, "写总纲");
    expect(r.ok).toBe(true);
    expect(readOutline(root)?.title).toBe("总纲");
  });
  it("P20 thread 落 structure/threads/", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ target: "plot_thread", content: { title: "主线", summary: "s", confidence: 0.9 } }) }],
    });
    const r = await generateOutlineItem(provider, root, "plot_thread", "生成主线");
    expect(r.ok).toBe(true);
    expect(r.slug).toBeTruthy();
    expect(existsSync(join(root, "structure", "threads", r.slug + ".md"))).toBe(true);
  });
  it("analyze 不写资产", async () => {
    const root = makeRoot();
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ analysis: "结构清晰" }) }] });
    const r = await analyzeOutline(provider, "大纲文本");
    expect(r.ok).toBe(true);
    expect(listScenes(root)).toHaveLength(0);
  });
  it("sceneFusionDraft 返回合成卡", async () => {
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ title: "合成场景", confidence: 0.9 }) }] });
    const r = await sceneFusionDraft(provider, "两卡");
    expect(r.ok).toBe(true);
    expect((r.result as { title: string }).title).toBe("合成场景");
  });
});

describe("写端 schema 必填补齐(B3)", () => {
  function readFm(root: string, rel: string): Record<string, unknown> {
    return parseFrontmatter(readFileSync(join(root, rel), "utf8")).data as Record<string, unknown>;
  }

  it("writeStructureAsset thread: id/name/thread_type 齐备且过 schema(frontmatter.ts:492)", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "thread", { title: "主线", summary: "s" });
    const fm = readFm(root, `structure/threads/${slug}.md`);
    expect(fm.id).toBe(slug); // id = slug(B3)
    expect(fm.name).toBe("主线"); // name 默认取 title(B3)
    expect(fm.thread_type).toBe("main");
    expect(validateFrontmatter("thread", fm as never)).toEqual([]);
  });

  it("writeStructureAsset arc: id 齐备且过 schema(frontmatter.ts:497)", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "arc", { title: "第一卷" });
    const fm = readFm(root, `structure/arcs/${slug}.md`);
    expect(fm.id).toBe(slug);
    expect(validateFrontmatter("arc", fm as never)).toEqual([]);
  });

  it("writeStructureAsset foreshadowing: name 齐备且过 schema(frontmatter.ts:502)", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "foreshadowing", { title: "怀表伏笔" });
    const fm = readFm(root, `structure/foreshadowing/${slug}.md`);
    expect(fm.id).toBe(slug);
    expect(fm.name).toBe("怀表伏笔"); // name 默认取 title(B3)
    expect(validateFrontmatter("foreshadowing", fm as never)).toEqual([]);
  });

  it("writeStructureAsset reveal: 缺 target 三件套 fail-closed 拒写, 文件不落盘(frontmatter.ts:508)", () => {
    const root = makeRoot();
    expect(() => writeStructureAsset(root, "reveal", { title: "秘密" })).toThrowError(/reveal 必填缺失/);
    expect(readdirSync(join(root, "structure", "reveal"))).toEqual([]);
  });

  it("writeStructureAsset reveal: target_type/target_id/secret_summary 齐备落盘且过 schema", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "reveal", {
      title: "秘密",
      target_type: "world_entity",
      target_id: "霜华剑",
      secret_summary: "剑是赝品",
    });
    const fm = readFm(root, `structure/reveal/${slug}.md`);
    expect(fm.target_type).toBe("world_entity");
    expect(fm.target_id).toBe("霜华剑");
    expect(fm.secret_summary).toBe("剑是赝品");
    expect(validateFrontmatter("reveal", fm as never)).toEqual([]);
  });

  it("writeOutline: creative_core/major_storylines/macro_movements/open_decisions 缺省补齐(frontmatter.ts:513)", () => {
    const root = makeRoot();
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一" });
    const o = readOutline(root)!;
    expect(o.creative_core).toEqual({});
    expect(o.major_storylines).toEqual([]);
    expect(o.macro_movements).toEqual([]);
    expect(o.open_decisions).toEqual([]);
  });

  it("generateStoryOutline 持久化 major_storylines/macro_movements/open_decisions 到 outline.md", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          title: "总纲",
          outline_markdown: "卷一",
          major_storylines: [{ name: "主线", narrative_function: "backbone" }],
          macro_movements: [{ name: "启幕", story_state_change: "平静→动乱" }],
          open_decisions: [{ question: "结局走向?" }],
        }),
      }],
    });
    const r = await generateStoryOutline(provider, root, "写总纲");
    expect(r.ok).toBe(true);
    const o = readOutline(root)!;
    expect((o.major_storylines as Array<{ name: string }>)[0].name).toBe("主线");
    expect((o.macro_movements as Array<{ name: string }>)[0].name).toBe("启幕");
    expect((o.open_decisions as Array<{ question: string }>)[0].question).toBe("结局走向?");
  });

  it("generateOutlineItem: content 透传 name/thread_type; reveal 三件套进 fm", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          target: "plot_thread",
          content: {
            title: "主线",
            name: "主角成长线",
            thread_type: "character",
            target_type: "character",
            target_id: "obj-klein",
            secret_summary: "克莱恩是穿越者",
            summary: "s",
            confidence: 0.9,
          },
        }),
      }],
    });
    const r = await generateOutlineItem(provider, root, "plot_thread", "生成主线");
    expect(r.ok).toBe(true);
    const fm = readFm(root, `structure/threads/${r.slug}.md`);
    expect(fm.id).toBe(r.slug);
    expect(fm.name).toBe("主角成长线");
    expect(fm.thread_type).toBe("character");
    // reveal 必填三件套经 content 透传(frontmatter.ts:508)
    expect(fm.target_type).toBe("character");
    expect(fm.target_id).toBe("obj-klein");
    expect(fm.secret_summary).toBe("克莱恩是穿越者");
    expect(validateFrontmatter("thread", fm as never)).toEqual([]);
  });
});

describe("写链 validateFrontmatter 接入(N23/M7-C)", () => {
  function readFm(root: string, rel: string): Record<string, unknown> {
    return parseFrontmatter(readFileSync(join(root, rel), "utf8")).data as Record<string, unknown>;
  }

  it("writeStructureAsset: 类型不合规(relations 非 list) → VALIDATION_FAILED 且文件未落盘", () => {
    const root = makeRoot();
    let err: unknown;
    try {
      writeStructureAsset(root, "thread", { title: "主线", relations: "legacy-string" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError); // N23: 校验失败统一 StoreError(与 assertValidRelations 同构)
    expect((err as StoreError).code).toBe("VALIDATION_FAILED");
    expect(readdirSync(join(root, "structure", "threads"))).toEqual([]); // fail-closed: 不写字
  });

  it("writeStructureAsset: 合规写入不受校验影响(N23)", () => {
    const root = makeRoot();
    const slug = writeStructureAsset(root, "arc", { title: "第二卷", summary: "s" });
    const fm = readFm(root, `structure/arcs/${slug}.md`);
    expect(fm.id).toBe(slug);
    expect(validateFrontmatter("arc", fm as never)).toEqual([]);
  });

  it("writeOutline: 缺必填 title → VALIDATION_FAILED 且 outline.md 未创建", () => {
    const root = makeRoot();
    let err: unknown;
    try {
      writeOutline(root, { outline_markdown: "# 卷一" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("VALIDATION_FAILED");
    expect(existsSync(join(root, "structure", "outline.md"))).toBe(false); // fail-closed: 不写字
  });

  it("writeOutline: 合规写入不受校验影响(N23)", () => {
    const root = makeRoot();
    writeOutline(root, { title: "总纲", outline_markdown: "# 卷一" });
    const { data, body } = parseFrontmatter(readFileSync(join(root, "structure", "outline.md"), "utf8"));
    expect(validateFrontmatter("outline", { ...data, outline_markdown: body.trim() } as never)).toEqual([]);
  });
});

// R9(目录枚举扫描): readdirSync + withFileTypes 只接收 entry.isFile() 的 .md 普通文件;
// 仓库内已提交的指向 vault 外 .md 的 symlink 必须被安全忽略, 绝不跟随读取。
// 平台不支持 symlink(如 Windows 非管理员)时 skipIf。
const symlinkSupported = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), "ncl-"));
    symlinkSync("t", join(d, "l"));
    rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!symlinkSupported)("listScenes 忽略指向 vault 外的 .md symlink(R9)", () => {
  it("外部文件内容不可见, 普通 scene 正常列出", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "nco-x-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), '---\ntitle: 外部泄漏\nstatus: draft\n---\n');
    symlinkSync(join(outside, "secret.md"), join(root, "scenes", "evil.md"));
    writeFileSync(
      join(root, "scenes", "s001.md"),
      '---\nid: s001\nstatus: draft\ntitle: S1\nsource: deep_import\n---\n',
    );
    const scenes = listScenes(root);
    expect(scenes.map((s) => s.slug)).toEqual(["s001"]);
    expect(scenes.some((s) => s.title === "外部泄漏")).toBe(false);
  });

  it("目录里只有 symlink 时返回空(安全忽略, 不跟随)", () => {
    const root = makeRoot();
    const outside = mkdtempSync(join(tmpdir(), "nco-x-"));
    dirs.push(outside);
    writeFileSync(join(outside, "secret.md"), '---\ntitle: 外部泄漏\nstatus: draft\n---\n');
    symlinkSync(join(outside, "secret.md"), join(root, "scenes", "evil.md"));
    expect(listScenes(root)).toEqual([]);
  });
});
