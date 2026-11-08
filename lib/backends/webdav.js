/**
 * dsh-sync WebDAV 后端。
 *
 * 只依赖 Node 内置 fetch（或注入的 options.fetchImpl），实现 SPEC 第 5 节：
 *   - Basic Auth
 *   - init 逐级 MKCOL（405 = 已存在）
 *   - PUT/GET manifest，404 → null
 *   - PROPFIND Depth:1 列设备（解析 <d:href> / <d:href>，URL 解码）
 *   - HEAD 探测对象，缺失再 PUT
 *   - 每次请求 60s 超时，非 2xx 抛带状态码的可读错误
 *
 * 布局：<url 去尾斜杠><basePath>/devices/<deviceId>.json
 *       <url 去尾斜杠><basePath>/objects/<sha256>
 */

/** 单次请求超时（SPEC 要求 60s）。 */
const REQUEST_TIMEOUT_MS = 60_000
/** 对象名：只允许 64 位小写 sha256。 */
const HASH_RE = /^[a-f0-9]{64}$/
/** deviceId 会拼进 URL 路径段。 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** PROPFIND 请求体：只要最基础的属性，兼容性最好。 */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>' +
  '</d:prop></d:propfind>'

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

  /** 逐级建目录：先按 basePath 的每一段 MKCOL，再建 devices/、objects/。 */
  async function init() {
    const root = rootUrl()
    const base = trimTrailingSlashes(String(target.url ?? '').trim())
    const segments = normalizeBasePath(target.basePath).split('/').filter(Boolean)
    let cursor = base
    for (const segment of segments) {
      cursor = `${cursor}/${encodeURIComponent(segment)}`
      await ensureCollection(cursor)
    }
    await ensureCollection(joinUrl(root, 'devices'))
    await ensureCollection(joinUrl(root, 'objects'))
    return { ok: true, detail: root }
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

  /** HEAD 探测对象：200/204 → true，404 → false，其余抛错。 */
  async function hasObject(hash) {
    const root = rootUrl()
    assertHash(hash)
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

  /** GET 对象；404 → null。 */
  async function readObject(hash) {
    const root = rootUrl()
    assertHash(hash)
    const url = joinUrl(root, 'objects', hash)
    const response = await request('GET', url, {
      headers: { Accept: 'application/octet-stream' },
    })
    if (response.status === 404) {
      await drain(response)
      return null
    }
    if (!isOkStatus(response.status)) throw await statusError('GET', url, response)
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  /** 写对象：先 HEAD，已存在跳过；不存在再 PUT（内容寻址，天然幂等）。 */
  async function writeObject(hash, bytes) {
    const root = rootUrl()
    assertHash(hash)
    if (await hasObject(hash)) return { ok: true, skipped: true }
    const url = joinUrl(root, 'objects', hash)
    let body
    if (Buffer.isBuffer(bytes)) body = bytes
    else if (bytes instanceof Uint8Array) body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    else if (bytes instanceof ArrayBuffer) body = Buffer.from(bytes)
    else if (ArrayBuffer.isView(bytes)) body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    else throw new Error('bytes 必须是 Buffer / Uint8Array / ArrayBuffer')
    const response = await request('PUT', url, {
      body,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    if (!isOkStatus(response.status)) throw await statusError('PUT', url, response)
    await drain(response)
    return { ok: true, skipped: false, size: body.byteLength }
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