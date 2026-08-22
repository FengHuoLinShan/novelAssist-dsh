// N36: optional BGE adapter loader seam.
// 默认源码 CI profile 显式移除 workspace adapter 链接且不构建 capability；单测通过该可注入 seam 覆盖不可加载降级与合法模块，
// 显式 BGE CI profile 另做真实 import 集成验证。
import type { EmbeddingBackend } from '@novelcraft/rag';

export interface OptionalBgeModule {
  createBgeEmbeddingBackend?: () => EmbeddingBackend;
}

const OPTIONAL_BGE_SPECIFIER = '@novelcraft/rag-bge';

export const optionalBgeLoader = {
  async load(): Promise<OptionalBgeModule> {
    return await import(OPTIONAL_BGE_SPECIFIER) as OptionalBgeModule;
  },
};
