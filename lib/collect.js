/**
 * 从会话事件里提取用量，并驱动历史回填。
 *
 * ## 唯一的入账判据
 *
 * 每个 `assistant/message` 事件只有在**同时**满足三条时才入账：
 *
 * 1. `event.data.usage` 存在（没上报就不写 0，见 fold.js 的口径说明）；
 * 2. `event.seq > watermark[sessionId]`（水位线，保证不重复计数）；
 * 3. `event.seq >= inheritedEventCount`（**fork 继承前缀**，见下）。
 *
 * ## 为什么第 3 条是必需的
 *
 * fork / resume 出来的会话，其日志前缀是**从父会话继承**的——那些 `assistant/message`
 * 事件在父会话里已经计过一次。`SessionHandle.inheritedEventCount` 精确给出继承前缀
 * 的长度，因此「只算 `seq >= inheritedEventCount` 的自有事件」是避免把父会话用量
 * 重复算进子会话的**正确且唯一**的判据。
 *
 * 注意水位线**不能**替代它：水位线是按 sessionId 分开存的，子会话有自己的水位线，
 * 光靠水位线会把继承前缀当成子会话的新事件照单全收。
 *
 * ## 为什么用会话日志而不是 `llm/stream`
 *
 * `assistant/message` 的 usage 是**持久化**的，所以「历史回填」与「实时捕获」读的是
 * **同一份数据**，不存在两套口径漂移。`llm/stream` 能看到更多调用（压缩、标题生成），
 * 但 `GenerateOptions.purpose` 不落进日志，无法区分来源；引入它会立刻带来「同一笔
 * 调用被两条路径各记一次」的双写风险。第一版只用日志这一条路径。
 */

import { makeEntry, num, sessionScopeOf } from './fold.js'
import { listSessions, liveSeedPrefixOf, probePersistence, readSession } from './adapter.js'

/**
 * 从一个事件提取待入账记录；不满足条件返回 undefined。
 *
 * ## 处理的事件类型（两种，都真实花 token）
 *
 * | 事件 | kind | 路由字段 |
 * |---|---|---|
 * | `assistant/message` | `chat` | `data.message.source.{provider,model}` |
 * | `compaction/summary` | `aux` | `data.{provider,model}` |
 *
 * **为什么必须包含压缩**：压缩是一次真实的模型调用，它的事件**不是**
 * `assistant/message`，只读后者会静默漏掉它。本机实测历史里有 2 次压缩共
 * 613,328 tokens——漏掉它会让「累计用量」明显偏低。
 *
 * `session/title-llm-request` 只记录请求、**不带 usage**，因此无法入账（如实说明：
 * 标题生成的开销无法从日志恢复）。
 *
 * @param sessionId           会话 id。
 * @param header              会话 header（判定 main/sub 归属，并取 `cwd` 作工作区）。
 * @param event               会话事件。
 * @param inheritedEventCount 继承前缀长度（fork 场景下 > 0）。
 */
export function entryFromEvent({ sessionId, header, event, inheritedEventCount = 0 }) {
  if (event === null || typeof event !== 'object') return undefined

  const seq = num(event.seq)
  if (seq < num(inheritedEventCount)) return undefined // 继承前缀：父会话已计过

  const scope = sessionScopeOf(header)
  // 工作区 = 会话的 cwd。**实时与回填都从同一处取**，所以两条路径的口径不会漂移。
  // 拿不到（老日志缺 cwd / 非会话来源）就留空，聚合时归为「未标注」。
  const workspace = typeof header?.cwd === 'string' ? header.cwd : ''

  if (event.type === 'assistant/message') {
    const usage = event.data?.usage
    if (usage === null || typeof usage !== 'object') return undefined
    const source = event.data?.message?.source
    return makeEntry({
      sessionId,
      seq,
      time: num(event.time),
      provider: source?.provider ?? '',
      model: source?.model ?? '',
      workspace,
      scope,
      kind: 'chat',
      usage,
    })
  }

  if (event.type === 'compaction/summary') {
    const usage = event.data?.usage
    if (usage === null || typeof usage !== 'object') return undefined
    return makeEntry({
      sessionId,
      seq,
      time: num(event.time),
      provider: event.data?.provider ?? '',
      model: event.data?.model ?? '',
      workspace,
      scope,
      kind: 'aux',
      usage,
    })
  }

  return undefined
}

/** 会带 usage 的事件类型（回填与实时共用，避免两处清单漂移）。 */
export const USAGE_EVENT_TYPES = ['assistant/message', 'compaction/summary']

/**
 * 从一个会话的全部事件里提取待入账记录（已按水位线过滤）。
 *
 * @returns `{ entries, seen, withUsage, skippedByWatermark }`，其中 `seen` 是**自有
 *          事件**里可能带 usage 的事件总数，`withUsage` 是其中真的带了 usage 的数量
 *          ——两者的差就是「没测到用量」的调用数，作为诊断读数暴露出去。
 */
export function collectSessionEntries({ sessionId, header, events, inheritedEventCount = 0, watermark }) {
  const entries = []
  let seen = 0
  let withUsage = 0
  let skippedByWatermark = 0
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    if (!USAGE_EVENT_TYPES.includes(event.type)) continue
    const seq = num(event.seq)
    if (seq < num(inheritedEventCount)) continue
    seen += 1
    const usage = event.data?.usage
    if (usage === null || typeof usage !== 'object') continue
    withUsage += 1
    if (watermark !== undefined && seq <= num(watermark)) {
      skippedByWatermark += 1
      continue
    }
    const entry = entryFromEvent({ sessionId, header, event, inheritedEventCount })
    if (entry !== undefined) entries.push(entry)
  }
  return { entries, seen, withUsage, skippedByWatermark }
}

/**
 * 取会话的工作区标识（`cwd`）。
 *
 * ## 为什么需要 fallback
 *
 * 首选 `header.cwd`——它同时覆盖**回填**（`persistence.open()` 返回的 handle
 * 带 header）和**实时**（`session/event` 传的是已构造的 Session，header 已设置）。
 *
 * 但实时路径上实测有一部分事件拿不到 cwd：最终落到 `workspace: ''`（未标注）。
 * 本机实测 305 万 token 的当前会话就是这样进来的——那是实时捕获的主路径，
 * 不是边缘情况。
 *
 * 所以这里加 fallback：`session.cwd`（若运行时把它直接挂在 Session 上）。
 * 取不到就返回空串，由聚合层归为「未标注」——**不猜**、不用会话 id 冒充。
 *
 * @param header 会话 header（可能没有 cwd）。
 * @param session live 路径传进来的 Session 对象（可能带 cwd）。
 */
export function workspaceOf(header, session) {
  if (typeof header?.cwd === 'string' && header.cwd !== '') return header.cwd
  if (typeof session?.cwd === 'string' && session.cwd !== '') return session.cwd
  return ''
}

/**
 * 实时事件的入账判据（与回填共用水位线，因此不可能重复）。
 *
 * 继承前缀走 {@link liveSeedPrefixOf}：旧字段在，用旧字段；否则退到
 * `session.firstLiveSeq`（新版把 fork 边界放在这里）。直接读
 * `session.inheritedEventCount` 在 rc.6 起会拿到 `undefined` → `num()` 归 0
 * → **fork 继承前缀被照单全收**，同一批 token 在父会话与子会话各计一次。
 */
export function entryFromLiveEvent({ session, event, store }) {
  if (session === null || typeof session !== 'object') return undefined
  const sessionId = session.id
  const seq = num(event?.seq)
  if (!store.shouldCount(sessionId, seq)) return undefined
  return entryFromEvent({
    sessionId,
    header: {
      ...session.header,
      // header.cwd 缺失时用 session.cwd 兜底（见 workspaceOf 的说明）。
      cwd: workspaceOf(session.header, session),
    },
    event,
    inheritedEventCount: liveSeedPrefixOf(session),
  })
}

/**
 * 历史回填：遍历所有已存会话，把尚未入账的用量并进 store。
 *
 * ## 设计取舍
 *
 * - **顺序执行**，不并发：会话数量在数百量级，串行读盘足够快，且避免同时打开大量
 *   文件句柄。回填是启动期一次性工作，不占用推理路径。
 * - **单会话失败不中断**：某个日志损坏只记日志并跳过——统计型数据不值得阻断启动。
 * - **可取消**：调用方传 `signal`，profile 卸载时能及时收手。
 * - **幂等**：重复运行只会入账水位线之后的新事件，所以「每次启动都回填」是安全的，
 *   也让「运行期间产生的会话」在下次启动时被补上。
 * - **接口不匹配必须可见**：宿主 `sessionPersistence` 的形状换过代（见
 *   `lib/adapter.js`），曾经这里写死 `list()` 返回 `{header}`、并且调 `open()`，
 *   在新版上会**静默**返回 `sessions: 0`。现在读不出来就落 `degraded`，
 *   由诊断区如实展示，绝不假装成功。
 *
 * @returns 统计摘要，供诊断日志与 UI 展示。`degraded` 非空表示「这次回填不可信」，
 *          可能是列表/读取能力缺失，或列表调用本身失败。
 */
export async function backfill({ persistence, store, logger, signal, onProgress } = {}) {
  const summary = {
    sessions: 0,
    failed: 0,
    entries: 0,
    assistantMessages: 0,
    withUsage: 0,
    skippedByWatermark: 0,
    /** undefined = 正常；字符串 = 降级原因（诊断区会显示它）。 */
    degraded: undefined,
  }
  if (persistence === undefined || store === undefined) return summary

  // 先探测：连会话都枚举不出来时立刻收手，并把「为什么」带回去。
  const probe = probePersistence(persistence)
  if (probe.degraded !== undefined) {
    summary.degraded = probe.degraded
    logger?.warn?.(`[token-usage] 历史回填不可用：${probe.degraded}`)
    return summary
  }

  let snapshots
  try {
    snapshots = await listSessions(persistence, { signal })
  } catch (error) {
    // 列表失败（权限、编码不匹配、跨目录同 id 等）——如实标注，不静默归零。
    const reason = String(error?.message ?? error)
    summary.degraded = `list failed: ${reason}`
    logger?.warn?.(`[token-usage] 列出会话失败，本次不回填历史: ${reason}`)
    return summary
  }

  for (const snapshot of snapshots) {
    if (signal?.aborted === true) break
    const sessionId = snapshot?.header?.id
    if (typeof sessionId !== 'string' || sessionId === '') continue
    summary.sessions += 1

    let read
    try {
      read = await readSession(persistence, snapshot.header, { signal })
      const watermark = store.watermarkOf?.(sessionId)
      const collected = collectSessionEntries({
        sessionId,
        header: read.header ?? snapshot.header,
        events: read.events,
        inheritedEventCount: read.seedPrefix,
        watermark,
      })
      for (const entry of collected.entries) store.fold(entry)
      summary.entries += collected.entries.length
      summary.assistantMessages += collected.seen
      summary.withUsage += collected.withUsage
      summary.skippedByWatermark += collected.skippedByWatermark
    } catch (error) {
      // 单会话失败不中断整体回填（损坏 / 读取竞态 / 未物化）。
      summary.failed += 1
      logger?.warn?.(`[token-usage] 回填会话 ${sessionId} 失败，已跳过: ${String(error)}`)
    } finally {
      try {
        await read?.close?.()
      } catch {
        // close 失败不影响已入账的数据。
      }
    }
    onProgress?.(summary)
  }

  // 读取能力完全缺失时，每个会话都会失败——把根因也带上，免得只看到「N 个失败」。
  if (probe.readKind === 'none') {
    summary.degraded = `no read capability: load() / open() / inspect()+readFrom() all missing (found: ${probe.listKind} only)`
    logger?.warn?.(`[token-usage] ${summary.degraded}`)
  }

  return summary
}
