// @novelcraft/dsh · 地图册工具(规划/视图/上传/生命周期/标注队列/prompt 更新)。
// 一律经 novelcraftToolFactory 定义(N34 隔离/toolError 映射)。
// 有意排除 afterMutation: atlas 页不在 radar/rag 语料面(§11 事件映射无 atlas 事件),
// 维持现状零雷达零索引副作用; 若未来纳入语料, 在 EVENT_RADAR_MAP 加事件键即可。
import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { NovelCraftService } from '../service.js';
import { novelcraftToolFactory } from './define.js';

export function buildMapAtlasTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  const tool = novelcraftToolFactory(ctx, service);
  return [
    tool({
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
      timeoutMs: 3_600_000,
      async execute(args, run) {
        const result = await run.service.capabilities.propose.planMapAtlas(run.root, {
          run_kind: args.full_rebuild ? 'initial' : 'update',
          style_note: args.style_note,
          include_working_drafts: args.include_working_drafts,
          include_interiors: args.include_interiors,
          full_rebuild: args.full_rebuild,
        }, run.signal, undefined, run.agent);
        if (result.run.status === 'failed') {
          throw new HarnessError(result.run.error_message || '地图册规划失败', 'MAP_ATLAS_PLAN_FAILED');
        }
        const evidence = (result.run.spatial_evidence ?? {}) as {
          supported?: unknown[];
          visual_fill?: unknown[];
          conflicts?: unknown[];
          degraded?: boolean;
          reused?: boolean;
        };
        const evidenceSummary = JSON.stringify({
          supported: evidence.supported?.length ?? 0,
          visual_fill: evidence.visual_fill?.length ?? 0,
          conflicts: evidence.conflicts?.length ?? 0,
          degraded: evidence.degraded === true,
          reused: evidence.reused === true,
        });
        return {
          ok: true,
          run_id: result.run.id,
          status: result.run.status,
          planned_page_count: result.run.planned_page_count,
          error_code: result.run.error_code ?? '',
          evidence_summary: evidenceSummary,
          message: result.run.planned_page_count === 0
            ? '无变化(missing/changed/new 均空), 未调用 LLM。'
            : `已规划 ${result.run.planned_page_count} 页候选(prompt_only); 上传图片后走 novelcraft_map_atlas_review adopt。`,
        };
      },
    }),

    tool({
      name: 'novelcraft_map_atlas_view',
      description:
        '地图册只读视图: 已采用树(图片页/空页占位/image_missing 派生位) + 候选(pending nodes/pages) + 指定或最近 run 摘要。' +
        '图片以相对路径返回(images/<page>/<attempt>.<ext>), 不读字节。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        run_id: { type: 'string', description: '指定 run(缺省 = 最近一次)' },
      },
      output: {
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
      async execute(args, run) {
        const { tree, run: atlasRun } = run.service.capabilities.read.viewMapAtlas(run.root, args.run_id);
        return {
          ok: true,
          adopted_nodes: tree.nodes.length,
          adopted_pages: tree.pages.length,
          pending_nodes: tree.pendingNodes.length,
          pending_pages: tree.pendingPages.length,
          tree: JSON.stringify(tree),
          run: atlasRun ? JSON.stringify(atlasRun) : '',
          message: `已采用 ${tree.nodes.length} 节点/${tree.pages.length} 页; 候选 ${tree.pendingNodes.length} 节点/${tree.pendingPages.length} 页。`,
        };
      },
    }),

    tool({
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
      async execute(args, run) {
        const result = run.service.capabilities.propose.importAtlasImage(run.root, {
          receiptId: args.receipt_id,
          sessionId: run.sessionId(),
        });
        return {
          ok: true,
          page_id: result.page.id,
          node_ref: result.page.node_ref,
          generation_status: result.page.generation_status,
          image: result.page.image?.file ?? '',
          message: `已导入候选图 ${result.page.image?.file ?? ''}(页 ${result.page.id}); 采用请走 novelcraft_map_atlas_review。`,
        };
      },
    }),

    tool({
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
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      async execute(args, run) {
        const result = await run.service.capabilities.adoptGuarded.reviewMapAtlas(
          run.agent,
          run.root,
          { pageRef: args.page_ref, nodeRef: args.node_ref },
          args.action,
          { confirmConflicts: args.confirm_conflicts, expectedContentHash: args.expected_content_hash, note: args.note },
        );
        return { ok: true, action: args.action, message: result.detail };
      },
    }),

    tool({
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
      async execute(_args, run) {
        const result = await run.service.capabilities.propose.authorEdit.annotations(run.root);
        const status: 'complete' | 'partial' | 'no_change' = result.failed > 0
          ? 'partial'
          : result.files === 0 ? 'no_change' : 'complete';
        return {
          ok: true,
          status,
          applied: result.applied,
          queue_files: result.files,
          message: result.files === 0
            ? '标注队列为空(.assistant/atlas/annotation-queue/ 无文件)。'
            : `已消费 ${result.files} 个队列文件, 应用 ${result.applied} 条标注${result.failed > 0 ? `(失败 ${result.failed}: ${result.errors.join('; ')})` : ''}。`,
        };
      },
    }),

    tool({
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
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          page_id: { type: 'string', required: true },
          content_hash: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      async execute(args, run) {
        const page = await run.service.capabilities.propose.updateAtlasPrompt(
          run.root,
          args.page_ref,
          args.prompt,
          args.expected_content_hash,
        );
        return { ok: true, page_id: page.id, content_hash: page.content_hash, message: `已更新页 ${page.id} 的 prompt。` };
      },
    }),
  ];
}
