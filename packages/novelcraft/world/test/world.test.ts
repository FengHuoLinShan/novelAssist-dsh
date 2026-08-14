// world 行为契约(specs/assets/world.md + §19 映射)
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
import { StoreError, parseFrontmatter, validateFrontmatter } from "@novelcraft/store";
import { createObject, listObjects, listPending, listTags, readObject, suggestBiblePage, suggestEntity, updateObject, worldChat, worldConverge, worldExplore, worldInspect } from "../src/index";

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

describe("objects CRUD(薄封装)", () => {
  it("创建/读取/列表/标签派生(N13); 写面统一 kind(B1 裁定)", () => {
    const root = makeRoot();
    const slug = createObject(root, { name: "苏婉", entityType: "character", aliases: ["红衣女子"], tags: ["主角团"] });
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
  it("重名创建拒绝; 更新 tags", () => {
    const root = makeRoot();
    const slug = createObject(root, { name: "克莱恩", entityType: "character" });
    expect(() => createObject(root, { name: "克莱恩", entityType: "character" })).toThrow(/已存在/);
    updateObject(root, slug, { tags: ["主角"] });
    expect(readObject(root, slug).tags).toEqual(["主角"]);
  });
  it("createObject 落盘含 id 且过 object schema(N23/M7-C)", () => {
    const root = makeRoot();
    const slug = createObject(root, { name: "林晚", entityType: "character", aliases: ["晚娘"], tags: ["配角"] });
    const raw = readFileSync(join(root, "world", "objects", slug + ".md"), "utf8");
    expect(raw).toContain(`id: ${JSON.stringify(slug)}`); // N23: object required 含 id(frontmatter.ts:417)
    const { data } = parseFrontmatter(raw);
    expect(validateFrontmatter("object", data)).toEqual([]); // 合规写入不受影响
  });
  it("updateObject: 缺必填 id 的 legacy 对象 → VALIDATION_FAILED 且文件未被改写(N23/M7-C)", () => {
    const root = makeRoot();
    const file = join(root, "world", "objects", "obj-legacy.md");
    writeFileSync(file, ["---", 'name: "旧人"', 'kind: "character"', "status: canonical", "---", ""].join("\n"), "utf8");
    const before = readFileSync(file, "utf8");
    let err: unknown;
    try {
      updateObject(root, "obj-legacy", { tags: ["新标签"] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreError); // N23: 校验失败统一 StoreError(与 assertValidRelations 同构)
    expect((err as StoreError).code).toBe("VALIDATION_FAILED");
    // fail-closed: 校验发生在任何写入之前, 文件内容不变(无部分状态)
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("legacy 兼容: 只含 entity_type 的旧对象文件仍可读(B1 fallback)", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "world", "objects", "obj-legacy.md"),
      ["---", 'name: "旧人"', 'entity_type: "character"', "status: canonical", "---", ""].join("\n"),
      "utf8",
    );
    const obj = readObject(root, "obj-legacy");
    expect(obj.entity_type).toBe("character"); // kind 缺失 → entity_type fallback(B1)
  });
  it("relations: list 形态 → 结构化对象数组; legacy 字符串形态保留(N14)", () => {
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
  it("suggestBiblePage 落 bible/ draft(发布走世界书流程)", async () => {
    const root = makeRoot();
    const provider = new MockProvider({
      responses: [{
        text: JSON.stringify({
          title: "家族背景", overview: "o",
          sections: [{ title: "起源", body_markdown: "正文" }],
        }),
      }],
    });
    const r = await suggestBiblePage(provider, root, "补设定", { isNewPage: true });
    expect(r.ok).toBe(true);
    expect(existsSync(join(root, "bible", r.slug + ".md"))).toBe(true);
    expect(readFileSync(join(root, "bible", r.slug + ".md"), "utf8")).toContain("status: draft");
  });
});
