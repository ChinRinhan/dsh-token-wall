/**
 * 运行时偏好（开关）的单测。
 *
 * 覆盖三件事：
 * 1. 缺省值 —— 三个模块默认全开（装了就该看得见）；
 * 2. 原子写与读回 —— 写完立刻能读出，且文件是合法 JSON；
 * 3. 钳制 —— 脏输入（错类型 / 未知键 / 非对象）不能让偏好崩掉。
 *
 * 运行：`node --test test/prefs.test.mjs`
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_PREFS, openPrefs, sanitizePrefs } from '../lib/prefs.js'

const home = mkdtempSync(join(tmpdir(), 'dsh-token-usage-prefs-'))
const prefsPath = join(home, 'token-usage', 'prefs.json')

test('缺省值：桌宠与主面板默认可见，横幅默认关闭', () => {
  const p = openPrefs({ home })
  const read = p.read()
  // 横幅的内容已并入桌宠，所以默认关闭（要横幅的用户在设置页打开）。
  assert.equal(read.statusBar, false)
  assert.equal(read.pet, true)
  assert.equal(read.wallPanel, true)
  assert.deepEqual(read, DEFAULT_PREFS)
})

test('写入后立刻能读回，且文件是合法 JSON', () => {
  const p = openPrefs({ home })
  const next = p.write({ pet: false })
  assert.equal(next.pet, false)
  assert.equal(next.statusBar, false, '未提到的开关保持原值')
  // 重新打开一个 store（模拟重启）应读出同样的值。
  const reopened = openPrefs({ home })
  assert.equal(reopened.read().pet, false)
  // 文件本身是合法 JSON，且带 schema。
  const raw = JSON.parse(readFileSync(prefsPath, 'utf-8'))
  assert.equal(raw.schema, 'dsh-token-usage/prefs/v1')
  assert.equal(raw.pet, false)
})

test('钳制：脏输入不会让偏好崩掉', () => {
  // 错类型 → 用默认值。
  assert.deepEqual(sanitizePrefs({ statusBar: 'yes' }), DEFAULT_PREFS)
  // 非对象 → 全部默认。
  assert.deepEqual(sanitizePrefs(null), DEFAULT_PREFS)
  assert.deepEqual(sanitizePrefs([1, 2]), DEFAULT_PREFS)
  // 未知键被丢弃（不会原样写回盘上）。
  const cleaned = sanitizePrefs({ pet: false, bogus: 1 })
  assert.equal(cleaned.pet, false)
  assert.equal('bogus' in cleaned, false, '未知键必须丢弃')
  // 合法布尔值原样保留。
  assert.equal(sanitizePrefs({ wallPanel: false }).wallPanel, false)
})

test('损坏的偏好文件：回默认值，不阻断启动', () => {
  writeFileSync(prefsPath, 'this is not json', 'utf-8')
  const p = openPrefs({ home })
  assert.deepEqual(p.read(), DEFAULT_PREFS)
})

test('内存后端：定位不到 home 时降级，开关只在本次会话有效', () => {
  const p = openPrefs({ home: '' })
  assert.equal(p.describe().kind, 'memory')
  assert.equal(p.write({ pet: false }).pet, false)
  assert.equal(p.read().pet, false)
})

test('清理临时目录', () => {
  rmSync(home, { recursive: true, force: true })
})
