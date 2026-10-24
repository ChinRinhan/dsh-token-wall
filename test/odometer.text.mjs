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
  // 当前工作区（host 告知）。用中性示例名，不要写本机真实项目名。
  current: { workspace: 'D:\\projects\\beta' },
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
// ⚠️ 大数字的标签现在是**本会话**，不再是「累计」。
//
// 全时累计没有消失——它改由「池」（N 块）承担，那是同一件事的另一个尺度。
// 主读数换成会话，是因为用户真正想问的是「这次对话花了多少」。
check('显示「本会话」标签', joined.includes('本会话'), joined.slice(0, 140))

// ⚠️ 速度 / 昨日 已**从桌宠移除**；但「今日」作为**附加读数**回来了。
//
// 演变过程值得记一笔，因为它说明「移除」不等于「永不再加」：
// - PR1 把 今日/速度/昨日 一起移除（它们都回答「过去怎么样」，而桌宠该回答
//   「现在有没有事」）；
// - 之后用户反馈「过于单调」，于是 今日 以**补充读数**的身份回来——它现在住在
//   最下面那行（`缓存 x% · 今日 y`），字号更小、颜色更弱，不再当主读数。
//
// 所以断言要跟着**位置与权重**走，而不是简单地「有/没有」：今日 必须在，但
// 速度/昨日 仍然不在。
check('「今日」作为附加读数回来了', joined.includes('今日'), joined.slice(0, 160))
check('今日数字 142.59M 显示在附加读数行', joined.includes('142.59M'), joined.slice(0, 160))
check('不再显示「速度」标签', !joined.includes('速度'), joined.slice(0, 140))
check('不再显示速度读数 5.0K/s', !/5\.0K\/s/.test(joined), joined.slice(0, 140))
check('不再显示「昨日」参照', !joined.includes('昨日'), joined.slice(0, 140))
check('**不**显示「今日 vs 昨日」百分比（部分天不可与整天比）', !/对昨日|vs yesterday/i.test(joined))

// 当前工作区 chip。
check('显示当前工作区 chip（beta）', joined.includes('beta'), joined.slice(0, 140))

// ── 保留项：池（全时累计）──────────────────────────────────────────────
//
// 移除统计读数**不等于**把视觉主体也删了。池是这插件的身份读数
// （全时累计块数，只增不减），必须还在。
//
// TODAY 的 allTime = 582.97M → floor(582.97M / 10M) = 58 块。
check('保留池：显示全时累计块数（58 块）', joined.includes('58 块'), joined.slice(0, 140))

// ── 降级：没有会话数据时不许显示 0 ────────────────────────────────────
//
// 这份 TODAY mock **不带** `session` 字段（模拟「桥没挂载」：用户切到了方块墙
// 面板或设置页）。此时会话类读数必须显示 `—`，绝不能画成「0 tokens」——
// 「读不到」和「花了 0」是两件完全不同的事。
//
// ⚠️ 但**进度条与池不受影响**：它们来自本地日聚合，与会话无关。这是这次拆分
// 的关键收益——会话数据缺失时，桌宠仍有一半读数可用。
check('无会话数据时大数字显示 —', joined.includes('—'), joined.slice(0, 160))
check('无会话数据时上下文读数显示 —', /上下文\s*—/.test(joined), joined.slice(0, 200))
check('无会话数据时不显示 0 作为会话用量', !/本会话\s*0\b/.test(joined), joined.slice(0, 160))
check('无会话数据时进度条照常显示块进度', /\d+%/.test(joined), joined.slice(0, 160))

// 池与「本会话」必须是两个独立的数：池不跟随会话。
check('池与「本会话」并存（两个不同来源）',
  joined.includes('本会话') && joined.includes('58 块'), joined.slice(0, 160))

// ── 有会话数据时：本会话 + 本轮 + 上下文 ──────────────────────────────
//
// 上面那份 mock 不带 session（模拟桥没挂载）。这里换成带 session 的响应，
// 断言三个新读数真的会显示——否则「降级路径正确」可能掩盖「正常路径也坏」。
const WITH_SESSION = {
  ...TODAY,
  session: {
    id: 'sess-demo',
    live: {
      sessionTokens: 2_130_000,
      turnTokens: 41_000,
      previousTurnTokens: 55_000,
      turn: 3,
      steps: 5,
    },
    projected: {
      tokenUsage: {
        uncachedInputTokens: 2_130_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
      contextPressure: { contextWindow: 1_000_000, pressureTokens: 710_000, projectedTokens: 710_000 },
    },
  },
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => WITH_SESSION })
const before2 = new Set(env.body.children)
instance.apply(ctx)
const pet2 = env.body.children.find((c) => !before2.has(c))
for (let i = 0; i < 16; i += 1) await Promise.resolve()
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))

const text2 = []
;(function collect(n) {
  if (n._text !== undefined && n._text !== '') text2.push(String(n._text))
  for (const c of n.children ?? []) collect(c)
})(pet2)
const joined2 = text2.join('')
console.log('\n有会话数据时的文本:')
for (const s of text2) if (String(s).trim() !== '') console.log(`  ${JSON.stringify(s)}`)

check('有会话数据：本会话显示 2.13M', joined2.includes('2.13M'), joined2.slice(0, 160))
check('有会话数据：本轮显示 41.0K', joined2.includes('41.0K'), joined2.slice(0, 160))
check('有会话数据：上下文显示 71%', joined2.includes('71%'), joined2.slice(0, 160))
check('有会话数据：池仍显示全时 58 块（不跟随会话）',
  joined2.includes('58 块'), joined2.slice(0, 160))

// 缓存命中率：这份 mock 的 cacheRead=0 → 分母 = 2.13M，命中率 0.0%。
// 断言它**渲染了数字**（而不是 `—`），因为这是「输入侧」指标算得出来的情况。
check('有会话数据：缓存命中率渲染为百分比', /缓存\s*0\.0%/.test(joined2), joined2.slice(0, 200))
check('有会话数据：今日量渲染', /今日\s*142\.59M/.test(joined2), joined2.slice(0, 200))

// 「上一轮」只进 tooltip：它是「本轮这个数算大还是算小」的参照，属于按需信息。
// 这条断言存在的理由：`previousTurnTokens` 曾经被 host 算出来、却**从没被前端
// 渲染过**——一个字段在链路上走完了全程却没有人用，是最难靠读代码发现的那类缺口。
const turnNode = (function findTurn(n) {
  if (String(n.className ?? '').includes('dsh-tu-pet-stat-dim')) return n
  for (const c of n.children ?? []) { const r = findTurn(c); if (r !== undefined) return r }
  return undefined
})(pet2)
check('本轮节点存在', turnNode !== undefined)
check('本轮 tooltip 含上一轮', typeof turnNode?.title === 'string'
  && turnNode.title.includes('上一轮') && turnNode.title.includes('55.0K'),
  JSON.stringify(turnNode?.title))
check('本轮文字本身不常显上一轮（不挤占版面）',
  !String(turnNode?._text ?? '').includes('上一轮'), String(turnNode?._text))

// ── 零值语义：两个方向都要对 ──────────────────────────────────────────
//
// 「读不到」与「真的是 0」必须分开。这里各验一次，因为两种写法很容易互相写反：
//
// 1. **今日 = 0 是合法的**（今天还没花）：必须显示 `0`，不是 `—`。
//    早先写成 `> 0 ? compact : '—'`，把一个合法的 0 画成了「不可用」。
// 2. **只有 live 的 0 不算数**：`live` 是「插件启动以来」的累计，只要收到过一条
//    事件就存在（哪怕只有 `turn/start`，用量是 0）。若 `projected` 不可用，
//    直接画这个 0 会让人以为「这个会话没花钱」，而我们其实只是不知道历史总量。
console.log('\n=== 零值语义 ===')
const ZERO_TODAY = {
  ...TODAY,
  totals: { totalTokens: 0 }, // 今天确实还没花
  session: {
    id: 'sess-zero',
    live: { sessionTokens: 0, turnTokens: 0, turn: 1, steps: 0 }, // 有状态但还没用量
    projected: null, // 宿主投影不可用
    projectedUnavailable: 'no-session-query',
  },
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ZERO_TODAY })
const before3 = new Set(env.body.children)
instance.apply(ctx)
const pet3 = env.body.children.find((c) => !before3.has(c))
for (let i = 0; i < 16; i += 1) await Promise.resolve()
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))
const text3 = []
;(function collect(n) {
  if (n._text !== undefined && n._text !== '') text3.push(String(n._text))
  for (const c of n.children ?? []) collect(c)
})(pet3)
const joined3 = text3.join('')
console.log(`  文本: ${JSON.stringify(text3)}`)
check('今日真为 0 时显示 0（不是 —）', /今日\s*0\b/.test(joined3), joined3.slice(0, 200))
check('projected 不可用时不把 live 的 0 当成本会话用量',
  !/本会话\s*0\b/.test(joined3), joined3.slice(0, 200))

console.log(`\n结果: ${failures.length === 0 ? '全部通过 ✓' : `${failures.length} 处失败 ✗`}`)
for (const f of failures) console.log('  ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
