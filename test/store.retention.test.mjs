/**
 * **保留期必须同时作用于内存与盘**。
 *
 * 这个文件锁的是一条曾经只做了一半的纪律：`flush()` 只对写出的文档做
 * `pruneDays`，内存表 `this.days` 永不过期。后果是「累计」（读内存）比盘上大，
 * 重启后数字下跌——延迟到保留期到期那天才发作，最难查。
 *
 * 反过来也有个坑：如果先 `cloneDays` 建基线再剪内存，被剪掉的天会在下次 flush
 * 被当成「全新增量」重新写回盘，保留期等于没做。所以这里两条都断言。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore, parseStoreDocument } from '../lib/store.js'
import { grandTotals, localDayKey, shiftDayKey } from '../lib/fold.js'
import { readFileSync } from 'node:fs'

const silent = { info: () => {}, warn: () => {} }

/** 造一条可入账的记录（默认 150 token）。 */
function entry(dayOffset, seq) {
  const base = new Date()
  base.setDate(base.getDate() + dayOffset)
  base.setHours(12, 0, 0, 0)
  return {
    sessionId: 'retention-sess',
    seq,
    time: base.getTime(),
    provider: 'p',
    model: 'm',
    workspace: 'F:/ws',
    scope: 'main',
    kind: 'chat',
    usage: { inputTokens: 100, outputTokens: 50 },
  }
}

function withStore(keepDays, fn) {
  const home = mkdtempSync(join(tmpdir(), 'tu-retention-'))
  try {
    return fn(home, openStore({ home, keepDays, logger: silent }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('超出保留期的日键：内存表与盘同时淘汰', () => {
  withStore(3, (home, store) => {
    store.fold(entry(0, 1))   // 今天
    store.fold(entry(-1, 2))  // 昨天
    store.fold(entry(-2, 3))  // 前天
    store.fold(entry(-10, 4)) // 保留期外
    store.cancelPending()
    store.flush()

    const today = localDayKey(Date.now())
    assert.equal(store.days.has(today), true)
    assert.equal(store.days.has(shiftDayKey(today, -10)), false, '内存表也要淘汰')
    assert.equal(store.days.size, 3, '内存表只剩保留窗口内的 3 天')

    const disk = parseStoreDocument(readFileSync(join(home, 'token-usage', 'daily.json'), 'utf-8'))
    assert.equal(disk.days.size, 3)
    assert.equal(disk.days.has(shiftDayKey(today, -10)), false)
  })
})

test('淘汰后再次落盘不会把旧日键复活（基线顺序不能反）', () => {
  withStore(3, (home, store) => {
    store.fold(entry(-10, 1))
    store.cancelPending()
    store.flush()
    const oldDay = shiftDayKey(localDayKey(Date.now()), -10)
    assert.equal(store.days.has(oldDay), false)

    // 再入账一笔新数据并落盘：旧日键绝不能被「增量」重写回盘。
    store.fold(entry(0, 2))
    store.cancelPending()
    store.flush()

    const disk = parseStoreDocument(readFileSync(join(home, 'token-usage', 'daily.json'), 'utf-8'))
    assert.equal(disk.days.has(oldDay), false, '被淘汰的天不能复活')
    assert.equal(disk.days.size, 1)
  })
})

test('内存「累计」与盘上内容严格一致', () => {
  withStore(3, (home, store) => {
    for (let i = 0; i < 6; i += 1) store.fold(entry(-i, i + 1))
    store.cancelPending()
    store.flush()

    const disk = parseStoreDocument(readFileSync(join(home, 'token-usage', 'daily.json'), 'utf-8'))
    const fromDisk = grandTotals(disk.days).totalTokens
    const fromMemory = grandTotals(store.days).totalTokens
    assert.equal(fromMemory, fromDisk, '两处读数必须相等，否则重启后会「凭空下跌」')
    assert.equal(fromMemory, 3 * 150, '3 天 × 150 token')
  })
})

test('keepDays <= 0 表示不淘汰，内存表原样保留', () => {
  withStore(0, (home, store) => {
    store.fold(entry(-400, 1))
    store.cancelPending()
    store.flush()
    assert.equal(store.days.size, 1)
    assert.equal(existsSync(join(home, 'token-usage', 'daily.json')), true)
  })
})
