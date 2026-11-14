/**
 * 完整应用数据（scope=app）测试。
 *
 * 目标行为：新设备装好 DSH、导入归档后，会话/设置/插件启用状态/账号凭据/自有插件源码
 * 都与原机一致；可重建的东西（node_modules、下载的二进制、缓存）不进包。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  APP_HOME_EXCLUDES,
  LINK_EXCLUDES,
  RESTORE_DOC_MEMBER,
  RESTORE_MEMBER,
  RESTORE_SH_MEMBER,
  appDataRoots,
  buildRestorePlan,
  detectDshVersion,
  detectLinkSources,
  linkRootId,
  renderRestoreDoc,
  renderRestoreScript,
} from '../lib/engine/appdata.js'
import { isExcluded } from '../lib/engine/scan.js'

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

async function mkTemp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

/* ------------------------------------------------------------------ */
/* A1–A3 根清单与排除项                                                */
/* ------------------------------------------------------------------ */

test('A1 app 根：DSH_HOME 在第一位，link 源码按路径推出稳定 id', () => {
  const roots = appDataRoots({
    dshHome: '/root/.dsh',
    profileDir: '/root/.dsh/profiles/web',
    linkSources: [
      { name: 'dsh-a', path: '/root/dsha-a', exists: true },
      { name: 'dsh-b', path: '/root/dsha-b', exists: true },
    ],
  })
  assert.equal(roots.length, 3)
  assert.equal(roots[0].id, 'dsh-home')
  assert.equal(roots[0].path, '/root/.dsh')
  assert.equal(roots[0].includeSecrets, true, '默认要带凭据，否则新设备得重新登录')
  // id 由路径决定：同一路径在任何机器上都得到同一个 id。
  assert.equal(roots[1].id, linkRootId('/root/dsha-a'))
  assert.equal(roots[1].id, roots[1].id.toLowerCase())
  assert.equal(roots[2].id, linkRootId('/root/dsha-b'))
  // link 源码不需要凭据
  assert.equal(roots[1].includeSecrets, false)
})

test('A2 app 根：不存在的 link 源码不进根列表', () => {
  const roots = appDataRoots({
    dshHome: '/root/.dsh',
    profileDir: '/root/.dsh/profiles/web',
    linkSources: [{ name: 'gone', path: '/root/gone', exists: false }],
  })
  assert.equal(roots.length, 1, '只保留 DSH_HOME')
})

test('A3 排除项：可重建的内容都不该进包', () => {
  const checks = [
    ['dsh-sync/store/objects/abc', true, '同步存储自身'],
    ['profiles/web/node_modules/foo/index.js', true, 'node_modules'],
    ['node_modules/x/y.js', true, '根上的 node_modules'],
    ['mobile-access/components/cloudflared/bin', true, '下载的二进制'],
    ['storages/dsh-deepseek-web/native-libs/lib.so', true, '原生库'],
    ['storages/dsh-deepseek-web/native-venv/py', true, 'venv'],
    ['cache/foo.bin', true, '缓存'],
    ['logs/today.log', true, '日志'],
    ['plugin-install-operations/tmp/x', true, '安装中间态'],
    ['storages/session_projcache/s.json', true, '投影缓存'],
    ['profiles/web/cordis.patch.yml.bak-1792916992997', true, '编辑器备份噪音'],
    // 真正要带上的
    ['sessions/s1.jsonl', false, '会话'],
    ['.credentials.yaml', false, '凭据（由 includeSecrets 放行，排除项本身不该拦）'],
    ['storages/workspace.json', false, '工作区登记'],
    ['plugin-activations.json', false, '插件启用状态'],
    ['profiles/web/cordis.yml', false, '插件编排'],
    ['attachments/a.png', false, '附件'],
  ]
  for (const [relPath, expected, label] of checks) {
    assert.equal(isExcluded(relPath, APP_HOME_EXCLUDES), expected, `${label}（${relPath}）`)
  }
  // link 源码目录的排除项
  assert.equal(isExcluded('node_modules/x.js', LINK_EXCLUDES), true)
  assert.equal(isExcluded('.git/HEAD', LINK_EXCLUDES), true)
  assert.equal(isExcluded('store/objects/abc', LINK_EXCLUDES), true)
  assert.equal(isExcluded('lib/index.js', LINK_EXCLUDES), false)
})

/* ------------------------------------------------------------------ */
/* A4–A5 link 依赖探测                                                 */
/* ------------------------------------------------------------------ */

test('A4 detectLinkSources：只认 link: 依赖，路径为相对时按 profile 解析', async () => {
  const tmp = await mkTemp('appdata-link-')
  try {
    const profileDir = path.join(tmp, 'profiles', 'web')
    await fsp.mkdir(path.join(tmp, 'my-plugin'), { recursive: true })
    await fsp.mkdir(profileDir, { recursive: true })
    await fsp.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        'rel-plugin': `link:${path.join(tmp, 'my-plugin')}`,
        'versioned': '^1.2.3',
        'file-dep': 'file:../somewhere',
      },
    }))
    const links = await detectLinkSources({ profileDir })
    assert.equal(links.length, 1, '只有 link: 才算自有源码')
    assert.equal(links[0].name, 'rel-plugin')
    assert.equal(links[0].path, path.join(tmp, 'my-plugin'))
    assert.equal(links[0].exists, true)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('A5 detectLinkSources：profile 没有 package.json 时返回空数组', async () => {
  const tmp = await mkTemp('appdata-nopkg-')
  try {
    assert.deepEqual(await detectLinkSources({ profileDir: tmp }), [])
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* A6–A8 恢复计划                                                      */
/* ------------------------------------------------------------------ */

test('A6 恢复计划：步骤顺序是「落盘 → 源码 → 安装 → 重启」', () => {
  const plan = buildRestorePlan({
    dshHome: '/root/.dsh',
    profileDir: '/root/.dsh/profiles/web',
    dshVersion: '0.2.2',
    linkSources: [{ name: 'a', path: '/root/a', exists: true }],
  })
  assert.deepEqual(plan.steps.map((s) => s.id), ['files', 'links', 'install', 'restart'])
  assert.equal(plan.installer, 'pnpm')
  assert.equal(plan.lockfile, 'pnpm-lock.yaml')
  assert.equal(plan.dshVersion, '0.2.2')
  assert.equal(plan.linkSources.length, 1)
  assert.equal(plan.includeSecrets, true)
})

test('A7 恢复说明与脚本：包含 profile 目录、安装命令与凭据提示', () => {
  const plan = buildRestorePlan({
    dshHome: '/root/.dsh',
    profileDir: '/root/.dsh/profiles/web',
    linkSources: [{ name: 'my-plugin', path: '/root/my-plugin', exists: true }],
    includeSecrets: true,
  })
  const doc = renderRestoreDoc(plan)
  assert.match(doc, /\/root\/\.dsh\/profiles\/web/)
  assert.match(doc, /pnpm install --frozen-lockfile/)
  assert.match(doc, /my-plugin/)
  assert.match(doc, /凭据/, '带凭据时必须写明风险')

  const script = renderRestoreScript(plan)
  assert.match(script, /^#!\/usr\/bin\/env bash/)
  assert.match(script, /set -euo pipefail/)
  assert.match(script, /\/root\/my-plugin/, '要检查源码在原路径')
  assert.match(script, /pnpm install/)
  // 不带凭据时文档不该再喊"包含凭据"
  const noSecret = renderRestoreDoc({ ...plan, includeSecrets: false })
  assert.match(noSecret, /未包含账号凭据/)
})

test('A8 恢复计划：没有 link 源码时脚本不检查目录，只装依赖', () => {
  const plan = buildRestorePlan({
    dshHome: '/root/.dsh',
    profileDir: '/root/.dsh/profiles/web',
    linkSources: [],
  })
  const script = renderRestoreScript(plan)
  assert.match(script, /没有 link 依赖/)
  assert.doesNotMatch(script, /missing=1/)
})

/* ------------------------------------------------------------------ */
/* A9–A11 端到端：导出 → 换 home → 导入                                 */
/* ------------------------------------------------------------------ */

async function makeDevice({ home, profile = 'web' }) {
  const { SyncStore } = await import('../lib/state.js')
  const { SyncEngine } = await import('../lib/engine/engine.js')
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_PROFILE: profile,
    DSH_PROFILE_DIR: path.join(home, 'profiles', profile),
  }
  const store = new SyncStore({ homeDir: home, logger: silentLogger, env })
  await store.load()
  const engine = new SyncEngine({ store, logger: silentLogger })
  await engine.updateConfig({ autoSync: false, autoSave: false, syncOnStart: false })
  return { store, engine }
}

test('A9 完整应用数据往返：会话/凭据/插件状态/自有源码全部落到新 home', async () => {
  const tmp = await mkTemp('appdata-e2e-')
  try {
    const srcHome = path.join(tmp, 'src', '.dsh')
    const pluginDir = path.join(tmp, 'src', 'my-plugin')
    const dstHome = path.join(tmp, 'dst', '.dsh')
    await fsp.mkdir(path.join(srcHome, 'sessions'), { recursive: true })
    await fsp.mkdir(path.join(srcHome, 'storages'), { recursive: true })
    await fsp.mkdir(path.join(srcHome, 'profiles', 'web'), { recursive: true })
    await fsp.mkdir(pluginDir, { recursive: true })
    await fsp.mkdir(path.join(pluginDir, 'node_modules', 'dep'), { recursive: true })

    await fsp.writeFile(path.join(srcHome, 'sessions', 's1.jsonl'), '{"m":"hi"}\n')
    await fsp.writeFile(path.join(srcHome, '.credentials.yaml'), 'token: SECRET\n')
    await fsp.writeFile(path.join(srcHome, 'plugin-activations.json'), '{"dsh-sync":true}')
    await fsp.writeFile(path.join(srcHome, 'storages', 'workspace.json'), '{"tables":{}}')
    await fsp.writeFile(path.join(srcHome, 'profiles', 'web', 'cordis.yml'), 'plugins: []\n')
    await fsp.writeFile(path.join(srcHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: { 'my-plugin': `link:${pluginDir}` },
    }))
    await fsp.writeFile(path.join(pluginDir, 'index.js'), 'export const x = 1\n')
    // node_modules 必须被排除
    await fsp.writeFile(path.join(pluginDir, 'node_modules', 'dep', 'index.js'), 'dep\n')

    const src = await makeDevice({ home: srcHome })
    const exported = await src.engine.exportArchive({ scope: 'app' })
    assert.equal(exported.ok, true)
    assert.equal(exported.scope, 'app')

    const bytes = await fsp.readFile(exported.path)
    const { parseArchive } = await import('../lib/engine/archive.js')
    const parsed = await parseArchive(bytes)
    const keys = [...parsed.manifest.entries.values()].map((e) => e.key)
    assert.ok(keys.some((k) => k.endsWith('sessions/s1.jsonl')), '会话必须进包')
    assert.ok(keys.some((k) => k.endsWith('.credentials.yaml')), '凭据必须进包（默认带）')
    assert.ok(keys.some((k) => k.endsWith('plugin-activations.json')), '插件启用状态必须进包')
    assert.ok(keys.some((k) => k.endsWith('cordis.yml')), '插件编排必须进包')
    // 自有插件源码是独立根，key 是 `<link 根 id>/index.js`，不含原目录名。
    assert.ok(keys.some((k) => k.startsWith('link-') && k.endsWith('/index.js')), '自有插件源码必须进包')
    assert.equal(keys.some((k) => k.includes('node_modules')), false, 'node_modules 不该进包')

    // 换设备：home 路径不同，也要能还原
    const dst = await makeDevice({ home: dstHome })
    const report = await dst.engine.importArchive({ bytes, name: exported.name })
    assert.equal(report.ok, true)
    assert.equal(report.applied, true, `必须真的写入了文件：${report.warning ?? ''}`)

    const read = (rel) => fsp.readFile(path.join(dstHome, rel), 'utf8')
    assert.equal(await read('sessions/s1.jsonl'), '{"m":"hi"}\n')
    assert.equal(await read('.credentials.yaml'), 'token: SECRET\n')
    assert.equal(await read('plugin-activations.json'), '{"dsh-sync":true}')
    assert.equal(await read('profiles/web/cordis.yml'), 'plugins: []\n')
    // 自有插件源码在自身路径上还原（与 home 无关的比较位置）
    assert.equal(await fsp.readFile(path.join(pluginDir, 'index.js'), 'utf8'), 'export const x = 1\n')
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('A10 完整应用数据：不带凭据时 .credentials.yaml 不进包', async () => {
  const tmp = await mkTemp('appdata-nosecret-')
  try {
    const home = path.join(tmp, '.dsh')
    await fsp.mkdir(path.join(home, 'sessions'), { recursive: true })
    await fsp.writeFile(path.join(home, 'sessions', 's1.jsonl'), '{}\n')
    await fsp.writeFile(path.join(home, '.credentials.yaml'), 'token: SECRET\n')

    const dev = await makeDevice({ home })
    await dev.engine.updateConfig({ backupSecrets: false })
    const exported = await dev.engine.exportArchive({ scope: 'app' })
    const bytes = await fsp.readFile(exported.path)
    const { parseArchive } = await import('../lib/engine/archive.js')
    const parsed = await parseArchive(bytes)
    const keys = [...parsed.manifest.entries.values()].map((e) => e.key)
    assert.equal(keys.some((k) => k.endsWith('.credentials.yaml')), false, '关掉后不得带凭据')
    assert.ok(keys.some((k) => k.endsWith('s1.jsonl')), '其余数据照常备份')
    // 恢复计划要如实标注"没带凭据"，否则用户以为含了
    const { gunzipSync } = await import('node:zlib')
    const tarText = gunzipSync(bytes).toString('utf8')
    const at = tarText.indexOf('"scope": "app"')
    assert.ok(at > 0, 'restore.json 应在归档里')
    const slice = tarText.slice(Math.max(0, at - 200), at + 400)
    assert.match(slice, /"includeSecrets": false/)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('A11 归档里带恢复成员：restore.json / RESTORE.md / restore.sh', async () => {
  const tmp = await mkTemp('appdata-members-')
  try {
    const home = path.join(tmp, '.dsh')
    await fsp.mkdir(path.join(home, 'sessions'), { recursive: true })
    await fsp.writeFile(path.join(home, 'sessions', 's1.jsonl'), '{}\n')
    const dev = await makeDevice({ home })
    const exported = await dev.engine.exportArchive({ scope: 'app' })
    const { gunzipSync } = await import('node:zlib')
    const tar = gunzipSync(await fsp.readFile(exported.path))
    const text = tar.toString('latin1')
    for (const member of [RESTORE_MEMBER, RESTORE_DOC_MEMBER, RESTORE_SH_MEMBER]) {
      assert.ok(text.includes(member), `归档必须带 ${member}`)
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ */
/* A12 版本探测                                                        */
/* ------------------------------------------------------------------ */

test('A12 detectDshVersion：环境变量优先，取不到返回空串不编造', async () => {
  assert.equal(await detectDshVersion({ env: { DSH_VERSION: '9.9.9' } }), '9.9.9')
  const detected = await detectDshVersion({ env: {} })
  assert.equal(typeof detected, 'string')
  assert.ok(detected === '' || /^\d+\.\d+/.test(detected), `版本要么空要么像版本号，实际 ${detected}`)
})

test('A13 link 源码原路径不可用时兜底到 linked-plugins（源码不能丢）', async () => {
  const tmp = await mkTemp('appdata-relink-')
  try {
    const srcHome = path.join(tmp, 'a', '.dsh')
    const pluginDir = path.join(tmp, 'a', 'my-plugin')
    const dstHome = path.join(tmp, 'b', '.dsh')
    await fsp.mkdir(path.join(srcHome, 'profiles', 'web'), { recursive: true })
    await fsp.mkdir(pluginDir, { recursive: true })
    await fsp.writeFile(path.join(srcHome, 'profiles', 'web', 'package.json'), JSON.stringify({
      dependencies: { 'my-plugin': `link:${pluginDir}` },
    }))
    await fsp.writeFile(path.join(pluginDir, 'index.js'), 'export const mine = true\n')

    const src = await makeDevice({ home: srcHome })
    const exported = await src.engine.exportArchive({ scope: 'app' })
    const bytes = await fsp.readFile(exported.path)

    // 目标设备的 home 在另一个父目录下：原路径不属于可信目录，adopt 会被拒绝。
    const dst = await makeDevice({ home: dstHome })
    const report = await dst.engine.importArchive({ bytes, name: exported.name })

    assert.equal(report.skipped, 0, '源码不该被丢弃')
    assert.ok(Array.isArray(report.relocatedLinks) && report.relocatedLinks.length === 1, '要报告改放位置')
    const moved = report.relocatedLinks[0]
    assert.equal(moved.from, pluginDir)
    assert.equal(moved.to, path.join(dstHome, 'linked-plugins', 'my-plugin'))
    assert.equal(await fsp.readFile(path.join(moved.to, 'index.js'), 'utf8'), 'export const mine = true\n')
    // 必须留下可操作的提示
    assert.ok(
      dst.store.state.logs.some((log) => log.message.includes('link:') ),
      '要提示用户改 package.json 的 link:',
    )
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

