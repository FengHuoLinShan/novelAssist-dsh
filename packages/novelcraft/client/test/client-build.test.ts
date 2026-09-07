import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clientBuildEnvironmentDefines,
  clientConfig,
  requestedExternals,
} from '../build-tools/tsdown.client.ts'

describe('DSH client build adapter', () => {
  it('validates requested externals and projects only public client build values', () => {
    // N51: only declared module edges and public build variables cross the bundle boundary.
    expect([...requestedExternals('novelcraft-dsh', ['example/client'])]).toEqual(['example/client'])
    expect([...requestedExternals('novelcraft-dsh', undefined)]).toEqual([])
    expect(() => requestedExternals('novelcraft-dsh', ['ok', 1])).toThrow('must be a string array')

    expect(clientBuildEnvironmentDefines({
      DSH_CLIENT_TITLE: 'NovelCraft',
      DSH_BUILD_CLIENT_PROFILE: 'ignored',
      PRIVATE_VALUE: 'secret',
    })).toEqual({
      'process.env': '{}',
      'process.env.DSH_CLIENT_TITLE': '"NovelCraft"',
    })
  })

  it('inlines all rc.1 CSS forms and rejects feature-plugin value imports', async () => {
    type BuildPlugin = {
      name: string
      resolveId(source: string, importer?: string): string | null
      load(this: { addWatchFile(file: string): void }, id: string): Promise<string | null>
    }
    const plugins = clientConfig('@novelcraft/dsh-client', 'src/client/index.ts').plugins as BuildPlugin[]
    const plugin = (name: string) => plugins.find(item => item.name === name)!
    const root = mkdtempSync(join(tmpdir(), 'novelcraft-client-build-'))
    const watched: string[] = []
    try {
      for (const name of ['module.module.css', 'global.css', 'inline.css']) {
        writeFileSync(join(root, name), '.sample { color: red; }')
      }
      const load = async (name: string, source: string) => {
        const item = plugin(name)
        const id = item.resolveId(source, join(root, 'entry.ts'))!
        return item.load.call({ addWatchFile: file => watched.push(file) }, id)
      }
      // N51: module/global styles retain plugin ownership; ?inline is text without a DOM effect.
      expect(await load('dsh-css-modules-inline', './module.module.css')).toContain('export default {"sample":')
      expect(await load('dsh-css-global-inline', './global.css')).toContain('tag.dataset.plugin = "@novelcraft/dsh-client"')
      const inline = await load('dsh-css-text-inline', './inline.css?inline')
      expect(inline).toContain('export default')
      expect(inline).not.toContain('document')
      expect(watched).toHaveLength(3)

      const purity = plugin('dsh-client-bundle-purity')
      expect(purity.resolveId('@deepseek-ai/dsh-client-ui-primitives')).toBeNull()
      expect(purity.resolveId('@deepseek-ai/dsh-file-reference')).toBeNull()
      expect(() => purity.resolveId('@deepseek-ai/dsh-client-ui-conversation/client'))
        .toThrow('cross-plugin value imports are forbidden')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
