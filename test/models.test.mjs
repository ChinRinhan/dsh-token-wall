/**
 * 模型名归一化与两级归并的单测。
 *
 * 覆盖：
 * 1. 安全归一化（去渠道前缀、去 -free 后缀、小写）；
 * 2. **不合并不同代际**（用户明确要求）；
 * 3. 认不出厂商时归 unknown（不猜）；
 * 4. 别名表可以覆盖 vendor 与 model；
 * 5. 归并后合计不丢量（与输入总量一致）。
 *
 * 运行：`node --test test/models.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  UNKNOWN_VENDOR,
  VENDOR_LABELS,
  groupModels,
  groupVendors,
  normalizeModel,
} from '../lib/models.js'

test('去渠道前缀：同一模型的不同前缀归到一起', () => {
  const a = normalizeModel('deepseek-v4.1-flash')
  const b = normalizeModel('workbuddy/deepseek-v4.1-flash')
  const c = normalizeModel('deepseek-ai/deepseek-v4.1-flash')
  assert.deepEqual(a, { vendor: 'deepseek', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(b, a, '带渠道前缀的必须与主名一致')
  assert.deepEqual(c, a, '另一种前缀也必须一致')
})

test('去计费后缀：-free / :free 归到同一个模型', () => {
  assert.deepEqual(
    normalizeModel('deepseek-v4.1-flash-free'),
    normalizeModel('deepseek-v4.1-flash'),
  )
  assert.deepEqual(
    normalizeModel('minimax/minimax-m3.1-flash:free'),
    { vendor: 'minimax', model: 'minimax-m3.1-flash' },
  )
})

test('**不合并不同代际**（用户明确要求）', () => {
  const v41 = normalizeModel('deepseek-v4.1-flash')
  const v4 = normalizeModel('deepseek-v4-flash')
  const legacy = normalizeModel('deepseek-flash')
  // 三者的 vendor 相同，但 model 必须各不相同。
  assert.equal(v41.vendor, 'deepseek')
  assert.equal(v4.vendor, 'deepseek')
  assert.equal(legacy.vendor, 'deepseek')
  assert.notEqual(v41.model, v4.model)
  assert.notEqual(v41.model, legacy.model)
  assert.notEqual(v4.model, legacy.model)
})

test('认不出厂商时归 unknown，不猜', () => {
  for (const name of ['dfmodel', 'qfmodel', 'space-bunny-free']) {
    assert.equal(normalizeModel(name).vendor, UNKNOWN_VENDOR, `${name} 不该被猜成某个厂商`)
  }
  // unknown 的展示名是「其他」。
  assert.equal(VENDOR_LABELS[UNKNOWN_VENDOR], '其他')
})

test('别名表优先级最高，可覆盖 vendor 与 model', () => {
  const aliases = {
    dfmodel: { vendor: 'deepseek', model: 'deepseek-v4.1-flash' },
    qfmodel: { model: 'deepseek-v4.1-flash' }, // 只给 model，vendor 落 unknown
  }
  assert.deepEqual(normalizeModel('dfmodel', aliases), {
    vendor: 'deepseek', model: 'deepseek-v4.1-flash',
  })
  assert.deepEqual(normalizeModel('qfmodel', aliases), {
    vendor: UNKNOWN_VENDOR, model: 'deepseek-v4.1-flash',
  })
  // 未命中的名字走自动归一化。
  assert.deepEqual(normalizeModel('glm-5.3-flash', aliases), {
    vendor: 'zhipu', model: 'glm-5.3-flash',
  })
})

test('空名与脏输入不崩', () => {
  assert.equal(normalizeModel('').vendor, UNKNOWN_VENDOR)
  assert.equal(normalizeModel(undefined).vendor, UNKNOWN_VENDOR)
  assert.equal(normalizeModel(null).model, '')
  // 多斜杠不切（避免把模型名里的路径切坏）。
  assert.equal(normalizeModel('a/b/c').model, 'a/b/c')
})

test('groupModels：4 个变体合成 1 行，且记录变体数', () => {
  const mk = (model, totalTokens) => ({ model, totals: { requests: 1, totalTokens } })
  const rows = [
    mk('deepseek-v4.1-flash', 1000),
    mk('workbuddy/deepseek-v4.1-flash', 200),
    mk('deepseek-ai/deepseek-v4.1-flash', 50),
    mk('deepseek-v4.1-flash-free', 300),
    mk('glm-5.3-flash', 400),
  ]
  const merged = groupModels(rows)
  assert.equal(merged.length, 2, '应只剩 2 个模型')
  const ds = merged.find((r) => r.model === 'deepseek-v4.1-flash')
  assert.equal(ds.variants.length, 4, '应记录 4 个原始变体')
  assert.equal(ds.totals.totalTokens, 1550, '合计必须是 1000+200+50+300')
  // 降序：deepseek(1550) 在 glm(400) 前。
  assert.equal(merged[0].model, 'deepseek-v4.1-flash')
})

test('groupVendors：按研发商合并，记录含几个模型', () => {
  const mk = (model, totalTokens) => ({ model, totals: { requests: 1, totalTokens } })
  const rows = [
    mk('deepseek-v4.1-flash', 1000),
    mk('deepseek-flash', 500),
    mk('glm-5.3-flash', 400),
    mk('dfmodel', 100),
  ]
  const byVendor = groupVendors(rows)
  const ds = byVendor.find((r) => r.vendor === 'deepseek')
  assert.equal(ds.totals.totalTokens, 1500)
  assert.equal(ds.models.length, 2, 'DeepSeek 下有 2 个代际（不合并）')
  assert.equal(ds.label, 'DeepSeek')
  // 认不出的归「其他」。
  const other = byVendor.find((r) => r.vendor === UNKNOWN_VENDOR)
  assert.equal(other.totals.totalTokens, 100)
  assert.equal(other.label, '其他')
})

test('归并后总量守恒（不丢也不重）', () => {
  const mk = (model, totalTokens) => ({ model, totals: { requests: 1, totalTokens } })
  const rows = [
    mk('deepseek-v4.1-flash', 1000),
    mk('workbuddy/deepseek-v4.1-flash', 200),
    mk('glm-5.3-flash', 400),
    mk('dfmodel', 100),
  ]
  const inputTotal = rows.reduce((a, r) => a + r.totals.totalTokens, 0)
  const byModel = groupModels(rows).reduce((a, r) => a + r.totals.totalTokens, 0)
  const byVendor = groupVendors(rows).reduce((a, r) => a + r.totals.totalTokens, 0)
  assert.equal(byModel, inputTotal, '按模型归并后总量必须守恒')
  assert.equal(byVendor, inputTotal, '按厂商归并后总量必须守恒')
})
