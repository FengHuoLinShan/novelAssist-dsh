// llm-step · strict llm.yml 单次快照解析行为契约(N34 / ADR-0023 §6, 独立审查 P3)。
// 断言引: N34(执行配置解析失败 fail-closed, 不带半解析配置跑)、N5(Key 永不进文件:
//         llm.yml 只存预设名与参数)、ADR-0023 §6(启动解析一次, 解析失败 → 编排启动失败)。
// 覆盖: 未知键/secret/非法 preset 类型/非数字/NaN/小数/越界/temperature/provider/model
//       全部 fail-closed; 合法边界值(temperature=0 等)通过; 单次 readFileSync 快照
//       (TOCTOU 不存在「读两次文件内容不一致」); legacy resolvePolicy 保持兼容。
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initVault } from '@novelcraft/vault';
import {
  LlmYmlError,
  parseLlmYmlStrict,
  readExecutionLlmYmlSnapshot,
  resolveExecutionLlmYml,
  resolvePolicy,
} from '../src/index';

// 单次读断言需要拦截 readFileSync: 只包一层透传 vi.fn(其余 fs 原样透传),
// 计数「resolveExecutionLlmYml 对 llm.yml 的读取次数」。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof import('node:fs').readFileSync>) =>
      (actual.readFileSync as (...a: Parameters<typeof import('node:fs').readFileSync>) => ReturnType<typeof import('node:fs').readFileSync>)(...args),
    ),
  };
});

const dirs: string[] = [];
function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ncls-'));
  dirs.push(root);
  initVault(root, { title: '测试书', language: 'zh' });
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseLlmYmlStrict(未知键/secret/类型/数字/小数/越界 fail-closed, N34 P3)', () => {
  const bad: Array<[string, string]> = [
    ['未知键', 'foo: 1\n'],
    ['secret 键(api_key)', 'api_key: sk-very-secret\n'],
    ['secret 键(token 拆段)', 'access_token: abc\n'],
    ['secret 键(bearer)', 'bearer: abc\n'],
    ['preset 非法类型(数字形态)', 'preset: 123\n'],
    ['preset 非法 slug(含空白)', 'preset: "my card"\n'],
    ['temperature 非数字', 'temperature: hot\n'],
    ['temperature 非数字形态(.nan)', 'temperature: .nan\n'],
    ['temperature 非数字形态(inf)', 'temperature: inf\n'],
    ['top_p 非数字', 'top_p: x\n'],
    ['max_tokens 小数', 'max_tokens: 10.5\n'],
    ['max_tokens 小数表示(10.0)', 'max_tokens: 10.0\n'],
    ['timeout_ms 小数', 'timeout_ms: 1000.5\n'],
    ['temperature 越界(>2)', 'temperature: 3\n'],
    ['temperature 负越界', 'temperature: -0.5\n'],
    ['top_p 越界(>1)', 'top_p: 1.5\n'],
    ['max_tokens 越界(0)', 'max_tokens: 0\n'],
    ['max_tokens 越界(负)', 'max_tokens: -5\n'],
    ['timeout_ms 越界(<1000)', 'timeout_ms: 999\n'],
    ['provider 空值', 'provider: ""\n'],
    ['provider 含空白', 'provider: "deep seek"\n'],
    ['model 空值', 'model: ""\n'],
    ['model 含空白', 'model: "bad model"\n'],
    ['reasoning_effort 空值', 'reasoning_effort: ""\n'],
    ['reasoning_effort 含空白', 'reasoning_effort: "vendor high"\n'],
    ['embedding 非法值', 'embedding: llama-local\n'],
    ['重复键', 'model: a\nmodel: b\n'],
    ['嵌套节(执行面不允许)', '  model: x\n'],
    ['无法解析的行', 'this is not yaml\n'],
    ['键缺值', 'model:\n'],
  ];
  for (const [label, text] of bad) {
    it(`${label} → LlmYmlError(issues 非空), 不带半解析配置跑`, () => {
      try {
        parseLlmYmlStrict(text);
        expect.unreachable(`${label} 应 fail-closed`);
      } catch (err) {
        expect(err).toBeInstanceOf(LlmYmlError);
        expect((err as LlmYmlError).issues.length).toBeGreaterThan(0);
      }
    });
  }

  it('合法最小配置 → 全部严格字段解析', () => {
    const out = parseLlmYmlStrict('preset: import-day\nmodel: deepseek-v4-flash\nprovider: deepseek\nreasoning_effort: high\ntemperature: 0.2\ntop_p: 0.8\nmax_tokens: 8192\ntimeout_ms: 900000\nembedding: off\n');
    expect(out).toEqual({
      preset: 'import-day',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      reasoning_effort: 'high',
      temperature: 0.2,
      top_p: 0.8,
      max_tokens: 8192,
      timeout_ms: 900000,
      embedding: 'off',
    });
  });

  it('合法边界零值通过: temperature=0 / top_p=0 / max_tokens=1 / timeout_ms=1000', () => {
    const out = parseLlmYmlStrict('temperature: 0\ntop_p: 0\nmax_tokens: 1\ntimeout_ms: 1000\n');
    expect(out.temperature).toBe(0);
    expect(out.top_p).toBe(0);
    expect(out.max_tokens).toBe(1);
    expect(out.timeout_ms).toBe(1000);
  });

  it('注释行/空行/--- 分隔线忽略; 行内注释剥离', () => {
    const out = parseLlmYmlStrict('# 注释\n\n---\nmodel: m1 # 行内注释\n');
    expect(out).toEqual({ model: 'm1' });
  });

  it('引号字符串值剥离(仅字符串键)', () => {
    const out = parseLlmYmlStrict('preset: "import-day"\nmodel: \'m1\'\n');
    expect(out).toEqual({ preset: 'import-day', model: 'm1' });
  });

  it('secret 键错误消息只报键名, 不含任何值材料(铁律 6/N5)', () => {
    try {
      parseLlmYmlStrict('api_key: sk-super-secret-material-xyz\n');
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).toContain('api_key');
      expect(String((err as Error).message)).not.toContain('sk-super-secret-material-xyz');
    }
  });

  it('审查项 7: malformed 行(api_key = sk-...)错误只报行号/通用原因, 不回显行原文 secret', () => {
    try {
      // 无冒号 → 不匹配 key: value 形态 → 「无法解析的行」路径; 旧实现回显行原文。
      parseLlmYmlStrict('api_key = sk-super-secret-material-xyz\n');
      expect.unreachable();
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toContain('第 1 行'); // 行号
      expect(msg).toContain('格式无法解析'); // 通用原因
      expect(msg).not.toContain('sk-super-secret-material-xyz'); // secret 原文绝不回显
      expect(msg).not.toContain('api_key ='); // 行原文不回显
    }
  });

  it('审查项 7: 数字键值不回显(值可能含 secret 材料), 只报行号+键名+通用原因', () => {
    const cases: Array<[string, string]> = [
      ['temperature 值像 secret', 'temperature: sk-super-secret-material\n'],
      ['max_tokens 小数', 'max_tokens: 10.0\n'],
      ['timeout_ms 小数', 'timeout_ms: 1000.5\n'],
      ['temperature 越界', 'temperature: 3\n'],
      ['top_p 越界', 'top_p: 1.5\n'],
    ];
    for (const [label, text] of cases) {
      try {
        parseLlmYmlStrict(text);
        expect.unreachable(label);
      } catch (err) {
        const msg = String((err as Error).message);
        expect(msg, label).toContain('第 1 行');
        expect(msg, label).not.toContain('sk-super-secret-material');
        expect(msg, label).not.toContain('10.0');
        expect(msg, label).not.toContain('1000.5');
        expect(msg, label).not.toContain('1.5');
        expect(msg, label).not.toContain('3)');
      }
    }
  });

  it('审查项 7: 字符串键值(embedding 非法/数字形态)不回显', () => {
    for (const text of ['embedding: llama-local\n', 'preset: 123\n']) {
      try {
        parseLlmYmlStrict(text);
        expect.unreachable();
      } catch (err) {
        const msg = String((err as Error).message);
        expect(msg).toContain('第 1 行');
        expect(msg).not.toContain('llama-local');
        expect(msg).not.toContain('123');
      }
    }
  });

  it('审查项 7: 行号准确(第 3 行 malformed → 报第 3 行)', () => {
    try {
      parseLlmYmlStrict('model: m1\npreset: ok\napi_key = sk-secret-xyz\n');
      expect.unreachable();
    } catch (err) {
      const msg = String((err as Error).message);
      expect(msg).toContain('第 3 行');
      expect(msg).not.toContain('sk-secret-xyz');
    }
  });
});

describe('resolveExecutionLlmYml(单次快照: 一次 readFileSync 后只解析内存文本, P3 TOCTOU)', () => {
  it('文件缺失 → 空配置(合法, 不抛)', () => {
    const root = makeRoot();
    expect(resolveExecutionLlmYml(root)).toEqual({});
  });

  it('单次读: readFileSync 恰好一次(不存在「读两次文件内容不一致」)', () => {
    const root = makeRoot();
    writeFileSync(path.join(root, '.assistant', 'llm.yml'), 'model: m1\n', 'utf8');
    const spy = vi.mocked(fs.readFileSync);
    spy.mockClear();
    const out = resolveExecutionLlmYml(root);
    expect(out).toEqual({ model: 'm1' });
    // 解析只读一次文件: 快照语义 —— 校验与取值共用同一份内存文本。
    expect(spy.mock.calls.filter((c) => String(c[0]).endsWith('llm.yml'))).toHaveLength(1);
  });

  it('文件内容非法 → LlmYmlError(执行入口 fail-closed)', () => {
    const root = makeRoot();
    writeFileSync(path.join(root, '.assistant', 'llm.yml'), 'timeout_ms: 500\n', 'utf8');
    expect(() => resolveExecutionLlmYml(root)).toThrow(LlmYmlError);
  });

  it('单次快照语义: 解析期间文件被改写, 结果仍基于读取时刻的快照', () => {
    const root = makeRoot();
    const file = path.join(root, '.assistant', 'llm.yml');
    writeFileSync(file, 'model: snapshot-a\n', 'utf8');
    // 先读一次拿快照文本(模拟解析入口), 再改写文件 —— 解析结果必须仍是快照内容。
    const snapshot = readFileSync(file, 'utf8');
    writeFileSync(file, 'model: snapshot-b\n', 'utf8');
    expect(parseLlmYmlStrict(snapshot)).toEqual({ model: 'snapshot-a' });
  });

  it('审查项 2: readExecutionLlmYmlSnapshot 单次读取 immutable 文本快照, 缺失 → undefined', () => {
    const root = makeRoot();
    // 缺失 → undefined(合法空配置信号)
    expect(readExecutionLlmYmlSnapshot(root)).toBeUndefined();
    // 存在 → 单次读取的文本快照; 后续解析复用同一快照(文件再变不影响已读快照)。
    const file = path.join(root, '.assistant', 'llm.yml');
    writeFileSync(file, 'preset: import-day\nmodel: m1\n', 'utf8');
    const snapshot = readExecutionLlmYmlSnapshot(root);
    expect(snapshot).toBe('preset: import-day\nmodel: m1\n');
    writeFileSync(file, 'preset: other\nmodel: m2\n', 'utf8');
    // 同一快照解析出与读取时刻一致的 preset + 直键(双读 TOCTOU 不存在)。
    expect(parseLlmYmlStrict(snapshot as string)).toEqual({ preset: 'import-day', model: 'm1' });
    // 计数: 对 llm.yml 恰好一次读(读两次文件内容不一致的情形不可构造)。
    const spy = vi.mocked(fs.readFileSync);
    spy.mockClear();
    readExecutionLlmYmlSnapshot(root);
    expect(spy.mock.calls.filter((c) => String(c[0]).endsWith('llm.yml'))).toHaveLength(1);
  });
});

describe('legacy resolvePolicy 保持兼容(非执行入口, 独立审查 P3)', () => {
  it('resolvePolicy 仍可用且不抛(未知键被忽略、非法数值被丢弃)', () => {
    const root = makeRoot();
    writeFileSync(
      path.join(root, '.assistant', 'llm.yml'),
      'model: m1\nunknown_key: 1\ntemperature: not-a-number\n',
      'utf8',
    );
    const p = resolvePolicy(root);
    expect(p.llm.model).toBe('m1');
    expect(p.llm.temperature).toBeUndefined(); // legacy: 非法数值丢弃(不抛)
    // 而执行入口(strict)对同一文件 fail-closed:
    expect(() => resolveExecutionLlmYml(root)).toThrow(LlmYmlError);
    // 文件存在(供 existsSync 计数之外的断言)
    expect(existsSync(path.join(root, '.assistant', 'llm.yml'))).toBe(true);
  });
});
