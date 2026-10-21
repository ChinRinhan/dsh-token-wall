/**
 * **模型名归一化**：把「同一模型、不同渠道/不同后缀」的名字收敛成一个，
 * 并推出它属于哪个研发商。
 *
 * ## 为什么需要
 *
 * 本机实测的真实模型名（16 个）里，同一个模型散成了多个变体：
 *
 * ```
 * deepseek-v4.1-flash            1.54B   ← 主名
 * workbuddy/deepseek-v4.1-flash  25.6M   ← 带渠道前缀
 * deepseek-ai/deepseek-v4.1-flash 52K    ← 带另一种前缀
 * deepseek-v4.1-flash-free       23.1M   ← 带 free 后缀
 * ```
 *
 * 按名字直接分组会得到 4 行，读者看不出「这其实是同一个模型、走了 4 个渠道」。
 *
 * ## 两条设计原则
 *
 * 1. **不合并不同代际**。`deepseek-flash` / `deepseek-v4-flash` /
 *    `deepseek-v4.1-flash` 是三个不同版本，合并会掩盖「还在用旧模型」这个
 *    信息。用户明确要求不合并。
 * 2. **认不出就归 unknown**，不猜。`dfmodel` / `qfmodel` 从名字看不出厂商，
 *    硬猜会造出假数据。它们可以靠 `modelAliases` 显式配置。
 *
 * ## 归一化规则（只做**安全**的，即「去掉渠道/计费装饰」）
 *
 * | 规则 | 例子 |
 * |---|---|
 * | 去掉 `vendor/` 前缀 | `workbuddy/deepseek-v4.1-flash` → `deepseek-v4.1-flash` |
 * | 去掉 `-free` / `:free` 后缀 | `deepseek-v4.1-flash-free` → `deepseek-v4.1-flash` |
 * | 小写 | `Spark-X2.5-4B` → `spark-x2.5-4b` |
 *
 * ⚠️ 「去掉前缀」只在前缀**不是厂商名**时做。`minimax/minimax-m3.1-flash`
 * 的前缀 `minimax` 是厂商名，去掉后剩 `minimax-m3.1-flash`——仍然正确。
 */

import { addTotals, emptyTotals } from './fold.js'

/**
 * 研发商识别表：按模型名前缀判断。
 *
 * 顺序有意义——`deepseek` 要在通用规则之前匹配。
 */
const VENDOR_PATTERNS = [
  { vendor: 'deepseek', re: /^deepseek[-.]/ },
  { vendor: 'deepseek', re: /^deepseek$/ },
  { vendor: 'zhipu', re: /^glm[-.]/ },
  { vendor: 'xiaomi', re: /^mimo[-.]/ },
  { vendor: 'minimax', re: /^minimax[-.]/ },
  { vendor: 'stepfun', re: /^step[-.]/ },
  { vendor: 'qwen', re: /^qwen[-.]/ },
  { vendor: 'anthropic', re: /^claude[-.]/ },
  { vendor: 'openai', re: /^(gpt|o[134])[-.]/ },
  { vendor: 'google', re: /^(gemini|gemma)[-.]/ },
  { vendor: 'moonshot', re: /^(kimi|moonshot)[-.]/ },
  { vendor: 'spark', re: /^spark[-.]/ },
]

/** 研发商的展示名（未知归「其他」）。 */
export const VENDOR_LABELS = {
  deepseek: 'DeepSeek',
  zhipu: '智谱 GLM',
  xiaomi: '小米 MiMo',
  minimax: 'MiniMax',
  stepfun: '阶跃 Step',
  qwen: '通义千问',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  moonshot: 'Moonshot',
  spark: '讯飞星火',
  unknown: '其他',
}

/** 认不出厂商时用的键。 */
export const UNKNOWN_VENDOR = 'unknown'

/**
 * 去掉渠道前缀：`workbuddy/deepseek-v4.1-flash` → `deepseek-v4.1-flash`。
 *
 * ⚠️ 只在**恰好一个**斜杠、且后半段非空时切。多斜杠的情况
 * （`a/b/c`）保留原样，避免把模型名里的路径切坏。
 */
function stripVendorPrefix(name) {
  const parts = name.split('/')
  if (parts.length !== 2) return name
  const [head, tail] = parts
  if (head === '' || tail === '') return name
  return tail
}

/** 去掉计费装饰后缀：`-free`、`:free`、`-beta` 之类。 */
function stripSuffix(name) {
  return name.replace(/[-:](free|beta|preview-beta)$/i, '')
}

/**
 * 归一化一个模型名。
 *
 * @param raw 原始模型名（可能是 `provider/model` 形态，可能带 `-free`）。
 * @param aliases 用户配置的别名表 `{ 原名: { vendor?, model? } }`。
 * @returns `{ vendor, model }`；`vendor` 认不出时是 `'unknown'`。
 */
export function normalizeModel(raw, aliases) {
  const original = String(raw ?? '').trim()
  if (original === '') return { vendor: UNKNOWN_VENDOR, model: '' }

  // ① 用户别名表优先级最高：它可以同时覆盖 vendor 与 model。
  if (aliases !== null && typeof aliases === 'object') {
    const hit = aliases[original] ?? aliases[original.toLowerCase()]
    if (hit !== null && typeof hit === 'object') {
      const vendor = typeof hit.vendor === 'string' && hit.vendor !== ''
        ? hit.vendor
        : UNKNOWN_VENDOR
      const model = typeof hit.model === 'string' && hit.model !== ''
        ? hit.model
        : original.toLowerCase()
      return { vendor, model }
    }
  }

  // ② 自动归一化：去渠道前缀 → 去计费后缀 → 小写。
  let name = stripVendorPrefix(original)
  name = stripSuffix(name)
  name = name.toLowerCase().trim()

  // ③ 从归一化后的名字推厂商。
  for (const { vendor, re } of VENDOR_PATTERNS) {
    if (re.test(name)) return { vendor, model: name }
  }
  return { vendor: UNKNOWN_VENDOR, model: name }
}

/**
 * 把一批 `{ model, totals }` 行按归一化后的模型合并。
 *
 * @param rows  原始行（来自 `aggregateRange({ groupBy: 'model' })`）。
 * @param aliases 别名表。
 * @returns 合并后的行：`{ key, vendor, model, label, variants, totals }`，
 *          按 totalTokens 降序。
 */
export function groupModels(rows, aliases) {
  const out = new Map()
  for (const row of rows) {
    const raw = String(row?.model ?? '')
    const { vendor, model } = normalizeModel(raw, aliases)
    const key = `${vendor}${'\u0000'}${model}`
    let entry = out.get(key)
    if (entry === undefined) {
      entry = {
        key,
        vendor,
        model,
        label: model === '' ? '(unnamed model)' : model,
        // 记录被合并进来的原始名（用于「N 个变体」提示）。
        variants: new Set(),
        totals: emptyTotals(),
      }
      out.set(key, entry)
    }
    entry.variants.add(raw)
    // ⚠️ `addTotals` 返回**新对象**、不改入参（见 lib/fold.js）。
    entry.totals = addTotals(entry.totals, row.totals)
  }
  const list = [...out.values()].map((e) => ({ ...e, variants: [...e.variants] }))
  list.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens)
  return list
}

/**
 * 把一批 `{ model, totals }` 行按**研发商**合并。
 *
 * @param rows  原始行。
 * @param aliases 别名表。
 * @returns 合并后的行：`{ key, vendor, label, models, totals }`，降序。
 */
export function groupVendors(rows, aliases) {
  const out = new Map()
  for (const row of rows) {
    const raw = String(row?.model ?? '')
    const { vendor, model } = normalizeModel(raw, aliases)
    let entry = out.get(vendor)
    if (entry === undefined) {
      entry = {
        key: vendor,
        vendor,
        label: VENDOR_LABELS[vendor] ?? vendor,
        models: new Set(),
        totals: emptyTotals(),
      }
      out.set(vendor, entry)
    }
    entry.models.add(model)
    entry.totals = addTotals(entry.totals, row.totals)
  }
  const list = [...out.values()].map((e) => ({ ...e, models: [...e.models] }))
  list.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens)
  return list
}
