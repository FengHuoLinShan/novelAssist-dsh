// assistant 核心 · per-book 校准(§13/§22.2 calibration.md, append-only)。
// 打回理由等用户纠正记入校准笔记, 供 llm-step 的 resolvePolicy 覆盖链读取。
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { paths } from "@novelcraft/vault";

export interface CalibrationEntry {
  key: string;
  value: string;
  reason: string;
  at: string;
}

/** 追加一条校准(append-only; 与 llm-step parseFlatYaml 的 `key: value` 行格式兼容,
 *  理由以 # 注释尾随)。 */
export function appendCalibration(root: string, entry: Omit<CalibrationEntry, "at">): void {
  const p = paths(root);
  const line = `${entry.key}: ${entry.value} # ${entry.reason.replace(/\n/g, " ")}`;
  appendFileSync(p.assistant.calibration, `\n${line}\n`, "utf8");
}

/** 读全部校准条目(解析 `key: value # reason` 行)。 */
export function readCalibration(root: string): CalibrationEntry[] {
  const p = paths(root);
  if (!existsSync(p.assistant.calibration)) return [];
  const out: CalibrationEntry[] = [];
  for (const line of readFileSync(p.assistant.calibration, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_.\-]+):\s*(.*?)\s*(?:#\s*(.*))?$/);
    if (!m) continue;
    out.push({ key: m[1], value: m[2].trim(), reason: m[3]?.trim() ?? "", at: "" });
  }
  return out;
}

/** 打回理由 → 校准(收件箱 reject 的落点)。 */
export function recordRejection(root: string, signalId: string, reason: string): void {
  appendCalibration(root, {
    key: "signal_rejection",
    value: signalId,
    reason,
  });
}
