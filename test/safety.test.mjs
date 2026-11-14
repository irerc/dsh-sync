/**
 * 数据安全回归：本机"看不见"的文件（超大、被排除、根目录禁用、对端独有根目录）
 * 绝不能被当成"本地删除"而写墓碑，从而删掉其他设备上的副本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { SyncStore } from '../lib/state.js'
import { SyncEngine } from '../lib/engine/engine.js'
import { parseArchive } from '../lib/engine/archive.js'
import { sha256Bytes } from '../lib/engine/hash.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

async function makeDevice(base, name, { maxFileBytes = 8 * 1024 * 1024, storeDir, extraRoots = [] } = {}) {
  const home = path.join(base, name)
  const root = path.join(base, name, 'data')
  await fsp.mkdir(root, { recursive: true })
  for (const extra of extraRoots) await fsp.mkdir(extra.path, { recursive: true })
  const store = new SyncStore({
    homeDir: home,
    logger: silentLogger,
    env: { ...process.env, DSH_HOME: home, HOME: base, DSH_PROFILE: 'web' },
  })
  await store.load()
  const engine = new SyncEngine({ store, logger: silentLogger })
  const roots = [
    { id: 'data', label: 'data', path: root, enabled: true, exclude: [] },
    ...extraRoots,
  ]
  await engine.updateConfig({
    deviceName: name,
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    maxFileBytes,
    roots,
    targets: [{ id: 'local', type: 'local', label: 'local', enabled: true, path: storeDir }],
  })
  return { home, root, store, engine }
}

async function sync(device) {
  const result = await device.engine.sync({ mode: 'auto', trigger: 'test' })
  return result.reports[0]
}

async function readManifest(storeDir, deviceId) {
  const raw = await fsp.readFile(path.join(storeDir, 'devices', `${deviceId}.json`), 'utf8')
  return JSON.parse(raw)
}

function tombstoneKeys(manifest) {
  return new Set((manifest.tombstones ?? []).map((item) => item.key))
}

test('超大文件：本机跳过，不墓碑对端', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsync-safe-big-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const storeDir = path.join(base, 'store')
  const A = await makeDevice(base, 'A', { maxFileBytes: 64 * 1024, storeDir })
  const B = await makeDevice(base, 'B', { storeDir })

  await fsp.writeFile(path.join(B.root, 'large.bin'), Buffer.alloc(70 * 1024, 7))
  const bPush = await sync(B)
  assert.equal(bPush.pushed, 1)
  // A 本地也有一个超大文件（内容不同）：扫描会跳过它，但绝不能因此墓碑掉 B 的副本。
  await fsp.writeFile(path.join(A.root, 'large.bin'), Buffer.alloc(70 * 1024, 9))

  const aReport = await sync(A)
  assert.equal(aReport.skipped, 1)
  assert.equal(aReport.tombstoned, 0, '超大文件不能产生墓碑')
  assert.equal(aReport.deletedLocal, 0)
  assert.equal(await fsp.readFile(path.join(A.root, 'large.bin')).then((buf) => buf[0]), 9, '本机超大文件必须原样保留')
  assert.equal(await fsp.readFile(path.join(B.root, 'large.bin')).then((buf) => buf[0]), 7, '对端副本不能被删/覆盖')

  const aManifest = await readManifest(storeDir, A.store.deviceId)
  assert.equal(tombstoneKeys(aManifest).has('data/large.bin'), false)

  const bAfter = await sync(B)
  assert.equal(bAfter.deletedLocal, 0)
  assert.equal(bAfter.tombstoned, 0)
  assert.equal((await fsp.readFile(path.join(B.root, 'large.bin'))).byteLength, 70 * 1024)
})

test('后加排除规则：不墓碑，基线保留', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsync-safe-exclude-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const storeDir = path.join(base, 'store')
  const A = await makeDevice(base, 'A', { storeDir })
  const B = await makeDevice(base, 'B', { storeDir })

  await fsp.writeFile(path.join(A.root, 'secret.txt'), 'keep me')
  await sync(A)
  await sync(B)
  assert.equal(await fsp.readFile(path.join(B.root, 'secret.txt'), 'utf8'), 'keep me')

  await A.engine.updateConfig({
    roots: [{ id: 'data', label: 'data', path: A.root, enabled: true, exclude: ['secret.txt'] }],
  })
  const aReport = await sync(A)
  assert.equal(aReport.tombstoned, 0, '排除规则不能产生墓碑')
  assert.equal(await fsp.readFile(path.join(A.root, 'secret.txt'), 'utf8'), 'keep me', '本机文件不能被删')
  assert.equal(A.store.baseFor('local').has('data/secret.txt'), true, '基线必须保留')

  const aManifest = await readManifest(storeDir, A.store.deviceId)
  assert.equal(tombstoneKeys(aManifest).has('data/secret.txt'), false)

  const bAfter = await sync(B)
  assert.equal(bAfter.deletedLocal, 0)
  assert.equal(await fsp.readFile(path.join(B.root, 'secret.txt'), 'utf8'), 'keep me')
})

test('对端独有根目录：本机不识别也不墓碑', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsync-safe-unknown-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const storeDir = path.join(base, 'store')
  const extraPath = path.join(base, 'B', 'extra')
  const A = await makeDevice(base, 'A', { storeDir })
  const B = await makeDevice(base, 'B', { storeDir, extraRoots: [{ id: 'extra', label: 'extra', path: extraPath, enabled: true, exclude: [] }] })

  await fsp.writeFile(path.join(extraPath, 'e.txt'), 'extra only')
  const bPush = await sync(B)
  assert.equal(bPush.pushed, 1)

  const aReport = await sync(A)
  assert.equal(aReport.tombstoned, 0)
  assert.equal(aReport.errors, 0)
  const aManifest = await readManifest(storeDir, A.store.deviceId)
  assert.equal(tombstoneKeys(aManifest).has('extra/e.txt'), false)

  const bAfter = await sync(B)
  assert.equal(bAfter.deletedLocal, 0)
  assert.equal(bAfter.tombstoned, 0)
  assert.equal(await fsp.readFile(path.join(extraPath, 'e.txt'), 'utf8'), 'extra only')
})

test('禁用根目录：不墓碑，重新启用后基线还在', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsync-safe-disable-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const storeDir = path.join(base, 'store')
  const docsPath = path.join(base, 'A', 'docs')
  const A = await makeDevice(base, 'A', {
    storeDir,
    extraRoots: [{ id: 'docs', label: 'docs', path: docsPath, enabled: true, exclude: [] }],
  })
  const B = await makeDevice(base, 'B', {
    storeDir,
    extraRoots: [{ id: 'docs', label: 'docs', path: path.join(base, 'B', 'docs'), enabled: true, exclude: [] }],
  })

  await fsp.writeFile(path.join(docsPath, 'd.txt'), 'doc')
  await sync(A)
  await sync(B)
  assert.equal(await fsp.readFile(path.join(base, 'B', 'docs', 'd.txt'), 'utf8'), 'doc')

  await A.engine.updateConfig({
    roots: [
      { id: 'data', label: 'data', path: A.root, enabled: true, exclude: [] },
      { id: 'docs', label: 'docs', path: docsPath, enabled: false, exclude: [] },
    ],
  })
  const aReport = await sync(A)
  assert.equal(aReport.tombstoned, 0, '禁用根目录不能产生墓碑')
  assert.equal(await fsp.readFile(path.join(docsPath, 'd.txt'), 'utf8'), 'doc')
  assert.equal(A.store.baseFor('local').has('docs/d.txt'), true, '禁用期间基线必须保留')

  const bAfter = await sync(B)
  assert.equal(bAfter.deletedLocal, 0)
  assert.equal(await fsp.readFile(path.join(base, 'B', 'docs', 'd.txt'), 'utf8'), 'doc')

  // 重新启用：本机文件与基线都在，应该只剩 keep，不应产生墓碑或冲突。
  await A.engine.updateConfig({
    roots: [
      { id: 'data', label: 'data', path: A.root, enabled: true, exclude: [] },
      { id: 'docs', label: 'docs', path: docsPath, enabled: true, exclude: [] },
    ],
  })
  const reEnabled = await sync(A)
  assert.equal(reEnabled.tombstoned, 0)
  assert.equal(reEnabled.conflicts, 0)
})

test('导出：扫描后文件被改写，以实际字节重建清单', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsync-safe-export-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const storeDir = path.join(base, 'store')
  const A = await makeDevice(base, 'A', { storeDir })
  const file = path.join(A.root, 'live.txt')
  await fsp.writeFile(file, 'old-content')

  // 模拟扫描结束后、读取前文件又被追加（会话日志的真实场景）。
  const originalScan = A.engine.scanLocal.bind(A.engine)
  A.engine.scanLocal = async (options) => {
    const result = await originalScan(options)
    await fsp.writeFile(file, 'new-content-after-scan')
    return result
  }

  const result = await A.engine.exportArchive()
  const archived = await parseArchive(await fsp.readFile(result.path))
  const entry = archived.manifest.entries.find((item) => item.key === 'data/live.txt')
  assert.ok(entry, '导出清单必须包含该文件')
  assert.equal(entry.hash, sha256Bytes(Buffer.from('new-content-after-scan')))
  assert.equal(entry.size, Buffer.byteLength('new-content-after-scan'))
  assert.equal(Buffer.from(archived.objects.get(entry.hash)).toString('utf8'), 'new-content-after-scan')
  assert.equal(result.entries, 1)
})