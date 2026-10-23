/**
 * 检查「宿主启动时用来索引这个插件的那个名字」三处是否一致。
 *
 * ## 为什么需要
 *
 * 2026-10-24 的一次真实故障：`package.json` 的 `name` 从 `dsh-token-usage` 改成了
 * `dsh-token-wall`（npm 上重名），但 `client.js` 里的
 * `window.__ModuleLoader__.load({ id: 'dsh-token-usage' })` 没跟着改。
 *
 * 宿主的 client-modules 模块表**按包名索引**（`table.set(packageName, …)`），浏览器
 * 按包名去取 bundle，而 bundle 执行后注册成了另一个 id —— 于是这一行永远解析不到。
 * 宿主随后按「缺失行单独重试」再执行一次同一脚本，触发
 * `duplicate factory registration`，最终把**整次 Web boot 判为失败**：
 *
 *     Error: web boot: 1 entry did not activate
 *     dsh-token-wall: import failed (see console for the import error)
 *
 * 也就是说，一个字段写错 = 用户一开 App 就弹错，而且错的是「整个界面」而不是
 * 「这个插件」。这类缺陷本地开发完全看不出来（代码语法正确、函数都能跑），只有
 * 重启 App 才会暴露，属于最该被自动化拦下的那一类。
 *
 * ## 检查什么
 *
 * 1. `client.js` 注册的 `id` === `package.json` 的 `name`
 * 2. `package.json` 的 `name` 本身是合法的 npm 包名
 * 3. `exports['./client']` 指向的文件存在
 * 4. `files` 白名单里每个条目都存在（否则发布后少文件）
 * 5. `exports['./client']` 指向的文件确实在白名单覆盖范围内（否则 npm 装上没有 browser 半）
 * 6. `dsh.bundle.patch` 指向的文件存在
 *
 * 加 `--profile <dir>` 时，还会扫描该 profile 里所有**已安装**的客户端插件，逐个
 * 做同样的「注册 id === 包名」检查 —— 这样连第三方插件也能一起拦下。
 *
 * 用法:
 *   node tools/check-boot-identity.mjs
 *   node tools/check-boot-identity.mjs --profile "%USERPROFILE%\.dsh\profiles\desktop"
 * 退出码: 0 = 一致；1 = 有不一致（会打印具体是哪一处、期望值是什么）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 去掉 `//` 与 `/* *\/` 注释，保留字符串字面量内容。
 *
 * 为什么要这一步：真实 bundle 里 `__ModuleLoader__.load({` 与 `id:` 之间常常夹着
 * 一段说明注释（本项目 client.js 就是这样）。直接用正则会把注释误当代码而匹配失败，
 * 于是检查工具自己先报假警。逐字符走一遍状态机，字符串里的 `//`（例如 URL）也不会被误删。
 */
function stripComments(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i += 1
      while (i < n) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '')
          i += 2
          continue
        }
        out += source[i]
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** 与宿主 dsh-client-modules 相同的提取方式：取 `__ModuleLoader__.load({ id })` 的那个字面量。 */
function registrationIdOf(source) {
  const m = /__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*(['"])([^'"]+)\1/.exec(stripComments(source))
  return m?.[2]
}

/** 宿主同款包名规则：@scope/name 或 name，不含路径分隔与协议。 */
function isPackageName(name) {
  if (typeof name !== 'string' || name === '') return false
  if (name.startsWith('@')) {
    const parts = name.split('/')
    return parts.length === 2 && parts.every(Boolean)
  }
  return !name.includes('/') && !name.includes(':')
}

const failures = []
const notes = []
const check = (label, cond, detail = '') => {
  if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`)
}

/**
 * 校验一个「包目录」是否自洽。
 *
 * @param dir 包根目录
 * @param label 打印用的名字
 * @param opts.bundleOnly 只做 id/包名 检查（profile 扫描用，避免对第三方包要求过严）
 */
function checkPackage(dir, label, opts = {}) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    check(`${label}: package.json 存在`, false, pkgPath)
    return
  }
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  } catch (error) {
    check(`${label}: package.json 可解析`, false, String(error.message))
    return
  }

  const name = pkg.name
  check(`${label}: 包名合法`, isPackageName(name), String(name))

  // ① 核心不变式：注册 id 必须等于包名。
  const clientRel = typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : undefined
  if (clientRel === undefined) {
    notes.push(`${label}: 未声明 exports["./client"]，跳过 browser 半检查`)
  } else {
    const clientPath = join(dir, clientRel)
    if (!existsSync(clientPath)) {
      check(`${label}: exports["./client"] 指向的文件存在`, false, clientRel)
    } else {
      const id = registrationIdOf(readFileSync(clientPath, 'utf-8'))
      check(
        `${label}: 注册 id === 包名`,
        id === name,
        id === undefined ? `没找到 __ModuleLoader__.load({ id })` : `注册=${id} 包名=${name}`,
      )
    }
  }

  if (opts.bundleOnly) return

  // ② 发布完整性：files 白名单里的东西都得真的在。
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const missing = files.filter((entry) => !existsSync(join(dir, entry)))
  check(`${label}: files 白名单全部存在`, missing.length === 0, missing.join(', '))

  // ③ npm 只会带 files 里的文件 + README/LICENSE/package.json。
  //    如果 client.js 不在白名单覆盖内，用户 install 下来就没有 browser 半 ——
  //    表现和本次故障一模一样（import failed）。
  if (clientRel !== undefined) {
    const normalized = clientRel.replace(/^\.\//, '')
    const covered = files.some((entry) => {
      const e = entry.replace(/^\.\//, '')
      return normalized === e || normalized.startsWith(`${e}/`)
    })
    check(`${label}: client.js 会被发布（在 files 白名单内）`, covered, normalized)
  }

  // ④ Host 半入口与 bundle patch 也得存在。
  check(`${label}: exports["."] 指向的文件存在`, typeof pkg.exports?.['.'] === 'string' && existsSync(join(dir, pkg.exports['.'])))
  const patch = pkg.dsh?.bundle?.patch
  check(`${label}: dsh.bundle.patch 指向的文件存在`, typeof patch === 'string' && existsSync(join(dir, patch)), String(patch))
}

console.log('=== 本仓库自检 ===')
checkPackage(root, 'dsh-token-wall')

// Host 半导出的 name 只是插件标识，跟 npm 包名不同**不算错**（路由与存储靠它保持稳定），
// 但和包名不一致时值得知道，免得下次改包名又误以为要一起改。
const hostSource = readFileSync(join(root, 'index.js'), 'utf-8')
const hostName = /export\s+const\s+name\s*=\s*(['"])([^'"]+)\1/.exec(hostSource)?.[2]
const pkgName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).name
if (hostName !== undefined && hostName !== pkgName) {
  notes.push(`Host 半导出的 name=${hostName} 与包名 ${pkgName} 不同：这是有意的（路由前缀 / 存储目录保持不变），不要「顺手改成一致」，否则已有数据会找不到。`)
}

// ── 可选的 profile 扫描 ────────────────────────────────────────────────
const profileIndex = process.argv.indexOf('--profile')
if (profileIndex !== -1) {
  const profile = resolve(process.argv[profileIndex + 1] ?? '')
  console.log(`\n=== profile 扫描：${profile} ===`)
  if (!existsSync(join(profile, 'node_modules'))) {
    check(`profile 可扫描`, false, `${profile}/node_modules 不存在`)
  } else {
    // 只看顶层包与一层 @scope：宿主 loader 的行也是这个粒度。
    const dirs = []
    const nm = join(profile, 'node_modules')
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith('.')) continue
      const abs = join(nm, entry)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue // 悬空软链
      }
      if (!st.isDirectory()) continue
      if (entry.startsWith('@')) {
        for (const sub of readdirSync(abs)) {
          const subAbs = join(abs, sub)
          try {
            if (statSync(subAbs).isDirectory()) dirs.push([subAbs, `${entry}/${sub}`])
          } catch { /* 悬空软链 */ }
        }
        continue
      }
      dirs.push([abs, entry])
    }

    let scanned = 0
    let clientCount = 0
    for (const [dir, label] of dirs) {
      const pkgPath = join(dir, 'package.json')
      if (!existsSync(pkgPath)) continue
      let pkg
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      } catch {
        continue
      }
      scanned += 1
      if (pkg.dsh?.client?.platform !== 'web') continue
      if (typeof pkg.exports?.['./client'] !== 'string') continue
      clientCount += 1
      const clientPath = join(dir, pkg.exports['./client'])
      if (!existsSync(clientPath)) {
        check(`${label}: client 产物存在`, false, pkg.exports['./client'])
        continue
      }
      const id = registrationIdOf(readFileSync(clientPath, 'utf-8'))
      check(`${label}: 注册 id === 包名`, id === pkg.name, `注册=${id} 包名=${pkg.name}`)
    }
    console.log(`\n扫描 ${scanned} 个包，其中 ${clientCount} 个是 web 客户端插件。`)
  }
}

if (notes.length > 0) {
  console.log('\n=== 备注 ===')
  for (const note of notes) console.log(`  · ${note}`)
}

console.log('')
if (failures.length > 0) {
  console.log(`结果: ${failures.length} 项不一致 ✗`)
  console.log('修法：让 client.js 的注册 id 等于 package.json 的 name；')
  console.log('      改包名时同步改它，或直接引用包名而不写字面量。')
  process.exitCode = 1
} else {
  console.log('结果: 启动标识全部一致 ✓')
}
