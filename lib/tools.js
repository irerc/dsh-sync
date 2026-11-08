/**
 * Agent 工具：状态、立即同步、导出、导入。
 *
 * 工具与设置页共用同一个 SyncEngine，因此模型看到的数字与页面一致。
 * 工具注册失败（宿主没有 tools 服务）只记 warn，不影响同步本身。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { formatBytes } from './util.js'

/** 格式化同步报告。 */
function formatReport(report) {
  const lines = []
  for (const item of report.reports ?? []) {
    const status = item.ok ? '成功' : '失败'
    lines.push(
      `- ${item.targetId}（${item.type}）：${status}，上传 ${item.pushed}，下载 ${item.pulled}，` +
      `删除 ${item.deletedLocal}，墓碑 ${item.tombstoned}，冲突 ${item.conflicts}，` +
      `跳过 ${item.skipped}，错误 ${item.errors}，耗时 ${item.durationMs}ms` +
      (item.error ? `，错误信息：${item.error}` : ''),
    )
  }
  if (lines.length === 0) lines.push('- 没有启用的同步目标')
  if (report.skipped) lines.push('- 上一次同步仍在进行，本次自动任务已跳过')
  if (report.error) lines.push(`- ${report.error}`)
  return lines.join('\n')
}

/** 格式化状态。 */
function formatStatus(status) {
  const lines = [
    `设备：${status.deviceName}（${status.deviceId.slice(0, 8)}）`,
    `自动保存：${status.autoSave ? `开，${status.autoSaveIntervalSeconds}s` : '关'}；` +
    `自动同步：${status.autoSync ? `开，${status.autoSyncIntervalSeconds}s` : '关'}`,
    `同步目标：`,
  ]
  for (const target of status.targets) {
    const last = target.lastResult
    const lastText = target.lastSyncAt
      ? `${new Date(target.lastSyncAt).toLocaleString()}（↑${last?.pushed ?? 0} ↓${last?.pulled ?? 0} 冲突${last?.conflicts ?? 0} 错误${last?.errors ?? 0}）`
      : '尚未同步'
    lines.push(`- ${target.label} [${target.type}] ${target.enabled ? '启用' : '停用'}：${target.detail}；上次：${lastText}`)
  }
  lines.push('根目录：')
  for (const root of status.roots) {
    lines.push(`- ${root.label}：${root.path}${root.enabled === false ? '（停用）' : ''}`)
  }
  if (status.conflicts?.length) {
    lines.push(`最近冲突 ${status.conflicts.length} 条，最新：${status.conflicts.at(-1)?.copy ?? '（无副本）'}`)
  }
  lines.push(`对等配对地址：${status.peer.url}`)
  lines.push(`对等令牌：${status.peer.token}`)
  lines.push(`待处理提示：${status.warnings.length > 0 ? status.warnings.join('；') : '无'}`)
  return lines.join('\n')
}

/** 注册全部工具。 */
export function registerTools(ctx, { engine, ready, logger = console }) {
  const tools = ctx.get?.('tools')
  if (!tools || typeof tools.register !== 'function') {
    logger.warn?.('[dsh-sync] 宿主未提供 tools 服务，跳过 Agent 工具注册')
    return
  }

  const register = (definition) => {
    if (typeof ctx.effect === 'function') ctx.effect(() => tools.register(definition), `dsh-sync: tool ${definition.name}`)
    else tools.register(definition)
  }

  const withReady = async (operation) => {
    await ready
    return operation()
  }

  register({
    name: 'dsh_sync_status',
    description:
      '查看多设备同步状态：设备、同步目标、上次同步结果、根目录、最近冲突、对等配对地址与令牌。' +
      '用户问“同步好了吗 / 上次同步结果”时先调用它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => withReady(async () => formatStatus(await engine.status())),
  })

  register({
    name: 'dsh_sync_run',
    description:
      '立即执行一次多设备同步。mode=auto 双向（默认），push 只上传本地变更，pull 只下载远端变更；' +
      '省略 targetId 时同步所有已启用目标。返回每个目标的真实统计。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'push', 'pull'], description: '同步方向，默认 auto。' },
        targetId: { type: 'string', description: '只同步指定目标 id；省略则全部启用目标。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args) => withReady(async () => {
      const report = await engine.sync({
        mode: args?.mode ?? 'auto',
        targetId: args?.targetId,
        trigger: 'tool',
      })
      return formatReport(report)
    }),
  })

  register({
    name: 'dsh_sync_export',
    description:
      '把当前根目录导出为一个 .dshsync 单文件归档（gzip+tar，内容寻址）。适合用聊天/网盘把快照发给另一台设备。' +
      '返回归档绝对路径与大小。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async () => withReady(async () => {
      const result = await engine.exportArchive()
      return `已导出：${result.path}\n大小：${formatBytes(result.size)}（${result.entries} 个文件，跳过 ${result.skipped}）\nsha256：${result.sha256}\n可以直接发送该文件；在另一台设备用 dsh_sync_import 导入。`
    }),
  })

  register({
    name: 'dsh_sync_import',
    description:
      '导入本机上的 .dshsync 归档文件。归档内容写入对应根目录；被覆盖的本地旧内容会保留为冲突副本。' +
      '导入后建议再调用 dsh_sync_run 把结果推送到各目标。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本机上 .dshsync 文件的绝对路径（或相对当前工作目录）。' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args) => withReady(async () => {
      const raw = String(args?.path ?? '').trim()
      if (raw.length === 0) throw new Error('path 不能为空')
      const file = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        throw new Error(`归档不存在：${file}`)
      }
      if (!stat.isFile()) throw new Error(`不是普通文件：${file}`)
      if (stat.size > 512 * 1024 * 1024) throw new Error('归档超过 512 MiB，拒绝导入')
      const bytes = await fsp.readFile(file)
      const report = await engine.importArchive({ bytes, name: path.basename(file) })
      return [
        `导入完成：${report.name}`,
        `写入 ${report.imported}，未变 ${report.unchanged}，冲突副本 ${report.conflicts}，跳过 ${report.skipped}，错误 ${report.errors}`,
        report.errors > 0 ? '存在错误，请查看设置页日志。' : '可以调用 dsh_sync_run 推送到同步目标。',
      ].join('\n')
    }),
  })
}