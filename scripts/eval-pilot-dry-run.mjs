#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evalRoot = path.join(repoRoot, 'evals', 'deepseek-v4-flash');
const catalogPath = path.join(evalRoot, 'catalog.json');
const fixturesPath = path.join(evalRoot, 'fixtures.json');
const EXPECTED_CATEGORIES = [
  'json_schema_first_pass', 'scene_slicing', 'entity_extraction', 'alias_relation',
  'structure_analysis', 'continuation_proposal', 'chapter_prose', 'semantic_review',
  'targeted_revision', 'outline_world_planning', 'rag_rerank_abstention',
  'continuity_pov_knowledge_foreshadowing',
];
const EXPECTED_PILOT_CHAINS = [
  'structure_analysis', 'continuation_proposal', 'chapter_prose', 'semantic_review',
];

function fail(message) {
  throw new Error(`eval dry-run: ${message}`);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    fail(`无法读取 JSON ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validIsoDate(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function sameStrings(left, right) {
  return [...left].sort().join('\n') === [...right].sort().join('\n');
}

function validateCatalog(catalog, fixtureSet) {
  if (!catalog || typeof catalog !== 'object') fail('catalog 必须是对象');
  if (!Array.isArray(catalog.categories) || catalog.categories.length !== 12) {
    fail('catalog 必须恰好覆盖 12 类任务');
  }
  if (!Array.isArray(catalog.pilot_chains) || catalog.pilot_chains.length !== 4) {
    fail('pilot_chains 必须恰好为四条首轮链');
  }
  if (catalog.candidate_model !== 'deepseek-v4-flash' || catalog.pilot_effort !== 'high') {
    fail('catalog candidate_model/pilot_effort 必须固定为 deepseek-v4-flash/high');
  }
  if (!sameStrings(catalog.categories.map((category) => category.id), EXPECTED_CATEGORIES)) {
    fail('catalog 必须精确覆盖冻结的 12 类任务');
  }
  if (!sameStrings(catalog.pilot_chains, EXPECTED_PILOT_CHAINS)) {
    fail('pilot_chains 必须精确为冻结的四条链');
  }
  if (catalog.repetitions !== 3) fail('repetitions 必须为 3');
  const ids = new Set();
  for (const category of catalog.categories) {
    if (!nonEmptyString(category.id) || ids.has(category.id)) fail('category id 必须非空且唯一');
    ids.add(category.id);
    if (!['ready', 'contract_only', 'blocked'].includes(category.status)) {
      fail(`category ${category.id} status 非法`);
    }
    if (!nonEmptyString(category.spec_ref)) fail(`category ${category.id} 缺 spec_ref`);
    if (category.status === 'ready') {
      if (!Array.isArray(category.fixture_ids) || category.fixture_ids.length !== 3) {
        fail(`ready category ${category.id} 必须恰好绑定 3 个 fixture`);
      }
      if (new Set(category.fixture_ids).size !== 3) fail(`ready category ${category.id} fixture 不得重复`);
      for (const fixtureId of category.fixture_ids) {
        if (!fixtureSet.has(fixtureId)) fail(`category ${category.id} 引用未知 fixture ${fixtureId}`);
      }
    } else if (!nonEmptyString(category.reason)) {
      fail(`非 ready category ${category.id} 必须解释原因`);
    }
  }
  if (!catalog.pilot_chains.every((id) => ids.has(id))) fail('pilot_chains 含未知 category');
  const ready = catalog.categories.filter((category) => category.status === 'ready').map((category) => category.id);
  if (!sameStrings(ready, catalog.pilot_chains)) fail('ready categories 必须与 pilot_chains 完全一致');
  const pilotFixtureIds = catalog.categories
    .filter((category) => category.status === 'ready')
    .flatMap((category) => category.fixture_ids);
  if (new Set(pilotFixtureIds).size !== 12 || !sameStrings(pilotFixtureIds, fixtureSet)) {
    fail('四条 pilot 必须覆盖 12 个互异 synthetic fixture');
  }
}

function validateFixtures(document) {
  if (document?.data_policy !== 'synthetic') fail('fixture 只允许 synthetic 数据');
  if (!Array.isArray(document.fixtures) || document.fixtures.length !== 12) {
    fail('首轮四链必须恰好提供 12 个 fixture');
  }
  const ids = new Set();
  for (const fixture of document.fixtures) {
    if (!nonEmptyString(fixture.id) || ids.has(fixture.id)) fail('fixture id 必须非空且唯一');
    ids.add(fixture.id);
    if (!nonEmptyString(fixture.chain) || !nonEmptyString(fixture.input)) {
      fail(`fixture ${fixture.id} 缺 chain/input`);
    }
    if (!Array.isArray(fixture.checks) || fixture.checks.length === 0 || !fixture.checks.every(nonEmptyString)) {
      fail(`fixture ${fixture.id} 缺可执行 checks`);
    }
  }
  return ids;
}

function validateAuthorization(auth, fixtureIds) {
  const issues = [];
  if (!auth || typeof auth !== 'object') return ['authorization_manifest_missing'];
  if (auth.version !== '1.0.0') issues.push('version_must_equal_1_0_0');
  const strings = [
    'model',
    'effort',
    'output_directory',
    'authorized_by',
    'authorized_at',
    'currency',
    'official_pricing_url',
    'pricing_verified_at',
    'model_verified_at',
  ];
  for (const field of strings) if (!nonEmptyString(auth[field])) issues.push(`${field}_missing`);
  if (!Array.isArray(auth.fixture_ids) || !sameStrings(auth.fixture_ids, fixtureIds)) {
    issues.push('fixture_ids_mismatch');
  }
  if (auth.model !== 'deepseek-v4-flash') issues.push('model_must_be_deepseek_v4_flash');
  if (auth.effort !== 'high') issues.push('effort_must_be_high');
  if (!Number.isSafeInteger(auth.seed) || auth.seed < 0) issues.push('seed_invalid');
  if (auth.max_logical_calls !== 36) issues.push('max_logical_calls_must_equal_36');
  if (auth.max_physical_calls !== 72) issues.push('max_physical_calls_must_equal_72');
  for (const field of ['per_call_output_token_cap', 'max_total_input_tokens', 'max_total_output_tokens']) {
    if (!Number.isSafeInteger(auth[field]) || auth[field] < 1) issues.push(`${field}_invalid`);
  }
  if (!Number.isFinite(auth.estimated_cost_cap) || auth.estimated_cost_cap <= 0) {
    issues.push('estimated_cost_cap_invalid');
  }
  if (nonEmptyString(auth.output_directory) &&
      (!path.isAbsolute(auth.output_directory) || path.resolve(auth.output_directory) === path.parse(auth.output_directory).root)) {
    issues.push('output_directory_must_be_safe_absolute_path');
  }
  if (nonEmptyString(auth.official_pricing_url) && !auth.official_pricing_url.startsWith('https://')) {
    issues.push('official_pricing_url_must_be_https');
  }
  for (const field of ['authorized_at', 'pricing_verified_at', 'model_verified_at']) {
    if (nonEmptyString(auth[field]) && !validIsoDate(auth[field])) issues.push(`${field}_invalid`);
  }
  if (typeof auth.rolling_alias !== 'boolean') issues.push('rolling_alias_invalid');
  return [...new Set(issues)].sort();
}

export async function buildDryRun(authorizationPath) {
  const fixturesDocument = await readJson(fixturesPath);
  const fixtureIds = validateFixtures(fixturesDocument);
  const catalog = await readJson(catalogPath);
  validateCatalog(catalog, fixtureIds);
  const fixtures = new Map(fixturesDocument.fixtures.map((fixture) => [fixture.id, fixture]));
  const ready = new Map(catalog.categories.map((category) => [category.id, category]));
  const calls = [];
  for (const chain of catalog.pilot_chains) {
    const category = ready.get(chain);
    for (const fixtureId of category.fixture_ids) {
      const fixture = fixtures.get(fixtureId);
      if (fixture.chain !== chain) fail(`fixture ${fixtureId} chain 与 catalog 不一致`);
      for (let repeat = 1; repeat <= catalog.repetitions; repeat += 1) {
        calls.push({
          logical_call_id: `${chain}:${fixtureId}:r${repeat}`,
          chain,
          spec_ref: category.spec_ref,
          fixture_id: fixtureId,
          fixture_hash: sha256(fixture),
          repeat,
          requested_model: catalog.candidate_model,
          requested_effort: catalog.pilot_effort,
          prompt_hash_status: 'runtime_required',
        });
      }
    }
  }
  if (calls.length !== 36) fail(`逻辑调用必须为 36，实际 ${calls.length}`);
  const authorization = authorizationPath ? await readJson(path.resolve(authorizationPath)) : undefined;
  const authorizationIssues = validateAuthorization(authorization, fixtureIds);
  return {
    version: '1.0.0',
    mode: 'dry-run',
    provider_calls: 0,
    paid_execution_available: false,
    data_policy: fixturesDocument.data_policy,
    authorization: {
      provided: authorization !== undefined,
      valid: authorizationIssues.length === 0,
      issues: authorizationIssues,
      ...(authorization !== undefined ? {
        manifest: {
          version: authorization.version,
          model: authorization.model,
          effort: authorization.effort,
          seed: authorization.seed,
          rolling_alias: authorization.rolling_alias,
        },
      } : {}),
    },
    limits: {
      logical_calls: 36,
      maximum_physical_calls_if_later_authorized: 72,
    },
    ready_categories: catalog.pilot_chains,
    contract_only_categories: catalog.categories
      .filter((category) => category.status === 'contract_only')
      .map((category) => ({ id: category.id, reason: category.reason })),
    blocked_categories: catalog.categories
      .filter((category) => category.status === 'blocked')
      .map((category) => ({ id: category.id, reason: category.reason })),
    calls,
  };
}

function parseArgs(argv) {
  const parsed = { authorization: undefined, selfTest: false, execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-test') parsed.selfTest = true;
    else if (arg === '--execute') parsed.execute = true;
    else if (arg === '--authorization') {
      const value = argv[++index];
      if (!nonEmptyString(value) || value.startsWith('--')) fail('--authorization 必须紧跟 JSON 路径');
      parsed.authorization = value;
    }
    else fail(`未知参数 ${arg}`);
  }
  return parsed;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.execute) {
      fail('此 runner 只支持 dry-run；真实付费执行尚未获用户费用/数据授权，且必须另接 DSH ctx.llm');
    }
    const report = await buildDryRun(args.authorization);
    if (args.authorization && !report.authorization.valid) {
      fail(`授权清单无效: ${report.authorization.issues.join(', ')}`);
    }
    if (args.selfTest) {
      if (report.provider_calls !== 0 || report.limits.logical_calls !== 36 || report.calls.length !== 36 ||
          report.authorization.valid || !report.authorization.issues.includes('authorization_manifest_missing')) {
        fail('self-test 断言失败');
      }
      process.stdout.write(`${JSON.stringify({ self_test: 'ok', provider_calls: 0, logical_calls: 36, authorization_gate: 'ok' })}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
