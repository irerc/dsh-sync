/**
 * Agent 工具：状态、立即同步、导出、导入。
 *
 * 工具与设置页共用同一个 SyncEngine，因此模型看到的数字与页面一致。
 * 工具注册失败（宿主没有 tools 服务）只记 warn，不影响同步本身。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { formatBytes } from './util.js'
import { decodePairing } from './pair.js'

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
    name: 'dsh_sync_configure',
    description:
      '配置一个同步目标。用户口述「WebDAV 服务器地址 / 账号 / 应用密码」时调用：type=webdav，填 url、username、password、basePath（默认 /dsh-sync）。' +
      'peer 目标填 url 与 token；local 目标填绝对路径 path。默认测试连接并立即同步；同一地址+用户名会更新而不是重复新增。' +
      '不要把 password/token 回显给用户。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['webdav', 'peer', 'local'], description: '目标类型。' },
        label: { type: 'string', description: '显示名称，可选。' },
        url: { type: 'string', description: 'webdav/peer 的服务器地址（http/https）。' },
        username: { type: 'string', description: 'WebDAV 用户名。' },
        password: { type: 'string', description: 'WebDAV 应用密码/专用密码。' },
        basePath: { type: 'string', description: 'WebDAV 子路径，默认 /dsh-sync。' },
        token: { type: 'string', description: 'peer 目标的配对 Token。' },
        path: { type: 'string', description: 'local 目标的绝对路径。' },
        sync: { type: 'boolean', description: '配置成功后是否立即同步，默认 true。' },
        targetId: { type: 'string', description: '更新已有目标时填其 id，可选。' },
      },
      required: ['type'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args) => withReady(async () => {
      const { target, warnings } = await engine.connectTarget(args ?? {})
      const test = await engine.testTarget(target)
      let report = null
      if (args?.sync !== false && test?.ok) {
        report = await engine.sync({ targetId: target.id, mode: 'auto', trigger: 'tool' })
      }
      const where = target.type === 'local' ? target.path : target.url
      const lines = [
        `已配置目标：${target.id}（${target.type}）${target.label}`,
        `地址：${where}`,
        `连接测试：${test?.ok ? '成功' : '失败'}${test?.detail ? `（${test.detail}）` : ''}`,
        report ? `同步结果：\n${formatReport(report)}` : '同步：未执行（测试未通过或 sync=false）',
      ]
      if (warnings?.length) lines.push(`提示：${warnings.join('；')}`)
      return lines.join('\n')
    }),
  })

  register({
    name: 'dsh_sync_pair',
    description:
      '应用一段 dsh-sync 一键配对码（DSHSYNC1. 开头），自动新增/更新 peer 或 WebDAV 目标，默认测试并同步。' +
      '用户直接粘贴配对码时调用；不要回显码里的密码/Token。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '以 DSHSYNC1. 开头的配对码。' },
        sync: { type: 'boolean', description: '是否立即同步，默认 true。' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    execute: async (args) => withReady(async () => {
      const data = decodePairing(args?.code)
      const result = await engine.applyPairPayload(data, { sync: args?.sync !== false })
      const where = result.target.type === 'local' ? result.target.path : result.target.url
      const lines = [
        `已配对：${result.target.id}（${result.target.type}）${result.target.label}`,
        `地址：${where}`,
        `连接测试：${result.test?.ok ? '成功' : '失败'}${result.test?.detail ? `（${result.test.detail}）` : ''}`,
      ]
      if (result.report) lines.push(`同步结果：\n${formatReport(result.report)}`)
      if (result.error) lines.push(`同步错误：${result.error}`)
      if (result.warnings?.length) lines.push(`提示：${result.warnings.join('；')}`)
      return lines.join('\n')
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