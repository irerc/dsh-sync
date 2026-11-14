/**
 * 「完整备份」与跨设备恢复（工作区文件 + 对话文件一起打包）。
 *
 * 覆盖：
 *   W1 工作区过滤：危险祖先（/root 等）与系统目录被拒；嵌套工作区被合并
 *   W2 已被既有根覆盖的工作区不重复打包
 *   M1 manifest 顶层带根路径，旧归档（无 roots）仍可解析
 *   I1 导入时根 id 对不上 → 按路径兜底匹配到本地同路径根
 *   I2 根 id 与路径都匹配不到 → 计入 skipped，并写 warn 日志（不静默吞）
 *   E1 scope:'full' 导出：工作区文件与对话文件确实在同一个归档里
 *   E2 完整备份可被另一台设备按路径恢复
 */

import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { SyncEngine } from '../lib/engine/engine.js'
import { SyncStore } from '../lib/state.js'
import {
  detectWorkspaces,
  rootRejectionReason,
  selectBackupWorkspaces,
  workspacesFromStorage,
} from '../lib/engine/workspaces.js'
import { createDeviceManifest, normalizeManifest } from '../lib/engine/manifest.js'
import { parseArchive } from '../lib/engine/archive.js'
import { createSandbox, exists, writeText } from './support/fakes.mjs'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

/* ------------------------------------------------------------------ */
/* W：工作区过滤                                                        */
/* ------------------------------------------------------------------ */

test('W1 危险路径与系统目录被拒绝作为备份根', () => {
  const cases = [
    ['/', /系统级祖先|系统目录/],
    ['/root', /系统级祖先|系统目录/],
    ['/data', /系统级祖先|系统目录/],
    ['/usr', /系统级祖先|系统目录/],
    ['/proc', /系统级祖先|系统目录/],
    ['/android-sdk', /系统级祖先|系统目录/],
    ['relative/path', /绝对路径/],
  ]
  for (const [candidate, expected] of cases) {
    const reason = rootRejectionReason(candidate, { dshHome: '/root/.dsh' })
    assert.match(reason, expected, `${candidate} 应被拒绝，实际原因：${reason || '(空)'}`)
  }
  // 正常工作区必须放行
  assert.equal(rootRejectionReason('/root/小工具', { dshHome: '/root/.dsh' }), '')
  assert.equal(rootRejectionReason('/root/.dsh', { dshHome: '/root/.dsh' }), '', 'DSH 主目录本身可备份')
  assert.equal(rootRejectionReason('/root/Documents/x', { dshHome: '/root/.dsh' }), '')
})

test('W2 嵌套工作区只保留更具体的那个', () => {
  const { kept, dropped } = selectBackupWorkspaces([
    { id: 'a', title: '外层', path: '/root/proj' },
    { id: 'b', title: '内层', path: '/root/proj/sub' },
    { id: 'c', title: '独立', path: '/root/other' },
  ])
  assert.deepEqual(kept.map((item) => item.path).sort(), ['/root/other', '/root/proj/sub'])
  const droppedPaths = dropped.map((item) => item.path)
  assert.ok(droppedPaths.includes('/root/proj'), `应丢弃外层，实际丢弃：${droppedPaths}`)
})

test('W3 已被既有根覆盖的工作区不再重复打包', () => {
  const { kept, dropped } = selectBackupWorkspaces(
    [
      { id: 'a', title: '文档子目录', path: '/root/Documents/deepseek-harness/default-workspace' },
      { id: 'b', title: '独立', path: '/root/独立' },
    ],
    { coveredBy: ['/root/Documents'] },
  )
  assert.deepEqual(kept.map((item) => item.path), ['/root/独立'])
  assert.ok(dropped.some((item) => item.reason.includes('已被根目录')))
})

test('W4 workspace.json 解析：坏数据不抛错', () => {
  assert.deepEqual(workspacesFromStorage(null), [])
  assert.deepEqual(workspacesFromStorage({}), [])
  assert.deepEqual(workspacesFromStorage({ tables: {} }), [])
  const parsed = workspacesFromStorage({
    tables: {
      workspaces: {
        x: { path: '/root/a', title: '' },
        y: { path: '' },
        z: { title: '没有路径' },
      },
    },
  })
  assert.deepEqual(parsed.map((item) => item.path), ['/root/a'])
  assert.equal(parsed[0].title, '/root/a', '空标题回退为路径')
})

test('W5 真实 workspace.json 缺失时返回空集', async () => {
  const sandbox = await createSandbox({ prefix: 'dsh-sync-ws-' })
  try {
    const result = await detectWorkspaces({ dshHome: sandbox.dshHome })
    assert.deepEqual(result.kept, [])
    assert.equal(result.total ?? 0, 0)
  } finally {
    await sandbox.cleanup()
  }
})

/* ------------------------------------------------------------------ */
/* M：manifest 根路径                                                  */
/* ------------------------------------------------------------------ */

test('M1 manifest 记录根路径；旧归档无 roots 字段仍可解析', () => {
  const manifest = createDeviceManifest({
    deviceId: 'a1b2c3d4'.repeat(4),
    deviceName: 'dev',
    roots: [
      { id: 'sessions', path: '/root/.dsh/sessions' },
      { id: 'ws-abc', path: '/root/小工具' },
    ],
    entries: new Map(),
    tombstones: new Map(),
    now: 1,
  })
  assert.equal(manifest.roots.length, 2)
  const normalized = normalizeManifest(manifest)
  assert.equal(normalized.rootPaths.get('ws-abc'), '/root/小工具')

  // 旧归档：把 roots 去掉，仍要被接受（向后兼容）
  const legacy = { ...manifest }
  delete legacy.roots
  const legacyParsed = normalizeManifest(legacy)
  assert.ok(legacyParsed, '旧归档必须仍可解析')
  assert.equal(legacyParsed.rootPaths.size, 0, '旧归档没有根路径信息')
})

test('M2 非法 roots 条目被忽略，不污染映射', () => {
  const base = createDeviceManifest({
    deviceId: 'a1b2c3d4'.repeat(4),
    deviceName: 'dev',
    entries: new Map(),
    tombstones: new Map(),
    now: 1,
  })
  const normalized = normalizeManifest({
    ...base,
    roots: [
      { id: '', path: '/root/x' },
      { id: 'ok', path: 'relative/path' },
      { id: 'good', path: '/root/good' },
      null,
      'nonsense',
    ],
  })
  assert.equal(normalized.rootPaths.size, 1)
  assert.equal(normalized.rootPaths.get('good'), '/root/good')
})

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

async function makeDevice(sandbox, { name, roots }) {
  const store = new SyncStore({
    homeDir: sandbox.dshHome,
    logger: silentLogger,
    env: sandbox.env,
  })
  await store.load()
  const engine = new SyncEngine({ store, logger: silentLogger })
  await engine.updateConfig({
    deviceName: name,
    autoSync: false,
    autoSave: false,
    syncOnStart: false,
    roots,
    targets: [],
  })
  return { store, engine }
}

/** 在 DSH_HOME 下写一份 workspace.json（模拟 DSH 自己的登记）。 */
async function seedWorkspaces(dshHome, workspaces) {
  const dir = path.join(dshHome, 'storages')
  await fsp.mkdir(dir, { recursive: true })
  const table = {}
  for (const item of workspaces) {
    table[item.id] = { id: item.id, title: item.title, path: item.path, sessionIds: [] }
  }
  await fsp.writeFile(
    path.join(dir, 'workspace.json'),
    JSON.stringify({ unit: { name: 'workspace', version: 2 }, tables: { workspaces: table } }),
  )
}

/* ------------------------------------------------------------------ */
/* E：完整备份端到端                                                    */
/* ------------------------------------------------------------------ */

test('E1 scope=full：工作区文件与对话文件在同一个归档里', async () => {
  const sandbox = await createSandbox({ prefix: 'dsh-sync-full-' })
  try {
    const workspaceDir = path.join(sandbox.root, 'my-workspace')
    const sessionsDir = path.join(sandbox.dshHome, 'sessions')
    await fsp.mkdir(workspaceDir, { recursive: true })
    await fsp.mkdir(sessionsDir, { recursive: true })
    await writeText(path.join(workspaceDir, 'note.md'), '# 工作区笔记')
    await writeText(path.join(sessionsDir, 'session-1.jsonl'), '{"role":"user"}')

    await seedWorkspaces(sandbox.dshHome, [
      { id: 'w1', title: '我的工作区', path: workspaceDir },
    ])

    const device = await makeDevice(sandbox, {
      name: 'full-A',
      roots: [
        { id: 'sessions', label: '会话', path: sessionsDir, enabled: true, exclude: [] },
      ],
    })

    const exported = await device.engine.exportArchive({ scope: 'full' })
    assert.equal(exported.ok, true)
    assert.equal(exported.scope, 'full')
    assert.equal(exported.workspaces.kept, 1, '应纳入 1 个工作区')

    const bytes = await fsp.readFile(exported.path)
    const parsed = await parseArchive(bytes)
    const manifest = normalizeManifest(parsed.manifest)
    const paths = [...manifest.entries.values()].map((entry) => entry.path).sort()
    assert.ok(
      paths.some((item) => item.endsWith('note.md')),
      `工作区文件必须在归档里，实际：${JSON.stringify(paths)}`,
    )
    assert.ok(
      paths.some((item) => item.endsWith('session-1.jsonl')),
      `对话文件必须在归档里，实际：${JSON.stringify(paths)}`,
    )
    // 归档必须记录工作区根的原路径，供换设备恢复
    const rootPaths = [...manifest.rootPaths.values()]
    assert.ok(rootPaths.includes(workspaceDir), `manifest 应记录工作区路径，实际：${JSON.stringify(rootPaths)}`)
  } finally {
    await sandbox.cleanup()
  }
})

test('E2 另一台设备用完整备份按路径恢复（根 id 不同也能还原）', async () => {
  const sandboxA = await createSandbox({ prefix: 'dsh-sync-resc-a-' })
  const sandboxB = await createSandbox({ prefix: 'dsh-sync-resc-b-' })
  try {
    // 两台设备“同一个工作区路径”——这是换机/重装后的真实情形
    const sharedWorkspace = path.join(sandboxA.root, 'shared-workspace')
    await fsp.mkdir(sharedWorkspace, { recursive: true })
    await writeText(path.join(sharedWorkspace, 'important.txt'), '要救回来的数据')

    await seedWorkspaces(sandboxA.dshHome, [
      { id: 'wa', title: '工作区A', path: sharedWorkspace },
    ])

    const a = await makeDevice(sandboxA, {
      name: 'dev-A',
      roots: [{ id: 'documents', label: '文档', path: sharedWorkspace, enabled: true, exclude: [] }],
    })
    const exported = await a.engine.exportArchive({ scope: 'full' })
    const bytes = await fsp.readFile(exported.path)

    // B 设备：根 id 完全不同（模拟 id 由 label 派生、两机不一致）
    const bWorkspace = sandboxB.root
    await fsp.mkdir(bWorkspace, { recursive: true })
    const b = await makeDevice(sandboxB, {
      name: 'dev-B',
      roots: [
        {
          id: 'different-id',
          label: '另一个名字',
          path: bWorkspace,
          enabled: true,
          exclude: [],
        },
      ],
    })

    const report = await b.engine.importArchive({ bytes, name: exported.name })
    assert.equal(report.ok, true)
    // 根 id 对不上、路径也不同 → 必须计入 skipped，而不是 silent 崩溃
    assert.ok(report.skipped >= 1, `应在报告中体现跳过，实际 ${JSON.stringify(report)}`)
    assert.ok(
      b.store.state.logs.some((log) => log.message.includes('归档中的根')),
      '必须留下“根不存在”的可诊断日志',
    )
  } finally {
    await sandboxA.cleanup()
    await sandboxB.cleanup()
  }
})

test('E3 同路径不同 id：导入按路径兜底成功还原', async () => {
  const sandboxA = await createSandbox({ prefix: 'dsh-sync-path-a-' })
  const sandboxB = await createSandbox({ prefix: 'dsh-sync-path-b-' })
  try {
    const shared = path.join(sandboxA.root, 'ws')
    await fsp.mkdir(shared, { recursive: true })
    await writeText(path.join(shared, 'data.txt'), '跨设备内容')

    await seedWorkspaces(sandboxA.dshHome, [{ id: 'w', title: 'WS', path: shared }])
    const a = await makeDevice(sandboxA, {
      name: 'A',
      roots: [{ id: 'root-a', label: 'A', path: shared, enabled: true, exclude: [] }],
    })
    const exported = await a.engine.exportArchive({ scope: 'full' })
    const bytes = await fsp.readFile(exported.path)

    // B：同一路径、不同 id → 路径兜底应命中
    const b = await makeDevice(sandboxB, {
      name: 'B',
      roots: [{ id: 'root-b-totally-different', label: 'B', path: shared, enabled: true, exclude: [] }],
    })
    // 清空 B 侧内容，模拟“新设备空目录”
    await fsp.rm(shared, { recursive: true, force: true })
    await fsp.mkdir(shared, { recursive: true })

    const report = await b.engine.importArchive({ bytes, name: exported.name })
    assert.equal(report.ok, true)
    assert.ok(report.imported >= 1, `按路径兜底后必须真正写入，报告：${JSON.stringify(report)}`)
    assert.equal(await fsp.readFile(path.join(shared, 'data.txt'), 'utf8'), '跨设备内容')
  } finally {
    await sandboxA.cleanup()
    await sandboxB.cleanup()
  }
})

test('E4 完整备份结束后临时根被清理，普通同步不受影响', async () => {
  const sandbox = await createSandbox({ prefix: 'dsh-sync-clean-' })
  try {
    const workspaceDir = path.join(sandbox.root, 'ws-clean')
    await fsp.mkdir(workspaceDir, { recursive: true })
    await writeText(path.join(workspaceDir, 'f.txt'), 'x')
    await seedWorkspaces(sandbox.dshHome, [{ id: 'w', title: 'W', path: workspaceDir }])
    const device = await makeDevice(sandbox, { name: 'C', roots: [] })

    await device.engine.exportArchive({ scope: 'full' })
    assert.equal(device.engine._exportRoots, null, '导出后必须清理临时根')

    // 清理后 rootById 不应再解析到工作区根
    const leaked = device.engine.config.roots.find((root) => root.path === workspaceDir)
    assert.equal(leaked, undefined, '工作区不得被偷偷写进配置')
  } finally {
    await sandbox.cleanup()
  }
})

test('E5 超出预算的工作区被跳过并记入报告（不会撑爆归档）', async () => {
  const sandbox = await createSandbox({ prefix: 'dsh-sync-budget-' })
  try {
    const small = path.join(sandbox.root, 'ws-small')
    const large = path.join(sandbox.root, 'ws-large')
    await fsp.mkdir(small, { recursive: true })
    await fsp.mkdir(large, { recursive: true })
    await writeText(path.join(small, 'a.txt'), '小')
    // 大工作区：稀疏文件占 20MiB「体积」但不吃磁盘；预算下限 16MiB 必然放不下
    const sparse = await fsp.open(path.join(large, 'big.bin'), 'w')
    await sparse.truncate(20 * 1024 * 1024)
    await sparse.close()

    await seedWorkspaces(sandbox.dshHome, [
      { id: 'w-small', title: '小工作区', path: small },
      { id: 'w-large', title: '大工作区', path: large },
    ])

    const device = await makeDevice(sandbox, { name: 'budget', roots: [] })
    // maxArchiveBytes 下限为 16MiB，小工作区仍能进、20MiB 的必须被跳过
    await device.engine.updateConfig({ maxArchiveBytes: 16 * 1024 * 1024 })

    const exported = await device.engine.exportArchive({ scope: 'full' })
    assert.equal(exported.ok, true)
    const report = exported.workspaces
    assert.equal(report.kept, 1, `应只纳入小工作区，报告：${JSON.stringify(report)}`)
    assert.equal(report.skippedTooBig.length, 1)
    assert.equal(report.skippedTooBig[0].title, '大工作区')
    assert.ok(
      device.store.state.logs.some((log) => log.message.includes('完整备份跳过工作区')),
      '跳过大工作区必须留下日志',
    )

    const parsed = await parseArchive(await fsp.readFile(exported.path))
    const paths = [...normalizeManifest(parsed.manifest).entries.values()].map((entry) => entry.path)
    assert.ok(paths.some((item) => item.endsWith('a.txt')), '小工作区必须进归档')
    assert.ok(!paths.some((item) => item.endsWith('big.bin')), '大工作区不得进归档')
  } finally {
    await sandbox.cleanup()
  }
})

test('E6 已启用根占用额度后，工作区可用预算相应减少', async () => {
  const sandbox = await createSandbox({ prefix: 'dsh-sync-base-' })
  try {
    const sessionsDir = path.join(sandbox.dshHome, 'sessions')
    const workspaceDir = path.join(sandbox.root, 'ws')
    await fsp.mkdir(sessionsDir, { recursive: true })
    await fsp.mkdir(workspaceDir, { recursive: true })
    // 会话根占 20MiB（稀疏），额度 16MiB → 基线已超，工作区额度应为 0
    const sessionFile = await fsp.open(path.join(sessionsDir, 'big.jsonl'), 'w')
    await sessionFile.truncate(20 * 1024 * 1024)
    await sessionFile.close()
    await writeText(path.join(workspaceDir, 'w.txt'), 'x')

    await seedWorkspaces(sandbox.dshHome, [{ id: 'w', title: 'W', path: workspaceDir }])
    const device = await makeDevice(sandbox, {
      name: 'base',
      roots: [{ id: 'sessions', label: '会话', path: sessionsDir, enabled: true, exclude: [] }],
    })
    await device.engine.updateConfig({ maxArchiveBytes: 16 * 1024 * 1024 })

    const exported = await device.engine.exportArchive({ scope: 'full' })
    const report = exported.workspaces
    assert.ok(report.baselineBytes >= 16 * 1024 * 1024, `基线应统计已启用根，实际 ${report.baselineBytes}`)
    assert.ok(report.workspaceBudget < report.budget, '工作区额度必须小于总预算')
    assert.equal(report.kept, 0, `额度不足时不应纳入工作区，报告：${JSON.stringify(report)}`)
  } finally {
    await sandbox.cleanup()
  }
})

test('E7 换机恢复：新设备没有该根时按归档路径补建并落盘', async () => {
  const sandbox = await createSandbox({ prefix: 'dsh-sync-mig-' })
  try {
    // 真实换机布局：两台设备共用同一个父目录，只是各自的 DSH home 不同
    const baseDir = path.dirname(sandbox.dshHome)
    const workspaceDir = path.join(baseDir, 'ws-migrate')
    await fsp.mkdir(workspaceDir, { recursive: true })
    await writeText(path.join(workspaceDir, 'precious.txt'), '救回来')

    const a = await makeDevice(sandbox, {
      name: 'old-phone',
      roots: [{ id: 'ws', label: '工作区', path: workspaceDir, enabled: true, exclude: [] }],
    })
    const exported = await a.engine.exportArchive({ scope: 'full' })
    const bytes = await fsp.readFile(exported.path)

    // 新设备：另一个 DSH home（模拟重装/换机），父目录相同，配置里没有这个根
    const newHome = path.join(baseDir, '.dsh-new')
    await fsp.mkdir(newHome, { recursive: true })
    const newStore = new SyncStore({ homeDir: newHome, logger: silentLogger, env: { ...sandbox.env, DSH_HOME: newHome } })
    await newStore.load()
    const b = new SyncEngine({ store: newStore, logger: silentLogger })
    await b.updateConfig({
      deviceName: 'new-phone', autoSync: false, autoSave: false, syncOnStart: false, roots: [], targets: [],
    })

    const report = await b.importArchive({ bytes, name: exported.name })
    assert.equal(report.ok, true)
    assert.ok(report.adoptedRoots.length >= 1, `应补建根，报告：${JSON.stringify(report)}`)
    assert.ok(b.config.roots.some((root) => root.path === workspaceDir), '补建根必须进入配置')
    assert.equal(await fsp.readFile(path.join(workspaceDir, 'precious.txt'), 'utf8'), '救回来')

    // 落盘验证：重新加载配置后根还在
    const reloaded = new SyncStore({ homeDir: newHome, logger: silentLogger, env: { ...sandbox.env, DSH_HOME: newHome } })
    await reloaded.load()
    assert.ok(reloaded.config.roots.some((root) => root.path === workspaceDir), '补建根必须写进磁盘配置')
  } finally {
    await sandbox.cleanup()
  }
})

test('E8 归档声称的路径在本机可信目录外时拒绝补建（不越界写）', async () => {
  const sandboxA = await createSandbox({ prefix: 'dsh-sync-safe-a-' })
  const sandboxB = await createSandbox({ prefix: 'dsh-sync-safe-b-' })
  try {
    const outside = path.join(sandboxA.root, 'outside-ws')
    await fsp.mkdir(outside, { recursive: true })
    await writeText(path.join(outside, 'x.txt'), '不该被写出')

    const a = await makeDevice(sandboxA, {
      name: 'src',
      roots: [{ id: 'out', label: '外', path: outside, enabled: true, exclude: [] }],
    })
    const exported = await a.engine.exportArchive({ scope: 'full' })
    const bytes = await fsp.readFile(exported.path)

    const b = await makeDevice(sandboxB, { name: 'dst', roots: [] })
    const report = await b.engine.importArchive({ bytes, name: exported.name })
    assert.equal(report.ok, true)
    assert.equal(report.adoptedRoots.length, 0, '不得补建越界根')
    assert.ok(report.skipped >= 1, '越界条目必须计入跳过')
    assert.ok(
      b.store.state.logs.some((log) => log.message.includes('拒绝按归档路径补建根')),
      '必须留下拒绝日志',
    )
  } finally {
    await sandboxA.cleanup()
    await sandboxB.cleanup()
  }
})
