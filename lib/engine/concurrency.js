/**
 * 有界并发调度：上传/下载的性能核心。
 *
 * 为什么需要它：
 * 同步的对象是独立的内容寻址文件，彼此没有顺序依赖。原来的实现逐文件
 * `await`，在 150ms RTT 的网络上 200 个文件光等待就 90s+。这里把“同时
 * 在飞的任务数”和“同时在飞的内存字节数”都卡住，既提速又不打爆内存。
 *
 * 两个上限：
 * - concurrency：同时进行的任务数（对服务端压力可控）
 * - maxBytes：同时在飞的源数据字节数（4 × 32MiB 上限 ≈ 128MiB 峰值）
 */

/** 默认同时在飞任务数：对 Nextcloud / PHP 后端友好，不至于触发限流。 */
export const DEFAULT_CONCURRENCY = 4
/** 默认同时在飞字节预算：64MiB。 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/** 把任意输入夹到 [min,max] 的整数。 */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * 创建调度器。
 * @param {{concurrency?: number, maxBytes?: number}} [options]
 * @returns {{run: (bytes: number, fn: Function) => Promise<any>, inflight: () => number, drain: () => Promise<void>}}
 */
export function createLimiter(options = {}) {
  const concurrency = clampInt(options.concurrency, 1, 64, DEFAULT_CONCURRENCY)
  const maxBytes = clampInt(options.maxBytes, 1, 1024 * 1024 * 1024, DEFAULT_MAX_BYTES)
  /** @type {Array<{bytes:number,fn:Function,resolve:Function,reject:Function}>} */
  const queue = []
  let active = 0
  let activeBytes = 0
  let settled = 0
  const waiters = new Set()

  function notifyIdle() {
    if (active === 0 && queue.length === 0) {
      for (const resolve of waiters) resolve()
      waiters.clear()
    }
  }

  function pump() {
    while (queue.length > 0) {
      const job = queue[0]
      if (active >= concurrency) break
      // 空载时允许单个超大任务独占通道，否则大文件会永远排不进去。
      const fitsBytes = active === 0 || activeBytes + job.bytes <= maxBytes
      if (!fitsBytes) break
      queue.shift()
      active += 1
      activeBytes += job.bytes
      Promise.resolve()
        .then(() => job.fn())
        .then(
          (value) => {
            job.resolve(value)
          },
          (error) => {
            job.reject(error)
          },
        )
        .finally(() => {
          active -= 1
          activeBytes -= Math.min(job.bytes, activeBytes)
          settled += 1
          pump()
          notifyIdle()
        })
    }
    notifyIdle()
  }

  return {
    /** 排队执行一个任务；bytes 用于内存预算。 */
    run(bytes, fn) {
      const weight = Number.isFinite(Number(bytes)) ? Math.max(0, Math.trunc(Number(bytes))) : 0
      return new Promise((resolve, reject) => {
        queue.push({ bytes: weight, fn, resolve, reject })
        pump()
      })
    },
    /** 当前在飞任务数（指标/自检用）。 */
    inflight() {
      return active
    },
    /** 等待全部排空。 */
    drain() {
      if (active === 0 && queue.length === 0) return Promise.resolve()
      return new Promise((resolve) => waiters.add(resolve))
    },
    get settledCount() {
      return settled
    },
    concurrency,
    maxBytes,
  }
}

/**
 * 用调度器并发处理一批独立条目。
 *
 * worker 内部自己 try/catch（引擎需要在失败时记 stats 并继续），
 * 这里只负责限流与兜底：worker 意外抛出时收集为 failures，不中断整批。
 *
 * @param {Array<any>} items
 * @param {ReturnType<typeof createLimiter>} limiter
 * @param {(item:any, index:number) => Promise<any>} worker
 * @param {(item:any, error:any) => number} [weightOf] 每个条目的内存权重
 * @returns {Promise<{failures: Array<{item:any,error:any}>}>}
 */
export async function runBatched(items, limiter, worker, weightOf = () => 0) {
  const failures = []
  if (!Array.isArray(items) || items.length === 0) return { failures }
  await Promise.all(
    items.map((item, index) =>
      limiter.run(weightOf(item, index), async () => {
        try {
          await worker(item, index)
        } catch (error) {
          failures.push({ item, error })
        }
      }),
    ),
  )
  return { failures }
}