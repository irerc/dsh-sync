/**
 * 后端层测试（SPEC 第 5 节）：local / webdav / peer + createBackend 工厂。
 *
 * 纪律：
 * - 全部走真实网络：WebDAV / peer 用例都在 127.0.0.1 上起真实 node:http 服务，
 *   不 mock fetch 的返回结果（只允许包一层计数代理，证明 fetchImpl 注入生效）。
 * - 每个断言都有可核对证据；错误传播断言必须匹配真实状态码。
 * - 复用 test/support 下的共享夹具（mock-webdav.mjs / peer-server.mjs），
 *   它们是真实 HTTP 服务，不是打桩对象。
 *
 * 运行：node --test test/backends.test.mjs
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createBackend } from '../lib/backends/index.js'
import { __resetWebdavInitCache } from '../lib/backends/webdav.js'
import { resolveProtocolBase } from '../lib/backends/peer.js'
import { sha256Hex } from '../lib/util.js'
import { startMockWebdav } from './support/mock-webdav.mjs'
import { startPeerServer } from './support/peer-server.mjs'

/** 全零 hash：只用于权限探测，不对应任何真实对象。 */
const ZERO_HASH = '0'.repeat(64)
/** WebDAV 测试凭据：含非 ASCII，顺带验证 Basic Auth 的 UTF-8 编码。 */
const DAV_USER = 'dav-user'
const DAV_PASS = 'p@ss-Wörd-123'
/** mock 挂载前缀（模拟 url 本身位于子路径）。 */
const DAV_MOUNT = '/dav'
/** 后端 basePath：多级，用来验证“逐级 MKCOL”。 */
const DAV_SUB = '/sync/a'
/** peer 测试 token。 */
const PEER_TOKEN = 'peer-token-4f2a9c'

/** 建临时目录，测试结束自动清理。 */
async function makeTempDir(t, prefix = 'dshsync-backends-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })
  return dir
}

/** 启一个 mock WebDAV，测试结束自动关闭。 */
async function startWebdav(t, options = {}) {
  const dav = await startMockWebdav(options)
  t.after(async () => {
    await dav.close()
  })
  return dav
}

/** 启一个 mock peer，测试结束自动关闭。 */
async function startPeer(t, options = {}) {
  const peer = await startPeerServer(options)
  t.after(async () => {
    await peer.close()
  })
  return peer
}

/** 构造 SPEC 形态的设备 manifest（后端不校验内容，引擎才校验）。 */
function makeManifest(deviceId, entries = []) {
  return {
    format: 'dsh-sync-manifest',
    version: 1,
    deviceId,
    deviceName: `test-${deviceId}`,
    generatedAt: 1760000000000,
    entries,
    tombstones: [],
  }
}

/** 一条合法 entry，供往返用例使用。 */
function makeEntry(deviceId, hash = 'a'.repeat(64)) {
  return {
    key: 'profile/cordis.patch.yml',
    root: 'profile',
    path: 'cordis.patch.yml',
    hash,
    size: 12,
    mtimeMs: 1760000000000,
    updatedAt: 1760000000000,
    deviceId,
  }
}

/** 真实 HTTP 故障服务器：所有请求固定返回 status，用于验证 5xx 错误传播。 */
async function startFailureServer(t, status = 500) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`simulated ${status} for ${req.method}`)
  })
  t.after(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(() => resolve()))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

/* ------------------------------------------------------------------ */
/* local                                                               */
/* ------------------------------------------------------------------ */

test('local · init 幂等创建 devices/objects，test() 真实读写探测', async (t) => {
  const dir = await makeTempDir(t)
  const store = path.join(dir, 'store')
  const backend = await createBackend({
    id: 'local-1',
    type: 'local',
    label: '本地存储',
    path: store,
  })

  assert.equal(backend.type, 'local')
  assert.equal(backend.targetId, 'local-1')

  await backend.init()
  await backend.init() // 幂等：重复 init 不抛

  for (const sub of ['devices', 'objects']) {
    const stat = await fsp.stat(path.join(store, sub))
    assert.ok(stat.isDirectory(), `${sub} 应为目录`)
  }

  const probe = await backend.test()
  assert.equal(probe.ok, true, probe.detail)
  assert.match(probe.detail, /探测文件读写成功/)
  // 探测文件必须清理干净
  const leftovers = (await fsp.readdir(store)).filter((name) => name.includes('.dsh-sync-probe-'))
  assert.deepEqual(leftovers, [])
})

test('local · manifest 往返、覆盖写原子无 tmp 残留、缺失返回 null', async (t) => {
  const dir = await makeTempDir(t)
  const store = path.join(dir, 'store')
  const backend = await createBackend({ id: 'local-2', type: 'local', path: store })
  await backend.init()

  const first = makeManifest('dev-a1b2c3', [makeEntry('dev-a1b2c3')])
  await backend.writeManifest('dev-a1b2c3', first)
  assert.deepEqual(await backend.readManifest('dev-a1b2c3'), first)

  const second = makeManifest('dev-a1b2c3')
  await backend.writeManifest('dev-a1b2c3', second)
  assert.deepEqual(await backend.readManifest('dev-a1b2c3'), second)

  assert.equal(await backend.readManifest('dev-ffffffffff'), null)

  // tmp+rename 的中间文件不能残留
  const names = await fsp.readdir(path.join(store, 'devices'))
  assert.deepEqual(names, ['dev-a1b2c3.json'])
})

test('local · 对象往返、幂等写入与 hasObject、缺失返回 null', async (t) => {
  const dir = await makeTempDir(t)
  const store = path.join(dir, 'store')
  const backend = await createBackend({ id: 'local-3', type: 'local', path: store })
  await backend.init()

  const bytes = Buffer.from('多设备同步对象内容 local', 'utf8')
  const hash = sha256Hex(bytes)

  assert.equal(await backend.hasObject(hash), false)
  const firstWrite = await backend.writeObject(hash, bytes)
  assert.equal(firstWrite.skipped, false)
  assert.equal(await backend.hasObject(hash), true)
  assert.deepEqual(Buffer.from(await backend.readObject(hash)), bytes)

  // 内容寻址：已存在直接跳过，不重写
  const secondWrite = await backend.writeObject(hash, bytes)
  assert.equal(secondWrite.skipped, true)
  assert.deepEqual(Buffer.from(await backend.readObject(hash)), bytes)

  assert.equal(await backend.readObject(ZERO_HASH), null)
  assert.deepEqual(await fsp.readdir(path.join(store, 'objects')), [hash])
})

test('local · listDevices 排序并过滤非法文件名/目录', async (t) => {
  const dir = await makeTempDir(t)
  const store = path.join(dir, 'store')
  const backend = await createBackend({ id: 'local-4', type: 'local', path: store })
  await backend.init()

  await backend.writeManifest('dev-b', makeManifest('dev-b'))
  await backend.writeManifest('dev-a', makeManifest('dev-a'))
  await fsp.writeFile(path.join(store, 'devices', 'notes.txt'), '不是 manifest')
  await fsp.writeFile(path.join(store, 'devices', 'bad..name.json'), '{}')
  await fsp.mkdir(path.join(store, 'devices', 'weird.json'))

  assert.deepEqual(await backend.listDevices(), ['dev-a', 'dev-b'])
})

test('local · 非法对象名与 deviceId 被拒绝（路径穿越防线）', async (t) => {
  const dir = await makeTempDir(t)
  const backend = await createBackend({ id: 'local-5', type: 'local', path: path.join(dir, 'store') })
  await backend.init()

  await assert.rejects(() => backend.hasObject('not-a-sha256'), /64 位小写 sha256/)
  await assert.rejects(() => backend.readObject('A'.repeat(64)), /64 位小写 sha256/)
  await assert.rejects(() => backend.writeObject('../escape', Buffer.from('x')), /64 位小写 sha256/)
  await assert.rejects(() => backend.readManifest('../escape'), /非法 deviceId/)
  await assert.rejects(() => backend.writeManifest('a/b', {}), /非法 deviceId/)
})

test('local · 缺少 path 时 init 抛可读错误，test() 不抛且给出原因', async () => {
  const backend = await createBackend({ id: 'local-empty', type: 'local' })
  await assert.rejects(() => backend.init(), /缺少 path/)
  const result = await backend.test()
  assert.equal(result.ok, false)
  assert.match(result.detail, /缺少 path/)
})

test('local · describe 只暴露类型/标签/路径', async (t) => {
  const dir = await makeTempDir(t)
  const backend = await createBackend({
    id: 'local-6',
    type: 'local',
    label: '手机存储',
    path: path.join(dir, 'store'),
  })
  const desc = await backend.describe()
  assert.deepEqual(desc, {
    type: 'local',
    label: '手机存储',
    detail: path.join(dir, 'store'),
  })
})

/* ------------------------------------------------------------------ */
/* webdav                                                              */
/* ------------------------------------------------------------------ */

test('webdav · init 逐级 MKCOL、405 视为已存在、Basic Auth 正确', async (t) => {
  // autoCreateParents=false：父集合必须真实存在，才能证明 init 的逐级 MKCOL 有效
  const dav = await startWebdav(t, {
    basePath: DAV_MOUNT,
    username: DAV_USER,
    password: DAV_PASS,
    autoCreateParents: false,
  })
  const backend = await createBackend({
    id: 'dav-1',
    type: 'webdav',
    label: '坚果云',
    url: `${dav.url}${DAV_MOUNT}`,
    username: DAV_USER,
    password: DAV_PASS,
    basePath: DAV_SUB,
  })
  assert.equal(backend.type, 'webdav')
  assert.equal(backend.targetId, 'dav-1')

  await backend.init()

  const mkcolPaths = dav.requests
    .filter((request) => request.method === 'MKCOL')
    .map((request) => request.path)
  assert.deepEqual(mkcolPaths, [
    `${DAV_MOUNT}/sync`,
    `${DAV_MOUNT}/sync/a`,
    `${DAV_MOUNT}/sync/a/devices`,
    `${DAV_MOUNT}/sync/a/objects`,
  ])
  for (const dir of mkcolPaths) assert.ok(dav.dirs.has(dir), `${dir} 应已创建`)

  // 重复 init：命中 5 分钟 init 缓存 → 不再重复 MKCOL（每次同步省 4 次往返）
  await backend.init()
  assert.equal(
    dav.requests.filter((request) => request.method === 'MKCOL').length,
    mkcolPaths.length,
    'init 缓存命中时不应重复 MKCOL',
  )

  // 清掉缓存后再 init：目录都已存在，服务器返回 405，后端必须视为成功
  __resetWebdavInitCache()
  await backend.init()
  const repeat = dav.requests.filter((request) => request.method === 'MKCOL').slice(mkcolPaths.length)
  assert.deepEqual(repeat.map((request) => request.path), mkcolPaths)
  for (const request of repeat) {
    assert.equal(request.status, 405, `${request.path} 已存在，应为 405 且被兼容`)
  }
})

test('webdav · test() 走 MKCOL + 探测文件 PUT/GET/DELETE 并清理', async (t) => {
  const dav = await startWebdav(t, { basePath: DAV_MOUNT, username: DAV_USER, password: DAV_PASS })
  const backend = await createBackend({
    id: 'dav-2',
    type: 'webdav',
    url: `${dav.url}${DAV_MOUNT}`,
    username: DAV_USER,
    password: DAV_PASS,
    basePath: DAV_SUB,
  })

  const result = await backend.test()
  assert.equal(result.ok, true, result.detail)
  assert.match(result.detail, /MKCOL、探测文件写入 \/ 读取 \/ 删除均成功/)

  const probeRequests = dav.requests.filter((request) => request.path.includes('.dsh-sync-probe-'))
  assert.deepEqual(
    probeRequests.map((request) => request.method),
    ['PUT', 'GET', 'DELETE'],
  )
  assert.deepEqual(
    probeRequests.map((request) => request.status),
    [201, 200, 204],
  )
  assert.equal([...dav.files.keys()].some((key) => key.includes('.dsh-sync-probe-')), false)
})

test('webdav · manifest 往返、404→null、PUT 覆盖到真实路径', async (t) => {
  const dav = await startWebdav(t, { basePath: DAV_MOUNT, username: DAV_USER, password: DAV_PASS })
  const backend = await createBackend({
    id: 'dav-3',
    type: 'webdav',
    url: `${dav.url}${DAV_MOUNT}`,
    username: DAV_USER,
    password: DAV_PASS,
    basePath: DAV_SUB,
  })
  await backend.init()

  const manifest = makeManifest('dev-a1b2c3', [makeEntry('dev-a1b2c3')])
  const write = await backend.writeManifest('dev-a1b2c3', manifest)
  assert.equal(write.ok, true)
  assert.deepEqual(await backend.readManifest('dev-a1b2c3'), manifest)
  assert.equal(await backend.readManifest('dev-ffffffffff'), null)

  const key = `${DAV_MOUNT}${DAV_SUB}/devices/dev-a1b2c3.json`
  assert.ok(dav.files.has(key), `mock 服务端应存在 ${key}`)
  assert.deepEqual(JSON.parse(dav.files.get(key).toString('utf8')), manifest)
})

test('webdav · 对象 HEAD 探测、PUT/GET 往返、幂等跳过重复 PUT、404→null', async (t) => {
  const dav = await startWebdav(t, { basePath: DAV_MOUNT, username: DAV_USER, password: DAV_PASS })
  const backend = await createBackend({
    id: 'dav-4',
    type: 'webdav',
    url: `${dav.url}${DAV_MOUNT}`,
    username: DAV_USER,
    password: DAV_PASS,
    basePath: DAV_SUB,
  })
  await backend.init()

  const bytes = Buffer.from('webdav 对象内容', 'utf8')
  const hash = sha256Hex(bytes)

  assert.equal(await backend.hasObject(hash), false)
  const first = await backend.writeObject(hash, bytes)
  assert.equal(first.skipped, false)
  assert.equal(await backend.hasObject(hash), true)
  assert.deepEqual(Buffer.from(await backend.readObject(hash)), bytes)

  const second = await backend.writeObject(hash, bytes)
  assert.equal(second.skipped, true)
  const puts = dav.requests.filter(
    (request) => request.method === 'PUT' && request.path.endsWith(`/objects/${hash}`),
  )
  assert.equal(puts.length, 1, '幂等写入不应产生第二次 PUT')

  assert.equal(await backend.readObject(ZERO_HASH), null)
})

test('webdav · PROPFIND Depth:1 列设备，过滤非 .json 文件', async (t) => {
  const dav = await startWebdav(t, { basePath: DAV_MOUNT, username: DAV_USER, password: DAV_PASS })
  const backend = await createBackend({
    id: 'dav-5',
    type: 'webdav',
    url: `${dav.url}${DAV_MOUNT}`,
    username: DAV_USER,
    password: DAV_PASS,
    basePath: DAV_SUB,
  })
  await backend.init()

  await backend.writeManifest('dev-b', makeManifest('dev-b'))
  await backend.writeManifest('dev-a', makeManifest('dev-a'))
  dav.writeFile(`${DAV_MOUNT}${DAV_SUB}/devices/notes.txt`, Buffer.from('不是设备'))

  assert.deepEqual(await backend.listDevices(), ['dev-a', 'dev-b'])

  // init 之后还会对 objects/ 发一次 PROPFIND（建对象索引），这里只取列设备那一次
  const propfind = dav.requests.find(
    (request) => request.method === 'PROPFIND' && request.path === `${DAV_MOUNT}${DAV_SUB}/devices/`,
  )
  assert.ok(propfind, '应对 devices/ 发出 PROPFIND')
  assert.equal(propfind.status, 207)
})

test('webdav · 认证失败 401 传播为带状态码错误，test() 不抛', async (t) => {
  const dav = await startWebdav(t, { basePath: DAV_MOUNT, username: DAV_USER, password: DAV_PASS })
  const backend = await createBackend({
    id: 'dav-bad',
    type: 'webdav',
    url: `${dav.url}${DAV_MOUNT}`,
    username: DAV_USER,
    password: 'wrong-password',
    basePath: DAV_SUB,
  })

  await assert.rejects(() => backend.init(), /HTTP 401/)
  const result = await backend.test()
  assert.equal(result.ok, false)
  assert.match(result.detail, /401/)
})

test('webdav · 5xx 错误传播带状态码', async (t) => {
  const origin = await startFailureServer(t, 500)
  const backend = await createBackend({
    id: 'dav-500',
    type: 'webdav',
    url: `${origin}/dav`,
    username: 'u',
    password: 'p',
    basePath: '/sync',
  })
  await assert.rejects(() => backend.init(), /HTTP 500/)
})

test('webdav · options.fetchImpl 被真实调用（仍走 localhost 网络）', async (t) => {
  const dav = await startWebdav(t, { basePath: DAV_MOUNT, username: DAV_USER, password: DAV_PASS })
  let calls = 0
  const countingFetch = (...args) => {
    calls += 1
    return globalThis.fetch(...args)
  }
  const backend = await createBackend(
    {
      id: 'dav-6',
      type: 'webdav',
      url: `${dav.url}${DAV_MOUNT}`,
      username: DAV_USER,
      password: DAV_PASS,
      basePath: DAV_SUB,
    },
    { fetchImpl: countingFetch },
  )
  await backend.init()
  const manifest = makeManifest('dev-a1b2c3')
  await backend.writeManifest('dev-a1b2c3', manifest)
  assert.deepEqual(await backend.readManifest('dev-a1b2c3'), manifest)
  assert.ok(calls >= 3, `fetchImpl 应被调用至少 3 次，实际 ${calls}`)
  assert.ok(dav.requests.length >= 3)
})

test('webdav · describe 不含密码', async (t) => {
  const dav = await startWebdav(t, { basePath: DAV_MOUNT, username: DAV_USER, password: DAV_PASS })
  const backend = await createBackend({
    id: 'dav-7',
    type: 'webdav',
    label: '群晖',
    url: `${dav.url}${DAV_MOUNT}`,
    username: DAV_USER,
    password: DAV_PASS,
    basePath: DAV_SUB,
  })
  const desc = await backend.describe()
  assert.equal(desc.type, 'webdav')
  assert.equal(desc.label, '群晖')
  assert.match(desc.detail, /\/dav\/sync\/a/)
  assert.equal(JSON.stringify(desc).includes(DAV_PASS), false, 'describe 不得包含密码')
})

/* ------------------------------------------------------------------ */
/* peer                                                                */
/* ------------------------------------------------------------------ */

test('peer · resolveProtocolBase 五种 url 输入归一化一致', () => {
  // Lead 补充口径：配对区展示的是完整协议根，复制粘贴不能二次拼接
  const expected = 'http://127.0.0.1:3080/dsh-sync/v1'
  assert.equal(resolveProtocolBase('http://127.0.0.1:3080'), expected) // origin
  assert.equal(resolveProtocolBase('http://127.0.0.1:3080/'), expected) // origin/
  assert.equal(resolveProtocolBase('http://127.0.0.1:3080/dsh-sync/v1'), expected) // 完整协议根
  assert.equal(resolveProtocolBase('http://127.0.0.1:3080/gateway'), 'http://127.0.0.1:3080/gateway/dsh-sync/v1') // 自定义前缀
  assert.equal(resolveProtocolBase('http://127.0.0.1:3080/dsh-sync'), expected) // /dsh-sync
  // 尾斜杠的完整协议根同样不能重复拼接
  assert.equal(resolveProtocolBase('http://127.0.0.1:3080/dsh-sync/v1/'), expected)
})

test('peer · init/test 用 ping + HEAD 全零 hash，不写假 manifest', async (t) => {
  const peer = await startPeer(t, { token: PEER_TOKEN, deviceName: 'other-phone' })
  const backend = await createBackend({
    id: 'peer-1',
    type: 'peer',
    label: '另一台 DSH',
    url: peer.url,
    token: PEER_TOKEN,
  })
  assert.equal(backend.type, 'peer')
  assert.equal(backend.targetId, 'peer-1')

  const init = await backend.init()
  assert.equal(init.ok, true)
  assert.match(init.detail, /protocol=1/)
  assert.match(init.detail, /deviceName=other-phone/)

  const probe = await backend.test()
  assert.equal(probe.ok, true, probe.detail)
  assert.match(probe.detail, /protocol=1/)
  assert.match(probe.detail, /对象探测为空（权限正常）/)

  // 关键红线：探测不得写入任何 manifest，不得污染设备列表
  assert.equal(peer.devices.size, 0)
  assert.equal(peer.objects.size, 0)
  assert.equal(peer.requests.filter((request) => request.method === 'PUT').length, 0)
  assert.ok(peer.requests.some((request) => request.path === '/dsh-sync/v1/ping'))
  assert.ok(
    peer.requests.some(
      (request) => request.method === 'HEAD' && request.path === `/dsh-sync/v1/objects/${ZERO_HASH}`,
    ),
  )
})

test('peer · token 无效时 401 给出可读错误，test() 不抛', async (t) => {
  const peer = await startPeer(t, { token: PEER_TOKEN })
  const backend = await createBackend({
    id: 'peer-bad',
    type: 'peer',
    url: peer.url,
    token: 'wrong-token',
  })

  await assert.rejects(() => backend.init(), /token 无效/)
  await assert.rejects(() => backend.listDevices(), /token 无效/)
  const result = await backend.test()
  assert.equal(result.ok, false)
  assert.match(result.detail, /401/)
  assert.equal(peer.devices.size, 0)
})

test('peer · manifest 与对象往返、缺失返回 null、幂等写入', async (t) => {
  const peer = await startPeer(t, { token: PEER_TOKEN })
  const backend = await createBackend({ id: 'peer-2', type: 'peer', url: peer.url, token: PEER_TOKEN })
  await backend.init()

  assert.equal(await backend.readManifest('dev-a1b2c3'), null)

  const manifest = makeManifest('dev-a1b2c3', [makeEntry('dev-a1b2c3')])
  await backend.writeManifest('dev-a1b2c3', manifest)
  assert.deepEqual(await backend.readManifest('dev-a1b2c3'), manifest)
  assert.deepEqual(peer.devices.get('dev-a1b2c3'), manifest)

  const bytes = Buffer.from('peer 对象内容', 'utf8')
  const hash = sha256Hex(bytes)
  assert.equal(await backend.hasObject(hash), false)
  const first = await backend.writeObject(hash, bytes)
  assert.equal(first.skipped, false)
  assert.equal(await backend.hasObject(hash), true)
  assert.deepEqual(Buffer.from(await backend.readObject(hash)), bytes)

  const second = await backend.writeObject(hash, bytes)
  assert.equal(second.skipped, true)
  const puts = peer.requests.filter(
    (request) => request.method === 'PUT' && request.path === `/dsh-sync/v1/objects/${hash}`,
  )
  assert.equal(puts.length, 1, '幂等写入不应产生第二次 PUT')

  assert.equal(await backend.readObject(ZERO_HASH), null)
})

test('peer · listDevices 返回排序后的设备列表', async (t) => {
  const peer = await startPeer(t, { token: PEER_TOKEN })
  const backend = await createBackend({ id: 'peer-3', type: 'peer', url: peer.url, token: PEER_TOKEN })
  await backend.init()

  await backend.writeManifest('dev-b', makeManifest('dev-b'))
  await backend.writeManifest('dev-a', makeManifest('dev-a'))
  assert.deepEqual(await backend.listDevices(), ['dev-a', 'dev-b'])
})

test('peer · url 带 base path 时协议根为 <url>/dsh-sync/v1', async (t) => {
  const peer = await startPeer(t, {
    token: PEER_TOKEN,
    prefix: '/gateway/dsh-sync',
    deviceName: 'gateway-peer',
  })
  const backend = await createBackend({
    id: 'peer-gw',
    type: 'peer',
    url: `${peer.url}/gateway`,
    token: PEER_TOKEN,
  })

  await backend.init()
  const manifest = makeManifest('dev-a1b2c3')
  await backend.writeManifest('dev-a1b2c3', manifest)
  assert.deepEqual(await backend.readManifest('dev-a1b2c3'), manifest)
  assert.deepEqual(await backend.listDevices(), ['dev-a1b2c3'])

  // 请求路径必须真的带 url 的 path 前缀，且保持 /dsh-sync/v1 协议根
  assert.ok(peer.requests.length > 0)
  for (const request of peer.requests) {
    assert.ok(
      request.path.startsWith('/gateway/dsh-sync/v1/'),
      `请求路径应挂在 /gateway/dsh-sync/v1 下，实际 ${request.path}`,
    )
  }
  assert.ok(peer.requests.some((request) => request.path === '/gateway/dsh-sync/v1/ping'))
})

test('peer · url 直接填完整协议根不会二次拼接（真实网络）', async (t) => {
  const peer = await startPeer(t, { token: PEER_TOKEN })
  const backend = await createBackend({
    id: 'peer-full',
    type: 'peer',
    url: `${peer.url}/dsh-sync/v1`,
    token: PEER_TOKEN,
  })
  await backend.init()
  const probe = await backend.test()
  assert.equal(probe.ok, true, probe.detail)
  assert.ok(peer.requests.some((request) => request.path === '/dsh-sync/v1/ping'))
  for (const request of peer.requests) {
    assert.equal(
      request.path.includes('/dsh-sync/v1/dsh-sync/v1'),
      false,
      `不应出现重复协议根：${request.path}`,
    )
  }
})

test('peer · 5xx 错误传播带状态码', async (t) => {
  const origin = await startFailureServer(t, 503)
  const backend = await createBackend({
    id: 'peer-500',
    type: 'peer',
    url: origin,
    token: 'any-token',
  })
  await assert.rejects(() => backend.init(), /HTTP 503/)
})

test('peer · describe 不含 token', async (t) => {
  const peer = await startPeer(t, { token: PEER_TOKEN })
  const backend = await createBackend({
    id: 'peer-4',
    type: 'peer',
    label: '家里那台',
    url: peer.url,
    token: PEER_TOKEN,
  })
  const desc = await backend.describe()
  assert.equal(desc.type, 'peer')
  assert.equal(desc.label, '家里那台')
  assert.match(desc.detail, /\/dsh-sync\/v1$/)
  assert.equal(JSON.stringify(desc).includes(PEER_TOKEN), false, 'describe 不得包含 token')
})

/* ------------------------------------------------------------------ */
/* createBackend 工厂                                                   */
/* ------------------------------------------------------------------ */

test('createBackend · 未知 type 抛可读错误', async () => {
  await assert.rejects(() => createBackend({ id: 'x', type: 's3' }), /未知的后端类型：s3/)
  await assert.rejects(() => createBackend({}), /未知的后端类型：\(空\)/)
  await assert.rejects(() => createBackend(undefined), /未知的后端类型/)
})

test('createBackend · 三种类型都返回完整 SyncBackend 接口', async (t) => {
  const dir = await makeTempDir(t)
  const targets = [
    { id: 'l', type: 'local', path: path.join(dir, 'store') },
    { id: 'w', type: 'webdav', url: 'http://127.0.0.1:1/dav', username: 'u', password: 'p' },
    { id: 'p', type: 'peer', url: 'http://127.0.0.1:1', token: 't' },
  ]
  const methods = [
    'init',
    'test',
    'listDevices',
    'readManifest',
    'writeManifest',
    'hasObject',
    'readObject',
    'writeObject',
    'describe',
    'close',
  ]
  for (const target of targets) {
    const backend = await createBackend(target)
    assert.equal(backend.type, target.type)
    assert.equal(backend.targetId, target.id)
    for (const method of methods) {
      assert.equal(typeof backend[method], 'function', `${target.type}.${method} 应为函数`)
    }
  }
})