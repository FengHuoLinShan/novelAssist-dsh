// world/map-atlas · 空间事实提取(Phase 2; catalog §4.12; 计划 §4 Phase 2; 规则 4)。
// LLM 仅提取(map_spatial_facts); location_key/source_keys 逐字白名单校验、分桶、指纹复用全部确定性。
// 空间事实只作规划输入, 不写 canonical 资产(计划 §1.3)。
import { createHash } from "node:crypto";
import { registerSpec, runStep } from "@novelcraft/llm-step";
import type { Provider } from "@novelcraft/llm-step";
import { latestAtlasRun } from "./read.js";
import {
  SPATIAL_FACT_BASIS,
  type AtlasContextPacket,
  type AtlasContextResult,
  type SpatialEvidence,
  type SpatialFact,
  type SpatialFactBasis,
} from "./types.js";

/** 批/条数上限(计划 §4 Phase 2; 旧引擎 map_atlas_schemas.py 83-110 行口径)。 */
export const ATLAS_SPATIAL_BATCH_SIZE = 5;
export const ATLAS_SPATIAL_MAX_FACTS_PER_LOCATION = 12;
export const ATLAS_SPATIAL_MAX_FACTS_PER_BATCH = 60;
export const ATLAS_SPATIAL_MAX_STATEMENT_CHARS = 1000;
export const ATLAS_SPATIAL_MAX_CONFLICTS = 20;
export const ATLAS_SPATIAL_MAX_PER_BUCKET = 50;
export const ATLAS_SPATIAL_SCHEMA_VERSION = 1;

let mapAtlasSpecsRegistered = false;

/** map-atlas 内容步 spec 注册(幂等; registerWritingSpecsOnce 同惯例)。 */
export function registerMapAtlasSpecsOnce(): void {
  if (mapAtlasSpecsRegistered) return;
  try {
    registerSpec({
      specRef: "map_spatial_facts",
      description: "空间事实提取(地图册来源 packet → 带 basis 与逐字来源引用的 JSON; catalog §4.12)",
      inputNotes: "AtlasContextPacket[] JSON(每地点 wiki/rag 证据 + source_keys 白名单)",
      outputSchema: {
        type: "object",
        properties: {
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                location_key: { type: "string" },
                facts: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      statement: { type: "string" },
                      // basis 枚举四值(catalog §4.12)由 sanitizeFact 逐条校验丢弃;
                      // schema 不内嵌 enum——避免单条非法 basis 触发整批 schema 重试。
                      basis: { type: "string" },
                      source_keys: { type: "array", items: { type: "string" } },
                    },
                    required: ["statement", "basis", "source_keys"],
                    additionalProperties: true,
                  },
                },
              },
              required: ["location_key", "facts"],
              additionalProperties: true,
            },
          },
        },
        required: ["locations"],
        additionalProperties: true,
      },
      budgetTokens: 0, // N27 输入主导豁免: 输入 = 5 地点 × ≤8000 字, 必超 4000; catalog max_tokens 4000 是输出口径。
      temperature: 0,
      timeoutMs: 900_000,
      degradationNote: "批失败只降级该批; 非法 location_key/source_keys 逐条丢弃; 全批失败 all_batches_failed。",
      contractVersion: "v1",
    });
  } catch {
    // 已注册则忽略(幂等)。
  }
  mapAtlasSpecsRegistered = true;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 来源指纹(旧引擎 _compute_spatial_source_fingerprint 口径):
 * sha256(schema_version + 各地点 {slug,name,aliases 排序,sources 排序} 规范化 JSON)。
 */
export function computeSpatialFingerprint(ctx: AtlasContextResult): string {
  const locations = ctx.packets
    .map((p) => ({
      slug: p.location_key,
      name: p.name,
      aliases: [...p.aliases].sort(),
      sources: [...(ctx.location_source_hashes[p.location_key] ?? [])].sort(),
    }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return sha256Hex(JSON.stringify({ schema_version: ATLAS_SPATIAL_SCHEMA_VERSION, locations }));
}

function emptyEvidence(fingerprint: string, message?: string): SpatialEvidence {
  return {
    schema_version: ATLAS_SPATIAL_SCHEMA_VERSION,
    facts: [],
    supported: [],
    visual_fill: [],
    conflicts: [],
    source_fingerprint: fingerprint,
    locations_checked: 0,
    locations_with_facts: 0,
    degraded: false,
    all_batches_failed: false,
    invalid_count: 0,
    ...(message ? { message } : {}),
  };
}

/** AtlasRun.spatial_evidence 为 Record<string, unknown>(Phase 1 宽松落盘); 复用前结构收窄。 */
function asSpatialEvidence(raw: unknown): SpatialEvidence | null {
  if (!raw || typeof raw !== "object") return null;
  const ev = raw as Partial<SpatialEvidence>;
  if (typeof ev.schema_version !== "number" || typeof ev.source_fingerprint !== "string") return null;
  if (!Array.isArray(ev.facts) || !Array.isArray(ev.supported) || !Array.isArray(ev.visual_fill) || !Array.isArray(ev.conflicts)) return null;
  if (typeof ev.degraded !== "boolean" || typeof ev.all_batches_failed !== "boolean") return null;
  return ev as SpatialEvidence;
}

/** 指纹复用条件(计划 Phase 2 步骤 5): 同指纹 + 非降级 + 非全败 + 旧 facts 来源 ⊆ 当前 manifest。
 *  excludeRunId: orchestrator 先落 planning run 再提取(计划 Phase 3 步骤 1), 复用必须跳过本轮自身。 */
function tryReuseEvidence(
  root: string,
  ctx: AtlasContextResult,
  fingerprint: string,
  excludeRunId?: string,
): SpatialEvidence | null {
  const prev = latestAtlasRun(root, excludeRunId ? { excludeId: excludeRunId } : undefined);
  const ev = asSpatialEvidence(prev?.spatial_evidence);
  if (!ev) return null;
  if (ev.schema_version !== ATLAS_SPATIAL_SCHEMA_VERSION) return null;
  if (ev.source_fingerprint !== fingerprint) return null;
  if (ev.degraded || ev.all_batches_failed) return null;
  const currentKeys = new Set(ctx.packets.flatMap((p) => p.source_keys));
  for (const f of ev.facts) {
    if (!f.source_keys.every((k) => currentKeys.has(k))) return null;
  }
  return {
    ...ev,
    facts: [...ev.facts],
    supported: [...ev.supported],
    visual_fill: [...ev.visual_fill],
    conflicts: [...ev.conflicts],
    reused: true,
  };
}

interface RawFact {
  statement?: unknown;
  basis?: unknown;
  source_keys?: unknown;
}

/** 校验 + 归一一条 LLM fact(非法 → null 并计 invalid; 规则 4: source_keys 必须逐字来自 packet)。 */
function sanitizeFact(raw: RawFact, packet: AtlasContextPacket): SpatialFact | null {
  const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
  if (!statement) return null;
  const basis = raw.basis;
  if (typeof basis !== "string" || !(SPATIAL_FACT_BASIS as readonly string[]).includes(basis)) return null;
  if (!Array.isArray(raw.source_keys) || raw.source_keys.length === 0) return null;
  const allowed = new Set(packet.source_keys);
  const keys: string[] = [];
  for (const k of raw.source_keys) {
    if (typeof k !== "string" || !allowed.has(k)) return null;
    if (!keys.includes(k)) keys.push(k);
  }
  return {
    location_key: packet.location_key,
    statement: statement.slice(0, ATLAS_SPATIAL_MAX_STATEMENT_CHARS),
    basis: basis as SpatialFactBasis,
    source_keys: keys,
  };
}

/** 确定性分桶(计划 Phase 2): explicit→supported; inferred/working→visual_fill; conflicting→conflicts。 */
export function partitionSpatialFacts(facts: SpatialFact[]): Pick<SpatialEvidence, "supported" | "visual_fill" | "conflicts"> {
  const supported: SpatialFact[] = [];
  const visualFill: SpatialFact[] = [];
  const conflicts: SpatialFact[] = [];
  const seen = new Set<string>();
  for (const f of facts) {
    const key = `${f.location_key}\n${f.statement}`;
    if (seen.has(key)) continue; // 去重保序
    seen.add(key);
    if (f.basis === "explicit") {
      if (supported.length < ATLAS_SPATIAL_MAX_PER_BUCKET) supported.push(f);
    } else if (f.basis === "conflicting") {
      if (conflicts.length < ATLAS_SPATIAL_MAX_CONFLICTS) conflicts.push(f);
    } else {
      if (visualFill.length < ATLAS_SPATIAL_MAX_PER_BUCKET) visualFill.push(f);
    }
  }
  return { supported, visual_fill: visualFill, conflicts };
}

export interface ExtractSpatialFactsOptions {
  /** checkpoint 续跑: 从第 N 批开始(默认 0; Phase 3 run 落盘消费)。 */
  startBatch?: number;
  /** 指纹复用回避的 run id(orchestrator 的本轮 planning run)。 */
  excludeRunId?: string;
  /** durable driver 每个 chunk 自成 batch 时禁用跨 run 整体复用。 */
  disableReuse?: boolean;
  /** provider/shape 失败直接抛给 run engine → provider_outcome_unknown，不静默吞错。 */
  failClosed?: boolean;
}

/**
 * 空间事实提取(计划 Phase 2 步骤 4-6): 批 5 地点 runStep(map_spatial_facts) →
 * 逐字校验 → 截断 → 指纹复用(命中则不调 provider)→ 确定性分桶。
 */
export async function extractSpatialFacts(
  root: string,
  provider: Provider,
  ctx: AtlasContextResult,
  opts?: ExtractSpatialFactsOptions,
): Promise<SpatialEvidence> {
  registerMapAtlasSpecsOnce();
  const fingerprint = computeSpatialFingerprint(ctx);
  if (ctx.insufficient_sources || ctx.packets.length === 0) {
    return {
      ...emptyEvidence(fingerprint, ctx.message ?? "没有可核对的已采用地点。"),
      insufficient_sources: true,
    };
  }

  const reused = opts?.disableReuse === true ? null : tryReuseEvidence(root, ctx, fingerprint, opts?.excludeRunId);
  if (reused) return reused;

  const batches: AtlasContextPacket[][] = [];
  for (let i = 0; i < ctx.packets.length; i += ATLAS_SPATIAL_BATCH_SIZE) {
    batches.push(ctx.packets.slice(i, i + ATLAS_SPATIAL_BATCH_SIZE));
  }

  const facts: SpatialFact[] = [];
  const journals: unknown[] = []; // L1: 收集各批 llm_step journal(计划 Phase 3 步骤 6 审计)。
  let invalidCount = 0;
  let failedBatches = 0;
  let nextCheckpoint: number | null = null;
  const startBatch = Math.max(0, opts?.startBatch ?? 0);

  for (let bi = startBatch; bi < batches.length; bi++) {
    const batch = batches[bi];
    const input = JSON.stringify({
      locations: batch.map((p) => ({
        location_key: p.location_key,
        name: p.name,
        aliases: p.aliases,
        importance: p.importance,
        wiki: p.wiki,
        rag: p.rag,
        source_keys: p.source_keys,
      })),
    });
    let step;
    try {
      step = await runStep(provider, { specRef: "map_spatial_facts", input });
    } catch (err) {
      if (opts?.failClosed === true) throw err;
      step = null;
    }
    if (step) journals.push({ specRef: "map_spatial_facts", batch: bi, journal: step.journal, usage: step.usage, ok: step.ok });
    if (!step || !step.ok || typeof step.result !== "object" || step.result === null) {
      if (opts?.failClosed === true) throw new Error(`map_spatial_facts batch ${bi} provider/结果失败`);
      failedBatches += 1; // legacy 路径批失败只降级, durable driver 使用 failClosed。
      if (nextCheckpoint === null) nextCheckpoint = bi; // 续跑游标 = 首个失败批号。
      continue;
    }
    const rawLocations = (step.result as { locations?: unknown }).locations;
    if (!Array.isArray(rawLocations)) {
      if (opts?.failClosed === true) throw new Error(`map_spatial_facts batch ${bi} 缺 locations 数组`);
      failedBatches += 1;
      if (nextCheckpoint === null) nextCheckpoint = bi; // 续跑游标 = 首个失败批号。
      continue;
    }
    const byKey = new Map(batch.map((p) => [p.location_key, p]));
    let batchFacts = 0;
    for (const rawLoc of rawLocations) {
      if (batchFacts >= ATLAS_SPATIAL_MAX_FACTS_PER_BATCH) break; // 每批 ≤60。
      if (!rawLoc || typeof rawLoc !== "object") {
        invalidCount += 1;
        continue;
      }
      const key = (rawLoc as { location_key?: unknown }).location_key;
      const packet = typeof key === "string" ? byKey.get(key) : undefined;
      const rawFacts = (rawLoc as { facts?: unknown }).facts;
      if (!packet || !Array.isArray(rawFacts)) {
        invalidCount += Array.isArray(rawFacts) ? rawFacts.length : 1;
        continue;
      }
      let locFacts = 0;
      for (const raw of rawFacts as RawFact[]) {
        if (locFacts >= ATLAS_SPATIAL_MAX_FACTS_PER_LOCATION) break; // 每地点 ≤12。
        if (batchFacts >= ATLAS_SPATIAL_MAX_FACTS_PER_BATCH) break;
        if (!raw || typeof raw !== "object") {
          invalidCount += 1;
          continue;
        }
        const fact = sanitizeFact(raw, packet);
        if (!fact) {
          invalidCount += 1;
          continue;
        }
        facts.push(fact);
        locFacts += 1;
        batchFacts += 1;
      }
    }
  }

  const allFailed = failedBatches === batches.length - startBatch;
  const locationsWithFacts = new Set(facts.map((f) => f.location_key)).size;
  const partition = partitionSpatialFacts(facts);
  return {
    schema_version: ATLAS_SPATIAL_SCHEMA_VERSION,
    facts,
    ...partition,
    journal: journals,
    source_fingerprint: fingerprint,
    locations_checked: ctx.packets.length,
    locations_with_facts: locationsWithFacts,
    degraded: failedBatches > 0 && !allFailed,
    all_batches_failed: allFailed,
    invalid_count: invalidCount,
    ...(nextCheckpoint !== null && !allFailed ? { next_checkpoint: nextCheckpoint } : {}),
    ...(allFailed ? { message: "空间事实提取全部批次失败, 可稍后重试。" } : {}),
  };
}
