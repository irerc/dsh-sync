/**
 * 内存版 dsh-sync v1 peer 服务（测试专用）。
 *
 * 按 SPEC 第 7 节实现 peer 协议，可独立于 `lib/http-api.js` 使用：
 *
 *   GET    <prefix>/v1/ping                    无需 token
 *   GET    <prefix>/v1/devices                 { devices: string[] }
 *   GET    <prefix>/v1/devices/<deviceId>      manifest JSON / 404
 *   PUT    <prefix>/v1/devices/<deviceId>      manifest JSON（< 2 MiB）
 *   HEAD   <prefix>/v1/objects/<sha256>        200 / 404
 *   GET    <prefix>/v1/objects/<sha256>        原始字节 / 404
 *   PUT    <prefix>/v1/objects/<sha256>        原始字节，幂等，校验 hash
 *
 * 全部路由（除 ping）校验 `x-dsh-sync-token`，不匹配返回 401。
 *
 * 存储：
 * - 默认纯内存（devices/objects 两个 Map）。
 * - 传入 `storePath` 时落盘为 `devices/<id>.json` + `objects/<hash>`，
 *   布局与 SPEC 的 local 后端一致，因此同一个目录既能被本 mock 使用，
 *   也能被真实 local 后端读取，便于做“peer 服务端存储”类测试。
 *
 * 用法：
 *   const peer = await startPeerServer({ token: 't', deviceId: 'abc' })
 *   // peer.url === 'http://127.0.0.1:<port>'（不含协议前缀）
 *   await fetch(`${peer.url}/dsh-sync/v1/ping`)
 *   await peer.close()
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const DEFAULT_MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024
const HASH_RE = /^[a-f0-9]{64}$/
const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function randomHex(bytes = 16) {
  return createHash('sha256')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest('hex')
    .slice(0, bytes * 2)
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(Object.assign(new Error(`request body exceeds ${limit} bytes`), { code: 'E2BIG' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('request aborted')))
  })
}

function normalizePrefix(prefix) {
  if (prefix === undefined || prefix === null) return '/dsh-sync'
  const raw = String(prefix)
  if (raw === '' || raw === '/') return ''
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  return withSlash.replace(/\/+$/, '')
}

/**
 * @param {object} [options]
 * @param {string} [options.token='test-peer-token'] 共享 token。
 * @param {string} [options.deviceId] 本端 deviceId，默认随机 32 hex。
 * @param {string} [options.deviceName='mock-peer'] 本端设备名。
 * @param {string} [options.prefix='/dsh-sync'] 协议挂载前缀（路由为 `${prefix}/v1`）。
 * @param {string|null} [options.storePath=null] 落盘目录；null 表示纯内存。
 * @param {number} [options.maxManifestBytes] manifest 上限，默认 2 MiB。
 * @param {number} [options.maxObjectBytes] 单个对象上限，默认 64 MiB。
 * @param {boolean} [options.verifyObjectHash=true] PUT 对象时校验 sha256。
 * @param {string} [options.host='127.0.0.1'] 监听地址。
 * @param {number} [options.port=0] 监听端口。
 */
export async function startPeerServer(options = {}) {
  const {
    token = 'test-peer-token',
    deviceId = randomHex(16),
    deviceName = 'mock-peer',
    prefix = '/dsh-sync',
    storePath = null,
    maxManifestBytes = DEFAULT_MAX_MANIFEST_BYTES,
    maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES,
    verifyObjectHash = true,
    host = '127.0.0.1',
    port = 0,
  } = options

  const mount = normalizePrefix(prefix)

  /** @type {Map<string, object>} */
  const devices = new Map()
  /** @type {Map<string, Buffer>} */
  const objects = new Map()
  const requests = []
  const warnings = []

  const devicesDir = storePath ? path.join(storePath, 'devices') : null
  const objectsDir = storePath ? path.join(storePath, 'objects') : null

  if (storePath) {
    await fsp.mkdir(devicesDir, { recursive: true, mode: 0o700 })
    await fsp.mkdir(objectsDir, { recursive: true, mode: 0o700 })
    const names = await fsp.readdir(devicesDir).catch(() => [])
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      try {
        const raw = await fsp.readFile(path.join(devicesDir, name), 'utf8')
        devices.set(id, JSON.parse(raw))
      } catch (error) {
        warnings.push(`ignored unreadable manifest ${name}: ${error?.message ?? error}`)
      }
    }
  }

  async function persistManifest(id, manifest) {
    if (!storePath) return
    const file = path.join(devicesDir, `${id}.json`)
    const tmp = path.join(devicesDir, `.${id}.json.tmp-${process.pid}-${randomHex(4)}`)
    await fsp.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(tmp, file)
  }

  async function persistObject(hash, bytes) {
    if (!storePath) return
    const file = path.join(objectsDir, hash)
    if (await fsp.access(file).then(() => true, () => false)) return
    const tmp = path.join(objectsDir, `.${hash}.tmp-${process.pid}-${randomHex(4)}`)
    await fsp.writeFile(tmp, bytes, { mode: 0o600 })
    await fsp.rename(tmp, file)
  }

  async function getObject(hash) {
    if (objects.has(hash)) return objects.get(hash)
    if (!storePath) return null
    try {
      const bytes = await fsp.readFile(path.join(objectsDir, hash))
      objects.set(hash, bytes)
      return bytes
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  function send(req, res, status, body, headers = {}) {
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body)
    requests.push({ method: req.method, path: req.url ?? '', status })
    const outHeaders = { ...headers }
    if (payload !== null) outHeaders['content-length'] = String(payload.length)
    else if (!('content-length' in outHeaders)) outHeaders['content-length'] = '0'
    res.writeHead(status, outHeaders)
    if (req.method === 'HEAD' || payload === null) res.end()
    else res.end(payload)
  }

  function sendJson(req, res, status, value) {
    send(req, res, status, `${JSON.stringify(value)}\n`, {
      'content-type': 'application/json; charset=utf-8',
    })
  }

  function routeOf(pathname) {
    const decoded = decodeSafe(pathname ?? '/')
    const bases = []
    if (mount !== '') bases.push(`${mount}/v1`)
    bases.push('/v1')
    for (const candidate of bases) {
      if (decoded === candidate) return { base: candidate, rest: '' }
      if (decoded.startsWith(`${candidate}/`)) return { base: candidate, rest: decoded.slice(candidate.length + 1) }
    }
    return null
  }

  async function handle(req, res) {
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://mock-peer.local')
    const route = routeOf(url.pathname)

    if (!route) {
      sendJson(req, res, 404, { ok: false, error: 'not found' })
      return
    }
    if (method === 'OPTIONS') {
      send(req, res, 204, null, { allow: 'GET, HEAD, PUT, OPTIONS' })
      return
    }

    const segments = route.rest === '' ? [] : route.rest.split('/')
    const isPing = method === 'GET' && route.rest === 'ping'

    if (!isPing) {
      if (req.headers['x-dsh-sync-token'] !== token) {
        sendJson(req, res, 401, { ok: false, error: 'token 无效' })
        return
      }
    } else {
      sendJson(req, res, 200, {
        ok: true,
        protocol: 1,
        deviceId,
        deviceName,
        requiresToken: true,
      })
      return
    }

    if (method === 'GET' && route.rest === 'devices') {
      sendJson(req, res, 200, { devices: [...devices.keys()].sort() })
      return
    }

    if (segments[0] === 'devices' && segments.length === 2) {
      const id = decodeSafe(segments[1])
      if (!DEVICE_ID_RE.test(id) || id === '.' || id === '..') {
        sendJson(req, res, 400, { ok: false, error: 'invalid deviceId' })
        return
      }
      if (method === 'GET') {
        const manifest = devices.get(id)
        if (!manifest) {
          sendJson(req, res, 404, { ok: false, error: 'manifest not found' })
          return
        }
        sendJson(req, res, 200, manifest)
        return
      }
      if (method === 'PUT') {
        let body
        try {
          body = await readBody(req, maxManifestBytes)
        } catch (error) {
          sendJson(req, res, error?.code === 'E2BIG' ? 413 : 400, {
            ok: false,
            error: error?.message ?? String(error),
          })
          return
        }
        let manifest
        try {
          manifest = JSON.parse(body.toString('utf8'))
        } catch {
          sendJson(req, res, 400, { ok: false, error: 'invalid JSON manifest' })
          return
        }
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
          sendJson(req, res, 400, { ok: false, error: 'manifest must be an object' })
          return
        }
        if (manifest.deviceId && manifest.deviceId !== id) {
          warnings.push(`manifest deviceId ${manifest.deviceId} written under devices/${id}`)
        }
        devices.set(id, manifest)
        await persistManifest(id, manifest)
        sendJson(req, res, 200, { ok: true })
        return
      }
    }

    if (segments[0] === 'objects' && segments.length === 2) {
      const hash = segments[1].toLowerCase()
      if (!HASH_RE.test(hash)) {
        sendJson(req, res, 400, { ok: false, error: 'invalid object hash' })
        return
      }
      if (method === 'HEAD') {
        const bytes = await getObject(hash)
        if (!bytes) {
          send(req, res, 404, null)
          return
        }
        send(req, res, 200, null, {
          'content-length': String(bytes.length),
          'content-type': 'application/octet-stream',
        })
        return
      }
      if (method === 'GET') {
        const bytes = await getObject(hash)
        if (!bytes) {
          sendJson(req, res, 404, { ok: false, error: 'object not found' })
          return
        }
        send(req, res, 200, bytes, { 'content-type': 'application/octet-stream' })
        return
      }
      if (method === 'PUT') {
        let body
        try {
          body = await readBody(req, maxObjectBytes)
        } catch (error) {
          sendJson(req, res, error?.code === 'E2BIG' ? 413 : 400, {
            ok: false,
            error: error?.message ?? String(error),
          })
          return
        }
        if (verifyObjectHash) {
          const actual = sha256Hex(body)
          if (actual !== hash) {
            sendJson(req, res, 400, {
              ok: false,
              error: `object hash mismatch: expected ${hash}, got ${actual}`,
            })
            return
          }
        }
        objects.set(hash, body)
        await persistObject(hash, body)
        sendJson(req, res, 200, { ok: true })
        return
      }
    }

    sendJson(req, res, 405, { ok: false, error: 'method not allowed' })
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(req, res, 500, { ok: false, error: error?.message ?? String(error) })
      } else {
        res.destroy()
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const origin = `http://${host}:${actualPort}`

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  return {
    url: origin,
    origin,
    port: actualPort,
    prefix: mount,
    token,
    deviceId,
    deviceName,
    devices,
    objects,
    requests,
    warnings,
    storePath,
    readManifest: (id) => devices.get(id) ?? null,
    writeManifest(id, manifest) {
      devices.set(id, manifest)
      return persistManifest(id, manifest)
    },
    getObject,
    putObject(hash, bytes) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      objects.set(hash, buf)
      return persistObject(hash, buf)
    },
    close,
  }
}