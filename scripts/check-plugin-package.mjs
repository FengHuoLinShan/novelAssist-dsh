#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))
const plugin = join(root, 'plugin')
const manifest = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))
const patch = parse(readFileSync(join(plugin, 'cordis.patch.yml'), 'utf8'))
const required = ['lib/index.js', 'lib/client-host.js', 'lib/client.js', 'LICENSE']

if (manifest.name !== 'novelcraft-dsh' || manifest.private === true || manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('invalid public DSH bundle manifest')
}
if (!Array.isArray(patch) || !JSON.stringify(patch).includes('novelcraft-dsh/client-host')) {
  throw new Error('bundle patch does not mount both NovelCraft host faces')
}
for (const file of required) {
  if (!existsSync(join(plugin, file))) throw new Error(`missing plugin artifact: ${file}`)
}
for (const file of ['lib/index.js', 'lib/client-host.js', 'lib/client.js']) {
  const source = readFileSync(join(plugin, file), 'utf8')
  if (/(?:from\s*|import\s*\()\s*['"]@novelcraft\//.test(source)) {
    throw new Error(`${file} leaks a private @novelcraft runtime import`)
  }
  if (source.includes(`${root}/`) || /\/(?:Users|home)\//.test(source)) {
    throw new Error(`${file} leaks an absolute build path`)
  }
}
console.log('plugin package OK: novelcraft-dsh host/client bundle is self-contained')
