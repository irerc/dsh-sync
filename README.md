# dsh-sync

DSH（DeepSeek Harness）的多设备同步插件：把**用户选定的本地目录**（DSH profile、会话记录、工作区文档等）以**内容快照**的形式发布到本地目录 / WebDAV / 另一台 DSH，并在多设备间做**双向、增量、可冲突保护**的同步；同时支持 `.dshsync` 单文件归档的导出与导入。

> 本 README 按 `SPEC.md`（冻结版 v1）描述行为。实现与验收以 SPEC 为准；测试计划与真实输出见 `NOTES-verify.md`。

---

## 1. 功能矩阵

| 能力 | 本地目录 / 网盘挂载 | WebDAV | 另一台 DSH（peer） | 本地发送（`.dshsync`） |
|---|---|---|---|---|
| 传输方式 | 文件系统路径 | HTTP PUT/GET/HEAD/MKCOL/PROPFIND | 本插件自己的 `/dsh-sync/v1` HTTP 协议 | 浏览器下载/上传、Agent 工具、本地路径 |
| 认证 | 由操作系统/挂载点决定 | HTTP Basic Auth | `x-dsh-sync-token` | 无（文件本身） |
| 增量同步 | ✅（内容 hash） | ✅ | ✅ | ✅（导入按 manifest 合并） |
| 删除传播 | ✅（tombstone） | ✅ | ✅ | ✅ |
| 冲突保护 | ✅（冲突副本） | ✅ | ✅ | ✅ |
| 是否需要第三方服务 | 否（rclone/Termux SAF 等挂载即可） | 需要 WebDAV 服务 | 否（点对点） | 否 |
| 多 target 扇出 | ✅（每个 target 独立基线） | ✅ | ✅ | — |
| DSH 设置页 UI | ✅ | ✅ | ✅ | ✅ |
| Agent 工具 | ✅ | ✅ | ✅ | ✅（导出/导入） |

三种 target 可以同时启用，一轮同步会扇出到所有启用的 target；**每个 target 维护独立的同步基线**，互不干扰。

---

## 2. 工作原理（三句话）

1. **内容寻址**：每个文件按 `sha256` 存成后端对象 `objects/<sha256>`；每台设备把自己的文件清单写成 `devices/<deviceId>.json`（entries + tombstones）。
2. **三方合并**：用「本地本次扫描 / 多设备清单合并结果 / 上次同步基线」做三方比较，得出 pull、push、删除、复活、冲突等动作。
3. **快照发布**：一轮同步先把本地变更推上去，再把远端变更拉下来；冲突时**本地内容保留**，远端内容另存为冲突副本。

后端目录布局（local / peer 存储一致）：

```
<store>/
├── devices/<deviceId>.json    # 设备 manifest
└── objects/<sha256>           # 文件内容（按 hash 去重）
```

---

## 3. 安装

前置条件：

- Node.js **≥ 20**；
- 可用的 DSH Web profile（`dsh web`）；
- 插件使用 Node 内置模块，**不新增任何 npm 依赖、没有构建步骤**，克隆即可运行。

### 方式 A：GitHub（其他设备推荐）

1. 打开 DSH Web GUI，侧边栏进入**插件**页；
2. 选择**安装组合包**，目标填写：

   ```text
   https://github.com/irerc/dsh-sync.git
   ```

   （也接受 `https://github.com/irerc/dsh-sync`）
3. 安装后确认 `dsh-sync` 出现在组合包列表中且已启用；未启用 HMR 时**重启 `dsh web`**；
4. 打开 **设置 → dsh-sync**，应能看到状态卡、targets、roots、peer 配对、导入导出与日志。

**已验证的安装 URL（2026-11-08 本机实测）：**

| 方式 | URL | 适用网络 |
|---|---|---|
| GitHub git | `https://github.com/irerc/dsh-sync.git` | 能访问 `github.com:443` |
| codeload tag tarball | `https://codeload.github.com/irerc/dsh-sync/tar.gz/refs/tags/v1.3.0` | `github.com` 被阻断但 `codeload.github.com` 可达；pnpm 可直接安装 |
| Release 资产 | `https://github.com/irerc/dsh-sync/releases/download/v1.3.0/dsh-sync-1.3.0.tgz` | 能访问 `github.com`；也可手动下载后在本地安装 |
| raw tarball（GUI 兼容） | `https://raw.githubusercontent.com/irerc/dsh-sync/main/dist/dsh-sync-1.3.0.tgz` | `github.com` 被阻断但 `raw.githubusercontent.com` 可达；URL 以 `.tgz` 结尾，插件管理器可直接识别 |

本机（`github.com:443` 被阻断、`codeload.github.com` 可达）实测通过的 CLI：

```bash
dsh plugin --profile web add https://codeload.github.com/irerc/dsh-sync/tar.gz/refs/tags/v1.3.0
# 或：raw tarball（GUI 安装也接受这个 URL）
dsh plugin --profile web add https://raw.githubusercontent.com/irerc/dsh-sync/main/dist/dsh-sync-1.3.0.tgz
```

> `v4.gh-proxy.org` 的 git 只读 `ls-remote` 可用，但 `git clone` 实测返回 403；因此**优先用 codeload tarball**，不要依赖镜像 clone。

如果所在网络直连 `github.com` 不稳定，再尝试镜像前缀（能否使用取决于你的网络环境）：

```text
https://v4.gh-proxy.org/https://github.com/irerc/dsh-sync.git
```

### 方式 B：本地目录（开发/离线）

1. 把本仓库放到目标设备（例如 `/root/dsh-sync`）；
2. 插件页 → **安装组合包** → 目标填该绝对路径；
3. 启用 `dsh-sync`，未启用 HMR 时重启 `dsh web`。

### 方式 C：CLI

```bash
# 1) 把插件加入 profile 依赖；git 地址会由 pnpm 安装到 node_modules
dsh plugin --profile web add https://github.com/irerc/dsh-sync.git

# 2) 在插件页勾选启用 dsh-sync（组合包状态写入 profile 的 package.json）
# 3) 未启用 HMR 时重启
dsh web
```

> 说明：`dsh plugin ... add` 只负责依赖安装；**组合包启用状态**需要在插件页选择，或由 `plugin_manager` 工具设置。安装/启用属于宿主操作，本插件不会自行修改 profile 配置。

升级：重新执行安装（git 地址拉取最新提交；tarball 地址换成新 tag），或替换本地目录后重装/重启。需要固定版本时用 tag：`.../tar.gz/refs/tags/v1.3.0`。配置与状态保存在 `$DSH_HOME/dsh-sync/`，不受升级影响。

---

## 4. 设置页使用

### 4.0 最快路径：WebDAV 只填三项

设置页**最上方**是「WebDAV 快速开始」：只填 **地址、账号、应用密码**，点「连接并同步」。子路径自动使用 `/dsh-sync`，target 名默认 `WebDAV`；保存后自动测试连接并立即同步，结果就地显示上传/下载/冲突/错误数。同一地址+账号再次提交是**更新**，不会重复新增。


设置页入口：**设置 → dsh-sync**（`settings.section`，order 60）。页面分六块：

1. **状态卡**：设备名、上次同步时间与结果、自动同步开关、自动保存开关、两个间隔（秒）、`立即同步` / `仅上传` / `仅下载` 按钮。
2. **Targets**：每个 target 一张卡片，可启用/停用、编辑字段、测试连接、删除；可新增 `local` / `webdav` / `peer` 三类 target。密码字段为 `type=password`，`测试连接` 使用未保存的草稿值。
3. **Roots**：要同步的本地根目录列表（label、绝对路径、启用开关、排除项一行一个）；可新增 root。路径必须是**绝对路径**且存在，root 之间不允许嵌套或重复，禁止 `/`。
4. **一键配对码**：可复制本机 peer 码，或复制任一 WebDAV/peer target 的配对码；在另一台设备粘贴后自动新增 target 并同步（详见 §6.1）。
5. **导入 / 导出**：`导出` 生成 `.dshsync` 并触发浏览器下载；`导入` 选择 `.dshsync` 文件后以原始字节上传。
6. **活动日志 / 冲突**：最近日志与冲突列表；无数据时显示空态文案。

所有按钮有 busy/禁用态，错误就地展示；首次加载有 loading 态，status 请求失败可重试。

---

## 5. 三种 target 配置示例

路径字段支持 `$DSH_HOME`、`$HOME`、`$DSH_PROFILE` 与 `~` 前缀，保存/加载时展开为绝对路径。以下示例也可直接写进 `$DSH_HOME/dsh-sync/config.json`。

### 5.1 webdav（推荐，跨网络首选）

支持 Nextcloud / 坚果云 / 群晖 / Alist 等。

```json
{
  "id": "dav",
  "type": "webdav",
  "label": "WebDAV",
  "enabled": true,
  "url": "https://cloud.example.com/remote.php/dav/files/alice",
  "username": "alice",
  "password": "应用密码",
  "basePath": "/dsh-sync"
}
```

最终根 = `url` 去尾斜杠 + `basePath`。示例：

| 服务 | url |
|---|---|
| Nextcloud | `https://cloud.example.com/remote.php/dav/files/<用户名>` |
| 坚果云 | `https://dav.jianguoyun.com/dav/` |
| 群晖 WebDAV | `https://nas.example.com:5006` |
| Alist | `https://alist.example.com/dav` |

要点：

- 只支持 **HTTP Basic Auth**；建议使用**应用密码 / 专用密码**，不要用主账号密码。
- 强烈建议使用 **HTTPS**；HTTP 下密码相当于明文。
- `basePath` 可省略，默认 `/dsh-sync`；快速开始卡只要求 **url / username / password** 三项。
- `init` 会对根与 `devices`、`objects` 逐级 `MKCOL`（405 视为已存在）。
- 列设备用 `PROPFIND devices/`（`Depth: 1`），因此服务端必须支持 PROPFIND；不支持 WebDAV 的“纯 HTTP 文件服务”不能作为此 target。

### 5.2 local（本地目录 / 网盘挂载点）

```json
{
  "id": "local",
  "type": "local",
  "label": "本地/挂载目录",
  "enabled": true,
  "path": "$DSH_HOME/dsh-sync/store"
}
```

其他常见路径：

| 场景 | path 示例 |
|---|---|
| 同机多实例 / 共享目录 | `/mnt/shared/dsh-sync` |
| rclone 挂载的云盘 | `/mnt/onedrive/dsh-sync` |
| Termux SAF / 外置存储 | `/storage/emulated/0/Documents/dsh-sync` |

后端会在 `init` 时创建 `<path>/devices` 与 `<path>/objects`。路径所在文件系统必须支持重命名（同目录 tmp + rename 原子写）。

### 5.3 peer（另一台 DSH）

```json
{
  "id": "peer",
  "type": "peer",
  "label": "另一台 DSH",
  "enabled": true,
  "url": "http://192.168.1.20:38445",
  "token": "<另一台设备配对区复制的 token>"
}
```

要点：

- `url` 两种写法都接受：
  - 直接粘贴配对区展示的**完整协议根**（含 `/dsh-sync/v1`），如 `http://192.168.1.5:38445/dsh-sync/v1`；
  - 或只填 **origin**，如 `http://192.168.1.5:38445`，后端会自动补 `/dsh-sync/v1`。
  已包含 `/dsh-sync/v1` 时**不会重复拼接**，复制即用。
- `token` 必须与对端 `peerToken` 完全一致（区分大小写，不要带空格）。
- **两台设备必须能直连**：同一局域网、VPN，或公网/反向代理可达地址。DSH Web 监听的端口**就是** peer 协议端口（如 `38445`），保证该端口对另一台设备可达即可。
- 接收端必须正在运行 DSH 并已启用本插件（peer 路由由 `GET /dsh-sync/v1/ping` 探活）。

### 5.4 多 target

同一轮同步会扇出到所有 `enabled: true` 的 target；不同 target 的 `base` 分别记录在 `state.json` 的 `targets.<id>.base` 下。可以只启用 local 做本机备份，同时启用 webdav 做异地备份，两者互不影响。

---

## 6. Peer 配对步骤

### 6.1 一键配对码（推荐）

**WebDAV 配对**（跨网络首选）：

1. A 端在 `Targets` 里填好 WebDAV 地址、账号、应用密码、子路径，点**测试连接**通过；
2. 点该 target 卡片上的**复制配对码**；
3. B 端打开 设置 → dsh-sync → **一键配对码**，把码粘贴进去，点**连接并同步**；
4. B 端会自动新增同名 WebDAV target、立即测试并同步，状态卡回填结果。

**Peer 配对**（同一局域网）：

1. A 端点**复制本机配对码**；若提示只监听回环地址，用 `--host 0.0.0.0` 启动 `dsh web` 后重试；
2. B 端粘贴同一段码，点**连接并同步**。

> 配对码等同于密码：内含 WebDAV 密码或 peer token，只发给可信设备；Host 不写日志。同一 target 会按类型 + 地址 + 用户名去重，重复粘贴不会产生重复项。

**也可以直接对 Agent 说**：

```text
帮我配置 WebDAV 同步：地址 https://cloud.example.com/remote.php/dav/files/alice
账号 alice，应用密码 xxxx-xxxx-xxxx，子路径 /dsh-sync
```

Agent 会调用 `dsh_sync_configure`：新增 target → 测试连接 → 立即同步 → 汇报真实统计；同一地址+用户名再次配置时更新原 target，不会重复新增。也可以把配对码直接发给 Agent，由它调用 `dsh_sync_pair`。

> 注意：口述的密码会进入本次对话的模型上下文。请使用**应用密码/专用密码**，不要用主账号密码；配置完成后可随时在服务端撤销该应用密码。

### 6.2 手动配置（备用）


以 A（提供存储）→ B（连接 A）为例：

1. **A 端**：设置 → dsh-sync → Peer 配对，确认 DSH Web 正在监听，复制只读的 `url` 与 `token`。
   - `url` 形如 `http://192.168.1.20:38445/dsh-sync/v1`；若显示 `127.0.0.1`，请换成局域网 IP 或反向代理地址后再给 B。
2. **B 端**：设置 → dsh-sync → 新增 target → 类型 `peer`：
   - `url` 直接粘贴 A 的完整 `url`（含 `/dsh-sync/v1`），或只填 origin（如 `http://192.168.1.20:38445`）——后端会自动补全，且不会重复拼接；
   - `token` 粘贴 A 的 token（必须完全一致）。
3. 点击**测试连接**：插件会 `GET ping`（免 token）并用 `HEAD objects/<全 0 hash>` 探测写权限；返回失败时检查网络、端口、token。
4. 启用 target，点**立即同步**。B 的清单会写到 A 的 peer 存储，A 也会在下一轮同步里看到 B 的文件。

> 网络前提：A 与 B 能**直连**。A 的 DSH Web 端口就是 peer 协议端口；若 A 在 NAT 后，需要端口映射/VPN/反向代理。安全提示：peer 协议是 **明文 HTTP + 静态 token**，只建议在可信局域网/VPN 内使用；跨公网请套 HTTPS 反向代理，并妥善保管 token（泄露后对方可读写你的同步存储）。

---

## 7. 自动保存与自动同步

| 配置项 | 默认值 | 语义 |
|---|---|---|
| `autoSave` | `true` | 每 `autoSaveIntervalSeconds` 扫描本地；有变更则对每个**启用** target 执行 **push（只上传，不拉取）**。 |
| `autoSync` | `true` | 每 `autoSyncIntervalSeconds` 对每个启用 target 执行**完整双向同步**。 |
| `syncOnStart` | `true` | 启动后 **8 秒**触发一次完整同步（错开启动高峰）。 |
| `autoSaveIntervalSeconds` | `20` | 自动保存间隔（秒）。 |
| `autoSyncIntervalSeconds` | `180` | 自动同步间隔（秒）。 |
| `maxFileBytes` | `33554432`（32 MiB） | 单文件上限；超限文件不进入快照并记日志。 |

行为约定：

- 自动保存**只推不拉**：远端变更要等自动同步（或手动同步）才会落地。
- 自动同步/自动保存与手动同步**串行化**，运行中 `status.busy` 为 `true`。
- 自动任务失败**只记日志**，不会抛到进程；可在设置页日志里看到原因。
- 卸载插件时会清理所有 timer/listener，不会留下后台任务。
- 两个间隔与开关都可在设置页修改，保存即生效（无需重启）。

---

## 8. 本地发送：`.dshsync` 导出 / 导入

- **导出**：把当前本地快照（或指定 target 视角）打成单个 `.dshsync` 文件，落到 `$DSH_HOME/dsh-sync/exports/`；设置页通过 `/dsh-sync/api/export` 获取 `url` 后触发浏览器下载。
- **导入**：读取 `.dshsync`，把归档里的 manifest 当作一份“远端清单”参与三方合并，然后按正常同步动作落地。
- **格式**：`gzip(ustar)`，成员为 `manifest.json` + `objects/<sha256>`；对象按内容去重。
- 典型用途：没有共同存储的两台设备之间“U 盘/聊天软件”传文件；或作为某一时刻的手工备份。

导出的归档**包含文件明文内容**，请按敏感数据对待；导入只应使用可信来源的文件。

---

## 9. Agent 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `dsh_sync_status` | 无 | 返回设备、targets、上次结果、冲突数与待处理提示。 |
| `dsh_sync_run` | `mode?: 'auto'\|'push'\|'pull'`、`targetId?` | 执行同步，返回每个 target 的报告。 |
| `dsh_sync_configure` | `type`、`url`、`username`、`password`、`basePath?`、`path?`、`token?`、`sync?`、`targetId?` | 按口述信息新增/更新 target，默认测试连接并同步；同地址+用户名更新而非重复。 |
| `dsh_sync_pair` | `code`、`sync?` | 解析 `DSHSYNC1.` 配对码，新增/更新 target，默认测试并同步。 |
| `dsh_sync_export` | 无 | 导出 `.dshsync` 到 `$DSH_HOME/dsh-sync/exports/`，返回绝对路径/大小。 |
| `dsh_sync_import` | `path: string` | 导入本地 `.dshsync` 文件，返回合并报告。 |

工具输出为字符串（含结构化摘要），失败时抛可读错误。

---

## 10. 数据与安全边界

### 10.1 本地数据

- 目录 `$DSH_HOME/dsh-sync/` 权限 `0700`，其中文件 `0600`；写入一律原子化（同目录 tmp + rename）。
- `config.json`：配置（targets、roots、间隔、`peerToken` 等）。
- `state.json`：`deviceId`、每个 target 的同步基线 `base`、上次结果、日志/冲突环形缓冲。
- 日志上限 500 条、冲突上限 200 条（环形缓冲，超出淘汰最旧）。

### 10.2 凭据

- WebDAV 的 `password` 与 peer 的 `token` 保存在 `config.json` 中；插件**不额外加密**，依赖文件权限（0600）与操作系统账户隔离。多用户主机或备份场景请自行加密磁盘/目录。
- `GET /dsh-sync/api/status` 中 `password` / target `token` 以 `"***"` 返回；**`peer.token` 单独明文给出**，仅用于配对复制（需要能复制才能配对）。
- UI 路由做同源校验：带 `Origin` 时 host 必须与请求 `Host` 一致，否则 403；并且必须带 `x-dsh-sync-ui-token`（由受 DSH 登录保护的 index 页面注入），否则 401。peer 路由校验 `x-dsh-sync-token`，否则 401。

### 10.3 排除与敏感文件（强制）

- `$DSH_HOME` 内**始终排除**以下敏感文件（不可配置）：
  `**/.credentials.yaml`、`**/credentials.key`、`**/cookies*`、`**/jar-*.json`、`**/*.key`、`**/*.pem`、`**/id_rsa*`。
- 每个 root 可追加 `exclude` 数组，支持 `*`、`?`、`**`，例如 `node_modules/**`、`**/*.log`、`*.bak-*`。
- 默认 profile root 已排除 `node_modules/**`、`.plugin-manager/**`、`*.bak-*`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`package.json`；文档 root（默认停用）额外排除 `.git/**`、`**/*.zip`、`**/*.tar.gz`。
- 排除是**路径匹配**，不是内容扫描；不要指望它发现改了扩展名的密钥文件。

### 10.4 大小与路径安全

- `maxFileBytes`（默认 32 MiB）：超限文件不进入快照，每个文件记一次日志；不会截断上传。
- 扫描与拉取都**跳过符号链接**（文件与目录），并记录 `symlink` 跳过。
- 后端对象名只允许 `[a-f0-9]{64}`（sha256）；路径写入前做 realpath + resolve 校验，拒绝绝对路径、`..`、`\`、NUL、空段、Windows 盘符。
- 归档解包拒绝任何越界路径；导入路径同样走上述校验。

### 10.5 网络

- 本插件只连接**你配置的 target**（local 路径、WebDAV URL、peer URL）；没有遥测、没有心跳上报、没有云端账号体系。
- WebDAV 建议 HTTPS；peer 建议可信网络或反向代理 HTTPS。
- WebDAV/peer 请求超时 60 秒；4xx/5xx 会作为失败记录到日志与 `lastResult`。

### 10.6 导入信任边界

- `.dshsync` 归档未签名、未加密；导入即信任其内容。
- 导入不会逃逸出配置的 roots（路径校验），但**内容本身会被写入 roots**；恶意归档可以覆盖 roots 内同名文件。只导入你能确认来源的归档。

---

## 11. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| 设置页打不开 / 空白 | 插件未启用、未重启、或 Client bundle 未加载 | 插件页确认启用；重启 `dsh web`；看浏览器控制台与宿主日志 |
| `GET /dsh-sync/api/status` 403 | 反向代理改了 Host/Origin，同源校验失败 | 让代理保留 `Host` 与 `Origin` 一致，或直接访问 DSH 原地址 |
| peer `401 token 无效` | 两边 token 不一致 | 在 A 端重新复制 token，B 端重新粘贴；注意不要带空格 |
| peer 连接超时 | 两台设备不互通、端口未放行、`url` 用了对端不可见的 `127.0.0.1` | 换可达地址（局域网 IP / VPN / 反代）；确认 A 的 DSH 在监听该端口；`curl http://<ip>:<port>/dsh-sync/v1/ping` 自测 |
| peer 404 | 对端未启用插件、路径前缀不匹配，或服务不在该端口 | 先 `curl http://<ip>:<port>/dsh-sync/v1/ping`；确认对端 DSH 已启用 dsh-sync 且 `url` 的 path 前缀正确 |
| WebDAV 401/403 | 密码错误、用了主密码、服务要求应用密码 | 改用应用密码；先在浏览器/`curl` 验证 Basic Auth |
| WebDAV 404 / MKCOL 失败 | `url` 或 `basePath` 不对，目录不存在且父级不可建 | 核对最终根；确认账号对父目录有创建权限 |
| WebDAV `PROPFIND` 失败 | 服务不是真正的 WebDAV（只是静态 HTTP） | 该服务不能作为 webdav target；换 local 挂载或 peer |
| 同步后文件没变 | target 未启用、自动同步未到点、文件被排除/超限/是符号链接 | 看 `lastResult` 与日志；手动点“立即同步” |
| 出现 `*.conflict-<device>-<时间>.ext` | 双方改了同一文件，或有删除/修改交叉 | 正常保护行为：本地保留、远端内容另存副本；人工合并后删除副本，下一轮会同步 |
| 文件反复复活 | 一端删除、另一端仍在修改 | 按三方规则会以修改方为准并记冲突；需要人工确认最终内容 |
| 大文件不同步 | 超过 `maxFileBytes` | 调大上限（会影响扫描/内存）或改用其他方式传输 |
| 冲突/日志丢失 | 环形缓冲上限（200/500） | 需要长期审计请另行落盘 |

排障入口：设置页日志/冲突列表；`dsh_sync_status`。命令行调试需带 UI token（从 `~/.dsh/dsh-sync/state.json` 的 `uiToken` 读取）：

```bash
curl -s -H "x-dsh-sync-ui-token: $UI_TOKEN" http://127.0.0.1:<port>/dsh-sync/api/status
```

---

## 12. 已知限制

1. **单文件默认 ≤ 32 MiB**，超限跳过；调大上限会成倍增加扫描与内存开销。
2. **只同步文件**：空目录、目录权限、扩展属性、ACL 不同步。
3. **符号链接一律跳过**（安全考虑），不会跟随。
4. **没有文件锁**：同步运行期间的并发编辑按“最后写入 + 冲突副本”处理，不保证字节级一致；建议避免在同步中编辑大文件。
5. **冲突副本需人工处理**：插件只保证内容不丢，不自动合并文本。
6. **mtime 为尽力恢复**：`pull` 会尽量还原 `mtime`，但部分文件系统/后端会截断精度。
7. **归档是 USTAR**：成员路径受 ustar 限制（name ≤ 100、prefix ≤ 155）；超长路径导出会失败，不会静默截断。归档输入/解压各有 512 MiB 上限。
8. **WebDAV 只支持 Basic Auth**：不支持 Digest、OAuth、2FA 交互；不支持分块断点续传，单次 PUT 全量对象。
9. **peer 协议无 TLS，且要求两端可直连**：安全边界依赖网络环境（局域网/VPN/反向代理）；NAT 后需端口映射或隧道。
10. **无端到端加密、无版本历史/回滚**：需要历史版本请依赖存储侧快照（Nextcloud 版本、对象存储版本等）或定期导出归档。
11. **同步串行**：同一时刻只跑一轮。自动任务在 `busy` 时直接跳过（`status.busy=true`）；手动同步会排队串行执行，不会并行写同一 target。
12. **deviceId 首次生成后固定**：`state.json` 丢失会生成新 `deviceId`，旧清单仍保留在 target 上，可能出现一次额外的“新设备”合并。
13. **多设备同名不校验**：`deviceName` 仅用于展示，冲突副本里的 `device8` 来自 `deviceId`。
14. **local target 共享同一目录**：多台设备指向同一 local 目录可以工作（各自写自己的 manifest），但不要同时用两个进程写同一个 `devices/<id>.json`。

---

## 13. 验证

要求 Node.js **≥ 20**。在 Node 24 下，`node --test test/` 会把目录当作模块入口而报 `Cannot find module`，请使用下面的写法：

```bash
# 全部测试（shell 展开 test 目录下的测试文件）
node --test test/*.test.mjs

# 也可以从包根自动发现（会把 test/support/*.mjs 作为文件级用例一并执行）
node --test

# 只跑 E2E（真实 lib + 双实例收敛）
node --test test/e2e.test.mjs

# 只跑夹具自测
node --test test/support/support-selftest.test.mjs
```

测试文件分工：

| 文件 | 覆盖 |
|---|---|
| `test/support/support-selftest.test.mjs` | 夹具/mock 自身（真实 HTTP） |
| `test/archive.test.mjs` | `.dshsync` 归档格式、路径安全、上限 |
| `test/backends.test.mjs` | local / WebDAV / peer 三个后端 |
| `test/core.test.mjs` | 合并、扫描、引擎收敛 |
| `test/http-api.test.mjs` | 设置页 API、UI token 鉴权、导出下载、peer 协议 |
| `test/safety.test.mjs` | 数据安全：超大/排除/禁用根/未知根不墓碑、不删对端 |
| `test/e2e.test.mjs` | 双设备 E2E：local / WebDAV / peer / 安全 / 大小限制 |

测试计划、阶段状态与真实输出见 [`NOTES-verify.md`](./NOTES-verify.md)；接口契约见 [`SPEC.md`](./SPEC.md)。

---

## 14. 相关文件

| 文件 | 说明 |
|---|---|
| `SPEC.md` | 冻结版接口与语义契约（唯一事实源） |
| `NOTES-verify.md` | 测试计划、阶段完成项、失败复现记录 |
| `test/support/mock-webdav.mjs` | 真实 `node:http` WebDAV mock |
| `test/support/peer-server.mjs` | 内存版 v1 peer 服务 |
| `test/support/fakes.mjs` | 临时 HOME/DSH_HOME、config、快照、等待等夹具 |
| `test/support/support-selftest.test.mjs` | 夹具自测 |
| `test/e2e.test.mjs` | 双设备端到端测试 |
| `lib/` | Host 侧实现（store / engine / backends / routes / tools） |
| `lib/client.js` | Web 设置页 |
| `locale/zh.json`、`locale/en.json` | 设置页文案 |

---

## 15. 常见问题（FAQ）

**Q：需要安装 rclone 吗？**
不需要。`local` target 就是普通目录；是否用 rclone 挂载云盘由你决定（挂载后对插件透明）。

**Q：能同步 `$DSH_HOME` 整个目录吗？**
不建议。默认 roots 只选 profile/sessions/工作区文档；整个 `$DSH_HOME` 会包含大量缓存与锁文件，且敏感文件虽然被硬编码排除，仍可能暴露其他内部状态。

**Q：两台设备同时在线会不会互相覆盖？**
不会静默覆盖。同一 key 双方都改时保留本地、远端内容写冲突副本，并在 `conflicts` 里记录；双方删除则清基线。

**Q：自动保存会把远端删除“推回来”吗？**
不会。自动保存只做 push，不拉取远端，因此不会复活远端已删文件；完整双向语义由自动同步负责。

**Q：能只上传或只下载吗？**
可以。`dsh_sync_run` 支持 `mode: 'push'` / `'pull'`；设置页提供对应按钮。`auto` 为完整双向。

**Q：token 泄露了怎么办？**
立即在配置中更换 `peerToken`（设置页重新生成/手工改），并同步更新所有对端 target 的 token；旧 token 立即失效。