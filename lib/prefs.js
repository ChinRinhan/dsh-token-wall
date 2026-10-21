/**
 * **运行时偏好**（开关）：与日聚合数据完全分开的一份小文档。
 *
 * ## 为什么不用 Config
 *
 * Config（`cordis.patch.yml` 里的 `statusBarEnabled` 之类）是**部署期**配置：
 * 改它要重启 DSH 才生效。而用户想要的是「在设置页点一下就生效」的**运行时**开关。
 * 所以需要一份独立的、能在运行中被读写并立即生效的偏好。
 *
 * ## 存哪儿
 *
 * `$DSH_HOME/token-usage/prefs.json`，与 `daily.json` 同目录但**不同文件**：
 * `daily.json` 是高频写（每次记账合并写），`prefs.json` 是极低频写（用户点开关）。
 * 混在一起会让「开关保存」与「记账落盘」互相干扰。
 *
 * ## 为什么不是一个键值对
 *
 * 三个开关是**正交**的（横幅 / 桌宠 / 主面板可以任意组合），所以用独立的布尔字段，
 * 缺失时取默认值。默认值全是 `true`——插件装了就应该可见，用户主动关掉才关。
 *
 * ## 写入是原子的
 *
 * 与 `FileStore.flush()` 一样用「tmp + rename」，避免进程在写一半时崩溃留下半个
 * JSON（那会让下次启动读到一个坏文件，开关全部回默认）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 偏好文档的 schema 标识（供未来迁移识别）。 */
export const PREFS_SCHEMA = 'dsh-token-usage/prefs/v1'

/**
 * 默认值。
 *
 * ⚠️ `statusBar` 默认 **false**：横幅的内容已并入桌宠（两者显示同一批读数，
 * 两处同时显示是冗余，而且横幅会把对话区往上挤）。要横幅的用户在设置页打开即可。
 *
 * `pet` / `wallPanel` 默认 true：装了就该看得见。
 */
export const DEFAULT_PREFS = {
  /** 底部横幅（conversation.input.dock）。 */
  statusBar: false,
  /** 桌宠（document.body 上的浮动面板）。 */
  pet: true,
  /** 方块墙主面板（侧栏图标 + main 页面）。 */
  wallPanel: true,
}

/**
 * 把任意输入钳制成合法偏好。
 *
 * ⚠️ 未知键**丢弃**（不原样写回）：这样磁盘上的文件不会因为某个旧版本留下的
 * 字段而无限膨胀，也避免客户端塞进什么就存什么。
 */
export function sanitizePrefs(input) {
  const raw = input === null || typeof input !== 'object' || Array.isArray(input) ? {} : input
  const out = {}
  for (const key of Object.keys(DEFAULT_PREFS)) {
    out[key] = typeof raw[key] === 'boolean' ? raw[key] : DEFAULT_PREFS[key]
  }
  return out
}

/**
 * 打开偏好存储。
 *
 * @param options.home    DSH home 绝对路径；缺失时降级为纯内存。
 * @param options.logger  可选 logger。
 * @returns 读写偏好对象的 store。
 */
export function openPrefs({ home, logger } = {}) {
  if (typeof home !== 'string' || home.trim() === '') {
    return new MemoryPrefs()
  }
  return new FilePrefs(join(home, 'token-usage', 'prefs.json'), logger)
}

/** 内存后端：定位不到 DSH home 时的降级（开关只在本次会话有效）。 */
class MemoryPrefs {
  constructor() {
    this.prefs = { ...DEFAULT_PREFS }
  }

  read() {
    return { ...this.prefs }
  }

  write(patch) {
    this.prefs = sanitizePrefs({ ...this.prefs, ...patch })
    return { ...this.prefs }
  }

  describe() {
    return { kind: 'memory', path: undefined }
  }
}

/** 文件后端：原子写 + 损坏即回默认。 */
class FilePrefs {
  constructor(path, logger) {
    this.path = path
    this.logger = logger
    this.prefs = this.load()
  }

  load() {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_PREFS }
      const raw = JSON.parse(readFileSync(this.path, 'utf-8'))
      return sanitizePrefs(raw)
    } catch (error) {
      // 损坏的 JSON：回默认值，不阻断启动（开关回默认是最安全的降级）。
      this.logger?.warn?.(`[token-usage] 读取 ${this.path} 失败，开关回默认值: ${String(error)}`)
      return { ...DEFAULT_PREFS }
    }
  }

  read() {
    return { ...this.prefs }
  }

  write(patch) {
    const next = sanitizePrefs({ ...this.prefs, ...patch })
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify({ schema: PREFS_SCHEMA, ...next }, null, 2), 'utf-8')
      renameSync(tmp, this.path)
      this.prefs = next
    } catch (error) {
      // 写失败：保留内存里的旧值（这次改动不生效），但不抛错——
      // 开关写不进去不该让插件整个坏掉。
      this.logger?.warn?.(`[token-usage] 写入 ${this.path} 失败，开关未保存: ${String(error)}`)
    }
    return { ...this.prefs }
  }

  describe() {
    return { kind: 'file', path: this.path }
  }
}

export { MemoryPrefs, FilePrefs }
