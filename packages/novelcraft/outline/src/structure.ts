// outline · 结构面(Scene/线程/篇章/总纲 + 结构健康信号, R5 确定性核心)。
// 依据: specs/assets/outline.md + store-rules + N1(六键健康词汇表)+ N12(目录化)。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths, slugify } from "@novelcraft/vault";
import { assertValidRelations, computeSceneHealthDetail, gitAdd, gitCommit, parseFrontmatter, relOf, serializeFrontmatter, StoreError, validateFrontmatter } from "@novelcraft/store";

export interface SceneLite {
  slug: string;
  title: string;
  status: string;
  chapter_ids: number[];
  file: string;
  fm: Record<string, unknown>;
}

export function listScenes(root: string): SceneLite[] {
  const dir = paths(root).scenes.dir;
  if (!existsSync(dir)) return [];
  // R9(目录枚举扫描): withFileTypes 只接收 entry.isFile() 的 .md 普通文件;
  // 仓库内已提交的 symlink(即使指向 vault 外)一律忽略, 绝不跟随读取。
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => {
      const f = e.name;
      const file = `${dir}/${f}`;
      const { data } = parseFrontmatter(readFileSync(file, "utf8"));
      return {
        slug: f.replace(/\.md$/, ""),
        title: String(data.title ?? ""),
        status: String(data.status ?? ""),
        chapter_ids: Array.isArray(data.chapter_ids) ? data.chapter_ids.map(Number) : [],
        file,
        fm: data as Record<string, unknown>,
      };
    });
}

/** Scene 四键健康信号(N1): 委托 store 确定性推导; 带 title 与证据明细。 */
export function sceneHealthSignals(
  scenes: SceneLite[],
): Array<{ slug: string; title: string; keys: string[]; details: ReturnType<typeof computeSceneHealthDetail> }> {
  return scenes
    .map((s) => {
      const details = computeSceneHealthDetail(s.fm as never);
      return { slug: s.slug, title: s.title, keys: details.map((d) => d.key), details };
    })
    .filter((x) => x.keys.length > 0);
}

/** 结构资产级信号(N1 后两键): threads/arcs 等目录里的 needs_review/unassigned。 */
export interface StructureHealthInput {
  kind: string;
  slug: string;
  title: string;
  fm: Record<string, unknown>;
}

export function structureHealthSignalsFromEntries(
  entries: readonly StructureHealthInput[],
): Array<{ kind: string; slug: string; title: string; keys: string[] }> {
  const out: Array<{ kind: string; slug: string; title: string; keys: string[] }> = [];
  for (const { kind, slug, title, fm } of entries) {
    const keys: string[] = [];
    if (fm.needs_review === true) keys.push("structure_needs_review");
    const related = Array.isArray(fm.related_thread_ids) ? fm.related_thread_ids : [];
    if (fm.unassigned === true || (related.length === 0 && kind === "thread")) keys.push("structure_unassigned");
    if (keys.length) out.push({ kind, slug, title, keys });
  }
  return out;
}

export function structureHealthSignals(
  root: string,
): Array<{ kind: string; slug: string; title: string; keys: string[] }> {
  const entries: StructureHealthInput[] = [];
  const p = paths(root).structure;
  const dirs: Array<[string, string]> = [
    ["thread", p.threads],
    ["arc", p.arcs],
    ["foreshadowing", p.foreshadowing],
    ["reveal", p.reveal],
  ];
  for (const [kind, dir] of dirs) {
    if (!existsSync(dir)) continue;
    // R9(目录枚举扫描): 只接收 .md 普通文件; symlink(含指向 vault 外)忽略, 不跟随。
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const f = entry.name;
      const { data } = parseFrontmatter(readFileSync(`${dir}/${f}`, "utf8"));
      entries.push({
        kind,
        slug: f.replace(/\.md$/, ""),
        title: typeof data.title === "string" ? data.title : String(data.name ?? ""),
        fm: data as Record<string, unknown>,
      });
    }
  }
  return structureHealthSignalsFromEntries(entries);
}

/** 总纲单文件(structure/outline.md, adjudication #1): 读/写; revisions 由 git 承接。 */
export function readOutline(root: string): Record<string, unknown> | undefined {
  const file = paths(root).structure.outline;
  if (!existsSync(file)) return undefined;
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
  return { ...data, outline_markdown: body.trim() };
}

export function writeOutline(
  root: string,
  content: Record<string, unknown>,
  opts: { workflowId?: string; message?: string } = {},
): void {
  const file = paths(root).structure.outline;
  const { outline_markdown: body, ...meta } = content as { outline_markdown?: string } & Record<string, unknown>;
  // B3 必填补齐(frontmatter.ts:513): outline required 含 title/creative_core/outline_markdown/
  // major_storylines/macro_movements/open_decisions; 缺省给中性占位(不虚构语义), 显式值覆盖。
  const fm: Record<string, unknown> = {
    status: "draft",
    creative_core: content.creative_core ?? {},
    major_storylines: content.major_storylines ?? [],
    macro_movements: content.macro_movements ?? [],
    open_decisions: content.open_decisions ?? [],
    ...meta,
  };
  if (opts.workflowId) fm.workflow = opts.workflowId;
  // N23/M7-C: 落盘前按 outline schema 校验(frontmatter.ts:513)。outline_markdown 落正文,
  // 校验视图并入; issues 非空 fail-closed 不写字。
  const issues = validateFrontmatter("outline", { ...fm, outline_markdown: String(body ?? "") });
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new StoreError("VALIDATION_FAILED", `outline frontmatter 校验失败: ${detail}`, issues);
  }
  writeFileSync(file, serializeFrontmatter(fm, String(body ?? "")), "utf8");
  // 精确 pathspec(relOf = 相对 repo 根的 POSIX 路径, store/merge.ts 同款): 只暂存
  // 本操作路径(增/改/删都由 `git add <path>` 统一承接), 绝不 -A——无关的
  // staged/unstaged/untracked 一律保持原状, 不卷入本 commit。
  gitAdd(root, [relOf(root, file)]);
  gitCommit(root, opts.message ?? "outline: update story outline");
}

/** 写结构资产(threads/arcs/foreshadowing/reveal 目录, N12)。 */
export function writeStructureAsset(
  root: string,
  kind: "thread" | "arc" | "foreshadowing" | "reveal",
  content: Record<string, unknown>,
  opts: { workflowId?: string } = {},
): string {
  const title = String(content.title ?? "未命名");
  const slug = slugify(`${kind}-${title}`) || `${kind}-${Date.now()}`;
  const dir =
    kind === "thread" ? paths(root).structure.threads :
    kind === "arc" ? paths(root).structure.arcs :
    kind === "foreshadowing" ? paths(root).structure.foreshadowing :
    paths(root).structure.reveal;
  const { summary: body, ...meta } = content as { summary?: string } & Record<string, unknown>;
  const fm: Record<string, unknown> = { status: "draft", id: slug, title, ...meta };
  // B3 必填补齐(store/src/frontmatter.ts:491-511):
  // thread=id/status/name/thread_type; arc=id/status/title; foreshadowing=id/status/name;
  // reveal=id/status/target_type/target_id/secret_summary。
  if (kind === "thread" || kind === "foreshadowing") {
    // name 默认取 title(B3); thread_type 自由字符串, 常见 main(specs/assets/outline.md:148)。
    if (typeof fm.name !== "string" || fm.name === "") fm.name = title;
  }
  if (kind === "thread" && (typeof fm.thread_type !== "string" || fm.thread_type === "")) {
    fm.thread_type = "main";
  }
  if (kind === "reveal") {
    // 语义字段不可虚构: 缺 target_type/target_id/secret_summary → fail-closed 拒写。
    const missing = (["target_type", "target_id", "secret_summary"] as const).filter(
      (k) => typeof fm[k] !== "string" || fm[k] === "",
    );
    if (missing.length > 0) {
      throw new Error(`reveal 必填缺失(frontmatter.ts:508): ${missing.join(", ")}`);
    }
  }
  if (opts.workflowId) fm.workflow = opts.workflowId;
  // ADR-0019 P3(用户裁定): relations 写前硬错校验(自环/悬空/type 白名单/端点 kind)。
  if (Array.isArray(fm.relations)) {
    assertValidRelations(root, kind, slug, fm.relations);
  }
  // N23/M7-C: B3 必填补齐 + relations 校验之后、落盘之前, 按 kind schema 校验
  // (thread/arc/foreshadowing/reveal, frontmatter.ts:491-511); issues 非空 fail-closed 不写字。
  const issues = validateFrontmatter(kind, fm);
  if (issues.length > 0) {
    const detail = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new StoreError("VALIDATION_FAILED", `${kind} frontmatter 校验失败: ${detail}`, issues);
  }
  const file = `${dir}/${slug}.md`;
  writeFileSync(file, serializeFrontmatter(fm, String(body ?? "")), "utf8");
  // 精确 pathspec(relOf = 相对 repo 根的 POSIX 路径, store/merge.ts 同款): 只暂存
  // 本操作路径(增/改/删都由 `git add <path>` 统一承接), 绝不 -A——无关的
  // staged/unstaged/untracked 一律保持原状, 不卷入本 commit。
  gitAdd(root, [relOf(root, file)]);
  gitCommit(root, `outline: ${kind} ${slug}`);
  return slug;
}
