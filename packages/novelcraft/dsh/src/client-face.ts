// @novelcraft/dsh · 客户端 UI 面(service.ui; ADR-0018 loopback RPC 的宿主侧数据源)。
// 收敛 client 此前绕过 seam 的平行读面: 只读聚合(view)、收据暂存(stage, 非正史)、
// 决定记录(records)、配置面(config, N19 不过审批)。client 经结构化接口消费
// ctx.novelcraft.ui, 不再直接 import 核心包运行时/裸 fs。
// 纪律: 本面不写 canonical 资产(铁律 3 —— adopt 类仍走 agent + ApprovalGate);
// stage/records 的信号推送尽力而为(通道缺省静默)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import path from 'node:path';
import * as assistant from '@novelcraft/assistant';
import {
  DEFAULT_CONTENT_PRESETS,
  resolvePolicy,
  selectPresetInLlmYml,
  selectReasoningEffortInLlmYml,
  type ResolvedPolicy,
} from '@novelcraft/llm-step';
import * as store from '@novelcraft/store';
import { assertNoSymlinkOnPath, assertSafePathSegment, guardPath, paths, type StagedFileIntake } from '@novelcraft/vault';
import * as world from '@novelcraft/world';
import * as writing from '@novelcraft/writing';
import type { NovelCraftCapabilities } from './capabilities.js';
import { pushSignalsChanged } from './push.js';
import { svc } from './ctx.js';
import type { NovelCraftService } from './service.js';

/** 图片预览上限: ≤2MB 给 base64 data URL, 大图只回元数据与相对路径(计划 Phase 6)。 */
const ATLAS_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** 预设条目的结构形状(client PresetLike 同形; ContentPreset 的 JSON 投影)。 */
export type PresetLike = {
  name: string;
  label?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  timeout_ms?: number;
};

/** 页内章节编辑收据输入(与 writing.stageChapterEditIntake 同形)。 */
export type ChapterEditStageInput = Parameters<typeof writing.stageChapterEditIntake>[2];

export interface NovelcraftUiFace {
  /** 复用冻结只读命名空间(收件箱/章节读面/地图册视图; N35 sanction 不变)。 */
  readonly read: NovelCraftCapabilities['read'];
  readonly view: {
    /** 该书执行策略(llm.yml 直读: watch 阈值 + 活动 preset 等轻量读面)。 */
    vaultPolicy(root: string): ResolvedPolicy;
    /** 一句话剧情摘要(宠物默认答复数据源; §9)。 */
    plotSummary(root: string): string;
    /** 剧情地图聚合(§17.5)。 */
    storyMap(root: string): store.StoryMap;
    /** 全书派生索引(chapterIndex 读面; 文件唯一真相可随时重建)。 */
    chapterIndex(root: string): store.VaultIndex;
    /** 各章审查摘要卡(.assistant/reviews 容错投影)。 */
    reviewSummaries(root: string): writing.ReviewSummaryCard[];
    /** 最新一条续写提案(全章; 无则 undefined)。 */
    latestProposal(root: string): writing.ProposalRecord | undefined;
    /** 指定 next_chapter 的最新提案(无则 undefined)。 */
    latestProposalForChapter(root: string, nextChapter: number): writing.ProposalRecord | undefined;
    /** 单章资产档案(§17.5.1 逐资产容错)。 */
    chapterDossier(root: string, chapterIndex: number): store.ChapterDossier;
    /** 章节历史线卡(store.chapterHistoryCardView 唯一映射)。 */
    chapterHistoryCards(root: string, chapterIndex: number): store.ChapterHistoryCardView[];
    /** 精确 current 候选快照(无候选抛错, 调用方容错)。 */
    chapterCandidate(root: string, chapterIndex: number, ref: string): writing.ChapterCandidateSnapshot;
    /** chapters/pending 有效候选章节索引(升序; 与索引章合并去重由调用方)。 */
    pendingChapterRefs(root: string): number[];
    /** 结构健康扫描(确定性 + 幂等落盘; 写作台打开时刷新)。 */
    scanHealth(root: string): Promise<assistant.HealthScanResult>;
    /** 标注队列只读状态(文件/ops/涉及页)。 */
    atlasQueueStatus(root: string): world.AtlasAnnotationQueueStatus;
    /** 地图页图片预览 data URL(≤2MB; 失败/超限/缺失 → undefined)。 */
    atlasImagePreview(root: string, file: string, mediaType: string, byteSize: number): string | undefined;
    /** 种子预设名单(最小 profile 无注册表面时 client 兜底展示; N20)。 */
    presetSeeds(): PresetLike[];
  };
  readonly stage: {
    /** 文本手稿收据(会话绑定; 零正史写)+ 摄入提示信号 + 信号变化推送。 */
    stageTextIntake(root: string, sessionId: string, fileName: string, bytes: Uint8Array): StagedFileIntake;
    /** 地图图片收据(节点锁定)+ 导入提示信号 + 推送。 */
    stageAtlasImageIntake(
      root: string,
      sessionId: string,
      fileName: string,
      bytes: Uint8Array,
      nodeRef: string,
    ): StagedFileIntake;
    /** 页内章节编辑收据(CAS 基线冻结)+ 保存提示信号 + 推送。 */
    stageChapterEditIntake(root: string, sessionId: string, input: ChapterEditStageInput): StagedFileIntake;
    /**
     * 标注请求入队 + 提示信号 + 推送。写边界(R9, fail-closed): queueDir 由
     * paths() 限定(guard + 逐段 symlink 检查), page_ref 经 assertSafePathSegment
     * 双保险为单文件段; 目标文件若被预置为 symlink —— 包括指向 vault 内 signals
     * 等其他文件的内部链接(guardPath 的 real containment 会放行, 而 writeFileSync
     * 会跟随链接改写 vault 内他处; 读面的目录枚举只收普通文件, 链接队列文件会被
     * 忽略 → 写读不一致) —— 由 assertNoSymlinkOnPath 显式拒绝任意 symlink
     * (外部/内部/悬空一律不写)。应用仍由助手工具消费队列(CAS + 单 commit, N35)。
     */
    queueAtlasAnnotations(
      root: string,
      pageRef: string,
      baseContentHash: string,
      ops: readonly unknown[],
    ): { file: string };
  };
  readonly records: {
    /** 收件箱四动词(决定记录; 与 capabilities.propose.actOnSignal 同源, 内含推送)。 */
    actOnSignal: NovelCraftService['actOnSignal'];
  };
  readonly config: {
    /** 选预设卡(N19: 配置非资产, 不过审批; 只写 llm.yml preset 单键; 未知名由调用方校验)。 */
    selectPreset(root: string, preset: string | null): void;
    /** Exact-model reasoning options; every call resolves the live adapter and does not cache. */
    reasoningOptions(root: string): Promise<ReasoningOptionsView>;
    /** Validate against the current exact route, then write only reasoning_effort. */
    selectReasoningEffort(root: string, effort: string | null): Promise<void>;
    /** Validate a preset's effort against its own exact route before writing preset. */
    selectPresetValidated(
      root: string,
      preset: string,
      route: { provider: string; model: string; reasoningEffort?: string },
    ): Promise<void>;
  };
}

export interface ReasoningOptionsView {
  provider: string;
  model: string;
  selected: string | null;
  adapterDefault: string | null;
  efforts: Array<{ id: string; name: string; description?: string }>;
}

function bestEffortPush(ctx: Context, root: string): void {
  try {
    pushSignalsChanged(ctx, { root });
  } catch {
    // 推送通道缺省时静默(ADR-0018); 收据/决定已落盘不受影响。
  }
}

/** 构建 service.ui(构造期一次; 深冻结防运行时替换)。ctx 显式传入(Service.ctx 为 protected)。 */
export function createNovelcraftClientFace(ctx: Context, service: NovelCraftService): NovelcraftUiFace {
  const resolveReasoning = async (
    provider: string,
    model: string,
    selected: string | null,
  ): Promise<ReasoningOptionsView> => {
    const llm = svc<LlmRuntime>(ctx, 'llm');
    if (!llm) throw new Error('DSH llm 服务不可用，无法读取思考等级');
    const info: LlmResolvedModelInfo = await llm.resolveModelInfo(provider, model);
    return {
      provider,
      model,
      selected,
      adapterDefault: info.reasoning?.defaultEffort ?? null,
      efforts: (info.reasoning?.efforts ?? []).map((effort) => ({
        id: effort.id,
        name: effort.name,
        ...(effort.description !== undefined ? { description: effort.description } : {}),
      })),
    };
  };
  const assertEffort = async (provider: string, model: string, effort: string): Promise<void> => {
    const options = await resolveReasoning(provider, model, effort);
    if (!options.efforts.some((candidate) => candidate.id === effort)) {
      throw new Error(`当前模型不支持思考等级「${effort}」，配置未写入`);
    }
  };
  const face: NovelcraftUiFace = {
    read: service.capabilities.read,
    view: Object.freeze({
      vaultPolicy: (root) => resolvePolicy(root),
      plotSummary: (root) => assistant.plotSummaryLine(root),
      storyMap: (root) => store.storyMap(root),
      chapterIndex: (root) => store.rebuildIndex(root),
      reviewSummaries: (root) => writing.reviewSummaries(root),
      latestProposal: (root) => writing.latestProposal(root),
      latestProposalForChapter: (root, nextChapter) => writing.latestProposalForChapter(root, nextChapter),
      chapterDossier: (root, chapterIndex) => store.chapterDossier(root, chapterIndex),
      chapterHistoryCards: (root, chapterIndex) =>
        store.listChapterHistory(root, chapterIndex).map((entry) => store.chapterHistoryCardView(entry)),
      chapterCandidate: (root, chapterIndex, ref) => writing.readChapterCandidate(root, chapterIndex, ref),
      pendingChapterRefs: (root) => writing.pendingChapterRefs(root),
      scanHealth: (root) => assistant.scanHealthSignalsAtomic(root),
      atlasQueueStatus: (root) => world.atlasAnnotationQueueStatus(root),
      atlasImagePreview: (root, file, mediaType, byteSize) => {
        try {
          const abs = guardPath(root, path.join(paths(root).world.atlas.dir, file));
          if (!existsSync(abs) || byteSize > ATLAS_PREVIEW_MAX_BYTES) return undefined;
          return `data:${mediaType};base64,${readFileSync(abs).toString('base64')}`;
        } catch {
          return undefined; // 预览失败只回元数据(不炸)。
        }
      },
      presetSeeds: () => DEFAULT_CONTENT_PRESETS,
    }),
    stage: Object.freeze({
      stageTextIntake: (root, sessionId, fileName, bytes) => {
        const staged = writing.stageTextIntake(root, sessionId, fileName, bytes);
        assistant.pushSignal(root, {
          radar: 'ingest',
          severity: 'hint',
          title: `手稿「${staged.fileName}」已授权, 等待导入`,
          evidence: [`receipt:${staged.receiptId}`, `sha256:${staged.sha256}`],
          proposed_action: `调用 novelcraft_ingest_file(root, receipt_id=${staged.receiptId}) 导入该手稿`,
          reversibility: true,
        });
        bestEffortPush(ctx, root);
        return staged;
      },
      stageAtlasImageIntake: (root, sessionId, fileName, bytes, nodeRef) => {
        const staged = world.stageAtlasImageIntake(root, sessionId, fileName, bytes, nodeRef);
        assistant.pushSignal(root, {
          radar: 'suggest',
          severity: 'hint',
          title: `地图图片「${staged.fileName}」已授权, 等待导入`,
          evidence: [`receipt:${staged.receiptId}`, `node:${nodeRef}`, `sha256:${staged.sha256}`],
          proposed_action: `调用 novelcraft_map_atlas_upload(root, receipt_id=${staged.receiptId}) 导入到节点 ${nodeRef}`,
          reversibility: true,
        });
        bestEffortPush(ctx, root);
        return staged;
      },
      stageChapterEditIntake: (root, sessionId, input) => {
        const staged = writing.stageChapterEditIntake(root, sessionId, input);
        assistant.pushSignal(root, {
          radar: 'writing',
          severity: 'hint',
          title: `第 ${input.chapterIndex} 章编辑已暂存, 等待审批保存`,
          evidence: [`receipt:${staged.receiptId}`, `base:${input.expectedContentHash}`, `sha256:${staged.sha256}`],
          proposed_action: `调用 novelcraft_chapter_version(action=save, receipt_id=${staged.receiptId}) 保存第 ${input.chapterIndex} 章`,
          reversibility: true,
          target: { chapter_index: input.chapterIndex },
        });
        bestEffortPush(ctx, root);
        return staged;
      },
      queueAtlasAnnotations: (root, pageRef, baseContentHash, ops) => {
        assertSafePathSegment(pageRef, 'page_ref');
        const queueDir = paths(root).assistant.atlas.annotationQueue;
        const file = guardPath(root, path.join(queueDir, `${pageRef}.json`));
        assertNoSymlinkOnPath(root, file);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          JSON.stringify(
            { page_ref: pageRef, base_content_hash: baseContentHash, ops },
            null,
            2,
          ),
          'utf8',
        );
        assistant.pushSignal(root, {
          radar: 'suggest',
          severity: 'hint',
          title: `地图页「${pageRef}」有 ${ops.length} 个标签修改待应用`,
          evidence: [file],
          proposed_action: `调用 novelcraft_map_atlas_annotation(root, page_ref=${pageRef}) 应用标签修改(只消费队列, 不生成坐标)`,
          reversibility: true,
          expires_when_draft_changes: false,
        });
        bestEffortPush(ctx, root);
        return { file };
      },
    }),
    records: Object.freeze({
      actOnSignal: service.actOnSignal.bind(service),
    }),
    config: Object.freeze({
      selectPreset: (root, preset) => {
        selectPresetInLlmYml(root, preset);
      },
      reasoningOptions: async (root) => {
        const profile = await service.resolveProfile(root);
        if (!profile.provider || !profile.model) throw new Error('当前书未解析出 provider/model');
        return resolveReasoning(profile.provider, profile.model, profile.reasoning_effort ?? null);
      },
      selectReasoningEffort: async (root, effort) => {
        if (effort !== null) {
          const profile = await service.resolveProfile(root);
          if (!profile.provider || !profile.model) throw new Error('当前书未解析出 provider/model');
          await assertEffort(profile.provider, profile.model, effort);
        }
        selectReasoningEffortInLlmYml(root, effort);
      },
      selectPresetValidated: async (root, preset, route) => {
        if (route.reasoningEffort !== undefined) {
          await assertEffort(route.provider, route.model, route.reasoningEffort);
        }
        selectPresetInLlmYml(root, preset);
      },
    }),
  };
  return Object.freeze(face);
}
