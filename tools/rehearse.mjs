/**
 * 最终演练：用**真实 DSH home 路径**跑一遍完整的「回填 → 落盘 → 查询」，
 * 验证 host 半在真实环境下的行为与设置页将要读到的数字。
 *
 * ⚠️ 写入真实 `$DSH_HOME/token-usage/daily.json`——这正是插件激活后要做的事。
 * 若插件随后激活，它会读这个文件并**只补充**水位线之后的新事件（幂等），
 * 所以预先生成不会导致重复计数。
 *
 * 用法: node tools/rehearse.mjs [sessionsRoot]
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../lib/store.js'
import { backfill } from '../lib/collect.js'
import { aggregateRange, grandTotals, localDayKey, shiftDayKey } from '../lib/fold.js'
import { makePersistence } from './session-logs.mjs'

const sessionsRoot = process.argv[2]
  ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')
const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')

const logger = { info: (m) => console.log('  ' + m), warn: (m) => console.log('  [warn] ' + m) }

console.log(`DSH home     : ${home}`)
console.log(`会话根目录   : ${sessionsRoot}`)

const persistence = await makePersistence(sessionsRoot)
const store = openStore({ home, keepDays: 400, logger })

console.log('\n=== 回填 ===')
const summary = await backfill({ persistence, store, logger })
store.flush()
console.log(`  会话 ${summary.sessions}（失败 ${summary.failed}）| 新入账 ${summary.entries} 笔`
  + ` | 扫描 ${summary.assistantMessages} | 带用量 ${summary.withUsage}`)

console.log('\n=== 存储位置 ===')
console.log(`  ${store.describe().path}`)

const all = grandTotals(store.days)
console.log('\n=== 全量 ===')
console.log(`  调用 ${all.requests} | 合计 ${all.totalTokens} tokens`)

const today = localDayKey(Date.now())
const todayTotals = aggregateRange(store.days, { from: today, to: today, groupBy: 'day' }).totals
console.log(`\n=== 今日（${today}）===`)
console.log(`  调用 ${todayTotals.requests} | 合计 ${todayTotals.totalTokens} tokens`)

console.log('\n=== 近 7 天 ===')
const week = aggregateRange(store.days, {
  from: shiftDayKey(today, -6), to: today, groupBy: 'day',
})
for (const row of week.rows) console.log(`  ${row.key}  ${row.totals.totalTokens}`)
console.log(`  小计 ${week.totals.totalTokens} tokens / ${week.totals.requests} 次`)

console.log('\n=== 逐日（全部）===')
for (const row of aggregateRange(store.days, { groupBy: 'day' }).rows) {
  console.log(`  ${row.key}  ${String(row.totals.totalTokens).padStart(12)}  (${row.totals.requests} 次)`)
}

console.log('\n=== 按渠道 ===')
for (const row of aggregateRange(store.days, { groupBy: 'provider' }).rows) {
  console.log(`  ${String(row.label).padEnd(20)} ${String(row.totals.totalTokens).padStart(12)}  (${row.totals.requests} 次)`)
}

console.log('\n=== 幂等复查（再跑一次回填，应新增 0 笔）===')
const again = await backfill({ persistence, store, logger })
store.flush()
console.log(`  新增 ${again.entries} 笔（应为 0）| 合计 ${grandTotals(store.days).totalTokens}（应与上面一致）`)
console.log(again.entries === 0 ? '\n结果: 幂等 ✓' : '\n结果: 非幂等 ✗')
process.exitCode = again.entries === 0 ? 0 : 1
