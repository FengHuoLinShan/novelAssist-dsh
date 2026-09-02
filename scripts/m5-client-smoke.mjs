// M5 client UI 模块级冒烟(无浏览器): 执行 dist/client.js 的 closure-factory,
// 桩 platform 模块(primitives), 真实 react/react-dom/server 渲染客户端入口,
// 断言: locale 注册、会话头/空白会话插槽注入与文字按钮渲染。
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
  Button: ({ children, icon, ...rest }) => createElement('button', rest, icon, children),
  Pill: ({ children, onClick, ...rest }) => createElement(onClick ? 'button' : 'span', { ...rest, onClick }, children),
  Input: (props) => createElement('input', props),
  IconRefreshOutline16: () => createElement('span', { 'data-icon': 'refresh' }),
  Modal: ({ open, title, children, className, contentClassName }) =>
    open ? createElement('div', { className: `${className ?? ''} ${contentClassName ?? ''}`, 'data-modal-title': title }, children) : null,
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
const { apply, inject, PetAction, ChapterWorkspaceView } = exports_
if (captured.load.id !== '@novelcraft/dsh-client') {
  throw new Error(`FAIL: rc.8 client bundle id 使用了保留后缀或意外名称: ${captured.load.id}`)
}

// ---- 桩客户端 ctx ----
const calls = { locale: [], slots: [] }
const ctx = {
  effect: (fn) => { fn() },
  locale: {
    register: (ns, dicts) => calls.locale.push({ ns, dicts }),
    bind: () => (key) => key,
  },
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
const slot = calls.slots.find((s) => s.register.id === 'novelcraft-pet')
if (!slot || slot.register.id !== 'novelcraft-pet') {
  throw new Error(`FAIL: 会话头插槽注入缺失或 id 错误: ${JSON.stringify(calls.slots)}`)
}
const actionDockSlot = calls.slots.find((s) => s.register.id === 'novelcraft-actions')
if (!actionDockSlot || actionDockSlot.slotName !== 'conversation.input.dock') {
  throw new Error(`FAIL: 空白会话功能栏缺失或插槽错误: ${JSON.stringify(calls.slots)}`)
}
const chapterSlot = calls.slots.find((s) => s.slotName === 'conversation.view')
if (!chapterSlot || chapterSlot.register.id !== 'novelcraft-chapters' || chapterSlot.register.order !== 20) {
  throw new Error(`FAIL: rc.8 conversation.view 章节标签缺失或注册错误: ${JSON.stringify(calls.slots)}`)
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

const dockHtml = renderToStaticMarkup(
  createElement(actionDockSlot.register.Component, {
    sessionId: 's1',
    session: { blank: true },
    input: {},
    t: (key) => ({
      'actions.title': 'NovelCraft 功能',
      'book.title': '书库',
      'pet.title': 'NovelCraft 守望',
      'pet.silent': '静默',
      'workflow.title': '长任务',
      'story.title': '剧情地图',
      'desk.title': '写作台',
      'preset.title': '模型预设',
      'atlas.title': '地图册',
      'world.title': '世界书',
    }[key] ?? key),
    connection: undefined,
    useInput: (select) => select({ draft: '' }),
    inputActions: { setDraft: () => {}, submit: () => {} },
  }),
)
if (!dockHtml.includes('NovelCraft 功能') || !dockHtml.includes('地图册') || dockHtml.includes('🗺')) {
  throw new Error(`FAIL: 空白会话功能栏或地图文字入口渲染错误: ${dockHtml.slice(0, 500)}`)
}
const activeDockHtml = renderToStaticMarkup(
  createElement(actionDockSlot.register.Component, { session: { blank: false } }),
)
if (activeDockHtml !== '') throw new Error(`FAIL: 已开始会话重复渲染功能栏: ${activeDockHtml}`)

const chapterHtml = renderToStaticMarkup(
  createElement(ChapterWorkspaceView, {
    sessionId: 's1',
    t: (key) => ({ 'chapter.view': '章节正文', 'chapter.unbound': '未绑定', 'chapter.select': '选择章节', 'chapter.empty': '无章节', 'chapter.refresh': '刷新' }[key] ?? key),
    connection: undefined,
    useInput: (select) => select({ draft: '' }),
    inputActions: { setDraft: () => {}, submit: () => {} },
  }),
)
if (!chapterHtml.includes('章节正文') || !chapterHtml.includes('未绑定')) {
  throw new Error(`FAIL: 章节 conversation.view 渲染失败: ${chapterHtml.slice(0, 300)}`)
}

console.log('M5 client 模块冒烟 ✓')
console.log(`  module id = ${captured.load.id}`)
console.log(`  inject = [${inject.join(', ')}]`)
console.log(`  slots = [${calls.slots.map((s) => s.slotName).join(', ')}]`)
console.log(`  pet render = ${html.slice(0, 220)}...`)
console.log(`  blank-session actions = ${dockHtml.slice(0, 260)}...`)
console.log(`  chapter view = ${chapterHtml.slice(0, 220)}...`)
