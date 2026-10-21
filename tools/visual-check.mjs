/**
 * **视觉验证**：把真实组件放进真实浏览器里渲染并截图。
 *
 * ## 为什么需要它
 *
 * README 之前如实写着「未完成：页面的视觉确认」。结构测试能证明「渲染未抛错、
 * 节点数 > 0」，但证明不了「看起来对不对」：方块是不是真的排成 10 列、里程表会
 * 不会挤成一行、主题 token 在浅色/深色下是否真的生效。这些只有**看图**才知道。
 *
 * ## 做法
 *
 * 不绕过 DSH 的鉴权去驱动真实页面（那需要 launch token，越权且脆弱）。改为：
 *
 * 1. 用 `test/browser-env.mjs` 的 DOM 替身把 `client.js` 加载起来，取出**真实的**
 *    slot 注册项（设置页 / 里程表 / 方块墙 / 侧栏图标）；
 * 2. 生成一个自包含 HTML：注入**真实 CSS**（client.js 里那份）、**真实主题 token**
 *    变量、真实 React 18 UMD、以及一段把注册项 `createRoot` 到页面的引导脚本；
 * 3. `fetch` 被替换成返回真实形状的假数据（数字取自本机真实日志），
 *    因此**组件会真的跑到「有数据」分支**，effect、轮询、hooks 全部真跑；
 * 4. 用 Edge headless 截图。
 *
 * 这样看到的是**真实组件 + 真实样式 + 真实数据流**，只有宿主外壳是模拟的——
 * 这正是「视觉确认」需要的那一层。边界如实标注：宿主外壳（侧栏、设置面板的
 * 外框）不在验证范围内。
 *
 * 运行：`node tools/visual-check.mjs`
 * 产物：`tools/out/visual-check.html`、`tools/out/light.png`、`tools/out/dark.png`
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(here, 'out')
mkdirSync(outDir, { recursive: true })

/**
 * 找到 web profile 的 node_modules（React UMD 从那里取）。
 *
 * 不写死绝对路径：优先 `$DSH_HOME`，否则 `~/.dsh`。找不到就直接报错说明原因，
 * 不静默降级（降级会产出一张没有 React 的白页，比失败更难查）。
 */
function findWebModules() {
  const candidates = []
  const dshHome = process.env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    candidates.push(join(dshHome, 'profiles', 'web', 'node_modules'))
  }
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (typeof home === 'string' && home.trim() !== '') {
    candidates.push(join(home, '.dsh', 'profiles', 'web', 'node_modules'))
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'react', 'umd', 'react.production.min.js'))) return dir
  }
  throw new Error(`找不到 web profile 的 node_modules（试过：${candidates.join(' | ')}）`)
}
const webModules = findWebModules()

// ── 1. 加载 client.js，拿到真实注册项与 CSS ───────────────────────────
const { makeEl } = await import('../test/browser-env.mjs')

const doc = {
  body: makeEl('body'),
  head: makeEl('head'),
  documentElement: makeEl('html'),
  createElement: (tag) => makeEl(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
}
const win = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {}, dispatch() {} }
const storage = new Map()
globalThis.document = doc
globalThis.window = win
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => { storage.set(k, String(v)) },
  removeItem: (k) => { storage.delete(k) },
}

const source = readFileSync(join(root, 'client.js'), 'utf-8')
let registered = null
win.__ModuleLoader__ = { load(spec) { registered = spec } }

// 桌宠在 apply() 里会 `setInterval` 轮询并挂到 document.body。Node 里不需要它活着
// （我们要的是组件引用与 CSS），所以把定时器换成空实现，否则进程不会退出。
const realSetInterval = globalThis.setInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

new Function('window', 'document', 'localStorage', 'fetch', source)(
  win, doc, globalThis.localStorage, async () => ({ ok: true, json: async () => ({}) }),
)

// 只需要「组件引用」——真正的渲染发生在浏览器里（那里有真实 React）。
// 所以这里给一个最小的 React 替身，只为让 factory 能跑通。
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

const instance = registered.factory((name) => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require(${name})`)
})

const registrations = []
let css = ''
instance.apply({
  get(name) {
    if (name === 'slots') {
      return {
        inject: (_k, cb) => cb(),
        register: (options, component) => {
          registrations.push({ options, component })
          return () => {}
        },
      }
    }
    // ⚠️ 这里**不再伪造** `styles`。
    //
    // 上一版为了「拿到 CSS 字符串」在这里返回了一个假 styles 服务，于是验证器
    // 自己把 CSS 内联进 HTML——**替被测插件把样式注了进去**，截图当然完美，
    // 而真实运行时（没有 styles 服务）样式一行都没进页面。验证器绕过了它本该
    // 验证的那条路径，这是它失效的根本原因。
    //
    // 现在如实返回 undefined，CSS 必须由插件自己挂进 document.head；
    // 下面从 head 里把 style 取出来用，取不到就直接报错，不静默降级。
    return undefined
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject: (_deps, cb) => cb({}),
  on() {},
  logger: { info() {}, warn() {} },
})

// 从真实注入的 <style> 里取 CSS——取不到说明插件没注入样式，必须硬失败。
const injected = (doc.head.children ?? []).filter((el) => el.tagName === 'STYLE')
if (injected.length === 0) {
  throw new Error(
    '插件没有把样式注入 document.head —— 视觉验证无法进行。'
    + '（这正是真实页面里「方块墙竖排 / 桌宠只剩文本」的根因）',
  )
}
css = injected.map((el) => el.textContent).join('\n')
if (css.length < 1000) throw new Error(`注入的样式过短（${css.length} 字符），疑似未完整注入`)

// 桌宠在 apply() 时启动 setInterval 轮询并挂到 document.body。
// 这里只需要它的 CSS，不需要它在 Node 里活着——清掉定时器让进程能退出。
globalThis.setInterval = realSetInterval

const byName = (n) => registrations.find((r) => r.options.name === n)
const panellist = byName('sidebar.panellist')
const odometer = byName('conversation.input.dock')
const settings = byName('settings.section')
const main = byName('main')

for (const [label, reg] of [['settings.section', settings], ['conversation.input.dock', odometer], ['sidebar.panellist', panellist], ['main', main]]) {
  if (reg === undefined) throw new Error(`slot 未注册：${label}`)
}

// ── 2. 真实形状的假数据（数字取自本机真实日志） ──────────────────────
const TODAY = {
  ok: true,
  day: '2026-10-21',
  yesterday: {
    day: '2026-10-20',
    totals: { requests: 537, inputTokens: 20550117, cacheReadTokens: 106949376, cacheWriteTokens: 0, outputTokens: 294161, reasoningTokens: 9067, totalTokens: 127793654 },
  },
  totals: { requests: 128, inputTokens: 731429, cacheReadTokens: 30635008, cacheWriteTokens: 0, outputTokens: 71030, reasoningTokens: 21039, totalTokens: 31437467 },
  allTime: { requests: 12693, inputTokens: 112162132, cacheReadTokens: 2843323050, cacheWriteTokens: 0, outputTokens: 13427549, reasoningTokens: 4515382, totalTokens: 2971781312 },
  // 本次运行的平均速度：120 万 token / 300 秒 = 4.0K/s。
  run: { startedAt: Date.now() - 300_000, tokens: 1_200_000, elapsedMs: 300_000 },
  // 当前工作区 / 当前模型（host 告知「刚刚在哪、用什么产生了消耗」）。
  // ⚠️ 模型给**原始名**（带渠道前缀），这正是 host 的行为——客户端要自己
  // 归一化后才能匹配到归并后的行。
  current: { workspace: 'F:\\dafeiyu', model: 'workbuddy/deepseek-v4.1-flash' },
  generatedAt: Date.now(),
  config: { keepDays: 400, statusBarEnabled: true, statusBarRefreshMs: 1000 },
  // 运行时开关：横幅默认关（内容已并入桌宠），桌宠与主面板默认开。
  prefs: { statusBar: false, pet: true, wallPanel: true },
  diagnostics: {
    liveEntries: 19,
    sessionsTracked: 89,
    backfill: { sessions: 116, failed: 0, entries: 8410, assistantMessages: 12700, withUsage: 12692, skippedByWatermark: 4282 },
    backfilledAt: Date.now(),
    // 占位路径：不要写真实用户名（这是要公开的仓库）。
    store: { kind: 'file', path: '<DSH_HOME>/token-usage/daily.json' },
  },
}

const mkRow = (key, label, kind, requests, total) => ({
  key, label, provider: key, model: 'deepseek-v4.1-flash', kind,
  totals: {
    requests,
    inputTokens: Math.round(total * 0.03),
    cacheReadTokens: Math.round(total * 0.9),
    cacheWriteTokens: 0,
    outputTokens: Math.round(total * 0.05),
    reasoningTokens: Math.round(total * 0.01),
    totalTokens: total,
  },
})

// 工作区分组的假数据——**用本机真实分布**（来自 tools/migrate-workspace.mjs 的
// 实测结果）。这样截图里的横条长度比例是真的，不是随手编的。
const WORKSPACE_ROWS = [
  { workspace: 'F:\\HD222game', totals: { requests: 3700, inputTokens: 12000000, cacheReadTokens: 800000000, cacheWriteTokens: 0, outputTokens: 12000000, reasoningTokens: 300000, totalTokens: 842373593 } },
  { workspace: 'F:\\dsh-work', totals: { requests: 3100, inputTokens: 10000000, cacheReadTokens: 670000000, cacheWriteTokens: 0, outputTokens: 10000000, reasoningTokens: 250000, totalTokens: 702839440 } },
  { workspace: 'F:\\dafeiyu', totals: { requests: 2900, inputTokens: 9000000, cacheReadTokens: 630000000, cacheWriteTokens: 0, outputTokens: 9000000, reasoningTokens: 200000, totalTokens: 656068057 } },
  { workspace: 'F:\\HD2game', totals: { requests: 2400, inputTokens: 8000000, cacheReadTokens: 490000000, cacheWriteTokens: 0, outputTokens: 8000000, reasoningTokens: 150000, totalTokens: 527475379 } },
  { workspace: 'F:\\HD2tafang', totals: { requests: 900, inputTokens: 3000000, cacheReadTokens: 220000000, cacheWriteTokens: 0, outputTokens: 3000000, reasoningTokens: 50000, totalTokens: 231580537 } },
  { workspace: 'F:\\文案', totals: { requests: 300, inputTokens: 1200000, cacheReadTokens: 84000000, cacheWriteTokens: 0, outputTokens: 1200000, reasoningTokens: 30000, totalTokens: 8858720 } },
  { workspace: '', totals: { requests: 40, inputTokens: 500000, cacheReadTokens: 24000000, cacheWriteTokens: 0, outputTokens: 500000, reasoningTokens: 10000, totalTokens: 3049804 } },
  // 一条「家目录级」的工作区：验证 basename 回落（Windows 用户目录名不该出现在公开仓库里）。
  { workspace: 'C:\\Users\\<user>', totals: { requests: 12, inputTokens: 20000, cacheReadTokens: 20000, cacheWriteTokens: 0, outputTokens: 20000, reasoningTokens: 500, totalTokens: 26338 } },
]

// 当前工作区：取分布里第二大的那个，让「高亮非首位」的情况也被覆盖到
// （只高亮最大的一条会漏掉「当前不是最重的」这个真实场景）。
const CURRENT_CWD = 'F:\\dsh-work'

// 工作区标题映射：模拟宿主 Workspace 服务给的 title。
//
// ⚠️ 用**真实**的值：宿主把 workspace 存成 path: "F:\dsh-work", title: "dsh-work"
// （见 $DSH_HOME/storages/workspace.json）——**title 就是 basename**。
// 早先这里编了「HD222 游戏」「大发鱼」这种不存在的名字，于是截图看起来
// 比真实效果「好看」，掩盖了「标题与路径无区别」这个事实。
//
// 定义在 Node 端并用 JSON.stringify 内联进浏览器脚本：写在浏览器脚本里的话，
// 反斜杠会被外层模板字符串先吃掉一层，浏览器再解析时 \H 退化成 H →
// 变成 F:HD222game，与数据里的 F:\HD222game 对不上，标题映射永远失配。
const WS_TITLE_LIST = [
  { path: 'F:\\HD222game', title: 'HD222game' },
  { path: 'F:\\dsh-work', title: 'dsh-work' },
  { path: 'F:\\dafeiyu', title: 'dafeiyu' },
  { path: 'F:\\HD2game', title: 'HD2game' },
  { path: 'F:\\HD2tafang', title: 'HD2tafang' },
  { path: 'F:\\文案', title: '文案' },
]

// 按天分组的行数据：用来验证设置页表格的**排版**（列宽固定 → 日期不折行；
// 表头紧凑 → 「缓存写」竖排两行）。数字取自本机真实日用量。
const DAY_ROWS = [
  ['2026-09-25', 16, 52125, 437312, 0, 34330, 0, 523767],
  ['2026-09-26', 26, 71591, 513166, 0, 69457, 0, 654214],
  ['2026-09-30', 525, 476588, 88551040, 0, 419346, 0, 89446974],
  ['2026-10-03', 38, 33541, 15570816, 0, 29721, 0, 15634078],
  ['2026-10-12', 1284, 731429, 545031018, 0, 1210331, 0, 553295406],
  ['2026-10-16', 1822, 1042118, 361482450, 0, 1420334, 0, 366991431],
].map(([day, requests, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens]) => ({
  key: day, label: day,
  totals: { requests, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens },
}))

// 归并维度：模型 / 厂商。数字与**变体数**取自本机实测（见 lib/models.js 的
// 说明），这样截图里的「4 个变体」「3 个模型」是真的，不是编的。
const mkTotals = (totalTokens, requests) => ({
  requests,
  inputTokens: Math.round(totalTokens * 0.03),
  cacheReadTokens: Math.round(totalTokens * 0.9),
  cacheWriteTokens: 0,
  outputTokens: Math.round(totalTokens * 0.06),
  reasoningTokens: 0,
  totalTokens,
})

const MODEL_ROWS = [
  { key: 'deepseek\u0000deepseek-v4.1-flash', vendor: 'deepseek', model: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash', variants: ['deepseek-v4.1-flash', 'workbuddy/deepseek-v4.1-flash', 'deepseek-ai/deepseek-v4.1-flash', 'deepseek-v4.1-flash-free'], totals: mkTotals(1620265175, 6800) },
  { key: 'deepseek\u0000deepseek-flash', vendor: 'deepseek', model: 'deepseek-flash', label: 'deepseek-flash', variants: ['deepseek-flash'], totals: mkTotals(593071514, 2400) },
  { key: 'stepfun\u0000step-5-preview', vendor: 'stepfun', model: 'step-5-preview', label: 'step-5-preview', variants: ['step-5-preview'], totals: mkTotals(427737430, 1700) },
  { key: 'minimax\u0000minimax-m3.1-flash', vendor: 'minimax', model: 'minimax-m3.1-flash', label: 'minimax-m3.1-flash', variants: ['minimax/minimax-m3.1-flash:free'], totals: mkTotals(332649250, 1300) },
  { key: 'zhipu\u0000glm-5.3-flash', vendor: 'zhipu', model: 'glm-5.3-flash', label: 'glm-5.3-flash', variants: ['glm-5.3-flash'], totals: mkTotals(152537021, 620) },
  { key: 'unknown\u0000dfmodel', vendor: 'unknown', model: 'dfmodel', label: 'dfmodel', variants: ['dfmodel'], totals: mkTotals(149428477, 590) },
  { key: 'unknown\u0000space-bunny', vendor: 'unknown', model: 'space-bunny', label: 'space-bunny', variants: ['space-bunny-free'], totals: mkTotals(78224417, 310) },
  { key: 'unknown\u0000qfmodel', vendor: 'unknown', model: 'qfmodel', label: 'qfmodel', variants: ['qfmodel'], totals: mkTotals(77397732, 300) },
  { key: 'xiaomi\u0000mimo-v2.6-flash', vendor: 'xiaomi', model: 'mimo-v2.6-flash', label: 'mimo-v2.6-flash', variants: ['mimo-v2.6-flash', 'mimo-v2.6-flash-free'], totals: mkTotals(48151597, 190) },
]

const VENDOR_ROWS = [
  { key: 'deepseek', vendor: 'deepseek', label: 'DeepSeek', models: ['deepseek-v4.1-flash', 'deepseek-flash', 'deepseek-v4-flash'], totals: mkTotals(2234751888, 9400) },
  { key: 'stepfun', vendor: 'stepfun', label: '阶跃 Step', models: ['step-5-preview'], totals: mkTotals(427737430, 1700) },
  { key: 'minimax', vendor: 'minimax', label: 'MiniMax', models: ['minimax-m3.1-flash'], totals: mkTotals(332649250, 1300) },
  { key: 'unknown', vendor: 'unknown', label: '其他', models: ['dfmodel', 'qfmodel', 'space-bunny'], totals: mkTotals(305050626, 1200) },
  { key: 'zhipu', vendor: 'zhipu', label: '智谱 GLM', models: ['glm-5.3-flash'], totals: mkTotals(152537021, 620) },
  { key: 'xiaomi', vendor: 'xiaomi', label: '小米 MiMo', models: ['mimo-v2.6-flash', 'mimo-v2.6-pro'], totals: mkTotals(55790683, 230) },
]

const SUMMARY = {
  ok: true,
  generatedAt: Date.now(),
  range: { from: '2026-09-22', to: '2026-10-21', days: 30 },
  groupBy: 'provider',
  includeSub: true,
  includeAux: true,
  granularity: 'day',
  rows: [
    mkRow('buddy', 'buddy', 'chat', 3739, 1107061791),
    mkRow('workbuddy', 'workbuddy', 'chat', 3286, 880074968),
    mkRow('deepseek-account', 'deepseek-account', 'chat', 2777, 593071514),
    mkRow('qodercn', 'qodercn', 'chat', 832, 185729346),
    mkRow('our-free-model', 'our-free-model', 'chat', 1263, 105258515),
    mkRow('xiaomi', 'xiaomi', 'chat', 437, 51911288),
    mkRow('codearts', 'codearts', 'chat', 74, 24201347),
  ],
  totals: { requests: 12693, inputTokens: 112162132, cacheReadTokens: 2843323050, cacheWriteTokens: 0, outputTokens: 13427549, reasoningTokens: 4515382, totalTokens: 2971781312 },
  today: { day: '2026-10-21', totals: TODAY.totals },
  allTime: TODAY.allTime,
  config: { keepDays: 400, includeSubagents: true, includeAuxiliary: true, statusBarEnabled: true, statusBarRefreshMs: 1000 },
  diagnostics: TODAY.diagnostics,
}

// ── 3. 主题 token：**从宿主真实 CSS 读**，不再手写 ───────────────────
//
// ⚠️ 早先这里手写了一套假值（`--dsw-alias-brand-primary: #247bbf` 蓝）。
// 真实浅色主题里 brand-primary 是 **近黑** rgb(15,17,21)。于是截图里全是蓝色
// 方块，真实页面却是近黑色——截图完全不能代表用户看到的东西。
//
// 这与「验证器伪造 styles」是同一类错误：**验证器骗过了自己**。
// 现在值直接来自 @deepseek-ai/dsh-client-ui-theme 的 design-platform.css。
const { readThemeTokens, USED_TOKENS } = await import('./theme-tokens.mjs')
const theme = readThemeTokens(USED_TOKENS)
if (theme.source === undefined) {
  throw new Error('找不到宿主主题 CSS —— 不能用手写假值冒充，否则截图不可信')
}
/** 把 token Map 变成 CSS 声明块。 */
function tokenBlock(map) {
  return Object.entries(map)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
}
const LIGHT_TOKENS = tokenBlock(theme.light)
const DARK_TOKENS = tokenBlock(theme.dark)
console.log(`主题 token 取自: ${theme.source}`)

// ── 4. 生成 HTML ──────────────────────────────────────────────────────
//
// 引导脚本在浏览器里 `createRoot` 真实组件，所以 effect / fetch / 轮询全都会真跑。
// `fetch` 被替换成返回上面假数据的实现（URL 里带 /today 就给 TODAY）。
const reactUmd = readFileSync(join(webModules, 'react', 'umd', 'react.production.min.js'), 'utf-8')
const reactDomUmd = readFileSync(join(webModules, 'react-dom', 'umd', 'react-dom.production.min.js'), 'utf-8')

// ⚠️ 落单反引号的自检放在**独立文件**里（tools/check-stray-backticks.mjs），
// 这里只调用它。
//
// 为什么不内嵌：检查器若与被检查的文件同处一个模块，那它自己还没跑到，
// 被检查的文件就已经因为语法错误无法加载了——检查器形同虚设（实测：内嵌版本
// 在注入落单反引号时先报 SyntaxError，检查根本没跑）。
const { countStrayBackticks } = await import('./check-stray-backticks.mjs')
const strayBackticks = countStrayBackticks(
  readFileSync(fileURLToPath(import.meta.url), 'utf-8'),
)
if (strayBackticks > 0) {
  throw new Error(
    `visual-check.mjs 里有 ${strayBackticks} 个落单反引号——`
    + '它们会让模板字符串提前闭合（注释里的 Markdown 行内代码最常见）。'
    + '请把它们改成普通引号。',
  )
}

function page({ dark = false } = {}) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-token-usage visual check</title>
<style>
  :root { ${dark ? DARK_TOKENS : LIGHT_TOKENS} }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--dsw-alias-bg-base);
    color: var(--dsw-alias-label-primary);
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    padding: 18px;
  }
  .frame { max-width: 900px; margin: 0 auto 22px; padding: 16px 18px;
    background: var(--dsw-alias-bg-layer-1);
    border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; }
  .frame-label { font-size: 11px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--dsw-alias-label-secondary); margin-bottom: 12px; }
${css}
</style></head>
<body>
<div id="root"></div>
<script>${reactUmd}</script>
<script>${reactDomUmd}</script>
<script>
const TODAY = ${JSON.stringify(TODAY)};
const SUMMARY = ${JSON.stringify(SUMMARY)};
// 工作区分组的假数据（Node 端定义 → 必须显式内联，浏览器脚本看不到 Node 作用域）。
const WORKSPACE_ROWS = ${JSON.stringify(WORKSPACE_ROWS)};
// 按天分组的行数据（同上：Node 端定义 → 内联）。
const DAY_ROWS = ${JSON.stringify(DAY_ROWS)};
// 归并维度（模型 / 厂商）的行数据（同上）。
const MODEL_ROWS = ${JSON.stringify(MODEL_ROWS)};
const VENDOR_ROWS = ${JSON.stringify(VENDOR_ROWS)};
// Workspace 标题映射与当前工作区（同上：Node 端定义 → 内联）。
const WS_TITLE_LIST = ${JSON.stringify(WS_TITLE_LIST)};
const CURRENT_CWD = ${JSON.stringify(CURRENT_CWD)};

// 假 fetch：返回真实形状的数据，让组件跑到「有数据」分支。
//
// ⚠️ /today 的累计值必须**随每次轮询增长**。否则 Odometer 的 sparkline 缓冲区
// 只会攒到 1 个点（组件刻意在「值没变」时不追加采样），画出来是空 SVG——
// 上一版就因为这个把「曲线不显示」误判成了样式问题。
let tick = 0;
window.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/today')) {
    tick += 1;
    const body = JSON.parse(JSON.stringify(TODAY));
    // 每轮 +18 万~+40 万，模拟真实消耗的节奏。
    body.allTime.totalTokens += tick * (180000 + (tick % 5) * 55000);
    return { ok: true, status: 200, json: async () => body };
  }
  // /workspaces（轻量工作区端点，桌宠与主面板都用它）。
  // ⚠️ 判定要用 decodeURIComponent：URL 里的 & 在 html 里可能被写成 &amp;，
  // 直接用 includes('/workspaces') 会漏掉（实测就是这样漏的，横条全空）。
  if (decodeURIComponent(u).includes('/workspaces')) {
    // 该端点的行格式是扁平的 { workspace, totalTokens, requests }。
    const body = {
      ok: true,
      total: WORKSPACE_ROWS.length,
      rows: WORKSPACE_ROWS.map((r) => ({
        workspace: r.workspace,
        totalTokens: r.totals.totalTokens,
        requests: r.totals.requests,
      })),
    };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  }
  // groupBy=workspace 的请求（设置页的汇总表用 /summary）单独回工作区数据。
  if (decodeURIComponent(u).includes('groupBy=workspace')) {
    const body = { ok: true, groupBy: 'workspace', rows: WORKSPACE_ROWS, totals: SUMMARY.totals };
    return { ok: true, status: 200, json: async () => body };
  }
  // 归并维度：模型 / 厂商（用真实分布形状，让截图里的比例是真的）。
  if (decodeURIComponent(u).includes('groupBy=modelNorm')) {
    const body = { ...SUMMARY, groupBy: 'modelNorm', rows: MODEL_ROWS };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  }
  if (decodeURIComponent(u).includes('groupBy=vendor')) {
    const body = { ...SUMMARY, groupBy: 'vendor', rows: VENDOR_ROWS };
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  }
  // 设置页默认按天分组：给一份**按天**的行数据，用来验证表格排版
  // （列宽固定 → 日期不折行；表头紧凑 → 「缓存写」竖排两行）。
  if (decodeURIComponent(u).includes('groupBy=day')) {
    const body = { ...SUMMARY, groupBy: 'day', rows: DAY_ROWS };
    return { ok: true, status: 200, json: async () => body };
  }
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(SUMMARY)) };
};

const React = window.React;
const ReactDOM = window.ReactDOM;
const h = React.createElement;

// 把 client.js 的注册项在浏览器里重新构造出来（factory 只依赖 react）。
const ModuleLoader = { load(spec) { window.__SPEC__ = spec } };
window.__ModuleLoader__ = ModuleLoader;
</script>
<script>${readFileSync(join(root, 'client.js'), 'utf-8')}</script>
<script>
const instance = window.__SPEC__.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require(' + name + ')');
});
const regs = [];
instance.apply({
  get(name) {
    if (name === 'slots') return {
      inject: (_k, cb) => cb(),
      register: (options, component) => { regs.push({ options, component }); return () => {}; },
    };
    // 不伪造 styles：真实运行时没有这个服务，插件必须自己注入样式。
    return undefined;
  },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  inject: (_d, cb) => cb({}),
  on() {},
  logger: { info() {}, warn() {} },
});

// ── 自检：样式是否真的生效（不是「有没有调用」，而是「computed style 对不对」）──
const styleTags = Array.from(document.head.querySelectorAll('style[data-plugin]'));
const probe = document.createElement('div');
probe.className = 'dsh-tu-wall-grid';
document.body.appendChild(probe);
const gridDisplay = getComputedStyle(probe).display;
probe.remove();
const petProbe = document.createElement('div');
petProbe.id = 'dsh-tu-pet';
document.body.appendChild(petProbe);
const petPosition = getComputedStyle(petProbe).position;
petProbe.remove();

const checks = [
  ['本包 <style> 已注入 head', styleTags.length > 0],
  ['方块墙 .dsh-tu-wall-grid 的 display 是 grid', gridDisplay === 'grid'],
  ['桌宠 #dsh-tu-pet 的 position 是 fixed', petPosition === 'fixed'],
];
const failed = checks.filter(([, ok]) => !ok);
const banner = document.createElement('div');
banner.id = 'selfcheck';
banner.setAttribute('data-failed', String(failed.length));
banner.style.cssText = 'padding:10px 14px;margin:0 0 14px;border-radius:8px;font:12px/1.5 monospace;'
  + (failed.length === 0
    ? 'background:#e6f4ea;color:#137333;border:1px solid #137333'
    : 'background:#fce8e6;color:#c5221f;border:1px solid #c5221f');
banner.textContent = (failed.length === 0 ? '✓ 样式自检通过：' : '✗ 样式自检失败：')
  + checks.map(function (c) { return (c[1] ? '✓ ' : '✗ ') + c[0]; }).join('  |  ');
document.body.insertBefore(banner, document.body.firstChild);

const byName = (n) => regs.find((r) => r.options.name === n);
const panellist = byName('sidebar.panellist');
const odometer = byName('conversation.input.dock');
const settings = byName('settings.section');
const main = byName('main');

// ── 模拟宿主的 session-scope standardProps ─────────────────────────
//
// 插件靠 props 里的 useWorkspaces / useSessions / sessionId 取「Workspace 标题」
// 与「当前 cwd」。这里照宿主的形态给一份，否则新加的工作区功能在截图里
// 全是降级路径，等于没验。
//
// ⚠️ WS_TITLE_LIST / CURRENT_CWD 定义在 **Node 端**（见上），这里必须用
// JSON.stringify 内联，不能在浏览器脚本里重新写一遍字面量——反斜杠会被
// 外层模板字符串吃掉一层，路径对不上，标题映射静默失配。
const fakeProps = {
  sessionId: 'session-visual-check',
  session: { sessionId: 'session-visual-check' },
  useWorkspaces: (sel) => sel({ items: WS_TITLE_LIST }),
  // ⚠️ 必须是 current + byId 的**组合**——插件现在读的是
  // useSessions(s => s.byId[s.current]?.cwd)，因为 current 在同一个快照里，
  // 所以 root scope（main 面板）也能拿到当前会话的 cwd。
  useSessions: (sel) => sel({
    current: 'session-visual-check',
    byId: { 'session-visual-check': { cwd: CURRENT_CWD } },
  }),
};

// 侧栏图标用小尺寸容器；设置页传 t；其余无 props。
const Frame = (label, child) => h('div', { className: 'frame' },
  h('div', { className: 'frame-label' }, label), child);

ReactDOM.createRoot(document.getElementById('root')).render(
  h(React.Fragment, null,
    // ① 横幅默认**关闭**（内容已并入桌宠），所以这里不渲染它。
    Frame('② 方块墙主面板 · main（消耗分布默认「按工作区」）', h(main.component, fakeProps)),
    Frame('③ 侧栏图标 · sidebar.panellist（未选中 / 选中 / 22px）',
      h('div', { style: { display: 'flex', gap: 18, alignItems: 'center',
        color: 'var(--dsw-alias-label-secondary)' } },
        h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' } },
          h(panellist.component, { size: 16, active: false })),
        h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-brand-primary)' } },
          h(panellist.component, { size: 16, active: true })),
        h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' } },
          h(panellist.component, { size: 22, active: false })),
      )),
    Frame('④ 设置页 · settings.section（含三个运行时开关）',
      h(settings.component, { t: (k) => k, close: () => {} })),
    // 桌宠是命令式 DOM，apply() 时已挂到 document.body —— 它自己会出现在页面底部。
    Frame('⑤ 桌宠 · document.body 命令式 DOM（见页面右下角）', h('div', null, '')),
  ),
);

// 消耗分布的维度切换：主面板默认「按工作区」，这里按 URL 参数模拟一次点击，
// 好让截图能分别验证「按模型」「按厂商」两档的实际渲染（含「4 个变体」副标题
// 与当前模型高亮）。真实界面里这是用户点出来的，不是自动的。
//
// ⚠️ 用 click 而不是改 React state：要验证的是**真实交互路径**——
// 按钮真的接上了 onClick、真的能切到对应数据。
const dim = new URLSearchParams(location.search).get('dim');
if (dim === 'model' || dim === 'vendor') {
  const want = dim === 'model' ? '模型' : '厂商';
  setTimeout(() => {
    // Segmented 的按钮没有各自的类名，靠容器 .dsh-tu-seg 限定范围再按文本找。
    const btns = Array.from(document.querySelectorAll('.dsh-tu-seg button'));
    const target = btns.find((b) => b.textContent.trim() === want);
    if (target) target.click();
  }, 600);
}
</script>
</body></html>`
}

const lightPath = join(outDir, 'visual-check.html')
const darkPath = join(outDir, 'visual-check.dark.html')
writeFileSync(lightPath, page({ dark: false }), 'utf-8')
writeFileSync(darkPath, page({ dark: true }), 'utf-8')

console.log(`已生成 ${lightPath}`)
console.log(`已生成 ${darkPath}`)
console.log(`CSS ${css.length} 字符；注册项：${registrations.map((r) => r.options.name).join(', ')}`)
