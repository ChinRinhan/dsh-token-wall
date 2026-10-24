/**
 * 用**真实会话日志**交叉校验 `lib/turns.js` 的折叠结果。
 *
 * ## 为什么需要它
 *
 * `test/turn-fold.test.mjs` 用的是**人造事件**——它验证逻辑自洽，但证明不了
 * 「真实日志喂进去能得到宿主那个数」。这个脚本拿本机真实会话日志，用我们的
 * 折叠算一遍，再和宿主自己持久化的 `tokenUsage` 投影比对：
 *
 * ```
 * 我们的 sessionBuckets 之和  ==  宿主 tokenUsage 四桶之和
 * ```
 *
 * 两边口径本就应当相等（同一份 assistant/message 的 usage，只是折叠方式不同），
 * 所以**不相等就说明我们的折叠漏了或重了**。
 *
 * ## 已知的口径差异（不是 bug）
 *
 * - 宿主投影包含 **fork 继承前缀**（它折的是整份日志）；我们也可以从 seq 0 折，
 *   所以这里同样包含——两边一致。
 * - 宿主 `tokenUsage` 只累加 `assistant/message` / `assistant/attempt` 的样本；
 *   我们的 `usageOfEvent` 同源，但**额外**会在流里找 usage chunk。若某个事件
 *   两者取到不同样本，就会出现差异——那正是要发现的。
 *
 * 用法：node tools/cross-validate-turns.mjs <DSH_HOME>
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { foldTurnEvents, totalOf, sessionViewOf } from '../lib/turns.js'

const home = process.argv[2]
if (typeof home !== 'string' || home === '') {
  console.error('用法: node tools/cross-validate-turns.mjs <DSH_HOME>')
  process.exit(2)
}

/** 解一个多帧 zstd 日志。会话日志是「每次 append 一个 frame」，不是单帧。 */
function decodeSessionLog(path) {
  const buf = readFileSync(path)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1]
      && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k]
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
    } catch {
      // 单帧坏了不该让整轮校验失败：跳过，计数在下面体现。
    }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { events.push(JSON.parse(line)) } catch { /* 跳过半行 */ }
  }
  return events
}

/** 读宿主为某会话持久化的投影值（projcache 的记录格式）。
 *
 * ⚠️ 投影记录的 `val` 是 `{ totals, last }`，**不是**四个桶本身。
 * `totals` 才是整份日志的四桶累计；`last` 只是最近一次 attempt 的样本。
 * 早先这里少取一层，于是每个会话都算出 NaN——那种「全部不一致」的形态
 * 恰恰说明是取值错了，而不是折叠错了。
 */
function readProjection(homeDir, sessionId) {
  const path = join(homeDir, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const row = raw?.record?.rows?.tokenUsage
    if (row === undefined) return undefined
    return { totals: row.val?.totals, asOfSeq: row.seq }
  } catch {
    return undefined
  }
}

/** 找到某会话的日志文件。 */
function findSessionLog(homeDir, sessionId) {
  const root = join(homeDir, 'sessions')
  if (!existsSync(root)) return undefined
  for (const bucket of readdirSync(root)) {
    const dir = join(root, bucket, sessionId)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.jsonl.zstd')) return join(dir, name)
    }
  }
  return undefined
}

const totalOfUsage = (u) => (u === undefined || u === null
  ? undefined
  : u.uncachedInputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens)

const projDir = join(home, 'storages', 'session_projcache', 'sessions')
if (!existsSync(projDir)) {
  console.error(`找不到投影缓存: ${projDir}`)
  process.exit(2)
}

let checked = 0
let matched = 0
let skipped = 0
let stale = 0
const mismatches = []

for (const file of readdirSync(projDir)) {
  if (!file.endsWith('.json')) continue
  const sessionId = file.replace(/\.json$/, '')
  const projection = readProjection(home, sessionId)
  const hostTotal = totalOfUsage(projection?.totals)
  if (hostTotal === undefined) { skipped += 1; continue }

  const logPath = findSessionLog(home, sessionId)
  if (logPath === undefined) { skipped += 1; continue }

  const events = decodeSessionLog(logPath)
  if (events.length === 0) { skipped += 1; continue }

  // ⚠️ 投影缓存是**节流写盘**（write-behind）。日志还在增长时，盘上的检查点
  // 必然落后于日志本身——此时拿它当基准比较，差异只反映「检查点旧了」，
  // 不反映折叠错了。这类会话单独计数，不计入不一致。
  const lastSeq = events.reduce((max, e) => (Number.isInteger(e?.seq) && e.seq > max ? e.seq : max), -1)
  const asOfSeq = Number(projection?.asOfSeq)
  if (Number.isFinite(asOfSeq) && asOfSeq < lastSeq) { stale += 1; continue }

  const state = foldTurnEvents(events)
  const view = sessionViewOf(state)
  const ourTotal = view.sessionTokens
  checked += 1
  if (ourTotal === hostTotal) {
    matched += 1
  } else {
    mismatches.push({ sessionId, host: hostTotal, ours: ourTotal, diff: ourTotal - hostTotal })
  }
}

console.log(`=== 逐轮折叠 vs 宿主 tokenUsage 投影 ===`)
console.log(`可比对会话: ${checked}  一致: ${matched}  跳过: ${skipped}  检查点滞后(跳过): ${stale}`)
if (mismatches.length > 0) {
  console.log(`\n不一致 ${mismatches.length} 个（按差值绝对值降序，取前 10）：`)
  mismatches
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, 10)
    .forEach((m) => {
      console.log(`  ${m.sessionId}`)
      console.log(`    宿主=${m.host}  我们=${m.ours}  差=${m.diff > 0 ? '+' : ''}${m.diff}`)
    })
}
console.log(`\n结果: ${mismatches.length === 0 ? '全部一致 ✓' : `${mismatches.length} 个会话不一致`}`)
process.exitCode = mismatches.length === 0 ? 0 : 1
