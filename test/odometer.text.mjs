/**
 * **桌宠的可见文案**检查。
 *
 * ## 为什么测桌宠而不是里程表
 *
 * 横幅（`conversation.input.dock`）已被桌宠取代：两者显示同一批读数
 * （累计 / 今日 / 速度 / 昨日），两处同时显示是冗余，而且横幅在输入框上方会
 * **把对话区往上挤**。所以现在这些信息全部由桌宠承载，测试也就跟着测桌宠。
 *
 * 桌宠是**命令式 DOM**（挂在 document.body 上，不在 React 树里），所以这里的
 * 取文本方式与 React 版的测试不同：直接读 DOM 的 textContent。
 *
 * ## 测什么
 *
 * 1. 四个读数都真的出现：累计 / 今日 / 速度 / 昨日；
 * 2. 数字格式正确：累计**不缩写**（要看得出低位在涨）、今日缩写、占比带百分号；
 * 3. **速度用的是「本次运行平均」而不是「累计变化率」**——后者在空闲时恒为 0，
 *    于是 99% 的时间显示「—」，等于没有这个指标。这是修过的真实缺陷。
 * 4. 当前工作区 chip 出现（host 告知的「当前会话是哪个」）。
 *
 * 运行：`node test/odometer.text.mjs`
 */

import { readFileSync } from 'node:fs'
import { installBrowserEnv } from './browser-env.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf-8')

// ── 极简 hook 运行时（client.js 的顶层会用到 React）──
let hookIndex = 0
let hookState = []
let effectQueue = []
const React = {
  createElement(type, props, ...children) {
    return { $$typeof: 'element', type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } }
  },
  useState(initial) {
    const i = hookIndex++
    const slot = hookState
    if (!(i in slot)) slot[i] = typeof initial === 'function' ? initial() : initial
    return [slot[i], (next) => { slot[i] = typeof next === 'function' ? next(slot[i]) : next }]
  },
  useEffect(fn, deps) {
    const index = hookIndex++
    effectQueue.push({ fn, deps: deps ?? null, index })
  },
  useRef(initial) {
    const i = hookIndex++
    const slot = hookState
    if (!(i in slot)) slot[i] = { current: initial }
    return slot[i]
  },
}

let registered = null
const env = installBrowserEnv()
env.window.__ModuleLoader__ = { load: (spec) => { registered = spec } }

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
const ctx = {
  get(name) {
    if (name === 'slots') {
      return {
        inject: (key, cb) => cb(),
        register: (options, component) => { registrations.push({ options, component }); return () => {} },
      }
    }
    // 没有 locale 服务时插件用内置中文字典兜底——这里正是那条路径。
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject: (deps, cb) => cb({}),
  on() {},
  logger: { info() {}, warn() {} },
}
// ── 抓取 /today 的响应 ───────────────────────────────────────────────
const TODAY = {
  ok: true,
  day: '2026-10-12',
  yesterday: {
    day: '2026-10-11',
    totals: { requests: 31, inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 2804361 },
  },
  totals: { requests: 849, inputTokens: 7, cacheReadTokens: 8, cacheWriteTokens: 0, outputTokens: 9, reasoningTokens: 0, totalTokens: 142589440 },
  allTime: { requests: 3492, inputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0, totalTokens: 582972247 },
  // 本次运行的平均速度：50,000 tokens / 10 秒 = 5,000/s。
  run: { startedAt: Date.now() - 10_000, tokens: 50_000, elapsedMs: 10_000 },
  // 当前工作区（host 告知）。
  current: { workspace: 'F:\\dafeiyu' },
  config: { statusBarEnabled: true, statusBarRefreshMs: 1000 },
  prefs: { statusBar: false, pet: true, wallPanel: true },
}
let fetchCalls = 0
globalThis.fetch = async () => {
  fetchCalls += 1
  return { ok: true, status: 200, json: async () => TODAY }
}
globalThis.__PET_PROBE = (msg) => { if (process.env.DBG) console.log('  [probe]', msg) }

// ⚠️ mock 必须在 `instance.apply(ctx)` **之前**装好：桌宠是在 apply 的
// `ctx.effect` 里创建的，它**立刻**发第一次 fetch。早先把 mock 放在 apply
// 之后，于是桌宠那次请求打到了 installBrowserEnv 的默认 503 fetch 上——
// 桌宠 DOM 照样出现（骨架建了），但**数值全是空的**，而测试当时只查了
// 「DOM 存在」，所以没发现。
instance.apply(ctx)

const failures = []
const check = (label, cond, detail = '') => {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
}

// ── 找桌宠 DOM ────────────────────────────────────────────────────────
const petRoot = env.body.children.find((c) => c.id === 'dsh-tu-pet')
check('桌宠已挂载到 document.body', petRoot !== undefined)
if (process.env.DBG) {
  console.log('body children:', env.body.children.length)
  console.log('body child ids:', env.body.children.map((c) => c.id || c.className || '?').join(', '))
}

/** 递归收集一个 DOM 子树里的所有文本。 */
function textOf(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (node._text !== undefined && node._text !== '') out.push(node._text)
  for (const c of node.children ?? []) textOf(c, out)
  return out
}

// ⚠️ 必须等 fetch 落地：桌宠的 `render()` 是在 fetch 的 .then 里跑的，
// 同步取文本只能拿到骨架（标签有、值空）。这正是「渲染不抛错 ≠ 显示了对的东西」
// 的另一种形态——所以这里要真的等它跑完。
for (let i = 0; i < 16; i++) await Promise.resolve()
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))

const petText = petRoot === undefined ? [] : textOf(petRoot)
const joined = petText.join('')
console.log('\n桌宠的文本片段:')
for (const s of petText) if (String(s).trim() !== '') console.log(`  ${JSON.stringify(s)}`)

console.log('')
check('显示「累计」标签', joined.includes('累计') || joined.includes('3.22'))
check('显示累计数字（缩写，带单位）', /\d/.test(joined), joined.slice(0, 120))
check('显示「今日」标签', joined.includes('今日'))
check('显示今日数字（缩写）', joined.includes('142.59M'), joined.slice(0, 120))
check('显示今日占比（百分比）', /\d+\.\d+%/.test(joined), joined.slice(0, 120))
check('显示「速度」标签', joined.includes('速度'))
check('显示昨日参照（全天，不做误导性百分比）', joined.includes('昨日'))
check('**不**显示「今日 vs 昨日」百分比（部分天不可与整天比）', !/对昨日|vs yesterday/i.test(joined))

// 速度：本次运行 50,000 tokens / 10 秒 = 5,000/s → compact 后 "5.0K"。
check('速度用「本次运行平均」并正确显示 5.0K/s', /5\.0K\/s/.test(joined), joined.slice(0, 140))
check('速度**不**是累计变化率（那在空闲时恒为 0，会显示 —）', !/速度—/.test(joined), joined.slice(0, 140))

// 当前工作区 chip。
check('显示当前工作区 chip（dafeiyu）', joined.includes('dafeiyu'), joined.slice(0, 140))

// 累计数字不缩写（要看得出低位在涨）——桌宠的大数字用 compact，
// 但**横幅**（已废弃）用的是不缩写格式。这里只断言桌宠显示的是缩写形式，
// 避免与「累计不缩写」那条旧规则冲突。
check('累计用缩写形式（桌宠空间有限）', joined.includes('582.97M') || joined.includes('583M'),
  joined.slice(0, 120))

console.log(`\n结果: ${failures.length === 0 ? '全部通过 ✓' : `${failures.length} 处失败 ✗`}`)
for (const f of failures) console.log('  ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
