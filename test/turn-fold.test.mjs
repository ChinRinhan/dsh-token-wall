/**
 * 逐轮折叠的单元测试。
 *
 * 这块逻辑最容易被写错的地方有三处，每处都直接对应一条测试：
 * 1. **重试必须累加**（同一 (turn, step) 的第二次尝试是另一次计费）；
 * 2. **同步骤重复样本必须替换**（不是累加，否则一次调用被记两遍）；
 * 3. **reasoningTokens 是 outputTokens 的子集**，绝不能让总量膨胀。
 *
 * 另外还锁住「容错」这条设计承诺：缺 turn/start、事件乱序、只有半截日志时，
 * 读数可以偏低，但**不能消失**——这正是我们不采用 harness 那套全有全无语义的理由。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bucketsOf,
  totalOf,
  usageOfEvent,
  emptyTurnState,
  foldTurnEvent,
  foldTurnEvents,
  sessionViewOf,
} from '../lib/turns.js'

/** 造一条 assistant/message。 */
function msg({ turn, step, input = 100, output = 10, cacheRead, cacheWrite, reasoning }) {
  const usage = { inputTokens: input, outputTokens: output }
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  return { type: 'assistant/message', data: { turn, step, usage } }
}

const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const retryStarted = (turn, step) => ({ type: 'llm/retry-started', data: { turn, step } })

// ── bucketsOf ─────────────────────────────────────────────────────────

test('bucketsOf：缺省的可选桶补 0', () => {
  assert.deepEqual(bucketsOf({ inputTokens: 5, outputTokens: 2 }), {
    uncachedInputTokens: 5,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
})

test('bucketsOf：非法输入返回 undefined（不伪装成 0）', () => {
  assert.equal(bucketsOf(null), undefined)
  assert.equal(bucketsOf({}), undefined, '缺 inputTokens/outputTokens 不能当 0')
  assert.equal(bucketsOf({ inputTokens: 'x', outputTokens: 1 }), undefined)
})

test('reasoningTokens 不进总量（它是 output 的子集）', () => {
  const b = bucketsOf({ inputTokens: 100, outputTokens: 50, reasoningTokens: 40 })
  assert.equal(totalOf(b), 150, '100 + 50；reasoning 不再加一次')
})

// ── usageOfEvent ──────────────────────────────────────────────────────

test('usageOfEvent：优先 data.usage', () => {
  const ev = {
    type: 'assistant/message',
    data: {
      usage: { inputTokens: 1, outputTokens: 2 },
      stream: [{ chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } } }],
    },
  }
  assert.deepEqual(usageOfEvent(ev), {
    uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('usageOfEvent：没有 data.usage 时退到流里最后一个 usage chunk', () => {
  const ev = {
    type: 'assistant/message',
    data: {
      stream: [
        { chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
        { chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 8 } } },
      ],
    },
  }
  assert.deepEqual(usageOfEvent(ev), {
    uncachedInputTokens: 7, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('usageOfEvent：非用量事件返回 undefined', () => {
  assert.equal(usageOfEvent({ type: 'tool/call', data: {} }), undefined)
  assert.equal(usageOfEvent({ type: 'assistant/message', data: {} }), undefined)
})

// ── 累加 vs 替换 ──────────────────────────────────────────────────────

test('不同步骤：累加', () => {
  let s = foldTurnEvents([
    turnStart(1),
    msg({ turn: 1, step: 1, input: 100, output: 10 }),
    msg({ turn: 1, step: 2, input: 200, output: 20 }),
  ])
  assert.equal(totalOf(s.turnBuckets), 330, '100+10+200+20')
  assert.equal(totalOf(s.sessionBuckets), 330)
})

test('同一步骤重复样本：替换，不是累加', () => {
  let s = foldTurnEvents([
    turnStart(1),
    msg({ turn: 1, step: 1, input: 100, output: 10 }),
    msg({ turn: 1, step: 1, input: 100, output: 10 }), // 同一笔的重复样本
  ])
  assert.equal(totalOf(s.turnBuckets), 110, '重复样本不能记两遍')
})

test('同一步骤样本变大：替换为新值（不是旧+新）', () => {
  let s = foldTurnEvents([
    turnStart(1),
    msg({ turn: 1, step: 1, input: 100, output: 10 }),
    msg({ turn: 1, step: 1, input: 150, output: 20 }), // 流式样本的最终版
  ])
  assert.equal(totalOf(s.turnBuckets), 170, '应为 150+20，而不是 110+170')
})

test('重试之后同一步骤：必须累加（两次计费尝试）', () => {
  let s = foldTurnEvents([
    turnStart(1),
    msg({ turn: 1, step: 1, input: 100, output: 10 }),
    retryStarted(1, 1),
    msg({ turn: 1, step: 1, input: 100, output: 10 }), // 重试后的另一次尝试
  ])
  assert.equal(totalOf(s.turnBuckets), 220, '重试是另一次计费，必须累加')
})

// ── 轮次边界 ──────────────────────────────────────────────────────────

test('turn/start 把上一轮定格到 previousTurn', () => {
  let s = foldTurnEvents([
    turnStart(1),
    msg({ turn: 1, step: 1, input: 100, output: 10 }),
    turnStart(2),
    msg({ turn: 2, step: 1, input: 7, output: 3 }),
  ])
  assert.equal(totalOf(s.turnBuckets), 10, '本轮只算第 2 轮')
  assert.equal(s.previousTurn.turn, 1)
  assert.equal(totalOf(s.previousTurn.buckets), 110)
  assert.equal(totalOf(s.sessionBuckets), 120, '会话累计含两轮')
})

test('会话累计跨轮次单调累加', () => {
  let s = emptyTurnState()
  for (let turn = 1; turn <= 3; turn += 1) {
    s = foldTurnEvent(s, turnStart(turn))
    s = foldTurnEvent(s, msg({ turn, step: 1, input: 10, output: 0 }))
  }
  assert.equal(totalOf(s.sessionBuckets), 30)
  assert.equal(totalOf(s.turnBuckets), 10, '本轮只有第 3 轮')
})

// ── 容错（我们相对 harness 的改进点）──────────────────────────────────

test('缺 turn/start 也能起算（半截日志）', () => {
  const s = foldTurnEvents([msg({ turn: 5, step: 1, input: 40, output: 2 })])
  assert.equal(totalOf(s.turnBuckets), 42, '读数不因缺边界而消失')
  assert.equal(s.turn, 5)
})

test('缺 step 坐标也能入账', () => {
  const ev = { type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 9, outputTokens: 1 } } }
  const s = foldTurnEvents([turnStart(2), ev])
  assert.equal(totalOf(s.turnBuckets), 10)
})

test('空事件流返回零值状态（不抛错）', () => {
  const s = foldTurnEvents([])
  assert.equal(totalOf(s.turnBuckets), 0)
  assert.equal(totalOf(s.sessionBuckets), 0)
  assert.equal(s.turn, undefined)
})

test('没有用量的消息不改动状态（同一引用，便于跳过写盘）', () => {
  const s = emptyTurnState()
  const next = foldTurnEvent(s, { type: 'tool/call', data: {} })
  assert.equal(next, s, '应返回同一个引用')
})

// ── sessionViewOf ─────────────────────────────────────────────────────

test('sessionViewOf：字段名不与 harness 的 totalTokens 混淆', () => {
  const s = foldTurnEvents([
    turnStart(1),
    msg({ turn: 1, step: 1, input: 100, output: 10 }),
    turnStart(2),
    msg({ turn: 2, step: 1, input: 5, output: 5 }),
  ])
  const view = sessionViewOf(s)
  assert.equal(view.sessionTokens, 120)
  assert.equal(view.turnTokens, 10)
  assert.equal(view.previousTurnTokens, 110)
  assert.equal(view.turn, 2)
  assert.equal(view.totalTokens, undefined, '不应存在同名 totalTokens 字段')
})

test('sessionViewOf(undefined) 返回 undefined', () => {
  assert.equal(sessionViewOf(undefined), undefined)
  assert.equal(sessionViewOf(null), undefined)
})
