# NOTES-backends.md — 传输后端（local / webdav / peer）

> 范围：SPEC 第 5 节后端接口 + `createBackend` 工厂 + 后端单测。
> 负责人：backends-dev。最后更新：2026-11-08。

## 1. 交付文件清单

| 文件 | 说明 |
|---|---|
| `lib/backends/index.js` | `createBackend(target, options)` 工厂；未知 type 抛可读错误 |
| `lib/backends/local.js` | 本地目录后端；`devices/` + `objects/`；tmp+rename 原子写 |
| `lib/backends/webdav.js` | 标准 WebDAV；Basic Auth、逐级 MKCOL、PROPFIND、HEAD/PUT/GET |
| `lib/backends/peer.js` | 对等 DSH `/dsh-sync/v1` 协议；`resolveProtocolBase(url)` 归一化 |
| `test/backends.test.mjs` | 27 个用例，全部真实 localhost 网络 |
| `NOTES-backends.md` | 本文件（取舍 / 限制 / 真实测试输出） |

未改动：`lib/util.js`、`package.json`、其他 `lib/*`、`test/support/*`（夹具由 verify-dev 提供，本套件只复用）、profile。

## 2. 实现要点

### 2.1 通用约定

- 三个实现都返回同一套方法：`init / test / listDevices / readManifest / writeManifest / hasObject / readObject / writeObject / describe / close`。
- 对象名只接受 `/^[a-f0-9]{64}$/`；`deviceId` 只接受 `[A-Za-z0-9_-]{1,128}`（同时挡住 `.`、`..`、路径分隔符，防穿越）。非法输入直接抛 `Error`（编程错误不静默）。
- `readManifest` 遇到 404/不存在返回 `null`；内容损坏记录 `warn` 后返回 `null`（SPEC 3.2：校验失败按不存在处理，不让同步崩溃）。
- `writeManifest` 要求参数是普通对象，先做形状检查再落盘。
- `describe()` 只返回 `{ type, label, detail }`；localhost 的 `detail` 是目录路径，webdav 是根 URL + 用户名，peer 是协议根。**任何实现都不会包含 password / token。**
- `logger` 兼容两种形态：函数 `logger('warn', msg)` 或对象 `logger.warn(msg)`；日志异常被吞掉，不影响同步。`signal` 与内置 60s 超时用 `AbortSignal.any` 合并。
- 创建后端对象**不发网络请求**（只做轻量字段归一化）。连通性探测放在 `init()`/`test()`，便于设置页用同一对象测试未保存草稿。配置缺失（如 local 无 path、webdav 无 url）时 `init()` 抛可读错误，`test()` 返回 `{ok:false, detail}`。

### 2.2 local

- `init()`：`mkdir -p <path>/devices`、`<path>/objects`，递归建目录本身幂等。
- manifest / object 写入均走 `util.writeJsonAtomic` / `util.writeFileAtomic`：同目录 `.<name>.tmp-<pid>-<rand>` → `fsync` → `rename`；失败清理 tmp。测试断言写完后目录里没有 tmp 残留。
- `writeObject` 先 `stat` 判断已存在：内容寻址天然幂等，已存在直接返回 `{ok:true, skipped:true}`。
- `readObject` 返回普通 `Uint8Array`（复制 Buffer，不把内存池 view 泄漏给调用方）。
- `listDevices` 只认 `devices/` 下的普通文件、`.json` 结尾且 id 字符合法；目录、`.txt`、`bad..name.json` 一律忽略并 warn（非法文件名），结果升序去重。

### 2.3 webdav

- 根 URL = `url` 去尾斜杠 + `basePath`（默认 `/dsh-sync`；`/` 归一为空串）。URL 合法性用 `new URL` 提前校验，非 http/https 直接报错。
- `init()`：从 `url` 根基开始，对 `basePath` 的**每一段**依次 `MKCOL`，再 `MKCOL <root>/devices`、`<root>/objects`。201/200/204 视为成功，**405 视为已存在**（重复 init 幂等），其他状态抛 `WebDAV MKCOL <url> 失败：HTTP <code>`。
  - 只逐级创建 `basePath`，不 `MKCOL` `url` 自身的路径段：`url` 是 WebDAV 服务基地址，约定已存在（如 `/remote.php/dav/files/u`）。若 `basePath` 为 `/`，根就是 `url`，此时只建 `devices/`、`objects/`。
- `readManifest`：GET，404 → `null`；2xx 解析 JSON，解析失败 warn + `null`。
- `writeManifest`：PUT `application/json; charset=utf-8`。
- `listDevices`：PROPFIND `<root>/devices/`，`Depth: 1`，请求体只要 `resourcetype/getcontentlength/getlastmodified`。解析 `<d:href>` / `<D:HREF>` / `<href>`（正则兼容任意命名空间前缀），XML 实体反转义，`new URL(href, 请求URL)` 后取 pathname basename，`decodeURIComponent` 去 `.json`，再过 deviceId 校验。404 → `[]`；非 207/2xx 抛带状态码错误。
- `hasObject`：HEAD；200/204 → true，404 → false，其余抛错。
- `writeObject`：先 `hasObject`，已存在返回 `{skipped:true}` 不再 PUT；否则 PUT `application/octet-stream`。
- 每次请求 `AbortSignal.timeout(60_000)`；`options.signal` 存在时用 `AbortSignal.any` 合并。超时/网络错误都包装成可读错误。
- `test()`：完整 `init()`（含 MKCOL）+ 在根目录写 `.dsh-sync-probe-<ts>-<rand>.txt` → GET 比对内容 → DELETE 清理；任何一步失败返回 `{ok:false, detail}`，不抛。
- 成功响应会 `drain()`，避免 keep-alive 连接悬挂；错误响应由 `statusError` 读走前 200 字节文本拼进错误消息，便于排障。

### 2.4 peer

- 协议根：**SPEC §13 CHANGELOG** 要求的容错归一化，`resolveProtocolBase(url)` 单独导出（可单测）：
  1. 去尾斜杠后已以 `/dsh-sync/v1` 结尾 → 原样；
  2. 以 `/dsh-sync` 结尾 → 补 `/v1`；
  3. 其他（`origin`、`origin/`、自定义 path 前缀）→ 补 `/dsh-sync/v1`。
  这样设置页配对区展示的完整 URL 复制粘贴后不会变成 `/dsh-sync/v1/dsh-sync/v1`。实现用 `new URL`，丢弃 query/fragment，只允许 http/https。
- 认证头 `x-dsh-sync-token`；ping 也带（无害），401 统一抛 `peer 认证失败：token 无效（... 返回 HTTP 401 ...）`。
- 接口：`GET ping`、`GET devices`、`GET/PUT devices/<id>`、`HEAD/GET/PUT objects/<hash>`，与 SPEC 第 7 节一致；PUT object 用原始字节 + `application/octet-stream`。
- `readManifest` 404 → `null`；解析失败 warn + `null`。
- `hasObject` HEAD 200/204 → true、404 → false。
- `writeObject` 先 HEAD，已存在跳过。
- 60s 超时 + `options.signal` 合并，与 webdav 相同。
- `test()`：`GET ping` + `HEAD objects/<全零 hash>`，不写任何 manifest、不污染设备列表；探测结果 404 视为权限正常。`init()` 同样只 ping + HEAD。
- `describe()` 只给协议根，不含 token。

## 3. 关键取舍（为什么这么做）

1. **创建不抛、init/test 抛/报**：设置页 `POST /api/test` 会对未保存草稿调用后端；构造阶段抛错会让“缺 url/缺 path”这类可修复配置错误变成 500。因此构造只归一化，`init()` 抛可读错、`test()` 永不抛。
2. **webdav 只逐级 MKCOL `basePath`**：`url` 是服务入口（Nextcloud/坚果云/群晖/AList 的已有路径），对 `url` 自身路径逐级 MKCOL 会向真实服务器打一堆无意义的 405/403。`basePath` 才属于本插件，需要“逐级创建”。
3. **webdav 用 HEAD 做对象探测**：SPEC 明确要求；比 GET 省流量，也避免把对象拉回本地。
4. **peer 探测不写盘**：`test()` 若写 probe manifest 会污染设备列表（其它设备会试图合并它）。改用全零 sha256 的 HEAD：不存在的对象必然 404，正好证明“token 有效 + 对象通道可达”，且零副作用。
5. **内容寻址即幂等**：`writeObject` 对已存在对象直接跳过，避免多设备并发时重复上传大对象。
6. **凭据在创建时快照**：`createBackend` 时读取 `username/password/token`。配置修改后应由 engine 重新创建后端实例（不要在旧实例上改 target 字段）。
7. **复用 verify-dev 的夹具**：`test/support/mock-webdav.mjs`、`peer-server.mjs` 是真实 `node:http` 服务（非 fetch 打桩），满足“测试必须真跑网络”的硬约束，避免两份 mock 漂移。

## 4. 已知限制 / 风险

1. **WebDAV 服务器差异**：
   - `hasObject` 只用 HEAD。个别服务器/网关对 HEAD 返回 405 或 403（只允许 GET），此时 `hasObject` 会抛错而不是返回 false。要兼容需要在 `hasObject` 里对 405 回退 GET（会多耗流量），当前按 SPEC 不实现。
   - `PROPFIND` 假定返回 207（或 2xx XML）。少数服务器返回 200 + XML 也能解析；返回 403/405 视为错误向上抛。
   - 部分服务器要求集合 URL 带尾斜杠（PROPFIND/MKCOL），本实现已统一给 `devices/` 加尾斜杠、MKCOL 用无尾斜杠 URL；若遇到严格服务器可能需要调整。
   - `MKCOL` 把 405 视为“已存在”，这是 WebDAV 常见语义；若某服务器用 405 表示“禁止创建”（只读挂载），会被误判为成功，后续 PUT 会以真实 403 暴露。
   - 未实现 WebDAV 锁（LOCK/UNLOCK）、COPY/MOVE、分块上传；对象写入依赖服务端 PUT 的原子性。坚果云等对 PUT 单文件大小有上限（通常远大于 32 MiB 默认 `maxFileBytes`）。
2. **webdav `url` + `basePath` 组合**：若用户把插件子路径也填进 `url`（如 `.../dsh-sync`）同时 `basePath` 保留默认 `/dsh-sync`，会得到双重路径。设置页应把“服务地址”和“子路径”分开填写；未在代码里猜测用户意图。
3. **peer**：要求对端实现 HEAD（SPEC 要求）；若对端只支持 GET 会失败。token 通过 HTTP 明文头传输，非 TLS 内网可用，公网应走 HTTPS。协议无分块/断点续传，大对象受 `maxFileBytes` 限制。
4. **凭据快照**：配置热更新需重建 backend（见取舍 6）。
5. **本地后端符号链接**：`listDevices` 忽略符号链接；但 `readManifest/readObject` 通过普通 `readFile` 会跟随已存在的符号链接。存储目录由用户自己指定，不额外做 realpath 限制（SPEC 的写入路径安全约束属于 engine 的本地文件写入，不是后端存储）。
6. **超时固定 60s**：SPEC 要求，未做成可配置；大文件在慢网下可能触发超时。
7. **未测试项**：真实 Nextcloud/坚果云/群晖/AList 服务器；仅用真实 HTTP 的 mock WebDAV 覆盖协议子集。WebDAV 大文件、并发写、锁语义未覆盖。

## 5. 测试

命令：

```bash
cd /root/多设备同步 && node --test test/backends.test.mjs
```

环境：Node v24.19.0；真实 localhost 随机端口（`server.listen(0, '127.0.0.1')`），未 mock fetch 返回结果（仅在一个用例里包一层计数代理转发到 `globalThis.fetch`，证明 `fetchImpl` 注入生效）。

覆盖：
- **local**：init 幂等 / test 探测 / manifest 往返与覆盖写 / tmp 无残留 / 对象往返与幂等 / `hasObject` / 缺失 null / listDevices 过滤与排序 / 非法 hash 与 deviceId / 缺 path / describe。
- **webdav**：逐级 MKCOL 精确路径断言 / 405 幂等 / 探测文件 PUT→GET→DELETE / manifest 往返与 404→null / 对象往返与幂等（只 PUT 一次）/ PROPFIND Depth:1 列设备 / 401 与 500 错误传播 / fetchImpl 注入 / describe 不含密码。
- **peer**：`resolveProtocolBase` 五种输入 + 尾部斜杠 / init+test 零写入（设备与对象 Map 为空、无 PUT）/ 401 / manifest 与对象往返 / listDevices / url 带 base path / 完整协议根不二次拼接 / 503 传播 / describe 不含 token。
- **factory**：未知 type 抛错 / 三种类型返回完整接口。

连续运行两次均通过；以下为最后一次真实输出原文：

```text
✔ local · init 幂等创建 devices/objects，test() 真实读写探测 (50.31552ms)
✔ local · manifest 往返、覆盖写原子无 tmp 残留、缺失返回 null (48.267392ms)
✔ local · 对象往返、幂等写入与 hasObject、缺失返回 null (32.229632ms)
✔ local · listDevices 排序并过滤非法文件名/目录 (37.84768ms)
✔ local · 非法对象名与 deviceId 被拒绝（路径穿越防线） (18.463744ms)
✔ local · 缺少 path 时 init 抛可读错误，test() 不抛且给出原因 (0.445184ms)
✔ local · describe 只暴露类型/标签/路径 (5.04448ms)
✔ webdav · init 逐级 MKCOL、405 视为已存在、Basic Auth 正确 (75.243776ms)
✔ webdav · test() 走 MKCOL + 探测文件 PUT/GET/DELETE 并清理 (45.369472ms)
✔ webdav · manifest 往返、404→null、PUT 覆盖到真实路径 (31.660928ms)
✔ webdav · 对象 HEAD 探测、PUT/GET 往返、幂等跳过重复 PUT、404→null (53.486848ms)
✔ webdav · PROPFIND Depth:1 列设备，过滤非 .json 文件 (25.459072ms)
✔ webdav · 认证失败 401 传播为带状态码错误，test() 不抛 (12.583296ms)
✔ webdav · 5xx 错误传播带状态码 (7.832448ms)
✔ webdav · options.fetchImpl 被真实调用（仍走 localhost 网络） (20.441472ms)
✔ webdav · describe 不含密码 (2.733056ms)
✔ peer · resolveProtocolBase 五种 url 输入归一化一致 (0.427136ms)
✔ peer · init/test 用 ping + HEAD 全零 hash，不写假 manifest (19.195136ms)
✔ peer · token 无效时 401 给出可读错误，test() 不抛 (16.143872ms)
✔ peer · manifest 与对象往返、缺失返回 null、幂等写入 (46.205184ms)
✔ peer · listDevices 返回排序后的设备列表 (14.392832ms)
✔ peer · url 带 base path 时协议根为 <url>/dsh-sync/v1 (22.587904ms)
✔ peer · url 直接填完整协议根不会二次拼接（真实网络） (25.482624ms)
✔ peer · 5xx 错误传播带状态码 (6.274176ms)
✔ peer · describe 不含 token (2.585728ms)
✔ createBackend · 未知 type 抛可读错误 (0.338176ms)
✔ createBackend · 三种类型都返回完整 SyncBackend 接口 (5.82144ms)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 852.168832
```

退出码：`0`。