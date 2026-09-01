// world 行为契约(specs/assets/world.md + §19 映射)
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { StoreError, adopt, confirmSuggestion, gitAdd, gitCommit, gitLogSubjects, gitStatusEntries, parseFrontmatter, validateFrontmatter } from "@novelcraft/store";
import { createObject, executePreparedUpdateObject, listObjects, listPending, listTags, prepareUpdateObject, readObject, readPendingObject, suggestBiblePage, suggestEntity, updateObject, worldChat, worldChatSelected, worldConverge, worldExplore, worldInspect } from "../src/index";

/**
 * symlink 能力探测(平台允许时才跑 symlink 回归; Windows 无特权进程创建
 * symlink 会抛 EPERM/ENOSYS → 相关测试 skip)。
 */
let symlinkCapable: boolean | undefined;
function symlinksSupported(): boolean {
  if (symlinkCapable === undefined) {
    const probe = mkdtempSync(join(tmpdir(), "ncwd-link-"));
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
  const root = mkdtempSync(join(tmpdir(), "ncwd-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});


// M12-b review P1-1: slug 坍缩错误语义区分(同名 vs 坍缩)。
describe('createObject slug 冲突语义(N44 追记)', () => {
  it('同名对象与坍缩冲突报错可分辨', async () => {
    const root = makeRoot();
    await createObject(root, { name: '神秘女子', entityType: 'character' });
    // 同名: 报「同名对象」
    await expect(createObject(root, { name: '神秘女子', entityType: 'character' })).rejects.toThrow(/同名对象/);
    // 坍缩: 「?!?」全折为 '-' 与既有 slug(obj-神秘女子)不同 → 正常创建(不同 slug);
    // 用中文名折出相同前缀的场景难构造, 此处锁定的是同名分支可分辨 + 坍缩分支存在。
    await expect(createObject(root, { name: '?!?', entityType: 'object' })).resolves.toBeTruthy();
  });
});


describe("objects CRUD(薄封装)", () => {
  it("创建/读取/列表/标签派生(N13); 写面统一 kind(B1 裁定)", async () => {
    const root = makeRoot();
    const slug = await createObject(root, { name: "苏婉", entityType: "character", aliases: ["红衣女子"], tags: ["主角团"] });
    const raw = readFileSync(join(root, "world", "objects", slug + ".md"), "utf8");
    expect(raw).toContain('kind: "character"'); // B1: 写端用 kind(specs/assets/world.md 字段表)
    expect(raw).not.toContain("entity_type:");
    const obj = readObject(root, slug);
    expect(obj.name).toBe("苏婉");
    expect(obj.entity_type).toBe("character"); // 读面 kind 优先
    expect(obj.aliases).toContain("红衣女子");
    expect(obj.status).toBe("canonical");
    expect(listObjects(root)).toHaveLength(1);
    expect(listTags(root)).toEqual([{ tag: "主角团", count: 1 }]);
  });
  it("重名创建拒绝; 更新 tags", async () => {
    const root = makeRoot();
    const slug = await createObject(root, { name: "克莱恩", entityType: "character" });
    await expect(createObject(root, { name: "克莱恩", entityType: "character" })).rejects.toThrow(/已存在/);
    await updateObject(root, slug, { tags: ["主角"] });
    expect(readObject(root, slug).tags).toEqual(["主角"]);
  });
  it("R1 范围语义: create/update 的 commit 只含本操作对象文件, 无关用户改动不被 gitAdd 捕获", async () => {
    const root = makeRoot();
    // 无关用户改动: 既有已提交文件被改动(旧形态 gitAdd -A 会误入 commit) + 一个未跟踪新文件。
    writeFileSync(join(root, "user-notes.md"), "用户已提交笔记");
    gitAdd(root, ["user-notes.md"]);
    gitCommit(root, "user: notes");
    writeFileSync(join(root, "user-notes.md"), "用户后续修改");
    writeFileSync(join(root, "stray-note.md"), "用户未跟踪笔记");
    expect(gitStatusEntries(root)).toContainEqual({ status: " M", path: "user-notes.md" });
    expect(gitStatusEntries(root)).toContainEqual({ status: "??", path: "stray-note.md" });

    const slug = await createObject(root, { name: "苏婉", entityType: "character" });
    // 对象文件已提交且不残留; 无关改动(modified + untracked)保持原状, 未被 -A 扫入。
    expect(gitStatusEntries(root).filter((e) => e.path.includes(`${slug}.md`))).toEqual([]);
    expect(gitStatusEntries(root)).toContainEqual({ status: " M", path: "user-notes.md" });
    expect(gitStatusEntries(root)).toContainEqual({ status: "??", path: "stray-note.md" });
    expect(gitLogSubjects(root).some((subject) => /^vault-tx vtx:.* \(canonical\)$/.test(subject))).toBe(true);

    await updateObject(root, slug, { tags: ["主角"] });
    expect(gitLogSubjects(root).filter((subject) => /^vault-tx vtx:.* \(canonical\)$/.test(subject)).length).toBeGreaterThanOrEqual(2);
    // update 同样只暂存本操作文件, 不捕获无关改动。
    expect(gitStatusEntries(root).filter((e) => e.path.includes(`${slug}.md`))).toEqual([]);
    expect(gitStatusEntries(root)).toContainEqual({ status: " M", path: "user-notes.md" });
    expect(gitStatusEntries(root)).toContainEqual({ status: "??", path: "stray-note.md" });
  }, 15_000);
  it("updateObject 审批前 prepare 后外部编辑，批准执行固定基线冲突且不覆盖(N32)", async () => {
    const root = makeRoot();
    const slug = await createObject(root, { name: "苏婉", entityType: "character", description: "原正文" });
    const prepared = prepareUpdateObject(root, slug, { tags: ["主角"] });
    const file = join(root, "world", "objects", `${slug}.md`);
    const externallyEdited = readFileSync(file, "utf8").replace("原正文", "审批窗口编辑");
    writeFileSync(file, externallyEdited, "utf8");
    await expect(executePreparedUpdateObject(prepared)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(readFileSync(file, "utf8")).toContain("审批窗口编辑");
    expect(readFileSync(file, "utf8")).not.toContain("tags: [\"主角\"]");
  });

  it("updateObject 保留正文: CRLF 行尾 + 闭合符无尾换行 不损坏 body", async () => {
    const root = makeRoot();
    // CRLF 全文件: 手工 indexOf("\n---\n") 在 \r\n 下匹配不到 → 把 frontmatter 尾部当 body。
    const file = join(root, "world", "objects", "obj-crlf.md");
    writeFileSync(
      file,
      ['---', 'id: "obj-crlf"', 'name: "旧人"', 'kind: "character"', 'status: "canonical"', "---", "# 正文", "第一行"].join("\r\n"),
      "utf8",
    );
    await updateObject(root, "obj-crlf", { tags: ["新"] }); // 只改 tags, body 必须原样保留。
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    expect(data.name).toBe("旧人");
    expect(data.tags).toEqual(["新"]);
    // body 必须逐字节原样(CRLF 行尾不归一化), 不得含 frontmatter 残留。
    expect(body).toBe("# 正文\r\n第一行");
    expect(body).not.toContain('name:');
    expect(body).not.toContain('kind:');
  });
  it("updateObject 保留正文: 闭合 --- 后无 body(无尾换行)不产生垃圾正文", async () => {
    const root = makeRoot();
    // 文件以闭合 --- 结束、无尾换行、无正文: 手工提取会把 frontmatter 尾部当 body。
    const file = join(root, "world", "objects", "obj-nobody.md");
    writeFileSync(file, ['---', 'id: "obj-nobody"', 'name: "无人"', 'kind: "character"', 'status: "canonical"', "---"].join("\n"), "utf8");
    await updateObject(root, "obj-nobody", { tags: ["新"] });
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    expect(data.name).toBe("无人");
    expect(data.status).toBe("canonical");
    expect(body).toBe("");
  });
  it("createObject 落盘含 id 且过 object schema(N23/M7-C)", async () => {
    const root = makeRoot();
    const slug = await createObject(root, { name: "林晚", entityType: "character", aliases: ["晚娘"], tags: ["配角"] });
    const raw = readFileSync(join(root, "world", "objects", slug + ".md"), "utf8");
    expect(raw).toContain(`id: ${JSON.stringify(slug)}`); // N23: object required 含 id(frontmatter.ts:417)
    const { data } = parseFrontmatter(raw);
    expect(validateFrontmatter("object", data)).toEqual([]); // 合规写入不受影响
  });
  it("updateObject: 缺必填 id 的 legacy 对象 → VALIDATION_FAILED 且文件未被改写(N23/M7-C)", async () => {
    const root = makeRoot();
    const file = join(root, "world", "objects", "obj-legacy.md");
    writeFileSync(file, ["---", 'name: "旧人"', 'kind: "character"', "status: canonical", "---", ""].join("\n"), "utf8");
    const before = readFileSync(file, "utf8");
    let err: unknown;
    try {
      await updateObject(root, "obj-legacy", { tags: ["新标签"] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError); // N23: 校验失败统一 StoreError(与 assertValidRelations 同构)
    expect((err as StoreError).code).toBe("VALIDATION_FAILED");
    // fail-closed: 校验发生在任何写入之前, 文件内容不变(无部分状态)
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("legacy 兼容: 只含 entity_type 的旧对象文件仍可读(B1 fallback)", async () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "world", "objects", "obj-legacy.md"),
      ["---", 'name: "旧人"', 'entity_type: "character"', "status: canonical", "---", ""].join("\n"),
      "utf8",
    );
    const obj = readObject(root, "obj-legacy");
    expect(obj.entity_type).toBe("character"); // kind 缺失 → entity_type fallback(B1)
  });
  it("relations: list 形态 → 结构化对象数组; legacy 字符串形态保留(N14)", async () => {
    const root = makeRoot();
    // 旧 vault 字符串形态: 原样保留给读面。
    writeFileSync(
      join(root, "world", "objects", "obj-legacy.md"),
      ["---", 'name: "旧人"', 'kind: "character"', "status: canonical", 'relations: "obj-legacy -> obj-old (associate): 旧描述"', "---", ""].join("\n"),
      "utf8",
    );
    const obj = readObject(root, "obj-legacy");
    expect(obj.relations).toBe("obj-legacy -> obj-old (associate): 旧描述");

    // N14 list 形态 → ObjectRelation 数组。
    writeFileSync(
      join(root, "world", "objects", "obj-list.md"),
      [
        "---",
        'name: "新人"',
        'kind: "character"',
        "status: canonical",
        "relations:",
        "  - target: obj-b",
        "    type: associate",
        "    status: candidate",
        "---",
        "",
      ].join("\n"),
      "utf8",
    );
    const obj2 = readObject(root, "obj-list");
    expect(obj2.entity_type).toBe("character"); // kind 优先(B1)
    expect(obj2.relations).toEqual([{ target: "obj-b", type: "associate", status: "candidate" }]);
  });
});

describe("objects symlink fail-closed(R9: 同目录内部 symlink 也不跟随, 审批看到 x 不能改 y)", () => {
  const objFm = (id: string, name: string, status: string) =>
    ["---", `id: "${id}"`, `name: "${name}"`, 'kind: "character"', `status: ${status}`, "---", `# ${name} 正文`].join("\n");

  it.skipIf(!symlinksSupported())("readObject/updateObject 内部 symlink x→y: 拒绝且 y 哨兵不变", async () => {
    const root = makeRoot();
    const y = join(root, "world", "objects", "obj-y.md");
    writeFileSync(y, objFm("obj-y", "Y", "canonical"), "utf8");
    symlinkSync(y, join(root, "world", "objects", "obj-x.md")); // 同目录内部 symlink。
    // guardPath 的 real containment 放行 root 内 symlink; 最终目标必须逐段 lstat 拒绝。
    expect(() => readObject(root, "obj-x")).toThrow(/symlink/i); // 读不跟随: x 不是 y。
    await expect(updateObject(root, "obj-x", { tags: ["新标签"] })).rejects.toThrow(/symlink/i); // 写不跟随。
    expect(readFileSync(y, "utf8")).toContain('name: "Y"'); // y 哨兵不变。
    expect(readFileSync(y, "utf8")).not.toContain("新标签");
  });

  it.skipIf(!symlinksSupported())("listObjects 遇内部 symlink fail-closed 抛(不静默跟随)", async () => {
    const root = makeRoot();
    const y = join(root, "world", "objects", "obj-y.md");
    writeFileSync(y, objFm("obj-y", "Y", "canonical"), "utf8");
    symlinkSync(y, join(root, "world", "objects", "obj-x.md"));
    expect(() => listObjects(root)).toThrow(/symlink/i);
  });

  it.skipIf(!symlinksSupported())("readPendingObject/listPending 内部 symlink 同样拒绝", async () => {
    const root = makeRoot();
    const y = join(root, "world", "pending", "pend-y.md");
    writeFileSync(y, objFm("pend-y", "P", "candidate"), "utf8");
    symlinkSync(y, join(root, "world", "pending", "pend-x.md"));
    expect(() => readPendingObject(root, "pend-x")).toThrow(/symlink/i);
    expect(() => listPending(root)).toThrow(/symlink/i);
  });

  it.skipIf(!symlinksSupported())("外部 symlink 语义保持: read/update 拒绝, 外部哨兵不变", async () => {
    const root = makeRoot();
    const outside = join(tmpdir(), `ncwd-out-obj-${Date.now()}.md`);
    writeFileSync(outside, "外部哨兵, 不得被改写");
    try {
      symlinkSync(outside, join(root, "world", "objects", "obj-evil.md"));
      expect(() => readObject(root, "obj-evil")).toThrow(/escapes vault root/);
      await expect(updateObject(root, "obj-evil", { tags: ["x"] })).rejects.toThrow(/escapes vault root/);
      expect(readFileSync(outside, "utf8")).toBe("外部哨兵, 不得被改写");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it.skipIf(!symlinksSupported())("悬空 symlink → read/update fail-closed(不跟随创建)", async () => {
    const root = makeRoot();
    symlinkSync(join(root, "world", "objects", "no-such-target.md"), join(root, "world", "objects", "obj-dangling.md"));
    expect(() => readObject(root, "obj-dangling")).toThrow();
    await expect(updateObject(root, "obj-dangling", { tags: ["x"] })).rejects.toThrow();
  });

  it.skipIf(!symlinksSupported())("普通对象文件(无 symlink)读/更新/列表行为不变", async () => {
    const root = makeRoot();
    const slug = await createObject(root, { name: "苏婉", entityType: "character", tags: ["主角团"] });
    expect(readObject(root, slug).name).toBe("苏婉");
    await updateObject(root, slug, { tags: ["新"] });
    expect(readObject(root, slug).tags).toEqual(["新"]);
    expect(listObjects(root)).toHaveLength(1);
  });
});

describe("生成中心五模式(§19)", () => {
  it("chat 不写资产, 返回 reply", async () => {
    const root = makeRoot();
    const provider = new MockProvider({ responses: [{ text: JSON.stringify({ reply: "你好, 作者" }) }] });
    const r = await worldChat(provider, "你好");
    expect(r.ok).toBe(true);
    expect(r.reply).toBe("你好, 作者");
    expect(listObjects(root)).toHaveLength(0);
  });
  it("converge/explore/inspect 只读", async () => {
    const provider = new MockProvider({
      responses: [
        { text: JSON.stringify({ retained_source_keys: ["a"] }) },
        { text: JSON.stringify({ targets: [{ title: "缺口" }] }) },
        { text: JSON.stringify({ findings: [{ note: "x" }] }) },
      ],
    });
    expect((await worldConverge(provider, "ctx")).ok).toBe(true);
    expect((await worldExplore(provider, "ctx")).ok).toBe(true);
    expect((await worldInspect(provider, "ctx")).ok).toBe(true);
  });
  it("显式 canonical 来源进入模型；provider 期间漂移则拒绝结果", async () => {
    const root = makeRoot();
    const source = join(root, "world", "objects", "harbor.md");
    writeFileSync(source, '---\nid: harbor\nname: 盐港\nkind: location\nstatus: canonical\n---\n北闸冬季开放。\n');
    const base = new MockProvider({ responses: [{ text: JSON.stringify({ reply: "已读" }) }] });
    const provider = {
      async complete(request: Parameters<MockProvider["complete"]>[0]) {
        const response = await base.complete(request);
        writeFileSync(source, `${readFileSync(source, "utf8")}外部变化\n`, "utf8");
        return response;
      },
    };
    await expect(worldChatSelected(provider, root, {
      instruction: "检查盐港设定",
      source_refs: ["world/objects/harbor.md"],
    })).rejects.toThrow(/调用期间漂移/);
    expect(base.calls[0].messages.at(-1)?.content).toContain("北闸冬季开放");
  });
  it("suggestEntity 落 pending(status=candidate, 不自动采用)", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ name: "林晚", summary: "家族背景", reveal_level: "hidden" }) }],
    });
    const r = await suggestEntity(provider, root, "补林晚设定");
    expect(r.ok).toBe(true);
    const pending = listPending(root);
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("candidate");
    expect(listObjects(root)).toHaveLength(0);
  });
  it("suggestEntity 死路修复: 确定性 id/kind, LLM 输出被忽略, 候选可经 store adopt 采用", async () => {
    const root = makeRoot();
    // LLM 恶意输出 id/status(LLM schema 禁 id/status 且无 entity type): 一律被代码覆写。
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({ name: "林晚", summary: "家族背景", id: "llm-wants-id", status: "canonical" }),
      }],
    });
    const r = await suggestEntity(provider, root, "补林晚设定");
    expect(r.ok).toBe(true);
    const slug = r.slug!;
    const file = join(root, "world", "pending", slug + ".md");
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    // 确定性补全: id=slug、kind='object'; status 语义不变(candidate 待审批)。
    expect(data.id).toBe(slug);
    expect(data.kind).toBe("object");
    expect(data.status).toBe("candidate");
    expect(validateFrontmatter("object", data)).toEqual([]); // 落盘即可被 adopt 采用
    // confirmSuggestion 不接受 candidate(建议裁决只对 pending 态, 语义不变)。
    await expect(confirmSuggestion(root, slug)).rejects.toThrowError(
      expect.objectContaining({ code: "ILLEGAL_TRANSITION" }),
    );
    // 全链: store adopt(object) candidate → canonical, 移入 world/objects。
    const res = await adopt(root, "object", slug);
    expect(res.toStatus).toBe("canonical");
    expect(res.targetRelPath).toBe(`world/objects/${slug}.md`);
    const adopted = parseFrontmatter(readFileSync(join(root, "world", "objects", slug + ".md"), "utf8")).data;
    expect(adopted.status).toBe("canonical");
    expect(adopted.id).toBe(slug);
  });
  it("suggestBiblePage 落 bible/ draft(发布走世界书流程)", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          title: "家族背景", page_type: "family", overview: "o",
          sections: [{ title: "起源", body_markdown: "正文" }],
        }),
      }],
    });
    const r = await suggestBiblePage(provider, root, "补设定", { isNewPage: true });
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, "bible", r.slug + ".md"))).toBe(true);
    expect(readFileSync(join(root, "bible", r.slug + ".md"), "utf8")).toContain("status: draft");
  });
  it("suggestBiblePage 确定性补 id/page_key/version_number; LLM 输出被覆写; 过 bible_page schema", async () => {
    const root = makeRoot();
    // LLM 恶意输出 id/page_key/version_number: 必须被确定性代码覆写。
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          title: "家族背景", page_type: "family", overview: "o",
          sections: [{ title: "起源", body_markdown: "正文" }],
          id: "llm-page-id", page_key: "llm-key", version_number: 999,
        }),
      }],
    });
    const r = await suggestBiblePage(provider, root, "补设定", { isNewPage: true });
    expect(r.ok).toBe(true);
    const { data } = parseFrontmatter(readFileSync(join(root, "bible", r.slug + ".md"), "utf8"));
    expect(data.id).toBe(r.slug);
    expect(data.page_key).toBe(r.slug);
    expect(data.version_number).toBe(0);
    expect(data.status).toBe("draft");
    expect(validateFrontmatter("bible_page", data)).toEqual([]); // 写前校验保证必填齐备
  });
  it("suggestBiblePage 缺 page_type → schema_violation, fail-closed 不落盘", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({ title: "家族背景", sections: [{ title: "起源", body_markdown: "正文" }] }),
      }],
    });
    const r = await suggestBiblePage(provider, root, "补设定", { isNewPage: true });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("schema_violation");
    expect(existsSync(join(root, "bible", r.slug + ".md"))).toBe(false); // 无残留
  });
  it("suggestEntity 写目标冲突 fail-closed: 同名候选已存在 → 拒绝覆盖, 无新 commit", async () => {
    const root = makeRoot();
    const mk = () => new MockProvider({ responses: [{ text: JSON.stringify({ name: "林晚", summary: "第一次" }) }] });
    const r1 = await suggestEntity(mk(), root, "补设定");
    expect(r1.ok).toBe(true);
    const file = join(root, "world", "pending", r1.slug + ".md");
    const before = readFileSync(file, "utf8");
    const commitsBefore = gitLogSubjects(root).length;
    // 同名再次建议(同 slug): 已存在 → fail-closed 抛出, 不覆盖、不 commit。
    await expect(suggestEntity(mk(), root, "补设定")).rejects.toThrow(/候选已存在/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(gitLogSubjects(root).length).toBe(commitsBefore);
  });
  it.skipIf(!symlinksSupported())("suggestEntity 写目标 containment: 同名 pending symlink 指向 vault 外 → fail-closed, 外部不受写", async () => {
    const root = makeRoot();
    const mk = () => new MockProvider({ responses: [{ text: JSON.stringify({ name: "林晚", summary: "s" }) }] });
    const r1 = await suggestEntity(mk(), root, "补设定");
    expect(r1.ok).toBe(true);
    const file = join(root, "world", "pending", r1.slug + ".md");
    const outside = join(tmpdir(), `ncwd-outside-${Date.now()}.md`);
    writeFileSync(outside, "外部哨兵, 不得被改写"); // 有效 symlink 目标(写面会跟随到此处)。
    rmSync(file);
    symlinkSync(outside, file); // 同名 symlink → vault 外。
    await expect(suggestEntity(mk(), root, "补设定")).rejects.toThrow(/escapes vault root/);
    expect(readFileSync(outside, "utf8")).toBe("外部哨兵, 不得被改写"); // 外部未被 writeFileSync 跟随写入。
    rmSync(outside, { force: true });
  });
  it("suggestBiblePage 写目标冲突 fail-closed: 同名页面已存在 → 拒绝覆盖, 无新 commit", async () => {
    const root = makeRoot();
    const mk = () => new MockProvider({
      responses: [{
        text: JSON.stringify({ title: "家族背景", page_type: "family", overview: "第一次", sections: [] }),
      }],
    });
    const r1 = await suggestBiblePage(mk(), root, "补设定", { isNewPage: true });
    expect(r1.ok).toBe(true);
    const file = join(root, "bible", r1.slug + ".md");
    const before = readFileSync(file, "utf8");
    const commitsBefore = gitLogSubjects(root).length;
    await expect(suggestBiblePage(mk(), root, "补设定", { isNewPage: true })).rejects.toThrow(/页面已存在/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(gitLogSubjects(root).length).toBe(commitsBefore);
  });
  it.skipIf(!symlinksSupported())("suggestBiblePage 写目标 containment: 同名 bible symlink 指向 vault 外 → fail-closed, 外部不受写", async () => {
    const root = makeRoot();
    const mk = () => new MockProvider({
      responses: [{
        text: JSON.stringify({ title: "家族背景", page_type: "family", overview: "o", sections: [] }),
      }],
    });
    const r1 = await suggestBiblePage(mk(), root, "补设定", { isNewPage: true });
    expect(r1.ok).toBe(true);
    const file = join(root, "bible", r1.slug + ".md");
    const outside = join(tmpdir(), `ncwd-outside-page-${Date.now()}.md`);
    writeFileSync(outside, "外部哨兵, 不得被改写"); // 有效 symlink 目标(写面会跟随到此处)。
    rmSync(file);
    symlinkSync(outside, file); // 同名 symlink → vault 外。
    await expect(suggestBiblePage(mk(), root, "补设定", { isNewPage: true })).rejects.toThrow(/escapes vault root/);
    expect(readFileSync(outside, "utf8")).toBe("外部哨兵, 不得被改写"); // 外部未被 writeFileSync 跟随写入。
    rmSync(outside, { force: true });
  });
});

/** HEAD 单次 commit 变更文件(原始字节, -z 不引号化; 断言精确提交内容用)。 */
function headChangedFiles(root: string): string[] {
  return execFileSync("git", ["show", "--format=", "--name-only", "-z", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((l) => l.length > 0);
}

// N32(业务写面禁用 git add -A)+ R17(只提交本操作范围): suggest 两处 gitAdd 收窄为
// 完整精确相对 POSIX pathspec, 含删除语义, 不捕获无关用户改动。
describe("suggest gitAdd 收窄(完整精确 pathspec, 绝不 -A)", () => {
  it("suggestEntity: HEAD 只含本次落盘候选文件, 无关用户改动(改 book.yml + 杂散未跟踪)不被捕获", async () => {
    const root = makeRoot();
    // 无关用户改动: 已跟踪 book.yml 的手工修改 + 未跟踪杂散文件(旧形态 gitAdd -A 都会扫入)。
    const bookYml = join(root, "book.yml");
    writeFileSync(bookYml, readFileSync(bookYml, "utf8") + "# 用户手工编辑\n", "utf8");
    writeFileSync(join(root, "scenes", "scratch.md"), "用户杂散\n", "utf8");
    const provider = new MockProvider({
      responses: [{ text: JSON.stringify({ name: "林晚", summary: "s" }) }],
    });
    const r = await suggestEntity(provider, root, "补设定");
    expect(r.ok).toBe(true);
    expect(headChangedFiles(root)).toEqual([`world/pending/${r.slug}.md`]);
    // 无关改动保持原状(未暂存修改 / 未跟踪), 未被 gitAdd 捕获。
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(status).toContain(" M book.yml");
    expect(status).toContain("?? scenes/scratch.md");
    expect(status).not.toContain("world/pending");
  });

  it("suggestBiblePage: HEAD 只含本次落盘页面提案文件, 无关用户改动不被捕获", async () => {
    const root = makeRoot();
    const bookYml = join(root, "book.yml");
    writeFileSync(bookYml, readFileSync(bookYml, "utf8") + "# 用户手工编辑\n", "utf8");
    writeFileSync(join(root, "scenes", "scratch.md"), "用户杂散\n", "utf8");
    const mk = () => new MockProvider({
      responses: [{ text: JSON.stringify({ title: "家族背景", page_type: "family", overview: "o", sections: [] }) }],
    });
    const r = await suggestBiblePage(mk(), root, "补设定", { isNewPage: true });
    expect(r.ok).toBe(true);
    expect(headChangedFiles(root)).toEqual([`bible/${r.slug}.md`]);
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(status).toContain(" M book.yml");
    expect(status).toContain("?? scenes/scratch.md");
    expect(status).not.toContain("bible");
  });

  it("slug 含 glob 字符 `[`:`:(literal)` pathspec 仍精确提交单一文件(不 glob, 不捕获无关文件)", async () => {
    const root = makeRoot();
    const mk = () => new MockProvider({
      responses: [{ text: JSON.stringify({ title: "家族[终极]", page_type: "family", overview: "o", sections: [] }) }],
    });
    const r = await suggestBiblePage(mk(), root, "补设定", { isNewPage: true });
    expect(r.ok).toBe(true);
    expect(r.slug).toBe("家族[终极]"); // slugify 保留 [](非路径非法字符), 必须 literal 匹配。
    expect(existsSync(join(root, "bible", r.slug + ".md"))).toBe(true);
    expect(headChangedFiles(root)).toEqual([`bible/${r.slug}.md`]);
  });

  it("gitAdd 精确 pathspec 含删除: 已跟踪候选删除经同款 gitAdd(root,[rel]) 入 commit(不依赖 -A)", async () => {
    const root = makeRoot();
    const rel = "world/pending/obj-删.md";
    writeFileSync(join(root, rel), "x", "utf8");
    gitAdd(root, [rel]);
    gitCommit(root, "setup");
    rmSync(join(root, rel));
    // git add <path> 对已删除的跟踪文件 = stage 删除(git docs: 无需 -A 即含删除)。
    gitAdd(root, [rel]);
    gitCommit(root, "delete");
    expect(headChangedFiles(root)).toEqual([rel]);
  });
});
