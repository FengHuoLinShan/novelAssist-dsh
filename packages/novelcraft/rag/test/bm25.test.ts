// rankChunksBm25 行为契约(M6 Track A1, L0 BM25 粗排)。
import { describe, expect, it } from "vitest";
import { rankChunksBm25 } from "../src/index";

describe("rankChunksBm25(标准 BM25: k1=1.5, b=0.75)", () => {
  it("中文查询: 相关段排在噪声段前, 零得分段不返回", () => {
    const docs = [
      { text: "窗外下着雨, 气氛沉闷。", summary: undefined },
      { text: "诡秘之主在贝克兰德苏醒。", summary: undefined },
      { text: "今天天气不错, 适合散步。", summary: undefined },
      { text: "主角从梦中惊醒。", summary: undefined },
    ];
    const hits = rankChunksBm25(docs, "诡秘", 8);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain("诡秘之主");
  });

  it("词频更高/更相关的段排最前", () => {
    const docs = [
      { text: "诡秘教会。", summary: undefined },
      { text: "路人甲在河边钓鱼。", summary: undefined },
      { text: "诡秘之主与诡秘教会。", summary: undefined },
    ];
    const hits = rankChunksBm25(docs, "诡秘", 8);
    expect(hits.length).toBe(2); // 噪声段零得分被过滤。
    expect(hits[0].text).toBe("诡秘之主与诡秘教会。");
  });

  it("topK 截断(默认 8; 显式 topK 生效)", () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({
      text: `包含关键词的第${i + 1}段。`,
    }));
    expect(rankChunksBm25(docs, "关键词", 2).length).toBe(2);
    expect(rankChunksBm25(docs, "关键词").length).toBe(5); // 默认 8, 全量 5 都命中。
  });

  it("空查询 / 空白查询 / 空 chunks 返回 []", () => {
    const docs = [{ text: "关键词出现。" }];
    expect(rankChunksBm25(docs, "")).toEqual([]);
    expect(rankChunksBm25(docs, "   ")).toEqual([]);
    expect(rankChunksBm25([], "关键词")).toEqual([]);
  });

  it("summary 命中额外 +0.5/词 加分: 正文无词但 summary 命中可召回", () => {
    const docs = [
      { text: "一段平平无奇的白描。", summary: "诡秘之主" },
      { text: "另一段白描。", summary: undefined },
    ];
    const hits = rankChunksBm25(docs, "诡秘", 8);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain("平平无奇");
  });

  it("summary 加分可把带摘要的段提到纯正文命中段之前", () => {
    const docs = [
      { text: "诡秘教会。" }, // 正文命中 1 次。
      { text: "白描段。", summary: "诡秘诡秘诡秘" }, // 正文 0 次, summary 3 次 → 1.5 分。
    ];
    const hits = rankChunksBm25(docs, "诡秘", 8);
    expect(hits.length).toBe(2);
    expect(hits[0].text).toBe("白描段。");
  });

  it("纯确定性: 同分保持输入顺序(稳定排序)", () => {
    const docs = [
      { text: "甲段关键词。" },
      { text: "乙段关键词。" },
      { text: "丙段关键词。" },
    ];
    const hits = rankChunksBm25(docs, "关键词", 8);
    expect(hits.map((d) => d.text)).toEqual(["甲段关键词。", "乙段关键词。", "丙段关键词。"]);
  });
});
