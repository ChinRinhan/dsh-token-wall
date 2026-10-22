/**
 * 交叉校验：把**真实会话日志**喂进插件的**生产代码**（lib/collect.js + lib/fold.js），
 * 再用一份**完全独立**的实现复算同一个数，两者必须一致。
 *
 * 为什么这是最强的正确性证据：两条路径共享的只有「输入文件」——解析、过滤、聚合
 * 全部各写一遍。任何口径漂移（漏事件类型、日界错、重复计数）都会让数字对不上。
 *
 * 同时验证 v0/v4 两代日志的取舍：同一会话若同时存在两代，运行时只读**最高代**
 * （否则同一批事件被算两次）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

import { collectSessionEntries } from '../lib/collect.js'
import { seedPrefixOf } from '../lib/adapter.js'
import { foldEntries, grandTotals, localDayKey } from '../lib/fold.js'

/**
 * **独立**复算继承前缀（B 侧自己写一遍，不复用生产代码）。
 *
 * 两代口径并存：持久化 header 的 `seedLength`（新）与日志里的
 * `session/end-seed` 事件（也新，是 seed 边界的投影）。都没有 ⇒ 0。
 *
 * ⚠️ 早先这里是硬编码 `inheritedEventCount: 0`，等于假设「没有 fork」。
 * 在真实语料里恰好没有 seeded 会话，所以测试一直绿——而那个假设本身是错的。
 */
function seedBoundaryOf(header, events) {
  if (typeof header?.seedLength === 'number' && Number.isFinite(header.seedLength)) {
    return Math.max(0, Math.trunc(header.seedLength))
  }
  let last = -1
  for (const e of events) {
    if (e?.type !== 'session/end-seed') continue
    const seq = Number(e.seq)
    if (Number.isFinite(seq) && seq > last) last = seq
  }
  return last >= 0 ? last + 1 : 0
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解码「一个 zstd 帧 = 一批追加」的拼接文件。 */
function decodeFrames(buf) {
  const offsets = []
  let i = buf.indexOf(MAGIC, 0)
  while (i !== -1) { offsets.push(i); i = buf.indexOf(MAGIC, i + 1) }
  const parts = []
  let start = 0
  while (start < buf.length) {
    let ok = false
    for (const off of offsets) {
      if (off <= start) continue
      try { parts.push(zstdDecompressSync(buf.subarray(start, off))); start = off; ok = true; break } catch {}
    }
    if (!ok) { try { parts.push(zstdDecompressSync(buf.subarray(start))) } catch {}; break }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 走目录树，按「会话目录」归组，并选出该目录里代次最高的日志（模拟运行时行为）。 */
function collectSessionLogs(root) {
  const bySessionDir = new Map()
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(projectDir, entry.name)
      const logs = readdirSync(dir).filter((f) => f.endsWith('.jsonl.zstd'))
      if (logs.length === 0) continue
      // 代次：session.v4.jsonl.zstd → 4；session.jsonl.zstd → 0。取最高。
      const genOf = (f) => {
        const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(f)
        return m === null ? -1 : m[1] === undefined ? 0 : Number(m[1])
      }
      const best = logs.slice().sort((a, b) => genOf(b) - genOf(a))[0]
      bySessionDir.set(dir, { path: join(dir, best), generation: genOf(best), candidates: logs })
    }
  }
  return bySessionDir
}

const root = process.argv[2]
if (typeof root !== 'string' || root === '') {
  // ⚠️ 缺参数时必须**友好退出**，不能崩在 readdirSync(undefined) 上。
  // 别人克隆仓库后照着跑，第一眼看到的应该是用法提示，不是堆栈。
  console.error('用法: node test/cross-validate.mjs <sessions 目录>')
  console.error('')
  console.error('这个测试拿真实会话日志，用「插件的生产代码」和「一份独立实现」')
  console.error('分别算总量，逐日比对。它需要本机已有的 DSH 会话日志，因此不进 npm test。')
  console.error('')
  console.error('  示例（Windows）: node test/cross-validate.mjs "%USERPROFILE%\\.dsh\\sessions"')
  console.error('  示例（macOS/Linux）: node test/cross-validate.mjs ~/.dsh/sessions')
  process.exit(1)
}
if (!existsSync(root)) {
  console.error(`目录不存在: ${root}`)
  console.error('提示：DSH 的会话日志通常在 $DSH_HOME/sessions（默认 ~/.dsh/sessions）。')
  process.exit(1)
}
const logs = collectSessionLogs(root)

// ── 路径 A：插件的生产代码 ────────────────────────────────────────────
const daysA = new Map()
const watermarks = new Map()
let sessionsA = 0
let seenA = 0
let withUsageA = 0
let genCounts = { 0: 0, 4: 0 }
let multiGen = 0

// ── 路径 B：独立实现（不复用插件任何逻辑）────────────────────────────
const totalsB = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 }
const daysB = new Map()

for (const [dir, info] of logs) {
  if (info.candidates.length > 1) multiGen += 1
  genCounts[info.generation] = (genCounts[info.generation] ?? 0) + 1

  let text
  try { text = decodeFrames(readFileSync(info.path)) } catch { continue }
  const events = []
  let header
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type === 'session') { header = rec; continue }
    events.push(rec)
  }
  if (header === undefined) continue
  const sessionId = header.id
  sessionsA += 1

  // ── A：走生产代码 ──
  const seedPrefix = seedPrefixOf({ header, events })
  const collected = collectSessionEntries({
    sessionId,
    header,
    events,
    inheritedEventCount: seedPrefix,
    watermark: watermarks.get(sessionId),
  })
  foldEntries(daysA, collected.entries)
  seenA += collected.seen
  withUsageA += collected.withUsage
  for (const e of collected.entries) {
    const prev = watermarks.get(sessionId)
    if (prev === undefined || e.seq > prev) watermarks.set(sessionId, e.seq)
  }

  // ── B：独立复算（只看两种事件类型，直接累加）──
  // 继承前缀用本文件自己算的 seedBoundaryOf，不复用生产代码——两边口径一致
  // 但实现独立，任何一方漏掉 seed 边界都会在这里对不上。
  const seedBoundary = seedBoundaryOf(header, events)
  for (const ev of events) {
    if ((Number(ev.seq) || 0) < seedBoundary) continue
    const u = ev.data?.usage
    if (u === null || typeof u !== 'object' || u === undefined) continue
    const isChat = ev.type === 'assistant/message'
    const isCompaction = ev.type === 'compaction/summary'
    if (!isChat && !isCompaction) continue
    const input = Number(u.inputTokens) || 0
    const cr = Number(u.cacheReadTokens) || 0
    const cw = Number(u.cacheWriteTokens) || 0
    const out = Number(u.outputTokens) || 0
    const total = input + cr + cw + out
    totalsB.requests += 1
    totalsB.input += input
    totalsB.cacheRead += cr
    totalsB.cacheWrite += cw
    totalsB.output += out
    totalsB.reasoning += Number(u.reasoningTokens) || 0
    totalsB.total += total
    const day = localDayKey(ev.time)
    daysB.set(day, (daysB.get(day) ?? 0) + total)
  }
}

// ── 比较 ──────────────────────────────────────────────────────────────
const a = grandTotals(daysA)
const daysAFlat = new Map()
for (const [day, buckets] of daysA) {
  let sum = 0
  for (const b of buckets.values()) sum += b.totalTokens
  daysAFlat.set(day, sum)
}

const failures = []
const check = (label, x, y) => {
  const ok = x === y
  if (!ok) failures.push(`${label}: plugin=${x} independent=${y}`)
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}: plugin=${x} independent=${y}`)
}

console.log(`\nsession dirs: ${logs.size} | plugin sessions: ${sessionsA}`)
console.log(`generations read: v4=${genCounts[4] ?? 0} v0=${genCounts[0] ?? 0} | dirs with both: ${multiGen}`)
console.log(`assistant/compaction events seen=${seenA} withUsage=${withUsageA}\n`)
console.log('=== 全量合计交叉校验 ===')
check('requests', a.requests, totalsB.requests)
check('inputTokens', a.inputTokens, totalsB.input)
check('cacheReadTokens', a.cacheReadTokens, totalsB.cacheRead)
check('cacheWriteTokens', a.cacheWriteTokens, totalsB.cacheWrite)
check('outputTokens', a.outputTokens, totalsB.output)
check('reasoningTokens', a.reasoningTokens, totalsB.reasoning)
check('totalTokens', a.totalTokens, totalsB.total)

console.log('\n=== 逐日交叉校验 ===')
const allDays = [...new Set([...daysAFlat.keys(), ...daysB.keys()])].sort()
let dayMismatch = 0
for (const day of allDays) {
  const x = daysAFlat.get(day) ?? 0
  const y = daysB.get(day) ?? 0
  if (x !== y) { dayMismatch += 1; failures.push(`day ${day}: plugin=${x} independent=${y}`) }
}
console.log(`days compared: ${allDays.length} | mismatches: ${dayMismatch}`)

console.log('\n=== 每日用量（插件口径） ===')
for (const [day, total] of [...daysAFlat.entries()].sort()) {
  console.log(`  ${day}  ${String(total).padStart(12)}  (${(total / 1e6).toFixed(2)}M)`)
}

console.log(`\n结果: ${failures.length === 0 ? '全部一致 ✓' : `${failures.length} 处不一致 ✗`}`)
for (const f of failures.slice(0, 20)) console.log('  ' + f)
process.exitCode = failures.length === 0 ? 0 : 1
