/**
 * 同步引擎：把「本地扫描 / 远端设备视图 / 上次基线」合成可执行动作，
 * 并负责实际的文件 IO、对象上传、manifest 发布、导入导出与自动任务。
 *
 * 设计要点：
 * - 每个 target 独立基线，多 target 扇出互不影响；
 * - 远端没有锁：每个设备只写自己的 manifest，读取时合并；
 * - 冲突永远不丢数据：本地保留 + 远端落冲突副本（或还原远端 + 记录）；
 * - 所有写盘原子化；对象内容寻址，重复内容只传一次。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  ensureDir,
  formatBytes,
  nowMs,
  nowIso,
  randomHex,
  removeFileIfExists,
  resolveInside,
  sanitizeFileName,
  writeFileAtomic,
} from '../util.js'
import { maskConfig, normalizeConfig, normalizeTarget } from '../config.js'
import {
  createDeviceManifest,
  entryKey,
  mergeManifests,
  normalizeManifest,
  splitKey,
} from './manifest.js'
import { planMerge } from './merge.js'
import { createLimiter, runBatched } from './concurrency.js'
import { scanRoots } from './scan.js'
import { detectWorkspaces, directorySize } from './workspaces.js'
import {
  RESTORE_DOC_MEMBER,
  detectDshVersion,
  RESTORE_MEMBER,
  RESTORE_SH_MEMBER,
  appDataRoots,
  buildRestorePlan,
  detectLinkSources,
  renderRestoreDoc,
  renderRestoreScript,
} from './appdata.js'
import { sha256Bytes } from './hash.js'
import { buildArchive, buildArchiveStream, parseArchive } from './archive.js'
import { createBackend } from '../backends/index.js'

/** WebDAV 子路径归一化。 */
function normalizeBasePath(value) {
  const text = String(value ?? '').trim()
  if (text === '') return '/dsh-sync'
  return text.startsWith('/') ? text : `/${text}`
}

/** 冲突副本时间戳：20261108T193744。 */
function conflictStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 同步引擎。
 */
export class SyncEngine {
  /**
   * @param {object} options
   * @param {import('./state.js').SyncStore} options.store
   * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [options.logger]
   * @param {() => string|undefined} [options.getOrigin] 当前 Web 服务 origin
   * @param {Function} [options.backendFactory] 便于测试注入
   */
  constructor({ store, logger = console, getOrigin = () => undefined, backendFactory = createBackend }) {
    this.store = store
    this.logger = logger
    this.getOrigin = getOrigin
    this.backendFactory = backendFactory
    this.chain = Promise.resolve()
    this.busy = false
    this.timers = new Set()
    this.startupTimer = null
    this.stopped = true
  }

  /** 当前配置。 */
  get config() {
    return this.store.config
  }

  /** 串行执行同步任务，避免自动任务与手动任务并发写同一基线。 */
  serialize(operation) {
    const next = this.chain.then(operation, operation)
    this.chain = next.catch(() => {})
    return next
  }

  /** 导入期的临时状态：归档声明的根路径，与本机补建的根。 */
  importRootPaths = new Map()
  importAdoptedRoots = []

  /** 按 id 找根目录。 */
  rootById(rootId) {
    const fromConfig = this.config.roots.find((root) => root.id === rootId && root.enabled !== false)
    if (fromConfig) return fromConfig
    // 导出「完整备份」时会临时并入工作区根（不在配置里），扫描阶段必须能解析到它们，
    // 否则这些根下的文件会被静默跳过——归档成了空壳。
    const extra = Array.isArray(this._exportRoots) ? this._exportRoots : []
    return extra.find((root) => root.id === rootId) ?? null
  }

  /** 当前启用的根目录。 */
  enabledRoots() {
    return this.config.roots.filter((root) => root.enabled !== false)
  }

  /** 当前启用的 target。 */
  enabledTargets() {
    return this.config.targets.filter((target) => target.enabled !== false && this.targetUsable(target))
  }

  /** 目标是否已配好必需字段：启用但没填地址的目标不该参与同步（否则每次自动同步都报错）。 */
  targetUsable(target) {
    if (!target || typeof target !== 'object') return false
    if (target.type === 'webdav') return typeof target.url === 'string' && target.url.trim() !== ''
    if (target.type === 'peer') return typeof target.url === 'string' && target.url.trim() !== ''
    if (target.type === 'local') return typeof target.path === 'string' && target.path !== ''
    return true
  }

  /**
   * 把 UI 回传的 `"***"` 占位符还原为已保存的密钥。
   * 规则：同 id 优先；找不到时按 type + url 兜底；仍找不到则空串。
   * @param {Array<object>} rawTargets
   * @returns {Array<object>}
   */
  fillMaskedSecrets(rawTargets) {
    if (!Array.isArray(rawTargets)) return rawTargets
    const saved = Array.isArray(this.config.targets) ? this.config.targets : []
    return rawTargets.map((item) => {
      if (!item || typeof item !== 'object') return item
      const clone = { ...item }
      const sameId = saved.find((target) => target.id === clone.id)
      const sameUrl = saved.find((target) => target.type === clone.type && target.url === clone.url)
      const current = sameId ?? sameUrl
      if (clone.type === 'webdav' && clone.password === '***') {
        clone.password = current?.password ?? ''
      }
      if (clone.type === 'peer' && clone.token === '***') {
        clone.token = current?.token ?? ''
      }
      return clone
    })
  }

  /** 更新配置（浅合并 + 归一化 + 持久化）。返回 warnings。 */
  async updateConfig(patch) {
    const raw = { ...this.config }
    if (patch && typeof patch === 'object') {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) raw[key] = value
      }
      // UI 会把未修改的 target 原样回传（密钥为 ***），不能真的写入。
      if (Array.isArray(patch.targets)) raw.targets = this.fillMaskedSecrets(patch.targets)
    }
    const { config, warnings } = normalizeConfig(raw, { ...this.store.env, DSH_HOME: this.store.homeDir })
    await this.store.saveConfig(config)
    for (const warning of warnings) this.store.log('warn', warning)
    return { config, warnings }
  }

  /**
   * 新增/更新一个同步目标（供 Agent 工具与配对码共用）。
   * 同一类型 + 地址（WebDAV 再加用户名）视为同一目标，避免重复。
   * @returns {{target:object, warnings:string[]}}
   */
  async connectTarget(input = {}) {
    const type = String(input.type ?? '')
    if (!['local', 'webdav', 'peer'].includes(type)) throw new Error('type 必须是 local / webdav / peer')
    const current = (this.config.targets ?? []).map((target) => ({ ...target }))
    const url = String(input.url ?? '').trim()
    const localPath = String(input.path ?? '').trim()
    if (type === 'local') {
      if (!path.isAbsolute(localPath)) throw new Error('local 的 path 必须是绝对路径')
    } else if (!/^https?:\/\/[^\s]+$/i.test(url)) {
      throw new Error(`${type} 的 url 必须是 http(s) 地址`)
    }
    let same = null
    if (input.targetId) {
      same = current.find((target) => target.id === String(input.targetId)) ?? null
      if (!same) throw new Error(`target 不存在：${input.targetId}`)
    } else {
      same = current.find((target) => target.type === type
        && (type === 'local' ? target.path === localPath : target.url === url)
        && (type !== 'webdav' || String(target.username ?? '') === String(input.username ?? ''))) ?? null
      // 默认配置里预置了一个空地址的 WebDAV 占位；第一次连接时应当填满它，
      // 而不是把占位晾在一边再新建一个 dav-2。
      if (!same) {
        same = current.find((target) => target.type === type
          && (type === 'local' ? !target.path : !String(target.url ?? '').trim())) ?? null
      }
    }
    const base = same ?? {
      id: this.uniqueTargetId(current, type),
      type,
      enabled: true,
    }
    const label = String(input.label ?? '').trim()
      || (type === 'local' ? '本地目录' : type === 'webdav' ? 'WebDAV' : '另一台 DSH')
    const target = { ...base, type, label, enabled: input.enabled !== false }
    if (type === 'local') {
      target.path = localPath
    } else if (type === 'webdav') {
      target.url = url
      target.username = String(input.username ?? base.username ?? '')
      target.basePath = normalizeBasePath(input.basePath ?? base.basePath ?? '/dsh-sync')
      const nextPassword = input.password !== undefined ? String(input.password) : base.password
      target.password = nextPassword === '***' ? (base.password ?? '') : (nextPassword ?? '')
    } else {
      target.url = url
      const nextToken = input.token !== undefined ? String(input.token) : base.token
      target.token = nextToken === '***' ? (base.token ?? '') : (nextToken ?? '')
    }
    const targets = same
      ? current.map((item) => (item.id === same.id ? target : item))
      : [...current, target]
    const { warnings } = await this.updateConfig({ targets })
    this.restartAutomation()
    return { target, warnings }
  }

  /** 应用一键配对码载荷：新增/更新 target，默认测试并同步。 */
  async applyPairPayload(data, { sync = true } = {}) {
    const { target, warnings } = await this.connectTarget({ ...data, type: data.type })
    let test = null
    let report = null
    let error = null
    try {
      test = await this.testTarget(target)
      if (sync !== false && test?.ok) {
        report = await this.sync({ targetId: target.id, mode: 'auto', trigger: 'pair' })
      }
    } catch (failure) {
      error = failure?.message ?? String(failure)
    }
    return { target, warnings, test, report, error }
  }

  /** 生成不冲突的 target id。 */
  uniqueTargetId(targets, type) {
    const base = type === 'peer' ? 'peer' : type === 'webdav' ? 'dav' : 'local'
    const ids = new Set((targets ?? []).map((target) => target.id))
    if (!ids.has(base)) return base
    let index = 2
    while (ids.has(`${base}-${index}`)) index += 1
    return `${base}-${index}`
  }

  /** 生成状态面板数据。 */
  async status() {
    const config = this.config
    const origin = this.getOrigin() || 'http://127.0.0.1:3080'
    const targets = config.targets.map((target) => {
      const saved = this.store.state.targets[target.id] ?? {}
      let detail = target.label
      if (target.type === 'local') detail = target.path
      else if (target.type === 'webdav') detail = target.url ? `${target.url}${target.basePath}` : '未配置地址'
      else detail = target.url || '未配置地址'
      const safe = { ...target }
      if (safe.password) safe.password = '***'
      if (safe.token) safe.token = '***'
      return {
        ...safe,
        id: target.id,
        type: target.type,
        label: target.label,
        enabled: target.enabled !== false,
        detail,
        lastSyncAt: saved.lastSyncAt ?? null,
        lastResult: saved.lastResult ?? null,
      }
    })
    return {
      ok: true,
      deviceId: this.store.deviceId,
      deviceName: config.deviceName,
      autoSync: config.autoSync,
      autoSave: config.autoSave,
      syncOnStart: config.syncOnStart,
      autoSaveIntervalSeconds: config.autoSaveIntervalSeconds,
      autoSyncIntervalSeconds: config.autoSyncIntervalSeconds,
      maxFileBytes: config.maxFileBytes,
      concurrency: config.concurrency,
      compressObjects: config.compressObjects,
      roots: config.roots,
      targets,
      peer: {
        url: `${origin.replace(/\/+$/, '')}/dsh-sync/v1`,
        token: config.peerToken,
      },
      logs: this.store.state.logs.slice(-50),
      conflicts: this.store.state.conflicts.slice(-50),
      busy: this.busy,
      // 同步中实时进度：让设置页能显示 ↑↓ 速度，而不是只有结束后的平均值。
      progress: this.progress ? this.progressSnapshot() : null,
      warnings: this.store.warnings,
      config: maskConfig(config),
    }
  }

  /** 同步中进度的对外快照（含实时速率）。 */
  progressSnapshot() {
    const progress = this.progress
    if (!progress) return null
    const elapsedMs = Math.max(1, nowMs() - progress.startedAt)
    const seconds = elapsedMs / 1000
    const up = Math.round(progress.wireBytesUp / seconds)
    const down = Math.round(progress.wireBytesDown / seconds)
    return {
      elapsedMs,
      targetId: progress.targetId,
      phase: progress.phase,
      wireBytesUp: progress.wireBytesUp,
      wireBytesDown: progress.wireBytesDown,
      upBytesPerSecond: up,
      downBytesPerSecond: down,
    }
  }

  /** 测试一个未保存的 target 草稿。 */
  async testTarget(draft) {
    const [resolved] = this.fillMaskedSecrets([draft])
    const result = normalizeTarget(resolved, { ...this.store.env, DSH_HOME: this.store.homeDir })
    if (!result.ok) return { ok: false, detail: result.error }
    let backend
    try {
      backend = await this.backendFactory(result.target, { logger: this.logger })
      return await backend.test()
    } catch (error) {
      return { ok: false, detail: error?.message ?? String(error) }
    } finally {
      try {
        await backend?.close?.()
      } catch {}
    }
  }

  /** 扫描本地根目录。 */
  async scanLocal({ saveCache = true, signal } = {}) {
    const cache = this.store.cacheMap()
    const result = await scanRoots(this.enabledRoots(), {
      maxFileBytes: this.config.maxFileBytes,
      cache,
      dshHome: this.store.homeDir,
      signal,
      warn: (message) => this.store.log('warn', message),
    })
    if (result.skipped.length > 0) {
      const preview = result.skipped.slice(0, 5).map((item) => item.key).join('、')
      this.store.log('warn', `已跳过 ${result.skipped.length} 个超过 ${formatBytes(this.config.maxFileBytes)} 的文件：${preview}${result.skipped.length > 5 ? '…' : ''}`)
    }
    if (saveCache) await this.store.saveCache(result.cache)
    return result
  }

  /** 读取并合并后端上所有设备的 manifest。 */
  async readRemote(backend, { signal } = {}) {
    const manifests = []
    let deviceIds = []
    try {
      deviceIds = await backend.listDevices()
    } catch (error) {
      this.store.log('warn', `读取设备列表失败：${error?.message ?? error}`)
    }
    // 设备 manifest 数量通常很少，但每台都是一次往返：并发读取缩短启动时间。
    const manifestLimiter = createLimiter({ concurrency: 4, maxBytes: 1024 * 1024 })
    await runBatched(deviceIds, manifestLimiter, async (deviceId) => {
      if (signal?.aborted) throw new Error('aborted')
      try {
        const raw = await backend.readManifest(deviceId)
        if (raw === null || raw === undefined) return
        const manifest = normalizeManifest(raw)
        if (manifest === null) {
          this.store.log('warn', `忽略无效 manifest：${deviceId}`)
          return
        }
        if (manifest.skipped > 0) this.store.log('warn', `${deviceId} 的 manifest 有 ${manifest.skipped} 条无效记录，已跳过`)
        manifests.push(manifest)
      } catch (error) {
        this.store.log('warn', `读取 manifest 失败（${deviceId}）：${error?.message ?? error}`)
      }
    })
    return mergeManifests(manifests)
  }

  /** 执行一次同步：不传 targetId 时扇出到所有启用 target。 */
  async sync({ targetId, mode = 'auto', trigger = 'manual', signal } = {}) {
    const normalizedMode = ['auto', 'push', 'pull'].includes(mode) ? mode : 'auto'
    const targets = targetId
      ? this.config.targets.filter((target) => target.id === targetId)
      : this.enabledTargets()
    if (targets.length === 0) {
      const waiting = this.config.targets.filter((target) => target.enabled !== false && !this.targetUsable(target))
      return {
        ok: false,
        // 默认目标就是 WebDAV，启用但没填地址时要说清楚缺什么，而不是笼统一句“没有启用”。
        error: waiting.length > 0
          ? '已启用的同步目标还没填好地址（先填 WebDAV 地址与账号）'
          : '没有启用的同步目标（默认走 WebDAV，先在设置页填地址与账号并启用）',
        reports: [],
      }
    }
    if (this.busy && trigger !== 'manual') {
      return { ok: true, skipped: true, reason: 'busy', reports: [] }
    }

    this.busy = true
    this.progress = {
      startedAt: nowMs(),
      updatedAt: nowMs(),
      targetId: targets[0]?.id ?? null,
      phase: 'scan',
      wireBytesUp: 0,
      wireBytesDown: 0,
    }
    try {
      const reports = await this.serialize(async () => {
        const out = []
        for (const target of targets) {
          const report = await this.syncOne(target, normalizedMode, { trigger, signal })
          out.push(report)
        }
        return out
      })
      return { ok: reports.every((report) => report.ok), reports }
    } finally {
      this.busy = false
      this.progress = null
    }
  }

  /** 单 target 同步。 */
  async syncOne(target, mode, { trigger = 'manual', signal } = {}) {
    const startedAt = nowMs()
    const stats = {
      targetId: target.id,
      type: target.type,
      trigger,
      mode,
      ok: false,
      pushed: 0,
      pulled: 0,
      deletedLocal: 0,
      tombstoned: 0,
      conflicts: 0,
      skipped: 0,
      errors: 0,
      bytesUp: 0,
      bytesDown: 0,
      wireBytesUp: 0,
      wireBytesDown: 0,
      skippedUploads: 0,
      bytesPerSecond: 0,
      upBytesPerSecond: 0,
      downBytesPerSecond: 0,
      durationMs: 0,
      error: null,
    }
    // 本 target 的实时字节计数：由后端回调累加，结束时结算进 stats。
    const live = { up: 0, down: 0 }
    let backend
    try {
      // 实时字节回调：本 target 单独计数（结算进 stats），同时镜像到全局 progress
      // 供设置页在同步中显示 ↑↓ 速度。
      const onBytes = (direction, n) => {
        const delta = Number(n)
        if (!Number.isFinite(delta) || delta <= 0) return
        if (direction === 'up') live.up += delta
        else live.down += delta
        const progress = this.progress
        if (!progress) return
        if (direction === 'up') progress.wireBytesUp += delta
        else progress.wireBytesDown += delta
        progress.updatedAt = nowMs()
      }
      backend = await this.backendFactory(target, {
        logger: this.logger,
        signal,
        compress: this.config.compressObjects !== false,
        onBytes,
      })
      await backend.init()
    } catch (error) {
      stats.error = error?.message ?? String(error)
      stats.durationMs = nowMs() - startedAt
      this.store.log('error', `[${target.id}] 初始化失败：${stats.error}`)
      await this.store.recordTarget(target.id, { base: this.store.baseFor(target.id), tombstones: this.store.tombstonesFor(target.id), lastSyncAt: nowMs(), lastResult: stats })
      return stats
    }

    try {
      const localScan = await this.scanLocal({ signal })
      const local = localScan.entries
      const remoteRaw = await this.readRemote(backend, { signal })
      const baseRaw = this.store.baseFor(target.id)
      const enabledIds = new Set(this.enabledRoots().map((root) => root.id))
      // 被排除、超大、链接、读失败、禁用/未知根目录：全部视为"不归本机管"，
      // 既不当成本地删除，也不写墓碑——否则禁用根目录或调小上限会删掉别的设备的数据。
      const ignored = (key) => {
        const slash = key.indexOf('/')
        const rootId = slash > 0 ? key.slice(0, slash) : key
        if (!enabledIds.has(rootId)) return true
        if (localScan.ignoredKeys?.has(key)) return true
        for (const prefix of localScan.ignoredPrefixes ?? []) {
          if (key === prefix || key.startsWith(`${prefix}/`)) return true
        }
        return false
      }
      const filterMap = (map) => {
        const next = new Map()
        for (const [key, value] of map) {
          if (!ignored(key)) next.set(key, value)
        }
        return next
      }
      const remote = filterMap(remoteRaw)
      const base = filterMap(baseRaw)
      const tombstones = this.store.tombstonesFor(target.id)
      const plan = planMerge({ local, remote, base })

      const baseUpdates = new Map() // key → {hash,size,mtimeMs,updatedAt}
      const objectCache = new Map() // hash → bytes（本次同步内复用）
      const objectInflight = new Map() // hash → Promise（同 hash 并发读去重）
      const pulledEntries = new Map() // key → remote entry（保留其归属）
      const pushedKeys = new Set()

      // 并发度来自配置；字节预算固定 64MiB，防止并发大文件把内存打爆。
      const limiter = createLimiter({ concurrency: this.config.concurrency })

      // ── 拉取 / 删除本地 ───────────────────────────────────────────
      // 拉取、删除、冲突备份三类条目键互不重叠，可并发；失败仍逐条记录，
      // 单条失败不影响其他条目（与原来串行版本的容错语义一致）。
      if (mode !== 'push') {
        await runBatched(
          plan.pull,
          limiter,
          async (item) => {
            try {
              const bytes = await this.fetchObject(backend, item.entry.hash, objectCache, objectInflight)
              if (bytes === null) throw new Error(`远端对象缺失：${item.entry.hash}`)
              const root = this.rootById(item.entry.root)
              if (!root) throw new Error(`根目录已停用：${item.entry.root}`)
              const written = await this.writeLocalFile(root.path, item.entry.path, bytes, item.entry.mtimeMs)
              if (!written) throw new Error('路径不安全')
              const next = { ...item.entry, key: item.key }
              local.set(item.key, next)
              baseUpdates.set(item.key, {
                hash: item.entry.hash,
                size: bytes.byteLength,
                mtimeMs: item.entry.mtimeMs,
                updatedAt: item.entry.updatedAt,
              })
              pulledEntries.set(item.key, next)
              stats.pulled += 1
              stats.bytesDown += bytes.byteLength
            } catch (error) {
              stats.errors += 1
              this.store.log('warn', `[${target.id}] 拉取失败 ${item.key}：${error?.message ?? error}`)
            }
          },
          (item) => item.entry?.size ?? 0,
        )

        await runBatched(plan.deleteLocal, limiter, async (item) => {
          try {
            const parts = splitKey(item.key)
            if (!parts) throw new Error('key 非法')
            const root = this.rootById(parts.root)
            if (!root) throw new Error(`根目录已停用：${parts.root}`)
            const abs = resolveInside(root.path, parts.path)
            if (!abs) throw new Error('路径不安全')
            await removeFileIfExists(abs)
            local.delete(item.key)
            baseUpdates.set(item.key, { hash: null })
            stats.deletedLocal += 1
          } catch (error) {
            stats.errors += 1
            this.store.log('warn', `[${target.id}] 删除失败 ${item.key}：${error?.message ?? error}`)
          }
        })

        // ── 冲突副本：远端内容落地，本地内容保留 ─────────────────────
        await runBatched(
          plan.conflict.filter((item) => item.reason !== 'local-deleted-remote-modified'),
          limiter,
          async (item) => {
            try {
              const bytes = await this.fetchObject(backend, item.entry.hash, objectCache, objectInflight)
              if (bytes === null) throw new Error(`远端对象缺失：${item.entry.hash}`)
              const copy = await this.writeConflictCopy(item.entry, bytes)
              if (copy === null) throw new Error('冲突副本写入失败')
              local.set(copy.key, copy.entry)
              stats.conflicts += 1
              this.store.addConflict({ key: item.key, copy: copy.relativePath, reason: item.reason })
            } catch (error) {
              stats.errors += 1
              this.store.log('warn', `[${target.id}] 冲突备份失败 ${item.key}：${error?.message ?? error}`)
            }
          },
          (item) => item.entry?.size ?? 0,
        )
      }

      // ── 上传 ─────────────────────────────────────────────────────
      if (mode !== 'pull') {
        await runBatched(
          plan.push,
          limiter,
          async (item) => {
            try {
              const parts = splitKey(item.key)
              if (!parts) throw new Error('key 非法')
              const root = this.rootById(parts.root)
              if (!root) throw new Error(`根目录已停用：${parts.root}`)
              const abs = resolveInside(root.path, parts.path)
              if (!abs) throw new Error('路径不安全')
              const bytes = await fsp.readFile(abs)
              const hash = sha256Bytes(bytes)
              if (hash !== item.entry.hash) {
                // 扫描后文件又变了：以当前内容为准，避免发布错误 hash。
                item.entry.hash = hash
                item.entry.size = bytes.byteLength
                item.entry.mtimeMs = Math.floor((await fsp.stat(abs)).mtimeMs)
              }
              const uploaded = await this.putObject(backend, hash, bytes)
              if (uploaded.skipped) {
                // 其他设备已经传过同一内容：省掉整次 PUT。
                stats.skippedUploads += 1
                stats.wireBytesUp += 0
              } else {
                stats.wireBytesUp += uploaded.storedBytes
              }
              local.set(item.key, { ...item.entry, hash })
              baseUpdates.set(item.key, {
                hash,
                size: bytes.byteLength,
                mtimeMs: item.entry.mtimeMs,
                updatedAt: nowMs(),
              })
              pushedKeys.add(item.key)
              stats.pushed += 1
              stats.bytesUp += bytes.byteLength
            } catch (error) {
              stats.errors += 1
              this.store.log('warn', `[${target.id}] 上传失败 ${item.key}：${error?.message ?? error}`)
            }
          },
          (item) => item.entry?.size ?? 0,
        )

        // 冲突副本作为新文件上传，保证其他设备也能拿到两份内容。
        await runBatched(
          plan.conflict.filter((item) => item.reason !== 'local-deleted-remote-modified'),
          limiter,
          async (item) => {
            const copy = [...local.values()].find((entry) => entry.conflictOf === item.key) ?? null
            if (!copy) return
            try {
              const root = this.rootById(copy.root)
              if (!root) return
              const abs = resolveInside(root.path, copy.path)
              if (!abs) return
              const bytes = await fsp.readFile(abs)
              const uploaded = await this.putObject(backend, copy.hash, bytes)
              stats.wireBytesUp += uploaded.storedBytes
              baseUpdates.set(copy.key, { hash: copy.hash, size: copy.size, mtimeMs: copy.mtimeMs, updatedAt: nowMs() })
              stats.bytesUp += bytes.byteLength
            } catch (error) {
              stats.errors += 1
              this.store.log('warn', `[${target.id}] 冲突副本上传失败：${error?.message ?? error}`)
            }
          },
          (item) => item.entry?.size ?? 0,
        )

        for (const item of plan.pushTombstone) {
          const parts = splitKey(item.key)
          if (!parts) continue
          const entry = {
            key: item.key,
            root: parts.root,
            path: parts.path,
            deleted: true,
            updatedAt: nowMs(),
            deviceId: this.store.deviceId,
          }
          tombstones.set(item.key, entry)
          local.delete(item.key)
          baseUpdates.set(item.key, { hash: null })
          stats.tombstoned += 1
        }
      }

      // ── keep / clearBase ────────────────────────────────────────
      for (const item of plan.keep) {
        if (!baseUpdates.has(item.key)) baseUpdates.set(item.key, { hash: item.hash })
      }
      for (const key of plan.clearBase) {
        baseUpdates.delete(key)
        tombstones.delete(key)
      }

      // 本地重新存在的文件，移除旧墓碑。
      for (const key of local.keys()) tombstones.delete(key)

      // ── 发布本设备 manifest ─────────────────────────────────────
      const manifestEntries = new Map()
      for (const entry of local.values()) {
        const pulled = pulledEntries.get(entry.key)
        const previous = this.store.baseFor(target.id).get(entry.key)
        const isPushed = pushedKeys.has(entry.key)
        const isConflictCopy = entry.conflictOf !== undefined
        manifestEntries.set(entry.key, {
          ...entry,
          updatedAt: isPushed
            ? nowMs()
            : pulled?.updatedAt ?? previous?.updatedAt ?? entry.mtimeMs ?? nowMs(),
          deviceId: isPushed || isConflictCopy ? this.store.deviceId : pulled?.deviceId ?? this.store.deviceId,
        })
      }
      const manifest = createDeviceManifest({
        deviceId: this.store.deviceId,
        deviceName: this.config.deviceName,
        roots: this.manifestRoots(this.enabledRoots()),
        entries: manifestEntries,
        tombstones,
        now: nowMs(),
      })
      await backend.writeManifest(this.store.deviceId, manifest)

      // ── 基线落地 ─────────────────────────────────────────────────
      // 基线从"完整旧基线"出发，忽略集合的条目原样保留，避免重新启用时丢基线。
      const nextBase = new Map(baseRaw)
      for (const key of plan.clearBase) nextBase.delete(key)
      for (const [key, update] of baseUpdates) {
        if (update.hash === null) nextBase.delete(key)
        else {
          nextBase.set(key, {
            hash: update.hash,
            size: update.size ?? nextBase.get(key)?.size ?? 0,
            mtimeMs: update.mtimeMs ?? nextBase.get(key)?.mtimeMs ?? 0,
            updatedAt: update.updatedAt ?? nowMs(),
          })
        }
      }
      stats.ok = stats.errors === 0
      stats.durationMs = nowMs() - startedAt
      stats.skipped = localScan.skipped.length
      stats.scanned = localScan.filesSeen
      const seconds = stats.durationMs / 1000
      stats.wireBytesDown = live.down
      stats.bytesPerSecond = seconds > 0 ? Math.round((stats.bytesUp + stats.bytesDown) / seconds) : 0
      stats.upBytesPerSecond = seconds > 0 ? Math.round(stats.wireBytesUp / seconds) : 0
      stats.downBytesPerSecond = seconds > 0 ? Math.round(stats.wireBytesDown / seconds) : 0
      await this.store.recordTarget(target.id, {
        base: nextBase,
        tombstones,
        lastSyncAt: nowMs(),
        lastResult: stats,
      })
      // 带上吞吐与省流数据：优化效果要能被看见，而不是靠感觉。
      const throughput = stats.bytesPerSecond > 0 ? `，${formatBytes(stats.bytesPerSecond)}/s` : ''
      const dedupe = stats.skippedUploads > 0 ? `，去重跳过${stats.skippedUploads}` : ''
      const wire = stats.wireBytesUp > 0 && stats.wireBytesUp !== stats.bytesUp
        ? `，实传${formatBytes(stats.wireBytesUp)}`
        : ''
      this.store.log(stats.ok ? 'info' : 'warn',
        `[${target.id}] ${mode} 同步完成：↑${stats.pushed} ↓${stats.pulled} 删除${stats.deletedLocal} 墓碑${stats.tombstoned} 冲突${stats.conflicts} 错误${stats.errors}${dedupe}${wire}（${stats.durationMs}ms${throughput}）`)
      await this.store.saveState()
      return stats
    } catch (error) {
      stats.ok = false
      stats.error = error?.message ?? String(error)
      stats.durationMs = nowMs() - startedAt
      this.store.log('error', `[${target.id}] 同步失败：${stats.error}`)
      await this.store.recordTarget(target.id, {
        base: this.store.baseFor(target.id),
        tombstones: this.store.tombstonesFor(target.id),
        lastSyncAt: nowMs(),
        lastResult: stats,
      })
      return stats
    } finally {
      try {
        await backend?.close?.()
      } catch {}
    }
  }

  /**
   * 读对象（本次同步内缓存，并对同一 hash 的并发读去重）。
   * 并发拉取时多个条目可能引用同一对象，去重能避免重复下载。
   */
  async fetchObject(backend, hash, cache, inflight) {
    if (cache.has(hash)) return cache.get(hash)
    if (inflight?.has(hash)) return inflight.get(hash)
    const task = (async () => {
      const bytes = await backend.readObject(hash)
      if (bytes === null) return null
      if (sha256Bytes(bytes) !== hash) throw new Error(`对象校验失败：${hash}`)
      // 只缓存小对象：一次同步可能拉取上 GB 数据，全量缓存会把宿主内存打爆。
      // 大对象不缓存（同一 hash 的并发读由 inflight 去重兜住，极少重复 GET）。
      if (bytes.byteLength <= 2 * 1024 * 1024) cache.set(hash, bytes)
      return bytes
    })()
    if (inflight) {
      inflight.set(hash, task)
      task.then(
        () => inflight.delete(hash),
        () => inflight.delete(hash),
      )
    }
    return task
  }

  /**
   * 上传对象。
   *
   * 只调 writeObject：所有后端内部都已经做了“已存在则跳过”的探测
   * （WebDAV/Peer 走对象索引，Local 走 stat）。以前在这里又探测一次，
   * 导致每个对象 2 次 HEAD + 1 次 PUT；现在探测只发生一次。
   *
   * @returns {Promise<{skipped: boolean, storedBytes: number}>}
   */
  async putObject(backend, hash, bytes) {
    const result = await backend.writeObject(hash, bytes)
    const skipped = result?.skipped === true
    const storedBytes = Number.isFinite(result?.storedBytes)
      ? Number(result.storedBytes)
      : bytes.byteLength
    return { skipped, storedBytes: skipped ? 0 : storedBytes }
  }

  /** 写本地文件（原子 + mtime + 路径校验）。 */
  async writeLocalFile(rootPath, relPath, bytes, mtimeMs) {
    const abs = resolveInside(rootPath, relPath)
    if (abs === null) return false
    await ensureDir(path.dirname(abs))
    await writeFileAtomic(abs, bytes, { mtimeMs: Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : undefined })
    return true
  }

  /** 把远端冲突内容写成同目录副本。 */
  async writeConflictCopy(remoteEntry, bytes) {
    const root = this.rootById(remoteEntry.root)
    if (!root) return null
    const parsed = path.posix.parse(remoteEntry.path)
    const suffix = `conflict-${this.store.deviceId.slice(0, 8)}-${conflictStamp()}`
    let candidate = parsed.dir ? `${parsed.dir}/${parsed.name}.${suffix}${parsed.ext}` : `${parsed.name}.${suffix}${parsed.ext}`
    let counter = 1
    while (true) {
      const abs = resolveInside(root.path, candidate)
      if (abs === null) return null
      try {
        await fsp.lstat(abs)
        counter += 1
        candidate = parsed.dir
          ? `${parsed.dir}/${parsed.name}.${suffix}-${counter}${parsed.ext}`
          : `${parsed.name}.${suffix}-${counter}${parsed.ext}`
        continue
      } catch {
        try {
          await ensureDir(path.dirname(abs))
          await writeFileAtomic(abs, bytes)
          const stat = await fsp.stat(abs)
          return {
            key: entryKey(root.id, candidate),
            relativePath: candidate,
            entry: {
              key: entryKey(root.id, candidate),
              root: root.id,
              path: candidate,
              hash: remoteEntry.hash,
              size: bytes.byteLength,
              mtimeMs: Math.floor(stat.mtimeMs),
              updatedAt: nowMs(),
              deviceId: this.store.deviceId,
              conflictOf: remoteEntry.key,
            },
          }
        } catch {
          return null
        }
      }
    }
  }

  /**
   * 按给定根列表扫描（用于「完整备份」把工作区临时并入）。
   * 与 scanLocal 的区别：不吃 this.enabledRoots()，但仍复用同一套忽略/缓存逻辑。
   */
  async scanWithRoots(roots, { saveCache = false, signal } = {}) {
    const cache = this.store.cacheMap()
    const result = await scanRoots(roots, {
      maxFileBytes: this.config.maxFileBytes,
      cache,
      dshHome: this.store.homeDir,
      signal,
      warn: (message) => this.store.log('warn', message),
    })
    if (result.skipped.length > 0) {
      this.store.log('warn', `完整备份跳过 ${result.skipped.length} 个超过 ${formatBytes(this.config.maxFileBytes)} 的文件`)
    }
    // 工作区是临时根，不能写进常规缓存（否则下次普通同步会带着不存在的根）。
    if (saveCache) await this.store.saveCache(result.cache)
    return result
  }

  /**
   * 写进 manifest 的根清单：只记录**被归档覆盖**的根，且带绝对路径。
   * 路径是跨设备稳定的锚点——根 id 由 label 派生，两台设备上可能不同。
   */
  manifestRoots(roots = null) {
    const list = Array.isArray(roots) ? roots : (this.config.roots ?? [])
    return list.map((root) => ({ id: root.id, path: root.path }))
  }

  /**
   * 导入时把归档里的根 id 映射到本地根。
   * 顺序：同 id → 同路径（归档里记录的原路径）→ 在可信父目录内补建。
   * 路径不在可信目录内时一律不补建，避免归档把文件写到任意位置。
   */
  resolveImportRoot(entry) {
    const direct = this.rootById(entry.root)
    if (direct) return { root: direct, created: false }
    const declaredPath = this.importRootPaths?.get(entry.root)
    if (typeof declaredPath !== 'string' || declaredPath === '') return null
    const samePath = (this.config.roots ?? []).find((root) => root.path === declaredPath)
    if (samePath) return { root: samePath, created: false }
    // 完整应用数据的根：无论原机 DSH_HOME 在哪，都落到本机 DSH_HOME。
    // 这是「新设备装完即等同原机」的关键——换机器时 home 路径本来就可能不同。
    if (entry.root === 'dsh-home') {
      const home = path.posix.normalize(this.store.homeDir || '')
      if (home.startsWith('/')) return { root: this.ensureImportHomeRoot(home), created: true }
    }
    // 换设备/重装：本机还没有这个根。可以就地补一个，否则「数据拯救」只能同机还原。
    // 补根只发生在「路径安全且位于本机可信父目录下」时，避免归档把文件写到任意位置。
    const adopted = this.adoptImportRoot(entry.root, declaredPath)
    if (adopted !== null) return adopted
    // link 插件源码：原路径不可用时**不能丢**（丢了新设备就少了功能），
    // 落到本机 DSH_HOME 下的 linked-plugins/<名字>，源码至少还在。
    if (String(entry.root).startsWith('link-')) {
      return { root: this.ensureImportLinkRoot(entry.root, declaredPath), created: true }
    }
    return null
  }

  /** 导入时把 dsh-home 根绑到本机 DSH_HOME（换设备重定位用）。 */
  ensureImportHomeRoot(home) {
    const existing = (this.config.roots ?? []).find((root) => root.path === home)
    if (existing) return existing
    const root = { id: 'dsh-home', label: 'DSH 应用数据', path: home, enabled: true, exclude: [] }
    this.config.roots.push(root)
    this.importAdoptedRoots.push(root)
    this.store.log('info', `完整应用数据恢复到本机 DSH_HOME：${home}`)
    return root
  }

  /**
   * link 插件源码的兜底落点：原路径不可用时收到 `$DSH_HOME/linked-plugins/<name>`。
   * 目录名取自原路径的最后一段，保持可辨认。
   */
  ensureImportLinkRoot(rootId, declaredPath) {
    const home = path.posix.normalize(this.store.homeDir || '')
    const baseName = path.posix.basename(path.posix.normalize(declaredPath)) || 'linked-plugin'
    const safeName = String(baseName).replace(/[^A-Za-z0-9._@-]/g, '-').replace(/^\.+/, '') || 'linked-plugin'
    const target = path.posix.join(home, 'linked-plugins', safeName)
    const existing = (this.config.roots ?? []).find((root) => root.path === target)
    if (existing) return existing
    const root = { id: String(rootId), label: safeName, path: target, enabled: true, exclude: [] }
    this.config.roots.push(root)
    this.importAdoptedRoots.push(root)
    this.importRelocatedLinks.push({ id: String(rootId), from: declaredPath, to: target })
    this.store.log('warn', `自有插件源码原路径不可用（${declaredPath}），改放到 ${target}；请在 profile 的 package.json 里把 link: 指到这里`)
    return root
  }

  /** 导入期间按归档记录的路径补建根；不安全的路径一律拒绝。 */
  adoptImportRoot(rootId, declaredPath) {
    const safeBases = this.importAdoptBases()
    const normalized = path.posix.normalize(declaredPath)
    const inside = safeBases.some((base) => normalized === base || normalized.startsWith(base.endsWith('/') ? base : base + '/'))
    if (!inside) {
      this.store.log('warn', `拒绝按归档路径补建根：${declaredPath}（不在本机可信目录内）`)
      return null
    }
    const existing = (this.config.roots ?? []).find((root) => root.path === normalized)
    if (existing) return { root: existing, created: false }
    // id 冲突时加后缀，保持归档（按路径）可继续解析
    let id = String(rootId)
    const ids = new Set((this.config.roots ?? []).map((root) => root.id))
    while (ids.has(id)) id = `${id}-x`
    const root = { id, label: path.posix.basename(normalized) || normalized, path: normalized, enabled: true, exclude: [] }
    this.config.roots.push(root)
    this.importAdoptedRoots.push(root)
    this.store.log('info', `按归档路径补建备份根「${root.label}」→ ${root.path}`)
    return { root, created: true }
  }

  /** 允许补建根的可信父目录：DSH 主目录与其默认工作区父目录。 */
  importAdoptBases() {
    const bases = new Set()
    const home = path.posix.normalize(this.store.homeDir || '')
    if (home.startsWith('/')) {
      bases.add(home)
      const parent = path.posix.dirname(home)
      if (parent !== '/' && parent !== '.') bases.add(parent)
    }
    return [...bases]
  }

  /**
   * 导出本地快照为 .dshsync。
   * scope='full' 时把「工作区文件」也一起打包：根 = 已启用根 + 探测到的 DSH 工作区。
   * 工作区根用由路径推导的稳定 id（跨设备一致），并写进 manifest 的 roots，便于换机恢复。
   */
  async exportArchive({ signal, scope = 'roots' } = {}) {
    const extras = []
    let workspaceReport = null
    if (scope === 'full') {
      const detected = await detectWorkspaces({
        dshHome: this.store.homeDir,
        coveredBy: this.enabledRoots().map((root) => root.path),
      })
      // 体积预算：完整备份必须能导得回来。超预算的工作区跳过并说明，
      // 而不是等到 buildArchive 把所有对象读进内存才 OOM。
      // 已启用根（如 88M 的会话）也占额度，否则「根 + 工作区」会悄悄超出上限。
      const budget = this.config.maxArchiveBytes
      let baseline = 0
      for (const root of this.enabledRoots()) {
        baseline += await directorySize(root.path, { limitBytes: budget }).catch(() => 0)
      }
      const workspaceBudget = Math.max(0, budget - baseline)
      const sized = []
      for (const item of detected.kept) {
        const bytes = await directorySize(item.path).catch(() => 0)
        sized.push({ ...item, bytes })
      }
      // 小的工作区优先，保证预算花在“能拿回更多内容”的地方。
      sized.sort((a, b) => a.bytes - b.bytes)
      const accepted = []
      let spent = 0
      const tooBig = []
      for (const item of sized) {
        if (spent + item.bytes > workspaceBudget) {
          tooBig.push(item)
          continue
        }
        spent += item.bytes
        accepted.push(item)
        extras.push({
          id: workspaceRootId(item.path),
          label: item.title,
          path: item.path,
          enabled: true,
          exclude: [],
          workspace: true,
        })
      }
      workspaceReport = {
        kept: accepted.length,
        dropped: detected.dropped,
        budget,
        baselineBytes: baseline,
        workspaceBudget,
        plannedBytes: spent,
        skippedTooBig: tooBig.map((item) => ({ title: item.title, path: item.path, bytes: item.bytes })),
      }
      for (const item of tooBig) {
        this.store.log('warn', `完整备份跳过工作区「${item.title}」（${formatBytes(item.bytes)}），可用额度 ${formatBytes(workspaceBudget)}`)
      }
      this.store.log('info', `完整备份：已有根约 ${formatBytes(baseline)}，纳入工作区 ${workspaceReport.kept} 个（约 ${formatBytes(spent)}）${tooBig.length > 0 ? `，因额度不足跳过 ${tooBig.length} 个` : ''}${detected.dropped.length > 0 ? `，不适用 ${detected.dropped.length} 个` : ''}`)
    }
    // scope=app：完整应用数据。除了已启用根，还要带上 DSH_HOME 本身与自己写的 link 插件源码，
    // 否则新设备只能拿到"部分数据"，谈不上和原机一样。
    let appPlan = null
    if (scope === 'app') {
      const profileDir = this.store.profileDir
      const linkSources = await detectLinkSources({ profileDir })
      const appRoots = appDataRoots({
        dshHome: this.store.homeDir,
        profileDir,
        linkSources,
        includeSecrets: this.config.backupSecrets !== false,
      })
      appPlan = buildRestorePlan({
        dshHome: this.store.homeDir,
        profileDir,
        profile: this.store.profileName || 'web',
        dshVersion: this.config.dshVersion || await detectDshVersion(),
        linkSources,
        includeSecrets: this.config.backupSecrets !== false,
      })
      for (const root of appRoots) {
        // 已启用根若与 DSH_HOME 重叠（很常见：sessions/documents 都在里面），
        // 以 app 根为准，避免同一文件被两个根扫描两次而产生重复 entry。
        if (extras.some((item) => item.id === root.id)) continue
        extras.push(root)
      }
      this.store.log('info', `完整应用数据：${appRoots.length} 个根（含 ${appPlan.linkSources.length} 个自有插件源码）`)
    }
    const scanRootsList = scope === 'app' ? [...extras] : [...this.enabledRoots(), ...extras]
    this._exportRoots = scanRootsList
    try {
      // 没有额外根时才走 scanLocal（它只扫已启用根）；只要有 extras 就必须按根列表扫，
      // 否则工作区/app 根会被漏掉。
      const scan = extras.length === 0
        ? await this.scanLocal({ signal })
        : await this.scanWithRoots(scanRootsList, { signal })
      // 扫描与读取之间文件可能又被追加（会话日志正在写）：以实际读到的字节为准
      // 重建清单，避免旧 hash 与新内容不匹配导致导出失败/快照自相矛盾。
      const entries = new Map()
      // 只记「hash → 绝对路径」，不记字节：完整应用数据上百 MiB，
      // 把内容全攒在内存里会在打包前就 OOM。真正的读取交给 buildArchiveStream。
      const pathByHash = new Map()
      let unreadable = 0
      for (const entry of scan.entries.values()) {
        if (signal?.aborted) throw new Error('aborted')
        const root = this.rootById(entry.root)
        if (!root) continue
        const abs = resolveInside(root.path, entry.path)
        if (abs === null) continue
        let bytes
        try {
          bytes = await fsp.readFile(abs)
        } catch {
          unreadable += 1
          continue
        }
        const hash = sha256Bytes(bytes)
        const size = bytes.byteLength
        bytes = null // 立刻释放：扫描阶段只用来算 hash 和大小
        entries.set(entry.key, {
          ...entry,
          hash,
          size,
          updatedAt: nowMs(),
          deviceId: this.store.deviceId,
        })
        pathByHash.set(`key:${entry.key}`, abs)
        if (!pathByHash.has(hash)) pathByHash.set(hash, abs)
      }
      const manifest = createDeviceManifest({
        deviceId: this.store.deviceId,
        deviceName: this.config.deviceName,
        roots: this.manifestRoots(this._exportRoots ?? null),
        entries,
        tombstones: new Map(),
        now: nowMs(),
      })
      const readObject = async (hash, entry) => {
        // 以 entry.key 定位文件，比 hash 更可靠：同一内容可能来自多个路径。
        const key = entry?.key
        const abs = (key !== undefined ? pathByHash.get(`key:${key}`) : undefined) ?? pathByHash.get(hash)
        if (!abs) return null
        try {
          return await fsp.readFile(abs)
        } catch {
          return null
        }
      }
      await ensureDir(this.store.exportsDir)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const name = `${sanitizeFileName(`dsh-sync-${this.config.deviceName}`)}-${stamp}.dshsync`
      const file = path.join(this.store.exportsDir, name)
      // 流式落盘：先写临时文件再改名，中途失败不会留下半截归档冒充完整备份。
      const tempFile = `${file}.part`
      const handle = await fsp.open(tempFile, 'w')
      let archive
      try {
        archive = await buildArchiveStream({
          manifest,
          readObject,
          extraMembers: appPlan === null ? [] : [
            { path: RESTORE_MEMBER, bytes: Buffer.from(JSON.stringify(appPlan, null, 2), 'utf8') },
            { path: RESTORE_DOC_MEMBER, bytes: Buffer.from(renderRestoreDoc(appPlan), 'utf8') },
            { path: RESTORE_SH_MEMBER, bytes: Buffer.from(renderRestoreScript(appPlan), 'utf8') },
          ],
          signal,
          write: async (chunk) => {
            await handle.write(chunk)
          },
        })
        await handle.sync()
      } catch (error) {
        await handle.close().catch(() => {})
        await fsp.rm(tempFile, { force: true }).catch(() => {})
        throw error
      }
      await handle.close()
      await fsp.rename(tempFile, file)
      const changedCount = Array.isArray(archive.changed) ? archive.changed.length : 0
      this.store.log('info', `导出快照 ${name}（${formatBytes(archive.size)}，${entries.size} 个文件${unreadable > 0 ? `，${unreadable} 个读取失败已跳过` : ''}${changedCount > 0 ? `，${changedCount} 个在导出期间被改动（已按最新内容写入）` : ''}）`)
      await this.store.saveState()
      return {
        ok: true,
        name,
        path: file,
        size: archive.size,
        sha256: archive.sha256,
        entries: entries.size,
        skipped: scan.skipped.length,
        scope,
        workspaces: workspaceReport,
        createdAt: nowIso(),
      }
    } finally {
      // 临时根只在本次导出期间有效，之后必须清掉，否则普通同步会解析到不存在的根。
      this._exportRoots = null
    }
  }

  /** 导入 .dshsync：归档内容覆盖本地（本地旧内容留冲突副本），不删除归档外文件。 */
  async importArchive({ bytes, name = 'import.dshsync', signal } = {}) {
    const parsed = await parseArchive(bytes)
    const manifest = normalizeManifest(parsed.manifest)
    if (manifest === null) throw new Error('归档 manifest 无效')
    // 归档声明的根路径：根 id 对不上时按路径兜底（换设备/重装后恢复的关键）。
    this.importRootPaths = manifest.rootPaths ?? new Map()
    this.importAdoptedRoots = []
    this.importRelocatedLinks = []
    this.importAdoptBasesCache = null
    let imported = 0
    let unchanged = 0
    let conflicts = 0
    let skipped = 0
    let errors = 0
    const cache = this.store.cacheMap()

    for (const entry of manifest.entries.values()) {
      if (signal?.aborted) throw new Error('aborted')
      const resolved = this.resolveImportRoot(entry)
      const root = resolved?.root ?? null
      if (!root) {
        skipped += 1
        if (manifest.rootPaths?.has(entry.root)) {
          this.store.log('warn', `归档中的根「${entry.root}」在本机不存在（原路径 ${manifest.rootPaths.get(entry.root)}），已跳过 ${entry.path}`)
        }
        continue
      }
      const abs = resolveInside(root.path, entry.path)
      if (abs === null) {
        skipped += 1
        continue
      }
      const data = parsed.objects.get(entry.hash)
      if (data === undefined) {
        errors += 1
        this.store.log('warn', `归档缺少对象：${entry.hash}`)
        continue
      }
      let existing = null
      try {
        existing = await fsp.readFile(abs)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          errors += 1
          continue
        }
      }
      if (existing !== null && sha256Bytes(existing) === entry.hash) {
        unchanged += 1
        continue
      }
      if (existing !== null) {
        const copy = await this.writeImportBackup(root, entry.path, existing)
        if (copy !== null) {
          conflicts += 1
          this.store.addConflict({ key: entry.key, copy: copy.relativePath, reason: 'import-replaced' })
        }
      }
      try {
        await ensureDir(path.dirname(abs))
        await writeFileAtomic(abs, data, { mtimeMs: entry.mtimeMs || undefined })
        cache.set(entry.key, { size: data.byteLength, mtimeMs: entry.mtimeMs, hash: entry.hash })
        imported += 1
      } catch (error) {
        errors += 1
        this.store.log('warn', `导入写入失败 ${entry.key}：${error?.message ?? error}`)
      }
    }
    await this.store.saveCache(cache)
    if (this.importAdoptedRoots.length > 0) {
      // 补建的根必须落盘，否则本次恢复的文件在下次同步时又找不到归属。
      await this.store.saveConfig(this.config)
    }
    const adoptedRoots = this.importAdoptedRoots.map((root) => ({ id: root.id, path: root.path }))
    // 哪些归档根在本机没找到落点：换设备时最常见的失败原因，必须原样告诉用户，
    // 否则「导入成功但什么都没恢复」会被当成 bug。
    const matched = new Set()
    for (const entry of manifest.entries.values()) {
      if (this.resolveImportRoot(entry)?.root) matched.add(entry.root)
    }
    const unmatchedRoots = []
    for (const [rootId, rootPath] of manifest.rootPaths ?? new Map()) {
      if (!matched.has(rootId)) unmatchedRoots.push({ id: rootId, path: rootPath })
    }
    this.store.log('info', `导入 ${name}：写入 ${imported}，未变 ${unchanged}，冲突副本 ${conflicts}，跳过 ${skipped}，错误 ${errors}${adoptedRoots.length > 0 ? `，补建根 ${adoptedRoots.length} 个` : ''}`)
    await this.store.saveState()
    // 有内容但一个都没写进去 = 路径对不上。ok 只表示"流程没出错"（沿用既有契约），
    // 用 applied/warning 明确告诉用户"没落下任何文件"，否则会被当成恢复成功。
    const nothingApplied = imported === 0 && unchanged === 0 && skipped > 0
    return {
      ok: errors === 0,
      applied: !nothingApplied,
      warning: nothingApplied
        ? `归档里的路径在本机没有对应位置，未写入任何文件（${unmatchedRoots.length} 个根未匹配，例如 ${unmatchedRoots[0]?.path ?? '未知'}）`
        : undefined,
      imported,
      unchanged,
      conflicts,
      skipped,
      errors,
      adoptedRoots,
      unmatchedRoots,
      // 被改放到 linked-plugins 的自有插件源码：package.json 的 link: 需要按这里改。
      relocatedLinks: this.importRelocatedLinks,
      name,
    }
  }

  /** 导入时把被覆盖的本地内容留档。 */
  async writeImportBackup(root, relPath, bytes) {
    const parsed = path.posix.parse(relPath)
    const suffix = `conflict-local-${conflictStamp()}`
    let candidate = parsed.dir ? `${parsed.dir}/${parsed.name}.${suffix}${parsed.ext}` : `${parsed.name}.${suffix}${parsed.ext}`
    let counter = 1
    for (;;) {
      const abs = resolveInside(root.path, candidate)
      if (abs === null) return null
      try {
        await fsp.lstat(abs)
        counter += 1
        candidate = parsed.dir
          ? `${parsed.dir}/${parsed.name}.${suffix}-${counter}${parsed.ext}`
          : `${parsed.name}.${suffix}-${counter}${parsed.ext}`
      } catch {
        await ensureDir(path.dirname(abs))
        await writeFileAtomic(abs, bytes)
        return { key: entryKey(root.id, candidate), relativePath: candidate }
      }
    }
  }

  /** 启动自动任务。 */
  startAutomation() {
    this.stopAutomation()
    this.stopped = false
    const config = this.config
    const arm = (delayMs, callback, label) => {
      const timer = setInterval(() => {
        if (this.stopped) return
        Promise.resolve()
          .then(callback)
          .catch((error) => this.store.log('warn', `${label} 失败：${error?.message ?? error}`))
      }, Math.max(5000, delayMs))
      timer.unref?.()
      this.timers.add(timer)
      return timer
    }
    if (config.autoSave) {
      arm(config.autoSaveIntervalSeconds * 1000, () => this.sync({ mode: 'push', trigger: 'auto-save' }), '自动保存')
    }
    if (config.autoSync) {
      arm(config.autoSyncIntervalSeconds * 1000, () => this.sync({ mode: 'auto', trigger: 'auto' }), '自动同步')
    }
    if (config.syncOnStart) {
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null
        if (this.stopped) return
        this.sync({ mode: 'auto', trigger: 'startup' }).catch((error) => {
          this.store.log('warn', `启动同步失败：${error?.message ?? error}`)
        })
      }, 8000)
      this.startupTimer.unref?.()
    }
    this.store.log('info', `自动任务已启动：自动保存 ${config.autoSave ? `${config.autoSaveIntervalSeconds}s` : '关'}，自动同步 ${config.autoSync ? `${config.autoSyncIntervalSeconds}s` : '关'}`)
  }

  /** 停止自动任务。 */
  stopAutomation() {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
    if (this.startupTimer !== null) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
  }

  /** 配置更新后重启自动任务。 */
  restartAutomation() {
    this.stopAutomation()
    this.startAutomation()
  }
}
export function workspaceRootId(workspacePath) {
  const normalized = String(workspacePath ?? '')
  return 'ws-' + sha256Bytes(Buffer.from(normalized, 'utf8')).slice(0, 12)
}
