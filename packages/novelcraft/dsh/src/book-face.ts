// @novelcraft/dsh · 书库生命周期面(M11/N42, §6.13 多书生命周期公开化)。
// bookList: 只读枚举 vaultsDir 下全部书(book.yml 存在即书; 坏 frontmatter 容错列目录名)
//   + 当前会话绑定标记;
// bookCreateGuarded: 审批后 ensureVault 初始化新书(幂等: 已有则返回既有, 不动现有文件);
// bookOpenGuarded: 审批后把当前会话绑定切换到既有书(binder.bindSession 原子切换,
//   引用计数 0→1 激活 watch);
// bookList/create/open 均为「未绑定也可用」的入口(发现/创建第一本书是 M11 的目的),
// 隔离纪律: 无 agent(无会话上下文)一律 WORKSPACE_ISOLATION(工具 execute 自验);
// 不接受模型提供的绝对路径 —— 目标书一律按书名(rootForBook + validateBookDirName
// + guardPath 防穿越), 与 N34 的「不退回任意 root 访问」同口径。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { expandHome, type Config } from './config.js';
import type { NovelCraftService } from './service.js';

export interface BookListItem {
  /** 书目录名(即 vault 目录名, 唯一键) */
  book: string;
  /** book.yml 的 title(缺省/坏 frontmatter → 目录名) */
  title: string;
  /** vault 根绝对路径 */
  root: string;
  /** 是否为指定会话当前绑定的书 */
  current: boolean;
}

/** 解析 book.yml title(容错: 坏 YAML/非字符串 → undefined)。 */
function readBookTitle(root: string): string | undefined {
  try {
    const text = readFileSync(join(root, 'book.yml'), 'utf8');
    const m = text.match(/^title:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m);
    if (!m) return undefined;
    return (m[1] ?? m[2] ?? m[3] ?? '').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** 枚举 vaultsDir 下全部书(目录含 book.yml 即书; 目录序按名排序)。 */
export function bookList(config: Config, currentRoot?: string): BookListItem[] {
  const dir = expandHome(config.vaultsDir);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: BookListItem[] = [];
  for (const name of entries) {
    const root = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(root).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (!existsSync(join(root, 'book.yml'))) continue; // 非书目录(含 .zcode 等杂项)
    const title = readBookTitle(root) ?? name;
    out.push({ book: name, title, root, current: currentRoot !== undefined && root === currentRoot });
  }
  return out;
}

/** 工具隔离自验: 无 agent(无会话上下文)的书库状态操作一律拒绝(与 N34 同 code)。 */
export function requireAgentForBooks(exec: { agent?: unknown }): void {
  if (!exec.agent) {
    throw new HarnessError('书库操作需要会话上下文(无 agent)', 'WORKSPACE_ISOLATION');
  }
}

/** 创建新书(审批后): ensureVault 幂等初始化; 返回绑定描述(审批在 service 方法内,
 *  工具只经 capabilities.adoptGuarded —— N35 源码扫描纪律)。 */
export async function bookCreateGuarded(
  service: NovelCraftService,
  agent: Parameters<NovelCraftService['deepImport']>[0],
  book: string,
): Promise<{ book: string; root: string; created: boolean }> {
  // 校验先于审批(review P2-1): 非法书名零审批拒绝(rootForBook 内 validateBookDirName)。
  service.vaults.rootForBook(book);
  const existed = service.vaults.readVault(service.vaults.rootForBook(book)) !== undefined;
  const decision = await service.approval.request(agent, {
    action: '创建新书',
    summary: `在书库创建新书「${book}」(初始化 book.yml + 目录骨架 + git 仓库)` +
      (existed ? '; 注意: 同名书已存在, 将直接返回既有(幂等, 不动现有文件)' : ''),
    items: [`书名: ${book}`],
  });
  if (decision !== 'allowed-once') {
    throw new HarnessError(`创建新书未获批准(${decision}), 零初始化(fail-closed)`, 'BOOK_CREATE_REJECTED');
  }
  const binding = service.vaults.ensureVault(book);
  return { book: binding.book, root: binding.root, created: !existed };
}

/** 切换当前会话到既有书(审批后): binder 原子改绑(引用计数/watch 语义由 binder 管)。 */
export async function bookOpenGuarded(
  service: NovelCraftService,
  agent: Parameters<NovelCraftService['deepImport']>[0],
  sessionId: string,
  book: string,
): Promise<{ book: string; root: string; activated: boolean; count: number }> {
  // 校验先于审批(review P2-1): 目标书不存在零审批拒绝; 摘要写明从哪本切到哪本。
  const target = service.vaults.readVault(service.vaults.rootForBook(book));
  if (target === undefined) {
    throw new HarnessError(
      `书不存在: ${book}(vaultsDir 下无此 book.yml)。请先 book_list 确认或 book_create 创建`,
      'BOOK_NOT_FOUND',
    );
  }
  const current = await service.vaults.resolve(sessionId).catch(() => undefined);
  const decision = await service.approval.request(agent, {
    action: '切换当前会话的书',
    summary: `把当前会话的工作区绑定从「${current?.book ?? '未绑定'}」切换到「${book}」(后续创作工具将作用于该书)`,
    items: [`当前: ${current?.book ?? '未绑定'}`, `目标书: ${book}`],
  });
  if (decision !== 'allowed-once') {
    throw new HarnessError(`切换书未获批准(${decision}), 绑定不变(fail-closed)`, 'BOOK_OPEN_REJECTED');
  }
  const transition = await service.vaults.bindSession(sessionId, target);
  // 切绑后驱动守望生命周期(review P1-1): 新书 0→1 激活、旧书 →0 停止 —— 与
  // session/created|disposed 走同一 nodeRuntime 面(ADR-0023)。
  if (transition.activated) await service.nodeRuntime.activate(target);
  if (transition.deactivatedRoot !== undefined) {
    await service.nodeRuntime.deactivate(transition.deactivatedRoot);
  }
  return { book: target.book, root: target.root, ...transition };
}
