/**
 * 从**宿主真实 CSS** 里读出主题 token 的实际取值。
 *
 * ## 为什么必须有这个模块
 *
 * 早先 `tools/visual-check.mjs` 把主题 token 的值**手写**在文件里
 * （`--dsw-alias-brand-primary: #247bbf`）。那是**我编的**——真实浅色主题里
 * `--dsw-alias-brand-primary` 是 `rgb(15,17,21)`（近黑）。于是所有截图里的
 * 方块墙都是蓝的，而真实页面是近黑色的方块。
 *
 * 这和「验证器伪造 styles」是同一类错误：**验证器骗过了自己**。手写主题值
 * 就是「假装宿主是另一个样子」，截图当然好看，但完全不能代表用户看到的东西。
 *
 * ## 做法
 *
 * 宿主的主题定义在
 * `@deepseek-ai/dsh-client-ui-theme/lib/styles/design-platform.css`：
 *
 * - `body { … }` → 浅色
 * - `body[data-ds-dark-theme] { … }` → 深色
 *
 * 里面全是 `var(--dsw-static-…)` 的间接引用，所以要**解析两层**：
 * alias → static → 字面量。
 *
 * @returns `{ light: Map<string,string>, dark: Map<string,string> }`
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 找到 dsh-client-ui-theme 的样式目录。 */
function findThemeStyles() {
  const candidates = []
  const dshHome = process.env.DSH_HOME
  if (typeof dshHome === 'string' && dshHome.trim() !== '') {
    candidates.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'styles'))
  }
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (typeof home === 'string' && home.trim() !== '') {
    candidates.push(join(home, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'styles'))
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'design-platform.css'))) return dir
  }
  return undefined
}

/**
 * 解析一个 CSS 块里的自定义属性。
 * @param text  块文本。
 * @returns Map<name, value>
 */
function parseBlock(text) {
  const out = new Map()
  // 只取 `--name: value;` 形式（值里没有分号的简单情形；主题里都是单值）。
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g
  let m
  while ((m = re.exec(text)) !== null) {
    out.set(m[1], m[2].trim())
  }
  return out
}

/** 取出 `selector { … }` 的内容（支持嵌套花括号计数）。 */
function extractBlock(css, selector) {
  const idx = css.indexOf(selector)
  if (idx === -1) return undefined
  const open = css.indexOf('{', idx)
  if (open === -1) return undefined
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return undefined
}

/**
 * 把 `var(--x)` 递归解析成字面量。
 * @param value  原始值。
 * @param table  变量表（含 alias 与 static）。
 * @param depth  递归深度上限。
 */
function resolveValue(value, table, depth = 0) {
  if (typeof value !== 'string' || depth > 8) return value
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim())
  if (m === null) return value.trim()
  const next = table.get(m[1])
  if (next === undefined) return value.trim()
  return resolveValue(next, table, depth + 1)
}

/**
 * 读出两套主题的 token 取值。
 * @param names 要取值的 token 名（不含 `--`）。
 * @returns `{ light: Record<string,string>, dark: Record<string,string>, source: string|undefined }`
 */
export function readThemeTokens(names) {
  const dir = findThemeStyles()
  if (dir === undefined) {
    return { light: {}, dark: {}, source: undefined }
  }
  const css = readFileSync(join(dir, 'design-platform.css'), 'utf-8')

  // 第一个 body 块 = 静态色板 + 浅色 alias；第二个 = 深色 alias。
  // 结构：`body { statics… }` → `body[data-ds-dark-theme] { statics… }` → `body { aliases… }` → `body[data-ds-dark-theme] { aliases… }`
  const blocks = []
  let cursor = 0
  for (;;) {
    const open = css.indexOf('{', cursor)
    if (open === -1) break
    let depth = 0
    let end = -1
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1
      else if (css[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) break
    const selector = css.slice(cursor, open).trim().split('\n').pop().trim()
    blocks.push({ selector, body: css.slice(open + 1, end) })
    cursor = end + 1
  }

  const staticsLight = parseBlock(extractBlock(css, 'body {\n  --dsw-static') ?? '')
  const staticsDark = parseBlock(extractBlock(css, 'body[data-ds-dark-theme] {\n  --dsw-static') ?? '')

  // alias 块：取「含 --dsw-alias-」的那些 body 块。
  const aliasBlocks = blocks.filter((b) => b.body.includes('--dsw-alias-'))
  const aliasLight = parseBlock(aliasBlocks[0]?.body ?? '')
  const aliasDark = parseBlock(aliasBlocks[1]?.body ?? '')

  const lightTable = new Map([...staticsLight, ...aliasLight])
  const darkTable = new Map([...staticsDark, ...aliasDark])

  const pick = (table, name) => resolveValue(table.get(name), table) ?? ''

  const light = {}
  const dark = {}
  for (const name of names) {
    const key = `--dsw-alias-${name}`
    light[key] = pick(lightTable, key)
    dark[key] = pick(darkTable, key)
  }
  return { light, dark, source: dir }
}

/** 本插件用到的 token 清单（与 client.js 的 CSS 里引用的完全一致）。 */
export const USED_TOKENS = [
  'label-primary',
  'label-secondary',
  'label-tertiary',
  'bg-base',
  'bg-layer-1',
  'bg-layer-2',
  'bg-layer-3',
  'bg-overlay',
  'border-l1',
  'border-l2',
  'brand-primary',
  'state-error-primary',
  'interactive-bg-hover',
  // 上下文读数的严重度着色（PR2 之后加的）。
  //
  // ⚠️ state-warn-primary 是**在宿主主题里真实存在**的语义色（已用
  // readThemeTokens 验过：rgb(245,158,11)）。加进这份清单不是「让测试闭嘴」，
  // 而是声明本插件**有意**使用它——清单本身就是「允许引用的 token 集合」。
  //
  // 只加这一个：state-error-primary 上面已有；进度条保持单色（它是积累进度，
  // 不是告警），所以不需要 secondary 那一档。
  'state-warn-primary',
]
