/**
 * 方块逻辑的**跨端一致性**校验。
 *
 * ## 为什么需要它
 *
 * `lib/blocks.js` 与 `client.js` 里各有一份等价的换算实现——客户端是手写
 * ModuleLoader bundle，**不能 import** 那个模块（它不是 ES 模块，跨端也拿不到
 * Node 解析）。两份实现一旦漂移，就会出现「主面板说 65 块、桌宠说 64 块」这种
 * 最难查的不一致。
 *
 * 本测试在**同一组输入**上分别跑两份实现，逐字段比对，用真实渲染结果反推
 * 客户端的换算，因此不是「看起来一样」而是「算出来必须一样」。
 */

import { readFileSync } from 'node:fs'
import { blockWall as libBlockWall, DEFAULT_UNIT, DEFAULT_PAGE_SIZE } from '../lib/blocks.js'
import { installBrowserEnv } from './browser-env.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf-8')

// ── 极简 hook 运行时 ──────────────────────────────────────────────────
let hookIndex = 0
let hookState = []
let effectQueue = []
const React = {
  createElement: (type, props, ...children) => ({ $$typeof: 'element', type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }),
  useState(init) {
    const i = hookIndex++
    const slot = hookState
    if (!(i in slot)) slot[i] = typeof init === 'function' ? init() : init
    return [slot[i], (n) => { slot[i] = typeof n === 'function' ? n(slot[i]) : n }]
  },
  useEffect(fn) { const i = hookIndex++; effectQueue.push({ fn, deps: null, index: i }) },
  useRef(init) {
    const i = hookIndex++
    const slot = hookState
    if (!(i in slot)) slot[i] = { current: init }
    return slot[i]
  },
}

let registered = null
// 共享的浏览器替身（含 document/window/localStorage/定时器）。
const env = installBrowserEnv()
env.window.__ModuleLoader__ = { load: (s) => { registered = s } }

const module = { exports: {} }
new Function('window', 'module', 'exports', 'require', source)(
  globalThis.window, module, module.exports,
  (name) => { if (name === 'react') return React; throw new Error(`unexpected require(${name})`) },
)

const failures = []
const check = (label, cond, detail = '') => {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
}

const instance = registered.factory((n) => {
  if (n === 'react') return React
  throw new Error(`unexpected require(${n})`)
})

const registrations = []
/** 每次 apply 收集到的 effect 清理函数（含桌宠的卸载函数）。 */
const effectCleanups = []
function makeCtx() {
  return {
    get(name) {
      if (name === 'slots') return { inject: (k, cb) => cb(), register: (o, c) => { registrations.push({ o, c }); return () => {} } }
      if (name === 'styles') return { insert: () => () => {} }
      if (name === 'locale') return { register: () => () => {}, bind: () => (k) => k }
      return undefined
    },
    effect: (fn) => {
      const d = fn()
      const dispose = typeof d === 'function' ? d : () => {}
      effectCleanups.push(dispose)
      return dispose
    },
    inject: (d, cb) => cb({}),
  }
}
instance.apply(makeCtx())

/** 让 /today 返回指定总量（scope=all 时用 allTime）。 */
function mockFetch(total) {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      ok: true, day: '2026-10-12',
      yesterday: { day: '2026-10-11', totals: { totalTokens: 0 } },
      totals: { totalTokens: 0 },
      allTime: { totalTokens: total },
      config: { statusBarEnabled: true, statusBarRefreshMs: 1000 },
    }),
  })
}

/**
 * 用指定总量渲染一次桌宠，**返回它本次创建的 DOM 元素**。
 *
 * 桌宠是命令式 DOM：apply() 时立刻发一次请求并渲染，而 mock 下轮询不会跑。
 * 因此每次以新数据重新 apply（会追加一个新的 #dsh-tu-pet）。
 *
 * ⚠️ 必须**返回本次新建的元素**，而不是事后按 id 去 body 里找：apply 是同步
 * 追加的，而 fetch 落地在其后；若调用方在 await 之前解析元素，拿到的可能是
 * 上一次迭代留下的旧元素（表现为「差一轮」的断言失败）。
 *
 * 不做清理：避免「清理后 fetch 才落地」的竞态；旧元素留在 body 上不影响断言。
 */
async function petRender(total) {
  mockFetch(total)
  const before = new Set(env.body.children)
  instance.apply(makeCtx())
  const created = env.body.children.find((c) => !before.has(c))
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  return created
}

const odometer = registrations.find((r) => r.o.name === 'conversation.input.dock')
const panel = registrations.find((r) => r.o.name === 'main')

/**
 * 渲染一个包装组件并展开到方块网格，取回它实际用的 cells。
 *
 * ⚠️ 必须**异步两遍**：面板与桌宠都通过 `useEffect` + `fetch` 取数，第一遍渲染
 * 只有「加载中」占位。要等 promise 落地后用**同一个 hook store** 重渲染，才能
 * 拿到真正画出来的网格。
 */
async function renderAndExtractCells(entry, total) {
  mockFetch(total)
  const store = { state: [], index: 0, deps: [] }

  /** 一遍渲染：给定 store 渲染包装组件并展开出元素树。 */
  function pass() {
    const saved = { hookIndex, hookState, effectQueue }
    hookIndex = store.index
    hookState = store.state
    effectQueue = []
    // ⚠️ 用 `__component` 拿**内部**组件，而不是注册的外层包装。
    //
    // 注册的是 `(ownerProps) => h(GatedBlockPanel, ownerProps)`，展开一层得到的是
    // `h(GatedBlockPanel, props)`——再展开 GatedBlockPanel 会**新渲染**一次
    // BlockPanel，而那次渲染的 fetch 还没落地，于是永远只有「加载中」占位。
    // 直接拿 BlockPanel，数据在同一个 store 里，才是对的。
    const target = entry.c.__component ?? entry.c
    const wrapper = target({})
    const el = typeof wrapper.type === 'function' ? wrapper.type(wrapper.props) : wrapper
    for (const e of effectQueue) e.fn()
    store.index = hookIndex
    store.state = hookState
    hookIndex = saved.hookIndex
    hookState = saved.hookState
    effectQueue = saved.effectQueue
    return el
  }

  // 第一遍：触发 fetch。
  store.index = 0
  let el = pass()
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  // 第二遍：数据已落地，重渲染（hook 读取位置归零）。
  store.index = 0
  el = pass()

  let cells
  ;(function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const c of node) walk(c); return }
    if (node.$$typeof !== 'element') return
    if (typeof node.type === 'function') {
      // 嵌套组件（BlockGrid / BlockPanel 等）用独立 store 展开一次即可。
      const nested = { state: [], index: 0 }
      const saved = { hookIndex, hookState }
      hookIndex = 0
      hookState = []
      const inner = node.type(node.props)
      hookIndex = saved.hookIndex
      hookState = saved.hookState
      walk(inner)
      return
    }
    const cls = String(node.props?.className ?? '')
    if (cls.includes('dsh-tu-wall-grid') || cls.includes('dsh-tu-pet-grid')) {
      // ⚠️ 网格的 children 现在是**两个数组**：[方块数组, 里程碑标签数组]。
      // 早先只有一个数组，所以直接取 children 就行；现在必须展平。
      //
      // 然后只取**方块**：里程碑标签（dsh-tu-milestone-label）也是网格的孩子，
      // 但不是方块，不过滤会让三态序列整体错位。
      const raw = Array.isArray(node.props.children) ? node.props.children : [node.props.children]
      const flat = raw.flatMap((k) => (Array.isArray(k) ? k : [k])).filter(Boolean)
      cells = flat
        .filter((k) => String(k.props?.className ?? '').includes('dsh-tu-block'))
        .map((k) => String(k.props?.className ?? ''))
      return
    }
    walk(node.props?.children)
  })(el)

  return cells
}

/** 从客户端渲染出的 class 列表反推 { state } 序列。 */
function statesFromClasses(classes) {
  return classes.map((c) => {
    if (c.includes('is-filled')) return 'filled'
    if (c.includes('is-partial')) return 'partial'
    return 'empty'
  })
}

console.log('=== 常量一致性 ===')
check('单位常量一致（10M）', source.includes('10 * 1e6') && DEFAULT_UNIT === 10_000_000, `lib=${DEFAULT_UNIT}`)
check('页大小常量一致（100）', source.includes('BLOCK_PAGE_SIZE = 100') && DEFAULT_PAGE_SIZE === 100, `lib=${DEFAULT_PAGE_SIZE}`)

console.log('\n=== 主面板 vs lib/blocks.js ===')
const CASES = [
  0,
  1,
  5_000_000,
  9_999_999,
  10_000_000,
  10_000_001,
  65 * 10_000_000 + 704_221,
  100 * 10_000_000,
  150 * 10_000_000,
  234 * 10_000_000,
  999_999_999,
]
for (const total of CASES) {
  const expected = libBlockWall(total)
  const classes = await renderAndExtractCells(panel, total)
  if (classes === undefined) { check(`total=${total} 取到网格`, false); continue }
  const states = statesFromClasses(classes)
  const expectedStates = expected.cells.map((c) => c.state)
  const ok = states.length === expectedStates.length && states.every((s, i) => s === expectedStates[i])
  check(`total=${total.toLocaleString()} 三态序列一致`, ok,
    ok ? `filled=${expected.filled} partial@${states.indexOf('partial')}` : `client=${states.slice(0, 12).join(',')} lib=${expectedStates.slice(0, 12).join(',')}`)
}

console.log('\n=== 桌宠「上下文条 + 池」vs lib/blocks.js ===')
//
// ⚠️ 桌宠的进度条**已经不再由 blockWall 驱动**：它现在是「上下文占用」
// （`projectedTokens / contextWindow`，快满会被压缩），而池仍然是
// 「全时累计块数」。所以跨端校验的对象只剩池：
//
// - 池里显示的块数  ==  blockWall().filled
//
// 这仍是**跨端校验**：`lib/blocks.js` 是 host 侧实现，桌宠是客户端的手写
// 命令式 DOM；两边对同一个 total 必须算出同样的块数。
//
// 进度条的新语义由本文件末尾的「上下文条」一组单独覆盖——它**不能**再和
// blockWall 比对，否则会把「上下文占用」悄悄退回成「10M 进度」。

/** 从桌宠 DOM 里取 { chargeWidth, chargePct, poolText }。 */
function petChargeAndPool(root) {
  const find = (cls, node = root) => {
    if (node === undefined) return undefined
    if (String(node.className ?? '').includes(cls)) return node
    for (const c of node.children ?? []) { const r = find(cls, c); if (r !== undefined) return r }
    return undefined
  }
  const fill = find('dsh-tu-pet-charge-fill')
  const pct = find('dsh-tu-pet-charge-pct')
  const label = find('dsh-tu-pet-pool-label')
  return {
    chargeWidth: fill?.style?.width ?? '',
    chargePct: pct?._text ?? '',
    poolText: label?._text ?? '',
  }
}

for (const total of [0, 5_000_000, 10_000_000, 65 * 10_000_000 + 704_221, 150 * 10_000_000]) {
  const w = libBlockWall(total)
  const petEl = await petRender(total)
  check(`pet total=${total.toLocaleString()} 已创建桌宠元素`, petEl !== undefined)
  const { chargeWidth, chargePct, poolText } = petChargeAndPool(petEl)
  // 池里显示的块数：client 写的是 `${filled} 块`。
  check(`pet total=${total.toLocaleString()} 池内块数一致`, poolText.startsWith(String(w.filled)),
    `dom=${JSON.stringify(poolText)} lib filled=${w.filled}`)
  // 没有会话数据（这个 mock 不带 session）时，上下文条必须显式「不可用」，
  // 而不是留一个看起来像 0% 的假进度。
  check(`pet total=${total.toLocaleString()} 无会话数据时上下文条显示 —`,
    chargeWidth === '0%' && chargePct === '—',
    `width=${chargeWidth} pct=${chargePct}`)
}

console.log('\n=== 桌宠「上下文条」由 contextPressure 驱动（不是 10M 进度）===')
//
// 这条断言存在的理由：进度条从「10M 充能」换成「上下文占用」后，最容易发生的
// 事故是**悄悄退回旧语义**——毕竟两条路径都写 `chargeFill.style.width`，
// 单看代码很难发现喂进去的是哪个数。所以这里直接喂一份带 `contextPressure`
// 的会话数据，断言宽度等于 `projectedTokens / contextWindow`。

/** 带会话数据的 /today mock。 */
function mockFetchWithSession({ total, sessionTokens, pressure }) {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      ok: true, day: '2026-10-12',
      yesterday: { day: '2026-10-11', totals: { totalTokens: 0 } },
      totals: { totalTokens: 0 },
      allTime: { totalTokens: total },
      config: { statusBarEnabled: true, statusBarRefreshMs: 1000 },
      session: {
        id: 'sess-test',
        live: { sessionTokens, turnTokens: 0, turn: 1, steps: 1 },
        projected: {
          tokenUsage: {
            uncachedInputTokens: sessionTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
          },
          contextPressure: pressure,
        },
      },
    }),
  })
}

async function petRenderWithSession(opts) {
  mockFetchWithSession(opts)
  const before = new Set(env.body.children)
  instance.apply(makeCtx())
  const created = env.body.children.find((c) => !before.has(c))
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  return created
}

for (const { used, window: win } of [
  { used: 32_000, window: 128_000 },   // 25%
  { used: 710_000, window: 1_000_000 }, // 71%
  { used: 0, window: 1_000_000 },       // 0%
]) {
  const el = await petRenderWithSession({
    total: 500_000_000,
    sessionTokens: 2_130_000,
    pressure: { contextWindow: win, pressureTokens: used, projectedTokens: used },
  })
  const { chargeWidth, chargePct } = petChargeAndPool(el)
  const expected = `${((used / win) * 100).toFixed(2)}%`
  check(`上下文 ${used}/${win} 宽度 == projectedTokens/contextWindow`, chargeWidth === expected,
    `dom=${chargeWidth} expected=${expected}`)
  check(`上下文 ${used}/${win} 百分比文字`, chargePct === `${Math.round((used / win) * 100)}%`,
    `dom=${chargePct}`)
}

// 没有 contextWindow 时不能瞎算——显示不可用。
{
  const el = await petRenderWithSession({
    total: 500_000_000,
    sessionTokens: 2_130_000,
    pressure: { pressureTokens: 5000 }, // 缺 contextWindow
  })
  const { chargeWidth, chargePct } = petChargeAndPool(el)
  check('缺 contextWindow 时不瞎算，显示 —', chargeWidth === '0%' && chargePct === '—',
    `width=${chargeWidth} pct=${chargePct}`)
}

console.log(`\n结果: ${failures.length === 0 ? '全部一致 ✓' : `${failures.length} 处不一致 ✗`}`)
for (const f of failures) console.log('  ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
