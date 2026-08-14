// @novelcraft/rag-bge — L2 本地 BGE 嵌入后端(可选包, M6 Track B)。
// 基于 @huggingface/transformers.js 的 Xenova/bge-small-zh-v1.5(中文句子向量),
// 实现 @novelcraft/rag 的 EmbeddingBackend 接口(rag.ts: {readonly name; embed(texts)})。
// 全链可降级: 加载/推理失败抛带前缀错误(bge_load_failed / bge_embed_failed), 由上层
// (dsh/rag searchRag)catch 降级, 不阻塞主工具调用链。
// 关键纪律:
// - 懒加载: 首次 embed 才动态 import('@huggingface/transformers'), 之后缓存复用;
// - 零顶层副作用: 模块 import 不触发任何模型下载/推理(可选包语义 + 测试零网络依赖此点);
// - pipelineFactory 为测试注入缝, 生产路径不用。
import os from "node:os";
import path from "node:path";
import type { EmbeddingBackend } from "@novelcraft/rag";

export interface BgeBackendOptions {
  /** 模型 id(HF hub); 默认 'Xenova/bge-small-zh-v1.5'。 */
  modelId?: string;
  /** 模型缓存目录; 默认 (DSH_HOME ?? ~/.dsh)/novelcraft/models。 */
  cacheDir?: string;
  /**
   * 量化开关; 默认 true。transformers.js v4.2.0 实际 API 为加载选项 dtype
   * (无 quantized 键): true → 'q8', false → 'fp32'(已按实际类型核对)。
   */
  quantized?: boolean;
  /**
   * 测试注入缝: 替代「动态 import + env.cacheDir + pipeline 加载」整个加载步骤。
   * 契约: 返回的对象需可调用
   *   (texts: string[], opts: { pooling: 'mean'; normalize: true }) => Promise<{ tolist(): number[][] }>,
   * 即调用时返回一个 Promise, resolve 出的对象提供 tolist(): number[][], 且与输入同序。
   */
  pipelineFactory?: (modelId: string, opts: { quantized: boolean }) => Promise<unknown>;
}

/** transformers.js feature-extraction pipeline 的可调用形态(以安装后的实际类型核对为准)。 */
interface FeatureExtractionFn {
  (texts: string[], opts: { pooling: "mean"; normalize: true }): Promise<{
    tolist(): number[][];
  }>;
}

const DEFAULT_MODEL_ID = "Xenova/bge-small-zh-v1.5";
const BACKEND_NAME = "bge-small-zh-v1.5-q8";

export function createBgeEmbeddingBackend(opts?: BgeBackendOptions): EmbeddingBackend {
  const modelId = opts?.modelId ?? DEFAULT_MODEL_ID;
  const quantized = opts?.quantized ?? true;
  const cacheDir =
    opts?.cacheDir ??
    path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "novelcraft", "models");

  let pipelinePromise: Promise<FeatureExtractionFn> | undefined;

  const load = async (): Promise<FeatureExtractionFn> => {
    if (opts?.pipelineFactory !== undefined) {
      // 测试注入缝: 由调用方提供假 pipeline, 零网络。
      return (await opts.pipelineFactory(modelId, { quantized })) as FeatureExtractionFn;
    }
    const mod = await import("@huggingface/transformers");
    // env.cacheDir 是 transformers.js 的全局缓存目录(实际类型: env.d.ts cacheDir: string | null)。
    mod.env.cacheDir = cacheDir;
    // v4 加载选项已由 v3 的 quantized 改为 dtype(实际类型: PretrainedModelOptions.dtype):
    // quantized=true → 'q8', false → 'fp32'。
    return (await mod.pipeline("feature-extraction", modelId, {
      dtype: quantized ? "q8" : "fp32",
    })) as FeatureExtractionFn;
  };

  const ensurePipeline = (): Promise<FeatureExtractionFn> => {
    if (pipelinePromise === undefined) {
      pipelinePromise = load().catch((err) => {
        pipelinePromise = undefined; // 加载失败不缓存, 下次 embed 重试。
        throw new Error(`bge_load_failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return pipelinePromise;
  };

  return {
    name: BACKEND_NAME,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      let fn: FeatureExtractionFn;
      try {
        fn = await ensurePipeline();
      } catch (err) {
        throw err instanceof Error ? err : new Error(`bge_load_failed: ${String(err)}`);
      }
      try {
        const out = await fn(texts, { pooling: "mean", normalize: true });
        const vectors = typeof out.tolist === "function" ? out.tolist() : undefined;
        if (!Array.isArray(vectors) || vectors.length !== texts.length) {
          throw new Error("向量数量与输入不一致");
        }
        return vectors;
      } catch (err) {
        throw new Error(`bge_embed_failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
