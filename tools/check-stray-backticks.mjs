/**
 * 检查源文件里**落单**的反引号（会破坏模板字符串的语法）。
 *
 * ## 为什么需要它
 *
 * 这个插件的 `client.js` 与 `tools/visual-check.mjs` 里有大段 CSS / HTML 的
 * 模板字符串。往注释里写一个 Markdown 风格的行内代码（`xxx`）看着无害，
 * 却会让模板字符串**提前闭合**，整个文件语法错误。
 *
 * 实际踩坑记录：同一个问题在 `client.js` 上踩了 4 次、在
 * `tools/visual-check.mjs` 上踩了 3 次，每次都是「改一处 → 报语法错 → 找是哪行
 * → 换成普通引号」，一轮返工要花好几分钟。
 *
 * ## 为什么必须是**独立文件**
 *
 * 检查器如果放在被检查的文件里，那它自己还没跑到，被检查的文件就已经因为
 * 语法错误无法加载了——检查器形同虚设（实测：把检查器放进
 * `visual-check.mjs` 后，注入落单反引号时先报 SyntaxError，检查根本没跑）。
 *
 * 所以它独立成文件，用 `node --check` 之外的方式调用：
 *
 *   node tools/check-stray-backticks.mjs <文件…>
 *
 * 退出码 0 = 干净，1 = 有落单反引号。
 */

/**
 * 统计文本里**落单**的反引号数量。
 *
 * 「落单」= 不属于任何一对模板字符串、也不在注释或普通字符串里的反引号。
 * 扫描时：
 * - 跳过双斜杠开头的行注释与星号斜杠开头的块注释（注释里的反引号不影响语法）；
 * - 跳过单引号与双引号包起来的普通字符串；
 * - 识别反引号包起来的模板字符串（含花括号插值）。
 *
 * ⚠️ 本文件自己的块注释里也不能出现「星号斜杠」序列——那会提前闭合注释。
 * 这不是玩笑：本工具的第一版就因为注释里写了「跳过单引号/双引号字符串」而
 * 把自己写崩了。
 *
 * @param {string} text 源码文本。
 * @returns {number} 落单反引号数量。
 */
export function countStrayBackticks(text) {
  let count = 0
  let inTemplate = false
  let templateDepth = 0
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === '' && !inTemplate && ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (quote === '' && !inTemplate && ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (quote !== '') {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '\\') { i += 1; continue }
    if (ch === '$' && text[i + 1] === '{') { templateDepth += 1; i += 1; continue }
    if (ch === '}' && templateDepth > 0) { templateDepth -= 1; continue }
    if (ch !== '`') continue
    if (inTemplate && templateDepth === 0) {
      inTemplate = false
    } else if (!inTemplate) {
      inTemplate = true
    } else {
      count += 1
    }
  }
  if (inTemplate) count += 1
  return count
}

/** 直接运行时：检查命令行给出的文件。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 「本文件是主入口」的判定：比较解析后的绝对路径。
// ⚠️ 早先写成 import.meta.url === `file://${process.argv[1]}` 的字符串比较，
// 在 Windows 上分隔符不匹配 → 永远不相等 → CLI 分支根本不执行
// （实测：跑起来 exit 0 但一行输出都没有）。
const isMain = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === fileURLToPath(`file://${process.argv[1].replace(/\\/g, '/')}`)

if (isMain) {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    console.error('用法: node tools/check-stray-backticks.mjs <文件…>')
    process.exit(1)
  }
  let bad = 0
  for (const file of files) {
    const n = countStrayBackticks(readFileSync(file, 'utf-8'))
    if (n > 0) {
      bad += 1
      console.error(`✗ ${file}: ${n} 个落单反引号（会破坏模板字符串）`)
    } else {
      console.log(`✓ ${file}`)
    }
  }
  process.exit(bad === 0 ? 0 : 1)
}
