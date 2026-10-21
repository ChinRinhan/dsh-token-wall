/**
 * 存储层端到端测试：真实会话日志 → 回填 → 落盘 → 重新打开 → 数字必须一致。
 *
 * 覆盖 `lib/store.js` 的三个关键性质：
 * 1. **落盘后重新打开，读数不变**（重启不丢历史）；
 * 2. **重复回填不重复计数**（水位线幂等）；
 * 3. **增量合并写不抹掉别人的数据**（模拟两个实例并存）。
 *
 * 用真实日志而不是合成数据，是为了让「解析 → 过滤 → 聚合 → 序列化 → 反序列化」
 * 整条链一起被验证；纯单测覆盖不到序列化这一跳。
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore, parseStoreDocument } from '../lib/store.js'
import { aggregateRange, grandTotals } from '../lib/fold.js'
import { backfill } from '../lib/collect.js'
import { makePersistence } from '../tools/session-logs.mjs'

const sessionsRoot = process.argv[2]
if (typeof sessionsRoot !== 'string' || sessionsRoot === '') {
  // 同 cross-validate：缺参数要友好退出，不能崩在 readdirSync(undefined)。
  console.error('用法: node test/store.e2e.mjs <sessions 目录>')
  console.error('')
  console.error('存储端到端测试：回填 → 落盘 → 重新打开 → 幂等 → 并发，全部用真实会话日志。')
  console.error('它需要本机已有的 DSH 会话日志，因此不进 npm test。')
  console.error('')
  console.error('  示例（Windows）: node test/store.e2e.mjs "%USERPROFILE%\\.dsh\\sessions"')
  console.error('  示例（macOS/Linux）: node test/store.e2e.mjs ~/.dsh/sessions')
  process.exit(1)
}
if (!existsSync(sessionsRoot)) {
  console.error(`目录不存在: ${sessionsRoot}`)
  console.error('提示：DSH 的会话日志通常在 $DSH_HOME/sessions（默认 ~/.dsh/sessions）。')
  process.exit(1)
}
const home = mkdtempSync(join(tmpdir(), 'tu-store-'))
const failures = []
const check = (label, x, y) => {
  const ok = x === y
  if (!ok) failures.push(`${label}: got ${x}, want ${y}`)
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: ${x}${ok ? '' : ` (want ${y})`}`)
}

const logger = { info: () => {}, warn: (m) => console.log('  [warn]', m) }
const persistence = await makePersistence(sessionsRoot)

/**
 * 独立复算期望值：直接遍历 persistence 暴露的事件，按「带 usage 的可入账类型」
 * 数一遍。不复用插件的聚合代码，因此它是一次真正的交叉校验。
 */
async function expectedCounts(p) {
  let entries = 0
  let totalTokens = 0
  for (const snap of await p.list()) {
    const handle = await p.open(snap.header.id, 'read')
    const { events } = await handle.read()
    const inherited = handle.inheritedEventCount ?? 0
    for (const ev of events) {
      if (ev.type !== 'assistant/message' && ev.type !== 'compaction/summary') continue
      if ((ev.seq ?? 0) < inherited) continue
      const u = ev.data?.usage
      if (u === null || typeof u !== 'object' || u === undefined) continue
      entries += 1
      totalTokens += (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0)
        + (Number(u.cacheWriteTokens) || 0) + (Number(u.outputTokens) || 0)
    }
    await handle.close()
  }
  return { entries, totalTokens }
}

// ── ① 首次回填并落盘 ──────────────────────────────────────────────────
console.log('=== ① 首次回填 ===')
const store1 = openStore({ home, keepDays: 400, logger })
const summary1 = await backfill({ persistence, store: store1, logger })
store1.flush()
console.log(`  sessions=${summary1.sessions} failed=${summary1.failed} entries=${summary1.entries}`)
const totals1 = grandTotals(store1.days)
const days1 = store1.days.size
console.log(`  days=${days1} totalTokens=${totals1.totalTokens} requests=${totals1.requests}`)
check('首次回填 totalTokens > 0', totals1.totalTokens > 0, true)
check('回填无失败会话', summary1.failed, 0)

// 期望值**从同一份日志现算**，而不是写死常数：会话日志在测试期间仍在增长
// （本会话自己就在追加），写死数字会变成假失败。这里断言的是不变量：
// 每条带 usage 的可入账事件，恰好入账一次。
const expected = await expectedCounts(persistence)
check('入账笔数 == 日志里带 usage 的可入账事件数', summary1.entries, expected.entries)
check('入账总 token == 独立复算值', totals1.totalTokens, expected.totalTokens)
console.log(`  （独立复算: ${expected.entries} 笔 / ${expected.totalTokens} tokens）`)

const file = join(home, 'token-usage', 'daily.json')
check('落盘文件已创建', existsSync(file), true)

// ── ② 重新打开（模拟重启）后读数一致 ──────────────────────────────────
console.log('\n=== ② 重启后读数一致 ===')
const store2 = openStore({ home, keepDays: 400, logger })
const totals2 = grandTotals(store2.days)
check('重启后 days 数量一致', store2.days.size, days1)
check('重启后 totalTokens 一致', totals2.totalTokens, totals1.totalTokens)
check('重启后 requests 一致', totals2.requests, totals1.requests)
check('重启后水位线已恢复', store2.watermarks.size, store1.watermarks.size)

// ── ③ 重复回填不重复计数 ──────────────────────────────────────────────
console.log('\n=== ③ 重复回填幂等 ===')
const summary2 = await backfill({ persistence, store: store2, logger })
store2.flush()
console.log(`  第二次 entries=${summary2.entries}（应为 0）skippedByWatermark=${summary2.skippedByWatermark}`)
check('第二次回填新入账 0 笔', summary2.entries, 0)
check('重复回填后 totalTokens 不变', grandTotals(store2.days).totalTokens, totals1.totalTokens)
check('重复回填后 requests 不变', grandTotals(store2.days).requests, totals1.requests)

// ── ④ 增量合并写：第二个实例的数据不被抹掉 ────────────────────────────
console.log('\n=== ④ 两实例并存不互相抹掉 ===')
// 模拟「另一个实例刚写了一天」。
const other = parseStoreDocument(readFileSync(file, 'utf-8'))
other.days.set('2030-01-01', new Map([['main|chat|other|m', {
  requests: 7, inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
  outputTokens: 2, reasoningTokens: 0, totalTokens: 3,
}]]))
writeFileSync(file, JSON.stringify({
  schema: 'dsh-token-usage/daily/v1',
  days: Object.fromEntries([...other.days].map(([d, b]) => [d, Object.fromEntries(b)])),
  watermarks: Object.fromEntries(other.watermarks),
}), 'utf-8')

// 本实例仍持有旧的 days（不含 2030-01-01），写入新一天后 flush。
store2.fold({
  sessionId: 'local-session', seq: 1, time: new Date(2031, 0, 2, 12, 0).getTime(),
  provider: 'local', model: 'm', scope: 'main', kind: 'chat',
  usage: { inputTokens: 5, outputTokens: 5 },
})
store2.flush()

const after = parseStoreDocument(readFileSync(file, 'utf-8'))
check('别的实例写的那天仍在', after.days.has('2030-01-01'), true)
check('本实例的新一天已写入', after.days.has('2031-01-02'), true)
check('别实例的桶数值未被改', after.days.get('2030-01-01')?.get('main|chat|other|m')?.requests, 7)

// ── ⑤ 汇总接口在真实数据上的读数 ──────────────────────────────────────
console.log('\n=== ⑤ 区间汇总（真实数据） ===')
const byDay = aggregateRange(store1.days, { groupBy: 'day' })
console.log(`  按天: ${byDay.rows.length} 行, 合计 ${byDay.totals.totalTokens}`)
check('按天合计 == 全量合计', byDay.totals.totalTokens, totals1.totalTokens)

const byProvider = aggregateRange(store1.days, { groupBy: 'provider' })
console.log('  按渠道:')
for (const row of byProvider.rows) console.log(`    ${row.label}: ${row.totals.requests} 次 / ${row.totals.totalTokens} tokens`)
check('按渠道合计 == 全量合计', byProvider.totals.totalTokens, totals1.totalTokens)

const byKind = aggregateRange(store1.days, { groupBy: 'kind' })
console.log('  按类型:')
for (const row of byKind.rows) console.log(`    ${row.label}: ${row.totals.requests} 次 / ${row.totals.totalTokens} tokens`)
check('按类型合计 == 全量合计', byKind.totals.totalTokens, totals1.totalTokens)

const byMonth = aggregateRange(store1.days, { groupBy: 'month' })
check('按月合计 == 全量合计', byMonth.totals.totalTokens, totals1.totalTokens)

// 压缩用量确实被计入（本机实测 613,328）。
const aux = byKind.rows.find((r) => r.key === 'aux')
check('压缩等辅助调用已入账', (aux?.totals.totalTokens ?? 0) > 0, true)
console.log(`  辅助调用合计: ${aux?.totals.totalTokens ?? 0}`)

rmSync(home, { recursive: true, force: true })
console.log(`\n结果: ${failures.length === 0 ? '全部通过 ✓' : `${failures.length} 处失败 ✗`}`)
for (const f of failures) console.log('  ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
