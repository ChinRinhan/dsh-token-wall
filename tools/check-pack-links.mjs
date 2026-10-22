/**
 * 检查 README 里的**相对链接**在 npm 包里是否真的存在。
 *
 * ## 为什么需要
 *
 * npm 只会发布 `package.json` 中 `files` 白名单里的文件。README 是会被发布的
 * （npm 强制带上），但如果它链接到 `docs/DESIGN.md` 而 `docs/` 不在白名单里，
 * 那么在 npm 页面上点这个链接就是 404——读者会以为文档坏了。
 *
 * 这类缺陷**只在发布之后才暴露**：GitHub 上一切正常，因为仓库里有那个文件。
 *
 * 用法: node tools/check-pack-links.mjs
 * 退出码: 0 = 全部可解析；1 = 有链接指向不会发布的文件
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

/**
 * npm 打包时会包含的文件集合。
 *
 * 规则（简化了 npm 的真实行为，只覆盖本项目用到的部分）：
 * - `package.json` / `README*` / `LICENSE*` 总是包含
 * - `files` 里列的文件或目录（目录递归展开）
 */
function packedFiles() {
  const out = new Set()
  for (const always of ['package.json', 'README.md', 'LICENSE']) {
    if (existsSync(join(root, always))) out.add(always)
  }
  for (const entry of Array.isArray(pkg.files) ? pkg.files : []) {
    const abs = join(root, entry)
    if (!existsSync(abs)) continue
    if (!statSync(abs).isDirectory()) {
      out.add(entry)
      continue
    }
    // 目录：广度优先展开。
    const queue = [entry]
    while (queue.length > 0) {
      const cur = queue.shift()
      for (const name of readdirSync(join(root, cur))) {
        const rel = `${cur}/${name}`
        const absChild = join(root, rel)
        if (statSync(absChild).isDirectory()) queue.push(rel)
        else out.add(rel)
      }
    }
  }
  return out
}

const packed = packedFiles()

// 抽 README 里的相对链接（跳过 http(s) 与纯锚点），去掉可选 #fragment。
const readme = readFileSync(join(root, 'README.md'), 'utf-8')
const links = [...new Set(
  [...readme.matchAll(/\]\((?!https?:)([^)#]+)(?:#[^)]*)?\)/g)]
    .map((m) => m[1].replace(/^\.\//, '')),
)]

let bad = 0
console.log('=== README 相对链接 → npm 包里是否存在 ===')
for (const target of links) {
  if (packed.has(target)) {
    console.log(`  ${target.padEnd(24)} ✓ 会发布`)
    continue
  }
  bad += 1
  const local = existsSync(join(root, target))
  console.log(`  ${target.padEnd(24)} ❌ ${local ? '本地有但不会发布（npm 上会 404）' : '本地也不存在'}`)
}

console.log('')
console.log(`打包文件数: ${packed.size}`)
if (bad > 0) {
  console.log(`\n结果: ${bad} 个链接在 npm 上会打不开 ✗`)
  console.log('修法：把目标目录加进 package.json 的 files，或改成绝对 URL。')
  process.exitCode = 1
} else {
  console.log('结果: 全部可解析 ✓')
}
