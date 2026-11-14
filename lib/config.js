/**
 * dsh-sync 配置：默认值、路径展开、校验与归一化。
 *
 * 运行期配置保存在 $DSH_HOME/dsh-sync/config.json（不写 profile patch），
 * 因此插件可以热更新同步目标，而不会污染用户的 plugins 列表。
 */
import os from 'node:os'
import path from 'node:path'
import { asBoolean, clampInt, ensureDir, randomHex } from './util.js'

/** 支持的 target 类型。 */
export const TARGET_TYPES = Object.freeze(['local', 'webdav', 'peer'])

/** DSH_HOME 内永远排除的敏感文件（不可配置，防止把凭据同步到云端）。 */
export const SECRET_PATTERNS = Object.freeze([
  '**/.credentials.yaml',
  '**/credentials.key',
  '**/cookies*',
  '**/jar-*.json',
  '**/*.key',
  '**/*.pem',
  '**/id_rsa*',
])

/** 配置版本。 */
export const CONFIG_VERSION = 1

/**
 * 展开 $VAR、${VAR}、~ 前缀，并转成绝对路径。
 * @param {unknown} value 原始路径
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {string} 绝对路径（空输入返回空串）
 */
export function expandPath(value, env = process.env) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (text.length === 0) return ''
  const home = env.HOME || os.homedir()
  const dshHome = env.DSH_HOME || path.join(home, '.dsh')
  const vars = {
    HOME: home,
    DSH_HOME: dshHome,
    DSH_PROFILE: env.DSH_PROFILE || 'web',
  }
  text = text.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name) => vars[name] ?? match)
  text = text.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, name) => vars[name] ?? match)
  if (text === '~') text = home
  else if (text.startsWith('~/')) text = path.join(home, text.slice(2))
  return path.resolve(text)
}

/** 当前 profile 目录的默认值。 */
function profileDir(env) {
  const home = env.HOME || os.homedir()
  const dshHome = env.DSH_HOME || path.join(home, '.dsh')
  return path.join(dshHome, 'profiles', env.DSH_PROFILE || 'web')
}

/** 默认根目录：DSH 配置 + 会话记录（文档默认关闭，避免首次同步拖入大仓库）。 */
export function defaultRoots(env = process.env) {
  return [
    {
      id: 'profile',
      label: 'DSH 配置',
      path: profileDir(env),
      enabled: true,
      exclude: [
        'node_modules/**',
        '.plugin-manager/**',
        '.dsh-market/**',
        '*.bak-*',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'package.json',
      ],
    },
    {
      id: 'sessions',
      label: '会话记录',
      path: path.join(env.DSH_HOME || path.join(env.HOME || os.homedir(), '.dsh'), 'sessions'),
      enabled: true,
      exclude: ['.sessions-trash/**'],
    },
    {
      id: 'documents',
      label: '工作区文档',
      path: path.join(env.HOME || os.homedir(), 'Documents'),
      enabled: false,
      exclude: ['node_modules/**', '.git/**', '**/*.zip', '**/*.tar.gz'],
    },
  ]
}

/** 默认同步目标。 */
export function defaultTargets(env = process.env) {
  const dshHome = env.DSH_HOME || path.join(env.HOME || os.homedir(), '.dsh')
  // 默认走 WebDAV：跨网络、跨设备都能用，也是唯一「在家用平板、出门用手机」都成立的通道。
  // local 需要同一块磁盘、peer 需要同一局域网，都只作为进阶选项，默认不启用。
  return [
    {
      id: 'dav',
      type: 'webdav',
      label: 'WebDAV',
      // 默认路径就是 WebDAV，但「启用」必须是用户填完地址后的事：
      // normalizeTarget 拒绝「启用却没有地址」的目标，这里预先启用会得到一份非法配置。
      enabled: false,
      url: '',
      username: '',
      password: '',
      basePath: '/dsh-sync',
    },
    {
      id: 'local',
      type: 'local',
      label: '本地 / 挂载目录',
      enabled: false,
      path: path.join(dshHome, 'dsh-sync', 'store'),
    },
    {
      id: 'peer',
      type: 'peer',
      label: '另一台 DSH',
      enabled: false,
      url: '',
      token: '',
    },
  ]
}

/** 默认配置。 */
export function defaultConfig(env = process.env) {
  return {
    version: CONFIG_VERSION,
    deviceName: sanitizeDeviceName(os.hostname()),
    autoSync: true,
    autoSave: false,
    syncOnStart: true,
    autoSaveIntervalSeconds: 20,
    // 主要触发时机是「Agent 停止」：请求空闲时上传，避免和正在跑的 turn 抢带宽。
    // 间隔同步退化为兜底（没有 Agent 活动的机器，例如只是被配对的那台）。
    syncOnAgentIdle: true,
    agentIdleDelaySeconds: 20,
    autoSyncIntervalSeconds: 1800,
    maxFileBytes: 32 * 1024 * 1024,
    // 「完整备份」的总预算：必须 ≤ 导入上限，否则导出的包自己导入不回去（自相矛盾）。
    maxArchiveBytes: 256 * 1024 * 1024,
    // 完整应用数据备份是否带账号凭据：默认带，否则新设备还得重新登录，达不到"和原机一样"。
    backupSecrets: true,
    // 导出时写入恢复计划的 DSH 版本；由宿主环境填充，取不到就留空。
    dshVersion: String(env.DSH_VERSION || ''),
    // 上传/下载并发数：4 对 Nextcloud/PHP 后端友好；漫游网络可调低，局域网可调高。
    concurrency: 4,
    // 对象传输前 gzip（仅当确实更小）：DSH 内容以 JSON/Markdown 为主，压缩收益显著。
    compressObjects: true,
    peerToken: randomHex(16),
    peerStorePath: path.join(
      env.DSH_HOME || path.join(env.HOME || os.homedir(), '.dsh'),
      'dsh-sync',
      'peer-store',
    ),
    roots: defaultRoots(env),
    targets: defaultTargets(env),
  }
}

/** 设备名清洗。 */
export function sanitizeDeviceName(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text.slice(0, 64) || 'dsh-device'
}

/** 配置目录。 */
export function configDir(env = process.env) {
  return path.join(env.DSH_HOME || path.join(env.HOME || os.homedir(), '.dsh'), 'dsh-sync')
}

/**
 * 校验并归一化一个 target 草稿。
 * @returns {{ ok: boolean, target?: object, error?: string }}
 */
export function normalizeTarget(raw, env = process.env) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'target 必须是对象' }
  const type = String(raw.type ?? '')
  if (!TARGET_TYPES.includes(type)) return { ok: false, error: `未知 target 类型：${type || '(空)'}` }
  const id = sanitizeId(raw.id, type)
  const label = String(raw.label ?? '').trim().slice(0, 80) || defaultTargetLabel(type)
  const target = { id, type, label, enabled: asBoolean(raw.enabled, false) }

  if (type === 'local') {
    const p = expandPath(raw.path, env)
    if (p.length === 0) return { ok: false, error: '本地目标必须填写目录路径' }
    target.path = p
  } else if (type === 'webdav') {
    const url = String(raw.url ?? '').trim().replace(/\/+$/, '')
    if (url.length > 0 && !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'WebDAV 地址必须以 http:// 或 https:// 开头' }
    }
    target.url = url
    target.username = String(raw.username ?? '').slice(0, 256)
    target.password = String(raw.password ?? '').slice(0, 512)
    const basePath = String(raw.basePath ?? '/dsh-sync').trim() || '/dsh-sync'
    target.basePath = basePath.startsWith('/') ? basePath.replace(/\/+$/, '') : `/${basePath.replace(/\/+$/, '')}`
    if (target.enabled && target.url.length === 0) return { ok: false, error: '启用 WebDAV 前请填写地址' }
  } else {
    const url = String(raw.url ?? '').trim().replace(/\/+$/, '')
    if (url.length > 0 && !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'DSH 对等地址必须以 http:// 或 https:// 开头' }
    }
    target.url = url
    target.token = String(raw.token ?? '').slice(0, 256)
    if (target.enabled && (target.url.length === 0 || target.token.length === 0)) {
      return { ok: false, error: '启用对等同步前请填写地址和配对令牌' }
    }
  }
  return { ok: true, target }
}

/** 默认显示名。 */
export function defaultTargetLabel(type) {
  if (type === 'local') return '本地 / 挂载目录'
  if (type === 'webdav') return 'WebDAV'
  return '另一台 DSH'
}

/** id 清洗：小写字母数字下划线连字符。 */
export function sanitizeId(value, fallback = 'target') {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return text.length > 0 ? text : `${fallback}-${randomHex(2)}`
}

/** 根目录归一化。 */
function normalizeRoot(raw, index, env) {
  if (!raw || typeof raw !== 'object') return null
  const p = expandPath(raw.path, env)
  if (p.length === 0 || p === path.parse(p).root) return null
  const exclude = Array.isArray(raw.exclude)
    ? raw.exclude
      .filter((item) => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 50)
    : []
  return {
    id: sanitizeId(raw.id, `root-${index + 1}`),
    label: String(raw.label ?? '').trim().slice(0, 80) || `根目录 ${index + 1}`,
    path: p,
    enabled: asBoolean(raw.enabled, true),
    exclude,
  }
}

/**
 * 校验并归一化完整配置。非法项被丢弃并记入 warnings，不抛错。
 * @returns {{ config: object, warnings: string[] }}
 */
export function normalizeConfig(raw, env = process.env, options = {}) {
  const warnings = []
  const base = defaultConfig(env)
  const source = raw && typeof raw === 'object' ? raw : {}
  const config = {
    ...base,
    version: CONFIG_VERSION,
    deviceName: sanitizeDeviceName(source.deviceName ?? base.deviceName),
    autoSync: asBoolean(source.autoSync, base.autoSync),
    autoSave: asBoolean(source.autoSave, base.autoSave),
    syncOnStart: asBoolean(source.syncOnStart, base.syncOnStart),
    autoSaveIntervalSeconds: clampInt(source.autoSaveIntervalSeconds, 5, 3600, base.autoSaveIntervalSeconds),
    syncOnAgentIdle: asBoolean(source.syncOnAgentIdle, base.syncOnAgentIdle),
    agentIdleDelaySeconds: clampInt(source.agentIdleDelaySeconds, 3, 600, base.agentIdleDelaySeconds),
    autoSyncIntervalSeconds: clampInt(source.autoSyncIntervalSeconds, 15, 86400, base.autoSyncIntervalSeconds),
    maxFileBytes: clampInt(source.maxFileBytes, 64 * 1024, 1024 * 1024 * 1024, base.maxFileBytes),
    maxArchiveBytes: clampInt(source.maxArchiveBytes, 16 * 1024 * 1024, 1024 * 1024 * 1024, base.maxArchiveBytes),
    backupSecrets: asBoolean(source.backupSecrets, base.backupSecrets),
    dshVersion: String(source.dshVersion ?? base.dshVersion).slice(0, 64),
    concurrency: clampInt(source.concurrency, 1, 16, base.concurrency),
    compressObjects: asBoolean(source.compressObjects, base.compressObjects),
    peerToken: typeof source.peerToken === 'string' && /^[a-f0-9]{16,64}$/.test(source.peerToken)
      ? source.peerToken
      : base.peerToken,
    peerStorePath: expandPath(source.peerStorePath, env) || base.peerStorePath,
  }

  const rootsRaw = Array.isArray(source.roots) ? source.roots.slice(0, 16) : base.roots
  const roots = []
  const rootIds = new Set()
  for (let index = 0; index < rootsRaw.length; index += 1) {
    const root = normalizeRoot(rootsRaw[index], index, env)
    if (root === null) {
      warnings.push(`根目录 #${index + 1} 路径无效，已忽略`)
      continue
    }
    if (rootIds.has(root.id)) {
      root.id = `${root.id}-${index + 1}`
      warnings.push(`根目录 id 重复，已改为 ${root.id}`)
    }
    rootIds.add(root.id)
    roots.push(root)
  }
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const a = roots[i].path
      const b = roots[j].path
      if (a === b || b.startsWith(a + path.sep) || a.startsWith(b + path.sep)) {
        roots[j].enabled = false
        warnings.push(`根目录「${roots[j].label}」与「${roots[i].label}」重叠，已停用后者`)
      }
    }
  }
  config.roots = roots

  const targetsRaw = Array.isArray(source.targets) ? source.targets.slice(0, 16) : base.targets
  const targets = []
  const targetIds = new Set()
  for (const rawTarget of targetsRaw) {
    const result = normalizeTarget(rawTarget, env)
    if (!result.ok) {
      warnings.push(`同步目标已忽略：${result.error}`)
      continue
    }
    const target = result.target
    if (targetIds.has(target.id)) {
      target.id = `${target.id}-${targets.length + 1}`
      warnings.push(`同步目标 id 重复，已改为 ${target.id}`)
    }
    targetIds.add(target.id)
    targets.push(target)
  }
  // 同一个远程根挂两个 target 是数据事故：两份独立基线会互相把对方写的 manifest
  // 当成远端变更，于是每次同步都产生冲突副本。这里按“远程根指纹”去重，后者停用并告警。
  // 注意指纹包含 basePath：同一账号在不同子路径建两个 store 是合法用法，不能误杀。
  const seenFingerprints = new Map() // fingerprint → 先出现的 target
  for (const target of targets) {
    const fingerprint = targetFingerprint(target)
    if (fingerprint === null) continue
    const first = seenFingerprints.get(fingerprint)
    if (first) {
      if (target.enabled !== false) {
        target.enabled = false
        warnings.push(
          `同步目标「${target.label}」与「${first.label}」指向同一个远程存储，已自动停用（同一存储只能有一个 target，否则两份基线会互相制造冲突）`,
        )
      }
      continue
    }
    seenFingerprints.set(fingerprint, target)
  }
  config.targets = targets

  return { config, warnings }
}

/**
 * 计算 target 的“远程存储指纹”：相同指纹意味着两个 target 写同一份远端数据。
 * 返回 null 表示无法判定（配置不完整），此时不做去重。
 */
function targetFingerprint(target) {
  if (target.type === 'webdav') {
    if (!target.url) return null
    let originPath
    try {
      const parsed = new URL(target.url)
      originPath = `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`.replace(/\/+$/, '')
    } catch {
      return null
    }
    const basePath = String(target.basePath ?? '/dsh-sync').replace(/\/+$/, '') || '/dsh-sync'
    return `webdav|${originPath}|${basePath}|${target.username ?? ''}`
  }
  if (target.type === 'peer') {
    if (!target.url) return null
    try {
      const parsed = new URL(target.url)
      return `peer|${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}`.replace(/\/+$/, '')
    } catch {
      return null
    }
  }
  if (target.type === 'local') {
    if (!target.path) return null
    return `local|${target.path}`
  }
  return null
}

/** 只读配置是否存在。 */
export async function ensureConfigDir(env = process.env) {
  const dir = configDir(env)
  await ensureDir(dir)
  return dir
}

/** 状态展示用：把密钥替换为 ***。 */
export function maskConfig(config) {
  const clone = structuredClone(config)
  clone.targets = clone.targets.map((target) => {
    if (target.type === 'webdav') return { ...target, password: target.password ? '***' : '' }
    if (target.type === 'peer') return { ...target, token: target.token ? '***' : '' }
    return target
  })
  return clone
}