/**
 * 一键配对码：把「连接另一台设备所需的最小信息」编码成一行可复制的文本。
 *
 * 格式：`DSHSYNC1.<base64url(JSON)>`
 * - peer：url + token
 * - webdav：url + username + password + basePath
 *
 * 配对码包含凭据，等同于密码：只发给可信设备，不写入日志。
 */
import os from 'node:os'

export const PAIR_PREFIX = 'DSHSYNC1.'
const MAX_CODE_BYTES = 16 * 1024
const MAX_URL_LENGTH = 2048
const MAX_TOKEN_LENGTH = 512
const MAX_LABEL_LENGTH = 120
const MAX_BASE_PATH_LENGTH = 512

/** 生成配对码。 */
export function encodePairing(payload) {
  const json = JSON.stringify(payload)
  if (Buffer.byteLength(json, 'utf8') > MAX_CODE_BYTES) throw new Error('配对信息过大')
  return PAIR_PREFIX + Buffer.from(json, 'utf8').toString('base64url')
}

/**
 * 解析并校验配对码。
 * @param {string} code
 * @returns {{v:1,type:'peer'|'webdav',label:string,url:string,token?:string,username?:string,password?:string,basePath?:string,deviceName?:string}}
 */
export function decodePairing(code) {
  const text = String(code ?? '').trim()
  if (!text.startsWith(PAIR_PREFIX)) throw new Error('不是 dsh-sync 配对码')
  const raw = text.slice(PAIR_PREFIX.length)
  if (raw.length === 0) throw new Error('配对码为空')
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new Error('配对码内容损坏')
  }
  if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) throw new Error('配对码版本不支持')
  const type = parsed.type
  if (type !== 'peer' && type !== 'webdav') throw new Error('配对码类型不支持')
  const url = String(parsed.url ?? '').trim().slice(0, MAX_URL_LENGTH)
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('配对码里的地址无效')
  const label = normalizeLabel(parsed.label, type === 'peer' ? 'Peer' : 'WebDAV')
  if (type === 'peer') {
    const token = String(parsed.token ?? '').trim()
    if (token.length < 8 || token.length > MAX_TOKEN_LENGTH) throw new Error('配对码里的 Token 无效')
    return { v: 1, type, url, token, label, deviceName: normalizeDeviceName(parsed.deviceName) }
  }
  const username = String(parsed.username ?? '')
  if (username.length > 256) throw new Error('配对码里的用户名过长')
  const password = String(parsed.password ?? '')
  if (password.length > MAX_TOKEN_LENGTH) throw new Error('配对码里的密码过长')
  const basePath = String(parsed.basePath ?? '/dsh-sync').trim().slice(0, MAX_BASE_PATH_LENGTH)
  if (basePath !== '' && !basePath.startsWith('/')) throw new Error('配对码里的子路径必须以 / 开头')
  return { v: 1, type, url, username, password, basePath: basePath || '/dsh-sync', label, deviceName: normalizeDeviceName(parsed.deviceName) }
}

/** 供 UI 展示的简短摘要（不含凭据）。 */
export function pairingSummary(payload) {
  if (payload.type === 'peer') {
    return { type: 'peer', label: payload.label, url: payload.url, deviceName: payload.deviceName ?? '' }
  }
  return { type: 'webdav', label: payload.label, url: payload.url, username: payload.username, basePath: payload.basePath }
}

function normalizeLabel(value, fallback) {
  const label = String(value ?? '').trim().slice(0, MAX_LABEL_LENGTH)
  return label || fallback
}
function normalizeDeviceName(value) {
  return String(value ?? '').trim().slice(0, MAX_LABEL_LENGTH)
}

/** 是否是回环/通配地址。 */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === ''
}

/** 选一个可用于局域网访问的 IPv4 地址；没有则返回空串。 */
export function lanAddress() {
  const interfaces = os.networkInterfaces()
  const candidates = []
  for (const [name, list] of Object.entries(interfaces)) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (!item.address || item.address.startsWith('169.254.')) continue
      const score = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address) ? 2 : 1
      candidates.push({ name, address: item.address, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]?.address ?? ''
}

/** 把 origin 归一化成 peer 协议根（不重复拼接 /dsh-sync/v1）。 */
export function peerProtocolRoot(origin) {
  const base = String(origin ?? '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) throw new Error('origin 无效')
  if (/\/dsh-sync\/v1$/i.test(base)) return base
  return `${base}/dsh-sync/v1`
}

/**
 * 本机作为 peer 的配对码：自动把回环地址替换成局域网 IP，并返回提示。
 * @param {{origin:string, token:string, deviceName:string}} input
 */
export function selfPeerPairing({ origin, token, deviceName }) {
  const parsed = new URL(String(origin))
  const loopback = isLoopbackHost(parsed.hostname)
  let warning = ''
  if (loopback) {
    const lan = lanAddress()
    if (lan) {
      parsed.hostname = lan
      warning = `当前 DSH 监听 ${parsed.protocol === 'https:' ? 'HTTPS' : 'HTTP'} 回环地址，已把配对码地址换成局域网 IP ${lan}；若仍连不上，请用 --host 0.0.0.0 启动 dsh web。`
    } else {
      warning = '当前 DSH 只监听回环地址且未找到局域网 IP；其他设备无法直连，请用 --host 0.0.0.0 启动 dsh web，或改用 WebDAV 配对码。'
    }
  }
  return {
    payload: {
      v: 1,
      type: 'peer',
      url: peerProtocolRoot(parsed.toString()),
      token: String(token ?? ''),
      label: normalizeLabel(deviceName, 'Peer'),
      deviceName: normalizeDeviceName(deviceName),
    },
    warning,
  }
}