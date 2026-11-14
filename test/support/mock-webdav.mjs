/**
 * 真实 `node:http` WebDAV mock（测试专用，无第三方依赖）。
 *
 * 覆盖 SPEC 第 5 节 webdav 后端会用到的全部方法：
 *   PUT / GET / HEAD / MKCOL / PROPFIND / OPTIONS / DELETE
 *
 * 特性：
 * - Basic Auth 校验（username/password 都为空时视为免认证）。
 * - 内存文件树（Map），支持任意 basePath（默认 `/dsh-sync`），
 *   同时预创建 basePath 的祖先集合，方便测试“挂载在子路径”的部署形态。
 * - PROPFIND 支持 Depth: 0 / 1，返回 `<d:multistatus>` XML。
 * - 记录每一次请求（method/path/status），供断言与排障。
 *
 * 用法：
 *   const dav = await startMockWebdav({ username: 'u', password: 'p' })
 *   // dav.url === 'http://127.0.0.1:<port>'
 *   await dav.close()
 *
 * 说明：`files` 是活的 Map<urlPath, Buffer>，外部可直接读写以模拟“远端被别的设备改了”；
 * 更推荐用 `writeFile()` / `removeFile()`，它们会同步维护 mtime。
 */

import http from 'node:http'

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024

/** 去掉尾部斜杠；`/` 归一成空串（空串代表服务根集合）。 */
function normalizeBase(basePath) {
  if (basePath === undefined || basePath === null) return '/dsh-sync'
  const raw = String(basePath)
  if (raw === '' || raw === '/') return ''
  let base = raw.startsWith('/') ? raw : `/${raw}`
  base = base.replace(/\/+$/, '')
  return base
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return pathname
  }
}

/** 请求 pathname → 规范化 key（无尾斜杠；根集合为空串）。 */
function normalizeKey(pathname) {
  const decoded = decodePathname(pathname ?? '/')
  const trimmed = decoded.replace(/\/+$/, '')
  return trimmed === '' || trimmed === '/' ? '' : trimmed
}

function parentKey(key) {
  if (key === '' || key === '/') return ''
  const idx = key.lastIndexOf('/')
  return idx <= 0 ? '' : key.slice(0, idx)
}

function isUnder(key, base) {
  if (base === '') return key.startsWith('/') || key === ''
  return key === base || key.startsWith(`${base}/`)
}

function hrefFor(key, isDir) {
  if (key === '') return '/'
  return `${encodeURI(key)}${isDir ? '/' : ''}`
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

function propfindXml(key, nodes) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<d:multistatus xmlns:d="DAV:">',
  ]
  for (const node of nodes) {
    lines.push('<d:response>')
    lines.push(`<d:href>${escapeXml(hrefFor(node.key, node.isDir))}</d:href>`)
    lines.push('<d:propstat>')
    lines.push('<d:prop>')
    if (node.isDir) {
      lines.push('<d:resourcetype><d:collection/></d:resourcetype>')
    } else {
      lines.push('<d:resourcetype/>')
      lines.push(`<d:getcontentlength>${node.size ?? 0}</d:getcontentlength>`)
      lines.push(`<d:getlastmodified>${new Date(node.mtimeMs ?? Date.now()).toUTCString()}</d:getlastmodified>`)
    }
    lines.push('</d:prop>')
    lines.push('<d:status>HTTP/1.1 200 OK</d:status>')
    lines.push('</d:propstat>')
    lines.push('</d:response>')
  }
  lines.push('</d:multistatus>')
  return lines.join('\n')
}

/**
 * 启动 mock WebDAV 服务。
 *
 * @param {object} [options]
 * @param {string} [options.basePath='/dsh-sync'] 挂载路径；`/` 表示服务根。
 * @param {string} [options.username='dsh'] Basic Auth 用户名；与 password 都为空则免认证。
 * @param {string} [options.password='secret'] Basic Auth 密码。
 * @param {string} [options.realm='dsh-sync-test'] 401 的 realm。
 * @param {number} [options.maxBodyBytes] 单请求体上限，默认 64 MiB。
 * @param {boolean} [options.autoCreateParents=true] PUT 时自动补建父集合（并记 warning）。
 * @param {string} [options.host='127.0.0.1'] 监听地址。
 * @param {number} [options.port=0] 监听端口；0 由系统分配。
 * @returns {Promise<{url:string,port:number,basePath:string,files:Map<string,Buffer>,dirs:Set<string>,
 *   requests:Array<{method:string,path:string,status:number}>,warnings:string[],
 *   writeFile:Function,removeFile:Function,readFile:Function,listFiles:Function,
 *   davPath:Function,close:Function}>}
 */
export async function startMockWebdav(options = {}) {
  const {
    basePath = '/dsh-sync',
    username = 'dsh',
    password = 'secret',
    realm = 'dsh-sync-test',
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    autoCreateParents = true,
    // 已存在集合时 MKCOL 的状态码：RFC 是 405，123pan 实测 423 Locked。
    mkcolExistingStatus = 405,
    host = '127.0.0.1',
    port = 0,
  } = options

  const base = normalizeBase(basePath)
  const authRequired = !(username === '' && password === '')
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`

  /** @type {Map<string, Buffer>} */
  const files = new Map()
  /** @type {Map<string, number>} */
  const mtimes = new Map()
  /** @type {Set<string>} */
  const dirs = new Set([''])
  /** @type {Array<{method:string,path:string,status:number}>} */
  const requests = []
  const warnings = []

  // 预创建 basePath 及其祖先，允许“挂载在 /remote.php/dav/files/u 之下”的部署形态。
  if (base !== '') {
    const parts = base.split('/').filter(Boolean)
    let cursor = ''
    for (const part of parts) {
      cursor += `/${part}`
      dirs.add(cursor)
    }
  }

  function ensureParentDir(key) {
    const parent = parentKey(key)
    if (parent === '' || dirs.has(parent)) return
    if (!autoCreateParents) return
    const missing = []
    let cursor = parent
    while (cursor !== '' && !dirs.has(cursor)) {
      missing.push(cursor)
      cursor = parentKey(cursor)
    }
    for (const dir of missing.reverse()) {
      dirs.add(dir)
      warnings.push(`auto-created missing collection ${dir}`)
    }
  }

  function directChildren(key) {
    const out = []
    for (const dir of dirs) {
      if (dir !== key && parentKey(dir) === key) out.push({ key: dir, isDir: true })
    }
    for (const [file, bytes] of files) {
      if (parentKey(file) === key) {
        out.push({ key: file, isDir: false, size: bytes.length, mtimeMs: mtimes.get(file) })
      }
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  }

  function send(req, res, status, body, headers = {}) {
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body)
    requests.push({ method: req.method, path: req.url ?? '', status })
    const outHeaders = { ...headers }
    if (payload) outHeaders['content-length'] = String(payload.length)
    else if (!('content-length' in outHeaders)) outHeaders['content-length'] = '0'
    res.writeHead(status, outHeaders)
    if (req.method === 'HEAD' || payload === null) {
      res.end()
    } else {
      res.end(payload)
    }
  }

  function unauthorized(req, res) {
    send(req, res, 401, 'Unauthorized', {
      'www-authenticate': `Basic realm="${realm}"`,
      'content-type': 'text/plain; charset=utf-8',
    })
  }

  async function handle(req, res) {
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://mock.local')
    const key = normalizeKey(url.pathname)

    if (method === 'OPTIONS') {
      send(req, res, 200, null, {
        dav: '1,2',
        allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND',
      })
      return
    }

    if (authRequired && req.headers.authorization !== expectedAuth) {
      unauthorized(req, res)
      return
    }

    if (!isUnder(key, base)) {
      send(req, res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' })
      return
    }

    if (method === 'PROPFIND') {
      const exists = dirs.has(key) || files.has(key)
      if (!exists) {
        send(req, res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      const depth = String(req.headers.depth ?? '0').toLowerCase()
      const nodes = []
      if (dirs.has(key)) {
        nodes.push({ key, isDir: true })
        if (depth !== '0') nodes.push(...directChildren(key))
      } else {
        nodes.push({ key, isDir: false, size: files.get(key).length, mtimeMs: mtimes.get(key) })
      }
      send(req, res, 207, propfindXml(key, nodes), {
        'content-type': 'application/xml; charset=utf-8',
      })
      return
    }

    if (method === 'MKCOL') {
      if (key === '') {
        send(req, res, 405, 'cannot create service root', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      if (dirs.has(key) || files.has(key)) {
        send(req, res, mkcolExistingStatus, 'already exists', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      const parent = parentKey(key)
      if (parent !== '' && !dirs.has(parent)) {
        send(req, res, 409, 'parent collection missing', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      dirs.add(key)
      send(req, res, 201, null)
      return
    }

    if (method === 'PUT') {
      if (key === '' || dirs.has(key)) {
        send(req, res, 405, 'cannot PUT a collection', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      let body
      try {
        body = await readBody(req, maxBodyBytes)
      } catch (error) {
        send(req, res, error?.code === 'E2BIG' ? 413 : 400, error.message, {
          'content-type': 'text/plain; charset=utf-8',
        })
        return
      }
      ensureParentDir(key)
      const created = !files.has(key)
      files.set(key, body)
      mtimes.set(key, Date.now())
      send(req, res, created ? 201 : 204, null)
      return
    }

    if (method === 'HEAD') {
      if (files.has(key)) {
        const bytes = files.get(key)
        send(req, res, 200, null, {
          'content-length': String(bytes.length),
          'content-type': 'application/octet-stream',
          'last-modified': new Date(mtimes.get(key) ?? Date.now()).toUTCString(),
        })
        return
      }
      if (dirs.has(key)) {
        send(req, res, 200, null, { 'content-length': '0' })
        return
      }
      send(req, res, 404, null, { 'content-length': '0' })
      return
    }

    if (method === 'GET') {
      if (files.has(key)) {
        send(req, res, 200, files.get(key), {
          'content-type': 'application/octet-stream',
          'last-modified': new Date(mtimes.get(key) ?? Date.now()).toUTCString(),
        })
        return
      }
      if (dirs.has(key)) {
        const listing = directChildren(key).map((node) => node.key).join('\n')
        send(req, res, 200, listing, { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      send(req, res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' })
      return
    }

    if (method === 'DELETE') {
      if (files.has(key)) {
        files.delete(key)
        mtimes.delete(key)
        send(req, res, 204, null)
        return
      }
      if (dirs.has(key) && key !== '') {
        for (const file of [...files.keys()]) {
          if (file === key || file.startsWith(`${key}/`)) {
            files.delete(file)
            mtimes.delete(file)
          }
        }
        for (const dir of [...dirs]) {
          if (dir === key || dir.startsWith(`${key}/`)) dirs.delete(dir)
        }
        send(req, res, 204, null)
        return
      }
      send(req, res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' })
      return
    }

    send(req, res, 405, 'method not allowed', {
      allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND',
      'content-type': 'text/plain; charset=utf-8',
    })
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        send(req, res, 500, error?.stack ?? String(error), {
          'content-type': 'text/plain; charset=utf-8',
        })
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

  /** basePath 相对 URL → 存储 key。 */
  function davPath(relative = '') {
    const rel = String(relative).replace(/^\/+/, '')
    if (rel === '') return base
    return `${base}/${rel}`.replace(/\/+$/, '')
  }

  return {
    url: origin,
    origin,
    port: actualPort,
    basePath: base,
    files,
    mtimes,
    dirs,
    requests,
    warnings,
    davPath,
    writeFile(urlPath, bytes) {
      const key = normalizeKey(urlPath)
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      files.set(key, buf)
      mtimes.set(key, Date.now())
      ensureParentDir(key)
      return key
    },
    removeFile(urlPath) {
      const key = normalizeKey(urlPath)
      files.delete(key)
      mtimes.delete(key)
      return key
    },
    readFile(urlPath) {
      return files.get(normalizeKey(urlPath)) ?? null
    },
    listFiles() {
      return [...files.keys()].sort()
    },
    close,
  }
}

/** 便捷函数：把 mock 的 basePath 相对路径拼成绝对 URL。 */
export function joinUrl(origin, basePath, relative = '') {
  const base = normalizeBase(basePath)
  const rel = String(relative).replace(/^\/+/, '')
  if (rel === '') return `${origin}${base}`
  return `${origin}${base}/${rel}`
}