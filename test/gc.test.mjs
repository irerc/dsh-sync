/**
 * 云端回收（GC）测试。
 *
 * 规则必须保守：只删「没有任何设备 manifest 引用」的对象；
 * 预演（apply=false）不删任何东西；引用集合不可信时整轮放弃。
 *
 *   G1 预演：报告可删数量/字节，但不删
 *   G2 执行：只删未引用对象，被引用的对象必须存活
 *   G3 读不到任何 manifest 时拒绝执行（宁可不删）
 */

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { SyncEngine } from '../lib/engine/engine.js'
import { SyncStore } from '../lib/state.js'
import { createSandboxPair, writeText } from './support/fakes.mjs'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

async function makeDevice(sandbox, { name, rootPath, targetPath }) {
  const store = new SyncStore({ homeDir: sandbox.dshHome, logger: silentLogger, env: sandbox.env })
  await store.load()
  const engine = new SyncEngine({ store, logger: silentLogger })
  await engine.updateConfig({
    deviceName: name,
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    roots: [{ id: 'data', label: '数据', path: rootPath, enabled: true, exclude: [] }],
    targets: [{ id: 'local', type: 'local', label: '本地', enabled: true, path: targetPath }],
  })
  return { store, engine }
}

test('G1/G2 回收只删未引用对象，被引用对象存活', async () => {
  const pair = await createSandboxPair()
  try {
    const remote = path.join(pair.a.dshHome, 'remote')
    await writeText(path.join(pair.a.workspace, 'keep.txt'), 'keep-me')
    const { store, engine } = await makeDevice(pair.a, {
      name: 'A',
      rootPath: pair.a.workspace,
      targetPath: remote,
    })

    // 真同步一次：远端产生被引用的对象。
    const first = await engine.sync({ mode: 'push', trigger: 'test' })
    assert.equal(first.reports[0].ok, true, first.reports[0].error ?? '')

    // 手工塞两个孤儿对象（模拟"改过又改回来"留下的旧版本）。
    const orphans = {
      ['a'.repeat(64)]: Buffer.alloc(1000, 1),
      ['b'.repeat(64)]: Buffer.alloc(2000, 2),
    }
    for (const [hash, bytes] of Object.entries(orphans)) {
      await fsp.writeFile(path.join(remote, 'objects', hash), bytes)
    }
    const referencedBefore = (await fsp.readdir(path.join(remote, 'objects'))).length
    assert.ok(referencedBefore >= 3, `远端应有 3 个对象，实际 ${referencedBefore}`)

    // 预演：只报告，不删。
    const dryRun = await engine.pruneRemote({ apply: false })
    assert.equal(dryRun.ok, true, dryRun.error ?? '')
    assert.equal(dryRun.applied, false)
    assert.equal(dryRun.removable, 2, `应识别 2 个孤儿，实际 ${dryRun.removable}`)
    assert.equal(dryRun.removed, 0, '预演不能删除任何对象')
    assert.ok(dryRun.removableBytes >= 3000, `应报出可回收字节，实际 ${dryRun.removableBytes}`)
    assert.equal((await fsp.readdir(path.join(remote, 'objects'))).length, referencedBefore, '预演后对象数不变')

    // 执行：孤儿消失，被引用的对象还在。
    const applied = await engine.pruneRemote({ apply: true })
    assert.equal(applied.ok, true, applied.error ?? '')
    assert.equal(applied.removed, 2)
    assert.ok(applied.freedBytes >= 3000, `应报出真实回收字节，实际 ${applied.freedBytes}`)
    // 回收给的是"字节/秒"，不是网速；字段名必须能区分，避免被当成同步速度。
    assert.ok(applied.freedBytesPerSecond >= 0)
    assert.equal(applied.bytesPerSecond, undefined)

    const left = await fsp.readdir(path.join(remote, 'objects'))
    for (const hash of Object.keys(orphans)) assert.ok(!left.includes(hash), `孤儿 ${hash.slice(0, 8)} 应被删除`)
    assert.equal(left.length, referencedBefore - 2, '只删孤儿')

    // 被引用的对象仍然可读（下次同步不会 404）。
    const second = await engine.sync({ mode: 'push', trigger: 'test' })
    assert.equal(second.reports[0].ok, true, second.reports[0].error ?? '')
    assert.equal(second.reports[0].errors, 0)
    assert.equal(store.state.logs.filter((log) => String(log.message ?? '').includes('云端回收')).length, 2)
  } finally {
    await pair.cleanup?.()
  }
})

test('G3 读不到任何 manifest 时拒绝回收', async () => {
  const pair = await createSandboxPair()
  try {
    const remote = path.join(pair.a.dshHome, 'remote')
    const { engine } = await makeDevice(pair.a, { name: 'A', rootPath: pair.a.workspace, targetPath: remote })
    // 只有对象、没有 devices/*.json：引用集合不可信。
    await fsp.mkdir(path.join(remote, 'objects'), { recursive: true })
    await fsp.writeFile(path.join(remote, 'objects', 'c'.repeat(64)), Buffer.alloc(10))

    const report = await engine.pruneRemote({ apply: true })
    assert.equal(report.ok, false, '不应在引用集合不可信时执行')
    assert.match(String(report.error), /manifest|引用/, `错误信息要说明原因，实际 ${report.error}`)
    const left = await fsp.readdir(path.join(remote, 'objects'))
    assert.equal(left.length, 1, '拒绝时不能删除任何对象')
  } finally {
    await pair.cleanup?.()
  }
})
test('G4 被引用的对象在远端缺失时，回收顺手补传（自愈）', async () => {
  const pair = await createSandboxPair()
  try {
    const remote = path.join(pair.a.dshHome, 'remote')
    await writeText(path.join(pair.a.workspace, 'keep.txt'), 'keep-me-please')
    const { engine } = await makeDevice(pair.a, { name: 'A', rootPath: pair.a.workspace, targetPath: remote })
    const first = await engine.sync({ mode: 'push', trigger: 'test' })
    assert.equal(first.reports[0].ok, true, first.reports[0].error ?? '')

    // 模拟"manifest 写了但对象没上传成功"：直接删掉远端对象。
    const objectsBefore = await fsp.readdir(path.join(remote, 'objects'))
    assert.equal(objectsBefore.length, 1)
    await fsp.rm(path.join(remote, 'objects', objectsBefore[0]))

    // 预演只报告缺失，不补。
    const dry = await engine.pruneRemote({ apply: false })
    assert.equal(dry.ok, true, dry.error ?? '')
    assert.equal(dry.missingReferenced, 1)
    assert.equal(dry.repaired, 0, '预演不能补传')

    // 执行：补传回来，且报告里说清楚补了几个。
    const applied = await engine.pruneRemote({ apply: true })
    assert.equal(applied.ok, true, applied.error ?? '')
    assert.equal(applied.missingReferenced, 1)
    assert.equal(applied.repaired, 1, `应补传 1 个，实际 ${applied.repaired}`)
    assert.ok(applied.repairedBytes > 0)
    assert.equal(applied.unrepairedReferenced, 0)

    const objectsAfter = await fsp.readdir(path.join(remote, 'objects'))
    assert.deepEqual(objectsAfter, objectsBefore, '对象应被补传回原位置')

    // 补传后同步不报错（别的设备也不会 404）。
    const second = await engine.sync({ mode: 'push', trigger: 'test' })
    assert.equal(second.reports[0].errors, 0)
  } finally {
    await pair.cleanup?.()
  }
})
