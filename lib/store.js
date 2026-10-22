/**
 * 日聚合的持久化。
 *
 * ## 文件位置与形态
 *
 * `$DSH_HOME/token-usage/daily.json`：
 *
 * ```json
 * {
 *   "schema": "dsh-token-usage/daily/v1",
 *   "days": { "2026-10-12": { "main|workbuddy|deepseek-v4.1-flash": { …合计… } } },
 *   "watermarks": { "session-abc": 412 }
 * }
 * ```
 *
 * **独立文档**，不进 `state.json`：state.json 会被别的插件/旧版本整体重写，它不认识
 * 的键会被静默抹掉（本仓库 `permanent-lock-store.ts` 记录过同类事故）。
 *
 * ## 为什么「水位线」让重复计数结构上不可能
 *
 * 会话日志 append-only，`seq` 从 0 连续且**永不重写**。因此「该会话已计数的最大
 * seq」这一个数就是完备的去重状态：
 *
 * - 历史回填：只入账 `seq > watermark` 的事件；
 * - 实时捕获：同样只入账 `seq > watermark`。
 *
 * 两条路径共用同一个水位线，所以**无论它们以什么顺序、交叠多少次运行，每条事件
 * 最多入账一次**。重启也不重算（水位线在盘上），所以文件只增不改——即使某个会话
 * 日志后来被删除，它已经贡献过的历史也不会丢。
 *
 * ## 增量合并写（不是整体覆盖）
 *
 * `flush()` 是「重读盘 → 只把**相对本实例上次落盘基线的增量**加上去 → 原子写」。
 * 整体覆盖只在单实例下安全：两个实例并存时（fiber 重启交错、同机多 profile 共享
 * 同一 home）各自内存视图独立，谁后写谁抹掉对方。增量写让两边都保留。
 *
 * ⚠️ **已知限制（如实记录，未修）**：`flush()` 的「读 → 改 → 写」不是跨进程原子
 * 操作，两个**真实进程**密集并发写时后写者可能基于陈旧快照覆盖。DSH 桌面通常
 * 单进程单 profile，影响面有限；根治需要文件锁或改追加日志形态，超出本次范围。
 *
 * ## 落盘节流
 *
 * 记账在推理关键路径上，每笔都同步写盘会把「一次推理」变成「一次磁盘写」。默认
 * 2 秒防抖；窗口内崩溃最多丢最近 2 秒的计数——对统计型数据是可接受的精度损失。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  emptyTotals,
  foldEntry,
  localDayKey,
  mergeWatermarks,
  num,
  pruneDays,
  shiftDayKey,
} from './fold.js'

/** 落盘 schema 标识（供未来迁移识别）。 */
export const SCHEMA = 'dsh-token-usage/daily/v1'

/** 落盘节流窗口（毫秒）。 */
export const FLUSH_DEBOUNCE_MS = 2000

/** 合计对象的字段（读写共用一份清单，避免加字段时漏改一处）。 */
const TOTAL_FIELDS = [
  'requests',
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
]

/** 把一个桶的原始 JSON 值钳制成合计对象（脏数据不致命，但不能 NaN）。 */
function toTotals(raw) {
  const out = emptyTotals()
  if (raw === null || typeof raw !== 'object') return out
  for (const k of TOTAL_FIELDS) out[k] = num(raw[k])
  return out
}

/** 深拷贝日聚合表（桶对象也复制，避免与基线共享引用）。 */
function cloneDays(days) {
  const out = new Map()
  for (const [day, buckets] of days) {
    out.set(day, new Map([...buckets].map(([k, v]) => [k, { ...v }])))
  }
  return out
}

/** 逐字段相减（增量 = 当前 − 基线），负数钳 0 防倒挂。 */
function subtractTotals(current, base) {
  const out = emptyTotals()
  let any = false
  for (const k of TOTAL_FIELDS) {
    const d = Math.max(0, num(current[k]) - num(base?.[k]))
    out[k] = d
    if (d !== 0) any = true
  }
  // 全 0 增量返回 undefined：调用方据此**跳过**该桶。
  // 否则「外部删掉的日键」会被重建成全 0 桶，造成静默数据丢失。
  return any ? out : undefined
}

/** 逐字段相加（两个桶合并）。 */
function addTotalsRaw(a, b) {
  const out = emptyTotals()
  for (const k of TOTAL_FIELDS) out[k] = num(a[k]) + num(b[k])
  return out
}

/** 解析盘上的 JSON 为 `{ days, watermarks }`；损坏一律按空表处理（不阻断启动）。 */
function parseDocument(text) {
  const days = new Map()
  const watermarks = new Map()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { days, watermarks }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { days, watermarks }

  const rawDays = parsed.days
  if (rawDays !== null && typeof rawDays === 'object' && !Array.isArray(rawDays)) {
    for (const [day, rawBuckets] of Object.entries(rawDays)) {
      if (rawBuckets === null || typeof rawBuckets !== 'object' || Array.isArray(rawBuckets)) continue
      const buckets = new Map()
      for (const [key, rawTotals] of Object.entries(rawBuckets)) buckets.set(key, toTotals(rawTotals))
      if (buckets.size > 0) days.set(day, buckets)
    }
  }

  const rawMarks = parsed.watermarks
  if (rawMarks !== null && typeof rawMarks === 'object' && !Array.isArray(rawMarks)) {
    for (const [id, seq] of Object.entries(rawMarks)) {
      const n = num(seq)
      if (id !== '' && n > 0) watermarks.set(id, n)
    }
  }
  return { days, watermarks }
}

/**
 * 内存后端：无法定位 DSH home 时的显式降级（数据仍可用，只是重启即丢）。
 */
class MemoryStore {
  constructor() {
    this.days = new Map()
    this.watermarks = new Map()
  }
  /** 该会话已计数的最大 seq；从未计过返回 undefined。 */
  watermarkOf(sessionId) {
    return this.watermarks.get(String(sessionId))
  }

  /** 该 `(sessionId, seq)` 是否尚未入账。 */
  shouldCount(sessionId, seq) {
    const mark = this.watermarkOf(sessionId)
    return mark === undefined || num(seq) > mark
  }

  fold(entry) {
    foldEntry(this.days, entry)
    this.watermarks.set(entry.sessionId, num(entry.seq))
  }

  flush() {}

  describe() {
    return { kind: 'memory', path: undefined }
  }
}

/**
 * 文件后端：原子写 + 节流 + 增量合并。
 */
class FileStore {
  constructor(path, logger, { keepDays }) {
    this.path = path
    this.logger = logger
    this.keepDays = keepDays
    this.timer = undefined
    this.dirty = false

    const loaded = this.readFile()
    this.days = loaded.days
    this.watermarks = loaded.watermarks
    // 落盘基线：上次成功写盘时的内存快照。**只有 days 需要基线**——
    // 水位线是单调取 max 的（幂等合并），不需要算增量。
    this.written = cloneDays(this.days)
  }

  /** 读盘。返回空表表示无盘/损坏/不存在。 */
  readFile() {
    try {
      if (!existsSync(this.path)) return { days: new Map(), watermarks: new Map() }
      return parseDocument(readFileSync(this.path, 'utf-8'))
    } catch (error) {
      this.logger?.warn?.(`[token-usage] 读取 ${this.path} 失败，历史用量按空表处理: ${String(error)}`)
      return { days: new Map(), watermarks: new Map() }
    }
  }

  /** 该会话已计数的最大 seq；从未计过返回 undefined。 */
  watermarkOf(sessionId) {
    return this.watermarks.get(String(sessionId))
  }

  /** 该 `(sessionId, seq)` 是否尚未入账——回填与实时共用这一个判据。 */
  shouldCount(sessionId, seq) {
    const mark = this.watermarkOf(sessionId)
    return mark === undefined || num(seq) > mark
  }

  /** 入账一条并前移水位线（内存即时，落盘节流）。 */
  fold(entry) {
    foldEntry(this.days, entry)
    this.watermarks.set(entry.sessionId, num(entry.seq))
    this.scheduleFlush()
  }

  /** 节流落盘：窗口内首笔启动计时器，到点刷盘；期间新写入标记 dirty 再刷一轮。 */
  scheduleFlush() {
    if (this.timer !== undefined) {
      this.dirty = true
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.flush()
      } finally {
        if (this.dirty) {
          this.dirty = false
          this.scheduleFlush()
        }
      }
    }, FLUSH_DEBOUNCE_MS)
    // unref：落盘不该拖住进程退出（非 Node 环境没有 unref）。
    this.timer.unref?.()
  }

  /**
   * 立即落盘：把「本实例相对上次基线的增量」合并进盘上**当前**内容。
   *
   * 步骤：① 重读盘（别的实例可能刚写过）→ ② 逐桶只加增量、跳过零增量 →
   * ③ 原子写（tmp + rename）→ ④ 基线前移（仅在写盘成功后）。
   */
  flush() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const merged = this.readFile()

      let hasDelta = false
      for (const [day, buckets] of this.days) {
        const base = this.written.get(day)
        for (const [key, totals] of buckets) {
          const delta = subtractTotals(totals, base?.get(key))
          if (delta === undefined) continue // 本次无新增量 ⇒ 不碰盘上这一桶
          hasDelta = true
          let target = merged.days.get(day)
          if (target === undefined) {
            target = new Map()
            merged.days.set(day, target)
          }
          const existing = target.get(key)
          target.set(key, existing === undefined ? delta : addTotalsRaw(existing, delta))
        }
      }

      // 水位线单调取 max，直接并入即可（幂等，无需增量）。
      const marksBefore = merged.watermarks.size
      mergeWatermarks(merged.watermarks, this.watermarks)
      const marksChanged = merged.watermarks.size !== marksBefore
        || [...this.watermarks].some(([id, seq]) => merged.watermarks.get(id) !== seq)

      // 淘汰过老日键（在写之前，让盘上文件本身收敛）。
      const pruned = pruneDays(merged.days, { keepDays: this.keepDays })

      // 无任何新增量且无水位线变化 ⇒ 直接返回，不重写文件。
      // 避免无谓的「全量读 + parse + stringify + 原子写」同步阻塞事件循环。
      if (!hasDelta && !marksChanged) return

      const payload = {
        schema: SCHEMA,
        days: Object.fromEntries(
          [...pruned].sort(([a], [b]) => a.localeCompare(b)).map(([day, buckets]) => [
            day,
            Object.fromEntries([...buckets].sort(([a], [b]) => a.localeCompare(b))),
          ]),
        ),
        watermarks: Object.fromEntries([...merged.watermarks].sort(([a], [b]) => a.localeCompare(b))),
      }

      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8')
      renameSync(tmp, this.path)

      // 保留期必须**同时**作用于内存表：
      //
      // 早先只对写出的 `merged.days` 做 pruneDays，`this.days` 永不过期，于是
      // 「累计」（读内存）比盘上的量更大，重启后数字下跌——正是本插件最不能
      // 接受的失效模式，只是延迟到保留期到期那天才发作。
      //
      // ⚠️ 顺序不能反：必须在下面 `this.written = cloneDays(this.days)` **之前**
      // 剪，否则基线里还留着被剪掉的天，下次 flush 会把它们当成「全新增量」
      // 重新写回盘，保留期等于失效。
      const kept = pruneDays(this.days, { keepDays: this.keepDays })
      if (kept !== this.days) this.days = kept

      // 基线前移（只在写盘成功后）。
      this.written = cloneDays(this.days)
    } catch (error) {
      // 落盘失败只记日志：账本还有内存兜底，绝不能反噬推理。
      this.logger?.warn?.(`[token-usage] 写入 ${this.path} 失败（本次统计不入盘）: ${String(error)}`)
    }
  }

  /** 取消未决的节流计时器（dispose 用；不落盘——调用方自己决定是否 flush）。 */
  cancelPending() {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  describe() {
    return { kind: 'file', path: this.path }
  }
}

/**
 * 打开日聚合存储。
 *
 * @param options.home      DSH home 绝对路径；缺失时降级为纯内存。
 * @param options.keepDays  保留天数（落盘时淘汰更早的日键）；<= 0 不淘汰。
 * @param options.logger    可选 logger（`warn` 会被调用）。
 */
export function openStore({ home, keepDays = 400, logger } = {}) {
  if (typeof home !== 'string' || home.trim() === '') {
    logger?.warn?.('[token-usage] 无法定位 DSH home，Token 用量仅存在于内存中（重启即丢）')
    return new MemoryStore()
  }
  const path = join(home, 'token-usage', 'daily.json')
  return new FileStore(path, logger, { keepDays })
}

/** 供测试与诊断：读取一份文档文本为 `{ days, watermarks }`。 */
export function parseStoreDocument(text) {
  const doc = parseDocument(text)
  // schema 原样带出：迁移工具（tools/migrate-workspace.mjs）要按同样的
  // schema 重写文件，拿不到它就会把 `schema` 字段写成 undefined——而
  // `JSON.stringify` 会**直接丢掉**值为 undefined 的键，于是盘上文件少了
  // schema，下一次 flush 的增量合并还能跑，但版本标识没了，未来迁移无法识别。
  let schema
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.schema === 'string') {
      schema = parsed.schema
    }
  } catch {
    // 损坏的 JSON：parseDocument 已按空表处理，这里不重复报错。
  }
  return { ...doc, schema }
}

export { MemoryStore, FileStore }

/** 保留期淘汰的辅助（测试用）：给定「今天」，算出保留窗口起点日键。 */
export function retentionCutoffDay(keepDays, now = Date.now()) {
  return shiftDayKey(localDayKey(now), -(num(keepDays) - 1))
}
