# NOTES-verify — dsh-sync 验证记录

> 角色：验证与文档工程师（verify-dev）。
> 事实源：`SPEC.md`（v1 契约）。本文件只记录**真实执行过的命令与输出**，以及尚未覆盖项的原因。
> 约束：只改 `test/support/*`、`test/e2e.test.mjs`、`README.md`、`NOTES-verify.md`；不装插件、不改 `package.json`、不写 profile、不碰 `lib/`。

---

## 0. 当前状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| A | WebDAV mock / 夹具 / peer mock / README / 本文件 | ✅ 完成 |
| B | `test/e2e.test.mjs` 双实例收敛 + 全量测试 | ✅ 完成（56/56，0 fail） |

最终证据（2026-11-08，Node v24.19.0，Linux）：

```bash
$ node --test test/*.test.mjs
ℹ tests 56
ℹ pass 56
ℹ fail 0

$ node --test
ℹ tests 70
ℹ pass 70
ℹ fail 0
```

> 两条命令的差异见 §4.4：无参自动发现会额外把 `test/support/*.mjs` 当作文件级用例执行（3 条），并包含 `test/support/support-selftest.test.mjs`（11 条），因此是 70 = 56 + 11 + 3。

---

## 1. 验收标准映射（SPEC §11）

| SPEC §11 验收项 | 覆盖手段 | 状态 |
|---|---|---|
| 1. `node --test`：合并规则、路径安全、归档往返、三个后端、导入导出 | 单元 + 后端 + 归档 + E2E | ✅ 全绿 |
| 2. 真实双实例 local 双向收敛（增/改/删/冲突副本） | `test/e2e.test.mjs` E1 | ✅ 5/5 |
| 3. 设置页可打开、无 slot crash、`GET /dsh-sync/api/status` 结构正确 | `test/http-api.test.mjs` + `test/ui-static.test.mjs`（静态）；浏览器交互未在本环境执行 | ⚠️ 接口/静态已验证，浏览器待部署环境确认 |
| 4. `dsh_sync_export` → 改文件 → `dsh_sync_import` 往返 | `test/e2e.test.mjs` E1 后半段 + `test/archive.test.mjs` | ✅ |
| 5. 重启后配置/状态仍在、自动同步 timer 正常 | `SyncStore.load()` 往返由存储层覆盖；**timer wall-clock 未在 E2E 实测** | ⚠️ 见 §6 |

---

## 2. 测试分层

| 层 | 文件 | 证明什么 | 依赖 |
|---|---|---|---|
| 夹具自测 | `test/support/support-selftest.test.mjs`（11） | mock/夹具本身不说谎（真实 HTTP 状态码、认证、PROPFIND、hash、落盘） | 仅 Node 内置 |
| 归档 | `test/archive.test.mjs`（14） | USTAR/去重/路径安全/上限/损坏输入 | `lib/engine/archive.js` |
| 后端 | `test/backends.test.mjs`（27） | local / WebDAV / peer 三后端的真实网络行为 | `lib/backends/*` |
| 核心 | `test/core.test.mjs`（6） | 配置、manifest、三方合并、扫描、引擎收敛 | `lib/engine/*` |
| HTTP | `test/http-api.test.mjs`（3） | 设置页 API、同源、鉴权、下载、peer 协议 | `lib/http-api.js` |
| UI 静态 | `test/ui-static.test.mjs`（1） | 源码形态、slot 注册、locale 键完整性、图标体积 | `lib/client.js` + `locale/*` |
| E2E | `test/e2e.test.mjs`（5） | 双实例真实收敛（local / WebDAV / peer / 安全 / 大小） | 全部 `lib/*` + 夹具 |

---

## 3. 阶段 A 交付物

| 文件 | 关键能力 |
|---|---|
| `test/support/mock-webdav.mjs` | 真实 `node:http`：`PUT/GET/HEAD/MKCOL/PROPFIND/OPTIONS/DELETE`、Basic Auth、内存文件树、任意 `basePath`、`Depth:0/1` 207、请求日志、`startMockWebdav()` |
| `test/support/fakes.mjs` | 临时沙箱（`HOME`/`DSH_HOME`/`DSH_PROFILE`）、`applyEnv()` 还原、config/state 原子读写、文件/snapshot/diff、glob、`waitFor`、manifest 夹具、`createSandboxPair()` |
| `test/support/peer-server.mjs` | SPEC §7 v1 peer：ping 免 token、devices/objects、sha256 校验、token 401、可选 `storePath` 落盘（重启可加载） |
| `README.md` | 功能矩阵、安装、设置页、三种 target 示例、peer 配对、自动语义、安全边界、排障、限制 |
| `NOTES-verify.md` | 本文件 |

### 3.1 WebDAV mock 行为约定

- 认证 `Basic base64(user:pass)`；`username`/`password` 都空 → 免认证；`OPTIONS` 免认证。
- `MKCOL` 已存在 → `405`（后端视为可用）；父缺失 → `409`；成功 `201`。
- `PUT` 新建 → `201`，覆盖 → `204`；`autoCreateParents:true` 时补建并记 `warnings`。
- `PROPFIND` → `207`，`Depth:1` 返回直属子项；`DELETE` → `204/404`。
- `files` key 为含 `basePath` 的绝对 pathname（无尾斜杠，根 `''`）；`requests[].path` 是原始 `req.url`。

### 3.2 peer mock 行为约定

- 路由 `${prefix}/v1/*`（默认 `/dsh-sync/v1`），同时接受 `/v1/*`。
- `GET ping` 免 token；其余校验 `x-dsh-sync-token`，否则 `401`。
- `PUT objects/<hash>` 默认校验 sha256，不匹配 `400`；幂等。
- `PUT devices/<id>` 只做 JSON/大小校验（< 2 MiB）；语义由引擎负责。
- `storePath` 布局与 local 后端一致，可被真实 local 后端读取。

---

## 4. 命令与真实输出

### 4.1 语法检查（阶段 A）

```bash
$ node --check test/support/mock-webdav.mjs \
  && node --check test/support/fakes.mjs \
  && node --check test/support/peer-server.mjs
syntax OK
```

### 4.2 夹具自测

```bash
$ node --test test/support/support-selftest.test.mjs
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

11 条覆盖：WebDAV 认证/MKCOL/读写/207/DELETE、带前缀挂载、缺失父集合补建、peer ping/401/对象 hash/落盘重启、沙箱与 env 还原、config/state 往返、snapshot/diff、waitFor 超时信息、manifest 形状。

### 4.3 全量测试（最终）

```bash
$ node --test test/*.test.mjs
ℹ tests 56
ℹ pass 56
ℹ fail 0
ℹ duration_ms 3079.9
```

各文件真实通过数：

| 文件 | tests | pass | fail |
|---|---:|---:|---:|
| `test/archive.test.mjs` | 14 | 14 | 0 |
| `test/backends.test.mjs` | 27 | 27 | 0 |
| `test/core.test.mjs` | 6 | 6 | 0 |
| `test/http-api.test.mjs` | 3 | 3 | 0 |
| `test/ui-static.test.mjs` | 1 | 1 | 0 |
| `test/e2e.test.mjs` | 5 | 5 | 0 |
| **合计** | **56** | **56** | **0** |

### 4.4 `node --test` 两种写法

| 命令 | 结果 | 说明 |
|---|---|---|
| `node --test test/*.test.mjs` | 56 / 56 | shell 展开；**推荐**，只跑 6 个测试文件 |
| `node --test` | 70 / 70 | 自动发现：额外执行 `test/support/support-selftest.test.mjs`（11）与 3 个 support 模块（文件级 3 条） |
| `node --test test/` | ❌ `Cannot find module .../test` | **Node v24.19.0 下目录参数不再是有效入口**；README/NOTES 已统一改为前两种写法 |

异常记录（Node 24）：

```
Error: Cannot find module '/root/多设备同步/test'
    at Module._resolveFilename ...
code: 'MODULE_NOT_FOUND'
```

---

## 5. 阶段 B：E2E 场景与证据

文件：`test/e2e.test.mjs`（5 条，全部真实模块，未 mock 引擎）。

| # | 用例 | 关键断言（真实通过） |
|---|---|---|
| E1 | 双设备同一 local store 的增/改/删/冲突/幂等 | A 新增 2 文件 `pushed=2` → B `pulled=2`；B 改 → `pushed=1`、A `pulled=1`；A 删 → `tombstoned=1`、B `deletedLocal=1` 且不复活；双方改 → B `conflicts=1`，本地保留 `B-version`，冲突副本为 `A-version` 且 `state.conflicts` 有记录；A 拉取 2 条后双方均为 `B-version` + 1 份副本；连续 2 轮空转全 0 |
| E1b | 导出 → 改本地 → 导入 → 再同步 | 归档 `size>0`；导入 `imported=1`、`conflicts=1`，`a.txt` 回到归档内容，旧内容落 `.conflict-local-*`；备份作为新文件上传，另一端拉取后收敛 |
| E2 | WebDAV mock A→B→A | 请求覆盖 `MKCOL/PUT/GET/HEAD/PROPFIND`；两份设备 manifest 在 `/dsh-sync/devices/`；对象 PUT 恰好 2 次（两个版本，去重生效）；两轮空转 0 |
| E3 | peer 真实直连 | A 的 `attachRoutes` + `node:http` 壳；`GET /dsh-sync/v1/ping` 200 且返回真实 `deviceId`；B 用完整协议根 `…/dsh-sync/v1` 拉取 `a.txt`；B 推送 `b.txt` 后 A 拉取成功；A 的 peer store 出现 `devices/<B>.json`；错误 token → `ok=false` 且 error 匹配 401/令牌，对端 objects 列表**不变**；改用 origin（无后缀）后空转成功 |
| E4 | 恶意 manifest | `../`、`C:/`、反斜杠、非法 hash 全部被跳过；root 外 `escape.txt` 不存在；root 内只有 `safe.txt`；日志含“无效记录”；本机 manifest 仍只列 `data/safe.txt`；再同步空转 |
| E5 | 超大文件 | `maxFileBytes=64 KiB`；`70 KiB` 文件 `skipped=1`、只上传 `small.txt`（`pushed=1`）；B 无 `big.bin`；manifest 只含 `small.txt`；日志含“已跳过 1 个超过” |

运行结果：

```bash
$ node --test test/e2e.test.mjs
✔ E2E local：双设备同一 store 的新增/修改/删除/冲突/幂等收敛 (1158.59ms)
✔ E2E WebDAV：mock 上 A→B→A 关键链路与对象去重 (613.67ms)
✔ E2E peer：真实 HTTP API 直连，双实例收敛且 token 失败不破坏数据 (1513.93ms)
✔ E2E 安全：manifest 路径穿越与非法 hash 被拒绝，不写出 root (170.84ms)
✔ E2E 大小限制：超过 maxFileBytes 的文件被跳过且不进入 manifest (280.30ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

> 时间为单次真实值；重复运行有毫秒级波动，pass/fail 计数必须保持 5/0。

---

## 6. 未覆盖项（明确声明）

| 项 | 原因 / 现状 |
|---|---|
| 真实 WebDAV 服务联调（Nextcloud/坚果云/群晖） | 本环境无外部服务；协议层由 mock 覆盖，真实服务需部署环境验证 |
| 浏览器交互（点击、下载、复制、错误提示） | `ui-static.test.mjs` 只做静态/假渲染；`http-api.test.mjs` 覆盖 API；真实浏览器未执行 |
| 插件安装/启用、profile `bundles` 写入 | 角色硬约束：不装插件、不写 profile；由 Lead/用户执行 |
| 8 秒 `syncOnStart` 与自动 timer 的 wall-clock | E2E 显式关闭自动任务；timer 启停/清理由代码路径与单测覆盖，未等真实 8s/180s |
| 跨机器网络（非 localhost） | peer E2E 走 `127.0.0.1`；局域网/NAT/反代需部署环境验证 |
| 512 MiB 归档上限 | 归档单测用可调小的上限覆盖逻辑；未用真实 512 MiB 输入 |
| Windows/macOS 文件系统语义 | 仅在 Linux 验证；`deviceName`/文件名大小写、mtime 精度可能不同 |

---

## 7. 失败复现记录

### F1（已消失）core 导入断言失败

- 首次全量运行（11:52）时 `test/core.test.mjs` 失败：
  - 断言：`test/core.test.mjs:272`（导入后 `a.txt` 内容）
  - 期望：`B-version`；实际：`A-version`
- 归属：引擎 `importArchive` 行为（Lead scope）。
- 处理：未改 `lib/`、未放宽断言；Lead 更新引擎后同一用例通过。
- 最终状态：`core.test.mjs` 6/6，全量 56/56；**最终制品不可复现**。

### F2（已消失）ui-static 并发编辑暂态

- 11:54:2x 的全量运行中 `test/ui-static.test.mjs` 报 `ERR_ASSERTION`（false == true）；当时文件正在被 ui-dev 写入（mtime 11:54:34/11:54:49）。
- 处理：不修改 ui-dev 文件；等待稳定后单跑/全量均通过。
- 最终状态：ui-static 1/1；非产品缺陷。

### F3（命令问题）`node --test test/`

- Node v24.19.0 下目录参数被当作模块入口，报 `MODULE_NOT_FOUND`。
- 处理：README/NOTES 改为 `node --test test/*.test.mjs` 或 `node --test`；非产品缺陷。

### 失败报告模板（后续使用）

````markdown
### F<n> <现象一句话>

- 断言：<文件:行号，期望 vs 实际>
- 输入/步骤：
  1. ...
- 最小复现命令：
  ```bash
  node --test --test-name-pattern="..." test/e2e.test.mjs
  ```
- 实际输出（原始，不删减）：
  ```
  ...
  ```
- 现场路径（若保留）：`/tmp/dsh-sync-...`
- 初步定位：<模块/文件:行号>（只描述证据，不猜结论）
- 归属：<engine / backends / http-api / archive / client>
````

---

## 8. 覆盖矩阵

| 断言点 | 归档 | 后端 | 核心 | HTTP | UI | E2E |
|---|---|---|---|---|---|---|
| 路径穿越/绝对路径 | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| 内容 hash 校验 | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| 双向收敛 | — | ✅ | ✅ | — | — | ✅ |
| 删除墓碑 | — | — | ✅ | — | — | ✅ |
| 冲突副本 + 记录 | — | — | ✅ | — | — | ✅ |
| 导入导出往返 | ✅ | — | ✅ | ✅ | — | ✅ |
| WebDAV 协议细节 | — | ✅ | — | — | — | ✅ |
| peer token/401 | — | ✅ | — | ✅ | — | ✅ |
| 同源校验 | — | — | — | ✅ | — | — |
| 大小限制跳过 | ✅ | — | ✅ | — | — | ✅ |
| 幂等（连续空转） | — | — | — | — | — | ✅ |

---

## 9. 变更记录

| 日期 | 变更 | 依据 |
|---|---|---|
| 2026-11-08 | 阶段 A：三个 support 模块 + 自测 + README + 本文件 | 任务说明 / SPEC §2、§3、§5、§7、§11 |
| 2026-11-08 | README peer `url` 改为“完整协议根或 origin 都可，后端归一化不重复拼接；需两端直连，DSH Web 端口即路由端口” | Lead 决策（A 方案） |
| 2026-11-08 | 端口示例统一 `38445`（本环境实际 DSH Web 端口） | 运行环境 URL |
| 2026-11-08 | 阶段 B：`test/e2e.test.mjs` 5 条；全量 56/56（glob）、70/70（自动发现） | 本文件 §4、§5 |
| 2026-11-08 | 测试命令统一为 `node --test test/*.test.mjs` / `node --test`（Node 24 目录参数失效） | 实测 `MODULE_NOT_FOUND` |

---

## 10. Lead 后续验证（2026-11-08，最终状态）

> §4–§9 的 56/56 是阶段 B 交付时的快照；Lead 随后补了安全与一致性修复，**当前最终状态为 61/61**。

### 10.1 最终测试

```text
$ cd /root/多设备同步 && node --test test/*.test.mjs
tests 61 / pass 61 / fail 0
（archive 14、backends 27、core 6、http-api 3、ui-static 1、e2e 5、safety 5）
```

新增 `test/safety.test.mjs` 5 条：超大文件、后加排除、对端独有根目录、禁用根目录都不产生墓碑/删除；导出时“扫描后文件被改写”必须按实际字节重建清单。

### 10.2 修复项（均由实测暴露）

| 问题 | 根因 | 修复 | 证据 |
|---|---|---|---|
| 设置页 API 可未鉴权访问 | `webServer` 自定义路由不经过 DSH 浏览器鉴权 | 每个实例生成 `state.uiToken`，经 `tapIndex` 只注入受保护 index；`/api/*` 强制 `x-dsh-sync-ui-token` | 线上：无 token 401、query token 401、header 200 |
| 禁用根/排除/超大文件会墓碑远端 | 合并把“本地没有”一律当成本地删除 | 扫描记录 ignored keys/prefixes；引擎过滤远端与基线视图、保留基线 | `safety.test.mjs` 5/5 |
| 导出 500：对象 sha256 不匹配 | 扫描后会话日志被追加，旧 hash 与新字节不一致 | 导出先读实际字节、重建 entries/hash/size 再打包 | 线上导出 200；归档 96 文件 / 50 对象 / 哈希 0 不匹配 |
| 默认 8 MiB 漏掉大会话 | 会话 `.zstd` 最大 19.8 MB | 默认 `maxFileBytes` 32 MiB；排除 `.sessions-trash/**`、`.dsh-market/**` | 线上 manifest 含 19.7/9.5/8.5 MB 三个会话文件 |

### 10.3 线上实测（DSH Web 38445，插件 `include:dsh-sync` active）

| 检查 | 结果 |
|---|---|
| `GET /dsh-sync/api/status` 无 token / query token / header token | 401 / 401 / 200 |
| `POST /dsh-sync/api/export` + 带 header 下载 + `parseArchive` | 200 / 200 / 96 entries，50 objects，hash 不匹配 0 |
| `GET /dsh-sync/v1/ping` | 200，protocol 1 |
| 首次自动同步 | ↑113，0 错误，store 39 MB |
| 32 MiB 上限后手动同步 | ↑6，40.7 MB，0 skipped，0 errors；manifest 含 3 个大会话 |
| 忽略修复后同步 | 0 tombstoned，0 skipped，0 errors |
| 插件行 | `include:dsh-sync` enabled + fiberPhase active |

### 10.4 环境修复（非插件缺陷，已披露）

本机 profile 的 `dsh-plugin-local-model` 是 URL tarball + optional peer，pnpm 10.34.5 在解析该组合时丢 integrity，导致任何 `install_bundle` 都失败。处理：备份 `package.json`/`pnpm-lock.yaml` 到 `/root/dsync-install-backup-20261108T115742`，把已安装的 0.7.1 复制到 `/root/dsh-plugin-local-model-0.7.1`，依赖改为 `link:`；local-model 仍 active。此修复只影响本机 profile，不进入插件包。

### 10.5 仍未覆盖

浏览器视觉/按钮真实点击、真实 WebDAV 服务、跨公网/非 localhost 网络、Windows/macOS 文件语义、真实 512 MiB 归档。设置页需要刷新一次页面才能加载新客户端 bundle。

---

## 11. GitHub 发布验证（2026-11-08）

| 项 | 结果 |
|---|---|
| 仓库 | `https://github.com/irerc/dsh-sync`（public，default `main`） |
| 发布提交 | `ec10aa7b6fdf3a6190f1e4d23393bed8e55033b8` |
| 文件数 | 41 个 blob（API `git/trees?recursive=1` 核对） |
| tag / release | `v1.1.0`；release 资产 `dsh-sync-1.1.0.tgz`（90140 B，sha256 `4e1f2f8a…4c2529`） |
| 内容一致性 | codeload `tar.gz/refs/heads/main` 解包后与本地 `diff -r` **无差异**；`package.json` API 内容 sha256 与本地一致 |
| 安装链路 A | `pnpm add https://codeload.github.com/irerc/dsh-sync/tar.gz/refs/tags/v1.1.0` → `+ dsh-sync 1.1.0`，`import('dsh-sync')` 返回 `name/apply` |
| 安装链路 B | release 资产经 API 下载，sha256 与本地 tarball 完全一致；本地 tarball 在隔离目录安装 + import 通过 |
| 安装链路 C | release 资产 URL（需 `github.com` 可达）；git URL（需 `github.com:443`） |

网络实测：本机 `github.com:443` 连接超时；`api.github.com`、`codeload.github.com`、`raw.githubusercontent.com`、`uploads.github.com` 可达。`v4.gh-proxy.org` 的 `git ls-remote` 可用，但 `git clone` 返回 403，因此安装文档优先 codeload tarball。

推送方式：因 `git push`（github.com）被阻断，使用 GitHub Git Data API（blobs → tree → commit → ref）发布；release 资产经 `uploads.github.com` 上传。
