/**
 * dsh-sync WebDAV 后端。
 *
 * 只依赖 Node 内置 fetch（或注入的 options.fetchImpl）与 node:zlib，实现 SPEC 第 5 节：
 *   - Basic Auth
 *   - init 逐级 MKCOL（405 = 已存在；同一 root/用户 5 分钟内跨实例缓存）
 *   - init 一次 PROPFIND objects/ 建对象索引（raw 与 `<hash>.z` 两种形态），
 *     索引可用时 hasObject 零往返；服务器不支持时回退单次 HEAD
 *   - PUT/GET manifest，404 → null
 *   - PROPFIND Depth:1 列设备
 *   - 对象默认 gzip（≥512B 且压缩率 <90% 才存 `.z`），读回自动解压
 *   - 每次请求 60s 超时，非 2xx 抛带状态码的可读错误
 *
 * 布局：<url 去尾斜杠><basePath>/devices/<deviceId>.json
 *       <url 去尾斜杠><basePath>/objects/<sha256>[.z]
 *
 * 兼容性：1.3.0 及更早写入的 raw 对象仍可读；`.z` 与 raw 允许共存。
 */
import { gzip, gzipSync, gunzip, gunzipSync } from 'node:zlib'
import { promisify } from 'node:util'

/** 单次请求超时（SPEC 要求 60s）。 */
const REQUEST_TIMEOUT_MS = 60_000
/** 对象名：只允许 64 位小写 sha256。 */
const HASH_RE = /^[a-f0-9]{64}$/
/** 对象压缩阈值：小于 512 字节不压（省不出收益）。 */
const COMPRESS_MIN_BYTES = 512
/** 压缩收益门槛：gzip 后必须小于原始大小的 90%。 */
const COMPRESS_RATIO = 0.9
/** gzip 级别：6（速度/压缩比平衡）。 */
const GZIP_LEVEL = 6
/**
 * 超过该体积改用异步 gzip（线程池）。
 * 32MiB 上限的文件同步压缩会阻塞事件循环数百毫秒，直接卡住 DSH 的 HTTP 服务。
 */
const ASYNC_COMPRESS_MIN_BYTES = 4 * 1024 * 1024

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/** 按体积选择同步/异步压缩：小对象走快路径，大对象不阻塞主线程。 */
async function compressBuffer(buffer) {
  if (buffer.byteLength < ASYNC_COMPRESS_MIN_BYTES) return gzipSync(buffer, { level: GZIP_LEVEL })
  return await gzipAsync(buffer, { level: GZIP_LEVEL })
}

/** 按体积选择同步/异步解压：大 `.z` 对象同样不阻塞主线程。 */
async function decompressBuffer(buffer) {
  if (buffer.byteLength < ASYNC_COMPRESS_MIN_BYTES) return gunzipSync(buffer)
  return await gunzipAsync(buffer)
}
/** init 的 MKCOL 链缓存：5 分钟内同一 root/用户/压缩配置不重复建目录。 */
const INIT_CACHE_TTL_MS = 5 * 60_000
/** 模块级缓存：`root|username|compress` → 过期时间戳；跨后端实例共享。 */
const initCache = new Map()
/** deviceId 会拼进 URL 路径段。 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** PROPFIND 请求体：只要最基础的属性，兼容性最好。 */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>' +
  '</d:prop></d:propfind>'
/** 对象索引 PROPFIND：只要 resourcetype，响应体更小、兼容性更好。 */
const PROPFIND_OBJECTS_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'

/** logger 兼容函数与对象两种形态，且不影响主流程。 */
function logWarn(logger, message) {
  try {
    if (typeof logger === 'function') logger('warn', message)
    else if (logger && typeof logger.warn === 'function') logger.warn(message)
  } catch {
    // 忽略日志失败
  }
}

function assertHash(hash) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
    throw new Error(`对象名必须是 64 位小写 sha256：${String(hash).slice(0, 80)}`)
  }
  return hash
}

function assertDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    throw new Error(`非法 deviceId：${String(deviceId).slice(0, 80)}（只允许字母、数字、下划线与短横线）`)
  }
  return deviceId
}

/** 去掉尾部斜杠（保留协议里的 `https://`）。 */
function trimTrailingSlashes(value) {
  return String(value).replace(/\/+$/, '')
}

/** basePath 归一化：保证前导 `/`，去掉尾部 `/`；`/` 归一为空串。 */
function normalizeBasePath(basePath) {
  let raw = typeof basePath === 'string' && basePath.trim().length > 0 ? basePath.trim() : '/dsh-sync'
  if (!raw.startsWith('/')) raw = `/${raw}`
  raw = raw.replace(/\/+$/, '')
  return raw
}

/** 拼接根 URL：url 去尾斜杠 + basePath（保持 `/` 语义）。 */
function computeRoot(target) {
  const rawUrl = typeof target.url === 'string' ? target.url.trim() : ''
  if (!rawUrl) throw new Error('WebDAV 后端缺少 url（例如 https://dav.example.com/remote.php/dav/files/user）')
  const base = trimTrailingSlashes(rawUrl)
  const basePath = normalizeBasePath(target.basePath)
  const root = trimTrailingSlashes(`${base}${basePath}`)
  try {
    // 提前暴露非法 url（协议、host 缺失等）
    const parsed = new URL(root)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`不支持的协议 ${parsed.protocol}`)
    }
  } catch (error) {
    throw new Error(`WebDAV url 非法：${rawUrl}（${error?.message ?? error}）`)
  }
  return root
}

/** URL 路径段编码后拼接（对象名是 hex，deviceId 已限制为安全字符）。 */
function joinUrl(root, ...segments) {
  return `${trimTrailingSlashes(root)}/${segments.map((segment) => encodeURIComponent(String(segment))).join('/')}`
}

function isOkStatus(status) {
  return status >= 200 && status < 300
}

/** 读取并丢弃响应体，避免 keep-alive 连接悬挂。 */
async function drain(response) {
  try {
    await response.arrayBuffer()
  } catch {
    // 读失败无所谓，调用方已经拿到了需要的信息
  }
}

/** 解析 XML 里少量转义实体（href 一般不含，但按规范处理）。 */
function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 从 PROPFIND XML 里提取全部 href（兼容任意命名空间前缀）。 */
function extractHrefs(xml) {
  const hrefs = []
  const hrefRe = /<(?:[A-Za-z][\w.-]*:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?href>/gi
  let match
  while ((match = hrefRe.exec(xml)) !== null) {
    hrefs.push(decodeXmlEntities(match[1].trim()))
  }
  return hrefs
}

/** href → URL 解码后的 basename；解析失败返回 null。 */
function hrefBasename(href, baseUrl) {
  let pathname
  try {
    pathname = new URL(href, baseUrl).pathname
  } catch {
    return null
  }
  const basename = pathname.replace(/\/+$/, '').split('/').pop() ?? ''
  if (!basename) return null
  try {
    return decodeURIComponent(basename)
  } catch {
    return basename
  }
}

/**
 * 对象文件名 → { hash, form }。
 * `<hash>` = raw，`<hash>.z` = gzip；其它文件（探针、临时文件）返回 null。
 */
function parseObjectName(name) {
  if (name.endsWith('.z')) {
    const hash = name.slice(0, -2)
    return HASH_RE.test(hash) ? { hash, form: 'gz' } : null
  }
  return HASH_RE.test(name) ? { hash: name, form: 'raw' } : null
}

/** 把字节输入统一成 Buffer。 */
function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes)
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  throw new Error('bytes 必须是 Buffer / Uint8Array / ArrayBuffer')
}

/** init 缓存命中？（顺手清理过期项） */
function initCacheHit(key) {
  const expiresAt = initCache.get(key)
  if (expiresAt === undefined) return false
  if (Date.now() >= expiresAt) {
    initCache.delete(key)
    return false
  }
  return true
}

/** 记录一次成功的 MKCOL 链（5 分钟内有效）。 */
function initCacheMark(key) {
  initCache.set(key, Date.now() + INIT_CACHE_TTL_MS)
}

/**
 * 清空 init 缓存（测试专用）。
 *
 * 生产路径不需要它：缓存本来就是为了让 `test()` 与紧随其后的 `sync()`
 * 不重复走 MKCOL 链。测试需要确定性，所以显式重置。
 */
export function __resetWebdavInitCache() {
  initCache.clear()
}

/** 构造带状态码的错误；错误消息面向用户，可直接展示。 */
async function statusError(method, url, response) {
  let hint = ''
  try {
    const text = await response.text()
    if (text) hint = `：${text.replace(/\s+/g, ' ').slice(0, 200)}`
  } catch {
    // 忽略响应体读取失败
  }
  const statusText = response.statusText ? ` ${response.statusText}` : ''
  return new Error(`WebDAV ${method} ${url} 失败：HTTP ${response.status}${statusText}${hint}`)
}

/**
 * 创建 WebDAV 后端。
 * @param {object} target { id, type:'webdav', label, url, username, password, basePath }
 * @param {object} options { fetchImpl, logger, signal }
 */
export function createWebdavBackend(target = {}, options = {}) {
  const targetId = String(target.id ?? 'webdav')
  const logger = options.logger
  const label =
    typeof target.label === 'string' && target.label.trim().length > 0
      ? target.label.trim()
      : 'WebDAV'
  const fetchImpl =
    typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  const user = typeof target.username === 'string' ? target.username : ''
  const password = typeof target.password === 'string' ? target.password : ''
  const authHeaders = {}
  if (user || password) {
    authHeaders.Authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
  }

  /** 可选 gzip：默认开启，options.compress === false 关闭。 */
  const compressEnabled = options.compress !== false
  /** 对象索引：hash → 'raw' | 'gz'；init 一次 PROPFIND 建立，写入增量维护。 */
  let objectIndex = new Map()
  /** 索引是否可用；PROPFIND 失败时 hasObject 回退单次 HEAD。 */
  let indexAvailable = false
  /** 同 hash 并发写去重：hash → Promise，保证最多一次 PUT。 */
  const objectInflight = new Map()

  /** 惰性解析根 URL：创建对象不抛，让 test() 能把配置错误变成可展示的 detail。 */
  let cachedRoot
  function rootUrl() {
    if (cachedRoot === undefined) cachedRoot = computeRoot(target)
    return cachedRoot
  }

  /**
   * 统一请求：注入 Basic Auth、60s 超时与外部 AbortSignal。
   * @returns {Promise<Response>}
   */
  async function request(method, url, { body, headers = {} } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('当前运行环境没有可用的 fetch（请升级 Node 或注入 options.fetchImpl）')
    }
    if (options.signal?.aborted) throw new Error('WebDAV 请求已取消')
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)]
    if (options.signal) signals.push(options.signal)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    try {
      return await fetchImpl(url, {
        method,
        headers: { ...authHeaders, ...headers },
        body,
        signal,
        redirect: 'follow',
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new Error(`WebDAV ${method} ${url} 超时（${REQUEST_TIMEOUT_MS}ms）`)
      }
      if (error?.name === 'AbortError' && options.signal?.aborted) {
        throw new Error(`WebDAV ${method} ${url} 已取消`)
      }
      throw new Error(`WebDAV ${method} ${url} 网络错误：${error?.message ?? error}`)
    }
  }

  /** MKCOL 一个集合：2xx 成功；405（已存在）视为成功；其余抛带状态码错误。 */
  async function ensureCollection(url) {
    const response = await request('MKCOL', url)
    if (isOkStatus(response.status) || response.status === 405) {
      await drain(response)
      return
    }
    throw await statusError('MKCOL', url, response)
  }

  /** 逐级建目录（5 分钟内同 root/用户/压缩配置跨实例复用），再重建对象索引。 */
  async function init() {
    const root = rootUrl()
    const cacheKey = `${root}|${user}|${compressEnabled ? 'gz' : 'raw'}`
    if (!initCacheHit(cacheKey)) {
      const base = trimTrailingSlashes(String(target.url ?? '').trim())
      const segments = normalizeBasePath(target.basePath).split('/').filter(Boolean)
      let cursor = base
      for (const segment of segments) {
        cursor = `${cursor}/${encodeURIComponent(segment)}`
        await ensureCollection(cursor)
      }
      await ensureCollection(joinUrl(root, 'devices'))
      await ensureCollection(joinUrl(root, 'objects'))
      initCacheMark(cacheKey)
    }
    await refreshObjectIndex(cacheKey)
    return { ok: true, detail: root, objectsIndexed: indexAvailable }
  }

  /**
   * 重建对象索引：PROPFIND objects/ Depth:1，只解析 resourcetype。
   * 每次 init 都重建（目录可能被其它设备改过）；404/405/501 或响应不可解析时
   * 标记索引不可用，hasObject 回退为单次 HEAD。
   */
  async function refreshObjectIndex(cacheKey) {
    const root = rootUrl()
    const url = `${joinUrl(root, 'objects')}/`
    const response = await request('PROPFIND', url, {
      body: Buffer.from(PROPFIND_OBJECTS_BODY, 'utf8'),
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    })
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await drain(response)
      objectIndex = new Map()
      indexAvailable = false
      // 404 说明 objects 集合不在了（缓存可能是旧的），下次 init 重新走 MKCOL
      if (response.status === 404) initCache.delete(cacheKey)
      logWarn(logger, `WebDAV 对象索引不可用（PROPFIND 返回 ${response.status}），回退为逐对象 HEAD`)
      return
    }
    if (response.status !== 207 && !isOkStatus(response.status)) {
      throw await statusError('PROPFIND', url, response)
    }
    let xml
    try {
      xml = await response.text()
    } catch (error) {
      objectIndex = new Map()
      indexAvailable = false
      logWarn(logger, `WebDAV 对象索引读取失败，回退为逐对象 HEAD：${error?.message ?? error}`)
      return
    }
    const hrefs = extractHrefs(xml)
    // 正常至少包含集合自身；一个 href 都没有说明响应不可信，宁可用 HEAD
    if (hrefs.length === 0) {
      objectIndex = new Map()
      indexAvailable = false
      logWarn(logger, 'WebDAV 对象索引为空或无法解析，回退为逐对象 HEAD')
      return
    }
    const next = new Map()
    for (const href of hrefs) {
      const name = hrefBasename(href, url)
      if (!name) continue
      const parsed = parseObjectName(name)
      if (!parsed) continue
      // 同一 hash 同时存在 raw 与 .z（混合版本并发写）时优先 gz，读取只需一次 GET
      if (parsed.form === 'gz' || !next.has(parsed.hash)) next.set(parsed.hash, parsed.form)
    }
    objectIndex = next
    indexAvailable = true
  }

  /** PROPFIND Depth:1 列设备：取 href 的 basename，URL 解码后去掉 .json。 */
  async function listDevices() {
    const root = rootUrl()
    const url = `${joinUrl(root, 'devices')}/`
    const response = await request('PROPFIND', url, {
      body: Buffer.from(PROPFIND_BODY, 'utf8'),
      headers: {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      },
    })
    if (response.status === 404) {
      await drain(response)
      return []
    }
    if (response.status !== 207 && !isOkStatus(response.status)) {
      throw await statusError('PROPFIND', url, response)
    }
    const xml = await response.text()
    const hrefs = []
    const hrefRe = /<(?:[A-Za-z][\w.-]*:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z][\w.-]*:)?href>/gi
    let match
    while ((match = hrefRe.exec(xml)) !== null) {
      hrefs.push(decodeXmlEntities(match[1].trim()))
    }
    const ids = []
    for (const href of hrefs) {
      let pathname
      try {
        pathname = new URL(href, url).pathname
      } catch {
        continue
      }
      const basename = pathname.replace(/\/+$/, '').split('/').pop() ?? ''
      let decoded
      try {
        decoded = decodeURIComponent(basename)
      } catch {
        decoded = basename
      }
      if (!decoded.endsWith('.json')) continue
      const id = decoded.slice(0, -'.json'.length)
      if (!DEVICE_ID_RE.test(id)) {
        logWarn(logger, `忽略非法设备 manifest 文件名：${decoded}`)
        continue
      }
      ids.push(id)
    }
    return [...new Set(ids)].sort()
  }

  /** GET manifest；404 → null；解析失败记录 warn 后返回 null（不让同步崩溃）。 */
  async function readManifest(deviceId) {
    const root = rootUrl()
    assertDeviceId(deviceId)
    const url = joinUrl(root, 'devices', `${deviceId}.json`)
    const response = await request('GET', url, { headers: { Accept: 'application/json' } })
    if (response.status === 404) {
      await drain(response)
      return null
    }
    if (!isOkStatus(response.status)) throw await statusError('GET', url, response)
    const text = await response.text()
    try {
      return JSON.parse(text)
    } catch (error) {
      logWarn(logger, `manifest 解析失败，视为不存在：${url}：${error?.message ?? error}`)
      return null
    }
  }

  /** PUT manifest（服务端 PUT 保证整体生效）。 */
  async function writeManifest(deviceId, manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest 必须是普通对象')
    }
    const root = rootUrl()
    assertDeviceId(deviceId)
    const url = joinUrl(root, 'devices', `${deviceId}.json`)
    const body = Buffer.from(JSON.stringify(manifest), 'utf8')
    const response = await request('PUT', url, {
      body,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    if (!isOkStatus(response.status)) throw await statusError('PUT', url, response)
    await drain(response)
    return { ok: true, size: body.byteLength }
  }

  /** 对象是否存在：索引可用时 0 往返；索引不可用时回退单次 HEAD。 */
  async function hasObject(hash) {
    const root = rootUrl()
    assertHash(hash)
    if (indexAvailable) return objectIndex.has(hash)
    const url = joinUrl(root, 'objects', hash)
    const response = await request('HEAD', url)
    if (response.status === 200 || response.status === 204) {
      await drain(response)
      return true
    }
    if (response.status === 404) {
      await drain(response)
      return false
    }
    throw await statusError('HEAD', url, response)
  }

  /**
   * 读对象：按索引记录的形态 GET（.z 自动 gunzip 还原原始字节）。
   * 404 时删掉过期索引并换另一种形态重试一次，最多两次 GET，不死循环。
   * 索引不可用/未知形态时按契约先试 `.z` 再试 raw（兼容 1.3.0 的 raw 对象）。
   */
  async function readObject(hash) {
    const root = rootUrl()
    assertHash(hash)
    const known = objectIndex.get(hash)
    const forms = known === 'raw' ? ['raw', 'gz'] : ['gz', 'raw']
    for (const form of forms) {
      const fileName = form === 'gz' ? `${hash}.z` : hash
      const url = joinUrl(root, 'objects', fileName)
      const response = await request('GET', url, {
        headers: { Accept: form === 'gz' ? 'application/gzip' : 'application/octet-stream' },
      })
      if (response.status === 404) {
        await drain(response)
        // 索引记录与服务器不一致（其它设备删过/并发写）：删掉这条，试另一种形态
        if (objectIndex.get(hash) === form) objectIndex.delete(hash)
        continue
      }
      if (!isOkStatus(response.status)) throw await statusError('GET', url, response)
      const buffer = Buffer.from(await response.arrayBuffer())
      if (form === 'gz') {
        let raw
        try {
          raw = await decompressBuffer(buffer)
        } catch (error) {
          throw new Error(`WebDAV 对象 ${hash} 解压失败：${error?.message ?? error}`)
        }
        objectIndex.set(hash, 'gz')
        return new Uint8Array(raw)
      }
      objectIndex.set(hash, 'raw')
      return new Uint8Array(buffer)
    }
    return null
  }

  /**
   * 写对象：索引命中直接跳过；未命中按压缩收益决策后**单次 PUT**。
   * 同 hash 并发调用共享同一个 Promise（最多一次 PUT），后来者返回 skipped。
   * 返回 { skipped, size(原始字节), storedBytes(实际传输字节), compressed }。
   */
  async function writeObject(hash, bytes) {
    const root = rootUrl()
    assertHash(hash)
    const buffer = toBuffer(bytes)
    if (objectIndex.has(hash)) {
      return { ok: true, skipped: true, size: buffer.byteLength, storedBytes: 0 }
    }
    const running = objectInflight.get(hash)
    if (running) {
      // 有人正在传同一内容：等它完成，自己不重复发 PUT
      await running
      return { ok: true, skipped: true, size: buffer.byteLength, storedBytes: 0 }
    }
    const task = (async () => {
      let body = buffer
      let form = 'raw'
      if (compressEnabled && buffer.byteLength >= COMPRESS_MIN_BYTES) {
        const gz = await compressBuffer(buffer)
        if (gz.byteLength < buffer.byteLength * COMPRESS_RATIO) {
          body = gz
          form = 'gz'
        }
      }
      const fileName = form === 'gz' ? `${hash}.z` : hash
      const url = joinUrl(root, 'objects', fileName)
      const response = await request('PUT', url, {
        body,
        headers: {
          'Content-Type': form === 'gz' ? 'application/gzip' : 'application/octet-stream',
        },
      })
      if (!isOkStatus(response.status)) throw await statusError('PUT', url, response)
      await drain(response)
      objectIndex.set(hash, form)
      return {
        ok: true,
        skipped: false,
        size: buffer.byteLength,
        storedBytes: body.byteLength,
        compressed: form === 'gz',
      }
    })()
    objectInflight.set(hash, task)
    try {
      return await task
    } finally {
      objectInflight.delete(hash)
    }
  }

  /** 探测：init（MKCOL 全链路）+ 写/读/删一个小探测文件；任何失败都返回 ok:false。 */
  async function test() {
    try {
      const root = rootUrl()
      await init()
      const probeUrl = `${root}/.dsh-sync-probe-${Date.now()}-${Math.random().toString(16).slice(2, 10)}.txt`
      const payload = `dsh-sync probe ${new Date().toISOString()}`
      const put = await request('PUT', probeUrl, {
        body: Buffer.from(payload, 'utf8'),
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
      if (!isOkStatus(put.status)) throw await statusError('PUT', probeUrl, put)
      await drain(put)
      const get = await request('GET', probeUrl)
      if (!isOkStatus(get.status)) throw await statusError('GET', probeUrl, get)
      const text = await get.text()
      if (text !== payload) throw new Error('探测文件读回内容不一致')
      const del = await request('DELETE', probeUrl)
      if (!(isOkStatus(del.status) || del.status === 404)) {
        throw await statusError('DELETE', probeUrl, del)
      }
      await drain(del)
      return {
        ok: true,
        detail: `${root}：MKCOL、探测文件写入 / 读取 / 删除均成功`,
      }
    } catch (error) {
      return { ok: false, detail: `WebDAV 探测失败：${error?.message ?? error}` }
    }
  }

  /** 摘要：绝不包含 password。 */
  async function describe() {
    let detail
    try {
      detail = rootUrl()
    } catch {
      detail = '(url 未配置或非法)'
    }
    if (user) detail = `${detail}（用户 ${user}）`
    return { type: 'webdav', label, detail }
  }

  async function close() {
    // fetch 由宿主管理，无常驻资源需要释放
  }

  return {
    type: 'webdav',
    targetId,
    init,
    test,
    listDevices,
    readManifest,
    writeManifest,
    hasObject,
    readObject,
    writeObject,
    describe,
    close,
  }
}