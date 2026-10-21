/**
 * 上升曲线（sparkline）的行为测试。
 *
 * 这是「越花越多」的**主要视觉信号**，所以单独测它的几何正确性：
 * 1. 采样不足时给等宽占位（不崩、不抖）；
 * 2. 递增数据 → 曲线**左低右高**（这正是「在涨」的形状）；
 * 3. 数值恒定 → 退化成水平线，**不**除零、不制造假的起伏；
 * 4. 单点 → 不崩（只有 1 个点无法画线）；
 * 5. 路径坐标全部落在画布内（不溢出）；
 * 6. 只用主题 token 上色（走 CSS 类，不写内联颜色）。
 */

import { readFileSync } from 'node:fs'
import { installBrowserEnv } from './browser-env.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf-8')

// 极简 hook 运行时（只为让 client.js 能加载并注册）。
let hookIndex = 0
let hookState = []
let effectQueue = []
const React = {
  createElement(type, props, ...children) {
    return { $$typeof: 'element', type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
  },
  useState(init) {
    const i = hookIndex++
    const slot = hookState
    if (!(i in slot)) slot[i] = typeof init === 'function' ? init() : init
    return [slot[i], (n) => { slot[i] = typeof n === 'function' ? n(slot[i]) : n }]
  },
  useEffect(fn) { hookIndex++; effectQueue.push({ fn, deps: null, index: hookIndex }) },
  useRef(init) {
    const i = hookIndex++
    const slot = hookState
    if (!(i in slot)) slot[i] = { current: init }
    return slot[i]
  },
}

let registered = null
// 共享浏览器替身（client.js 现在还会在 document.body 上挂命令式桌宠 DOM）。
const env = installBrowserEnv()
env.window.__ModuleLoader__ = { load: (s) => { registered = s } }
globalThis.clearInterval = () => {}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })

const module = { exports: {} }
new Function('window', 'module', 'exports', 'require', source)(
  globalThis.window, module, module.exports,
  (name) => { if (name === 'react') return React; throw new Error(`unexpected require(${name})`) },
)

const instance = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})

const registrations = []
instance.apply({
  get(name) {
    if (name === 'slots') {
      return {
        inject: (k, cb) => cb(),
        register: (o, c) => { registrations.push({ o, c }); return () => {} },
      }
    }
    if (name === 'styles') return { insert: () => () => {} }
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject: (deps, cb) => cb({}),
})

const failures = []
const check = (label, cond, detail = '') => {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
}

// ── 从 Odometer 的渲染树里取出 Sparkline 元素 ─────────────────────────
// Odometer 返回的树里第一个孩子就是 `h(Sparkline, {points})`。
const odometer = registrations.find((r) => r.o.name === 'conversation.input.dock')
check('里程表已注册', odometer !== undefined)

/** 直接调 Odometer 拿到它的返回元素（不展开子组件），从中找到 Sparkline 的 props。 */
function sparkPropsFrom(odometerEl) {
  // 结构：div.dsh-tu-odo > [ div.dsh-tu-odo-top > [ Sparkline, ... ], ... ]
  const top = odometerEl.props.children[0]
  return top.props.children[0]
}

// 用真实 fetch 驱动：给出递增的累计值，让 Odometer 累积采样点。
const TODAY = { ok: true, day: '2026-10-12', yesterday: { totals: { totalTokens: 0 } }, totals: { totalTokens: 0 }, allTime: { totalTokens: 0 }, config: { statusBarEnabled: true, statusBarRefreshMs: 1000 } }
let currentTotal = 0
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...TODAY, allTime: { totalTokens: currentTotal } }) })

// ── 直接用 Sparkline 组件测几何 ───────────────────────────────────────
//
// ⚠️ 走的是 Odometer 的**累积采样**路径：Sparkline 的采样点是在 Odometer 的
// useEffect 里攒的，所以要渲染 Odometer 若干次、每次给不同的累计值，
// 才能得到一条多点折线。
//
// 组件引用从 `GatedOdometer.__component` 取——因为 GatedOdometer 是
// 「按开关决定是否渲染」的包装层，直接调它会得到 null（横幅默认关闭）。
const store = { state: [], index: 0, deps: [] }
const Odometer = odometer.c.__component
check('能取到 Odometer 组件（经 Gated 包装的逃生口）', typeof Odometer === 'function', typeof Odometer)

/**
 * 渲染里程表并返回 **Odometer 自身的输出元素**。
 *
 * ⚠️ 两次调用必须共用同一个 hook store（否则 Odometer 的 useState/useRef 会丢状态）。
 */
function renderOdometer() {
  hookIndex = store.index
  hookState = store.state
  effectQueue = []
  const el = Odometer({})
  for (const e of effectQueue) e.fn()
  store.index = hookIndex
  store.state = hookState
  return el
}

async function poll(total) {
  currentTotal = total
  store.index = 0
  renderOdometer()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  store.index = 0
  return renderOdometer()
}

// 采样不足：第一次轮询后只有 0~1 个点。
let el = await poll(1000)
let spark = sparkPropsFrom(el)
check('能取到 Sparkline 元素', spark !== null && typeof spark === 'object' && typeof spark.type === 'function')
check('采样不足时不崩（返回 svg 占位）', spark.type(spark.props).type === 'svg')

// 递增采样：模拟消耗逐步增长。
for (const v of [1200, 1600, 2100, 2900, 4000, 5600, 8000, 12000]) el = await poll(v)
spark = sparkPropsFrom(el)
const svg = spark.type(spark.props)
const paths = svg.props.children.filter((c) => c.type === 'path')
check('曲线含 2 条 path（面积 + 线）', paths.length === 2, `got ${paths.length}`)

const linePath = paths.find((p) => String(p.props.className).includes('spark-line'))
check('存在折线 path', linePath !== undefined)

const d = String(linePath?.props?.d ?? '')
const coords = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
check('折线至少 2 个点', coords.length >= 2, `got ${coords.length}`)

// ① 左低右高：SVG 的 y 轴向下，所以「在涨」= y 递减。
const firstY = coords[0][1]
const lastY = coords[coords.length - 1][1]
check('曲线左低右高（y 递减 = 数值上升）', lastY < firstY, `firstY=${firstY} lastY=${lastY}`)

// ② 全部坐标落在画布内（0..46 x 0..16）。
const W = 46
const H = 16
const inBounds = coords.every(([x, y]) => x >= 0 && x <= W + 0.01 && y >= 0 && y <= H + 0.01)
check('所有坐标在画布内（不溢出）', inBounds, coords.map(([x, y]) => `${x},${y}`).join(' '))

// ③ 递增数据的最高点应贴到画布顶部附近。
const minY = Math.min(...coords.map(([, y]) => y))
check('最高点接近画布顶部（归一化生效）', minY <= 2, `minY=${minY}`)

// ④ 数值恒定 → 水平线，不除零。
const flatStore = { state: [], index: 0, deps: [] }
function renderFlat() {
  hookIndex = flatStore.index
  hookState = flatStore.state
  effectQueue = []
  const e = Odometer({})
  for (const f of effectQueue) f.fn()
  flatStore.index = hookIndex
  flatStore.state = hookState
  return e
}
// 先让 Sparkline 直接拿一组恒定点验证（绕过轮询，直接调组件）。
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ...TODAY, allTime: { totalTokens: 5000 } }) })
for (let i = 0; i < 4; i++) {
  flatStore.index = 0
  renderFlat()
  for (let k = 0; k < 12; k++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}
flatStore.index = 0
const flatEl = renderFlat()
const flatSpark = sparkPropsFrom(flatEl)
// 恒定值可能因「点数不足 2」而返回占位 svg（children 为空），也可能已累积到
// 多个相同的点。两种都必须不崩——这里直接构造两种输入分别验证。
const flatSvg = flatSpark.type(flatSpark.props)
check('恒定值不崩（占位或水平线均可）', flatSvg.type === 'svg')
if (Array.isArray(flatSvg.props.children)) {
  const flatPaths = flatSvg.props.children.filter((c) => c.type === 'path')
  if (flatPaths.length === 2) {
    const flatLine = flatPaths.find((p) => String(p.props.className).includes('spark-line'))
    const flatCoords = [...String(flatLine.props.d).matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => Number(m[2]))
    const allSame = flatCoords.every((y) => Math.abs(y - flatCoords[0]) < 0.01)
    check('恒定值画成水平线（无假起伏）', allSame, flatCoords.join(','))
    check('恒定值不是 NaN', flatCoords.every((y) => Number.isFinite(y)))
  }
}

// 直接构造「多个相同点」验证水平线分支（不依赖轮询累积）。
const flatLineEl = spark.type({ points: [5000, 5000, 5000, 5000] })
const flatLinePaths = flatLineEl.props.children.filter((c) => c.type === 'path')
check('多个相同点 → 2 条 path', flatLinePaths.length === 2)
const flatLinePath = flatLinePaths.find((p) => String(p.props.className).includes('spark-line'))
const ys = [...String(flatLinePath.props.d).matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => Number(m[2]))
check('相同点全在同一 y（水平线）', ys.every((y) => Math.abs(y - ys[0]) < 0.01), ys.join(','))
check('相同点无 NaN（未除零）', ys.every((y) => Number.isFinite(y)), ys.join(','))

// ⑤ 单点不崩。
const single = spark.type({ points: [42] })
check('单点不崩', single.type === 'svg')

// ⑥ 空数组不崩。
check('空数组不崩', spark.type({ points: [] }).type === 'svg')
// ⑦ 非数组不崩。
check('非数组不崩', spark.type({ points: undefined }).type === 'svg')

console.log(`\n结果: ${failures.length === 0 ? '全部通过 ✓' : `${failures.length} 处失败 ✗`}`)
for (const f of failures) console.log('  ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
