/**
 * dsh-sync 持久化：config.json + state.json。
 *
 * - 目录 0700，文件 0600（配置里有 WebDAV 密码与 peerToken）；
 * - 所有写入原子化；
 * - state 里保存每个 target 的同步基线、断点缓存、日志与冲突记录；
 * - 状态文件损坏时备份后重建，绝不让插件启动失败。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import {
  ensureDir,
  nowMs,
  randomHex,
  readJsonFile,
  ringPush,
  writeJsonAtomic,
} from './util.js'
import { configDir, defaultConfig, normalizeConfig } from './config.js'

const LOG_LIMIT = 500
const CONFLICT_LIMIT = 200
const STATE_VERSION = 1

/** 把对象形式的 map 转回 Map。 */
function toMap(value) {
  const map = new Map()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry && typeof entry === 'object') map.set(key, entry)
    }
  }
  return map
}

/** Map → 普通对象（按键排序，便于 diff）。 */
function toObject(map) {
  const out = {}
  for (const key of [...map.keys()].sort()) out[key] = map.get(key)
  return out
}

/** 给损坏的状态文件留档。 */
async function backupCorrupt(file) {
  try {
    await fsp.rename(file, `${file}.corrupt-${Date.now()}`)
  } catch {}
}

/**
 * 配置与状态仓库。
 */
export class SyncStore {
  /**
   * @param {object} options
   * @param {string} options.homeDir DSH_HOME
   * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [options.logger]
   * @param {NodeJS.ProcessEnv} [options.env]
   */
  constructor({ homeDir, logger = console, env = process.env }) {
    this.homeDir = homeDir
    this.env = env
    // DSH 自己在环境里给了 profile 名与目录；没有就以 web 兜底（默认 profile）。
    this.profileName = String(env.DSH_PROFILE || 'web')
    this.profileDir = String(env.DSH_PROFILE_DIR || `${homeDir}/profiles/${this.profileName}`)
    this.logger = logger
    this.dataDir = configDir({ ...env, DSH_HOME: homeDir, HOME: env.HOME })
    this.configFile = path.join(this.dataDir, 'config.json')
    this.stateFile = path.join(this.dataDir, 'state.json')
    this.exportsDir = path.join(this.dataDir, 'exports')
    this.config = defaultConfig({ ...env, DSH_HOME: homeDir })
    this.state = {
      version: STATE_VERSION,
      deviceId: randomHex(16),
      uiToken: randomHex(16),
      createdAt: nowMs(),
      cache: {},
      targets: {},
      logs: [],
      conflicts: [],
    }
    this.warnings = []
    this.writeChain = Promise.resolve()
    this.loaded = false
  }

  /** 读取配置与状态；首次运行写默认值。 */
  async load() {
    await ensureDir(this.dataDir)
    await ensureDir(this.exportsDir)

    let rawConfig
    try {
      rawConfig = await readJsonFile(this.configFile, undefined)
    } catch (error) {
      if (error?.code === 'ENOENT') rawConfig = undefined
      else {
        this.logger.warn?.(`[dsh-sync] 配置读取失败，使用默认值：${error.message}`)
        await backupCorrupt(this.configFile)
      }
    }
    if (rawConfig === undefined) {
      this.config = defaultConfig({ ...this.env, DSH_HOME: this.homeDir })
      await this.persistConfig()
    } else {
      const normalized = normalizeConfig(rawConfig, { ...this.env, DSH_HOME: this.homeDir })
      this.config = normalized.config
      this.warnings = normalized.warnings
      for (const warning of normalized.warnings) this.logger.warn?.(`[dsh-sync] ${warning}`)
      // 归一化会补全 peerToken 等内容；只有实际变化时才回写。
      const saved = JSON.stringify(rawConfig)
      const next = JSON.stringify(this.config)
      if (saved !== next) await this.persistConfig()
    }

    let rawState
    try {
      rawState = await readJsonFile(this.stateFile, undefined)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn?.(`[dsh-sync] 状态读取失败，已重建：${error.message}`)
        await backupCorrupt(this.stateFile)
      }
    }
    if (rawState && typeof rawState === 'object' && rawState.version === STATE_VERSION && typeof rawState.deviceId === 'string') {
      this.state = {
        version: STATE_VERSION,
        deviceId: rawState.deviceId,
        uiToken: typeof rawState.uiToken === 'string' && /^[a-f0-9]{32}$/.test(rawState.uiToken)
          ? rawState.uiToken
          : randomHex(16),
        createdAt: Number(rawState.createdAt) || nowMs(),
        cache: rawState.cache && typeof rawState.cache === 'object' ? rawState.cache : {},
        targets: rawState.targets && typeof rawState.targets === 'object' ? rawState.targets : {},
        logs: Array.isArray(rawState.logs) ? rawState.logs.slice(-LOG_LIMIT) : [],
        conflicts: Array.isArray(rawState.conflicts) ? rawState.conflicts.slice(-CONFLICT_LIMIT) : [],
      }
    } else {
      this.state.deviceId = randomHex(16)
      this.state.uiToken = randomHex(16)
      await this.persistState()
    }
    // 旧状态文件没有 UI token：补发并落盘。
    if (typeof this.state.uiToken !== 'string' || !/^[a-f0-9]{32}$/.test(this.state.uiToken)) {
      this.state.uiToken = randomHex(16)
      await this.persistState()
    }
    this.loaded = true
    return this
  }

  /** 设备 id。 */
  get deviceId() {
    return this.state.deviceId
  }

  /** 设置页 API 的会话令牌（index 注入，不随状态接口返回）。 */
  get uiToken() {
    return this.state.uiToken
  }

  /** 设备名。 */
  get deviceName() {
    return this.config.deviceName
  }

  /** 串行写文件，避免并发 rename 竞争。 */
  queueWrite(operation) {
    const next = this.writeChain.then(operation, operation)
    this.writeChain = next.catch(() => {})
    return next
  }

  /** 保存配置。 */
  async saveConfig(config) {
    this.config = config
    await this.persistConfig()
  }

  /** 写配置文件。 */
  persistConfig() {
    return this.queueWrite(() => writeJsonAtomic(this.configFile, this.config, { mode: 0o600 }))
  }

  /** 保存状态。 */
  async saveState() {
    await this.persistState()
  }

  /** 写状态文件。 */
  persistState() {
    const state = {
      version: STATE_VERSION,
      deviceId: this.state.deviceId,
      uiToken: this.state.uiToken,
      createdAt: this.state.createdAt,
      cache: this.state.cache,
      targets: this.state.targets,
      logs: this.state.logs.slice(-LOG_LIMIT),
      conflicts: this.state.conflicts.slice(-CONFLICT_LIMIT),
    }
    return this.queueWrite(() => writeJsonAtomic(this.stateFile, state, { mode: 0o600 }))
  }

  /** 上次扫描缓存（key → {size,mtimeMs,hash}）。 */
  cacheMap() {
    return toMap(this.state.cache)
  }

  /** 更新扫描缓存。 */
  async saveCache(map) {
    this.state.cache = toObject(map)
    await this.persistState()
  }

  /** 某 target 的基线（key → {hash,size,mtimeMs,updatedAt}）。 */
  baseFor(targetId) {
    return toMap(this.state.targets[targetId]?.base)
  }

  /** 某 target 的墓碑（key → entry）。 */
  tombstonesFor(targetId) {
    return toMap(this.state.targets[targetId]?.tombstones)
  }

  /** 记录一次 target 同步结果。 */
  async recordTarget(targetId, { base, tombstones, lastSyncAt, lastResult }) {
    const previous = this.state.targets[targetId] ?? {}
    this.state.targets[targetId] = {
      ...previous,
      base: toObject(base),
      tombstones: toObject(tombstones),
      lastSyncAt: lastSyncAt ?? nowMs(),
      lastResult: lastResult ?? previous.lastResult ?? null,
    }
    await this.persistState()
  }

  /** 追加日志（同时写给宿主 logger）。 */
  log(level, message) {
    const entry = { at: nowMs(), level, message: String(message).slice(0, 2000) }
    ringPush(this.state.logs, entry, LOG_LIMIT)
    const fn = this.logger?.[level]
    if (typeof fn === 'function') fn.call(this.logger, `[dsh-sync] ${message}`)
    // 日志不单独落盘：由调用方在同步结束时统一持久化，避免高频 IO。
  }

  /** 记录冲突。 */
  addConflict({ key, copy, reason }) {
    ringPush(this.state.conflicts, {
      at: nowMs(),
      key,
      copy: copy ?? null,
      reason: reason ?? 'conflict',
    }, CONFLICT_LIMIT)
  }

  /** 状态快照。 */
  snapshot() {
    return {
      deviceId: this.state.deviceId,
      deviceName: this.config.deviceName,
      targets: this.state.targets,
      cacheSize: Object.keys(this.state.cache ?? {}).length,
    }
  }
}