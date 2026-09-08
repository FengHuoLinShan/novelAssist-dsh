// @novelcraft/dsh · 常驻创作状态面(N53 / M13-A)。
// 经宿主 ctx.systemPrompt seam 注册: ①静态用法 section(稳定 prefix, KV-cache 友好)
// ②context 快照(durable user-role snapshot; compaction 只删派生 surface 消息, 不影响快照;
// 同 producer 后者取代前者)。官方消费者范式(dsh-user-approval): 全局注册一次,
// text provider 内按 ac.agent.session 分支——对接 SessionVaultBinder.peek(N53 同步只读面)。
// text provider 必须同步 → 重算在请求路径外: vault 激活预热 + afterMutation 触发 +
// 指纹漂移自愈(下次 assemble 调度重算, 本次返回旧值, 一个回合内收敛)。
// 依赖拓扑注记: 本模块是 dsh→@novelcraft/context 依赖的真实消费者(N48 删的是当时无
// 消费者的冗余依赖; 拓扑序 context(5) < dsh(13) 合规)。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import * as assistant from '@novelcraft/assistant';
import {
  buildResidentState,
  estimateContextTokens,
  renderResidentState,
  type ResidentStateInput,
} from '@novelcraft/context';
import * as store from '@novelcraft/store';
import { paths, validateInitializedVault } from '@novelcraft/vault';
import type { PromptConfig } from './config.js';
import type { ActiveVaultRuntime } from './lifecycle/node-runtime.js';
import type { SessionVaultBinder } from './vault/binding.js';

/** 静态用法说明(稳定 prefix; 不得含 `{{`——section 文本会被严格变量插值)。 */
const USAGE_SECTION_TEXT = [
  '[NovelCraft 常驻状态] 下方「当前书状态」快照来自作者的书库 vault, 是结构的权威摘要:',
  '快照在会话历史被压缩后仍然有效; 续写/审查/规划前先对照章游标、剧情线与逾期伏笔。',
  '快照只是导航摘要, 结构事实以 novelcraft 工具实时读取为准。',
].join('\n');

interface ResidentCacheEntry {
  text: string;
  hash: string;
  fingerprint: string;
  tokens: number;
}

/** 组合多个 ActiveVaultRuntime(顺序激活, 逆序停用; N53 状态面与 watch 调度共用生命周期)。 */
export function composeActiveVaultRuntimes(parts: readonly ActiveVaultRuntime[]): ActiveVaultRuntime {
  return {
    async activate(binding) {
      for (const part of parts) await part.activate(binding);
    },
    async deactivate(root) {
      for (let i = parts.length - 1; i >= 0; i -= 1) await parts[i].deactivate(root);
    },
    async stopAll() {
      for (let i = parts.length - 1; i >= 0; i -= 1) await parts[i].stopAll?.();
    },
  };
}

/** 采集精简 v1 读面(全只读)。逾期伏笔判定与 radar-risk 同规则:
 * planned_payoff_chapter < 当前最大章 且无 reveals_foreshadowing 边指向。 */
function gatherResidentInput(root: string): ResidentStateInput {
  const map = store.storyMap(root);
  return {
    book: map.book,
    chapters: map.chapters.map((c) => ({ index: c.index, title: c.title })),
    scenes: map.scenes.map((s) => ({ slug: s.slug, status: s.status })),
    threads: map.threads.map((t) => ({ slug: t.slug, name: t.name, status: t.status })),
    arcs: map.arcs.map((a) => ({ slug: a.slug, name: a.name, status: a.status })),
    foreshadowing: map.foreshadowing.map((f) => ({
      slug: f.slug,
      name: f.name,
      status: f.status,
      plannedPayoffChapter: f.planned_payoff_chapter,
      revealed: map.edges.some((e) => e.type === 'reveals_foreshadowing' && e.target === f.slug),
    })),
    openSignals: assistant.inboxView(root).map((s) => ({ severity: s.severity })),
  };
}

/** git HEAD 指纹: 工具链内写路径均经 N32 事务提交 → 分支 ref 文件 mtime 随每次 commit 移动。
 *  只读文件系统(不 spawn git 进程); 非正常 repo(worktree/packed-refs)退化常量, 保持缓存不空转。 */
function gitHeadFingerprint(root: string): string {
  try {
    const dotGit = path.join(root, '.git');
    if (!existsSync(dotGit)) return 'no-git';
    const stat = statSync(dotGit);
    let gitDir = dotGit;
    if (stat.isFile()) {
      gitDir = readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, '');
    }
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const refPath = path.join(gitDir, ref);
      if (existsSync(refPath)) return `${ref}@${statSync(refPath).mtimeMs}`;
      return `${ref}@packed`;
    }
    return `detached@${stat.mtimeMs}`;
  } catch {
    return 'unknown';
  }
}

/** 信号指纹: 收件箱决定(act/对账写信号文件但不 commit)→ 目录条目数 + 最新 mtime。 */
function signalsFingerprint(root: string): string {
  try {
    const dir = paths(root).assistant.signals;
    if (!existsSync(dir)) return 'none';
    let count = 0;
    let maxMtime = 0;
    for (const name of readdirSync(dir)) {
      count += 1;
      maxMtime = Math.max(maxMtime, statSync(path.join(dir, name)).mtimeMs);
    }
    return `${count}@${maxMtime}`;
  } catch {
    return 'unknown';
  }
}

function residentFingerprint(root: string): string {
  return `${gitHeadFingerprint(root)}|${signalsFingerprint(root)}`;
}

/** 常驻状态面: 注册 + 缓存 + 重算调度(全部尽力而为, 不进任何工具/请求主链)。 */
export class NovelcraftResidentStateFace {
  private readonly cache = new Map<string, ResidentCacheEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(
    private readonly ctx: Context,
    private readonly binder: SessionVaultBinder,
    private readonly config: PromptConfig,
  ) {}

  /** 挂到宿主 seam(systemPrompt 服务缺席时 Cordis 等待, 不阻塞其余面)。 */
  attach(): void {
    this.ctx.inject(['systemPrompt'], (scope) => {
      const disposeSection = scope.systemPrompt.section({
        name: 'novelcraft:usage',
        order: 300,
        text: USAGE_SECTION_TEXT,
      });
      const disposeContext = scope.systemPrompt.context({
        name: 'novelcraft:state',
        order: 130,
        text: (ac) => this.textFor((ac as { agent?: Agent }).agent),
      });
      scope.effect(() => () => {
        disposeContext();
        disposeSection();
      });
    });
  }

  /** ActiveVaultRuntime 面: 0→1 激活预热; 1→0 停用清缓存。 */
  asVaultRuntime(): ActiveVaultRuntime {
    return {
      activate: (binding) => {
        this.scheduleRefresh(binding.root, 'activate');
      },
      deactivate: (root) => {
        this.cache.delete(root);
      },
      stopAll: () => {
        this.stopped = true;
        this.cache.clear();
      },
    };
  }

  /** text provider(同步, 每 assemble 一次): 无 agent/未绑定 → 空文本(空贡献);
   *  冷缓存 → 调度重算并返回 ''; 指纹漂移 → 调度重算并返回旧值(下回合收敛)。 */
  textFor(agent: Agent | undefined): string {
    if (agent === undefined) return '';
    const sessionId = (agent as { session?: { id?: unknown } }).session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return '';
    const binding = this.binder.peek(sessionId);
    if (!binding) return '';
    const entry = this.cache.get(binding.root);
    if (entry === undefined) {
      this.scheduleRefresh(binding.root, 'cold');
      return '';
    }
    if (residentFingerprint(binding.root) !== entry.fingerprint) {
      this.scheduleRefresh(binding.root, 'drift');
    }
    return entry.text;
  }

  /** 重算入口(vault 激活 / afterMutation 漏斗; 去重合并, 异步不阻塞)。 */
  scheduleRefresh(root: string | undefined, trigger: string): void {
    void this.refreshNow(root, trigger);
  }

  /** 可等待重算(测试与确定性消费面); 与 scheduleRefresh 共享 inflight 去重。 */
  async refreshNow(root: string | undefined, trigger = 'manual'): Promise<void> {
    if (root === undefined || this.stopped) return;
    if (!validateInitializedVault(root).ok) return;
    const inflight = this.inflight.get(root);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        // 兑现「重算在请求路径外」(M13-A review P1-1): 让出同步段——compute 的
        // storyMap/rebuildIndexSnapshot 全量重扫不落在调用栈(text provider 的同步
        // assemble 路径 / afterMutation 的工具 await 链)内。inflight.set 仍在创建
        // 后的原同步段执行, 去重窗口保持原子。
        await new Promise<void>((resolve) => setImmediate(resolve));
        const entry = await this.compute(root);
        if (entry) {
          this.cache.set(root, entry);
          this.ctx.logger?.info?.(
            `[novelcraft] resident-state ${trigger} hash=${entry.hash} tokens=${entry.tokens}`);
        }
      } catch (err) {
        this.ctx.logger?.warn?.(
          `[novelcraft] resident-state ${trigger} 重算失败: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.inflight.delete(root);
      }
    })();
    this.inflight.set(root, task);
    return task;
  }

  private async compute(root: string): Promise<ResidentCacheEntry | undefined> {
    const fingerprint = residentFingerprint(root);
    const text = renderResidentState(buildResidentState(gatherResidentInput(root)), {
      maxTokens: this.config.maxTokens,
    });
    return {
      text,
      hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
      fingerprint,
      tokens: estimateContextTokens(text),
    };
  }
}

/** 创建并挂载常驻状态面; config.prompt.enabled=false 时返回 undefined(零注册零 IO)。 */
export function registerPromptStateFace(
  ctx: Context,
  binder: SessionVaultBinder,
  config: PromptConfig,
): NovelcraftResidentStateFace | undefined {
  if (!config.enabled) return undefined;
  const face = new NovelcraftResidentStateFace(ctx, binder, config);
  face.attach();
  return face;
}
