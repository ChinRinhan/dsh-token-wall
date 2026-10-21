/**
 * 分析「10M 一个方块」的可行性：用真实会话日志算出
 * 1) 每轮对话花多少 token；2) 活跃时段每分钟花多少；3) 填满一个方块要多久。
 *
 * 只读，不写任何东西。
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { makePersistence } from '../tools/session-logs.mjs'

const root = process.argv[2]
  ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')

const persistence = await makePersistence(root)

/** 收集每个 turn 的 token 合计 + 时间范围。 */
const turns = []
const allTimes = []
let grand = 0

for (const snap of await persistence.list()) {
  const handle = await persistence.open(snap.header.id, 'read')
  const { events } = await handle.read()
  const inherited = handle.inheritedEventCount ?? 0
  /** turn -> { tokens, start, end } */
  const byTurn = new Map()
  let current = null
  for (const ev of events) {
    if (ev.type === 'turn/start') {
      current = ev.data?.turn
      if (current !== undefined) byTurn.set(current, { tokens: 0, start: ev.time, end: ev.time })
      continue
    }
    if (ev.type === 'assistant/message' && ev.data?.usage && (ev.seq ?? 0) >= inherited) {
      const u = ev.data.usage
      const tok = (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0)
        + (Number(u.cacheWriteTokens) || 0) + (Number(u.outputTokens) || 0)
      grand += tok
      allTimes.push(ev.time)
      if (current !== undefined && byTurn.has(current)) {
        const t = byTurn.get(current)
        t.tokens += tok
        t.end = ev.time
      }
    }
  }
  for (const [, t] of byTurn) if (t.tokens > 0) turns.push(t)
  await handle.close()
}

const sum = (a) => a.reduce((x, y) => x + y, 0)
const pct = (a, p) => {
  const s = a.slice().sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

const tokenList = turns.map((t) => t.tokens)
const durList = turns.map((t) => (t.end - t.start) / 1000).filter((d) => d > 0)

console.log(`总消耗: ${grand.toLocaleString()} tokens`)
console.log(`turn 数: ${turns.length}`)
console.log('')
console.log('=== 每轮对话的 token 消耗 ===')
console.log(`  中位数 : ${pct(tokenList, 0.5).toLocaleString()}`)
console.log(`  平均   : ${Math.round(sum(tokenList) / tokenList.length).toLocaleString()}`)
console.log(`  p90    : ${pct(tokenList, 0.9).toLocaleString()}`)
console.log(`  最大   : ${Math.max(...tokenList).toLocaleString()}`)
console.log('')
console.log('=== 每轮耗时（秒）===')
console.log(`  中位数 : ${pct(durList, 0.5).toFixed(0)}s`)
console.log(`  平均   : ${(sum(durList) / durList.length).toFixed(0)}s`)
console.log(`  最大   : ${Math.max(...durList).toFixed(0)}s`)

// 活跃时段速率：把有事件的时间按分钟分桶，只统计「有消耗」的分钟。
const perMinute = new Map()
for (const t of allTimes) {
  const m = Math.floor(t / 60000)
  perMinute.set(m, (perMinute.get(m) ?? 0) + 1)
}
// 按分钟聚合 token 需要重扫；这里用「每分钟事件数 × 平均每次事件 token」近似。
const avgPerEvent = grand / allTimes.length
const activeMinutes = perMinute.size
const spanMinutes = (Math.max(...allTimes) - Math.min(...allTimes)) / 60000

console.log('')
console.log('=== 时间分布 ===')
console.log(`  有消耗的分钟数 : ${activeMinutes.toLocaleString()}`)
console.log(`  跨越的总时长   : ${(spanMinutes / 60).toFixed(1)} 小时`)
console.log(`  平均每次调用   : ${Math.round(avgPerEvent).toLocaleString()} tokens`)
console.log(`  活跃分钟占比   : ${(activeMinutes / spanMinutes * 100).toFixed(1)}%`)

console.log('')
console.log('=== 填满一个 10M 方块需要多久 ===')
const scenarios = [
  ['单轮中位消耗', pct(tokenList, 0.5)],
  ['单轮平均消耗', sum(tokenList) / tokenList.length],
  ['单轮 p90 消耗', pct(tokenList, 0.9)],
]
for (const [label, perTurn] of scenarios) {
  console.log(`  ${label} (${Math.round(perTurn).toLocaleString()} tok/轮) → ${(10e6 / perTurn).toFixed(1)} 轮`)
}
const perActiveMin = grand / activeMinutes
console.log(`  按活跃分钟速率 (${Math.round(perActiveMin).toLocaleString()} tok/min) → ${(10e6 / perActiveMin).toFixed(1)} 分钟`)

console.log('')
console.log('=== 方块总数 ===')
for (const unit of [1e6, 5e6, 10e6, 25e6, 50e6]) {
  console.log(`  ${(unit / 1e6).toString().padStart(4)}M/块 → 当前 ${Math.floor(grand / unit).toString().padStart(5)} 块 (余 ${((grand % unit) / unit * 100).toFixed(1)}%)`)
}
