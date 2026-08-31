// @novelcraft/dsh · 写作域工具(计划台提案/生成、单章审查闭环、单章版本工作流)。
// 一律经 novelcraftToolFactory 定义(N34 隔离/toolError 映射/afterMutation 副作用纪律)。
import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { chapterHistoryCardView } from '@novelcraft/store';
import * as writing from '@novelcraft/writing';
import type { NovelCraftService } from '../service.js';
import { novelcraftToolFactory } from './define.js';
import { requireRoot, llmError } from './shared.js';

function reviewFindingCards(findings: readonly writing.ReviewFinding[]): Array<Record<string, string>> {
  return findings.map((finding) => ({
    finding_id: finding.finding_id,
    category: finding.category,
    severity: finding.severity,
    quote: finding.quote,
    suggestion: finding.suggestion,
  }));
}

export function buildWritingTools(ctx: Context, service: NovelCraftService): ToolDefinition[] {
  const tool = novelcraftToolFactory(ctx, service);
  return [
    tool({
      name: 'novelcraft_propose_next_chapter',
      description:
        '计划台续写提案: 基于总纲/剧情线/上一章结尾, 生成下一章 2–3 条续写方向(各带依据/成本/风险)。' +
        '结果落 .assistant/proposals/(临时预览, 不写正文); 选定一条后再按需走 writing_generate。',
      parameters: {
        root: { type: 'string', required: true, description: 'vault 根绝对路径' },
        chapter: { type: 'integer', required: true, description: '当前最后一章序号(1 起); 提案其下一章' },
      },
      output: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          next_chapter: { type: 'integer', required: true },
          proposals: { type: 'array', required: true },
          message: { type: 'string', required: true },
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const result = await run.service.capabilities.propose.proposeNextChapter(requireRoot(run), args.chapter, run.signal);
        if (!result.ok || !result.proposal) {
          throw llmError(result.error?.kind, result.error?.message ?? '提案失败');
        }
        return {
          ok: true,
          next_chapter: result.proposal.next_chapter,
          proposals: result.proposal.proposals.map((proposal) => ({
            title: proposal.title,
            premise: proposal.premise,
            basis: proposal.basis ?? [],
            cost: proposal.cost ?? '',
            risk: proposal.risk ?? '',
          })),
          message: `已生成 ${result.proposal.proposals.length} 条下一章方案(选定后可按需 writing_generate 出正文候选)。`,
        };
      },
    }),

    tool({
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
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          file: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      timeoutMs: 300_000,
      async execute(args, run) {
        const result = await run.service.capabilities.propose.generateNextChapter(requireRoot(run), args.chapter, {
          proposalTitle: args.proposal_title,
          ...(args.premise ? { premise: args.premise } : {}),
        }, run.signal);
        if (!result.ok) throw llmError(result.error?.kind, result.error?.message ?? '生成失败');
        await run.afterMutation({ radars: ['generate'] });
        return {
          ok: true,
          file: result.file ?? '',
          message: `已生成第 ${args.chapter + 1} 章候选(chapters/pending); 采用请走 novelcraft_store_adopt。`,
        };
      },
    }),

    tool({
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
      timeoutMs: 1_800_000,
      async execute(args, run) {
        const target = args.target;
        const ref = args.ref ?? String(args.chapter).padStart(3, '0');
        const blank = {
          ok: true as const,
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
        if (args.action === 'inspect') {
          const review = run.service.capabilities.read.chapterReview(requireRoot(run), args.chapter, target, ref);
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
          const result = await run.service.capabilities.propose.reviewChapter(
            requireRoot(run),
            args.chapter,
            target,
            target === 'candidate' ? ref : undefined,
            run.signal,
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
          const result = await run.service.capabilities.propose.reviseChapter(requireRoot(run), args.chapter, args.finding_ids, run.signal);
          if (!result.ok) throw llmError(result.error?.kind, result.error?.message ?? '返修失败');
          await run.afterMutation({ radars: ['generate'] });
          return { ...blank, file: result.file ?? '', message: `第 ${args.chapter} 章返修候选已生成；采用前必须独立审查 candidate。` };
        }
        if (args.action === 'reject_finding') {
          if (target !== 'current' || !args.review_id || !args.finding_id || !args.reason) {
            throw new HarnessError('reject_finding 缺少 current/review_id/finding_id/reason', 'INVALID_ARGUMENT');
          }
          await run.service.capabilities.propose.rejectChapterFinding(
            requireRoot(run), args.chapter, args.review_id, args.finding_id, args.reason,
          );
          return { ...blank, review_id: args.review_id, message: `已打回 finding ${args.finding_id} 并记录理由。` };
        }
        if (args.action === 'reject') {
          if (target !== 'candidate' || !args.reason || !args.expected_content_hash) {
            throw new HarnessError('reject 缺少 candidate/reason/expected_content_hash', 'INVALID_ARGUMENT');
          }
          const result = await run.service.capabilities.propose.rejectChapterCandidate(
            requireRoot(run), args.chapter, ref, args.expected_content_hash, args.reason,
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
          const result = await run.service.capabilities.adoptGuarded.storeAdopt(
            run.agent,
            requireRoot(run),
            'chapter_candidate',
            ref,
            args.expected_content_hash ? { expectedContentHash: args.expected_content_hash } : {},
            `采用第 ${args.chapter} 章候选 ${ref}`,
          );
          await run.afterMutation({ radars: ['adopt', 'adoptChapterCandidate'], rag: true });
          return {
            ...blank,
            commit: result.commit,
            message: `第 ${args.chapter} 章候选已采用(commit ${result.commit.slice(0, 12)})。`,
          };
        }
        throw new HarnessError('action 非法', 'INVALID_ARGUMENT');
      },
    }),

    tool({
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
      async execute(args, run) {
        const blank = {
          ok: true as const,
          action: args.action,
          chapter: args.chapter,
          content_hash: '',
          commit: '',
          body: '',
          history: [] as Array<Record<string, string | number | boolean>>,
          diff: '',
          truncated: false,
        };
        if (args.action === 'inspect') {
          const current = run.service.capabilities.read.chapterCurrent(requireRoot(run), args.chapter);
          return {
            ...blank,
            content_hash: current.contentHash,
            commit: current.head,
            body: current.body,
            message: `第 ${args.chapter} 章当前正文已读取(${current.status})。`,
          };
        }
        if (args.action === 'history') {
          // 映射走 store.chapterHistoryCardView 唯一事实源; 工具展示层补 title 空串回退。
          const history = run.service.capabilities.read.chapterHistory(requireRoot(run), args.chapter)
            .map((entry) => {
              const card = chapterHistoryCardView(entry);
              return { ...card, title: card.title ?? '' };
            });
          return {
            ...blank,
            history,
            message: `第 ${args.chapter} 章共有 ${history.length} 条可见 Git 版本。`,
          };
        }
        if (args.action === 'diff') {
          if (!args.commit) throw new HarnessError('diff 缺少 commit', 'INVALID_ARGUMENT');
          const diff = run.service.capabilities.read.chapterDiff(requireRoot(run), args.chapter, args.commit, args.compare_commit);
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
          const result = await run.service.capabilities.adoptGuarded.saveChapter(
            run.agent,
            requireRoot(run),
            run.sessionId(),
            args.receipt_id,
          );
          if (!result.skipped) {
            await run.afterMutation({ radars: ['ingest'], rag: true });
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
          const result = await run.service.capabilities.adoptGuarded.restoreChapter(
            run.agent,
            requireRoot(run),
            args.chapter,
            args.commit,
            args.expected_content_hash,
          );
          if (!result.skipped) {
            await run.afterMutation({ radars: ['ingest'], rag: true });
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
      },
    }),
  ];
}
