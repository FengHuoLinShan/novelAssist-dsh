// tokenizeRagText 行为契约(M6 Track A1, L0 确定性分词)。
import { describe, expect, it } from "vitest";
import { tokenizeRagText } from "../src/index";

describe("tokenizeRagText(CJK 单字 + 相邻 bigram; 拉丁/数字整词小写)", () => {
  it("CJK 单字保留且相邻 CJK 字产出 bigram(两字词不丢召回)", () => {
    expect(tokenizeRagText("主角")).toEqual(["主", "角", "主角"]);
    // 输出顺序: 逐字推进, 单字后紧跟其与前一字的 bigram(确定性)。
    expect(tokenizeRagText("诡秘之主")).toEqual([
      "诡", "秘", "诡秘",
      "之", "秘之",
      "主", "之主",
    ]);
  });

  it("拉丁字母/数字串小写化整词输出, 打断 CJK bigram 链", () => {
    expect(tokenizeRagText("Chapter 3")).toEqual(["chapter", "3"]);
    expect(tokenizeRagText("ABCdef")).toEqual(["abcdef"]);
    // 数字夹在 CJK 之间: 不产出跨数字的 bigram。
    expect(tokenizeRagText("第3章 诡秘之主")).toEqual([
      "第", "3", "章",
      "诡", "秘", "诡秘",
      "之", "秘之",
      "主", "之主",
    ]);
  });

  it("中英混排: 英文整词 + CJK 单字/bigram 并存", () => {
    expect(tokenizeRagText("Bekland 诡秘")).toEqual(["bekland", "诡", "秘", "诡秘"]);
  });

  it("标点/空白是分隔符, 不产出词且断开 bigram", () => {
    expect(tokenizeRagText("诡秘,秘之")).toEqual(["诡", "秘", "诡秘", "秘", "之", "秘之"]);
    // 逗号断开: 无跨标点的 bigram(第二个 秘 与 之 相邻才组成 秘之)。
    expect(tokenizeRagText("诡秘,秘之")).not.toContain("秘秘");
  });

  it("空串 / 全标点 / 纯空白 返回 []", () => {
    expect(tokenizeRagText("")).toEqual([]);
    expect(tokenizeRagText("，。！？…—·")).toEqual([]);
    expect(tokenizeRagText("   \n\t  ")).toEqual([]);
  });

  it("纯确定性: 同输入恒同输出", () => {
    const a = tokenizeRagText("诡秘之主降临第 1 章");
    const b = tokenizeRagText("诡秘之主降临第 1 章");
    expect(a).toEqual(b);
  });
});
