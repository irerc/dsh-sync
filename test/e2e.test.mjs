/**
 * 端到端测试：真实 `lib/` 模块 + 临时 DSH_HOME，验证多设备收敛。
 *
 * 覆盖（任务阶段 B）：
 *   E1 双设备同一 local store：新增 / 修改 / 删除 / 冲突副本 / 幂等收敛
 *   E2 导出归档 → 本地改文件 → 导入 → 再同步收敛
 *   E3 WebDAV mock 上跑关键链路（A→B→A）
 *   E4 peer 双实例直连：真实 `attachRoutes` + 真实 `createBackend('peer')`
 *   E5 manifest 路径穿越 / 非法 hash 被拒绝，不写出 root
 *   E6 超大文件按 maxFileBytes 跳过，不进入 manifest
 *
 * 运行：node --test test/e2e.test.mjs
 *
 * 断言只依赖 SPEC 语义与引擎返回字段，不硬编码内部实现细节；
 * 失败时保留临时目录路径（sandbox.root）并在错误信息里指明。
 */

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import { attachRoutes } from '../lib/http-api.js'
import { SyncEngine } from '../lib/engine/engine.js'
import { SyncStore } from '../lib/state.js'
import {
  createSandboxPair,
  exists,
  sha256Hex,
  writeText,
} from './support/fakes.mjs'
import { startMockWebdav } from './support/mock-webdav.mjs'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

/**
 * 用真实 SyncStore + SyncEngine 造一台“设备”。
 * 所有自动任务关闭，测试里显式调 sync，避免 timer 干扰。
 */
async function makeDevice(sandbox, { name, roots, targets }) {
  const store = new SyncStore({
    homeDir: sandbox.dshHome,
    logger: silentLogger,
    env: sandbox.env,
  })
  await store.load()
  const engine = new SyncEngine({ store, logger: silentLogger })
  const { config, warnings } = await engine.updateConfig({
    deviceName: name,
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    roots,
    targets,
  })
  return { store, engine, config, warnings }
}

function dataRoot(sandbox) {
  return { id: 'data', label: '数据', path: sandbox.workspace, enabled: true, exclude: [] }
}

function localTarget(storePath) {
  return { id: 'local', type: 'local', label: '本地', enabled: true, path: storePath }
}

/** 调用一次同步并返回唯一 target 的 report。 */
async function syncReport(engine, mode = 'auto') {
  const result = await engine.sync({ mode, trigger: 'test' })
  assert.equal(result.reports.length, 1, `期望 1 个 target 报告，实际 ${result.reports.length}`)
  return result.reports[0]
}

/** 断言“没有新动作”的幂等状态。 */
function assertIdle(report, label) {
  const detail = `${label}: ${JSON.stringify({
    ok: report.ok,
    pushed: report.pushed,
    pulled: report.pulled,
    deletedLocal: report.deletedLocal,
    tombstoned: report.tombstoned,
    conflicts: report.conflicts,
    errors: report.errors,
    error: report.error,
  })}`
  assert.equal(report.ok, true, detail)
  assert.equal(report.pushed, 0, detail)
  assert.equal(report.pulled, 0, detail)
  assert.equal(report.deletedLocal, 0, detail)
  assert.equal(report.tombstoned, 0, detail)
  assert.equal(report.conflicts, 0, detail)
  assert.equal(report.errors, 0, detail)
}

/** 读取目录下文件内容（只读一层，测试目录都是扁平的冲突副本场景）。 */
async function readAll(dir) {
  const names = await fsp.readdir(dir)
  const out = {}
  for (const name of names) {
    const abs = path.join(dir, name)
    if ((await fsp.stat(abs)).isFile()) out[name] = await fsp.readFile(abs, 'utf8')
  }
  return out
}

/* ------------------------------------------------------------------ */
/* E1：local 双设备                                                    */
/* ------------------------------------------------------------------ */

test('E2E local：双设备同一 store 的新增/修改/删除/冲突/幂等收敛', async (t) => {
  const pair = await createSandboxPair()
  t.after(() => pair.cleanup())
  const A = await makeDevice(pair.a, {
    name: 'device-a',
    roots: [dataRoot(pair.a)],
    targets: [localTarget(pair.store)],
  })
  const B = await makeDevice(pair.b, {
    name: 'device-b',
    roots: [dataRoot(pair.b)],
    targets: [localTarget(pair.store)],
  })
  assert.notEqual(A.store.deviceId, B.store.deviceId, '两台设备 deviceId 必须不同')

  // ── 新增 ─────────────────────────────────────────────────────
  await writeText(path.join(pair.a.workspace, 'a.txt'), 'hello-a')
  await writeText(path.join(pair.a.workspace, 'sub/b.json'), '{"b":1}')
  const r1 = await syncReport(A.engine)
  assert.equal(r1.ok, true, r1.error ?? '')
  assert.equal(r1.pushed, 2)
  assert.equal(r1.pulled, 0)

  const r2 = await syncReport(B.engine)
  assert.equal(r2.pulled, 2)
  assert.equal(r2.pushed, 0)
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'a.txt'), 'utf8'), 'hello-a')
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'sub/b.json'), 'utf8'), '{"b":1}')

  // store 里应有对象与两份设备 manifest
  const storeDevices = (await fsp.readdir(path.join(pair.store, 'devices'))).sort()
  assert.deepEqual(storeDevices, [`${A.store.deviceId}.json`, `${B.store.deviceId}.json`].sort())

  // ── 修改 ─────────────────────────────────────────────────────
  await writeText(path.join(pair.b.workspace, 'a.txt'), 'hello-b')
  const rB1 = await syncReport(B.engine)
  assert.equal(rB1.pushed, 1)
  const rA1 = await syncReport(A.engine)
  assert.equal(rA1.pulled, 1)
  assert.equal(await fsp.readFile(path.join(pair.a.workspace, 'a.txt'), 'utf8'), 'hello-b')

  // ── 删除 ─────────────────────────────────────────────────────
  await fsp.unlink(path.join(pair.a.workspace, 'sub/b.json'))
  const rA2 = await syncReport(A.engine)
  assert.equal(rA2.tombstoned, 1)
  const rB2 = await syncReport(B.engine)
  assert.equal(rB2.deletedLocal, 1)
  await assert.rejects(fsp.stat(path.join(pair.b.workspace, 'sub/b.json')))
  // 再同步一轮不会复活
  const rBIdle = await syncReport(B.engine)
  assert.equal(rBIdle.pulled, 0)
  assert.equal(rBIdle.deletedLocal, 0)
  await assert.rejects(fsp.stat(path.join(pair.b.workspace, 'sub/b.json')))

  // ── 双方同时改同一文件：冲突副本 ─────────────────────────────
  await writeText(path.join(pair.a.workspace, 'a.txt'), 'A-version')
  await writeText(path.join(pair.b.workspace, 'a.txt'), 'B-version')
  const rA3 = await syncReport(A.engine)
  assert.equal(rA3.pushed, 1)
  const rB3 = await syncReport(B.engine)
  assert.equal(rB3.conflicts, 1, 'B 应识别 1 次冲突')
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'a.txt'), 'utf8'), 'B-version')

  const filesB = await readAll(pair.b.workspace)
  const copiesB = Object.keys(filesB).filter((name) => name.includes('.conflict-'))
  assert.equal(copiesB.length, 1, `B 冲突副本数量：${JSON.stringify(Object.keys(filesB))}`)
  assert.equal(filesB[copiesB[0]], 'A-version', '冲突副本必须保留远端内容')
  assert.equal(B.store.state.conflicts.length, 1, '冲突必须记录到 state.conflicts')
  assert.ok(
    B.store.state.conflicts[0].copy.includes('.conflict-'),
    `conflicts 记录 copy 字段：${JSON.stringify(B.store.state.conflicts[0])}`,
  )

  // ── 第二轮：交叉收敛 ─────────────────────────────────────────
  const rA4 = await syncReport(A.engine)
  assert.equal(rA4.pulled, 2, 'A 应拉取远端胜出版本 + 冲突副本')
  const rB4 = await syncReport(B.engine)
  assert.equal(rB4.pulled, 0)
  assert.equal(
    await fsp.readFile(path.join(pair.a.workspace, 'a.txt'), 'utf8'),
    'B-version',
    '较新的远端内容胜出',
  )

  // 两台设备都拿到两份内容（本地优先版本 + 冲突副本），且副本数量稳定
  const finalA = await readAll(pair.a.workspace)
  const finalB = await readAll(pair.b.workspace)
  assert.equal(Object.keys(finalA).filter((n) => n.includes('.conflict-')).length, 1)
  assert.equal(Object.keys(finalB).filter((n) => n.includes('.conflict-')).length, 1)
  const copyNameA = Object.keys(finalA).find((n) => n.includes('.conflict-'))
  assert.equal(finalA[copyNameA], 'A-version', 'A 侧也必须保留 A-version')

  // 连续两轮空转：幂等
  assertIdle(await syncReport(A.engine), 'A 收敛后第 1 轮')
  assertIdle(await syncReport(A.engine), 'A 收敛后第 2 轮')
  assertIdle(await syncReport(B.engine), 'B 收敛后第 1 轮')
  assertIdle(await syncReport(B.engine), 'B 收敛后第 2 轮')

  // ── E2：导出 → 改本地 → 导入 → 再同步收敛 ───────────────────
  const exported = await A.engine.exportArchive()
  assert.equal(exported.ok, true)
  assert.match(exported.name, /\.dshsync$/)
  assert.ok(exported.size > 0, `归档大小应 > 0，实际 ${exported.size}`)
  assert.equal(await exists(exported.path), true)
  const archiveBytes = await fsp.readFile(exported.path)
  assert.equal(archiveBytes.byteLength, exported.size)

  const aContent = await fsp.readFile(path.join(pair.a.workspace, 'a.txt'), 'utf8')
  await writeText(path.join(pair.b.workspace, 'a.txt'), 'B-local-only')
  const imported = await B.engine.importArchive({ bytes: archiveBytes, name: exported.name })
  assert.equal(imported.ok, true)
  assert.equal(imported.imported, 1, '只有 a.txt 内容需要覆盖')
  assert.ok(imported.conflicts >= 1, `导入应留下本地副本，实际 ${imported.conflicts}`)
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'a.txt'), 'utf8'), aContent)

  const afterImport = await readAll(pair.b.workspace)
  const localBackups = Object.keys(afterImport).filter((name) => name.includes('.conflict-local-'))
  assert.equal(localBackups.length, 1, `导入备份文件：${JSON.stringify(Object.keys(afterImport))}`)
  assert.equal(afterImport[localBackups[0]], 'B-local-only', '导入前的本地内容必须留档')

  // 备份文件作为新文件上传，另一端拉取后收敛
  const rB5 = await syncReport(B.engine)
  assert.ok(rB5.pushed >= 1, `导入备份应上传，实际 pushed=${rB5.pushed}`)
  const rA5 = await syncReport(A.engine)
  assert.ok(rA5.pulled >= 1, `A 应拉取导入备份，实际 pulled=${rA5.pulled}`)
  assert.equal(await fsp.readFile(path.join(pair.a.workspace, 'a.txt'), 'utf8'), aContent)

  assertIdle(await syncReport(B.engine), '导入后 B 空转')
  assertIdle(await syncReport(A.engine), '导入后 A 空转')
})

/* ------------------------------------------------------------------ */
/* E3：WebDAV mock                                                     */
/* ------------------------------------------------------------------ */

test('E2E WebDAV：mock 上 A→B→A 关键链路与对象去重', async (t) => {
  const dav = await startMockWebdav({ username: 'u', password: 'p' })
  const pair = await createSandboxPair()
  t.after(async () => {
    await pair.cleanup()
    await dav.close()
  })

  const davTarget = () => ({
    id: 'dav',
    type: 'webdav',
    label: 'WebDAV',
    enabled: true,
    url: dav.url,
    username: 'u',
    password: 'p',
    basePath: '/dsh-sync',
  })
  const A = await makeDevice(pair.a, {
    name: 'dav-a',
    roots: [dataRoot(pair.a)],
    targets: [davTarget()],
  })
  const B = await makeDevice(pair.b, {
    name: 'dav-b',
    roots: [dataRoot(pair.b)],
    targets: [davTarget()],
  })

  await writeText(path.join(pair.a.workspace, 'hello.txt'), 'dav-a')
  const rA1 = await syncReport(A.engine)
  assert.equal(rA1.ok, true, rA1.error ?? '')
  assert.equal(rA1.pushed, 1)

  const rB1 = await syncReport(B.engine)
  assert.equal(rB1.ok, true, rB1.error ?? '')
  assert.equal(rB1.pulled, 1)
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'hello.txt'), 'utf8'), 'dav-a')

  await writeText(path.join(pair.b.workspace, 'hello.txt'), 'dav-b')
  const rB2 = await syncReport(B.engine)
  assert.equal(rB2.pushed, 1)
  const rA2 = await syncReport(A.engine)
  assert.equal(rA2.pulled, 1)
  assert.equal(await fsp.readFile(path.join(pair.a.workspace, 'hello.txt'), 'utf8'), 'dav-b')

  // 对象按内容去重：两个版本各 PUT 一次，共 2 次
  const objectPuts = dav.requests.filter(
    (item) => item.method === 'PUT' && item.path.startsWith('/dsh-sync/objects/'),
  )
  assert.equal(objectPuts.length, 2, `对象 PUT 次数=${objectPuts.length}，路径=${objectPuts.map((p) => p.path).join(',')}`)

  // 协议覆盖：init 的 MKCOL、写对象 PUT、读对象 GET、PROPFIND 列表。
  // HEAD 只作为“服务端不支持对象清单 / PROPFIND 失败”时的回退路径，不再是必经路径。
  const methods = new Set(dav.requests.map((item) => item.method))
  for (const method of ['MKCOL', 'PUT', 'GET', 'PROPFIND']) {
    assert.ok(methods.has(method), `WebDAV 请求应包含 ${method}，实际 ${[...methods].sort().join(',')}`)
  }
  // 回归守卫：旧实现每个对象 2 次 HEAD（本用例即 4 次）。对象清单可用时应为 0，
  // 回退路径最多每对象 1 次，因此用“不超过对象 PUT 次数”卡住双重探测回归。
  const headCalls = dav.requests.filter((item) => item.method === 'HEAD')
  assert.ok(
    headCalls.length <= objectPuts.length,
    `HEAD 次数=${headCalls.length}，超过对象数（疑似恢复成逐对象双重探测）`,
  )

  // 两份设备 manifest
  assert.ok(dav.files.has(`/dsh-sync/devices/${A.store.deviceId}.json`))
  assert.ok(dav.files.has(`/dsh-sync/devices/${B.store.deviceId}.json`))

  // 幂等
  assertIdle(await syncReport(A.engine), 'WebDAV A 空转')
  assertIdle(await syncReport(B.engine), 'WebDAV B 空转')
})

/* ------------------------------------------------------------------ */
/* E4：peer 直连（真实 attachRoutes + 真实 createBackend('peer')）       */
/* ------------------------------------------------------------------ */

/**
 * 最小 node:http 壳：只实现 attachRoutes 需要的 register/getOrigin 契约。
 * 这样 peer 协议走真实 lib/http-api.js，而不是测试仿造。
 */
function createHttpShell() {
  const routes = []
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = routes.find(
      (item) => pathname === item.path || pathname.startsWith(`${item.path}/`),
    )
    if (!route) {
      res.statusCode = 404
      res.setHeader('content-type', 'text/plain; charset=utf-8')
      res.end('not found')
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(String(error?.message ?? error))
      } else {
        res.destroy()
      }
    })
  })
  let origin = ''
  const webServer = {
    register({ path: prefix, handler }) {
      const entry = { path: prefix, handler }
      routes.push(entry)
      return () => {
        const index = routes.indexOf(entry)
        if (index >= 0) routes.splice(index, 1)
      }
    },
    getOrigin() {
      return origin
    },
  }
  return {
    webServer,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      origin = `http://127.0.0.1:${server.address().port}`
      return origin
    },
    get origin() {
      return origin
    },
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

test('E2E peer：真实 HTTP API 直连，双实例收敛且 token 失败不破坏数据', async (t) => {
  const pair = await createSandboxPair()
  const shell = createHttpShell()
  t.after(async () => {
    await shell.close()
    await pair.cleanup()
  })

  // A：把自己的文件发布到 peerStorePath（这正是 peer 服务端暴露的目录）。
  // 先建 store 拿到 peerStorePath，再配置 local target；两步都在真实 API 上完成。
  const A = await makeDevice(pair.a, {
    name: 'peer-a',
    roots: [dataRoot(pair.a)],
    targets: [],
  })
  await A.engine.updateConfig({
    targets: [
      { id: 'publish', type: 'local', label: '发布到 peer store', enabled: true, path: A.store.config.peerStorePath },
    ],
  })

  const dispose = attachRoutes(shell.webServer, {
    engine: A.engine,
    store: A.store,
    logger: silentLogger,
  })
  t.after(() => dispose())
  const origin = await shell.listen()

  // ping 免 token，且返回真实 deviceId
  const pingRes = await fetch(`${origin}/dsh-sync/v1/ping`)
  assert.equal(pingRes.status, 200)
  const ping = await pingRes.json()
  assert.equal(ping.ok, true)
  assert.equal(ping.protocol, 1)
  assert.equal(ping.deviceId, A.store.deviceId)
  assert.equal(ping.requiresToken, true)

  // B：peer target 指向 A 的完整协议根（Lead 决策 A：复制即用，不重复拼接）
  const peerTarget = (url, token) => ({
    id: 'peer',
    type: 'peer',
    label: 'A 设备',
    enabled: true,
    url,
    token,
  })
  const B = await makeDevice(pair.b, {
    name: 'peer-b',
    roots: [dataRoot(pair.b)],
    targets: [peerTarget(`${origin}/dsh-sync/v1`, A.store.config.peerToken)],
  })

  // A 发布 → B 通过真实 peer 后端拉取
  await writeText(path.join(pair.a.workspace, 'a.txt'), 'from-a')
  const rA1 = await syncReport(A.engine)
  assert.equal(rA1.ok, true, rA1.error ?? '')
  assert.equal(rA1.pushed, 1)

  const rB1 = await syncReport(B.engine)
  assert.equal(rB1.ok, true, rB1.error ?? '')
  assert.equal(rB1.pulled, 1)
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'a.txt'), 'utf8'), 'from-a')

  // B 修改并推回 A 的 peer store，A 再拉取
  await writeText(path.join(pair.b.workspace, 'b.txt'), 'from-b')
  const rB2 = await syncReport(B.engine)
  assert.equal(rB2.ok, true, rB2.error ?? '')
  assert.ok(rB2.pushed >= 1)
  const rA2 = await syncReport(A.engine)
  assert.equal(rA2.ok, true, rA2.error ?? '')
  assert.equal(rA2.pulled, 1)
  assert.equal(await fsp.readFile(path.join(pair.a.workspace, 'b.txt'), 'utf8'), 'from-b')

  // A 的 peer store 里应有 B 的 manifest（说明真实 PUT 落盘）
  assert.equal(
    await exists(path.join(A.store.config.peerStorePath, 'devices', `${B.store.deviceId}.json`)),
    true,
  )

  // 幂等两轮
  assertIdle(await syncReport(B.engine), 'peer B 空转')
  assertIdle(await syncReport(A.engine), 'peer A 空转')

  // 错误 token：init 阶段 401，报告失败且不破坏已有数据
  const objectsBefore = (await fsp.readdir(path.join(A.store.config.peerStorePath, 'objects'))).sort()
  await B.engine.updateConfig({
    targets: [peerTarget(`${origin}/dsh-sync/v1`, '0'.repeat(32))],
  })
  const bad = await syncReport(B.engine)
  assert.equal(bad.ok, false, '错误 token 必须失败')
  assert.match(String(bad.error ?? ''), /401|令牌|token/i, `错误信息应可读：${bad.error}`)
  const objectsAfter = (await fsp.readdir(path.join(A.store.config.peerStorePath, 'objects'))).sort()
  assert.deepEqual(objectsAfter, objectsBefore, '失败同步不得写坏对端对象')
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'b.txt'), 'utf8'), 'from-b')

  // 恢复 token，并改用 origin（不带 /dsh-sync/v1）：后端归一化后仍应幂等成功
  await B.engine.updateConfig({ targets: [peerTarget(origin, A.store.config.peerToken)] })
  assertIdle(await syncReport(B.engine), 'peer 恢复 origin 写法')
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'a.txt'), 'utf8'), 'from-a')
})

/* ------------------------------------------------------------------ */
/* E5：恶意 manifest                                                   */
/* ------------------------------------------------------------------ */

test('E2E 安全：manifest 路径穿越与非法 hash 被拒绝，不写出 root', async (t) => {
  const pair = await createSandboxPair()
  t.after(() => pair.cleanup())
  const A = await makeDevice(pair.a, {
    name: 'safe-a',
    roots: [dataRoot(pair.a)],
    targets: [localTarget(pair.store)],
  })
  await writeText(path.join(pair.a.workspace, 'safe.txt'), 'safe')
  const first = await syncReport(A.engine)
  assert.equal(first.ok, true, first.error ?? '')
  assert.equal(first.pushed, 1)

  // 直接往 store 写一份恶意 manifest（模拟被入侵/不可信的上游设备）
  const evil = Buffer.from('evil')
  const evilHash = sha256Hex(evil)
  await fsp.mkdir(path.join(pair.store, 'objects'), { recursive: true })
  await fsp.writeFile(path.join(pair.store, 'objects', evilHash), evil)
  const now = Date.now()
  const malicious = {
    format: 'dsh-sync-manifest',
    version: 1,
    deviceId: 'mallory1',
    deviceName: 'mallory',
    generatedAt: now,
    entries: [
      {
        key: 'data/../escape.txt',
        root: 'data',
        path: '../escape.txt',
        hash: evilHash,
        size: evil.length,
        mtimeMs: now,
        updatedAt: now + 10000,
        deviceId: 'mallory1',
      },
      {
        key: 'data/C:/abs.txt',
        root: 'data',
        path: 'C:/abs.txt',
        hash: evilHash,
        size: evil.length,
        mtimeMs: now,
        updatedAt: now + 10000,
        deviceId: 'mallory1',
      },
      {
        key: 'data/a\\b.txt',
        root: 'data',
        path: 'a\\b.txt',
        hash: evilHash,
        size: evil.length,
        mtimeMs: now,
        updatedAt: now + 10000,
        deviceId: 'mallory1',
      },
      {
        key: 'data/badhash.txt',
        root: 'data',
        path: 'badhash.txt',
        hash: 'not-a-sha256',
        size: evil.length,
        mtimeMs: now,
        updatedAt: now + 10000,
        deviceId: 'mallory1',
      },
    ],
    tombstones: [],
  }
  await fsp.writeFile(
    path.join(pair.store, 'devices', 'mallory1.json'),
    `${JSON.stringify(malicious, null, 2)}\n`,
  )

  const second = await syncReport(A.engine)
  assert.equal(second.errors, 0, `恶意条目应被静默跳过而不是崩溃：${second.error ?? ''}`)
  assert.equal(second.ok, true)

  // root 外/root 内都不得出现穿越文件
  const outside = path.resolve(pair.a.workspace, '..', 'escape.txt')
  assert.equal(await exists(outside), false, `不得写出 root：${outside}`)
  assert.equal(await exists(path.join(pair.a.workspace, 'escape.txt')), false)
  assert.equal(await exists(path.join(pair.a.workspace, 'abs.txt')), false)
  assert.equal(await exists(path.join(pair.a.workspace, 'badhash.txt')), false)
  assert.equal(await exists(path.join(pair.a.workspace, 'a\\b.txt')), false)

  const files = (await fsp.readdir(pair.a.workspace)).sort()
  assert.deepEqual(files, ['safe.txt'], `root 只应有安全文件，实际 ${JSON.stringify(files)}`)

  // 无效条目被计数并记日志
  assert.ok(
    A.store.state.logs.some((item) => String(item.message ?? '').includes('无效记录')),
    `应记录无效 manifest 条目，日志：${JSON.stringify(A.store.state.logs.slice(-5))}`,
  )

  // 恶意 manifest 不影响本机清单继续有效
  const ownManifest = JSON.parse(
    await fsp.readFile(path.join(pair.store, 'devices', `${A.store.deviceId}.json`), 'utf8'),
  )
  assert.equal(ownManifest.format, 'dsh-sync-manifest')
  assert.deepEqual(ownManifest.entries.map((entry) => entry.key), ['data/safe.txt'])

  assertIdle(await syncReport(A.engine), '恶意 manifest 后空转')
})

/* ------------------------------------------------------------------ */
/* E6：超大文件                                                        */
/* ------------------------------------------------------------------ */

test('E2E 大小限制：超过 maxFileBytes 的文件被跳过且不进入 manifest', async (t) => {
  const pair = await createSandboxPair()
  t.after(() => pair.cleanup())
  const maxFileBytes = 64 * 1024 // normalizeConfig 的最小值
  const A = await makeDevice(pair.a, {
    name: 'size-a',
    roots: [dataRoot(pair.a)],
    targets: [localTarget(pair.store)],
  })
  await A.engine.updateConfig({ maxFileBytes })
  const B = await makeDevice(pair.b, {
    name: 'size-b',
    roots: [dataRoot(pair.b)],
    targets: [localTarget(pair.store)],
  })
  await B.engine.updateConfig({ maxFileBytes })

  await writeText(path.join(pair.a.workspace, 'small.txt'), 'small')
  await writeText(path.join(pair.a.workspace, 'big.bin'), 'x'.repeat(maxFileBytes + 1024))

  const rA = await syncReport(A.engine)
  assert.equal(rA.ok, true, rA.error ?? '')
  assert.equal(rA.pushed, 1, `只有 small.txt 应上传，实际 pushed=${rA.pushed}`)
  assert.equal(rA.skipped, 1, `应有 1 个超限文件被跳过，实际 skipped=${rA.skipped}`)

  const rB = await syncReport(B.engine)
  assert.equal(rB.pulled, 1)
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'small.txt'), 'utf8'), 'small')
  assert.equal(await exists(path.join(pair.b.workspace, 'big.bin')), false, '超限文件不得出现在对端')

  // manifest 里只有 small.txt
  const manifest = JSON.parse(
    await fsp.readFile(path.join(pair.store, 'devices', `${A.store.deviceId}.json`), 'utf8'),
  )
  assert.deepEqual(manifest.entries.map((entry) => entry.key), ['data/small.txt'])

  assert.ok(
    A.store.state.logs.some((item) => String(item.message ?? '').includes('已跳过 1 个超过')),
    `应记录跳过日志，日志：${JSON.stringify(A.store.state.logs.slice(-5))}`,
  )

  assertIdle(await syncReport(A.engine), '超限场景 A 空转')
  assertIdle(await syncReport(B.engine), '超限场景 B 空转')
})

test('E2E 速率统计：上传/下载实传字节与双向速率都记在结果里', async (t) => {
  const dav = await startMockWebdav({ username: 'u', password: 'p' })
  const pair = await createSandboxPair()
  t.after(async () => {
    await pair.cleanup()
    await dav.close()
  })

  const davTarget = () => ({
    id: 'dav',
    type: 'webdav',
    label: 'WebDAV',
    enabled: true,
    url: dav.url,
    username: 'u',
    password: 'p',
    basePath: '/dsh-sync',
  })
  const A = await makeDevice(pair.a, { name: 'rate-a', roots: [dataRoot(pair.a)], targets: [davTarget()] })
  const B = await makeDevice(pair.b, { name: 'rate-b', roots: [dataRoot(pair.b)], targets: [davTarget()] })

  // 不压缩也不可压缩的内容：实传字节应与原始字节同量级，避免断言被 gzip 倍数误导。
  const payload = Buffer.alloc(400 * 1024)
  for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7) % 251
  await fsp.writeFile(path.join(pair.a.workspace, 'blob.bin'), payload)

  const up = await syncReport(A.engine)
  assert.equal(up.ok, true, up.error ?? '')
  assert.equal(up.pushed, 1)
  assert.ok(up.wireBytesUp > 0, `上传实传字节应大于 0，实际 ${up.wireBytesUp}`)
  assert.ok(up.upBytesPerSecond > 0, `上传速率应大于 0，实际 ${up.upBytesPerSecond}`)

  const down = await syncReport(B.engine)
  assert.equal(down.ok, true, down.error ?? '')
  assert.equal(down.pulled, 1)
  assert.ok(down.wireBytesDown > 0, `下载实传字节应大于 0，实际 ${down.wireBytesDown}`)
  assert.ok(down.downBytesPerSecond > 0, `下载速率应大于 0，实际 ${down.downBytesPerSecond}`)
  // 两边统计的是同一份对象，实传字节必须一致（压缩形态相同）。
  assert.equal(down.wireBytesDown, up.wireBytesUp, '同一对象的上下行实传字节应一致')
  assert.equal(await fsp.readFile(path.join(pair.b.workspace, 'blob.bin')).then((b) => b.equals(payload)), true)
})

test('E2E 实时进度：同步中 status().progress 带双向速率，结束后清空', async (t) => {
  const pair = await createSandboxPair()
  t.after(() => pair.cleanup())
  // makeDevice 不注入 backendFactory，这里手工建：慢后端在写入期间留住时间窗口，
  // 好读到“同步中”的快照。
  const store = new SyncStore({ homeDir: pair.a.dshHome, logger: silentLogger, env: pair.a.env })
  await store.load()
  const A = {
    store,
    engine: new SyncEngine({
      store,
      logger: silentLogger,
      backendFactory: async () => ({
        init: async () => {},
        test: async () => ({ ok: true, detail: 'memory' }),
        close: async () => {},
        listDevices: async () => [],
        readManifest: async () => null,
        writeManifest: async () => {},
        readObject: async (hash) => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          return Buffer.from(`obj-${hash}`)
        },
        writeObject: async (hash, bytes) => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          return { skipped: false, size: bytes.byteLength, storedBytes: bytes.byteLength }
        },
        deleteObject: async () => {},
        listTombstones: async () => [],
        writeTombstone: async () => {},
      }),
    }),
  }
  await A.engine.updateConfig({
    deviceName: 'live-a',
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    roots: [dataRoot(pair.a)],
    targets: [{ id: 'mem', type: 'local', label: 'mem', enabled: true, path: pair.a.at('store') }],
  })

  await writeText(path.join(pair.a.workspace, 'live.txt'), 'live-progress')
  const running = A.engine.sync({ mode: 'push' })
  // 给它一点时间进入同步态，再读 status。轮询而不是硬等一个固定值，避免机器快慢导致偶发失败。
  let snapshot = null
  for (let i = 0; i < 40 && !snapshot; i += 1) {
    const status = await A.engine.status()
    if (status.busy && status.progress) snapshot = status.progress
    else await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const result = await running
  assert.equal(result.ok, true)
  assert.ok(snapshot, '同步中必须能读到 progress')
  assert.ok(Number.isFinite(snapshot.wireBytesUp), 'progress 应带上传字节')
  assert.ok(Number.isFinite(snapshot.upBytesPerSecond), 'progress 应带上传速率')
  assert.ok(Number.isFinite(snapshot.downBytesPerSecond), 'progress 应带下载速率')
  assert.ok(snapshot.elapsedMs > 0, 'progress 应带已用时间')

  const after = await A.engine.status()
  assert.equal(after.progress, null, '同步结束后 progress 必须清空')
})

test('默认配置：WebDAV 已启用但未填地址时，同步给出明确提示且不抛错', async (t) => {
  const pair = await createSandboxPair()
  t.after(() => pair.cleanup())
  const store = new SyncStore({ homeDir: pair.a.dshHome, logger: silentLogger, env: pair.a.env })
  await store.load()
  const engine = new SyncEngine({ store, logger: silentLogger })
  // 只改非目标字段：目标用默认值（WebDAV 启用、地址为空）。
  await engine.updateConfig({ deviceName: 'fresh', autoSync: false, autoSave: false, syncOnStart: false })
  const result = await engine.sync({ mode: 'auto', trigger: 'test' })
  assert.equal(result.ok, false)
  assert.match(result.error, /WebDAV/, `提示应点名 WebDAV，实际：${result.error}`)
  assert.equal(result.reports.length, 0)
})

