/**
 * **宿主接口适配层**的测试。
 *
 * ## 为什么这个文件必须存在
 *
 * 本插件对 `sessionPersistence` 的调用以前绑死在一代接口上：
 * `list()` 返回 `{header, revision}[]`、`open(id,'read')` 返回句柄、句柄带
 * `inheritedEventCount`。同机的另一份 DSH（0.1.0-rc.6）已经不是这样了：
 *
 * - `list()` 返回 `SessionHeader[]`（没有 `.header` 包裹）
 * - 没有 `open()`，只有 `load(id)` / `inspect(id)` / `readFrom(id, seq)`
 * - 没有 `inheritedEventCount`，只有 `header.seedLength` / `session.firstLiveSeq`
 *   / `session/end-seed` 事件
 *
 * 这三处不匹配**全部静默**：`list()` 形状一变，回填直接返回
 * `sessions: 0`，一条日志都不留。所以这里用**两套按真实形状写的夹具**跑同一批
 * 事件，断言两边读数完全一致；再加一条反向断言，保证「接口认不出来」时必须
 * 报 `degraded`，而不是假装成功。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { backfill } from '../lib/collect.js'
import { openStore } from '../lib/store.js'
import { grandTotals } from '../lib/fold.js'
import { probePersistence, listSessions, readSession, seedPrefixOf } from '../lib/adapter.js'

const silent = { info: () => {}, warn: () => {} }

/** 一条带用量的 assistant/message 事件。 */
function assistantEvent(seq, time) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 20 },
      message: { source: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash' } },
    },
  }
}

/** 4 条自有事件：seq 0..3，每条 1170 token，合计 4680。 */
function events(seed = 0) {
  const t = new Date(2026, 9, 12, 12, 0).getTime()
  return Array.from({ length: 4 }, (_, i) => assistantEvent(seed + i, t + i * 1000))
}

const HEADER = { id: 'sess-a', cwd: 'F:/ws-x', version: 4, createdAt: 1 }

/**
 * 旧一代接口：`list()` → `{header, revision}[]`，`open()` → 句柄带 inheritedEventCount。
 * 本机 desktop 那一版就是这个形状（由 `daily.json` 里 23 天历史反推）。
 */
function legacyPersistence(list, { inherited = 0 } = {}) {
  return {
    async list() {
      return [{ header: HEADER, revision: 'rev-0' }]
    },
    async open() {
      return {
        header: HEADER,
        inheritedEventCount: inherited,
        async read() { return { events: list } },
        async close() {},
      }
    },
  }
}

/**
 * 新一代接口（0.1.0-rc.6 起）：`listSnapshots()` → `{header, revision}[]`，
 * `load(id)` → `{meta, events}`，**没有** `open`、**没有** inheritedEventCount。
 */
function modernPersistence(list, { seedLength = undefined } = {}) {
  const header = seedLength === undefined ? HEADER : { ...HEADER, seedLength }
  return {
    async listSnapshots() { return [{ header, revision: 'rev-0' }] },
    async list() { return [header] }, // 真实形状：返回 header[]，不是 snapshot[]
    async load() { return { meta: header, events: list } },
    async inspect() { return { meta: header } },
  }
}

/** 只有 list()、且返回 header[]（没有 listSnapshots）——最容易踩的退化组合。 */
function bareListPersistence(list) {
  return {
    async list() { return [HEADER] },
    async load() { return { meta: HEADER, events: list } },
  }
}

/** 跑一遍回填，返回摘要 + 读数。 */
async function runBackfill(persistence) {
  const home = mkdtempSync(join(tmpdir(), 'tu-adapter-'))
  const store = openStore({ home, keepDays: 400, logger: silent })
  const summary = await backfill({ persistence, store, logger: silent })
  const totals = grandTotals(store.days)
  rmSync(home, { recursive: true, force: true })
  return { summary, totals }
}

// ── ① 两代接口必须给出同一读数 ─────────────────────────────────────────

test('旧接口与新接口回填出完全相同的读数', async () => {
  const old = await runBackfill(legacyPersistence(events()))
  const modern = await runBackfill(modernPersistence(events()))

  assert.equal(old.summary.entries, 4, '旧接口应入账 4 笔')
  assert.equal(modern.summary.entries, 4, '新接口应入账 4 笔')
  assert.equal(old.summary.sessions, 1)
  assert.equal(modern.summary.sessions, 1, '新接口必须能识别到会话，不能是 0')
  assert.equal(modern.totals.totalTokens, old.totals.totalTokens, '两代接口总 token 必须一致')
  assert.equal(modern.totals.requests, old.totals.requests)
  assert.equal(modern.summary.degraded, undefined, '正常降级路径不应标记 degraded')
})

test('只有 list() 且返回 header[] 时也能回填（不能静默归零）', async () => {
  const r = await runBackfill(bareListPersistence(events()))
  assert.equal(r.summary.sessions, 1, 'header[] 形状也必须被识别')
  assert.equal(r.summary.entries, 4)
  assert.equal(r.totals.totalTokens, 4 * 1170)
})

// ── ② 接口认不出来时必须报 degraded，不能假装成功 ─────────────────────

test('persistence 完全没有列表/读取能力 → degraded 且不抛错', async () => {
  const r = await runBackfill({})
  assert.equal(r.summary.sessions, 0)
  assert.equal(r.summary.entries, 0)
  assert.equal(typeof r.summary.degraded, 'string', '必须给出 degraded 原因')
  assert.match(r.summary.degraded, /list|listSnapshots/i)
})

test('有列表能力但没有读取能力 → 每个会话都记 failed 并标 degraded', async () => {
  const r = await runBackfill({ async listSnapshots() { return [{ header: HEADER }] } })
  assert.equal(r.summary.failed, 1, '读不到内容应计入 failed')
  assert.equal(typeof r.summary.degraded, 'string')
})

// ── ③ 继承前缀（fork）必须能从两种形状里都取到 ─────────────────────────

test('seedPrefixOf：header.seedLength 优先', () => {
  assert.equal(seedPrefixOf({ header: { seedLength: 2 }, handle: { inheritedEventCount: 9 } }), 2)
})

test('seedPrefixOf：退化到 handle.inheritedEventCount（旧接口）', () => {
  assert.equal(seedPrefixOf({ header: {}, handle: { inheritedEventCount: 3 } }), 3)
})

test('seedPrefixOf：退化到 session/end-seed 事件（新接口的持久化形态）', () => {
  const evs = [{ type: 'session/end-seed', seq: 0 }, assistantEvent(1, 1), assistantEvent(2, 2)]
  assert.equal(seedPrefixOf({ header: {}, events: evs }), 1, 'end-seed 在 seq 0 ⇒ 自有事件从 1 开始')
})

test('seedPrefixOf：最后一个 end-seed 才算（seed 后再次 seed）', () => {
  const evs = [
    { type: 'session/end-seed', seq: 0 },
    assistantEvent(1, 1),
    { type: 'session/end-seed', seq: 2 },
    assistantEvent(3, 3),
  ]
  assert.equal(seedPrefixOf({ header: {}, events: evs }), 3)
})

test('seedPrefixOf：都没有 ⇒ 0', () => {
  assert.equal(seedPrefixOf({ header: {}, events: [assistantEvent(0, 1)] }), 0)
})

test('fork 前缀不会被重复计入（新接口 header.seedLength）', async () => {
  // 前 2 条是继承来的父会话事件，只有 seq>=2 的 2 条是自有
  const r = await runBackfill(modernPersistence(events(), { seedLength: 2 }))
  assert.equal(r.summary.entries, 2, '继承前缀不计入')
  assert.equal(r.totals.totalTokens, 2 * 1170)
})

test('fork 前缀不会被重复计入（旧接口 inheritedEventCount）', async () => {
  const r = await runBackfill(legacyPersistence(events(), { inherited: 2 }))
  assert.equal(r.summary.entries, 2)
  assert.equal(r.totals.totalTokens, 2 * 1170)
})

// ── ④ 探测结果用于诊断 ────────────────────────────────────────────────

test('probePersistence 报告实际走的是哪条路径', () => {
  assert.equal(probePersistence(legacyPersistence([])).listKind, 'list')
  assert.equal(probePersistence(legacyPersistence([])).readKind, 'open')
  assert.equal(probePersistence(modernPersistence([])).listKind, 'listSnapshots')
  assert.equal(probePersistence(modernPersistence([])).readKind, 'load')
  assert.equal(probePersistence({}).listKind, 'none')
})

test('listSessions / readSession 对形状做归一化', async () => {
  const listed = await listSessions(modernPersistence(events()))
  assert.equal(listed.length, 1)
  assert.equal(listed[0].header.id, 'sess-a', '必须把 header 剥出来')

  const read = await readSession(modernPersistence(events()), listed[0].header)
  assert.equal(read.events.length, 4)
  assert.equal(read.header.id, 'sess-a')
  assert.equal(read.seedPrefix, 0)
  assert.equal(typeof read.close, 'function')
})
