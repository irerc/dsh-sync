/**
 * 完整应用数据（scope=app）的清单与恢复计划。
 *
 * 目标：新设备装好 DSH 后导入一次归档，行为与当前设备一致——
 * 会话、偏好、插件启用状态、工作区登记、账号凭据、自己写的 link 插件源码都在。
 *
 * 取舍原则：**能重建的一律不带**（node_modules、下载的二进制、缓存、日志）。
 * 这些占了这台机器 DSH_HOME 的绝大部分体积，带上只会让归档变大、恢复变慢，
 * 而且 rebuild 出来的东西和原机并不会逐字节相同——真正需要"完全相同"的是配置与数据。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { sha256Bytes } from './hash.js'

/** DSH_HOME 根上的排除项：可重建 / 自我引用 / 纯噪音。 */
export const APP_HOME_EXCLUDES = Object.freeze([
  // 同步存储自身：它是备份目标，体积大且带自我引用，打包进去等于把备份再备份一遍。
  'dsh-sync/**',
  // 依赖与构建产物：新设备 install 即可重建，且逐字节不可能一致。
  'node_modules/**',
  '**/node_modules/**',
  '.git/**',
  '**/.git/**',
  'dist/**',
  '**/dist/**',
  'coverage/**',
  // 下载回来的二进制（cloudflared / cpolar / native libs / venv）：按需重新下载。
  'mobile-access/components/**',
  'mobile-access/logs/**',
  'storages/*/native-libs/**',
  'storages/*/native-venv/**',
  // 缓存与日志。
  'cache/**',
  'logs/**',
  'storages/session_projcache/**',
  '__pycache__/**',
  '**/__pycache__/**',
  // 安装/预览/搬家过程的中间态。
  'plugin-install-operations/**',
  'plugin-previews/**',
  'plugin-history/**',
  'session-move-backup/**',
  '/tmp/**',
  // 编辑器式备份文件：`cordis.patch.yml.bak-1792916992997` 这类噪音。
  '*.bak-*',
  '**/*.bak-*',
])

/** link 插件源码目录的排除项（相对该目录）。 */
export const LINK_EXCLUDES = Object.freeze([
  'node_modules/**',
  '.git/**',
  'dist/**',
  'coverage/**',
  // dsh-sync 自己的本地 store 与导出件：不跟着插件源码走。
  'store/**',
  'exports/**',
  '*.dshsync',
])

/** 恢复计划里描述的产物文件名（归档内成员）。 */
export const RESTORE_MEMBER = 'restore.json'
export const RESTORE_DOC_MEMBER = 'RESTORE.md'
export const RESTORE_SH_MEMBER = 'restore.sh'

/**
 * 尽力探测当前 DSH 版本：恢复计划里要写清"按哪个版本导的"。
 * 探测失败返回空串——宁可写"未知版本"，也不要编一个。
 *
 * @returns {Promise<string>}
 */
export async function detectDshVersion({ env = process.env } = {}) {
  if (typeof env.DSH_VERSION === 'string' && env.DSH_VERSION.trim() !== '') return env.DSH_VERSION.trim()
  const candidates = [
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/lib/node_modules/@deepseek-ai/dsh/package.json',
  ]
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (typeof pkg.version === 'string' && pkg.version !== '') return pkg.version
    } catch {
      // 换个位置再试
    }
  }
  return ''
}

/**
 * 从 profile 的 package.json 里取 `link:` 依赖——这些是装在本机的自有插件源码，
 * 新设备上没有对应目录，功能就会缺一大块，所以必须跟着归档走。
 *
 * @param {object} input
 * @param {string} input.profileDir profile 目录绝对路径
 * @returns {Promise<Array<{name: string, path: string, exists: boolean}>>}
 */
export async function detectLinkSources({ profileDir } = {}) {
  if (typeof profileDir !== 'string' || profileDir === '') return []
  let pkg
  try {
    pkg = JSON.parse(await fsp.readFile(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const deps = pkg && typeof pkg.dependencies === 'object' && pkg.dependencies !== null ? pkg.dependencies : {}
  const out = []
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
    const target = spec.slice('link:'.length)
    if (target === '') continue
    const abs = path.isAbsolute(target) ? target : path.resolve(profileDir, target)
    let exists = false
    try {
      const stat = await fsp.stat(abs)
      exists = stat.isDirectory()
    } catch {
      exists = false
    }
    out.push({ name, path: abs, exists })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** link 源码根 id：路径稳定 → id 稳定，换设备后仍能对上。 */
export function linkRootId(linkPath) {
  return `link-${sha256Bytes(Buffer.from(String(linkPath), 'utf8')).slice(0, 12)}`
}

/**
 * 生成 scope=app 的根列表。
 *
 * @param {object} input
 * @param {string} input.dshHome
 * @param {string} input.profileDir
 * @param {Array<{name: string, path: string, exists?: boolean}>} [input.linkSources]
 * @param {boolean} [input.includeSecrets] 是否带上 `.credentials.yaml` 等凭据（默认带）
 * @returns {Array<{id: string, label: string, path: string, enabled: boolean, exclude: string[], includeSecrets?: boolean}>}
 */
export function appDataRoots({ dshHome, profileDir, linkSources = [], includeSecrets = true } = {}) {
  if (typeof dshHome !== 'string' || dshHome === '') throw new Error('appDataRoots 需要 dshHome')
  const roots = [
    {
      id: 'dsh-home',
      label: 'DSH 应用数据',
      path: dshHome,
      enabled: true,
      exclude: [...APP_HOME_EXCLUDES],
      // 凭据文件默认被扫描器的 SECRET_PATTERNS 拦掉；"完全相同"必须显式放行。
      includeSecrets: includeSecrets === true,
    },
  ]
  for (const link of linkSources) {
    if (!link || link.exists === false) continue
    roots.push({
      id: linkRootId(link.path),
      label: link.name,
      path: link.path,
      enabled: true,
      exclude: [...LINK_EXCLUDES],
      includeSecrets: false,
    })
  }
  return roots
}

/**
 * 恢复计划：新设备导入后要做什么才能达到"和原机一样"。
 *
 * 归档里带上这份计划，而不是让用户自己猜——node_modules 被排除了，
 * 不跑一遍安装就只能得到一堆"有源码但跑不起来"的插件。
 */
export function buildRestorePlan({ dshHome, profileDir, profile = 'web', dshVersion = '', linkSources = [], includeSecrets = true } = {}) {
  const links = linkSources.filter((link) => link && link.exists !== false)
  return {
    version: 1,
    scope: 'app',
    dshVersion,
    dshHome,
    profile,
    profileDir,
    installer: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    includeSecrets: includeSecrets === true,
    linkSources: links.map((link) => ({ name: link.name, path: link.path })),
    // 顺序有讲究：先把源码落回原位，再安装依赖，最后才可能启动。
    steps: [
      { id: 'files', title: '解包应用数据', detail: '归档内容覆盖到相同路径（本地旧文件留冲突副本）' },
      {
        id: 'links',
        title: '确认 link 插件源码到位',
        detail: links.length > 0 ? `${links.length} 个自有插件需要落在原路径，路径不同时改 package.json 的 link: 目标` : '没有 link 依赖',
      },
      {
        id: 'install',
        title: '安装依赖',
        detail: `在 ${profileDir} 执行 pnpm install --frozen-lockfile（node_modules 未随包带上，必须重建）`,
      },
      { id: 'restart', title: '重启 DSH', detail: '插件启用状态、模型设置、凭据均在归档内，重启后即生效' },
    ],
  }
}

/** 人读版恢复说明（写进归档，换设备时不需要另找文档）。 */
export function renderRestoreDoc(plan) {
  const links = plan.linkSources.length > 0
    ? plan.linkSources.map((link) => `- \`${link.name}\` → \`${link.path}\``).join('\n')
    : '- （无）'
  const lines = [
    '# 在这台新设备上还原',
    '',
    `归档来自 DSH \`${plan.dshVersion || '未知版本'}\`，应用数据目录 \`${plan.dshHome}\`，profile \`${plan.profile}\`。`,
    '',
    '## 步骤',
    '',
    '1. 安装同版本 DSH（版本不同也能导，但插件兼容性按原版本为准）。',
    '2. 在设置页「导入」选择本归档，等导入完成。文件会覆盖到相同路径，冲突的本地旧文件另存。',
    '3. 安装依赖（node_modules 没有随包带上，是可重建的）：',
    '',
    '```bash',
    `cd ${plan.profileDir}`,
    'pnpm install --frozen-lockfile',
    '```',
    '',
    '4. 重启 DSH。会话、设置、插件启用状态、账号凭据、工作区登记都已在归档内。',
    '',
    '## 这个归档带了的自有插件源码',
    '',
    links,
    '',
    '如果新设备上这些目录不在原路径，请改 profile 的 `package.json` 里对应的 `link:` 目标，',
    '再执行第 3 步；否则 `pnpm install` 会找不到这些包。',
    '',
    plan.includeSecrets
      ? '## 注意：归档包含账号凭据\n\n`.credentials.yaml` 等凭据文件在包内。请把它当作密码对待，不要上传到公开位置。'
      : '## 归档未包含账号凭据\n\n导入后需要重新登录各账号。',
    '',
  ]
  return lines.join('\n')
}

/** 可执行的恢复脚本（与 RESTORE.md 等价，省得手抄）。 */
export function renderRestoreScript(plan) {
  const links = plan.linkSources
  const lines = [
    '#!/usr/bin/env bash',
    '# 由 dsh-sync 生成：把这份归档还原成和原机一致的状态。',
    '# 前提：已用 dsh-sync 导入本归档（文件已落到相同路径）。',
    'set -euo pipefail',
    '',
    `PROFILE_DIR=${JSON.stringify(plan.profileDir)}`,
    '',
    '# 1. 检查 link 插件源码是否都在原路径上。',
  ]
  if (links.length === 0) {
    lines.push('echo "没有 link 依赖，跳过源码检查"')
  } else {
    lines.push('missing=0')
    for (const link of links) {
      lines.push(`[ -d ${JSON.stringify(link.path)} ] || { echo "缺失: ${link.name} -> ${link.path}"; missing=1; }`)
    }
    lines.push('if [ "$missing" -ne 0 ]; then')
    lines.push('  echo "有自有插件源码不在原路径：请改 $PROFILE_DIR/package.json 的 link: 目标后重跑" >&2')
    lines.push('  exit 1')
    lines.push('fi')
  }
  lines.push(
    '',
    '# 2. 重建 node_modules（归档内不含依赖）。',
    'cd "$PROFILE_DIR"',
    'if [ -f pnpm-lock.yaml ]; then',
    '  pnpm install --frozen-lockfile',
    'else',
    '  pnpm install',
    'fi',
    '',
    'echo "完成。重启 DSH 后生效。"',
    '',
  )
  return lines.join('\n')
}