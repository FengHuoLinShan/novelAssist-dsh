// rag-bge 行为契约(M6 Track B, L2 嵌入后端; 测试零网络)。
// 全部用例经 pipelineFactory 注入假 pipeline —— 不触发动态 import('@huggingface/transformers'),
// 不下载/推理任何真实模型(AGENTS.md: vitest 测试零网络)。
// 断言引: D16 嵌入后端可插拔、R5 片段资产; 懒加载/错误前缀见 rag-bge src 头注释。
import { describe, expect, it, vi } from "vitest";
import { createBgeEmbeddingBackend } from "../src/index";

interface FakePipeline {
  (texts: string[], opts: { pooling: string; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
}

/** 假 pipeline: 记录调用, 返回 [text.length, 1, 0] 定维向量(与输入同序)。 */
function makeFakePipeline(calls: Array<{ texts: string[]; opts: unknown }>): FakePipeline {
  return async (texts, opts) => {
    calls.push({ texts, opts });
    return { tolist: () => texts.map((t) => [t.length, 1, 0]) };
  };
}

describe("createBgeEmbeddingBackend(pipelineFactory 注入)", () => {
  it("name 固定为 bge-small-zh-v1.5-q8(与索引 embedding_model 联动)", () => {
    const backend = createBgeEmbeddingBackend({
      pipelineFactory: async () => makeFakePipeline([]),
    });
    expect(backend.name).toBe("bge-small-zh-v1.5-q8");
  });

  it("懒加载: 首次 embed 才调 pipelineFactory, 之后缓存复用(只初始化一次)", async () => {
    const factory = vi.fn(async (_modelId: string, _opts: { quantized: boolean }) =>
      makeFakePipeline([]),
    );
    const backend = createBgeEmbeddingBackend({ pipelineFactory: factory });
    expect(factory).not.toHaveBeenCalled(); // 构造不触发加载(零顶层副作用)
    await backend.embed(["第一句"]);
    await backend.embed(["第二句", "第三句"]);
    await backend.embed([]);
    expect(factory).toHaveBeenCalledTimes(1); // 多轮 embed 复用同一 pipeline
    expect(factory).toHaveBeenCalledWith("Xenova/bge-small-zh-v1.5", { quantized: true });
  });

  it("pipelineFactory 收到 modelId 覆盖与 quantized=false 覆盖", async () => {
    const factory = vi.fn(async (_modelId: string, _opts: { quantized: boolean }) =>
      makeFakePipeline([]),
    );
    const backend = createBgeEmbeddingBackend({
      modelId: "Xenova/custom-model",
      quantized: false,
      pipelineFactory: factory,
    });
    await backend.embed(["句"]);
    expect(factory).toHaveBeenCalledWith("Xenova/custom-model", { quantized: false });
  });

  it("embed 顺序/维度透传: 向量与输入同序且定维(pooling mean + normalize true)", async () => {
    const calls: Array<{ texts: string[]; opts: unknown }> = [];
    const backend = createBgeEmbeddingBackend({ pipelineFactory: async () => makeFakePipeline(calls) });
    const texts = ["雨夜孤灯", "青锋剑", "林晚"];
    const vectors = await backend.embed(texts);
    expect(vectors).toEqual([
      [texts[0].length, 1, 0],
      [texts[1].length, 1, 0],
      [texts[2].length, 1, 0],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].texts).toEqual(texts);
    expect(calls[0].opts).toEqual({ pooling: "mean", normalize: true }); // 归一化+均值池化契约
  });

  it("空数组 → [] 且不触发加载", async () => {
    const factory = vi.fn(async () => makeFakePipeline([]));
    const backend = createBgeEmbeddingBackend({ pipelineFactory: factory });
    expect(await backend.embed([])).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("pipelineFactory 抛错 → bge_load_failed(供上层降级)", async () => {
    const backend = createBgeEmbeddingBackend({
      pipelineFactory: async () => {
        throw new Error("model fetch 404");
      },
    });
    await expect(backend.embed(["句"])).rejects.toThrow("bge_load_failed");
    // 加载失败不缓存: 下次 embed 重试仍为加载错误(前缀不变)
    await expect(backend.embed(["句"])).rejects.toThrow("bge_load_failed");
  });

  it("pipeline 调用抛错 → bge_embed_failed", async () => {
    const backend = createBgeEmbeddingBackend({
      pipelineFactory: async () =>
        (async () => {
          throw new Error("inference boom");
        }) as unknown as FakePipeline,
    });
    await expect(backend.embed(["句"])).rejects.toThrow("bge_embed_failed");
  });

  it("向量数量与输入不一致 → bge_embed_failed(防御)", async () => {
    const backend = createBgeEmbeddingBackend({
      pipelineFactory: async () =>
        (async (_texts: string[], _opts: unknown) => ({ tolist: () => [[0, 0, 0]] })) as unknown as FakePipeline,
    });
    await expect(backend.embed(["句一", "句二"])).rejects.toThrow("bge_embed_failed");
  });
});
