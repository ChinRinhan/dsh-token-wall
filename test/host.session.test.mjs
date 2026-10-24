/**
 * `/today?session=` 的会话用量契约。
 *
 * 这块最容易静默失效：桌宠要显示「当前会话用了多少」，而 host 自己**看不到**
 * 用户在 UI 里选中了哪个会话（那是客户端状态），所以只能由客户端桥把 sessionId
 * 推上来。拿到 id 之后又有三种现实情况（活会话 / 冷会话 / 都不可用），必须逐级
 * 覆盖，且**任何一级都不许把「读不到」伪装成 0**。
 *
 * 本文件锁的就是这三级降级，以及「老客户端不带 session 参数时行为完全不变」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'
import { localDayKey } from '../lib/fold.js'

const silent = { info: () => {}, warn: () => {} }

/**
 * 起一个插件实例。
 *
 * @param options.services 额外注入的宿主服务（`sessions` / `sessionProjections` / `sessionQuery`）。
 * @returns `{ call, emit, dispose }`，其中 `emit(session, event)` 触发 `session/event`。
 */
function boot(options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tu-session-'))
  const day = localDayKey(Date.now())
  mkdirSync(join(home, 'token-usage'), { recursive: true })
  writeFileSync(join(home, 'token-usage', 'daily.json'), JSON.stringify({
    schema: 'dsh-token-usage/daily/v1',
    days: { [day]: {} },
    watermarks: {},
  }), 'utf-8')

  const routes = []
  const disposers = []
  /** 捕获 `ctx.on('session/event', …)` 注册的监听器。 */
  const listeners = new Map()

  const services = options.services ?? {}
  const ctx = {
    logger: silent,
    get(name) {
      if (name === 'dshHomePath') return () => home
      if (name in services) return services[name]
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
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  apply(ctx, { backfillOnStart: false })

  const call = async (path, search = '') => {
    const route = routes.find((r) => r.path === path)
    assert.notEqual(route, undefined, `未注册路由 ${path}`)
    let text
    let resolveDone
    const done = new Promise((resolve) => { resolveDone = resolve })
    route.handler({ url: `${path}${search}`, method: 'GET' }, {
      writeHead() {},
      end(payload) { text = payload; resolveDone() },
    })
    await done
    return JSON.parse(text)
  }

  /** 触发一次 session/event（模拟宿主投递）。 */
  const emit = (session, event) => {
    for (const fn of listeners.get('session/event') ?? []) fn(session, event)
  }

  const dispose = () => {
    for (const d of disposers) { try { d() } catch {} }
    rmSync(home, { recursive: true, force: true })
  }
  return { call, emit, dispose }
}

/**
 * 造一个**形状与宿主真实租约一致**的 SessionObservation。
 *
 * ## ⚠️ 为什么不能省事地给个 `.dispose()`
 *
 * 宿主真实的 `SessionObservation` 是 `extends Disposable`，租约对象上只有
 * **`[Symbol.dispose]()`** 和 `retain()`，**没有 `.dispose()`**（见
 * `sessionQuery` 的 `live()` / `read()` 返回的字面量）。
 *
 * 这个测试最早就是自己造了一个 `.dispose()`。于是实现里的
 * `observation?.dispose?.()`（一个静默空操作）把测试骗过去了 ——
 * **实现与验证器共享同一个错误前提**，正是 NOTES 里「验证器骗过自己」的同款。
 *
 * 所以这里刻意只提供 `[Symbol.dispose]`，并且**故意不提供 `.dispose()`**：
 * 哪天有人把实现写回 `.dispose?.()`，这个测试会立刻红。
 *
 * @param options.projections 观察结果里的投影快照（可选）。
 * @param options.events      观察结果里的事件序列（可选，用于播种路径）。
 * @param options.onDispose   释放时回调，用于断言「租约真的被释放了」。
 */
function createLease(options = {}) {
  let disposed = false
  const lease = {
    source: 'prepared',
    header: { cwd: 'F:/ws' },
    inheritedEventCount: 0,
    events: options.events ?? [],
    cursor: -1,
    retain: () => lease,
    [Symbol.dispose]: () => {
      disposed = true
      options.onDispose?.()
    },
  }
  if (options.projections !== undefined) lease.projections = options.projections
  // 供断言使用：租约是否已被释放。
  lease.__isDisposed = () => disposed
  return lease
}

/** 造一条 assistant/message。 */
function message({ turn = 1, step = 1, input = 100, output = 10 }) {
  return {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: {
      turn,
      step,
      usage: { inputTokens: input, outputTokens: output },
      message: { source: { provider: 'p', model: 'm' } },
    },
  }
}

const liveSession = (id) => ({ id, header: { cwd: 'F:/ws' } })

// ── 老客户端行为不变 ──────────────────────────────────────────────────

test('不带 session 参数时，响应里没有 session 字段', async () => {
  const { call, dispose } = boot()
  try {
    const body = await call('/dsh-token-usage/today')
    assert.equal(body.ok, true)
    assert.equal('session' in body, false, '老客户端不该看到新字段')
  } finally {
    dispose()
  }
})

// ── ③ 都不可用：必须显式说明原因，不能给 0 ────────────────────────────

test('宿主没有 sessionQuery 时，projected=null 且给出原因', async () => {
  const { call, dispose } = boot()
  try {
    const body = await call('/dsh-token-usage/today', '?session=sess-1')
    assert.equal(body.session.id, 'sess-1')
    assert.equal(body.session.projected, null)
    assert.equal(body.session.projectedUnavailable, 'no-session-query')
    // live 没数据时是 null，而不是「0 tokens」——「没见到」和「花了 0」是两件事。
    assert.equal(body.session.live, null)
  } finally {
    dispose()
  }
})

// ── ① 活会话：走 sessionProjections.snapshot ──────────────────────────

test('活会话命中 sessions.get + sessionProjections 时给出精确投影', async () => {
  const session = liveSession('sess-live')
  const snapshotValues = {
    tokenUsage: {
      uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0,
    },
    contextPressure: { contextWindow: 128000, pressureTokens: 32000, projectedTokens: 33000 },
  }
  const { call, dispose } = boot({
    services: {
      sessions: { get: (id) => (id === 'sess-live' ? session : undefined) },
      sessionProjections: { snapshot: () => ({ asOfSeq: 9, values: snapshotValues }) },
    },
  })
  try {
    const body = await call('/dsh-token-usage/today', '?session=sess-live')
    assert.equal(body.session.projectedUnavailable, undefined, '不该有降级原因')
    assert.deepEqual(body.session.projected.tokenUsage, snapshotValues.tokenUsage)
    assert.deepEqual(body.session.projected.contextPressure, snapshotValues.contextPressure)
  } finally {
    dispose()
  }
})

test('活会话存在但投影里没有 tokenUsage 时，继续尝试冷路径', async () => {
  const session = liveSession('sess-x')
  let observed = 0
  const { call, dispose } = boot({
    services: {
      sessions: { get: () => session },
      // 活会话的投影缺 tokenUsage → 应退到 sessionQuery
      sessionProjections: { snapshot: () => ({ asOfSeq: 1, values: {} }) },
      sessionQuery: {
        observeSession: async () => {
          observed += 1
          return createLease({
            projections: {
              values: {
                tokenUsage: {
                  uncachedInputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0,
                },
              },
            },
          })
        },
      },
    },
  })
  try {
    const body = await call('/dsh-token-usage/today', '?session=sess-x')
    assert.equal(observed, 1, '活会话投影不完整时必须退到冷路径')
    assert.equal(body.session.projected.tokenUsage.outputTokens, 3)
  } finally {
    dispose()
  }
})

// ── ② 冷会话：走 sessionQuery.observeSession ──────────────────────────

test('冷会话（sessions.get 未命中）走 observeSession，并按 [Symbol.dispose] 释放租约', async () => {
  let disposed = 0
  /** 抓住这次返回的租约，事后断言它真的被释放了。 */
  let lease
  const { call, dispose } = boot({
    services: {
      // 没有任何活会话
      sessions: { get: () => undefined },
      sessionProjections: { snapshot: () => ({ asOfSeq: 0, values: {} }) },
      sessionQuery: {
        observeSession: async (id, opts) => {
          assert.equal(id, 'sess-cold')
          assert.equal(opts?.projectionMode, 'all', '必须要求投影，否则读不到 tokenUsage')
          lease = createLease({
            projections: {
              values: {
                tokenUsage: {
                  uncachedInputTokens: 42, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0,
                },
                contextPressure: { contextWindow: 1000000, pressureTokens: 500 },
              },
            },
            onDispose: () => { disposed += 1 },
          })
          return lease
        },
      },
    },
  })
  try {
    const body = await call('/dsh-token-usage/today', '?session=sess-cold')
    assert.equal(body.session.projected.tokenUsage.uncachedInputTokens, 42)
    assert.equal(disposed, 1, 'SessionObservation 是租约，必须释放')
    // ⚠️ 关键断言：释放必须走 `[Symbol.dispose]`。
    //
    // 这条曾经不存在，于是实现里的 `observation?.dispose?.()`（真实租约上
    // **没有**这个方法）是静默空操作——refs 不递减、条目永不被淘汰，而桌宠每秒
    // 轮询一次。测试当时是绿的，因为 mock 自己造了 `.dispose()`。
    assert.equal(lease.__isDisposed?.(), true, '租约必须通过 [Symbol.dispose] 释放')
    assert.equal(typeof lease.dispose, 'undefined',
      '真实租约没有 .dispose()；mock 也不该提供，否则会掩盖空操作 bug')
  } finally {
    dispose()
  }
})

test('冷读会用同一份 events 播种逐轮状态（重启后「本轮/上一轮」立刻有值）', async () => {
  const { call, dispose } = boot({
    services: {
      sessions: { get: () => undefined },
      sessionProjections: { snapshot: () => ({ asOfSeq: 0, values: {} }) },
      sessionQuery: {
        observeSession: async () => createLease({
          projections: {
            values: {
              tokenUsage: {
                uncachedInputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0,
              },
            },
          },
          // 一份「两轮」的最小日志：第 1 轮 100、第 2 轮 230。
          events: [
            { type: 'turn/start', seq: 0, data: { turn: 1 } },
            message({ turn: 1, step: 1, input: 100, output: 0 }),
            { type: 'turn/start', seq: 2, data: { turn: 2 } },
            message({ turn: 2, step: 1, input: 200, output: 30 }),
          ],
        }),
      },
    },
  })
  try {
    const body = await call('/dsh-token-usage/today', '?session=sess-seeded')
    // `live` 现在应当已经由 events 播种出来（而不是 null）。
    assert.notEqual(body.session.live, null, '冷读必须播种 live，否则重启后本轮永远空着')
    assert.equal(body.session.live.sessionTokens, 330, '播种后会话累计 = 100 + 230')
    assert.equal(body.session.live.turnTokens, 230, '本轮 = 第 2 轮')
    assert.equal(body.session.live.previousTurnTokens, 100, '上一轮 = 第 1 轮')
  } finally {
    dispose()
  }
})

test('observeSession 抛错时降级为 reason，而不是 500', async () => {
  const { call, dispose } = boot({
    services: {
      sessions: { get: () => undefined },
      sessionProjections: { snapshot: () => ({ asOfSeq: 0, values: {} }) },
      sessionQuery: {
        observeSession: async () => { throw new Error('SESSION_QUERY_SESSION_NOT_FOUND') },
      },
    },
  })
  try {
    const body = await call('/dsh-token-usage/today', '?session=ghost')
    assert.equal(body.ok, true, '端点本身必须仍然成功')
    assert.equal(body.session.projected, null)
    assert.match(body.session.projectedUnavailable, /query-failed/)
  } finally {
    dispose()
  }
})

// ── 逐轮：我们自己的增量折叠（harness 做不到的部分）────────────────────

test('session/event 喂进来后，live 给出本会话与本轮读数', async () => {
  const session = liveSession('sess-live-2')
  const { call, emit, dispose } = boot({
    services: { sessions: { get: () => undefined } },
  })
  try {
    emit(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    emit(session, message({ turn: 1, step: 1, input: 100, output: 10 }))
    emit(session, message({ turn: 1, step: 2, input: 200, output: 20 }))

    const body = await call('/dsh-token-usage/today', '?session=sess-live-2')
    assert.notEqual(body.session.live, null, 'live 必须有数据')
    assert.equal(body.session.live.sessionTokens, 330, '100+10+200+20')
    assert.equal(body.session.live.turnTokens, 330, '同一轮内两步骤')
    assert.equal(body.session.live.turn, 1)
  } finally {
    dispose()
  }
})

test('换轮后 live 的 turnTokens 归零、previousTurnTokens 保留上一轮', async () => {
  const session = liveSession('sess-live-3')
  const { call, emit, dispose } = boot({ services: { sessions: { get: () => undefined } } })
  try {
    emit(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
    emit(session, message({ turn: 1, step: 1, input: 100, output: 0 }))
    emit(session, { type: 'turn/start', seq: 2, data: { turn: 2 } })
    emit(session, message({ turn: 2, step: 1, input: 5, output: 5 }))

    const body = await call('/dsh-token-usage/today', '?session=sess-live-3')
    assert.equal(body.session.live.turnTokens, 10, '本轮只有第 2 轮')
    assert.equal(body.session.live.previousTurnTokens, 100, '上一轮定格')
    assert.equal(body.session.live.sessionTokens, 110, '会话累计含两轮')
  } finally {
    dispose()
  }
})

test('live 与 projected 各自独立：投影缺失也不影响逐轮读数', async () => {
  const session = liveSession('sess-live-4')
  const { call, emit, dispose } = boot({ services: { sessions: { get: () => undefined } } })
  try {
    emit(session, message({ turn: 1, step: 1, input: 50, output: 50 }))
    const body = await call('/dsh-token-usage/today', '?session=sess-live-4')
    assert.equal(body.session.live.sessionTokens, 100, '逐轮折叠不依赖宿主投影')
    assert.equal(body.session.projected, null, '宿主投影确实不可用')
  } finally {
    dispose()
  }
})

test('不同会话的逐轮状态互不串台', async () => {
  const a = liveSession('sess-a')
  const b = liveSession('sess-b')
  const { call, emit, dispose } = boot({ services: { sessions: { get: () => undefined } } })
  try {
    emit(a, message({ turn: 1, step: 1, input: 100, output: 0 }))
    emit(b, message({ turn: 1, step: 1, input: 7, output: 0 }))

    const bodyA = await call('/dsh-token-usage/today', '?session=sess-a')
    const bodyB = await call('/dsh-token-usage/today', '?session=sess-b')
    assert.equal(bodyA.session.live.sessionTokens, 100)
    assert.equal(bodyB.session.live.sessionTokens, 7)
  } finally {
    dispose()
  }
})
