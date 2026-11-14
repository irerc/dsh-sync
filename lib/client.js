/**
 * dsh-sync Web 设置页（浏览器模块）。
 *
 * 设计边界：
 * - 只依赖宿主注入的 `react`，不引用任何 Harness 运行时包，不使用 iframe。
 * - 所有数据走同源 `/dsh-sync/api`；所有可见文案走 `ctx.locale` 字典。
 * - 样式只使用 `--dsw-alias-*` 主题 token，类名统一 `dsync-` 前缀。
 * - 字典键采用**扁平点号键**：locale 服务的 lookup 按对象属性直接取 key，
 *   不做嵌套路径展开（已核对 dsh-client-locale 的 translate/lookup 实现）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 客户端本地化命名空间，同时用于设置页导航标签。 */
    const NS = 'dsh-sync'
    /** Host HTTP API 基地址。 */
    const API_BASE = '/dsh-sync/api'
    /** 设置页会话令牌：由 Host 注入到受鉴权保护的 index 页面。 */
    const UI_TOKEN_META = typeof document === 'undefined' ? null : document.querySelector('meta[name="dsh-sync-ui-token"]')
    const UI_TOKEN = UI_TOKEN_META ? textOf(UI_TOKEN_META.getAttribute('content')) : ''

    /** 给请求头补上 UI token（没有 meta 时保持原样，Host 会返回 401）。 */
    function withUiToken(headers) {
      const merged = { ...(headers || {}) }
      if (UI_TOKEN) merged['x-dsh-sync-ui-token'] = UI_TOKEN
      return merged
    }
    /** 归档导入的客户端预检查上限，与 SPEC 的 512 MiB 解压上限对齐。 */
    const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
    /** Host 配置归一化的数量上限，提前在 UI 拦截，避免静默截断。 */
    const MAX_TARGETS = 16
    const MAX_ROOTS = 16
    const MAX_EXCLUDES = 50
    const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' })

    // ---------------------------------------------------------------------
    // 文案字典（zh / en）。扁平键，插值契约与宿主 locale 一致：{name}。
    // ---------------------------------------------------------------------
    const zh = {
      nav: '多设备同步',
      title: '多设备同步',
      intro: '把选定的本地目录以内容快照发布到本地目录、WebDAV 或另一台 DSH，并在多设备间双向同步。每个目标维护独立的同步基线。',

      'common.save': '保存',
      'common.saving': '保存中…',
      'common.saved': '已保存',
      'common.cancel': '取消',
      'common.delete': '删除',
      'common.confirmDelete': '确认删除',
      'common.copy': '复制',
      'common.copied': '已复制',
      'common.copyFailed': '复制失败，请手动选择文本。',
      'common.retry': '重试',
      'common.refresh': '刷新',
      'common.refreshing': '刷新中…',
      'common.enabled': '已启用',
      'common.disabled': '未启用',
      'common.never': '从未同步',
      'common.dismiss': '关闭提示',
      'common.test': '测试连接',
      'common.testing': '测试中…',
      'common.add': '新增',
      'common.working': '处理中…',
      'common.optional': '可选',
      'common.none': '—',

      'state.loading': '正在读取同步状态…',
      'state.loadFailed': '无法读取同步状态：{error}',
      'state.loadFailedHint': '请确认 DSH 正在运行，然后重试。',
      'state.busy': '后台同步任务正在运行，完成前部分操作不可用。',
      'state.actionFailed': '操作失败：{error}',
      'state.invalidNumber': '请输入有效数字。',
      'state.configWarnings': '配置已保存，但 Host 报告了 {n} 条警告：',
      'state.warningsMore': '另有 {n} 条警告未显示。',

      'status.heading': '同步状态',
      'status.intro': '设备级同步设置与最近一次同步结果。',
      'status.device': '设备',
      'status.deviceLine': '设备：{name}',
      'status.lastSyncLine': '上次同步：{time}',
      'status.deviceName': '设备名称',
      'status.deviceNameHint': '用于在其他设备上识别本机。',
      'status.deviceNameRequired': '设备名称不能为空。',
      'status.autoSync': '自动同步',
      'status.autoSyncHint': '按间隔执行完整双向同步。',
      'status.autoSave': '自动保存',
      'status.autoSaveHint': '本地有变更时自动上传到已启用的目标。',
      'status.syncOnStart': '启动时同步',
      'status.syncOnStartHint': 'DSH 启动后错峰执行一次完整同步。',
      'status.autoSyncInterval': '自动同步间隔（秒）',
      'status.autoSaveInterval': '自动保存间隔（秒）',
      'status.intervalHint': '取值 1–86400 秒。',
      'status.intervalInvalid': '间隔必须是 1 到 86400 之间的整数。',
      'status.autoSaveIntervalHint': '取值 5–3600 秒。',
      'status.autoSyncIntervalHint': '取值 15–86400 秒。',
      'status.autoSaveIntervalInvalid': '自动保存间隔必须是 5 到 3600 之间的整数。',
      'status.autoSyncIntervalInvalid': '自动同步间隔必须是 15 到 86400 之间的整数。',
      'status.concurrency': '并发传输数',
      'status.concurrencyHint': '取值 1–16；默认 4。网络好可调高，移动网络建议 2。',
      'status.concurrencyInvalid': '并发传输数必须是 1 到 16 之间的整数。',
      'status.compressObjects': '上传压缩',
      'status.compressObjectsHint': 'JSON/Markdown 等文本对象 gzip 后再传，通常省 60%~90% 流量。',
      'status.skippedUploads': '去重跳过 {n}',
      'status.throughput': '{rate}/s',
      'status.speedLine': '↑ {size} · {rate}/s',
      'status.speedHint': '上次同步的实传字节与平均速率',
      'status.liveSpeed': '↑ {up}/s · ↓ {down}/s',
      'status.liveSpeedHint': '本次同步的实时上传/下载速率',
      'status.speedLineBoth': '↑ {upSize} · ↓ {downSize} · {rate}/s',
      'status.syncingFor': '同步中 {seconds}s',
      'status.syncingAria': '正在同步',
      'status.settingsHeading': '常规设置',
      'status.saveSettings': '保存设置',
      'status.lastSync': '上次同步',
      'status.lastResult': '上次结果',
      'status.lastResultCombined': '上次结果（各目标合计）',
      'status.resultOk': '成功',
      'status.resultFailed': '有失败项',
      'status.pushed': '上传 {n}',
      'status.pulled': '下载 {n}',
      'status.deletedLocal': '删除 {n}',
      'status.tombstoned': '删除标记 {n}',
      'status.errors': '错误 {n}',
      'status.conflicts': '冲突 {n}',
      'status.skipped': '跳过 {n}',
      'status.duration': '耗时 {ms} 毫秒',
      'status.syncNow': '立即同步',
      'status.pushOnly': '仅上传',
      'status.pullOnly': '仅下载',
      'status.syncing': '同步中…',
      'status.syncDone': '同步完成。',
      'status.reports': '本次同步结果',
      'status.reportLine': '{target}：上传 {pushed} · 下载 {pulled} · 冲突 {conflicts}',
      'status.noEnabledTargets': '没有已启用的同步目标，请先启用一个 target。',
      'status.busyHint': '同步进行中，按钮已暂时禁用。',

      'targets.heading': '同步目标',
      'targets.intro': '一轮同步会扇出到所有已启用的目标；每个目标独立保存上次同步基线。',
      'targets.empty': '还没有同步目标。添加本地目录、WebDAV 或另一台 DSH。',
      'quick.heading': 'WebDAV 快速开始',
      'quick.intro': '只填地址、账号、应用密码即可。子路径自动使用 /dsh-sync，保存后立即测试连接并同步。',
      'quick.url': 'WebDAV 地址',
      'quick.username': '账号',
      'quick.password': '应用密码',
      'quick.passwordHint': '建议使用应用密码/专用密码；密码只保存在本机配置中，不回显。',
      'quick.submit': '连接并同步',
      'quick.required': '请填写地址、账号和应用密码。',
      'quick.testFailed': '连接失败：{detail}',
      'quick.synced': '已连接 {target}；上传 {pushed}，下载 {pulled}，冲突 {conflicts}，错误 {errors}。',
      'quick.summary': '已连接 {url} · 账号 {username}',
      'quick.summaryUnknown': '已配置 WebDAV',
      'quick.expand': '展开',
      'quick.collapse': '收起',
      'quick.toggleHint': '展开后可修改地址或账号；密码已保存，保持 *** 即沿用原密码。',
      'quick.savedPasswordKeep': '密码已保存，此处显示 ***；保持不变即沿用原密码。',
      'quick.passwordReset': '已保存新密码。',
      'targets.add': '新增目标',
      'targets.newTitle': '新增同步目标',
      'targets.type': '类型',
      'targets.typeLocal': '本地 / 挂载目录',
      'targets.typeWebdav': 'WebDAV',
      'targets.typePeer': '另一台 DSH',
      'targets.typeHint': '切换类型后只显示该类型需要的字段。',
      'targets.label': '名称',
      'targets.labelPlaceholder': '例如：家里 NAS',
      'targets.path': '目录路径',
      'targets.pathHint': '绝对路径；目录需已存在，支持 $HOME、$DSH_HOME、~ 前缀。',
      'targets.pathRequired': '请填写目录路径。',
      'targets.url': '服务地址',
      'targets.urlHintWebdav': '例如 https://dav.example.com/remote.php/dav/files/user',
      'targets.urlHintPeer': '例如 http://192.168.1.20:3080（可带路径前缀）',
      'targets.urlPlaceholderWebdav': 'https://dav.example.com/remote.php/dav/files/user',
      'targets.urlPlaceholderPeer': 'http://192.168.1.20:3080',
      'targets.urlRequired': '请填写服务地址。',
      'targets.urlInvalid': '地址必须以 http:// 或 https:// 开头。',
      'targets.username': '用户名',
      'targets.password': '密码',
      'targets.passwordHint': '已保存的密码不会回显；留空表示不修改。',
      'targets.basePath': '基础路径',
      'targets.basePathHint': '例如 /dsh-sync',
      'targets.token': 'Token',
      'targets.tokenHint': '对方「Peer 配对」中的 Token；留空表示不修改。',
      'targets.tokenRequired': '启用对等同步时请填写配对 Token。',
      'targets.limit': '最多 16 个同步目标。',
      'targets.enabled': '启用该目标',
      'targets.lastSync': '上次同步',
      'targets.lastSyncLine': '上次同步：{time}',
      'targets.test': '测试连接',
      'targets.testOk': '连接成功：{detail}',
      'targets.testFail': '连接失败：{detail}',
      'targets.save': '保存目标',
      'targets.copyPair': '复制配对码',
      'targets.delete': '删除目标',
      'targets.deleteConfirm': '确定删除同步目标「{label}」？远端已有数据不会被删除。',
      'targets.addSave': '添加目标',
      'targets.required': '请填写所有必填字段。',
      'targets.masked': '已保存（不回显）',
      'targets.detail': '位置',
      'targets.detailLine': '位置：{detail}',
      'targets.labelRequired': '请填写名称。',

      'roots.heading': '同步目录',
      'roots.intro': '选择要纳入同步的本地目录。排除规则一行一条，支持 *、?、**，例如 node_modules/**。',
      'roots.empty': '还没有同步目录。',
      'roots.add': '新增目录',
      'roots.newTitle': '新增同步目录',
      'roots.label': '名称',
      'roots.labelPlaceholder': '例如：工作区文档',
      'roots.path': '绝对路径',
      'roots.pathHint': '必须是绝对路径；支持 $HOME、$DSH_HOME、~ 前缀。',
      'roots.pathWarning': '路径必须指向已存在的绝对路径，不能是 /，也不能与其他目录互相嵌套。',
      'roots.exclude': '排除项',
      'roots.excludeHint': '一行一个，例如 node_modules/**、**/*.log、.git/**；最多 50 条。',
      'roots.enabled': '启用该目录',
      'roots.save': '保存目录',
      'roots.delete': '删除目录',
      'roots.deleteConfirm': '确定删除同步目录「{label}」？磁盘上的文件不会被删除。',
      'roots.addSave': '添加目录',
      'roots.labelRequired': '请填写名称。',
      'roots.pathRequired': '请填写绝对路径。',
      'roots.limit': '最多 16 个同步目录。',
      'roots.excludeLimit': '排除项最多 50 条。',

      'peer.heading': 'Peer 配对',
      'peer.intro': '在另一台设备上新增 peer 目标，填入下面的地址与 Token 即可互联。仅分享给可信设备。',
      'peer.url': '服务地址',
      'peer.token': '配对 Token',
      'peer.codeHeading': '一键配对码',
      'peer.codeHint': '配对码包含连接凭据，只发给可信设备；对方粘贴后会自动新增 target 并同步。',
      'peer.copyCode': '复制本机配对码',
      'peer.codePlaceholder': '点击“复制本机配对码”生成',
      'peer.pasteLabel': '粘贴对方的配对码',
      'peer.pastePlaceholder': 'DSHSYNC1....',
      'peer.pairButton': '连接并同步',
      'peer.pairSynced': '已连接 {target}，同步完成',
      'peer.pairFailed': '配对失败：{error}',
      'peer.copyUrl': '复制地址',
      'peer.copyToken': '复制 Token',
      'peer.unavailable': 'Host 未提供配对信息。',
      'peer.securityNote': 'Token 等同于访问凭据，请妥善保管。',

      'transfer.heading': '导入 / 导出',
      'transfer.intro': '导出会生成 .dshsync 归档；导入会把归档当作远端快照合并到本地。',
      'transfer.export': '导出归档',
      'transfer.exporting': '导出中…',
      'transfer.exportFull': '完整备份（工作区＋对话）',
      'transfer.exportFulling': '打包中…',
            'transfer.exportFullSkipped': '{base} 但以下工作区超出体积上限被跳过：{names}。需要时可调大单次归档上限后重试。',
'transfer.exportFullHint': '把 DSH 工作区文件与对话记录一起打包下载，用于换机或数据拯救。大文件与系统目录会被自动跳过。',
  'transfer.exportApp': '完整应用数据',
  'transfer.pruneFailed': '云端回收失败',
  'transfer.prune': '云端回收',
  'transfer.pruneHint': '删除云端没有任何设备清单引用的旧对象（文件每改一次就会多存一份，旧的不删会越积越多）。先预演，再确认。',
  'transfer.pruneDryRun': '预演：检查可回收空间',
  'transfer.pruneConfirm': '确认删除 {n} 个对象（{size}）',
  'transfer.pruneResult': '云端 {objects} 个对象，引用 {referenced} 个；可回收 {n} 个 / {size}。',
  'transfer.pruneDone': '已删除 {n} 个对象，回收 {size}（{rate}）。',
  'transfer.dedupeSaved': '去重省下 {size}',
  'transfer.pruneRunning': '回收中…',
  'transfer.exportAppHint': '打包 DSH 应用数据本身（会话、设置、插件启用状态、账号凭据、自有插件源码）。新设备导入后再跑一次依赖安装，效果与这台机器一致。node_modules 与缓存的二进制不会打包。',
      'transfer.missingUrl': '导出响应缺少下载地址。',
      'transfer.exportDone': '已生成 {name}（{size}）。',
      'transfer.import': '导入归档',
      'transfer.importing': '导入中…',
      'transfer.importPick': '选择 .dshsync 文件',
      'transfer.importDone': '导入完成：写入 {imported} · 未变 {unchanged} · 冲突副本 {conflicts} · 跳过 {skipped} · 错误 {errors}。',
      'transfer.importHint': '只接受 .dshsync 文件；超过 Host 限制的归档会被拒绝。',
      'transfer.importInvalidType': '请选择 .dshsync 归档文件。',
      'transfer.importTooLarge': '文件超过 512 MiB，已取消导入。',

      'logs.heading': '活动日志',
      'logs.empty': '暂无活动记录。',
      'logs.conflictsHeading': '冲突',
      'logs.conflictsEmpty': '暂无冲突记录。',
      'logs.conflictItem': '{key} → {copy}',
      'logs.reason': '原因：{reason}',
      'logs.level.info': '信息',
      'logs.level.warn': '警告',
      'logs.level.error': '错误',

      'footer.note': '所有数据经本机 /dsh-sync HTTP 接口读写；密码与 Token 不会在页面回显。',
    }

    const en = {
      nav: 'Multi-device sync',
      title: 'Multi-device sync',
      intro: 'Publish selected local folders as content snapshots to a local folder, WebDAV, or another DSH device, and sync bidirectionally across devices. Each target keeps its own baseline.',

      'common.save': 'Save',
      'common.saving': 'Saving…',
      'common.saved': 'Saved',
      'common.cancel': 'Cancel',
      'common.delete': 'Delete',
      'common.confirmDelete': 'Confirm delete',
      'common.copy': 'Copy',
      'common.copied': 'Copied',
      'common.copyFailed': 'Copy failed; select the text manually.',
      'common.retry': 'Retry',
      'common.refresh': 'Refresh',
      'common.refreshing': 'Refreshing…',
      'common.enabled': 'Enabled',
      'common.disabled': 'Disabled',
      'common.never': 'Never synced',
      'common.dismiss': 'Dismiss',
      'common.test': 'Test connection',
      'common.testing': 'Testing…',
      'common.add': 'Add',
      'common.working': 'Working…',
      'common.optional': 'Optional',
      'common.none': '—',

      'state.loading': 'Reading sync status…',
      'state.loadFailed': 'Cannot read sync status: {error}',
      'state.loadFailedHint': 'Make sure DSH is running, then retry.',
      'state.busy': 'A background sync is running; some actions are unavailable until it finishes.',
      'state.actionFailed': 'Action failed: {error}',
      'state.invalidNumber': 'Enter a valid number.',
      'state.configWarnings': 'Saved, but the Host reported {n} warning(s):',
      'state.warningsMore': '{n} more warning(s) not shown.',

      'status.heading': 'Sync status',
      'status.intro': 'Device-level sync settings and the latest run.',
      'status.device': 'Device',
      'status.deviceLine': 'Device: {name}',
      'status.lastSyncLine': 'Last sync: {time}',
      'status.deviceName': 'Device name',
      'status.deviceNameHint': 'Identifies this device on other machines.',
      'status.deviceNameRequired': 'Device name cannot be empty.',
      'status.autoSync': 'Auto sync',
      'status.autoSyncHint': 'Runs a full bidirectional sync on the interval.',
      'status.autoSave': 'Auto save',
      'status.autoSaveHint': 'Uploads local changes automatically to enabled targets.',
      'status.syncOnStart': 'Sync on start',
      'status.syncOnStartHint': 'Runs one full sync shortly after DSH starts.',
      'status.autoSyncInterval': 'Auto sync interval (seconds)',
      'status.autoSaveInterval': 'Auto save interval (seconds)',
      'status.intervalHint': 'Allowed range: 1–86400 seconds.',
      'status.intervalInvalid': 'Interval must be an integer between 1 and 86400.',
      'status.autoSaveIntervalHint': 'Allowed range: 5–3600 seconds.',
      'status.autoSyncIntervalHint': 'Allowed range: 15–86400 seconds.',
      'status.autoSaveIntervalInvalid': 'Auto save interval must be an integer between 5 and 3600.',
      'status.autoSyncIntervalInvalid': 'Auto sync interval must be an integer between 15 and 86400.',
      'status.concurrency': 'Parallel transfers',
      'status.concurrencyHint': 'Allowed range: 1–16; default 4. Raise on fast links, lower on mobile.',
      'status.concurrencyInvalid': 'Parallel transfers must be an integer between 1 and 16.',
      'status.compressObjects': 'Compress uploads',
      'status.compressObjectsHint': 'Gzip text objects (JSON/Markdown) before upload; usually saves 60–90% traffic.',
      'status.skippedUploads': 'Deduped {n}',
      'status.throughput': '{rate}/s',
      'status.speedLine': '↑ {size} · {rate}/s',
      'status.speedHint': 'Bytes actually uploaded last sync and average rate',
      'status.liveSpeed': '↑ {up}/s · ↓ {down}/s',
      'status.liveSpeedHint': 'Live upload/download rate for this sync',
      'status.speedLineBoth': '↑ {upSize} · ↓ {downSize} · {rate}/s',
      'status.syncingFor': 'Syncing {seconds}s',
      'status.syncingAria': 'Syncing',
      'status.settingsHeading': 'General settings',
      'status.saveSettings': 'Save settings',
      'status.lastSync': 'Last sync',
      'status.lastResult': 'Last result',
      'status.lastResultCombined': 'Last result (all targets combined)',
      'status.resultOk': 'Succeeded',
      'status.resultFailed': 'Has failures',
      'status.pushed': 'Uploaded {n}',
      'status.pulled': 'Downloaded {n}',
      'status.deletedLocal': 'Deleted {n}',
      'status.tombstoned': 'Delete markers {n}',
      'status.errors': 'Errors {n}',
      'status.conflicts': 'Conflicts {n}',
      'status.skipped': 'Skipped {n}',
      'status.duration': 'Took {ms} ms',
      'status.syncNow': 'Sync now',
      'status.pushOnly': 'Upload only',
      'status.pullOnly': 'Download only',
      'status.syncing': 'Syncing…',
      'status.syncDone': 'Sync finished.',
      'status.reports': 'This run',
      'status.reportLine': '{target}: uploaded {pushed} · downloaded {pulled} · conflicts {conflicts}',
      'status.noEnabledTargets': 'No enabled target yet. Enable one first.',
      'status.busyHint': 'Sync in progress; buttons are disabled.',

      'targets.heading': 'Sync targets',
      'targets.intro': 'One sync run fans out to every enabled target; each target keeps its own baseline.',
      'targets.empty': 'No sync target yet. Add a local folder, WebDAV, or another DSH.',
      'quick.heading': 'Quick WebDAV setup',
      'quick.intro': 'Fill in the URL, account, and app password. The subpath defaults to /dsh-sync, and the connection is tested and synced immediately.',
      'quick.url': 'WebDAV URL',
      'quick.username': 'Account',
      'quick.password': 'App password',
      'quick.passwordHint': 'Use an app-specific password. It is stored only in the local config and never echoed back.',
      'quick.submit': 'Connect and sync',
      'quick.required': 'URL, account, and app password are required.',
      'quick.testFailed': 'Connection failed: {detail}',
      'quick.synced': 'Connected {target}; pushed {pushed}, pulled {pulled}, conflicts {conflicts}, errors {errors}.',
      'quick.summary': 'Connected to {url} · account {username}',
      'quick.summaryUnknown': 'WebDAV configured',
      'quick.expand': 'Expand',
      'quick.collapse': 'Collapse',
      'quick.toggleHint': 'Expand to edit the URL or account. The password is saved; keep *** to reuse it.',
      'quick.savedPasswordKeep': 'The password is saved and shown as ***; keep it unchanged to reuse it.',
      'quick.passwordReset': 'New password saved.',
      'targets.add': 'Add target',
      'targets.newTitle': 'New sync target',
      'targets.type': 'Type',
      'targets.typeLocal': 'Local / mounted folder',
      'targets.typeWebdav': 'WebDAV',
      'targets.typePeer': 'Another DSH',
      'targets.typeHint': 'Switching type shows only the fields that type needs.',
      'targets.label': 'Name',
      'targets.labelPlaceholder': 'e.g. NAS at home',
      'targets.path': 'Folder path',
      'targets.pathHint': 'Absolute path; the folder must exist. $HOME, $DSH_HOME, and ~ prefixes are supported.',
      'targets.pathRequired': 'Enter the folder path.',
      'targets.url': 'Server URL',
      'targets.urlHintWebdav': 'e.g. https://dav.example.com/remote.php/dav/files/user',
      'targets.urlHintPeer': 'e.g. http://192.168.1.20:3080 (path prefix allowed)',
      'targets.urlPlaceholderWebdav': 'https://dav.example.com/remote.php/dav/files/user',
      'targets.urlPlaceholderPeer': 'http://192.168.1.20:3080',
      'targets.urlRequired': 'Enter the server URL.',
      'targets.urlInvalid': 'URL must start with http:// or https://.',
      'targets.username': 'Username',
      'targets.password': 'Password',
      'targets.passwordHint': 'Saved passwords are never shown; leave empty to keep the current one.',
      'targets.basePath': 'Base path',
      'targets.basePathHint': 'e.g. /dsh-sync',
      'targets.token': 'Token',
      'targets.tokenHint': 'The Token from the peer pairing panel; leave empty to keep the current one.',
      'targets.tokenRequired': 'A pairing Token is required when peer sync is enabled.',
      'targets.limit': 'Up to 16 sync targets.',
      'targets.enabled': 'Enable this target',
      'targets.lastSync': 'Last sync',
      'targets.lastSyncLine': 'Last sync: {time}',
      'targets.test': 'Test connection',
      'targets.testOk': 'Connected: {detail}',
      'targets.testFail': 'Connection failed: {detail}',
      'targets.save': 'Save target',
      'targets.copyPair': 'Copy pairing code',
      'targets.delete': 'Delete target',
      'targets.deleteConfirm': 'Delete sync target "{label}"? Existing remote data is not removed.',
      'targets.addSave': 'Add target',
      'targets.required': 'Fill in every required field.',
      'targets.masked': 'Saved (hidden)',
      'targets.detail': 'Location',
      'targets.detailLine': 'Location: {detail}',
      'targets.labelRequired': 'Enter a name.',

      'roots.heading': 'Sync folders',
      'roots.intro': 'Choose local folders to include. Exclude rules go one per line and support *, ?, and ** (e.g. node_modules/**).',
      'roots.empty': 'No sync folder yet.',
      'roots.add': 'Add folder',
      'roots.newTitle': 'New sync folder',
      'roots.label': 'Name',
      'roots.labelPlaceholder': 'e.g. Workspace documents',
      'roots.path': 'Absolute path',
      'roots.pathHint': 'Must be absolute; $HOME, $DSH_HOME, and ~ prefixes are supported.',
      'roots.pathWarning': 'The path must be an existing absolute path, cannot be /, and must not nest inside another root.',
      'roots.exclude': 'Excludes',
      'roots.excludeHint': 'One per line, e.g. node_modules/**, **/*.log, .git/**; up to 50 entries.',
      'roots.enabled': 'Enable this folder',
      'roots.save': 'Save folder',
      'roots.delete': 'Delete folder',
      'roots.deleteConfirm': 'Delete sync folder "{label}"? Files on disk are not removed.',
      'roots.addSave': 'Add folder',
      'roots.labelRequired': 'Enter a name.',
      'roots.pathRequired': 'Enter an absolute path.',
      'roots.limit': 'Up to 16 sync folders.',
      'roots.excludeLimit': 'Up to 50 exclude entries.',

      'peer.heading': 'Peer pairing',
      'peer.intro': 'On another device, add a peer target with the URL and Token below. Share only with trusted devices.',
      'peer.url': 'Server URL',
      'peer.token': 'Pairing Token',
      'peer.codeHeading': 'One-paste pairing',
      'peer.codeHint': 'The pairing code contains credentials. Share it only with trusted devices; pasting it adds a target and syncs immediately.',
      'peer.copyCode': 'Copy this device code',
      'peer.codePlaceholder': 'Click "Copy this device code" to generate',
      'peer.pasteLabel': "Paste the other device's code",
      'peer.pastePlaceholder': 'DSHSYNC1....',
      'peer.pairButton': 'Connect and sync',
      'peer.pairSynced': 'Connected {target}; sync finished',
      'peer.pairFailed': 'Pairing failed: {error}',
      'peer.copyUrl': 'Copy URL',
      'peer.copyToken': 'Copy Token',
      'peer.unavailable': 'The Host did not provide pairing details.',
      'peer.securityNote': 'The Token is a credential; keep it safe.',

      'transfer.heading': 'Import / export',
      'transfer.intro': 'Export produces a .dshsync archive; import merges an archive as a remote snapshot.',
      'transfer.export': 'Export archive',
      'transfer.exporting': 'Exporting…',
      'transfer.exportFull': 'Full backup (workspaces + chats)',
      'transfer.exportFulling': 'Packing…',
            'transfer.exportFullSkipped': '{base} Skipped workspaces over the size budget: {names}. Raise the archive limit and retry if needed.',
'transfer.exportFullHint': 'Pack DSH workspace files together with conversation history for device migration or data rescue. Huge files and system directories are skipped automatically.',
  'transfer.exportApp': 'Full app data',
  'transfer.pruneFailed': 'Cloud reclaim failed',
  'transfer.prune': 'Reclaim cloud space',
  'transfer.pruneHint': 'Delete old objects that no device manifest references any more (every edit stores another copy; old ones pile up). Preview first, then confirm.',
  'transfer.pruneDryRun': 'Preview reclaimable space',
  'transfer.pruneConfirm': 'Delete {n} objects ({size})',
  'transfer.pruneResult': '{objects} objects in cloud, {referenced} referenced; reclaimable {n} / {size}.',
  'transfer.pruneDone': 'Deleted {n} objects, freed {size} ({rate}).',
  'transfer.dedupeSaved': '{size} saved by dedupe',
  'transfer.pruneRunning': 'Reclaiming…',
  'transfer.exportAppHint': 'Pack the DSH application data itself (sessions, settings, plugin activation, account credentials, your own linked plugin sources). Install dependencies once on the new device and it behaves like this one. node_modules and cached binaries are excluded.',
      'transfer.missingUrl': 'The export response did not include a download URL.',
      'transfer.exportDone': 'Created {name} ({size}).',
      'transfer.import': 'Import archive',
      'transfer.importing': 'Importing…',
      'transfer.importPick': 'Choose a .dshsync file',
      'transfer.importDone': 'Import finished: written {imported} · unchanged {unchanged} · conflict copies {conflicts} · skipped {skipped} · errors {errors}.',
      'transfer.importHint': 'Only .dshsync files; archives beyond the Host limit are rejected.',
      'transfer.importInvalidType': 'Choose a .dshsync archive.',
      'transfer.importTooLarge': 'File exceeds 512 MiB; import cancelled.',

      'logs.heading': 'Activity log',
      'logs.empty': 'No activity yet.',
      'logs.conflictsHeading': 'Conflicts',
      'logs.conflictsEmpty': 'No conflicts yet.',
      'logs.conflictItem': '{key} → {copy}',
      'logs.reason': 'Reason: {reason}',
      'logs.level.info': 'Info',
      'logs.level.warn': 'Warning',
      'logs.level.error': 'Error',

      'footer.note': 'All data is read and written through the local /dsh-sync HTTP API; passwords and Tokens are never echoed to the page.',
    }

    // ---------------------------------------------------------------------
    // 样式：仅使用 --dsw-alias-* token；窄屏下字段与操作区单列。
    // ---------------------------------------------------------------------
    const CSS = `
.dsync-section{display:flex;flex-direction:column;gap:16px;padding-bottom:8px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dsync-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dsync-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dsync-intro{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;max-width:720px}
.dsync-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:14px;min-width:0}
.dsync-cardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsync-cardTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}
.dsync-cardIntro{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:680px}
.dsync-cardActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsync-item{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);padding:14px 16px;display:flex;flex-direction:column;gap:12px;min-width:0}
.dsync-item--new{border-style:dashed}
.dsync-itemHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsync-itemTitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:500}
.dsync-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsync-metaRow{margin:0}
.dsync-meta{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-all}
.dsync-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.dsync-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsync-fieldLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsync-input,.dsync-textarea,.dsync-select{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:6px 9px;font:inherit;font-size:13px;line-height:20px;min-width:0}
.dsync-textarea{min-height:76px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px}
.dsync-input:focus,.dsync-textarea:focus,.dsync-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsync-input:disabled,.dsync-textarea:disabled,.dsync-select:disabled{opacity:.55;cursor:default}
.dsync-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;word-break:break-word}
.dsync-hint--warn{color:var(--dsw-alias-state-warn-primary)}
.dsync-inlineMsg{margin:0;font-size:12px;line-height:18px;word-break:break-word}
.dsync-inlineMsg--ok{color:var(--dsw-alias-state-success-primary)}
.dsync-inlineMsg--error{color:var(--dsw-alias-state-error-primary)}
.dsync-inlineMsg--warn{color:var(--dsw-alias-state-warn-primary)}
.dsync-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px}
.dsync-confirmText{color:var(--dsw-alias-state-warn-primary)}
.dsync-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsync-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 13px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.dsync-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsync-btn:disabled{opacity:.5;cursor:default}
.dsync-btn--primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsync-btn--danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsync-btn--text{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dsync-btn--text:hover:not(:disabled){color:var(--dsw-alias-brand-primary)}
.dsync-switchRow--compact{padding:4px 8px;background:transparent}
.dsync-switchRow{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base)}
.dsync-switch{flex:none;width:16px;height:16px;margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.dsync-switchText{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsync-switchLabel{font-size:13px;line-height:20px}
.dsync-switchHint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsync-switchGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.dsync-chip{display:inline-flex;align-items:center;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);padding:0 8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsync-chip--ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsync-chip--warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsync-chip--error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsync-quickHead{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.dsync-quickHead>.dsync-chip{max-width:100%;overflow:hidden;text-overflow:ellipsis}
.dsync-chips{display:flex;flex-wrap:wrap;gap:6px}
.dsync-chips>.dsync-chip{animation:dsync-fadeIn .18s ease-out both}
.dsync-chip--speed{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}
.dsync-chip--busy{border-color:var(--dsw-alias-brand-primary,var(--dsw-alias-border-l2));color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-secondary));animation:dsync-breathe 1.8s ease-in-out infinite}
.dsync-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block;margin-right:6px;animation:dsync-pulse 1.1s ease-in-out infinite}
.dsync-syncbar{height:3px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;margin:8px 0 2px}
.dsync-syncbarFill{display:block;height:100%;width:38%;border-radius:999px;background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-success-primary));animation:dsync-slide 1.15s ease-in-out infinite}
@keyframes dsync-fadeIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
@keyframes dsync-breathe{0%,100%{opacity:1}50%{opacity:.62}}
@keyframes dsync-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.72);opacity:.55}}
@keyframes dsync-slide{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}
@media (prefers-reduced-motion: reduce){
.dsync-chips>.dsync-chip,.dsync-chip--busy,.dsync-dot,.dsync-syncbarFill{animation:none}
.dsync-syncbarFill{width:100%}
}
.dsync-notice{box-sizing:border-box;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-left-width:3px;border-radius:8px;padding:9px 12px;font-size:13px;line-height:20px;background:var(--dsw-alias-bg-layer-1)}
.dsync-warnText{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsync-warnTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-state-warn-primary)}
.dsync-warnList{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsync-warnList li{word-break:break-word}
.dsync-notice--ok{border-left-color:var(--dsw-alias-state-success-primary)}
.dsync-notice--warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.dsync-notice--error{border-left-color:var(--dsw-alias-state-error-primary)}
.dsync-empty{margin:0;padding:14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.dsync-loading{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-secondary)}
.dsync-spinner{width:18px;height:18px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:dsync-spin .9s linear infinite}
@keyframes dsync-spin{to{transform:rotate(360deg)}}
.dsync-copyRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsync-textarea{min-height:64px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dsync-copyRow .dsync-input{flex:1 1 260px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dsync-logList{display:flex;flex-direction:column;max-height:300px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.dsync-logRow{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}
.dsync-logRow:last-child{border-bottom:none}
.dsync-logTime{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsync-logMsg{min-width:0;word-break:break-word}
.dsync-conflict{display:flex;flex-direction:column;gap:2px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:18px}
.dsync-conflict:last-child{border-bottom:none}
.dsync-conflictKey{word-break:break-all}
.dsync-conflictMeta{color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsync-transfer{display:flex;flex-direction:column;gap:10px}
.dsync-hidden{display:none}
.dsync-footer{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;max-width:720px}
.dsync-syncActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsync-settingsRow{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.dsync-settingsRow .dsync-field{flex:1 1 240px}
@media (max-width:640px){
  .dsync-card{padding:14px}
  .dsync-head{flex-direction:column}
  .dsync-grid{grid-template-columns:1fr}
  .dsync-switchGrid{grid-template-columns:1fr}
  .dsync-syncActions{flex-direction:column;align-items:stretch}
  .dsync-syncActions .dsync-btn{width:100%}
  .dsync-copyRow .dsync-input{flex-basis:100%}
}
`

    // ---------------------------------------------------------------------
    // 通用小工具
    // ---------------------------------------------------------------------

    /** 把未知异常压成可展示文本。 */
    function errorText(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    /** 安全读取字符串字段。 */
    function textOf(value) {
      return typeof value === 'string' ? value : ''
    }

    /** 判定某字段是否被 Host 用掩码占位。 */
    function isMasked(value) {
      return value === '***'
    }

    /** 数字时间戳 → 本地时间文本；无效值返回 null。 */
    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
      try {
        return new Date(value).toLocaleString()
      } catch {
        return String(value)
      }
    }

    /** 字节数 → 人类可读大小。 */
    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB'
      return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    }

    /** 排除项 textarea ↔ 数组。 */
    function splitExclude(value) {
      return textOf(value)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    }

    /** 新 id：类型/名称前缀 + 随机后缀，避开已有 id。 */
    function freshId(prefix, taken) {
      const base = (prefix || 'item').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
      let candidate = base + '-' + Math.random().toString(36).slice(2, 8)
      let index = 1
      while (taken.indexOf(candidate) >= 0) {
        candidate = base + '-' + Math.random().toString(36).slice(2, 8) + '-' + index
        index += 1
      }
      return candidate
    }

    /** target 配置草稿 → 仅含契约字段的 POST 负载。 */
    function targetConfigOf(target) {
      const type = target && target.type ? target.type : 'local'
      const config = {
        id: textOf(target && target.id),
        type,
        label: textOf(target && target.label),
        enabled: !(target && target.enabled === false),
      }
      if (type === 'local') {
        config.path = textOf(target && target.path)
      } else if (type === 'webdav') {
        config.url = textOf(target && target.url)
        config.username = textOf(target && target.username)
        config.password = textOf(target && target.password)
        config.basePath = textOf(target && target.basePath)
      } else if (type === 'peer') {
        config.url = textOf(target && target.url)
        config.token = textOf(target && target.token)
      }
      return config
    }

    /** root 配置草稿 → 仅含契约字段的 POST 负载。 */
    function rootConfigOf(root) {
      return {
        id: textOf(root && root.id),
        label: textOf(root && root.label),
        path: textOf(root && root.path),
        enabled: !(root && root.enabled === false),
        exclude: Array.isArray(root && root.exclude) ? root.exclude.slice() : [],
      }
    }

    /** 表单草稿：密文字段留空，掩码状态单独记。 */
    function draftOfTarget(target) {
      const type = target && target.type ? target.type : 'local'
      return {
        type,
        label: textOf(target && target.label),
        enabled: !(target && target.enabled === false),
        path: textOf(target && target.path),
        url: textOf(target && target.url),
        username: textOf(target && target.username),
        password: isMasked(target && target.password) ? '' : textOf(target && target.password),
        basePath: textOf(target && target.basePath),
        token: isMasked(target && target.token) ? '' : textOf(target && target.token),
      }
    }

    /**
     * 由草稿生成可提交的 target。未触碰的掩码密文回传 "***"，
     * 由 Host 解释为“保持原值”（已在协作消息中与 Lead 对齐）。
     */
    function buildTargetPayload(draft, touched, base) {
      const payload = {
        id: textOf(base && base.id),
        type: draft.type,
        label: textOf(draft.label).trim(),
        enabled: draft.enabled !== false,
      }
      if (draft.type === 'local') {
        payload.path = textOf(draft.path).trim()
      } else if (draft.type === 'webdav') {
        payload.url = textOf(draft.url).trim()
        payload.username = textOf(draft.username)
        if (touched.password || !isMasked(base && base.password)) payload.password = textOf(draft.password)
        else payload.password = '***'
        payload.basePath = textOf(draft.basePath).trim()
      } else if (draft.type === 'peer') {
        payload.url = textOf(draft.url).trim()
        if (touched.token || !isMasked(base && base.token)) payload.token = textOf(draft.token)
        else payload.token = '***'
      }
      return payload
    }

    /** 只比较可提交字段，忽略展示字段。 */
    function sameTarget(a, b) {
      return JSON.stringify(a) === JSON.stringify(b)
    }

    /** 新建 target 的初始草稿。 */
    function emptyTargetDraft(type) {
      return {
        type,
        label: '',
        enabled: true,
        path: '',
        url: '',
        username: '',
        password: '',
        basePath: '/dsh-sync',
        token: '',
      }
    }

    /** root 草稿（与 draftOfTarget 对应）。 */
    function draftOfRoot(root) {
      return {
        label: textOf(root && root.label),
        enabled: !(root && root.enabled === false),
        path: textOf(root && root.path),
        exclude: Array.isArray(root && root.exclude) ? root.exclude.join('\n') : '',
      }
    }

    /** 新建 root 的初始草稿。 */
    function emptyRootDraft() {
      return { label: '', path: '', enabled: true, exclude: '' }
    }

    /** 校验 URL 形态，保持宽松：只要求 http(s) 前缀。 */
    function isHttpUrl(value) {
      return /^https?:\/\//i.test(textOf(value).trim())
    }

    /** HTTP header 只允许可见 ASCII；非 ASCII 文件名退回百分号编码。 */
    function headerFileName(name) {
      const value = textOf(name)
      return /^[\x20-\x7e]+$/.test(value) ? value : encodeURIComponent(value)
    }

    /** 校验整数间隔（上下限与 Host normalizeConfig 对齐）。 */
    function parseInterval(value, min, max) {
      const parsed = Number(textOf(value).trim())
      if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null
      return parsed
    }

    /** GET/POST JSON，并统一错误语义（非 2xx 或 ok:false 都抛错）。 */
    async function requestJson(path, init) {
      const response = await fetch(API_BASE + path, {
        credentials: 'same-origin',
        ...init,
        headers: withUiToken(init && init.headers),
      })
      let payload = null
      const raw = await response.text()
      if (raw) {
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = null
        }
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' && payload.error ? payload.error : response.status + ' ' + response.statusText
        throw new Error(message)
      }
      if (!payload || payload.ok !== true) {
        const message = payload && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
        throw new Error(message)
      }
      return payload
    }

    /**
     * 宽松 JSON 请求：HTTP 2xx 即返回 payload。
     * 用于 /test（ok:false 表示连接失败，但仍带 detail）与 /sync、/import（可能带报告）。
     */
    async function requestPayload(path, init) {
      const response = await fetch(API_BASE + path, {
        credentials: 'same-origin',
        ...init,
        headers: withUiToken(init && init.headers),
      })
      let payload = null
      const raw = await response.text()
      if (raw) {
        try {
          payload = JSON.parse(raw)
        } catch {
          payload = null
        }
      }
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' && payload.error ? payload.error : response.status + ' ' + response.statusText
        throw new Error(message)
      }
      if (!payload || typeof payload !== 'object') throw new Error('invalid response payload')
      return payload
    }

    /** Host 返回的 status 归一化，避免缺字段直接崩 UI。 */
    function normalizeStatus(raw) {
      if (!raw || typeof raw !== 'object') throw new Error('invalid status payload')
      return {
        ...raw,
        deviceId: textOf(raw.deviceId),
        deviceName: textOf(raw.deviceName),
        autoSync: raw.autoSync !== false,
        autoSave: raw.autoSave !== false,
        syncOnStart: raw.syncOnStart !== false,
        autoSaveIntervalSeconds: Number(raw.autoSaveIntervalSeconds) || 20,
        autoSyncIntervalSeconds: Number(raw.autoSyncIntervalSeconds) || 180,
        concurrency: Number(raw.concurrency) || 4,
        compressObjects: raw.compressObjects !== false,
        roots: Array.isArray(raw.roots) ? raw.roots.slice() : [],
        targets: Array.isArray(raw.targets) ? raw.targets.slice() : [],
        logs: Array.isArray(raw.logs) ? raw.logs.slice() : [],
        conflicts: Array.isArray(raw.conflicts) ? raw.conflicts.slice() : [],
        peer: raw.peer && typeof raw.peer === 'object' ? raw.peer : null,
        busy: raw.busy === true,
      }
    }

    /** 判断 POST /config 的响应是否直接就是新 status。 */
    function looksLikeStatus(payload) {
      return Boolean(payload && typeof payload === 'object' && Array.isArray(payload.targets) && typeof payload.deviceId === 'string')
    }

    /** level → 本地化标签。 */
    function levelLabel(t, level) {
      if (level === 'warn') return t('logs.level.warn')
      if (level === 'error') return t('logs.level.error')
      return t('logs.level.info')
    }

    /** type → 本地化类型标签。 */
    function typeLabel(t, type) {
      if (type === 'webdav') return t('targets.typeWebdav')
      if (type === 'peer') return t('targets.typePeer')
      return t('targets.typeLocal')
    }

    // ---------------------------------------------------------------------
    // 基础视图组件
    // ---------------------------------------------------------------------

    function Card({ title, intro, actions, children }) {
      return h(
        'section',
        { className: 'dsync-card' },
        h(
          'div',
          { className: 'dsync-cardHead' },
          h(
            'div',
            { className: 'dsync-cardText' },
            h('h3', { className: 'dsync-cardTitle' }, title),
            intro ? h('p', { className: 'dsync-cardIntro' }, intro) : null,
          ),
          actions ? h('div', { className: 'dsync-cardActions' }, actions) : null,
        ),
        children,
      )
    }

    function Field({ label, htmlFor, hint, hintTone, children }) {
      return h(
        'div',
        { className: 'dsync-field' },
        label ? h('label', { className: 'dsync-fieldLabel', htmlFor }, label) : null,
        children,
        hint ? h('p', { className: hintTone ? 'dsync-hint dsync-hint--' + hintTone : 'dsync-hint' }, hint) : null,
      )
    }

    function Switch({ checked, disabled, label, hint, onChange }) {
      return h(
        'label',
        { className: 'dsync-switchRow' },
        h('input', {
          type: 'checkbox',
          className: 'dsync-switch',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event.target.checked),
        }),
        h(
          'span',
          { className: 'dsync-switchText' },
          h('span', { className: 'dsync-switchLabel' }, label),
          hint ? h('span', { className: 'dsync-switchHint' }, hint) : null,
        ),
      )
    }

    function Empty({ text }) {
      return h('p', { className: 'dsync-empty' }, text)
    }

    /** 危险按钮的二次确认：第二次点击才执行，避免原生 confirm 与宿主样式割裂。 */
    function DeleteControl({ t, disabled, label, message, onConfirm }) {
      const [arming, setArming] = React.useState(false)
      if (arming) {
        return h(
          'span',
          { className: 'dsync-confirm' },
          h('span', { className: 'dsync-confirmText' }, message),
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn dsync-btn--danger',
              disabled: disabled === true,
              onClick: () => {
                setArming(false)
                onConfirm()
              },
            },
            t('common.confirmDelete'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn dsync-btn--text',
              disabled: disabled === true,
              onClick: () => setArming(false),
            },
            t('common.cancel'),
          ),
        )
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'dsync-btn dsync-btn--danger',
          disabled: disabled === true,
          onClick: () => setArming(true),
        },
        label,
      )
    }

    // ---------------------------------------------------------------------
    // 状态卡：设备名、自动同步/保存、间隔、三个同步按钮、上次结果
    // ---------------------------------------------------------------------

    /**
     * WebDAV 快速开始卡：只要求地址 / 账号 / 应用密码。
     *
     * 易用性约定（1.6.0）：
     * - 已在页面**最底部**且**默认折叠**：只有一行摘要 + 展开按钮，避免老用户每次都被大表单挡住。
     * - 首次进入且尚无 WebDAV target 时**默认展开**，新用户不需要先找按钮。
     * - 折叠态判定只做一次（等 status 真正到达），否则首帧 status 为空会把默认值定成“展开”。
     * - 成功后记住地址/账号，密码位显示 `***`（后端把 `***` 还原为已存密码），不显示明文。
     */
    function WebdavQuickCard({ t, status, busy, pending, onConnect }) {
      const [url, setUrl] = React.useState('')
      const [username, setUsername] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [error, setError] = React.useState('')
      const [result, setResult] = React.useState(null)
      // 默认折叠状态要等 status 到达后才能定，因此先给 null 表示“还没判定”。
      const [expanded, setExpanded] = React.useState(null)
      const initializedRef = React.useRef(false)
      const prefilledRef = React.useRef('')

      const targets = status && Array.isArray(status.targets) ? status.targets : []
      const webdavTarget = targets.find((target) => target && target.type === 'webdav' && target.enabled !== false)
        || targets.find((target) => target && target.type === 'webdav')
        || null
      const savedUrl = textOf(webdavTarget && webdavTarget.url)
      const savedUsername = textOf(webdavTarget && webdavTarget.username)
      const hasSaved = Boolean(savedUrl)

      // 只在 status 首次可用时判定一次默认展开态，之后不再覆盖用户手动操作。
      React.useEffect(() => {
        if (initializedRef.current || !status || expanded !== null) return
        initializedRef.current = true
        setExpanded(!hasSaved)
      }, [status, expanded, hasSaved])

      // 预填已保存的地址/账号：按 target 身份去重，避免每次 status 刷新都覆盖用户正在编辑的输入。
      React.useEffect(() => {
        if (!hasSaved) return
        const key = savedUrl + '\u0000' + savedUsername
        if (prefilledRef.current === key) return
        prefilledRef.current = key
        setUrl(savedUrl)
        setUsername(savedUsername)
        // 密码只在“尚未输入过”时用掩码占位；已有输入不覆盖。
        setPassword((current) => (current === '' ? '***' : current))
      }, [hasSaved, savedUrl, savedUsername])

      const submitting = pending === 'quick-connect'
      const disabled = busy || submitting
      // 尚未判定（status 未到）时按“展开”渲染并禁用切换：
      // 若此时渲染成折叠，新用户会先看到“已配置”的错觉，比短暂闪现表单更误导。
      const undecided = expanded === null
      const isOpen = undecided ? true : expanded === true

      const submit = async () => {
        setError('')
        setResult(null)
        const nextUrl = url.trim()
        const nextUsername = username.trim()
        // 已有保存的 WebDAV 时，密码留空或保持 `***` 都表示沿用原密码。
        const nextPassword = password === '' || password === '***' ? (hasSaved ? '***' : '') : password
        if (nextUrl === '' || nextUsername === '' || nextPassword === '') {
          setError(t('quick.required'))
          return
        }
        try {
          const data = await onConnect({
            type: 'webdav',
            label: 'WebDAV',
            url: nextUrl,
            username: nextUsername,
            password: nextPassword,
            // 已有 target 时沿用其子路径（可能是自定义的），否则用默认 /dsh-sync。
            basePath: textOf(webdavTarget && webdavTarget.basePath) || '/dsh-sync',
            sync: true,
          })
          const report = data && data.report && Array.isArray(data.report.reports) ? data.report.reports[0] : null
          if (data && data.test && data.test.ok === false) {
            setResult({ ok: false, text: t('quick.testFailed', { detail: textOf(data.test.detail) || t('common.none') }) })
            return
          }
          if (data && data.error) {
            setResult({ ok: false, text: textOf(data.error) })
            return
          }
          setResult({
            ok: true,
            text: t('quick.synced', {
              target: textOf(data && data.target && data.target.label) || 'WebDAV',
              pushed: report?.pushed ?? 0,
              pulled: report?.pulled ?? 0,
              conflicts: report?.conflicts ?? 0,
              errors: report?.errors ?? 0,
            }),
          })
          // 成功后自动收起，并保留地址/账号；密码位回到掩码（后端已保存真实密码）。
          setUrl(nextUrl)
          setUsername(nextUsername)
          setPassword('***')
          setExpanded(false)
        } catch (failure) {
          setError(errorText(failure))
        }
      }

      const summary = hasSaved
        ? t('quick.summary', { url: savedUrl, username: savedUsername || t('common.none') })
        : t('quick.summaryUnknown')

      const panelId = 'dsync-quick-panel'

      return h(
        Card,
        { title: t('quick.heading'), intro: isOpen ? t('quick.intro') : null },
        h(
          'div',
          { className: 'dsync-quickHead' },
          undecided
            ? null
            : h(
                'span',
                {
                  className: 'dsync-chip ' + (hasSaved ? 'dsync-chip--ok' : ''),
                  title: hasSaved ? t('quick.toggleHint') : undefined,
                },
                summary,
              ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn dsync-btn--text',
              'aria-expanded': isOpen,
              'aria-controls': panelId,
              disabled: undecided,
              onClick: () => setExpanded(!isOpen),
            },
            isOpen ? t('quick.collapse') : t('quick.expand'),
          ),
        ),
        // 折叠时整体不渲染表单：避免隐藏字段仍能被 Tab 聚焦。
        isOpen
          ? h(
              'div',
              { id: panelId },
              h(
                Field,
                { label: t('quick.url'), htmlFor: 'dsync-quick-url' },
                h('input', {
                  id: 'dsync-quick-url',
                  className: 'dsync-input',
                  type: 'text',
                  value: url,
                  placeholder: t('targets.urlPlaceholderWebdav'),
                  disabled,
                  onChange: (event) => setUrl(event.target.value),
                }),
              ),
              h(
                Field,
                { label: t('quick.username'), htmlFor: 'dsync-quick-username' },
                h('input', {
                  id: 'dsync-quick-username',
                  className: 'dsync-input',
                  type: 'text',
                  value: username,
                  autoComplete: 'username',
                  disabled,
                  onChange: (event) => setUsername(event.target.value),
                }),
              ),
              h(
                Field,
                {
                  label: t('quick.password'),
                  htmlFor: 'dsync-quick-password',
                  hint: hasSaved ? t('quick.savedPasswordKeep') : t('quick.passwordHint'),
                },
                h('input', {
                  id: 'dsync-quick-password',
                  className: 'dsync-input',
                  type: 'password',
                  value: password,
                  autoComplete: 'new-password',
                  disabled,
                  onChange: (event) => setPassword(event.target.value),
                }),
              ),
              error ? h('p', { className: 'dsync-inlineMsg dsync-inlineMsg--error', role: 'alert' }, error) : null,
              result
                ? h('p', { className: 'dsync-inlineMsg ' + (result.ok ? 'dsync-inlineMsg--ok' : 'dsync-inlineMsg--error') }, result.text)
                : null,
              h(
                'div',
                { className: 'dsync-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsync-btn dsync-btn--primary',
                    disabled,
                    onClick: submit,
                  },
                  submitting ? t('state.busy') : t('quick.submit'),
                ),
              ),
            )
          : // 折叠时仍保留一个空容器，让 aria-controls 指向真实存在的节点。
            h('div', { id: panelId, hidden: true }),
      )
    }

    function StatusCard({ t, status, busy, pending, onToggleConfig, onSaveSettings, onSync, reports }) {
      const [draft, setDraft] = React.useState(() => ({
        deviceName: status.deviceName,
        autoSaveIntervalSeconds: String(status.autoSaveIntervalSeconds),
        autoSyncIntervalSeconds: String(status.autoSyncIntervalSeconds),
        concurrency: String(status.concurrency),
      }))
      const [error, setError] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      // 同步中的已用秒数：让“正在传”有可见的时间推进，而不是一个静止的按钮。
      const [elapsedSeconds, setElapsedSeconds] = React.useState(0)
      React.useEffect(() => {
        if (!busy) {
          setElapsedSeconds(0)
          return undefined
        }
        const startedAt = Date.now()
        const timer = setInterval(() => {
          setElapsedSeconds(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
        }, 1000)
        return () => clearInterval(timer)
      }, [busy])

      const enabledTargets = status.targets.filter((target) => target.enabled !== false)
      // status 顶层可能不带 lastSyncAt/lastResult（SPEC §7 只定义在 targets[] 内），
      // 因此这里从各 target 派生：时间取最大，结果按各目标合计。
      const targetSyncTimes = status.targets
        .map((target) => Number(target.lastSyncAt))
        .filter((value) => Number.isFinite(value) && value > 0)
      const topSyncTime = Number(status.lastSyncAt)
      const lastSync = formatTime(Number.isFinite(topSyncTime) && topSyncTime > 0 ? topSyncTime : targetSyncTimes.length > 0 ? Math.max(...targetSyncTimes) : 0)
      const targetResults = status.targets
        .map((target) => target.lastResult)
        .filter((result) => result && typeof result === 'object')
      let lastResult = status.lastResult && typeof status.lastResult === 'object' ? status.lastResult : null
      let resultCombined = false
      if (!lastResult && targetResults.length > 0) {
        resultCombined = true
        lastResult = targetResults.reduce(
          (accumulator, result) => {
            accumulator.ok = accumulator.ok && result.ok !== false
            ;['pushed', 'pulled', 'deletedLocal', 'tombstoned', 'conflicts', 'skipped', 'errors', 'skippedUploads'].forEach((field) => {
              accumulator[field] += Number(result[field]) || 0
            })
            accumulator.durationMs = Math.max(accumulator.durationMs, Number(result.durationMs) || 0)
            accumulator.bytesPerSecond = Math.max(accumulator.bytesPerSecond, Number(result.bytesPerSecond) || 0)
            return accumulator
          },
          { ok: true, pushed: 0, pulled: 0, deletedLocal: 0, tombstoned: 0, conflicts: 0, skipped: 0, errors: 0, skippedUploads: 0, durationMs: 0, bytesPerSecond: 0 },
        )
      }

      const dirty =
        draft.deviceName.trim() !== status.deviceName ||
        parseInterval(draft.autoSaveIntervalSeconds, 5, 3600) !== status.autoSaveIntervalSeconds ||
        parseInterval(draft.autoSyncIntervalSeconds, 15, 86400) !== status.autoSyncIntervalSeconds ||
        parseInterval(draft.concurrency, 1, 16) !== status.concurrency

      const toggle = (field, next) => {
        setError('')
        Promise.resolve(onToggleConfig(field, next)).catch((failure) => setError(errorText(failure)))
      }

      const submitSettings = async () => {
        setError('')
        if (draft.deviceName.trim().length === 0) {
          setError(t('status.deviceNameRequired'))
          return
        }
        const autoSaveIntervalSeconds = parseInterval(draft.autoSaveIntervalSeconds, 5, 3600)
        if (autoSaveIntervalSeconds === null) {
          setError(t('status.autoSaveIntervalInvalid'))
          return
        }
        const autoSyncIntervalSeconds = parseInterval(draft.autoSyncIntervalSeconds, 15, 86400)
        if (autoSyncIntervalSeconds === null) {
          setError(t('status.autoSyncIntervalInvalid'))
          return
        }
        const concurrency = parseInterval(draft.concurrency, 1, 16)
        if (concurrency === null) {
          setError(t('status.concurrencyInvalid'))
          return
        }
        setSaving(true)
        try {
          const next = await onSaveSettings({
            deviceName: draft.deviceName.trim(),
            autoSaveIntervalSeconds,
            autoSyncIntervalSeconds,
            concurrency,
          })
          if (next && typeof next === 'object') {
            setDraft({
              deviceName: textOf(next.deviceName),
              autoSaveIntervalSeconds: String(next.autoSaveIntervalSeconds),
              autoSyncIntervalSeconds: String(next.autoSyncIntervalSeconds),
              concurrency: String(Number(next.concurrency) || 4),
            })
          }
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setSaving(false)
        }
      }

      const runSyncButton = (mode) => {
        setError('')
        Promise.resolve(onSync(mode)).catch((failure) => setError(errorText(failure)))
      }

      const lastResultChips = []
      if (lastResult) {
        lastResultChips.push(
          h(
            'span',
            {
              key: 'ok',
              className: lastResult.ok === false ? 'dsync-chip dsync-chip--warn' : 'dsync-chip dsync-chip--ok',
            },
            lastResult.ok === false ? t('status.resultFailed') : t('status.resultOk'),
          ),
        )
        ;['pushed', 'pulled', 'deletedLocal', 'tombstoned', 'conflicts', 'skipped', 'skippedUploads', 'errors'].forEach((field) => {
          const count = Number(lastResult[field]) || 0
          if (count > 0) {
            lastResultChips.push(h('span', { className: 'dsync-chip', key: field }, t('status.' + field, { n: count })))
          }
        })
        if (Number.isFinite(lastResult.durationMs) && lastResult.durationMs > 0) {
          lastResultChips.push(h('span', { key: 'duration', className: 'dsync-chip' }, t('status.duration', { ms: lastResult.durationMs })))
        }
        // 去重省下的真实字节：用户要能验证"到底省了多少流量"。
        if (Number.isFinite(lastResult.dedupeSavedBytes) && lastResult.dedupeSavedBytes > 0) {
          lastResultChips.push(
            h('span', { key: 'dedupe', className: 'dsync-chip dsync-chip--dedupe' },
              t('transfer.dedupeSaved', { size: formatBytes(lastResult.dedupeSavedBytes) })),
          )
        }
        // 吞吐量：让“上传变快了多少”在界面上可见，而不是只能凭感觉。
        if (Number.isFinite(lastResult.bytesPerSecond) && lastResult.bytesPerSecond > 0) {
          lastResultChips.push(
            h('span', { key: 'throughput', className: 'dsync-chip' }, t('status.throughput', { rate: formatBytes(lastResult.bytesPerSecond) })),
          )
        }
      }

      // 网速小 tag：同步中显示呼吸点 + 已用时间；空闲时显示上次的实传字节与平均速率。
      const speedTag = (() => {
        if (busy) {
          const live = status.progress
          const up = Number(live && live.upBytesPerSecond) || 0
          const down = Number(live && live.downBytesPerSecond) || 0
          // 有实时字节就先报速率；还没有字节（扫描阶段）时只报已用时间，不编造 0/s。
          const text =
            up > 0 || down > 0
              ? t('status.syncingFor', { seconds: elapsedSeconds }) +
                ' · ' +
                t('status.liveSpeed', { up: formatBytes(up) || '0 B', down: formatBytes(down) || '0 B' })
              : t('status.syncingFor', { seconds: elapsedSeconds })
          return h(
            'span',
            {
              className: 'dsync-chip dsync-chip--busy',
              key: 'speed',
              title: up > 0 || down > 0 ? t('status.liveSpeedHint') : t('status.syncingAria'),
            },
            h('span', { className: 'dsync-dot', 'aria-hidden': 'true' }),
            text,
          )
        }
        const wireBytes = Number(lastResult && lastResult.wireBytesUp) || 0
        const wireDown = Number(lastResult && lastResult.wireBytesDown) || 0
        const rate = Number(lastResult && lastResult.bytesPerSecond) || 0
        if (wireBytes <= 0 && wireDown <= 0 && rate <= 0) return null
        // 有下载量时把双向都报出来：只报 ↑ 会让人以为下载没走网络。
        const text =
          wireDown > 0
            ? t('status.speedLineBoth', {
                upSize: formatBytes(wireBytes) || '0 B',
                downSize: formatBytes(wireDown) || '0 B',
                rate: formatBytes(rate) || '0 B',
              })
            : t('status.speedLine', { size: formatBytes(wireBytes), rate: formatBytes(rate) })
        return h(
          'span',
          { className: 'dsync-chip dsync-chip--speed', key: 'speed', title: t('status.speedHint') },
          text,
        )
      })()

      return h(
        Card,
        { title: t('status.heading'), intro: t('status.intro') || null },
        h(
          'div',
          { className: 'dsync-metaRow dsync-chips' },
          h('span', { className: 'dsync-chip dsync-chip--ok' }, t('status.deviceLine', { name: status.deviceName || t('common.none') })),
          h('span', { className: 'dsync-chip' }, t('status.lastSyncLine', { time: lastSync || t('common.never') })),
          speedTag,
        ),
        // 不定进度条：同步期间给出“在进行”的动感，不谎报百分比（没有逐字节进度事件）。
        busy
          ? h(
              'div',
              {
                className: 'dsync-syncbar',
                role: 'progressbar',
                'aria-label': t('status.syncingAria'),
                'aria-valuetext': t('status.syncingFor', { seconds: elapsedSeconds }),
              },
              h('span', { className: 'dsync-syncbarFill', 'aria-hidden': 'true' }),
            )
          : null,
        h(
          'div',
          { className: 'dsync-settingsRow' },
          h(
            Field,
            { label: t('status.deviceName'), htmlFor: 'dsync-device-name', hint: t('status.deviceNameHint') },
            h('input', {
              id: 'dsync-device-name',
              className: 'dsync-input',
              type: 'text',
              value: draft.deviceName,
              disabled: busy || saving,
              onChange: (event) => setDraft({ ...draft, deviceName: event.target.value }),
            }),
          ),
          h(
            Field,
            { label: t('status.autoSaveInterval'), htmlFor: 'dsync-auto-save-interval', hint: t('status.autoSaveIntervalHint') },
            h('input', {
              id: 'dsync-auto-save-interval',
              className: 'dsync-input',
              type: 'number',
              min: 5,
              max: 3600,
              step: 1,
              value: draft.autoSaveIntervalSeconds,
              disabled: busy || saving,
              onChange: (event) => setDraft({ ...draft, autoSaveIntervalSeconds: event.target.value }),
            }),
          ),
          h(
            Field,
            { label: t('status.autoSyncInterval'), htmlFor: 'dsync-auto-sync-interval', hint: t('status.autoSyncIntervalHint') },
            h('input', {
              id: 'dsync-auto-sync-interval',
              className: 'dsync-input',
              type: 'number',
              min: 15,
              max: 86400,
              step: 1,
              value: draft.autoSyncIntervalSeconds,
              disabled: busy || saving,
              onChange: (event) => setDraft({ ...draft, autoSyncIntervalSeconds: event.target.value }),
            }),
          ),
          h(
            Field,
            { label: t('status.concurrency'), htmlFor: 'dsync-concurrency', hint: t('status.concurrencyHint') },
            h('input', {
              id: 'dsync-concurrency',
              className: 'dsync-input',
              type: 'number',
              min: 1,
              max: 16,
              step: 1,
              value: draft.concurrency,
              disabled: busy || saving,
              onChange: (event) => setDraft({ ...draft, concurrency: event.target.value }),
            }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn dsync-btn--primary',
              disabled: busy || saving || !dirty,
              onClick: submitSettings,
            },
            saving ? t('common.saving') : t('status.saveSettings'),
          ),
        ),
        h(
          'div',
          { className: 'dsync-switchGrid' },
          h(Switch, {
            checked: status.autoSync,
            disabled: busy || pending !== '',
            label: t('status.autoSync'),
            hint: t('status.autoSyncHint'),
            onChange: (next) => toggle('autoSync', next),
          }),
          h(Switch, {
            checked: status.autoSave,
            disabled: busy || pending !== '',
            label: t('status.autoSave'),
            hint: t('status.autoSaveHint'),
            onChange: (next) => toggle('autoSave', next),
          }),
          h(Switch, {
            checked: status.syncOnStart,
            disabled: busy || pending !== '',
            label: t('status.syncOnStart'),
            hint: t('status.syncOnStartHint'),
            onChange: (next) => toggle('syncOnStart', next),
          }),
          h(Switch, {
            checked: status.compressObjects,
            disabled: busy || pending !== '',
            label: t('status.compressObjects'),
            hint: t('status.compressObjectsHint'),
            onChange: (next) => toggle('compressObjects', next),
          }),
        ),
        h(
          'div',
          null,
          h('p', { className: 'dsync-fieldLabel' }, resultCombined ? t('status.lastResultCombined') : t('status.lastResult')),
          lastResult ? h('div', { className: 'dsync-chips' }, lastResultChips) : h('p', { className: 'dsync-hint' }, t('common.never')),
        ),
        reports && reports.length > 0
          ? h(
              'div',
              { className: 'dsync-field' },
              h('p', { className: 'dsync-fieldLabel' }, t('status.reports')),
              h(
                'div',
                { className: 'dsync-chips dsync-reports' },
                reports.map((report, index) => {
                  const matched = status.targets.find((target) => target.id === report.targetId)
                  const targetName = textOf(matched && matched.label) || textOf(report.targetLabel) || textOf(report.targetId) || t('common.none')
                  const failed = report.ok === false
                  return h(
                    'span',
                    {
                      className: failed ? 'dsync-chip dsync-chip--warn' : 'dsync-chip',
                      key: index,
                      title: textOf(report.error) || null,
                    },
                    t('status.reportLine', {
                      target: targetName,
                      pushed: Number(report.pushed) || 0,
                      pulled: Number(report.pulled) || 0,
                      conflicts: Number(report.conflicts) || 0,
                    }),
                  )
                }),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dsync-syncActions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn dsync-btn--primary',
              disabled: busy || enabledTargets.length === 0,
              onClick: () => runSyncButton('auto'),
            },
            pending === 'sync' ? t('status.syncing') : t('status.syncNow'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn',
              disabled: busy || enabledTargets.length === 0,
              onClick: () => runSyncButton('push'),
            },
            t('status.pushOnly'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn',
              disabled: busy || enabledTargets.length === 0,
              onClick: () => runSyncButton('pull'),
            },
            t('status.pullOnly'),
          ),
          enabledTargets.length === 0 ? h('p', { className: 'dsync-hint' }, t('status.noEnabledTargets')) : null,
        ),
        error ? h('p', { className: 'dsync-inlineMsg dsync-inlineMsg--error', role: 'alert' }, error) : null,
      )
    }

    // ---------------------------------------------------------------------
    // Targets：列表、行内编辑、三类型字段联动、测试、删除、新增
    // ---------------------------------------------------------------------

    function targetRank(type) {
      return type === 'webdav' ? 0 : type === 'peer' ? 1 : 2
    }
    function sortTargets(list) {
      return [...list].sort((a, b) => targetRank(a.type) - targetRank(b.type))
    }

    function TargetCard({ t, target, busy, pending, onSave, onDelete, onTest, onCopyCode }) {
      const [draft, setDraft] = React.useState(() => draftOfTarget(target))
      const [touched, setTouched] = React.useState({ password: false, token: false })
      const [error, setError] = React.useState('')
      const [testResult, setTestResult] = React.useState(null)
      const [copyState, setCopyState] = React.useState('')
      const targetRef = React.useRef(target)
      const draftRef = React.useRef(draft)
      const touchedRef = React.useRef(touched)
      draftRef.current = draft
      touchedRef.current = touched

      // Host 归一化可能改写 target（例如重复 id 被重命名、非法项被停用）。
      // 仅在本地没有未保存修改时跟随，避免吞掉用户正在编辑的内容。
      React.useEffect(() => {
        const previous = targetRef.current
        if (previous === target) return
        const currentPayload = buildTargetPayload(draftRef.current, touchedRef.current, previous)
        const previousPayload = buildTargetPayload(draftOfTarget(previous), { password: false, token: false }, previous)
        if (sameTarget(currentPayload, previousPayload)) {
          setDraft(draftOfTarget(target))
          setTouched({ password: false, token: false })
          setTestResult(null)
          setError('')
        }
        targetRef.current = target
      }, [target])

      const baseTarget = targetConfigOf(target)
      const currentPayload = buildTargetPayload(draft, touched, target)
      const baselinePayload = buildTargetPayload(draftOfTarget(target), { password: false, token: false }, target)
      const dirty = !sameTarget(currentPayload, baselinePayload)
      const saving = pending === 'target:' + target.id
      const testing = pending === 'test:' + target.id
      const disabled = busy || pending !== ''

      const update = (patch) => {
        setDraft({ ...draft, ...patch })
        setTestResult(null)
      }

      const switchType = (type) => {
        const next = { ...emptyTargetDraft(type), label: draft.label, enabled: draft.enabled }
        setDraft(next)
        setTouched({ password: false, token: false })
        setTestResult(null)
        setError('')
      }

      const validate = () => {
        if (draft.label.trim().length === 0) return t('targets.labelRequired')
        if (draft.type === 'local' && draft.path.trim().length === 0) return t('targets.pathRequired')
        if ((draft.type === 'webdav' || draft.type === 'peer') && draft.enabled !== false && draft.url.trim().length === 0) {
          return t('targets.urlRequired')
        }
        if ((draft.type === 'webdav' || draft.type === 'peer') && draft.url.trim().length > 0 && !isHttpUrl(draft.url)) {
          return t('targets.urlInvalid')
        }
        const keepsSavedToken = isMasked(baseTarget.token) && touched.token !== true
        if (draft.type === 'peer' && draft.enabled !== false && !keepsSavedToken && draft.token.trim().length === 0) {
          return t('targets.tokenRequired')
        }
        return ''
      }

      const save = async () => {
        const message = validate()
        if (message) {
          setError(message)
          return
        }
        setError('')
        try {
          const next = await onSave(buildTargetPayload(draft, touched, target))
          const saved = next && Array.isArray(next.targets) ? next.targets.find((item) => item.id === target.id) : null
          setTouched({ password: false, token: false })
          if (saved) setDraft(draftOfTarget(saved))
          else setDraft((previous) => ({ ...previous, password: '', token: '' }))
          setTestResult(null)
        } catch (failure) {
          setError(errorText(failure))
        }
      }

      const toggleEnabled = async (next) => {
        setError('')
        setDraft({ ...draft, enabled: next })
        try {
          const nextStatus = await onSave({ ...baseTarget, enabled: next })
          const saved = nextStatus && Array.isArray(nextStatus.targets) ? nextStatus.targets.find((item) => item.id === target.id) : null
          setDraft((previous) => ({ ...previous, enabled: saved ? saved.enabled !== false : next }))
        } catch (failure) {
          setDraft({ ...draft, enabled: !next })
          setError(errorText(failure))
        }
      }

      const test = async () => {
        const message = validate()
        if (message) {
          setError(message)
          return
        }
        setError('')
        setTestResult(null)
        try {
          const result = await onTest(buildTargetPayload(draft, touched, target))
          if (!result) throw new Error(t('state.busy'))
          setTestResult({
            ok: result.ok !== false,
            detail: textOf(result.detail) || t('common.none'),
          })
        } catch (failure) {
          setTestResult({ ok: false, detail: errorText(failure) })
        }
      }

      const lastSync = formatTime(target.lastSyncAt)

      return h(
        'div',
        { className: 'dsync-item' },
        h(
          'div',
          { className: 'dsync-itemHead' },
          h(
            'div',
            null,
            h(
              'div',
              { className: 'dsync-itemTitle' },
              draft.label || t('common.none'),
              h('span', { className: 'dsync-badge' }, typeLabel(t, draft.type)),
              target.enabled === false ? h('span', { className: 'dsync-badge' }, t('common.disabled')) : null,
            ),
            h('p', { className: 'dsync-meta' }, t('targets.lastSyncLine', { time: lastSync || t('common.never') })),
          ),
          h(
            'label',
            { className: 'dsync-switchRow dsync-switchRow--compact' },
            h('input', {
              type: 'checkbox',
              className: 'dsync-switch',
              checked: draft.enabled !== false,
              disabled,
              onChange: (event) => toggleEnabled(event.target.checked),
            }),
            h('span', { className: 'dsync-switchText' }, h('span', { className: 'dsync-switchLabel' }, t('targets.enabled'))),
          ),
        ),
        h(
          'div',
          { className: 'dsync-grid' },
          h(
            Field,
            { label: t('targets.label'), htmlFor: 'dsync-target-label-' + target.id },
            h('input', {
              id: 'dsync-target-label-' + target.id,
              className: 'dsync-input',
              type: 'text',
              value: draft.label,
              placeholder: t('targets.labelPlaceholder'),
              disabled,
              onChange: (event) => update({ label: event.target.value }),
            }),
          ),
          h(
            Field,
            { label: t('targets.type'), htmlFor: 'dsync-target-type-' + target.id, hint: t('targets.typeHint') },
            h(
              'select',
              {
                id: 'dsync-target-type-' + target.id,
                className: 'dsync-select',
                value: draft.type,
                disabled,
                onChange: (event) => switchType(event.target.value),
              },
              h('option', { value: 'webdav' }, t('targets.typeWebdav')),
              h('option', { value: 'peer' }, t('targets.typePeer')),
              h('option', { value: 'local' }, t('targets.typeLocal')),
            ),
          ),
          draft.type === 'local'
            ? h(
                Field,
                { label: t('targets.path'), htmlFor: 'dsync-target-path-' + target.id, hint: t('targets.pathHint') },
                h('input', {
                  id: 'dsync-target-path-' + target.id,
                  className: 'dsync-input',
                  type: 'text',
                  value: draft.path,
                  disabled,
                  onChange: (event) => update({ path: event.target.value }),
                }),
              )
            : null,
          draft.type === 'webdav'
            ? h(
                Field,
                { label: t('targets.url'), htmlFor: 'dsync-target-url-' + target.id, hint: t('targets.urlHintWebdav') },
                h('input', {
                  id: 'dsync-target-url-' + target.id,
                  className: 'dsync-input',
                  type: 'text',
                  value: draft.url,
                  placeholder: t('targets.urlPlaceholderWebdav'),
                  disabled,
                  onChange: (event) => update({ url: event.target.value }),
                }),
              )
            : null,
          draft.type === 'peer'
            ? h(
                Field,
                { label: t('targets.url'), htmlFor: 'dsync-target-url-' + target.id, hint: t('targets.urlHintPeer') },
                h('input', {
                  id: 'dsync-target-url-' + target.id,
                  className: 'dsync-input',
                  type: 'text',
                  value: draft.url,
                  placeholder: t('targets.urlPlaceholderPeer'),
                  disabled,
                  onChange: (event) => update({ url: event.target.value }),
                }),
              )
            : null,
          draft.type === 'webdav'
            ? h(
                Field,
                { label: t('targets.username'), htmlFor: 'dsync-target-username-' + target.id },
                h('input', {
                  id: 'dsync-target-username-' + target.id,
                  className: 'dsync-input',
                  type: 'text',
                  autoComplete: 'off',
                  value: draft.username,
                  disabled,
                  onChange: (event) => update({ username: event.target.value }),
                }),
              )
            : null,
          draft.type === 'webdav'
            ? h(
                Field,
                { label: t('targets.password'), htmlFor: 'dsync-target-password-' + target.id, hint: t('targets.passwordHint') },
                h('input', {
                  id: 'dsync-target-password-' + target.id,
                  className: 'dsync-input',
                  type: 'password',
                  autoComplete: 'new-password',
                  value: draft.password,
                  placeholder: isMasked(baseTarget.password) ? t('targets.masked') : '',
                  disabled,
                  onChange: (event) => {
                    setTouched({ ...touched, password: true })
                    update({ password: event.target.value })
                  },
                }),
              )
            : null,
          draft.type === 'webdav'
            ? h(
                Field,
                { label: t('targets.basePath'), htmlFor: 'dsync-target-basepath-' + target.id, hint: t('targets.basePathHint') },
                h('input', {
                  id: 'dsync-target-basepath-' + target.id,
                  className: 'dsync-input',
                  type: 'text',
                  value: draft.basePath,
                  disabled,
                  onChange: (event) => update({ basePath: event.target.value }),
                }),
              )
            : null,
          draft.type === 'peer'
            ? h(
                Field,
                { label: t('targets.token'), htmlFor: 'dsync-target-token-' + target.id, hint: t('targets.tokenHint') },
                h('input', {
                  id: 'dsync-target-token-' + target.id,
                  className: 'dsync-input',
                  type: 'password',
                  autoComplete: 'new-password',
                  value: draft.token,
                  placeholder: isMasked(baseTarget.token) ? t('targets.masked') : '',
                  disabled,
                  onChange: (event) => {
                    setTouched({ ...touched, token: true })
                    update({ token: event.target.value })
                  },
                }),
              )
            : null,
        ),
        textOf(target.detail)
          ? h('p', { className: 'dsync-meta' }, t('targets.detailLine', { detail: target.detail }))
          : null,
        error ? h('p', { className: 'dsync-inlineMsg dsync-inlineMsg--error', role: 'alert' }, error) : null,
        testResult
          ? h(
              'p',
              { className: 'dsync-inlineMsg ' + (testResult.ok ? 'dsync-inlineMsg--ok' : 'dsync-inlineMsg--error') },
              t(testResult.ok ? 'targets.testOk' : 'targets.testFail', { detail: testResult.detail }),
            )
          : null,
        h(
          'div',
          { className: 'dsync-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn dsync-btn--primary',
              disabled: disabled || !dirty,
              onClick: save,
            },
            saving ? t('common.saving') : t('targets.save'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsync-btn',
              disabled: disabled,
              onClick: test,
            },
            testing ? t('common.testing') : t('common.test'),
          ),
          target.type !== 'local' && onCopyCode
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsync-btn',
                  disabled,
                  onClick: async () => {
                    try {
                      const data = await onCopyCode(target.id)
                      await navigator.clipboard.writeText(textOf(data && data.code))
                      setCopyState('ok')
                    } catch {
                      setCopyState('fail')
                    }
                    setTimeout(() => setCopyState(''), 2000)
                  },
                },
                copyState === 'ok' ? t('common.copied') : copyState === 'fail' ? t('common.copyFailed') : t('targets.copyPair'),
              )
            : null,
          h(DeleteControl, {
            t,
            disabled,
            label: t('targets.delete'),
            message: t('targets.deleteConfirm', { label: draft.label || t('common.none') }),
            onConfirm: () => {
              Promise.resolve(onDelete()).catch((failure) => setError(errorText(failure)))
            },
          }),
        ),
      )
    }

    function TargetForm({ t, busy, pending, onAdd, onCancel, existingIds }) {
      const [draft, setDraft] = React.useState(() => emptyTargetDraft('webdav'))
      const [error, setError] = React.useState('')
      const adding = pending === 'target:add'
      const disabled = busy || pending !== ''

      const submit = async () => {
        setError('')
        if (draft.label.trim().length === 0) {
          setError(t('targets.labelRequired'))
          return
        }
        if (draft.type === 'local' && draft.path.trim().length === 0) {
          setError(t('targets.pathRequired'))
          return
        }
        if ((draft.type === 'webdav' || draft.type === 'peer') && draft.enabled !== false && draft.url.trim().length === 0) {
          setError(t('targets.urlRequired'))
          return
        }
        if ((draft.type === 'webdav' || draft.type === 'peer') && draft.url.trim().length > 0 && !isHttpUrl(draft.url)) {
          setError(t('targets.urlInvalid'))
          return
        }
        if (draft.type === 'peer' && draft.enabled !== false && draft.token.trim().length === 0) {
          setError(t('targets.tokenRequired'))
          return
        }
        const id = freshId(draft.type, existingIds)
        try {
          await onAdd(buildTargetPayload({ ...draft, label: draft.label.trim() }, { password: true, token: true }, { id }))
        } catch (failure) {
          setError(errorText(failure))
        }
      }

      return h(
        'div',
        { className: 'dsync-item dsync-item--new' },
        h('div', { className: 'dsync-itemTitle' }, t('targets.newTitle')),
        h(
          'div',
          { className: 'dsync-grid' },
          h(
            Field,
            { label: t('targets.type'), htmlFor: 'dsync-new-target-type', hint: t('targets.typeHint') },
            h(
              'select',
              {
                id: 'dsync-new-target-type',
                className: 'dsync-select',
                value: draft.type,
                disabled,
                onChange: (event) => {
                  setDraft({ ...emptyTargetDraft(event.target.value), label: draft.label, enabled: draft.enabled })
                  setError('')
                },
              },
              h('option', { value: 'webdav' }, t('targets.typeWebdav')),
              h('option', { value: 'peer' }, t('targets.typePeer')),
              h('option', { value: 'local' }, t('targets.typeLocal')),
            ),
          ),
          h(
            Field,
            { label: t('targets.label'), htmlFor: 'dsync-new-target-label' },
            h('input', {
              id: 'dsync-new-target-label',
              className: 'dsync-input',
              type: 'text',
              value: draft.label,
              placeholder: t('targets.labelPlaceholder'),
              disabled,
              onChange: (event) => setDraft({ ...draft, label: event.target.value }),
            }),
          ),
          draft.type === 'local'
            ? h(
                Field,
                { label: t('targets.path'), htmlFor: 'dsync-new-target-path', hint: t('targets.pathHint') },
                h('input', {
                  id: 'dsync-new-target-path',
                  className: 'dsync-input',
                  type: 'text',
                  value: draft.path,
                  disabled,
                  onChange: (event) => setDraft({ ...draft, path: event.target.value }),
                }),
              )
            : null,
          draft.type === 'webdav' || draft.type === 'peer'
            ? h(
                Field,
                {
                  label: t('targets.url'),
                  htmlFor: 'dsync-new-target-url',
                  hint: draft.type === 'webdav' ? t('targets.urlHintWebdav') : t('targets.urlHintPeer'),
                },
                h('input', {
                  id: 'dsync-new-target-url',
                  className: 'dsync-input',
                  type: 'text',
                  value: draft.url,
                  disabled,
                  onChange: (event) => setDraft({ ...draft, url: event.target.value }),
                }),
              )
            : null,
          draft.type === 'webdav'
            ? h(
                Field,
                { label: t('targets.username'), htmlFor: 'dsync-new-target-username' },
                h('input', {
                  id: 'dsync-new-target-username',
                  className: 'dsync-input',
                  type: 'text',
                  autoComplete: 'off',
                  value: draft.username,
                  disabled,
                  onChange: (event) => setDraft({ ...draft, username: event.target.value }),
                }),
              )
            : null,
          draft.type === 'webdav'
            ? h(
                Field,
                { label: t('targets.password'), htmlFor: 'dsync-new-target-password', hint: t('targets.passwordHint') },
                h('input', {
                  id: 'dsync-new-target-password',
                  className: 'dsync-input',
                  type: 'password',
                  autoComplete: 'new-password',
                  value: draft.password,
                  disabled,
                  onChange: (event) => setDraft({ ...draft, password: event.target.value }),
                }),
              )
            : null,
          draft.type === 'webdav'
            ? h(
                Field,
                { label: t('targets.basePath'), htmlFor: 'dsync-new-target-basepath', hint: t('targets.basePathHint') },
                h('input', {
                  id: 'dsync-new-target-basepath',
                  className: 'dsync-input',
                  type: 'text',
                  value: draft.basePath,
                  disabled,
                  onChange: (event) => setDraft({ ...draft, basePath: event.target.value }),
                }),
              )
            : null,
          draft.type === 'peer'
            ? h(
                Field,
                { label: t('targets.token'), htmlFor: 'dsync-new-target-token', hint: t('targets.tokenHint') },
                h('input', {
                  id: 'dsync-new-target-token',
                  className: 'dsync-input',
                  type: 'password',
                  autoComplete: 'new-password',
                  value: draft.token,
                  disabled,
                  onChange: (event) => setDraft({ ...draft, token: event.target.value }),
                }),
              )
            : null,
        ),
        h(Switch, {
          checked: draft.enabled !== false,
          disabled,
          label: t('targets.enabled'),
          onChange: (next) => setDraft({ ...draft, enabled: next }),
        }),
        error ? h('p', { className: 'dsync-inlineMsg dsync-inlineMsg--error', role: 'alert' }, error) : null,
        h(
          'div',
          { className: 'dsync-actions' },
          h(
            'button',
            { type: 'button', className: 'dsync-btn dsync-btn--primary', disabled, onClick: submit },
            adding ? t('common.saving') : t('targets.addSave'),
          ),
          h('button', { type: 'button', className: 'dsync-btn dsync-btn--text', disabled, onClick: onCancel }, t('common.cancel')),
        ),
      )
    }

    function TargetsSection({ t, status, busy, pending, onSaveTarget, onDeleteTarget, onAddTarget, onTestTarget, onCopyCode }) {
      const [adding, setAdding] = React.useState(false)
      const atLimit = status.targets.length >= MAX_TARGETS
      if (!adding) {
        return h(
          Card,
          {
            title: t('targets.heading'),
            intro: t('targets.intro'),
            actions: h(
              'div',
              { className: 'dsync-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsync-btn dsync-btn--primary',
                  disabled: busy || pending !== '' || atLimit,
                  onClick: () => setAdding(true),
                },
                t('targets.add'),
              ),
              atLimit ? h('span', { className: 'dsync-hint' }, t('targets.limit')) : null,
            ),
          },
          status.targets.length === 0
            ? h(Empty, { text: t('targets.empty') })
            : sortTargets(status.targets).map((target) =>
                h(TargetCard, {
                  key: target.id,
                  t,
                  target,
                  busy,
                  pending,
                  onSave: (payload) => onSaveTarget(target, payload),
                  onDelete: () => onDeleteTarget(target),
                  onTest: (payload) => onTestTarget(target, payload),
                  onCopyCode,
                }),
              ),
        )
      }
      return h(
        Card,
        { title: t('targets.heading'), intro: t('targets.intro') },
        sortTargets(status.targets).map((target) =>
          h(TargetCard, {
            key: target.id,
            t,
            target,
            busy,
            pending,
            onSave: (payload) => onSaveTarget(target, payload),
            onDelete: () => onDeleteTarget(target),
            onTest: (payload) => onTestTarget(target, payload),
            onCopyCode,
          }),
        ),
        h(TargetForm, {
          t,
          busy,
          pending,
          existingIds: status.targets.map((target) => target.id),
          onAdd: async (payload) => {
            await onAddTarget(payload)
            setAdding(false)
          },
          onCancel: () => setAdding(false),
        }),
      )
    }

    // ---------------------------------------------------------------------
    // Roots：列表、行内编辑、排除项逐行、启用、删除、新增
    // ---------------------------------------------------------------------

    function RootCard({ t, root, busy, pending, onSave, onDelete }) {
      const [draft, setDraft] = React.useState(() => draftOfRoot(root))
      const [error, setError] = React.useState('')
      const rootRef = React.useRef(root)
      const draftRef = React.useRef(draft)
      draftRef.current = draft

      // 与 TargetCard 相同：干净草稿跟随 Host 归一化结果。
      React.useEffect(() => {
        const previous = rootRef.current
        if (previous === root) return
        const currentPayload = {
          id: previous.id,
          label: draftRef.current.label.trim(),
          path: draftRef.current.path.trim(),
          enabled: draftRef.current.enabled !== false,
          exclude: splitExclude(draftRef.current.exclude),
        }
        if (JSON.stringify(currentPayload) === JSON.stringify(rootConfigOf(previous))) setDraft(draftOfRoot(root))
        rootRef.current = root
      }, [root])
      const saving = pending === 'root:' + root.id
      const disabled = busy || pending !== ''

      const baseline = rootConfigOf(root)
      const payload = {
        id: root.id,
        label: draft.label.trim(),
        path: draft.path.trim(),
        enabled: draft.enabled !== false,
        exclude: splitExclude(draft.exclude),
      }
      const dirty = JSON.stringify(payload) !== JSON.stringify(baseline)

      const save = async () => {
        setError('')
        if (draft.label.trim().length === 0) {
          setError(t('roots.labelRequired'))
          return
        }
        if (draft.path.trim().length === 0) {
          setError(t('roots.pathRequired'))
          return
        }
        if (splitExclude(draft.exclude).length > MAX_EXCLUDES) {
          setError(t('roots.excludeLimit'))
          return
        }
        try {
          const next = await onSave(payload)
          const saved = next && Array.isArray(next.roots) ? next.roots.find((item) => item.id === root.id) : null
          if (saved) setDraft(draftOfRoot(saved))
        } catch (failure) {
          setError(errorText(failure))
        }
      }

      const toggleEnabled = async (next) => {
        setError('')
        setDraft({ ...draft, enabled: next })
        try {
          const nextStatus = await onSave({ ...baseline, enabled: next })
          const saved = nextStatus && Array.isArray(nextStatus.roots) ? nextStatus.roots.find((item) => item.id === root.id) : null
          setDraft((previous) => ({ ...previous, enabled: saved ? saved.enabled !== false : next }))
        } catch (failure) {
          setDraft({ ...draft, enabled: !next })
          setError(errorText(failure))
        }
      }

      return h(
        'div',
        { className: 'dsync-item' },
        h(
          'div',
          { className: 'dsync-itemHead' },
          h(
            'div',
            null,
            h(
              'div',
              { className: 'dsync-itemTitle' },
              draft.label || t('common.none'),
              h('span', { className: 'dsync-badge' }, root.id),
            ),
            h('p', { className: 'dsync-meta' }, draft.path || t('common.none')),
          ),
          h(
            'label',
            { className: 'dsync-switchRow dsync-switchRow--compact' },
            h('input', {
              type: 'checkbox',
              className: 'dsync-switch',
              checked: draft.enabled !== false,
              disabled,
              onChange: (event) => toggleEnabled(event.target.checked),
            }),
            h('span', { className: 'dsync-switchText' }, h('span', { className: 'dsync-switchLabel' }, t('roots.enabled'))),
          ),
        ),
        h(
          'div',
          { className: 'dsync-grid' },
          h(
            Field,
            { label: t('roots.label'), htmlFor: 'dsync-root-label-' + root.id },
            h('input', {
              id: 'dsync-root-label-' + root.id,
              className: 'dsync-input',
              type: 'text',
              value: draft.label,
              placeholder: t('roots.labelPlaceholder'),
              disabled,
              onChange: (event) => setDraft({ ...draft, label: event.target.value }),
            }),
          ),
          h(
            Field,
            { label: t('roots.path'), htmlFor: 'dsync-root-path-' + root.id, hint: t('roots.pathHint') },
            h('input', {
              id: 'dsync-root-path-' + root.id,
              className: 'dsync-input',
              type: 'text',
              value: draft.path,
              disabled,
              onChange: (event) => setDraft({ ...draft, path: event.target.value }),
            }),
          ),
        ),
        h(
          Field,
          { label: t('roots.exclude'), htmlFor: 'dsync-root-exclude-' + root.id, hint: t('roots.excludeHint') },
          h('textarea', {
            id: 'dsync-root-exclude-' + root.id,
            className: 'dsync-textarea',
            value: draft.exclude,
            disabled,
            spellCheck: false,
            onChange: (event) => setDraft({ ...draft, exclude: event.target.value }),
          }),
        ),
        error ? h('p', { className: 'dsync-inlineMsg dsync-inlineMsg--error', role: 'alert' }, error) : null,
        h(
          'div',
          { className: 'dsync-actions' },
          h(
            'button',
            { type: 'button', className: 'dsync-btn dsync-btn--primary', disabled: disabled || !dirty, onClick: save },
            saving ? t('common.saving') : t('roots.save'),
          ),
          h(DeleteControl, {
            t,
            disabled,
            label: t('roots.delete'),
            message: t('roots.deleteConfirm', { label: draft.label || t('common.none') }),
            onConfirm: () => {
              Promise.resolve(onDelete()).catch((failure) => setError(errorText(failure)))
            },
          }),
        ),
      )
    }

    function RootForm({ t, busy, pending, onAdd, onCancel, existingIds }) {
      const [draft, setDraft] = React.useState(() => emptyRootDraft())
      const [error, setError] = React.useState('')
      const adding = pending === 'root:add'
      const disabled = busy || pending !== ''

      const submit = async () => {
        setError('')
        if (draft.label.trim().length === 0) {
          setError(t('roots.labelRequired'))
          return
        }
        if (draft.path.trim().length === 0) {
          setError(t('roots.pathRequired'))
          return
        }
        if (splitExclude(draft.exclude).length > MAX_EXCLUDES) {
          setError(t('roots.excludeLimit'))
          return
        }
        const id = freshId(draft.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'root', existingIds)
        try {
          await onAdd({
            id,
            label: draft.label.trim(),
            path: draft.path.trim(),
            enabled: draft.enabled !== false,
            exclude: splitExclude(draft.exclude),
          })
        } catch (failure) {
          setError(errorText(failure))
        }
      }

      return h(
        'div',
        { className: 'dsync-item dsync-item--new' },
        h('div', { className: 'dsync-itemTitle' }, t('roots.newTitle')),
        h(
          'div',
          { className: 'dsync-grid' },
          h(
            Field,
            { label: t('roots.label'), htmlFor: 'dsync-new-root-label' },
            h('input', {
              id: 'dsync-new-root-label',
              className: 'dsync-input',
              type: 'text',
              value: draft.label,
              placeholder: t('roots.labelPlaceholder'),
              disabled,
              onChange: (event) => setDraft({ ...draft, label: event.target.value }),
            }),
          ),
          h(
            Field,
            {
              label: t('roots.path'),
              htmlFor: 'dsync-new-root-path',
              hint: t('roots.pathHint'),
              hintTone: 'warn',
            },
            h('input', {
              id: 'dsync-new-root-path',
              className: 'dsync-input',
              type: 'text',
              value: draft.path,
              disabled,
              onChange: (event) => setDraft({ ...draft, path: event.target.value }),
            }),
          ),
        ),
        h(
          Field,
          { label: t('roots.exclude'), htmlFor: 'dsync-new-root-exclude', hint: t('roots.excludeHint') },
          h('textarea', {
            id: 'dsync-new-root-exclude',
            className: 'dsync-textarea',
            value: draft.exclude,
            disabled,
            spellCheck: false,
            onChange: (event) => setDraft({ ...draft, exclude: event.target.value }),
          }),
        ),
        h(Switch, {
          checked: draft.enabled !== false,
          disabled,
          label: t('roots.enabled'),
          onChange: (next) => setDraft({ ...draft, enabled: next }),
        }),
        h('p', { className: 'dsync-hint dsync-hint--warn' }, t('roots.pathWarning')),
        error ? h('p', { className: 'dsync-inlineMsg dsync-inlineMsg--error', role: 'alert' }, error) : null,
        h(
          'div',
          { className: 'dsync-actions' },
          h(
            'button',
            { type: 'button', className: 'dsync-btn dsync-btn--primary', disabled, onClick: submit },
            adding ? t('common.saving') : t('roots.addSave'),
          ),
          h('button', { type: 'button', className: 'dsync-btn dsync-btn--text', disabled, onClick: onCancel }, t('common.cancel')),
        ),
      )
    }

    function RootsSection({ t, status, busy, pending, onSaveRoot, onDeleteRoot, onAddRoot }) {
      const [adding, setAdding] = React.useState(false)
      const atLimit = status.roots.length >= MAX_ROOTS
      return h(
        Card,
        {
          title: t('roots.heading'),
          intro: t('roots.intro'),
          actions: h(
            'div',
            { className: 'dsync-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsync-btn dsync-btn--primary',
                disabled: busy || pending !== '' || adding || atLimit,
                onClick: () => setAdding(true),
              },
              t('roots.add'),
            ),
            atLimit ? h('span', { className: 'dsync-hint' }, t('roots.limit')) : null,
          ),
        },
        status.roots.length === 0 && !adding ? h(Empty, { text: t('roots.empty') }) : null,
        status.roots.map((root) =>
          h(RootCard, {
            key: root.id,
            t,
            root,
            busy,
            pending,
            onSave: (payload) => onSaveRoot(root, payload),
            onDelete: () => onDeleteRoot(root),
          }),
        ),
        adding
          ? h(RootForm, {
              t,
              busy,
              pending,
              existingIds: status.roots.map((root) => root.id),
              onAdd: async (payload) => {
                await onAddRoot(payload)
                setAdding(false)
              },
              onCancel: () => setAdding(false),
            })
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Peer 配对：只读 url/token + 复制
    // ---------------------------------------------------------------------

    function PeerCard({ t, peer, busy, onGetCode, onApplyPair }) {
      const [copyState, setCopyState] = React.useState('')
      const [code, setCode] = React.useState('')
      const [warning, setWarning] = React.useState('')
      const [paste, setPaste] = React.useState('')
      const [pairing, setPairing] = React.useState(false)
      const [pairNotice, setPairNotice] = React.useState(null)
      const timerRef = React.useRef(null)
      React.useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current)
      }, [])

      const url = textOf(peer && peer.url)
      const token = textOf(peer && peer.token)
      const available = url.length > 0

      const copy = async (kind, value) => {
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable')
          await navigator.clipboard.writeText(value)
          setCopyState(kind + ':ok')
        } catch {
          setCopyState(kind + ':fail')
        }
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopyState(''), 2000)
      }

      const copyLabel = (kind) => {
        if (copyState === kind + ':ok') return t('common.copied')
        if (copyState === kind + ':fail') return t('common.copyFailed')
        return t('peer.copy' + (kind === 'url' ? 'Url' : 'Token'))
      }

      const makeCode = async () => {
        if (!onGetCode) return
        try {
          const data = await onGetCode()
          setCode(textOf(data && data.code))
          setWarning(textOf(data && data.warning))
          await copy('code', textOf(data && data.code))
        } catch (failure) {
          setWarning(errorText(failure))
        }
      }

      const apply = async () => {
        if (!paste.trim() || !onApplyPair || pairing) return
        setPairing(true)
        setPairNotice(null)
        try {
          const data = await onApplyPair(paste.trim())
          const name = textOf(data && data.target && data.target.label) || t('common.none')
          if (data && data.error) {
            setPairNotice({ tone: 'warn', text: t('peer.pairFailed', { error: textOf(data.error) }) })
          } else {
            setPairNotice({ tone: 'ok', text: t('peer.pairSynced', { target: name }) })
            setPaste('')
          }
        } catch (failure) {
          setPairNotice({ tone: 'error', text: t('peer.pairFailed', { error: errorText(failure) }) })
        } finally {
          setPairing(false)
        }
      }

      const pairBlock = h(
        'div',
        null,
        h(
          Field,
          { label: t('peer.codeHeading'), hint: t('peer.codeHint') },
          h(
            'div',
            { className: 'dsync-copyRow' },
            h('button', {
              type: 'button',
              className: 'dsync-btn',
              disabled: busy || pairing || !onGetCode,
              onClick: makeCode,
            }, copyState === 'code:ok' ? t('common.copied') : t('peer.copyCode')),
          ),
          h('textarea', {
            className: 'dsync-input dsync-textarea',
            rows: 3,
            readOnly: true,
            value: code,
            placeholder: t('peer.codePlaceholder'),
          }),
          warning ? h('p', { className: 'dsync-hint' }, warning) : null,
        ),
        h(
          Field,
          { label: t('peer.pasteLabel'), hint: t('peer.codeHint') },
          h('textarea', {
            className: 'dsync-input dsync-textarea',
            rows: 3,
            value: paste,
            placeholder: t('peer.pastePlaceholder'),
            disabled: busy || pairing,
            onChange: (event) => setPaste(event.target.value),
          }),
          h(
            'div',
            { className: 'dsync-actions' },
            h('button', {
              type: 'button',
              className: 'dsync-btn dsync-btn--primary',
              disabled: busy || pairing || paste.trim().length === 0 || !onApplyPair,
              onClick: apply,
            }, pairing ? t('state.busy') : t('peer.pairButton')),
            pairNotice ? h('p', { className: 'dsync-inlineMsg ' + (pairNotice.tone === 'ok' ? 'dsync-inlineMsg--ok' : 'dsync-inlineMsg--error'), role: 'alert' }, pairNotice.text) : null,
          ),
        ),
      )

      if (!available) {
        return h(Card, { title: t('peer.heading'), intro: t('peer.intro') }, h(Empty, { text: t('peer.unavailable') }), pairBlock)
      }

      return h(
        Card,
        { title: t('peer.heading'), intro: t('peer.intro') },
        h(
          Field,
          { label: t('peer.url'), htmlFor: 'dsync-peer-url' },
          h(
            'div',
            { className: 'dsync-copyRow' },
            h('input', { id: 'dsync-peer-url', className: 'dsync-input', type: 'text', readOnly: true, value: url }),
            h(
              'button',
              { type: 'button', className: 'dsync-btn', onClick: () => copy('url', url) },
              copyLabel('url'),
            ),
          ),
        ),
        h(
          Field,
          { label: t('peer.token'), htmlFor: 'dsync-peer-token', hint: t('peer.securityNote') },
          h(
            'div',
            { className: 'dsync-copyRow' },
            h('input', { id: 'dsync-peer-token', className: 'dsync-input', type: 'text', readOnly: true, value: token }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsync-btn',
                disabled: token.length === 0,
                onClick: () => copy('token', token),
              },
              copyLabel('token'),
            ),
          ),
        ),
        pairBlock,
      )
    }

    // ---------------------------------------------------------------------
    // 导入 / 导出
    // ---------------------------------------------------------------------

    function TransferCard({ t, busy, pending, onExport, onExportFull, onExportApp, onImport }) {
      const inputRef = React.useRef(null)
      const [error, setError] = React.useState('')
      // 云端回收：先预演拿到可回收量，用户确认后才真删。
      const [pruneReport, setPruneReport] = React.useState(null)
      const [pruning, setPruning] = React.useState(false)
      const [pruneMessage, setPruneMessage] = React.useState('')
      const exporting = pending === 'export'
      const fullExporting = pending === 'export-full'
      const appExporting = pending === 'export-app'
      const importing = pending === 'import'
      const disabled = busy || pending !== ''

      const runPrune = async (apply) => {
        setError('')
        setPruning(true)
        try {
          const payload = await requestJson('/dsh-sync/api/prune', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(apply ? { apply: true } : {}),
          })
          const report = (payload && payload.report) || {}
          if (report.ok === false) {
            setError(report.error || t('transfer.pruneFailed'))
            setPruneReport(null)
          } else if (apply) {
            setPruneReport(null)
            setPruneMessage(
              t('transfer.pruneDone', {
                n: report.removed ?? 0,
                size: formatBytes(report.freedBytes ?? 0),
                rate: formatBytes(report.freedBytesPerSecond ?? 0) + '/s',
              }),
            )
          } else {
            setPruneReport(report)
            setPruneMessage(
              t('transfer.pruneResult', {
                objects: report.objects ?? 0,
                referenced: report.referenced ?? 0,
                n: report.removable ?? 0,
                size: formatBytes(report.removableBytes ?? 0),
              }),
            )
          }
        } catch (failure) {
          setError(errorText(failure))
        } finally {
          setPruning(false)
        }
      }

      const pickFile = () => {
        setError('')
        if (inputRef.current) inputRef.current.click()
      }

      const handleFile = async (event) => {
        const file = event.target.files && event.target.files[0]
        if (event.target) event.target.value = ''
        if (!file) return
        if (!/\.dshsync$/i.test(file.name)) {
          setError(t('transfer.importInvalidType'))
          return
        }
        if (file.size > MAX_ARCHIVE_BYTES) {
          setError(t('transfer.importTooLarge'))
          return
        }
        setError('')
        try {
          await onImport(file)
        } catch (failure) {
          setError(errorText(failure))
        }
      }

      return h(
        Card,
        { title: t('transfer.heading'), intro: t('transfer.intro') },
        h(
          'div',
          { className: 'dsync-transfer' },
          h(
            'div',
            { className: 'dsync-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsync-btn dsync-btn--primary',
                disabled,
                onClick: () => {
                  setError('')
                  Promise.resolve(onExport()).catch((failure) => setError(errorText(failure)))
                },
              },
              exporting ? t('transfer.exporting') : t('transfer.export'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsync-btn',
                disabled,
                title: t('transfer.exportFullHint'),
                onClick: () => {
                  setError('')
                  Promise.resolve(onExportFull()).catch((failure) => setError(errorText(failure)))
                },
              },
              fullExporting ? t('transfer.exporting') : t('transfer.exportFull'),
            ),
            // 完整应用数据：换设备后"装完即等同原机"用的就是它。
            h(
              'button',
              {
                type: 'button',
                className: 'dsync-btn',
                disabled,
                title: t('transfer.exportAppHint'),
                onClick: () => {
                  setError('')
                  Promise.resolve(onExportApp()).catch((failure) => setError(errorText(failure)))
                },
              },
              appExporting ? t('transfer.exporting') : t('transfer.exportApp'),
            ),
            h(
              'button',
              { type: 'button', className: 'dsync-btn', disabled, onClick: pickFile },
              importing ? t('transfer.importing') : t('transfer.importPick'),
            ),
            h('input', {
              ref: inputRef,
              type: 'file',
              accept: '.dshsync',
              className: 'dsync-hidden',
              disabled,
              onChange: handleFile,
            }),
          ),
          h('p', { className: 'dsync-hint' }, t('transfer.importHint')),
          // 云端回收：文件每改一次云端就多存一份对象，旧的不删会一直堆着。
          h(
            'div',
            { className: 'dsync-row dsync-row--prune' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsync-btn',
                disabled,
                title: t('transfer.pruneHint'),
                onClick: () => {
                  if (pruneReport && (pruneReport.removable ?? 0) > 0) {
                    Promise.resolve(runPrune(true))
                    return
                  }
                  Promise.resolve(runPrune(false))
                },
              },
              pruning
                ? t('transfer.pruneRunning')
                : pruneReport && (pruneReport.removable ?? 0) > 0
                  ? t('transfer.pruneConfirm', {
                      n: pruneReport.removable,
                      size: formatBytes(pruneReport.removableBytes ?? 0),
                    })
                  : t('transfer.pruneDryRun'),
            ),
          ),
          h('p', { className: 'dsync-hint' }, t('transfer.pruneHint')),
          pruneMessage ? h('p', { className: 'dsync-inlineMsg', role: 'status' }, pruneMessage) : null,
          error ? h('p', { className: 'dsync-inlineMsg dsync-inlineMsg--error', role: 'alert' }, error) : null,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 日志与冲突
    // ---------------------------------------------------------------------

    function LogsCard({ t, status }) {
      const logs = status.logs.slice(-20).reverse()
      const conflicts = status.conflicts.slice().reverse()
      return h(
        Card,
        { title: t('logs.heading') },
        logs.length === 0
          ? h(Empty, { text: t('logs.empty') })
          : h(
              'div',
              { className: 'dsync-logList' },
              logs.map((entry, index) =>
                h(
                  'div',
                  { className: 'dsync-logRow', key: String(entry.at === undefined ? index : entry.at) + '-' + index },
                  h('span', { className: 'dsync-logTime' }, formatTime(entry.at) || t('common.none')),
                  h('span', { className: 'dsync-chip' }, levelLabel(t, entry.level)),
                  h('span', { className: 'dsync-logMsg' }, textOf(entry.message)),
                ),
              ),
            ),
        h('p', { className: 'dsync-fieldLabel' }, t('logs.conflictsHeading')),
        conflicts.length === 0
          ? h(Empty, { text: t('logs.conflictsEmpty') })
          : h(
              'div',
              { className: 'dsync-logList' },
              conflicts.map((conflict, index) =>
                h(
                  'div',
                  { className: 'dsync-conflict', key: String(conflict.at === undefined ? index : conflict.at) + '-' + index },
                  h(
                    'span',
                    { className: 'dsync-conflictKey' },
                    t('logs.conflictItem', { key: textOf(conflict.key), copy: textOf(conflict.copy) }),
                  ),
                  textOf(conflict.reason)
                    ? h('span', { className: 'dsync-conflictMeta' }, t('logs.reason', { reason: conflict.reason }))
                    : null,
                ),
              ),
            ),
      )
    }

    // ---------------------------------------------------------------------
    // 根组件：状态获取、全局 busy、所有 API 动作
    // ---------------------------------------------------------------------

    function SyncSection({ t }) {
      const sectionRef = React.useRef(null)
      const [status, setStatus] = React.useState(null)
      const [phase, setPhase] = React.useState('loading')
      const [loadError, setLoadError] = React.useState('')
      const [pending, setPending] = React.useState('')
      const [notice, setNotice] = React.useState(null)
      const [reports, setReports] = React.useState(null)
      const [configWarnings, setConfigWarnings] = React.useState([])

      const fetchStatus = React.useCallback(async () => {
        const data = await requestJson('/status')
        return normalizeStatus(data)
      }, [])

      const loadInitial = React.useCallback(async () => {
        setPhase('loading')
        setLoadError('')
        try {
          const next = await fetchStatus()
          setStatus(next)
          setPhase('ready')
        } catch (failure) {
          setLoadError(errorText(failure))
          setPhase('error')
        }
      }, [fetchStatus])

      React.useEffect(() => {
        loadInitial()
      }, [loadInitial])

      /** 串行化所有修改动作，避免并发覆盖。 */
      const run = async (key, task) => {
        if (pending !== '') throw new Error(t('state.busy'))
        setPending(key)
        setNotice(null)
        try {
          return await task()
        } finally {
          setPending('')
        }
      }

      /** POST /config 并同步 Host 返回的最新 status；同时保留 Host 的配置警告。 */
      const commitPatch = async (patch) => {
        const data = await requestJson('/config', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ patch }),
        })
        setConfigWarnings(Array.isArray(data.warnings) ? data.warnings.filter((item) => typeof item === 'string') : [])
        const embedded = data.status && looksLikeStatus(data.status) ? data.status : looksLikeStatus(data) ? data : null
        const next = embedded ? normalizeStatus(embedded) : await fetchStatus()
        setStatus(next)
        return next
      }

      const refresh = async () => {
        try {
          await run('refresh', async () => {
            const next = await fetchStatus()
            setStatus(next)
            setPhase('ready')
          })
        } catch (failure) {
          setNotice({ tone: 'error', text: t('state.actionFailed', { error: errorText(failure) }) })
        }
      }

      const toggleConfig = (field, next) => run('config-toggle', () => commitPatch({ [field]: next }))

      const saveSettings = async (patch) => {
        const next = await run('settings', () => commitPatch(patch))
        if (next) setNotice({ tone: 'ok', text: t('common.saved') })
        return next
      }

      const saveTarget = async (target, payload) => {
        const next = await run('target:' + target.id, () => {
          const targets = status.targets.map((item) => (item.id === target.id ? payload : targetConfigOf(item)))
          return commitPatch({ targets })
        })
        if (next) setNotice({ tone: 'ok', text: t('common.saved') })
        return next
      }

      const deleteTarget = async (target) => {
        const next = await run('target:' + target.id, () => {
          const targets = status.targets.filter((item) => item.id !== target.id).map(targetConfigOf)
          return commitPatch({ targets })
        })
        if (next) setNotice({ tone: 'ok', text: t('common.saved') })
        return next
      }

      const addTarget = async (payload) => {
        const next = await run('target:add', () => {
          const targets = status.targets.map(targetConfigOf).concat([targetConfigOf(payload)])
          return commitPatch({ targets })
        })
        if (next) setNotice({ tone: 'ok', text: t('common.saved') })
        return next
      }

      const quickConnect = async (payload) => {
        const data = await run('quick-connect', () => requestPayload('/connect', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(payload),
        }))
        if (data && data.status && looksLikeStatus(data.status)) setStatus(normalizeStatus(data.status))
        else await fetchStatus()
        return data
      }

      const getPairCode = async (targetId) => {
        const suffix = targetId ? '?targetId=' + encodeURIComponent(targetId) : ''
        return await requestJson('/pair/code' + suffix)
      }

      const applyPair = async (code) => {
        const data = await run('pair', () => requestPayload('/pair', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ code, sync: true }),
        }))
        if (data && data.status && looksLikeStatus(data.status)) setStatus(normalizeStatus(data.status))
        else await fetchStatus()
        return data
      }

      const testTarget = async (target, payload) => {
        return run('test:' + target.id, () =>
          requestPayload('/test', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ target: payload }),
          }),
        )
      }

      const saveRoot = async (root, payload) => {
        const next = await run('root:' + root.id, () => {
          const roots = status.roots.map((item) => (item.id === root.id ? payload : rootConfigOf(item)))
          return commitPatch({ roots })
        })
        if (next) setNotice({ tone: 'ok', text: t('common.saved') })
        return next
      }

      const deleteRoot = async (root) => {
        const next = await run('root:' + root.id, () => {
          const roots = status.roots.filter((item) => item.id !== root.id).map(rootConfigOf)
          return commitPatch({ roots })
        })
        if (next) setNotice({ tone: 'ok', text: t('common.saved') })
        return next
      }

      const addRoot = async (payload) => {
        const next = await run('root:add', () => {
          const roots = status.roots.map(rootConfigOf).concat([rootConfigOf(payload)])
          return commitPatch({ roots })
        })
        if (next) setNotice({ tone: 'ok', text: t('common.saved') })
        return next
      }

      const runSync = async (mode) => {
        await run('sync', async () => {
          const data = await requestPayload('/sync', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ mode }),
          })
          setReports(Array.isArray(data.reports) ? data.reports : [])
          const next = await fetchStatus()
          setStatus(next)
          if (data.ok === false) {
            setNotice({ tone: 'warn', text: t('state.actionFailed', { error: textOf(data.error) || t('common.none') }) })
          } else {
            setNotice({ tone: 'ok', text: t('status.syncDone') })
          }
        })
      }

      const exportArchive = async (scope = 'roots') => {
        const pendingKey = scope === 'full' ? 'export-full' : scope === 'app' ? 'export-app' : 'export'
        await run(pendingKey, async () => {
          const data = await requestJson('/export', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(scope === 'roots' ? {} : { scope }),
          })
          if (!data.url) throw new Error(t('transfer.missingUrl'))
          // 下载链接也走同源 fetch，才能带上 UI token；再转 Blob 交给浏览器保存。
          const response = await fetch(data.url, {
            credentials: 'same-origin',
            headers: withUiToken(),
          })
          if (!response.ok) {
            let message = 'HTTP ' + response.status
            try {
              const payload = await response.json()
              if (payload && typeof payload.error === 'string' && payload.error) message = payload.error
            } catch {}
            throw new Error(message)
          }
          const blob = await response.blob()
          const objectUrl = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = objectUrl
          anchor.download = textOf(data.name) || 'dsh-sync.dshsync'
          anchor.rel = 'noopener'
          const host = sectionRef.current
          if (host) host.appendChild(anchor)
          anchor.click()
          if (host) host.removeChild(anchor)
          setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
          const skippedTooBig = Array.isArray(data.workspaces?.skippedTooBig) ? data.workspaces.skippedTooBig : []
          const baseText = t('transfer.exportDone', { name: textOf(data.name) || t('common.none'), size: formatBytes(data.size) || t('common.none') })
          setNotice(
            skippedTooBig.length > 0
              ? {
                  // 「完整备份」要不完整就明说，不能让用户以为已经在手里了。
                  tone: 'warn',
                  text: t('transfer.exportFullSkipped', {
                    base: baseText,
                    names: skippedTooBig.map((item) => textOf(item.title)).filter(Boolean).join('、'),
                  }),
                }
              : { tone: 'ok', text: baseText },
          )
          try {
            setStatus(await fetchStatus())
          } catch {}
        })
      }

      const importArchive = async (file) => {
        await run('import', async () => {
          const data = await requestPayload('/import', {
            method: 'POST',
            headers: {
              'content-type': 'application/gzip',
              'x-filename': headerFileName(file.name),
            },
            body: file,
          })
          const report = data.report && typeof data.report === 'object' ? data.report : {}
          if (data.ok === false && !data.report) throw new Error(textOf(data.error) || t('common.none'))
          setNotice({
            tone: data.ok === false ? 'warn' : 'ok',
            text: t('transfer.importDone', {
              imported: Number(report.imported) || 0,
              unchanged: Number(report.unchanged) || 0,
              conflicts: Number(report.conflicts) || 0,
              skipped: Number(report.skipped) || 0,
              errors: Number(report.errors) || 0,
            }),
          })
          try {
            setStatus(await fetchStatus())
          } catch {}
        })
      }

      const busy = pending !== '' || (status && status.busy === true)

      // 同步/传输进行中定时刷新 status：实时字节来自引擎的 progress 快照，
      // 不轮询就只能等结束后看到一次平均值。
      React.useEffect(() => {
        if (!busy) return undefined
        const poll = setInterval(() => {
          fetchStatus()
            .then((next) => setStatus(next))
            .catch(() => {})
        }, 800)
        return () => clearInterval(poll)
      }, [busy, fetchStatus])

      if (phase === 'loading') {
        return h(
          'div',
          { className: 'dsync-section' },
          h('style', null, CSS),
          h('h2', { className: 'dsync-title' }, t('title')),
          h('p', { className: 'dsync-intro' }, t('intro')),
          h(
            'div',
            { className: 'dsync-card' },
            h(
              'div',
              { className: 'dsync-loading', role: 'status' },
              h('span', { className: 'dsync-spinner' }),
              h('span', null, t('state.loading')),
            ),
          ),
        )
      }

      if (phase === 'error' || !status) {
        return h(
          'div',
          { className: 'dsync-section' },
          h('style', null, CSS),
          h('h2', { className: 'dsync-title' }, t('title')),
          h('p', { className: 'dsync-intro' }, t('intro')),
          h(
            'div',
            { className: 'dsync-card' },
            h('p', { className: 'dsync-inlineMsg dsync-inlineMsg--error', role: 'alert' }, t('state.loadFailed', { error: loadError })),
            h('p', { className: 'dsync-hint' }, t('state.loadFailedHint')),
            h(
              'div',
              { className: 'dsync-actions' },
              h('button', { type: 'button', className: 'dsync-btn dsync-btn--primary', onClick: loadInitial }, t('common.retry')),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'dsync-section', ref: sectionRef },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dsync-head' },
          h(
            'div',
            null,
            h('h2', { className: 'dsync-title' }, t('title')),
            h('p', { className: 'dsync-intro' }, t('intro')),
          ),
          h(
            'div',
            { className: 'dsync-cardActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsync-btn',
                disabled: busy,
                onClick: refresh,
              },
              pending === 'refresh' ? t('common.refreshing') : t('common.refresh'),
            ),
          ),
        ),
        status.busy
          ? h('div', { className: 'dsync-notice dsync-notice--warn', role: 'status' }, t('state.busy'))
          : null,
        configWarnings.length > 0
          ? h(
              'div',
              { className: 'dsync-notice dsync-notice--warn', role: 'alert' },
              h(
                'div',
                { className: 'dsync-warnText' },
                h('span', { className: 'dsync-warnTitle' }, t('state.configWarnings', { n: configWarnings.length })),
                h(
                  'ul',
                  { className: 'dsync-warnList' },
                  configWarnings.slice(0, 5).map((warning, index) => h('li', { key: index }, warning)),
                ),
                configWarnings.length > 5
                  ? h('p', { className: 'dsync-warnTitle' }, t('state.warningsMore', { n: configWarnings.length - 5 }))
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsync-btn dsync-btn--text',
                  'aria-label': t('common.dismiss'),
                  onClick: () => setConfigWarnings([]),
                },
                t('common.dismiss'),
              ),
            )
          : null,
        notice
          ? h(
              'div',
              { className: 'dsync-notice dsync-notice--' + (notice.tone || 'ok'), role: notice.tone === 'error' ? 'alert' : 'status' },
              h('span', null, notice.text),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsync-btn dsync-btn--text',
                  'aria-label': t('common.dismiss'),
                  onClick: () => setNotice(null),
                },
                t('common.dismiss'),
              ),
            )
          : null,
        h(StatusCard, {
          t,
          status,
          busy,
          pending,
          reports,
          onToggleConfig: toggleConfig,
          onSaveSettings: saveSettings,
          onSync: runSync,
        }),
        h(TargetsSection, {
          t,
          status,
          busy,
          pending,
          onSaveTarget: saveTarget,
          onDeleteTarget: deleteTarget,
          onAddTarget: addTarget,
          onTestTarget: testTarget,
          onCopyCode: getPairCode,
        }),
        h(RootsSection, {
          t,
          status,
          busy,
          pending,
          onSaveRoot: saveRoot,
          onDeleteRoot: deleteRoot,
          onAddRoot: addRoot,
        }),
        h(PeerCard, { t, peer: status.peer, busy, onGetCode: getPairCode, onApplyPair: applyPair }),
        h(TransferCard, {
          t,
          busy,
          pending,
          onExport: () => exportArchive('roots'),
          onExportFull: () => exportArchive('full'),
          onExportApp: () => exportArchive('app'),
          onImport: importArchive,
        }),
        h(LogsCard, { t, status }),
        // 快速开始放在最底部：老用户不需要它，新用户仍能一眼找到（折叠态可见摘要 + 展开按钮）。
        h(WebdavQuickCard, { t, status, busy, pending, onConnect: quickConnect }),
        h('p', { className: 'dsync-footer' }, t('footer.note')),
      )
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sync: settings locales')
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-sync',
              order: 60,
              label: () => t('nav'),
              locale: NS,
            },
            (props) => h(SyncSection, { t: props && typeof props.t === 'function' ? props.t : t }),
          ),
        )
      },
    }
  },
})