/**
 * 阶段 A 夹具自测：真实 HTTP 驱动 WebDAV mock / peer mock，验证 fakes 工具。
 *
 * 这里不是业务测试，只证明“夹具本身没有说谎”：
 * 认证、状态码、PROPFIND 列表、hash 校验、落盘、快照/等待都按预期工作。
 *
 * 运行：node --test test/support/support-selftest.test.mjs
 */

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  buildConfig,
  buildSandboxConfig,
  createSandbox,
  createSandboxPair,
  diffSnapshots,
  fileHashes,
  matchesGlob,
  readConfigFile,
  readStateFile,
  sha256Hex,
  snapshot,
  waitFor,
  waitForFileText,
  writeConfigFile,
  writeFiles,
  writeJsonFile,
  makeManifest,
  makeEntryFromBytes,
  validateManifestShape,
} from './fakes.mjs'
import { joinUrl, startMockWebdav } from './mock-webdav.mjs'
import { startPeerServer } from './peer-server.mjs'

/* ------------------------------------------------------------------ */
/* WebDAV mock                                                         */
/* ------------------------------------------------------------------ */

test('mock WebDAV：认证、MKCOL、PUT/GET/HEAD/PROPFIND/DELETE 全链路', async () => {
  const dav = await startMockWebdav({ username: 'u', password: 'p' })
  try {
    const base = dav.url
    const rel = (p) => joinUrl(base, dav.basePath, p)

    // 1) OPTIONS 免认证
    const optionsRes = await fetch(`${base}${dav.basePath}`, { method: 'OPTIONS' })
    assert.equal(optionsRes.status, 200)
    assert.match(optionsRes.headers.get('dav') ?? '', /1/)

    // 2) 未认证 PUT → 401
    const anon = await fetch(rel('devices/x.json'), { method: 'PUT', body: 'x' })
    assert.equal(anon.status, 401)
    assert.match(anon.headers.get('www-authenticate') ?? '', /Basic/)

    const auth = { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` }

    // 3) MKCOL 根已存在（405 视为可用），devices/objects 新建
    assert.equal((await fetch(`${base}${dav.basePath}`, { method: 'MKCOL', headers: auth })).status, 405)
    assert.equal((await fetch(rel('devices'), { method: 'MKCOL', headers: auth })).status, 201)
    assert.equal((await fetch(rel('objects'), { method: 'MKCOL', headers: auth })).status, 201)
    // 重复 MKCOL → 405
    assert.equal((await fetch(rel('devices'), { method: 'MKCOL', headers: auth })).status, 405)

    // 4) PUT 新建 → 201；重写 → 204
    const body = Buffer.from(JSON.stringify({ format: 'dsh-sync-manifest', version: 1 }))
    const put1 = await fetch(rel('devices/dev1.json'), { method: 'PUT', headers: auth, body })
    assert.equal(put1.status, 201)
    const put2 = await fetch(rel('devices/dev1.json'), { method: 'PUT', headers: auth, body })
    assert.equal(put2.status, 204)

    // 5) GET 原样返回
    const got = await fetch(rel('devices/dev1.json'), { headers: auth })
    assert.equal(got.status, 200)
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), body)

    // 6) HEAD 存在 / 不存在
    assert.equal((await fetch(rel('devices/dev1.json'), { method: 'HEAD', headers: auth })).status, 200)
    assert.equal((await fetch(rel('devices/none.json'), { method: 'HEAD', headers: auth })).status, 404)

    // 7) PROPFIND Depth:1 列出 .json basename（后端解析契约）
    const propfind = await fetch(rel('devices'), {
      method: 'PROPFIND',
      headers: { ...auth, depth: '1' },
    })
    assert.equal(propfind.status, 207)
    const xml = await propfind.text()
    assert.match(xml, /<d:multistatus/)
    assert.match(xml, /dev1\.json/)
    assert.match(xml, /<d:collection\/>/)

    // 8) DELETE → 204，随后 404
    assert.equal((await fetch(rel('devices/dev1.json'), { method: 'DELETE', headers: auth })).status, 204)
    assert.equal((await fetch(rel('devices/dev1.json'), { method: 'HEAD', headers: auth })).status, 404)

    // 9) 请求日志可用于断言
    assert.ok(dav.requests.length >= 12)
  } finally {
    await dav.close()
  }
})

test('mock WebDAV：带路径前缀的挂载点自动预建祖先', async () => {
  const basePath = '/remote.php/dav/files/u/dsh-sync'
  const dav = await startMockWebdav({ username: '', password: '', basePath })
  try {
    assert.ok(dav.dirs.has('/remote.php'))
    assert.ok(dav.dirs.has('/remote.php/dav/files/u'))
    assert.ok(dav.dirs.has(basePath))
    // 空用户名/密码 → 免认证；MKCOL devices 直接成功
    const res = await fetch(joinUrl(dav.url, basePath, 'devices'), { method: 'MKCOL' })
    assert.equal(res.status, 201)
    const list = await fetch(joinUrl(dav.url, basePath, 'devices'), { method: 'PROPFIND', headers: { depth: '0' } })
    assert.equal(list.status, 207)
  } finally {
    await dav.close()
  }
})

test('mock WebDAV：PUT 到缺失父集合时自动补建并记录 warning', async () => {
  const dav = await startMockWebdav({ username: '', password: '' })
  try {
    const res = await fetch(joinUrl(dav.url, dav.basePath, 'devices/deep/x.json'), {
      method: 'PUT',
      body: '{}',
    })
    assert.equal(res.status, 201)
    assert.ok(dav.dirs.has(`${dav.basePath}/devices/deep`))
    assert.ok(dav.warnings.some((line) => line.includes(`${dav.basePath}/devices/deep`)))
  } finally {
    await dav.close()
  }
})

/* ------------------------------------------------------------------ */
/* peer mock                                                           */
/* ------------------------------------------------------------------ */

test('peer mock：ping 免 token，其余路由 401，manifest/object 读写与 hash 校验', async () => {
  const peer = await startPeerServer({ token: 'tok', deviceId: 'a'.repeat(32), deviceName: 'peer-a' })
  try {
    const v1 = `${peer.url}/dsh-sync/v1`

    // ping 无需 token
    const ping = await fetch(`${v1}/ping`)
    assert.equal(ping.status, 200)
    const pingBody = await ping.json()
    assert.deepEqual(
      { ok: pingBody.ok, protocol: pingBody.protocol, deviceId: pingBody.deviceId, requiresToken: pingBody.requiresToken },
      { ok: true, protocol: 1, deviceId: 'a'.repeat(32), requiresToken: true },
    )

    // 无 token → 401
    const denied = await fetch(`${v1}/devices`)
    assert.equal(denied.status, 401)
    assert.match((await denied.json()).error, /token/)

    const headers = { 'x-dsh-sync-token': 'tok' }

    // 空设备列表
    const empty = await fetch(`${v1}/devices`, { headers })
    assert.deepEqual(await empty.json(), { devices: [] })

    // PUT manifest → GET 原样
    const manifest = makeManifest({
      deviceId: 'a'.repeat(32),
      entries: [makeEntryFromBytes('profile/a.txt', 'hello', { size: 5 })],
    })
    const putManifest = await fetch(`${v1}/devices/${'a'.repeat(32)}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    })
    assert.equal(putManifest.status, 200)
    const gotManifest = await fetch(`${v1}/devices/${'a'.repeat(32)}`, { headers })
    assert.equal(gotManifest.status, 200)
    assert.equal((await gotManifest.json()).deviceId, 'a'.repeat(32))

    // 不存在 manifest → 404
    assert.equal((await fetch(`${v1}/devices/${'b'.repeat(32)}`, { headers })).status, 404)

    // object PUT/HEAD/GET
    const bytes = Buffer.from('object-bytes')
    const hash = sha256Hex(bytes)
    const putObject = await fetch(`${v1}/objects/${hash}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: bytes,
    })
    assert.equal(putObject.status, 200)
    assert.equal((await fetch(`${v1}/objects/${hash}`, { method: 'HEAD', headers })).status, 200)
    const gotObject = await fetch(`${v1}/objects/${hash}`, { headers })
    assert.deepEqual(Buffer.from(await gotObject.arrayBuffer()), bytes)
    // 缺失对象
    assert.equal((await fetch(`${v1}/objects/${'0'.repeat(64)}`, { method: 'HEAD', headers })).status, 404)
    // hash 不匹配 → 400
    const bad = await fetch(`${v1}/objects/${'1'.repeat(64)}`, { method: 'PUT', headers, body: bytes })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /mismatch/)
    // 非法 hash → 400
    assert.equal((await fetch(`${v1}/objects/not-a-hash`, { method: 'PUT', headers, body: bytes })).status, 400)
  } finally {
    await peer.close()
  }
})

test('peer mock：storePath 落盘并在重启后保留', async () => {
  const sandbox = await createSandbox({ prefix: 'dsh-sync-peer-store-' })
  try {
    const storePath = path.join(sandbox.root, 'peer-store')
    const token = 'tok2'
    const deviceId = 'c'.repeat(32)
    const first = await startPeerServer({ token, deviceId, storePath })
    const v1 = `${first.url}/dsh-sync/v1`
    const headers = { 'x-dsh-sync-token': token }
    const manifest = makeManifest({ deviceId, entries: [] })
    assert.equal(
      (await fetch(`${v1}/devices/${deviceId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(manifest),
      })).status,
      200,
    )
    const bytes = Buffer.from('persist-me')
    const hash = sha256Hex(bytes)
    assert.equal((await fetch(`${v1}/objects/${hash}`, { method: 'PUT', headers, body: bytes })).status, 200)
    await first.close()

    // 落盘文件真实存在
    const manifestOnDisk = JSON.parse(await fsp.readFile(path.join(storePath, 'devices', `${deviceId}.json`), 'utf8'))
    assert.equal(manifestOnDisk.deviceId, deviceId)
    assert.deepEqual(await fsp.readFile(path.join(storePath, 'objects', hash)), bytes)

    // 重启后从磁盘加载
    const second = await startPeerServer({ token, deviceId: 'd'.repeat(32), storePath })
    try {
      const res = await fetch(`${second.url}/dsh-sync/v1/devices`, {
        headers: { 'x-dsh-sync-token': token },
      })
      assert.deepEqual(await res.json(), { devices: [deviceId] })
      const obj = await fetch(`${second.url}/dsh-sync/v1/objects/${hash}`, {
        headers: { 'x-dsh-sync-token': token },
      })
      assert.deepEqual(Buffer.from(await obj.arrayBuffer()), bytes)
    } finally {
      await second.close()
    }
  } finally {
    await sandbox.cleanup()
  }
})

/* ------------------------------------------------------------------ */
/* fakes                                                               */
/* ------------------------------------------------------------------ */

test('fakes：沙箱 HOME/DSH_HOME、env 应用与还原、config/state 往返', async () => {
  const sandbox = await createSandbox()
  try {
    for (const dir of [sandbox.home, sandbox.dshHome, sandbox.workspace, sandbox.profileDir]) {
      assert.equal((await fsp.stat(dir)).isDirectory(), true, dir)
    }
    assert.equal(sandbox.paths.profileDir, path.join(sandbox.dshHome, 'profiles', 'web'))

    const restore = sandbox.applyEnv()
    try {
      assert.equal(process.env.HOME, sandbox.home)
      assert.equal(process.env.DSH_HOME, sandbox.dshHome)
      assert.equal(process.env.DSH_PROFILE, 'web')
    } finally {
      restore()
    }
    assert.notEqual(process.env.DSH_HOME, sandbox.dshHome)

    const config = buildSandboxConfig(sandbox, { deviceName: 'phone' })
    assert.equal(config.deviceName, 'phone')
    assert.equal(config.roots.length, 3)
    assert.equal(config.targets.length, 3)
    assert.equal(config.roots[0].path, sandbox.profileDir)

    const file = await writeConfigFile(sandbox.dshHome, config)
    assert.match(file, /dsh-sync[/\\]config\.json$/)
    assert.deepEqual(await readConfigFile(sandbox.dshHome), config)
    assert.equal(await readStateFile(sandbox.dshHome), null)

    await writeJsonFile(sandbox.at('dsh-home/dsh-sync/state.json'), { version: 1, deviceId: 'x' })
    assert.deepEqual(await readStateFile(sandbox.dshHome), { version: 1, deviceId: 'x' })
  } finally {
    await sandbox.cleanup()
  }
})

test('fakes：buildConfig 默认值与显式 targets/roots 替换', () => {
  const config = buildConfig({ dshHome: '/tmp/x', home: '/tmp/y' })
  assert.equal(config.version, 1)
  assert.equal(config.maxFileBytes, 8388608)
  assert.deepEqual(config.targets.map((t) => t.id), ['local', 'dav', 'peer'])
  assert.equal(config.targets[0].path, path.join('/tmp/x', 'dsh-sync', 'store'))

  const custom = buildConfig({
    dshHome: '/tmp/x',
    home: '/tmp/y',
    roots: [{ id: 'only', path: '/tmp/z', label: 'z', enabled: true, exclude: [] }],
    targets: [{ id: 't1', type: 'webdav', url: 'http://h', username: 'u', password: 'p' }],
  })
  assert.deepEqual(custom.roots.map((r) => r.id), ['only'])
  assert.deepEqual(custom.targets.map((t) => t.id), ['t1'])
  assert.equal(custom.targets[0].enabled, true)
})

test('fakes：writeFiles / snapshot / diffSnapshots / glob', async () => {
  const sandbox = await createSandbox()
  try {
    await writeFiles(sandbox.workspace, {
      'a.txt': 'one',
      'nested/b.txt': 'two',
      'nested/deep/c.bin': Buffer.from([1, 2, 3]),
      'skip.log': 'ignored',
    })
    const before = await snapshot(sandbox.workspace, { exclude: ['**/*.log'] })
    assert.deepEqual(Object.keys(before.files), ['a.txt', 'nested/b.txt', 'nested/deep/c.bin'])
    assert.deepEqual(before.files['a.txt'], {
      size: 3,
      sha256: sha256Hex('one'),
      mtimeMs: before.files['a.txt'].mtimeMs,
    })

    await writeFiles(sandbox.workspace, { 'a.txt': 'one-changed', 'new/d.txt': 'four' })
    await fsp.unlink(path.join(sandbox.workspace, 'nested/b.txt'))
    const after = await snapshot(sandbox.workspace, { exclude: ['**/*.log'] })
    const diff = diffSnapshots(before, after)
    assert.deepEqual(diff.added, ['new/d.txt'])
    assert.deepEqual(diff.removed, ['nested/b.txt'])
    assert.deepEqual(diff.changed, ['a.txt'])
    assert.deepEqual(fileHashes(after)['new/d.txt'], sha256Hex('four'))

    assert.equal(matchesGlob('x/y.key', ['**/*.key']), true)
    assert.equal(matchesGlob('top.key', ['**/*.key']), true)
    assert.equal(matchesGlob('dir/a.txt', ['dir/**']), true)
    assert.equal(matchesGlob('other/a.txt', ['dir/**']), false)
  } finally {
    await sandbox.cleanup()
  }
})

test('fakes：waitFor 成功/超时信息、waitForFileText', async () => {
  const sandbox = await createSandbox()
  try {
    let count = 0
    const value = await waitFor(() => {
      count += 1
      return count >= 3 ? 'ready' : false
    }, { intervalMs: 5, label: 'counter' })
    assert.equal(value, 'ready')

    await assert.rejects(
      waitFor(() => false, { timeoutMs: 60, intervalMs: 10, label: 'never-true' }),
      (error) => {
        assert.match(error.message, /timed out after 60ms waiting for never-true/)
        assert.match(error.message, /last value: false/)
        return true
      },
    )

    const file = sandbox.at('late.txt')
    const writing = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      await writeFiles(sandbox.root, { 'late.txt': 'done' })
    })()
    await waitForFileText(file, 'done', { timeoutMs: 2000, intervalMs: 10 })
    await writing
  } finally {
    await sandbox.cleanup()
  }
})

test('fakes：createSandboxPair 共享 store 且 cleanup 安全', async () => {
  const pair = await createSandboxPair()
  try {
    assert.notEqual(pair.a.root, pair.b.root)
    assert.ok(pair.store.startsWith(pair.a.root) === false)
    await writeFiles(pair.store, { 'devices/x.json': '{}' })
    assert.equal(await fsp.readFile(path.join(pair.store, 'devices/x.json'), 'utf8'), '{}')
  } finally {
    await pair.cleanup()
  }
  await assert.rejects(fsp.stat(pair.a.root))
})

test('fakes：manifest 夹具自洽', () => {
  const bytes = Buffer.from('hello')
  const entry = makeEntryFromBytes('profile/a.txt', bytes, { updatedAt: 5 })
  const manifest = makeManifest({
    deviceId: 'e'.repeat(32),
    deviceName: 'phone',
    entries: [entry],
    tombstones: [{ key: 'sessions/old.jsonl', updatedAt: 6 }],
  })
  assert.deepEqual(validateManifestShape(manifest), [])
  assert.equal(manifest.entries[0].hash, sha256Hex(bytes))
  assert.equal(manifest.entries[0].root, 'profile')
  assert.equal(manifest.entries[0].path, 'a.txt')
  assert.equal(manifest.tombstones[0].deleted, true)
  assert.equal(manifest.tombstones[0].root, 'sessions')
})