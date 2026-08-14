// Provider 接口实现: MockProvider(测试/验收用)。
// 真 DSH ctx.llm 适配器留挂载阶段(seam 契约, packages/novelcraft/README.md)。
import type { Provider, ProviderRequest, ProviderResponse } from "./types.js";

export interface MockResponse {
  /** 成功响应文本(与 throwError 二选一) */
  text?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** 返回前延迟毫秒(测超时) */
  delayMs?: number;
  /** 抛错(测重试分类) */
  throwError?: Error;
}

export interface MockProviderOptions {
  /** 响应队列: 按调用顺序弹出; 耗尽后报错(防静默吞调用) */
  responses: MockResponse[];
  /** 是否可重试错误(配合 throwError 分类) */
  retryable?: boolean;
}

export class MockProvider implements Provider {
  responses: MockResponse[];
  private retryable: boolean;
  calls: ProviderRequest[] = [];

  constructor(opts: MockProviderOptions) {
    this.responses = [...opts.responses];
    this.retryable = opts.retryable ?? true;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(req);
    const next = this.responses.shift();
    if (!next) {
      throw new Error("MockProvider 响应队列耗尽(测试应提供与调用次数一致的响应)");
    }
    if (next.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, next.delayMs);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    }
    if (next.throwError) {
      (next.throwError as Error & { retryable?: boolean }).retryable = this.retryable;
      throw next.throwError;
    }
    return { text: next.text ?? "", usage: next.usage ?? { inputTokens: 0, outputTokens: 0 } };
  }
}
