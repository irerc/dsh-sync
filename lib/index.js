/**
 * dsh-sync —— 多设备文件型同步插件（Host 半边）。
 *
 * 装配顺序：
 *   1. 读取 $DSH_HOME/dsh-sync/config.json 与 state.json；
 *   2. 创建 SyncEngine；
 *   3. 注册 Agent 工具；
 *   4. webServer 就绪后挂载 /dsh-sync 路由（设置页 API + 对等协议）；
 *   5. 启动自动保存/自动同步定时器。
 *
 * 所有失败都收敛到日志：同步不可用不应该阻止 DSH 启动。
 */
import os from 'node:os'
import { SyncStore } from './state.js'
import { SyncEngine } from './engine/engine.js'
import { registerTools } from './tools.js'
import { attachRoutes } from './http-api.js'

/** Loader 里的插件名，必须与 cordis.patch.yml 的 name 一致。 */
export const name = 'dsh-sync'

/** 不强制注入任何服务：工具与 Web 路由都按可用性挂载。 */
export const inject = []

/** 结构化日志前缀。 */
function makeLogger(base) {
  const emit = (level) => (...args) => {
    const message = args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ')
    const target = base?.[level]
    if (typeof target === 'function') {
      try {
        target.call(base, `[dsh-sync] ${message}`)
        return
      } catch {}
    }
    if (level === 'error') console.error(message)
    else if (level === 'warn') console.warn(message)
    else console.log(message)
  }
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    log: emit('info'),
  }
}

/**
 * Cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig bundle patch 里的 config（本插件不依赖它）
 */
export function apply(ctx, rawConfig = {}) {
  const logger = makeLogger(ctx.logger)
  const homeDir = String(rawConfig?.dshHome ?? process.env.DSH_HOME ?? `${os.homedir()}/.dsh`)
  const store = new SyncStore({ homeDir, logger, env: process.env })

  const ready = (async () => {
    try {
      await store.load()
    } catch (error) {
      logger.error(`初始化状态失败：${error?.message ?? error}`)
    }
    return store
  })()

  const engine = new SyncEngine({
    store,
    logger,
    getOrigin: () => {
      try {
        return ctx.get?.('webServer')?.getOrigin?.()
      } catch {
        return undefined
      }
    },
  })

  // 工具注册：等宿主 tools 服务可用。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => registerTools(toolCtx, { engine, ready, logger }))
  } else {
    registerTools(ctx, { engine, ready, logger })
  }

  // HTTP 路由：webServer 只有在 web 组合里才存在。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (httpCtx) => {
      const webServer = httpCtx.get('webServer')
      if (!webServer || typeof webServer.register !== 'function') return
      const effect = typeof httpCtx.effect === 'function' ? httpCtx.effect.bind(httpCtx) : ctx.effect?.bind(ctx)
      const mount = () => attachRoutes(webServer, { engine, store, logger })
      if (typeof effect === 'function') effect(mount, 'dsh-sync: http routes')
      else mount()
    })
  }

  // 自动任务：状态加载完成后启动；插件卸载时清理所有 timer。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      let active = true
      ready.then(() => {
        if (active) engine.startAutomation()
      })
      return () => {
        active = false
        engine.stopAutomation()
      }
    }, 'dsh-sync: automation')
  } else {
    ready.then(() => engine.startAutomation())
  }

  ready.then(async () => {
    logger.info(`已就绪：设备 ${store.config.deviceName}（${store.deviceId.slice(0, 8)}），` +
      `${store.config.targets.filter((target) => target.enabled !== false).length} 个启用同步目标`)
    if (store.warnings.length > 0) logger.warn(`配置警告：${store.warnings.join('；')}`)
    await store.saveState()
  })

  // 不返回插件对象：Cordis 的 apply 返回值不参与装配，返回对象反而可能被误判。
}