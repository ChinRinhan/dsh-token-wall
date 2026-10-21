/**
 * **方块墙**的纯逻辑：把累计 token 量换算成「10M 一个方块」的网格。
 *
 * ## 为什么单独成文件
 *
 * 网格换算有若干容易算错的边界（刚好整除、跨页、进度百分比、当前块归属哪一页），
 * 这些都应该被单测穷举，而不是埋在 UI 组件里靠肉眼验证。
 *
 * ## 为什么客户端有一份等价实现
 *
 * `client.js` 是浏览器里的手写 ModuleLoader bundle，**不能 import 本文件**
 * （它不是 ES 模块，且跨端拿不到 Node 解析）。所以客户端内联了一份同样的逻辑。
 * 防漂移靠 `test/blocks.test.mjs`：它同时跑本模块与客户端渲染结果，**交叉校验
 * 两者对同一输入的换算必须一致**——与本项目 host 侧的做法同源。
 *
 * ## 术语
 *
 * - **unit**：一个方块代表的 token 数（默认 10M）。
 * - **filled**：已填满的方块数。
 * - **progress**：当前正在填的那一块的进度（0~1）。
 * - **page**：一页 `pageSize` 个格子。方块只增不减，所以必须分页，
 *   否则一年后会有几百格把界面撑爆。
 */

/** 默认单位：一个方块 10M tokens。 */
export const DEFAULT_UNIT = 10_000_000

/** 默认每页格子数：100 格 × 10M = 10 亿 tokens 一页。 */
export const DEFAULT_PAGE_SIZE = 100

/**
 * 把一个 token 总量换算成方块墙状态。
 *
 * @param total 累计 token 数（负数/非有限值按 0 处理）。
 * @param options.unit     一个方块代表多少 token（<= 0 回落到默认值）。
 * @param options.pageSize 每页格子数（<= 0 回落到默认值）。
 * @returns `{ filled, remainder, progress, unit, pageSize, pageIndex, pageStart,
 *             pageCount, cells, total }`
 *          `cells` 恒有 `pageSize` 项，每项 `{ index, state, fill }`：
 *          - `index`：**全局**方块序号（0 基）
 *          - `state`：`'filled' | 'partial' | 'empty'`
 *          - `fill`：`0~1` 的填充比例
 */
export function blockWall(total, options = {}) {
  const rawTotal = Number(total)
  const safeTotal = Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal : 0

  const rawUnit = Number(options.unit)
  const unit = Number.isFinite(rawUnit) && rawUnit > 0 ? rawUnit : DEFAULT_UNIT

  const rawPageSize = Number(options.pageSize)
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0
    ? Math.floor(rawPageSize)
    : DEFAULT_PAGE_SIZE

  const filled = Math.floor(safeTotal / unit)
  const remainder = safeTotal - filled * unit
  // 注意：刚好整除时 remainder 为 0，此时「当前块」进度是 0（下一块刚开始）。
  const progress = remainder / unit

  // 当前正在填的方块是 `filled`，它落在哪一页由 `filled` 决定。
  const pageIndex = Math.floor(filled / pageSize)
  const pageStart = pageIndex * pageSize

  const cells = []
  for (let i = 0; i < pageSize; i += 1) {
    const index = pageStart + i
    let state = 'empty'
    let fill = 0
    if (index < filled) {
      state = 'filled'
      fill = 1
    } else if (index === filled) {
      state = 'partial'
      fill = progress
    }
    cells.push({ index, state, fill })
  }

  return {
    total: safeTotal,
    unit,
    pageSize,
    filled,
    remainder,
    progress,
    pageIndex,
    pageStart,
    // 至少 1 页；当前页永远存在。
    pageCount: pageIndex + 1,
    cells,
  }
}

/** 人类可读的单位描述（用于界面标注「每格 10M」）。 */
export function unitLabel(unit) {
  const u = Number(unit) || DEFAULT_UNIT
  if (u >= 1e9) return `${trimZero(u / 1e9)}B`
  if (u >= 1e6) return `${trimZero(u / 1e6)}M`
  if (u >= 1e3) return `${trimZero(u / 1e3)}K`
  return String(u)
}

/** 非负整数钳制。 */
function clampCount(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

/** 0~1 比例钳制。 */
function clampRatio(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(Math.max(n, 0), 1)
}

/** 去掉小数末尾的 0（10.0 → 10，1.5 → 1.5）。 */
function trimZero(n) {
  return String(Number(n.toFixed(2)))
}
