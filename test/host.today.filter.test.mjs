/**
 * **端点口径一致性**的回归测试（预置数据版）。
 *
 * `test/host.routes.test.mjs` 跑在空 store 上（断言全是 `0 vs 0`），只能验 JSON
 * 形状，验不出「两个端点对同一份数据给出不同读数」。这里预置一份 `daily.json`
 * 再调端点，锁住这条不变量：
 *
 * ```
 * /today?includeSub=0 的 allTime  ===  /summary?includeSub=0 的 allTime
 * ```
 *
 * 曾经不成立：`/today` 直接读 `config.*`，完全不看查询参数。后果是设置页关掉
 * 「含子会话」后，区间合计变小、而方块墙/桌宠的累计纹丝不动——同一块界面上
 * 两个互相矛盾的数字。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { localDayKey } from '../lib/fold.js'

const silent = { info: () => {}, warn: () => {} }

/** 造一个桶（全部字段都要有，`toTotals` 会逐字段读）。 */
function bucket(total) {
  return {
    requests: 1,
    inputTokens: total,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: total,
  }
}

/**
 * 起一个插件实例，预置「主会话 100 + 子会话 900」。
 * @param config 传给 `apply()` 的 Cordis config（默认空 = 全用默认值）。
 * @returns `{ call, dispose }`
 */
function boot(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tu-filter-'))
  const day = localDayKey(Date.now())
  mkdirSync(join(home, 'token-usage'), { recursive: true })
  writeFileSync(join(home, 'token-usage', 'daily.json'), JSON.stringify({
    schema: 'dsh-token-usage/daily/v1',
    days: {
      [day]: {
        'main|chat|F:/ws|p|m': bucket(100),
        'sub|chat|F:/ws|p|m': bucket(900),
      },
    },
    watermarks: {},
  }), 'utf-8')

  const routes = []
  const disposers = []
  const ctx = {
    logger: silent,
    get(name) {
      if (name === 'dshHomePath') return () => home
      return undefined
    },
    inject(_deps, cb) {
      cb({
        webServer: { register: (route) => { routes.push(route); return () => {} } },
        effect(fn) {
          const dispose = fn()
          if (typeof dispose === 'function') disposers.push(dispose)
        },
        get: ctx.get,
        logger: silent,
      })
    },
    on() {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  apply(ctx, config)

  const call = (path, search = '') => {
    const route = routes.find((r) => r.path === path)
    assert.notEqual(route, undefined, `未注册路由 ${path}`)
    let text
    route.handler({ url: `${path}${search}`, method: 'GET' }, {
      writeHead() {},
      end(payload) { text = payload },
    })
    return JSON.parse(text)
  }
  const dispose = () => {
    for (const d of disposers) { try { d() } catch {} }
    rmSync(home, { recursive: true, force: true })
  }
  return { call, dispose, day }
}

test('/today 与 /summary 的 allTime 在两种口径下都一致', () => {
  const { call, dispose } = boot()
  try {
    for (const flag of ['1', '0']) {
      const today = call('/dsh-token-usage/today', `?includeSub=${flag}`)
      const summary = call('/dsh-token-usage/summary', `?includeSub=${flag}&groupBy=day`)
      assert.equal(today.ok, true)
      assert.equal(summary.ok, true)
      assert.equal(
        today.allTime.totalTokens,
        summary.allTime.totalTokens,
        `includeSub=${flag} 时两个端点必须给出同一个累计值`,
      )
      // 回显字段必须同义：一个说 true、另一个说 false 会让人以为「筛选没生效」。
      assert.equal(
        today.config.includeSubagents,
        summary.config.includeSubagents,
        `includeSub=${flag} 时两端点的 config.includeSubagents 必须一致`,
      )
    }
  } finally {
    dispose()
  }
})

test('关掉「含子会话」真的会让 /today 的读数变小（不是只影响 /summary）', () => {
  const { call, dispose } = boot()
  try {
    const withSub = call('/dsh-token-usage/today')
    const withoutSub = call('/dsh-token-usage/today', '?includeSub=0')
    assert.equal(withSub.allTime.totalTokens, 1000, '默认计入子会话')
    assert.equal(withoutSub.allTime.totalTokens, 100, '关掉后只算主会话')
    assert.equal(withSub.totals.totalTokens, 1000)
    assert.equal(withoutSub.totals.totalTokens, 100)
    // 响应里要回显实际用的口径，客户端才知道自己看的是什么范围。
    assert.equal(withSub.config.includeSubagents, true)
    assert.equal(withoutSub.config.includeSubagents, false)
  } finally {
    dispose()
  }
})

test('config 关掉 includeSubagents 时，查询参数无法把它打开（硬与）', () => {
  const { call, dispose } = boot({ includeSubagents: false })
  try {
    const body = call('/dsh-token-usage/today', '?includeSub=1')
    assert.equal(body.allTime.totalTokens, 100, '部署期关闭后，查询参数不能把它打开')
    assert.equal(body.config.includeSubagents, false)
  } finally {
    dispose()
  }
})
