/**
 * dsh-sync 归档引擎（SPEC 第 6 节）。
 *
 * 格式：`gzip(USTAR)`。成员固定为两类：
 *   - `manifest.json`：设备 manifest（UTF-8 JSON，无 BOM，generatedAt 为导出时刻）；
 *   - `objects/<sha256>`：manifest entries 引用的对象，按 hash 去重、升序写入。
 *
 * 设计约束（与 SPEC 对齐）：
 *   - 只实现 USTAR（不使用 GNU 长文件名扩展）。成员路径 ≤ 100 字节时放 name 字段，
 *     超过时按 `/` 切分到 prefix（≤155）+ name（≤100）。
 *   - 头部字段：mode `0000644`、uid/gid `0000000`、size 八进制 11 位 + 空格、
 *     mtime 八进制 11 位 + NUL、chksum 6 位八进制 + NUL + 空格、typeflag `0`、
 *     magic `ustar\0`、version `00`。
 *   - 解析拒绝：重复成员、绝对路径、`..`、`\`、NUL、Windows 盘符、非法对象名、
 *     头部校验和不符、gzip 损坏、超过输入/解压上限、对象 sha256 与内容不符。
 *   - 非 `manifest.json` / `objects/<sha256>` 的成员被忽略但计数（返回值 `ignored`）。
 *   - 纯函数：只依赖 Node 内置模块 + `lib/util.js`，不依赖 Host 上下文。
 *
 * 可测试性：`parseArchive(bytes, { maxInputBytes, maxTotalBytes, maxBytes })`
 * 允许调小上限做单测；默认值均为 512 MiB（SPEC 要求）。
 */

import { createGzip, gunzipSync, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { isSafeRelPath, sha256Hex } from '../util.js'

/** USTAR 块大小（字节）。 */
const BLOCK_SIZE = 512
/** 主清单成员名。 */
const MANIFEST_MEMBER = 'manifest.json'
/** 对象成员名前缀。 */
const OBJECT_PREFIX = 'objects/'
/** sha256 hex 严格格式。 */
const HASH_RE = /^[a-f0-9]{64}$/
/** name 字段容量。 */
const NAME_FIELD_SIZE = 100
/** prefix 字段容量。 */
const PREFIX_FIELD_SIZE = 155
/** SPEC 默认输入上限：512 MiB。 */
const DEFAULT_MAX_INPUT_BYTES = 512 * 1024 * 1024
/** SPEC 默认成员总解压上限：512 MiB。 */
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
/**
 * gunzip 时在“成员总解压上限”之外额外允许的头部/填充余量。
 * 512 字节一个成员头，16 MiB 足够容纳约 3 万个成员；超出即按超限报错。
 */
const GZIP_OVERHEAD_ALLOWANCE = 16 * 1024 * 1024

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把 Buffer / Uint8Array / ArrayBuffer / TypedArray 统一成 Uint8Array 视图。
 * 不做拷贝（调用方自己决定是否要脱离底层缓冲）。
 */
function toBytes(value, label) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  throw new TypeError(`${label} 必须是 Uint8Array / ArrayBuffer，实际为 ${typeof value}`)
}

/** 协作式取消：每个耗时步骤前检查一次。 */
function throwIfAborted(signal) {
  if (!signal || typeof signal.aborted !== 'boolean' || !signal.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error(typeof reason === 'string' && reason.length > 0 ? reason : '归档操作已取消')
  error.name = 'AbortError'
  throw error
}

/** 解析上限参数：显式值 > 共享值 > 默认值；必须是正安全整数。 */
function resolveLimit(specific, shared, fallback, label) {
  const raw = specific ?? shared ?? fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`归档上限参数非法（${label}）: ${String(raw)}`)
  }
  return value
}

/** 读取 USTAR 数字字段（八进制，容忍首尾 NUL/空格）。 */
function readOctalField(block, offset, length, label) {
  const raw = block.toString('latin1', offset, offset + length)
  const text = raw.replace(/^[\u0000 ]+/, '').replace(/[\u0000 ]+$/, '')
  if (text.length === 0) return 0
  if (!/^[0-7]+$/.test(text)) throw new Error(`归档头部 ${label} 字段非法: ${JSON.stringify(raw)}`)
  return Number.parseInt(text, 8)
}

/** 读取以 NUL 结尾的字符串字段。 */
function readCString(block, offset, length) {
  const limit = offset + length
  let end = offset
  while (end < limit && block[end] !== 0) end += 1
  return block.toString('utf8', offset, end)
}

/** 判断一个 512 字节块是否全零（归档结束标记）。 */
function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false
  }
  return true
}

/** 剥离 USTAR 成员路径的 `./` 前缀（可能重复出现）。 */
function stripDotSlashPrefix(memberPath) {
  let out = memberPath
  while (out.startsWith('./')) out = out.slice(2)
  return out
}

/** 校验 USTAR 头部校验和；不符直接抛错。 */
function verifyHeaderChecksum(block) {
  const stored = readOctalField(block, 148, 8, 'chksum')
  let sum = 0
  for (let i = 0; i < BLOCK_SIZE; i += 1) {
    // 计算时 chksum 字段本身按 8 个空格计入。
    sum += i >= 148 && i < 156 ? 0x20 : block[i]
  }
  if (sum !== stored) {
    throw new Error(`归档头部校验和不符: 记录 ${stored}，实际 ${sum}`)
  }
}

/* ------------------------------------------------------------------ */
/* 清单校验（build 与 parse 共用）                                     */
/* ------------------------------------------------------------------ */

/** 校验 key / root / path 三者自洽且路径安全。 */
function assertKeyTriplet(item, label) {
  if (typeof item.key !== 'string' || !isSafeRelPath(item.key)) {
    throw new Error(`${label}.key 不安全: ${JSON.stringify(item.key)}`)
  }
  if (
    typeof item.root !== 'string' ||
    item.root.length === 0 ||
    item.root.includes('/') ||
    !isSafeRelPath(item.root)
  ) {
    throw new Error(`${label}.root 非法: ${JSON.stringify(item.root)}`)
  }
  if (typeof item.path !== 'string' || !isSafeRelPath(item.path)) {
    throw new Error(`${label}.path 不安全: ${JSON.stringify(item.path)}`)
  }
  if (item.key !== `${item.root}/${item.path}`) {
    throw new Error(`${label}.key 与 root/path 不自洽: ${JSON.stringify(item.key)} !== ${JSON.stringify(`${item.root}/${item.path}`)}`)
  }
}

/** 校验 sha256 字段。 */
function assertHash(hash, label) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
    throw new Error(`${label} 非法（必须是 64 位小写 hex）: ${JSON.stringify(hash)}`)
  }
}

/** 校验 manifest 结构；失败抛 Error（调用方负责包装上下文）。 */
function validateManifest(manifest, where) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${where}: 清单必须是普通对象`)
  }
  if (manifest.format !== 'dsh-sync-manifest') {
    throw new Error(`${where}: 清单 format 非法: ${JSON.stringify(manifest.format)}`)
  }
  if (manifest.version !== 1) {
    throw new Error(`${where}: 清单 version 非法: ${JSON.stringify(manifest.version)}`)
  }
  if (typeof manifest.deviceId !== 'string' || manifest.deviceId.length === 0 || manifest.deviceId.length > 200) {
    throw new Error(`${where}: 清单 deviceId 非法: ${JSON.stringify(manifest.deviceId)}`)
  }
  if (manifest.deviceName !== undefined && typeof manifest.deviceName !== 'string') {
    throw new Error(`${where}: 清单 deviceName 非法`)
  }
  if (manifest.generatedAt !== undefined && !Number.isFinite(manifest.generatedAt)) {
    throw new Error(`${where}: 清单 generatedAt 非法`)
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error(`${where}: 清单 entries 必须是数组`)
  }
  if (manifest.tombstones !== undefined && !Array.isArray(manifest.tombstones)) {
    throw new Error(`${where}: 清单 tombstones 必须是数组`)
  }

  const entryKeys = new Set()
  manifest.entries.forEach((entry, index) => {
    const label = `${where}: entries[${index}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} 不是对象`)
    }
    assertKeyTriplet(entry, label)
    assertHash(entry.hash, `${label}.hash`)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`${label}.size 非法: ${JSON.stringify(entry.size)}`)
    }
    if (entry.mtimeMs !== undefined && !Number.isFinite(entry.mtimeMs)) {
      throw new Error(`${label}.mtimeMs 非法`)
    }
    if (entry.updatedAt !== undefined && !Number.isFinite(entry.updatedAt)) {
      throw new Error(`${label}.updatedAt 非法`)
    }
    if (entry.deviceId !== undefined && (typeof entry.deviceId !== 'string' || entry.deviceId.length === 0)) {
      throw new Error(`${label}.deviceId 非法`)
    }
    if (entryKeys.has(entry.key)) {
      throw new Error(`${where}: entries 中 key 重复: ${entry.key}`)
    }
    entryKeys.add(entry.key)
  })

  const tombstones = manifest.tombstones ?? []
  const tombstoneKeys = new Set()
  tombstones.forEach((item, index) => {
    const label = `${where}: tombstones[${index}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label} 不是对象`)
    }
    assertKeyTriplet(item, label)
    if (item.deleted !== true) {
      throw new Error(`${label}.deleted 必须为 true`)
    }
    if (item.updatedAt !== undefined && !Number.isFinite(item.updatedAt)) {
      throw new Error(`${label}.updatedAt 非法`)
    }
    if (item.deviceId !== undefined && (typeof item.deviceId !== 'string' || item.deviceId.length === 0)) {
      throw new Error(`${label}.deviceId 非法`)
    }
    if (tombstoneKeys.has(item.key)) {
      throw new Error(`${where}: tombstones 中 key 重复: ${item.key}`)
    }
    tombstoneKeys.add(item.key)
    if (entryKeys.has(item.key)) {
      throw new Error(`${where}: key 同时出现在 entries 与 tombstones: ${item.key}`)
    }
  })
}

/* ------------------------------------------------------------------ */
/* USTAR 写入                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把成员路径切分到 USTAR 的 name（100）/ prefix（155）字段。
 *
 * 返回 `{ name, prefix }`；无法表示时抛错。导出仅为可测试性：
 * 生产代码只通过 buildArchive 调用它，SPEC 要求的两个主接口不受影响。
 *
 * @param {string} memberPath 相对路径（POSIX 语义）
 * @returns {{ name: string, prefix: string }}
 */
export function __splitUstarPath(memberPath) {
  if (typeof memberPath !== 'string' || memberPath.length === 0) {
    throw new Error('USTAR 成员路径为空')
  }
  if (memberPath.startsWith('/') || memberPath.includes('\\') || memberPath.includes('\u0000')) {
    throw new Error(`USTAR 成员路径必须是不含反斜杠/NUL 的相对路径: ${JSON.stringify(memberPath)}`)
  }
  // USTAR 名称字段是原始字节，非 ASCII 会在 Buffer.write('ascii') 时被截断，直接拒绝。
  if (!/^[\x20-\x7e]+$/.test(memberPath)) {
    throw new Error(`USTAR 成员路径必须是可打印 ASCII: ${JSON.stringify(memberPath)}`)
  }
  if (memberPath.length <= NAME_FIELD_SIZE) {
    return { name: memberPath, prefix: '' }
  }
  // 从右往左找 `/`：越靠右 name 越短、prefix 越长；需要同时满足两段容量。
  for (let index = memberPath.length - 1; index > 0; index -= 1) {
    if (memberPath[index] !== '/') continue
    const prefix = memberPath.slice(0, index)
    const name = memberPath.slice(index + 1)
    if (name.length === 0) continue
    if (name.length <= NAME_FIELD_SIZE && prefix.length <= PREFIX_FIELD_SIZE) {
      return { name, prefix }
    }
  }
  throw new Error(`USTAR 成员路径过长，无法切分: ${memberPath.length} 字节`)
}

/** 写一个八进制数字字段（digits 个 0 + 指定终止符）。 */
function writeOctalField(block, offset, length, value, terminator) {
  const digits = length - 1
  const text = Math.floor(value).toString(8).padStart(digits, '0')
  if (text.length > digits) throw new Error(`USTAR 数字字段溢出（offset=${offset}, value=${value}）`)
  block.write(text, offset, digits, 'ascii')
  block[offset + digits] = terminator
}

/** 构造一个 512 字节 USTAR 头部。 */
function buildHeader({ name, prefix, size, mtimeSec }) {
  if (typeof name !== 'string' || name.length === 0 || name.length > NAME_FIELD_SIZE) {
    throw new Error(`USTAR name 字段非法: ${JSON.stringify(name)}`)
  }
  if (prefix !== undefined && prefix !== '' && (prefix.length > PREFIX_FIELD_SIZE)) {
    throw new Error(`USTAR prefix 字段非法: ${JSON.stringify(prefix)}`)
  }
  const block = Buffer.alloc(BLOCK_SIZE, 0)
  block.write(name, 0, NAME_FIELD_SIZE, 'ascii')
  block.write('0000644', 100, 7, 'ascii') // mode
  block[107] = 0
  block.write('0000000', 108, 7, 'ascii') // uid
  block[115] = 0
  block.write('0000000', 116, 7, 'ascii') // gid
  block[123] = 0
  writeOctalField(block, 124, 12, size, 0x20) // size: 11 位八进制 + 空格
  writeOctalField(block, 136, 12, mtimeSec, 0) // mtime: 11 位八进制 + NUL
  block.write('        ', 148, 8, 'ascii') // chksum 先占位为 8 个空格
  block.write('0', 156, 1, 'ascii') // typeflag 普通文件
  block.write('ustar', 257, 5, 'ascii') // magic
  block[262] = 0
  block.write('00', 263, 2, 'ascii') // version
  if (prefix) block.write(prefix, 345, PREFIX_FIELD_SIZE, 'ascii')
  // 校验和：把 chksum 字段按空格参与求和。
  let sum = 0
  for (let i = 0; i < BLOCK_SIZE; i += 1) sum += block[i]
  const text = sum.toString(8).padStart(6, '0')
  block.write(text, 148, 6, 'ascii')
  block[154] = 0
  block[155] = 0x20
  return block
}

/* ------------------------------------------------------------------ */
/* 导出：buildArchive                                                  */
/* ------------------------------------------------------------------ */

/**
 * 生成 `.dshsync` 归档字节。
 *
 * @param {object} input
 * @param {object} input.manifest 设备 manifest（SPEC 3.2）；生成的归档会覆盖 generatedAt。
 * @param {(hash: string) => Uint8Array | Promise<Uint8Array>} input.readObject
 *        按 hash 读取对象内容；缺失返回 null 会抛错。
 * @param {AbortSignal} [input.signal] 协作式取消。
 * @returns {Promise<{ bytes: Uint8Array, sha256: string, size: number }>}
 */
export async function buildArchive({ manifest, readObject, signal } = {}) {
  throwIfAborted(signal)
  if (typeof readObject !== 'function') {
    throw new TypeError('buildArchive 需要 readObject(hash) 函数')
  }
  validateManifest(manifest, 'buildArchive')

  const entries = manifest.entries ?? []
  // 同一 hash 被多个 key 引用时 size 必须一致，否则归档自相矛盾。
  const sizeByHash = new Map()
  for (const entry of entries) {
    const prev = sizeByHash.get(entry.hash)
    if (prev !== undefined && prev !== entry.size) {
      throw new Error(`清单中同一 hash 的 size 不一致: ${entry.hash}（${prev} vs ${entry.size}）`)
    }
    sizeByHash.set(entry.hash, entry.size)
  }

  // 按 hash 升序读取，保证同一清单生成稳定的成员顺序。
  const hashes = [...sizeByHash.keys()].sort()
  const objects = new Map()
  for (const hash of hashes) {
    throwIfAborted(signal)
    const raw = await readObject(hash)
    if (raw === null || raw === undefined) {
      throw new Error(`读取对象失败（对象不存在）: ${hash}`)
    }
    const bytes = toBytes(raw, `对象 ${hash}`)
    const actual = sha256Hex(bytes)
    if (actual !== hash) {
      throw new Error(`对象内容 sha256 不匹配: 期望 ${hash}，实际 ${actual}`)
    }
    if (bytes.length !== sizeByHash.get(hash)) {
      throw new Error(`对象大小与清单不一致: ${hash} 清单 ${sizeByHash.get(hash)}，实际 ${bytes.length}`)
    }
    // 拷贝一份，避免调用方后续复用/改写底层缓冲影响归档。
    objects.set(hash, Buffer.from(bytes))
  }

  const generatedAt = Date.now()
  // generatedAt 固定为导出时刻；其余字段原样写入。
  const snapshot = { ...manifest, generatedAt }
  const mtimeSec = Math.max(0, Math.floor(generatedAt / 1000))

  const parts = []
  /** 追加一个 USTAR 成员（头部 + 数据 + 512 对齐填充）。 */
  const pushMember = (memberPath, data) => {
    const { name, prefix } = __splitUstarPath(memberPath)
    parts.push(buildHeader({ name, prefix, size: data.length, mtimeSec }))
    parts.push(data)
    const padding = (BLOCK_SIZE - (data.length % BLOCK_SIZE)) % BLOCK_SIZE
    if (padding > 0) parts.push(Buffer.alloc(padding, 0))
  }

  pushMember(MANIFEST_MEMBER, Buffer.from(JSON.stringify(snapshot), 'utf8'))
  for (const hash of hashes) {
    throwIfAborted(signal)
    pushMember(`${OBJECT_PREFIX}${hash}`, objects.get(hash))
  }
  // USTAR 结束标记：两个全零块。
  parts.push(Buffer.alloc(BLOCK_SIZE * 2, 0))

  const tarBytes = Buffer.concat(parts)
  const bytes = gzipSync(tarBytes, { level: 9 })
  return { bytes, sha256: sha256Hex(bytes), size: bytes.length }
}

/* ------------------------------------------------------------------ */
/* 导出：buildArchiveStream（流式，内存只留一个对象）                   */
/* ------------------------------------------------------------------ */

/**
 * 流式生成归档：边读对象、边压、边写盘，不把整个 tar 攒在内存里。
 *
 * `buildArchive` 会把所有对象拷贝进 Map，再做 Buffer.concat + gzipSync：
 * 完整应用数据（会话 + 存储 + 附件）动辄上百 MiB，这条路会吃掉 2–3 倍内存。
 * 这里改成惰性读对象 + gzip 流 + 增量 sha256，峰值只跟单个对象有关。
 *
 * @param {object} input
 * @param {object} input.manifest 设备 manifest
 * @param {(hash: string) => Uint8Array | Promise<Uint8Array>} input.readObject 按 hash 惰性读取
 * @param {(chunk: Buffer) => Promise<void> | void} input.write 结果字节的落盘回调（按顺序、需支持背压）
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{ size: number, sha256: string, members: number }>}
 */
export async function buildArchiveStream({ manifest, readObject, write, extraMembers = [], signal } = {}) {
  throwIfAborted(signal)
  if (typeof readObject !== 'function') throw new TypeError('buildArchiveStream 需要 readObject(hash) 函数')
  if (typeof write !== 'function') throw new TypeError('buildArchiveStream 需要 write(chunk) 回调')
  validateManifest(manifest, 'buildArchiveStream')

  const extraSeen = new Set([MANIFEST_MEMBER])
  const extras = []
  for (const member of extraMembers) {
    const memberPath = String(member?.path ?? '')
    if (memberPath === '' || extraSeen.has(memberPath)) throw new Error(`附加成员路径重复或为空: ${memberPath}`)
    if (memberPath.startsWith(OBJECT_PREFIX)) throw new Error(`附加成员不能占用 objects/ 前缀: ${memberPath}`)
    extraSeen.add(memberPath)
    extras.push({ path: memberPath, bytes: toBytes(member.bytes, `附加成员 ${memberPath}`) })
  }

  const generatedAt = Date.now()
  const mtimeSec = Math.max(0, Math.floor(generatedAt / 1000))
  // 还活着的会话日志会在扫描与打包之间继续追加：这里的 hash/size 以**实际读到的字节**为准，
  // 清单放到最后写。成员顺序不影响解析（parseArchive 收完所有成员后才校验引用）。
  const corrected = new Map()
  const packed = new Map() // hash → 已写的对象（同样内容只写一次）

  async function* tarChunks() {
    const member = function* (memberPath, bytes) {
      const { name, prefix } = __splitUstarPath(memberPath)
      yield buildHeader({ name, prefix, size: bytes.length, mtimeSec })
      yield bytes
      const padding = (BLOCK_SIZE - (bytes.length % BLOCK_SIZE)) % BLOCK_SIZE
      if (padding > 0) yield Buffer.alloc(padding, 0)
    }

    for (const entry of manifest.entries ?? []) {
      throwIfAborted(signal)
      const bytes = await readObject(entry.hash, entry)
      if (bytes === null || bytes === undefined) {
        throw new Error(`读取对象失败（文件已不存在）: ${entry.key}`)
      }
      const data = toBytes(bytes, `对象 ${entry.key}`)
      const hash = sha256Hex(data)
      if (!packed.has(hash)) {
        yield* member(`${OBJECT_PREFIX}${hash}`, data)
        packed.set(hash, data.length)
      }
      corrected.set(entry.key, { hash, size: data.length, changed: hash !== entry.hash })
    }

    for (const extra of extras) {
      throwIfAborted(signal)
      yield* member(extra.path, extra.bytes)
    }

    const entries = (manifest.entries ?? []).map((entry) => {
      const actual = corrected.get(entry.key)
      return actual ? { ...entry, hash: actual.hash, size: actual.size } : entry
    })
    const snapshot = { ...manifest, entries, generatedAt }
    yield* member(MANIFEST_MEMBER, Buffer.from(JSON.stringify(snapshot), 'utf8'))
    yield Buffer.alloc(BLOCK_SIZE * 2, 0) // USTAR 结束标记
  }

  const digest = createHash('sha256')
  let size = 0
  const sink = new Writable({
    // 写盘回调可能是异步的（FileHandle.write），用回调式 write 才能正确施加背压。
    write(chunk, _encoding, callback) {
      digest.update(chunk)
      size += chunk.length
      Promise.resolve()
        .then(() => write(chunk))
        .then(() => callback(), (error) => callback(error))
    },
  })

  // 生成器 + pipeline：背压交给流框架。
  // 早期用 `once(gzip,'drain')` 手工等背压，gzip 在 end() 后不再触发 drain，
  // 被 end-of-stream 判成 premature close 抛未捕获异常，会把宿主进程一起带走。
  await pipeline(Readable.from(tarChunks(), { objectMode: false }), createGzip({ level: 9 }), sink)

  const changed = [...corrected.entries()].filter(([, info]) => info.changed).map(([key]) => key)
  return { size, sha256: digest.digest('hex'), members: packed.size + extras.length + 1, objects: packed.size, changed, corrected }
}

/* ------------------------------------------------------------------ */
/* 导出：parseArchive                                                  */
/* ------------------------------------------------------------------ */

/**
 * 解析 `.dshsync` 归档字节。
 *
 * @param {Uint8Array | ArrayBuffer} bytes gzip 归档字节。
 * @param {object} [options]
 * @param {number} [options.maxInputBytes] gzip 输入上限（默认 512 MiB）。
 * @param {number} [options.maxTotalBytes] 成员总解压上限（默认 512 MiB）。
 * @param {number} [options.maxBytes]     便捷参数：同时设置上面两个上限（显式项优先）。
 * @returns {Promise<{ manifest: object, objects: Map<string, Uint8Array>, ignored: number }>}
 */
export async function parseArchive(bytes, options = {}) {
  const input = toBytes(bytes, '归档输入')
  const maxInputBytes = resolveLimit(options.maxInputBytes, options.maxBytes, DEFAULT_MAX_INPUT_BYTES, 'maxInputBytes')
  const maxTotalBytes = resolveLimit(options.maxTotalBytes, options.maxBytes, DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes')

  if (input.length > maxInputBytes) {
    throw new Error(`归档输入超过上限: ${input.length} > ${maxInputBytes}`)
  }

  let tarBytes
  try {
    tarBytes = gunzipSync(input, { maxOutputLength: maxTotalBytes + GZIP_OVERHEAD_ALLOWANCE })
  } catch (error) {
    const message = error?.message ?? String(error)
    if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /Cannot create a Buffer larger|maxOutputLength/i.test(message)) {
      throw new Error(`归档解压超过上限: ${maxTotalBytes} 字节（另允许 ${GZIP_OVERHEAD_ALLOWANCE} 字节头部/填充）`)
    }
    throw new Error(`归档 gzip 解压失败（文件损坏或不是 .dshsync）: ${message}`)
  }

  if (tarBytes.length % BLOCK_SIZE !== 0) {
    throw new Error(`归档长度非法（不是 512 的整数倍）: ${tarBytes.length}`)
  }

  const seenPaths = new Set()
  const objects = new Map()
  let manifestBytes = null
  let ignored = 0
  let totalDataBytes = 0
  let offset = 0

  while (offset < tarBytes.length) {
    if (tarBytes.length - offset < BLOCK_SIZE) {
      throw new Error('归档被截断：剩余数据不足一个 512 字节头部')
    }
    const block = tarBytes.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(block)) break // 结束标记
    verifyHeaderChecksum(block)

    if (block[257] !== 0x75 || block[258] !== 0x73 || block[259] !== 0x74 || block[260] !== 0x61 || block[261] !== 0x72) {
      throw new Error('归档头部 magic 非 USTAR（只支持 USTAR 格式）')
    }

    const rawName = readCString(block, 0, NAME_FIELD_SIZE)
    const rawPrefix = readCString(block, 345, PREFIX_FIELD_SIZE)
    // typeflag：0x00 是旧式普通文件，'0' 是 POSIX 普通文件。
    const typeflagByte = block[156]
    const typeflag = typeflagByte === 0 ? '0' : String.fromCharCode(typeflagByte)

    const size = readOctalField(block, 124, 12, 'size')
    if (!Number.isSafeInteger(size)) {
      throw new Error(`归档头部 size 字段超出安全整数范围: ${size}`)
    }
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    const dataStart = offset + BLOCK_SIZE
    // 先按“声明大小”累计解压上限：伪造巨型 size 头时立刻拒绝，而不是先落到截断错误。
    totalDataBytes += size
    if (totalDataBytes > maxTotalBytes) {
      throw new Error(`归档解压内容超过上限: ${totalDataBytes} > ${maxTotalBytes}`)
    }
    if (dataStart + paddedSize > tarBytes.length) {
      throw new Error(`归档被截断：成员声明 ${size} 字节，实际不足`)
    }

    let memberPath = rawPrefix ? `${rawPrefix}/${rawName}` : rawName
    memberPath = stripDotSlashPrefix(memberPath)
    const isDirectory = typeflag === '5' || memberPath.endsWith('/')
    if (isDirectory) memberPath = memberPath.replace(/\/+$/, '')

    if (memberPath.length > 0) {
      // 任何成员（包括将被忽略的成员）都必须路径安全。
      if (!isSafeRelPath(memberPath)) {
        throw new Error(`归档成员路径不安全（绝对路径 / .. / 反斜杠 / NUL）: ${JSON.stringify(memberPath)}`)
      }
      if (seenPaths.has(memberPath)) {
        throw new Error(`归档存在重复成员: ${memberPath}`)
      }
      seenPaths.add(memberPath)
    }

    const data = tarBytes.subarray(dataStart, dataStart + size)

    if (!isDirectory && typeflag === '0' && memberPath.length > 0) {
      if (memberPath === MANIFEST_MEMBER) {
        manifestBytes = data
      } else if (memberPath.startsWith(OBJECT_PREFIX)) {
        const objectHash = memberPath.slice(OBJECT_PREFIX.length)
        if (!HASH_RE.test(objectHash)) {
          throw new Error(`归档对象名非法（必须是 64 位小写 hex）: ${memberPath}`)
        }
        const actual = sha256Hex(data)
        if (actual !== objectHash) {
          throw new Error(`归档对象 sha256 与内容不匹配: ${memberPath}（实际 ${actual}）`)
        }
        if (objects.has(objectHash)) {
          throw new Error(`归档存在重复对象: ${objectHash}`)
        }
        objects.set(objectHash, new Uint8Array(data))
      } else {
        ignored += 1
      }
    } else {
      // 目录、符号链接、硬链接、未知成员：跳过但计数。
      ignored += 1
    }

    offset = dataStart + paddedSize
  }

  if (manifestBytes === null) {
    throw new Error('归档缺少 manifest.json')
  }

  let manifest
  try {
    let text = manifestBytes.toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 容忍误写入的 BOM
    manifest = JSON.parse(text)
  } catch (error) {
    throw new Error(`归档 manifest.json 不是合法 JSON: ${error?.message ?? String(error)}`)
  }

  validateManifest(manifest, 'parseArchive')

  // 清单引用的对象必须齐全，且长度与 size 一致；否则归档不可导入。
  for (const entry of manifest.entries) {
    const data = objects.get(entry.hash)
    if (!data) {
      throw new Error(`归档缺少清单引用的对象: ${entry.hash}（key=${entry.key}）`)
    }
    if (data.length !== entry.size) {
      throw new Error(`对象大小与清单不一致: ${entry.hash} 清单 ${entry.size}，实际 ${data.length}`)
    }
  }

  return { manifest, objects, ignored }
}