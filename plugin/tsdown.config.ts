import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientConfig } from '../packages/novelcraft/client/build-tools/tsdown.client.ts'

const pathFromRoot = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))
const outDir = fileURLToPath(new URL('./lib', import.meta.url))

const host: UserConfig = {
  name: 'novelcraft-dsh/host',
  entry: {
    index: pathFromRoot('packages/novelcraft/dsh/src/index.ts'),
    'client-host': pathFromRoot('packages/novelcraft/client/src/index.ts'),
  },
  outDir,
  format: 'esm',
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: false,
  outputOptions: {
    entryFileNames: '[name].js',
  },
  deps: {
    neverBundle: [/^@deepseek-ai\//, '@novelcraft/rag-bge'],
    alwaysBundle: (id: string) => {
      if (id === '@novelcraft/rag-bge') return undefined
      if (id.startsWith('@novelcraft/')) return true
      if (id === 'yaml' || id === 'zod') return true
      return undefined
    },
  },
}

const browser: UserConfig = {
  ...clientConfig('novelcraft-dsh', pathFromRoot('packages/novelcraft/client/src/client/index.ts')),
  outDir,
  clean: false,
  sourcemap: false,
}

export default [host, browser]
