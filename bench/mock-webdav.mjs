#!/usr/bin/env node
/**
 * bench/mock-webdav.mjs — 可配置延迟/限速的 WebDAV mock（node:http，零依赖）。
 *
 * 给“WebDAV 上传速度”做可复现量化基准：本机无法访问真实 WebDAV，用本地服务替代，
 * 并在 mock 侧统计请求次数、各 Content-Type 收到的字节数与并发峰值（瓶颈证据）。
 *
 * 方法：OPTIONS / MKCOL / HEAD / GET / PUT / PROPFIND(Depth 0/1) / DELETE。
 * 语义：MKCOL 已存在→405、父缺失→409；HEAD/GET/PROPFIND 不存在→404；PUT 原样落盘
 * （不解压，支持 application/gzip）；任意目录（含 objects/）Depth:1 列出真实文件名。
 *
 * 参数：--port --latency <ms> --read-bps --write-bps --store --username --password
 *       --auto-parents；统计端点 GET /__stats
 * 用法：node bench/mock-webdav.mjs --latency 150 --port 8080
 */
import http from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const MAX_BODY_BYTES = 64 * 1024 * 1024
const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND'
/** 请求结束标记：同步递减在飞计数，避免 res 'close' 异步触发导致并发峰值虚高。 */
const DONE = Symbol('bench-request-done')

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
/** URL pathname → 安全路径段数组；`.`/`..`/编码斜杠/NUL 一律拒绝（返回 null）。 */
function decodeSegments(pathname) {
  const out = []
  for (const raw of String(pathname ?? '/').split('/')) {
    if (raw === '') continue
    let segment
    try { segment = decodeURIComponent(raw) } catch { return null }
    if (segment === '' || segment === '.' || segment === '..') return null
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) return null
    out.push(segment)
  }
  return out
}
function hrefFor(segments, isDir) {
  if (segments.length === 0) return '/'
  return `/${segments.map((s) => encodeURIComponent(s)).join('/')}${isDir ? '/' : ''}`
}
/** 合法多状态 XML；nodes: [{segments,isDir,size,mtimeMs}]。 */
function propfindXml(nodes) {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', '<d:multistatus xmlns:d="DAV:">']
  for (const node of nodes) {
    lines.push('<d:response>', `<d:href>${escapeXml(hrefFor(node.segments, node.isDir))}</d:href>`, '<d:propstat>', '<d:prop>')
    if (node.isDir) lines.push('<d:resourcetype><d:collection/></d:resourcetype>')
    else lines.push('<d:resourcetype/>', `<d:getcontentlength>${node.size ?? 0}</d:getcontentlength>`)
    lines.push(`<d:getlastmodified>${new Date(node.mtimeMs ?? Date.now()).toUTCString()}</d:getlastmodified>`)
    lines.push('</d:prop>', '<d:status>HTTP/1.1 200 OK</d:status>', '</d:propstat>', '</d:response>')
  }
  lines.push('</d:multistatus>')
  return lines.join('\n')
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
/**
 * 启动 mock WebDAV。
 * @param {object} [options] latencyMs/port/host/storeDir/username/password/readBps/writeBps/autoParents
 * @returns {Promise<{url,port,storeDir,stats,snapshot,resetStats,close}>}
 */
export async function startMockWebdav(options = {}) {
  const {
    latencyMs = 0, port = 0, host = '127.0.0.1', storeDir: requestedStore,
    username = '', password = '', realm = 'dsh-bench', readBps = 0, writeBps = 0, autoParents = false,
  } = options

  let storeDir
  if (requestedStore) {
    storeDir = path.resolve(requestedStore)
    await fsp.mkdir(storeDir, { recursive: true })
  } else {
    storeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-bench-dav-'))
  }

  const authRequired = !(username === '' && password === '')
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
  const counters = {
    inflight: 0, maxInflight: 0, total: 0, methods: {}, statuses: {},
    bytesIn: 0, bytesInByType: {}, bytesOut: 0,
  }
  const snapshot = () => JSON.parse(JSON.stringify(counters))
  function resetStats() {
    Object.assign(counters, {
      inflight: 0, maxInflight: 0, total: 0, methods: {}, statuses: {},
      bytesIn: 0, bytesInByType: {}, bytesOut: 0,
    })
  }
  const absPath = (segments) => path.join(storeDir, ...segments)

  async function statPath(segments) {
    try {
      return await fsp.stat(absPath(segments))
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
      throw error
    }
  }

  function send(req, res, status, body, headers = {}) {
    const method = (req.method ?? 'GET').toUpperCase()
    const payload = body === undefined || body === null
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    counters.statuses[status] = (counters.statuses[status] ?? 0) + 1
    if (payload) counters.bytesOut += payload.length
    const out = { ...headers }
    if (payload) out['content-length'] = String(payload.length)
    else if (!('content-length' in out)) out['content-length'] = '0'
    res.writeHead(status, out)
    if (method === 'HEAD' || payload === null) res.end()
    else res.end(payload)
    res[DONE]?.()
  }

  async function handle(req, res) {
    const method = (req.method ?? 'GET').toUpperCase()
    const url = new URL(req.url ?? '/', 'http://mock.local')
    const segments = decodeSegments(url.pathname)

    if (method === 'OPTIONS') {
      send(req, res, 200, null, { dav: '1,2', allow: ALLOW })
      return
    }
    if (authRequired && req.headers.authorization !== expectedAuth) {
      send(req, res, 401, 'Unauthorized', {
        'www-authenticate': `Basic realm="${realm}"`,
        'content-type': 'text/plain; charset=utf-8',
      })
      return
    }
    if (segments === null) {
      send(req, res, 400, 'bad path', { 'content-type': 'text/plain; charset=utf-8' })
      return
    }
    if (latencyMs > 0) await sleep(latencyMs)

    if (method === 'PROPFIND') {
      const st = await statPath(segments)
      if (!st) {
        send(req, res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      const depth = String(req.headers.depth ?? '1').toLowerCase()
      const nodes = []
      if (!st.isDirectory()) {
        nodes.push({ segments, isDir: false, size: st.size, mtimeMs: st.mtimeMs })
      } else {
        nodes.push({ segments, isDir: true, mtimeMs: st.mtimeMs })
        if (depth !== '0') {
          const entries = await fsp.readdir(absPath(segments), { withFileTypes: true })
          for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
            if (entry.name === '.' || entry.name === '..') continue
            const child = [...segments, entry.name]
            const childStat = await statPath(child)
            if (!childStat) continue
            nodes.push({
              segments: child, isDir: childStat.isDirectory(),
              size: childStat.size, mtimeMs: childStat.mtimeMs,
            })
          }
        }
      }
      send(req, res, 207, propfindXml(nodes), { 'content-type': 'application/xml; charset=utf-8' })
      return
    }

    if (method === 'MKCOL') {
      if (segments.length === 0) {
        send(req, res, 405, 'cannot create service root', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      if (await statPath(segments)) {
        send(req, res, 405, 'already exists', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      const parentStat = await statPath(segments.slice(0, -1))
      if (!parentStat || !parentStat.isDirectory()) {
        send(req, res, 409, 'parent collection missing', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      await fsp.mkdir(absPath(segments))
      send(req, res, 201, null)
      return
    }

    if (method === 'PUT') {
      if (segments.length === 0) {
        send(req, res, 405, 'cannot PUT a collection', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      let body
      try {
        body = await readBody(req, MAX_BODY_BYTES)
      } catch (error) {
        send(req, res, error?.code === 'E2BIG' ? 413 : 400, error.message, {
          'content-type': 'text/plain; charset=utf-8',
        })
        return
      }
      // 按 Content-Type 记录收到的字节：用于比较压缩前/后实际上传量。
      const contentType = String(req.headers['content-type'] ?? 'application/octet-stream')
      counters.bytesIn += body.length
      counters.bytesInByType[contentType] = (counters.bytesInByType[contentType] ?? 0) + body.length
      const existing = await statPath(segments)
      if (existing && existing.isDirectory()) {
        send(req, res, 405, 'cannot PUT a collection', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      const parentSegments = segments.slice(0, -1)
      const parentStat = await statPath(parentSegments)
      if (!parentStat || !parentStat.isDirectory()) {
        if (!autoParents) {
          send(req, res, 409, 'parent collection missing', { 'content-type': 'text/plain; charset=utf-8' })
          return
        }
        await fsp.mkdir(absPath(parentSegments), { recursive: true })
      }
      if (writeBps > 0) await sleep((body.length / writeBps) * 1000)
      const abs = absPath(segments)
      const tmp = `${abs}.upload-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
      await fsp.writeFile(tmp, body)
      await fsp.rename(tmp, abs)
      send(req, res, existing ? 204 : 201, null)
      return
    }

    if (method === 'HEAD') {
      const st = await statPath(segments)
      if (!st) {
        send(req, res, 404, null, { 'content-length': '0' })
        return
      }
      if (st.isDirectory()) {
        send(req, res, 200, null, { 'content-length': '0' })
        return
      }
      send(req, res, 200, null, {
        'content-length': String(st.size),
        'content-type': 'application/octet-stream',
        'last-modified': st.mtime.toUTCString(),
      })
      return
    }

    if (method === 'GET') {
      const st = await statPath(segments)
      if (!st) {
        send(req, res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      if (st.isDirectory()) {
        const entries = (await fsp.readdir(absPath(segments))).sort()
        send(req, res, 200, entries.join('\n'), { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      const bytes = await fsp.readFile(absPath(segments))
      if (readBps > 0) await sleep((bytes.length / readBps) * 1000)
      send(req, res, 200, bytes, {
        'content-type': 'application/octet-stream',
        'last-modified': st.mtime.toUTCString(),
      })
      return
    }

    if (method === 'DELETE') {
      if (segments.length === 0) {
        send(req, res, 405, 'cannot delete service root', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      const st = await statPath(segments)
      if (!st) {
        send(req, res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' })
        return
      }
      if (st.isDirectory()) await fsp.rm(absPath(segments), { recursive: true, force: true })
      else await fsp.unlink(absPath(segments))
      send(req, res, 204, null)
      return
    }

    send(req, res, 405, 'method not allowed', {
      allow: ALLOW, 'content-type': 'text/plain; charset=utf-8',
    })
  }

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (url === '/__stats' || url.startsWith('/__stats?')) {
      const payload = Buffer.from(JSON.stringify(snapshot()))
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(payload.length) })
      res.end(payload)
      return
    }
    const method = (req.method ?? 'GET').toUpperCase()
    counters.total += 1
    counters.methods[method] = (counters.methods[method] ?? 0) + 1
    counters.inflight += 1
    if (counters.inflight > counters.maxInflight) counters.maxInflight = counters.inflight
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      counters.inflight -= 1
    }
    res[DONE] = done
    res.on('close', done)
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        send(req, res, 500, error?.stack ?? String(error), { 'content-type': 'text/plain; charset=utf-8' })
      } else {
        res.destroy()
        done()
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
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    storeDir,
    stats: counters,
    snapshot,
    resetStats,
    close,
  }
}
/* CLI：独立起一个 mock，供手工 / 外部脚本压测 */
async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' }, latency: { type: 'string', default: '0' },
      'read-bps': { type: 'string', default: '0' }, 'write-bps': { type: 'string', default: '0' },
      store: { type: 'string' }, 'auto-parents': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const num = (name, raw) => {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--${name} 必须是非负数：${raw}`)
    return parsed
  }
  const dav = await startMockWebdav({
    port: num('port', values.port), latencyMs: num('latency', values.latency),
    readBps: num('read-bps', values['read-bps']), writeBps: num('write-bps', values['write-bps']),
    storeDir: values.store, autoParents: values['auto-parents'],
  })
  console.log(`mock WebDAV listening on ${dav.url}\nstore: ${dav.storeDir}\nstats: ${dav.url}/__stats`)
  const shutdown = async () => { await dav.close(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(`mock-webdav 启动失败：${error?.message ?? error}`)
    process.exit(1)
  })
}