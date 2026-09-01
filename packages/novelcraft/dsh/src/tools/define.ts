// @novelcraft/dsh · 领域工具定义包装器。
// 收敛每个工具重复的五段式骨架: args 类型(defineTool schema 推断, 不再手写接口+强转)、
// 工作区隔离(resolveBoundRoot, N34)、错误映射(toolError 单点)、共享 render、
// 变更后副作用(run.afterMutation, §11 三连扇出唯一入口)。
// 新工具只经本包装器定义: 结构上不可能绕过隔离/错误映射/副作用纪律。
// 注意: 本文件位于 src/tools/ 下, capabilities.test.ts 的源码扫描据此继续覆盖
// 「工具层对领域服务的访问只走 capabilities 与 vaults 两个命名空间」(N35)。
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { InferArgs, InferValue, ObjectValueSchemaSpec, ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import { afterMutation, type AfterMutationOptions } from '../radar-hooks.js';
import type { NovelCraftService } from '../service.js';
import { render, resolveBoundRoot, sessionIdOf, toolError } from './shared.js';

/** 包装器传给 execute 的运行上下文: 隔离已解析的绑定 root + 受控副作用入口。 */
export interface NovelcraftToolRun {
  /** 宿主 Context(副作用推送面; 不用于直接服务读取, 服务访问走 service)。 */
  readonly ctx: Context;
  /** 领域服务(capabilities 是唯一受 sanction 的调用面, N35)。 */
  readonly service: NovelCraftService;
  /** 原始 ToolRunContext(透传, 含 arguments/callId 等低频字段)。 */
  readonly exec: ToolRunContext;
  /** exec.agent 的窄化视图(审批门控入参)。 */
  readonly agent: Agent | undefined;
  /** exec.signal: 工具取消信号(内容手贯通, 与 llm-step timeout 合并)。 */
  readonly signal: AbortSignal | undefined;
  /** N34 隔离产出的绑定 vault 根(canonical; 一切读取/写入用它)。 */
  readonly root: string | undefined;
  /** 当前 agent session id(收据消费类工具用)。 */
  sessionId(): string;
  /** 变更后副作用唯一入口(雷达/推送/RAG; 尽力而为不外抛)。 */
  afterMutation(opts: AfterMutationOptions): Promise<void>;
}

/** 错误兜底: 静态 {code, message} 或按异常动态生成(如 ingest 的透传消息)。 */
export type ToolErrorFallback =
  | { code: string; message: string }
  | ((err: unknown) => { code: string; message: string });

export interface NovelcraftToolSpec<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  readonly name: string;
  readonly description: string;
  /** 逐属性参数 schema(defineTool 编译为隐式开放对象根; required 逐属性标注)。 */
  readonly parameters: S;
  /** 输出根 schema(封闭对象; 个别逃逸口如动态键 results 自行声明 additionalProperties)。 */
  readonly output: O;
  readonly timeoutMs?: number;
  /**
   * 绑定 root 解析方式: 'args'(缺省, 校验 args.root 与 session 绑定 canonical 一致) |
   * 'session'(llm_step: 无 root 参数, 直接取绑定根)。解析先于 execute 一切服务调用。
   */
  /**
   * 工作区 root 解析模式:
   * - 'args'(缺省): 从 args.root 经 resolveBoundRoot(与 session 绑定 canonical 对账);
   * - 'session': 无 root 参数, 直接取 session 绑定 root;
   * - 'none'(M11/N42): 不解析 root —— 「未绑定也可用」的入口(书库发现/创建/首绑),
   *   execute 自验 agent 存在; 未绑定会话不得在工厂层被拒(否则首绑死锁)。
   */
  readonly bindRoot?: 'args' | 'session' | 'none';
  /** toolError 兜底覆盖(缺省 NOVELCRAFT_TOOL_ERROR)。 */
  readonly errorFallback?: ToolErrorFallback;
  execute(args: InferArgs<S>, run: NovelcraftToolRun): Promise<InferValue<O>>;
}

/**
 * 创建工具工厂(ctx/service 在 build 阶段固定, 39 个工具共享)。
 * 工厂产出的定义与手写 defineTool 完全同形: rc.8 参数校验、封闭输出校验、
 * render 均由 defineTool 原生承担; 本包装器只加隔离/错误映射/副作用纪律。
 */
export function novelcraftToolFactory(ctx: Context, service: NovelCraftService) {
  return function defineNovelcraftTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec & ObjectValueSchemaSpec>(
    spec: NovelcraftToolSpec<S, O>,
  ): ToolDefinition {
    // 「execute 与 parameters/output schema 一致」的编译期检查由本工厂的
    // NovelcraftToolSpec<S,O> 泛型在各工具定义点完成(具体字面量, 推断廉价)。
    // 此处不能把泛型 S/O 直接对照 DefineToolOptions<S,O>: 两侧的 InferArgs/
    // InferValue 是 deferred 条件类型, 递归比较会触发 excessive stack depth,
    // 故经 unknown 一次擦除后交给 defineTool(纯编译期动作, 运行时对象不变,
    // rc.8 的参数/输出运行时校验不受影响)。
    const options = {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: {
        schema: spec.output,
        render,
      },
      ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
      async execute(rawArgs: unknown, exec: ToolRunContext) {
        try {
          const root = spec.bindRoot === 'none'
            ? undefined
            : spec.bindRoot === 'session'
              ? await resolveBoundRoot(service, exec)
              : await resolveBoundRoot(service, exec, (rawArgs as { root?: string }).root);
          const run: NovelcraftToolRun = {
            ctx,
            service,
            exec,
            agent: exec.agent,
            signal: exec.signal,
            root,
            sessionId: () => sessionIdOf(exec),
            afterMutation: (opts) => afterMutation(ctx, root, opts), // none 模式 root=undefined: book 组无 afterMutation
          };
          return await spec.execute(rawArgs as InferArgs<S>, run);
        } catch (err) {
          if (typeof spec.errorFallback === 'function') {
            throw toolError(err, spec.errorFallback(err));
          }
          throw toolError(err, spec.errorFallback);
        }
      },
    };
    return defineTool(options as unknown as {
      name: string;
      description: string;
      parameters: ParameterSchemaSpec;
      output: { schema: ValueSchemaSpec; render: typeof render };
      timeoutMs?: number;
      execute: (args: never, exec: ToolRunContext) => Promise<never>;
    });
  };
}
