// memory 行为契约(small-modules §2 + store-rules R12)
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { appendEvent, chapterCoverage, eventId, projectWorldState, readEvents } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "ncm-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("appendEvent(事件溯源)", () => {
  it("append-only 落 events.jsonl, 行可解析", () => {
    const root = makeRoot();
    const ev = appendEvent(root, {
      chapter_index: 3, sequence: 0, event_type: "entity_created",
      snapshot_after: { name: "克莱恩" }, entity_id: "obj_klein",
    });
    expect(ev.id).toBe(eventId(3, 0));
    const { events, brokenLines } = readEvents(root);
    expect(brokenLines).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].snapshot_after).toEqual({ name: "克莱恩" });
    const raw = readFileSync(join(root, "memory", "events.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("幂等: 同章同 sequence 拒绝(旧 uq 约束)", () => {
    const root = makeRoot();
    appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "entity_created", snapshot_after: {} });
    expect(() =>
      appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "entity_updated", snapshot_after: {} }),
    ).toThrow(/幂等拒绝/);
  });

  // N26: 第二幂等键 (scene_id, scene_sequence) — small-modules.md:140/142
  it("幂等: 同 scene_id + scene_sequence 拒绝(第二幂等键)", () => {
    const root = makeRoot();
    appendEvent(root, {
      chapter_index: 1, sequence: 0, event_type: "entity_created",
      snapshot_after: {}, scene_id: "scene-cn-001", scene_sequence: 0,
    });
    // 同 scene 同 scene_sequence、不同章 sequence → 仍拒绝(N26 双键)
    expect(() =>
      appendEvent(root, {
        chapter_index: 1, sequence: 1, event_type: "entity_updated",
        snapshot_after: {}, scene_id: "scene-cn-001", scene_sequence: 0,
      }),
    ).toThrow(/幂等拒绝/);
  });

  it("幂等: 同 scene_id 不同 scene_sequence 放行(第二幂等键)", () => {
    const root = makeRoot();
    appendEvent(root, {
      chapter_index: 1, sequence: 0, event_type: "entity_created",
      snapshot_after: {}, scene_id: "scene-cn-001", scene_sequence: 0,
    });
    const ev = appendEvent(root, {
      chapter_index: 1, sequence: 1, event_type: "entity_updated",
      snapshot_after: {}, scene_id: "scene-cn-001", scene_sequence: 1,
    });
    expect(ev.scene_id).toBe("scene-cn-001");
    expect(ev.scene_sequence).toBe(1);
    const { events } = readEvents(root);
    expect(events).toHaveLength(2);
  });

  it("无 scene_id 事件行为不变(旧主键幂等仍生效, 第二键不触发)", () => {
    const root = makeRoot();
    appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "entity_created", snapshot_after: {} });
    // 旧主键 chapter+sequence 仍拒绝
    expect(() =>
      appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "entity_updated", snapshot_after: {} }),
    ).toThrow(/幂等拒绝/);
    // 仅 scene_sequence 无 scene_id → 第二键不触发, 放行
    const ev = appendEvent(root, {
      chapter_index: 2, sequence: 0, event_type: "entity_created",
      snapshot_after: {}, scene_sequence: 5,
    });
    expect(ev.scene_sequence).toBe(5);
  });

  it("非法 event_type/dimension/snapshot_after 缺失拒绝", () => {
    const root = makeRoot();
    expect(() =>
      appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "nope" as never, snapshot_after: {} }),
    ).toThrow(/event_type/);
    expect(() =>
      appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "entity_created", dimension: "bad" as never, snapshot_after: {} }),
    ).toThrow(/dimension/);
    expect(() =>
      appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "entity_created", snapshot_after: undefined as never }),
    ).toThrow(/snapshot_after/);
  });

  // N26: scene_id/scene_sequence 在场校验(small-modules.md:112 锚点, writing.md:136 弱绑定)
  it("scene_id 空串 / scene_sequence 负数拒绝", () => {
    const root = makeRoot();
    expect(() =>
      appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "entity_created", snapshot_after: {}, scene_id: "" }),
    ).toThrow(/scene_id/);
    expect(() =>
      appendEvent(root, { chapter_index: 1, sequence: 0, event_type: "entity_created", snapshot_after: {}, scene_sequence: -1 }),
    ).toThrow(/scene_sequence/);
  });
});

describe("projectWorldState(派生投影, 可重建)", () => {
  it("实体增删改 + 关系建立/结束投影正确", () => {
    const events = [
      { id: "1", chapter_index: 1, sequence: 0, event_type: "entity_created" as const, entity_id: "a", snapshot_after: { v: 1 }, source: "ai_extraction" as const, created_at: "2026-08-14T00:00:00Z" },
      { id: "2", chapter_index: 1, sequence: 1, event_type: "entity_updated" as const, entity_id: "a", snapshot_after: { v: 2 }, source: "ai_extraction" as const, created_at: "2026-08-14T00:00:01Z" },
      { id: "3", chapter_index: 1, sequence: 2, event_type: "relation_established" as const, entity_id: "a", snapshot_after: { to: "b" }, source: "ai_extraction" as const, created_at: "2026-08-14T00:00:02Z" },
      { id: "4", chapter_index: 1, sequence: 3, event_type: "entity_removed" as const, entity_id: "a", snapshot_after: {}, source: "ai_extraction" as const, created_at: "2026-08-14T00:00:03Z" },
    ];
    const p = projectWorldState(events);
    expect(p.entities.get("a")).toBeUndefined(); // removed
    expect(p.relations).toHaveLength(1);
    expect(p.lastEventAt).toBe("2026-08-14T00:00:03Z");
  });
});

describe("chapterCoverage(增量导入/雷达用)", () => {
  it("每章计数与最后 sequence", () => {
    const events = [
      { id: "1", chapter_index: 2, sequence: 0, event_type: "entity_created" as const, snapshot_after: {}, source: "ai_extraction" as const, created_at: "x" },
      { id: "2", chapter_index: 2, sequence: 5, event_type: "entity_updated" as const, snapshot_after: {}, source: "ai_extraction" as const, created_at: "x" },
      { id: "3", chapter_index: 3, sequence: 1, event_type: "entity_created" as const, snapshot_after: {}, source: "ai_extraction" as const, created_at: "x" },
    ];
    const cov = chapterCoverage(events);
    expect(cov.get(2)).toEqual({ count: 2, lastSequence: 5 });
    expect(cov.get(3)).toEqual({ count: 1, lastSequence: 1 });
  });
});
