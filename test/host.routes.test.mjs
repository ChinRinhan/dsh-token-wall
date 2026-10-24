/**
 * **Host 半的只读路由**：`/today` 与 `/summary` 的响应契约。
 *
 * ## 为什么需要这个文件
 *
 * 之前所有测试都在验证 `lib/**` 的纯逻辑与 `client.js` 的渲染，**没有任何一个**
 * 检查 host 实际下发的 JSON 形状。于是两个真实缺陷溜了过去：
 *
 * 1. `/today` 不下发 `diagnostics`，而方块墙主面板读的正是 `/today`；它拿到
 *    `undefined` 后按「没有 store」渲染，把**落盘成功**的状态报成了
 *    「仅内存（未找到 DSH home）」。
 * 2. `/today` 与 `/summary` 的 `allTime` 直接调 `grandTotals()`，无视
 *    `includeSub` / `includeAux` 开关，导致「区间合计」与「累计」互相矛盾。
 *
 * 这两条都是**数据形状**层面的错误，纯逻辑单测覆盖不到，所以这里用 mock 的
 * Cordis 上下文真正跑一遍 `apply()`，抓取注册的 route 并调用其 handler。
 *
 * 运行：`node test/host.routes.test.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

// ── 极简断言框架（与其它 test/*.mjs 同风格，零依赖） ──────────────────
let passed = 0
let failed = 0
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`OK   ${label}${detail === undefined ? '' : ` (${detail})`}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}${detail === undefined ? '' : ` (${detail})`}`)
  }
}

// ── 测试夹具 ──────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dsh-token-usage-routes-'))

/** 收集 apply() 期间注册的 web route。 */
const routes = []

/** 记录 dispose 回调，便于测后清理。 */
const disposers = []

/**
 * 造一个够用的 Cordis 上下文。
 *
 * 只实现本插件真正用到的成员：`get`（取可选服务）、`inject`（可选依赖回调）、
 * `on`（事件订阅）、`effect`（随 fiber 卸载）、`logger`。
 */
function makeCtx() {
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'dshHomePath') return () => home
      return undefined
    },
    inject(_deps, cb) {
      // 本插件对 sessionPersistence / webServer 都是可选依赖。
      // 这里注入 webServer（要被测的那个），不注入 sessionPersistence
      // ——回填由别的测试覆盖，这里只关心路由。
      const scoped = {
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
        },
        get: ctx.get,
        logger: ctx.logger,
      }
      cb(scoped)
    },
    on() {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  return ctx
}

/**
 * 调用一个已注册的 route，返回解析后的 JSON。
 *
 * @param path   路由路径。
 * @param search 查询串。
 * @param method HTTP 方法（默认 GET）。
 * @param body   请求体（PUT 时用）。**异步**：prefs 的 PUT handler 是
 *               「读 body → 解析 → 写盘 → 响应」，需要等 end 事件。
 */
/**
 * 调用一个已注册的 route，返回解析后的 JSON。
 *
 * ⚠️ **必须是 async**：`/today` 的 handler 现在会 await（带 `session` 参数时
 * 要读宿主投影，冷会话可能读盘）。响应是在微任务里 `end()` 的，同步取
 * `text` 只会拿到 undefined——这正是本文件早先报 `"undefined" is not valid
 * JSON` 的原因。
 *
 * @param path   路由路径。
 * @param search 查询串。
 * @param method HTTP 方法（默认 GET）。
 * @param body   请求体（PUT 时用）。
 */
async function callRoute(path, search = '', { method = 'GET', body = undefined } = {}) {
  const route = routes.find((r) => r.path === path)
  assert.notEqual(route, undefined, `未注册路由 ${path}`)
  let text
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    writeHead() {},
    end(payload) {
      text = payload
      resolveDone()
    },
  }
  if (method === 'GET') {
    route.handler({ url: `${path}${search}`, method: 'GET' }, res)
    await done
    return JSON.parse(text)
  }
  // 写方法：伪造一个带 on('data')/on('end') 的 req。
  let settled = false
  const req = {
    url: `${path}${search}`,
    method,
    on(event, fn) {
      if (event === 'data') fn(body ?? '')
      if (event === 'end') { fn(); settled = true }
    },
  }
  route.handler(req, res)
  assert.equal(settled, true, 'PUT handler 必须同步走完 end（body 是同步喂的）')
  await done
  return JSON.parse(text)
}

// ── 跑起来 ────────────────────────────────────────────────────────────
apply(makeCtx(), { backfillOnStart: false })

console.log('\n=== 路由注册 ===')
check('注册了 4 条路由', routes.length === 4, routes.map((r) => r.path).join(', '))
check('/today 已注册', routes.some((r) => r.path === '/dsh-token-usage/today'))
check('/summary 已注册', routes.some((r) => r.path === '/dsh-token-usage/summary'))
check('/workspaces 已注册', routes.some((r) => r.path === '/dsh-token-usage/workspaces'))
check('/prefs 已注册', routes.some((r) => r.path === '/dsh-token-usage/prefs'))

// ── ① /today 必须下发 diagnostics（回归：曾缺失 ⇒ 面板误报「仅内存」）──
console.log('\n=== /today 响应契约 ===')
const today = await callRoute('/dsh-token-usage/today')
check('/today ok=true', today.ok === true)
check('/today 有 totals', typeof today.totals === 'object' && today.totals !== null)
check('/today 有 allTime', typeof today.allTime === 'object' && today.allTime !== null)
check('/today 有 yesterday', typeof today.yesterday === 'object')

// 核心回归断言：BlockPanel 的诊断区读 data.diagnostics。
// 缺了它，Diagnostics 会把 store 当成不存在，显示「仅内存（未找到 DSH home）」。
check(
  '/today 下发 diagnostics（回归：缺失导致误报「仅内存」）',
  today.diagnostics !== undefined && today.diagnostics !== null,
  today.diagnostics === undefined ? '缺失' : 'ok',
)
check(
  '/today diagnostics.store 是 file 后端（不是 memory）',
  today.diagnostics?.store?.kind === 'file',
  today.diagnostics?.store?.kind,
)
check(
  '/today diagnostics.store.path 指向 home 下的 daily.json',
  typeof today.diagnostics?.store?.path === 'string'
    && today.diagnostics.store.path.endsWith('daily.json'),
  today.diagnostics?.store?.path,
)
check('/today diagnostics.sessionsTracked 是数字', Number.isFinite(today.diagnostics?.sessionsTracked))

// config 是客户端调整轮询间隔的依据，必须存在。
check('/today 下发 config.statusBarRefreshMs', Number.isFinite(today.config?.statusBarRefreshMs))
check('/today 下发 config.keepDays（诊断区要显示）', Number.isFinite(today.config?.keepDays))

// ── ② /summary 契约 ───────────────────────────────────────────────────
console.log('\n=== /summary 响应契约 ===')
const summary = await callRoute('/dsh-token-usage/summary', '?from=2026-01-01&to=2026-12-31')
check('/summary ok=true', summary.ok === true)
check('/summary 有 rows 数组', Array.isArray(summary.rows))
check('/summary 有 totals', typeof summary.totals === 'object')
check('/summary 有 allTime', typeof summary.allTime === 'object')
check('/summary 有 diagnostics', summary.diagnostics !== undefined)
check('/summary 回显 range.days', Number.isFinite(summary.range?.days))

// ── ③ allTime 必须遵守过滤开关（回归：曾无视 includeSub/includeAux）──
//
// 空存储下两个数都是 0，无法区分「遵守」与「无视」。所以这里直接验证
// **代码路径**：allTime 与同参数的区间合计必须是同一个对象形状，并且在
// 打开/关闭开关时行为一致。真正的数值回归由 test/fold.test.mjs 覆盖
// （那里用造出来的数据断言了「关掉子会话后累计必须下降」）。
console.log('\n=== allTime 过滤口径 ===')
const withAll = await callRoute('/dsh-token-usage/summary', '?from=2000-01-01&to=2099-12-31&includeSub=1&includeAux=1')
const noSub = await callRoute('/dsh-token-usage/summary', '?from=2000-01-01&to=2099-12-31&includeSub=0&includeAux=1')
const noAux = await callRoute('/dsh-token-usage/summary', '?from=2000-01-01&to=2099-12-31&includeSub=1&includeAux=0')

check(
  '不限区间时 totals 与 allTime 一致（同一口径）',
  withAll.totals.totalTokens === withAll.allTime.totalTokens,
  `${withAll.totals.totalTokens} vs ${withAll.allTime.totalTokens}`,
)
check(
  'includeSub 开关会回显到响应',
  withAll.includeSub === true && noSub.includeSub === false,
  `${withAll.includeSub}/${noSub.includeSub}`,
)
check(
  'includeAux 开关会回显到响应',
  withAll.includeAux === true && noAux.includeAux === false,
  `${withAll.includeAux}/${noAux.includeAux}`,
)

// allTime 不能大于同区间的 totals（它最多等于「不限区间」的结果）。
check(
  'allTime 不因关闭过滤而异常增大',
  noSub.allTime.totalTokens <= withAll.allTime.totalTokens,
  `${noSub.allTime.totalTokens} <= ${withAll.allTime.totalTokens}`,
)

// ── ④ /workspaces：轻量工作区端点（桌宠用） ─────────────────────────
//
// 桌宠是 root scope 的命令式 DOM，拿不到 session-scope 的 props，所以它问 host
// 要「消耗最多的工作区」。这个端点为此存在：只回 top N，比 /summary 轻。
console.log('\n=== /workspaces 契约 ===')
const ws = await callRoute('/dsh-token-usage/workspaces', '?limit=3')
check('/workspaces ok=true', ws.ok === true)
check('/workspaces 有 rows 数组', Array.isArray(ws.rows))
check('/workspaces 有 total（未截断的总数）', Number.isFinite(ws.total))
check('/workspaces 遵守 limit', ws.rows.length <= 3, `rows=${ws.rows.length}`)
for (const row of ws.rows) {
  check(
    `工作区行 ${row.workspace} 有 workspace / totalTokens / requests`,
    typeof row.workspace === 'string'
      && Number.isFinite(row.totalTokens)
      && Number.isFinite(row.requests),
  )
  check(
    `工作区行 ${row.workspace} 不是空串（未标注已被排除）`,
    row.workspace !== '',
  )
}
// 不传 limit 时用默认 5。
const wsDefault = await callRoute('/dsh-token-usage/workspaces')
check('/workspaces 默认 limit=5', wsDefault.rows.length <= 5, `rows=${wsDefault.rows.length}`)
// from/to 范围参数被接受（主面板切「今日」时用）。
const wsToday = await callRoute('/dsh-token-usage/workspaces', '?from=2026-10-21&to=2026-10-21')
check('/workspaces 接受 from/to', wsToday.ok === true && Array.isArray(wsToday.rows))

// ── ⑤ /prefs：运行时开关（横幅 / 桌宠 / 主面板） ─────────────────────
console.log('\n=== /prefs 契约 ===')
const prefsGet = await callRoute('/dsh-token-usage/prefs')
check('/prefs GET ok=true', prefsGet.ok === true)
check('/prefs 返回三个开关',
  prefsGet.prefs?.statusBar !== undefined
  && prefsGet.prefs?.pet !== undefined
  && prefsGet.prefs?.wallPanel !== undefined,
  JSON.stringify(prefsGet.prefs))
check('/prefs 默认：桌宠与主面板开，横幅关（内容已并入桌宠）',
  prefsGet.prefs?.statusBar === false
  && prefsGet.prefs?.pet === true
  && prefsGet.prefs?.wallPanel === true,
  JSON.stringify(prefsGet.prefs))

const prefsPut = await callRoute('/dsh-token-usage/prefs', '', {
  method: 'PUT',
  body: JSON.stringify({ pet: false }),
})
check('/prefs PUT ok=true', prefsPut.ok === true)
check('/prefs PUT 后 pet=false', prefsPut.prefs?.pet === false)
check('/prefs PUT 未提到的键保持不变', prefsPut.prefs?.statusBar === false)
check('/prefs PUT 后再 GET 一致',
  (await callRoute('/dsh-token-usage/prefs')).prefs?.pet === false)

// 脏输入被拒绝或钳制，不能 500。
const badJson = await callRoute('/dsh-token-usage/prefs', '', { method: 'PUT', body: 'not json' })
check('/prefs 拒绝非法 JSON', badJson.ok === false, `error=${badJson.error}`)
const badType = await callRoute('/dsh-token-usage/prefs', '', { method: 'PUT', body: '[1,2]' })
check('/prefs 拒绝非对象', badType.ok === false, `error=${badType.error}`)
const wrongValue = await callRoute('/dsh-token-usage/prefs', '', {
  method: 'PUT',
  body: JSON.stringify({ pet: 'yes' }),
})
check('/prefs 钳制错类型的值', wrongValue.ok === true && wrongValue.prefs?.pet === true)

// /today 与 /summary 都下发 prefs（客户端挂载前要知道开关状态）。
check('/today 下发 prefs', today.prefs !== undefined)
check('/summary 下发 prefs', summary.prefs !== undefined)

// ── ⑥ 归并维度：modelNorm / vendor ──────────────────────────────────
//
// 背景：同一个模型会走多个渠道，模型名带上不同前缀/后缀
// （`workbuddy/deepseek-v4.1-flash`、`deepseek-v4.1-flash-free`）。按原始
// 模型名分组会把它拆成 4 行。这两个维度在 host 侧做归并。
console.log('\n=== 归并维度（modelNorm / vendor）===')
const byModelNorm = await callRoute('/dsh-token-usage/summary', '?groupBy=modelNorm')
check('/summary 接受 groupBy=modelNorm', byModelNorm.groupBy === 'modelNorm')
check('modelNorm 行带 vendor 字段',
  byModelNorm.rows.every((r) => typeof r.vendor === 'string'))
check('modelNorm 行带 variants 数组',
  byModelNorm.rows.every((r) => Array.isArray(r.variants)))

const byVendor = await callRoute('/dsh-token-usage/summary', '?groupBy=vendor')
check('/summary 接受 groupBy=vendor', byVendor.groupBy === 'vendor')
check('vendor 行带 label 与 models',
  byVendor.rows.every((r) => typeof r.label === 'string' && Array.isArray(r.models)))

// 归并后总量必须与按天合计一致（不丢不重）。
const byDay = await callRoute('/dsh-token-usage/summary', '?groupBy=day')
const sumOf = (rows) => rows.reduce((a, r) => a + (Number(r.totals?.totalTokens) || 0), 0)
check('modelNorm 合计 == 按天合计',
  sumOf(byModelNorm.rows) === sumOf(byDay.rows),
  `${sumOf(byModelNorm.rows)} vs ${sumOf(byDay.rows)}`)
check('vendor 合计 == 按天合计',
  sumOf(byVendor.rows) === sumOf(byDay.rows),
  `${sumOf(byVendor.rows)} vs ${sumOf(byDay.rows)}`)

// ── ⑦ providerModel 不再被 workspace 污染（回归） ────────────────────
//
// 早先把 workspace 加进桶键时，providerModel 的 rowKey 也用了 bucketKeyOf，
// 于是同一 (provider, model) 在不同工作区被拆成多行。实测本机 66 行里只有
// 20 个真实组合。现在 rowKey 用独立的 ROW_SEP，同一组合必须只有一行。
console.log('\n=== providerModel 不被 workspace 拆分 ===')
const byPM = await callRoute('/dsh-token-usage/summary', '?groupBy=providerModel')
const pmKeys = byPM.rows.map((r) => `${r.provider}\u0000${r.model}`)
check('providerModel 的 (provider, model) 不重复',
  new Set(pmKeys).size === pmKeys.length,
  `${pmKeys.length} 行 / ${new Set(pmKeys).size} 个唯一组合`)

// ── ⑧ kind 分组只给枚举值（回归：host 曾下发中文文案） ────────────────
console.log('\n=== kind 分组文案 ===')
const byKind = await callRoute('/dsh-token-usage/summary', '?groupBy=kind')
check('/summary 接受 groupBy=kind', byKind.groupBy === 'kind')
for (const row of byKind.rows) {
  check(
    `kind 行 ${row.key} 的 label 是枚举值且无中文`,
    row.label === row.kind && !/[\u4e00-\u9fff]/.test(String(row.label)),
    row.label,
  )
}

// ── ⑤ 卸载不抛错 ──────────────────────────────────────────────────────
console.log('\n=== 卸载 ===')
try {
  for (const dispose of disposers) dispose()
  check('dispose 全部执行且不抛错', true)
} catch (error) {
  check('dispose 全部执行且不抛错', false, String(error))
}

try {
  rmSync(home, { recursive: true, force: true })
} catch {
  // 临时目录清理失败不影响结论。
}

console.log(`\n结果: ${failed === 0 ? '全部通过 ✓' : `${failed} 项失败 ✗`}`)
console.log(`  通过 ${passed} 项${failed === 0 ? '' : `，失败 ${failed} 项`}`)
process.exit(failed === 0 ? 0 : 1)
