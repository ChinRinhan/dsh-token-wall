/**
 * 纯聚合逻辑：日键、分桶、区间汇总。
 *
 * ## 为什么单独成文件
 *
 * 这一层是**纯函数**——不读盘、不写盘、不订阅事件。所有口径（日界、合计定义、
 * 周/月归属、水位线去重）都收敛在这里，因此可以被单测穷举边界，也可以在
 * 回填脚本里被独立复算。host 半只负责「把事件喂进来」和「把结果送出去」。
 *
 * ## 合计口径（重要，写进 UI 也写进注释，避免两处漂移）
 *
 * dsh 的 `TokenUsage` 把输入拆成三段：`inputTokens` 是**未命中缓存**的输入，
 * `cacheReadTokens` / `cacheWriteTokens` 是缓存读写。本模块的 `totalTokens`
 * 定义为四段之和：
 *
 * ```
 * totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
 * ```
 *
 * 即「这次调用实际过了一遍的 token 总量」。它与 `TokenUsage.totalTokens`（provider
 * 上报值，通常只是 input+output）**不是一回事**，所以本模块不读那个字段，只按
 * 上述定义自算——避免把「上游报了什么」和「我们统一定义什么」混成一个数。
 * `outputTokens` 按 dsh 口径**已含思考 token**，`reasoningTokens` 只作为拆分项
 * 单独存，不重复计入合计。
 *
 * ## 计数范围
 *
 * 只统计**带 usage 的** `assistant/message` 事件。没带 usage 的调用（中断、上游
 * 提前断开、请求失败）**不写 0**，而是根本不入桶——「没测到」与「确实是 0」必须
 * 可区分（与仓库既有 token-ledger 同一条纪律）。覆盖率作为诊断计数单独记录。
 */

/** 桶键分隔符。 */
const SEP = '|'

/**
 * 聚合行的主键分隔符。
 *
 * ⚠️ 与桶键的 `SEP` **分开**：桶键是落盘格式（含 workspace 等 5 段），
 * 而聚合行的 key 只是内存里的分组标识。混用会让「加了桶键维度」意外影响
 * 聚合行分组（实测踩过：加 workspace 进桶键后，providerModel 分组把同一
 * 渠道同一模型拆成了多行）。
 */
const ROW_SEP = '\u0000'

/** 数值字段统一钳制：非有限值 / 负数 → 0，截断小数。 */
export function num(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/**
 * 本机**本地时区**的日键（`YYYY-MM-DD`）。
 *
 * 用 `getFullYear/getMonth/getDate`（本地）而非 UTC 换算——用户在设置里明确选了
 * 「本机本地时区」，作息直觉以午夜换日为准。注意本仓库另一个插件（token-ledger）
 * 用的是 UTC+8 算术，那是因为它要对齐渠道每日额度结算时区；本插件不对齐额度，
 * 对齐的是用户看表的直觉，两者口径**有意不同**。
 */
export function localDayKey(ts) {
  const d = new Date(ts)
  if (!Number.isFinite(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 日键字符串 → 该日 00:00 本地时间的 Date（用本地构造器，不经过 UTC 解析）。 */
export function dayKeyToDate(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '')
  if (m === null) return undefined
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(d.getTime()) ? d : undefined
}

/** 日键加减天数（用本地日历算术，跨夏令时不会漂）。 */
export function shiftDayKey(day, deltaDays) {
  const d = dayKeyToDate(day)
  if (d === undefined) return ''
  d.setDate(d.getDate() + deltaDays)
  return localDayKey(d.getTime())
}

/** 两个日键相差的天数（`a - b`）。 */
export function diffDays(a, b) {
  const da = dayKeyToDate(a)
  const db = dayKeyToDate(b)
  if (da === undefined || db === undefined) return 0
  return Math.round((da.getTime() - db.getTime()) / 86400000)
}

/**
 * ISO 周键（`YYYY-Www`）。
 *
 * 按 ISO-8601：周一为一周首日，含该年第一个周四的那一周为第 1 周。用 UTC 构造
 * 纯日期再算，避免本地时区在跨年边界上把周归属挪错一天。
 */
export function isoWeekKey(day) {
  const d = dayKeyToDate(day)
  if (d === undefined) return ''
  const t = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const date = new Date(t)
  // ISO 周：把周四定为本年的锚点。
  const dayNum = (date.getUTCDay() + 6) % 7 // 周一=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000))
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

/** 月键（`YYYY-MM`）。 */
export function monthKeyOf(day) {
  return typeof day === 'string' && day.length >= 7 ? day.slice(0, 7) : ''
}

/** 按粒度取周期键。`day` 粒度直接返回日键。 */
export function periodKeyOf(day, granularity) {
  switch (granularity) {
    case 'week': return isoWeekKey(day)
    case 'month': return monthKeyOf(day)
    default: return day
  }
}

/** 空合计。所有字段都是可加的累加器。 */
export function emptyTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

/** 把一份 usage 累加进合计（usage 必须存在——调用方负责过滤）。 */
export function addUsage(totals, usage) {
  const input = num(usage?.inputTokens)
  const cacheRead = num(usage?.cacheReadTokens)
  const cacheWrite = num(usage?.cacheWriteTokens)
  const output = num(usage?.outputTokens)
  totals.requests += 1
  totals.inputTokens += input
  totals.cacheReadTokens += cacheRead
  totals.cacheWriteTokens += cacheWrite
  totals.outputTokens += output
  totals.reasoningTokens += num(usage?.reasoningTokens)
  totals.totalTokens += input + cacheRead + cacheWrite + output
  return totals
}

/** 两个合计相加（返回新对象，不改入参）。 */
export function addTotals(a, b) {
  const out = emptyTotals()
  for (const k of Object.keys(out)) out[k] = num(a?.[k]) + num(b?.[k])
  return out
}

/**
 * 桶键：`scope|kind|workspace|provider|model`，共五段。
 *
 * ## 为什么 scope 与 kind 是两个维度而不是一个
 *
 * `scope`（`main` / `sub`）回答「谁发起的」，`kind`（`chat` / `aux`）回答「是不是
 * 辅助调用」。二者**正交**：子会话里的压缩仍然既是 sub 又是 aux。合成一个字段就
 * 无法独立过滤——用户可能想看「含子会话但不含辅助调用」，或反过来。四个字段让两个
 * 开关各管一维，互不干扰。
 *
 * ## 为什么 workspace 放在第 3 段（新增）
 *
 * 回答「哪个工作区烧得最多」。它和 scope/kind 三者两两正交，所以也必须是独立一段
 * ——合成任何一个字段都会失去一个独立开关。
 *
 * ## ⚠️ 段数兼容（旧数据必须继续可读）
 *
 * 盘上的历史文件是 **4 段**的（`scope|kind|provider|model`）。如果只认 5 段，
 * 旧文件里的几百 MB 数据会被当成脏数据整体跳过，累计瞬间跌到 0——这正是本插件
 * 最不能接受的失效模式（用户看到「token 归零」）。
 *
 * 因此这里**同时写 5 段、读 4 或 5 段**：
 *
 * - 读 4 段 → `workspace: ''`（未标注）；
 * - 读 5 段 → 正常解析；
 * - 其它段数 → undefined（真的脏数据，跳过）。
 *
 * 实测里 2.97B tokens 全是 4 段旧数据，靠这条规则它们全部继续可用，只是工作区一栏
 * 显示「未标注」。本机已跑过 `tools/rehearse.mjs` 回填，之后新写入的都是 5 段。
 *
 * 值里的分隔符做转义，保证 `split` 的段数恒定。
 */
export function bucketKeyOf({ scope, kind, workspace, provider, model }) {
  const esc = (s) => String(s ?? '').replaceAll(SEP, '/')
  const s = scope === 'sub' ? 'sub' : 'main'
  const k = kind === 'aux' ? 'aux' : 'chat'
  const w = esc(workspace)
  return `${s}${SEP}${k}${SEP}${w}${SEP}${esc(provider)}${SEP}${esc(model)}`
}

/** 未标注工作区：旧 4 段数据与非会话来源。 */
export const UNKNOWN_WORKSPACE = ''

/**
 * 解析桶键为结构化字段；段数不对返回 undefined（脏数据不致命，跳过即可）。
 *
 * **四种合法段数**：4（历史）/ 5（当前）。见 {@link bucketKeyOf} 的兼容说明。
 */
export function parseBucketKey(key) {
  const parts = String(key ?? '').split(SEP)
  if (parts.length === 4) {
    // 历史 4 段：workspace 缺省为「未标注」。
    const [scope, kind, provider, model] = parts
    return {
      scope: scope === 'sub' ? 'sub' : 'main',
      kind: kind === 'aux' ? 'aux' : 'chat',
      workspace: UNKNOWN_WORKSPACE,
      provider: provider ?? '',
      model: model ?? '',
    }
  }
  if (parts.length === 5) {
    const [scope, kind, workspace, provider, model] = parts
    return {
      scope: scope === 'sub' ? 'sub' : 'main',
      kind: kind === 'aux' ? 'aux' : 'chat',
      workspace: workspace ?? UNKNOWN_WORKSPACE,
      provider: provider ?? '',
      model: model ?? '',
    }
  }
  return undefined
}

/**
 * 会话的计数范围归属。
 *
 * 子代理 / 团队队友 / workflow 子会话在持久化里都是**独立 session**，且 header 带
 * `origin: 'subagent'` 或 `delegationDepth > 0`。它们默认计入（用户选了「完整反映
 * 真实消耗」），但打上 `sub` 标记，以便 Config 关掉时能被过滤。
 */
export function sessionScopeOf(header) {
  if (header?.origin === 'subagent') return 'sub'
  if (num(header?.delegationDepth) > 0) return 'sub'
  return 'main'
}

/**
 * 一条待入账记录。
 *
 * `seq` 与 `sessionId` 一起构成**永久稳定**的去重键：会话日志 append-only、
 * seq 从 0 连续且永不重写，所以「已计数的最大 seq」水位线足以保证回填与实时
 * 两条路径加起来**不可能重复计数**。
 *
 * `kind` 区分主对话调用（`chat`）与辅助调用（`aux`，目前只有压缩摘要）。
 * 辅助调用真实花 token，默认计入；但用户可以按需过滤掉。
 *
 * `workspace` 是会话的 `header.cwd`（工作区标识）。空值表示「未标注」——历史
 * 4 段桶键与拿不到 cwd 的来源都会走到这里。
 */
export function makeEntry({ sessionId, seq, time, provider, model, workspace, scope, kind, usage }) {
  return {
    sessionId: String(sessionId ?? ''),
    seq: num(seq),
    time: num(time),
    provider: String(provider ?? '').slice(0, 64),
    model: String(model ?? '').slice(0, 160),
    workspace: String(workspace ?? '').slice(0, 260),
    scope: scope === 'sub' ? 'sub' : 'main',
    kind: kind === 'aux' ? 'aux' : 'chat',
    usage: {
      inputTokens: num(usage?.inputTokens),
      cacheReadTokens: num(usage?.cacheReadTokens),
      cacheWriteTokens: num(usage?.cacheWriteTokens),
      outputTokens: num(usage?.outputTokens),
      reasoningTokens: num(usage?.reasoningTokens),
    },
  }
}

/**
 * 把一条记录并入日聚合表（**原地修改** `days`，调用方持有该表）。
 *
 * `days` 结构：`日键 → (桶键 → 合计)`。与仓库既有 token-ledger 同款取舍——只落
 * 日聚合不落明细，写入量与请求量解耦（同一格只加数，不增行）。
 */
export function foldEntry(days, entry) {
  const day = localDayKey(entry.time)
  if (day === '') return false
  let buckets = days.get(day)
  if (buckets === undefined) {
    buckets = new Map()
    days.set(day, buckets)
  }
  const key = bucketKeyOf(entry)
  let totals = buckets.get(key)
  if (totals === undefined) {
    totals = emptyTotals()
    buckets.set(key, totals)
  }
  addUsage(totals, entry.usage)
  return true
}

/** 批量并入。 */
export function foldEntries(days, entries) {
  let folded = 0
  for (const entry of entries) if (foldEntry(days, entry)) folded += 1
  return folded
}

/** 水位线：`sessionId → 已计数的最大 seq`。取 max，因此重复应用是幂等的。 */
export function advanceWatermark(watermarks, sessionId, seq) {
  const id = String(sessionId ?? '')
  if (id === '') return
  const next = num(seq)
  const prev = watermarks.get(id)
  if (prev === undefined || next > prev) watermarks.set(id, next)
}

/** 水位线合并（盘上 vs 内存）：逐会话取 max。用于增量落盘时不互相抹掉。 */
export function mergeWatermarks(target, source) {
  for (const [id, seq] of source) advanceWatermark(target, id, seq)
}

/**
 * 区间汇总。
 *
 * @param days 日聚合表（Map）。
 * @param options.from/to        闭区间的日键；省略 = 不限。
 * @param options.groupBy        `day` | `week` | `month` | `provider` | `model` | `providerModel` | `kind` | `workspace`。
 * @param options.workspace      只统计某个工作区（header.cwd）；省略 = 不限。
 * @param options.includeSub     是否计入子会话（默认 true）。
 * @param options.includeAux     是否计入辅助调用（压缩摘要等，默认 true）。
 * @returns `{ rows, totals }`；`rows` 按 key 升序（时间粒度）或按 totalTokens 降序（维度粒度）。
 */
export function aggregateRange(days, options = {}) {
  const { from, to, groupBy = 'day', workspace, includeSub = true, includeAux = true } = options
  const totals = emptyTotals()
  /** @type {Map<string, any>} */
  const rows = new Map()
  const isTimeGroup = groupBy === 'day' || groupBy === 'week' || groupBy === 'month'

  // 工作区过滤（可选）：只在指定了 workspace 时生效。
  // 显式传 undefined / '' 表示「不限」——「未标注」不是空串筛选，而是靠
  // rows 里 label 为空来体现（否则永远筛不出历史 4 段数据）。
  const wantWorkspace = typeof workspace === 'string' && workspace !== '' ? workspace : undefined

  const dayKeys = [...days.keys()].sort()
  for (const day of dayKeys) {
    if (typeof from === 'string' && from !== '' && day < from) continue
    if (typeof to === 'string' && to !== '' && day > to) continue
    const buckets = days.get(day)
    if (buckets === undefined) continue
    for (const [key, bucketTotals] of buckets) {
      const parsed = parseBucketKey(key)
      if (parsed === undefined) continue
      if (wantWorkspace !== undefined && parsed.workspace !== wantWorkspace) continue
      if (!includeSub && parsed.scope === 'sub') continue
      if (!includeAux && parsed.kind === 'aux') continue
      addTotalsInto(totals, bucketTotals)
      let rowKey
      let label
      if (isTimeGroup) {
        rowKey = periodKeyOf(day, groupBy)
        label = rowKey
      } else if (groupBy === 'provider') {
        rowKey = parsed.provider
        label = parsed.provider || '(unnamed provider)'
      } else if (groupBy === 'model') {
        rowKey = parsed.model
        label = parsed.model || '(unnamed model)'
      } else if (groupBy === 'kind') {
        rowKey = parsed.kind
        // 这里只给**与语言无关**的键，不下发中文/英文文案：`kind` 是枚举值
        // （`chat` / `aux`），文案属于展示层。早先这里硬编码中文，结果英文界面
        // 也会显示「辅助调用（压缩等）」——host 根本不知道当前 locale。
        // Client 按 `row.kind` 自行本地化（见 client.js 的 `kindLabel`）。
        label = parsed.kind
      } else if (groupBy === 'workspace') {
        rowKey = parsed.workspace
        // 空串给个明确的展示键，别让 row.key 为空字符串（空 key 在 React 列表里是坑）。
        label = parsed.workspace || '(unnamed workspace)'
      } else {
        // ⚠️ `providerModel` 的主键**不能**用 bucketKeyOf：那个函数现在含
        // workspace 段，于是同一 (provider, model) 在不同工作区会被拆成多行。
        // 实测本机 66 行里只有 20 个真实组合——`deepseek-account|deepseek-flash`
        // 被拆成 6 行。这是把 workspace 加进桶键时引入的回归。
        //
        // 这里用独立分隔符拼一个纯 (provider, model) 的键，与桶键格式无关。
        rowKey = `${parsed.provider}${ROW_SEP}${parsed.model}`
        label = `${parsed.provider || '(unnamed provider)'} / ${parsed.model || '(unnamed model)'}`
      }
      let row = rows.get(rowKey)
      if (row === undefined) {
        row = {
          key: rowKey,
          label,
          provider: parsed.provider,
          model: parsed.model,
          kind: parsed.kind,
          // 工作区原始值（可能是 '' = 未标注）。下发它，让 Client 用 Workspace
          // 标题做展示，而不是让 host 猜 display name——host 不知道用户给
          // Workspace 起过什么 title。
          workspace: parsed.workspace,
          totals: emptyTotals(),
        }
        rows.set(rowKey, row)
      }
      addTotalsInto(row.totals, bucketTotals)
    }
  }

  const list = [...rows.values()]
  if (isTimeGroup) {
    // 时间粒度：升序（旧 → 新），便于直接画趋势。
    list.sort((a, b) => String(a.key).localeCompare(String(b.key)))
  } else {
    // 维度粒度：谁烧得多谁在前。
    list.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens)
  }
  return { rows: list, totals }
}

/** 原地把 `source` 累加进 `target`（内部热路径，避免每桶新建对象）。 */
function addTotalsInto(target, source) {
  for (const k of Object.keys(target)) target[k] += num(source?.[k])
  return target
}

/**
 * 淘汰过老日键，返回**浅拷贝**（不改调用方的表）。
 *
 * @param keepDays 保留天数（含今天）。<= 0 表示不淘汰。
 */
export function pruneDays(days, { keepDays, now = Date.now() } = {}) {
  const keep = num(keepDays)
  if (keep <= 0) return days
  const cutoff = shiftDayKey(localDayKey(now), -(keep - 1))
  const out = new Map()
  for (const [day, buckets] of days) {
    if (cutoff !== '' && day < cutoff) continue
    out.set(day, buckets)
  }
  return out
}

/** 汇总表里所有桶的合计（用于「累计」一类的读数）。 */
export function grandTotals(days) {
  const totals = emptyTotals()
  for (const buckets of days.values()) {
    for (const bucket of buckets.values()) addTotalsInto(totals, bucket)
  }
  return totals
}
