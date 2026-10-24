/**
 * **逐轮 / 逐会话用量折叠** —— 纯函数，host 侧使用。
 *
 * ## 为什么它在这里，而不是让客户端算
 *
 * harness 自己的「本轮用量」是在**浏览器里**折的：ui-chat 把 `deriveTurnTokenUsage`
 * 内联进 bundle，每次从原始事件重算一整轮。那个实现有一条我们不想继承的性质——
 * **全有全无**：任一生命周期异常（缺 `step/end`、attempt 未闭合、总量自相矛盾、
 * `reasoningTokens > outputTokens`）就让整轮读数消失，用户看不到任何数字。
 *
 * 我们走另一条路：`assistant/message` 事件**自带** `turn` / `step` / `usage`
 * （实测 `turn=2 step=1`），所以增量累加就够，不需要重放历史。好处是：
 *
 * 1. **容错**：缺边界也能从任意一条带 usage 的消息起算，只是可能少算开头部分；
 *    这比「整轮消失」诚实得多——显示的是一份偏低的实数，而不是空白。
 * 2. **O(1)**：每条事件只做几次加法，不重扫日志。
 * 3. **可回放**：`foldTurnEvent` 是纯函数，回填与实时两条路径共用同一入口。
 *
 * ## 重试语义（唯一需要小心的地方）
 *
 * 同一步骤可以被重试：`llm/retry-started` 关闭上一次尝试的替换窗口，随后的
 * `assistant/message` 是**另一次计费尝试**，应当**累加**而不是替换。
 * 而在同一步骤内、没有 `llm/retry-started` 的重复样本，是同一笔调用的**替换**
 * （harness 的 `addReplacing` 也是这个语义：先减去旧值再加新值）。
 *
 * 所以状态里要记住「本步骤最近一次样本」，用它决定是减后加、还是纯加。
 */

/** 零值桶（四个桶都是计费口径上互斥的）。 */
export const zeroBuckets = () => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

/** provider 的 usage 样本 → 我们的四个桶。
 *
 * ⚠️ `reasoningTokens` **不进桶**：它是 `outputTokens` 的子集，加进去就是重复计数。
 * 它只在「往下一层拆分」时有用，不能进总量。
 */
export function bucketsOf(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const input = Number(usage.inputTokens)
  const output = Number(usage.outputTokens)
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined
  // cacheRead / cacheWrite 是可选字段（不是所有 provider 都报）。
  const cacheRead = usage.cacheReadTokens === undefined ? 0 : Number(usage.cacheReadTokens)
  const cacheWrite = usage.cacheWriteTokens === undefined ? 0 : Number(usage.cacheWriteTokens)
  if (!Number.isFinite(cacheRead) || !Number.isFinite(cacheWrite)) return undefined
  return {
    uncachedInputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  }
}

/** 四个桶相加。 */
export function addBuckets(left, right) {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  }
}

/** 四个桶相减（用于「替换」：先撤掉旧样本再加新样本）。 */
export function subBuckets(left, right) {
  return {
    // 允许出现负数中间态的话内部账目会脏；钳到 0 是安全的（极少数乱序事件）。
    uncachedInputTokens: Math.max(0, left.uncachedInputTokens - right.uncachedInputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    cacheReadTokens: Math.max(0, left.cacheReadTokens - right.cacheReadTokens),
    cacheWriteTokens: Math.max(0, left.cacheWriteTokens - right.cacheWriteTokens),
  }
}

/** 四个桶的计费总量（**不含** reasoning——它是 output 的子集）。 */
export function totalOf(buckets) {
  if (buckets === undefined) return 0
  return buckets.uncachedInputTokens + buckets.outputTokens
    + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

/**
 * 从一条 `assistant/message` 事件里取出 usage 样本。
 *
 * 优先 `data.usage`（持久化权威样本）；退到 `data.stream` 里最后一个 usage chunk
 * （harness 的 `usageOf` 也是这个顺序，因为最终样本会替换流式样本）。
 *
 * @returns 桶，或 undefined（这条消息没报用量）。
 */
export function usageOfEvent(event) {
  if (event === null || typeof event !== 'object') return undefined
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const direct = bucketsOf(event.data?.usage)
  if (direct !== undefined) return direct
  const stream = event.data?.stream
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i]?.chunk
    if (chunk?.type === 'usage') {
      const fromStream = bucketsOf(chunk.usage)
      if (fromStream !== undefined) return fromStream
    }
  }
  return undefined
}

/** 一条事件的 turn / step 坐标（负数/非整数视为缺失）。 */
export function coordsOf(event) {
  const turn = Number(event?.data?.turn)
  const step = Number(event?.data?.step)
  return {
    turn: Number.isInteger(turn) && turn >= 0 ? turn : undefined,
    step: Number.isInteger(step) && step >= 0 ? step : undefined,
  }
}

/**
 * 新建一份逐会话折叠状态。
 *
 * `lastSample` 记录「本步骤最近一次样本」，用于区分替换与累加（见文件头）。
 */
export function emptyTurnState() {
  return {
    /** 当前轮次号（最后一条带坐标的事件）。 */
    turn: undefined,
    /** 当前步骤号。 */
    step: undefined,
    /** 上一轮的定格读数（`{ turn, buckets }`），供 UI 显示「上一轮」。 */
    previousTurn: undefined,
    /** 本轮累计（四个桶）。 */
    turnBuckets: zeroBuckets(),
    /** 本会话累计（四个桶）。 */
    sessionBuckets: zeroBuckets(),
    /** 本轮收到过多少条带用量的消息（诊断用）。 */
    turnSamples: 0,
    /** 本步骤最近一次样本，用于替换语义。 */
    lastSample: undefined,
    /** `lastSample` 所属的坐标 —— 决定「这次是替换还是累加」。 */
    lineTurn: undefined,
    lineStep: undefined,
  }
}

/**
 * 折叠一条事件，返回**新的**状态（纯函数，不修改入参）。
 *
 * 处理三类事件：
 * - `turn/start`：切到新轮，把上一轮读数定格到 `previousTurn`。
 * - `llm/retry-started`：清掉 lastSample，使随后的样本**累加**（重新计费）。
 * - `assistant/message` / `assistant/attempt`：带样本时按替换/累加规则入账。
 *
 * 其余事件原样返回（同一个引用，调用方可据此跳过写盘）。
 */
export function foldTurnEvent(state, event) {
  if (event === null || typeof event !== 'object') return state

  if (event.type === 'turn/start') {
    const turn = coordsOf(event).turn
    if (turn === undefined) return state
    if (state.turn === turn) return state
    // 上一轮若已有读数，定格下来供 UI 显示「上一轮」。
    const previousTurn = totalOf(state.turnBuckets) > 0 || state.turnSamples > 0
      ? { turn: state.turn, buckets: state.turnBuckets }
      : state.previousTurn
    return {
      ...state,
      turn,
      step: undefined,
      turnBuckets: zeroBuckets(),
      turnSamples: 0,
      lastSample: undefined,
      previousTurn,
    }
  }

  if (event.type === 'llm/retry-started') {
    // 重试 = 同一 (turn, step) 的另一次计费尝试 → 后续样本必须累加。
    return state.lastSample === undefined ? state : { ...state, lastSample: undefined }
  }

  const sample = usageOfEvent(event)
  if (sample === undefined) return state

  const coords = coordsOf(event)
  const turn = coords.turn ?? state.turn
  const step = coords.step ?? state.step

  // 换轮了但没看到 turn/start（例如从半截日志回放）：把旧轮定格后重开。
  let base = state
  if (state.turn !== undefined && turn !== undefined && turn !== state.turn) {
    const previousTurn = totalOf(state.turnBuckets) > 0 || state.turnSamples > 0
      ? { turn: state.turn, buckets: state.turnBuckets }
      : state.previousTurn
    base = {
      ...state,
      turn,
      step: undefined,
      turnBuckets: zeroBuckets(),
      turnSamples: 0,
      lastSample: undefined,
      previousTurn,
    }
  }

  // ── 替换语义 ──
  //
  // 同一步骤的重复样本是**同一笔调用**的更好版本（流式样本 → 最终样本），
  // 必须「先撤掉旧样本、再加入新样本」，而不是把两个都加上去。
  //
  // ⚠️ 不能先算差值再相加：`subBuckets` 会把负数钳到 0（防止乱序事件把账冲成
  // 负数），差值路径一旦为负就被吃掉，增量变 0，读数卡在旧值上。这里直接对
  // 累计表做「减一次旧、加一次新」，钳制只作用在真正的乱序异常上。
  const replacing = base.lastSample !== undefined
    && base.lineTurn === turn
    && base.lineStep === step
  const turnBuckets = addBuckets(
    replacing ? subBuckets(base.turnBuckets, base.lastSample) : base.turnBuckets,
    sample,
  )
  const sessionBuckets = addBuckets(
    replacing ? subBuckets(base.sessionBuckets, base.lastSample) : base.sessionBuckets,
    sample,
  )

  return {
    ...base,
    turn: turn ?? base.turn,
    step: step ?? base.step,
    lineTurn: turn,
    lineStep: step,
    turnBuckets,
    sessionBuckets,
    turnSamples: base.turnSamples + 1,
    lastSample: sample,
  }
}

/**
 * 把一条完整事件序列折叠成最终状态（回填路径用）。
 *
 * @param events 按 seq 升序的事件数组。
 * @returns 最终状态。
 */
export function foldTurnEvents(events) {
  let state = emptyTurnState()
  for (const event of events) state = foldTurnEvent(state, event)
  return state
}

/**
 * 状态 → 对外的会话视图（供 `/today?session=` 下发给客户端）。
 *
 * ⚠️ 字段名刻意用 `sessionTokens` / `turnTokens`，而不是 `totalTokens`：
 * 前者的口径是「每次调用的计费桶之和」，与 harness 的 `totalTokens`
 * （provider 上报、通常只含 input+output）不是一回事，同名会误导。
 */
export function sessionViewOf(state) {
  if (state === null || state === undefined) return undefined
  return {
    sessionTokens: totalOf(state.sessionBuckets),
    turnTokens: totalOf(state.turnBuckets),
    previousTurnTokens: state.previousTurn === undefined
      ? undefined
      : totalOf(state.previousTurn.buckets),
    turn: state.turn,
    steps: state.turnSamples,
    buckets: {
      session: state.sessionBuckets,
      turn: state.turnBuckets,
    },
  }
}
