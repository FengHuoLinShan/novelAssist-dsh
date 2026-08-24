// @novelcraft/dsh · agent 工具注册(ctx.tools seam)。
// §22.3/§12: 原语工具面同名映射为「文件背书插件工具」; 采用类写操作经
// ApprovalGate(fail-closed), 读操作直通。工具名统一 novelcraft_ 前缀。
// 取消贯通: 五个内容手工具(llm_step/deep_import/propose/generate/map_atlas_plan)
// 把 exec.signal 传 service(service 层 withAbortSignal 与 llm-step timeout 合并)。
// tools 服务缺失时静默跳过注册(最小 profile/纯进程内测试仍可用服务门面)。
// 工具一律经 novelcraftToolFactory 定义: schema 推断 args 类型、N34 隔离、
// toolError 单点映射、afterMutation 副作用纪律由包装器结构性保证。
import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { svc } from './ctx.js';
import { importTraceFile } from './deep-import.js';
import type { NovelCraftService } from './service.js';
import { novelcraftToolFactory } from './tools/define.js';
import { buildMapAtlasTools } from './tools/map-atlas.js';
import { buildWritingTools } from './tools/writing.js';
import { llmError } from './tools/shared.js';

export { WorkspaceIsolationError } from './tools/shared.js';

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

function buildTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
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
            ...(args.max_tokens !== undefined ? { maxTokens: args.max_tokens } : {}),
            ...(args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
          },
          fixAttempts: args.fix_attempts ?? 1,
        }, run.root, run.signal);
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
        const index = run.service.capabilities.propose.refreshIndex(run.root);
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
          run.root,
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
        const signals = run.service.capabilities.read.inbox(run.root, args.content_hash);
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
          run.root,
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
        '多章为长任务, 建议由编排层分批触发; 本工具同步执行并返回摘要。',
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
        const result = await run.service.capabilities.adoptGuarded.deepImport(run.agent, run.root, {
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
          trace_file: importTraceFile(run.root),
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
        const r = await run.service.capabilities.propose.scanHealth(run.root);
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
        const report = run.service.capabilities.propose.ingestTextFile(run.root, {
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
          run.root,
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
        const r = await run.service.capabilities.read.ragSearch(run.root, args.query, {
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
        const r = await run.service.capabilities.propose.ragEmbed(run.root);
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
  ];
}
