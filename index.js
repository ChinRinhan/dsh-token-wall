/**
 * **Host 半**：采集、聚合、持久化、只读查询接口。
 *
 * ## 数据来源
 *
 * 会话日志里 `assistant/message` 事件的 `usage` 字段——它是**持久化**的，因此
 * 「历史回填」与「实时捕获」读的是同一份数据，不存在两套口径漂移。详见
 * `lib/collect.js` 的模块头（含「为什么不用 llm/stream」与 fork 去重的说明）。
 *
 * ## 生命周期
 *
 * `apply()` 里做三件事，每件都用 `ctx.effect` / `ctx.on` 注册以便随 fiber 卸载：
 *
 * 1. 打开存储（读盘，恢复历史与水位线）；
 * 2. 后台回填历史（异步、不阻塞激活，失败只记日志）；
 * 3. 订阅 `session/event` 做实时捕获。
 *
 * ## 依赖声明（关键：不要用硬 inject）
 *
 * `inject` 是**硬门禁**——Cordis 会把 fiber 挂起直到该服务出现。本插件对
 * `sessionPersistence` 是**可选**依赖（没有它就没有历史回填，但实时捕获仍可用），
 * 所以用 `ctx.inject([...], cb)` 而不是顶层 `inject`，避免在没有该服务的组合里
 * 永久不激活。`webServer` 同理（headless 组合没有 HTTP 服务）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './lib/store.js'
import { openPrefs } from './lib/prefs.js'
import { backfill, entryFromLiveEvent } from './lib/collect.js'
import { probePersistence } from './lib/adapter.js'
import { aggregateRange, diffDays, localDayKey, shiftDayKey } from './lib/fold.js'
import { groupModels, groupVendors } from './lib/models.js'
import { emptyTurnState, foldTurnEvent, sessionViewOf } from './lib/turns.js'

export const name = 'dsh-token-usage'

/** HTTP 路由前缀。 */
const ROUTE_PREFIX = '/dsh-token-usage'

/**
 * 解析 DSH home（绝对路径）。
 *
 * 优先用官方的 `dshHomePath` 服务——它统一了「显式配置 > `$DSH_HOME` > `~/.dsh`」
 * 的优先级，与 DSH 其余部分保持一致。注意 `dshHomePath('token-usage')` 返回的是
 * `<home>/token-usage`，而 `openStore` 会自己再拼一层子目录，所以这里取它的父目录。
 *
 * 拿不到该服务时回落到环境变量与 `~/.dsh`，让插件在没有 home-paths 的组合里仍可用。
 */
function resolveHome(ctx) {
  try {
    const homePath = ctx.get('dshHomePath')
    if (typeof homePath === 'function') {
      const root = homePath()
      if (typeof root === 'string' && root.trim() !== '') return root
    }
  } catch {
    // 服务不存在或调用失败：走环境变量回落。
  }
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return join(homedir(), '.dsh')
}

/**
 * Config：用户可在 `cordis.patch.yml` 覆盖，升级不丢。
 *
 * ## 为什么是 `~standard` 而不是 `parse`
 *
 * Cordis 的 `resolveConfig` 走的是 **Standard Schema** 契约：
 * `Config['~standard'].validate(config)`，返回值要么 `{ value }` 要么 `{ issues }`。
 * 一个只有 `parse` 的对象会让 `runtime.Config['~standard']` 是 `undefined`，
 * 激活期直接抛 `Cannot read properties of undefined (reading 'validate')`。
 *
 * 手写这层契约（而不是 import schemastery/zod）：插件因此**零依赖**，不会因为
 * profile 里解析不到某个 schema 库而激活失败。校验逻辑本身很短，且是唯一真源。
 */
function validateConfig(input) {
  const issues = []
  const raw = input === null || typeof input === 'undefined' ? {} : input
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: 'dsh-token-usage: config must be an object', path: [] }] }
  }
  const boolOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const intOr = (value, fallback, min) => {
    if (typeof value === 'undefined' || value === null) return fallback
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) {
      issues.push({ message: `dsh-token-usage: expected a non-negative number, got ${JSON.stringify(value)}`, path: [] })
      return fallback
    }
    return Math.max(min, Math.trunc(n))
  }
  const value = {
    keepDays: intOr(raw.keepDays, 400, 0),
    includeSubagents: boolOr(raw.includeSubagents, true),
    includeAuxiliary: boolOr(raw.includeAuxiliary, true),
    statusBarEnabled: boolOr(raw.statusBarEnabled, true),
    statusBarRefreshMs: intOr(raw.statusBarRefreshMs, 1000, 1000),
    backfillOnStart: boolOr(raw.backfillOnStart, true),
    modelAliases: aliasOr(raw.modelAliases),
  }
  return issues.length > 0 ? { issues } : { value }
}

/**
 * 校验 `modelAliases`：`{ 原始模型名: { vendor?, model? } }`。
 *
 * ⚠️ 这是**用户显式声明**的归并规则，所以只做形状校验、不做「猜」：
 * 每项必须是一个对象，`vendor` / `model` 若存在必须是非空字符串。
 * 形状不对的条目**静默丢弃**（而不是让整个 config 失效）——
 * 一条别名写错不该让插件起不来。
 *
 * @param raw 用户传入的别名表。
 * @returns 规范化后的别名表（可能为空对象）。
 */
function aliasOr(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, val] of Object.entries(raw)) {
    if (typeof key !== 'string' || key === '') continue
    if (val === null || typeof val !== 'object' || Array.isArray(val)) continue
    const entry = {}
    if (typeof val.vendor === 'string' && val.vendor !== '') entry.vendor = val.vendor
    if (typeof val.model === 'string' && val.model !== '') entry.model = val.model
    if (Object.keys(entry).length > 0) out[key] = entry
  }
  return out
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-token-usage',
    validate: validateConfig,
  },
}

export function apply(ctx, rawConfig) {
  // loader 已通过 Config 校验，这里再兜一次默认值（直接 import 本模块的测试
  // 路径会绕过 loader 校验）。
  const validated = validateConfig(rawConfig)
  const config = 'value' in validated ? validated.value : validateConfig({}).value
  const logger = ctx.logger ?? console
  const home = resolveHome(ctx)
  const store = openStore({ home, keepDays: config.keepDays, logger })
  // 运行时开关（横幅 / 桌宠 / 主面板）。与日聚合数据分开存，见 lib/prefs.js。
  const prefs = openPrefs({ home, logger })

  logger.info?.(
    `[token-usage] 启动：存储=${store.describe().path ?? '(仅内存)'} 保留=${config.keepDays} 天`,
  )

  /** 最近一次回填摘要（诊断用，通过 `/summary` 的 diagnostics 字段暴露给设置页）。 */
  const diagnostics = {
    backfill: undefined,
    backfillError: undefined,
    backfilledAt: undefined,
    /** 宿主 `sessionPersistence` 实际支持哪些调用（接口换代时这里是第一现场）。 */
    persistence: undefined,
    liveEntries: 0,
    startedAt: Date.now(),
  }

  // ── ① 历史回填（异步，不阻塞激活） ──────────────────────────────────
  ctx.inject(['sessionPersistence'], (scoped) => {
    const persistence = scoped.sessionPersistence
    if (persistence === undefined) return
    // 接口探测：不同代 DSH 的 sessionPersistence 形状不同（见 lib/adapter.js）。
    // 探测结果进诊断区——这是「回填为什么是 0」的第一现场，不能只留在日志里。
    diagnostics.persistence = probePersistence(persistence)
    logger.info?.(
      `[token-usage] 宿主接口：list=${diagnostics.persistence.listKind}`
      + ` read=${diagnostics.persistence.readKind}`
      + (diagnostics.persistence.degraded === undefined ? '' : ` ⚠️ ${diagnostics.persistence.degraded}`),
    )
    if (!config.backfillOnStart) {
      logger.info?.('[token-usage] 已按配置跳过历史回填')
      return
    }
    // 回填是启动期的一次性长任务：fiber 卸载时必须能及时收手，否则会在
    // profile 关闭/插件禁用后继续读盘。
    const controller = new AbortController()
    scoped.effect(() => () => {
      controller.abort()
    }, 'dsh-token-usage: backfill abort')

    void backfill({
      persistence,
      store,
      logger,
      signal: controller.signal,
    })
      .then((summary) => {
        if (controller.signal.aborted) return
        diagnostics.backfill = summary
        diagnostics.backfilledAt = Date.now()
        store.flush()
        // 降级必须显眼：静默的 0 会被当成「你本来就没有历史」，是最坏的失败形态。
        if (summary.degraded !== undefined) {
          logger.warn?.(
            `[token-usage] 历史回填降级（读数可能偏低）：${summary.degraded}`,
          )
        }
        logger.info?.(
          `[token-usage] 历史回填完成：会话 ${summary.sessions}（失败 ${summary.failed}），`
          + `新入账 ${summary.entries} 笔，扫描可入账事件 ${summary.assistantMessages}`
          + `（带用量 ${summary.withUsage}），水位线跳过 ${summary.skippedByWatermark}`,
        )
      })
      .catch((error) => {
        diagnostics.backfillError = String(error)
        logger.warn?.(`[token-usage] 历史回填失败（不影响实时捕获）: ${String(error)}`)
      })
  })

  // ── ② 实时捕获 ────────────────────────────────────────────────────
  //
  // `{ global: true }`：`session/event` 是按 scope 过滤投递的。本插件的 `apply`
  // 跑在 loader 行自己的 fiber 上（不在任何 agent scope 内），因此默认已能收到全部
  // 会话；显式声明 global 是为了在将来组合变化（例如被挂进某个 scoped group）时
  // 仍然收到**子代理 / 团队队友 / workflow 子会话**——那正是用户选定的计数范围。
  //
  // 「本次运行」的记账起点：从插件激活起算。用于算「平均速度」。
  const runStartedAt = Date.now()
  /** 本次运行内入账的 token（平均速度的分子）。 */
  let runTokens = 0
  /** 最近一次产生用量的会话的工作区（cwd）。空串 = 还不知道。 */
  let currentWorkspace = ''
  /** 最近一次产生用量的模型（**原始名**，含渠道前缀）。空串 = 还不知道。 */
  let currentModel = ''

  /**
   * 逐会话的逐轮折叠状态：`sessionId → turnState`。
   *
   * ## 为什么是**有界**的 Map，而不是落盘
   *
   * 「当前会话」在新开会话时本来就该从 0 起算，所以逐轮读数**不需要持久化**：
   * 重启后你面对的通常是一个新会话。唯一尴尬的是「恢复旧会话」，那时会从 0
   * 开始涨到下一次调用——这可以接受，而且冷会话的真实数据我们另有来源
   * （`/today?session=` 会去查宿主投影，见 `sessionUsageOf`）。
   *
   * 因此这里只保留最近 `MAX_TURN_SESSIONS` 个会话，超出时按插入顺序淘汰最旧的。
   * 只存内存、不写盘，符合「重启清零」的既定取舍。
   */
  const turnStates = new Map()
  /** 上限：几百个会话足够覆盖「同时开着几个」的实际使用，且不会无限增长。 */
  const MAX_TURN_SESSIONS = 64

  /**
   * 取（或新建）某个会话的折叠状态，并维持 Map 有界。
   *
   * 重新 set 一次是为了把该 key 移到插入顺序末尾（Map 保序 → 天然 LRU 近似）。
   */
  function turnStateOf(sessionId) {
    const id = String(sessionId ?? '')
    if (id === '') return undefined
    let state = turnStates.get(id)
    if (state === undefined) {
      state = emptyTurnState()
      turnStates.set(id, state)
      while (turnStates.size > MAX_TURN_SESSIONS) {
        const oldest = turnStates.keys().next().value
        turnStates.delete(oldest)
      }
    }
    return state
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (session === null || typeof session !== 'object') return

      // ── 先折逐轮状态 ──
      //
      // ⚠️ 顺序很重要：逐轮折叠必须看到 `turn/start` 与 `llm/retry-started`
      // （它们**不带用量**，会被下面的日聚合路径提前 return）。所以这一步
      // 必须在 `entryFromLiveEvent` 之前，且不能被它的早退跳过。
      const sessionId = session.id
      if (sessionId !== undefined) {
        const before = turnStateOf(sessionId)
        if (before !== undefined) {
          const after = foldTurnEvent(before, event)
          // foldTurnEvent 对无关事件返回同一个引用 → 无需写回，省一次 Map.set。
          if (after !== before) turnStates.set(String(sessionId), after)
        }
      }

      const entry = entryFromLiveEvent({ session, event, store })
      if (entry === undefined) return
      store.fold(entry)
      runTokens += entry.usage.inputTokens + entry.usage.cacheReadTokens
        + entry.usage.cacheWriteTokens + entry.usage.outputTokens
      diagnostics.liveEntries += 1
      // 「当前工作区」= 最近一次产生用量的会话的 cwd。
      //
      // ⚠️ host 拿不到「用户在 UI 里选中了哪个会话」——那是客户端状态。但
      // 「刚刚在哪个工作区产生了消耗」是 host 完全知道的，而且对用户来说
      // **更贴近意图**（你刚在这个项目里干活，chip 就该显示它）。
      if (typeof session.header?.cwd === 'string' && session.header.cwd !== '') {
        currentWorkspace = session.header.cwd
      }
      // 「当前模型」= 这条用量事件用的是哪个模型。与当前工作区同理：
      // host 不知道 UI 选中了什么，但知道「刚刚在用什么模型」。
      // 记**原始名**（含渠道前缀）——归一化在读取侧做，这样别名表改了不用重算历史。
      if (entry.model !== '') currentModel = entry.model
    } catch (error) {
      // 记账在推理关键路径上：绝不抛错反噬推理。
      logger.warn?.(`[token-usage] 实时记账失败（已忽略）: ${String(error)}`)
    }
  }, { global: true })

  // ── ③ 只读查询路由 ────────────────────────────────────────────────
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer
    if (webServer === undefined) return

    const today = () => localDayKey(Date.now())

    /**
     * 两个过滤开关的统一取值口径。
     *
     * ⚠️ **所有端点必须共用这两个函数**。早先 `/today` 直接读 `config.*`，
     * 完全不看查询参数，于是「设置页关掉含子会话」之后：区间合计变小了，
     * 而方块墙/桌宠读的 `/today` 一点没变——同一块界面上出现两个互相矛盾的
     * 累计值。这正是当年 `grandTotals` 那个 bug 的同款，只是换了个边界。
     *
     * 语义是**硬与**：`config` 关掉就再也打不开（部署期硬开关），查询参数只能
     * 在 config 允许的范围内再收窄。
     */
    const wantsSub = (query) => config.includeSubagents && query?.get('includeSub') !== '0'
    const wantsAux = (query) => config.includeAuxiliary && query?.get('includeAux') !== '0'

    /**
     * 读宿主对某个会话的**精确**投影（`tokenUsage` / `contextPressure`）。
     *
     * ## 为什么要分三级降级
     *
     * 桌宠要知道「当前会话花了多少、上下文占了多少」，而 host 只知道客户端**告诉**
     * 它的那个 sessionId（host 自己看不出用户在 UI 里选中了哪个会话）。拿到 id
     * 之后有三种现实情况，必须逐个覆盖，且**任何一级都不许伪装成 0**：
     *
     * 1. **活会话**：`ctx.sessions.get(id)` 命中 → `sessionProjections.snapshot()`
     *    直接给精确值。这是当前正在跑的主路径，便宜且实时。
     * 2. **冷会话**（重启后继续旧会话、或切到方块墙面板时）：`sessions.get` 只
     *    返回**活**会话，未命中返回 undefined。此时退到
     *    `sessionQuery.observeSession(id, { projectionMode: 'all' })`——它没有活
     *    会话时会从磁盘把日志读出来折出投影。首次要解日志，之后有缓存。
     * 3. **都不可用**（老日志没有该投影 / 服务不在组合里 / 会话不存在）：
     *    返回 `{ available: false, reason }`，由客户端显示 `—`。
     *
     * 之所以不自己维护一份「每会话合计」的 Map 当兜底：本插件回填时确实能攒出
     * 一份，但它只在回填跑过时才有，且对**新会话**永远是过期的。第 2 级直接问
     * 宿主既更准也更省，Map 只在最后才考虑。
     *
     * @param sessionId 会话 id（来自客户端桥）。
     * @returns `{ available: true, tokenUsage, contextPressure }` 或 `{ available: false, reason }`。
     */
    async function sessionUsageOf(sessionId) {
      const id = String(sessionId ?? '')
      if (id === '') return { available: false, reason: 'no-session' }

      const pick = (snapshot) => {
        const values = snapshot?.values ?? {}
        const tokenUsage = values.tokenUsage
        if (tokenUsage === undefined) return undefined
        return { tokenUsage, contextPressure: values.contextPressure }
      }

      // ① 活会话（最常用、最便宜）。
      try {
        const live = ctx.get('sessions')?.get?.(id)
        const projections = ctx.get('sessionProjections')
        if (live !== undefined && projections !== undefined) {
          const hit = pick(projections.snapshot(live))
          if (hit !== undefined) return { available: true, ...hit }
        }
      } catch (error) {
        logger.warn?.(`[token-usage] 读取活会话投影失败: ${String(error)}`)
      }

      // ② 冷会话：从磁盘折投影（可能较慢，首次会解日志）。
      try {
        const query = ctx.get('sessionQuery')
        if (query?.observeSession === undefined) {
          return { available: false, reason: 'no-session-query' }
        }
        const observation = await query.observeSession(id, { projectionMode: 'all' })
        try {
          const hit = pick(observation?.projections)
          if (hit !== undefined) return { available: true, ...hit }
          return { available: false, reason: 'no-token-usage' }
        } finally {
          // SessionObservation 是租约，必须释放，否则会留住会话日志句柄。
          try { observation?.dispose?.() } catch { /* 已释放 */ }
        }
      } catch (error) {
        return { available: false, reason: `query-failed: ${String(error?.message ?? error)}` }
      }
    }

    /**
     * 全量合计**必须走同一套过滤**。
     *
     * 这里曾经直接调 `grandTotals(store.days)`——它把**所有**桶无差别相加，完全
     * 不看 `includeSub` / `includeAux`。后果是页面上同时出现两个互相矛盾的数：
     * 关掉「含子会话」后区间合计变小了，而旁边的「累计」纹丝不动，看起来像
     * 漏统计。累计与区间合计是同一份数据、同一个口径，只是范围不同（全部 vs
     * 指定区间），所以这里用 `aggregateRange` 走**不限区间**的同一路径。
     *
     * `workspace` 同理：筛了工作区之后，累计必须只算该工作区的。
     */
    const allTimeTotals = (includeSub, includeAux, workspace) => aggregateRange(store.days, {
      groupBy: 'day',
      workspace,
      includeSub,
      includeAux,
    }).totals

    /**
     * 合法分组维度（白名单，避免把任意 query 透传给聚合层）。
     *
     * `modelNorm` / `vendor` 是**归并后**的维度：它们先按原始 `model` 分组，
     * 再用 `lib/models.js` 归一化后合并（同一模型的多个渠道/`-free` 变体合一）。
     * 放在 host 侧算而不是让 client 算，是因为归并要用 `config.modelAliases`。
     */
    const GROUP_BY = [
      'day', 'week', 'month', 'provider', 'model', 'providerModel', 'kind', 'workspace',
      'modelNorm', 'vendor',
    ]

    /** 组装一个区间查询响应。 */
    const buildSummary = (query) => {
      const granularity = ['day', 'week', 'month'].includes(query.get('granularity'))
        ? query.get('granularity')
        : 'day'
      const groupBy = GROUP_BY.includes(query.get('groupBy')) ? query.get('groupBy') : granularity
      // 工作区过滤（可选）：只统计某个 cwd。空 / 缺省 = 不限。
      const wsParam = query.get('workspace')
      const workspace = typeof wsParam === 'string' && wsParam !== '' ? wsParam : undefined
      const todayKey = today()
      const from = typeof query.get('from') === 'string' && query.get('from') !== ''
        ? query.get('from')
        : shiftDayKey(todayKey, -29)
      const to = typeof query.get('to') === 'string' && query.get('to') !== '' ? query.get('to') : todayKey
      const includeSub = wantsSub(query)
      const includeAux = wantsAux(query)

      // 归并维度：先按原始 model 聚合，再在 host 侧合并。
      // ⚠️ 不能直接按归一化名分桶——桶键是落盘格式，改它要迁移历史数据。
      // 在读取侧归并则零成本：数据不动，只是换个聚合方式。
      if (groupBy === 'modelNorm' || groupBy === 'vendor') {
        const byModel = aggregateRange(store.days, {
          from, to, groupBy: 'model', workspace, includeSub, includeAux,
        })
        const merged = groupBy === 'modelNorm'
          ? groupModels(byModel.rows, config.modelAliases)
          : groupVendors(byModel.rows, config.modelAliases)
        const todayTotals = aggregateRange(store.days, {
          from: todayKey, to: todayKey, groupBy: 'day', workspace, includeSub, includeAux,
        }).totals
        return {
          ok: true,
          generatedAt: Date.now(),
          range: { from, to, days: diffDays(to, from) + 1 },
          groupBy,
          workspace: workspace ?? null,
          includeSub,
          includeAux,
          granularity,
          rows: merged,
          totals: byModel.totals,
          today: { day: todayKey, totals: todayTotals },
          allTime: allTimeTotals(includeSub, includeAux, workspace),
          config: {
            keepDays: config.keepDays,
            // ⚠️ 回显**本次响应实际用的**口径（而不是部署期 config 原值）：
            // 两个端点同名同义，客户端才能直接拿它显示「当前统计范围」。
            // 部署期的硬开关另有 `configurable` 含义，不该混在这个字段里。
            includeSubagents: includeSub,
            includeAuxiliary: includeAux,
            statusBarEnabled: config.statusBarEnabled,
            statusBarRefreshMs: config.statusBarRefreshMs,
          },
          prefs: prefs.read(),
          diagnostics: {
            liveEntries: diagnostics.liveEntries,
            backfill: diagnostics.backfill,
            backfillError: diagnostics.backfillError,
            backfilledAt: diagnostics.backfilledAt,
            persistence: diagnostics.persistence,
          persistence: diagnostics.persistence,
            store: store.describe(),
            sessionsTracked: store.watermarks?.size ?? 0,
          },
        }
      }

      const { rows, totals } = aggregateRange(store.days, {
        from, to, groupBy, workspace, includeSub, includeAux,
      })
      // 今日合计与累计要跟着 workspace 过滤走——否则页面上「今日」和区间合计
      // 会因为筛选不一致而互相矛盾（和 includeSub/includeAux 是同一类问题）。
      const todayTotals = aggregateRange(store.days, {
        from: todayKey,
        to: todayKey,
        groupBy: 'day',
        workspace,
        includeSub,
        includeAux,
      }).totals
      return {
        ok: true,
        generatedAt: Date.now(),
        range: { from, to, days: diffDays(to, from) + 1 },
        groupBy,
        workspace: workspace ?? null,
        includeSub,
        includeAux,
        granularity,
        rows,
        totals,
        today: { day: todayKey, totals: todayTotals },
        allTime: allTimeTotals(includeSub, includeAux, workspace),
        config: {
          keepDays: config.keepDays,
          // 同 modelNorm 分支：回显本次响应用的实际口径，与 `/today` 保持同义。
          includeSubagents: includeSub,
          includeAuxiliary: includeAux,
          statusBarEnabled: config.statusBarEnabled,
          statusBarRefreshMs: config.statusBarRefreshMs,
        },
        // 运行时开关（横幅 / 桌宠 / 主面板）。设置页读它来决定渲染哪些模块。
        prefs: prefs.read(),
        diagnostics: {
          liveEntries: diagnostics.liveEntries,
          backfill: diagnostics.backfill,
          backfillError: diagnostics.backfillError,
          backfilledAt: diagnostics.backfilledAt,
          persistence: diagnostics.persistence,
          store: store.describe(),
          sessionsTracked: store.watermarks?.size ?? 0,
        },
      }
    }

    /**
     * 轻量端点：状态条/里程表只关心「今日 + 累计」这几个数，避免每次轮询都下发
     * 整张聚合表。轮询频率是 1 秒级，所以这里刻意只做 O(日×桶) 的加总。
     *
     * ## 为什么它是 async
     *
     * 带 `session` 参数时要去读宿主投影；**冷会话**（重启后继续旧会话）只能从
     * `sessionQuery.observeSession` 读盘折出来。但这条慢路径**只在请求带
     * session 参数且该会话不是活会话时**才走到——常规轮询仍是一次同步加总。
     *
     * @param query 可选的查询参数。接受 `includeSub` / `includeAux`，与 `/summary`
     *   **同一口径**——否则页面上的「累计」与区间合计会互相矛盾。
     */
    const buildToday = async (query) => {
      const includeSub = wantsSub(query)
      const includeAux = wantsAux(query)
      const day = today()
      const { totals } = aggregateRange(store.days, {
        from: day,
        to: day,
        groupBy: 'day',
        includeSub,
        includeAux,
      })
      const yesterdayKey = shiftDayKey(day, -1)
      const yesterday = aggregateRange(store.days, {
        from: yesterdayKey,
        to: yesterdayKey,
        groupBy: 'day',
        includeSub,
        includeAux,
      }).totals

      // ── 当前会话（可选）──
      //
      // 客户端用挡板组件把「用户正在看哪个会话」推上来（host 自己看不到这个
      // 状态）。没带 session 参数时整块字段**不出现**，老客户端行为完全不变。
      //
      // 会话用量有两个来源，优先级明确：
      // - `live`：我们自己增量折的逐轮状态（有「本轮实时在涨」，harness 做不到）；
      // - `projected`：宿主投影的整份日志精确四桶（权威，但不分轮次）。
      //
      // 两者**口径不重叠**：`sessionTokens` 是我们折出来的计费桶之和，宿主的
      // `tokenUsage` 也是同一份数据的四桶之和，所以它们应当**相等**（这是交叉
      // 校验点，不是两套口径）。逐轮读数则只有我们有。
      const sessionParam = typeof query?.get === 'function' ? query.get('session') : undefined
      let session
      if (typeof sessionParam === 'string' && sessionParam !== '') {
        const live = turnStates.get(sessionParam)
        const projected = await sessionUsageOf(sessionParam)
        const turnView = live === undefined ? undefined : sessionViewOf(live)
        session = {
          id: sessionParam,
          // 我们折的逐轮读数；宿主投影缺失时它仍可用（这是它最大的价值）。
          live: turnView ?? null,
          // 宿主投影（权威的整份日志口径）。
          projected: projected.available
            ? {
              tokenUsage: projected.tokenUsage,
              contextPressure: projected.contextPressure ?? null,
            }
            : null,
          // 投影不可用的原因（客户端据此显示 — 并说明为什么）。
          projectedUnavailable: projected.available ? undefined : projected.reason,
        }
      }

      return {
        ok: true,
        day,
        yesterday: { day: yesterdayKey, totals: yesterday },
        totals,
        // 累计是**单调递增**的，正是「越花越多」最直接的表达。
        allTime: allTimeTotals(includeSub, includeAux),
        // 本次运行的平均速度。
        //
        // ⚠️ 早先客户端用的是「累计值的相邻采样变化率」，那个指标**在空闲时恒为 0**
        // （累计值只在有新调用时才变），于是 99% 的时间显示「—」，实际等于没有。
        //
        // 「本次运行的总消耗 ÷ 已运行时长」不会归零：只要这段时间用过，就有数；
        // 不用的时候它是一个稳定的平均值，不跳变。分子只算**本次运行内**入账的
        // token（runTokens），不含历史回填——否则会算出一个巨大且误导的数。
        run: {
          startedAt: runStartedAt,
          tokens: runTokens,
          elapsedMs: Math.max(1, Date.now() - runStartedAt),
        },
        // 当前工作区 / 当前模型：最近一次产生用量的事件带来的。
        // 桌宠是 root scope 的命令式 DOM，拿不到客户端的「当前会话」状态，
        // 所以由 host 告知（见 session/event 处理器里的说明）。
        current: { workspace: currentWorkspace, model: currentModel },
        generatedAt: Date.now(),
        // 客户端据此调整轮询间隔（免得让 Client 再拉一次 summary）。
        config: {
          keepDays: config.keepDays,
          statusBarEnabled: config.statusBarEnabled,
          statusBarRefreshMs: config.statusBarRefreshMs,
          // 本次响应实际用的过滤口径，客户端据此显示「当前统计范围」。
          includeSubagents: includeSub,
          includeAuxiliary: includeAux,
        },
        // 运行时开关的当前状态。客户端在挂载桌宠 / 注册横幅前先读它，
        // 所以「关掉某个模块」是**立即生效**的（不用重启、不用重载页面）。
        prefs: prefs.read(),
        // 方块墙主面板也读这个端点，而它的诊断区要显示「存储在哪、回填了多少」。
        // 早先这里不下发 diagnostics，客户端拿到 `undefined` 后按「没有 store」
        // 处理，于是**明明落盘成功却显示「仅内存（未找到 DSH home）」**——把
        // 一个正常状态报成了故障。诊断字段很小，一并下发，代价可忽略。
        diagnostics: {
          liveEntries: diagnostics.liveEntries,
          backfill: diagnostics.backfill,
          backfillError: diagnostics.backfillError,
          backfilledAt: diagnostics.backfilledAt,
          persistence: diagnostics.persistence,
          store: store.describe(),
          sessionsTracked: store.watermarks?.size ?? 0,
        },
        // 仅当请求带 `session` 参数时出现（老客户端行为不变）。
        ...session === undefined ? {} : { session },
      }
    }

    /**
     * 轻量端点：工作区分布（只给 top N 个）。
     *
     * ## 为什么单独一个端点，而不是让桌宠去拉 /summary
     *
     * 桌宠是 **root scope 的命令式 DOM**（挂在 document.body 上），它拿不到
     * session-scope 的 props，所以不知道「当前会话在哪个工作区」。
     * 它能问的只有 host —— 而 host 知道每个会话的 cwd（采集时记下的），
     * 所以能算出「消耗最多的工作区」。
     *
     * 这个端点只返回 top N（默认 5）个，比 /summary 轻得多：桌宠每 10 秒拉一次，
     * 不该拖着整张聚合表走。
     *
     * ## 与 /summary?groupBy=workspace 的区别
     *
     * 这个端点额外支持 **from/to**（日期范围），所以主面板切到「今日」时也能用
     * 它（不必拉全量再在客户端过滤）。不传范围 = 全量。
     *
     * @param query URL 查询参数（`limit` / `from` / `to`）。
     */
    const buildWorkspaces = (query) => {
      const limitRaw = Number(query.get('limit'))
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(50, Math.trunc(limitRaw))
        : 5
      // ⚠️ 必须走 `wantsSub` / `wantsAux`，**不能**直接读 `config.*`。
      //
      // 这里曾经读的是部署期 `config.includeSubagents` / `config.includeAuxiliary`，
      // 而 `/today` 与 `/summary` 走的是运行时 prefs。后果是：用户在设置页关掉
      // 「含子会话」后，方块墙/桌宠的累计（读 `/today`）立刻变小，而旁边的
      // 工作区分布（读本端点）纹丝不动——同一块界面上两个矛盾的数字。
      // 这正是 `/today` 当年那个 bug 的同款，只是漏在了第三条路径上。
      //
      // 本端点也接受 `includeSub` / `includeAux` 查询参数（与另两个端点同义），
      // 因为桌宠/主面板轮询时会带上它们；忽略参数会让「当前口径」的显示与实际
      // 统计不一致。
      const includeSub = wantsSub(query)
      const includeAux = wantsAux(query)
      const from = typeof query.get('from') === 'string' && query.get('from') !== ''
        ? query.get('from')
        : undefined
      const to = typeof query.get('to') === 'string' && query.get('to') !== ''
        ? query.get('to')
        : undefined
      const { rows } = aggregateRange(store.days, {
        groupBy: 'workspace',
        from,
        to,
        includeSub,
        includeAux,
      })
      // 排除「未标注」：它不是工作区，单独一条会让 top 列表失真。
      const named = rows.filter((row) => row.workspace !== '' && row.workspace !== undefined)
      return {
        ok: true,
        generatedAt: Date.now(),
        total: named.length,
        rows: named.slice(0, limit).map((row) => ({
          workspace: row.workspace,
          totalTokens: row.totals.totalTokens,
          requests: row.totals.requests,
        })),
      }
    }

    const sendJson = (res, body, status = 200) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(text)
    }

    const routes = [
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/today`,
        handler: (req, res) => {
          // `buildToday` 是 async（带 session 时要读宿主投影，冷会话可能读盘）。
          // 错误必须在这里收住并回 500——未处理的 rejection 会让整个 Host 挂掉，
          // 而这条路径由客户端每秒轮询，绝不能因为一个会话读不到就崩。
          void (async () => {
            try {
              const url = new URL(req.url ?? '/', 'http://localhost')
              sendJson(res, await buildToday(url.searchParams))
            } catch (error) {
              sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
            }
          })()
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/summary`,
        handler: (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            sendJson(res, buildSummary(url.searchParams))
          } catch (error) {
            sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/workspaces`,
        handler: (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            sendJson(res, buildWorkspaces(url.searchParams))
          } catch (error) {
            sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
          }
        },
      },
      {
        kind: 'exact',
        path: `${ROUTE_PREFIX}/prefs`,
        handler: (req, res) => {
          try {
            // GET → 读当前开关；PUT → 改开关。
            // ⚠️ 唯一会**写**的端点（其余全是只读）。所以它必须严格校验：
            // 只接受一个普通对象，未知键丢弃，类型错的回落默认（见 sanitizePrefs）。
            if (req.method === 'PUT' || req.method === 'POST') {
              let body = ''
              req.on('data', (chunk) => { body += chunk })
              req.on('end', () => {
                let parsed
                try {
                  parsed = JSON.parse(body === '' ? '{}' : body)
                } catch {
                  sendJson(res, { ok: false, error: 'prefs must be valid JSON' }, 400)
                  return
                }
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  sendJson(res, { ok: false, error: 'prefs must be a plain object' }, 400)
                  return
                }
                sendJson(res, { ok: true, prefs: prefs.write(parsed) })
              })
              return
            }
            sendJson(res, { ok: true, prefs: prefs.read() })
          } catch (error) {
            sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
          }
        },
      },
    ]

    scoped.effect(() => {
      const disposers = routes.map((route) => webServer.register(route))
      logger.info?.(`[token-usage] 已注册 ${disposers.length} 条只读路由（${ROUTE_PREFIX}/*）`)
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 卸载期的重复 dispose 不该抛错。
          }
        }
      }
    }, 'dsh-token-usage: routes')
  })

  // ── ④ 卸载：把内存里的增量落盘 ─────────────────────────────────────
  ctx.effect(() => () => {
    store.cancelPending?.()
    store.flush()
  }, 'dsh-token-usage: flush on dispose')
}

export { ROUTE_PREFIX }
