/**
 * 目录扫描：把 root 下的普通文件变成 key → {hash, size, mtimeMs}。
 *
 * 特性：
 * - 跳过符号链接（防止逃逸 root 与成环）；
 * - glob 排除（* / ? / **）；DSH_HOME 内强制排除敏感文件；
 * - 超过 maxFileBytes 的文件跳过并记录；
 * - mtime+size 缓存命中时复用旧 hash，避免每次重算 67MB 会话目录。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { isSafeRelPath } from '../util.js'
import { sha256File } from './hash.js'
import { SECRET_PATTERNS } from '../config.js'

/** 最大递归深度。 */
const MAX_DEPTH = 48

/** 把 glob 片段转成正则。 */
function globToRegExp(pattern) {
  let out = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`${out}$`)
}

const regexCache = new Map()

/** 取缓存的正则。 */
function regexFor(pattern) {
  let regex = regexCache.get(pattern)
  if (regex === undefined) {
    regex = globToRegExp(pattern)
    regexCache.set(pattern, regex)
  }
  return regex
}

/**
 * 判断相对路径是否被排除。
 * 无 `/` 的模式匹配 basename（任意层级）；含 `/` 的模式匹配完整相对路径，
 * 并额外把模式当作 `**\/<模式>` 再试一次，让 `node_modules/**` 命中嵌套目录。
 * @param {string} relPath POSIX 相对路径
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function isExcluded(relPath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false
  const normalized = String(relPath).replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    if (!pattern.includes('/')) {
      if (regexFor(pattern).test(base)) return true
      continue
    }
    if (regexFor(pattern).test(normalized)) return true
    if (regexFor(`**/${pattern}`).test(normalized)) return true
    // 目录模式 `dir/**` 在遍历到 dir 本身时也要命中
    if (pattern.endsWith('/**') && regexFor(pattern.slice(0, -3)).test(normalized)) return true
  }
  return false
}

/**
 * 判断绝对路径是否在 DSH_HOME 内（用于强制敏感文件排除）。
 * @param {string} absPath
 * @param {string} dshHome
 */
export function isInsideDshHome(absPath, dshHome) {
  if (!dshHome) return false
  const root = path.resolve(dshHome)
  const target = path.resolve(absPath)
  return target === root || target.startsWith(root + path.sep)
}

/**
 * 扫描一组根目录。
 * @param {Array<{id:string,path:string,enabled:boolean,exclude:string[]}>} roots
 * @param {object} options
 * @param {number} options.maxFileBytes
 * @param {Map<string,{size:number,mtimeMs:number,hash:string}>} [options.cache] 上次扫描缓存
 * @param {string} [options.dshHome]
 * @param {AbortSignal} [options.signal]
 * @param {(message:string)=>void} [options.warn]
 * @returns {Promise<{entries: Map, cache: Map, skipped: Array, filesSeen: number, bytes: number, excluded: number, symlinks: number, errors: number }>}
 */
export async function scanRoots(roots, options = {}) {
  const {
    maxFileBytes = 8 * 1024 * 1024,
    cache = new Map(),
    dshHome = process.env.DSH_HOME,
    signal,
    warn = () => {},
  } = options

  const entries = new Map()
  const nextCache = new Map()
  const skipped = []
  const seenSkip = new Set()
  // 被有意忽略的 key / 子树：合并时既不当"本地删除"，也不写墓碑。
  const ignoredKeys = new Set()
  const ignoredPrefixes = new Set()
  const ignoreKey = (key) => ignoredKeys.add(key)
  const ignorePrefix = (key) => ignoredPrefixes.add(key)
  let filesSeen = 0
  let bytes = 0
  let excluded = 0
  let symlinks = 0
  let errors = 0

  const skip = (key, reason) => {
    if (seenSkip.has(key)) return
    seenSkip.add(key)
    skipped.push({ key, reason })
  }

  for (const root of roots) {
    if (!root || root.enabled === false) continue
    let rootStat
    try {
      rootStat = await fsp.lstat(root.path)
    } catch {
      errors += 1
      ignoredPrefixes.add(root.id)
      warn(`根目录不存在，已跳过：${root.label} (${root.path})`)
      continue
    }
    if (!rootStat.isDirectory()) {
      errors += 1
      ignoredPrefixes.add(root.id)
      warn(`根目录不是目录，已跳过：${root.path}`)
      continue
    }

    const walk = async (dir, relDir, depth) => {
      if (depth > MAX_DEPTH) {
        errors += 1
        if (relDir.length > 0) ignoredPrefixes.add(`${root.id}/${relDir}`)
        warn(`目录层级过深，已跳过：${relDir}`)
        return
      }
      let dirEntries
      try {
        dirEntries = await fsp.readdir(dir, { withFileTypes: true })
      } catch (error) {
        errors += 1
        if (relDir.length > 0) ignoredPrefixes.add(`${root.id}/${relDir}`)
        warn(`读取目录失败：${relDir || '.'}（${error?.code ?? error?.message ?? 'error'}）`)
        return
      }
      dirEntries.sort((a, b) => a.name.localeCompare(b.name))
      for (const dirent of dirEntries) {
        if (signal?.aborted) throw new Error('aborted')
        const relPath = relDir.length > 0 ? `${relDir}/${dirent.name}` : dirent.name
        // 路径安全兜底：奇怪文件名直接跳过，绝不让 key 进入 manifest。
        if (!isSafeRelPath(relPath)) {
          excluded += 1
          continue
        }
        if (dirent.isSymbolicLink()) {
          symlinks += 1
          ignoreKey(`${root.id}/${relPath}`)
          continue
        }
        if (dirent.isDirectory()) {
          // 目录本身命中和"目录下任意文件命中"都视为整棵子树排除，
          // 这样 `node_modules/**` 不用等到遍历进子目录才生效。
          if (isExcluded(relPath, root.exclude) || isExcluded(`${relPath}/__probe__`, root.exclude)) {
            excluded += 1
            ignoredPrefixes.add(`${root.id}/${relPath}`)
            continue
          }
          await walk(path.join(dir, dirent.name), relPath, depth + 1)
          continue
        }
        if (!dirent.isFile()) {
          ignoreKey(`${root.id}/${relPath}`)
          continue
        }
        const absPath = path.join(dir, dirent.name)
        const key = `${root.id}/${relPath}`
        if (isExcluded(relPath, root.exclude)) {
          excluded += 1
          ignoreKey(key)
          continue
        }
        if (isInsideDshHome(absPath, dshHome) && isExcluded(relPath, SECRET_PATTERNS)) {
          excluded += 1
          ignoreKey(key)
          continue
        }
        let stat
        try {
          // 用纳秒时间戳做缓存键：只看毫秒 mtime 会在"同尺寸、同毫秒"的快速修改上
          // 命中旧 hash（导出/同步拿到过期内容）。ctime 还能兜住 mtime 被人为保留的写入。
          stat = await fsp.stat(absPath, { bigint: true })
        } catch {
          errors += 1
          ignoreKey(key)
          continue
        }
        if (!stat.isFile()) {
          ignoreKey(key)
          continue
        }
        filesSeen += 1
        const size = Number(stat.size)
        if (size > maxFileBytes) {
          ignoreKey(key)
          skip(key, 'too-large')
          continue
        }
        const mtimeNs = stat.mtimeNs.toString()
        const ctimeNs = stat.ctimeNs.toString()
        const mtimeMs = Math.floor(Number(stat.mtimeNs) / 1e6)
        const cached = cache.get(key)
        try {
          let hash
          if (cached !== undefined && cached.size === size && cached.mtimeNs === mtimeNs && cached.ctimeNs === ctimeNs) {
            hash = cached.hash
          } else {
            hash = await sha256File(absPath, signal)
          }
          entries.set(key, {
            key,
            root: root.id,
            path: relPath,
            hash,
            size,
            mtimeMs,
          })
          nextCache.set(key, { size, mtimeNs, ctimeNs, hash })
          bytes += size
        } catch (error) {
          if (error?.message === 'aborted') throw error
          errors += 1
          ignoreKey(key)
          // 文件刚好被删除或不可读：跳过，不算致命错误。
        }
      }
    }

    await walk(root.path, '', 0)
  }

  return { entries, cache: nextCache, skipped, ignoredKeys, ignoredPrefixes, filesSeen, bytes, excluded, symlinks, errors }
}