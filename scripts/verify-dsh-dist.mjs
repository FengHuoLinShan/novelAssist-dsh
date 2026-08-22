// N35 验收证据: 真实 import('@novelcraft/dsh') 无 raw exports; internal 入口可用。
// 运行: node scripts/verify-dsh-dist.mjs (依赖已构建的 packages/novelcraft/dsh/dist)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dsh = await import('@novelcraft/dsh');
const internal = await import('@novelcraft/dsh/internal');

// 1) 主入口存在核心服务与能力面。
assert.equal(typeof dsh.NovelCraftService, 'function', 'NovelCraftService 应从主入口导出');
assert.equal(typeof dsh.createNovelCraftCapabilities, 'function', 'createNovelCraftCapabilities 应从主入口导出');

// 2) N35: 主 exports 不暴露 raw 写面 / 工具注册 / deep-import 适配器。
const RAW_FORBIDDEN = [
  'applyAtlasAnnotations', // raw annotation ops(工具不得直接旁路)
  'registerNovelcraftTools', // raw tool registrar → internal
  'ImportTraceSink',
  'importTraceFile',
  'FACADES', // raw facades 命名空间不公开(facades 只作内部 deprecated 别名过渡)
  'WORLD_FACADE',
];
for (const name of RAW_FORBIDDEN) {
  assert.equal(name in dsh, false, `主 exports 不得暴露 raw ${name}`);
}

// 3) 真实服务类原型不再携带 raw 方法(实例面 = 主入口 import 可见面)。
// capabilities 是构造器赋值的实例字段(不在 prototype), 另行经工厂验证。
assert.equal('applyAtlasAnnotations' in dsh.NovelCraftService.prototype, false);
assert.equal('facades' in dsh.NovelCraftService.prototype, false);
assert.equal('applyAtlasAnnotationQueue' in dsh.NovelCraftService.prototype, true);

// 4) capabilities 三分面: authorEdit.annotations 绑定队列入口(唯一受控入口)。
const fakeService = {};
for (const m of [
  'viewMapAtlas', 'inbox', 'ragSearch', 'runStep', 'planMapAtlas', 'importAtlasImage', 'updateAtlasPrompt',
  'createAtlasUploadNode', 'proposeNextChapter', 'generateNextChapter', 'ingestTextFile', 'scanHealth',
  'radarSweep', 'refreshIndex', 'ragSync', 'ragEmbed', 'applyAtlasAnnotationQueue', 'adoptGuarded',
  'worldCreateGuarded', 'worldUpdateGuarded', 'reviewMapAtlasGuarded', 'deepImport',
]) {
  fakeService[m] = () => 'bound';
}
const caps = dsh.createNovelCraftCapabilities(fakeService);
assert.equal(typeof caps.propose.authorEdit.annotations, 'function');
assert.equal('applyAtlasAnnotations' in caps.propose.authorEdit, false);
assert.equal(typeof caps.adoptGuarded.reviewMapAtlas, 'function');

// 5) internal 入口可用: tools 注册器 + deep-import 适配器存在。
assert.equal(typeof internal.registerNovelcraftTools, 'function', 'internal 应导出 registerNovelcraftTools');
assert.equal(typeof internal.importTraceFile, 'function', 'internal 应导出 importTraceFile');
assert.equal(typeof internal.deepImport, 'function', 'internal 应导出 deepImport');

// 6) 构建产物必须真实接到 Tx seam，不能仅靠 source-level spy 或导出形状假绿。
const world = await import('@novelcraft/world');
assert.equal(typeof world.applyAtlasAnnotationOpsTx, 'function', 'world.applyAtlasAnnotationOpsTx 应存在');
const serviceDist = readFileSync(new URL('../packages/novelcraft/dsh/dist/service.js', import.meta.url), 'utf8');
assert.match(serviceDist, /world\.applyAtlasAnnotationOpsTx\(/, 'dist queue 必须调用 transactional annotation API');
assert.doesNotMatch(serviceDist, /world\.applyAtlasAnnotationOps\(/, 'dist queue 不得回退 sync annotation writer');

console.log('verify-dsh-dist: OK');
console.log('  - import("@novelcraft/dsh") 无 raw exports:', RAW_FORBIDDEN.join(', '));
console.log('  - import("@novelcraft/dsh/internal") 可用: registerNovelcraftTools/importTraceFile/deepImport');
console.log('  - NovelCraftService.prototype 无 applyAtlasAnnotations/facades; 有 applyAtlasAnnotationQueue');
console.log('  - capabilities 三分面: authorEdit.annotations = applyAtlasAnnotationQueue(唯一受控入口)');
