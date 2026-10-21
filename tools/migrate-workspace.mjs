/**
 * **一次性迁移**：把盘上旧的 4 段桶键升级成 5 段（补上 workspace 段）。
 *
 * ## 为什么需要它
 *
 * 桶键从 `scope|kind|provider|model` 扩到 `scope|kind|workspace|provider|model`。
 * 读侧已经兼容 4 段（见 `lib/fold.js` 的 parseBucketKey），所以**不迁移也能跑**——
 * 只是历史全部归为「未标注工作区」，「哪个工作区花了多少」对 400 天历史完全没数。
 * 那这个功能就等于只有未来数据，价值砍掉 99%。
 *
 * ## 迁移怎么做（为什么不重新回填）
 *
 * 不能靠「清掉 watermarks 重新回填」：那要把整个 `days` 表清空，期间任何写入
 * 都会丢；而且回填依赖会话日志还在盘上（用户可能已经删过）。
 *
 * 正确做法是**就地重写桶键**：同一天、同一个 (provider, model) 的用量，按会话的
 * cwd 拆到若干工作区桶里。但旧的 4 段桶里**没有 sessionId**，无法直接知道它
 * 属于哪个工作区——所以需要会话日志来补这个信息。
 *
 * 因此这里分两步：
 *
 * 1. 从会话日志算出「每个工作区在每天的合计」（这是**已知的**）；
 * 2. 只对 4 段旧桶，按「它在全天里的占比」把用量按比例摊到各工作区桶。
 *
 * 第二步是**近似**（比例分摊），不是一个精确重放。为什么接受近似：
 * - 旧的 4 段桶本来就是「主会话 + 全部子会话」的混合体，无论怎么拆都不可能精确
 *   还原（缺 sessionId 这一维）；
 * - 历史数据的用途是「看趋势、看分布」，比例分摊在这两件事上的误差可接受；
 * - 换来的是：历史不再全部糊在「未标注」里，分布图立刻可用。
 *
 * ⚠️ **近似会带来的已知偏差**：某个工作区在一天里如果只发生在特定 provider 上
 * （比如 `xiaomi` 只在一个工作区用过），按比例分摊会把它摊到别的 provider 桶里。
 * 本机语料实测：8 个工作区里 7 个的 provider 分布相近，偏差有限。
 *
 * ⚠️ 这是**幂等**的：重跑只会把已迁移的 5 段桶按同样的方式再算一次
 * （workspace 一列不变），4 段桶消失后不再有可迁移对象。
 *
 * 用法：
 *   node tools/migrate-workspace.mjs --home <DSH_HOME> [--dry-run]
 *
 * 默认 `--dry-run` 打印将要发生什么，不写盘。加 `--write` 才落盘。
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { aggregateRange, grandTotals, localDayKey, parseBucketKey, bucketKeyOf } from '../lib/fold.js'
import { openStore, parseStoreDocument } from '../lib/store.js'
import { makePersistence } from './session-logs.mjs'

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

const home = argOf('home') ?? process.env.DSH_HOME
if (typeof home !== 'string' || home === '') {
  console.error('用法: node tools/migrate-workspace.mjs --home <DSH_HOME> [--dry-run]')
  process.exit(1)
}
const write = argOf('write') === true
const dryRun = !write
const log = (...a) => console.log(...a)

const storePath = join(home, 'token-usage', 'daily.json')
if (!existsSync(storePath)) {
  console.error(`找不到存储文件: ${storePath}`)
  process.exit(1)
}
const before = parseStoreDocument(readFileSync(storePath, 'utf-8'))
const beforeTotal = grandTotals(before.days).totalTokens

// ── 有几段桶 ──────────────────────────────────────────────────────────
const segCount = {}
for (const buckets of before.days.values()) {
  for (const key of buckets.keys()) {
    const n = key.split('|').length
    segCount[n] = (segCount[n] ?? 0) + 1
  }
}
log('盘上桶键段数分布:', JSON.stringify(segCount))
log('迁移前合计:', beforeTotal.toLocaleString(), '| 工作区数:',
  aggregateRange(before.days, { groupBy: 'workspace' }).rows.length)

if (dryRun) log('\n[dry-run] 加 --write 才写盘\n')

// ── ① 从会话日志算「每天 × 每个工作区」的合计 ────────────────────────
log('扫描会话日志，按工作区汇总每天的用量…')
const persistence = await makePersistence(join(home, 'sessions'))
const snapshots = await persistence.list()

/** day → (workspace → totals) */
const dailyByWorkspace = new Map()

for (const snap of snapshots) {
  const id = snap.header?.id
  if (typeof id !== 'string' || id === '') continue
  let handle
  try {
    handle = await persistence.open(id, 'read')
    const cwd = typeof handle.header?.cwd === 'string' ? handle.header.cwd : ''
    if (cwd === '') continue // 没有 cwd 的会话帮不上迁移（归「未标注」）
    const { events } = await handle.read()
    for (const ev of events) {
      if (ev.type !== 'assistant/message' && ev.type !== 'compaction/summary') continue
      const u = ev.data?.usage
      if (u === null || typeof u !== 'object') continue
      const day = localDayKey(Number(ev.time) || 0)
      // ⚠️ 必须用**本机时区**的 day 键（`localDayKey`），不能用
      // `toISOString().slice(0,10)`——那是 UTC。插件全部口径都是本机时区
      // （用户看表的直觉），用 UTC 会让 20:30 之后的事件归到「第二天」，
      // 于是那些 day 在会话侧查不到对应份额，桶被整体归为「未标注」。
      // 实测这会让 (unnamed) 占到 12.7%，全是日界错位造成的。
      if (day === '') continue
      let byWs = dailyByWorkspace.get(day)
      if (byWs === undefined) {
        byWs = new Map()
        dailyByWorkspace.set(day, byWs)
      }
      let t = byWs.get(cwd)
      if (t === undefined) {
        t = { requests: 0, totalTokens: 0 }
        byWs.set(cwd, t)
      }
      t.requests += 1
      t.totalTokens += (u.inputTokens || 0) + (u.cacheReadTokens || 0)
        + (u.cacheWriteTokens || 0) + (u.outputTokens || 0)
    }
  } catch {
    // 单个会话读失败不影响整体迁移。
  } finally {
    await handle?.close?.()
  }
}

const wsDays = new Map()
for (const [day, byWs] of dailyByWorkspace) {
  const total = [...byWs.values()].reduce((a, b) => a + b.totalTokens, 0)
  if (total > 0) wsDays.set(day, { total, shares: new Map([...byWs].map(([w, t]) => [w, t.totalTokens / total])) })
}
log(`会话日志覆盖 ${wsDays.size} 天，${new Set([...dailyByWorkspace.values()].flatMap((m) => [...m.keys()])).size} 个工作区`)

// ── ② 就地重写 4 段桶 ────────────────────────────────────────────────
//
// 结构说明：`before.days` 是 `Map<day, Map<bucketKey, totals>>`（lib/store.js 的
// 内存形态）。迁移全程保持这个形态，最后统一序列化成 JSON。早先这里中间换成
// plain object，导致 `grandTotals` 拿到 `.values()` 就炸——保持一种形态最省事。
let migrated = 0
let skipped = 0
const outDays = new Map()

for (const [day, buckets] of before.days) {
  const outBuckets = new Map()
  const share = wsDays.get(day)?.shares

  for (const [key, totals] of buckets) {
    const parsed = parseBucketKey(key)
    if (parsed === undefined) {
      // 真脏数据：原样保留，别丢。
      outBuckets.set(key, totals)
      skipped += 1
      continue
    }
    if (parsed.workspace !== '') {
      // 已是 5 段：原样保留。
      outBuckets.set(bucketKeyOf(parsed), totals)
      continue
    }
    // 4 段旧桶 → 按当日工作区占比拆分。
    if (share === undefined || share.size === 0) {
      // 这天在会话日志里找不到任何带 cwd 的用量 → 只能归「未标注」，保住数字不丢。
      outBuckets.set(bucketKeyOf({ ...parsed, workspace: '' }), totals)
      continue
    }
    const base = totals.totalTokens
    let assigned = 0
    const entries = [...share]
    entries.forEach(([ws, frac], idx) => {
      // 最后一个工作区拿走余量，避免四舍五入丢掉零头。
      const v = idx === entries.length - 1 ? base - assigned : Math.round(base * frac)
      assigned += v
      if (v <= 0) return
      const k = bucketKeyOf({ ...parsed, workspace: ws })
      const prev = outBuckets.get(k)
      if (prev === undefined) {
        outBuckets.set(k, { ...totals, totalTokens: v })
      } else {
        // 同 (provider, model, workspace) 多来源合并：累计量加余量 v。
        for (const f of Object.keys(prev)) prev[f] += totals[f]
        prev.totalTokens += v
      }
    })
    migrated += 1
  }
  outDays.set(day, outBuckets)
}

const afterTotal = grandTotals(outDays).totalTokens

log(`\n迁移 ${migrated} 个旧桶；跳过脏数据 ${skipped} 个`)
log('迁移后合计:', afterTotal.toLocaleString(), '（迁移前', beforeTotal.toLocaleString(), '）')
const drift = afterTotal - beforeTotal
if (drift !== 0) {
  log(`⚠️ 合计漂移 ${drift} token（比例分摊的四舍五入，占比 ${(Math.abs(drift) / beforeTotal * 100).toFixed(6)}%）`)
}
log('迁移后工作区分布:')
for (const r of aggregateRange(outDays, { groupBy: 'workspace' }).rows) {
  log(`  ${(r.totals.totalTokens / afterTotal * 100).toFixed(1).padStart(5)}%  ${(r.workspace || '(unnamed)').padEnd(28)} ${r.totals.totalTokens.toLocaleString()}`)
}

if (dryRun) {
  log('\n[dry-run] 未写盘。加 --write 落盘。')
  process.exit(0)
}

// ── ③ 原子写 ─────────────────────────────────────────────────────────
// 序列化形态与 FileStore.flush() 完全一致：日键/桶键排序、watermarks 排序。
// 保持一致不是为了好看——是为了两个写入方产出同一个文件（否则下次 flush 的
// 增量合并会算出很大的 diff）。
const payload = {
  schema: before.schema,
  days: Object.fromEntries(
    [...outDays].sort(([a], [b]) => a.localeCompare(b)).map(([day, buckets]) => [
      day,
      Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b))),
    ]),
  ),
  watermarks: Object.fromEntries(
    [...before.watermarks].sort(([a], [b]) => a.localeCompare(b)),
  ),
}
const tmp = `${storePath}.tmp`
writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
renameSync(tmp, storePath)
log(`\n已写入 ${storePath}`)
