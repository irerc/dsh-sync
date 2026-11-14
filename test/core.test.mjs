/**
 * 核心算法与引擎集成测试。
 *
 * 覆盖：路径安全、配置归一化、manifest 合并、三方合并计划、
 * 扫描排除/链接/大文件、两个临时 DSH_HOME 经 local 后端收敛、冲突与导入导出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSafeRelPath, resolveInside } from '../lib/util.js'
import { normalizeConfig, normalizeTarget, expandPath } from '../lib/config.js'
import { createDeviceManifest, normalizeManifest, mergeManifests, entryKey } from '../lib/engine/manifest.js'
import { planMerge } from '../lib/engine/merge.js'
import { scanRoots, isExcluded } from '../lib/engine/scan.js'
import { SyncStore } from '../lib/state.js'
import { SyncEngine } from '../lib/engine/engine.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

async function tempDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function write(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, content)
}

/** 本地 entry 简写。 */
function localEntry(key, hash) {
  const [root, ...rest] = key.split('/')
  return { key, root, path: rest.join('/'), hash, size: 1, mtimeMs: 1 }
}

/** 远端 entry 简写。 */
function remoteEntry(key, hash, updatedAt = 1000) {
  return { ...localEntry(key, hash), updatedAt, deviceId: 'device-b' }
}

function tombstone(key, updatedAt = 1000) {
  return { key, root: key.split('/')[0], path: key.split('/').slice(1).join('/'), deleted: true, updatedAt, deviceId: 'device-b' }
}

function baseEntry(hash) {
  return { hash, size: 1, mtimeMs: 1, updatedAt: 1000 }
}

test('路径安全：拒绝绝对路径、上跳、反斜杠、NUL', () => {
  for (const bad of ['/etc/passwd', '../x', 'a/../../b', 'a\\b', 'a//b', 'a/\u0000b', '']) {
    assert.equal(isSafeRelPath(bad), false, bad)
  }
  assert.equal(isSafeRelPath('a/b.txt'), true)
  assert.equal(resolveInside('/tmp/root', 'a/b'), path.join('/tmp/root', 'a/b'))
  assert.equal(resolveInside('/tmp/root', '../x'), null)
})

test('配置：展开变量、重叠根目录停用、target 校验', () => {
  assert.equal(expandPath('$DSH_HOME/profiles/$DSH_PROFILE', { HOME: '/home/u', DSH_HOME: '/d', DSH_PROFILE: 'web' }), '/d/profiles/web')
  assert.equal(expandPath('~/docs', { HOME: '/home/u', DSH_HOME: '/d', DSH_PROFILE: 'web' }), '/home/u/docs')

  const { config, warnings } = normalizeConfig({
    roots: [
      { id: 'a', path: '/tmp/x', enabled: true },
      { id: 'b', path: '/tmp/x/sub', enabled: true },
    ],
    targets: [
      { id: 'l', type: 'local', path: '/tmp/store', enabled: true },
      { id: 'bad', type: 'nope', enabled: true },
    ],
  }, { HOME: '/home/u', DSH_HOME: '/d', DSH_PROFILE: 'web' })
  assert.equal(config.roots[0].id, 'a')
  assert.equal(config.roots[1].enabled, false)
  assert.equal(config.targets.length, 1)
  assert.ok(warnings.some((item) => item.includes('重叠')))
  assert.ok(warnings.some((item) => item.includes('未知 target 类型')))

  assert.equal(normalizeTarget({ type: 'webdav', url: 'https://x', enabled: true }).ok, true)
  assert.equal(normalizeTarget({ type: 'webdav', url: '', enabled: true }).ok, false)
  assert.equal(normalizeTarget({ type: 'peer', url: 'http://h', token: '', enabled: true }).ok, false)
})

test('manifest：墓碑没有 hash 也能校验，多设备按 updatedAt/deviceId 合并', () => {
  const a = createDeviceManifest({
    deviceId: 'device-a',
    deviceName: 'A',
    entries: new Map([[ 'data/a.txt', { ...localEntry('data/a.txt', 'a'.repeat(64)), updatedAt: 2000, deviceId: 'device-a' } ]]),
    tombstones: new Map([[ 'data/gone.txt', { key: 'data/gone.txt', root: 'data', path: 'gone.txt', deleted: true, updatedAt: 3000, deviceId: 'device-a' } ]]),
    now: 4000,
  })
  const normalized = normalizeManifest(a)
  assert.ok(normalized)
  assert.equal(normalized.skipped, 0)
  assert.equal(normalized.tombstones.get('data/gone.txt').deleted, true)

  const b = createDeviceManifest({
    deviceId: 'device-b',
    deviceName: 'B',
    entries: new Map([[ 'data/a.txt', { ...localEntry('data/a.txt', 'b'.repeat(64)), updatedAt: 5000, deviceId: 'device-b' } ]]),
    tombstones: new Map(),
    now: 6000,
  })
  const merged = mergeManifests([normalizeManifest(a), normalizeManifest(b)])
  assert.equal(merged.get('data/a.txt').hash, 'b'.repeat(64))
  assert.equal(merged.get('data/gone.txt').deleted, true)
})

test('三方合并：十种关键分支', () => {
  const H = (c) => c.repeat(64)
  const cases = [
    // [local, remote, base, 期望]
    [H('a'), H('a'), H('a'), { keep: 1 }],
    [H('a'), H('b'), H('a'), { pull: 1 }],
    [H('b'), H('a'), H('a'), { push: 1 }],
    [H('b'), H('c'), H('a'), { push: 1, conflict: 1 }],
    [H('b'), null, null, { push: 1 }],
    [null, H('b'), null, { pull: 1 }],
    [null, H('a'), H('a'), { tombstone: 1 }],
    [null, H('b'), H('a'), { pull: 1, conflict: 1 }],
    [H('a'), tombstone('data/a.txt'), H('a'), { deleteLocal: 1 }],
    [H('b'), tombstone('data/a.txt'), H('a'), { push: 1, conflict: 1 }],
  ]
  for (const [localHash, remoteValue, baseHash, expected] of cases) {
    const local = new Map()
    if (localHash !== null) local.set('data/a.txt', localEntry('data/a.txt', localHash))
    const remote = new Map()
    if (remoteValue !== null) {
      remote.set('data/a.txt', typeof remoteValue === 'string' ? remoteEntry('data/a.txt', remoteValue) : remoteValue)
    }
    const base = new Map()
    if (baseHash !== null) base.set('data/a.txt', baseEntry(baseHash))
    const plan = planMerge({ local, remote, base })
    const counts = {
      keep: plan.keep.length,
      pull: plan.pull.length,
      push: plan.push.length,
      conflict: plan.conflict.length,
      tombstone: plan.pushTombstone.length,
      deleteLocal: plan.deleteLocal.length,
    }
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(counts[key], value, `case ${JSON.stringify({ localHash, remoteValue, baseHash })} → ${key}`)
    }
  }
})

test('扫描：排除目录、跳过链接与超大文件，并复用 hash 缓存', async (t) => {
  const root = await tempDir('dsync-scan-')
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  await write(path.join(root, 'keep.txt'), 'keep')
  await write(path.join(root, 'node_modules/pkg/index.js'), 'ignored')
  await write(path.join(root, 'a.bak-1'), 'ignored')
  await write(path.join(root, 'sub/nested.txt'), 'nested')
  await fsp.symlink(path.join(root, 'keep.txt'), path.join(root, 'link.txt'))
  await write(path.join(root, 'big.bin'), 'x'.repeat(64))

  assert.equal(isExcluded('node_modules/pkg/index.js', ['node_modules/**']), true)
  assert.equal(isExcluded('a.bak-1', ['*.bak-*']), true)
  assert.equal(isExcluded('sub/x.txt', ['node_modules/**']), false)

  const first = await scanRoots([{ id: 'r', path: root, enabled: true, exclude: ['node_modules/**', '*.bak-*'] }], {
    maxFileBytes: 32,
    dshHome: '/nonexistent',
  })
  const keys = [...first.entries.keys()].sort()
  assert.deepEqual(keys, ['r/keep.txt', 'r/sub/nested.txt'])
  assert.ok(first.skipped.some((item) => item.reason === 'too-large'))
  assert.ok(first.symlinks >= 1)

  const second = await scanRoots([{ id: 'r', path: root, enabled: true, exclude: ['node_modules/**', '*.bak-*'] }], {
    maxFileBytes: 32,
    dshHome: '/nonexistent',
    cache: first.cache,
  })
  assert.equal(second.entries.get('r/keep.txt').hash, first.entries.get('r/keep.txt').hash)
})

/** 构造两个临时设备，指向同一个 local store。 */
async function makePair(t) {
  const base = await tempDir('dsync-e2e-')
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const storeDir = path.join(base, 'store')
  const homeA = path.join(base, 'homeA')
  const homeB = path.join(base, 'homeB')
  const rootA = path.join(base, 'A', 'data')
  const rootB = path.join(base, 'B', 'data')
  await fsp.mkdir(rootA, { recursive: true })
  await fsp.mkdir(rootB, { recursive: true })
  const make = async (home, root, name) => {
    const store = new SyncStore({
      homeDir: home,
      logger: silentLogger,
      env: { ...process.env, DSH_HOME: home, HOME: path.dirname(home), DSH_PROFILE: 'web' },
    })
    await store.load()
    const engine = new SyncEngine({ store, logger: silentLogger })
    await engine.updateConfig({
      deviceName: name,
      autoSync: false,
      autoSave: false,
      syncOnStart: false,
      roots: [{ id: 'data', label: 'data', path: root, enabled: true, exclude: [] }],
      targets: [{ id: 'local', type: 'local', label: 'local', enabled: true, path: storeDir }],
    })
    return { store, engine, root }
  }
  const A = await make(homeA, rootA, 'A')
  const B = await make(homeB, rootB, 'B')
  return { base, storeDir, A, B }
}

test('引擎：新增/修改/删除/冲突/导入导出收敛', async (t) => {
  const { A, B } = await makePair(t)
  const sync = async (device) => {
    const result = await device.engine.sync({ mode: 'auto', trigger: 'test' })
    assert.equal(result.reports.length, 1)
    return result.reports[0]
  }

  await write(path.join(A.root, 'a.txt'), 'hello-a')
  await write(path.join(A.root, 'sub/b.json'), '{"b":1}')
  const r1 = await sync(A)
  assert.equal(r1.ok, true)
  assert.equal(r1.pushed, 2)
  const r2 = await sync(B)
  assert.equal(r2.pulled, 2)
  assert.equal(await fsp.readFile(path.join(B.root, 'a.txt'), 'utf8'), 'hello-a')
  assert.equal(await fsp.readFile(path.join(B.root, 'sub/b.json'), 'utf8'), '{"b":1}')

  // B 改，A 拉。
  await write(path.join(B.root, 'a.txt'), 'hello-b')
  await sync(B)
  await sync(A)
  assert.equal(await fsp.readFile(path.join(A.root, 'a.txt'), 'utf8'), 'hello-b')

  // A 删，B 跟着删；再同步不会复活。
  await fsp.unlink(path.join(A.root, 'sub/b.json'))
  await sync(A)
  await sync(B)
  await assert.rejects(fsp.stat(path.join(B.root, 'sub/b.json')))
  const rIdle = await sync(B)
  assert.equal(rIdle.pulled, 0)
  await assert.rejects(fsp.stat(path.join(B.root, 'sub/b.json')))

  // 双方同时改：保留两份内容，冲突不丢数据。
  await write(path.join(A.root, 'a.txt'), 'A-version')
  await write(path.join(B.root, 'a.txt'), 'B-version')
  await sync(A)
  const conflictReport = await sync(B)
  assert.equal(conflictReport.conflicts, 1)
  assert.equal(await fsp.readFile(path.join(B.root, 'a.txt'), 'utf8'), 'B-version')
  const filesB = await fsp.readdir(B.root)
  const copiesB = filesB.filter((name) => name.includes('.conflict-'))
  assert.equal(copiesB.length, 1)
  assert.equal(await fsp.readFile(path.join(B.root, copiesB[0]), 'utf8'), 'A-version')

  await sync(A)
  await sync(B)
  const stable = await sync(A)
  assert.equal(stable.conflicts, 0, '收敛后不应再产生新冲突')
  const filesA = await fsp.readdir(A.root)
  assert.ok(filesA.some((name) => name.includes('.conflict-')), 'A 应收到冲突副本')

  // 导出 → B 本地改 → 导入：归档内容胜出，旧内容留档。
  const exported = await A.engine.exportArchive()
  const archiveBytes = await fsp.readFile(exported.path)
  const aContent = await fsp.readFile(path.join(A.root, 'a.txt'), 'utf8')
  await write(path.join(B.root, 'a.txt'), 'B-local-only')
  const imported = await B.engine.importArchive({ bytes: archiveBytes, name: exported.name })
  assert.equal(imported.ok, true)
  assert.equal(await fsp.readFile(path.join(B.root, 'a.txt'), 'utf8'), aContent)
  const filesAfterImport = await fsp.readdir(B.root)
  assert.ok(filesAfterImport.some((name) => name.includes('.conflict-local-')))
})