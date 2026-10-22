/**
 * **宿主接口适配层**：把不同代 `sessionPersistence` 的形态收敛成一套内部契约。
 *
 * ## 为什么需要这一层
 *
 * 插件的回填曾经直接写死了一代接口：
 *
 * ```js
 * for (const snapshot of await persistence.list())      // 期望 {header, revision}
 *   handle = await persistence.open(id, 'read', {signal}) // 期望 open 存在
 *   inherited = handle.inheritedEventCount                // 期望这个字段存在
 * ```
 *
 * 同机的另一份 DSH（`0.1.0-rc.6`）三处都不成立：
 *
 * | 期望 | 实际（rc.6/rc.8） |
 * |---|---|
 * | `list()` → `{header, revision}[]` | **`SessionHeader[]`**（无包裹） |
 * | `open(id, 'read')` | **不存在**；只有 `load(id)` / `inspect(id)` / `readFrom(id, seq)` |
 * | `handle.inheritedEventCount` | **不存在**；只有 `header.seedLength` / `session.firstLiveSeq` / `session/end-seed` 事件 |
 *
 * 三处不匹配**全部静默**——`list()` 形状一变，`snapshot.header.id` 就是
 * `undefined`，回填返回 `sessions: 0`，一条日志都不留。已实测：
 *
 * ```
 * rc.8 真实形状   → sessions=0 entries=0 failed=0   ← 零警告
 * 旧形状          → sessions=1 entries=2 failed=0
 * ```
 *
 * 所以这一层的职责是：**先探测、再分支、认不出来就明说**。它不猜「应该」是什么
 * 形状，只按实际存在的成员名走，并把走的那条路报告出去（`probePersistence`
 * 的结果会进诊断区）。
 *
 * ## 为什么不直接 try/catch 兜一圈
 *
 * 「调用失败就当没有」会让真实故障与接口缺失混成一团。这里的取舍是：
 * **列表能力缺失 = 硬降级**（立刻返回并标注原因）；**读取能力缺失 = 逐会话失败**
 * （`failed` 计数照实累加）。两种都能在诊断区被看见。
 */

import { num } from './fold.js'

/** 列表能力的探测结果标签。 */
const LIST_KINDS = ['listSnapshots', 'list']
/** 读取能力的探测结果标签（按优先级）。 */
const READ_KINDS = ['load', 'open', 'readFrom']

/**
 * 探测宿主 persistence 实际支持哪些调用。
 *
 * @param persistence `ctx.sessionPersistence` 服务实例。
 * @returns `{ listKind, readKind, degraded }`。`degraded` 只在**列表能力缺失**
 *          （连会话都枚举不出来）时给出原因——读取能力缺失留给逐会话失败累计。
 */
export function probePersistence(persistence) {
  const has = (name) => typeof persistence?.[name] === 'function'
  const listKind = LIST_KINDS.find(has) ?? 'none'
  // `readFrom` 需要配合 `inspect` 使用，单有它不算完整读取能力。
  const readKind = has('load') ? 'load'
    : has('open') ? 'open'
      : (has('inspect') && has('readFrom')) ? 'readFrom' : 'none'
  return {
    listKind,
    readKind,
    degraded: listKind === 'none'
      ? `no list capability: neither listSnapshots() nor list() on sessionPersistence (${describe(persistence)})`
      : undefined,
  }
}

/** 诊断用：把对象上真正存在的 persistence 成员名列出来，便于远程排错。 */
function describe(persistence) {
  const names = ['list', 'listSnapshots', 'load', 'inspect', 'readFrom', 'open', 'append']
  const present = names.filter((n) => typeof persistence?.[n] === 'function')
  return present.length > 0 ? `found: ${present.join(', ')}` : 'found: (none)'
}

/**
 * 列出一份会话清单，元素统一成 `{ header, revision }`。
 *
 * 两种形状都要吃得下：
 * - `listSnapshots()` / 旧版 `list()` → `{ header, revision }[]`
 * - 新版 `list()` → `SessionHeader[]`（元素本身就是 header）
 *
 * 没有 `id` 的元素直接丢弃（不猜）。
 *
 * @param persistence 服务实例。
 * @param options.signal 取消信号。
 * @returns `{ header, revision }[]`
 * @throws 列表能力完全缺失时抛错（调用方应先看 `probePersistence`）。
 */
export async function listSessions(persistence, { signal } = {}) {
  const probe = probePersistence(persistence)
  if (probe.degraded !== undefined) throw new Error(probe.degraded)

  const raw = probe.listKind === 'listSnapshots'
    ? await persistence.listSnapshots({ signal })
    : await persistence.list({ signal })

  const rows = Array.isArray(raw) ? raw : []
  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    // 新版 list() 返回的就是 header；旧版是 {header, revision}。用 id 判别。
    const header = typeof row.header === 'object' && row.header !== null ? row.header : row
    if (typeof header?.id !== 'string' || header.id === '') continue
    out.push({ header, revision: row.revision })
  }
  return out
}

/**
 * 读一个会话的事件，并算出继承前缀长度。
 *
 * 读取路径按优先级退让：`load` → `open`（旧版句柄）→ `inspect` + `readFrom`。
 *
 * @param persistence 服务实例。
 * @param header 会话 header（来自 {@link listSessions}）。
 * @param options.signal 取消信号。
 * @returns `{ header, events, seedPrefix, close }`
 * @throws 读取能力完全缺失时抛错。
 */
export async function readSession(persistence, header, { signal } = {}) {
  const id = header?.id
  if (typeof id !== 'string' || id === '') throw new Error('readSession: header.id is required')

  let events = []
  let resolvedHeader = header
  let handle
  let close = async () => {}

  if (typeof persistence.load === 'function') {
    // rc.6+：`load(id)` 返回 { meta, events }。它不接受 signal，多传会被忽略。
    const loaded = await persistence.load(id)
    events = Array.isArray(loaded?.events) ? loaded.events : []
    resolvedHeader = loaded?.meta ?? loaded?.header ?? header
  } else if (typeof persistence.open === 'function') {
    // 旧版：open(id, 'read', {signal}) → 句柄。三参签名是老版本的契约。
    handle = await persistence.open(id, 'read', { signal })
    const read = await handle.read(undefined, undefined, { signal })
    events = Array.isArray(read?.events) ? read.events : []
    resolvedHeader = handle.header ?? header
    close = async () => {
      try {
        await handle?.close?.()
      } catch {
        // close 失败不影响已读到的数据。
      }
    }
  } else if (typeof persistence.inspect === 'function' && typeof persistence.readFrom === 'function') {
    const inspection = await persistence.inspect(id, signal)
    resolvedHeader = inspection?.meta ?? header
    const read = await persistence.readFrom(id, 0, signal)
    events = Array.isArray(read?.events) ? read.events : []
  } else {
    throw new Error(`no read capability on sessionPersistence (${describe(persistence)})`)
  }

  const seedPrefix = seedPrefixOf({ header: resolvedHeader, handle, events })
  return { header: resolvedHeader, events, seedPrefix, close }
}

/**
 * 算出「继承前缀」的长度：`seq < seedPrefix` 的事件是 fork/replay 从父会话带来的，
 * 父会话已计过一次，不能再算。
 *
 * 三条来源，按可信度排序：
 *
 * 1. `header.seedLength` —— 持久化层写进 header 的**durable** 分叉边界（最权威）；
 * 2. `handle.inheritedEventCount` —— 旧版句柄字段（本机 desktop 那一代）；
 * 3. 日志里**最后一个** `session/end-seed` 事件的 `seq + 1` —— 新版把分叉边界
 *    投影成日志事件（见 `dsh-session` 的 `firstLiveSeq` 说明：定位最后一个，
 *    不一定是某个特定 seq）。
 *
 * 都没有 ⇒ 0（不是 fork，全部是自有事件）。
 *
 * ⚠️ 这里必须接受 `header.seedLength === 0`：它表示「明确没有 seed」，此时
 * 不该再往下看事件标记（否则会把一次正常的 `end-seed` 误判成继承前缀）。
 *
 * @param input.header 会话 header（可能带 `seedLength`）。
 * @param input.handle 旧版句柄（可能带 `inheritedEventCount`）。
 * @param input.events 该会话的事件数组。
 * @returns 非负整数。
 */
export function seedPrefixOf({ header, handle, events } = {}) {
  if (typeof header?.seedLength === 'number' && Number.isFinite(header.seedLength)) {
    return Math.max(0, Math.trunc(header.seedLength))
  }
  if (typeof handle?.inheritedEventCount === 'number' && Number.isFinite(handle.inheritedEventCount)) {
    return Math.max(0, Math.trunc(handle.inheritedEventCount))
  }
  if (Array.isArray(events)) {
    let last = -1
    for (const event of events) {
      if (event?.type !== 'session/end-seed') continue
      const seq = num(event.seq)
      if (seq > last) last = seq
    }
    if (last >= 0) return last + 1
  }
  return 0
}

/**
 * 实时路径的继承前缀：优先旧字段，退到 `session.firstLiveSeq`。
 *
 * `firstLiveSeq` 是进程内的构造事实（构造 seed 的长度），在**实时**这条路上比
 * 持久化 header 更准确——见 `dsh-session` 里对该字段的说明。
 *
 * @param session live 的 Session 实例。
 * @returns 非负整数。
 */
export function liveSeedPrefixOf(session) {
  if (typeof session?.inheritedEventCount === 'number' && Number.isFinite(session.inheritedEventCount)) {
    return Math.max(0, Math.trunc(session.inheritedEventCount))
  }
  if (typeof session?.firstLiveSeq === 'number' && Number.isFinite(session.firstLiveSeq)) {
    return Math.max(0, Math.trunc(session.firstLiveSeq))
  }
  return 0
}
