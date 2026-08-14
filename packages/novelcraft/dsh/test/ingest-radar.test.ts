// Track 1b/2b 契约: novelcraft_ingest_file 文本入库工具 + 雷达事件钩子 + novelcraft_radar_sweep。
// 断言引: D9a(纯文本入库)、设计 §11(事件触发, 非定时)、§7(六雷达信号)、imports.md §41(幂等)。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { listSignals } from '@novelcraft/assistant';
import { gitAdd, gitCommit, serializeFrontmatter } from '@novelcraft/store';
import { NovelCraftService } from '../src/index.js';
import { makeContext, type HarnessServices } from './helpers.js';

const fakeAgent = { id: 'a1', session: { id: 's1' } } as never;

interface TestEnv {
  h: HarnessServices;
  service: NovelCraftService;
  vaultsDir: string;
  root: string;
  tools: ToolDefinition[];
  exec: { callId: string; name: string; arguments: unknown; agent: unknown; signal: AbortSignal };
  workDir: string;
}

const envs: TestEnv[] = [];
async function setup(): Promise<TestEnv> {
  const h = await makeContext({ approval: { outcome: 'allowed-once' } });
  const vaultsDir = mkdtempSync(path.join(os.tmpdir(), 'nc-ingest-'));
  const tools: ToolDefinition[] = [];
  h.ctx.provide('tools', {
    register(def: ToolDefinition) {
      tools.push(def);
      return () => {};
    },
  });
  await h.ctx.plugin(NovelCraftService, {
    llm: { provider: 'fake', model: 'fake-model' },
    vaultsDir,
    watch: { enabled: false, intervalMinutes: 60 },
  });
  const service = h.ctx.novelcraft;
  const binding = service.vaults.ensureVault('测试书');
  await service.vaults.bindSession('s1', binding);
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'nc-manuscript-'));
  const env: TestEnv = {
    h,
    service,
    vaultsDir,
    root: binding.root,
    tools,
    exec: { callId: 'c1', name: '', arguments: {}, agent: fakeAgent, signal: new AbortController().signal },
    workDir,
  };
  envs.push(env);
  return env;
}
afterEach(() => {
  for (const e of envs.splice(0)) {
    rmSync(e.vaultsDir, { recursive: true, force: true });
    rmSync(e.workDir, { recursive: true, force: true });
  }
});

const tool = (env: TestEnv, name: string): ToolDefinition => {
  const t = env.tools.find((x) => x.name === name);
  if (!t) throw new Error(`工具未注册: ${name}`);
  return t;
};
const call = async (env: TestEnv, name: string, args: Record<string, unknown>) =>
  (await tool(env, name).execute(args as never, env.exec as never)) as Record<string, unknown>;

const SAMPLE = [
  '序章',
  '一切从这里开始。',
  '',
  '第一章 雨夜',
  '雨下了一夜。林晚推开窗。',
  '',
  '第二章 对峙',
  '苏婉站在桥上。',
  '',
  '第三章 黎明',
  '天亮了。',
].join('\n');

describe('novelcraft_ingest_file(Track 1b 文本入库, D9a)', () => {
  it('样例 txt → 4 章落库 + 原文停靠 + import-log + 索引重建 + 摄入雷达钩子落信号', async () => {
    const env = await setup();
    const file = path.join(env.workDir, '手稿.txt');
    writeFileSync(file, SAMPLE, 'utf8');
    const r = await call(env, 'novelcraft_ingest_file', { root: env.root, file_path: file });
    expect(r.ok).toBe(true);
    expect(r.total).toBe(4); // 序章 + 三章
    expect(r.imported).toBe(4);
    // chapters/001..004.md 落库
    for (let i = 1; i <= 4; i++) {
      const f = path.join(env.root, 'chapters', `${String(i).padStart(3, '0')}.md`);
      expect(existsSync(f)).toBe(true);
      expect(readFileSync(f, 'utf8')).toContain('content_hash:');
    }
    // imports/ 原文停靠 + import-log(imports.md §41/§95)
    expect(existsSync(path.join(env.root, 'imports', '手稿.md'))).toBe(true);
    const log = readFileSync(path.join(env.root, 'imports', 'import-log.jsonl'), 'utf8');
    expect(log).toContain('"file_name":"手稿.txt"');
    expect(log).toContain('"status":"done"');
    // 事件钩子(§11): 摄入雷达对账 —— 新章无 Scene 覆盖 → ingest- 前缀信号落盘
    const signals = listSignals(env.root);
    expect(signals.some((s) => s.id.startsWith('ingest-uncovered-ch1'))).toBe(true);
    expect(String(r.message)).toContain('深度导入');
  });

  it('幂等: 同文件二次导入 → duplicate_import, 不写任何文件', async () => {
    const env = await setup();
    const file = path.join(env.workDir, '手稿.txt');
    writeFileSync(file, SAMPLE, 'utf8');
    await call(env, 'novelcraft_ingest_file', { root: env.root, file_path: file });
    const before = readFileSync(path.join(env.root, 'imports', 'import-log.jsonl'), 'utf8');
    const r = await call(env, 'novelcraft_ingest_file', { root: env.root, file_path: file });
    expect(r.ok).toBe(true);
    expect(String(r.message)).toContain('幂等');
    const after = readFileSync(path.join(env.root, 'imports', 'import-log.jsonl'), 'utf8');
    expect(after).toBe(before); // import-log 未新增(§41 幂等键)
  });

  it('.docx 拒绝(作者语言) + 缺失文件拒绝', async () => {
    const env = await setup();
    const docx = path.join(env.workDir, '书稿.docx');
    writeFileSync(docx, 'fake', 'utf8');
    const r1 = await call(env, 'novelcraft_ingest_file', { root: env.root, file_path: docx });
    expect(r1.ok).toBe(false);
    expect(String(r1.message)).toContain('.docx'); // 门禁作者语言(白名单提示)
    const r2 = await call(env, 'novelcraft_ingest_file', { root: env.root, file_path: path.join(env.workDir, '不存在.txt') });
    expect(r2.ok).toBe(false);
  });
});

describe('novelcraft_radar_sweep + 事件钩子(Track 2b, §7/§11)', () => {
  it('手动巡检: 疑似重复对象 → dedup 信号; 二次扫描幂等; plot_summary 是一句话', async () => {
    const env = await setup();
    // 构造归一化同名组(R28): 两个 canonical 对象「苏 婉」/「苏  婉」
    for (const [slug, name] of [['suwan-a', '苏 婉'], ['suwan-b', '苏  婉']] as const) {
      writeFileSync(
        path.join(env.root, 'world', 'objects', `${slug}.md`),
        serializeFrontmatter({ id: slug, kind: 'character', name, status: 'canonical' }, `${name}正文`),
        'utf8',
      );
    }
    const r = await call(env, 'novelcraft_radar_sweep', { root: env.root });
    expect(r.ok).toBe(true);
    expect(String(r.plot_summary)).toContain('全书');
    const dedupSignals = listSignals(env.root).filter((s) => s.id.startsWith('dedup-'));
    expect(dedupSignals.length).toBeGreaterThan(0);
    // 幂等: 再扫 → created=0(对账 skipped)
    const r2 = await call(env, 'novelcraft_radar_sweep', { root: env.root, radar: 'dedup' });
    const results = r2.results as Record<string, { created: number; skipped: number }>;
    expect(results.dedup.created).toBe(0);
    expect(results.dedup.skipped).toBeGreaterThan(0);
  });

  it('adopt 事件钩子: adopt 成功后自动跑去重+风险雷达(§11 事件触发)', async () => {
    const env = await setup();
    // 预置归一化同名 canonical 组, adopt 无关对象后钩子应产生 dedup 信号
    for (const [slug, name] of [['hong-a', '红 衣'], ['hong-b', '红  衣']] as const) {
      writeFileSync(
        path.join(env.root, 'world', 'objects', `${slug}.md`),
        serializeFrontmatter({ id: slug, kind: 'character', name, status: 'canonical' }, '正文'),
        'utf8',
      );
    }
    writeFileSync(
      path.join(env.root, 'world', 'pending', 'pend_x.md'),
      serializeFrontmatter({ id: 'pend_x', kind: 'character', name: '路人甲', status: 'candidate' }, '候选正文'),
      'utf8',
    );
    // adopt 的 CAS 前提: 工作区须干净(store-rules: 脏时拒绝), fixture 落盘后提交。
    gitAdd(env.root);
    gitCommit(env.root, 'fixture');
    expect(listSignals(env.root).some((s) => s.id.startsWith('dedup-'))).toBe(false);
    const r = await call(env, 'novelcraft_store_adopt', { root: env.root, kind: 'object', ref: 'pend_x' });
    expect(r.ok).toBe(true);
    expect(listSignals(env.root).some((s) => s.id.startsWith('dedup-'))).toBe(true);
  });

  it('空 vault 巡检: 五面零计数不炸, plot_summary 兜底', async () => {
    const env = await setup();
    const r = await call(env, 'novelcraft_radar_sweep', { root: env.root });
    expect(r.ok).toBe(true);
    expect(typeof r.plot_summary).toBe('string');
  });
});
