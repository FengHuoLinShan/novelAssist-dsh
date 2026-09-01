// @novelcraft/dsh · outline 生成 preview/apply 面(M12-b/N44, 台账 §6.18.2)。
// preview(propose): core previewStoryOutline/previewOutlineItem → 暂存 .assistant/proposals/,
//   不写 structure 资产(promptFingerprint 随记录可回放);
// apply(adoptGuarded): 审批后 applyStoryOutlinePreview/applyOutlineItemPreview →
//   writeOutline/writeStructureAsset(canonical 写, N32 事务由 write* 内部承接);
// world 生成中心只读四模式(propose): worldChat/Converge/Explore/Inspect 纯 LLM 调用
//   零写; suggestBiblePage 落 bible/ draft 提案(采用走 store_adopt bible_page, §6.17 语义)。
import * as outline from '@novelcraft/outline';
import * as world from '@novelcraft/world';
import type { Provider, StepResult } from '@novelcraft/llm-step';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { NovelCraftService } from './service.js';

export type OutlinePreviewOk = { ok: true; file: string; record: outline.OutlinePreviewRecord };
export type OutlinePreviewErr = { ok: false; error: StepResult['error'] };

/** 内容手 provider 解析(与 service.contentProviderFor 同源; preview 用 root 绑定画像;
 * signal 透传工具取消——M12-b review P2-5: 内层 spec 超时 1800s 须可被外层取消)。 */
async function providerFor(service: NovelCraftService, root: string, signal?: AbortSignal): Promise<Provider> {
  return service.contentProviderFor(root, signal);
}

/** 总纲 preview: 暂存 proposals, 不写 structure/outline.md。 */
export async function outlinePreview(
  service: NovelCraftService, root: string, selection: outline.OutlineContextSelection, signal?: AbortSignal,
): Promise<OutlinePreviewOk | OutlinePreviewErr> {
  return outline.previewStoryOutlineSelected(await providerFor(service, root, signal), root, selection);
}

/** P20 当前层 preview: 暂存 proposals, 不写 thread/arc。 */
export async function outlineItemPreview(
  service: NovelCraftService, root: string, target: 'plot_thread' | 'outline_arc', selection: outline.OutlineContextSelection,
signal?: AbortSignal,
): Promise<OutlinePreviewOk | OutlinePreviewErr> {
  return outline.previewOutlineItemSelected(await providerFor(service, root, signal), root, target, selection);
}

/** apply 总纲 preview(审批内执行 canonical 写)。 */
export async function outlineApplyGuarded(
  service: NovelCraftService, agent: Agent | undefined, root: string, runId: string,
): Promise<{ file: string }> {
  return service.approval.guard(agent, {
    action: '采用总纲 preview',
    summary: `把 preview ${runId} 的总纲生成结果写入 structure/outline.md(canonical 覆写, 历史走 git)`,
    items: [`preview: ${runId}`],
  }, async () => {
    outline.applyStoryOutlinePreviewSelected(root, runId);
    return { file: 'structure/outline.md' };
  });
}

/** apply P20 当前层 preview(审批内执行 canonical 写; 返回新资产 slug)。 */
export async function outlineItemApplyGuarded(
  service: NovelCraftService, agent: Agent | undefined, root: string, runId: string,
): Promise<{ slug: string }> {
  return service.approval.guard(agent, {
    action: '采用结构资产 preview',
    summary: `把 preview ${runId} 的 P20 生成结果写入 structure/(thread/arc, canonical)`,
    items: [`preview: ${runId}`],
  }, async () => {
    const slug = outline.applyOutlineItemPreviewSelected(root, runId);
    return { slug };
  });
}

// —— world 生成中心只读模式(propose; 纯 LLM 调用零写) ——

export async function worldGenChat(service: NovelCraftService, root: string, selection: world.WorldContextSelection, signal?: AbortSignal) {
  return world.worldChatSelected(await providerFor(service, root, signal), root, selection);
}

export async function worldGenConverge(service: NovelCraftService, root: string, selection: world.WorldContextSelection, signal?: AbortSignal) {
  return world.worldConvergeSelected(await providerFor(service, root, signal), root, selection);
}

export async function worldGenExplore(service: NovelCraftService, root: string, selection: world.WorldContextSelection, signal?: AbortSignal) {
  return world.worldExploreSelected(await providerFor(service, root, signal), root, selection);
}

export async function worldGenInspect(service: NovelCraftService, root: string, selection: world.WorldContextSelection, signal?: AbortSignal) {
  return world.worldInspectSelected(await providerFor(service, root, signal), root, selection);
}

/** 世界书页面建议 → bible/ draft 提案(采用另走 store_adopt; §6.17 页面建议只落工作稿)。 */
export async function worldGenBibleSuggest(
  service: NovelCraftService, root: string, selection: world.WorldContextSelection, opts: { isNewPage?: boolean }, signal?: AbortSignal,
) {
  return world.suggestBiblePageSelected(await providerFor(service, root, signal), root, selection, opts);
}
