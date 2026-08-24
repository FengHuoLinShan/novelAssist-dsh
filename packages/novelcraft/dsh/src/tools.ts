// @novelcraft/dsh · agent 工具注册(ctx.tools seam)。
// §22.3/§12: 原语工具面同名映射为「文件背书插件工具」; 采用类写操作经
// ApprovalGate(fail-closed), 读操作直通。工具名统一 novelcraft_ 前缀。
// 取消贯通: 五个内容手工具(llm_step/deep_import/propose/generate/map_atlas_plan)
// 把 exec.signal 传 service(service 层 withAbortSignal 与 llm-step timeout 合并)。
// tools 服务缺失时静默跳过注册(最小 profile/纯进程内测试仍可用服务门面)。
// 工具内部把 args 收窄到本地接口; 成功输出用 closed schema 锁定完整合同。
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { realpathSync } from 'node:fs';
import * as assistant from '@novelcraft/assistant';
import * as store from '@novelcraft/store';
import * as writing from '@novelcraft/writing';
import type { AdoptableKind } from '@novelcraft/store';
import { GateDeniedError, GateRequiredError } from './approval/gate.js';
import { svc } from './ctx.js';
import { DeepImportDeniedError, importTraceFile } from './deep-import.js';
import { EVENT_RADAR_MAP, fireRadarHooks } from './radar-hooks.js';
import { fireRagHook } from './rag-hooks.js';
import type { NovelCraftService } from './service.js';
import { pushSignalsChanged } from './push.js';

/** tools 服务缺省时的空注册(返回空 disposer 列表)。 */
export function registerNovelcraftTools(ctx: Context, service: NovelCraftService): Array<() => void> {
  const registry = svc<{ register(definition: ToolDefinition): () => void }>(ctx, 'tools');
  if (!registry || typeof registry.register !== 'function') return [];

  const disposers: Array<() => void> = [];
  try {
    for (const tool of buildTools(ctx, service)) {
      disposers.push(registry.register(tool));
    }
    return disposers;
  } catch (error) {
    // Registration is all-or-nothing. If the k-th tool fails, the caller never receives the prior
    // disposers, so this function must roll them back before rethrowing.
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* preserve the registration failure */ }
    }
    throw error;
  }
}

const render = (_args: unknown, value: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(value) },
];

function reviewFindingCards(findings: readonly writing.ReviewFinding[]): Array<Record<string, string>> {
  return findings.map((finding) => ({
    finding_id: finding.finding_id,
    category: finding.category,
    severity: finding.severity,
    quote: finding.quote,
    suggestion: finding.suggestion,
  }));
}

/** DSH seam 唯一错误映射: 失败必须进入宿主 HarnessError/isError 通道。 */
function toolError(
  err: unknown,
  fallback: { code: string; message: string } = {
    code: 'NOVELCRAFT_TOOL_ERROR',
    message: 'NovelCraft 工具执行失败, 已停止后续动作',
  },
): HarnessError {
  if (err instanceof HarnessError) return err;
  if (err instanceof WorkspaceIsolationError) {
    return new HarnessError(err.message, 'WORKSPACE_ISOLATION', { cause: err });
  }
  if (err instanceof GateDeniedError || err instanceof DeepImportDeniedError) {
    return new HarnessError(err.message, `APPROVAL_${err.decision.toUpperCase().replace('-', '_')}`, { cause: err });
  }
  if (err instanceof GateRequiredError) {
    return new HarnessError(err.message, 'APPROVAL_REQUIRED', { cause: err });
  }
  if (err instanceof store.StoreError) {
    return new HarnessError(`store: ${err.message}`, `STORE_${err.code}`, { cause: err });
  }
  if (err instanceof writing.TextIntakeError) {
    return new HarnessError(err.message, `INTAKE_${err.code}`, { cause: err });
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new HarnessError('工具执行已取消', 'ABORTED', { cause: err });
  }
  return new HarnessError(fallback.message, fallback.code, { cause: err });
}

const LLM_ERROR_CODES: Record<string, string> = {
  spec_not_found: 'LLM_SPEC_NOT_FOUND',
  budget_exceeded: 'LLM_BUDGET_EXCEEDED',
  timeout: 'LLM_TIMEOUT',
  schema_violation: 'LLM_SCHEMA_VIOLATION',
  provider_retryable: 'LLM_PROVIDER_RETRYABLE',
  provider_fatal: 'LLM_PROVIDER_FATAL',
};

function llmError(kind: string | undefined, message: string | undefined): HarnessError {
  return new HarnessError(message || '模型步骤失败', LLM_ERROR_CODES[kind ?? ''] ?? 'LLM_FAILED');
}

/**
 * N34 工作区隔离错误(统一 fail-closed 拒绝; 由 toolError 映射宿主失败通道)。
 * 由 resolveBoundRoot 抛出: 无 session / 未绑定 / root 与绑定不一致。
 */
export class WorkspaceIsolationError extends Error {
  constructor(reason: string) {
    super(`工作区隔离失败: ${reason}`);
    this.name = 'WorkspaceIsolationError';
  }
}

function sessionIdOf(exec: { agent?: unknown }): string {
  const sessionId = (exec.agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new WorkspaceIsolationError('无 agent session id, 拒绝访问任意 vault');
  }
  return sessionId;
}

/**
 * 统一工具 root/binding 解析(N34 工作区隔离; 独立审查确认问题修复):
 * - 所有带 root 或会访问 vault 的 agent 工具都必须经本 helper 从
 *   `exec.agent.session.id` 解析会话绑定(内存优先, 回查 domain 只读缓存);
 * - 无 agent session / 未绑定 → 抛 WorkspaceIsolationError(fail-closed),
 *   零服务调用、零 fs 访问;
 * - 工具保留 root 参数时: 其 canonical(realpath)必须与绑定 root **完全一致**
 *   (realpath 逐字节相等), 否则拒绝——绝不信任任意 root、绝不以参数 root 访问
 *   绑定外的任何目录。指向**别的** vault 的路径别名/symlink 一律拒绝; 指向同一
 *   canonical vault 的别名(realpath 相等)放行, 但工具始终只用本 helper 返回的
 *   绑定 root 执行, 与参数原值无关;
 * - 只读工具同规则隔离(读面同样只从绑定 root 访问)。
 * @returns 绑定 root(canonical), 供 service 调用与事件钩子(fireRadarHooks/
 *   fireRagHook)统一使用。
 */
async function resolveBoundRoot(
  service: NovelCraftService,
  exec: { agent?: unknown },
  requested?: unknown,
): Promise<string> {
  const sessionId = sessionIdOf(exec);
  const binding = await service.vaults.resolve(sessionId);
  if (!binding) {
    throw new WorkspaceIsolationError(`session ${sessionId} 未绑定 vault, 拒绝`);
  }
  const boundRoot = binding.root;
  if (requested !== undefined) {
    if (typeof requested !== 'string') {
      throw new WorkspaceIsolationError(`root 参数必须是字符串, got ${typeof requested}`);
    }
    let realBound: string;
    let realRequested: string;
    try {
      realBound = realpathSync(boundRoot);
      realRequested = realpathSync(requested);
    } catch (err) {
      throw new WorkspaceIsolationError(`无法解析 root 真实路径: ${(err as Error).message}`);
    }
    if (realBound !== realRequested) {
      throw new WorkspaceIsolationError(
        `root(${requested}) 与 session 绑定 vault(${boundRoot}) 的 canonical 根不一致, 拒绝跨工作区访问`,
      );
    }
  }
  return boundRoot;
}

const ADOPTABLE_KINDS = [
  'object',
  'scene',
  'chapter_candidate',
  'bible_page',
  'thread',
  'arc',
  'foreshadowing',
  'reveal',
] as const;

const INBOX_ACTIONS = ['accept', 'reject', 'modify', 'defer'] as const;

const RADARS = ['ingest', 'dedup', 'suggest', 'plot', 'risk', 'writing'] as const;

/** 每个工具的具体参数形状(defineTool 的 args 为宽泛 JsonValue, 在此收窄)。 */
interface LlmStepArgs {
  spec: string;
  input: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
  fix_attempts?: number;
}
interface RootArgs {
  root: string;
}
interface AdoptArgs extends RootArgs {
  kind: string;
  ref: string;
  expected_content_hash?: string;
  adopted_by?: string;
  note?: string;
}
interface InboxViewArgs extends RootArgs {
  content_hash?: string;
}
interface InboxActArgs extends RootArgs {
  signal_id: string;
  action: string;
  reason?: string;
  modified_title?: string;
  modified_proposed_action?: string;
}
interface DeepImportArgs extends RootArgs {
  start_chapter: number;
  end_chapter: number;
}
interface ProposeNextChapterArgs extends RootArgs {
  chapter: number;
}
interface GenerateNextChapterArgs extends RootArgs {
  chapter: number;
  proposal_title: string;
  premise?: string;
}
interface IngestFileArgs extends RootArgs {
  receipt_id: string;
  start_chapter?: number;
  force?: boolean;
}
interface ChapterVersionArgs extends RootArgs {
  action: string;
  chapter: number;
  receipt_id?: string;
  commit?: string;
  compare_commit?: string;
  expected_content_hash?: string;
}
interface ChapterReviewArgs extends RootArgs {
  action: string;
  target: string;
  chapter: number;
  ref?: string;
  review_id?: string;
  finding_id?: string;
  finding_ids?: string[];
  reason?: string;
  expected_content_hash?: string;
}
interface RadarSweepArgs extends RootArgs {
  radar?: string;
}
interface RagSearchArgs extends RootArgs {
  query: string;
  top_k?: number;
  rerank?: boolean;
}
// ---- map-atlas 工具参数(Phase 5; 计划 §4 Phase 5) ----
interface MapAtlasPlanArgs extends RootArgs {
  style_note?: string;
  include_working_drafts?: boolean;
  include_interiors?: boolean;
  full_rebuild?: boolean;
}
interface MapAtlasViewArgs extends RootArgs {
  run_id?: string;
}
interface MapAtlasUploadArgs extends RootArgs {
  receipt_id: string;
}
interface MapAtlasReviewArgs extends RootArgs {
  page_ref?: string;
  node_ref?: string;
  action: string;
  confirm_conflicts?: boolean;
  expected_content_hash?: string;
  note?: string;
}
interface MapAtlasUpdatePromptArgs extends RootArgs {
  page_ref: string;
  prompt: string;
  expected_content_hash?: string;
}

function buildTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  return [
    // ---- 1. llm_step(内容手原语, §12) ----
    defineTool({
      name: 'novelcraft_llm_step',
      description:
        '内容手一步调用: 按 specRef 运行一次受控 LLM 步骤(schema 校验/预算/超时/journal)。' +
        'specRef 见 NovelCraft prompt 目录; 输入为步骤要求的内容文本。',
      parameters: {
        spec: { type: 'string', required: true, description: '步骤 specRef(如 semantic_review / world_ask)' },
        input: { type: 'string', required: true, description: '步骤输入内容(原文/上下文)' },
        model: { type: 'string', description: '覆盖模型 id(默认取 profile 配置)' },
        temperature: { type: 'number', description: '覆盖温度' },
        max_tokens: { type: 'integer', description: '覆盖输出预算' },
        timeout_ms: { type: 'integer', description: '覆盖超时毫秒' },
        fix_attempts: { type: 'integer', description: 'schema 违例修复重试次数(默认 1)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          input_tokens: { type: 'integer', required: true },
          output_tokens: { type: 'integer', required: true },
          error: { type: 'string', required: true },
          },
        },
        render,
      },
      timeoutMs: 300_000,
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as LlmStepArgs;
        // N34 工作区隔离: llm_step 会访问绑定 vault 的该书 profile/llm.yml(N20),
        // 统一经 resolveBoundRoot 从 exec.agent.session.id 解析绑定; 无 session/
        // 未绑定 → fail-closed, 不退回「仅 Config.llm 默认」的任意 root 访问。
        let boundRoot: string;
        try {
          boundRoot = await resolveBoundRoot(service, exec);
        } catch (err) {
          throw toolError(err);
        }
        // exec.signal(工具取消)贯通: runStep 层与 llm-step timeout 合并(withAbortSignal)。
        const result = await service.capabilities.propose.runStep({
          specRef: args.spec,
          input: args.input,
          overrides: {
            ...(args.model ? { model: args.model } : {}),
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            ...(args.max_tokens !== undefined ? { maxTokens: args.max_tokens } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
          },
          fixAttempts: args.fix_attempts ?? 1,
        }, boundRoot, exec.signal);
        if (!result.ok) throw llmError(result.error?.kind, result.error?.message);
        const text = result.result && typeof result.result === 'object'
          ? JSON.stringify(result.result)
          : String(result.result ?? '');
        return {
          ok: true,
          text: text.slice(0, 8000),
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          error: result.error ? `${result.error.kind}: ${result.error.message}` : '',
        };
      },
    }),

    // ---- 2. 索引重建(只读) ----
    defineTool({
      name: 'novelcraft_store_index',
      description: '重建全书派生索引(对象/别名/关系/Scene/章节/结构), 并写入可选缓存。文件是唯一真相, 可随时重建。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          objects: { type: 'integer', required: true },
          aliases: { type: 'integer', required: true },
          relations: { type: 'integer', required: true },
          scenes: { type: 'integer', required: true },
          chapters: { type: 'integer', required: true },
          structure: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const { root: requestedRoot } = rawArgs as unknown as RootArgs;
        try {
          // N34: 只读工具同样隔离——root 必须与 session 绑定完全一致(canonical)。
          const root = await resolveBoundRoot(service, exec, requestedRoot);
          const index = service.capabilities.propose.refreshIndex(root);
          return {
            ok: true,
            objects: index.objects.length,
            aliases: index.aliases.length,
            relations: index.relations.length,
            scenes: index.scenes.length,
            chapters: index.chapters.length,
            structure: index.structure.length,
            message: `派生索引已重建(${index.objects.length} 对象/` +
              `${index.aliases.length} 别名/` +
              `${index.relations.length} 关系)`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 3. 采用(审批门控写, §9) ----
    defineTool({
      name: 'novelcraft_store_adopt',
      description:
        '采用一个待处理/候选资产(copy-on-adopt 或状态迁移 + git commit)。' +
        '写操作必经用户审批(fail-closed); 审批未放行时进入宿主工具失败通道。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        kind: { type: 'string', required: true, enum: [...ADOPTABLE_KINDS] },
        ref: { type: 'string', required: true, description: '源文件 slug 或相对路径(如 pend_red 或 world/pending/xxx.md)' },
        expected_content_hash: { type: 'string', description: 'CAS 期望哈希(失配拒绝)' },
        adopted_by: { type: 'string', description: '采用来源记录' },
        note: { type: 'string', description: '一句话审批说明(作者语言)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          commit: { type: 'string', required: true },
          target_rel_path: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as AdoptArgs;
        const agent = exec.agent as Agent | undefined;
        try {
          // N34: root 必须与 session 绑定 canonical 完全一致; 后续 service/钩子
          // 一律用返回的绑定 root(解析在一切服务调用/文件访问之前 → 零影响 B)。
          const root = await resolveBoundRoot(service, exec, args.root);
          const result = await service.capabilities.adoptGuarded.storeAdopt(
            agent,
            root,
            args.kind as AdoptableKind,
            args.ref,
            {
              ...(args.expected_content_hash ? { expectedContentHash: args.expected_content_hash } : {}),
              ...(args.adopted_by ? { adoptedBy: args.adopted_by } : {}),
            },
            args.note,
          );
          // 事件触发雷达(§11): adopt 后去重+风险对账; 章候选采用另加写作面。
          fireRadarHooks(
            ctx,
            root,
            args.kind === 'chapter_candidate'
              ? [...EVENT_RADAR_MAP.adopt, ...EVENT_RADAR_MAP.adoptChapterCandidate]
              : EVENT_RADAR_MAP.adopt,
          );
          // 事件触发 RAG 索引(§11): adopt(含章候选分支)后只同步词法派生索引;
          // 向量写入由显式 novelcraft_rag_embed 独占。
          fireRagHook(ctx, root);
          return {
            ok: true,
            commit: result.commit,
            target_rel_path: result.targetRelPath,
            message: `已采用 ${result.kind} → ${result.toStatus}(commit ${result.commit.slice(0, 12)})`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 4. 收件箱视图(只读) ----
    defineTool({
      name: 'novelcraft_inbox_view',
      description: '读收件箱: 全部新鲜信号(风险前置排序)。卡片含 id/radar/severity/title/proposed_action/status。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        content_hash: { type: 'string', description: '当前正文哈希(判断写作/审查类信号是否过期)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          signals: { type: 'array', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as InboxViewArgs;
        try {
          // N34: 只读工具同样隔离(绑定 root 校验在一切读取之前 → 零读 B)。
          const root = await resolveBoundRoot(service, exec, args.root);
          const signals = service.capabilities.read.inbox(root, args.content_hash);
          return {
            ok: true,
            signals: signals.map((s) => ({
              id: s.id,
              radar: s.radar,
              severity: s.severity,
              title: s.title,
              proposed_action: s.proposed_action,
              status: s.status,
              observed_at: s.observed_at,
            })),
            message: `收件箱 ${signals.length} 条新鲜信号`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 5. 收件箱四动词(记录决定; 资产写入另走采用/微工作流工具) ----
    defineTool({
      name: 'novelcraft_inbox_act',
      description:
        '收件箱四动词: accept 采纳(返回 adopt 指引)/ reject 打回(理由进校准)/ modify 改一改(路由微工作流)/ defer 先放着。' +
        'reject/modify 必须带 reason。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        signal_id: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: [...INBOX_ACTIONS] },
        reason: { type: 'string', description: '打回/改一改的理由(校准原料)' },
        modified_title: { type: 'string', description: 'modify: 修改后的标题' },
        modified_proposed_action: { type: 'string', description: 'modify: 修改后的建议动作' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          microflow: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as InboxActArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const descriptor = assistant.act(root, {
            signalId: args.signal_id,
            action: args.action as assistant.InboxAction,
            ...(args.reason ? { reason: args.reason } : {}),
            ...(args.action === 'modify'
              ? {
                  modified: {
                    ...(args.modified_title ? { title: args.modified_title } : {}),
                    ...(args.modified_proposed_action
                      ? { proposed_action: args.modified_proposed_action }
                      : {}),
                  },
                }
              : {}),
          });
          const guide =
            descriptor.kind === 'adopt'
              ? '采纳动作: 请按信号目标调用 novelcraft_store_adopt 完成资产采用。'
              : descriptor.kind === 'microflow'
                ? `已路由微工作流「${descriptor.microflow ?? ''}」: 请按其阶段调用对应工具执行。`
                : '已记录决定(校准笔记已更新)。';
          pushSignalsChanged(ctx, { root });
          return {
            ok: true,
            action: descriptor.action,
            kind: descriptor.kind,
            microflow: descriptor.microflow ?? '',
            message: guide,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 6. 深度导入(范围授权 + adopt/2b 独立审批门; trace 落 .assistant/import-trace.jsonl) ----
    defineTool({
      name: 'novelcraft_deep_import',
      description:
        '深度导入: 执行前先请求范围授权(授权将调用 LLM 并产出候选; 拒绝则零副作用, fail-closed); ' +
        '放行后按章节范围顺序跑六阶段(切分/补全/融合/Scene 采用/实体/别名关系/结构)。' +
        'Scene 采用与 2b 别名/关系写入分别过独立审批(fail-closed); 全程 trace 事件落 .assistant/import-trace.jsonl。' +
        '多章为长任务, 建议由编排层分批触发; 本工具同步执行并返回摘要。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        start_chapter: { type: 'integer', required: true, description: '起始章节(1 起)' },
        end_chapter: { type: 'integer', required: true, description: '结束章节(含)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          workflow_id: { type: 'string', required: true },
          adopted: { type: 'integer', required: true },
          committed: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          conflicts: { type: 'integer', required: true },
          rejected: { type: 'boolean', required: true },
          trace_file: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      timeoutMs: 3_600_000,
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as DeepImportArgs;
        const agent = exec.agent as Agent | undefined;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const result = await service.capabilities.adoptGuarded.deepImport(agent, root, {
            startChapter: args.start_chapter,
            endChapter: args.end_chapter,
          }, exec.signal);
          if (result.rejected) {
            throw new HarnessError('深度导入的 Scene 采用未获批准, 候选保持未采用', 'APPROVAL_REJECTED');
          }
          // 事件触发雷达(§11): 导入后去重/风险/剧情/写作四面对账。
          fireRadarHooks(ctx, root, EVENT_RADAR_MAP.deepImport);
          // 事件触发 RAG 索引(§11): 导入后只同步词法派生索引;
          // 向量写入由显式 novelcraft_rag_embed 独占。
          fireRagHook(ctx, root);
          return {
            ok: true,
            workflow_id: result.workflow_id,
            adopted: result.adopted,
            committed: result.committed.length,
            skipped: result.skipped.length,
            conflicts: result.conflicts.length,
            rejected: result.rejected,
            trace_file: importTraceFile(root),
            message: '深度导入完成: 采用 ' + result.adopted + ' 个 Scene(' + result.skipped.length + ' skip / ' + result.conflicts.length + ' conflict)。',
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 7. 续写提案(计划台; 内容手直连 ctx.llm, 落 .assistant/proposals/) ----
    defineTool({
      name: 'novelcraft_propose_next_chapter',
      description:
        '计划台续写提案: 基于总纲/剧情线/上一章结尾, 生成下一章 2–3 条续写方向(各带依据/成本/风险)。' +
        '结果落 .assistant/proposals/(临时预览, 不写正文); 选定一条后再按需走 writing_generate。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        chapter: { type: 'integer', required: true, description: '当前最后一章序号(1 起); 提案其下一章' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          next_chapter: { type: 'integer', required: true },
          proposals: { type: 'array', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      timeoutMs: 300_000,
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as ProposeNextChapterArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = await service.capabilities.propose.proposeNextChapter(root, args.chapter, exec.signal);
          if (!r.ok || !r.proposal) {
            throw llmError(r.error?.kind, r.error?.message ?? '提案失败');
          }
          return {
            ok: true,
            next_chapter: r.proposal.next_chapter,
            proposals: r.proposal.proposals.map((p) => ({
              title: p.title,
              premise: p.premise,
              basis: p.basis ?? [],
              cost: p.cost ?? '',
              risk: p.risk ?? '',
            })),
            message: `已生成 ${r.proposal.proposals.length} 条下一章方案(选定后可按需 writing_generate 出正文候选)。`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 8. 结构健康信号扫描(确定性, 幂等落盘收件箱 + 自动结算) ----
    defineTool({
      name: 'novelcraft_health_scan',
      description:
        '结构健康信号扫描: 确定性扫描 Scene 四键 + 结构资产两键, 把命中写成收件箱信号' +
        '(radar=writing)。幂等 + 双向对账: 已存在不重复; 条件消失的 open 信号自动结算为' +
        'resolved; 问题回来重新 open; 作者已裁决(accept/reject/defer)不复活。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          created: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          resolved: { type: 'integer', required: true },
          reopened: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const { root: requestedRoot } = rawArgs as unknown as RootArgs;
        try {
          const root = await resolveBoundRoot(service, exec, requestedRoot);
          const r = service.capabilities.propose.scanHealth(root);
          pushSignalsChanged(ctx, { root });
          return {
            ok: true,
            created: r.created,
            skipped: r.skipped,
            resolved: r.resolved,
            reopened: r.reopened,
            total: r.total,
            message: `结构健康扫描完成(新 ${r.created}/结 ${r.resolved}/复 ${r.reopened})`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 9. 续写提案第二阶段(选定方向 → writing_generate 正文候选) ----
    defineTool({
      name: 'novelcraft_generate_next_chapter',
      description:
        '续写提案第二阶段: 按选定方向生成下一章正文候选(writing_generate, 续写模式)。' +
        '候选写 chapters/pending/{NNN}.md(status=candidate, 只读); 采用另走 novelcraft_store_adopt(必经审批)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        chapter: { type: 'integer', required: true, description: '当前最后一章序号(1 起); 生成其下一章' },
        proposal_title: { type: 'string', required: true, description: '选定提案标题(作者语言方向)' },
        premise: { type: 'string', description: '选定提案前提(可空)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          file: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      timeoutMs: 300_000,
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as GenerateNextChapterArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = await service.capabilities.propose.generateNextChapter(root, args.chapter, {
            proposalTitle: args.proposal_title,
            ...(args.premise ? { premise: args.premise } : {}),
          }, exec.signal);
          if (!r.ok) throw llmError(r.error?.kind, r.error?.message ?? '生成失败');
          // 事件触发雷达(§11): 新候选入库后写作面对账。
          fireRadarHooks(ctx, root, EVENT_RADAR_MAP.generate);
          return {
            ok: true,
            file: r.file ?? '',
            message: `已生成第 ${args.chapter + 1} 章候选(chapters/pending); 采用请走 novelcraft_store_adopt。`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 10. 文本入库(页内授权收据 → 章节切分 → wiki 化存储; D9a) ----
    defineTool({
      name: 'novelcraft_ingest_file',
      description:
        '文本入库: 消费用户在当前写作台选择文件后获得的会话收据(.txt/.md, ≤50MB),' +
        '确定性切分章节并写入 imports/ + chapters/ + import-log。不接受主机文件路径。' +
        '同号章内容冲突默认跳过' +
        '(force 才覆盖); 同文件重复导入自动跳过(幂等)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        receipt_id: { type: 'string', required: true, description: '当前会话写作台生成的文件收据 ID' },
        start_chapter: { type: 'integer', description: '落库起始章节号(缺省接现有最大章之后)' },
        force: { type: 'boolean', description: '同号章内容不同时覆盖(默认跳过并报告冲突)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          receipt_id: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          imported: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          conflicts: { type: 'array', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as IngestFileArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const sessionId = sessionIdOf(exec);
          const report = service.capabilities.propose.ingestTextFile(root, {
            receiptId: args.receipt_id,
            sessionId,
            ...(args.start_chapter !== undefined ? { startChapter: args.start_chapter } : {}),
            ...(args.force ? { force: true } : {}),
          });
          if (!report.ok) {
            throw new HarnessError(report.reason ?? '导入失败', 'INGEST_FAILED');
          }
          // 事件触发雷达(§11): 摄入对账 + 写作健康。
          fireRadarHooks(ctx, root, EVENT_RADAR_MAP.ingest);
          // 事件触发 RAG 索引(§11): 新章落库后只同步词法派生索引;
          // 向量写入由显式 novelcraft_rag_embed 独占。
          fireRagHook(ctx, root);
          const dup = report.warnings.includes('duplicate_import');
          const conflictNote = (report.conflicts?.length ?? 0) > 0
            ? `, ${report.conflicts!.length} 章冲突跳过(第 ${report.conflicts!.join('/')} 章, 可用 force 覆盖)`
            : '';
          const noHeading = report.warnings.includes('no_headings') ? ', 未识别到章节标题已按单章处理' : '';
          const message = dup
            ? '该文件此前已导入(幂等跳过, 不写任何文件)。'
            : `已入库 ${report.imported ?? 0} 章(共解析 ${report.total ?? 0} 章${conflictNote}${noHeading})。下一步可跑深度导入(novelcraft_deep_import)。`;
          return {
            ok: true,
            receipt_id: args.receipt_id,
            total: report.total ?? 0,
            imported: report.imported ?? 0,
            skipped: report.skipped ?? 0,
            conflicts: report.conflicts ?? [],
            message,
          };
        } catch (err) {
          throw toolError(err, {
            code: 'INGEST_FAILED',
            message: err instanceof Error ? err.message : '导入失败',
          });
        }
      },
    }),

    // ---- 章级审查闭环(§6.16): current review/revise → candidate review → guarded adopt ----
    defineTool({
      name: 'novelcraft_chapter_review',
      description:
        '单章审查闭环。review 可审 current 或 candidate；revise 只接受 fresh current review 的 finding_ids 并产新候选；' +
        'reject_finding 记录作者理由；reject 以 hash CAS 驳回并释放 active candidate；' +
        'adopt 只采用 fresh 独立审查 pass 且基线未漂移的候选，并必经审批。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        action: { type: 'string', required: true, enum: ['inspect', 'review', 'revise', 'reject_finding', 'reject', 'adopt'] },
        target: { type: 'string', required: true, enum: ['current', 'candidate'] },
        chapter: { type: 'integer', required: true, description: '章节序号(1 起)' },
        ref: { type: 'string', description: 'candidate 的精确 ref(缺省 NNN)' },
        review_id: { type: 'string', description: 'reject_finding 的 current review id' },
        finding_id: { type: 'string', description: 'reject_finding 的 finding id' },
        finding_ids: { type: 'array', items: { type: 'string' }, description: 'revise 选中的 finding ids' },
        reason: { type: 'string', description: 'reject_finding 必填作者理由' },
        expected_content_hash: { type: 'string', description: 'adopt 的候选 CAS hash' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            target: { type: 'string', required: true },
            chapter: { type: 'integer', required: true },
            ref: { type: 'string', required: true },
            review_id: { type: 'string', required: true },
            verdict: { type: 'string', required: true },
            content_hash: { type: 'string', required: true },
            findings: { type: 'array', required: true },
            file: { type: 'string', required: true },
            commit: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render,
      },
      timeoutMs: 1_800_000,
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as ChapterReviewArgs;
        const target = args.target === 'candidate' ? 'candidate' : args.target === 'current' ? 'current' : null;
        if (!target) throw new HarnessError('target 非法', 'INVALID_ARGUMENT');
        const ref = args.ref ?? String(args.chapter).padStart(3, '0');
        const blank = {
          ok: true,
          action: args.action,
          target,
          chapter: args.chapter,
          ref,
          review_id: '',
          verdict: '',
          content_hash: '',
          findings: [] as Array<Record<string, string>>,
          file: '',
          commit: '',
        };
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          if (args.action === 'inspect') {
            const review = service.capabilities.read.chapterReview(root, args.chapter, target, ref);
            return review
              ? {
                  ...blank,
                  review_id: review.review_id,
                  verdict: review.verdict ?? '',
                  content_hash: review.target_content_hash ?? review.content_hash,
                  findings: reviewFindingCards(review.findings),
                  message: `第 ${args.chapter} 章 ${target} 最新审查: ${review.verdict ?? '未裁定'}。`,
                }
              : { ...blank, message: `第 ${args.chapter} 章 ${target} 尚无审查。` };
          }
          if (args.action === 'review') {
            const result = await service.capabilities.propose.reviewChapter(
              root,
              args.chapter,
              target,
              target === 'candidate' ? ref : undefined,
              exec.signal,
            );
            if (!result.ok || !result.review) throw llmError(result.error?.kind, result.error?.message ?? '审查失败');
            return {
              ...blank,
              review_id: result.review.review_id,
              verdict: result.review.verdict ?? '',
              content_hash: result.review.target_content_hash ?? result.review.content_hash,
              findings: reviewFindingCards(result.review.findings),
              message: `第 ${args.chapter} 章 ${target} 审查完成: ${result.review.verdict ?? '未裁定'}，${result.review.findings.length} 条 finding。`,
            };
          }
          if (args.action === 'revise') {
            if (target !== 'current' || !Array.isArray(args.finding_ids) || args.finding_ids.length === 0) {
              throw new HarnessError('revise 只接受 current + 非空 finding_ids', 'INVALID_ARGUMENT');
            }
            const result = await service.capabilities.propose.reviseChapter(root, args.chapter, args.finding_ids, exec.signal);
            if (!result.ok) throw llmError(result.error?.kind, result.error?.message ?? '返修失败');
            fireRadarHooks(ctx, root, EVENT_RADAR_MAP.generate);
            return { ...blank, file: result.file ?? '', message: `第 ${args.chapter} 章返修候选已生成；采用前必须独立审查 candidate。` };
          }
          if (args.action === 'reject_finding') {
            if (target !== 'current' || !args.review_id || !args.finding_id || !args.reason) {
              throw new HarnessError('reject_finding 缺少 current/review_id/finding_id/reason', 'INVALID_ARGUMENT');
            }
            await service.capabilities.propose.rejectChapterFinding(
              root, args.chapter, args.review_id, args.finding_id, args.reason,
            );
            return { ...blank, review_id: args.review_id, message: `已打回 finding ${args.finding_id} 并记录理由。` };
          }
          if (args.action === 'reject') {
            if (target !== 'candidate' || !args.reason || !args.expected_content_hash) {
              throw new HarnessError('reject 缺少 candidate/reason/expected_content_hash', 'INVALID_ARGUMENT');
            }
            const result = await service.capabilities.propose.rejectChapterCandidate(
              root, args.chapter, ref, args.expected_content_hash, args.reason,
            );
            return {
              ...blank,
              content_hash: args.expected_content_hash,
              commit: result.commit,
              message: `第 ${args.chapter} 章候选已拒绝并释放待处理槽(commit ${result.commit.slice(0, 12)})。`,
            };
          }
          if (args.action === 'adopt') {
            if (target !== 'candidate') throw new HarnessError('adopt 只接受 candidate', 'INVALID_ARGUMENT');
            const result = await service.capabilities.adoptGuarded.storeAdopt(
              exec.agent as Agent | undefined,
              root,
              'chapter_candidate',
              ref,
              args.expected_content_hash ? { expectedContentHash: args.expected_content_hash } : {},
              `采用第 ${args.chapter} 章候选 ${ref}`,
            );
            fireRadarHooks(ctx, root, [...EVENT_RADAR_MAP.adopt, ...EVENT_RADAR_MAP.adoptChapterCandidate]);
            fireRagHook(ctx, root);
            return {
              ...blank,
              commit: result.commit,
              message: `第 ${args.chapter} 章候选已采用(commit ${result.commit.slice(0, 12)})。`,
            };
          }
          throw new HarnessError('action 非法', 'INVALID_ARGUMENT');
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 正文版本工作流(§6.15): 读/history/diff + 收据保存/恢复审批 ----
    defineTool({
      name: 'novelcraft_chapter_version',
      description:
        '单章正文版本工作流。inspect/history/diff 为只读；save 消费章节页内编辑收据；' +
        'restore 把所选 Git 旧版本恢复为一个新提交。save/restore 必经用户审批且使用正文 hash/HEAD CAS。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        action: { type: 'string', required: true, enum: ['inspect', 'history', 'diff', 'save', 'restore'] },
        chapter: { type: 'integer', required: true, description: '章节序号(1 起)' },
        receipt_id: { type: 'string', description: 'save: 写作页内编辑生成的会话收据 ID' },
        commit: { type: 'string', description: 'diff/restore: 所选历史 commit' },
        compare_commit: { type: 'string', description: 'diff: 对比目标 commit(缺省当前 HEAD)' },
        expected_content_hash: { type: 'string', description: 'restore: 当前正文 CAS hash' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            chapter: { type: 'integer', required: true },
            content_hash: { type: 'string', required: true },
            commit: { type: 'string', required: true },
            body: { type: 'string', required: true },
            history: { type: 'array', required: true },
            diff: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as ChapterVersionArgs;
        const blank = {
          ok: true,
          action: args.action,
          chapter: args.chapter,
          content_hash: '',
          commit: '',
          body: '',
          history: [] as Array<Record<string, string | number | boolean>>,
          diff: '',
          truncated: false,
        };
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          if (args.action === 'inspect') {
            const current = service.capabilities.read.chapterCurrent(root, args.chapter);
            return {
              ...blank,
              content_hash: current.contentHash,
              commit: current.head,
              body: current.body,
              message: `第 ${args.chapter} 章当前正文已读取(${current.status})。`,
            };
          }
          if (args.action === 'history') {
            const history = service.capabilities.read.chapterHistory(root, args.chapter).map((entry) => ({
              commit: entry.commit,
              authored_at: entry.authoredAt,
              subject: entry.subject,
              status: entry.status,
              title: entry.title ?? '',
              content_hash: entry.contentHash,
              declared_hash_valid: entry.declaredHashValid,
              byte_length: entry.byteLength,
            }));
            return {
              ...blank,
              history,
              message: `第 ${args.chapter} 章共有 ${history.length} 条可见 Git 版本。`,
            };
          }
          if (args.action === 'diff') {
            if (!args.commit) throw new HarnessError('diff 缺少 commit', 'INVALID_ARGUMENT');
            const diff = service.capabilities.read.chapterDiff(root, args.chapter, args.commit, args.compare_commit);
            return {
              ...blank,
              content_hash: diff.to.contentHash,
              commit: diff.to.commit,
              diff: diff.patch,
              truncated: diff.truncated,
              message: `已生成第 ${args.chapter} 章版本差异${diff.truncated ? '(展示已限长)' : ''}。`,
            };
          }
          if (args.action === 'save') {
            if (!args.receipt_id) throw new HarnessError('save 缺少 receipt_id', 'INVALID_ARGUMENT');
            const result = await service.capabilities.adoptGuarded.saveChapter(
              exec.agent as Agent | undefined,
              root,
              sessionIdOf(exec),
              args.receipt_id,
            );
            if (!result.skipped) {
              fireRadarHooks(ctx, root, EVENT_RADAR_MAP.ingest);
              fireRagHook(ctx, root);
            }
            return {
              ...blank,
              content_hash: result.contentHash,
              commit: result.commit,
              message: result.skipped
                ? `第 ${args.chapter} 章内容未变化, 未创建版本。`
                : `第 ${args.chapter} 章已保存为新版本(commit ${result.commit.slice(0, 12)})。`,
            };
          }
          if (args.action === 'restore') {
            if (!args.commit || !args.expected_content_hash) {
              throw new HarnessError('restore 缺少 commit 或 expected_content_hash', 'INVALID_ARGUMENT');
            }
            const result = await service.capabilities.adoptGuarded.restoreChapter(
              exec.agent as Agent | undefined,
              root,
              args.chapter,
              args.commit,
              args.expected_content_hash,
            );
            if (!result.skipped) {
              fireRadarHooks(ctx, root, EVENT_RADAR_MAP.ingest);
              fireRagHook(ctx, root);
            }
            return {
              ...blank,
              content_hash: result.contentHash,
              commit: result.commit,
              message: result.skipped
                ? `第 ${args.chapter} 章已与所选版本一致, 未创建版本。`
                : `第 ${args.chapter} 章已恢复为新版本(commit ${result.commit.slice(0, 12)})。`,
            };
          }
          throw new HarnessError('action 非法', 'INVALID_ARGUMENT');
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 11. 雷达巡检(§11 手动触发; 默认五面, 幂等 + 自动结算) ----
    defineTool({
      name: 'novelcraft_radar_sweep',
      description:
        '雷达巡检: 五面确定性扫描器对账收件箱信号(摄入/去重/建议/风险/写作; 幂等落盘 + ' +
        '条件消失自动结算 + 作者裁决不复活), 并返回一句话剧情摘要(宠物默认答复数据源)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        radar: { type: 'string', enum: [...RADARS], description: '只跑某一面(缺省全五面)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          results: { type: 'object', additionalProperties: true, required: true },
          plot_summary: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as RadarSweepArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = service.capabilities.propose.radarSweep(
            root,
            args.radar ? [args.radar as assistant.RadarKind] : undefined,
          );
          pushSignalsChanged(ctx, { root });
          // results 的 radar 键是动态集合, 仅该嵌套对象保持开放。
          const results: Record<string, { created: number; skipped: number; resolved: number; reopened: number; total: number }> = {};
          const summaryParts: string[] = [];
          for (const [k, v] of Object.entries(r.results)) {
            if (!v) continue;
            results[k] = { created: v.created, skipped: v.skipped, resolved: v.resolved, reopened: v.reopened, total: v.total };
            summaryParts.push(`${k}: 新${v.created}/结${v.resolved}/复${v.reopened}`);
          }
          const summary = summaryParts.join(', ');
          return {
            ok: true,
            results,
            plot_summary: r.plotSummary,
            message: `巡检完成(${summary || '无命中'})。当前: ${r.plotSummary}`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),
    // ---- 12. RAG 语义检索(只读; 索引由事件钩子维护, 本工具不触发同步) ----
    defineTool({
      name: 'novelcraft_rag_search',
      description:
        '语义检索: 在已索引片段(章节正文/角色/世界对象)中按查询找相关片段。BM25 召回 + 内容手精排' +
        '(rerank=false 可关), 精排失败自动降级 BM25; .assistant/llm.yml 设 embedding: bge-local-v1 时' +
        '叠加本地 BGE 向量召回(L2, 失败自动回退文本检索); 索引由 adopt/ingest/deep_import 事件自动维护, ' +
        '本工具只检索不建索引——若提示无索引, 请先文本入库或采用资产后重试。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        query: { type: 'string', required: true, description: '检索查询(作者语言关键词或句子)' },
        top_k: { type: 'integer', description: '返回条数上限(缺省 8)' },
        rerank: { type: 'boolean', description: '内容手精排开关(缺省 true; false = 纯 BM25, 不调 LLM)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          hits: { type: 'array', required: true },
          ranking: { type: 'string', required: true },
          degraded: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as RagSearchArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = await service.capabilities.read.ragSearch(root, args.query, {
            ...(args.top_k !== undefined ? { topK: args.top_k } : {}),
            ...(args.rerank !== undefined ? { rerank: args.rerank } : {}),
          });
          // hits 摊平为作者可读字段。
          const hits = r.hits.map((c) => ({
            chunk_id: c.chunk_id,
            source_type: c.source_type,
            ...(c.chapter_index !== undefined ? { chapter_index: c.chapter_index } : {}),
            char_count: c.char_count,
            text: c.text,
          }));
          const rankingLabel = r.ranking === 'llm_rerank' ? '精排' : r.ranking === 'vector' ? '向量召回' : 'BM25';
          const degradedNote = r.degraded
            ? r.degraded.includes('rerank_failed')
              ? '; 精排失败已降级'
              : '; 嵌入失败, 已回退文本检索'
            : '';
          const message = hits.length > 0
            ? `命中 ${hits.length} 条(${rankingLabel}${degradedNote})。`
            : '无命中或索引为空, 可先文本入库/采用资产后重试。';
          return { ok: true, hits, ranking: r.ranking, degraded: r.degraded ?? '', message };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 13. RAG 批量嵌入(L2; 后端不可用进入宿主失败通道) ----
    defineTool({
      name: 'novelcraft_rag_embed',
      description:
        '批量嵌入: 对索引中待向量化片段(pending/failed 且无 vector)调用本地 BGE 嵌入后端生成向量, ' +
        '逐批落盘 .assistant/rag-index.json(中断可重入)。需在 .assistant/llm.yml 设 embedding: bge-local-v1 ' +
        '且 @novelcraft/rag-bge 已安装; 未启用时返回可机读的宿主工具错误。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          embedded: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          skipped: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as RootArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = await service.capabilities.propose.ragEmbed(root);
          if (r.message !== undefined) {
            throw new HarnessError(r.message, 'RAG_EMBEDDING_UNAVAILABLE');
          }
          return {
            ok: true,
            embedded: r.embedded,
            failed: r.failed,
            skipped: r.skipped,
            message: `已嵌入 ${r.embedded} 个片段(失败 ${r.failed}, 跳过 ${r.skipped})`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),
    // ---- 14. 地图册规划(catalog §4.11; 同步长跑 timeout 3600s; 候选落 pending, 不过审批) ----
    defineTool({
      name: 'novelcraft_map_atlas_plan',
      description:
        '地图册规划: 编译 canonical 证据 → 空间事实 → LLM 产出 ≤20 页 AtlasPlan 并校验, ' +
        '候选页落 world/atlas/pending(prompt_only, 本系统不生图, 不可直接采用)。' +
        '采用走 novelcraft_map_atlas_review(必经审批)。timeout 3600s。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        style_note: { type: 'string', description: '全局风格补充(≤4000 字)' },
        include_working_drafts: { type: 'boolean', description: '纳入 draft 状态 bible 页(默认仅 canonical)' },
        include_interiors: { type: 'boolean', description: '允许 interior 层级节点' },
        full_rebuild: { type: 'boolean', description: '忽略现有地图册, 按 initial 规划' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          run_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          planned_page_count: { type: 'integer', required: true },
          error_code: { type: 'string', required: true },
          evidence_summary: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      timeoutMs: 3_600_000,
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as MapAtlasPlanArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = await service.capabilities.propose.planMapAtlas(root, {
            run_kind: args.full_rebuild ? 'initial' : 'update',
            style_note: args.style_note,
            include_working_drafts: args.include_working_drafts,
            include_interiors: args.include_interiors,
            full_rebuild: args.full_rebuild,
          }, exec.signal, undefined, exec.agent);
          if (r.run.status === 'failed') {
            throw new HarnessError(r.run.error_message || '地图册规划失败', 'MAP_ATLAS_PLAN_FAILED');
          }
          const ev = (r.run.spatial_evidence ?? {}) as {
            supported?: unknown[]; visual_fill?: unknown[]; conflicts?: unknown[];
            degraded?: boolean; reused?: boolean;
          };
          const evidenceSummary = JSON.stringify({
            supported: ev.supported?.length ?? 0,
            visual_fill: ev.visual_fill?.length ?? 0,
            conflicts: ev.conflicts?.length ?? 0,
            degraded: ev.degraded === true,
            reused: ev.reused === true,
          });
          return {
            ok: true,
            run_id: r.run.id,
            status: r.run.status,
            planned_page_count: r.run.planned_page_count,
            error_code: r.run.error_code ?? '',
            evidence_summary: evidenceSummary,
            message: r.run.planned_page_count === 0
              ? '无变化(missing/changed/new 均空), 未调用 LLM。'
              : `已规划 ${r.run.planned_page_count} 页候选(prompt_only); 上传图片后走 novelcraft_map_atlas_review adopt。`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 15. 地图册视图(只读) ----
    defineTool({
      name: 'novelcraft_map_atlas_view',
      description:
        '地图册只读视图: 已采用树(图片页/空页占位/image_missing 派生位) + 候选(pending nodes/pages) + 指定或最近 run 摘要。' +
        '图片以相对路径返回(images/<page>/<attempt>.<ext>), 不读字节。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        run_id: { type: 'string', description: '指定 run(缺省 = 最近一次)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          adopted_nodes: { type: 'integer', required: true },
          adopted_pages: { type: 'integer', required: true },
          pending_nodes: { type: 'integer', required: true },
          pending_pages: { type: 'integer', required: true },
          tree: { type: 'string', required: true },
          run: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as MapAtlasViewArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const { tree, run } = service.capabilities.read.viewMapAtlas(root, args.run_id);
          return {
            ok: true,
            adopted_nodes: tree.nodes.length,
            adopted_pages: tree.pages.length,
            pending_nodes: tree.pendingNodes.length,
            pending_pages: tree.pendingPages.length,
            tree: JSON.stringify(tree),
            run: run ? JSON.stringify(run) : '',
            message: `已采用 ${tree.nodes.length} 节点/${tree.pages.length} 页; 候选 ${tree.pendingNodes.length} 节点/${tree.pendingPages.length} 页。`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 16. 会话收据图片导入(候选写入不过审批, N29; 附录 A.3/A.4) ----
    defineTool({
      name: 'novelcraft_map_atlas_upload',
      description:
        '消费用户在当前地图册选择图片后获得的会话收据(PNG/JPEG ≤50MB, 16~8192px):' +
        '挂到收据锁定节点的 prompt_only 候选页(置 review_ready)或新建 upload 候选页。不接受主机文件路径。' +
        '候选不过审批; 采用走 novelcraft_map_atlas_review(adopt 必经审批)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        receipt_id: { type: 'string', required: true, description: '当前会话地图册生成的图片收据 ID' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          page_id: { type: 'string', required: true },
          node_ref: { type: 'string', required: true },
          generation_status: { type: 'string', required: true },
          image: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as MapAtlasUploadArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = service.capabilities.propose.importAtlasImage(root, {
            receiptId: args.receipt_id,
            sessionId: sessionIdOf(exec),
          });
          return {
            ok: true,
            page_id: r.page.id,
            node_ref: r.page.node_ref,
            generation_status: r.page.generation_status,
            image: r.page.image?.file ?? '',
            message: `已导入候选图 ${r.page.image?.file ?? ''}(页 ${r.page.id}); 采用请走 novelcraft_map_atlas_review。`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 17. 地图页/节点生命周期(adopt 类必经 ApprovalGate, fail-closed) ----
    defineTool({
      name: 'novelcraft_map_atlas_review',
      description:
        '地图页/节点生命周期: adopt(采用候选页, 需 review_ready+有图) / adopt_placeholder(采用空页占位节点) / ' +
        'reject(驳回 review_ready 候选页) / archive(归档已采用页) / restore(恢复归档页)。' +
        'adopt/adopt_placeholder/archive/restore 必经审批(fail-closed, allowed-once 只放行一次); ' +
        'conflicts 页需 confirm_conflicts=true。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        page_ref: { type: 'string', description: '页 id(adopt/reject/archive/restore)' },
        node_ref: { type: 'string', description: '节点 id(adopt_placeholder)' },
        action: { type: 'string', required: true, enum: ['adopt', 'adopt_placeholder', 'reject', 'archive', 'restore'], description: 'adopt|adopt_placeholder|reject|archive|restore' },
        confirm_conflicts: { type: 'boolean', description: '确认 evidence.conflicts(adopt 必需)' },
        expected_content_hash: { type: 'string', description: 'CAS: 期望的页 content_hash' },
        note: { type: 'string', description: 'review_note' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as MapAtlasReviewArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = await service.capabilities.adoptGuarded.reviewMapAtlas(
            exec.agent as Agent | undefined,
            root,
            { pageRef: args.page_ref, nodeRef: args.node_ref },
            args.action as 'adopt' | 'adopt_placeholder' | 'reject' | 'archive' | 'restore',
            { confirmConflicts: args.confirm_conflicts, expectedContentHash: args.expected_content_hash, note: args.note },
          );
          return { ok: true, action: args.action, message: r.detail };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 18. 标注应用(N35: 唯一受控结构化入口 = 消费 UI 队列; 作者内容编辑不过审批) ----
    defineTool({
      name: 'novelcraft_map_atlas_annotation',
      description:
        '应用地图页文字标注: 只消费 .assistant/atlas/annotation-queue/ 队列文件(UI 已落盘的精确' +
        '结构化编辑, 固定 schema {page_ref, base_content_hash, ops}, base_content_hash CAS 必填)。' +
        'agent 只触发消费, 不生成/不翻译坐标, 不接受直接 ops 参数(工具无旁路)。' +
        '缺失/过期 base_content_hash、非法 op(未知 op/未知字段/缺字段)一律拒绝且零写, 队列文件保留待修。' +
        '标注是作者内容编辑, 不走审批。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', enum: ['complete', 'partial', 'no_change'], required: true },
          applied: { type: 'integer', required: true },
          queue_files: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as RootArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const r = await service.capabilities.propose.authorEdit.annotations(root);
          const status: 'complete' | 'partial' | 'no_change' = r.failed > 0
            ? 'partial'
            : r.files === 0 ? 'no_change' : 'complete';
          return {
            ok: true,
            status,
            applied: r.applied,
            queue_files: r.files,
            message: r.files === 0
              ? '标注队列为空(.assistant/atlas/annotation-queue/ 无文件)。'
              : `已消费 ${r.files} 个队列文件, 应用 ${r.applied} 条标注${r.failed > 0 ? `(失败 ${r.failed}: ${r.errors.join('; ')})` : ''}。`,
          };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),

    // ---- 19. 改 prompt_only 候选页 prompt(候选面, 不过审批) ----
    defineTool({
      name: 'novelcraft_map_atlas_update_prompt',
      description:
        '更新 prompt_only 候选页的外部生图参考文本(仅 prompt_only 候选可改; expected_content_hash 做 CAS)。' +
        '本系统不生图, prompt 供作者拿去外部生图后走 novelcraft_map_atlas_upload 回传。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        page_ref: { type: 'string', required: true, description: '页 id(prompt_only 候选)' },
        prompt: { type: 'string', required: true, description: '新的生图参考文本' },
        expected_content_hash: { type: 'string', description: 'CAS: 期望的页 content_hash' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
          ok: { type: 'boolean', required: true },
          page_id: { type: 'string', required: true },
          content_hash: { type: 'string', required: true },
          message: { type: 'string', required: true },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as MapAtlasUpdatePromptArgs;
        try {
          const root = await resolveBoundRoot(service, exec, args.root);
          const page = await service.capabilities.propose.updateAtlasPrompt(root, args.page_ref, args.prompt, args.expected_content_hash);
          return { ok: true, page_id: page.id, content_hash: page.content_hash, message: `已更新页 ${page.id} 的 prompt。` };
        } catch (err) {
          throw toolError(err);
        }
      },
    }),
  ];
}
