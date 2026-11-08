/**
 * Agent 工具：dsh_sync_configure / dsh_sync_pair 的注册与执行。
 * 用真实 SyncEngine + 假 tools 服务，确保模型口述地址/账号/密码即可配置。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { SyncStore } from '../lib/state.js'
import { SyncEngine } from '../lib/engine/engine.js'
import { registerTools } from '../lib/tools.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

async function makeHarness(base) {
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
  const engine = new SyncEngine({ store, logger: silentLogger })
  await engine.updateConfig({
    deviceName: 'tool-test',
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    roots: [{ id: 'data', label: 'data', path: root, enabled: true, exclude: [] }],
    targets: [{ id: 'local', type: 'local', label: 'local', enabled: true, path: storeDir }],
  })
  const defs = new Map()
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (def) => { defs.set(def.name, def); return () => defs.delete(def.name) } } : null),
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
  registerTools(ctx, { engine, ready: Promise.resolve(), logger: silentLogger })
  return { engine, storeDir, defs }
}

test('工具注册齐全，configure 能配置本地目标并测试连接', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsync-tools-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const { engine, storeDir, defs } = await makeHarness(base)
  for (const name of ['dsh_sync_status', 'dsh_sync_run', 'dsh_sync_configure', 'dsh_sync_pair', 'dsh_sync_export', 'dsh_sync_import']) {
    assert.ok(defs.has(name), `缺少工具 ${name}`)
  }

  const configure = defs.get('dsh_sync_configure')
  const output = await configure.execute({
    type: 'local',
    label: '口述配置的本地目录',
    path: storeDir,
    sync: false,
  })
  assert.match(output, /已配置目标：local/)
  assert.match(output, /连接测试：成功/)
  assert.match(output, /同步：未执行/)
  assert.equal(engine.config.targets.find((item) => item.id === 'local').label, '口述配置的本地目录')
})

test('configure 拒绝非法 webdav 地址，pair 拒绝坏码', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsync-tools-bad-'))
  t.after(() => fsp.rm(base, { recursive: true, force: true }))
  const { defs } = await makeHarness(base)
  const configure = defs.get('dsh_sync_configure')
  await assert.rejects(() => configure.execute({ type: 'webdav', url: 'ftp://example.com', username: 'u', password: 'p' }), /url 必须是 http/)
  await assert.rejects(() => configure.execute({ type: 'nope' }), /type 必须是/)
  const pair = defs.get('dsh_sync_pair')
  await assert.rejects(() => pair.execute({ code: 'not-a-code' }), /不是 dsh-sync 配对码/)
})