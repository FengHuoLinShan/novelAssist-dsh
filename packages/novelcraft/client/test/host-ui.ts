// 测试辅助: 用核心包构建 NovelcraftHostService['ui'] 的真实行为实现
// (与 @novelcraft/dsh service.ui 同形; 生产宿主由 dsh 提供, 测试侧镜像以满足
// 结构 seam 契约)。R9/预览/入队纪律与旧版 rpc 内联实现逐字一致。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { act, inboxView, plotSummaryLine, pushSignal, scanHealthSignals } from '@novelcraft/assistant';
import {
  DEFAULT_CONTENT_PRESETS,
  resolvePolicy,
  selectPresetInLlmYml,
  selectReasoningEffortInLlmYml,
} from '@novelcraft/llm-step';
import {
  chapterDossier,
  chapterHistoryCardView,
  diffChapterVersions,
  listChapterHistory,
  readCurrentChapter,
  rebuildIndex,
  storyMap,
} from '@novelcraft/store';
import {
  assertNoSymlinkOnPath,
  assertSafePathSegment,
  guardPath,
  paths,
  type StagedFileIntake,
} from '@novelcraft/vault';
import {
  atlasAnnotationQueueStatus,
  latestAtlasRun,
  readAtlasRun,
  readAtlasTree,
  stageAtlasImageIntake,
} from '@novelcraft/world';
import {
  latestCandidateReview,
  latestProposal,
  latestProposalForChapter,
  latestReview,
  pendingChapterRefs,
  readChapterCandidate,
  reviewSummaries,
  stageChapterEditIntake,
  stageTextIntake,
} from '@novelcraft/writing';
import type { NovelcraftHostService, PresetLike } from '../src/rpc.js';

const ATLAS_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** 构建宿主 ui 面(测试镜像实现)。 */
export function makeHostUi(
  listPresets: () => Promise<PresetLike[]> = async () => [...DEFAULT_CONTENT_PRESETS],
): NovelcraftHostService['ui'] {
  return {
    read: {
      inbox: (root) => inboxView(root),
      chapterCurrent: (root, chapterIndex) => readCurrentChapter(root, chapterIndex),
      chapterDiff: (root, chapterIndex, fromCommit, toCommit) =>
        diffChapterVersions(root, chapterIndex, fromCommit, toCommit),
      chapterReview: (root, chapterIndex, target, ref) =>
        target === 'candidate'
          ? latestCandidateReview(root, chapterIndex, ref ?? String(chapterIndex).padStart(3, '0'))
          : latestReview(root, chapterIndex),
      viewMapAtlas: (root, runId) => ({
        tree: readAtlasTree(root),
        run: runId ? readAtlasRun(root, runId) : latestAtlasRun(root),
      }),
      bookList: () => [],
    },
    view: {
      vaultPolicy: (root) => resolvePolicy(root),
      plotSummary: (root) => plotSummaryLine(root),
      storyMap: (root) => storyMap(root),
      chapterIndex: (root) => rebuildIndex(root),
      reviewSummaries: (root) => reviewSummaries(root),
      latestProposal: (root) => latestProposal(root),
      latestProposalForChapter: (root, nextChapter) => latestProposalForChapter(root, nextChapter),
      chapterDossier: (root, chapterIndex) => chapterDossier(root, chapterIndex),
      chapterHistoryCards: (root, chapterIndex) =>
        listChapterHistory(root, chapterIndex).map((entry) => chapterHistoryCardView(entry)),
      chapterCandidate: (root, chapterIndex, ref) => readChapterCandidate(root, chapterIndex, ref),
      pendingChapterRefs: (root) => pendingChapterRefs(root),
      scanHealth: async (root) => {
        scanHealthSignals(root);
        return { created: 0, skipped: 0, resolved: 0, reopened: 0, total: 0 };
      },
      atlasQueueStatus: (root) => atlasAnnotationQueueStatus(root),
      atlasImagePreview: (root, file, mediaType, byteSize) => {
        try {
          const abs = guardPath(root, path.join(paths(root).world.atlas.dir, file));
          if (!existsSync(abs) || byteSize > ATLAS_PREVIEW_MAX_BYTES) return undefined;
          return `data:${mediaType};base64,${readFileSync(abs).toString('base64')}`;
        } catch {
          return undefined;
        }
      },
      presetSeeds: () => DEFAULT_CONTENT_PRESETS,
    },
    stage: {
      stageTextIntake: (root, sessionId, fileName, bytes): StagedFileIntake => {
        const staged = stageTextIntake(root, sessionId, fileName, bytes);
        pushSignal(root, {
          radar: 'ingest',
          severity: 'hint',
          title: `手稿「${staged.fileName}」已授权, 等待导入`,
          evidence: [`receipt:${staged.receiptId}`, `sha256:${staged.sha256}`],
          proposed_action: `调用 novelcraft_ingest_file(root, receipt_id=${staged.receiptId}) 导入该手稿`,
          reversibility: true,
        });
        return staged;
      },
      stageAtlasImageIntake: (root, sessionId, fileName, bytes, nodeRef): StagedFileIntake => {
        const staged = stageAtlasImageIntake(root, sessionId, fileName, bytes, nodeRef);
        pushSignal(root, {
          radar: 'suggest',
          severity: 'hint',
          title: `地图图片「${staged.fileName}」已授权, 等待导入`,
          evidence: [`receipt:${staged.receiptId}`, `node:${nodeRef}`, `sha256:${staged.sha256}`],
          proposed_action: `调用 novelcraft_map_atlas_upload(root, receipt_id=${staged.receiptId}) 导入到节点 ${nodeRef}`,
          reversibility: true,
        });
        return staged;
      },
      stageChapterEditIntake: (root, sessionId, input): StagedFileIntake => {
        const staged = stageChapterEditIntake(root, sessionId, input);
        pushSignal(root, {
          radar: 'writing',
          severity: 'hint',
          title: `第 ${input.chapterIndex} 章编辑已暂存, 等待审批保存`,
          evidence: [`receipt:${staged.receiptId}`, `base:${input.expectedContentHash}`, `sha256:${staged.sha256}`],
          proposed_action: `调用 novelcraft_chapter_version(action=save, receipt_id=${staged.receiptId}) 保存第 ${input.chapterIndex} 章`,
          reversibility: true,
          target: { chapter_index: input.chapterIndex },
        });
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
          JSON.stringify({ page_ref: pageRef, base_content_hash: baseContentHash, ops }, null, 2),
          'utf8',
        );
        pushSignal(root, {
          radar: 'suggest',
          severity: 'hint',
          title: `地图页「${pageRef}」有 ${ops.length} 个标签修改待应用`,
          evidence: [file],
          proposed_action: `调用 novelcraft_map_atlas_annotation(root, page_ref=${pageRef}) 应用标签修改(只消费队列, 不生成坐标)`,
          reversibility: true,
          expires_when_draft_changes: false,
        });
        return { file };
      },
    },
    records: {
      actOnSignal: async (root, signalId, action, opts) =>
        act(root, {
          signalId,
          action,
          ...(opts?.reason ? { reason: opts.reason } : {}),
          ...(action === 'modify'
            ? {
                modified: {
                  ...(opts?.modifiedTitle ? { title: opts.modifiedTitle } : {}),
                  ...(opts?.modifiedProposedAction ? { proposed_action: opts.modifiedProposedAction } : {}),
                },
              }
            : {}),
        }),
    },
    config: {
      selectPreset: (root, preset) => {
        selectPresetInLlmYml(root, preset);
      },
      reasoningOptions: async (root) => ({
        provider: resolvePolicy(root).llm.provider ?? 'deepseek',
        model: resolvePolicy(root).llm.model ?? 'deepseek-v4-flash',
        selected: resolvePolicy(root).llm.reasoning_effort ?? null,
        adapterDefault: 'high',
        efforts: [
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
      }),
      selectReasoningEffort: async (root, effort) => {
        if (effort !== null && !['high', 'max'].includes(effort)) throw new Error('当前模型不支持该思考等级');
        selectReasoningEffortInLlmYml(root, effort);
      },
      selectPresetValidated: async (root, preset) => {
        const card = preset === null
          ? undefined
          : (await listPresets()).find((candidate) => candidate.name === preset);
        if (card?.reasoning_effort !== undefined && !['high', 'max'].includes(card.reasoning_effort)) {
          throw new Error('当前模型不支持该思考等级');
        }
        selectPresetInLlmYml(root, preset);
      },
    },
  };
}
