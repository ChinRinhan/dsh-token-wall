/**
 * 用**真实数据**渲染里程表并打印其结构与可见文本，作为交付前的最终目视确认
 * （在无浏览器环境下，这是最接近「看一眼」的检查）。
 *
 * 用法: node tools/preview.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

// ── 直接从插件自己的聚合层取真实数字（与 /today 同源）────────────────
const { openStore } = await import('../lib/store.js')
const { aggregateRange, grandTotals, localDayKey, shiftDayKey } = await import('../lib/fold.js')

const store = openStore({ home, keepDays: 400 })
const day = localDayKey(Date.now())
const today = aggregateRange(store.days, { from: day, to: day, groupBy: 'day' }).totals
const yKey = shiftDayKey(day, -1)
const yesterday = aggregateRange(store.days, { from: yKey, to: yKey, groupBy: 'day' }).totals
const allTime = grandTotals(store.days)

const grouped = (n) => String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const compact = (n) => {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return String(Math.trunc(v))
}

// ── 极简 hook 运行时，加载真实 client.js ──────────────────────────────
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

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf-8')
let registered = null
globalThis.window = { __ModuleLoader__: { load: (s) => { registered = s } } }
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

// 模拟 host 端点返回真实数据。
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({
    ok: true,
    day,
    yesterday: { day: yKey, totals: yesterday },
    totals: today,
    allTime,
    config: { statusBarEnabled: true, statusBarRefreshMs: 1000 },
  }),
})

const module = { exports: {} }
new Function('window', 'module', 'exports', 'require', source)(
  globalThis.window, module, module.exports,
  (name) => { if (name === 'react') return React; throw new Error(`unexpected require(${name})`) },
)

const instance = registered.factory((n) => {
  if (n === 'react') return React
  throw new Error(`unexpected require(${n})`)
})

const regs = []
instance.apply({
  get(name) {
    if (name === 'slots') return { inject: (k, cb) => cb(), register: (o, c) => { regs.push({ o, c }); return () => {} } }
    if (name === 'styles') return { insert: (css) => { globalThis.__CSS = css; return () => {} } }
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject: (d, cb) => cb({}),
})

const odo = regs.find((r) => r.o.name === 'conversation.input.dock')
const store2 = { state: [], index: 0, deps: [] }

/** 渲染一次（复用 store 以便累积采样点）。 */
function render() {
  hookIndex = store2.index
  hookState = store2.state
  effectQueue = []
  const wrapper = odo.c({})
  const el = wrapper.type(wrapper.props)
  for (const e of effectQueue) e.fn()
  store2.index = hookIndex
  store2.state = hookState
  return el
}

// 模拟若干次轮询：累计值逐步增长，让曲线有走势。
let total = allTime.totalTokens - 400_000
for (let i = 0; i < 12; i++) {
  total += [0, 0, 60_000, 0, 120_000, 0, 0, 90_000, 0, 150_000, 0, 80_000][i]
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({
      ok: true, day,
      yesterday: { day: yKey, totals: yesterday },
      totals: { ...today, totalTokens: today.totalTokens },
      allTime: { ...allTime, totalTokens: total },
      config: { statusBarEnabled: true, statusBarRefreshMs: 1000 },
    }),
  })
  store2.index = 0
  render()
  await new Promise((r) => setTimeout(r, 3))
}
store2.index = 0
const el = render()

// ── 打印结构 ──────────────────────────────────────────────────────────
function describe(node, indent = '') {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { console.log(`${indent}「${node}」`); return }
  if (Array.isArray(node)) { for (const c of node) describe(c, indent); return }
  if (node.$$typeof !== 'element') return
  const cls = node.props?.className
  const tag = typeof node.type === 'function' ? `⟨${node.type.name || 'Component'}⟩` : node.type
  const extra = node.props?.d !== undefined ? ` d="${String(node.props.d).slice(0, 46)}${String(node.props.d).length > 46 ? '…' : ''}"` : ''
  const style = node.props?.style?.width !== undefined ? ` style="width:${node.props.style.width}"` : ''
  console.log(`${indent}${tag}${cls ? ` .${cls}` : ''}${extra}${style}`)
  const kids = node.props?.children
  if (kids !== undefined) describe(kids, indent + '  ')
}

console.log('=== 真实数据 ===')
console.log(`  今日 ${grouped(today.totalTokens)} | 昨日 ${grouped(yesterday.totalTokens)} | 累计 ${grouped(total)}`)
console.log('')
console.log('=== 渲染结构（含上升曲线路径）===')
describe(el)

console.log('')
console.log('=== 可见文本 ===')
const texts = []
;(function walk(n) {
  if (n === null || n === undefined || typeof n === 'boolean') return
  if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return }
  if (Array.isArray(n)) { for (const c of n) walk(c); return }
  if (n.$$typeof === 'element') walk(n.props?.children)
})(el)
console.log('  ' + texts.join(' '))

console.log('')
console.log('=== 曲线路径 ===')
// 需要展开函数组件（Sparkline）才能拿到它产出的 svg——只走 children 会漏掉。
;(function findPath(n) {
  if (n === null || n === undefined || typeof n !== 'object') return
  if (Array.isArray(n)) { for (const c of n) findPath(c); return }
  if (n.$$typeof !== 'element') return
  if (typeof n.type === 'function') {
    findPath(n.type(n.props))
    return
  }
  if (String(n.props?.className ?? '').includes('spark-line')) {
    const d = String(n.props.d)
    const pts = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
    console.log(`  点数: ${pts.length}`)
    console.log(`  路径: ${d.slice(0, 140)}${d.length > 140 ? '…' : ''}`)
    const first = pts[0]?.[1]
    const last = pts[pts.length - 1]?.[1]
    console.log(`  首点 y=${first}  末点 y=${last}  → ${last < first ? '左低右高 ✓（在涨）' : '非上升 ✗'}`)
    // 简单的文本折线预览，直观看出走势。
    const H = 8
    const min = Math.min(...pts.map((p) => p[1]))
    const max = Math.max(...pts.map((p) => p[1]))
    const span = max - min || 1
    const rows = []
    for (let r = 0; r < H; r++) {
      let line = ''
      for (const [, y] of pts) {
        const norm = (y - min) / span
        const target = Math.round(norm * (H - 1))
        line += target === r ? '●' : ' '
      }
      rows.push('    ' + line)
    }
    console.log('  走势（上=多，下=少）:')
    for (const row of rows) console.log(row)
    return
  }
  findPath(n.props?.children)
})(el)
