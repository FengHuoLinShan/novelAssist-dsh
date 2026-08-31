// @novelcraft/dsh · agent 工具注册(ctx.tools seam)。
// §22.3/§12: 原语工具面同名映射为「文件背书插件工具」; 采用类写操作经
// ApprovalGate(fail-closed), 读操作直通。工具名统一 novelcraft_ 前缀。
// 取消贯通: 五个内容手工具(llm_step/deep_import/propose/generate/map_atlas_plan)
// 把 exec.signal 传 service(service 层 withAbortSignal 与 llm-step timeout 合并)。
// tools 服务缺失时静默跳过注册(最小 profile/纯进程内测试仍可用服务门面)。
// 工具一律经 novelcraftToolFactory 定义: schema 推断 args 类型、N34 隔离、
// toolError 单点映射、afterMutation 副作用纪律由包装器结构性保证。
import type { Context } from '@deepseek-ai/cordis';
import { requireRoot } from './tools/shared.js';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { ENTITY_TYPES } from '@novelcraft/store';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { svc } from './ctx.js';
import { importTraceFile } from './deep-import.js';
import type { NovelCraftService } from './service.js';
import { novelcraftToolFactory } from './tools/define.js';
import { buildMapAtlasTools } from './tools/map-atlas.js';
import { buildWritingTools } from './tools/writing.js';
import { buildWorkflowTools } from './tools/workflow.js';
import { buildBookTools } from './tools/book.js';
import { llmError } from './tools/shared.js';

export { WorkspaceIsolationError } from './tools/shared.js';

/** 工具组开关(groups.* 缺省 = 全开)。 */
export interface ToolGroupOptions {
  writing?: boolean;
  mapAtlas?: boolean;
  workflow?: boolean;
  book?: boolean;
}

/** 地图册工具组按名称前缀识别(novelcraft_map_atlas_*, 其余为写作/存储组)。 */
export function isMapAtlasTool(name: string): boolean {
  return name.startsWith('novelcraft_map_atlas_');
}

/** workflow 工具组按名称前缀识别(novelcraft_workflow_*, M10-B1/N40)。 */
export function isWorkflowTool(name: string): boolean {
  return name.startsWith('novelcraft_workflow_');
}

/** book 工具组按名称前缀识别(novelcraft_book_*, M11/N42)。 */
export function isBookTool(name: string): boolean {
  return name.startsWith('novelcraft_book_');
}

/**
 * tools 服务缺省时的空注册(返回空 disposer 列表)。
 * 默认组合走本同步路径(非 ctx.plugin 嵌套挂载): rc.8 cordis 对嵌套子插件构造器
 * 抛错是静默吞掉(deferred start), 同步注册保持 fail-closed 与既有测试契约。
 * 注册保持 all-or-nothing 回滚; 两个工具组可作为独立 cordis 插件单独挂载
 * (见 tools/plugins.ts, 共享同一组 build 函数)。
 */
export function registerNovelcraftTools(
  ctx: Context,
  service: NovelCraftService,
  groups: ToolGroupOptions = {},
): Array<() => void> {
  const registry = svc<{ register(definition: ToolDefinition): () => void }>(ctx, 'tools');
  if (!registry || typeof registry.register !== 'function') return [];

  const disposers: Array<() => void> = [];
  try {
    for (const tool of buildTools(ctx, service)) {
      if (isBookTool(tool.name)) {
        if (groups.book === false) continue;
      } else if (isWorkflowTool(tool.name)) {
        if (groups.workflow === false) continue;
      } else if (isMapAtlasTool(tool.name) ? groups.mapAtlas === false : groups.writing === false) continue;
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

/** 回执正文上界(N39② 延伸, M12-b review P2-6): 与 llm_step 同 receiptLimit 口径。 */
function capReceipt(run: { service: { capabilities: { read: { receiptLimit(): number } } } }, text: string): string {
  const max = run.service.capabilities.read.receiptLimit();
  return text.length > max
    ? `${text.slice(0, max)}\n[回执截断: 原文 ${text.length} 字符, 上限 ${max}(Config.llm.receiptMaxChars)]`
    : text;
}

/** 全量 21 工具定义(写作/存储 15 与地图册 6 的固定交错序; 工具组插件复用)。 */
export function buildTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  const tool = novelcraftToolFactory(ctx, service);
  const [proposeNextChapter, generateNextChapter, chapterReview, chapterVersion] =
    buildWritingTools(ctx, service);
  return [
    // ---- 1. llm_step(内容手原语, §12) ----
    tool({
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
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          input_tokens: { type: 'integer', required: true },
          output_tokens: { type: 'integer', required: true },
          error: { type: 'string', required: true },
          spec_ref: { type: 'string', required: true },
          contract_version: { type: 'string', required: true },
          prompt_hash: { type: 'string', required: true },
          schema_injection: { type: 'string', required: true },
          output_schema_hash: { type: 'string', required: true },
          journal: { type: 'array', required: true },
          // M10-A6: 生效调用参数(合并链终值; 未定字段空串/0)
          effective_provider: { type: 'string', required: true },
          effective_model: { type: 'string', required: true },
          effective_temperature: { type: 'number', required: true },
          effective_max_tokens: { type: 'integer', required: true },
          effective_timeout_ms: { type: 'integer', required: true },
        },
      },
      timeoutMs: 300_000,
      // N34 工作区隔离: llm_step 会访问绑定 vault 的该书 profile/llm.yml(N20),
      // 统一经 session 绑定解析 root; 无 session/未绑定 → fail-closed,
      // 不退回「仅 Config.llm 默认」的任意 root 访问。
      bindRoot: 'session',
      async execute(args, run) {
        // exec.signal(工具取消)贯通: runStep 层与 llm-step timeout 合并(withAbortSignal)。
        const result = await run.service.capabilities.propose.runStep({
          specRef: args.spec,
          input: args.input,
          overrides: {
            ...(args.model ? { model: args.model } : {}),
            ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
            // 显式 undefined 判断(零值不吞): max_tokens=0 是「不限输出」的合法语义,
            // timeout_ms=0 由 core deadline 检查响亮失败 —— 都不静默回退默认。
            ...(args.max_tokens !== undefined ? { maxTokens: args.max_tokens } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
          },
          fixAttempts: args.fix_attempts ?? 1,
        }, requireRoot(run), run.signal);
        if (!result.ok) throw llmError(result.error?.kind, result.error?.message);
        let text = result.result && typeof result.result === 'object'
          ? JSON.stringify(result.result)
          : String(result.result ?? '');
        // 回执尺寸上界(M10-A review 修复): 经 capabilities.read.receiptLimit 读
        // Config.llm.receiptMaxChars(N39 ②; 工具不绕过 capability 面, N35);
        // 超界截断并在尾部显式注记, 不静默丢内容。
        const maxChars = run.service.capabilities.read.receiptLimit();
        if (text.length > maxChars) {
          text = `${text.slice(0, maxChars)}\n[回执截断: 原文 ${text.length} 字符, 上限 ${maxChars}(Config.llm.receiptMaxChars)]`;
        }
        // M10-A4/N38: 回执不再截断正文, 且完整回传 journal 与模型可见指纹
        // (promptFingerprint: systemPromptHash/schemaInjection/outputSchemaHash)——
        // 模型可见⟺可回放, 调用方可审计实际发送的 system 提示与注入模式。
        // journal 逐字段投影为纯 JSON 对象(接口类型无 index signature, 直接透传不满足
        // 工具 output 的 JsonValue 契约)。
        const fp = result.promptFingerprint;
        return {
          ok: true,
          text,
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          error: result.error ? `${result.error.kind}: ${result.error.message}` : '',
          spec_ref: result.specRef,
          contract_version: result.contractVersion,
          prompt_hash: fp?.systemPromptHash ?? '',
          schema_injection: fp?.schemaInjection ?? '',
          output_schema_hash: fp?.outputSchemaHash ?? '',
          // M10-A6: 生效调用参数回执(spec < executionDefaults < overrides 合并终值;
          // 未定字段空串/0)。
          effective_provider: result.effective?.provider ?? '',
          effective_model: result.effective?.model ?? '',
          effective_temperature: result.effective?.temperature ?? 0,
          effective_max_tokens: result.effective?.maxTokens ?? 0,
          effective_timeout_ms: result.effective?.timeoutMs ?? 0,
          journal: result.journal.map((e) => ({
            attempt: e.attempt,
            startedAt: e.startedAt,
            durationMs: e.durationMs,
            ...(e.providerText !== undefined ? { providerText: e.providerText } : {}),
            ...(e.usage !== undefined
              ? { usage: { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens } }
              : {}),
            ...(e.errorKind !== undefined ? { errorKind: e.errorKind } : {}),
            ...(e.errorMessage !== undefined ? { errorMessage: e.errorMessage } : {}),
            ...(e.promptHash !== undefined ? { promptHash: e.promptHash } : {}),
            ...(e.schemaInjection !== undefined ? { schemaInjection: e.schemaInjection } : {}),
          })),
        };
      },
    }),

    // ---- 2. 索引重建(只读) ----
    tool({
      name: 'novelcraft_store_index',
      description: '重建全书派生索引(对象/别名/关系/Scene/章节/结构), 并写入可选缓存。文件是唯一真相, 可随时重建。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
      },
      output: {
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
      async execute(_args, run) {
        // N34: 只读工具同样隔离——root 必须与 session 绑定完全一致(canonical)。
        const index = run.service.capabilities.propose.refreshIndex(requireRoot(run));
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
      },
    }),

    // ---- 3. 采用(审批门控写, §9) ----
    tool({
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
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          commit: { type: 'string', required: true },
          target_rel_path: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      async execute(args, run) {
        const result = await run.service.capabilities.adoptGuarded.storeAdopt(
          run.agent,
          requireRoot(run),
          args.kind,
          args.ref,
          {
            ...(args.expected_content_hash ? { expectedContentHash: args.expected_content_hash } : {}),
            ...(args.adopted_by ? { adoptedBy: args.adopted_by } : {}),
          },
          args.note,
        );
        // §11 事件触发: adopt 后去重+风险对账(章候选另加写作面)+ RAG 词法索引同步;
        // 向量写入由显式 novelcraft_rag_embed 独占。
        await run.afterMutation({
          radars: args.kind === 'chapter_candidate' ? ['adopt', 'adoptChapterCandidate'] : ['adopt'],
          rag: true,
        });
        return {
          ok: true,
          commit: result.commit,
          target_rel_path: result.targetRelPath,
          message: `已采用 ${result.kind} → ${result.toStatus}(commit ${result.commit.slice(0, 12)})`,
        };
      },
    }),

    // ---- 4. 收件箱视图(只读) ----
    tool({
      name: 'novelcraft_inbox_view',
      description: '读收件箱: 全部新鲜信号(风险前置排序)。卡片含 id/radar/severity/title/proposed_action/status。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        content_hash: { type: 'string', description: '当前正文哈希(判断写作/审查类信号是否过期)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          signals: { type: 'array', required: true },
          message: { type: 'string', required: true },
        },
      },
      async execute(args, run) {
        // N34: 只读工具同样隔离(绑定 root 校验在一切读取之前 → 零读 B)。
        const signals = run.service.capabilities.read.inbox(requireRoot(run), args.content_hash);
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
      },
    }),

    // ---- 5. 收件箱四动词(记录决定; 资产写入另走采用/微工作流工具) ----
    tool({
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
      async execute(args, run) {
        const descriptor = await run.service.capabilities.propose.actOnSignal(
          requireRoot(run),
          args.signal_id,
          args.action,
          {
            ...(args.reason ? { reason: args.reason } : {}),
            ...(args.action === 'modify'
              ? {
                  ...(args.modified_title ? { modifiedTitle: args.modified_title } : {}),
                  ...(args.modified_proposed_action ? { modifiedProposedAction: args.modified_proposed_action } : {}),
                }
              : {}),
          },
        );
        const guide =
          descriptor.kind === 'adopt'
            ? '采纳动作: 请按信号目标调用 novelcraft_store_adopt 完成资产采用。'
            : descriptor.kind === 'microflow'
              ? `已路由微工作流「${descriptor.microflow ?? ''}」: 请按其阶段调用对应工具执行。`
              : '已记录决定(校准笔记已更新)。';
        return {
          ok: true,
          action: descriptor.action,
          kind: descriptor.kind,
          microflow: descriptor.microflow ?? '',
          message: guide,
        };
      },
    }),

    // ---- 6. 深度导入(范围授权 + adopt/2b 独立审批门; trace 落 .assistant/import-trace.jsonl) ----
    tool({
      name: 'novelcraft_deep_import',
      description:
        '深度导入: 执行前先请求范围授权(授权将调用 LLM 并产出候选; 拒绝则零副作用, fail-closed); ' +
        '放行后按章节范围顺序跑六阶段(切分/补全/融合/Scene 采用/实体/别名关系/结构)。' +
        'Scene 采用与 2b 别名/关系写入分别过独立审批(fail-closed); 全程 trace 事件落 .assistant/import-trace.jsonl。' +
        '多章为长任务, 建议由编排层分批触发; 本工具同步执行并返回摘要。' +
        '同范围已存在 completed run 时本工具会走续跑语义(全部批次已完成则零授权重收尾); 显式重放/重开请改用 workflow_inspect 与 workflow_start_new',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        start_chapter: { type: 'integer', required: true, description: '起始章节(1 起)' },
        end_chapter: { type: 'integer', required: true, description: '结束章节(含)' },
      },
      output: {
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
      timeoutMs: 3_600_000,
      async execute(args, run) {
        const result = await run.service.capabilities.adoptGuarded.deepImport(run.agent, requireRoot(run), {
          startChapter: args.start_chapter,
          endChapter: args.end_chapter,
        }, run.signal);
        if (result.rejected) {
          throw new HarnessError('深度导入的 Scene 采用未获批准, 候选保持未采用', 'APPROVAL_REJECTED');
        }
        // §11 事件触发: 导入后去重/风险/剧情/写作四面对账 + RAG 词法索引同步。
        await run.afterMutation({ radars: ['deepImport'], rag: true });
        return {
          ok: true,
          workflow_id: result.workflow_id,
          adopted: result.adopted,
          committed: result.committed.length,
          skipped: result.skipped.length,
          conflicts: result.conflicts.length,
          rejected: result.rejected,
          trace_file: importTraceFile(requireRoot(run)),
          message: '深度导入完成: 采用 ' + result.adopted + ' 个 Scene(' + result.skipped.length + ' skip / ' + result.conflicts.length + ' conflict)。',
        };
      },
    }),

    proposeNextChapter,

    // ---- 8. 结构健康信号扫描(确定性, 幂等落盘收件箱 + 自动结算) ----
    tool({
      name: 'novelcraft_health_scan',
      description:
        '结构健康信号扫描: 确定性扫描 Scene 四键 + 结构资产两键, 把命中写成收件箱信号' +
        '(radar=writing)。幂等 + 双向对账: 已存在不重复; 条件消失的 open 信号自动结算为' +
        'resolved; 问题回来重新 open; 作者已裁决(accept/reject/defer)不复活。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
      },
      output: {
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
      async execute(_args, run) {
        const r = await run.service.capabilities.propose.scanHealth(requireRoot(run));
        await run.afterMutation({ push: true });
        return {
          ok: true,
          created: r.created,
          skipped: r.skipped,
          resolved: r.resolved,
          reopened: r.reopened,
          total: r.total,
          message: `结构健康扫描完成(新 ${r.created}/结 ${r.resolved}/复 ${r.reopened})`,
        };
      },
    }),

    generateNextChapter,

    // ---- 10. 文本入库(页内授权收据 → 章节切分 → wiki 化存储; D9a) ----
    tool({
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
      errorFallback: (err) => ({
        code: 'INGEST_FAILED',
        message: err instanceof Error ? err.message : '导入失败',
      }),
      async execute(args, run) {
        const report = run.service.capabilities.propose.ingestTextFile(requireRoot(run), {
          receiptId: args.receipt_id,
          sessionId: run.sessionId(),
          ...(args.start_chapter !== undefined ? { startChapter: args.start_chapter } : {}),
          ...(args.force ? { force: true } : {}),
        });
        if (!report.ok) {
          throw new HarnessError(report.reason ?? '导入失败', 'INGEST_FAILED');
        }
        // §11 事件触发: 摄入对账 + 写作健康 + RAG 词法索引同步。
        await run.afterMutation({ radars: ['ingest'], rag: true });
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
      },
    }),

    chapterReview,
    chapterVersion,

    // ---- 11. 雷达巡检(§11 手动触发; 默认五面, 幂等 + 自动结算) ----
    tool({
      name: 'novelcraft_radar_sweep',
      description:
        '雷达巡检: 五面确定性扫描器对账收件箱信号(摄入/去重/建议/风险/写作; 幂等落盘 + ' +
        '条件消失自动结算 + 作者裁决不复活), 并返回一句话剧情摘要(宠物默认答复数据源)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        radar: { type: 'string', enum: [...RADARS], description: '只跑某一面(缺省全五面)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          results: { type: 'object', additionalProperties: true, required: true },
          plot_summary: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      async execute(args, run) {
        const r = await run.service.capabilities.propose.radarSweep(
          requireRoot(run),
          args.radar ? [args.radar] : undefined,
        );
        await run.afterMutation({ push: true });
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
      },
    }),
    // ---- 12. RAG 语义检索(只读; 索引由事件钩子维护, 本工具不触发同步) ----
    tool({
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
      async execute(args, run) {
        const r = await run.service.capabilities.read.ragSearch(requireRoot(run), args.query, {
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
      },
    }),

    // ---- 13. RAG 批量嵌入(L2; 后端不可用进入宿主失败通道) ----
    tool({
      name: 'novelcraft_rag_embed',
      description:
        '批量嵌入: 对索引中待向量化片段(pending/failed 且无 vector)调用本地 BGE 嵌入后端生成向量, ' +
        '逐批落盘 .assistant/rag-index.json(中断可重入)。需在 .assistant/llm.yml 设 embedding: bge-local-v1 ' +
        '且 @novelcraft/rag-bge 已安装; 未启用时返回可机读的宿主工具错误。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
      },
      output: {
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
      async execute(_args, run) {
        const r = await run.service.capabilities.propose.ragEmbed(requireRoot(run));
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
      },
    }),
    ...buildMapAtlasTools(ctx, service),
    ...buildWorkflowTools(ctx, service),
    ...buildBookTools(ctx, service),
    // ---- M12-a(N43): worldCreate/worldUpdate 工具入口(能力 N31 起已注册, 补齐作者可达面) ----
    tool({
      name: 'novelcraft_world_create',
      description:
        '创建世界对象(审批后执行): 写入 world/objects/(canonical 状态, 经 N32 事务精确提交)。' +
        'name 必填; entityType 缺省 object; 别名/标签/描述可选。同名对象已存在时拒绝。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        name: { type: 'string', required: true, description: '对象名(如「红衣女子」)' },
        entity_type: { type: 'string', description: "类型(缺省 'object'; 如 character/location/faction)" },
        aliases: { type: 'array', description: '别名列表(可选)' },
        tags: { type: 'array', description: '标签列表(可选)' },
        description: { type: 'string', description: '对象正文描述(可选)' },
        note: { type: 'string', description: '审批摘要补充说明(可选)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          slug: { type: 'string', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        // P1(review): entity_type 白名单 fail-fast —— core object schema 对 kind 只有
        // 类型检查无 enums(非法串会静默写成 kind 并被 relations 判定排除, 功能悄悄
        // 降级); 工具层先拒, core enums 补齐记 M12-b(N43 追记)。
        // 白名单与 core ENTITY_TYPES 同源(store 导出, 20 类; M12-b review P2-2 回收本地硬编码)。
        if (args.entity_type !== undefined && !(ENTITY_TYPES as readonly string[]).includes(args.entity_type)) {
          throw llmError('schema_violation',
            `entity_type 必须是 ENTITY_TYPES 白名单之一(收到: ${args.entity_type})`);
        }
        // schema 面数组是 JsonValue[]; 字符串化校验后收窄(schema type:array 元素未细化为
        // string, 运行时逐项校验 fail-closed, 不静默丢弃非字符串项)。
        const strList = (v: readonly unknown[] | undefined, what: string): string[] | undefined => {
          if (v === undefined) return undefined;
          const out = v.map((x) => {
            if (typeof x !== 'string') throw llmError('schema_violation', `${what} 必须是字符串数组`);
            return x;
          });
          return out;
        };
        const slug = await run.service.capabilities.adoptGuarded.worldCreate(
          run.agent,
          requireRoot(run),
          {
            name: args.name,
            entityType: args.entity_type ?? 'object',
            ...((): { aliases?: string[] } => { const v = strList(args.aliases, 'aliases'); return v ? { aliases: v } : {}; })(),
            ...((): { tags?: string[] } => { const v = strList(args.tags, 'tags'); return v ? { tags: v } : {}; })(),
            ...(args.description ? { description: args.description } : {}),
          },
          args.note,
        );
        return { ok: true, slug };
      },
    }),
    tool({
      name: 'novelcraft_world_update',
      description:
        '修改世界对象(审批后执行): 按对象 slug 定位 world/objects/ 内对象, 更新' +
        'name/tags/正文描述(经 N32 事务, 保留其余 frontmatter 与正文语义)。审批冻结' +
        '写前字节与 HEAD, 写前重验(并发修改 CAS 拒绝)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        slug: { type: 'string', required: true, description: '对象 slug(store_adopt/world 对象读面返回的 id)' },
        name: { type: 'string', description: '新名称(可选)' },
        tags: { type: 'array', description: '新标签列表(可选; 整组替换)' },
        description: { type: 'string', description: '新正文描述(可选; 整段替换)' },
        note: { type: 'string', description: '审批摘要补充说明(可选)' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          slug: { type: 'string', required: true },
        },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        const patch: { name?: string; description?: string; tags?: string[] } = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.name === undefined && args.tags === undefined && args.description === undefined) {
          throw llmError('schema_violation', '至少提供 name/tags/description 之一(空 patch 拒绝, 避免无意义审批+重排提交)');
        }
        if (args.tags !== undefined) {
          patch.tags = args.tags.map((x) => {
            if (typeof x !== 'string') throw llmError('schema_violation', 'tags 必须是字符串数组');
            return x;
          });
        }
        if (args.description !== undefined) patch.description = args.description;
        await run.service.capabilities.adoptGuarded.worldUpdate(
          run.agent,
          requireRoot(run),
          args.slug,
          patch,
          args.note,
        );
        return { ok: true, slug: args.slug };
      },
    }),
    // ---- M12-b(N44): outline 生成 preview/apply + world 生成中心只读模式 ----
    tool({
      name: 'novelcraft_outline_preview',
      description:
        '生成小说总纲 preview: 跑内容手(story_outline spec)并把结果暂存到 .assistant/proposals/' +
        '(带 prompt 指纹), **不写 structure/outline.md**。作者审阅/编辑暂存记录后, 用 ' +
        'novelcraft_outline_apply 显式采用(过审批)。返回 run_id 供 apply 引用。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '生成输入(当前设定摘要/方向要求等上下文)' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          run_id: { type: 'string', required: true },
          result_json: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.outlinePreview(requireRoot(run), args.input, run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, run_id: r.record.run_id, result_json: capReceipt(run, JSON.stringify(r.record.result)), error: '' };
      },
    }),
    tool({
      name: 'novelcraft_outline_apply',
      description:
        '采用总纲 preview(审批后执行): 把 .assistant/proposals/ 中该 run_id 的生成结果写入 ' +
        'structure/outline.md(canonical 覆写; 旧版本走 git 历史)。run_id 来自 outline_preview。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        run_id: { type: 'string', required: true, description: 'outline_preview 返回的 run_id' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, file: { type: 'string', required: true } },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        return { ok: true, ...(await run.service.capabilities.adoptGuarded.outlineApply(run.agent, requireRoot(run), args.run_id)) };
      },
    }),
    tool({
      name: 'novelcraft_outline_item_preview',
      description:
        '生成 P20 当前层(剧情线 plot_thread / 篇章纲 outline_arc)preview: 结果暂存 ' +
        '.assistant/proposals/(带 prompt 指纹), **不写 structure/**。用 ' +
        'novelcraft_outline_item_apply 显式采用(过审批)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        target: { type: 'string', required: true, description: "'plot_thread' | 'outline_arc'" },
        input: { type: 'string', required: true, description: '生成输入(当前层上下文/要求)' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          run_id: { type: 'string', required: true },
          result_json: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        if (args.target !== 'plot_thread' && args.target !== 'outline_arc') {
          throw llmError('schema_violation', "target 必须是 'plot_thread' 或 'outline_arc'");
        }
        const r = await run.service.capabilities.propose.outlineItemPreview(requireRoot(run), args.target, args.input, run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, run_id: r.record.run_id, result_json: capReceipt(run, JSON.stringify(r.record.result)), error: '' };
      },
    }),
    tool({
      name: 'novelcraft_outline_item_apply',
      description:
        '采用 P20 当前层 preview(审批后执行): 把该 run_id 的生成结果写入 structure/(thread/arc ' +
        '资产, canonical)。返回新资产 slug。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        run_id: { type: 'string', required: true, description: 'outline_item_preview 返回的 run_id' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, slug: { type: 'string', required: true } },
      },
      timeoutMs: 60_000,
      async execute(args, run) {
        return { ok: true, ...(await run.service.capabilities.adoptGuarded.outlineItemApply(run.agent, requireRoot(run), args.run_id)) };
      },
    }),
    tool({
      name: 'novelcraft_world_chat',
      description:
        '世界生成中心·共创聊天(M12-b/N44): 与内容手就世界设定自由共创对话, 纯 LLM 调用零写。' +
        '产出想法供作者参考; 要落资产请走 world_bible_suggest(工作稿)或 world_create(对象)。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '对话输入(设定材料+当前问题)' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, reply: { type: 'string', required: true }, error: { type: 'string', required: true } },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenChat(requireRoot(run), args.input, run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, reply: capReceipt(run, r.reply ?? ''), error: '' };
      },
    }),
    tool({
      name: 'novelcraft_world_converge',
      description: '世界生成中心·只读收束: 对给定设定材料做收敛分析(矛盾/缺口/可合并项), 零写。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '待收束的设定材料' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, result_json: { type: 'string', required: true }, error: { type: 'string', required: true } },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenConverge(requireRoot(run), args.input, run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, result_json: capReceipt(run, JSON.stringify(r.result)), error: '' };
      },
    }),
    tool({
      name: 'novelcraft_world_explore',
      description: '世界生成中心·一跳探索: 从既有设定出发探索相邻可能性(≤3 个方向), 不创建资产。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '探索锚点(当前设定摘要)' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, result_json: { type: 'string', required: true }, error: { type: 'string', required: true } },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenExplore(requireRoot(run), args.input, run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, result_json: capReceipt(run, JSON.stringify(r.result)), error: '' };
      },
    }),
    tool({
      name: 'novelcraft_world_inspect',
      description: '世界生成中心·页面检修: 对给定世界书页面/设定做语义检视, 返回 findings 供作者复核, 零写。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '待检视的页面内容/设定' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, result_json: { type: 'string', required: true }, error: { type: 'string', required: true } },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenInspect(requireRoot(run), args.input, run.signal);
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, result_json: capReceipt(run, JSON.stringify(r.result)), error: '' };
      },
    }),
    tool({
      name: 'novelcraft_world_bible_suggest',
      description:
        '世界生成中心·世界书页面建议(§6.17 语义): 生成页面提案并落 bible/ 为 draft 工作稿' +
        '(不是 canonical —— 采用请走 store_adopt 的 bible_page)。is_new_page=true 时按新页建议。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        input: { type: 'string', required: true, description: '页面建议输入(主题/已有页内容)' },
        is_new_page: { type: 'boolean', description: '是否按新页建议(缺省 false)' },
      },
      output: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, slug: { type: 'string', required: true }, error: { type: 'string', required: true } },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const r = await run.service.capabilities.propose.worldGenBibleSuggest(
          requireRoot(run), args.input, { ...(args.is_new_page ? { isNewPage: true } : {}) }, run.signal,
        );
        if (!r.ok) throw llmError(r.error?.kind, r.error?.message);
        return { ok: true, slug: r.slug ?? '', error: '' };
      },
    }),
  ];
}
