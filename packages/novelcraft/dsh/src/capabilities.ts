// N35 / ADR-0024 — misuse-resistant NovelCraftService capability surface.
// 数据驱动声明表: 每个能力只落笔一次(方法名即能力名), 命名空间类型与冻结对象
// 均由表推导 —— 重命名/加能力改一处, 不再接口+工厂双写漂移。
// adoptGuarded 因能力名≠方法名(storeAdopt→adoptGuarded 等)使用 [能力, 方法] 对表。
import type { NovelCraftService } from './service.js';

type MethodName = {
  [K in keyof NovelCraftService]: NovelCraftService[K] extends (...args: never[]) => unknown ? K : never
}[keyof NovelCraftService];
type Bound<K extends MethodName> = NovelCraftService[K] extends (...args: infer A) => infer R ? (...args: A) => R : never;

/** 自名能力表(能力名 = service 方法名): read/propose 两层。 */
const READ_METHODS = [
  'viewMapAtlas',
  'inbox',
  'ragSearch',
  'chapterCurrent',
  'chapterHistory',
  'chapterDiff',
  'chapterReview',
  // M10-A review(N39 ②): 工具回执上界读取走声明表 —— 工具不得直读 service.config
  // (N35 源码扫描只放行 capabilities./vaults.)。
  'receiptLimit',
  // M10-B1(N40): 长任务恢复只读面(durable run 枚举 + checkpoint 概要)。
  'workflowInspect',
  // M11(N42): 书库只读枚举。
  'bookList',
] as const satisfies readonly MethodName[];

const PROPOSE_METHODS = [
  'runStep',
  'actOnSignal',
  'planMapAtlas',
  'importAtlasImage',
  'updateAtlasPrompt',
  'createAtlasUploadNode',
  'proposeNextChapter',
  'generateNextChapter',
  'ingestTextFile',
  'reviewChapter',
  'reviseChapter',
  'rejectChapterFinding',
  'rejectChapterCandidate',
  'scanHealth',
  'radarSweep',
  'refreshIndex',
  'ragSync',
  'ragEmbed',
] as const satisfies readonly MethodName[];

/** 审批门控能力表: [能力名, service 方法名](adoptGuarded 族)。 */
const ADOPT_PAIRS = [
  ['storeAdopt', 'adoptGuarded'],
  ['worldCreate', 'worldCreateGuarded'],
  ['worldUpdate', 'worldUpdateGuarded'],
  ['reviewMapAtlas', 'reviewMapAtlasGuarded'],
  ['deepImport', 'deepImport'],
  ['saveChapter', 'saveChapterGuarded'],
  ['restoreChapter', 'restoreChapterGuarded'],
  // M10-B1(N40): 长任务恢复动作面(§6.9/§6.6)。注: workflowAbandon 清理的是
  // .assistant 机器状态(非 canonical adopt), 归 guarded 因其破坏性删除 + git 写面
  // (ADR-0024 三分法的保守扩展, N40)。
  ['bookCreate', 'bookCreateGuarded'],
  ['bookOpen', 'bookOpenGuarded'],
  ['workflowResume', 'workflowResumeGuarded'],
  ['workflowStartNew', 'workflowStartNewGuarded'],
  ['workflowAbandon', 'workflowAbandonGuarded'],
] as const satisfies ReadonlyArray<readonly [string, MethodName]>;

/** 自名方法列表 → 命名空间类型(键 = 方法名)。 */
type NamespaceOf<Methods extends readonly MethodName[]> = {
  [M in Methods[number]]: Bound<M>;
};

/** [能力, 方法] 对表 → 命名空间类型(键 = 能力名, 值 = 对应方法签名)。 */
type NamespaceOfPairs<Pairs extends ReadonlyArray<readonly [string, MethodName]>> = {
  [E in Pairs[number] as E[0]]: Bound<E[1]>;
};

export type NovelCraftReadCapabilities = NamespaceOf<typeof READ_METHODS>;

export interface NovelCraftAuthorEditCapabilities {
  /** ADR-0020 exception: fixed annotations field + queue provenance + content-hash CAS; no ApprovalGate. */
  annotations: Bound<'applyAtlasAnnotationQueue'>;
}

export type NovelCraftProposeCapabilities = NamespaceOf<typeof PROPOSE_METHODS> & {
  authorEdit: NovelCraftAuthorEditCapabilities;
};

export type NovelCraftAdoptGuardedCapabilities = NamespaceOfPairs<typeof ADOPT_PAIRS>;

export interface NovelCraftCapabilities {
  read: NovelCraftReadCapabilities;
  propose: NovelCraftProposeCapabilities;
  adoptGuarded: NovelCraftAdoptGuardedCapabilities;
}

function bind<K extends MethodName>(service: NovelCraftService, key: K): Bound<K> {
  const method = service[key];
  if (typeof method !== 'function') throw new Error(`NovelCraft capability method unavailable: ${String(key)}`);
  return method.bind(service) as Bound<K>;
}

function bindSelf<Methods extends readonly MethodName[]>(
  service: NovelCraftService,
  methods: Methods,
): NamespaceOf<Methods> {
  const out: Record<string, unknown> = {};
  // 宽化到非泛型列表再迭代(泛型元素作索引会被推断成 unique symbol)。
  for (const method of methods as readonly MethodName[]) {
    out[method as string] = bind(service, method);
  }
  return Object.freeze(out) as NamespaceOf<Methods>;
}

function bindPairs<Pairs extends ReadonlyArray<readonly [string, MethodName]>>(
  service: NovelCraftService,
  pairs: Pairs,
): NamespaceOfPairs<Pairs> {
  const out: Record<string, unknown> = {};
  // 宽化到非泛型对表再迭代: 泛型元组解构会把键侧推断成 unique symbol。
  for (const pair of pairs as ReadonlyArray<readonly [string, MethodName]>) {
    out[pair[0]] = bind(service, pair[1]);
  }
  return Object.freeze(out) as NamespaceOfPairs<Pairs>;
}

/** Build once in the service constructor; frozen namespaces prevent runtime replacement/route confusion. */
export function createNovelCraftCapabilities(service: NovelCraftService): NovelCraftCapabilities {
  const capabilities: NovelCraftCapabilities = {
    read: bindSelf(service, READ_METHODS),
    propose: Object.freeze({
      ...bindSelf(service, PROPOSE_METHODS),
      authorEdit: Object.freeze({ annotations: bind(service, 'applyAtlasAnnotationQueue') }),
    }),
    adoptGuarded: bindPairs(service, ADOPT_PAIRS),
  };
  return Object.freeze(capabilities);
}
