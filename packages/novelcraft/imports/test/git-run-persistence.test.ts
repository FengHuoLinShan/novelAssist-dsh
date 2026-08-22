// N33 / ADR-0022 — 生产持久化适配器(GitRunPersistence)行为契约测试。
// 真实临时 vault + @novelcraft/store executeTransaction: 覆盖
//  - 全部 state 写经 store 事务进 git 历史(run_bootstrap/state), 无裸写旁路;
//  - bootstrap crash → resume 先收敛同一事务补完(TOCTOU 由事务封闭);
//  - 窗口一(artifact intent 已耐久)/窗口二(commit 后 cursor 前)恢复不重跑 provider;
//  - tampered intent(path/bytes)→ 完整严格验证拒绝, 现场保留 fail-closed;
//  - force 新 run 前旧 intent 先收敛, 不覆盖旧 run;
//  - 预存 staged → 任何 state 写 fail-closed; artifact 字节篡改 → hash 对账失败;
//  - manifest 篡改 → load 严格校验拒绝; readBytes 精确字节/越界拒绝。
// 独立复审对抗测试(R7–R11, 全部 fail-closed):
//  - R7: expected 基线来自持久 HEAD 快照(工作树篡改不刷新基线, CAS 拒绝);
//        不可变文档(run plan/batch plan/artifact/receipt)恒 expected absent, 存在即冲突;
//  - R8: canonicalize 后拒绝 `.`/`..`/绝对/反斜杠/编码逃逸; 写面目标严格 ∈ 本 run root;
//  - R9: run plan/batch plan/artifact/receipt/manifest 工作树精确 == HEAD bytes;
//        文档 strict no-unknown + canonical 字节; artifact 身份绑定 committed batch plan;
//        cursor/run-status/apply 合法前态→后态转换;
//  - R10: READY intent 每 target 严格 ∈ 同一 canonical run root(混入 watch-state 拒绝保留);
//  - R11: store preflight 前零 mkdir(pre-staged 失败零目录副作用)。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import type { ApprovalDecision } from "@novelcraft/trace";
import {
  CrashSimulatedError,
  gitStatusPorcelain,
  type GatePhase,
  type TransactionOptions,
} from "@novelcraft/store";
import {
  GitRunPersistence,
  applyIdFor,
  batchPaths,
  canonicalRunJson,
  createWorkflowIdentity,
  makeBatchPlan,
  makeBatchReceipt,
  planDigestOf,
  runWorkflow,
  serializeBatchArtifact,
  workflowSha256,
  type ApplyApprovalRequest,
  type ApplyCanonicalRequest,
  type ApplyProbe,
  type BatchManifestEntry,
  type RunApplyPort,
  type RunBatchSpec,
  type RunEnginePorts,
  type RunEngineResult,
  type RunEngineSpec,
  type RunGeneratorInput,
  type RunGeneratorOutput,
  type RunGeneratorPort,
  type RunPlanDocument,
  type RunStateTransaction,
  type RunWorkflowManifest,
} from "../src/index.js";

const dirs: string[] = [];

function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "nci-gitrun-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (x: string) => workflowSha256(x);

function gitRun(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

class Gen implements RunGeneratorPort {
  calls: string[] = [];
  fail = new Set<string>();

  async generate(input: RunGeneratorInput): Promise<RunGeneratorOutput> {
    this.calls.push(input.batchId);
    if (this.fail.has(input.batchId)) throw new Error(`generator failure: ${input.batchId}`);
    const attempt = this.calls.filter((b) => b === input.batchId).length;
    return { payload: { text: `output-${input.batchId}-${attempt}` } };
  }
}

function spec(overrides: Partial<RunEngineSpec> = {}): RunEngineSpec {
  return {
    kind: "deep-import",
    inputFingerprint: sha("input-v1"),
    profileFingerprint: sha("profile-gpt"),
    uniqueRunId: "run-01",
    batches: [
      { phase: "slice", ordinal: 0, sourceIds: ["ch-1"], sourceHashes: { "ch-1": sha("ch1") } },
      { phase: "entities", ordinal: 1, sourceIds: ["scene-a"], sourceHashes: { "scene-a": sha("a") } },
    ],
    ...overrides,
  };
}

function workflowIdOf(s: RunEngineSpec): string {
  return createWorkflowIdentity({
    kind: s.kind,
    inputFingerprint: s.inputFingerprint,
    profileFingerprint: s.profileFingerprint,
    planDigest: planDigestOf(s),
    uniqueRunId: s.uniqueRunId,
  }).workflowId;
}

function expectedFor(s: RunEngineSpec) {
  return {
    workflowId: workflowIdOf(s),
    kind: s.kind,
    inputFingerprint: s.inputFingerprint,
    profileFingerprint: s.profileFingerprint,
    planDigest: planDigestOf(s),
  };
}

function batchIdOf(s: RunEngineSpec, ordinal: number): string {
  const batch = s.batches.find((b) => b.ordinal === ordinal)!;
  return makeBatchPlan({
    workflowId: workflowIdOf(s),
    phase: batch.phase,
    ordinal: batch.ordinal,
    inputFingerprint: s.inputFingerprint,
    sourceIds: batch.sourceIds,
    sourceHashes: batch.sourceHashes,
  }).batchId;
}

function portsOf(pers: GitRunPersistence, gen: Gen, apply?: RunApplyPort): RunEnginePorts {
  return { persistence: pers, generator: gen, ...(apply !== undefined ? { apply } : {}) };
}

/** 在第 txIndex 个事务到达 phase 时模拟 SIGKILL(store gates 注入; 之前副作用全保留)。 */
function crashAt(txIndex: number, phase: GatePhase): TransactionOptions {
  let seen = 0;
  return {
    gates: async (p: GatePhase) => {
      if (p === "intent-ready") seen += 1;
      if (p === phase && seen === txIndex) throw new CrashSimulatedError(`crash tx#${txIndex} @${phase}`);
    },
  };
}

function intentDir(root: string): string {
  let entries: string[];
  try {
    entries = readdirSync(join(root, ".git", "novelcraft-transactions"));
  } catch {
    entries = [];
  }
  const tx = entries.filter((n) => n.startsWith("tx-"));
  if (tx.length !== 1) throw new Error(`期望恰一个 intent, 实际 ${tx.length}`);
  return join(root, ".git", "novelcraft-transactions", tx[0]);
}

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TXID_A = `tx-${"a".repeat(64)}`;
const TXID_B = `tx-${"b".repeat(64)}`;

/** 测试侧原始 git commit(绕过 store; 仅用于构造“已提交的篡改现场”对抗输入)。 */
function gitCommitAll(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["commit", "-m", message], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "nci-test",
      GIT_AUTHOR_EMAIL: "nci-test@example.invalid",
      GIT_COMMITTER_NAME: "nci-test",
      GIT_COMMITTER_EMAIL: "nci-test@example.invalid",
    },
  });
}

/** 运行到 b1 provider 失败停止(provider_outcome_unknown; b1 plan 已提交, b2 未提交)。 */
async function runToProviderFailure(root: string): Promise<{ pers: GitRunPersistence; gen: Gen; s: RunEngineSpec; wfId: string; r1: RunEngineResult }> {
  const pers = new GitRunPersistence(root);
  const gen = new Gen();
  const s = spec();
  const wfId = workflowIdOf(s);
  gen.fail.add(batchIdOf(s, 0));
  const r1 = await runWorkflow(portsOf(pers, gen), { mode: "start", spec: s });
  expect(r1.status).toBe("provider_outcome_unknown");
  return { pers, gen, s, wfId, r1 };
}

/** 运行到 completed(全部批 + status 完成)。 */
async function completedRun(root: string, s: RunEngineSpec = spec()): Promise<{ pers: GitRunPersistence; wfId: string; r: RunEngineResult }> {
  const pers = new GitRunPersistence(root);
  const r = await runWorkflow(portsOf(pers, new Gen()), { mode: "start", spec: s });
  expect(r.status).toBe("completed");
  return { pers, wfId: r.workflowId, r };
}

/** 与 engine buildRunPlan 同构的手工 bootstrap state transaction(测试直接驱动 applyState)。 */
function bootstrapTxOf(s: RunEngineSpec): RunStateTransaction {
  const wfId = workflowIdOf(s);
  const planDigest = planDigestOf(s);
  const createdAt = new Date().toISOString();
  const runBatches: RunBatchSpec[] = [...s.batches]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((b) => ({
      phase: b.phase,
      ordinal: b.ordinal,
      sourceIds: [...b.sourceIds].sort(),
      sourceHashes: Object.fromEntries(Object.entries(b.sourceHashes).sort()),
      outputSchemaVersion: b.outputSchemaVersion ?? "1",
    }));
  const batches: Record<string, BatchManifestEntry> = {};
  for (const b of runBatches) {
    const plan = makeBatchPlan({
      workflowId: wfId,
      phase: b.phase,
      ordinal: b.ordinal,
      inputFingerprint: s.inputFingerprint,
      sourceIds: b.sourceIds,
      sourceHashes: b.sourceHashes,
    });
    batches[plan.batchId] = { batchId: plan.batchId, phase: plan.phase, ordinal: plan.ordinal, state: "planned", ...batchPaths("deep-import", plan) };
  }
  const manifest: RunWorkflowManifest = {
    version: 1,
    workflowId: wfId,
    kind: "deep-import",
    createdAt,
    inputFingerprint: s.inputFingerprint,
    profileFingerprint: s.profileFingerprint,
    planDigest,
    status: "planning",
    cursor: { phase: "start", ordinal: 0 },
    batches,
    applies: {},
  };
  const runPlan: RunPlanDocument = {
    version: 1,
    workflowId: wfId,
    kind: "deep-import",
    inputFingerprint: s.inputFingerprint,
    profileFingerprint: s.profileFingerprint,
    planDigest,
    createdAt,
    batches: runBatches,
  };
  return {
    kind: "bootstrap",
    txid: TXID_A,
    workflowId: wfId,
    runPlanPath: `.assistant/import-runs/${wfId}/run-plan.json`,
    runPlan: Buffer.from(`${canonicalRunJson(runPlan)}\n`, "utf8"),
    manifest,
  };
}

/** 手工 batch-plan state transaction(ordinal 指定批次; plan/path 可注入篡改输入)。 */
function batchPlanTxOf(s: RunEngineSpec, manifest: RunWorkflowManifest, ordinal: number, overrides: { plan?: Record<string, unknown>; path?: string } = {}): RunStateTransaction {
  const wfId = workflowIdOf(s);
  const plan = overrides.plan ?? batchPlanOf(s, ordinal);
  const batchId = (plan as unknown as { batchId?: string }).batchId ?? batchPlanOf(s, ordinal).batchId;
  const paths = batchPaths("deep-import", batchPlanOf(s, ordinal));
  return {
    kind: "batch-plan",
    txid: TXID_A,
    workflowId: wfId,
    batchId,
    path: overrides.path ?? paths.planPath,
    plan,
    bytes: Buffer.from(`${canonicalRunJson(plan)}\n`, "utf8"),
    manifest,
  } as unknown as RunStateTransaction;
}

function batchPlanOf(s: RunEngineSpec, ordinal: number): ReturnType<typeof makeBatchPlan> {
  const batch = s.batches.find((b) => b.ordinal === ordinal)!;
  return makeBatchPlan({
    workflowId: workflowIdOf(s),
    phase: batch.phase,
    ordinal: batch.ordinal,
    inputFingerprint: s.inputFingerprint,
    sourceIds: batch.sourceIds,
    sourceHashes: batch.sourceHashes,
  });
}

/** 手工 artifact-receipt state transaction(b1; phase/ordinal 可用 overrides 篡改)。 */
function artifactReceiptTxOf(
  s: RunEngineSpec,
  manifest: RunWorkflowManifest,
  overrides: { artifactPhase?: string; artifactOrdinal?: number } = {},
): { tx: RunStateTransaction; artifactBytes: Uint8Array; receiptBytes: Uint8Array; resultHash: string; batchId: string } {
  const wfId = workflowIdOf(s);
  const plan = batchPlanOf(s, 0);
  const paths = batchPaths("deep-import", plan);
  const artifact = {
    version: 1,
    workflowId: wfId,
    batchId: plan.batchId,
    phase: overrides.artifactPhase ?? plan.phase,
    ordinal: overrides.artifactOrdinal ?? plan.ordinal,
    inputFingerprint: plan.inputFingerprint,
    artifactSchemaVersion: 1,
    outputSchemaVersion: "1",
    payload: { text: "output-b1-1" },
  };
  const artifactBytes = Buffer.from(`${canonicalRunJson(artifact)}\n`, "utf8");
  const resultHash = workflowSha256(artifactBytes);
  const receipt = makeBatchReceipt({
    workflowId: wfId,
    batchId: plan.batchId,
    resultHash,
    transactionId: TXID_B,
    committedAt: new Date().toISOString(),
  });
  const receiptBytes = Buffer.from(`${canonicalRunJson(receipt)}\n`, "utf8");
  const entry = manifest.batches[plan.batchId];
  const next: RunWorkflowManifest = {
    ...manifest,
    status: "running",
    batches: {
      ...manifest.batches,
      [plan.batchId]: { ...entry, state: "artifact_committed", resultHash, transactionId: TXID_B },
    },
  };
  const tx: RunStateTransaction = {
    kind: "artifact-receipt",
    txid: TXID_B,
    workflowId: wfId,
    batchId: plan.batchId,
    artifactPath: paths.artifactPath,
    artifactBytes,
    receiptPath: paths.receiptPath,
    receiptBytes,
    manifest: next,
  };
  return { tx, artifactBytes, receiptBytes, resultHash, batchId: plan.batchId };
}

/** allowed-once 立即完成的 canonical apply 端口(测试用)。 */
class AllowedCanonical implements RunApplyPort {
  async requestApproval(_input: ApplyApprovalRequest): Promise<ApprovalDecision> {
    return "allowed-once";
  }
  async execute(_input: ApplyCanonicalRequest): Promise<{ commitOid: string }> {
    return { commitOid: "c".repeat(64) };
  }
  async probe(_transactionId: string): Promise<ApplyProbe> {
    return { state: "completed", commitOid: "c".repeat(64) };
  }
}

describe("GitRunPersistence · 生产持久化适配器(N33/ADR-0022)", () => {
  it("happy path: bootstrap→逐批→completed 全走 store 事务进 git 历史; 文件/Git truth 可重建; readBytes 精确字节", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const pers = new GitRunPersistence(root);
    const gen = new Gen();
    const s = spec();
    const wfId = workflowIdOf(s);
    expect(await pers.hasRun(wfId)).toBe(false);

    const r = await runWorkflow(portsOf(pers, gen), { mode: "start", spec: s });
    expect(r.status).toBe("completed");
    expect(r.completedBatchIds).toHaveLength(2);
    expect(await pers.hasRun(wfId)).toBe(true);

    // run namespace 内文件齐备(.assistant/import-runs/<canonical-run-id>/...)
    const runRoot = join(root, ".assistant", "import-runs", wfId);
    expect(existsSync(join(runRoot, "run-plan.json"))).toBe(true);
    expect(existsSync(join(runRoot, "manifest.json"))).toBe(true);
    // manifest 文件字节与 engine manifest 结构性一致(round-trip)
    expect(JSON.parse(readFileSync(join(runRoot, "manifest.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(r.manifest)));

    // 逐批确定性布局文件 + artifact/receipt exact bytes/hash
    const b1 = r.completedBatchIds[0];
    const entry = r.manifest.batches[b1];
    expect(existsSync(join(root, entry.planPath))).toBe(true);
    const artifactBytes = await pers.readBytes(entry.artifactPath);
    expect(artifactBytes).toBeDefined();
    expect(Buffer.from(artifactBytes!).equals(readFileSync(join(root, entry.artifactPath)))).toBe(true);
    expect(workflowSha256(artifactBytes!)).toBe(entry.resultHash); // 精确字节 hash 绑定
    const receipt = JSON.parse(readFileSync(join(root, entry.receiptPath), "utf8"));
    expect(receipt.resultHash).toBe(entry.resultHash);
    expect(receipt.transactionId).toBe(entry.transactionId);

    // 每次持久化调用 = 一个 store 事务 commit(共 bootstrap + 2×(plan/artifact/cursor) + status = 8)
    const subjects = gitRun(root, ["log", "--format=%s"]).split("\n");
    expect(subjects.filter((l) => l.includes("vault-tx vtx:tx-"))).toHaveLength(8);
    // 工作区干净(无裸写残留)
    expect(gitStatusPorcelain(root)).toEqual([]);

    // resume 幂等: 已完成 run 不重调 provider
    const gen2 = new Gen();
    const r2 = await runWorkflow(portsOf(pers, gen2), { mode: "resume", workflowId: wfId, expected: expectedFor(s) });
    expect(r2.status).toBe("completed");
    expect(gen2.calls).toHaveLength(0);
  });

  it("readBytes: 缺失返回 undefined; 越出 canonical run namespace 一律拒绝", async () => {
    const root = makeVault();
    const pers = new GitRunPersistence(root);
    const wfId = workflowIdOf(spec());
    expect(await pers.readBytes(`.assistant/import-runs/${wfId}/batches/x/nope.artifact.json`)).toBeUndefined();
    await expect(pers.readBytes("../escape.md")).rejects.toThrow(/run namespace/);
    await expect(pers.readBytes("/etc/passwd")).rejects.toThrow(/run namespace/);
    await expect(pers.readBytes("chapters/001.md")).rejects.toThrow(/run namespace/);
    await expect(pers.readBytes(`.assistant/import-runs/other-run-0000000000000000-x/batches/a/1.artifact.json`)).rejects.toThrow(/run namespace/);
  });

  it("bootstrap 崩溃(intent 已耐久未 commit)→ hasRun 为真; resume 先恢复同一事务补完, 不重跑", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const wfId = workflowIdOf(s);
    const pers = new GitRunPersistence(root, { transactionOptions: crashAt(1, "intent-ready") });
    await expect(runWorkflow(portsOf(pers, new Gen()), { mode: "start", spec: s })).rejects.toBeInstanceOf(CrashSimulatedError);
    // intent 保留、run 未提交(零工作树副作用)
    expect(existsSync(join(root, ".assistant", "import-runs", wfId, "run-plan.json"))).toBe(false);
    expect(await pers.hasRun(wfId)).toBe(true); // expected-absent 门禁: 未提交 intent 也算已存在

    // 全新进程 resume: loadRunState 先恢复 bootstrap intent, 再续跑
    const gen = new Gen();
    const r = await runWorkflow(portsOf(new GitRunPersistence(root), gen), { mode: "resume", workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe("completed");
    expect(existsSync(join(root, ".assistant", "import-runs", wfId, "run-plan.json"))).toBe(true);
    expect(gitStatusPorcelain(root)).toEqual([]);
    expect(gen.calls).toHaveLength(2);
  });

  it("窗口一: artifact-receipt 事务崩溃(intent 已耐久)→ 补完同一事务, 已产出批绝不重调 provider", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const wfId = workflowIdOf(s);
    const gen = new Gen();
    const pers = new GitRunPersistence(root, { transactionOptions: crashAt(3, "intent-ready") }); // 第 3 事务 = artifact:b1
    await expect(runWorkflow(portsOf(pers, gen), { mode: "start", spec: s })).rejects.toBeInstanceOf(CrashSimulatedError);
    expect(gen.calls).toEqual([batchIdOf(s, 0)]); // b1 已产出、持久化时崩溃

    const paths = batchPaths("deep-import", makeBatchPlan({
      workflowId: wfId, phase: "slice", ordinal: 0, inputFingerprint: s.inputFingerprint,
      sourceIds: ["ch-1"], sourceHashes: { "ch-1": sha("ch1") },
    }));
    const gen2 = new Gen();
    const r = await runWorkflow(portsOf(new GitRunPersistence(root), gen2), { mode: "resume", workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe("completed");
    expect(gen2.calls).toEqual([batchIdOf(s, 1)]); // b1 绝不重调
    const artifactBytes = readFileSync(join(root, paths.artifactPath));
    expect(workflowSha256(artifactBytes)).toBe(r.manifest.batches[batchIdOf(s, 0)].resultHash);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("窗口二: artifact+receipt 已提交、cursor 未推进 → resume 校验后幂等推进 cursor, 不重跑", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const wfId = workflowIdOf(s);
    const gen = new Gen();
    const pers = new GitRunPersistence(root, { transactionOptions: crashAt(3, "ref-cas") }); // artifact:b1 commit 后崩溃
    await expect(runWorkflow(portsOf(pers, gen), { mode: "start", spec: s })).rejects.toBeInstanceOf(CrashSimulatedError);
    expect(gen.calls).toEqual([batchIdOf(s, 0)]);

    const gen2 = new Gen();
    const r = await runWorkflow(portsOf(new GitRunPersistence(root), gen2), { mode: "resume", workflowId: wfId, expected: expectedFor(s) });
    expect(r.status).toBe("completed");
    expect(gen2.calls).toEqual([batchIdOf(s, 1)]);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("tampered intent(输出字节被篡改)→ 完整严格验证拒绝, intent 保留 fail-closed", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const pers = new GitRunPersistence(root, { transactionOptions: crashAt(1, "intent-ready") });
    await expect(runWorkflow(portsOf(pers, new Gen()), { mode: "start", spec: s })).rejects.toBeInstanceOf(CrashSimulatedError);
    const txDir = intentDir(root);
    // 篡改计划输出字节(outputs/0.bin = run plan 计划输出)
    writeFileSync(join(txDir, "outputs", "0.bin"), Buffer.from('{"tampered":true}\n'));
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: workflowIdOf(s), expected: expectedFor(s) }),
    ).rejects.toThrow(/未收敛 durable intent/);
    expect(existsSync(txDir)).toBe(true); // 保留现场供人工修复
  });

  it("tampered intent(目标路径改为作者内容)→ 严格验证拒绝, 现场保留", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const pers = new GitRunPersistence(root, { transactionOptions: crashAt(1, "intent-ready") });
    await expect(runWorkflow(portsOf(pers, new Gen()), { mode: "start", spec: s })).rejects.toBeInstanceOf(CrashSimulatedError);
    const txDir = intentDir(root);
    const intentPath = join(txDir, "intent.json");
    const raw = JSON.parse(readFileSync(intentPath, "utf8"));
    raw.targets[0].path = "chapters/001.md"; // 越出机器 namespace → 作者内容
    writeFileSync(intentPath, JSON.stringify(raw));
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: workflowIdOf(s), expected: expectedFor(s) }),
    ).rejects.toThrow(/越出机器 namespace/);
    expect(existsSync(txDir)).toBe(true);
  });

  it("force 新 run 前旧 intent 必须先收敛: 恢复补完旧 run, 新 bootstrap 成功且不覆盖旧 run", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const oldWfId = workflowIdOf(s);
    const persA = new GitRunPersistence(root, { transactionOptions: crashAt(1, "intent-ready") });
    await expect(runWorkflow(portsOf(persA, new Gen()), { mode: "start", spec: s })).rejects.toBeInstanceOf(CrashSimulatedError);

    // force: 全新 identity; 适配器先收敛旧 intent(补完旧 run)再 bootstrap 新 run
    const gen = new Gen();
    const r = await runWorkflow(portsOf(new GitRunPersistence(root), gen), { mode: "start", spec: s, force: true });
    expect(r.status).toBe("completed");
    expect(r.workflowId).not.toBe(oldWfId);
    expect(existsSync(join(root, ".assistant", "import-runs", oldWfId, "run-plan.json"))).toBe(true); // 旧 run 已补完
    expect(existsSync(join(root, ".assistant", "import-runs", r.workflowId, "manifest.json"))).toBe(true); // 新 run 自身 namespace
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("预存 staged 文件 → 任何 state 写 fail-closed(STAGED_CONFLICT), HEAD 不变", async () => {
    const root = makeVault();
    writeFileSync(join(root, "notes.md"), "staged-notes\n");
    execFileSync("git", ["add", "notes.md"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const headBefore = gitRun(root, ["rev-parse", "HEAD"]);
    await expect(runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "start", spec: spec() }))
      .rejects.toMatchObject({ code: "STAGED_CONFLICT" });
    expect(gitRun(root, ["rev-parse", "HEAD"])).toBe(headBefore);
  });

  it("sha/CAS: 已提交 artifact 被外部篡改(工作树字节改变)→ resume 重算 hash 与 receipt 不符, fail-closed", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const pers = new GitRunPersistence(root);
    const r = await runWorkflow(portsOf(pers, new Gen()), { mode: "start", spec: s });
    const b1 = r.completedBatchIds[0];
    const artifactPath = r.manifest.batches[b1].artifactPath;
    writeFileSync(join(root, artifactPath), '{"tampered":true}\n'); // 未提交篡改
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: r.workflowId, expected: expectedFor(s) }),
    ).rejects.toThrow(/hash 与 receipt 不符|损坏/);
  });

  it("manifest 被外部篡改 → loadRunState 严格校验/与 Git truth 对账拒绝(fail-closed)", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const pers = new GitRunPersistence(root);
    const r = await runWorkflow(portsOf(pers, new Gen()), { mode: "start", spec: s });
    const manifestPath = join(root, ".assistant", "import-runs", r.workflowId, "manifest.json");
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    raw.inputFingerprint = sha("tampered"); // 破坏 workflowId 绑定
    writeFileSync(manifestPath, JSON.stringify(raw));
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: r.workflowId, expected: expectedFor(s) }),
    ).rejects.toThrow(/不符|fail-closed/);
  });

  it("bootstrap expected-absent 由事务封闭 TOCTOU: 绕过 hasRun 直接重 bootstrap → 事务拒绝, 绝不覆盖", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const pers = new GitRunPersistence(root);
    const r = await runWorkflow(portsOf(pers, new Gen()), { mode: "start", spec: s });
    const wfId = r.workflowId;
    // 入口门禁: 同 workflowId 再次 start → conflict
    await expect(runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "start", spec: s }))
      .rejects.toMatchObject({ code: "conflict" });
    // 事务层封闭: 直接构造 bootstrap tx 调 applyState(绕过 hasRun)→ INVALID_REQUEST
    const loaded = await pers.loadRunState(wfId);
    const rootDir = `.assistant/import-runs/${wfId}`;
    const bootstrapTx: RunStateTransaction = {
      kind: "bootstrap",
      txid: "tx-1111111111111111111111111111111111111111111111111111111111111111",
      workflowId: wfId,
      runPlanPath: `${rootDir}/run-plan.json`,
      runPlan: (await pers.readBytes(`${rootDir}/run-plan.json`))!,
      manifest: loaded.manifest!,
    };
    await expect(pers.applyState(bootstrapTx)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // run 文件未被覆盖(git 历史/字节不变)
    expect(gitRun(root, ["log", "--format=%s"]).split("\n").filter((l) => l.includes("vault-tx vtx:tx-"))).toHaveLength(8);
  });

  it("provider 失败 → 写 provider_outcome_unknown 后停止; 重新授权后才重试, 已完成批不重跑", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const pers = new GitRunPersistence(root);
    const gen = new Gen();
    const s = spec();
    const b1 = batchIdOf(s, 0);
    gen.fail.add(b1);
    const r1 = await runWorkflow(portsOf(pers, gen), { mode: "start", spec: s });
    expect(r1.status).toBe("provider_outcome_unknown");
    expect(r1.providerOutcomeUnknown).toEqual([b1]);
    expect(gen.calls).toEqual([b1]);

    const r2 = await runWorkflow(portsOf(pers, gen), { mode: "resume", workflowId: r1.workflowId, expected: expectedFor(s) });
    expect(r2.status).toBe("provider_outcome_unknown");
    expect(gen.calls).toHaveLength(1); // 绝不自动重调

    gen.fail.clear();
    const r3 = await runWorkflow(portsOf(pers, gen), {
      mode: "resume", workflowId: r1.workflowId, expected: expectedFor(s), retryOutcomeUnknown: true,
    });
    expect(r3.status).toBe("completed");
    expect(gen.calls).toEqual([b1, b1, batchIdOf(s, 1)]);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  // ============ 独立复审对抗测试(R7–R11, 全部 fail-closed) ============

  it("R7: applyState expected 基线来自持久 HEAD manifest 快照(工作树篡改不刷新基线, STALE_BASELINE)", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const { pers, s, wfId } = await runToProviderFailure(root);
    const loaded = await pers.loadRunState(wfId);
    const manifestPath = join(root, ".assistant", "import-runs", wfId, "manifest.json");
    const originalManifestBytes = readFileSync(manifestPath);

    // 篡改工作树 manifest(未提交; 解析仍合法)——事务启动时绝不把它当基线
    const tampered = Buffer.concat([originalManifestBytes, Buffer.from(" ")]);
    writeFileSync(manifestPath, tampered);
    const headBefore = gitRun(root, ["rev-parse", "HEAD"]);

    // 合法 batch-plan 事务(b2; manifest 与 HEAD 持久快照一致)——若基线从工作树刷新,
    // 本事务会成功并覆写被篡改的 manifest; 基线必须来自持久快照 → CAS 拒绝
    const b2 = batchPlanTxOf(s, loaded.manifest!, 1);
    await expect(pers.applyState(b2)).rejects.toMatchObject({ code: "STALE_BASELINE" });

    // 零副作用: 工作树仍是被篡改的字节(未覆写)、HEAD 未动、无新文件/目录
    expect(readFileSync(manifestPath).equals(tampered)).toBe(true);
    expect(gitRun(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(existsSync(join(root, ".assistant", "import-runs", wfId, "batches", "entities"))).toBe(false);
  });

  it("R7: 不可变 batch plan 已存在 → 重驱动同一批次计划 = 冲突(存在即冲突, 拒绝覆盖)", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const { pers, s, wfId } = await runToProviderFailure(root);
    const loaded = await pers.loadRunState(wfId);
    const planPath = join(root, loaded.manifest!.batches[batchIdOf(s, 0)].planPath);
    const planBytesBefore = readFileSync(planPath);
    const headBefore = gitRun(root, ["rev-parse", "HEAD"]);

    // b1 计划已提交且 manifest 仍为 planned: 合法形状, 但不可变文件存在 → conflict
    const redrive = batchPlanTxOf(s, loaded.manifest!, 0);
    await expect(pers.applyState(redrive)).rejects.toMatchObject({ code: "conflict" });
    await expect(pers.applyState(redrive)).rejects.toThrow(/不可变 run 文档已存在/);

    // HEAD 未动、计划字节原样保留(绝不覆盖)
    expect(gitRun(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(readFileSync(planPath).equals(planBytesBefore)).toBe(true);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("R7: 不可变 artifact/receipt 已存在(残留文件)→ artifact-receipt 事务 = 冲突, 现场保留", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const { pers, s, wfId } = await runToProviderFailure(root);
    const loaded = await pers.loadRunState(wfId);
    const { tx, artifactBytes, receiptBytes } = artifactReceiptTxOf(s, loaded.manifest!);
    const b1 = batchIdOf(s, 0);
    const paths = batchPaths("deep-import", makeBatchPlan({
      workflowId: wfId, phase: "slice", ordinal: 0, inputFingerprint: s.inputFingerprint,
      sourceIds: ["ch-1"], sourceHashes: { "ch-1": sha("ch1") },
    }));
    // 工作树预置残留 artifact+receipt(未提交; 合法字节)——存在即冲突
    writeFileSync(join(root, paths.artifactPath), Buffer.from(artifactBytes));
    writeFileSync(join(root, paths.receiptPath), Buffer.from(receiptBytes));
    const headBefore = gitRun(root, ["rev-parse", "HEAD"]);
    await expect(pers.applyState(tx)).rejects.toMatchObject({ code: "conflict" });
    expect(gitRun(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    // 残留文件未被删除/覆写(现场保留)
    expect(readFileSync(join(root, paths.artifactPath)).equals(Buffer.from(artifactBytes))).toBe(true);
    expect(readFileSync(join(root, paths.receiptPath)).equals(Buffer.from(receiptBytes))).toBe(true);
    void b1;
  });

  it("R8: canonicalize 后拒绝 `.`/`..`/绝对/反斜杠/编码逃逸(含 run 前缀内穿越)", async () => {
    const root = makeVault();
    const pers = new GitRunPersistence(root);
    const wfId = workflowIdOf(spec());
    const runNs = `.assistant/import-runs/${wfId}`;
    // run namespace 内穿越(`..` 段)即使落在 vault 内也必须拒绝
    await expect(pers.readBytes(`${runNs}/batches/slice/../x.artifact.json`)).rejects.toThrow(/canonical|非法|拒绝/);
    await expect(pers.readBytes(`${runNs}/./x.json`)).rejects.toThrow(/canonical|非法|拒绝/);
    await expect(pers.readBytes(`${runNs}/x\\..\\y.json`)).rejects.toThrow(/canonical|非法|拒绝/);
    await expect(pers.readBytes(`${runNs}/x\u0000y.json`)).rejects.toThrow(/canonical|非法|拒绝/);
    await expect(pers.readBytes(`${runNs}/.git/config`)).rejects.toThrow(/canonical|非法|拒绝/);
    await expect(pers.readBytes(`${runNs}//x.json`)).rejects.toThrow(/canonical|非法|拒绝/);
    // 既有的非 run 拒绝口径不变
    await expect(pers.readBytes(`../escape.md`)).rejects.toThrow(/run namespace/);
  });

  it("R8: 写面目标严格位于本 workflow canonical root(跨 run batch plan / 穿越路径一律拒绝)", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const { pers, s, wfId } = await runToProviderFailure(root);
    const loaded = await pers.loadRunState(wfId);
    const manifest = loaded.manifest!;
    const b1 = batchIdOf(s, 0);
    const otherWf = workflowIdOf(spec({ uniqueRunId: "other-run" }));
    expect(otherWf).not.toBe(wfId);
    // 跨 run: plan 声称另一 workflowId(但复用本 run 的 batchId)→ 归属校验拒绝
    const foreign = { version: 1, workflowId: otherWf, batchId: b1, phase: "slice", ordinal: 0, inputFingerprint: s.inputFingerprint, sourceIds: ["ch-1"], sourceHashes: { "ch-1": sha("ch1") } };
    const crossRun = batchPlanTxOf(s, manifest, 0, { plan: foreign });
    await expect(pers.applyState(crossRun)).rejects.toThrow(/归属|身份|不符/);
    // 穿越路径: batch plan 目标含 `..` 段 → canonical 拒绝
    const traversal = batchPlanTxOf(s, manifest, 1, { path: `.assistant/import-runs/${wfId}/batches/../evil.plan.json` });
    await expect(pers.applyState(traversal)).rejects.toThrow(/canonical|\.\.|拒绝/);
    // bootstrap run plan 路径穿越 → canonical 拒绝(即使 run 已存在也先于事务)
    const badBootstrap = { ...bootstrapTxOf(spec()), runPlanPath: `.assistant/import-runs/${wfId}/../x/run-plan.json` } as RunStateTransaction;
    await expect(pers.applyState(badBootstrap)).rejects.toThrow(/canonical|\.\.|拒绝/);
  });

  it("R9: loadRunState 全文档对账——batch plan/receipt 工作树 != HEAD 已提交字节 → fail-closed", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const { pers, wfId, r } = await completedRun(root);
    const b1 = r.completedBatchIds[0];
    const entry = r.manifest.batches[b1];
    // 篡改已提交 batch plan(工作树; 未提交)
    const planPath = join(root, entry.planPath);
    const planBytes = readFileSync(planPath);
    writeFileSync(planPath, '{"tampered":true}\n');
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: wfId, expected: expectedFor(spec()) }),
    ).rejects.toThrow(/plan 工作树与 Git 已提交字节不符|损坏/);
    writeFileSync(planPath, planBytes); // 还原
    // 篡改已提交 receipt(工作树; 未提交)
    const receiptPath = join(root, entry.receiptPath);
    const receiptBytes = readFileSync(receiptPath);
    writeFileSync(receiptPath, '{"tampered":true}\n');
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: wfId, expected: expectedFor(spec()) }),
    ).rejects.toThrow(/receipt 工作树与 Git 已提交字节不符|损坏/);
    writeFileSync(receiptPath, receiptBytes); // 还原
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("R9: 全部 run 文档 strict no-unknown + canonical 字节(已提交篡改 → 拒绝)", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const { wfId, r } = await completedRun(root, s);
    const b1 = r.completedBatchIds[0];
    const entry = r.manifest.batches[b1];
    const docs: Array<{ rel: string; tamper: (b: Buffer) => Buffer; worktree: RegExp; committed: RegExp }> = [
      {
        rel: `.assistant/import-runs/${wfId}/manifest.json`,
        tamper: (b) => {
          const o = JSON.parse(b.toString("utf8"));
          o.hacked = true; // 未知字段
          return Buffer.from(JSON.stringify(o));
        },
        worktree: /未知字段/, // parseManifestStrict 先于对账
        committed: /未知字段/,
      },
      {
        rel: `.assistant/import-runs/${wfId}/run-plan.json`,
        tamper: (b) => Buffer.from(JSON.stringify(JSON.parse(b.toString("utf8")), null, 2)), // 非 canonical 格式
        worktree: /canonical 序列化/, // validateRunPlanBytes 先于对账
        committed: /canonical 序列化/,
      },
      {
        rel: entry.planPath,
        tamper: (b) => {
          const o = JSON.parse(b.toString("utf8"));
          o.hacked = true;
          return Buffer.from(JSON.stringify(o));
        },
        worktree: /plan 工作树与 Git 已提交字节不符|损坏/, // 对账先于文档校验
        committed: /未知字段/,
      },
      {
        rel: entry.artifactPath,
        tamper: (b) => {
          const o = JSON.parse(b.toString("utf8"));
          o.hacked = true; // 信封未知字段
          return Buffer.from(JSON.stringify(o));
        },
        worktree: /artifact 工作树与 Git 已提交字节不符|损坏/,
        committed: /未知字段/,
      },
      {
        rel: entry.receiptPath,
        tamper: (b) => {
          const o = JSON.parse(b.toString("utf8"));
          o.hacked = true;
          return Buffer.from(JSON.stringify(o));
        },
        worktree: /receipt 工作树与 Git 已提交字节不符|损坏/,
        committed: /未知字段/,
      },
    ];
    for (const doc of docs) {
      const abs = join(root, doc.rel);
      const original = readFileSync(abs);
      const tampered = doc.tamper(original);
      // 未提交工作树篡改: 对账(或前置文档校验)拒绝
      writeFileSync(abs, tampered);
      await expect(
        runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: wfId, expected: expectedFor(s) }),
      ).rejects.toThrow(doc.worktree);
      // 提交篡改 → 对账通过但 strict no-unknown/canonical 拒绝
      gitCommitAll(root, `tamper ${doc.rel}`);
      await expect(
        runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: wfId, expected: expectedFor(s) }),
      ).rejects.toThrow(doc.committed);
      // 还原并提交
      writeFileSync(abs, original);
      gitCommitAll(root, `restore ${doc.rel}`);
    }
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("R9: artifact 身份字段(phase/ordinal/inputFingerprint)精确绑定 committed batch plan", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const { pers, s, wfId } = await runToProviderFailure(root);
    const loaded = await pers.loadRunState(wfId);
    // phase 与已提交批次计划(slice)不符 → 绑定失败
    const badPhase = artifactReceiptTxOf(s, loaded.manifest!, { artifactPhase: "entities" });
    await expect(pers.applyState(badPhase.tx)).rejects.toThrow(/artifact 身份字段与已提交批次计划不符/);
    // ordinal 与已提交批次计划(0)不符 → 绑定失败
    const badOrdinal = artifactReceiptTxOf(s, loaded.manifest!, { artifactOrdinal: 99 });
    await expect(pers.applyState(badOrdinal.tx)).rejects.toThrow(/artifact 身份字段与已提交批次计划不符/);
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("R9: cursor/run-status/apply 合法前态→后态转换验证", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const { pers, s, wfId } = await runToProviderFailure(root);
    const loaded = await pers.loadRunState(wfId);
    const manifest = loaded.manifest!;
    const b1 = batchIdOf(s, 0);
    // cursor: 前态 planned(须 artifact_committed)→ 拒绝
    const cursorTx: RunStateTransaction = {
      kind: "cursor", txid: TXID_A, workflowId: wfId, batchId: b1,
      manifest: { ...manifest, status: "running", cursor: { phase: "slice", ordinal: 0 }, batches: { ...manifest.batches, [b1]: { ...manifest.batches[b1], state: "completed" } } },
    };
    await expect(pers.applyState(cursorTx)).rejects.toThrow(/前态\/后态非法|artifact_committed/);
    // run-status: provider_outcome_unknown → completed 非法转换 → 拒绝
    const illegalStatus: RunStateTransaction = { kind: "run-status", txid: TXID_A, workflowId: wfId, manifest: { ...manifest, status: "completed" } };
    await expect(pers.applyState(illegalStatus)).rejects.toThrow(/非法状态转换/);
    // run-status: provider_outcome_unknown → running 合法 → 提交成功
    const legalStatus: RunStateTransaction = { kind: "run-status", txid: TXID_A, workflowId: wfId, manifest: { ...manifest, status: "running" } };
    const after = await pers.applyState(legalStatus);
    expect(after.status).toBe("running");
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("R9: run-status 合法转换表(planning→running 可提交; planning→failed 拒绝)", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const pers = new GitRunPersistence(root);
    await pers.applyState(bootstrapTxOf(s)); // 手工程序化 bootstrap(仅 planning 态)
    const wfId = workflowIdOf(s);
    const loaded = await pers.loadRunState(wfId);
    const manifest = loaded.manifest!;
    const illegal: RunStateTransaction = { kind: "run-status", txid: TXID_A, workflowId: wfId, manifest: { ...manifest, status: "failed" } };
    await expect(pers.applyState(illegal)).rejects.toThrow(/非法状态转换/);
    // planning → completed 虽在转换表内, 但批次全部未完成 → 终态前置不变量拒绝
    const premature: RunStateTransaction = { kind: "run-status", txid: TXID_A, workflowId: wfId, manifest: { ...manifest, status: "completed" } };
    await expect(pers.applyState(premature)).rejects.toThrow(/未完成批次|completed/);
    const legal: RunStateTransaction = { kind: "run-status", txid: TXID_A, workflowId: wfId, manifest: { ...manifest, status: "running" } };
    const after = await pers.applyState(legal);
    expect(after.status).toBe("running");
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("R9: apply 合法前态→后态转换(终态不可回退; 新记录必须以 waiting_approval 起始)", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec({
      batches: [
        {
          phase: "slice", ordinal: 0, sourceIds: ["ch-1"], sourceHashes: { "ch-1": sha("ch1") },
          apply: { target: "content/scenes/ch1.md", expectedHash: EMPTY_HASH },
        },
        { phase: "entities", ordinal: 1, sourceIds: ["scene-a"], sourceHashes: { "scene-a": sha("a") } },
      ],
    });
    const pers = new GitRunPersistence(root);
    const r = await runWorkflow(portsOf(pers, new Gen(), new AllowedCanonical()), { mode: "start", spec: s });
    expect(r.status).toBe("completed");
    const wfId = r.workflowId;
    const b1 = batchIdOf(s, 0);
    const applyId = applyIdFor(wfId, b1);
    const loaded = await pers.loadRunState(wfId);
    const manifest = loaded.manifest!;
    const prevRec = manifest.applies[applyId];
    expect(prevRec.state).toBe("applied");
    // 终态 applied → waiting_approval(回退)→ 拒绝
    const { transactionId: _t, commitOid: _c, ...identity } = prevRec;
    const rollback: RunStateTransaction = {
      kind: "apply", txid: TXID_A, workflowId: wfId, applyId,
      manifest: { ...manifest, applies: { ...manifest.applies, [applyId]: { ...identity, state: "waiting_approval", updatedAt: prevRec.updatedAt } } },
    };
    await expect(pers.applyState(rollback)).rejects.toThrow(/非法状态转换/);
    // 新 apply 记录(b2, 无既有记录)直接进入 applying → 拒绝(必须以 waiting_approval 起始)
    const freshApplyId = applyIdFor(wfId, batchIdOf(s, 1));
    const freshApplying: RunStateTransaction = {
      kind: "apply", txid: TXID_A, workflowId: wfId, applyId: freshApplyId,
      manifest: {
        ...manifest,
        applies: {
          ...manifest.applies,
          [freshApplyId]: { ...identity, applyId: freshApplyId, batchId: batchIdOf(s, 1), state: "applying", transactionId: TXID_B, updatedAt: prevRec.updatedAt },
        },
      },
    };
    await expect(pers.applyState(freshApplying)).rejects.toThrow(/waiting_approval 起始/);
    // 合法新记录 waiting_approval → 提交成功
    const freshLegal: RunStateTransaction = {
      kind: "apply", txid: TXID_A, workflowId: wfId, applyId: freshApplyId,
      manifest: {
        ...manifest,
        applies: {
          ...manifest.applies,
          [freshApplyId]: { ...identity, applyId: freshApplyId, batchId: batchIdOf(s, 1), state: "waiting_approval", updatedAt: prevRec.updatedAt },
        },
      },
    };
    const after = await pers.applyState(freshLegal);
    expect(after.applies[freshApplyId].state).toBe("waiting_approval");
    expect(gitStatusPorcelain(root)).toEqual([]);
  });

  it("R10: READY intent 每 target 严格属于同一 canonical run root(混入 watch-state / 纯非 run / 跨 run 一律拒绝保留)", { timeout: 60_000 }, async () => {
    const root = makeVault();
    const s = spec();
    const wfId = workflowIdOf(s);
    const pers = new GitRunPersistence(root, { transactionOptions: crashAt(1, "intent-ready") });
    await expect(runWorkflow(portsOf(pers, new Gen()), { mode: "start", spec: s })).rejects.toBeInstanceOf(CrashSimulatedError);
    const txDir = intentDir(root);
    const intentPath = join(txDir, "intent.json");
    const raw = JSON.parse(readFileSync(intentPath, "utf8"));
    const originalTargets = JSON.parse(JSON.stringify(raw.targets));
    const otherWf = workflowIdOf(spec({ uniqueRunId: "other-run" }));

    // 1) 混入 watch-state(机器 namespace 但非 run root)→ 拒绝, 现场保留
    raw.targets = JSON.parse(JSON.stringify(originalTargets));
    raw.targets[1].path = ".assistant/watch-state.json";
    writeFileSync(intentPath, JSON.stringify(raw));
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: wfId, expected: expectedFor(s) }),
    ).rejects.toThrow(/canonical run namespace|混入非 run 机器状态/);
    expect(existsSync(txDir)).toBe(true);

    // 2) 纯非 run 机器状态(全部目标不在 run root)→ 拒绝保留
    raw.targets = JSON.parse(JSON.stringify(originalTargets));
    raw.targets[0].path = ".assistant/checkpoint.json";
    raw.targets[1].path = ".assistant/watch-state.json";
    writeFileSync(intentPath, JSON.stringify(raw));
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: wfId, expected: expectedFor(s) }),
    ).rejects.toThrow(/canonical run namespace|混入非 run 机器状态/);
    expect(existsSync(txDir)).toBe(true);

    // 3) 跨 run(两目标分属不同 run root)→ 拒绝保留
    raw.targets = JSON.parse(JSON.stringify(originalTargets));
    raw.targets[1].path = `.assistant/import-runs/${otherWf}/manifest.json`;
    writeFileSync(intentPath, JSON.stringify(raw));
    await expect(
      runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "resume", workflowId: wfId, expected: expectedFor(s) }),
    ).rejects.toThrow(/跨多个 canonical run root|同一/);
    expect(existsSync(txDir)).toBe(true);
  });

  it("R11: store preflight 前零 mkdir——pre-staged 失败无任何目录副作用", async () => {
    const root = makeVault();
    writeFileSync(join(root, "notes.md"), "staged-notes\n");
    execFileSync("git", ["add", "notes.md"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const headBefore = gitRun(root, ["rev-parse", "HEAD"]);
    await expect(runWorkflow(portsOf(new GitRunPersistence(root), new Gen()), { mode: "start", spec: spec() }))
      .rejects.toMatchObject({ code: "STAGED_CONFLICT" });
    // 零目录副作用: 未创建 run namespace / intent 命名空间 / 事务私有 index 残留
    // (`.assistant` 本身由 initVault 创建, 不在断言范围)
    expect(existsSync(join(root, ".assistant", "import-runs"))).toBe(false);
    expect(existsSync(join(root, ".git", "novelcraft-transactions"))).toBe(false);
    const gitEntries = readdirSync(join(root, ".git")).filter((n) => n.startsWith("novelcraft-txn-"));
    expect(gitEntries).toEqual([]);
    expect(gitRun(root, ["rev-parse", "HEAD"])).toBe(headBefore);
  });
});
