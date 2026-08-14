// world 行为契约(specs/assets/world.md + §19 映射)
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { MockProvider } from "@novelcraft/llm-step";
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
  it("创建/读取/列表/标签派生(N13)", () => {
    const root = makeRoot();
    const slug = createObject(root, { name: "苏婉", entityType: "character", aliases: ["红衣女子"], tags: ["主角团"] });
    const obj = readObject(root, slug);
    expect(obj.name).toBe("苏婉");
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
