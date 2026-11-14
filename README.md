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
| codeload tag tarball | `https://codeload.github.com/irerc/dsh-sync/tar.gz/refs/tags/v1.6.0` | `github.com` 被阻断但 `codeload.github.com` 可达；pnpm 可直接安装 |
| Release 资产 | `https://github.com/irerc/dsh-sync/releases/download/v1.6.0/dsh-sync-1.6.0.tgz` | 能访问 `github.com`；也可手动下载后在本地安装 |
| raw tarball（GUI 兼容） | `https://raw.githubusercontent.com/irerc/dsh-sync/main/dist/dsh-sync-1.6.0.tgz` | `github.com` 被阻断但 `raw.githubusercontent.com` 可达；URL 以 `.tgz` 结尾，插件管理器可直接识别 |

本机（`github.com:443` 被阻断、`codeload.github.com` 可达）实测通过的 CLI：

```bash
dsh plugin --profile web add https://codeload.github.com/irerc/dsh-sync/tar.gz/refs/tags/v1.6.0
# 或：raw tarball（GUI 安装也接受这个 URL）
dsh plugin --profile web add https://raw.githubusercontent.com/irerc/dsh-sync/main/dist/dsh-sync-1.6.0.tgz
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

升级：重新执行安装（git 地址拉取最新提交；tarball 地址换成新 tag），或替换本地目录后重装/重启。需要固定版本时用 tag：`.../tar.gz/refs/tags/v1.6.0`。配置与状态保存在 `$DSH_HOME/dsh-sync/`，不受升级影响。

---

## 4. 设置页使用

### 4.0 最快路径：WebDAV 只填三项

「WebDAV 快速开始」在设置页**最底部**（老用户不需要它，但新用户仍能一眼找到）：只填 **地址、账号、应用密码**，点「连接并同步」。子路径自动使用 `/dsh-sync`，target 名默认 `WebDAV`；保存后自动测试连接并立即同步，结果就地显示上传/下载/冲突/错误数。同一地址+账号再次提交是**更新**，不会重复新增。

连接成功后会**记住**这次填的网址与账号：

- 卡片默认**折叠**，只显示一行 `已连接 https://… · 账号 …` 和「展开」按钮；
- 展开后地址/账号已预填，密码位显示 `***`——**保持 `***` 不动就是沿用已保存的密码**，不需要每次重输；
- 成功一次后卡片自动收起，不占版面；还没有任何 WebDAV target 时则默认展开，新用户不用先找按钮。

> 密码只保存在本机 `config.json`（0600），设置页接口回给浏览器的永远是 `***`，不会回显明文。


### 4.1 上传速度与流量（1.4.0）

同步默认就快，不需要任何配置。三项机制：

| 机制 | 做了什么 | 效果（本机基准，见 `bench/BASELINE.md`） |
| --- | --- | --- |
| 对象索引 | 一次 `PROPFIND objects/`（WebDAV）或 `GET /v1/objects`（对等）拿到已有对象清单，之后不再逐对象探测 | 每对象 2 次 HEAD → **0 次** |
| 并发传输 | 上传/下载/删除并行，默认 4，范围 1–16，另有 64 MiB 在飞字节预算 | 200 文件 / RTT 150ms：**98.7s → 9.1s** |
| 对象 gzip | JSON/Markdown 等文本对象压缩后再传（仅当确实变小） | 60 × 200KB 文本：传输量 **13.18MB → 0.93MB（−93%）** |

设置页「状态卡」可调：

- **并发传输数**（1–16）：局域网千兆可调到 8；移动网络或服务端限流时降到 2。
- **上传压缩**（默认开）：内网直连且 CPU 弱可关，否则建议保持开启。

状态卡还会直接给出**网速小 tag**与进度动画：

- 同步中：呼吸圆点 + `同步中 12s`，并实时给出**双向速率** `↑ 1.2 MB/s · ↓ 480 KB/s`；
  下方一条不定进度条（不谎报百分比，因为总量在合并前无法确定）；
- 同步结束：`↑ 3.3 MiB · ↓ 1.1 MiB · 0.9 MB/s`，即上次的实传字节（上下行分开）与平均速率（悬停有说明）。

速率来自引擎的逐对象字节回调（`onBytes`），同步期间每 800ms 轮询一次 `/dsh-sync/api/status` 的
`progress` 快照；已用时间仍由前端本地计时，不依赖轮询频率。

> 下载量按**实际传输的字节**统计：WebDAV 上对象通常是 `.z` 压缩形态，所以下行字节会明显小于原始文件大小。
- 结果 chips 淡入；`prefers-reduced-motion` 下全部动画自动关闭，进度条退化为静态条。

同步日志会显示吞吐与实传字节，例如：

```text
[dav] auto 同步完成：↑200 ↓0 … 去重跳过3，实传0.832 MiB（9098ms，90 KiB/s）
```

> 兼容性：`objects/<hash>.z` 是新形态。旧版本（≤1.3.0）设备读不到 `.z` 对象，**请把所有设备升级到 1.6.0**；
> 新版本仍能读写 1.3.0 遗留的 `objects/<hash>` 原始对象。

设置页入口：**设置 → dsh-sync**（`settings.section`，order 60）。页面分六块：

1. **状态卡**：设备名、上次同步时间与结果、自动同步/自动保存/启动时同步开关、两个间隔（秒）、并发传输数、上传压缩开关、`立即同步` / `仅上传` / `仅下载` 按钮；结果 chips 含上传/下载/冲突/错误、去重跳过与吞吐量。
2. **Targets**：每个 target 一张卡片，可启用/停用、编辑字段、测试连接、删除；可新增 `local` / `webdav` / `peer` 三类 target。密码字段为 `type=password`，`测试连接` 使用未保存的草稿值。
3. **Roots**：要同步的本地根目录列表（label、绝对路径、启用开关、排除项一行一个）；可新增 root。路径必须是**绝对路径**且存在，root 之间不允许嵌套或重复，禁止 `/`。
4. **一键配对码**：可复制本机 peer 码，或复制任一 WebDAV/peer target 的配对码；在另一台设备粘贴后自动新增 target 并同步（详见 §6.1）。
5. **导入 / 导出**：`导出` 生成 `.dshsync` 并触发浏览器下载；`导入` 选择 `.dshsync` 文件后以原始字节上传。
6. **活动日志 / 冲突**：最近日志与冲突列表；无数据时显示空态文案。

所有按钮有 busy/禁用态，错误就地展示；首次加载有 loading 态，status 请求失败可重试。

---

## 5. 三种 target 配置示例

路径字段支持 `$DSH_HOME`、`$HOME`、`$DSH_PROFILE` 与 `~` 前缀，保存/加载时展开为绝对路径。以下示例也可直接写进 `$DSH_HOME/dsh-sync/config.json`。

默认配置只预置 **WebDAV** 一个目标（排第一位）：跨网络、跨设备都能用，也是「在家用平板、出门用手机」
唯一成立的通道。`local`（需要同一块磁盘）与 `peer`（需要同一局域网）保留为进阶选项，默认不启用。

WebDAV 目标预置为**未启用**：`normalizeTarget` 拒绝「启用却没有地址」的目标，填完地址并连接后自动启用
（首次连接会填满预置的 `dav` 占位，不会多出一个 `dav-2`）。

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

### 8.1 完整备份（工作区文件 + 对话文件）

设置页的「完整备份（工作区＋对话）」按钮（`POST /dsh-sync/api/export`，body `{"scope":"full"}`）会把**两类内容打进同一个归档**，用于换机迁移与数据拯救：

| 内容 | 来源 |
|---|---|
| 对话记录 | 已启用的 `sessions` 根（`$DSH_HOME/sessions`） |
| 工作区文件 | `$DSH_HOME/storages/workspace.json` 里登记的工作区 |

工作区不会全部照收，避免把整机打成归档：

- **危险祖先**（`/`、`/root`、`/usr`、`/data` 等）直接拒绝——它们等于整机打包；
- **已被既有根覆盖**的工作区跳过（例如 `documents` 根已包含 `Documents/...` 下的工作区），不重复打包；
- **嵌套工作区**只保留更具体的那个；
- **体积预算**：默认 `maxArchiveBytes = 256 MiB`，与导入上限对齐（否则导出的包自己导入不回去）。已启用根先占额度，剩余额度按体积**从小到大**装工作区；放不下的会被跳过，并在通知里点名列出。

> 被跳过不等于备份完整。看到「以下工作区超出体积上限被跳过」时，请确认那些目录是否需要单独处理（调大 `maxArchiveBytes`，或为它单独建根后导出 `roots` 范围）。

### 8.2 换设备恢复：根按路径对齐

归档的 `manifest.json` 顶层会记录每个根的**绝对路径**（`roots: [{id, path}]`）。根 id 是由 label 派生的，两台设备上可能不同，只按 id 匹配会让恢复静默跳过全部文件，所以导入按以下顺序解析：

1. 同 `id` 的本地根；
2. 同**路径**的本地根（换机、改了 label 都能命中）；
3. 本机没有该根时，若路径位于**可信父目录**内（`$DSH_HOME` 及其上一级），按归档路径**补建根**并落盘；否则拒绝，并留下「拒绝按归档路径补建根」日志。

第 3 条是「数据拯救」真正可用的前提：重装后配置是空的，没有它就只能同机还原。补建只在你的 DSH 主目录树内发生，归档不能借此把文件写到任意位置。

旧版归档没有 `roots` 字段，导入仍按原来的「只认 id」行为处理，向后兼容。

### 8.3 完整应用数据（换设备后和原机一样）

「完整备份」装的是工作区与对话；「**完整应用数据**」装的是 DSH 这个应用本身。设置页按钮为「完整应用数据」（`POST /dsh-sync/api/export`，body `{"scope":"app"}`）。

目标很具体：**新设备装好 DSH、导入这一份、跑一次依赖安装，用起来和这台机器一样。**

进包的内容：

| 内容 | 位置 | 为什么必须带 |
|---|---|---|
| 会话与对话记录 | `$DSH_HOME/sessions` | 对话历史就是工作成果 |
| 存储与登记 | `$DSH_HOME/storages`（去掉原生库/venv/投影缓存） | 工作区登记、账号表、聊天映射 |
| 账号凭据 | `$DSH_HOME/.credentials.yaml` 等 | 不带就得重新登录，谈不上「一样」 |
| 偏好与插件状态 | `$DSH_HOME/*.json`、`profiles/<profile>/**`（去掉 `node_modules`） | 插件启用状态、模型设置、编排 |
| 附件 | `$DSH_HOME/attachments` | 对话里的图片/文件 |
| 自有插件源码 | profile `package.json` 里所有 `link:` 依赖的真实路径（本机 17 个，约 11 MB） | 这些插件不在 npm 上，新设备没有源码就没有功能 |

**故意不进包**（可重建，带了只会变大变慢，且不可能逐字节一致）：`node_modules`、`mobile-access/components`（cloudflared/cpolar）、`storages/*/native-libs`、`storages/*/native-venv`、`cache`、`logs`、`plugin-install-operations`、`session-move-backup`、`session_projcache`、`*.bak-*`，以及同步存储自身 `dsh-sync/`（否则就是备份再备份，且体积自我膨胀）。

实测（本机，18 个根）：**121 MiB / 809 个文件 / 14.6 秒**。

#### 恢复步骤（归档里自带说明，不用另找文档）

归档额外带三个成员，老版本客户端导入时会当作未知成员忽略，所以不影响向后兼容：

- `restore.json`：机读的恢复计划（原机 DSH 版本、profile 目录、17 个 link 源码路径、4 个步骤）；
- `RESTORE.md`：人读说明；
- `restore.sh`：可直接执行——先检查 link 源码是否在原路径，缺了就报错退出，然后 `pnpm install --frozen-lockfile`。

1. 新设备装同版本 DSH（本机 `0.2.2-rc.1` 由插件自动探测并写进 `restore.json`）；
2. 设置页「导入」选这个归档；
3. `bash restore.sh`（或手工 `cd <profile> && pnpm install --frozen-lockfile`）；
4. 重启 DSH。

#### 换设备时 DSH_HOME 路径不同也能恢复

`dsh-home` 这个根**不做路径匹配**：归档里无论原机 home 在哪，导入时一律落到**本机** `$DSH_HOME`。这是「新设备装完即等同原机」的关键——换机器时 home 路径本来就可能不同。

其余根（自有插件源码）仍走 §8.2 的路径规则：路径在可信父目录内就补建，否则拒绝。

导入结果新增两个字段，避免「导入成功但什么都没恢复」被误判：

- `applied`：是否真的写入了文件（全部跳过时为 `false`）；
- `warning`：未写入时的原因，例如「归档里的路径在本机没有对应位置，未写入任何文件（N 个根未匹配，例如 /home/a/.dsh）」。

> **安全提醒**：完整应用数据**包含账号凭据**。归档落在 `$DSH_HOME/dsh-sync/exports/`，只有你主动下载/上传它才会离开这台机器。请当作密码文件对待，不要放到公开位置。设置项 `backupSecrets: false` 可关掉（关掉后新设备需要重新登录）。

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
- 凭据文件（`.credentials.yaml`、`credentials.key`、`cookies*`、`*.key`、`*.pem`、`id_rsa*`）在 `$DSH_HOME` 内**默认被拦掉**。只有「完整应用数据」用的那个根带 `includeSecrets: true` 才会放行（§8.3），普通同步与 `full` 备份仍然不带凭据。

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