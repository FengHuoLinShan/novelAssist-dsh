import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initVault } from "@novelcraft/vault";
import { importStagedTextIntake, stageTextIntake, TextIntakeError } from "../src/index.js";

const roots: string[] = [];
function makeVault(): string {
  const root = mkdtempSync(join(tmpdir(), "nc-intake-"));
  roots.push(root);
  initVault(root, { title: "测试书", language: "zh" });
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function intakeDir(root: string, sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return join(root, ".git", "novelcraft-intake", key);
}

describe("session-bound browser text intake", () => {
  it("stages immutable bytes, imports once, and replays the terminal receipt", () => {
    const root = makeVault();
    const text = Buffer.from("第一章 雨夜\n雨下了一夜。", "utf8");
    const staged = stageTextIntake(root, "s1", "手稿.md", text);
    const dir = intakeDir(root, "s1");

    expect(staged.fileName).toBe("手稿.md");
    expect(staged.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(root, "chapters", "001.md"))).toBe(false);
    expect(existsSync(join(dir, `${staged.receiptId}.bin`))).toBe(true);

    const first = importStagedTextIntake(root, "s1", staged.receiptId);
    expect(first).toMatchObject({ ok: true, imported: 1, total: 1 });
    expect(readFileSync(join(root, "chapters", "001.md"), "utf8")).toContain("雨下了一夜");
    expect(existsSync(join(dir, `${staged.receiptId}.bin`))).toBe(false);

    const replay = importStagedTextIntake(root, "s1", staged.receiptId);
    expect(replay).toEqual(first);
  });

  it("rejects another session without exposing or consuming its bytes", () => {
    const root = makeVault();
    const staged = stageTextIntake(root, "s1", "book.txt", Buffer.from("第一章\n正文"));
    expect(() => importStagedTextIntake(root, "s2", staged.receiptId)).toThrowError(TextIntakeError);
    expect(existsSync(join(intakeDir(root, "s1"), `${staged.receiptId}.bin`))).toBe(true);
  });

  it("rejects binary input before creating a receipt", () => {
    const root = makeVault();
    expect(() => stageTextIntake(root, "s1", "book.txt", Uint8Array.from([0x50, 0x4b, 0x03, 0x00])))
      .toThrow(/binary|UTF-8|二进制/);
    expect(existsSync(join(root, ".git", "novelcraft-intake"))).toBe(false);
  });

  it("detects tampered frozen bytes, records failure, and removes the payload", () => {
    const root = makeVault();
    const staged = stageTextIntake(root, "s1", "book.txt", Buffer.from("第一章\n正文"));
    const dir = intakeDir(root, "s1");
    const bytes = join(dir, `${staged.receiptId}.bin`);
    writeFileSync(bytes, "tampered", "utf8");

    expect(() => importStagedTextIntake(root, "s1", staged.receiptId)).toThrow(/receipt|tamper|收据|一致/);
    expect(existsSync(bytes)).toBe(false);
    const receipt = JSON.parse(readFileSync(join(dir, `${staged.receiptId}.json`), "utf8")) as { status: string };
    expect(receipt.status).toBe("failed");
    expect(readdirSync(dir).some((name) => name.endsWith(".lock"))).toBe(false);
  });
});
