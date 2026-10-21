/**
 * 用**真实数据**预览方块墙（主面板 + 桌宠），作为交付前的目视确认。
 *
 * 用法: node tools/preview-blocks.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

const { openStore } = await import('../lib/store.js')
const { aggregateRange, grandTotals, localDayKey } = await import('../lib/fold.js')
const { blockWall } = await import('../lib/blocks.js')

const store = openStore({ home, keepDays: 400 })
const day = localDayKey(Date.now())
const today = aggregateRange(store.days, { from: day, to: day, groupBy: 'day' }).totals
const allTime = grandTotals(store.days)

const grouped = (n) => String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 用字符画出一屏方块墙，直观确认填充形状。 */
function drawWall(wall, cols = 10) {
  const lines = []
  for (let r = 0; r < Math.ceil(wall.cells.length / cols); r += 1) {
    let line = '  '
    for (let c = 0; c < cols; c += 1) {
      const cell = wall.cells[r * cols + c]
      if (cell === undefined) { line += '   '; continue }
      if (cell.state === 'filled') line += '██ '
      else if (cell.state === 'partial') line += '▓░ '
      else line += '░░ '
    }
    lines.push(line.trimEnd())
  }
  return lines.join('\n')
}

for (const [label, total] of [['累计', allTime.totalTokens], ['今日', today.totalTokens]]) {
  const w = blockWall(total)
  console.log(`════ ${label} ════`)
  console.log(`  总消耗   ${grouped(total)} tokens`)
  console.log(`  已获得   ${w.filled} 块  ·  第 ${w.pageIndex + 1} 页`)
  console.log(`  下一块   ${grouped(w.remainder)} / ${grouped(w.unit)}  (${(w.progress * 100).toFixed(1)}%)`)
  console.log('')
  console.log(drawWall(w))
  console.log('')
}

console.log('════ 桌宠窗口（最近 30 格）════')
for (const [label, total] of [['累计', allTime.totalTokens], ['今日', today.totalTokens]]) {
  const w = blockWall(total)
  const SPAN = 30
  const start = Math.max(0, w.filled - SPAN + 1)
  const cells = []
  for (let i = 0; i < SPAN; i += 1) {
    const index = start + i
    let state = 'empty'
    if (index < w.filled) state = 'filled'
    else if (index === w.filled) state = 'partial'
    cells.push(state)
  }
  console.log(`\n  ${label}: ${grouped(total)}  →  ${w.filled} 块`)
  for (let r = 0; r < 3; r += 1) {
    let line = '    '
    for (let c = 0; c < 10; c += 1) {
      const s = cells[r * 10 + c]
      line += s === 'filled' ? '██ ' : s === 'partial' ? '▓░ ' : '░░ '
    }
    console.log(line.trimEnd())
  }
}

console.log('\n════ 侧栏图标（3×3，右下角空心）════')
const icon = []
for (let r = 0; r < 3; r += 1) {
  let line = '  '
  for (let c = 0; c < 3; c += 1) line += (r === 2 && c === 2) ? '□ ' : '■ '
  icon.push(line.trimEnd())
}
console.log(icon.join('\n'))
