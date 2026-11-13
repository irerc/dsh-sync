# DSH 多设备同步插件 `dsh-sync` 实施规格（冻结版 v1）

> 本文件是团队协作契约。所有实现必须严格按此接口、路径、字段名与语义执行。
> 不允许擅自改接口；确需变更先写进 `SPEC-CHANGELOG.md` 并通知 Lead。

## 1. 目标

一个可安装的 DSH bundle：把**用户选定的本地目录**（DSH profile、会话记录、工作区文档等）
以**内容快照**形式发布到多种“文件型”存储，并在多设备间做双向、增量、可冲突保护的无缝同步。

必须同时支持：

| 传输 | 说明 |
|---|---|
| `local` | 本地目录 / 已挂载的网盘（如 rclone、Termux SAF 挂载点）。本质是文件系统路径。 |
| `webdav` | 标准 WebDAV（Nextcloud、坚果云、群晖、Alist 等），走 HTTP PUT/GET/HEAD/MKCOL/PROPFIND。 |
| `peer` | 另一台正在运行本插件的 DSH：直连其 `/dsh-sync/v1/*` HTTP 协议（无需第三方服务）。 |
| 本地发送 | `.dshsync` 单文件归档的导出/导入（浏览器下载/上传 + Agent 工具 + 本地路径）。 |

同时支持配置**多个 target**，一轮同步扇出到所有启用 target（每个 target 独立基线）。

扩展包必须具备：**导入、导出、自动保存（auto-save）**，且 DSH 设置页有完整 UI。

## 2. 包结构（全部位于 `/root/多设备同步`）

```
package.json                 # name: dsh-sync, dsh.bundle.patch, dsh.client, exports
cordis.patch.yml             # 插入 dsh-sync 行
lib/index.js                 # Host apply：装配 store/engine/routes/tools/scheduler
lib/config.js                # 配置默认值、路径展开、校验、归一化
lib/state.js                 # 配置与状态持久化（$DSH_HOME/dsh-sync）
lib/util.js                  # 共享工具（已由 Lead 提供，勿改签名）
lib/engine/hash.js           # sha256
lib/engine/scan.js           # 目录扫描 + 排除 + 大小限制 + hash 缓存
lib/engine/manifest.js       # 设备 manifest 结构/校验/合并
lib/engine/merge.js          # 三方合并计划
lib/engine/archive.js        # .dshsync tar.gz 读写（子智能体 A）
lib/engine/engine.js         # SyncEngine 编排（扫描/合并/执行/导入导出/自动任务）
lib/backends/index.js        # createBackend 工厂（子智能体 B）
lib/backends/local.js        # 本地目录后端（子智能体 B）
lib/backends/webdav.js       # WebDAV 后端（子智能体 B）
lib/backends/peer.js         # DSH 对等 HTTP 后端（子智能体 B）
lib/http-api.js              # /dsh-sync 路由：UI API + peer 协议
lib/tools.js                 # Agent 工具
lib/client.js                # Web 设置页（子智能体 C）
locale/zh.json locale/en.json icon.svg（子智能体 C）
test/*.test.mjs              # node:test
README.md                    # 由验证子智能体汇总
```

依赖：**不得新增 npm 依赖**。只用 Node 内置模块（`node:fs/promises`、`node:path`、
`node:crypto`、`node:zlib`、`node:http`、`node:os`、`node:url`）与宿主注入的服务。
浏览器端只 `require('react')`。

## 3. 同步模型

### 3.1 key

```
key = `${rootId}/${relativePosixPath}`
```
例：`profile/cordis.patch.yml`、`sessions/--root-Documents-...--/session-x/events.jsonl`。

根目录（root）由配置给出：`{ id, label, path, enabled, exclude }`。
不允许根目录互相嵌套/重复；`path` 必须是绝对路径且存在；禁止 `/`。

### 3.2 设备 manifest（后端上的文件）

后端路径：`devices/<deviceId>.json`；对象：`objects/<sha256>`。

```json
{
  "format": "dsh-sync-manifest",
  "version": 1,
  "deviceId": "b3f...",
  "deviceName": "phone",
  "generatedAt": 1760000000000,
  "entries": [
    { "key": "profile/cordis.patch.yml", "root": "profile", "path": "cordis.patch.yml",
      "hash": "sha256hex", "size": 1234, "mtimeMs": 1760000000000,
      "updatedAt": 1760000000000, "deviceId": "b3f..." }
  ],
  "tombstones": [
    { "key": "sessions/x/old.jsonl", "root": "sessions", "path": "x/old.jsonl",
      "deleted": true, "updatedAt": 1760000000000, "deviceId": "b3f..." }
  ]
}
```

- `entries` 与 `tombstones` 均按 `key` 升序；`key/root/path/hash` 必须自洽。
- 校验失败的文件视为不存在（记录 warn），不得让同步崩溃。
- 多设备合并：同一 key 取 `(updatedAt, deviceId)` 字典序最大者；tombstone 参与比较，`deleted:true`。

### 3.3 三方合并规则

输入：`local`（本次本地扫描，Map）、`remote`（多设备合并后的 Map，可能 `deleted`）、
`base`（上次成功同步后的 key→hash，Map）。

| local | remote | 相对 base | 动作 |
|---|---|---|---|
| 同 hash | 同 hash | 任意 | 仅更新 base |
| local == base | remote 有新值 | — | **pull** 远端 |
| local == base | remote 删除 | — | **deleteLocal** |
| remote == base | local 有新值 | — | **push** 本地 |
| remote == base | local 删除 | — | **pushTombstone** |
| 双方都改（hash 不同，均 ≠ base） | | | **conflict**：本地保留，远端内容写冲突副本 `name.conflict-<device8>-<ISO>.ext`，冲突副本在下一轮作为新本地文件上传；记冲突日志 |
| local 全新 | remote 全新且 hash 不同 | base 缺 | 按 `updatedAt` 较新者胜；较旧内容保存为冲突副本（若远端胜则 pull 远端并把旧本地保存为冲突副本） |
| local 删除 | remote 修改 | — | **restore** 远端（冲突记录） |
| remote 删除 | local 修改 | — | **push** 本地（复活，冲突记录） |
| 双方都删 | | | 清 base |

`pull` 写文件必须：`mkdir -p`、写 `.dsh-sync-tmp-*` 后 `rename`、尽量恢复 `mtime`；
写入前校验路径安全（见 3.4）。`deleteLocal` 只删文件，空目录可忽略。

### 3.4 路径安全（强制）

- 拒绝绝对路径、`..` 段、`\`、NUL、空段、Windows 盘符。
- 写入前 `realpath(root)` + `path.resolve(root, rel)`，必须仍在 root 内。
- 扫描与写入都跳过符号链接（文件与目录），并记录 `symlink` 跳过。
- 后端对象名只允许 `[a-f0-9]{64}`（sha256）。
- 归档解包拒绝任何越界路径。

### 3.5 大小/排除

- `maxFileBytes`（默认 32 MiB）：超限文件不进入快照，日志记录（每文件一次）；上限可配到 1 GiB。
- 排除匹配（`exclude` 数组）：支持 `*`、`?`、`**`；`dir/**`；`**/*.ext`。
- `$DSH_HOME` 内始终排除敏感文件（不可配置）：
  `**/.credentials.yaml`、`**/credentials.key`、`**/cookies*`、`**/jar-*.json`、
  `**/*.key`、`**/*.pem`、`**/id_rsa*`。
- 扫描按路径排序，保证 manifest 稳定。

## 4. 配置与状态

目录：`$DSH_HOME/dsh-sync/`（0700；文件 0600）。

`config.json`：

```json
{
  "version": 1,
  "deviceName": "phone",
  "autoSync": true,
  "autoSave": true,
  "syncOnStart": true,
  "autoSaveIntervalSeconds": 20,
  "autoSyncIntervalSeconds": 180,
  "maxFileBytes": 33554432,
  "peerToken": "随机 32 hex",
  "peerStorePath": "$DSH_HOME/dsh-sync/peer-store",
  "roots": [
    { "id": "profile", "label": "DSH 配置", "path": "$DSH_HOME/profiles/$DSH_PROFILE", "enabled": true,
      "exclude": ["node_modules/**", ".plugin-manager/**", "*.bak-*", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"] },
    { "id": "sessions", "label": "会话记录", "path": "$DSH_HOME/sessions", "enabled": true, "exclude": [] },
    { "id": "documents", "label": "工作区文档", "path": "$HOME/Documents", "enabled": false, "exclude": ["node_modules/**", ".git/**"] }
  ],
  "targets": [
    { "id": "local", "type": "local", "label": "本地/挂载目录", "enabled": true,
      "path": "$DSH_HOME/dsh-sync/store" },
    { "id": "dav", "type": "webdav", "label": "WebDAV", "enabled": false,
      "url": "", "username": "", "password": "", "basePath": "/dsh-sync" },
    { "id": "peer", "type": "peer", "label": "另一台 DSH", "enabled": false,
      "url": "", "token": "" }
  ]
}
```

路径展开支持 `${DSH_HOME}`、`$DSH_HOME`、`$HOME`、`$DSH_PROFILE`、`~` 前缀。
`state.json`：

```json
{
  "version": 1,
  "deviceId": "32hex",
  "createdAt": 0,
  "targets": {
    "local": {
      "base": { "profile/cordis.patch.yml": { "hash": "...", "size": 1, "mtimeMs": 2, "updatedAt": 3 } },
      "lastSyncAt": 0,
      "lastResult": { "ok": true, "pulled": 0, "pushed": 0, "deletedLocal": 0, "tombstoned": 0, "conflicts": 0, "skipped": 0, "durationMs": 0 }
    }
  },
  "logs": [ { "at": 0, "level": "info", "message": "..." } ],
  "conflicts": [ { "at": 0, "key": "...", "copy": "...", "reason": "..." } ]
}
```

日志/冲突环形缓冲上限 500/200。所有写入原子化（tmp + rename）。

## 5. 后端接口（子智能体 B）

`lib/backends/index.js`：

```js
export async function createBackend(target, options = {}) // => SyncBackend
// options: { fetchImpl = globalThis.fetch, logger, signal }
```

`SyncBackend`：

```js
{
  type: 'local' | 'webdav' | 'peer',
  targetId: string,
  async init(),                       // 建目录/探测，幂等；失败抛 Error（消息可展示）
  async test(),                       // => { ok: boolean, detail: string }，不抛
  async listDevices(),                // => string[]（deviceId 列表）
  async readManifest(deviceId),       // => object | null（不存在返回 null）
  async writeManifest(deviceId, obj), // 原子写（后端自身机制）
  async hasObject(hash),              // => boolean
  async readObject(hash),             // => Uint8Array | null
  async writeObject(hash, bytes),     // 幂等；已存在可跳过
  async describe(),                   // => { type, label, detail } 不含密码
  async close()                       // 可空
}
```

### local

- `init`：`mkdir -p <path>/devices <path>/objects`。
- manifest 写入 tmp+rename；对象写入 tmp+rename。
- `readObject` 校验 hash 长度与文件名。

### webdav

- 配置：`url`（如 `https://dav.example.com/remote.php/dav/files/u`）、`username`、`password`、`basePath`（默认 `/dsh-sync`）。
- 最终根 = `url` 去尾斜杠 + basePath（确保 `/`）。
- 认证：`Authorization: Basic base64(user:pass)`。
- `init`：对根与 `devices`、`objects` 逐级 `MKCOL`（405 视为已存在）。
- `writeManifest`：`PUT`；`readManifest`：`GET`，404→null。
- `listDevices`：`PROPFIND` `devices/`，`Depth: 1`；解析 `<d:href>` / `<href>`，取以 `.json` 结尾的 basename，URL 解码。
- `hasObject`：`HEAD objects/<hash>`，200/204→true，404→false。
- `writeObject`：先 `hasObject`，不存在再 PUT。
- 超时：每次请求 `AbortSignal.timeout(60_000)`；4xx/5xx 抛带状态码的错误。
- `test`：MKCOL 根 + 写/读/删一个小探测文件（失败不抛）。

### peer

- 配置：`url`（形如 `https://other-host:port`，可含 path 前缀）、`token`。
- 协议根：`<url>/dsh-sync/v1`。
- 认证头：`x-dsh-sync-token: <token>`。
- `GET ping` → `{ ok:true, protocol:1, deviceId, deviceName }`（200）。
- `GET devices` → `{ devices: string[] }`。
- `GET devices/<id>` → manifest JSON；404→null。
- `PUT devices/<id>` → `{ ok:true }`。
- `HEAD objects/<hash>`；`GET/PUT objects/<hash>`（PUT body 原始字节，`content-type: application/octet-stream`）。
- 401 → 抛 `token 无效`；非 2xx 抛带状态。
- `test`：ping + 写读一个空 manifest 探测（用随机 deviceId `probe-<rand>`，随后不删也行；但不要污染列表：改用 `HEAD objects/<全0hash>` 探测权限 + ping）。

## 6. 归档 `.dshsync`（子智能体 A）

`lib/engine/archive.js`：

```js
export async function buildArchive({ manifest, readObject, signal }) // => { bytes: Uint8Array, sha256, size }
export async function parseArchive(bytes) // => { manifest, objects: Map<hash, Uint8Array> }
```

格式：`gzip(ustar)`。成员：

- `manifest.json`：上述 manifest（UTF-8，JSON，无 BOM；`generatedAt` 为导出时刻）。
- `objects/<sha256>`：每个 manifest entries 引用的对象，去重。

要求：

- 只实现 USTAR（无长文件名扩展），成员路径 ≤ 100 字符；超长路径用 `prefix` 字段（155）。
- 头部字段：mode `0000644`、uid/gid `0000000`、size 八进制 11 位+空格、mtime、chksum、typeflag `0`、magic `ustar\0`、version `00`。
- 解析时跳过 `./` 前缀与目录项；校验每个对象文件名 = sha256(内容)。
- 解压用 `zlib.gunzipSync`；输入上限 512 MiB，成员总解压上限 512 MiB，超限抛错。
- 解析拒绝重复成员、绝对路径、`..`、非 `manifest.json`/`objects/*` 的成员（忽略但计数）。
- 纯函数/可单测；不得依赖 Host 上下文。

导入时的合并由 `engine.js` 负责（把归档 manifest 当 remote）。

## 7. HTTP API（Lead 实现，UI 依赖）

统一前缀 `/dsh-sync`。JSON 响应均带 `ok`；错误 `{ ok:false, error:"..." }` 与 4xx/5xx。

同源校验（UI 路由）：存在 `Origin` 时 host 必须与请求 `Host` 一致，否则 403。
UI 鉴权：`/api/*` 还必须带 `x-dsh-sync-ui-token: <state.uiToken>`，否则 401。token 不通过 API 返回，只由 `webServer.tapIndex` 注入到受 DSH 浏览器鉴权保护的 index 页面（`<meta name="dsh-sync-ui-token">`）；下载同样只认请求头。
Peer 路由必须校验 `x-dsh-sync-token === config.peerToken`，否则 401。

### UI API

| 方法/路径 | 说明 |
|---|---|
| `GET /api/status` | 见下方状态结构 |
| `POST /api/config` | body `{ patch: Partial<Config> }`（顶层浅合并；`roots`/`targets` 整体替换）。校验失败 400。返回新 status。 |
| `POST /api/sync` | body `{ mode?: 'auto'\|'push'\|'pull', targetId?: string }`。返回 `{ ok, reports:[SyncReport] }` |
| `POST /api/test` | body `{ target }`（未保存草稿）。返回 `{ ok, detail }` |
| `POST /api/export` | 空 body。生成本地快照归档到 `exports/`，返回 `{ ok, name, size, url }` |
| `GET /api/download/<id>` | 下载归档（`application/gzip`，attachment） |
| `POST /api/import` | 原始 `.dshsync` 字节；`x-filename` 可选。返回 `{ ok, report }` |
| `GET /api/pair/code?targetId=<id>` | 生成一键配对码。无 `targetId` 时为本机 peer（回环地址自动替换为局域网 IP，并返回 `warning`）；指定 `targetId` 时导出该 WebDAV/peer target 的完整连接信息。返回 `{ ok, code, summary, warning }` |
| `POST /api/connect` | body 直接给 target 字段 `{ type, url?, username?, password?, basePath?, path?, token?, label?, sync? }`；调用 `connectTarget` 去重后新增/更新，默认测试+同步。返回与 `/api/pair` 同形 |
| `POST /api/pair` | body `{ code, sync?: boolean }`。解析 `DSHSYNC1.` 码，按类型+地址+用户名去重后新增/更新 target；默认测试连接并同步。返回 `{ ok, target, test, report, error, warnings, status }`；码无效 400 |
| `GET /api/logs` | `{ ok, logs, conflicts }` |

`GET /api/status` 结构：

```json
{
  "ok": true,
  "deviceId": "...", "deviceName": "phone",
  "autoSync": true, "autoSave": true, "syncOnStart": true,
  "autoSaveIntervalSeconds": 20, "autoSyncIntervalSeconds": 180,
  "maxFileBytes": 33554432,
  "roots": [ { "id":"profile", "label":"DSH 配置", "path":"/root/.dsh/profiles/web", "enabled":true, "exclude":["..."] } ],
  "targets": [ {
    "id":"local", "type":"local", "label":"本地/挂载目录", "enabled":true,
    "detail":"/root/.dsh/dsh-sync/store", "path":"/root/.dsh/dsh-sync/store",
    "lastSyncAt": 0,
    "lastResult": { "ok":true,"pushed":0,"pulled":0,"conflicts":0,"skipped":0,"durationMs":0 }
  } ],
  "peer": { "url":"http://<lan-ip>:<port>/dsh-sync/v1", "token":"..." },
  "logs": [ { "at":0, "level":"info", "message":"..." } ],
  "conflicts": [ { "at":0, "key":"...", "copy":"...", "reason":"..." } ],
  "busy": false
}
```

- 配置中的 `password`/`token` 在 status 中以 `"***"` 返回；`peer.token` 单独明文给出（用于配对复制）。
- 配对码格式：`DSHSYNC1.<base64url(JSON)>`。peer 载荷 `{v:1,type:"peer",url,token,label,deviceName}`；webdav 载荷 `{v:1,type:"webdav",url,username,password,basePath,label,deviceName}`。码内含凭据，只应发给可信设备，Host 不写日志。
- `url` 使用 `webServer.getOrigin()` 拼接 `/dsh-sync/v1`；取不到时用 `http://127.0.0.1:3080`。

### Peer 协议

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/ping` | `{ ok, protocol:1, deviceId, deviceName, requiresToken:true }`（无需 token） |
| `GET /v1/devices` | `{ devices: string[] }` |
| `GET /v1/devices/<id>` | manifest JSON，404 |
| `PUT /v1/devices/<id>` | 保存 manifest（< 2 MiB），`{ ok:true }` |
| `HEAD /v1/objects/<hash>` | 200/404 |
| `GET /v1/objects/<hash>` | 原始字节 |
| `PUT /v1/objects/<hash>` | 原始字节，幂等 |

Peer 服务端存储：`createBackend({ type:'local', path: config.peerStorePath })`。

## 8. Agent 工具（Lead 实现）

| 名称 | 参数 | 行为 |
|---|---|---|
| `dsh_sync_status` | 无 | 返回设备、targets、上次结果、冲突数、待处理提示 |
| `dsh_sync_run` | `mode?: 'auto'\|'push'\|'pull'`, `targetId?: string` | 执行同步，返回每个 target 的报告 |
| `dsh_sync_configure` | `type:'webdav'\|'peer'\|'local'`, `url?`, `username?`, `password?`, `basePath?`, `token?`, `path?`, `label?`, `sync?`, `targetId?` | 按口述信息新增/更新 target；同类型+地址（WebDAV 再加用户名）去重；默认 testTarget + sync；输出不回显密码/token |
| `dsh_sync_pair` | `code: string`, `sync?: boolean` | 解析 `DSHSYNC1.` 配对码并应用，默认测试 + 同步 |
| `dsh_sync_export` | `targetId?`（可选，仅命名用） | 导出 `.dshsync` 到 `$DSH_HOME/dsh-sync/exports/`，返回绝对路径/大小 |
| `dsh_sync_import` | `path: string` | 导入本地 `.dshsync` 文件，返回合并报告 |

工具必须：`ctx.inject(['tools'], ...)` + `ctx.effect` 注册；`execute` 失败时 throw 可读错误；
输出 schema `{ type:'string' }`，`render` 返回 text。工具名全局唯一。

## 9. Web 设置页（子智能体 C）

注册 `settings.section`：`id: 'dsh-sync'`, `order: 60`, `label: () => t('nav')`,
`locale: 'dsh-sync'`。注入 `['slots','locale']`。纯 React（`require('react')`），
**禁止** 引入任何 `@deepseek-ai/*` 运行时模块，禁止 iframe，禁止写 `document.body`。

数据全部走同源 `fetch`，base `/dsh-sync/api`；所有请求必须带 `x-dsh-sync-ui-token`（从 index 注入的 meta 读取），导出下载同样用带 header 的 `fetch` 转 Blob。必须覆盖：

1. 顶部状态卡：设备名、上次同步时间/结果、自动同步开关、自动保存开关、两个间隔数字、`立即同步 / 仅上传 / 仅下载` 按钮。
2. Targets：卡片列表（类型、启用开关、编辑字段、测试连接、删除）；新增 target（local/webdav/peer）。密码字段 `type=password`。
3. Roots：列表（label/path/启用/排除项文本，一行一个）；新增 root。提醒“路径必须是绝对路径”。
4. Peer 配对：展示只读 `url` + `token`（复制按钮），文案说明“在另一台设备添加 peer target 填这两个值”。
5. 导入/导出：导出按钮触发下载（用返回的 `url` 创建 `<a download>` 点击）；导入 `<input type=file accept=".dshsync">` → `fetch` 原始字节 POST。
6. 活动日志（最近 20 条）与冲突列表；空态文案。
7. 所有可见文案走 locale（zh/en 字典）；`t('key', {x})` 插值契约与 auto-compact 相同（`ctx.locale.bind(NS)`）。
8. 只使用 `--dsw-alias-*` 主题 token，类名统一 `dsync-` 前缀；样式通过组件内 `<style>` 注入。
9. 按钮 busy/禁用、错误就地显示；切换 target 类型时字段联动。
10. 首次加载 loading 态；status 请求失败显示可重试错误。

组件 props：`SettingsSectionOwnerProps = { close }`，无需使用。建议结构：

```js
window.__ModuleLoader__.load({ id: 'dsh-sync', factory(require) { ... return { inject:['slots','locale'], apply(ctx){...} } } })
```

`package.json` 的 `dsh.client`：`{ platform:'web', immediately:true, inject:['@deepseek-ai/dsh-client-ui-settings'] }`。

## 10. 自动保存 / 自动同步（Lead 实现）

- `autoSave`：每 `autoSaveIntervalSeconds` 扫描本地；有变更则对每个启用 target 执行 push（不拉取）。
- `autoSync`：每 `autoSyncIntervalSeconds` 对每个启用 target 执行完整双向同步。
- `syncOnStart`：启动后 8s 触发一次完整同步（错开启动高峰）。
- 所有自动任务串行化；失败只记日志，不得抛到进程。
- `apply` 卸载时必须清理所有 timer/listener。

## 11. 验收（每项必须有命令与输出证据）

1. `node --test test/*.test.mjs`：合并规则、路径安全、归档往返、三个后端（本地/WebDAV mock/peer）、导入导出。
2. 真实双实例：两个临时 `DSH_HOME` + 不同 deviceId，经 local target 互相同步，文件/新增/修改/删除/冲突副本全部收敛。
3. 设置页安装后可打开（截图/接口验证），无 slot crash；`GET /dsh-sync/api/status` 返回结构正确。
4. `dsh_sync_export` → 改文件 → `dsh_sync_import` 往返可用。
5. 重启 DSH 后配置/状态仍在；自动同步 timer 正常。

## 12. 协作纪律

- 只改自己 scope 内文件；跨文件接口变更先改本 SPEC 并通知 Lead。
- 禁止修改 profile 的 `package.json` / `cordis.patch.yml`；安装只走 `plugin_manager`（Lead）。
- 每个交付必须附：改动文件清单 + 运行命令 + 真实输出摘要 + 已知限制。
- 不确定的实现选择写进 `NOTES-<name>.md`，不要静默猜测。
## 13. 口径修订（CHANGELOG）

- 2026-11-08：peer target 的 `url` 增加归一化容错。`resolveProtocolBase(url)`：
  - 已以 `/dsh-sync/v1` 结尾 → 原样；
  - 以 `/dsh-sync` 结尾 → 补 `/v1`；
  - 其他（origin 或自定义前缀）→ 补 `/dsh-sync/v1`。
  这样设置页展示的完整配对 URL 可以复制即用，不会出现双重前缀。
- 2026-11-08：设置页回传的 `password` / `token` 为 `"***"` 时，Host 端按 target.id 回查已保存配置并保持原值；`POST /api/test` 同样补齐。
- 2026-11-08：`webServer` 自定义路由不经过 DSH 浏览器鉴权，`/api/*` 增加 `x-dsh-sync-ui-token` 强制校验；token 仅注入受保护的 index。
- 2026-11-08：扫描把“排除/超大/链接/读失败/禁用或未知根目录”记为 ignored，合并时既不当成本地删除也不写墓碑，避免误删其他设备副本；`maxFileBytes` 默认 32 MiB。
- 2026-11-08：导出先读取实际字节并重建 hash/size，修复“扫描后文件被追加导致对象 sha256 不匹配”的 500；下载只认 UI token 请求头。
- 2026-11-08：新增 `/api/connect` 与设置页「WebDAV 快速开始」（仅 url/username/password，basePath 默认 `/dsh-sync`，保存即测试并同步）；WebDAV 卡片置于页面最上方。
- 2026-11-08：新增一键配对码 `DSHSYNC1.<base64url>`（peer / webdav），`GET /api/pair/code` + `POST /api/pair`，UI 支持复制/粘贴后自动新增 target 并同步；target 类型与列表改为 WebDAV 优先。
- 2026-11-08：`GET /api/status` 的 `targets[]` 同时包含非密字段（path/url/username/basePath），密钥字段以 `"***"` 或空串返回。
