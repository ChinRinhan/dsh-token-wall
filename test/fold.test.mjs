/**
 * 纯聚合逻辑的单测（`node --test`，无外部依赖）。
 *
 * 覆盖口径边界：日界、周/月归属、合计定义、水位线去重、fork 继承前缀、
 * 保留期淘汰、以及「没上报用量 ≠ 用量为 0」这条纪律。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  addTotals,
  addUsage,
  aggregateRange,
  bucketKeyOf,
  diffDays,
  emptyTotals,
  foldEntries,
  grandTotals,
  isoWeekKey,
  localDayKey,
  monthKeyOf,
  parseBucketKey,
  periodKeyOf,
  pruneDays,
  sessionScopeOf,
  shiftDayKey,
} from '../lib/fold.js'
import { entryFromEvent, collectSessionEntries } from '../lib/collect.js'

/** 构造一个带用量的 assistant/message 事件。 */
function assistantEvent({ seq, time, usage, provider = 'p', model = 'm' }) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { message: { source: { provider, model } }, usage },
  }
}

const USAGE = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 20, reasoningTokens: 30 }

test('localDayKey 按本地时区切日，午夜前后分属两天', () => {
  const early = new Date(2026, 9, 12, 0, 0, 1).getTime()
  const late = new Date(2026, 9, 12, 23, 59, 59).getTime()
  const next = new Date(2026, 9, 13, 0, 0, 0).getTime()
  assert.equal(localDayKey(early), '2026-10-12')
  assert.equal(localDayKey(late), '2026-10-12')
  assert.equal(localDayKey(next), '2026-10-13')
})

test('shiftDayKey / diffDays 跨月跨年都正确', () => {
  assert.equal(shiftDayKey('2026-10-31', 1), '2026-11-01')
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31')
  assert.equal(shiftDayKey('2026-03-01', -1), '2026-02-28')
  assert.equal(diffDays('2026-11-01', '2026-10-31'), 1)
  assert.equal(diffDays('2026-10-12', '2026-10-12'), 0)
})

test('isoWeekKey 按 ISO-8601：周一为首日，跨年边界正确', () => {
  // 2026-01-01 是周四 → 属于 2026 年第 1 周。
  assert.equal(isoWeekKey('2026-01-01'), '2026-W01')
  // 2025-12-29 是周一 → 属于 2026 年第 1 周（ISO 跨年归属）。
  assert.equal(isoWeekKey('2025-12-29'), '2026-W01')
  // 2025-12-28 是周日 → 仍属 2025 最后一周。
  assert.equal(isoWeekKey('2025-12-28'), '2025-W52')
  // 同一周的周一到周日必须归到同一个周键。
  const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']
    .map(isoWeekKey)
  assert.equal(new Set(week).size, 1, `同周应归一个键，实得 ${JSON.stringify(week)}`)
  // 下一周的周一必须换键。
  assert.notEqual(isoWeekKey('2026-10-19'), week[0])
})

test('monthKeyOf / periodKeyOf 分派正确', () => {
  assert.equal(monthKeyOf('2026-10-12'), '2026-10')
  assert.equal(periodKeyOf('2026-10-12', 'day'), '2026-10-12')
  assert.equal(periodKeyOf('2026-10-12', 'week'), isoWeekKey('2026-10-12'))
  assert.equal(periodKeyOf('2026-10-12', 'month'), '2026-10')
})

test('合计定义：totalTokens = 输入 + 缓存读 + 缓存写 + 输出（不含思考重复计）', () => {
  const totals = emptyTotals()
  addUsage(totals, USAGE)
  assert.equal(totals.requests, 1)
  assert.equal(totals.inputTokens, 100)
  assert.equal(totals.outputTokens, 50)
  assert.equal(totals.cacheReadTokens, 1000)
  assert.equal(totals.cacheWriteTokens, 20)
  assert.equal(totals.reasoningTokens, 30)
  // 100 + 1000 + 20 + 50 = 1170；思考 30 已含在 output 内，不额外加。
  assert.equal(totals.totalTokens, 1170)
})

test('数值钳制：负数 / NaN / 缺失都算 0，不影响其他字段', () => {
  const totals = emptyTotals()
  addUsage(totals, { inputTokens: -5, outputTokens: 'abc', cacheReadTokens: undefined, cacheWriteTokens: 3.9 })
  assert.equal(totals.inputTokens, 0)
  assert.equal(totals.outputTokens, 0)
  assert.equal(totals.cacheReadTokens, 0)
  assert.equal(totals.cacheWriteTokens, 3) // 截断小数
  assert.equal(totals.totalTokens, 3)
})

test('addTotals 返回新对象，不改入参', () => {
  const a = emptyTotals(); addUsage(a, USAGE)
  const b = emptyTotals(); addUsage(b, USAGE)
  const sum = addTotals(a, b)
  assert.equal(sum.totalTokens, 2340)
  assert.equal(a.totalTokens, 1170, 'addTotals 不得修改入参')
})

test('bucketKey / parseBucketKey 往返一致，含分隔符的值被转义', () => {
  // workspace 现在是第 3 段（scope|kind|workspace|provider|model）。
  const key = bucketKeyOf({ scope: 'main', kind: 'chat', workspace: 'F:\\dafeiyu', provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(parseBucketKey(key), {
    scope: 'main', kind: 'chat', workspace: 'F:\\dafeiyu', provider: 'workbuddy', model: 'deepseek-v4.1-flash',
  })
  // 值里含 `|` 时必须仍能解析回五段（否则聚合会串桶）。
  const tricky = bucketKeyOf({ scope: 'sub', kind: 'aux', workspace: 'a|b', provider: 'c|d', model: 'e|f' })
  const parsed = parseBucketKey(tricky)
  assert.equal(parsed.scope, 'sub')
  assert.equal(parsed.kind, 'aux')
  assert.equal(parsed.workspace, 'a/b')
  assert.equal(parsed.provider, 'c/d')
  assert.equal(parsed.model, 'e/f')
  // 段数不对的脏数据被跳过而不是抛错。
  assert.equal(parseBucketKey('broken'), undefined)
  // 早先这里断言「三段是旧格式，必须被拒绝」——**那是错的**：旧格式是**四**段，
  // 而且它必须被接受，否则盘上 400 天的历史会被整体跳过、累计归零。
  assert.equal(parseBucketKey('a|b|c'), undefined, '三段既不是旧格式也不是新格式，拒绝')
  assert.equal(parseBucketKey(''), undefined)
})

test('parseBucketKey 兼容旧的 4 段桶键（历史数据必须继续可读）', () => {
  // 回归：桶键从 4 段扩到 5 段后，如果只认 5 段，盘上几十万条历史桶会被当成
  // 脏数据整体跳过，累计瞬间跌到 0——这是本插件最不能接受的失效模式。
  const legacy = parseBucketKey('main|chat|workbuddy|deepseek-v4.1-flash')
  assert.deepEqual(legacy, {
    scope: 'main', kind: 'chat', workspace: '', provider: 'workbuddy', model: 'deepseek-v4.1-flash',
  })
  // 旧的 sub/aux 也要能读。
  const legacySub = parseBucketKey('sub|aux|spark|Spark-X2.5-4B')
  assert.equal(legacySub.scope, 'sub')
  assert.equal(legacySub.kind, 'aux')
  assert.equal(legacySub.workspace, '', '旧数据没有 workspace 段 → 未标注')
  assert.equal(legacySub.provider, 'spark')
})

test('sessionScopeOf 识别子会话（subagent 与 delegationDepth）', () => {
  assert.equal(sessionScopeOf({ origin: 'subagent' }), 'sub')
  assert.equal(sessionScopeOf({ delegationDepth: 1 }), 'sub')
  assert.equal(sessionScopeOf({ delegationDepth: 0 }), 'main')
  assert.equal(sessionScopeOf({}), 'main')
  assert.equal(sessionScopeOf(undefined), 'main')
})

test('entryFromEvent：没带 usage 的调用不入账（不写 0）', () => {
  assert.equal(entryFromEvent({ sessionId: 's', event: assistantEvent({ seq: 1, time: Date.now() }) }), undefined)
  // 非 assistant/message 事件一律忽略。
  assert.equal(entryFromEvent({ sessionId: 's', event: { type: 'tool/result', seq: 2, time: Date.now() } }), undefined)
})

test('entryFromEvent：fork 继承前缀的事件被排除', () => {
  const event = assistantEvent({ seq: 5, time: Date.now(), usage: USAGE })
  // 继承前缀长度 10 ⇒ seq 5 属于父会话，子会话不得再计一次。
  assert.equal(entryFromEvent({ sessionId: 'child', event, inheritedEventCount: 10 }), undefined)
  // 自有事件（seq 12 >= 10）正常入账。
  const own = assistantEvent({ seq: 12, time: Date.now(), usage: USAGE })
  assert.notEqual(entryFromEvent({ sessionId: 'child', event: own, inheritedEventCount: 10 }), undefined)
})

test('collectSessionEntries：水位线只跳过已计事件，并如实统计覆盖率', () => {
  const events = [
    assistantEvent({ seq: 1, time: Date.now(), usage: USAGE }),
    assistantEvent({ seq: 2, time: Date.now(), usage: USAGE }),
    assistantEvent({ seq: 3, time: Date.now() }), // 无 usage
    assistantEvent({ seq: 4, time: Date.now(), usage: USAGE }),
  ]
  const first = collectSessionEntries({ sessionId: 's', header: {}, events })
  assert.equal(first.entries.length, 3, '三条带 usage 的都应入账')
  assert.equal(first.seen, 4)
  assert.equal(first.withUsage, 3, '覆盖率诊断：4 条里 3 条有用量')

  // 水位线 = 2 ⇒ 只入账 seq 4。
  const second = collectSessionEntries({ sessionId: 's', header: {}, events, watermark: 2 })
  assert.equal(second.entries.length, 1)
  assert.equal(second.entries[0].seq, 4)
  assert.equal(second.skippedByWatermark, 2)
})

test('foldEntries + aggregateRange：按天汇总与区间过滤', () => {
  const days = new Map()
  const t1 = new Date(2026, 9, 12, 10, 0, 0).getTime()
  const t2 = new Date(2026, 9, 12, 18, 0, 0).getTime()
  const t3 = new Date(2026, 9, 13, 9, 0, 0).getTime()
  foldEntries(days, [
    { sessionId: 's', seq: 1, time: t1, provider: 'workbuddy', model: 'm', scope: 'main', usage: USAGE },
    { sessionId: 's', seq: 2, time: t2, provider: 'workbuddy', model: 'm', scope: 'main', usage: USAGE },
    { sessionId: 's', seq: 3, time: t3, provider: 'deepseek-official', model: 'x', scope: 'main', usage: USAGE },
  ])

  const all = aggregateRange(days, { groupBy: 'day' })
  assert.equal(all.rows.length, 2)
  assert.equal(all.rows[0].key, '2026-10-12')
  assert.equal(all.rows[0].totals.requests, 2)
  assert.equal(all.rows[0].totals.totalTokens, 2340)
  assert.equal(all.rows[1].key, '2026-10-13')
  assert.equal(all.rows[1].totals.requests, 1)
  assert.equal(all.totals.requests, 3)
  assert.equal(all.totals.totalTokens, 3510)

  // 区间过滤：只取 10-13。
  const only13 = aggregateRange(days, { groupBy: 'day', from: '2026-10-13', to: '2026-10-13' })
  assert.equal(only13.rows.length, 1)
  assert.equal(only13.totals.totalTokens, 1170)

  // 按 provider 维度：降序（谁多谁前）。
  const byProvider = aggregateRange(days, { groupBy: 'provider' })
  assert.equal(byProvider.rows.length, 2)
  assert.equal(byProvider.rows[0].label, 'workbuddy')
  assert.equal(byProvider.rows[0].totals.requests, 2)
})

test('aggregateRange：includeSub=false 时排除子会话', () => {
  const days = new Map()
  const time = new Date(2026, 9, 12, 10, 0, 0).getTime()
  foldEntries(days, [
    { sessionId: 'a', seq: 1, time, provider: 'p', model: 'm', scope: 'main', usage: USAGE },
    { sessionId: 'b', seq: 1, time, provider: 'p', model: 'm', scope: 'sub', usage: USAGE },
  ])
  assert.equal(aggregateRange(days, { groupBy: 'day', includeSub: true }).totals.requests, 2)
  const withoutSub = aggregateRange(days, { groupBy: 'day', includeSub: false })
  assert.equal(withoutSub.totals.requests, 1)
  assert.equal(withoutSub.totals.totalTokens, 1170)
})

test('aggregateRange：按周/月合并多天', () => {
  const days = new Map()
  foldEntries(days, [
    { sessionId: 's', seq: 1, time: new Date(2026, 9, 12, 10, 0).getTime(), provider: 'p', model: 'm', scope: 'main', usage: USAGE },
    { sessionId: 's', seq: 2, time: new Date(2026, 9, 14, 10, 0).getTime(), provider: 'p', model: 'm', scope: 'main', usage: USAGE },
    { sessionId: 's', seq: 3, time: new Date(2026, 10, 2, 10, 0).getTime(), provider: 'p', model: 'm', scope: 'main', usage: USAGE },
  ])
  const byWeek = aggregateRange(days, { groupBy: 'week' })
  // 10-12 与 10-14 同属一周 → 合并为一行。
  assert.equal(byWeek.rows.length, 2)
  assert.equal(byWeek.rows[0].totals.requests, 2)
  const byMonth = aggregateRange(days, { groupBy: 'month' })
  assert.equal(byMonth.rows.length, 2)
  assert.equal(byMonth.rows[0].key, '2026-10')
  assert.equal(byMonth.rows[0].totals.requests, 2)
})

test('pruneDays 只淘汰窗口外的日键，且不改原表', () => {
  const days = new Map([
    ['2026-10-10', new Map([['main|p|m', { ...emptyTotals(), requests: 1 }]])],
    ['2026-10-12', new Map([['main|p|m', { ...emptyTotals(), requests: 1 }]])],
  ])
  const now = new Date(2026, 9, 12, 12, 0, 0).getTime()
  const kept = pruneDays(days, { keepDays: 2, now })
  assert.equal(kept.size, 1)
  assert.equal(kept.has('2026-10-12'), true)
  assert.equal(days.size, 2, 'pruneDays 不得修改原表')

  // keepDays <= 0 表示不淘汰。
  assert.equal(pruneDays(days, { keepDays: 0, now }).size, 2)
})

test('grandTotals 汇总全表', () => {
  const days = new Map()
  foldEntries(days, [
    { sessionId: 's', seq: 1, time: new Date(2026, 9, 12, 10, 0).getTime(), provider: 'p', model: 'm', scope: 'main', usage: USAGE },
    { sessionId: 's', seq: 2, time: new Date(2026, 9, 13, 10, 0).getTime(), provider: 'q', model: 'n', scope: 'sub', usage: USAGE },
  ])
  assert.equal(grandTotals(days).totalTokens, 2340)
})

test('entryFromEvent：压缩摘要（compaction/summary）也入账，标记为 aux', () => {
  // 压缩是一次真实模型调用，事件类型不是 assistant/message。
  // 只读后者会静默漏掉它（本机实测历史有 613,328 tokens 来自压缩）。
  const compaction = {
    type: 'compaction/summary',
    seq: 7,
    time: Date.now(),
    data: { provider: 'deepseek-account', model: 'deepseek-flash', usage: { inputTokens: 505232, outputTokens: 4294 } },
  }
  const entry = entryFromEvent({ sessionId: 's', header: {}, event: compaction })
  assert.notEqual(entry, undefined, '压缩用量必须入账')
  assert.equal(entry.kind, 'aux')
  assert.equal(entry.provider, 'deepseek-account')
  assert.equal(entry.model, 'deepseek-flash')
  assert.equal(entry.usage.inputTokens, 505232)

  // 对话调用标记为 chat。
  const chat = entryFromEvent({ sessionId: 's', header: {}, event: assistantEvent({ seq: 8, time: Date.now(), usage: USAGE }) })
  assert.equal(chat.kind, 'chat')

  // 压缩同样受 fork 继承前缀约束。
  assert.equal(entryFromEvent({ sessionId: 'c', event: compaction, inheritedEventCount: 10 }), undefined)
})

test('aggregateRange：includeAux=false 时排除压缩等辅助调用', () => {
  const days = new Map()
  const time = new Date(2026, 9, 12, 10, 0, 0).getTime()
  foldEntries(days, [
    { sessionId: 's', seq: 1, time, provider: 'p', model: 'm', scope: 'main', kind: 'chat', usage: USAGE },
    { sessionId: 's', seq: 2, time, provider: 'p', model: 'm', scope: 'main', kind: 'aux', usage: USAGE },
  ])
  assert.equal(aggregateRange(days, { groupBy: 'day' }).totals.requests, 2)
  const noAux = aggregateRange(days, { groupBy: 'day', includeAux: false })
  assert.equal(noAux.totals.requests, 1)
  assert.equal(noAux.totals.totalTokens, 1170)

  // 两个开关正交：aux 与 sub 各管一维。
  const byKind = aggregateRange(days, { groupBy: 'kind' })
  assert.equal(byKind.rows.length, 2)
})

test('aggregateRange：kind 分组只下发枚举值，不下发硬编码文案', () => {
  // 回归：host 曾把 label 写成中文「辅助调用（压缩等）」，导致英文界面也显示
  // 中文——host 不知道当前 locale。文案必须由 Client 按枚举本地化。
  const days = new Map()
  const time = new Date(2026, 9, 12, 10, 0, 0).getTime()
  foldEntries(days, [
    { sessionId: 's', seq: 1, time, provider: 'p', model: 'm', scope: 'main', kind: 'chat', usage: USAGE },
    { sessionId: 's', seq: 2, time, provider: 'p', model: 'm', scope: 'main', kind: 'aux', usage: USAGE },
  ])
  const { rows } = aggregateRange(days, { groupBy: 'kind' })
  const labels = rows.map((r) => r.label).sort()
  assert.deepEqual(labels, ['aux', 'chat'], 'label 必须是语言无关的枚举值')
  for (const row of rows) {
    assert.equal(row.kind, row.label, 'kind 字段与 label 一致，便于 Client 本地化')
    assert.doesNotMatch(row.label, /[\u4e00-\u9fff]/, '不得含中文')
  }
})

test('累计合计与区间合计走同一套过滤（回归：allTime 曾无视开关）', () => {
  // 回归：`/today` 与 `/summary` 的 allTime 曾直接调 grandTotals(store.days)，
  // 它把所有桶无差别相加、完全不看 includeSub/includeAux。结果是关掉「含子会话」
  // 后区间合计变小、旁边的「累计」纹丝不动，页面出现两个互相矛盾的数。
  // 现在 allTime 用 aggregateRange 的不限区间路径，因此两者口径必须一致。
  const days = new Map()
  const time = new Date(2026, 9, 12, 10, 0, 0).getTime()
  foldEntries(days, [
    { sessionId: 's1', seq: 1, time, provider: 'p', model: 'm', scope: 'main', kind: 'chat', usage: USAGE },
    { sessionId: 's2', seq: 2, time, provider: 'p', model: 'm', scope: 'sub', kind: 'chat', usage: USAGE },
    { sessionId: 's3', seq: 3, time, provider: 'p', model: 'm', scope: 'main', kind: 'aux', usage: USAGE },
  ])

  // 不限区间、同一组开关 ⇒ 与 grandTotals 相等（默认开关下二者应完全一致）。
  const all = aggregateRange(days, { groupBy: 'day' }).totals
  assert.deepEqual(all, grandTotals(days))

  // 关掉子会话：累计必须跟着变小，而不是纹丝不动。
  const noSub = aggregateRange(days, { groupBy: 'day', includeSub: false }).totals
  assert.equal(noSub.requests, 2)
  assert.ok(noSub.totalTokens < all.totalTokens, '关掉子会话后累计必须下降')

  // 关掉辅助调用：同样必须生效。
  const noAux = aggregateRange(days, { groupBy: 'day', includeAux: false }).totals
  assert.equal(noAux.requests, 2)
  assert.ok(noAux.totalTokens < all.totalTokens, '关掉辅助调用后累计必须下降')

  // 两个都关：只剩 1 笔。
  const neither = aggregateRange(days, { groupBy: 'day', includeSub: false, includeAux: false }).totals
  assert.equal(neither.requests, 1)
})

test('collectSessionEntries：压缩事件也参与覆盖率统计', () => {
  const events = [
    assistantEvent({ seq: 1, time: Date.now(), usage: USAGE }),
    { type: 'compaction/summary', seq: 2, time: Date.now(), data: { provider: 'p', model: 'm', usage: USAGE } },
    { type: 'session/title-llm-request', seq: 3, time: Date.now(), data: {} }, // 不带 usage，不入账
  ]
  const collected = collectSessionEntries({ sessionId: 's', header: {}, events })
  assert.equal(collected.entries.length, 2, '对话 + 压缩各一条')
  assert.equal(collected.entries.map((e) => e.kind).sort().join(','), 'aux,chat')
  assert.equal(collected.seen, 2, 'title-llm-request 不在可入账事件类型里')
  assert.equal(collected.withUsage, 2)
})

test('端到端：回填与实时共用水位线，同一条事件只入账一次', () => {
  // 模拟 store 的水位线语义（与 FileStore.shouldCount 同口径）。
  const watermarks = new Map()
  const days = new Map()
  const shouldCount = (id, seq) => {
    const mark = watermarks.get(id)
    return mark === undefined || seq > mark
  }
  const events = [
    assistantEvent({ seq: 1, time: new Date(2026, 9, 12, 10, 0).getTime(), usage: USAGE }),
    assistantEvent({ seq: 2, time: new Date(2026, 9, 12, 11, 0).getTime(), usage: USAGE }),
  ]
  // 第一次：全量回填。
  for (const e of events) {
    if (!shouldCount('s', e.seq)) continue
    foldEntries(days, [entryFromEvent({ sessionId: 's', header: {}, event: e })])
    watermarks.set('s', e.seq)
  }
  // 第二次：模拟重启后再次回填同一份日志 → 必须一条都不重复入账。
  for (const e of events) {
    if (!shouldCount('s', e.seq)) continue
    foldEntries(days, [entryFromEvent({ sessionId: 's', header: {}, event: e })])
    watermarks.set('s', e.seq)
  }
  assert.equal(grandTotals(days).requests, 2, '重复回填不得重复计数')
  assert.equal(grandTotals(days).totalTokens, 2340)

  // 第三次：实时收到一条新事件 → 正常入账。
  const live = assistantEvent({ seq: 3, time: new Date(2026, 9, 12, 12, 0).getTime(), usage: USAGE })
  assert.equal(shouldCount('s', live.seq), true)
  foldEntries(days, [entryFromEvent({ sessionId: 's', header: {}, event: live })])
  assert.equal(grandTotals(days).requests, 3)
})
