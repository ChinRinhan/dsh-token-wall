/**
 * 方块墙换算的单测。
 *
 * 重点覆盖容易算错的边界：刚好整除、跨页、当前块归属、进度百分比、
 * 以及「异常输入不崩」。这些是 UI 里靠肉眼很难发现的错误。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { blockWall, unitLabel, DEFAULT_UNIT, DEFAULT_PAGE_SIZE } from '../lib/blocks.js'

const M = 1_000_000
/** 一个方块 = 10M。用 blocks(n) 表达「n 块」，避免把 M 误当成一块。 */
const UNIT = 10 * M
const blocks = (n) => n * UNIT

test('默认单位与页大小符合约定（10M / 100 格）', () => {
  assert.equal(DEFAULT_UNIT, UNIT)
  assert.equal(DEFAULT_PAGE_SIZE, 100)
})

test('650.7M → 65 块已填 + 第 66 块 7%', () => {
  const w = blockWall(650_704_221)
  assert.equal(w.filled, 65)
  assert.equal(w.remainder, 704_221)
  assert.ok(Math.abs(w.progress - 0.0704221) < 1e-6)
  assert.equal(w.cells.length, 100)
  assert.equal(w.cells[64].state, 'filled')
  assert.equal(w.cells[65].state, 'partial')
  assert.ok(Math.abs(w.cells[65].fill - 0.0704221) < 1e-6)
  assert.equal(w.cells[66].state, 'empty')
})

test('刚好整除：filled 精确、进度为 0、当前块是下一块', () => {
  const w = blockWall(blocks(650))
  assert.equal(w.filled, 650)
  assert.equal(w.remainder, 0)
  assert.equal(w.progress, 0)
  // 刚好填满 650 块后，「正在填」的是第 651 块（索引 650），进度 0。
  // 该块落在第 7 页（650 / 100 = 6.5 → pageIndex 6，即第 7 页）。
  assert.equal(w.pageIndex, 6)
  assert.equal(w.cells[0].index, 600)
  assert.equal(w.cells[49].index, 649)
  assert.equal(w.cells[49].state, 'filled')
  assert.equal(w.cells[50].index, 650)
  assert.equal(w.cells[50].state, 'partial')
  assert.equal(w.cells[50].fill, 0)
})

test('分页：当前块决定页码，页内序号连续', () => {
  // 65 块 → 第 1 页（0 基 pageIndex 0），页内 0..99
  const p1 = blockWall(blocks(65))
  assert.equal(p1.pageIndex, 0)
  assert.equal(p1.pageStart, 0)
  assert.deepEqual(p1.cells.map((c) => c.index), Array.from({ length: 100 }, (_, i) => i))

  // 100 块 → 第 2 页（当前块是索引 100）
  const p2 = blockWall(blocks(100))
  assert.equal(p2.pageIndex, 1)
  assert.equal(p2.pageStart, 100)
  assert.equal(p2.cells[0].index, 100)
  assert.equal(p2.cells[0].state, 'partial')
  assert.equal(p2.cells[0].fill, 0)

  // 150 块 → 第 2 页，前 50 格已填
  const p3 = blockWall(blocks(150))
  assert.equal(p3.pageIndex, 1)
  assert.equal(p3.cells[0].index, 100)
  assert.equal(p3.cells[49].index, 149)
  assert.equal(p3.cells[49].state, 'filled')
  assert.equal(p3.cells[50].index, 150)
  assert.equal(p3.cells[50].state, 'partial')
})

test('每页恒定 100 格，不论总量多少', () => {
  for (const n of [0, 1, 99, 100, 101, 999, 1234]) {
    assert.equal(blockWall(blocks(n)).cells.length, 100, `total=${n}M`)
  }
})

test('0 与小额：第 1 块是当前块，进度按比例', () => {
  const zero = blockWall(0)
  assert.equal(zero.filled, 0)
  assert.equal(zero.progress, 0)
  assert.equal(zero.cells[0].state, 'partial')
  assert.equal(zero.cells[0].fill, 0)
  assert.equal(zero.cells[1].state, 'empty')

  // 半个方块：5M 是 10M 方块的一半。
  const half = blockWall(5 * M)
  assert.equal(half.filled, 0)
  assert.equal(half.cells[0].state, 'partial')
  assert.ok(Math.abs(half.cells[0].fill - 0.5) < 1e-9)
})

test('不足一块：进度正确、无已填块', () => {
  const w = blockWall(9_999_999)
  assert.equal(w.filled, 0)
  assert.ok(Math.abs(w.progress - 0.9999999) < 1e-9)
  assert.equal(w.cells[0].state, 'partial')
  assert.equal(w.cells.filter((c) => c.state === 'filled').length, 0)
})

test('已填格数 = filled，且只出现在当前页范围内', () => {
  const w = blockWall(blocks(234))
  const filledInPage = w.cells.filter((c) => c.state === 'filled').length
  // 第 3 页（200..299），234 已填 → 页内前 34 格填满
  assert.equal(w.pageIndex, 2)
  assert.equal(filledInPage, 34)
  assert.equal(w.cells[33].state, 'filled')
  assert.equal(w.cells[34].state, 'partial')
})

test('异常输入不崩：负数 / NaN / Infinity / undefined', () => {
  for (const bad of [-1, -1e12, NaN, Infinity, -Infinity, undefined, null, 'abc', {}]) {
    const w = blockWall(bad)
    assert.equal(w.total, 0, `input=${String(bad)}`)
    assert.equal(w.filled, 0)
    assert.equal(w.progress, 0)
    assert.equal(w.cells.length, 100)
    assert.equal(w.cells[0].state, 'partial')
    assert.ok(Number.isFinite(w.cells[0].fill))
  }
})

test('异常 unit / pageSize 回落到默认值', () => {
  for (const bad of [0, -1, NaN, undefined, null, 'x']) {
    const w = blockWall(25 * M, { unit: bad })
    assert.equal(w.unit, DEFAULT_UNIT, `unit=${String(bad)}`)
    // 默认单位 10M → 25M 是 2 块。
    assert.equal(w.filled, 2)
  }
  for (const bad of [0, -1, NaN, undefined, null, 'x']) {
    const w = blockWall(25 * M, { pageSize: bad })
    assert.equal(w.pageSize, DEFAULT_PAGE_SIZE, `pageSize=${String(bad)}`)
  }
})

test('自定义单位与页大小生效', () => {
  const w = blockWall(100 * M, { unit: 25 * M, pageSize: 8 })
  assert.equal(w.filled, 4)
  assert.equal(w.pageSize, 8)
  assert.equal(w.cells.length, 8)
  assert.equal(w.cells[3].state, 'filled')
  assert.equal(w.cells[4].state, 'partial')
  assert.equal(w.cells[4].fill, 0)
})

test('单调性：总量增加时 filled 只增不减', () => {
  let prev = 0
  for (let t = 0; t <= 300 * M; t += 7 * M) {
    const w = blockWall(t)
    assert.ok(w.filled >= prev, `t=${t} filled=${w.filled} prev=${prev}`)
    prev = w.filled
  }
})

test('进度百分比与 filled 的组合能还原总量（误差 < 1 token）', () => {
  for (const t of [0, 1, 9_999_999, 10_000_000, 10_000_001, 650_704_221, 999_999_999]) {
    const w = blockWall(t)
    const reconstructed = w.filled * w.unit + w.progress * w.unit
    assert.ok(Math.abs(reconstructed - t) < 1, `t=${t} reconstructed=${reconstructed}`)
  }
})

test('unitLabel 渲染常见单位', () => {
  assert.equal(unitLabel(10 * M), '10M')
  assert.equal(unitLabel(1_000_000_000), '1B')
  assert.equal(unitLabel(5 * M), '5M')
  assert.equal(unitLabel(1_500_000), '1.5M')
  assert.equal(unitLabel(1000), '1K')
  assert.equal(unitLabel(500), '500')
})
