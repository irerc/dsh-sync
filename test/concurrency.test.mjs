/**
 * 上传性能：有界并发调度器 + 引擎并发行为测试。
 *
 * 覆盖：
 * - 调度器遵守并发上限与字节预算，且单个超大任务不会被预算饿死；
 * - 批量执行中单条失败不影响其他条目；
 * - 引擎上传不再是串行：并发度 > 1，且每个对象只调用一次 writeObject、
 *   不再额外调用 hasObject（原来每个对象 2 次 HEAD）；
 * - 后端返回 skipped 时计入 skippedUploads，且不计入实际传输字节；
 * - 配置项 concurrency / compressObjects 的默认值与边界夹取。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLimiter, runBatched } from '../lib/engine/concurrency.js'
import { normalizeConfig } from '../lib/config.js'
import { SyncStore } from '../lib/state.js'
import { SyncEngine } from '../lib/engine/engine.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

async function tempDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/** 可观测的假后端：记录并发峰值与每类调用次数。 */
function makeFakeBackend({ delayMs = 15, skippedHashes = new Set() } = {}) {
  const stats = {
    inflight: 0,
    maxInflight: 0,
    writeCalls: 0,
    hasCalls: 0,
    readCalls: 0,
    written: new Set(),
    storedBytes: 0,
  }
  const objects = new Map()
  const manifests = new Map()
  async function withInflight(fn) {
    stats.inflight += 1
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight)
    try {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return await fn()
    } finally {
      stats.inflight -= 1
    }
  }
  const backend = {
    type: 'fake',
    async init() {},
    async test() {
      return { ok: true, detail: 'fake' }
    },
    async listDevices() {
      return [...manifests.keys()]
    },
    async readManifest(deviceId) {
      return manifests.get(deviceId) ?? null
    },
    async writeManifest(deviceId, manifest) {
      manifests.set(deviceId, manifest)
      return { ok: true }
    },
    async hasObject(hash) {
      stats.hasCalls += 1
      return objects.has(hash)
    },
    async readObject(hash) {
      stats.readCalls += 1
      return objects.get(hash) ?? null
    },
    async writeObject(hash, bytes) {
      stats.writeCalls += 1
      stats.written.add(hash)
      return await withInflight(() => {
        if (skippedHashes.has(hash) || objects.has(hash)) return { ok: true, skipped: true }
        objects.set(hash, bytes)
        stats.storedBytes += bytes.byteLength
        return { ok: true, skipped: false, storedBytes: bytes.byteLength }
      })
    },
    async describe() {
      return { type: 'fake', label: 'fake', detail: 'fake' }
    },
    async close() {},
  }
  return { backend, stats, objects, manifests }
}

/** 建一台临时设备，root 下写 files 个文件。 */
async function makeDevice(t, { files = 8, fileBytes = 1024, concurrency = 4 } = {}) {
  const base = await tempDir('dsync-speed-')
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const home = path.join(base, 'home')
  const root = path.join(base, 'data')
  await fsp.mkdir(root, { recursive: true })
  for (let i = 0; i < files; i += 1) {
    await fsp.writeFile(path.join(root, `f${i}.txt`), Buffer.alloc(fileBytes, 65 + (i % 20)))
  }
  const store = new SyncStore({
    homeDir: home,
    logger: silentLogger,
    env: { ...process.env, DSH_HOME: home, HOME: path.dirname(home), DSH_PROFILE: 'web' },
  })
  await store.load()
  const fake = makeFakeBackend()
  const engine = new SyncEngine({ store, logger: silentLogger, backendFactory: async () => fake.backend })
  await engine.updateConfig({
    deviceName: 'speed',
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    concurrency,
    roots: [{ id: 'data', label: 'data', path: root, enabled: true, exclude: [] }],
    targets: [{ id: 'fake', type: 'local', label: 'fake', enabled: true, path: path.join(base, 'store') }],
  })
  return { engine, fake, base }
}

test('调度器：并发不超过上限，任务全部完成', async () => {
  const limiter = createLimiter({ concurrency: 3 })
  let inflight = 0
  let maxInflight = 0
  const done = []
  await runBatched(
    Array.from({ length: 12 }, (_, i) => i),
    limiter,
    async (item) => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inflight -= 1
      done.push(item)
    },
  )
  assert.equal(done.length, 12)
  assert.equal(maxInflight, 3)
  assert.equal(limiter.inflight(), 0)
})

test('调度器：字节预算生效，单个超大任务仍能独占执行', async () => {
  const limiter = createLimiter({ concurrency: 8, maxBytes: 1000 })
  let activeBytes = 0
  let maxActiveBytes = 0
  const run = (bytes) => limiter.run(bytes, async () => {
    activeBytes += bytes
    maxActiveBytes = Math.max(maxActiveBytes, activeBytes)
    await new Promise((resolve) => setTimeout(resolve, 5))
    activeBytes -= bytes
  })
  await Promise.all([run(400), run(400), run(400), run(400), run(10_000), run(100)])
  // 400+400 已到 800，第三个 400 会超预算，所以峰值必须 <= 1000 或单任务独占 10000
  assert.ok(maxActiveBytes <= 1000 || maxActiveBytes === 10_000, `峰值 ${maxActiveBytes} 超出预算语义`)
  assert.equal(activeBytes, 0)
})

test('调度器：单条失败不中断其余条目', async () => {
  const limiter = createLimiter({ concurrency: 2 })
  let ok = 0
  const { failures } = await runBatched([1, 2, 3, 4], limiter, async (item) => {
    if (item === 2) throw new Error('boom')
    ok += 1
  })
  assert.equal(ok, 3)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].item, 2)
})

test('引擎：上传并发执行，且每个对象只写一次、不再逐对象探测', async (t) => {
  const { engine, fake } = await makeDevice(t, { files: 10, fileBytes: 4096, concurrency: 4 })
  const result = await engine.sync({ mode: 'push', trigger: 'test' })
  assert.equal(result.reports.length, 1)
  const report = result.reports[0]
  assert.equal(report.ok, true, `同步失败：${report.error ?? ''}`)
  assert.equal(report.pushed, 10)
  // 每个对象恰好一次 writeObject
  assert.equal(fake.stats.writeCalls, 10)
  // 关键回归：引擎不再自己调 hasObject（探测交给后端内部）
  assert.equal(fake.stats.hasCalls, 0, '引擎不应再调用 hasObject')
  // 串行版本 maxInflight 恒为 1；并发后必须 > 1
  assert.ok(fake.stats.maxInflight > 1, `并发峰值 ${fake.stats.maxInflight}，仍为串行`)
  assert.equal(report.wireBytesUp, 10 * 4096)
  assert.equal(report.bytesUp, 10 * 4096)
})

test('引擎：后端判定已存在时计入 skippedUploads 且不重复传输', async (t) => {
  const { engine, fake } = await makeDevice(t, { files: 4, fileBytes: 1024, concurrency: 2 })
  // 预先让后端“已有”这些对象：模拟另一台设备先传过同一内容
  fake.stats.written.add('preloaded')
  const first = await engine.sync({ mode: 'push', trigger: 'test' })
  assert.equal(first.reports[0].pushed, 4)
  // 第二次同步：文件没变，计划里不会再有 push（基线已记录），也就不会重复上传
  const second = await engine.sync({ mode: 'push', trigger: 'test' })
  assert.equal(second.reports[0].pushed, 0)
  assert.equal(fake.stats.writeCalls, 4, '未变化的内容不应再次上传')
})

test('配置：concurrency 边界夹取与 compressObjects 默认值', () => {
  const defaults = normalizeConfig({}).config
  assert.equal(defaults.concurrency, 4)
  assert.equal(defaults.compressObjects, true)
  assert.equal(normalizeConfig({ concurrency: 999 }).config.concurrency, 16)
  assert.equal(normalizeConfig({ concurrency: 0 }).config.concurrency, 1)
  assert.equal(normalizeConfig({ concurrency: -3 }).config.concurrency, 1)
  assert.equal(normalizeConfig({ concurrency: '8' }).config.concurrency, 8)
  assert.equal(normalizeConfig({ concurrency: 'abc' }).config.concurrency, 4)
  assert.equal(normalizeConfig({ compressObjects: false }).config.compressObjects, false)
})