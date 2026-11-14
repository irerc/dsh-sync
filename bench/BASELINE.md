# 上传加速基准：1.3.0（改造前）→ 1.4.0（改造后）

同一台机器、同一份 `bench/`、同样参数、同一 mock WebDAV（延迟通过 `setTimeout` 注入 RTT）。
基线代码：`044a940`（1.3.0 发布版）；改造后：1.4.0 工作区。

## 结论

| 场景 | 改造前耗时 | 改造后耗时 | 提升 | 请求数 | 其中 HEAD |
| --- | --- | --- | --- | --- | --- |
| A：200 × 4KB，RTT 150ms | **98,664 ms** | **9,098 ms** | **10.8×** | 605 → 203 | 400 → **0** |
| B：20 小 + 3 × 10MB，RTT 50ms | **4,858 ms** | **1,921 ms** | **2.5×** | 74 → 26 | 46 → **0** |
| C：260 对象（含 60 × 200KB 文本），RTT 100ms | **87,339 ms** | **8,221 ms** | **10.6×** | 785 → 263 | 520 → **0** |
| C 的实际传输字节 | 13,176,412 B | **931,688 B** | **−92.9%** | — | — |

三项优化分别对应：

1. **去掉逐对象双重探测**：原来 `engine.putObject` 先 `hasObject`，后端 `writeObject` 内部又探测一次
   → 每对象 2 次 HEAD；现在探测只发生一次，且 WebDAV 用一次 `PROPFIND objects/` 建索引后为 0 次。
2. **并发上传/下载**：严格串行改为有界并发（默认 4，可配 1–16，另有 64MiB 字节预算防内存峰值）。
3. **对象 gzip**：JSON/Markdown 等文本对象压缩后再 PUT，仅当体积确实变小（<90%）才压。

## 原始输出（关键行）

改造前 A：

```
sync elapsed            : 98664 ms
methods                 : HEAD=400 MKCOL=3 PROPFIND=1 PUT=201
HEAD per object         : 2
concurrency peak        : 1
```

改造后 A：

```
sync elapsed            : 9098 ms
methods                 : PROPFIND=2 PUT=201
HEAD per object         : 0
concurrency peak        : 4
```

改造前 C：

```
sync elapsed            : 87359 ms
methods                 : HEAD=520 MKCOL=3 PROPFIND=1 PUT=261
mock bytes in (PUT)     : 13176412 (12.566 MiB)
```

改造后 C：

```
sync elapsed            : 8221 ms
methods                 : PROPFIND=2 PUT=261
mock bytes in (PUT)     : 931688 (0.889 MiB)
mock bytes in by type   : application/octet-stream=819200; application/gzip=43276; application/json; charset=utf-8=69212
```

即高压缩率文本部分：12,288,000 B → 43,276 B（压缩率 0.35%），其余小文件为随机内容、不压缩。

改造前 B：

```
sync elapsed            : 4858 ms
methods                 : HEAD=46 MKCOL=3 PROPFIND=1 PUT=24
HEAD per object         : 2
```

改造后 B：

```
sync elapsed            : 1921 ms
throughput              : 16.4147 MB/s
methods                 : PROPFIND=2 PUT=24
HEAD per object         : 0
```

B 场景受 30MB 数据量本身限制，提升倍数低于小文件场景属预期：往返少了，但带宽没变。

## 复现方式

```bash
# 改造后
node bench/upload-bench.mjs --files 200 --size 4096 --latency 150 --label after-a

# 改造前（用 1.3.0 的提交另开工作树）
git worktree add /tmp/bench-baseline 044a940
cp -r bench /tmp/bench-baseline/
cd /tmp/bench-baseline && node bench/upload-bench.mjs --files 200 --size 4096 --latency 150 --label baseline-a
```

## 说明

- 延迟由 mock 注入，代表 RTT，不代表真实带宽；因此“小文件多”的场景提升最明显，
  “少量大文件”的场景提升主要来自并发（多文件并行传输）。
- `PROPFIND=2`：一次列 `devices/`，一次建 `objects/` 索引；`PUT=201`：200 个对象 + 1 次 manifest。
- 改造前 `HEAD=400` 正好等于 200 对象 × 2 次探测，是本次优化最主要的浪费来源。