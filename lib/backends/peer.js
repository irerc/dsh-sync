/**
 * dsh-sync 对等 DSH 后端（peer）。
 *
 * 协议（SPEC 第 5 / 7 节）：<url 去尾斜杠>/dsh-sync/v1
 *   GET  ping                → { ok:true, protocol:1, deviceId, deviceName }
 *   GET  devices             → { devices: string[] }
 *   GET  devices/<id>        → manifest JSON，404 → null
 *   PUT  devices/<id>        → 保存 manifest
 *   HEAD objects/<hash>      → 200/404
 *   GET  objects/<hash>      → 原始字节，404 → null
 *   PUT  objects/<hash>      → 原始字节，幂等
 * 认证：x-dsh-sync-token。
 *
 * test() 只做 ping + HEAD 全零 hash 的权限探测，绝不写假 manifest、不污染设备列表。
 */
/** 单次请求超时；与 WebDAV 后端保持一致，避免对端失联时无限等待。 */
const REQUEST_TIMEOUT_MS = 60_000
/** 对象名：只允许 64 位小写 sha256。 */
const HASH_RE = /^[a-f0-9]{64}$/
/** deviceId 会拼进 URL 路径段。 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** 全零 hash：只用于权限探测，真实对象不可能以它命名。 */
const ZERO_HASH = '0'.repeat(64)

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

function trimTrailingSlashes(value) {
  return String(value).replace(/\/+$/, '')
}

/**
 * 把 target.url 归一化成协议根（SPEC-CHANGELOG：配对区展示的是完整协议根，
 * 用户复制粘贴后不能拼成 `/dsh-sync/v1/dsh-sync/v1`）。规则：
 *   1. 去尾斜杠后已以 `/dsh-sync/v1` 结尾 → 原样使用；
 *   2. 以 `/dsh-sync` 结尾 → 补 `/v1`；
 *   3. 其他（origin、origin/、自定义 path 前缀）→ 补 `/dsh-sync/v1`。
 * 去掉 query/fragment，避免把 token 之类拼进路径；不支持 url 内嵌凭据。
 * @param {string} url
 * @returns {string} 形如 http://host:port[/prefix]/dsh-sync/v1
 */
export function resolveProtocolBase(url) {
  const rawUrl = typeof url === 'string' ? url.trim() : ''
  if (!rawUrl) throw new Error('peer 后端缺少 url（例如 http://192.168.1.10:3080）')
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    throw new Error(`peer url 非法：${rawUrl}（${error?.message ?? error}）`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`peer url 只支持 http/https：${rawUrl}`)
  }
  const base = trimTrailingSlashes(`${parsed.origin}${parsed.pathname}`)
  if (base.endsWith('/dsh-sync/v1')) return base
  if (base.endsWith('/dsh-sync')) return `${base}/v1`
  return `${base}/dsh-sync/v1`
}

/** 兼容 target 形式的协议根解析。 */
function computeProtocolRoot(target) {
  return resolveProtocolBase(target.url)
}

function isOkStatus(status) {
  return status >= 200 && status < 300
}

async function drain(response) {
  try {
    await response.arrayBuffer()
  } catch {
    // 忽略
  }
}

/** 构造带状态码的错误；401 单独给出“token 无效”的提示。 */
async function statusError(method, url, response) {
  let hint = ''
  try {
    const text = await response.text()
    if (text) hint = `：${text.replace(/\s+/g, ' ').slice(0, 200)}`
  } catch {
    // 忽略
  }
  if (response.status === 401) {
    return new Error(
      `peer 认证失败：token 无效（${method} ${url} 返回 HTTP 401，请核对两端 x-dsh-sync-token）`,
    )
  }
  const statusText = response.statusText ? ` ${response.statusText}` : ''
  return new Error(`peer ${method} ${url} 失败：HTTP ${response.status}${statusText}${hint}`)
}

/**
 * 未 2xx 即抛错。注意：成功时不能吞掉响应体——
 * ping / listDevices 还要读 JSON；需要丢弃 body 的调用方各自显式 drain。
 */
async function ensureOk(response, method, url) {
  if (!isOkStatus(response.status)) throw await statusError(method, url, response)
}

/**
 * 创建对等 DSH 后端。
 * @param {object} target { id, type:'peer', label, url, token }
 * @param {object} options { fetchImpl, logger, signal }
 */
export function createPeerBackend(target = {}, options = {}) {
  const targetId = String(target.id ?? 'peer')
  const logger = options.logger
  const label =
    typeof target.label === 'string' && target.label.trim().length > 0
      ? target.label.trim()
      : '另一台 DSH'
  const token = typeof target.token === 'string' ? target.token : ''
  const fetchImpl =
    typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch

  /**
   * 对象索引：init 时用一次 `GET /v1/objects` 把对端已有对象全量拉下来。
   * 新版本对端支持该端点 → 之后每个对象 0 次 HEAD；老版本返回 404 → 回退逐对象 HEAD。
   */
  let objectIndex = new Set()
  /** 索引是否可用（端点存在且响应完整）。 */
  let indexAvailable = false
  /** 已尝试过拉清单：失败后本实例内不再重试，避免每个 sync 都白跑一次。 */
  let indexAttempted = false
  /** 同 hash 并发写去重：hash → Promise，保证最多一次 PUT。 */
  const objectInflight = new Map()

  /** 惰性解析协议根：创建对象不抛，配置错误由 init/test 以可读方式暴露。 */
  let cachedRoot
  function protocolRoot() {
    if (cachedRoot === undefined) cachedRoot = computeProtocolRoot(target)
    return cachedRoot
  }

  /** 统一请求：注入 token 头、60s 超时与外部 AbortSignal。 */
  async function request(method, subPath, { body, headers = {} } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('当前运行环境没有可用的 fetch（请升级 Node 或注入 options.fetchImpl）')
    }
    if (options.signal?.aborted) throw new Error('peer 请求已取消')
    const url = `${protocolRoot()}/${subPath.replace(/^\/+/, '')}`
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)]
    if (options.signal) signals.push(options.signal)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
    try {
      return await fetchImpl(url, {
        method,
        headers: {
          'x-dsh-sync-token': token,
          Accept: 'application/json',
          ...headers,
        },
        body,
        signal,
        redirect: 'follow',
      })
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new Error(`peer ${method} ${url} 超时（${REQUEST_TIMEOUT_MS}ms）`)
      }
      if (error?.name === 'AbortError' && options.signal?.aborted) {
        throw new Error(`peer ${method} ${url} 已取消`)
      }
      throw new Error(`peer ${method} ${url} 网络错误：${error?.message ?? error}`)
    }
  }

  /** ping：验证协议与版本；401 也给出可读错误。 */
  async function ping() {
    const response = await request('GET', 'ping')
    await ensureOk(response, 'GET', `${protocolRoot()}/ping`)
    let data
    try {
      data = await response.json()
    } catch (error) {
      throw new Error(`peer ping 返回非 JSON：${error?.message ?? error}`)
    }
    if (!data || data.ok !== true) {
      throw new Error(`peer ping 返回异常：${JSON.stringify(data).slice(0, 200)}`)
    }
    return data
  }

  /**
   * 拉取对端对象清单建索引（失败不抛，只降级）。
   *
   * 兼容旧对端：没有 `/v1/objects` 端点时返回 404/405/501 → indexAvailable=false，
   * 之后 hasObject 走单次 HEAD。响应被截断（truncated）时同样降级——索引不完整
   * 会误判“已存在/不存在”，那比多一次 HEAD 危险得多。
   */
  async function refreshObjectIndex() {
    if (indexAttempted && !indexAvailable) return
    indexAttempted = true
    const url = `${protocolRoot()}/objects`
    let response
    try {
      response = await request('GET', 'objects')
    } catch (error) {
      indexAvailable = false
      logWarn(logger, `peer 对象索引不可用，回退为逐对象 HEAD：${error?.message ?? error}`)
      return
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      await drain(response)
      indexAvailable = false
      return
    }
    if (!isOkStatus(response.status)) {
      await drain(response)
      indexAvailable = false
      logWarn(logger, `peer 对象索引不可用（HTTP ${response.status}），回退为逐对象 HEAD`)
      return
    }
    let data
    try {
      data = await response.json()
    } catch (error) {
      indexAvailable = false
      logWarn(logger, `peer 对象索引解析失败，回退为逐对象 HEAD：${error?.message ?? error}`)
      return
    }
    const raw = Array.isArray(data?.hashes) ? data.hashes : null
    // ok !== true 时即使 HTTP 200 也不可信（老版本/代理可能返回形状不同的 JSON）
    if (data?.ok !== true || raw === null || data?.truncated === true) {
      indexAvailable = false
      logWarn(
        logger,
        `peer 对象索引不完整（${data?.ok !== true ? 'ok 不为 true' : data?.truncated === true ? '被截断' : '缺少 hashes'}），回退为逐对象 HEAD`,
      )
      return
    }
    const next = new Set()
    for (const item of raw) {
      if (typeof item === 'string' && HASH_RE.test(item)) next.add(item)
    }
    objectIndex = next
    indexAvailable = true
  }

  /** init：ping 校验协议与 token；有对象清单则建索引，否则 HEAD 全零 hash 探测。 */
  async function init() {
    const info = await ping()
    await refreshObjectIndex()
    if (!indexAvailable) {
      const url = `${protocolRoot()}/objects/${ZERO_HASH}`
      const response = await request('HEAD', `objects/${ZERO_HASH}`)
      if (response.status === 401) throw await statusError('HEAD', url, response)
      if (!(response.status === 200 || response.status === 204 || response.status === 404)) {
        throw await statusError('HEAD', url, response)
      }
      await drain(response)
    }
    return {
      ok: true,
      detail: `${protocolRoot()}（protocol=${info.protocol ?? '?'}，deviceName=${info.deviceName ?? '?'}${
        indexAvailable ? `，对象索引 ${objectIndex.size} 条` : ''
      }）`,
      objectsIndexed: indexAvailable,
    }
  }

  /** test：ping + HEAD 全零 hash，不抛、不写假 manifest。 */
  async function test() {
    try {
      const root = protocolRoot()
      const info = await ping()
      const parts = [`ping 正常（protocol=${info.protocol ?? '?'}，deviceName=${info.deviceName ?? '?'}）`]
      const url = `${root}/objects/${ZERO_HASH}`
      const response = await request('HEAD', `objects/${ZERO_HASH}`)
      if (response.status === 401) throw await statusError('HEAD', url, response)
      if (!(response.status === 200 || response.status === 204 || response.status === 404)) {
        throw await statusError('HEAD', url, response)
      }
      await drain(response)
      parts.push(response.status === 404 ? '对象探测为空（权限正常）' : '对象探测命中（权限正常）')
      return { ok: true, detail: `${root}：${parts.join('；')}` }
    } catch (error) {
      return { ok: false, detail: `peer 探测失败：${error?.message ?? error}` }
    }
  }

  /** GET devices → 排序后的 deviceId 列表（过滤非法值）。 */
  async function listDevices() {
    const url = `${protocolRoot()}/devices`
    const response = await request('GET', 'devices')
    await ensureOk(response, 'GET', url)
    let data
    try {
      data = await response.json()
    } catch (error) {
      throw new Error(`peer devices 返回非 JSON：${error?.message ?? error}`)
    }
    const raw = Array.isArray(data?.devices) ? data.devices : null
    if (raw === null) throw new Error('peer devices 响应格式不正确（缺少 devices 数组）')
    const ids = []
    for (const item of raw) {
      if (typeof item !== 'string' || !DEVICE_ID_RE.test(item)) {
        logWarn(logger, `忽略非法 deviceId：${String(item).slice(0, 80)}`)
        continue
      }
      ids.push(item)
    }
    return [...new Set(ids)].sort()
  }

  /** GET 设备 manifest；404 → null；解析失败 warn 后返回 null。 */
  async function readManifest(deviceId) {
    assertDeviceId(deviceId)
    const url = `${protocolRoot()}/devices/${encodeURIComponent(deviceId)}`
    const response = await request('GET', `devices/${encodeURIComponent(deviceId)}`)
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

  /** PUT 设备 manifest。 */
  async function writeManifest(deviceId, manifest) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest 必须是普通对象')
    }
    assertDeviceId(deviceId)
    const url = `${protocolRoot()}/devices/${encodeURIComponent(deviceId)}`
    const body = Buffer.from(JSON.stringify(manifest), 'utf8')
    const response = await request('PUT', `devices/${encodeURIComponent(deviceId)}`, {
      body,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    if (!isOkStatus(response.status)) throw await statusError('PUT', url, response)
    await drain(response)
    return { ok: true, size: body.byteLength }
  }

  /** 对象是否存在：索引可用时 0 往返；否则单次 HEAD。 */
  async function hasObject(hash) {
    assertHash(hash)
    if (indexAvailable) return objectIndex.has(hash)
    const url = `${protocolRoot()}/objects/${hash}`
    const response = await request('HEAD', `objects/${hash}`)
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
    assertHash(hash)
    const url = `${protocolRoot()}/objects/${hash}`
    const response = await request('GET', `objects/${hash}`, {
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

  /**
   * 写对象：索引命中直接跳过；未命中才 PUT（内容寻址，天然幂等）。
   * 同一 hash 并发写只发一次 PUT——引擎并发上传时多个条目可能指向同一内容。
   */
  async function writeObject(hash, bytes) {
    assertHash(hash)
    if (indexAvailable && objectIndex.has(hash)) return { ok: true, skipped: true, storedBytes: 0 }
    const pending = objectInflight.get(hash)
    if (pending) {
      // 与 WebDAV 后端对齐：等首个 PUT 完成后按“去重跳过”结算，
      // 否则 engine 会把同一份字节按调用次数重复计入 wireBytesUp（统计虚高）。
      await pending
      return { ok: true, skipped: true, size: 0, storedBytes: 0 }
    }
    let body
    if (Buffer.isBuffer(bytes)) body = bytes
    else if (bytes instanceof Uint8Array) body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    else if (bytes instanceof ArrayBuffer) body = Buffer.from(bytes)
    else if (ArrayBuffer.isView(bytes)) body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    else throw new Error('bytes 必须是 Buffer / Uint8Array / ArrayBuffer')
    const url = `${protocolRoot()}/objects/${hash}`
    const task = (async () => {
      if (!indexAvailable && await hasObject(hash)) {
        objectIndex.add(hash)
        return { ok: true, skipped: true, storedBytes: 0 }
      }
      const response = await request('PUT', `objects/${hash}`, {
        body,
        headers: { 'Content-Type': 'application/octet-stream' },
      })
      if (!isOkStatus(response.status)) throw await statusError('PUT', url, response)
      await drain(response)
      objectIndex.add(hash)
      return { ok: true, skipped: false, size: body.byteLength, storedBytes: body.byteLength }
    })()
    objectInflight.set(hash, task)
    try {
      return await task
    } finally {
      objectInflight.delete(hash)
    }
  }

  /** 摘要：只暴露协议根，绝不包含 token。 */
  async function describe() {
    let detail
    try {
      detail = protocolRoot()
    } catch {
      detail = '(url 未配置或非法)'
    }
    return { type: 'peer', label, detail }
  }

  async function close() {
    // fetch 连接由宿主管理
  }

  return {
    type: 'peer',
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