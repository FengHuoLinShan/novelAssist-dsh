// tsdown 入口: 只产出 browser client bundle(dist/client.js, closure-factory)。
// node 半身由 tsc 单独构建(dist/index.js)。预设 = vendor 的 DSH 共享配置。
import { clientConfig } from './build-tools/tsdown.client.ts'

export default [
  clientConfig('@novelcraft/dsh-client', 'src/client/index.ts'),
]
