// @novelcraft/dsh · agent 工具注册(ctx.tools seam)。
// §22.3/§12: 原语工具面同名映射为「文件背书插件工具」; 采用类写操作经
// ApprovalGate(fail-closed), 读操作直通。工具名统一 novelcraft_ 前缀。
// tools 服务缺失时静默跳过注册(最小 profile/纯进程内测试仍可用服务门面)。
// defineTool 显式泛型: S=ParameterSchemaSpec, O=ObjectValueSchemaSpec
// (对象开放是 dsh-tools 的强制要求); 工具内部把 args 收窄到本地接口。
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as assistant from '@novelcraft/assistant';
import * as store from '@novelcraft/store';
import type { AdoptableKind } from '@novelcraft/store';
import { GateDeniedError } from './approval/gate.js';
import { svc } from './ctx.js';
import { importTraceFile } from './deep-import.js';
import type { NovelCraftService } from './service.js';
import { pushSignalsChanged } from './push.js';

/** tools 服务缺省时的空注册(返回空 disposer 列表)。 */
export function registerNovelcraftTools(ctx: Context, service: NovelCraftService): Array<() => void> {
  const registry = svc<{ register(definition: ToolDefinition): () => void }>(ctx, 'tools');
  if (!registry || typeof registry.register !== 'function') return [];

  const disposers: Array<() => void> = [];
  for (const tool of buildTools(ctx, service)) {
    disposers.push(registry.register(tool));
  }
  return disposers;
}

const render = (_args: unknown, value: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(value) },
];

/** 错误 → 作者语言消息(工具结果不抛给模型栈, 转 ok:false)。 */
function errMessage(err: unknown): string {
  if (err instanceof GateDeniedError) return err.message;
  if (err instanceof store.StoreError) return `store: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
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
const SEVERITIES = ['hint', 'note', 'risk', 'conflict'] as const;

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
interface PushArgs extends RootArgs {
  radar: string;
  severity: string;
  title: string;
  evidence: string[];
  proposed_action: string;
  reversibility: boolean;
  expires_when_draft_changes?: boolean;
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
          additionalProperties: true,
          properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          input_tokens: { type: 'integer' },
          output_tokens: { type: 'integer' },
          error: { type: 'string' },
          },
        },
        render,
      },
      timeoutMs: 300_000,
      async execute(rawArgs, exec) {
        void exec.signal;
        const args = rawArgs as unknown as LlmStepArgs;
        const result = await service.runStep({
          specRef: args.spec,
          input: args.input,
          overrides: {
            ...(args.model ? { model: args.model } : {}),
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            ...(args.max_tokens !== undefined ? { maxTokens: args.max_tokens } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
          },
          fixAttempts: args.fix_attempts ?? 1,
        });
        const text = result.ok
          ? result.result && typeof result.result === 'object'
            ? JSON.stringify(result.result)
            : String(result.result ?? '')
          : '';
        return {
          ok: result.ok,
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
          additionalProperties: true,
          properties: {
          objects: { type: 'integer' },
          aliases: { type: 'integer' },
          relations: { type: 'integer' },
          scenes: { type: 'integer' },
          chapters: { type: 'integer' },
          structure: { type: 'integer' },
          },
        },
        render,
      },
      async execute(rawArgs) {
        const { root } = rawArgs as unknown as RootArgs;
        const index = service.refreshIndex(root);
        return {
          objects: index.objects.length,
          aliases: index.aliases.length,
          relations: index.relations.length,
          scenes: index.scenes.length,
          chapters: index.chapters.length,
          structure: index.structure.length,
        };
      },
    }),

    // ---- 3. 采用(审批门控写, §9) ----
    defineTool({
      name: 'novelcraft_store_adopt',
      description:
        '采用一个待处理/候选资产(copy-on-adopt 或状态迁移 + git commit)。' +
        '写操作必经用户审批(fail-closed); 审批拒绝时返回 ok:false。',
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
          additionalProperties: true,
          properties: {
          ok: { type: 'boolean' },
          commit: { type: 'string' },
          target_rel_path: { type: 'string' },
          message: { type: 'string' },
          },
        },
        render,
      },
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as AdoptArgs;
        const agent = exec.agent as Agent | undefined;
        try {
          const result = await service.adoptGuarded(
            agent,
            args.root,
            args.kind as AdoptableKind,
            args.ref,
            {
              ...(args.expected_content_hash ? { expectedContentHash: args.expected_content_hash } : {}),
              ...(args.adopted_by ? { adoptedBy: args.adopted_by } : {}),
            },
            args.note,
          );
          return {
            ok: true,
            commit: result.commit,
            target_rel_path: result.targetRelPath,
            message: `已采用 ${result.kind} → ${result.toStatus}(commit ${result.commit.slice(0, 12)})`,
          };
        } catch (err) {
          return { ok: false, commit: '', target_rel_path: '', message: errMessage(err) };
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
          additionalProperties: true,
          properties: {
          signals: { type: 'array' },
          },
        },
        render,
      },
      async execute(rawArgs) {
        const args = rawArgs as unknown as InboxViewArgs;
        const signals = service.inbox(args.root, args.content_hash);
        return {
          signals: signals.map((s) => ({
            id: s.id,
            radar: s.radar,
            severity: s.severity,
            title: s.title,
            proposed_action: s.proposed_action,
            status: s.status,
            observed_at: s.observed_at,
          })),
        };
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
          additionalProperties: true,
          properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          kind: { type: 'string' },
          microflow: { type: 'string' },
          message: { type: 'string' },
          },
        },
        render,
      },
      async execute(rawArgs) {
        const args = rawArgs as unknown as InboxActArgs;
        try {
          const descriptor = assistant.act(args.root, {
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
          pushSignalsChanged(ctx, { root: args.root });
          return {
            ok: true,
            action: descriptor.action,
            kind: descriptor.kind,
            microflow: descriptor.microflow ?? '',
            message: guide,
          };
        } catch (err) {
          return { ok: false, action: String(args.action ?? ''), kind: 'record', microflow: '', message: errMessage(err) };
        }
      },
    }),

    // ---- 6. 推信号(雷达产出 → 收件箱, 只写信号文件) ----
    defineTool({
      name: 'novelcraft_signal_push',
      description:
        '雷达产出推入收件箱: 创建一条 open 信号(作者语言可执行命题 + 证据)。六雷达: ' +
        'ingest/dedup/suggest/plot/risk/writing。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        radar: { type: 'string', required: true, enum: [...RADARS] },
        severity: { type: 'string', required: true, enum: [...SEVERITIES] },
        title: { type: 'string', required: true, description: '可执行命题(卡片首行)' },
        evidence: { type: 'array', items: { type: 'string' }, required: true, description: '证据(来源+引用, 至少一条)' },
        proposed_action: { type: 'string', required: true },
        reversibility: { type: 'boolean', required: true },
        expires_when_draft_changes: { type: 'boolean', description: '正文变化即过期(写作/审查类)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
          id: { type: 'string' },
          },
        },
        render,
      },
      async execute(rawArgs) {
        const args = rawArgs as unknown as PushArgs;
        const signal = assistant.pushSignal(args.root, {
          radar: args.radar as assistant.RadarKind,
          severity: args.severity as assistant.Severity,
          title: args.title,
          evidence: args.evidence,
          proposed_action: args.proposed_action,
          reversibility: args.reversibility,
          ...(args.expires_when_draft_changes !== undefined
            ? { expires_when_draft_changes: args.expires_when_draft_changes }
            : {}),
        });
        pushSignalsChanged(ctx, { root: args.root });
        return { id: signal.id };
      },
    }),
    // ---- 7. 深度导入(六阶段, adopt 经审批门; trace 落 .assistant/import-trace.jsonl) ----
    defineTool({
      name: 'novelcraft_deep_import',
      description:
        '深度导入: 按章节范围顺序跑六阶段(切分/补全/融合/Scene 采用/实体/别名关系/结构)。' +
        'Scene 采用必经用户审批(fail-closed); 全程 trace 事件落 .assistant/import-trace.jsonl。' +
        '多章为长任务, 建议由编排层分批触发; 本工具同步执行并返回摘要。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        start_chapter: { type: 'integer', required: true, description: '起始章节(1 起)' },
        end_chapter: { type: 'integer', required: true, description: '结束章节(含)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
          ok: { type: 'boolean' },
          workflow_id: { type: 'string' },
          adopted: { type: 'integer' },
          committed: { type: 'integer' },
          skipped: { type: 'integer' },
          conflicts: { type: 'integer' },
          rejected: { type: 'boolean' },
          trace_file: { type: 'string' },
          message: { type: 'string' },
          },
        },
        render,
      },
      timeoutMs: 3_600_000,
      async execute(rawArgs, exec) {
        const args = rawArgs as unknown as DeepImportArgs;
        const agent = exec.agent as Agent | undefined;
        try {
          const result = await service.deepImport(agent, args.root, {
            startChapter: args.start_chapter,
            endChapter: args.end_chapter,
          });
          return {
            ok: true,
            workflow_id: result.workflow_id,
            adopted: result.adopted,
            committed: result.committed.length,
            skipped: result.skipped.length,
            conflicts: result.conflicts.length,
            rejected: result.rejected,
            trace_file: importTraceFile(args.root),
            message: result.rejected
              ? '深度导入完成: Scene 采用未获批准(无提交)。'
              : '深度导入完成: 采用 ' + result.adopted + ' 个 Scene(' + result.skipped.length + ' skip / ' + result.conflicts.length + ' conflict)。',
          };
        } catch (err) {
          return { ok: false, workflow_id: '', adopted: 0, committed: 0, skipped: 0, conflicts: 0, rejected: false, trace_file: '', message: errMessage(err) };
        }
      },
    }),

    // ---- 8. 续写提案(计划台; 内容手直连 ctx.llm, 落 .assistant/proposals/) ----
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
          additionalProperties: true,
          properties: {
          ok: { type: 'boolean' },
          next_chapter: { type: 'integer' },
          proposals: { type: 'array' },
          message: { type: 'string' },
          },
        },
        render,
      },
      timeoutMs: 300_000,
      async execute(rawArgs) {
        const args = rawArgs as unknown as ProposeNextChapterArgs;
        try {
          const r = await service.proposeNextChapter(args.root, args.chapter);
          if (!r.ok || !r.proposal) {
            return { ok: false, next_chapter: 0, proposals: [], message: r.error?.message ?? '提案失败' };
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
          return { ok: false, next_chapter: 0, proposals: [], message: errMessage(err) };
        }
      },
    }),

    // ---- 9. 结构健康信号扫描(确定性, 幂等落盘收件箱 + 自动结算) ----
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
          additionalProperties: true,
          properties: {
          created: { type: 'integer' },
          skipped: { type: 'integer' },
          resolved: { type: 'integer' },
          reopened: { type: 'integer' },
          total: { type: 'integer' },
          },
        },
        render,
      },
      async execute(rawArgs) {
        const { root } = rawArgs as unknown as RootArgs;
        const r = service.scanHealth(root);
        pushSignalsChanged(ctx, { root });
        return { created: r.created, skipped: r.skipped, resolved: r.resolved, reopened: r.reopened, total: r.total };
      },
    }),

    // ---- 10. 续写提案第二阶段(选定方向 → writing_generate 正文候选) ----
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
          additionalProperties: true,
          properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          message: { type: 'string' },
          },
        },
        render,
      },
      timeoutMs: 300_000,
      async execute(rawArgs) {
        const args = rawArgs as unknown as GenerateNextChapterArgs;
        try {
          const r = await service.generateNextChapter(args.root, args.chapter, {
            proposalTitle: args.proposal_title,
            ...(args.premise ? { premise: args.premise } : {}),
          });
          if (!r.ok) return { ok: false, file: '', message: r.error?.message ?? '生成失败' };
          return {
            ok: true,
            file: r.file ?? '',
            message: `已生成第 ${args.chapter + 1} 章候选(chapters/pending); 采用请走 novelcraft_store_adopt。`,
          };
        } catch (err) {
          return { ok: false, file: '', message: errMessage(err) };
        }
      },
    }),
  ];
}
