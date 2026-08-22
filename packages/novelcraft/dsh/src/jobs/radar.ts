// @novelcraft/dsh · 雷达调度(ctx.jobs 适配)。
// seam 契约(packages/novelcraft/README.md): 雷达调度 → DSH ctx.jobs(每雷达一轮 =
// 一个 job)+ ctx.schedule(低频巡检, 默认关 D6)。
// 依据: 设计文档 §7(六雷达)/§11(阈值触发 N3)/§22.3(assistant seam = jobs,
// schedule, goal)。本包实现 jobs 调度 + 可选 interval(经宿主 ctx.setInterval,
// 由 cordis-plugin-timer 提供; 缺失时 watch.enabled 静默退化为按需巡检)。
// goal(整体目标)归 DSH 会话级 goal 子系统, 不在本包实现 —— 巡检轮由
// agent/工具显式触发, 或 watch.enabled 时由 interval 触发。
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JobId, JobKindMap, JobRegistry, JobStart } from '@deepseek-ai/dsh-jobs';
import type { RadarKind } from '@novelcraft/assistant';
import { svc } from '../ctx.js';
import type { ManagedRadarJob, RadarJobHost } from './watch-state.js';
import type { VaultBinding } from '../vault/binding.js';

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    /** 每个 NovelCraft 雷达巡检轮一个 job(id 前缀 novelcraft-radar)。 */
    'novelcraft-radar': 'novelcraft-radar';
  }
}

/** 声明合并后, 本包内直接用字面量标注 JobStart.kind 类型。 */
export const RADAR_JOB_KIND = 'novelcraft-radar' as JobKindMap['novelcraft-radar'];

export interface RadarRoundSpec {
  /** 巡检的 vault 根 */
  root: string;
  /** 雷达种类(ingest/dedup/suggest/plot/risk/writing) */
  radar: RadarKind;
  /** 一句话标签(模型可见的 job label; 缺省按雷达名生成) */
  label?: string;
  /** 归属 agent(会话围栏/取消随 agent); 缺省为 unowned job */
  owner?: Agent;
  /** 每轮输出字节上限 */
  outputLimitBytes?: number;
}

export type RadarWork = (signal: AbortSignal) => Promise<string>;

export interface RadarRoundResult {
  jobId: JobId;
}

const RADAR_LABELS: Record<RadarKind, string> = {
  ingest: '摄入雷达: 未摄入素材',
  dedup: '去重雷达: 重复对象/关系',
  suggest: '建议雷达: 世界补全建议',
  plot: '剧情雷达: 伏笔/连贯性',
  risk: '风险雷达: 设定冲突风险',
  writing: '写作雷达: 正文审查',
};

/**
 * 雷达巡检调度器: 把一轮巡检包成 DSH job(kind=novelcraft-radar)。
 * work 必须遵守 signal(取消时尽快停手); 输出经 done 的 output 字段进 job 终端结果。
 */
export class RadarScheduler {
  private readonly ctx: Context;

  constructor(ctx: Context) {
    this.ctx = ctx;
  }

  /** 同步发起一轮巡检, 返回 job id(不等待完成; 经 ctx.jobs.wait/read 收尾)。 */
  start(spec: RadarRoundSpec, work: RadarWork): JobId {
    const managed = this.startManaged(spec, work);
    // 旧 id-only API 没有 done 消费者；失败仍由 JobRegistry 记录，避免派生 Promise 未处理。
    void managed.done.catch(() => undefined);
    return managed.jobId;
  }

  /**
   * N34 watch scheduler seam：返回只管理本 radar job 的 done/cancel 句柄。
   * owner 缺省时明确创建 unowned job，session disposal 不会由 DSH 自动误杀。
   */
  startManaged(spec: RadarRoundSpec, work: RadarWork): ManagedRadarJob & { jobId: JobId } {
    let aborter: AbortController | undefined;
    let cancelled = false;
    let publishStarted!: () => void;
    let outcome!: ReturnType<JobStart['run']>['done'];
    const started = new Promise<void>((resolve) => { publishStarted = resolve; });
    const specStart: JobStart = {
      kind: RADAR_JOB_KIND,
      label: spec.label ?? RADAR_LABELS[spec.radar],
      ...(spec.outputLimitBytes !== undefined ? { outputLimitBytes: spec.outputLimitBytes } : {}),
      ...(spec.owner ? { owner: spec.owner } : {}),
      run: () => {
        aborter = new AbortController();
        outcome = (async () => {
          try {
            const output = await work(aborter.signal);
            return { status: cancelled ? ('killed' as const) : ('completed' as const), output };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              status: cancelled ? ('killed' as const) : ('failed' as const),
              detail: message.slice(0, 400),
            };
          }
        })();
        publishStarted();
        return {
          cancel: (reason?: string) => {
            cancelled = true;
            aborter?.abort(reason);
          },
          done: outcome,
        };
      },
    };
    const jobs = svc<JobRegistry>(this.ctx, 'jobs');
    if (!jobs) throw new Error('ctx.jobs 服务不可用(雷达巡检需要 jobs 插件)');
    const jobId = jobs.start(specStart);
    const done = started.then(async () => {
      const terminal = await outcome;
      if (terminal.status !== 'completed') throw new Error(terminal.detail ?? `radar job ${terminal.status}`);
    });
    return {
      id: String(jobId),
      jobId,
      done,
      cancel: (reason) => {
        const status = jobs.kill(jobId, undefined, reason);
        if (status === 'already-finished') return;
      },
    };
  }

  /**
   * 可选的低频巡检 interval(watch.enabled 时由宿主调用)。
   * 宿主需保证 ctx.setInterval 可用(cordis-plugin-timer); 不可用时返回 undefined。
   */
  startInterval(
    minutes: number,
    makeRound: () => { root: string; radar: RadarKind; label?: string; owner?: Agent } | undefined,
    work: RadarWork,
  ): (() => void) | undefined {
    const timerCtx = this.ctx as Context & {
      setInterval?: (cb: () => void, ms: number) => (() => void) | void;
    };
    if (typeof timerCtx.setInterval !== 'function') return undefined;
    return (timerCtx.setInterval(() => {
      const round = makeRound();
      if (round) this.start(round, work);
    }, minutes * 60_000) as () => void) ?? undefined;
  }
}

/** 把通用 RadarScheduler 适配成 ActiveVaultWatchScheduler 的逐 radar job host。 */
export class DshRadarJobHost implements RadarJobHost {
  constructor(
    private readonly scheduler: RadarScheduler,
    private readonly work: (binding: VaultBinding, radar: RadarKind, signal: AbortSignal) => Promise<string>,
  ) {}

  start(binding: VaultBinding, radar: RadarKind): ManagedRadarJob {
    return this.scheduler.startManaged(
      { root: binding.root, radar },
      (signal) => this.work(binding, radar, signal),
    );
  }
}
