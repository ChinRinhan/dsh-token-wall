/**
 * 共享的浏览器环境替身（供所有 client 侧测试使用）。
 *
 * ## 为什么抽成模块
 *
 * `client.js` 现在既注册 slot（React 组件），又在 `document.body` 上挂命令式 DOM
 * （桌宠）。任何加载它的测试都必须先备好 `window` / `document` / `localStorage`
 * 等对象；之前每个测试各写一份，改一处要改三处，且容易漏（漏了就是
 * `document is not defined`）。这里集中一份。
 *
 * 只实现 client.js 真正用到的部分，保持最小：
 * createElement / appendChild / classList / style / 位置感知的 getBoundingClientRect /
 * 事件派发（同步）。
 */

/** 创建一个极简 DOM 元素。 */
export function makeEl(tag) {
  const classes = new Set()
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    _listeners: new Map(),
    _text: '',
    id: '',
    title: '',
    type: '',
    offsetWidth: 196,
    offsetHeight: 120,
    appendChild(child) { el.children.push(child); child.parentNode = el; return child },
    append(...kids) { for (const k of kids) el.appendChild(k) },
    remove() {
      if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((c) => c !== el)
    },
    addEventListener(type, fn) {
      if (!el._listeners.has(type)) el._listeners.set(type, [])
      el._listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      el._listeners.set(type, (el._listeners.get(type) ?? []).filter((f) => f !== fn))
    },
    /** 同步派发——测试里不需要真正的异步事件语义。 */
    dispatch(type, event) { for (const fn of el._listeners.get(type) ?? []) fn(event) },
    setAttribute(k, v) { el.dataset[k] = v },
    getAttribute(k) { return el.dataset[k] },
    /**
     * 位置感知：真实浏览器里 fixed 元素的 rect 反映它当前的 left/top。
     * 固定返回常数会掩盖「抓取偏移」相关的问题。
     */
    getBoundingClientRect() {
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
  // className 与 classList 同步（真实 DOM 也如此）。
  Object.defineProperty(el, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); for (const n of String(v).split(/\s+/)) if (n !== '') classes.add(n) },
  })
  return el
}

/**
 * 安装浏览器替身到 globalThis，返回可复用的句柄。
 *
 * @param options.viewport 视口尺寸，默认 1280×800（测试拖动钳制时有用）。
 * @param options.fetchImpl 自定义 fetch；默认返回 503（让组件停在加载态）。
 */
export function installBrowserEnv({ viewport = { width: 1280, height: 800 }, fetchImpl } = {}) {
  const body = makeEl('body')
  const document = {
    body,
    head: makeEl('head'),
    documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const storage = new Map()
  const win = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!win._listeners.has(type)) win._listeners.set(type, [])
      win._listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      win._listeners.set(type, (win._listeners.get(type) ?? []).filter((f) => f !== fn))
    },
    dispatch(type, event) { for (const fn of win._listeners.get(type) ?? []) fn(event) },
  }
  globalThis.document = document
  globalThis.window = win
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => { storage.set(k, String(v)) },
    removeItem: (k) => { storage.delete(k) },
  }
  globalThis.fetch = fetchImpl ?? (async () => ({ ok: false, status: 503, json: async () => ({}) }))
  // 定时器：setInterval 不自动跑（避免测试里轮询）；setTimeout 立即执行回调
  // ——测试用 `await new Promise(r => setTimeout(r, 0))` 等 promise 落地，吞掉回调会死锁。
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.setTimeout = (fn) => { if (typeof fn === 'function') fn(); return 0 }
  globalThis.clearTimeout = () => {}
  globalThis.requestAnimationFrame = (fn) => { fn(0); return 0 }
  globalThis.cancelAnimationFrame = () => {}
  return { body, document, window: win, storage }
}
