// @novelcraft/memory — 事件溯源(R5 纯 TS 部分)。
// 依据: specs/assets/small-modules.md §2 + store-rules(R12: 文件是唯一真相,
// 派生投影可重建)。events.jsonl append-only; 所有投影为纯函数可重建。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";

export const EVENT_TYPES = [
  "entity_created", "entity_updated", "entity_removed", "entity_moved",
  "relation_established", "relation_ended", "knowledge_changed", "manual_correction",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const DIMENSIONS = ["entities", "relations", "locations", "knowledge"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const EVENT_SOURCES = ["ai_extraction", "manual_edit"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export interface MemoryEvent {
  id: string;
  chapter_index: number;
  /** Scene slug 弱绑定(无 FK, 对齐 writing.md:136); 与 scene_sequence 构成第二幂等键(N26) */
  scene_id?: string;
  scene_index?: number;
  scene_sequence?: number;
  dimension?: Dimension;
  /** 章内事件顺序(同章单调递增, 幂等键之一) */
  sequence: number;
  event_type: EventType;
  entity_id?: string;
  entity_type?: string;
  snapshot_before?: unknown;
  snapshot_after: unknown;
  source: EventSource;
  created_at: string;
}

export interface AppendEventInput {
  chapter_index: number;
  sequence: number;
  event_type: EventType;
  snapshot_after: unknown;
  snapshot_before?: unknown;
  dimension?: Dimension;
  /** Scene slug 弱绑定(无 FK); 与 scene_sequence 同在时启用第二幂等键(N26) */
  scene_id?: string;
  scene_index?: number;
  scene_sequence?: number;
  entity_id?: string;
  entity_type?: string;
  source?: EventSource;
}

/** 幂等键: novel + chapter + sequence(旧表 uq_memory_events_novel_chapter_sequence)。
 *  M4 文件内同章同 sequence 只允许一条(upsert 语义: 已存在则拒绝, 防重复计费/重放)。 */
export function eventId(chapterIndex: number, sequence: number): string {
  return `ev-${chapterIndex}-${sequence}`;
}

/** 读取全部事件(解析 JSONL, 忽略空行与坏行并收集)。 */
export function readEvents(root: string): { events: MemoryEvent[]; brokenLines: number } {
  const file = paths(root).memory.events;
  if (!existsSync(file)) return { events: [], brokenLines: 0 };
  const events: MemoryEvent[] = [];
  let brokenLines = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as MemoryEvent);
    } catch {
      brokenLines += 1;
    }
  }
  return { events, brokenLines };
}

function validate(input: AppendEventInput): void {
  if (!Number.isInteger(input.chapter_index) || input.chapter_index < 1) {
    throw new Error("chapter_index 必须 ≥1 整数");
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 0) {
    throw new Error("sequence 必须 ≥0 整数");
  }
  // N26: scene_id 在场须非空字符串(Scene slug 弱绑定); scene_sequence 在场须 ≥0 整数
  if (input.scene_id !== undefined && (typeof input.scene_id !== "string" || input.scene_id.length === 0)) {
    throw new Error("scene_id 必须非空字符串");
  }
  if (input.scene_sequence !== undefined && (!Number.isInteger(input.scene_sequence) || input.scene_sequence < 0)) {
    throw new Error("scene_sequence 必须 ≥0 整数");
  }
  if (!EVENT_TYPES.includes(input.event_type)) throw new Error(`event_type 非法: ${input.event_type}`);
  if (input.dimension !== undefined && !DIMENSIONS.includes(input.dimension)) {
    throw new Error(`dimension 非法: ${input.dimension}`);
  }
  if (input.snapshot_after === undefined) throw new Error("snapshot_after 必填");
}

/** 追加一条事件(append-only); 同章同 sequence 已存在 → 拒绝(幂等, fail-closed)。 */
export function appendEvent(root: string, input: AppendEventInput, now: Date = new Date()): MemoryEvent {
  validate(input);
  const { events } = readEvents(root);
  const dup = events.find(
    (e) => e.chapter_index === input.chapter_index && e.sequence === input.sequence,
  );
  if (dup) {
    throw new Error(`事件已存在(幂等拒绝): chapter=${input.chapter_index} seq=${input.sequence}`);
  }
  // N26: scene_id + scene_sequence 同在时启用第二幂等键(small-modules.md:140)
  if (input.scene_id !== undefined && input.scene_sequence !== undefined) {
    const sceneDup = events.find(
      (e) => e.scene_id === input.scene_id && e.scene_sequence === input.scene_sequence,
    );
    if (sceneDup) {
      throw new Error(
        `事件已存在(幂等拒绝): scene=${input.scene_id} scene_seq=${input.scene_sequence}`,
      );
    }
  }
  const event: MemoryEvent = {
    id: eventId(input.chapter_index, input.sequence),
    chapter_index: input.chapter_index,
    sequence: input.sequence,
    event_type: input.event_type,
    snapshot_after: input.snapshot_after,
    snapshot_before: input.snapshot_before,
    dimension: input.dimension,
    scene_id: input.scene_id,
    scene_index: input.scene_index,
    scene_sequence: input.scene_sequence,
    entity_id: input.entity_id,
    entity_type: input.entity_type,
    source: input.source ?? "ai_extraction",
    created_at: now.toISOString(),
  };
  appendFileSync(paths(root).memory.events, JSON.stringify(event) + "\n", "utf8");
  return event;
}

// ---------------------------------------------------------------------------
// 派生投影(全部可重建, R12): 不落独立真相, 需要时由事件重放
// ---------------------------------------------------------------------------

export interface WorldStateProjection {
  /** entity_id → 最新 snapshot_after */
  entities: Map<string, unknown>;
  /** relation 事件序列(建立/结束, 按时间) */
  relations: Array<{ event: MemoryEvent; established: boolean }>;
  lastEventAt?: string;
}

/** 重放全量事件 → 世界状态投影(剧情/风险雷达的读面, 设计文档 §20.5)。 */
export function projectWorldState(events: MemoryEvent[]): WorldStateProjection {
  const entities = new Map<string, unknown>();
  const relations: WorldStateProjection["relations"] = [];
  let lastEventAt: string | undefined;
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    lastEventAt = e.created_at;
    if (e.event_type === "entity_removed") {
      entities.delete(e.entity_id ?? "");
      continue;
    }
    if (e.entity_id && (e.event_type === "entity_created" || e.event_type === "entity_updated")) {
      entities.set(e.entity_id, e.snapshot_after);
    }
    if (e.event_type === "relation_established" || e.event_type === "relation_ended") {
      relations.push({ event: e, established: e.event_type === "relation_established" });
    }
  }
  return { entities, relations, lastEventAt };
}

/** 章节覆盖摘要(每章事件计数与最后 sequence)——增量导入/雷达用。 */
export function chapterCoverage(events: MemoryEvent[]): Map<number, { count: number; lastSequence: number }> {
  const out = new Map<number, { count: number; lastSequence: number }>();
  for (const e of events) {
    const cur = out.get(e.chapter_index) ?? { count: 0, lastSequence: -1 };
    cur.count += 1;
    cur.lastSequence = Math.max(cur.lastSequence, e.sequence);
    out.set(e.chapter_index, cur);
  }
  return out;
}

export interface CharacterKnowledgeFact {
  fact_id: string;
  text: string;
  chapter_index: number;
  event_id: string;
}

export interface CharacterKnowledgeExclusion {
  fact_id: string;
  exclusion: string;
  chapter_index: number;
  event_id: string;
}

export interface CharacterKnowledgeProjection {
  known: CharacterKnowledgeFact[];
  excluded: CharacterKnowledgeExclusion[];
  invalid_event_count: number;
  future_event_count: number;
}

type KnowledgeDelta =
  | { character_id: string; fact_id: string; state: "known"; text: string }
  | { character_id: string; fact_id: string; state: "excluded"; exclusion: string };

function knowledgeDelta(value: unknown): KnowledgeDelta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.character_id !== "string" || !v.character_id || typeof v.fact_id !== "string" || !v.fact_id) {
    return undefined;
  }
  if (v.state === "known" && typeof v.text === "string" && v.text.trim()) {
    return { character_id: v.character_id, fact_id: v.fact_id, state: "known", text: v.text.trim() };
  }
  if (v.state === "excluded" && typeof v.exclusion === "string" && v.exclusion.trim()) {
    return { character_id: v.character_id, fact_id: v.fact_id, state: "excluded", exclusion: v.exclusion.trim() };
  }
  return undefined;
}

/**
 * P1-M1 最小人物知识投影：只消费显式 knowledge_changed delta，按故事章/
 * Scene/序列重放。excluded 的原始 text 永不返回，只返回作者明示的安全 exclusion。
 */
export function projectCharacterKnowledge(
  events: readonly MemoryEvent[],
  characterId: string,
  throughChapter: number,
): CharacterKnowledgeProjection {
  if (!characterId || !Number.isSafeInteger(throughChapter) || throughChapter < 0) {
    throw new Error("characterId/throughChapter 非法");
  }
  const state = new Map<string, { delta: KnowledgeDelta; event: MemoryEvent }>();
  let invalidEventCount = 0;
  let futureEventCount = 0;
  const knowledgeEvents: Array<{ event: MemoryEvent; delta: KnowledgeDelta }> = [];
  for (const event of events) {
    if (event.event_type !== "knowledge_changed") continue;
    const delta = knowledgeDelta(event.snapshot_after);
    if (delta === undefined || typeof event.id !== "string" || !event.id ||
        !Number.isSafeInteger(event.chapter_index) || event.chapter_index < 1 ||
        !Number.isSafeInteger(event.sequence) || event.sequence < 0 ||
        !EVENT_SOURCES.includes(event.source) || typeof event.created_at !== "string" || !Number.isFinite(Date.parse(event.created_at)) ||
        (event.dimension !== undefined && event.dimension !== "knowledge") ||
        (event.scene_index !== undefined && (!Number.isSafeInteger(event.scene_index) || event.scene_index < 0)) ||
        (event.scene_sequence !== undefined && (!Number.isSafeInteger(event.scene_sequence) || event.scene_sequence < 0))) {
      invalidEventCount += 1;
      continue;
    }
    knowledgeEvents.push({ event, delta });
  }
  knowledgeEvents.sort((a, b) =>
    a.event.chapter_index - b.event.chapter_index ||
    (a.event.scene_index ?? Number.MAX_SAFE_INTEGER) - (b.event.scene_index ?? Number.MAX_SAFE_INTEGER) ||
    (a.event.scene_sequence ?? a.event.sequence) - (b.event.scene_sequence ?? b.event.sequence) ||
    a.event.sequence - b.event.sequence ||
    a.event.id.localeCompare(b.event.id));
  for (const { event, delta } of knowledgeEvents) {
    if (delta.character_id !== characterId) continue;
    if (event.chapter_index > throughChapter) {
      futureEventCount += 1;
      continue;
    }
    state.set(delta.fact_id, { delta, event });
  }
  const known: CharacterKnowledgeFact[] = [];
  const excluded: CharacterKnowledgeExclusion[] = [];
  for (const factId of [...state.keys()].sort()) {
    const current = state.get(factId)!;
    if (current.delta.state === "known") {
      known.push({
        fact_id: factId,
        text: current.delta.text,
        chapter_index: current.event.chapter_index,
        event_id: current.event.id,
      });
    } else {
      excluded.push({
        fact_id: factId,
        exclusion: current.delta.exclusion,
        chapter_index: current.event.chapter_index,
        event_id: current.event.id,
      });
    }
  }
  return { known, excluded, invalid_event_count: invalidEventCount, future_event_count: futureEventCount };
}

/** 事件行哈希(校验/审计用, N13 纯 hex)。 */
export function eventLineHash(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}
