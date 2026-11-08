/**
 * dsh-sync 后端工厂（SPEC 第 5 节）。
 *
 * 所有后端都实现同一套 SyncBackend 接口：
 *   init / test / listDevices / readManifest / writeManifest /
 *   hasObject / readObject / writeObject / describe / close
 *
 * 创建对象本身只做轻量校验、不发起网络请求；连通性探测统一放在 init()/test()，
 * 这样设置页可以用同一个对象对“未保存草稿”做连接测试。
 */
import { createLocalBackend } from './local.js'
import { createPeerBackend } from './peer.js'
import { createWebdavBackend } from './webdav.js'

/** 支持的后端类型。 */
export const BACKEND_TYPES = Object.freeze(['local', 'webdav', 'peer'])

/**
 * 按 target.type 创建后端实例。
 * @param {object} target 配置项，至少包含 { id, type }
 * @param {{ fetchImpl?: Function, logger?: any, signal?: AbortSignal }} [options]
 * @returns {Promise<object>} SyncBackend
 */
export async function createBackend(target, options = {}) {
  const rawType = typeof target?.type === 'string' ? target.type.trim().toLowerCase() : ''
  switch (rawType) {
    case 'local':
      return createLocalBackend(target, options)
    case 'webdav':
      return createWebdavBackend(target, options)
    case 'peer':
      return createPeerBackend(target, options)
    default:
      throw new Error(
        `未知的后端类型：${rawType || '(空)'}（支持 ${BACKEND_TYPES.join(' / ')}）`,
      )
  }
}