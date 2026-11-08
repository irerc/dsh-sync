/**
 * dsh-sync Web 设置页的轻量静态自检（不启动浏览器）。
 *
 * 覆盖：
 * 1. 源码形态：模块注册 id、settings.section 注册参数、无 document.body、
 *    无 Harness 运行时包、无 import/iframe、require 只有 react。
 * 2. 运行时注册：用假 window/ctx 执行 factory + apply，捕获 locale 字典与 slot 注册。
 * 3. 字典完整性：源码里出现的点号文案键在 zh/en 中都存在，zh/en 键集合一致。
 * 4. locale/*.json 的 meta.title / meta.description 与 icon.svg 的体积约束。
 *
 * 运行：node --test test/ui-static.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const readText = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------------------
// 1. 源码静态约束
// ---------------------------------------------------------------------------
const source = readText('lib/client.js')

assert.match(source, /window\.__ModuleLoader__\.load\(\{/, '必须注册浏览器模块')
assert.match(source, /id:\s*'dsh-sync'/, '模块 id 必须是 dsh-sync')
assert.match(source, /settings\.section/, '必须注册 settings.section')
assert.match(source, /order:\s*60/, 'settings.section 顺序必须是 60')
assert.match(source, /locale:\s*NS/, 'slot locale 必须是插件命名空间')
assert.match(source, /API_BASE\s*=\s*'\/dsh-sync\/api'/, 'API base 必须是 /dsh-sync/api')
assert.match(source, /x-dsh-sync-ui-token/, '设置页 API 必须携带 UI token')
assert.match(source, /meta\[name="dsh-sync-ui-token"\]/, 'UI token 必须从页面 meta 读取')

assert.doesNotMatch(source, /\bdocument\s*\.\s*body\b/, '禁止写入 document.body')
assert.doesNotMatch(source, /@deepseek-ai\//, '禁止依赖 Harness 运行时包')
assert.doesNotMatch(source, /^\s*import\s/m, '浏览器模块不得使用 import 语句')
assert.doesNotMatch(source, /<iframe/i, '禁止使用 iframe')

const requiredModules = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
assert.deepEqual([...new Set(requiredModules)], ['react'], '工厂函数只能 require react')

const passwordInputs = [...source.matchAll(/type:\s*'password'/g)].length
assert.ok(passwordInputs >= 2, '密码与 peer Token 必须使用 password 输入框')

// ---------------------------------------------------------------------------
// 2. 执行 factory + apply，捕获注册信息
// ---------------------------------------------------------------------------
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      definition = value
    },
  },
}

// 极简 hook 运行时：只用于把组件树渲染成字符串做结构冒烟，不模拟状态更新。
let hookFrame = null
const fakeReact = {
  createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useCallback(fn) {
    return fn
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  useState(initial) {
    const frame = hookFrame
    if (frame && frame.overrides && frame.index in frame.overrides) {
      const forced = frame.overrides[frame.index]
      frame.index += 1
      return forced
    }
    if (frame) frame.index += 1
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
}

const locales = []
const slots = []
const effects = []
const injectedSlots = []

await import(pathToFileURL(join(ROOT, 'lib/client.js')).href)

assert.ok(definition, '模块必须调用 window.__ModuleLoader__.load')
assert.equal(definition.id, 'dsh-sync')

const plugin = definition.factory((name) => {
  assert.equal(name, 'react', '工厂函数只能 require react')
  return fakeReact
})

assert.deepEqual(plugin.inject, ['slots', 'locale'], '插件注入必须是 slots + locale')

plugin.apply({
  locale: {
    bind: (ns) => {
      assert.equal(ns, 'dsh-sync')
      return (key) => key
    },
    register: (ns, dicts) => {
      locales.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject: (name, install) => {
      injectedSlots.push(name)
      install()
    },
    register: (options, component) => {
      slots.push({ options, component })
      return () => {}
    },
  },
  effect: (fn, label) => {
    effects.push({ label, dispose: fn() })
    return () => {}
  },
})

// ---------------------------------------------------------------------------
// 3. 注册参数与字典完整性
// ---------------------------------------------------------------------------
assert.deepEqual(injectedSlots, ['settings.section'], '必须注入 settings.section')
assert.equal(slots.length, 1, '必须注册一个设置页 section')

const registered = slots[0].options
assert.equal(registered.name, 'settings.section')
assert.equal(registered.id, 'dsh-sync')
assert.equal(registered.order, 60)
assert.equal(registered.locale, 'dsh-sync')
assert.equal(registered.label(), 'nav', 'label 必须走 locale 的 nav 键')

assert.equal(locales.length, 1, '必须注册一个 locale 命名空间')
assert.equal(locales[0].ns, 'dsh-sync')

const { zh, en } = locales[0].dicts
assert.ok(zh && en, '必须同时注册 zh 与 en 字典')

const zhKeys = Object.keys(zh).sort()
const enKeys = Object.keys(en).sort()
assert.deepEqual(zhKeys, enKeys, 'zh 与 en 的键集合必须一致')
assert.ok(zhKeys.length >= 100, '字典规模应覆盖全部界面文案')

for (const key of zhKeys) {
  assert.equal(typeof zh[key], 'string', `zh.${key} 必须是字符串`)
  assert.equal(typeof en[key], 'string', `en.${key} 必须是字符串`)
  assert.ok(zh[key].trim().length > 0, `zh.${key} 不能为空`)
  assert.ok(en[key].trim().length > 0, `en.${key} 不能为空`)
  assert.ok(!key.includes(' '), `字典键不得包含空格：${key}`)
}

// 源码中所有显式点号文案键都必须存在。
const namespace = '(?:nav|title|intro|common|state|status|targets|roots|peer|transfer|logs|footer)'
const keyPattern = new RegExp("'(" + namespace + "\\.[A-Za-z0-9]+)'(?!\\s*\\+)", 'g')
const usedKeys = [...source.matchAll(keyPattern)].map((match) => match[1])
assert.ok(usedKeys.length >= 80, '应能提取到足量文案键，正则或代码形态异常')

for (const key of [...new Set(usedKeys)]) {
  assert.ok(key in zh, `zh 缺少源码使用的键：${key}`)
  assert.ok(key in en, `en 缺少源码使用的键：${key}`)
}

// 动态拼接的键单独校验。
for (const field of ['pushed', 'pulled', 'deletedLocal', 'conflicts', 'skipped']) {
  assert.ok('status.' + field in zh, `缺少动态结果键 status.${field}`)
  assert.ok('status.' + field in en, `缺少动态结果键 en status.${field}`)
}
for (const kind of ['Url', 'Token']) {
  assert.ok('peer.copy' + kind in zh, `缺少动态复制键 peer.copy${kind}`)
  assert.ok('peer.copy' + kind in en, `缺少动态复制键 en peer.copy${kind}`)
}

// ---------------------------------------------------------------------------
// 3b. 深度渲染冒烟：loading 态与完整 ready 态都必须能构造出元素树
// ---------------------------------------------------------------------------
const noop = () => {}
const statusMock = {
  deviceId: 'abc123',
  deviceName: 'phone',
  autoSync: true,
  autoSave: true,
  syncOnStart: true,
  autoSaveIntervalSeconds: 20,
  autoSyncIntervalSeconds: 180,
  roots: [
    { id: 'profile', label: 'DSH 配置', path: '/root/.dsh/profiles/web', enabled: true, exclude: ['node_modules/**'] },
    { id: 'docs', label: 'Documents', path: '/root/Documents', enabled: false, exclude: [] },
  ],
  targets: [
    {
      id: 'local',
      type: 'local',
      label: '本地目录',
      enabled: true,
      path: '/root/.dsh/dsh-sync/store',
      detail: '/root/.dsh/dsh-sync/store',
      lastSyncAt: 1760000000000,
      lastResult: { ok: true, pushed: 1, pulled: 2, deletedLocal: 0, conflicts: 0, skipped: 0, durationMs: 12 },
    },
    {
      id: 'dav',
      type: 'webdav',
      label: 'WebDAV',
      enabled: false,
      url: 'https://dav.example.com/remote.php/dav/files/u',
      username: 'u',
      password: '***',
      basePath: '/dsh-sync',
    },
    { id: 'peer', type: 'peer', label: '另一台 DSH', enabled: false, url: 'http://192.168.1.20:3080', token: '***' },
  ],
  peer: { url: 'http://192.168.1.2:3080/dsh-sync/v1', token: 'deadbeefdeadbeef' },
  logs: [
    { at: 1760000000000, level: 'info', message: 'sync finished' },
    { at: 1760000000001, level: 'warn', message: 'skipped symlink' },
  ],
  conflicts: [{ at: 1760000000000, key: 'profile/a.json', copy: 'a.conflict-abc.json', reason: 'both changed' }],
  busy: false,
}

const fakeT = (key, params) => (params ? key + ' ' + Object.values(params).map((value) => String(value)).join(' ') : key)
const wrapper = slots[0].component
const rootElement = wrapper({ t: fakeT })
assert.equal(typeof rootElement.type, 'function', 'section 组件必须是函数组件')

/** 递归渲染；root 的 useState 顺序由 overrides 强制。 */
function renderTree(node, rootType, overrides) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => renderTree(child, rootType, overrides)).join('')
  if (typeof node.type === 'function') {
    const previous = hookFrame
    hookFrame = {
      index: 0,
      overrides: node.type === rootType ? overrides : null,
    }
    try {
      return renderTree(node.type(node.props), rootType, overrides)
    } finally {
      hookFrame = previous
    }
  }
  const childText = renderTree(node.props ? node.props.children : null, rootType, overrides)
  // 输入框的 value 也是可见内容，投影到文本里，才能验证回填与复制地址。
  const valueText = node.props && typeof node.props.value === 'string' ? node.props.value : ''
  return valueText + childText
}

const loadingMarkup = renderTree(rootElement, rootElement.type, null)
assert.ok(loadingMarkup.includes('state.loading'), '首次加载必须渲染 loading 态')

const readyMarkup = renderTree(rootElement, rootElement.type, {
  0: [statusMock, noop],
  1: ['ready', noop],
  2: ['', noop],
  3: ['', noop],
  4: [null, noop],
  5: [null, noop],
})
for (const expected of [
  'status.heading',
  'targets.heading',
  'roots.heading',
  'peer.heading',
  'transfer.heading',
  'logs.heading',
  'DSH 配置',
  '本地目录',
  'http://192.168.1.2:3080/dsh-sync/v1',
  'sync finished',
  'profile/a.json',
]) {
  assert.ok(readyMarkup.includes(expected), 'ready 态应渲染出：' + expected)
}
assert.ok(!readyMarkup.includes('***'), '页面不得把掩码密码当作明文展示')
assert.ok(!readyMarkup.includes('state.loading'), 'ready 态不应停留在 loading 文案')

// 配置警告与本次同步报告也是独立分支，单独渲染验证。
const richMarkup = renderTree(rootElement, rootElement.type, {
  0: [statusMock, noop],
  1: ['ready', noop],
  2: ['', noop],
  3: ['', noop],
  4: [null, noop],
  5: [[{ targetId: 'local', ok: true, pushed: 3, pulled: 0, conflicts: 1, durationMs: 9 }], noop],
  6: [['根目录 #1 路径无效，已忽略', '同步目标已忽略：地址非法'], noop],
})
for (const expected of ['state.configWarnings', '根目录 #1 路径无效，已忽略', 'status.reportLine', '本地目录']) {
  assert.ok(richMarkup.includes(expected), '警告/报告分支应渲染出：' + expected)
}

// ---------------------------------------------------------------------------
// 4. locale JSON 与图标
// ---------------------------------------------------------------------------
for (const lang of ['zh', 'en']) {
  const dict = JSON.parse(readText('locale/' + lang + '.json'))
  assert.equal(typeof dict.meta, 'object', `${lang}.json 必须有 meta`)
  assert.equal(typeof dict.meta.title, 'string', `${lang}.json meta.title 必须是字符串`)
  assert.equal(typeof dict.meta.description, 'string', `${lang}.json meta.description 必须是字符串`)
  assert.ok(dict.meta.title.trim().length > 0, `${lang}.json meta.title 不能为空`)
  assert.ok(dict.meta.description.trim().length > 0, `${lang}.json meta.description 不能为空`)
}

const iconPath = join(ROOT, 'icon.svg')
const iconSize = statSync(iconPath).size
assert.ok(iconSize <= 256 * 1024, 'icon.svg 必须不超过 256 KiB')
const icon = readText('icon.svg')
assert.match(icon, /<svg[\s>]/, 'icon.svg 必须是 SVG')
assert.match(icon, /viewBox="0 0 64 64"/, 'icon.svg 必须有 64x64 viewBox')
assert.match(icon, /#2563eb|#1d4ed8|#60a5fa/, 'icon.svg 必须使用蓝色系')
assert.ok(iconSize > 0, 'icon.svg 不能为空')

console.log(
  'ui-static ok: locale keys=' + zhKeys.length + ', used keys=' + new Set(usedKeys).size + ', icon bytes=' + iconSize,
)