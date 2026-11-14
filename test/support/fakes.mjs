/**
 * dsh-sync 测试夹具（测试专用，无第三方依赖）。
 *
 * 提供：
 * - 临时目录 / 临时 HOME + DSH_HOME 沙箱（自动清理）。
 * - 仅使用 Node 内置模块的配置文件、状态文件读写。
 * - 目录递归快照 + 快照差异（用于“双向收敛”断言）。
 * - 轮询等待（真实超时，失败信息带最后一次实际值）。
 * - SPEC 形态的 manifest 构造器。
 *
 * 约定：所有相对路径一律用 POSIX 语义（`a/b/c.txt`），与 SPEC 第 3.1 节的 key 一致。
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ------------------------------------------------------------------ */
/* 基础                                                                */
/* ------------------------------------------------------------------ */

/** 延时。 */
export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** sha256 hex（接受 string / Buffer / Uint8Array）。 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 创建临时目录（绝对路径）。 */
export async function createTempDir(prefix = 'dsh-sync-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 目录是否存在。 */
export async function exists(target) {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

/** mkdir -p（0700）。 */
export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 把临时 HOME / DSH_HOME / DSH_PROFILE 应用到 process.env。
 * 返回 restore()，务必在 finally 中调用，避免污染同进程内其他用例。
 */
export function applyEnv(env) {
  const keys = ['HOME', 'DSH_HOME', 'DSH_PROFILE']
  const saved = {}
  for (const key of keys) saved[key] = process.env[key]
  for (const key of keys) {
    if (env && env[key] !== undefined && env[key] !== null) process.env[key] = String(env[key])
  }
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

/* ------------------------------------------------------------------ */
/* 沙箱                                                                */
/* ------------------------------------------------------------------ */

/**
 * 创建一台“虚拟设备”的临时环境：
 *   <root>/home       → HOME
 *   <root>/dsh-home   → DSH_HOME（含 profiles/<profile>）
 *   <root>/workspace  → 普通工作区
 *
 * @param {object} [options]
 * @param {string} [options.prefix='dsh-sync-test-']
 * @param {string} [options.profile='web']
 */
export async function createSandbox(options = {}) {
  const { prefix = 'dsh-sync-test-', profile = 'web' } = options
  const root = await createTempDir(prefix)
  const home = path.join(root, 'home')
  const dshHome = path.join(root, 'dsh-home')
  const workspace = path.join(root, 'workspace')
  const profileDir = path.join(dshHome, 'profiles', profile)

  await Promise.all([
    fsp.mkdir(home, { recursive: true, mode: 0o700 }),
    fsp.mkdir(profileDir, { recursive: true, mode: 0o700 }),
    fsp.mkdir(workspace, { recursive: true, mode: 0o700 }),
  ])

  const env = {
    ...process.env,
    HOME: home,
    DSH_HOME: dshHome,
    DSH_PROFILE: profile,
  }

  return {
    root,
    home,
    dshHome,
    workspace,
    profile,
    profileDir,
    env,
    paths: { home, dshHome, workspace, profileDir },
    /** root 下的绝对路径。 */
    at: (rel) => path.join(root, rel),
    /** 应用本沙箱的环境变量，返回 restore()。 */
    applyEnv: () => applyEnv(env),
    cleanup: async () => {
      await removeSafe(root)
    },
  }
}

/**
 * 两个实例 + 一个共享 local store，用于双设备收敛测试。
 * cleanup() 会清理全部三个目录。
 */
export async function createSandboxPair(options = {}) {
  const a = await createSandbox({ ...options, prefix: options.prefixA ?? 'dsh-sync-a-' })
  const b = await createSandbox({ ...options, prefix: options.prefixB ?? 'dsh-sync-b-' })
  const store = await createTempDir('dsh-sync-store-')
  return {
    a,
    b,
    store,
    cleanup: async () => {
      await Promise.all([a.cleanup(), b.cleanup(), removeSafe(store)])
    },
  }
}

async function removeSafe(target) {
  const resolved = path.resolve(target)
  const tmp = path.resolve(os.tmpdir())
  if (resolved === tmp || !resolved.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(`refusing to remove non-temp path: ${resolved}`)
  }
  await fsp.rm(resolved, { recursive: true, force: true })
}

/** 删除任意临时路径（只允许 tmp 下）。 */
export async function cleanupTemp(target) {
  await removeSafe(target)
}

/* ------------------------------------------------------------------ */
/* 配置 / 状态                                                         */
/* ------------------------------------------------------------------ */

/** SPEC 默认 profile root 的排除项。 */
export const DEFAULT_PROFILE_EXCLUDE = [
  'node_modules/**',
  '.plugin-manager/**',
  '*.bak-*',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
]

/** 按 SPEC 第 4 节生成默认 roots（路径为绝对路径）。 */
export function defaultRoots(dshHome, home, profile = 'web') {
  return [
    {
      id: 'profile',
      label: 'DSH 配置',
      path: path.join(dshHome, 'profiles', profile),
      enabled: true,
      exclude: [...DEFAULT_PROFILE_EXCLUDE],
    },
    {
      id: 'sessions',
      label: '会话记录',
      path: path.join(dshHome, 'sessions'),
      enabled: true,
      exclude: [],
    },
    {
      id: 'documents',
      label: '工作区文档',
      path: path.join(home, 'Documents'),
      enabled: false,
      exclude: ['node_modules/**', '.git/**'],
    },
  ]
}

/** 按 SPEC 第 4 节生成默认 targets（路径为绝对路径）。 */
export function defaultTargets(dshHome) {
  return [
    {
      id: 'local',
      type: 'local',
      label: '本地/挂载目录',
      enabled: true,
      path: path.join(dshHome, 'dsh-sync', 'store'),
    },
    {
      id: 'dav',
      type: 'webdav',
      label: 'WebDAV',
      enabled: false,
      url: '',
      username: '',
      password: '',
      basePath: '/dsh-sync',
    },
    {
      id: 'peer',
      type: 'peer',
      label: '另一台 DSH',
      enabled: false,
      url: '',
      token: '',
    },
  ]
}

function normalizeRoot(root) {
  return {
    enabled: true,
    exclude: [],
    ...root,
    exclude: Array.isArray(root?.exclude) ? root.exclude : [],
  }
}

function normalizeTarget(target) {
  return { enabled: true, ...target }
}

/**
 * 生成 SPEC 形态的 config 对象（不做环境变量展开，路径直接给绝对路径）。
 *
 * @param {object} [options]
 * @param {string} [options.dshHome]
 * @param {string} [options.home]
 * @param {string} [options.profile='web']
 * @param {string} [options.deviceName='test-device']
 * @param {boolean} [options.autoSync=true]
 * @param {boolean} [options.autoSave=true]
 * @param {boolean} [options.syncOnStart=false]
 * @param {number} [options.autoSaveIntervalSeconds=20]
 * @param {number} [options.autoSyncIntervalSeconds=180]
 * @param {number} [options.maxFileBytes=8388608]
 * @param {string} [options.peerToken]
 * @param {string} [options.peerStorePath]
 * @param {Array} [options.roots] 传入则整体替换默认 roots。
 * @param {Array} [options.targets] 传入则整体替换默认 targets。
 * @param {object} [options.overrides] 最后浅合并的额外字段。
 */
export function buildConfig(options = {}) {
  const {
    dshHome = process.env.DSH_HOME ?? path.join(os.tmpdir(), 'dsh-sync-fake-dsh-home'),
    home = process.env.HOME ?? os.homedir(),
    profile = process.env.DSH_PROFILE ?? 'web',
    deviceName = 'test-device',
    autoSync = true,
    autoSave = true,
    syncOnStart = false,
    autoSaveIntervalSeconds = 20,
    autoSyncIntervalSeconds = 180,
    maxFileBytes = 8388608,
    peerToken = 'test-peer-token-0000000000000000',
    peerStorePath,
    roots,
    targets,
    overrides = {},
  } = options

  return {
    version: 1,
    deviceName,
    autoSync,
    autoSave,
    syncOnStart,
    autoSaveIntervalSeconds,
    autoSyncIntervalSeconds,
    maxFileBytes,
    peerToken,
    peerStorePath: peerStorePath ?? path.join(dshHome, 'dsh-sync', 'peer-store'),
    roots: (roots ?? defaultRoots(dshHome, home, profile)).map(normalizeRoot),
    targets: (targets ?? defaultTargets(dshHome)).map(normalizeTarget),
    ...overrides,
  }
}

/** 基于沙箱生成 config。 */
export function buildSandboxConfig(sandbox, overrides = {}) {
  return buildConfig({
    dshHome: sandbox.dshHome,
    home: sandbox.home,
    profile: sandbox.profile,
    peerStorePath: path.join(sandbox.dshHome, 'dsh-sync', 'peer-store'),
    ...overrides,
  })
}

/** `$DSH_HOME/dsh-sync`。 */
export function stateDir(dshHome) {
  return path.join(dshHome, 'dsh-sync')
}

export function configPath(dshHome) {
  return path.join(stateDir(dshHome), 'config.json')
}

export function statePath(dshHome) {
  return path.join(stateDir(dshHome), 'state.json')
}

/** 原子写 config.json（0600），返回文件路径。 */
export async function writeConfigFile(dshHome, config) {
  const file = configPath(dshHome)
  await writeJsonFile(file, config)
  return file
}

/** 读 config.json，不存在返回 null。 */
export async function readConfigFile(dshHome) {
  return readJsonFile(configPath(dshHome))
}

/** 读 state.json，不存在返回 null。 */
export async function readStateFile(dshHome) {
  return readJsonFile(statePath(dshHome))
}

/** 原子写 state.json（0600），返回文件路径。 */
export async function writeStateFile(dshHome, state) {
  const file = statePath(dshHome)
  await writeJsonFile(file, state)
  return file
}

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

async function atomicWrite(file, bytes, options = {}) {
  const dir = path.dirname(file)
  await ensureDir(dir)
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}`)
  await fsp.writeFile(tmp, bytes, { mode: options.mode ?? 0o600 })
  if (options.mtimeMs !== undefined) {
    const seconds = options.mtimeMs / 1000
    await fsp.utimes(tmp, seconds, seconds)
  }
  await fsp.rename(tmp, file)
}

/** 写文本（自动建父目录；支持 mtimeMs）。返回绝对路径。 */
export async function writeText(file, text, options = {}) {
  await atomicWrite(file, Buffer.from(String(text), 'utf8'), options)
  return file
}

/** 读文本。 */
export async function readText(file, encoding = 'utf8') {
  return fsp.readFile(file, encoding)
}

/** 读二进制。 */
export async function readBytes(file) {
  return fsp.readFile(file)
}

/** 写 JSON（2 空格缩进 + 换行）。 */
export async function writeJsonFile(file, value, options = {}) {
  await atomicWrite(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), options)
  return file
}

/** 读 JSON；不存在返回 null；解析失败抛出（测试里应明确知道格式错了）。 */
export async function readJsonFile(file) {
  let text
  try {
    text = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(text)
}

/** 读文件 sha256。 */
export async function hashFile(file) {
  return sha256Hex(await fsp.readFile(file))
}

/**
 * 批量写文件。
 *
 * @param {string} root 根目录
 * @param {Record<string, string|Buffer|{content:string|Buffer,mtimeMs?:number}>} mapping
 * @returns {Promise<string[]>} 写入的绝对路径
 */
export async function writeFiles(root, mapping) {
  const written = []
  for (const [rel, value] of Object.entries(mapping)) {
    const file = path.join(root, rel)
    const options = {}
    let content = value
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && 'content' in value) {
      content = value.content
      if (value.mtimeMs !== undefined) options.mtimeMs = value.mtimeMs
    }
    if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
      await atomicWrite(file, Buffer.from(content), options)
    } else {
      await writeText(file, String(content), options)
    }
    written.push(file)
  }
  return written
}

/** 递归列出文件（POSIX 相对路径，升序）。 */
export async function listFilesRecursive(root) {
  const out = []
  async function walk(dir, prefix) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) await walk(abs, rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  await walk(root, '')
  return out.sort()
}

/* ------------------------------------------------------------------ */
/* glob 匹配（测试方便用；与 SPEC 3.5 语义接近，不是引擎实现）           */
/* ------------------------------------------------------------------ */

function globToRegExp(pattern) {
  const p = String(pattern)
  let out = '^'
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i += 1
        if (p[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[|\\{}()[\]^$+.]/g, '\\$&')
    }
  }
  out += '$'
  return new RegExp(out)
}

/** 相对路径是否命中任一 glob（同时尝试 basename）。 */
export function matchesGlob(rel, patterns = []) {
  if (!patterns || patterns.length === 0) return false
  const base = path.posix.basename(rel)
  return patterns.some((pattern) => {
    const re = globToRegExp(pattern)
    return re.test(rel) || re.test(base)
  })
}

/* ------------------------------------------------------------------ */
/* 快照 / 差异                                                         */
/* ------------------------------------------------------------------ */

/**
 * 目录递归快照。符号链接跳过并记录。
 *
 * @returns {Promise<{root:string, files:Record<string,{size:number,sha256:string,mtimeMs:number}>,
 *   dirs:string[], symlinks:string[]}>}
 */
export async function snapshot(root, options = {}) {
  const { exclude = [], includeContent = false } = options
  const files = {}
  const dirs = []
  const symlinks = []

  async function walk(dir, prefix) {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (matchesGlob(rel, exclude)) continue
      const abs = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        symlinks.push(rel)
        continue
      }
      if (entry.isDirectory()) {
        dirs.push(rel)
        await walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fsp.stat(abs)
      const bytes = await fsp.readFile(abs)
      const item = {
        size: stat.size,
        sha256: sha256Hex(bytes),
        mtimeMs: Math.round(stat.mtimeMs),
      }
      if (includeContent) item.content = bytes.toString('utf8')
      files[rel] = item
    }
  }

  await walk(root, '')
  return { root, files, dirs: dirs.sort(), symlinks: symlinks.sort() }
}

/** 比较两个快照，返回 added / removed / changed / unchanged（均为升序 rel 数组）。 */
export function diffSnapshots(before, after) {
  const beforeFiles = before?.files ?? {}
  const afterFiles = after?.files ?? {}
  const beforeKeys = Object.keys(beforeFiles).sort()
  const afterKeys = Object.keys(afterFiles).sort()

  const added = afterKeys.filter((key) => !(key in beforeFiles))
  const removed = beforeKeys.filter((key) => !(key in afterFiles))
  const changed = afterKeys.filter(
    (key) => key in beforeFiles && beforeFiles[key].sha256 !== afterFiles[key].sha256,
  )
  const unchanged = afterKeys.filter(
    (key) => key in beforeFiles && beforeFiles[key].sha256 === afterFiles[key].sha256,
  )
  return { added, removed, changed, unchanged }
}

/** 只取文件的 sha256 映射（key → hash），便于和 manifest 对比。 */
export function fileHashes(snap) {
  const out = {}
  for (const [rel, info] of Object.entries(snap?.files ?? {})) out[rel] = info.sha256
  return out
}

/* ------------------------------------------------------------------ */
/* 等待                                                                */
/* ------------------------------------------------------------------ */

/**
 * 轮询等待 predicate 返回真值。
 *
 * @param {() => any} predicate 可返回 Promise。
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @param {number} [options.intervalMs=50]
 * @param {string} [options.label='condition']
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<any>} predicate 的真值
 */
export async function waitFor(predicate, options = {}) {
  const {
    timeoutMs = 10_000,
    intervalMs = 50,
    label = 'condition',
    signal,
  } = options
  const started = Date.now()
  let last
  let lastError

  for (;;) {
    if (signal?.aborted) throw new Error(`aborted while waiting for ${label}`)
    try {
      last = await predicate()
      lastError = undefined
      if (last) return last
    } catch (error) {
      lastError = error
    }
    if (Date.now() - started >= timeoutMs) {
      const detail = lastError
        ? `last error: ${lastError?.stack ?? lastError}`
        : `last value: ${safeStringify(last)}`
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; ${detail}`)
    }
    await sleep(intervalMs)
  }
}

/** 等待文件出现。 */
export async function waitForFile(file, options = {}) {
  return waitFor(() => exists(file), { label: `file ${file}`, ...options })
}

/** 等待文件内容等于期望值。 */
export async function waitForFileText(file, expected, options = {}) {
  return waitFor(async () => {
    try {
      return (await fsp.readFile(file, 'utf8')) === expected
    } catch {
      return false
    }
  }, { label: `file ${file} content`, ...options })
}

/** 等待目录快照满足断言函数。 */
export async function waitForSnapshot(root, predicate, options = {}) {
  const { exclude = [], ...rest } = options
  return waitFor(async () => {
    const snap = await snapshot(root, { exclude })
    return predicate(snap) ? snap : false
  }, { label: `snapshot of ${root}`, ...rest })
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/* ------------------------------------------------------------------ */
/* manifest 夹具                                                       */
/* ------------------------------------------------------------------ */

const DEVICE_ID_FALLBACK = '00000000000000000000000000000000'

function deriveRootPath(key) {
  const idx = key.indexOf('/')
  if (idx <= 0) throw new Error(`key must look like "<root>/<path>": ${key}`)
  return { root: key.slice(0, idx), relPath: key.slice(idx + 1) }
}

/**
 * 构造单条 entry。
 *
 * @param {string} key `root/relative/path`
 * @param {string} hash sha256 hex
 * @param {object} [options] { size, mtimeMs, updatedAt, deviceId }
 */
export function makeEntry(key, hash, options = {}) {
  const { root, relPath } = deriveRootPath(key)
  const now = Date.now()
  return {
    key,
    root,
    path: options.path ?? relPath,
    hash,
    size: options.size ?? 0,
    mtimeMs: options.mtimeMs ?? now,
    updatedAt: options.updatedAt ?? now,
    deviceId: options.deviceId ?? DEVICE_ID_FALLBACK,
  }
}

/** 构造单条 tombstone。 */
export function makeTombstone(key, options = {}) {
  const { root, relPath } = deriveRootPath(key)
  const now = Date.now()
  return {
    key,
    root,
    path: options.path ?? relPath,
    deleted: true,
    updatedAt: options.updatedAt ?? now,
    deviceId: options.deviceId ?? DEVICE_ID_FALLBACK,
  }
}

/**
 * 构造 SPEC 形态的 manifest。
 *
 * @param {object} [options]
 * @param {string} [options.deviceId]
 * @param {string} [options.deviceName='test-device']
 * @param {Array} [options.entries]
 * @param {Array} [options.tombstones]
 * @param {number} [options.generatedAt]
 */
export function makeManifest(options = {}) {
  const {
    deviceId = DEVICE_ID_FALLBACK,
    deviceName = 'test-device',
    entries = [],
    tombstones = [],
    generatedAt = Date.now(),
  } = options
  return {
    format: 'dsh-sync-manifest',
    version: 1,
    deviceId,
    deviceName,
    generatedAt,
    entries: [...entries].map((entry) => makeEntry(entry.key, entry.hash, { deviceId, ...entry })).sort(byKey),
    tombstones: [...tombstones]
      .map((tombstone) => makeTombstone(tombstone.key, { deviceId, ...tombstone }))
      .sort(byKey),
  }
}

function byKey(a, b) {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** 从字节构造 entry（hash/size 自动算）。 */
export function makeEntryFromBytes(key, bytes, options = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return makeEntry(key, sha256Hex(buffer), { size: buffer.length, ...options })
}

/**
 * 校验 manifest 基本形状（自洽性由引擎负责，这里只做测试夹具自检）。
 * 返回问题数组；空数组表示形状 OK。
 */
export function validateManifestShape(manifest) {
  const problems = []
  if (manifest?.format !== 'dsh-sync-manifest') problems.push('format')
  if (manifest?.version !== 1) problems.push('version')
  if (typeof manifest?.deviceId !== 'string' || manifest.deviceId.length === 0) problems.push('deviceId')
  if (!Array.isArray(manifest?.entries)) problems.push('entries')
  if (!Array.isArray(manifest?.tombstones)) problems.push('tombstones')
  return problems
}