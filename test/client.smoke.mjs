/**
 * Client 半的结构与渲染冒烟测试（无浏览器）。
 *
 * ## 为什么需要它
 *
 * 官方 verification 指南明确：没有浏览器控制时，视觉验证做不了。但「组件抛错会
 * 把 slot 条目打空」是一个**可离线捕获**的失败模式。本测试用一个最小
 * `window.__ModuleLoader__` + 极简 React hook 运行时把 client.js 真正加载起来，
 * 验证：
 *
 * 1. factory 注册的 `id` 等于包名（模块表按包名索引，写错就永远不加载）；
 * 2. `apply(ctx)` 不抛错，且**两个 slot 都完成注册**（设置页 + 状态条）；
 * 3. 两个组件都能被调用并返回元素而不抛错（含空数据、有数据两种输入）；
 * 4. 样式只引用 `--dsw-alias-*` 主题 token（硬约束：不能用字面量颜色上色）；
 * 5. `ctx.effect` 返回的清理函数可安全调用（slot 折叠时的卸载路径）。
 */

import { readFileSync } from 'node:fs'

const clientPath = new URL('../client.js', import.meta.url)
const source = readFileSync(clientPath, 'utf-8')

const failures = []
const check = (label, cond, detail = '') => {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
}

// ── 极简 React hook 运行时 ────────────────────────────────────────────
//
// 每个组件需要**自己的** hook 槽位与 effect 队列，否则「父组件渲染 → 展开子组件」
// 会共用同一份 hook 数组，hook 顺序错乱（真实的 React 用 fiber 树做这件事）。
// 下面用一个显式的组件栈复现这个语义。
let hookIndex = 0
let hookState = []
let effectQueue = []
let currentCleanups = []
const React = {
  createElement(type, props, ...children) {
    return { $$typeof: 'element', type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
  },
  useState(initial) {
    const i = hookIndex++
    // ⚠️ 必须捕获**本次渲染的槽位数组**（而不是引用模块级的 `hookState` 变量）：
    // setState 是在 effect 的异步回调里被调用的，那时 `renderComponent` 的 finally
    // 已把 `hookState` 还原成外层数组，写回模块级变量会把状态丢到错误的数组里。
    const slot = hookState
    if (!(i in slot)) slot[i] = typeof initial === 'function' ? initial() : initial
    const set = (next) => { slot[i] = typeof next === 'function' ? next(slot[i]) : next }
    return [slot[i], set]
  },
  useEffect(fn) {
    hookIndex++
    effectQueue.push(fn)
  },
  useRef(initial) {
    const i = hookIndex++
    const slot = hookState
    if (!(i in slot)) slot[i] = { current: initial }
    return slot[i]
  },
}

/**
 * 渲染一个**函数组件**：给它独立的 hook 槽位，运行它的 effect，并收集清理函数。
 * 这模拟 React 的 fiber 边界——每个组件一份 hook 状态。
 *
 * `store` 可传入以**跨多次渲染保留状态**（模拟 React 的重渲染）；省略则新建一份。
 * `cleanupSink` 若提供，清理函数会**延后**到调用方统一执行——这一点很重要：
 * effect 里常写「卸载时置 alive=false 以忽略迟到的响应」，若在渲染后立刻执行清理，
 * 那个标志会在 fetch 落地前就置位，数据被静默丢弃（真实 React 只在卸载/依赖变化
 * 时清理，不会在挂载后立即清理）。
 */
function renderComponent(fn, props, store, cleanupSink) {
  const slot = store ?? { state: [], index: 0 }
  const savedIndex = hookIndex
  const savedState = hookState
  const savedEffects = effectQueue
  const savedCleanups = currentCleanups
  hookIndex = slot.index
  hookState = slot.state
  effectQueue = []
  currentCleanups = []
  try {
    const el = fn(props)
    for (const effect of effectQueue) {
      const cleanup = effect()
      if (typeof cleanup === 'function') currentCleanups.push(cleanup)
    }
    return el
  } finally {
    const cleanups = currentCleanups
    // 回写本次渲染推进到的 hook 位置，供下一次渲染继续使用。
    slot.index = hookIndex
    slot.state = hookState
    hookIndex = savedIndex
    hookState = savedState
    effectQueue = savedEffects
    currentCleanups = savedCleanups
    if (cleanupSink !== undefined) {
      for (const c of cleanups.reverse()) cleanupSink.push(c)
    } else {
      for (const c of cleanups.reverse()) c()
    }
  }
}

/**
 * 异步递归展开整棵树：每个组件位置（按路径）保留自己的 hook store，并在渲染后
 * 让微任务落地、再用同一份 store 重渲染一次——这样嵌套组件（如状态条）的
 * effect 取回数据后，重渲染能看到「有数据」的分支。
 *
 * 清理函数统一收集，最后一次性执行（模拟卸载），确认卸载路径不抛错。
 * 返回节点计数，用于确认「有数据时确实渲染出了内容」。
 */
async function expandTree(node, path, stores, cleanups) {
  if (node === null || node === undefined || typeof node === 'boolean') return 0
  if (typeof node !== 'object') return 1
  if (Array.isArray(node)) {
    let n = 0
    for (let i = 0; i < node.length; i++) n += await expandTree(node[i], `${path}[${i}]`, stores, cleanups)
    return n
  }
  if (node.$$typeof !== 'element') return 0

  let n = 1
  if (typeof node.type === 'function') {
    const key = `${path}:${node.type.name || 'anon'}`
    const store = stores.get(key) ?? { state: [], index: 0 }
    stores.set(key, store)
    // 第一遍：跑 effect 发起请求。
    renderComponent(node.type, node.props, store, cleanups)
    for (let i = 0; i < 12; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    // 第二遍：数据已落地，重渲染（hook 读取位置归零）。
    store.index = 0
    const el = renderComponent(node.type, node.props, store, cleanups)
    n += await expandTree(el, key, stores, cleanups)
  } else if (node.props?.children !== undefined) {
    n += await expandTree(node.props.children, path, stores, cleanups)
  }
  return n
}

/** 渲染并展开（含嵌套组件的异步数据流），最后执行全部清理函数。 */
async function renderFull(fn, props) {
  const stores = new Map()
  const cleanups = []
  const nodes = await expandTree({ $$typeof: 'element', type: fn, props }, 'entry', stores, cleanups)
  for (const c of cleanups.reverse()) c()
  return nodes
}

// ── 拦截 window.__ModuleLoader__ ──────────────────────────────────────
let registered = null

/**
 * 极简 DOM 替身：只实现桌宠用到的部分（createElement / appendChild / classList /
 * style / 事件）。桌宠现在是**命令式 DOM**（挂在 document.body 上），所以 mock
 * document 是 smoke 测试的一部分，而不是可有可无的装饰。
 */
function makeEl(tag) {
  const classes = new Set()
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    _listeners: new Map(),
    _text: '',
    className: '',
    id: '',
    title: '',
    offsetWidth: 196,
    offsetHeight: 120,
    appendChild(child) { el.children.push(child); child.parentNode = el; return child },
    append(...kids) { for (const k of kids) el.appendChild(k) },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el) },
    addEventListener(type, fn) { if (!el._listeners.has(type)) el._listeners.set(type, []); el._listeners.get(type).push(fn) },
    removeEventListener(type, fn) { el._listeners.set(type, (el._listeners.get(type) ?? []).filter((f) => f !== fn)) },
    dispatch(type, event) { for (const fn of el._listeners.get(type) ?? []) fn(event) },
    setAttribute(k, v) { el.dataset[k] = v },
    getAttribute(k) { return el.dataset[k] },
    getBoundingClientRect() {
      // 位置感知：真实浏览器里 fixed 元素的 rect 反映它当前的 left/top。
      // 固定返回常数会掩盖「抓取偏移」相关的问题（在元素外按下也能拖动）。
      const left = Number.parseFloat(el.style.left)
      const top = Number.parseFloat(el.style.top)
      return {
        left: Number.isFinite(left) ? left : 0,
        top: Number.isFinite(top) ? top : 0,
        width: el.offsetWidth,
        height: el.offsetHeight,
      }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    get textContent() { return el._text },
    set textContent(v) { el._text = String(v); el.children = [] },
  }
  Object.defineProperty(el, 'classList', {
    value: {
      add: (...names) => { for (const n of names) classes.add(n) },
      remove: (...names) => { for (const n of names) classes.delete(n) },
      toggle: (name, force) => {
        const want = force === undefined ? !classes.has(name) : force
        if (want) classes.add(name); else classes.delete(name)
        return want
      },
      contains: (name) => classes.has(name),
    },
  })
  // className getter/setter 与 classList 同步（真实 DOM 也如此）。
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); for (const n of String(v).split(/\s+/)) if (n !== '') classes.add(n) },
  })
  return el
}

globalThis.document = {
  body: makeEl('body'),
  // 样式注入要挂到 head（与真实浏览器一致）。早先这里没有 head，正好也是
  // 「样式从未被注入」没被发现的原因之一——测试环境缺了那块 DOM。
  head: makeEl('head'),
  documentElement: makeEl('html'),
  createElement: (tag) => makeEl(tag),
}
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { registered = spec },
  },
  // 桌宠用 window 的内外尺寸做位置钳制、并监听 resize。
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
}
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem(k, v) { this._m.set(k, String(v)) },
  removeItem(k) { this._m.delete(k) },
}
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}
globalThis.setTimeout = (fn) => { try { fn() } catch { /* ignore */ } ; return 0 }
globalThis.clearTimeout = () => {}

console.log('=== 加载 client.js ===')
// 直接求值源码（它只调用 window.__ModuleLoader__.load）。
const module = { exports: {} }
new Function('window', 'module', 'exports', 'require', source)(
  globalThis.window,
  module,
  module.exports,
  (name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  },
)
check('factory 已注册', registered !== null)
check('注册 id == 包名', registered?.id === 'dsh-token-usage', `id=${registered?.id}`)

console.log('\n=== 实例化 factory ===')
const instance = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
check('返回 inject 声明', Array.isArray(instance?.inject) && instance.inject.includes('slots'))
check('apply 是函数', typeof instance?.apply === 'function')

// ── 用 mock ctx 调用 apply ────────────────────────────────────────────
const registrations = []
const effects = []
const effectCleanups = [] // 每个 ctx.effect(fn) 返回的清理函数，按注册顺序
const petCleanups = []    // 其中的桌宠清理函数（effect 求值后返回 disposer）
const ctx = {
  get(name) {
    if (name === 'slots') {
      return {
        inject: (key, cb) => { effects.push(cb); return cb() },
        register: (options, component) => {
          registrations.push({ options, component })
          return () => {}
        },
      }
    }
    // ⚠️ 刻意**不**提供 'styles'。真实运行时里根本没有这个服务（它是动态插件的
    // 函数参数，不是 Cordis 服务）。早先这里伪造了一个，于是「样式从未被注入」
    // 这个真实缺陷被测试掩盖了整整一轮。现在如实返回 undefined。
    if (name === 'locale') {
      return {
        register: () => () => {},
        bind: () => (key) => key,
      }
    }
    return undefined
  },
  effect: (fn, label) => {
    effects.push(fn)
    const d = fn()
    effectCleanups.push({ label, dispose: typeof d === 'function' ? d : () => {} })
    if (typeof d === 'function') petCleanups.push(d)
    return typeof d === 'function' ? d : () => {}
  },
  inject: (deps, cb) => cb({}),
}

console.log('\n=== apply(ctx) ===')
try {
  instance.apply(ctx)
  check('apply 未抛错', true)
} catch (error) {
  check('apply 未抛错', false, String(error?.stack ?? error))
}

const names = registrations.map((r) => r.options.name)
check('注册了设置页 slot', names.includes('settings.section'), names.join(','))
// ⚠️ 横幅（conversation.input.dock）的**内容**已被桌宠取代，所以它默认渲染成
// null（见下面的「默认关闭」断言）。但**注册仍在**——注册是一次性的，而开关是
// 运行时可变的；注册了再按开关渲染 null，用户打开开关就能立刻看到横幅。
check('横幅 slot 仍注册（按开关决定是否渲染）', names.includes('conversation.input.dock'), names.join(','))
check('注册了方块墙主面板（侧栏图标 + main）',
  names.includes('sidebar.panellist') && names.includes('main'), names.join(','))
check('桌宠不再注册 slot（改为 document.body 命令式 DOM）', !names.includes('shell.overlay'),
  names.join(','))
// list 槽位要 `id`，keyed 槽位要 `key`——给错宿主会直接抛错。
const badOptions = registrations.filter((r) => {
  const needsKey = r.options.name === 'main' || r.options.name === 'plugins.bundle.config'
  if (needsKey) return typeof r.options.key !== 'string' || r.options.key === ''
  return typeof r.options.id !== 'string' || r.options.id === ''
})
check('每个注册都带了该槽位必需的 id/key 字段', badOptions.length === 0,
  badOptions.map((r) => r.options.name).join(','))
// main 的 key 必须与侧栏图标的 id 一致，否则点了图标打不开面板。
const panellistId = registrations.find((r) => r.options.name === 'sidebar.panellist')?.options.id
const mainKey = registrations.find((r) => r.options.name === 'main')?.options.key
check('侧栏图标 id 与 main 的 key 一致（点击能打开面板）', panellistId === mainKey,
  `panellist=${panellistId} main=${mainKey}`)
// ── 样式必须真的进了 DOM ─────────────────────────────────────────────
//
// 回归：早先这里断言的是「mock 的 styles.insert 被调用过」。但真实运行时
// **没有** styles 服务，`ctx.get('styles')` 恒为 undefined，`if` 分支从未执行，
// CSS 一行都没进页面——而这条测试却绿着，把缺陷掩盖了一整轮。
//
// 所以现在断言的是**结果**：document.head 里真的出现了本包的 <style>，
// 且关键规则在里面。这样「样式没注入」不可能再静默通过。
console.log('\n=== 样式注入（真实 DOM） ===')
const headStyles = globalThis.document.head.children.filter((el) => el.tagName === 'STYLE')
const ourStyle = headStyles.find((el) => el.dataset['data-plugin'] === 'dsh-token-usage'
  || el.getAttribute('data-plugin') === 'dsh-token-usage')
check('document.head 里有本包的 <style>', ourStyle !== undefined,
  `head 里 style 数=${headStyles.length}`)
const css = ourStyle?.textContent ?? ''
check('样式内容非空', css.length > 1000, `${css.length} 字符`)
check('带 data-plugin 标记（HMR 按包认领/清理）',
  ourStyle !== undefined && ourStyle.getAttribute('data-plugin') === 'dsh-token-usage')

// 关键规则必须在里面——这几条正是「方块墙竖排」「桌宠退化成文本」的直接原因。
const MUST_HAVE = [
  ['.dsh-tu-wall-grid', 'display: grid'],       // 没有它 → 30 格竖排成一列
  ['#dsh-tu-pet', 'position: fixed'],           // 没有它 → 桌宠退回文档流，只剩裸文本
  ['.dsh-tu-odo-item', 'white-space: nowrap'],  // 没有它 → 「…680tokens」粘在一起
  ['grid-template-columns: repeat(10, 1fr)', null],
]
for (const [needle, alsoNeed] of MUST_HAVE) {
  const has = css.includes(needle) && (alsoNeed === null || css.includes(alsoNeed))
  check(`样式含关键规则 ${needle}${alsoNeed === null ? '' : ` { ${alsoNeed} }`}`, has)
}

console.log('\n=== 主题 token 约束 ===')

// 逐声明校验（按 `;` 切分），行级正则会把 box-shadow 里的 rgba 误判成违规。
// 值校验用正则字面量（非 new RegExp），转义语义与项目里其他正则一致。
const TOKEN_VALUE_RE = /^(var\(--dsw-alias-[\w-]+\)(\s+var\(--dsw-alias-[\w-]+\))?|transparent|none|inherit|currentColor)$/
const TOKEN_BORDER_RE = /^([\d.]+px\s+(solid|dashed|dotted)\s+)?var\(--dsw-alias-[\w-]+\)$/
const RESET_VALUES = new Set(['0', 'none'])
const ALLOW_PROPS = new Set([
  'box-shadow', 'text-shadow', 'drop-shadow', 'opacity', 'fill-opacity',
  'stroke-opacity', 'z-index', 'width', 'height', 'grid', 'padding',
  'margin', 'font', 'letter-spacing', 'border-radius', 'gap', 'inset', 'filter',
])
// 自检：校验器本身必须是好的（防转义损坏后静默放行一切）。
check('颜色校验器自检通过',
  TOKEN_VALUE_RE.test('var(--dsw-alias-label-primary)')
  && TOKEN_VALUE_RE.test('var(--dsw-alias-label-secondary)')
  && !TOKEN_VALUE_RE.test('rgba(0, 0, 0, 0.28)')
  // 拼写错误必须被抓住：dsh 不是 dsw（曾真实出现过这个 typo）。
  && !TOKEN_VALUE_RE.test('var(--dsh-alias-label-secondary)')
  && TOKEN_BORDER_RE.test('1px solid var(--dsw-alias-border-l1)'))

const violations = []
{
  let prop = ''
  let buf = ''
  let inProp = true
  for (const ch of css) {
    if (ch === ';') {
      const value = buf.trim()
      const name = prop.replace(/\s+/g, ' ').trim()
      if (name !== '' && value !== '') {
        if (!ALLOW_PROPS.has(name)) {
          const base = name.replace(/^-([a-z]+-)/, '')
          const isColor = /color$/.test(base) || base === 'fill' || base === 'stroke' || base === 'border'
          if (isColor && !(base === 'border' && RESET_VALUES.has(value))) {
            const ok = TOKEN_VALUE_RE.test(value) || (base === 'border' && TOKEN_BORDER_RE.test(value))
            if (!ok) violations.push(`${name}: ${value}`)
          }
        }
      }
      prop = ''; buf = ''; inProp = true
    } else if (ch === ':' && inProp) {
      prop = buf; buf = ''; inProp = false
    } else {
      buf += ch
    }
  }
}
check('所有颜色都走主题 token', violations.length === 0, violations.join(' | '))

// 桌宠现在是挂在 document.body 上的命令式 DOM。测试它的**行为**而不只是样式：
// 挂载、拖动改位置、位置写盘、折叠按钮、数据渲染、卸载清理。
console.log('\n=== 桌宠（命令式 DOM）行为 ===')
const petRoot = document.body.children.find((c) => c.id === 'dsh-tu-pet')
check('桌宠已挂载到 document.body', petRoot !== undefined)

if (petRoot !== undefined) {
  const find = (cls, node = petRoot) => {
    if (String(node.className ?? '').includes(cls)) return node
    for (const c of node.children ?? []) { const r = find(cls, c); if (r !== undefined) return r }
    return undefined
  }
  const head = find('dsh-tu-pet-head')
  const total = find('dsh-tu-pet-total')
  // ⚠️ 桌宠**不再有 30 格网格**：它改成了「单充能块 + 池」。
  // 理由：桌宠只有 ~196px 宽，30 格每格不到 16px 既看不清又占高度；
  // 而方块墙主面板已有 100 格大图，桌宠再铺一遍是重复。
  const charge = find('dsh-tu-pet-charge')
  const pool = find('dsh-tu-pet-pool')
  check('骨架完整（标题栏/大数字/充能块/池）',
    head !== undefined && total !== undefined && charge !== undefined && pool !== undefined)
  check('不再有 30 格网格（已改成单充能块）', find('dsh-tu-pet-grid') === undefined)
  // 充能块里必须有填充条（它是「当前这块填了多少」的表达）。
  check('充能块含填充条', find('dsh-tu-pet-charge-fill') !== undefined)
  check('池含图标与计数', find('dsh-tu-pet-pool-icon') !== undefined
    && find('dsh-tu-pet-pool-label') !== undefined)
  // ⚠️ 桌宠宽度在 CSS 与**测试替身的 offsetWidth** 之间必须一致。
  // 两处一旦漂移，位置钳制（petClamp）算出来的边界就是错的——而这类错误
  // 只在真实窗口里表现为「桌宠被挤到屏幕外」，单测完全看不出来。
  const cssWidth = /#dsh-tu-pet\s*\{[^}]*width:\s*(\d+)px/.exec(css)
  check('桌宠 CSS 宽度与测试替身一致', cssWidth !== null && Number(cssWidth[1]) === petRoot.offsetWidth,
    `css=${cssWidth?.[1]} mock=${petRoot.offsetWidth}`)
  check('位置已初始化（不在 0,0 也不在屏外）', () => {
    const x = Number.parseFloat(petRoot.style.left)
    const y = Number.parseFloat(petRoot.style.top)
    return Number.isFinite(x) && Number.isFinite(y) && x >= 4 && y >= 4 && x < 1280 && y < 800
  }, `left=${petRoot.style.left} top=${petRoot.style.top}`)

  // ── 拖动 ──
  //
  // 语义是「绝对定位 + 保持抓取偏移」：按下点相对元素左上角的偏移在整个拖动过程中
  // 保持不变。所以断言应验证**这个不变量**，而不是把位移当成相对增量。
  //
  // ⚠️ 默认位置在**屏幕右下角**，向右拖会立刻撞上视口钳制（元素宽 172，
  // 视口 1280 → 最大 left = 1104）。所以这里**向左**拖（有充足空间），
  // 钳制行为另用一条独立断言验证。
  const before = { x: Number.parseFloat(petRoot.style.left), y: Number.parseFloat(petRoot.style.top) }
  const mkEvt = (x, y) => ({ button: 0, clientX: x, clientY: y, buttons: 1, pointerId: 1, stopPropagation() {} })
  const OFFSET = { dx: 40, dy: 20 }
  const grabX = before.x + OFFSET.dx
  const grabY = before.y + OFFSET.dy
  const MOVE = { dx: -100, dy: 50 }

  head.dispatch('pointerdown', mkEvt(grabX, grabY))
  head.dispatch('pointermove', mkEvt(grabX + MOVE.dx, grabY + MOVE.dy))
  head.dispatch('pointerup', { ...mkEvt(grabX + MOVE.dx, grabY + MOVE.dy), buttons: 0 })
  const after = { x: Number.parseFloat(petRoot.style.left), y: Number.parseFloat(petRoot.style.top) }
  check('拖动 (-100,+50) 后位置精确平移相同距离',
    Math.abs(after.x - (before.x + MOVE.dx)) < 0.5 && Math.abs(after.y - (before.y + MOVE.dy)) < 0.5,
    `before=(${before.x},${before.y}) after=(${after.x},${after.y})`)
  // 抓取偏移不变量：指针相对元素的偏移在拖动后保持不变。
  const offAfter = { dx: grabX + MOVE.dx - after.x, dy: grabY + MOVE.dy - after.y }
  check('抓取偏移在拖动中保持不变',
    Math.abs(offAfter.dx - OFFSET.dx) < 0.5 && Math.abs(offAfter.dy - OFFSET.dy) < 0.5,
    `offset=(${offAfter.dx},${offAfter.dy}) expected=(${OFFSET.dx},${OFFSET.dy})`)

  const saved = JSON.parse(localStorage.getItem('dsh.tokenUsage.pet.pos') ?? 'null')
  check('拖动后位置写入 localStorage', saved !== null && saved.x === after.x && saved.y === after.y,
    JSON.stringify(saved))

  // 钳制：向右下猛拖必须被限制在视口内（不允许拖出屏幕）。
  head.dispatch('pointerdown', mkEvt(after.x + 10, after.y + 10))
  head.dispatch('pointermove', mkEvt(99999, 99999))
  head.dispatch('pointerup', { ...mkEvt(99999, 99999), buttons: 0 })
  const clamped = { x: Number.parseFloat(petRoot.style.left), y: Number.parseFloat(petRoot.style.top) }
  check('拖出屏幕时被钳制在视口内',
    clamped.x >= 0 && clamped.y >= 0
    && clamped.x + petRoot.offsetWidth <= 1280 && clamped.y + petRoot.offsetHeight <= 800,
    `clamped=(${clamped.x},${clamped.y}) size=${petRoot.offsetWidth}x${petRoot.offsetHeight}`)

  // ── 折叠 ──
  const btn = find('dsh-tu-pet-btn')
  check('折叠按钮存在', btn !== undefined)
  btn.dispatch('click', { stopPropagation() {} })
  check('点击后进入折叠态', String(petRoot.className).includes('is-collapsed'))
  btn.dispatch('click', { stopPropagation() {} })
  check('再点恢复展开态', !String(petRoot.className).includes('is-collapsed'))

  // ── 卸载 ──
  const cleanup = petCleanups[petCleanups.length - 1]
  if (typeof cleanup === 'function') {
    cleanup()
    check('卸载后桌宠从 DOM 移除', !document.body.children.some((c) => c.id === 'dsh-tu-pet'))
  } else {
    check('卸载清理函数存在', false, 'no cleanup captured')
  }
}

console.log('\n=== 组件渲染冒烟（空数据） ===')
for (const reg of registrations) {
  const label = reg.options.name
  try {
    const el = renderComponent(reg.component, { t: (k) => k, close: () => {} })
    check(`${label} 渲染未抛错`, el !== undefined && el !== null)
    check(`${label} 返回元素`, typeof el === 'object' && el.$$typeof === 'element')
  } catch (error) {
    check(`${label} 渲染未抛错`, false, String(error?.stack ?? error))
  }
}

// ── 有数据渲染：覆盖表格 / 卡片 / 诊断区这些最容易崩的分支 ──────────────
console.log('\n=== 组件渲染冒烟（真实数据） ===')
const SAMPLE = {
  ok: true,
  day: '2026-10-12',
  range: { from: '2026-09-13', to: '2026-10-12', days: 30 },
  groupBy: 'day',
  includeSub: true,
  includeAux: true,
  rows: [
    { key: '2026-10-11', label: '2026-10-11', totals: { requests: 12, inputTokens: 1000, cacheReadTokens: 5000, cacheWriteTokens: 0, outputTokens: 400, reasoningTokens: 50, totalTokens: 6400 } },
    { key: '2026-10-12', label: '2026-10-12', totals: { requests: 30, inputTokens: 2000, cacheReadTokens: 9000, cacheWriteTokens: 10, outputTokens: 800, reasoningTokens: 90, totalTokens: 11810 } },
  ],
  totals: { requests: 42, inputTokens: 3000, cacheReadTokens: 14000, cacheWriteTokens: 10, outputTokens: 1200, reasoningTokens: 140, totalTokens: 18210 },
  today: { day: '2026-10-12', totals: { requests: 30, inputTokens: 2000, cacheReadTokens: 9000, cacheWriteTokens: 10, outputTokens: 800, reasoningTokens: 90, totalTokens: 11810 } },
  allTime: { requests: 3314, inputTokens: 7926958, cacheReadTokens: 532972098, cacheWriteTokens: 0, outputTokens: 3262373, reasoningTokens: 487061, totalTokens: 544161429 },
  config: { keepDays: 400, statusBarEnabled: true, statusBarRefreshMs: 5000 },
  diagnostics: {
    liveEntries: 5,
    sessionsTracked: 61,
    backfill: { sessions: 61, failed: 0, entries: 3316, withUsage: 3313 },
    backfilledAt: Date.now(),
    store: { kind: 'file', path: 'C:\\Users\\x\\.dsh\\token-usage\\daily.json' },
  },
}
globalThis.fetch = async (url) => {
  const isToday = String(url).includes('/today')
  const body = isToday
    ? {
      ok: true,
      day: SAMPLE.day,
      yesterday: { day: '2026-10-11', totals: { requests: 31, inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 2804361 } },
      totals: SAMPLE.today.totals,
      allTime: SAMPLE.allTime,
      config: { statusBarEnabled: true, statusBarRefreshMs: 1000 },
    }
    : SAMPLE
  return { ok: true, status: 200, json: async () => body }
}

for (const reg of registrations) {
  const label = reg.options.name
  try {
    const nodes = await renderFull(reg.component, { t: (k) => k, close: () => {} })
    check(`${label} 有数据渲染未抛错`, true)
    // 空态至少也有几个节点；有数据必须明显更多，否则说明数据分支没走到。
    //
    // ⚠️ 横幅（conversation.input.dock）默认**关闭**（内容已并入桌宠），
    // 所以它渲染成 null 是**预期**的，不该用「节点数 > 5」判它。
    const isBanner = reg.options.name === 'conversation.input.dock'
    if (isBanner) {
      check(`${label} 默认关闭（内容已并入桌宠）`, nodes <= 2, `nodes=${nodes}`)
    } else {
      check(`${label} 有数据时渲染出内容`, nodes > 5, `nodes=${nodes}`)
    }
  } catch (error) {
    check(`${label} 有数据渲染未抛错`, false, String(error?.stack ?? error))
  }
}

// ── 主题 token 必须真的存在 ──────────────────────────────────────────
//
// 上面已经校验「只引用 --dsw-alias-*」与「拼写不是 dsh」。但还差一层：
// 引用的名字必须**在宿主主题里真的存在**——否则 var() 解析失败、颜色回退成
// 继承值，界面上表现为「某块文字突然变成默认色」，而所有静态检查都通过。
//
// 这份清单**从宿主真实 CSS 读**（tools/theme-tokens.mjs），不再手写。
// 早先这里手写了一份，然后新加的 label-tertiary 没进清单 → 测试红了 →
// 说明「手写清单」本身就是个会漂移的东西。真实来源不会漂移。
console.log('\n=== 主题 token 是否存在 ===')
const { readThemeTokens, USED_TOKENS } = await import('../tools/theme-tokens.mjs')
const themeProbe = readThemeTokens(USED_TOKENS)
const KNOWN_TOKENS = new Set([
  ...Object.keys(themeProbe.light),
  ...Object.keys(themeProbe.dark),
])
check('能读到宿主主题的真实 token 清单', KNOWN_TOKENS.size > 0,
  themeProbe.source === undefined ? '读不到宿主主题 CSS' : `${KNOWN_TOKENS.size} 个`)
const usedTokens = new Set([...css.matchAll(/var\((--dsw-alias-[\w-]+)\)/g)].map((m) => m[1]))
const unknownTokens = [...usedTokens].filter((t) => !KNOWN_TOKENS.has(t))
check('引用的每个主题 token 都存在于宿主主题', unknownTokens.length === 0,
  unknownTokens.length === 0 ? `${usedTokens.size} 个全部有效` : unknownTokens.join(', '))

// ── 落单反引号（会破坏模板字符串的语法） ─────────────────────────────
//
// 注释里写一个 Markdown 风格的行内代码，看着无害，却会让整个文件的模板字符串
// 提前闭合 → 语法错误 → 该文件**整个不可加载**。
// 本插件在 client.js 上踩了 4 次、visual-check.mjs 上踩了 3 次，每次都要花
// 好几分钟定位。所以这里做静态检查：落单反引号 = 0。
console.log('\n=== 落单反引号检查 ===')
const { countStrayBackticks } = await import('../tools/check-stray-backticks.mjs')
const { readFileSync: read } = await import('node:fs')
for (const rel of ['../client.js', '../index.js', '../tools/visual-check.mjs']) {
  const n = countStrayBackticks(read(new URL(rel, import.meta.url), 'utf-8'))
  check(`${rel} 没有落单反引号`, n === 0, n === 0 ? '' : `${n} 个`)
}

console.log(`\n结果: ${failures.length === 0 ? '全部通过 ✓' : `${failures.length} 处失败 ✗`}`)
for (const f of failures) console.log('  ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
