#!/usr/bin/env node
/**
 * bench/upload-bench.mjs — WebDAV 上传速度基准（真实 SyncEngine + 本地 mock）。
 *
 * 做什么：
 *   1. 在临时目录造 N 个文件（随机内容的小文件 + 可选大文件 + 可选高压缩率文本）；
 *   2. 起 mock WebDAV（可注入每请求延迟 / 读写限速），用真实 SyncStore + SyncEngine
 *      配置一个 webdav target，先 test() 再 sync({ mode, trigger:'manual' })；
 *   3. 打印文件数、总字节、耗时、MB/s、mock 侧请求计数与并发峰值、pushed/errors。
 *
 * 用法：
 *   node bench/upload-bench.mjs --files 200 --size 4096 --latency 150
 *   node bench/upload-bench.mjs --files 20 --size 4096 --big 3 --big-size 10485760 --latency 50
 *   node bench/upload-bench.mjs --text 60 --text-size 204800 --latency 100
 *
 * 参数：
 *   --files <n>        小文件数（默认 200）
 *   --size <bytes>     小文件大小（默认 4096）
 *   --big <n>          大文件数（默认 0）
 *   --big-size <bytes> 大文件大小（默认 10485760）
 *   --text <n>         高压缩率 JSON 文本文件数（默认 0）
 *   --text-size <bytes> 文本文件大小（默认 204800）
 *   --latency <ms>     mock 每请求注入延迟（默认 0）
 *   --mode <m>         push / auto / pull（默认 push）
 *   --read-bps <n>     mock GET 限速（默认 0=不限）
 *   --write-bps <n>    mock PUT 限速（默认 0=不限）
 *   --port <n>         mock 端口（默认 0=系统分配）
 *   --max-file-bytes   覆盖 maxFileBytes（默认至少 32MiB 且覆盖大文件）
 *   --label <text>     结果标签，写进输出便于对比
 *   --keep             保留临时目录（排障用）
 *   --json             只输出一行 JSON
 *
 * 退出码：0=成功；1=同步失败 / errors>0 / pushed 数不符；2=参数错误。
 */

import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'

import { SyncStore } from '../lib/state.js'
import { SyncEngine } from '../lib/engine/engine.js'
import { startMockWebdav } from './mock-webdav.mjs'

const MB = 1024 * 1024

/** 解析非负数值，非法时以退出码 2 结束。 */
function num(name, raw, { integer = true, min = 0 } = {}) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    console.error(`参数 --${name} 非法：${raw}（需要 ${integer ? '整数' : '数字'} ≥ ${min}）`)
    process.exit(2)
  }
  return value
}

/** 确定性伪随机字节，保证同一参数下内容可复现（避免对象去重影响计数）。 */
function makeBytes(size, seed) {
  const buf = Buffer.allocUnsafe(size)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let state = (seed >>> 0) || 1
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state
  }
  let offset = 0
  for (; offset + 4 <= size; offset += 4) view.setUint32(offset, next(), true)
  for (; offset < size; offset += 1) buf[offset] = next() >>> 24
  return buf
}

/** 高压缩率 JSON 文本：重复短语填充到精确字节数（ASCII，bytes == chars）。 */
function makeText(size, seed) {
  const prefix = `{"kind":"dsh-sync-bench-text","seed":${seed},"notes":"`
  const suffix = '"}'
  const filler = 'the quick brown fox jumps over the lazy dog '
  const capacity = size - prefix.length - suffix.length
  if (capacity < filler.length) {
    throw new Error(`--text-size 太小（至少 ${prefix.length + suffix.length + filler.length}）`)
  }
  const repeated = filler.repeat(Math.ceil(capacity / filler.length)).slice(0, capacity)
  return Buffer.from(`${prefix}${repeated}${suffix}`, 'utf8')
}

/** 造 fixture，返回 [{rel, size, buffer}]；文件真实落盘到 rootDir。 */
async function createFixture(rootDir, plan) {
  const files = []
  const add = async (rel, buffer) => {
    const abs = path.join(rootDir, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, buffer)
    files.push({ rel, size: buffer.length, buffer })
  }
  for (let i = 0; i < plan.files; i += 1) {
    await add(`small/f-${String(i).padStart(5, '0')}.bin`, makeBytes(plan.size, i + 1))
  }
  for (let i = 0; i < plan.big; i += 1) {
    await add(`big/b-${String(i).padStart(3, '0')}.bin`, makeBytes(plan.bigSize, 10000 + i))
  }
  for (let i = 0; i < plan.text; i += 1) {
    await add(`text/t-${String(i).padStart(3, '0')}.json`, makeText(plan.textSize, 20000 + i))
  }
  return files
}

const quietLogger = (sink) => ({
  debug() {},
  info(message) { sink.logs.push(String(message)) },
  warn(message) { sink.logs.push(String(message)) },
  error(message) { sink.logs.push(String(message)) },
})

async function main() {
  const { values } = parseArgs({
    options: {
      files: { type: 'string', default: '200' },
      size: { type: 'string', default: '4096' },
      big: { type: 'string', default: '0' },
      'big-size': { type: 'string', default: String(10 * MB) },
      text: { type: 'string', default: '0' },
      'text-size': { type: 'string', default: '204800' },
      latency: { type: 'string', default: '0' },
      mode: { type: 'string', default: 'push' },
      'read-bps': { type: 'string', default: '0' },
      'write-bps': { type: 'string', default: '0' },
      port: { type: 'string', default: '0' },
      'max-file-bytes': { type: 'string' },
      label: { type: 'string', default: '' },
      keep: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })

  const plan = {
    files: num('files', values.files),
    size: num('size', values.size, { min: 1 }),
    big: num('big', values.big),
    bigSize: num('big-size', values['big-size'], { min: 1 }),
    text: num('text', values.text),
    textSize: num('text-size', values['text-size'], { min: 64 }),
    latency: num('latency', values.latency),
    readBps: num('read-bps', values['read-bps']),
    writeBps: num('write-bps', values['write-bps']),
    port: num('port', values.port),
  }
  const mode = String(values.mode)
  if (!['auto', 'push', 'pull'].includes(mode)) {
    console.error(`参数 --mode 非法：${mode}（支持 auto / push / pull）`)
    process.exit(2)
  }
  const objects = plan.files + plan.big + plan.text
  if (objects === 0) {
    console.error('至少需要一个文件：--files / --big / --text 不能全为 0')
    process.exit(2)
  }
  const fixtureBytes = plan.files * plan.size + plan.big * plan.bigSize + plan.text * plan.textSize
  const label = String(values.label).trim()
    || [plan.files && `small-${plan.files}x${plan.size}`, plan.big && `big-${plan.big}x${plan.bigSize}`,
      plan.text && `text-${plan.text}x${plan.textSize}`].filter(Boolean).join('_') + `-lat${plan.latency}`

  const sink = { logs: [] }
  const logger = quietLogger(sink)
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-bench-'))
  const dataDir = path.join(sandbox, 'data')
  const dshHome = path.join(sandbox, 'dsh-home')
  const davStore = path.join(sandbox, 'dav-store')
  let dav = null
  let exitCode = 0

  try {
    await fsp.mkdir(dataDir, { recursive: true })
    const fixture = await createFixture(dataDir, plan)
    const totalFixtureBytes = fixture.reduce((sum, file) => sum + file.size, 0)

    dav = await startMockWebdav({
      latencyMs: plan.latency,
      port: plan.port,
      storeDir: davStore,
      username: 'bench',
      password: 'bench',
      readBps: plan.readBps,
      writeBps: plan.writeBps,
    })

    const store = new SyncStore({ homeDir: dshHome, logger, env: { ...process.env, DSH_HOME: dshHome } })
    await store.load()
    const engine = new SyncEngine({ store, logger })
    const maxFileBytes = values['max-file-bytes']
      ? num('max-file-bytes', values['max-file-bytes'], { min: 64 * 1024 })
      : Math.min(1024 * MB, Math.max(32 * MB, plan.bigSize + 1))
    const { warnings } = await engine.updateConfig({
      deviceName: 'bench-device',
      autoSync: false,
      autoSave: false,
      syncOnStart: false,
      maxFileBytes,
      roots: [{ id: 'documents', label: '基准数据', path: dataDir, enabled: true, exclude: [] }],
      targets: [{
        id: 'dav', type: 'webdav', label: 'bench WebDAV', enabled: true,
        url: dav.url, username: 'bench', password: 'bench', basePath: '/dsh-sync',
      }],
    })

    const target = engine.config.targets.find((item) => item.id === 'dav')
    if (!target) throw new Error('配置里没有 dav target（updateConfig 可能被规范化丢弃）')

    const testStart = performance.now()
    const probe = await engine.testTarget(target)
    const testMs = performance.now() - testStart
    if (!probe.ok) throw new Error(`WebDAV test() 失败：${probe.detail}`)

    // 只统计 sync 阶段：test() 的探测请求不混入上传计数。
    dav.resetStats()
    const syncStart = performance.now()
    const result = await engine.sync({ targetId: 'dav', mode, trigger: 'manual' })
    const elapsedMs = performance.now() - syncStart
    const report = result.reports?.[0] ?? null
    const snap = dav.snapshot()

    const bytesUp = report?.bytesUp ?? 0
    const mbps = elapsedMs > 0 ? bytesUp / 1e6 / (elapsedMs / 1000) : 0
    const mibps = elapsedMs > 0 ? bytesUp / MB / (elapsedMs / 1000) : 0
    const objectsPerSecond = elapsedMs > 0 ? objects / (elapsedMs / 1000) : 0
    const expectedBaseRequests = mode === 'pull' ? 0 : objects * 3
    const lowerBoundMs = expectedBaseRequests * plan.latency
    const overheadRequests = Math.max(0, snap.total - expectedBaseRequests)
    const ratio = lowerBoundMs > 0 ? elapsedMs / lowerBoundMs : null
    const methods = snap.methods ?? {}
    const headPerObject = objects > 0 ? (methods.HEAD ?? 0) / objects : 0
    const putPerObject = objects > 0 ? (methods.PUT ?? 0) / objects : 0

    // 文本压缩收益参考：本机 gzip 实测（非上传实测），只对高压缩率文本有意义。
    let gzipEstimate = null
    if (plan.text > 0 && mode !== 'pull') {
      const textFiles = fixture.filter((file) => file.rel.startsWith('text/'))
      const gzipBytes = textFiles.reduce((sum, file) => sum + gzipSync(file.buffer).length, 0)
      gzipEstimate = { rawBytes: textFiles.reduce((sum, file) => sum + file.size, 0), gzipBytes }
    }

    const ok = Boolean(result.ok) && Boolean(report?.ok) && (report?.errors ?? 1) === 0
      && (mode === 'pull' || report?.pushed === objects)
    exitCode = ok ? 0 : 1

    const payload = {
      label, mode,
      files: plan.files, smallSize: plan.size,
      bigFiles: plan.big, bigSize: plan.bigSize,
      textFiles: plan.text, textSize: plan.textSize,
      objects, totalFixtureBytes,
      latencyMs: plan.latency, readBps: plan.readBps, writeBps: plan.writeBps,
      testOk: probe.ok, testMs: Math.round(testMs),
      elapsedMs: Math.round(elapsedMs), syncDurationMs: report?.durationMs ?? null,
      bytesUp, throughputMBps: Number(mbps.toFixed(4)), throughputMiBps: Number(mibps.toFixed(4)),
      objectsPerSecond: Number(objectsPerSecond.toFixed(3)),
      pushed: report?.pushed ?? 0, errors: report?.errors ?? 0, skipped: report?.skipped ?? 0,
      syncOk: Boolean(result.ok), syncError: report?.error ?? null,
      requests: {
        total: snap.total, methods,
        headPerObject: Number(headPerObject.toFixed(2)), putPerObject: Number(putPerObject.toFixed(2)),
        maxInflight: snap.maxInflight,
      },
      mockBytesIn: snap.bytesIn, mockBytesInByType: snap.bytesInByType,
      mockBytesOut: snap.bytesOut,
      theory: {
        expectedBaseRequests, lowerBoundMs,
        overheadRequests, ratio: ratio === null ? null : Number(ratio.toFixed(3)),
      },
      gzipEstimate,
      warnings: [...warnings, ...sink.logs].slice(0, 20),
      sandbox: values.keep ? sandbox : null,
      ok,
    }

    if (values.json) {
      console.log(JSON.stringify(payload))
    } else {
      printHuman(payload)
    }
    if (!ok) {
      console.error(`[bench] 同步未达预期：ok=${result.ok} errors=${report?.errors} pushed=${report?.pushed}/${objects}`)
    }
  } catch (error) {
    exitCode = 1
    console.error(`[bench] 基准执行失败：${error?.message ?? error}`)
  } finally {
    try { await dav?.close() } catch {}
    if (!values.keep) {
      try { await fsp.rm(sandbox, { recursive: true, force: true }) } catch {}
    } else {
      console.error(`[bench] 临时目录保留：${sandbox}`)
    }
  }
  process.exitCode = exitCode
}

/** 人类可读输出；关键数字一行一个，便于贴进 BASELINE。 */
function printHuman(p) {
  const lines = []
  const push = (key, value) => lines.push(`${key.padEnd(24)}: ${value}`)
  push('label', p.label)
  push('mode', p.mode)
  push('objects', `${p.objects}（small ${p.files} × ${p.smallSize}B，big ${p.bigFiles} × ${p.bigSize}B，text ${p.textFiles} × ${p.textSize}B）`)
  push('total fixture bytes', `${p.totalFixtureBytes} (${(p.totalFixtureBytes / MB).toFixed(3)} MiB)`)
  push('latency per request', `${p.latencyMs} ms`)
  push('test()', `${p.testOk ? 'ok' : 'FAILED'}，${p.testMs} ms`)
  push('sync elapsed', `${p.elapsedMs} ms`)
  push('sync report duration', `${p.syncDurationMs} ms`)
  push('bytes up (report)', `${p.bytesUp} (${(p.bytesUp / MB).toFixed(3)} MiB)`)
  push('throughput', `${p.throughputMBps} MB/s (10^6 B/s) = ${p.throughputMiBps} MiB/s`)
  push('objects/s', `${p.objectsPerSecond}`)
  push('pushed / errors', `${p.pushed} / ${p.errors}`)
  push('sync ok', `${p.syncOk}${p.syncError ? `（error=${p.syncError}）` : ''}`)
  push('mock requests total', p.requests.total)
  push('methods', Object.entries(p.requests.methods).sort().map(([k, v]) => `${k}=${v}`).join(' '))
  push('HEAD per object', p.requests.headPerObject)
  push('PUT per object', p.requests.putPerObject)
  push('concurrency peak', p.requests.maxInflight)
  push('mock bytes in (PUT)', `${p.mockBytesIn} (${(p.mockBytesIn / MB).toFixed(3)} MiB)`)
  push('mock bytes in by type', Object.entries(p.mockBytesInByType).map(([k, v]) => `${k}=${v}`).join('; ') || 'n/a')
  push('theory serial lower bound', `${p.theory.lowerBoundMs} ms（${p.theory.expectedBaseRequests} 请求 × ${p.latencyMs} ms）`)
  push('overhead requests', p.theory.overheadRequests)
  push('elapsed / lower bound', p.theory.ratio === null ? 'n/a' : String(p.theory.ratio))
  if (p.gzipEstimate) {
    push('gzip estimate (local)', `${p.gzipEstimate.rawBytes} → ${p.gzipEstimate.gzipBytes} B（${(p.gzipEstimate.rawBytes / p.gzipEstimate.gzipBytes).toFixed(1)}×，非上传实测）`)
  }
  if (p.warnings.length > 0) push('warnings', `${p.warnings.length}（首条：${p.warnings[0]}）`)
  console.log(lines.join('\n'))
  console.log(`RESULT_JSON ${JSON.stringify(p)}`)
}

main()