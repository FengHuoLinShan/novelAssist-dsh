// @novelcraft/dsh · 地图册编排面(service.ts 的 map-atlas 段抽离; 领域逻辑不变)。
// planMapAtlas: immutable run + artifact/receipt/cursor + apply probe(N33);
// reviewMapAtlasDecision: 页/节点生命周期审批门控(铁律 3 fail-closed, N35 archive 无旁路)。
// service 方法保持原签名委托此处, capabilities 按名绑定不受影响。
import type { Agent } from '@deepseek-ai/dsh-agent';
import * as llmStep from '@novelcraft/llm-step';
import * as store from '@novelcraft/store';
import * as world from '@novelcraft/world';
import { GateDeniedError } from './approval/gate.js';
import type { ExecutionProfile } from './llm/execution-profile.js';
import { requireTrustedExecutionProfile } from './llm/execution-profile.js';
import type { ApprovalGate } from './approval/gate.js';
import type { NovelCraftService } from './service.js';

/** 地图册生产编排(N33): immutable run + artifact/receipt/cursor + apply probe。 */
export async function planMapAtlasRun(
  service: NovelCraftService,
  root: string,
  opts: world.AtlasWorkflowOptions,
  signal?: AbortSignal,
  profile?: ExecutionProfile,
  agent?: Agent,
): Promise<world.AtlasWorkflowResult> {
  const approval = service.approval;
  const resolved =
    profile !== undefined ? requireTrustedExecutionProfile(profile, root) : await service.resolveProfile(root);
  const provider = await service.contentProviderFor(root, signal, resolved);
  const toApprovalDecision = (decision: string): import('@novelcraft/trace').ApprovalDecision =>
    decision === 'allowed-once' ? 'allowed-once' : decision === 'unavailable' ? 'unavailable' : 'rejected';
  return world.runAtlasWorkflow(root, opts, {
    provider,
    profileFingerprint: llmStep.fingerprintExecutionProfile(resolved),
    contractVersions: resolved.contractVersions ?? {},
    ...(resolved.workflowBudget !== undefined
      ? { budget: llmStep.createWorkflowBudget(resolved.workflowBudget) }
      : {}),
    approve: async (action, summary, items) => {
      if (agent === undefined) return 'unavailable';
      return toApprovalDecision(await approval.request(agent, { action, summary, items, ...(signal ? { signal } : {}) }));
    },
    reauthorizeRemaining: async ({ workflowId, batches, estimate }) => {
      if (agent === undefined) return 'unavailable';
      return toApprovalDecision(await approval.request(agent, {
        action: 'authorize_map_atlas_resume',
        summary: `恢复地图册 ${workflowId}: ${estimate}`,
        items: batches.map((batch) => `阶段 ${batch.phase}(${batch.batchId})`),
        ...(signal ? { signal } : {}),
      }));
    },
  });
}

/**
 * 地图页/节点生命周期(审批门控, 铁律 3 fail-closed):
 * adopt / adopt_placeholder / restore / archive 均经 ApprovalGate(allowed-once 只放行
 * 一次, rejected/cancelled/unavailable 一律拒绝, fail-closed; N35: archive 是 canonical
 * 资产状态迁移, 工具无旁路); reject 为候选面操作(候选 → rejected 终态, 非 canonical), 直执行。
 */
export async function reviewMapAtlasDecision(
  approval: ApprovalGate,
  agent: Agent | undefined,
  root: string,
  target: { pageRef?: string; nodeRef?: string },
  action: 'adopt' | 'adopt_placeholder' | 'reject' | 'archive' | 'restore',
  opts: { confirmConflicts?: boolean; expectedContentHash?: string; note?: string } = {},
): Promise<{ ok: true; detail: string }> {
  const approve: world.AtlasApprove = async (a, summary, items) => {
    const decision = await approval.request(agent, { action: a, summary, items });
    if (decision !== 'allowed-once') {
      throw new GateDeniedError(decision, `未获批准, 已放弃「${a}」(决策: ${decision})`);
    }
    return 'allowed-once';
  };
  switch (action) {
    case 'adopt': {
      if (!target.pageRef) throw new store.StoreError('VALIDATION_FAILED', 'adopt 需要 page_ref');
      const r = await world.adoptAtlasPage(root, target.pageRef, {
        confirmConflicts: opts.confirmConflicts,
        expectedContentHash: opts.expectedContentHash,
        note: opts.note,
      }, approve);
      return { ok: true, detail: `已采用地图页 ${r.page.id}(连带节点 ${r.adoptedNodeIds.join('/') || '无'})` };
    }
    case 'adopt_placeholder': {
      if (!target.nodeRef) throw new store.StoreError('VALIDATION_FAILED', 'adopt_placeholder 需要 node_ref');
      const r = await world.adoptAtlasPlaceholder(root, target.nodeRef, approve);
      return { ok: true, detail: `已采用空页占位节点 ${r.adoptedNodeIds.join('/')}` };
    }
    case 'reject': {
      if (!target.pageRef) throw new store.StoreError('VALIDATION_FAILED', 'reject 需要 page_ref');
      const page = await world.rejectAtlasPage(root, target.pageRef, { note: opts.note, expectedContentHash: opts.expectedContentHash });
      return { ok: true, detail: `已驳回地图页 ${page.id}(终态 rejected)` };
    }
    case 'archive': {
      if (!target.pageRef) throw new store.StoreError('VALIDATION_FAILED', 'archive 需要 page_ref');
      // N35: archive(adopted → deprecated)是 canonical 资产状态迁移, 必须 ApprovalGate
      // allowed-once, 工具无旁路。审批前读快照 hash 作强制 CAS 基线(审批后写前重验,
      // 与 adopt/restore 同 R17/CAS 语义: 审批期间被改/已 commit 的页一律 CONFLICT 零写)。
      const adopted = world.readAtlasTree(root).pages.find((p) => p.id === target.pageRef);
      if (!adopted) throw new store.StoreError('NOT_FOUND', `已采用页不存在: ${target.pageRef}`);
      const preHash = adopted.content_hash;
      const decision = await approve('map_atlas.archive_page', `归档地图页 ${adopted.title}(${target.pageRef})`, [target.pageRef]);
      if (decision !== 'allowed-once') {
        throw new store.StoreError('VALIDATION_FAILED', `archive 审批未通过(${decision}), fail-closed 零写`);
      }
      const page = await world.archiveAtlasPage(root, target.pageRef, { expectedContentHash: preHash });
      return { ok: true, detail: `已归档地图页 ${page.id}(deprecated, 可 restore)` };
    }
    case 'restore': {
      if (!target.pageRef) throw new store.StoreError('VALIDATION_FAILED', 'restore 需要 page_ref');
      const r = await world.restoreAtlasPage(root, target.pageRef, approve, { expectedContentHash: opts.expectedContentHash });
      return { ok: true, detail: `已恢复地图页 ${r.page.id}(祖先链补齐 ${r.adoptedNodeIds.join('/') || '无'})` };
    }
  }
}
