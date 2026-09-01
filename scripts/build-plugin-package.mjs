#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const plugin = join(root, 'plugin')
const lib = join(plugin, 'lib')

rmSync(lib, { recursive: true, force: true })
mkdirSync(lib, { recursive: true })
copyFileSync(join(root, 'LICENSE'), join(plugin, 'LICENSE'))
execFileSync(join(root, 'node_modules', '.bin', 'tsdown'), ['--config', join(plugin, 'tsdown.config.ts')], {
  cwd: root,
  stdio: 'inherit',
})

const clientFile = join(lib, 'client.js')
writeFileSync(clientFile, readFileSync(clientFile, 'utf8').replaceAll(`${root}/`, ''))
