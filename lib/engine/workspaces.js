/**
 * DSH 工作区探测：从 `$DSH_HOME/storages/workspace.json` 读出用户建过的工作区路径，
 * 供「完整备份」把「工作区文件」和「对话文件」打进同一个归档。
 *
 * 为什么需要过滤，而不是照单全收：
 * - 工作区列表里可能登记了 `/root` 这种祖先目录，照收会把整个 home（含 `.dsh`、
 *   node_modules、android-sdk）都塞进归档，几十 GB，既跑不动也没意义；
 * - 嵌套工作区（`/root/a` 与 `/root/a/b`）同时收会重复打包同一批文件。
 *
 * 因此只保留「叶子工作区」：非危险路径、且不被其它候选目录包含。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 永远不能作为备份根的危险路径（祖先目录，等于整机打包）。 */
const FORBIDDEN_EXACT = new Set(['/', '/root', '/home', '/usr', '/etc', '/system', '/data', '/sdcard'])
/** 这些前缀下的内容属于系统/运行时，不参与备份。 */
const FORBIDDEN_PREFIXES = [
  '/proc', '/sys', '/dev', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt',
  '/system', '/vendor', '/data/data', '/data/app', '/android-sdk',
]

/**
 * 判断某个路径能否作为备份根。
 * @param {string} candidate 绝对路径
 * @param {{dshHome?: string, protect?: string[]}} options
 * @returns {string} 不可用的原因；空串表示可用
 */
export function rootRejectionReason(candidate, { dshHome = '', protect = [] } = {}) {
  const normalized = path.posix.normalize(String(candidate ?? ''))
  if (!normalized.startsWith('/')) return '不是绝对路径'
  if (FORBIDDEN_EXACT.has(normalized)) return '是系统级祖先目录'
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(prefix + '/')) return `位于系统目录 ${prefix}`
  }
  if (dshHome) {
    const home = path.posix.normalize(dshHome)
    // DSH 主目录本身可以备份（配置/会话就在里面），但它以外的祖先不行。
    if (normalized === path.posix.dirname(home)) return '包含 DSH 主目录的上级目录'
    if (home !== normalized && home.startsWith(normalized + '/')) return '包含 DSH 主目录的上级目录'
  }
  for (const item of protect) {
    const guarded = path.posix.normalize(String(item ?? ''))
    if (guarded !== '' && guarded === normalized) return '与受保护目录冲突'
  }
  return ''
}

/** 一个路径是否被另一个目录包含（用于剔除嵌套工作区）。 */
function isInside(parent, child) {
  if (parent === child) return false
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}

/**
 * 从 workspace.json 的内容里提取工作区。
 * @param {unknown} raw 解析后的 JSON
 * @returns {Array<{id:string,title:string,path:string}>}
 */
export function workspacesFromStorage(raw) {
  const table = raw && typeof raw === 'object' ? raw.tables?.workspaces : null
  if (!table || typeof table !== 'object') return []
  const list = []
  for (const [id, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object') continue
    const workspacePath = typeof value.path === 'string' ? value.path.trim() : ''
    if (workspacePath === '') continue
    list.push({
      id: String(value.id ?? id),
      title: typeof value.title === 'string' && value.title.trim() !== '' ? value.title.trim() : workspacePath,
      path: workspacePath,
    })
  }
  return list
}

/**
 * 选出真正值得备份的工作区：排除危险路径与被其它候选包含的祖先。
 * @param {Array<{id:string,title:string,path:string}>} workspaces
 * @param {{dshHome?:string, protect?:string[]}} options
 */
export function selectBackupWorkspaces(workspaces, options = {}) {
  const usable = []
  const dropped = []
  // 已有的备份根（例如 /root/Documents）已经覆盖的工作区不再重复打包。
  const covered = (options.coveredBy ?? []).map((item) => path.posix.normalize(String(item ?? ''))).filter(Boolean)
  for (const item of workspaces ?? []) {
    const reason = rootRejectionReason(item.path, options)
    if (reason !== '') {
      dropped.push({ ...item, reason })
      continue
    }
    const normalized = path.posix.normalize(item.path)
    const coveredRoot = covered.find((root) => root === normalized || isInside(root, normalized))
    if (coveredRoot) {
      dropped.push({ ...item, reason: `已被根目录 ${coveredRoot} 覆盖` })
      continue
    }
    usable.push(item)
  }
  // 去掉被别的候选包含的祖先（同时登记了 /root/a 与 /root/a/b 时保留更具体的 a/b）。
  const kept = usable.filter((item) => {
    const coveredBy = usable.filter((other) => other.path !== item.path && isInside(item.path, other.path))
    if (coveredBy.length === 0) return true
    dropped.push({ ...item, reason: `被工作区「${coveredBy[0].title}」覆盖` })
    return false
  })
  return { kept, dropped }
}

/**
 * 读取本机工作区并给出可备份子集。文件不存在/损坏时返回空集，不抛错。
 * @param {{dshHome?:string, protect?:string[]}} options
 */
export async function detectWorkspaces({ dshHome = '', protect = [], coveredBy = [], storagePath = '' } = {}) {
  const file = storagePath !== ''
    ? storagePath
    : path.join(dshHome || '', 'storages', 'workspace.json')
  let raw
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return { kept: [], dropped: [], source: file }
  }
  const all = workspacesFromStorage(raw)
  const { kept, dropped } = selectBackupWorkspaces(all, { dshHome, protect, coveredBy })
  return { kept, dropped, source: file, total: all.length }
}

/**
 * 估算目录总体积（字节）。用于「完整备份」的前置预算判断：
 * 归档是整块在内存里构建的，超预算时应当提前跳过，而不是等 OOM。
 *
 * 只统计普通文件，忽略符号链接与不可读项；任一环节出错就停止累加并返回已有值。
 * @param {string} dirPath
 * @param {{signal?: AbortSignal, limitBytes?: number}} options 达到 limitBytes 时提前返回
 */
export async function directorySize(dirPath, { signal, limitBytes = Infinity } = {}) {
  let total = 0
  const stack = [dirPath]
  while (stack.length > 0) {
    if (signal?.aborted) throw new Error('aborted')
    const current = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await fsp.stat(full)
        total += stat.size
      } catch {
        continue
      }
      if (total > limitBytes) return total
    }
  }
  return total
}
