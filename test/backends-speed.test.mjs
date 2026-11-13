/**
 * 上传加速专项测试：对象索引、gzip 传输、回退路径、并发去重、旧对象兼容。
 *
 * 这些用例只关心“请求次数与字节数”，不重复 e2e 的数据正确性覆盖：
 * - WebDAV：索引可用时每对象 0 次 HEAD + 1 次 PUT；索引不可用回退 1 次 HEAD；
 *   同 hash 并发只发一次 PUT；`.z` 读回还原原始字节；旧 raw 对象仍可读。
 * - Peer：对象清单端点存在时 0 次 HEAD；清单被截断或端点缺失时回退 HEAD。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createWebdavBackend } from '../lib/backends/webdav.js'
import { createPeerBackend } from '../lib/backends/peer.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const REPEATABLE = Buffer.from('{"role":"user","content":"dsh-sync 上传加速"}\n'.repeat(200), 'utf8')

/** 极简 WebDAV 假服务器：够 lib/backends/webdav.js 用，不追求协议完备。 */
function makeDav({ propfindObjects = 'ok' } = {}) {
  const files = new Map() // path -> Buffer
  const dirs = new Set(['/dav/sync/a', '/dav/sync/a/devices', '/dav/sync/a/objects'])
  const requests = []
  const base = '/dav/sync/a'

  function listObjectsXml() {
    const items = [...files.keys()].filter((path) => path.startsWith(`${base}/objects/`))
    const hrefs = [`${base}/objects/`]
      .concat(items.map((path) => path.slice(`${base}/objects/`.length)))
      .map((name) => `<d:response><d:href>${base}/objects/${name}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${hrefs.join('')}</d:multistatus>`
  }

  function listDevicesXml() {
    const hrefs = [`${base}/devices/`]
      .concat([...files.keys()].filter((path) => path.startsWith(`${base}/devices/`)).map((path) => path.slice(`${base}/devices/`.length)))
      .map((name) => `<d:response><d:href>${base}/devices/${name}</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)
    return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${hrefs.join('')}</d:multistatus>`
  }

  async function fetchImpl(url, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(url)
    requests.push({ method, pathname })
    if (method === 'MKCOL') {
      if (dirs.has(pathname)) return new Response(null, { status: 405 })
      dirs.add(pathname)
      return new Response(null, { status: 201 })
    }
    if (method === 'PROPFIND') {
      if (pathname === `${base}/objects/`) {
        if (propfindObjects !== 'ok') return new Response('nope', { status: propfindObjects })
        return new Response(listObjectsXml(), { status: 207 })
      }
      if (pathname === `${base}/devices/`) return new Response(listDevicesXml(), { status: 207 })
      return new Response(null, { status: 404 })
    }
    if (method === 'HEAD') {
      return new Response(null, { status: files.has(pathname) ? 200 : 404 })
    }
    if (method === 'GET') {
      const data = files.get(pathname)
      if (data === undefined) return new Response(null, { status: 404 })
      return new Response(data, { status: 200 })
    }
    if (method === 'PUT') {
      const body = Buffer.from(await new Response(init.body).arrayBuffer())
      files.set(pathname, body)
      return new Response(null, { status: 201 })
    }
    if (method === 'DELETE') {
      files.delete(pathname)
      return new Response(null, { status: 204 })
    }
    return new Response(null, { status: 405 })
  }

  return { fetchImpl, files, dirs, requests, base }
}

function davBackend(dav, options = {}) {
  return createWebdavBackend(
    { id: 'dav', type: 'webdav', url: 'http://dav.test/dav', username: 'u', password: 'p', basePath: '/sync/a' },
    { fetchImpl: dav.fetchImpl, logger: silentLogger, ...options },
  )
}

const count = (requests, method) => requests.filter((item) => item.method === method).length

test('webdav：索引可用时同 hash 只 1 次 PUT、0 次 HEAD', async () => {
  const dav = makeDav()
  const backend = davBackend(dav)
  await backend.init()
  const hash = sha256(REPEATABLE)
  const before = dav.requests.length

  await backend.writeObject(hash, REPEATABLE)
  const first = dav.requests.slice(before)
  assert.equal(count(first, 'PUT'), 1, '应只发一次 PUT')
  assert.equal(count(first, 'HEAD'), 0, '索引可用时不应逐对象 HEAD')

  // 第二次写同一内容：索引命中，0 请求
  const before2 = dav.requests.length
  const again = await backend.writeObject(hash, REPEATABLE)
  assert.equal(again.skipped, true)
  assert.equal(dav.requests.length, before2, '已存在内容不应再发任何请求')
})

test('webdav：gzip 存储且读回还原原始字节，sha256 与对象名一致', async () => {
  const dav = makeDav()
  const backend = davBackend(dav)
  await backend.init()
  const hash = sha256(REPEATABLE)

  const written = await backend.writeObject(hash, REPEATABLE)
  assert.equal(written.skipped, false)
  assert.ok(written.storedBytes < REPEATABLE.byteLength, `压缩后应更小：${written.storedBytes}`)
  assert.ok(dav.files.has(`${dav.base}/objects/${hash}.z`), '可压缩内容应存为 .z')

  const read = await backend.readObject(hash)
  assert.ok(read, '应能读回')
  assert.equal(sha256(read), hash, '读回字节必须与对象名一致（已解压）')
  assert.deepEqual(Buffer.from(read), REPEATABLE)

  // 已存在 .z 的对象，再次写应跳过（混合版本并发也不会重复传）
  const again = await backend.writeObject(hash, REPEATABLE)
  assert.equal(again.skipped, true)
})

test('webdav：不可压缩内容按原样存 raw，仍可读回', async () => {
  const dav = makeDav()
  const backend = davBackend(dav)
  await backend.init()
  // 真随机字节：gzip 不可能压到 90%（伪随机序列会被 zlib 压掉一半）
  const random = randomBytes(600)
  const hash = sha256(random)
  const written = await backend.writeObject(hash, random)
  assert.equal(written.storedBytes, random.byteLength, '无收益时应原样上传')
  assert.ok(dav.files.has(`${dav.base}/objects/${hash}`), '应存为 raw')
  assert.deepEqual(Buffer.from(await backend.readObject(hash)), random)
})

test('webdav：PROPFIND 不支持时不额外探测（幂等 PUT），实例内二次写跳过', async () => {
  // 没有对象清单时不做 HEAD：内容寻址 PUT 本身幂等，多一次 HEAD 只增加往返。
  // 代价是服务端可能已有同一对象（跨设备重复传），正确性不受影响。
  const dav = makeDav({ propfindObjects: 405 })
  const backend = davBackend(dav)
  await backend.init()
  const hash = sha256(REPEATABLE)
  const before = dav.requests.length
  await backend.writeObject(hash, REPEATABLE)
  const window = dav.requests.slice(before)
  assert.equal(count(window, 'HEAD'), 0, '不应为了探测多发请求')
  assert.equal(count(window, 'PUT'), 1)

  // 写入成功后内存索引已记录：同一实例内重复写不再发请求
  const before2 = dav.requests.length
  const again = await backend.writeObject(hash, REPEATABLE)
  assert.equal(again.skipped, true)
  assert.equal(dav.requests.length, before2)
})

test('webdav：同 hash 10 个并发写只发 1 次 PUT', async () => {
  const dav = makeDav()
  const backend = davBackend(dav)
  await backend.init()
  const hash = sha256(REPEATABLE)
  const before = dav.requests.length
  const results = await Promise.all(
    Array.from({ length: 10 }, () => backend.writeObject(hash, REPEATABLE)),
  )
  assert.equal(count(dav.requests.slice(before), 'PUT'), 1)
  assert.equal(results.filter((item) => item.skipped === false).length, 1)
})

test('webdav：旧版本写的 raw 对象仍可读（索引里只有 <hash>）', async () => {
  const dav = makeDav()
  const raw = Buffer.from('{"legacy":true}', 'utf8')
  const hash = sha256(raw)
  dav.files.set(`${dav.base}/objects/${hash}`, raw)
  const backend = davBackend(dav)
  await backend.init()
  assert.equal(await backend.hasObject(hash), true)
  assert.deepEqual(Buffer.from(await backend.readObject(hash)), raw)
})

/** 极简 peer 假服务器。 */
function makePeer({ listMode = 'ok' } = {}) {
  const objects = new Map()
  const requests = []
  async function fetchImpl(url, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase()
    const { pathname } = new URL(url)
    requests.push({ method, pathname })
    const prefix = '/dsh-sync/v1'
    if (pathname === `${prefix}/ping`) {
      return Response.json({ ok: true, protocol: 1, deviceId: 'peer-1', deviceName: 'peer' })
    }
    if (pathname === `${prefix}/objects` && method === 'GET') {
      if (listMode === 'missing') return new Response(null, { status: 404 })
      if (listMode === 'truncated') {
        return Response.json({ ok: true, total: 9, truncated: true, hashes: [...objects.keys()] })
      }
      return Response.json({ ok: true, total: objects.size, truncated: false, hashes: [...objects.keys()] })
    }
    const match = /^\/dsh-sync\/v1\/objects\/([a-f0-9]{64})$/.exec(pathname)
    if (match) {
      const hash = match[1]
      if (method === 'HEAD') return new Response(null, { status: objects.has(hash) ? 200 : 404 })
      if (method === 'GET') {
        if (!objects.has(hash)) return new Response(null, { status: 404 })
        return new Response(objects.get(hash), { status: 200 })
      }
      if (method === 'PUT') {
        objects.set(hash, Buffer.from(await new Response(init.body).arrayBuffer()))
        return new Response(null, { status: 200 })
      }
    }
    if (pathname.startsWith(`${prefix}/devices`)) {
      if (method === 'GET') return Response.json({ ok: true, devices: [] })
    }
    return new Response(null, { status: 404 })
  }
  return { fetchImpl, objects, requests }
}

function peerBackend(peer) {
  return createPeerBackend(
    { id: 'peer', type: 'peer', url: 'http://peer.test', token: 'token-1234567890' },
    { fetchImpl: peer.fetchImpl, logger: silentLogger },
  )
}

test('peer：有对象清单端点时 0 次 HEAD，写入后索引增量可用', async () => {
  const peer = makePeer()
  const backend = peerBackend(peer)
  await backend.init()
  const hash = sha256(REPEATABLE)
  const before = peer.requests.length
  const written = await backend.writeObject(hash, REPEATABLE)
  assert.equal(written.skipped, false)
  assert.equal(count(peer.requests.slice(before), 'HEAD'), 0, '索引可用时不发 HEAD')
  assert.equal(count(peer.requests.slice(before), 'PUT'), 1)

  const before2 = peer.requests.length
  const again = await backend.writeObject(hash, REPEATABLE)
  assert.equal(again.skipped, true)
  assert.equal(peer.requests.length, before2, '索引命中后 0 请求')
})

test('peer：清单被截断时回退 HEAD（防止误判）', async () => {
  const peer = makePeer({ listMode: 'truncated' })
  const backend = peerBackend(peer)
  await backend.init()
  const hash = sha256(REPEATABLE)
  const before = peer.requests.length
  await backend.writeObject(hash, REPEATABLE)
  assert.equal(count(peer.requests.slice(before), 'HEAD'), 1, '截断时应回退为 HEAD')
})

test('peer：旧对端没有清单端点时回退 HEAD 且每个对象 ≤1 次', async () => {
  const peer = makePeer({ listMode: 'missing' })
  const backend = peerBackend(peer)
  await backend.init()
  const hash = sha256(REPEATABLE)
  const before = peer.requests.length
  await backend.writeObject(hash, REPEATABLE)
  const window = peer.requests.slice(before)
  assert.equal(count(window, 'HEAD'), 1)
  assert.equal(count(window, 'PUT'), 1)
})

test('webdav：gzip 关闭时按原样上传（compress=false）', async () => {
  const dav = makeDav()
  const backend = davBackend(dav, { compress: false })
  await backend.init()
  const hash = sha256(REPEATABLE)
  const written = await backend.writeObject(hash, REPEATABLE)
  assert.equal(written.storedBytes, REPEATABLE.byteLength)
  assert.ok(dav.files.has(`${dav.base}/objects/${hash}`))
  assert.ok(!dav.files.has(`${dav.base}/objects/${hash}.z`))
})

test('webdav：gzip 字节确实是 gzip 格式（服务端可解）', async () => {
  const dav = makeDav()
  const backend = davBackend(dav)
  await backend.init()
  const hash = sha256(REPEATABLE)
  await backend.writeObject(hash, REPEATABLE)
  const stored = dav.files.get(`${dav.base}/objects/${hash}.z`)
  assert.ok(stored, '应有 .z 对象')
  // gzip magic 1f 8b
  assert.equal(stored[0], 0x1f)
  assert.equal(stored[1], 0x8b)
  assert.ok(stored.byteLength <= gzipSync(REPEATABLE).byteLength)
})