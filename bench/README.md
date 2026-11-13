# 上传/下载速度基准（bench）

用**真实 `SyncStore` + `SyncEngine` + `lib/backends/webdav.js`** 打本地 mock WebDAV，
在可控的“每请求延迟”下量化同步耗时、请求次数、并发峰值与实际传输字节。

- `mock-webdav.mjs` — 可注入延迟/限速的 WebDAV mock（MKCOL / PROPFIND / HEAD / GET / PUT / DELETE）
- `upload-bench.mjs` — 造夹具、跑一次 `push` 同步、打印指标
- `BASELINE.md` — 1.3.0（`044a940`，改造前）与 1.4.0（改造后）的真实对比数据

## 用法

```bash
node bench/upload-bench.mjs --files 200 --size 4096 --latency 150
node bench/upload-bench.mjs --files 20 --size 4096 --big 3 --big-size 10485760 --latency 50
node bench/upload-bench.mjs --text 60 --text-size 204800 --latency 100
```

常用参数（完整列表见 `upload-bench.mjs` 顶部注释）：

| 参数 | 含义 |
| --- | --- |
| `--files / --size` | 小文件数量与字节数 |
| `--big / --big-size` | 大文件数量与字节数 |
| `--text / --text-size` | 高压缩率 JSON 文本文件数量与字节数 |
| `--latency` | mock 对**每个请求**注入的延迟（毫秒），模拟网络 RTT |
| `--read-bps / --write-bps` | mock 侧读写限速（字节/秒） |
| `--label` | 结果标签，便于对比 |
| `--json` | 只输出一行 JSON（便于脚本对比） |

退出码：`0` 成功，`1` 同步失败或有错误项，`2` 参数非法。

## 指标怎么读

| 指标 | 含义 |
| --- | --- |
| `sync elapsed` | 一次 `push` 同步的总耗时（含引擎扫描） |
| `methods` | mock 侧收到的各类请求数；`HEAD per object` 是最关键的探测开销指标 |
| `concurrency peak` | mock 同时在飞的请求数峰值（= 实际并发度） |
| `mock bytes in (PUT)` | 真正发到服务端的字节数（压缩后） |
| `theory serial lower bound` | 若严格串行、每个对象固定 3 次往返的理论下限 |

判定标准：**串行且每对象 3 次往返时，实测应接近理论下限（ratio ≈ 1.0）**；
优化后请求数应接近“对象数 + 常数”，ratio 显著小于 1，`HEAD per object` 为 0。

## 注意事项

- mock 的延迟是 `setTimeout` 注入的 RTT，不含真实带宽；大文件场景主要测“并发带来的吞吐提升”，
  小文件场景主要测“往返次数减少”。
- `--text` 场景会同时带上默认 200 个小文件（除非显式改 `--files`），用于对比压缩前后传输量。
- 基准不覆盖真实 Nextcloud/坚果云行为差异（限流、chunk 上传等），只保证客户端侧逻辑可量化。