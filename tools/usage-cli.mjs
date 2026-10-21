/**
 * 命令行：直接从会话日志**离线**汇总 token 用量。
 *
 * ## 什么时候用它
 *
 * 插件自身已经会回填历史，所以正常使用不需要这个脚本。它有三个真实用途：
 *
 * 1. **对账**：把插件的数字与一个完全独立的实现对比，确认口径没漂。
 * 2. **灾难恢复**：`$DSH_HOME/token-usage/daily.json` 被误删或损坏后，
 *    用日志重建一份权威读数（日志是唯一真源）。
 * 3. **换机/换 profile**：在没有运行 DSH 的环境里先看一眼历史消耗。
 *
 * ## 用法
 *
 * ```bash
 * node tools/usage-cli.mjs --sessions "$DSH_HOME/sessions"
 * node tools/usage-cli.mjs --sessions ./sessions --group-by provider --from 2026-10-01 --to 2026-10-12
 * node tools/usage-cli.mjs --sessions ./sessions --json > report.json
 * ```
 *
 * 选项：
 * - `--sessions <dir>`  会话根目录（默认 `$DSH_HOME/sessions`）
 * - `--group-by <k>`    `day` | `week` | `month` | `provider` | `model` | `kind`（默认 `day`）
 * - `--from/--to <day>` 闭区间日键（`YYYY-MM-DD`，本机时区）
 * - `--no-sub`          排除子代理 / 团队 / workflow 子会话
 * - `--no-aux`          排除压缩等辅助调用
 * - `--json`            输出机器可读 JSON 而不是表格
 *
 * ⚠️ 本脚本复用插件的 `lib/fold.js`（同一套口径）。要与它**交叉校验**，请用
 * `test/cross-validate.mjs`——那份实现是独立写的，才构成真正的对账。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { aggregateRange, addUsage, bucketKeyOf, emptyTotals, grandTotals, localDayKey } from '../lib/fold.js'
import { collectSessionEntries } from '../lib/collect.js'
import { makePersistence } from './session-logs.mjs'

const { values } = parseArgs({
  options: {
    sessions: { type: 'string' },
    'group-by': { type: 'string', default: 'day' },
    from: { type: 'string' },
    to: { type: 'string' },
    'no-sub': { type: 'boolean', default: false },
    'no-aux': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
})

if (values.help) {
  console.log('用法: node tools/usage-cli.mjs [--sessions <dir>] [--group-by day|week|month|provider|model|kind]')
  console.log('                              [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--no-sub] [--no-aux] [--json]')
  process.exit(0)
}

const sessionsRoot = values.sessions
  ?? join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'sessions')

/** 千分位。 */
const grouped = (n) => String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

const persistence = await makePersistence(sessionsRoot)

// 把所有会话折叠进日聚合表（与插件回填走同一套 fold）。
const days = new Map()
let sessions = 0
let events = 0
let withUsage = 0
for (const snap of await persistence.list()) {
  const handle = await persistence.open(snap.header.id, 'read')
  const { events: list } = await handle.read()
  const collected = collectSessionEntries({
    sessionId: snap.header.id,
    header: handle.header ?? snap.header,
    events: list,
    inheritedEventCount: handle.inheritedEventCount ?? 0,
  })
  for (const entry of collected.entries) {
    const day = localDayKey(entry.time)
    let buckets = days.get(day)
    if (buckets === undefined) { buckets = new Map(); days.set(day, buckets) }
    const key = bucketKeyOf(entry)
    let totals = buckets.get(key)
    if (totals === undefined) { totals = emptyTotals(); buckets.set(key, totals) }
    addUsage(totals, entry.usage)
  }
  sessions += 1
  events += collected.seen
  withUsage += collected.withUsage
  await handle.close()
}

const { rows, totals } = aggregateRange(days, {
  groupBy: values['group-by'],
  from: values.from,
  to: values.to,
  includeSub: !values['no-sub'],
  includeAux: !values['no-aux'],
})

if (values.json) {
  console.log(JSON.stringify({
    sessionsRoot,
    generatedAt: Date.now(),
    today: localDayKey(Date.now()),
    sessions,
    events,
    withUsage,
    groupBy: values['group-by'],
    range: { from: values.from ?? null, to: values.to ?? null },
    rows,
    totals,
    allTime: grandTotals(days),
  }, null, 2))
} else {
  console.log(`会话根目录: ${sessionsRoot}`)
  console.log(`会话数: ${sessions} | 可入账事件: ${events} | 带用量: ${withUsage}`)
  console.log(`区间: ${values.from ?? '(全部)'} → ${values.to ?? '(全部)'} | 维度: ${values['group-by']}`)
  console.log('')
  const head = ['key', 'calls', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'TOTAL']
  const table = rows.map((r) => [
    r.label ?? r.key,
    grouped(r.totals.requests),
    grouped(r.totals.inputTokens),
    grouped(r.totals.cacheReadTokens),
    grouped(r.totals.cacheWriteTokens),
    grouped(r.totals.outputTokens),
    grouped(r.totals.reasoningTokens),
    grouped(r.totals.totalTokens),
  ])
  const totalRow = [
    '合计',
    grouped(totals.requests),
    grouped(totals.inputTokens),
    grouped(totals.cacheReadTokens),
    grouped(totals.cacheWriteTokens),
    grouped(totals.outputTokens),
    grouped(totals.reasoningTokens),
    grouped(totals.totalTokens),
  ]
  const all = [head, ...table, totalRow]
  const widths = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)))
  const fmt = (r) => r.map((c, i) => String(c).padStart(widths[i])).join('  ')
  console.log(fmt(head))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  for (const r of table) console.log(fmt(r))
  console.log(widths.map((w) => '-'.repeat(w)).join('  '))
  console.log(fmt(totalRow))
}
