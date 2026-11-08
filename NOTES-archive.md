# NOTES · `.dshsync` 归档引擎（lib/engine/archive.js）

负责人：子智能体 A（archive-dev）  
范围：`lib/engine/archive.js`、`test/archive.test.mjs`、本文件。未改动其他任何文件。

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `lib/engine/archive.js` | SPEC 第 6 节实现：`buildArchive` / `parseArchive` |
| `test/archive.test.mjs` | `node:test` + `node:assert/strict`，14 个测试 |
| `NOTES-archive.md` | 本文件 |

导出的 SPEC 接口签名与字段名**完全一致**：

```js
export async function buildArchive({ manifest, readObject, signal })
  // => { bytes: Uint8Array, sha256: string, size: number }
export async function parseArchive(bytes, options?) 
  // => { manifest, objects: Map<hash, Uint8Array>, ignored: number }
```

- `bytes` 实际是 Node `Buffer`（`Uint8Array` 子类），`instanceof Uint8Array` 为真。
- `parseArchive` 的第二个参数是可选的测试/资源上限参数（`maxInputBytes` / `maxTotalBytes` / `maxBytes`，
  默认均为 SPEC 的 512 MiB），不传时行为与 SPEC 完全一致。
- 额外导出 `__splitUstarPath(memberPath)`：USTAR `name`/`prefix` 切分原语，仅为可测试性暴露
  （当前格式的成员名最长 72 字符，`prefix` 编码路径在公开接口下不可达）。它**不改变** SPEC 两个主接口的签名。
- `ignored` 是新增的附加字段（SPEC 要求“非清单/对象成员忽略但计数”，计数需要出口），不影响 `{ manifest, objects }` 使用。

## 2. 实现取舍

1. **写入顺序确定**：对象按 hash 升序写入，`manifest.json` 永远第一个成员；同一 hash 被多个 key 引用只读一次、只写一次。
2. **generatedAt**：写入时用 `{ ...manifest, generatedAt: Date.now() }`，不改调用方对象；清单里其他字段原样保留。
   所有成员的 tar mtime 统一取导出时刻（秒级），逐文件时间信息由 `entries[].mtimeMs/updatedAt` 承载。
3. **头部字段严格按 SPEC**：mode `0000644`、uid/gid `0000000`、size = 11 位八进制 + **空格**、
   mtime = 11 位八进制 + NUL、chksum = 6 位八进制 + NUL + 空格、typeflag `0`、magic `ustar\0`、version `00`。
   校验和按 POSIX 无符号字节求和（计算时 chksum 字段视为 8 个空格）。
4. **解包校验（比 SPEC 更严，但都是自洽性/完整性要求）**：
   - 头部校验和、USTAR magic、512 对齐、截断检测；
   - 成员路径 `isSafeRelPath`（复用 `lib/util.js`：绝对路径 / `..` / `\` / NUL / 空段 / 盘符）；
   - 重复成员（含 `./manifest.json` 与 `manifest.json` 归一化后判重）；
   - `objects/` 下文件名必须是 64 位小写 hex，且 `sha256(内容) === 文件名`；
   - 清单结构校验：`format === 'dsh-sync-manifest'`、`version === 1`、`deviceId` 非空、
     `entries` 为数组、每条 `key/root/path` 自洽且安全、`hash` 严格 64 位小写 hex、`size` 为非负安全整数；
     `tombstones` 同理并要求 `deleted === true`；拒绝 entries 内重复 key、tombstones 内重复 key、
     以及同时出现在 entries 与 tombstones 的 key。
   - 清单引用的对象必须齐全，且对象实际长度 === `entry.size`（归档是自包含快照，缺对象不能静默导入）。
5. **忽略但计数**：目录项、符号链接/硬链接、`extras/*`、`notes.txt` 等非 `manifest.json` / `objects/<sha256>`
   成员一律跳过并计入 `ignored`。`./` 前缀会被剥离后再判定。
6. **解压**：`gunzipSync(input, { maxOutputLength: maxTotalBytes + 16 MiB })`。
   16 MiB 是头部/填充余量（约 3 万个成员）；成员声明大小累计超过 `maxTotalBytes` 立即抛错，
   因此伪造巨型 size 头会先命中“超过上限”而不是落到截断错误。
7. **纯函数**：只 `import` 了 `node:zlib` 与 `../util.js`（`sha256Hex` / `isSafeRelPath`），
   不依赖 Host 上下文、不写盘、无全局状态。

## 3. 测试覆盖（对应任务清单 1–10）

| 任务要求 | 测试 |
|---|---|
| 1) 空 entries 往返 | `1)` 归档只含 manifest.json，`entries/tombstones` 空、`objects.size === 0`、`generatedAt` 为导出时刻 |
| 2) 多文件对象去重 | `3)` 两个 key 同 hash：只读一次、tar 只有 1 个对象成员、`objects.size === 1`，tombstone 一并往返 |
| 3) 二进制内容 | `4)` 2048+3 字节，含 `0x00 / 0xFF / 0xFE / 0x80 / 0xC3 0x28` 非 UTF-8 序列，逐字节一致 |
| 4) 长路径 / ustar prefix | `5)` >100 字符 key 往返；手工 153 字符 prefix+name 成员解码；`100` 不切分 / `101` 切分 / `155` prefix 上限 / 无斜杠超长拒绝 |
| 5) 对象 sha256 不匹配 | `6)` build 侧篡改内容、对象缺失、size 不一致；parse 侧内容与文件名不符、清单引用对象缺失 |
| 6) 非法 manifest | `7)` 19 个用例（缺/错 format、version、deviceId、entries、tombstones、key 上跳/绝对/不自洽、root 含斜杠、hash 非法/大写、size 负数/非整数、tombstone 非法、重复 key、entries 与 tombstones 冲突），build 与 parse 双侧都要拒绝；另有坏 JSON、缺 manifest.json |
| 7) 路径越界 | `8)` `../x`、`objects/../../x`、`/etc/passwd`、prefix 拼出 `/etc/passwd`、prefix 拼出 `../`、反斜杠、`C:/evil` 全部拒绝；`./` 前缀正常通过；目录项跳过 |
| 8) 解压上限 | `9)` 输入上限、成员总上限（小参数）、`maxBytes` 便捷参数、伪造 8 GiB size 头（默认 512 MiB 上限）、声明大小优先于内容校验 |
| 9) 重复成员 | `10)` manifest 重复、对象重复、`./` 归一化后重复 |
| 10) gzip 损坏 | `11)` 魔数破坏、截断、CRC trailer 破坏、非 Uint8Array 输入 |
| 附加 | `2)` 头部字段逐字节符合 SPEC；`12)` 未知成员忽略计数；`13)` AbortSignal 取消；`14)` 0 字节文件对象往返 |

## 4. 真实测试输出

命令：

```bash
cd /root/多设备同步 && node --test test/archive.test.mjs
```

输出（2026-11-08，Node v24.19.0，真实粘贴）：

```
✔ 1) 空 entries 往返：只有 manifest.json，objects 为空 (3.374848ms)
✔ 2) USTAR 头部字段：mode/uid/gid/size/mtime/chksum/typeflag/magic/version (0.802432ms)
✔ 3) 多文件对象去重：同一内容被两个 key 引用只写一次 (1.059648ms)
✔ 4) 二进制内容往返：0x00、0xFF、非 UTF-8 序列与跨块长度 (0.955392ms)
✔ 5) 长路径往返：>100 字符 key 保真；ustar prefix 解码；切分边界 (1.339008ms)
✔ 6) 对象 sha256 校验：build 侧与 parse 侧都必须抛错 (1.161472ms)
✔ 7) 非法 manifest：build 与 parse 都必须拒绝 (5.091072ms)
✔ 8) 路径越界：../、绝对路径、反斜杠、prefix 拼接、./ 前缀归一化 (2.652416ms)
✔ 9) 解压上限：输入上限、成员总上限、伪造巨型 size 头 (1.305344ms)
✔ 10) 重复成员：manifest 重复、对象重复、./ 归一化后重复 (0.982208ms)
✔ 11) gzip 损坏：魔数错误、截断、CRC 错误都必须抛错 (1.236992ms)
✔ 12) 未知成员忽略并计数，不影响合法对象 (0.542208ms)
✔ 13) AbortSignal 取消时 buildArchive 抛 AbortError (0.16704ms)
✔ 14) 0 字节文件：size=0 成员往返，sha256 为 e3b0c442… (1.136896ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 116.016
```

第二轮复跑（清理临时目录后）`pass 14 / fail 0 / duration_ms 215.663`。

## 5. 外部交叉验证（真实执行，非单测）

1. **GNU tar 1.35 读取我们的归档**：`tar tzvf sample.dshsync` 列出
   `manifest.json`（627B）、`objects/<hash>`（24B、8B），权限 `-rw-r--r--`、`0/0`；
   `tar xzf` 抽取后 `sha256sum objects/*` 与文件名完全一致。
2. **GNU tar 生成归档交给我们的解析器**：`tar --format=ustar -czf gnu.dshsync manifest.json objects ignored/...`，
   其中含一个 140 字符（prefix 78 + name 62）路径成员；`parseArchive` 返回
   `entries=2 objects=2 ignored=4`，对象内容长度正确（24 / 8 字节）。证明 prefix 解码与真实实现兼容。

## 6. 已知限制 / 风险

1. **内存峰值**：`gunzipSync` 一次性解压，且对象在 Map 中拷贝一份脱离 tar 缓冲。默认 512 MiB 上限下
   极端场景内存峰值可达约 1 GiB。若后续要支持更大归档，建议改成 `createGunzip` 流式 + 逐成员消费。
2. **gzip 输出余量**：`maxOutputLength = maxTotalBytes + 16 MiB` 是头部/填充余量；
   当 `maxTotalBytes` 被调得很小（测试）时，解压本身仍允许额外 16 MiB，但成员声明大小累计会先触发上限，行为可预期。
3. **只支持 USTAR**：PAX 扩展头（`@PaxHeader`）、GNU `././@LongLink` 不会解析；它们会被当作未知成员忽略。
   由于本格式的成员名固定为 `manifest.json` 与 `objects/<64hex>`（≤72 字符），不受影响。
   若第三方用 PAX 把 manifest 放进扩展属性，无法读取（按 SPEC 我们只要求 USTAR）。
4. **成员总数字面上限**：受 16 MiB 头部余量约束，约 3.2 万个成员；远超正常快照规模。
   如需支持更多，可把余量改为按 `maxTotalBytes` 比例或流式解析。
5. **build 侧 prefix 编码不可达**：`objects/<hash>` 永远 72 字符，`manifest.json` 13 字符；
   `__splitUstarPath` 已实现并按边界单测（100/101/155 上限），仅为 SPEC 通用性与未来格式演进保留。
6. **严格导入语义**：清单引用对象缺失或 size 不一致会直接抛错，不做“部分导入”。
   `engine.js` 若需要容忍缺失对象，应在调用前自行裁剪清单（当前实现选择不静默丢数据）。
7. **时间戳**：tar mtime 统一为导出时刻，不逐文件保留；文件真实时间在 manifest 字段中。
8. **字节确定性**：同一输入两次导出因 `generatedAt`/mtime 不同，字节不会完全一致；
   成员顺序、对象去重规则本身是确定的。

## 7. 与 engine.js 集成注意

- `parseArchive` 是 `async`（与 SPEC 标注一致），调用方需 `await`。
- 导入时把 `parsed.manifest` 当 remote、`parsed.objects` 作为对象存储写入后端即可；
  对象 Map 的 value 是 `Uint8Array`，可直接交给后端 `writeObject(hash, bytes)`。
- `buildArchive` 的 `readObject(hash)` 可以返回 `Buffer`/`Uint8Array`/`Promise`；返回 `null` 会抛错，
  所以导出前必须保证 manifest 引用的对象都在后端存在。
- 导出/导入报告里的“忽略成员数”可直接用 `parsed.ignored`。