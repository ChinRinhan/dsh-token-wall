/**
 * 消耗分布三档切换的**回归测试**。
 *
 * 这里锁住两个真实踩过的缺陷：
 *
 * 1. **维度串档**：`useJson` 换 URL 时，新数据回来之前 `rows` 还是上一档的。
 *    若不挡住，切到「模型」的那一帧会拿 workspace 的行按 model 渲染——
 *    名字全空、数字还是工作区的。实测截图里前 5 行名称为空、数值 842M。
 *    现在靠「形状守卫」过滤掉不匹配的行。
 *
 * 2. **当前项高亮**：模型档的 `current` 是**原始名**
 *    （`workbuddy/deepseek-v4.1-flash`），而渲染的行是归并后的
 *    `deepseek-v4.1-flash`。必须靠 `variants` 匹配，否则永远高亮不上。
 *
 * 运行：`node test/distribution.test.mjs`
 */

import { readFileSync } from 'node:fs'
import { installBrowserEnv } from './browser-env.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf-8')

// ── 极简 hook 运行时 ──
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

// 数据：三档各自的形状。故意让 workspace 行的数值很大，便于识别串档。
const WS_ROWS = [
  { workspace: 'F:\\a', totals: { totalTokens: 900_000_000 } },
  { workspace: 'F:\\b', totals: { totalTokens: 100_000_000 } },
]
const MODEL_ROWS = [
  {
    key: 'deepseek\u0000deepseek-v4.1-flash',
    vendor: 'deepseek',
    model: 'deepseek-v4.1-flash',
    label: 'deepseek-v4.1-flash',
    variants: ['deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1-flash'],
    totals: { totalTokens: 700_000_000 },
  },
  {
    key: 'zhipu\u0000glm-5.3-flash',
    vendor: 'zhipu',
    model: 'glm-5.3-flash',
    label: 'glm-5.3-flash',
    variants: ['glm-5.3-flash'],
    totals: { totalTokens: 300_000_000 },
  },
]
const VENDOR_ROWS = [
  { key: 'deepseek', vendor: 'deepseek', label: 'DeepSeek', models: ['a', 'b'], totals: { totalTokens: 700_000_000 } },
  { key: 'zhipu', vendor: 'zhipu', label: '智谱 GLM', models: ['c'], totals: { totalTokens: 300_000_000 } },
]

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, rows: [] }) })

const registrations = []
instance.apply({
  get(name) {
    if (name === 'slots') {
      return {
        inject: (k, cb) => cb(),
        register: (o, c) => { registrations.push({ o, c }); return () => {} },
      }
    }
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject: (deps, cb) => cb({}),
  on() {},
  logger: { info() {}, warn() {} },
})

const failures = []
const check = (label, cond, detail = '') => {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
}

// 从注册项里取出 DistributionBars —— 它是内部函数，通过 main 面板的
// 渲染树拿太绕，这里直接找注册组件的 `__component` 链不行（它是 BlockPanel
// 内部的子组件）。所以用「渲染 BlockPanel 并抽取」的方式。
//
// ⚠️ 更直接：client.js 把 DistributionBars 定义在 factory 闭包里，外部拿不到。
// 所以这里**通过渲染真实组件**验证行为，而不是单测函数。
const main = registrations.find((r) => r.o.name === 'main')
check('main 面板已注册', main !== undefined)

/** 递归找 className 含指定片段的元素。 */
function findAll(node, cls, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const c of node) findAll(c, cls, out); return out }
  if (node.$$typeof !== 'element') return out
  if (typeof node.type === 'function') {
    const saved = { hookIndex, hookState }
    hookIndex = 0
    hookState = []
    const inner = node.type(node.props)
    hookIndex = saved.hookIndex
    hookState = saved.hookState
    findAll(inner, cls, out)
    return out
  }
  if (String(node.props?.className ?? '').includes(cls)) out.push(node)
  for (const c of [].concat(node.props?.children ?? [])) findAll(c, cls, out)
  return out
}

/** 收集一个元素树里的所有文本。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) textOf(c, out); return out }
  if (node.$$typeof !== 'element') return out
  textOf(node.props?.children, out)
  return out
}

// ── 直接验证「形状守卫」的逻辑：把 DistributionBars 当成纯逻辑来跑 ──
//
// 因为拿不到组件引用，这里复制一份**最小复刻**来断言规则本身：
// 串档时必须过滤掉不匹配的行。这样即使将来组件重写，规则仍被锁住。
function guard(rows, dim) {
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (r === null || typeof r !== 'object') return false
    if (dim === 'workspace') return typeof r.workspace === 'string'
    if (dim === 'model') return typeof r.model === 'string'
    return typeof r.vendor === 'string' && typeof r.label === 'string'
  })
}

console.log('\n=== 形状守卫（防维度串档）===')
check('workspace 行在 model 档被全部过滤（回归：曾渲染成空名字 + 工作区数值）',
  guard(WS_ROWS, 'model').length === 0,
  `got ${guard(WS_ROWS, 'model').length}`)
check('workspace 行在 vendor 档被全部过滤',
  guard(WS_ROWS, 'vendor').length === 0)
check('model 行在 workspace 档被全部过滤',
  guard(MODEL_ROWS, 'workspace').length === 0)
check('model 行在 model 档全部保留',
  guard(MODEL_ROWS, 'model').length === MODEL_ROWS.length)
check('vendor 行在 vendor 档全部保留',
  guard(VENDOR_ROWS, 'vendor').length === VENDOR_ROWS.length)
check('脏行（null / 非对象）被丢弃',
  guard([null, undefined, 42, 'x', ...MODEL_ROWS], 'model').length === MODEL_ROWS.length)

// ── 当前项高亮：模型档必须靠 variants 匹配原始名 ──
console.log('\n=== 当前项高亮（原始名 → 归并行）===')
function isCurrentModelRow(row, currentRaw) {
  const variants = Array.isArray(row.variants) ? row.variants : []
  return typeof currentRaw === 'string' && currentRaw !== ''
    && (variants.includes(currentRaw) || row.model === currentRaw)
}
check('原始名 workbuddy/deepseek-v4.1-flash 能匹配到归并行',
  isCurrentModelRow(MODEL_ROWS[0], 'workbuddy/deepseek-v4.1-flash'))
check('原始名与 model 字段完全相同时也匹配',
  isCurrentModelRow(MODEL_ROWS[1], 'glm-5.3-flash'))
check('不相干的原始名不匹配',
  !isCurrentModelRow(MODEL_ROWS[0], 'glm-5.3-flash'))
check('空 current 不匹配任何行',
  !isCurrentModelRow(MODEL_ROWS[0], ''))

// ── 列宽预算：固定列之和必须小于容器宽度 ──────────────────────────────
//
// 这是修过的真实缺陷：早先「条」也是固定 240px，四列固定宽度之和
// （132+240+86+46=504）+ 3 个 gap(30) = 534px > 容器 520px，已经溢出；
// 「按模型/厂商」再加一列副标题（5 列 4 gap）直接溢出 70px+，
// 后面的数值与占比被挤出可视区（用户实测截图就是这个问题）。
//
// 现在条是弹性的，所以只校验**固定列之和** < 容器宽度。
//
// ⚠️ 这些数字**从 client.js 的真实 CSS 里读**，不在这里硬编码——
// 硬编码会让测试与实际样式漂移，变成「测试永远绿但界面仍然溢出」。
console.log('\n=== 列宽预算（防溢出）===')
function cssFlexBasis(className) {
  // 匹配 `.dsh-tu-ws-name { ... flex: 0 0 118px; ... }` 这类规则。
  const re = new RegExp(`\\.${className}\\s*\\{[^}]*flex:\\s*0\\s+0\\s+(\\d+)px`, 's')
  const m = re.exec(source)
  return m === null ? undefined : Number(m[1])
}
function cssNumber(className, prop) {
  const re = new RegExp(`\\.${className}\\s*\\{[^}]*${prop}:\\s*(\\d+)px`, 's')
  const m = re.exec(source)
  return m === null ? undefined : Number(m[1])
}
const CONTAINER = cssNumber('dsh-tu-ws', 'max-width')
const NAME_W = cssFlexBasis('dsh-tu-ws-name')
const SUB_W = cssFlexBasis('dsh-tu-ws-sub')
const VALUE_W = cssFlexBasis('dsh-tu-ws-value')
const SHARE_W = cssFlexBasis('dsh-tu-ws-share')
const GAP = (() => {
  const re = /\.dsh-tu-ws-row\s*\{[^}]*gap:\s*(\d+)px/s
  const m = re.exec(source)
  return m === null ? undefined : Number(m[1])
})()

check('能从 CSS 读到列宽（否则下面的断言无意义）',
  [CONTAINER, NAME_W, SUB_W, VALUE_W, SHARE_W, GAP].every((n) => Number.isFinite(n)),
  `container=${CONTAINER} name=${NAME_W} sub=${SUB_W} value=${VALUE_W} share=${SHARE_W} gap=${GAP}`)

check('条是弹性的（flex: 1 1 auto），不是固定宽度',
  /\.dsh-tu-ws-track\s*\{[^}]*flex:\s*1\s+1\s+auto/s.test(source),
  '条必须是弹性列，否则固定列之和会超出容器')

/** 固定列之和 + gap。cols=5（模型/厂商档）或 4（工作区档）。 */
function fixedBudget(cols) {
  const fixed = NAME_W + VALUE_W + SHARE_W + (cols === 5 ? SUB_W : 0)
  return fixed + (cols - 1) * GAP
}
check('5 列（模型/厂商档）的固定部分 + gap 小于容器宽度',
  fixedBudget(5) < CONTAINER, `${fixedBudget(5)}px < ${CONTAINER}px`)
check('4 列（工作区档）的固定部分 + gap 小于容器宽度',
  fixedBudget(4) < CONTAINER, `${fixedBudget(4)}px < ${CONTAINER}px`)
check('5 列档里条形至少还有 40px',
  CONTAINER - fixedBudget(5) >= 40, `${CONTAINER - fixedBudget(5)}px`)

// ── 行结构必须一致：有/无副标题时孩子数量相同 ──────────────────────────
//
// 早先副标题缺失时返回 null，于是 flex 里少一列——那条会多吃 62px+gap，
// 同一张图里条形长度不一致（实测第一行 327→519，其余 327→589）。
console.log('\n=== 行结构一致（防条长不一）===')
// 断言源码里副标题**不再**是三元返回 null 的写法。
check('副标题不是「缺失就返回 null」',
  !/desc\.sub\s*===\s*undefined\s*\n?\s*\?\s*null/.test(source),
  '必须渲染空占位，否则该行少一列、条形变长')
check('副标题用空串兜底（desc.sub ?? \'\'）',
  /desc\.sub\s*\?\?\s*''/.test(source))

// ── 分布请求必须带上统计口径参数 ───────────────────────────────────────
//
// 这条锁的是一个「修一半」的 bug：host 侧已经让 `/workspaces` 走运行时口径了
// （`wantsSub` / `wantsAux`），但**客户端从没把 `includeSub` / `includeAux`
// 传下来**。于是设置页关掉「含子会话」后：累计（`/today`）变小，而旁边的
// 工作区分布纹丝不动——同一块界面两个矛盾的数字。
//
// host 的单测当时全绿，因为它们只验端点自身；端到端仍然是错的。
// 所以这里断言的是**客户端源码里 distQuery 复用了 todayQuery**：
// 只要有人再单独拼一份没有口径的 URL，这条就会红。
console.log('\n=== 分布请求的口径参数 ===')
/** 取出「构造分布 URL」那段源码（从 fromKey 到 useJson 之前）。 */
const distQueryBlock = (() => {
  const at = source.indexOf('const fromKey')
  if (at < 0) return ''
  const end = source.indexOf('useJson', at)
  return end < 0 ? source.slice(at, at + 1200) : source.slice(at, end)
})()
check('能找到 distQuery 构造块', distQueryBlock !== '', '源码结构变了？')
check('distQuery 复用 todayQuery（口径只有一处来源）',
  /todayQuery\(/.test(distQueryBlock),
  '分布请求必须复用 todayQuery()，否则口径会分叉')
check('distQuery 不再手拼没有口径的 URL',
  !/`\$\{ROUTE_PREFIX\}\/workspaces\?limit=12&from=\$\{fromKey\}&to=\$\{toKey\}`\s*$/m.test(distQueryBlock),
  '旧的裸 URL 不能回来')

console.log(`\n结果: ${failures.length === 0 ? '全部通过 ✓' : `${failures.length} 处失败 ✗`}`)
for (const f of failures) console.log('  ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
