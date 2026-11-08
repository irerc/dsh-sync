/**
 * 设备 manifest：结构、校验与多设备合并。
 *
 * 后端上的布局：devices/<deviceId>.json + objects/<sha256>。
 * 每个设备只写自己的 manifest，读取时把所有设备视图合并，
 * 因此不需要分布式锁；冲突由三方合并识别。
 */
import { isSafeRelPath } from '../util.js'

/** manifest 格式标识。 */
export const MANIFEST_FORMAT = 'dsh-sync-manifest'
/** manifest 版本。 */
export const MANIFEST_VERSION = 1
/** deviceId / root / hash 的取值约束。 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/
const ROOT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const HASH_RE = /^[a-f0-9]{64}$/

/** 拼接 key。 */
export function entryKey(root, relPath) {
  return `${root}/${relPath}`
}

/** 从 key 拆出 root 与相对路径。 */
export function splitKey(key) {
  const index = String(key).indexOf('/')
  if (index <= 0) return null
  const root = key.slice(0, index)
  const relPath = key.slice(index + 1)
  if (!ROOT_ID_RE.test(root) || !isSafeRelPath(relPath)) return null
  return { root, path: relPath }
}

/** 数值字段校验。 */
function finiteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * 校验单条 entry（entry 或 tombstone）。
 * @returns {object|null}
 */
export function normalizeManifestEntry(raw, deviceId, deleted) {
  if (!raw || typeof raw !== 'object') return null
  const key = typeof raw.key === 'string' ? raw.key : entryKey(String(raw.root ?? ''), String(raw.path ?? ''))
  const parts = splitKey(key)
  if (parts === null) return null
  // 墓碑没有内容 hash：删除语义靠 deleted 标记，不能按普通 entry 校验。
  if (!deleted && !HASH_RE.test(String(raw.hash ?? ''))) return null
  const entry = {
    key,
    root: parts.root,
    path: parts.path,
    hash: deleted ? '' : raw.hash,
    size: Math.max(0, Math.floor(finiteNumber(raw.size, 0))),
    mtimeMs: Math.max(0, Math.floor(finiteNumber(raw.mtimeMs, 0))),
    updatedAt: Math.max(0, Math.floor(finiteNumber(raw.updatedAt, 0))),
    deviceId: typeof raw.deviceId === 'string' && DEVICE_ID_RE.test(raw.deviceId) ? raw.deviceId : deviceId,
  }
  if (deleted) entry.deleted = true
  return entry
}

/**
 * 校验并归一化后端读到的 manifest。
 * 非法条目被跳过并计数；返回值仍可用于同步。
 * @returns {{ deviceId: string, deviceName: string, entries: Map, tombstones: Map, skipped: number } | null}
 */
export function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.format !== MANIFEST_FORMAT) return null
  if (finiteNumber(raw.version, 0) !== MANIFEST_VERSION) return null
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : ''
  if (!DEVICE_ID_RE.test(deviceId)) return null
  let skipped = 0
  const entries = new Map()
  const tombstones = new Map()
  for (const item of Array.isArray(raw.entries) ? raw.entries : []) {
    const entry = normalizeManifestEntry(item, deviceId, false)
    if (entry === null) {
      skipped += 1
      continue
    }
    entries.set(entry.key, entry)
  }
  for (const item of Array.isArray(raw.tombstones) ? raw.tombstones : []) {
    const entry = normalizeManifestEntry(item, deviceId, true)
    if (entry === null) {
      skipped += 1
      continue
    }
    tombstones.set(entry.key, entry)
    entries.delete(entry.key)
  }
  return {
    deviceId,
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName.slice(0, 64) : '',
    entries,
    tombstones,
    skipped,
  }
}

/**
 * 多设备合并：同一 key 取 (updatedAt, deviceId) 最大者；tombstone 参与比较。
 * @param {Array<{entries: Map, tombstones: Map}>} manifests
 * @returns {Map<string, object>}
 */
export function mergeManifests(manifests) {
  const out = new Map()
  for (const manifest of manifests) {
    if (!manifest) continue
    const all = [
      ...manifest.entries.values(),
      ...manifest.tombstones.values(),
    ]
    for (const entry of all) {
      const current = out.get(entry.key)
      if (current === undefined || compareEntries(entry, current) > 0) out.set(entry.key, entry)
    }
  }
  return out
}

/**
 * 排序比较：updatedAt 大者胜；相同则 deviceId 字典序大者胜；再相同则未删除者胜。
 * @returns {number}
 */
export function compareEntries(a, b) {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1
  if (Boolean(a.deleted) !== Boolean(b.deleted)) return a.deleted ? -1 : 1
  return String(a.hash ?? '').localeCompare(String(b.hash ?? ''))
}

/**
 * 生成可写入后端的设备 manifest。
 * @param {object} input
 * @returns {object}
 */
export function createDeviceManifest(input) {
  const {
    deviceId,
    deviceName,
    entries = new Map(),
    tombstones = new Map(),
    now = Date.now(),
  } = input
  const sortedEntries = [...entries.values()]
    .filter((entry) => HASH_RE.test(String(entry.hash ?? '')) && splitKey(entry.key) !== null)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => ({
      key: entry.key,
      root: entry.root,
      path: entry.path,
      hash: entry.hash,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      updatedAt: entry.updatedAt,
      deviceId: entry.deviceId,
    }))
  const sortedTombstones = [...tombstones.values()]
    .filter((entry) => splitKey(entry.key) !== null)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => ({
      key: entry.key,
      root: entry.root,
      path: entry.path,
      deleted: true,
      updatedAt: entry.updatedAt,
      deviceId: entry.deviceId,
    }))
  return {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    deviceId,
    deviceName,
    generatedAt: now,
    entries: sortedEntries,
    tombstones: sortedTombstones,
  }
}

/** 判断 manifest 是否基本可用（用于测试/导入）。 */
export function isValidManifest(raw) {
  return normalizeManifest(raw) !== null
}