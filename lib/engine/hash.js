/**
 * 文件内容哈希：sha256(hex)。同步的对象名就是它。
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'

/**
 * 计算文件 sha256。
 * @param {string} file 绝对路径
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
export async function sha256File(file, signal) {
  const handle = await fsp.open(file, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      if (signal?.aborted) throw new Error('aborted')
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/**
 * 计算字节 sha256。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}