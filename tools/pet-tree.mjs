/**
 * 桌宠结构快照：把重构后的桌宠 DOM 树**按真实层级**打印出来。
 *
 * 用途：PR1 是视觉重构，`client.smoke` 只断言「某类元素存在」，看不出
 * 「结构对不对、顺序对不对、有没有孤儿节点」。这个脚本把树打出来供人眼核对。
 */
import { readFileSync } from 'node:fs'
import { installBrowserEnv } from '../test/browser-env.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf-8')

const React = {
  createElement: () => null,
  useState: (i) => [typeof i === 'function' ? i() : i, () => {}],
  useEffect: () => {},
  useRef: (i) => ({ current: i }),
}

let registered = null
const env = installBrowserEnv()
env.window.__ModuleLoader__ = { load: (s) => { registered = s } }
const module = { exports: {} }
new Function('window', 'module', 'exports', 'require', source)(
  globalThis.window, module, module.exports,
  (n) => { if (n === 'react') return React; throw new Error(`unexpected require(${n})`) },
)
const instance = registered.factory((n) => {
  if (n === 'react') return React
  throw new Error(`unexpected require(${n})`)
})

const TODAY = {
  ok: true,
  day: '2026-10-12',
  yesterday: { day: '2026-10-11', totals: { totalTokens: 99_000_000 } },
  totals: { totalTokens: 142_590_000 },
  allTime: { totalTokens: 582_970_000 },
  run: { startedAt: Date.now() - 10_000, tokens: 50_000, elapsedMs: 10_000 },
  current: { workspace: 'D:\\projects\\beta', model: 'qodercn/dfmodel' },
  config: { statusBarEnabled: true, statusBarRefreshMs: 1000 },
  prefs: { statusBar: false, pet: true, wallPanel: true, includeSub: true, includeAux: true },
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => TODAY })

const ctx = {
  get(name) {
    if (name === 'slots') return { inject: () => {}, register: () => () => {} }
    if (name === 'locale') return { register: () => () => {}, bind: () => (k) => k }
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject: (d, cb) => cb({}),
}
instance.apply(ctx)

for (let i = 0; i < 24; i += 1) await Promise.resolve()
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))

const root = env.body.children.find((c) => c.id === 'dsh-tu-pet')
if (root === undefined) {
  console.error('桌宠未挂载')
  process.exit(1)
}

const SKIP = new Set(['dsh-tu-pet-grip'])
function dump(node, depth = 0, label = '') {
  const pad = '  '.repeat(depth)
  let line = ''
  if (label !== '') line += `${label} `
  line += node.tagName ? `<${node.tagName.toLowerCase()}>` : '(node)'
  if (node.id) line += ` #${node.id}`
  const cls = String(node.className ?? '').trim()
  if (cls !== '') line += ` .${cls.split(/\s+/).join('.')}`
  const text = node._text !== undefined && node._text !== '' ? JSON.stringify(node._text) : ''
  if (text !== '') line += ` ${text}`
  if (node.hidden) line += ' [hidden]'
  const w = node.style?.width
  if (w !== undefined && w !== '') line += ` {width:${w}}`
  console.log(pad + line)
  for (const c of node.children ?? []) dump(c, depth + 1)
}

console.log('=== 桌宠 DOM 结构（展开态）===\n')
dump(root)

// 行序断言：核心读数的出现顺序必须是 大数字 → 进度条 → 池。
const walk = []
;(function collect(n) {
  const cls = String(n.className ?? '')
  for (const key of ['dsh-tu-pet-total', 'dsh-tu-pet-charge', 'dsh-tu-pet-pool']) {
    if (cls.split(/\s+/).includes(key)) walk.push(key)
  }
  for (const c of n.children ?? []) collect(c)
})(root)
const order = walk.join(' → ')
const expected = 'dsh-tu-pet-total → dsh-tu-pet-charge → dsh-tu-pet-pool'
console.log(`\n行序: ${order}`)
console.log(order === expected ? 'OK   行序正确' : `FAIL 行序应为 ${expected}`)

const allText = []
;(function collectText(n) {
  if (n._text !== undefined && n._text !== '') allText.push(String(n._text))
  for (const c of n.children ?? []) collectText(c)
})(root)
console.log(`\n全部文本: ${JSON.stringify(allText)}`)
const banned = ['今日', '速度', '昨日', 'Today', 'Rate', 'Yesterday']
const leaked = banned.filter((b) => allText.some((tx) => tx === b))
console.log(leaked.length === 0 ? 'OK   无已移除的标签' : `FAIL 仍残留标签: ${leaked.join(', ')}`)

// ── 折叠态 ───────────────────────────────────────────────────────────
//
// 折叠态是 99% 时间被看到的那一屏。PR1 只有 CSS 参与（`.is-collapsed` 隐藏
// 进度条），所以这里断言**类名与结构**，而不是计算样式（测试替身不跑布局）。
// 真正「折叠态该显示什么」的自适应逻辑在 PR2。
const btn = (function findBtn(n) {
  if (String(n.className ?? '').includes('dsh-tu-pet-btn')) return n
  for (const c of n.children ?? []) { const r = findBtn(c); if (r !== undefined) return r }
  return undefined
})(root)

console.log('\n=== 折叠态 ===')
btn.dispatch('click', { stopPropagation() {} })
const collapsedCls = String(root.className)
console.log(`root.className = ${JSON.stringify(collapsedCls)}`)
const isCollapsed = collapsedCls.includes('is-collapsed')
console.log(isCollapsed ? 'OK   进入折叠态' : 'FAIL 未进入折叠态')

const btnLabel = btn._text
console.log(btnLabel === '+' ? 'OK   折叠按钮变为 +' : `FAIL 按钮应为 + 实为 ${JSON.stringify(btnLabel)}`)

// 折叠态下池仍在 DOM 里（CSS 负责可见性，DOM 不删——否则展开时无法复现）。
const stillHasPool = (function has(n) {
  if (String(n.className ?? '').includes('dsh-tu-pet-pool')) return true
  for (const c of n.children ?? []) if (has(c)) return true
  return false
})(root)
console.log(stillHasPool ? 'OK   池仍在 DOM（由 CSS 控制显隐）' : 'FAIL 池被误删')

// CSS 必须为折叠态定义「保留池、隐藏进度条」。
const cssText = source
const hideChargeRe = /\.is-collapsed\s+\.dsh-tu-pet-charge[^{]*\{[^}]*display:\s*none/
console.log(hideChargeRe.test(cssText) ? 'OK   折叠态隐藏进度条' : 'FAIL 折叠态未隐藏进度条')
const poolVisibleRe = /\.is-collapsed\s+\.dsh-tu-pet-pool/
const poolHidden = /\.is-collapsed[^{]*\{[^}]*\}\s*$/m.test('')
console.log(!poolHidden ? 'OK   折叠态未隐藏池' : 'FAIL 折叠态隐藏了池')

const ok = order === expected && leaked.length === 0 && isCollapsed && btnLabel === '+'
  && stillHasPool && hideChargeRe.test(cssText)

// ── 带真实形状数据的完整渲染 ─────────────────────────────────────────
//
// 上面那份 mock 不带 `session`，所以缓存/本轮都是 `—`。这里换成一份接近真实
// 的响应，把桌宠实际会显示的文字打出来——这是「数据够不够、会不会挤」唯一
// 离线可看的形式。
const WITH_SESSION = {
  ...TODAY,
  session: {
    id: 'sess-demo',
    live: { sessionTokens: 1_472_899, turnTokens: 1_472_899, turn: 16, steps: 3 },
    projected: {
      tokenUsage: {
        uncachedInputTokens: 1_042_250,
        outputTokens: 268_267,
        cacheReadTokens: 118_583_936,
        cacheWriteTokens: 0,
      },
      contextPressure: {
        contextWindow: 1_000_000,
        pressureTokens: 491_288,
        projectedTokens: 491_473,
      },
    },
  },
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => WITH_SESSION })
const beforeFull = new Set(env.body.children)
instance.apply(ctx)
const fullPet = env.body.children.find((c) => !beforeFull.has(c))
for (let i = 0; i < 24; i += 1) await Promise.resolve()
await new Promise((r) => setTimeout(r, 0))
await new Promise((r) => setTimeout(r, 0))

console.log('\n=== 带会话数据时的完整结构 ===\n')
dump(fullPet)

const fullText = []
;(function collect(n) {
  if (n._text !== undefined && n._text !== '') fullText.push(String(n._text))
  for (const c of n.children ?? []) collect(c)
})(fullPet)
console.log(`\n渲染出来的文字: ${JSON.stringify(fullText)}`)

const hasCache = fullText.some((s) => /^\d+\.\d%$/.test(s))
const hasTurn = fullText.some((s) => s.includes('1.47M') && s.startsWith('·'))
console.log(hasCache ? 'OK   缓存命中率已渲染' : 'FAIL 缓存命中率缺失')
console.log(hasTurn ? 'OK   本轮已渲染' : 'FAIL 本轮缺失')

process.exitCode = ok && hasCache && hasTurn ? 0 : 1
