/**
 * /dsh-sync HTTP 路由。
 *
 * 同一前缀下两套接口：
 * - `/dsh-sync/api/*`  设置页使用（同源 + x-dsh-sync-ui-token 鉴权）；
 * - `/dsh-sync/v1/*`   对等设备协议（要求 x-dsh-sync-token，token 来自 config.peerToken）。
 *
 * 路由由 webServer 服务托管，不新增监听端口；因此 Web / DAV / peer 三种模式
 * 共用同一个 DSH 实例的 Web 入口。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createBackend } from './backends/index.js'
import { normalizeManifest } from './engine/manifest.js'
import { decodePairing, encodePairing, pairingSummary, selfPeerPairing } from './pair.js'

/** JSON 请求体上限。 */
const JSON_LIMIT = 2 * 1024 * 1024
/** 归档导入上限（压缩后）。 */
const IMPORT_LIMIT = 256 * 1024 * 1024
/** 单个对象上限（与 maxFileBytes 解耦，允许略大）。 */
const OBJECT_LIMIT = 512 * 1024 * 1024

/** 发送 JSON。 */
function sendJson(res, statusCode, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', String(body.byteLength))
  res.end(body)
}

/** 发送错误 JSON。 */
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: String(message) })
}

/** 读取请求体（带硬上限）。 */
async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > limit) {
    const error = new Error(`请求体超过上限（${limit} 字节）`)
    error.statusCode = 413
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error(`请求体超过上限（${limit} 字节）`)
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 读取 JSON 体。 */
async function readJson(req, limit = JSON_LIMIT) {
  const buffer = await readBody(req, limit)
  if (buffer.length === 0) return {}
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.statusCode = 400
    throw error
  }
}

/** 同源校验：有 Origin 时必须与 Host 一致。 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 提取设置页 UI token：只接受请求头，避免令牌出现在 URL/日志/历史里。 */
function uiTokenOf(req) {
  const header = req.headers['x-dsh-sync-ui-token']
  return typeof header === 'string' ? header : ''
}

/** 提取 peer token。 */
function peerTokenOf(req) {
  const header = req.headers['x-dsh-sync-token']
  if (typeof header === 'string' && header.length > 0) return header
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7)
  }
  return ''
}

/** 常量时间比较。 */
function tokenEquals(expected, actual) {
  if (!expected || !actual) return false
  const a = Buffer.from(String(expected))
  const b = Buffer.from(String(actual))
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 校验 deviceId / hash。 */
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/
const HASH_RE = /^[a-f0-9]{64}$/

/**
 * 挂载路由。
 * @param {object} webServer webServer 服务
 * @param {object} deps { engine, store, logger }
 * @returns {() => void} disposer
 */
export function attachRoutes(webServer, deps) {
  const { engine, store, logger = console } = deps
  let peerBackend = null
  let peerBackendPath = null

  /** 对等协议落盘用的本地后端。 */
  async function getPeerBackend() {
    const target = {
      id: 'peer-server',
      type: 'local',
      label: 'peer server',
      enabled: true,
      path: store.config.peerStorePath,
    }
    if (peerBackend === null || peerBackendPath !== target.path) {
      try {
        await peerBackend?.close?.()
      } catch {}
      peerBackend = await createBackend(target, { logger })
      await peerBackend.init()
      peerBackendPath = target.path
    }
    return peerBackend
  }

  async function handlePeer(req, res, pathname) {
    // ping 不需要 token，方便另一台设备先探测协议与设备名。
    if (req.method === 'GET' && pathname === '/dsh-sync/v1/ping') {
      sendJson(res, 200, {
        ok: true,
        protocol: 1,
        deviceId: store.deviceId,
        deviceName: store.config.deviceName,
        requiresToken: true,
      })
      return
    }

    if (!tokenEquals(store.config.peerToken, peerTokenOf(req))) {
      sendError(res, 401, '配对令牌无效')
      return
    }

    const backend = await getPeerBackend()

    if (pathname === '/dsh-sync/v1/devices') {
      if (req.method !== 'GET') {
        sendError(res, 405, 'method not allowed')
        return
      }
      const devices = await backend.listDevices()
      sendJson(res, 200, { ok: true, devices })
      return
    }

    // 对象清单：对端用它一次建立对象索引，避免逐对象 HEAD（上传/拉取各省一次往返）。
    if (pathname === '/dsh-sync/v1/objects') {
      if (req.method !== 'GET') {
        sendError(res, 405, 'method not allowed')
        return
      }
      if (typeof backend.listObjects !== 'function') {
        sendError(res, 501, '当前对端不支持对象清单')
        return
      }
      const all = await backend.listObjects()
      // 上限保护：超大对象库只回前 50000 条，对端会回退为逐对象探测。
      const limit = 50_000
      const hashes = all.length > limit ? all.slice(0, limit) : all
      sendJson(res, 200, {
        ok: true,
        total: all.length,
        truncated: all.length > limit,
        hashes,
      })
      return
    }

    const deviceMatch = /^\/dsh-sync\/v1\/devices\/([A-Za-z0-9_-]{6,64})$/.exec(pathname)
    if (deviceMatch) {
      const deviceId = deviceMatch[1]
      if (!DEVICE_ID_RE.test(deviceId)) {
        sendError(res, 400, 'deviceId 非法')
        return
      }
      if (req.method === 'GET') {
        const manifest = await backend.readManifest(deviceId)
        if (manifest === null) {
          sendError(res, 404, 'not found')
          return
        }
        sendJson(res, 200, manifest)
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req, JSON_LIMIT)
        const normalized = normalizeManifest(body)
        if (normalized === null) {
          sendError(res, 400, 'manifest 无效')
          return
        }
        await backend.writeManifest(deviceId, body)
        sendJson(res, 200, { ok: true })
        return
      }
      sendError(res, 405, 'method not allowed')
      return
    }

    const objectMatch = /^\/dsh-sync\/v1\/objects\/([a-f0-9]{64})$/.exec(pathname)
    if (objectMatch) {
      const hash = objectMatch[1]
      if (!HASH_RE.test(hash)) {
        sendError(res, 400, 'hash 非法')
        return
      }
      if (req.method === 'HEAD') {
        const exists = await backend.hasObject(hash)
        res.statusCode = exists ? 200 : 404
        res.setHeader('Cache-Control', 'no-store')
        res.end()
        return
      }
      if (req.method === 'GET') {
        const bytes = await backend.readObject(hash)
        if (bytes === null) {
          sendError(res, 404, 'not found')
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', String(bytes.byteLength))
        res.setHeader('Cache-Control', 'no-store')
        res.end(Buffer.from(bytes))
        return
      }
      if (req.method === 'PUT') {
        const bytes = await readBody(req, OBJECT_LIMIT)
        const actual = createHash('sha256').update(bytes).digest('hex')
        if (actual !== hash) {
          sendError(res, 400, '对象内容与 hash 不匹配')
          return
        }
        await backend.writeObject(hash, bytes)
        sendJson(res, 200, { ok: true })
        return
      }
      sendError(res, 405, 'method not allowed')
      return
    }

    sendError(res, 404, 'unknown peer route')
  }

  async function handleUi(req, res, pathname) {
    if (!isSameOrigin(req)) {
      sendError(res, 403, '跨源请求被拒绝')
      return
    }
    // webServer 的自定义路由不经过 DSH 浏览器鉴权：设置页 API 必须自带会话令牌。
    // 令牌只注入到受鉴权保护的 index 页面（见 attachRoutes 里的 tapIndex）。
    if (!tokenEquals(store.uiToken, uiTokenOf(req))) {
      sendError(res, 401, '设置页会话令牌无效，请刷新页面')
      return
    }

    if (pathname === '/dsh-sync/api/status' && req.method === 'GET') {
      sendJson(res, 200, await engine.status())
      return
    }

    if (pathname === '/dsh-sync/api/pair/code' && req.method === 'GET') {
      let targetId = ''
      try {
        targetId = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('targetId') ?? ''
      } catch {
        targetId = ''
      }
      if (targetId) {
        const target = (engine.config.targets ?? []).find((item) => item.id === targetId)
        if (!target || target.type === 'local') {
          sendError(res, 400, '该 target 不支持配对码')
          return
        }
        if (!/^https?:\/\/[^\s]+$/i.test(String(target.url ?? '').trim())) {
          sendError(res, 400, '该 target 还没有有效地址，请先填写并保存')
          return
        }
        if (target.type === 'peer' && String(target.token ?? '').trim().length < 8) {
          sendError(res, 400, '该 peer target 还没有有效 Token')
          return
        }
        const payload = target.type === 'peer'
          ? { v: 1, type: 'peer', url: target.url, token: target.token, label: target.label, deviceName: engine.config.deviceName }
          : {
              v: 1,
              type: 'webdav',
              url: target.url,
              username: target.username ?? '',
              password: target.password ?? '',
              basePath: target.basePath ?? '/dsh-sync',
              label: target.label,
              deviceName: engine.config.deviceName,
            }
        sendJson(res, 200, { ok: true, code: encodePairing(payload), summary: pairingSummary(payload), warning: '' })
        return
      }
      const self = selfPeerPairing({
        origin: webServer.getOrigin(),
        token: engine.config.peerToken,
        deviceName: engine.config.deviceName,
      })
      sendJson(res, 200, { ok: true, code: encodePairing(self.payload), summary: pairingSummary(self.payload), warning: self.warning })
      return
    }

    if (pathname === '/dsh-sync/api/pair' && req.method === 'POST') {
      const body = await readJson(req)
      let data
      try {
        data = decodePairing(body?.code)
      } catch (error) {
        sendError(res, 400, '配对码无效：' + (error?.message ?? '解析失败'))
        return
      }
      const result = await engine.applyPairPayload(data, { sync: body?.sync !== false })
      sendJson(res, 200, {
        ok: true,
        target: { id: result.target.id, type: result.target.type, label: result.target.label },
        warnings: result.warnings,
        test: result.test,
        report: result.report,
        error: result.error,
        status: await engine.status(),
      })
      return
    }

    if (pathname === '/dsh-sync/api/connect' && req.method === 'POST') {
      const body = await readJson(req)
      let result
      try {
        result = await engine.applyPairPayload(body ?? {}, { sync: body?.sync !== false })
      } catch (error) {
        sendError(res, 400, error?.message ?? '连接配置无效')
        return
      }
      sendJson(res, 200, {
        ok: true,
        target: { id: result.target.id, type: result.target.type, label: result.target.label },
        warnings: result.warnings,
        test: result.test,
        report: result.report,
        error: result.error,
        status: await engine.status(),
      })
      return
    }

    if (pathname === '/dsh-sync/api/config' && req.method === 'POST') {
      const body = await readJson(req)
      const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body
      const result = await engine.updateConfig(patch)
      engine.restartAutomation()
      sendJson(res, 200, { ok: true, warnings: result.warnings, status: await engine.status() })
      return
    }

    if (pathname === '/dsh-sync/api/sync' && req.method === 'POST') {
      const body = await readJson(req)
      const report = await engine.sync({
        mode: body?.mode,
        targetId: body?.targetId,
        trigger: 'manual',
      })
      sendJson(res, 200, report)
      return
    }

    if (pathname === '/dsh-sync/api/test' && req.method === 'POST') {
      const body = await readJson(req)
      const result = await engine.testTarget(body?.target)
      sendJson(res, 200, result)
      return
    }

    if (pathname === '/dsh-sync/api/export' && req.method === 'POST') {
      // scope=full：把 DSH 工作区与对话（会话）一起打进同一个归档。
      let scope = 'roots'
      try {
        const body = await readBody(req, 64 * 1024)
        if (body.length > 0) {
          const parsed = JSON.parse(body.toString('utf8'))
          if (parsed && parsed.scope === 'full') scope = 'full'
        }
      } catch {
        scope = 'roots'
      }
      const result = await engine.exportArchive({ scope })
      sendJson(res, 200, {
        ...result,
        url: `/dsh-sync/api/download/${encodeURIComponent(result.name)}`,
      })
      return
    }

    if (pathname === '/dsh-sync/api/import' && req.method === 'POST') {
      const buffer = await readBody(req, IMPORT_LIMIT)
      const name = String(req.headers['x-filename'] ?? 'import.dshsync').slice(0, 200)
      const report = await engine.importArchive({ bytes: buffer, name })
      sendJson(res, 200, { ok: report.ok, report })
      return
    }

    if (pathname === '/dsh-sync/api/logs' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        logs: store.state.logs.slice(-200),
        conflicts: store.state.conflicts.slice(-100),
      })
      return
    }

    if (pathname.startsWith('/dsh-sync/api/download/') && req.method === 'GET') {
      let name
      try {
        name = decodeURIComponent(pathname.slice('/dsh-sync/api/download/'.length))
      } catch {
        sendError(res, 400, '文件名非法')
        return
      }
      // 只允许直接位于 exports 目录的普通文件名：拒绝任何路径分隔符。
      if (name.length === 0 || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
        sendError(res, 400, '文件名非法')
        return
      }
      const file = path.join(store.exportsDir, name)
      let bytes
      try {
        bytes = await fsp.readFile(file)
      } catch {
        sendError(res, 404, '归档不存在')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/gzip')
      res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"`)
      res.setHeader('Content-Length', String(bytes.byteLength))
      res.setHeader('Cache-Control', 'no-store')
      res.end(bytes)
      return
    }

    sendError(res, 404, 'unknown api route')
  }

  // 把 UI token 注入 index：该页面本身受 DSH 浏览器鉴权保护，未登录者拿不到 token。
  let disposeTap = null
  if (typeof webServer.tapIndex === 'function') {
    disposeTap = webServer.tapIndex((html) => {
      const token = store.uiToken
      if (!token || html.includes('name="dsh-sync-ui-token"')) return html
      const meta = `<meta name="dsh-sync-ui-token" content="${token}">`
      return html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : `${meta}${html}`
    })
  }

  const dispose = webServer.register({
    kind: 'prefix',
    path: '/dsh-sync',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const pathname = url.pathname
      try {
        if (pathname.startsWith('/dsh-sync/v1/')) {
          await handlePeer(req, res, pathname)
        } else {
          await handleUi(req, res, pathname)
        }
      } catch (error) {
        const statusCode = Number(error?.statusCode) || 500
        try {
          sendError(res, statusCode, error?.message ?? String(error))
        } catch {}
        logger.warn?.(`[dsh-sync] HTTP 处理失败 ${pathname}：${error?.message ?? error}`)
      }
    },
  })

  return () => {
    dispose()
    disposeTap?.()
    Promise.resolve(peerBackend?.close?.()).catch(() => {})
    peerBackend = null
    peerBackendPath = null
  }
}