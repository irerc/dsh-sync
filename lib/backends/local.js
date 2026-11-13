/**
 * dsh-sync 本地目录后端。
 *
 * 存储布局（与 SPEC 3.2 / 5 节一致）：
 *   <path>/devices/<deviceId>.json   设备 manifest
 *   <path>/objects/<sha256>          内容对象（文件名 = 内容哈希）
 *
 * 适用于本地磁盘、rclone / Termux SAF 等已挂载的“文件型”目标。
 * 所有写入都走 util.js 的 tmp + fsync + rename，避免同步过程中被读到半截文件。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  ensureDir,
  removeFileIfExists,
  writeFileAtomic,
  writeJsonAtomic,
} from '../util.js'

/** 对象名：只允许 64 位小写 sha256。 */
const HASH_RE = /^[a-f0-9]{64}$/
/** deviceId 会拼进文件名：只允许安全字符，禁止 `.` / `..` / 路径分隔符。 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** logger 既可能是函数，也可能是带 warn 的对象；两种都兼容，且绝不影响主流程。 */
function logWarn(logger, message) {
  try {
    if (typeof logger === 'function') logger('warn', message)
    else if (logger && typeof logger.warn === 'function') logger.warn(message)
  } catch {
    // 日志失败不能拖垮同步
  }
}

/** 校验对象名，非法直接抛错（调用方传错是编程错误，不应静默）。 */
function assertHash(hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
    throw new Error(`对象名必须是 64 位小写 sha256：${String(hash).slice(0, 80)}`)
  }
  return hash
}

/** 校验 deviceId，防止路径穿越。 */
function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    throw new Error(`非法 deviceId：${String(deviceId).slice(0, 80)}（只允许字母、数字、下划线与短横线）`)
  }
  return deviceId
}

/** 把各种字节输入统一成 Buffer。 */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes)
  if (ArrayBuffer.isView(bytes)) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8')
  throw new Error('bytes 必须是 Buffer / Uint8Array / ArrayBuffer')
}

/**
 * 创建本地目录后端。
 * @param {object} target 配置项：{ id, type:'local', label, path }
 * @param {object} options { logger, signal }
 */
export function createLocalBackend(target = {}, options = {}) {
  const root = typeof target.path === 'string' ? target.path.trim() : ''
  const targetId = String(target.id ?? 'local')
  const logger = options.logger
  const label =
    typeof target.label === 'string' && target.label.trim().length > 0
      ? target.label.trim()
      : '本地目录'

  /** path 缺失时 init/test 给出可读错误；创建对象本身不抛，方便 UI 测试草稿配置。 */
  function requireRoot() {
    if (!root) throw new Error('本地后端缺少 path（请填写本地目录或挂载点路径）')
    return root
  }

  function devicesDir() {
    return path.join(requireRoot(), 'devices')
  }

  function objectsDir() {
    return path.join(requireRoot(), 'objects')
  }

  function manifestFile(deviceId) {
    assertDeviceId(deviceId)
    return path.join(devicesDir(), `${deviceId}.json`)
  }

  function objectFile(hash) {
    assertHash(hash)
    return path.join(objectsDir(), hash)
  }

  /** 建 devices/ objects/，幂等。 */
  async function init() {
    requireRoot()
    await ensureDir(devicesDir())
    await ensureDir(objectsDir())
    return { ok: true, detail: root }
  }

  /** 连通性/可写性探测：初始化目录 + 写读删一个探测文件；失败不抛。 */
  async function test() {
    try {
      requireRoot()
      await init()
      const probe = path.join(root, `.dsh-sync-probe-${process.pid}-${Date.now()}.tmp`)
      const payload = Buffer.from('dsh-sync-probe', 'utf8')
      await writeFileAtomic(probe, payload)
      const readBack = await fsp.readFile(probe)
      await removeFileIfExists(probe)
      if (!readBack.equals(payload)) {
        return { ok: false, detail: `本地目录 ${root} 探测文件读回内容不一致` }
      }
      return { ok: true, detail: `${root}（devices/、objects/ 可写，探测文件读写成功）` }
    } catch (error) {
      return { ok: false, detail: `本地目录不可用：${error?.message ?? error}` }
    }
  }

  /** 列出 devices/ 下所有合法 manifest 对应的 deviceId（升序、去重）。 */
  async function listDevices() {
    requireRoot()
    let entries
    try {
      entries = await fsp.readdir(devicesDir(), { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const ids = []
    for (const entry of entries) {
      // 目录/符号链接都不算设备 manifest；原子写的 tmp 残留也不会以 .json 结尾
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -'.json'.length)
      if (!DEVICE_ID_RE.test(id)) {
        logWarn(logger, `忽略非法的设备 manifest 文件名：${entry.name}`)
        continue
      }
      ids.push(id)
    }
    return [...new Set(ids)].sort()
  }

  /**
   * 列出 objects/ 下所有对象 hash（升序、去重）。
   *
   * 供对等协议 `GET /dsh-sync/v1/objects` 使用：对端据此一次性建立对象索引，
   * 免去每个对象一次 HEAD 往返（上传/拉取各少一次 RTT）。
   * @returns {Promise<string[]>}
   */
  async function listObjects() {
    requireRoot()
    let entries
    try {
      entries = await fsp.readdir(objectsDir(), { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const hashes = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      // 兼容以后可能出现的 gzip 形态：<sha256>.z 也归到同一个 hash。
      const name = entry.name.endsWith('.z') ? entry.name.slice(0, -'.z'.length) : entry.name
      if (!HASH_RE.test(name)) continue
      hashes.push(name)
    }
    return [...new Set(hashes)].sort()
  }

  /** 读设备 manifest；不存在返回 null；内容损坏也按不存在处理（记录 warn）。 */
  async function readManifest(deviceId) {
    const file = manifestFile(deviceId)
    let text
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      logWarn(logger, `manifest 解析失败，视为不存在：${file}：${error?.message ?? error}`)
      return null
    }
  }

  /** 原子写设备 manifest（tmp + rename）。 */
  async function writeManifest(deviceId, manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest 必须是普通对象')
    }
    const file = manifestFile(deviceId)
    await writeJsonAtomic(file, manifest)
    return { ok: true, path: file }
  }

  /** 对象是否存在。 */
  async function hasObject(hash) {
    const file = objectFile(hash)
    try {
      const stat = await fsp.stat(file)
      return stat.isFile()
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  /** 读对象；不存在返回 null。 */
  async function readObject(hash) {
    const file = objectFile(hash)
    let buffer
    try {
      buffer = await fsp.readFile(file)
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
    // 复制成普通 Uint8Array，避免把 Buffer 池的 view 泄漏给调用方
    return new Uint8Array(buffer)
  }

  /** 写对象：已存在直接跳过（内容寻址，天然幂等）；tmp + rename 原子落盘。 */
  async function writeObject(hash, bytes) {
    const file = objectFile(hash)
    if (await hasObject(hash)) return { ok: true, skipped: true }
    await writeFileAtomic(file, toBuffer(bytes))
    return { ok: true, skipped: false }
  }

  /** 摘要：只暴露路径与类型，不含任何凭据。 */
  async function describe() {
    return {
      type: 'local',
      label,
      detail: root || '(未配置 path)',
    }
  }

  async function close() {
    // 文件句柄都由单次调用内部关闭，无常驻资源
  }

  return {
    type: 'local',
    targetId,
    init,
    test,
    listDevices,
    listObjects,
    readManifest,
    writeManifest,
    hasObject,
    readObject,
    writeObject,
    describe,
    close,
  }
}