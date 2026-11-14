/**
 * dsh-sync 共享工具。
 *
 * 只依赖 Node 内置模块。所有写盘操作都原子化（同目录 tmp + rename），
 * 避免同步/自动保存与用户操作并发时留下半截文件。
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** 当前毫秒时间戳。 */
export function nowMs() {
  return Date.now()
}

/** ISO 时间字符串。 */
export function nowIso() {
  return new Date().toISOString()
}

/** 生成 n 字节随机 hex。 */
export function randomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex')
}

/** 人类可读字节数。 */
export function formatBytes(n) {
  const value = Number(n)
  if (!Number.isFinite(value) || value < 0) return '0 B'
  if (value < 1024) return `${value} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let v = value / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

/** 延时。 */
export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** 路径是否存在（任意类型）。 */
export async function pathExists(p) {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

/** 创建目录（递归，权限尽力设为 0700）。 */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
}

/** 读取 JSON 文件；不存在返回 fallback；解析失败抛错（调用方决定是否吞）。 */
export async function readJsonFile(file, fallback = undefined) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== undefined) return fallback
    throw error
  }
  return JSON.parse(text)
}

/** 原子写 JSON（0600）。 */
export async function writeJsonAtomic(file, value, options = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await writeFileAtomic(file, bytes, options)
}

/** 原子写二进制：同目录临时文件 + fsync + rename。 */
export async function writeFileAtomic(file, bytes, options = {}) {
  const dir = path.dirname(file)
  await ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomHex(4)}`)
  let handle
  try {
    handle = await fsp.open(tmp, 'w', options.mode ?? 0o600)
    await handle.writeFile(bytes)
    if (options.mtimeMs !== undefined) {
      const seconds = options.mtimeMs / 1000
      await handle.utimes(seconds, seconds)
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsp.rename(tmp, file)
  } catch (error) {
    if (handle) {
      try {
        await handle.close()
      } catch {}
    }
    try {
      await fsp.unlink(tmp)
    } catch {}
    throw error
  }
  if (options.mtimeMs !== undefined) {
    try {
      const seconds = options.mtimeMs / 1000
      await fsp.utimes(file, seconds, seconds)
    } catch {}
  }
}

/** 删除文件，忽略不存在。 */
export async function removeFileIfExists(file) {
  try {
    await fsp.unlink(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** 文件名安全：去掉路径分隔符与控制字符。 */
export function sanitizeFileName(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 180) : fallback
}

/** 判断相对路径是否安全（POSIX 语义，禁止绝对/上跳/反斜杠/NUL/空段）。 */
export function isSafeRelPath(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 4096) return false
  if (rel.includes('\u0000') || rel.includes('\\')) return false
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return false
  const parts = rel.split('/')
  for (const part of parts) {
    if (part.length === 0 || part === '.' || part === '..') return false
  }
  return true
}

/** 把安全的相对路径解析到 root 内；不安全返回 null。 */
export function resolveInside(root, rel) {
  if (!isSafeRelPath(rel)) return null
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, rel)
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null
  return resolved
}

/** sha256(hex)，供后端对象名校验等使用。 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 环形缓冲推入：保持最多 max 条（新的在后）。返回同一数组便于链式。 */
export function ringPush(list, item, max) {
  list.push(item)
  while (list.length > max) list.shift()
  return list
}

/** 整数夹取。 */
export function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.round(parsed)
  return Math.min(max, Math.max(min, rounded))
}

/** 布尔归一化：只接受 true/false。 */
export function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** 顶层对象合并（undefined 不覆盖）。 */
export function shallowMerge(base, patch) {
  const out = { ...base }
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) out[key] = value
    }
  }
  return out
}