/**
 * HTTP API 端到端测试：
 * - 设置页 /api/*：状态、配置掩码、测试、同步、导出下载、导入、同源校验；
 * - 对等 /v1/*：ping 无 token、其余 401、设备与对象读写、hash 校验；
 * - 真实 createBackend('peer') 打到本测试服务器，验证 url 归一化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import { SyncStore } from '../lib/state.js'
import { SyncEngine } from '../lib/engine/engine.js'
import { attachRoutes } from '../lib/http-api.js'
import { decodePairing, encodePairing } from '../lib/pair.js'
import { createBackend } from '../lib/backends/index.js'
import { createDeviceManifest } from '../lib/engine/manifest.js'
import { parseArchive } from '../lib/engine/archive.js'
import { sha256Bytes } from '../lib/engine/hash.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

/** 起一个只承载 webServer.register 路由的测试壳。 */
async function startHarness(t) {
  const routes = []
  const taps = []
  let origin = ''
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    getOrigin: () => origin,
    tapIndex(fn) {
      taps.push(fn)
      return () => {
        const index = taps.indexOf(fn)
        if (index >= 0) taps.splice(index, 1)
      }
    },
    renderIndexForTest(html) {
      return taps.reduce((acc, fn) => fn(acc), html)
    },
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = routes.find((item) => url.pathname === item.path || url.pathname.startsWith(`${item.path}/`))
    if (!route) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  origin = `http://127.0.0.1:${port}`
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { webServer, origin, routes }
}

/** 创建临时设备（store + engine）。 */
async function startDevice(t, { password = 'secret-token' } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsync-api-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const home = path.join(base, 'home')
  const root = path.join(base, 'data')
  const storeDir = path.join(base, 'store')
  await fsp.mkdir(root, { recursive: true })
  const store = new SyncStore({
    homeDir: home,
    logger: silentLogger,
    env: { ...process.env, DSH_HOME: home, HOME: base, DSH_PROFILE: 'web' },
  })
  await store.load()
  let origin = ''
  const engine = new SyncEngine({ store, logger: silentLogger, getOrigin: () => origin })
  await engine.updateConfig({
    deviceName: 'api-test',
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    roots: [{ id: 'data', label: 'data', path: root, enabled: true, exclude: [] }],
    targets: [
      { id: 'local', type: 'local', label: '本地', enabled: true, path: storeDir },
      {
        id: 'dav',
        type: 'webdav',
        label: 'DAV',
        enabled: false,
        url: 'https://dav.example.com/remote.php/dav/files/u',
        username: 'u',
        password,
        basePath: '/dsh-sync',
      },
    ],
  })
  return { base, home, root, storeDir, store, engine, setOrigin: (value) => { origin = value } }
}

/** 当前测试设备的 UI token；在每个用例创建 device 后设置。 */
let uiToken = ''

/** fetch 包装：设置页 API 默认带 UI token，显式 noToken 用于验证 401。 */
async function call(origin, pathname, options = {}) {
  const { noToken = false, ...init } = options
  const headers = { ...(init.headers || {}) }
  if (!noToken && pathname.startsWith('/dsh-sync/api/') && uiToken) headers['x-dsh-sync-ui-token'] = uiToken
  const response = await fetch(`${origin}${pathname}`, { ...init, headers })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body, headers: response.headers, text }
}

test('HTTP API：状态/配置掩码/测试/同步/导出下载/导入/同源', async (t) => {
  const device = await startDevice(t)
  const harness = await startHarness(t)
  device.setOrigin(harness.origin)
  const dispose = attachRoutes(harness.webServer, { engine: device.engine, store: device.store, logger: silentLogger })
  t.after(dispose)
  uiToken = device.store.uiToken

  // index 注入 meta，且未登录拿不到 token
  const injected = harness.webServer.renderIndexForTest('<!doctype html><html><head></head><body></body></html>')
  assert.ok(injected.includes(`name="dsh-sync-ui-token" content="${device.store.uiToken}"`), 'index 必须注入 UI token meta')

  // 无 token 必须 401，带 token 才可读
  const anonymous = await call(harness.origin, '/dsh-sync/api/status', { noToken: true })
  assert.equal(anonymous.status, 401)
  assert.equal((await call(harness.origin, '/dsh-sync/api/config', {
    method: 'POST',
    noToken: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: { deviceName: 'hijack' } }),
  })).status, 401)
  const status = await call(harness.origin, '/dsh-sync/api/status')
  assert.equal(status.status, 200)
  assert.equal(status.body.ok, true)
  assert.equal(status.body.deviceName, 'api-test')
  assert.equal(status.body.peer.url, `${harness.origin}/dsh-sync/v1`)
  assert.equal(status.body.peer.token, device.store.config.peerToken)
  const dav = status.body.targets.find((item) => item.id === 'dav')
  assert.equal(dav.password, '***', '密码必须掩码')
  assert.equal(dav.url, 'https://dav.example.com/remote.php/dav/files/u', '非密字段必须回填')
  assert.equal(dav.basePath, '/dsh-sync')
  assert.equal(status.body.targets.find((item) => item.id === 'local').path, device.storeDir)

  // 掩码回传不能洗掉密码
  const configResponse = await call(harness.origin, '/dsh-sync/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: harness.origin },
    body: JSON.stringify({ patch: { targets: status.body.targets, deviceName: 'api-test-2' } }),
  })
  assert.equal(configResponse.status, 200)
  assert.equal(configResponse.body.ok, true)
  assert.equal(device.store.config.deviceName, 'api-test-2')
  assert.equal(device.store.config.targets.find((item) => item.id === 'dav').password, 'secret-token')

  // 测试未保存草稿（local）
  const tested = await call(harness.origin, '/dsh-sync/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: { id: 'probe', type: 'local', path: device.storeDir, enabled: true } }),
  })
  assert.equal(tested.body.ok, true)

  // 同步 + 导出
  await fsp.writeFile(path.join(device.root, 'hello.txt'), 'hello api')
  const synced = await call(harness.origin, '/dsh-sync/api/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'auto' }),
  })
  assert.equal(synced.status, 200)
  assert.equal(synced.body.ok, true)
  assert.equal(synced.body.reports[0].pushed, 1)

  const exported = await call(harness.origin, '/dsh-sync/api/export', { method: 'POST' })
  assert.equal(exported.status, 200)
  assert.ok(exported.body.url.startsWith('/dsh-sync/api/download/'))
  const download = await fetch(`${harness.origin}${exported.body.url}`, {
    headers: { 'x-dsh-sync-ui-token': device.store.uiToken },
  })
  assert.equal(download.status, 200)
  const archiveBytes = Buffer.from(await download.arrayBuffer())
  assert.equal(archiveBytes.byteLength, exported.body.size)
  const parsed = await parseArchive(archiveBytes)
  assert.ok(parsed.manifest.entries.some((entry) => entry.path === 'hello.txt'))

  // 改本地 → 导入归档恢复，旧内容留冲突副本
  await fsp.writeFile(path.join(device.root, 'hello.txt'), 'local edit')
  const imported = await call(harness.origin, '/dsh-sync/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-filename': 'roundtrip.dshsync' },
    body: archiveBytes,
  })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.ok, true)

  // 一键配对码：本机 peer 生成 + 粘贴 webdav 码后新增 target
  const codeResponse = await call(harness.origin, '/dsh-sync/api/pair/code')
  assert.equal(codeResponse.status, 200)
  assert.ok(codeResponse.body.code.startsWith('DSHSYNC1.'))
  const selfPayload = decodePairing(codeResponse.body.code)
  assert.equal(selfPayload.type, 'peer')
  assert.equal(selfPayload.token, device.engine.config.peerToken)
  assert.ok(selfPayload.url.endsWith('/dsh-sync/v1'))
  assert.equal((await call(harness.origin, '/dsh-sync/api/pair/code', { noToken: true })).status, 401)

  const webdavCode = encodePairing({
    v: 1,
    type: 'webdav',
    url: 'https://dav.example.com/remote.php/dav/files/alice',
    username: 'alice',
    password: 'pair-secret',
    basePath: '/dsh-sync',
    label: '配对云盘',
  })
  const applied = await call(harness.origin, '/dsh-sync/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: webdavCode, sync: false }),
  })
  assert.equal(applied.status, 200)
  assert.equal(applied.body.ok, true)
  const paired = applied.body.status.targets.find((item) => item.type === 'webdav' && item.label === '配对云盘')
  assert.ok(paired, '配对后必须出现 webdav target')
  assert.equal(paired.password, '***')
  assert.equal((await call(harness.origin, '/dsh-sync/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'not-a-code' }),
  })).status, 400)

  // 快速连接：地址/账号/密码三项即可（此处用 local 验证同一 connectTarget 链路）
  const quickPath = path.join(device.root, 'quick-local')
  const quick = await call(harness.origin, '/dsh-sync/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'local', label: '快速连接', path: quickPath, sync: false }),
  })
  assert.equal(quick.status, 200)
  assert.equal(quick.body.ok, true)
  assert.equal(quick.body.test.ok, true)
  assert.ok(quick.body.status.targets.some((item) => item.label === '快速连接'))
  const badQuick = await call(harness.origin, '/dsh-sync/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'webdav', url: 'ftp://example.com', username: 'u', password: 'p' }),
  })
  assert.equal(badQuick.status, 400)
  assert.equal(await fsp.readFile(path.join(device.root, 'hello.txt'), 'utf8'), 'hello api')
  const files = await fsp.readdir(device.root)
  assert.ok(files.some((name) => name.includes('.conflict-local-')))

  // 快速开始「记住密码」：已有 target 再提交 password:'***' 必须沿用已存密码，不能写成字面量 ***
  const reQuick = await call(harness.origin, '/dsh-sync/api/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'webdav',
      url: 'https://dav.example.com/remote.php/dav/files/u',
      username: 'u',
      password: '***',
      basePath: '/dsh-sync',
      sync: false,
    }),
  })
  assert.equal(reQuick.status, 200)
  const savedDav = device.store.config.targets.find((item) => item.id === 'dav')
  assert.ok(savedDav, '应原地更新已存在的 dav target')
  assert.equal(savedDav.password, 'secret-token', '`***` 必须还原为已保存密码，不能写成字面量')
  // 磁盘上的配置也要是真实密码（防止只在内存里对）
  const onDisk = JSON.parse(await fsp.readFile(path.join(device.home, 'dsh-sync', 'config.json'), 'utf8'))
  assert.equal(onDisk.targets.find((item) => item.id === 'dav').password, 'secret-token')
  // status 回给 UI 的必须是掩码，不能泄漏明文
  assert.equal(reQuick.body.status.targets.find((item) => item.id === 'dav').password, '***')

  // 同源校验
  const crossOrigin = await call(harness.origin, '/dsh-sync/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
    body: JSON.stringify({ patch: { deviceName: 'hijack' } }),
  })
  assert.equal(crossOrigin.status, 403)
  assert.equal(device.store.config.deviceName, 'api-test-2')

  // 未知路由
  assert.equal((await call(harness.origin, '/dsh-sync/api/nope')).status, 404)
  // 下载路径穿越
  assert.equal((await call(harness.origin, '/dsh-sync/api/download/..%2Fconfig.json')).status, 400)
})

test('对等协议：ping 免鉴权、其余 401、对象 hash 校验、manifest 读写', async (t) => {
  const device = await startDevice(t)
  const harness = await startHarness(t)
  device.setOrigin(harness.origin)
  const dispose = attachRoutes(harness.webServer, { engine: device.engine, store: device.store, logger: silentLogger })
  t.after(dispose)
  uiToken = device.store.uiToken

  const ping = await call(harness.origin, '/dsh-sync/v1/ping')
  assert.equal(ping.status, 200)
  assert.equal(ping.body.ok, true)
  assert.equal(ping.body.protocol, 1)
  assert.equal(ping.body.deviceId, device.store.deviceId)

  assert.equal((await call(harness.origin, '/dsh-sync/v1/devices')).status, 401)
  assert.equal((await call(harness.origin, '/dsh-sync/v1/devices', {
    headers: { 'x-dsh-sync-token': 'wrong' },
  })).status, 401)
  assert.equal((await call(harness.origin, '/dsh-sync/v1/devices', {
    headers: { Authorization: `Bearer ${device.store.config.peerToken}` },
  })).status, 200)

  const token = device.store.config.peerToken
  const headers = { 'x-dsh-sync-token': token }
  const bytes = Buffer.from('peer object content')
  const hash = sha256Bytes(bytes)
  const wrongHash = createHash('sha256').update('other').digest('hex')

  const badPut = await call(harness.origin, `/dsh-sync/v1/objects/${wrongHash}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
  assert.equal(badPut.status, 400)

  const put = await call(harness.origin, `/dsh-sync/v1/objects/${hash}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
  assert.equal(put.status, 200)

  const head = await fetch(`${harness.origin}/dsh-sync/v1/objects/${hash}`, { method: 'HEAD', headers })
  assert.equal(head.status, 200)
  const got = await fetch(`${harness.origin}/dsh-sync/v1/objects/${hash}`, { headers })
  assert.equal(got.status, 200)
  assert.equal(Buffer.from(await got.arrayBuffer()).toString('utf8'), 'peer object content')

  const manifest = createDeviceManifest({
    deviceId: 'peer-device-1',
    deviceName: 'peer',
    entries: new Map(),
    tombstones: new Map(),
    now: Date.now(),
  })
  const putManifest = await call(harness.origin, '/dsh-sync/v1/devices/peer-device-1', {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  })
  assert.equal(putManifest.status, 200)
  const getManifest = await call(harness.origin, '/dsh-sync/v1/devices/peer-device-1', { headers })
  assert.equal(getManifest.status, 200)
  assert.equal(getManifest.body.deviceId, 'peer-device-1')
  assert.equal((await call(harness.origin, '/dsh-sync/v1/devices/peer-device-1', {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'bad' }),
  })).status, 400)
  assert.equal((await call(harness.origin, '/dsh-sync/v1/devices/missing', { headers })).status, 404)
  assert.equal((await call(harness.origin, `/dsh-sync/v1/objects/${'0'.repeat(64)}`, { headers })).status, 404)
})

test('真实 peer 后端：origin 与完整协议根都能连', async (t) => {
  const device = await startDevice(t)
  const harness = await startHarness(t)
  device.setOrigin(harness.origin)
  const dispose = attachRoutes(harness.webServer, { engine: device.engine, store: device.store, logger: silentLogger })
  t.after(dispose)
  uiToken = device.store.uiToken

  for (const url of [harness.origin, `${harness.origin}/dsh-sync/v1`, `${harness.origin}/dsh-sync`]) {
    const backend = await createBackend({
      id: 'peer',
      type: 'peer',
      url,
      token: device.store.config.peerToken,
      enabled: true,
    }, { logger: silentLogger })
    const tested = await backend.test()
    assert.equal(tested.ok, true, `url=${url} 应可连接：${tested.detail}`)
    await backend.close?.()
  }

  const wrong = await createBackend({
    id: 'peer',
    type: 'peer',
    url: harness.origin,
    token: 'wrong',
    enabled: true,
  }, { logger: silentLogger })
  const failed = await wrong.test()
  assert.equal(failed.ok, false, '错误令牌必须测试失败')
  await wrong.close?.()
})

test('HTTP API：导出支持 scope=full，默认仍是 roots（向后兼容）', async (t) => {
  const device = await startDevice(t)
  const harness = await startHarness(t)
  device.setOrigin(harness.origin)
  const dispose = attachRoutes(harness.webServer, { engine: device.engine, store: device.store, logger: silentLogger })
  t.after(dispose)
  uiToken = device.store.uiToken

  // 默认（空 body）：保持旧行为
  const plain = await call(harness.origin, '/dsh-sync/api/export', { method: 'POST', body: '{}' })
  assert.equal(plain.status, 200)
  assert.equal(plain.body.scope, 'roots', '未指定 scope 时必须仍是 roots')
  assert.ok(typeof plain.body.url === 'string' && plain.body.url.startsWith('/dsh-sync/api/download/'))

  // scope=full：返回 full 并带工作区报告
  const full = await call(harness.origin, '/dsh-sync/api/export', {
    method: 'POST',
    body: JSON.stringify({ scope: 'full' }),
  })
  assert.equal(full.status, 200)
  assert.equal(full.body.scope, 'full')
  assert.ok(full.body.workspaces, 'full 必须返回工作区报告')
  assert.ok(typeof full.body.workspaces.budget === 'number', '报告应含预算')

  // 下载链接真实可用
  const download = await fetch(`${harness.origin}${full.body.url}`, { headers: { 'x-dsh-sync-ui-token': uiToken } })
  assert.equal(download.status, 200)
  const bytes = Buffer.from(await download.arrayBuffer())
  assert.equal(bytes.byteLength, full.body.size, '下载字节数必须与报告一致')
})
