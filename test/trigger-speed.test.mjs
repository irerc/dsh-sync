/**
 * 自动上传时机 + 真实速度 + 去重省流的测试。
 *
 * 对应用户明确要求：
 *   D1 自动上传只在 Agent 停止时触发，且连续多次结束合并成一次
 *   D2 关闭 syncOnAgentIdle 后完全不触发
 *   D3 同步进行中 Agent 又停：不叠加，结束后补跑一次
 *   D4 速度只用真实过网的字节算（去重跳过的对象不计入分母）
 *   D5 去重跳过的对象数与省下的字节可被读到
 */

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { SyncEngine } from '../lib/engine/engine.js'
import { SyncStore } from '../lib/state.js'
import { createSandboxPair, writeText } from './support/fakes.mjs'
import { startMockWebdav } from './support/mock-webdav.mjs'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

async function makeDevice(sandbox, { name, rootPath, targets, config = {} }) {
  const store = new SyncStore({ homeDir: sandbox.dshHome, logger: silentLogger, env: sandbox.env })
  await store.load()
  const engine = new SyncEngine({ store, logger: silentLogger })
  await engine.updateConfig({
    deviceName: name,
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    roots: [{ id: 'data', label: '数据', path: rootPath, enabled: true, exclude: [] }],
    targets,
    ...config,
  })
  return { store, engine }
}

function davTarget(url) {
  return { id: 'dav', type: 'webdav', label: 'DAV', enabled: true, url, username: 'dsh', password: 'secret', basePath: '/dsh-sync' }
}

/** 等下一个 idle 排程真正跑完（轮询 engine.busy / 同步次数）。 */
async function settle(engine, { timeoutMs = 8000 } = {}) {
  const started = Date.now()
  let seenBusy = false
  while (Date.now() - started < timeoutMs) {
    if (engine.busy) seenBusy = true
    if (seenBusy && !engine.busy && engine.idleTimer === null) return true
    if (!seenBusy && !engine.busy && engine.idleTimer === null && Date.now() - started > 200) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

test('D1 Agent 停止触发上传，连续结束合并成一次', async () => {
  const pair = await createSandboxPair()
  const dav = await startMockWebdav()
  try {
    await writeText(path.join(pair.a.workspace, 'a.txt'), 'A')
    const { engine } = await makeDevice(pair.a, {
      name: 'A',
      rootPath: pair.a.workspace,
      targets: [davTarget(dav.url)],
      config: { syncOnAgentIdle: true, agentIdleDelaySeconds: 3 },
    })

    engine.startAutomation()
    // 模拟一轮 turn 结束后连着几次状态回调（多会话 / 子 Agent）。
    engine.noteAgentIdle()
    engine.noteAgentIdle()
    engine.noteAgentIdle()
    assert.equal(engine.idleBursts, 3)
    assert.ok(engine.idleTimer !== null, '应当排了一次合并后的同步')

    assert.equal(await settle(engine), true, '合并后的同步应当跑完')
    const last = engine.store.state.targets?.dav?.lastResult
    assert.equal(last?.trigger, 'agent-idle', '触发器必须标明来自 Agent 空闲')
    assert.ok(last.pushed >= 1, '文件应当已上传')
    engine.stopAutomation()
  } finally {
    await dav.close()
    await pair.cleanup?.()
  }
})

test('D2 关闭 syncOnAgentIdle 后不触发任何上传', async () => {
  const pair = await createSandboxPair()
  try {
    await writeText(path.join(pair.a.workspace, 'a.txt'), 'A')
    const { engine } = await makeDevice(pair.a, {
      name: 'A',
      rootPath: pair.a.workspace,
      targets: [{ id: 'local', type: 'local', enabled: true, path: path.join(pair.a.dshHome, 'remote') }],
      config: { syncOnAgentIdle: false },
    })
    engine.startAutomation()
    engine.noteAgentIdle()
    assert.equal(engine.idleTimer, null, '关闭后不该排同步')
    engine.stopAutomation()
  } finally {
    await pair.cleanup?.()
  }
})

test('D3 同步进行中 Agent 又停：不叠加，结束后补跑一次', async () => {
  const pair = await createSandboxPair()
  const dav = await startMockWebdav()
  try {
    await writeText(path.join(pair.a.workspace, 'a.txt'), 'A')
    const { engine } = await makeDevice(pair.a, {
      name: 'A',
      rootPath: pair.a.workspace,
      targets: [davTarget(dav.url)],
      config: { syncOnAgentIdle: true, agentIdleDelaySeconds: 3 },
    })

    engine.startAutomation()
    // 手工制造“正在同步”状态：此时来了 idle 回调，应当排队而不是叠加。
    engine.busy = true
    engine.pendingIdleSync = false
    engine.scheduleIdleSync()
    await new Promise((resolve) => setTimeout(resolve, 3300))
    assert.equal(engine.pendingIdleSync, true, '忙时应记为待补跑，而不是并行发起')

    // 模拟那次同步结束：finally 会消费 pendingIdleSync 并补跑。
    engine.busy = false
    if (engine.pendingIdleSync) {
      engine.pendingIdleSync = false
      engine.scheduleIdleSync()
    }
    assert.equal(await settle(engine), true, '补跑应当完成')
    const last = engine.store.state.targets?.dav?.lastResult
    assert.equal(last?.trigger, 'agent-idle')
    engine.stopAutomation()
  } finally {
    await dav.close()
    await pair.cleanup?.()
  }
})

test('D4/D5 同内容换路径不去重传：速度按真实过网字节算', async () => {
  const pair = await createSandboxPair()
  const dav = await startMockWebdav()
  try {
    const shared = 'x'.repeat(200 * 1024)
    await writeText(path.join(pair.b.workspace, 'a.txt'), shared)
    const b = await makeDevice(pair.b, { name: 'B', rootPath: pair.b.workspace, targets: [davTarget(dav.url)] })

    // 第一次：对象要真的过网。
    const first = (await b.engine.sync({ mode: 'push', trigger: 'test' })).reports[0]
    assert.equal(first.ok, true, first.error ?? '')
    assert.ok(first.wireBytesUp > 0, '首次必须真的上传字节')

    // 改名但内容不变：key 变了要重新推，但对象已在远端 → 应当 0 上传。
    await fsp.rm(path.join(pair.b.workspace, 'a.txt'))
    await writeText(path.join(pair.b.workspace, 'b.txt'), shared)
    const second = (await b.engine.sync({ mode: 'push', trigger: 'test' })).reports[0]

    assert.equal(second.ok, true, second.error ?? '')
    assert.ok(second.pushed >= 1, '改名后的新 key 要进入上传计划')
    assert.ok(second.skippedUploads >= 1, `同内容对象必须被去重跳过，实际 ${second.skippedUploads}`)
    assert.equal(second.wireBytesUp, 0, '去重跳过的对象不应产生上传字节')
    assert.ok(
      second.dedupeSavedBytes >= 200 * 1024 - 4096,
      `省下的字节应≈文件大小，实际 ${second.dedupeSavedBytes}`,
    )
    assert.ok(second.bytesUp > 0, '逻辑上传量仍要记录，用来解释"没走网"')
    // 真实速度：没有过网字节时不能出现漂亮数字。
    assert.equal(second.bytesPerSecond, 0, `去重后真实速度应为 0，实际 ${second.bytesPerSecond}`)
    assert.equal(second.upBytesPerSecond, 0)
  } finally {
    await dav.close()
    await pair.cleanup?.()
  }
})

test('D6 已存在集合返回 423 Locked 时不能报错（123pan 实测行为）', async () => {
  const pair = await createSandboxPair()
  const dav = await startMockWebdav({ mkcolExistingStatus: 423 })
  try {
    await writeText(path.join(pair.a.workspace, 'a.txt'), 'A')
    const { engine } = await makeDevice(pair.a, {
      name: 'A',
      rootPath: pair.a.workspace,
      targets: [davTarget(dav.url)],
    })
    const first = (await engine.sync({ mode: 'push', trigger: 'test' })).reports[0]
    assert.equal(first.ok, true, first.error ?? '')
    assert.ok(first.pushed >= 1)

    // 第二次：集合已存在，MKCOL 会拿到 423；不能因此失败。
    await writeText(path.join(pair.a.workspace, 'b.txt'), 'B')
    const second = (await engine.sync({ mode: 'push', trigger: 'test' })).reports[0]
    assert.equal(second.ok, true, second.error ?? '')
    assert.ok(second.pushed >= 1)
  } finally {
    await dav.close()
    await pair.cleanup?.()
  }
})
