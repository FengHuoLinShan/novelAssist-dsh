// assistant · 健康信号扫描器行为契约(§20.6 / outline.md §535; 幂等, 确定性)。
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { inboxView, listSignals, scanHealthSignals } from "../src/index";

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "nch-"));
  dirs.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function seed(root: string) {
  writeFileSync(
    join(root, "scenes", "s001.md"),
    '---\nid: s001\nstatus: draft\ntitle: S1\nsource: deep_import\n---\n',
  );
  writeFileSync(
    join(root, "structure", "threads", "main.md"),
    '---\nid: main\nstatus: draft\ntitle: 主线\nthread_type: main\n---\n',
  );
}

describe("scanHealthSignals(健康命中 → 收件箱落盘)", () => {
  it("Scene 三键 + 结构 unassigned → 4 条 open 信号, radar=writing", () => {
    const root = makeRoot();
    seed(root);
    const r = scanHealthSignals(root);
    expect(r.created).toBe(4);
    expect(r.skipped).toBe(0);
    const signals = inboxView(root);
    expect(signals).toHaveLength(4);
    expect(signals.every((s) => s.radar === "writing")).toBe(true);
    // 证据作者语言: 缺设定信号带 goal。
    const missing = signals.find((s) => s.id === "health-scene_missing_setup-scene-s001");
    expect(missing?.evidence).toContain("缺目标");
  });

  it("幂等: 再扫一次全部跳过, 不重复堆积", () => {
    const root = makeRoot();
    seed(root);
    scanHealthSignals(root);
    const second = scanHealthSignals(root);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(4);
    expect(inboxView(root)).toHaveLength(4);
    expect(listSignals(root)).toHaveLength(4);
  });

  it("已 accept 的信号不被复活", () => {
    const root = makeRoot();
    seed(root);
    scanHealthSignals(root);
    // 直接把一条 open 信号改成 accepted(模拟作者已处理)。
    const file = join(root, ".assistant", "signals", "health-scene_unreviewed-scene-s001.json");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.status = "accepted";
    writeFileSync(file, JSON.stringify(rec, null, 2) + "\n", "utf8");
    const r = scanHealthSignals(root);
    expect(r.created).toBe(0);
    expect(r.skipped).toBe(4);
    expect(listSignals(root)).toHaveLength(4);
  });

  it("无健康命中的空 vault → 0 条", () => {
    const root = makeRoot();
    const r = scanHealthSignals(root);
    expect(r.total).toBe(0);
    expect(inboxView(root)).toHaveLength(0);
  });
});
