// M5 client UI 模块级冒烟(无浏览器): 执行 dist/client.js 的 closure-factory,
// 桩 platform 模块(primitives), 真实 react/react-dom/server 渲染 PetAction,
// 断言: locale 注册、会话头插槽注入(id=novelcraft-pet)、宠物按钮渲染(aria-label)。
// 运行: node scripts/m5-client-smoke.mjs
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const bundlePath = fileURLToPath(new URL('../packages/novelcraft/client/dist/client.js', import.meta.url))
const source = readFileSync(bundlePath, 'utf8')

// ---- 桩 platform 模块(primitives; react/jsx-runtime 走真实包) ----
const primitivesStub = {
  StateDot: ({ state }) => createElement('span', { 'data-dot': state }),
  Button: ({ children, ...rest }) => createElement('button', rest, children),
  Modal: ({ open, title, children, contentClassName }) =>
    open ? createElement('div', { className: contentClassName, 'data-modal-title': title }, children) : null,
}

let captured = { load: null }
const moduleLoaderStub = {
  load: (record) => { captured.load = record },
}

// 工厂在 window 上执行(banner 引用 window.__ModuleLoader__)
const stubRequire = (id) => {
  if (id === 'react') return require_('react')
  if (id === 'react/jsx-runtime') return require_('react/jsx-runtime')
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
  throw new Error(`unexpected external: ${id}`)
}

globalThis.window = { __ModuleLoader__: moduleLoaderStub }
// banner 执行即调用 window.__ModuleLoader__.load; 再显式执行工厂得到 exports。
new Function('require', source)(stubRequire)
const exports_ = captured.load.factory(stubRequire)
const { apply, inject, PetAction } = exports_

// ---- 桩客户端 ctx ----
const calls = { locale: [], slots: [] }
const ctx = {
  effect: (fn) => { fn() },
  locale: { register: (ns, dicts) => calls.locale.push({ ns, dicts }) },
  slots: {
    register: (options, Component) => ({ ...options, Component }),
    inject: (slotName, registerCb) => calls.slots.push({ slotName, register: registerCb() }),
  },
  get: (name) => (name === 'connection' ? { rpc: { call: async () => ({ ok: true, value: {} }) } } : undefined),
}

apply(ctx)

// ---- 断言 1: locale + 插槽注册 ----
if (!calls.locale.some((l) => l.ns === 'novelcraft')) {
  throw new Error('FAIL: locale 未注册 novelcraft 字典')
}
const slot = calls.slots.find((s) => s.slotName === 'conversation.session.header.actions')
if (!slot || slot.register.id !== 'novelcraft-pet') {
  throw new Error(`FAIL: 会话头插槽注入缺失或 id 错误: ${JSON.stringify(calls.slots)}`)
}

// ---- 断言 2: PetAction 真实渲染(静默态, 无 session) ----
const html = renderToStaticMarkup(
  createElement(PetAction, {
    sessionId: undefined,
    t: (key) => ({ 'pet.title': 'NovelCraft 守望', 'pet.silent': '静默' }[key] ?? key),
    connection: { rpc: { call: async () => ({ ok: true, value: { bound: null, open: 0, attention: false, threshold: 5, radarRunning: false } }) } },
  }),
)
if (!html.includes('NovelCraft 守望') || !html.includes('静默')) {
  throw new Error(`FAIL: 宠物按钮渲染缺 aria/title 或静默态: ${html.slice(0, 300)}`)
}

console.log('M5 client 模块冒烟 ✓')
console.log(`  module id = ${captured.load.id}`)
console.log(`  inject = [${inject.join(', ')}]`)
console.log(`  slots = [${calls.slots.map((s) => s.slotName).join(', ')}]`)
console.log(`  pet render = ${html.slice(0, 220)}...`)
