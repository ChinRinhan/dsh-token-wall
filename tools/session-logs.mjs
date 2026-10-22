/**
 * 一个**只读**的 `sessionPersistence` 替身：直接读盘上的会话日志。
 *
 * 为什么需要它：host 半的回填逻辑依赖 `persistence.list()` / `open()` / `read()`。
 * 在 DSH 进程外无法拿到真服务，所以在测试里复现同一套契约（含 `inheritedEventCount`、
 * `header`、`events`），让 `backfill()` 走**完全相同的代码路径**。
 *
 * 关键行为与真实后端一致：
 * - 同一会话目录若存在 v0 与 v4 两代日志，只暴露**最高代**（运行时按最高代读取，
 *   否则同一批事件会被算两次）；
 * - `list()` 返回 `{ header, revision }` 快照；
 * - `open(id,'read')` 返回带 `header` / `inheritedEventCount` / `read()` / `close()`
 *   的句柄。
 *
 * 唯一的有意简化：这里模拟的是**旧一代** `sessionPersistence` 的句柄形状
 * （`open()` 返回带 `inheritedEventCount` 的句柄）。新一代（0.1.0-rc.6 起）没有
 * `open()`，也没有这个字段——分叉边界改为 `header.seedLength` 或日志里的
 * `session/end-seed` 事件，见 `lib/adapter.js`。
 *
 * ⚠️ 这个替身**不能**单独用来证明 fork 前缀处理是对的：它自己造了一个
 * `inheritedEventCount` 字段，而真实的新版根本没有。证明那条逻辑要靠
 * `test/adapter.test.mjs` 里两套形状的对照。
 *
 * 本机实测语料里 16 个子代理 fork 全是 `isSeeded=false`、自带从 0 开始的独立日志，
 * 因此它们的继承前缀就是 0——把 `delegationDepth` 当作前缀长度是**错的**
 * （那会把子会话自己的 seq 0 误判为继承）。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 解码「一个 zstd 帧 = 一批追加」的拼接文件。 */
export function decodeFrames(buf) {
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

/** 日志文件名的代次：`session.v4.jsonl.zstd` → 4，`session.jsonl.zstd` → 0。 */
function generationOf(filename) {
  const m = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(filename)
  if (m === null) return -1
  return m[1] === undefined ? 0 : Number(m[1])
}

/** 扫描会话根目录，每个会话目录只保留代次最高的日志。 */
function discover(root) {
  const found = new Map()
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(projectDir, entry.name)
      const logs = readdirSync(dir).filter((f) => f.endsWith('.jsonl.zstd'))
      if (logs.length === 0) continue
      const best = logs.slice().sort((a, b) => generationOf(b) - generationOf(a))[0]
      const path = join(dir, best)
      const text = decodeFrames(readFileSync(path))
      const lines = text.split('\n').filter((l) => l.trim())
      let header
      const events = []
      for (const line of lines) {
        let rec
        try { rec = JSON.parse(line) } catch { continue }
        if (rec.type === 'session') { header = rec; continue }
        events.push(rec)
      }
      if (header === undefined) continue
      found.set(header.id, { path, header, events, generation: generationOf(best) })
    }
  }
  return found
}

/** 构造一个符合 `sessionPersistence` 读侧契约的替身。 */
export async function makePersistence(root) {
  const sessions = discover(root)
  return {
    async list() {
      return [...sessions.values()].map((s) => ({
        header: s.header,
        revision: `rev-${s.generation}`,
        eventCount: s.events.length,
      }))
    },
    async open(id, access) {
      const s = sessions.get(id)
      if (s === undefined) throw new Error(`session not found: ${id}`)
      return {
        id,
        header: s.header,
        // 旧一代语义：fork 继承前缀的长度，只对 seeded 会话非零。
        // 新一代没有这个字段（adapter 会优先读 header.seedLength，退到
        // session/end-seed 事件）。保留它只是为了让回填走**旧版分支**。
        inheritedEventCount: s.header.isSeeded === true ? Number(s.header.inheritedEventCount ?? 0) : 0,
        async read() {
          return { eventState: 'detached', events: s.events }
        },
        async close() {},
      }
    },
  }
}

export { discover }
