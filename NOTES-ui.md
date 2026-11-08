# dsh-sync 设置页（Web 客户端）设计与验收说明

## 1. 交付文件

| 文件 | 作用 | 规模 |
| --- | --- | --- |
| `lib/client.js` | 浏览器模块：`settings.section` 设置页、全部 fetch 调用、样式与内联 zh/en 字典 | 2724 行 / 约 110 KiB |
| `locale/zh.json` | Host 侧插件元数据（`meta.title` / `meta.description`） | 2 个字段 |
| `locale/en.json` | 同上，英文 | 2 个字段 |
| `icon.svg` | 原创蓝色同步图标（双向箭头） | 909 B |
| `test/ui-static.test.mjs` | 静态约束 + 注册参数 + 字典完整性 + 假 React 深度渲染冒烟 | 1 个测试 |
| `NOTES-ui.md` | 本文件 | — |

未修改任何其他文件（`lib/index.js`、`lib/http-api.js`、`lib/config.js`、`lib/engine/*`、`test/` 下其他测试均未改动）。

## 2. 组件结构

- `SyncSection`：根组件。持有 `status`、`pending`、`notice`、`configWarnings`、`reports`，负责首次加载、错误重试、刷新、所有 API 动作。
- `StatusCard`：设备名、自动同步/自动保存/启动时同步开关、两个间隔、三个同步按钮（`auto` / `push` / `pull`）、上次同步时间与结果。
- `TargetsSection` → `TargetCard` / `TargetForm`：target 列表、行内编辑、类型切换字段联动、测试连接、保存、二次确认删除、新增。
- `RootsSection` → `RootCard` / `RootForm`：目录列表、路径/启用、排除项逐行编辑（textarea ↔ 数组）、二次确认删除、新增。
- `PeerCard`：配对 url / token 只读展示与复制。
- `TransferCard`：导出（POST 后用返回的 `url` 触发下载）与导入（隐藏 file input，原始字节 + `x-filename`）。
- `LogsCard`：最近 20 条日志（倒序）与冲突列表（倒序，最多 Host 提供的 50 条）。

所有修改动作经 `run(key, task)` 串行化；重入时直接抛 `state.busy`，不会静默返回成功。

## 3. 与 Host 实际实现的对齐（已读 `lib/http-api.js` / `lib/engine/engine.js`）

| 接口 | Host 实际返回 | UI 处理 |
| --- | --- | --- |
| `GET /status` | 顶层 `ok:true` + 设备/开关/roots/targets/peer/logs/conflicts/busy/warnings/config | 严格 `ok:true` 解析 |
| `POST /config` | `{ ok, warnings, status }` | 优先取 `data.status`，兼容顶层 status，否则再 GET；`warnings` 在页面横幅展示前 5 条 |
| `POST /sync` | `{ ok, reports }`，失败也可能 HTTP 200 | 宽松解析；`ok:false` 用 warn 提示，不丢 reports |
| `POST /test` | `{ ok, detail }`；连接失败时 `ok:false` 且仍带 `detail` | 宽松解析，不把 `ok:false` 当接口错误 |
| `POST /export` | `{ ok, name, size, ..., url }` | 用 `url` + `a[download]` 下载 |
| `POST /import` | `{ ok: report.ok, report }`；report 字段为 `imported/unchanged/conflicts/skipped/errors/name` | 宽松解析，按导入字段展示摘要 |

- `status.targets[]` 会带全部非密字段（`local.path`、`webdav.url/username/basePath`、`peer.url`）以及 `password/token = "***"`（空密钥为 `""`），并保留 `detail/lastSyncAt/lastResult`。
- `status.peer.token` 是配对明文；`status.targets[].token` 是掩码，二者分开处理。
- 密钥回传：未触碰的掩码字段回传 `"***"`；Host `fillMaskedSecrets()` 按 `id`（或同类型同 URL）回填已保存值。新 target 发送用户输入（空串表示未设置）。
- `status` 顶层没有 `lastSyncAt` / `lastResult`：UI 从各 target 派生——时间取最大值，结果按各 target 的 `lastResult` 合计，并标注“各目标合计”。若 Host 以后补上顶层字段则优先使用顶层。
- **所有 `/api/*` 请求都带 UI token**：Host 把 `dsh-sync-ui-token` 注入受鉴权保护的 index 页面（`webServer.tapIndex`），UI 从 `<meta name="dsh-sync-ui-token">` 读取，并在 `x-dsh-sync-ui-token` 请求头里回传；下载也用同一 token 走同源 fetch。缺少 meta/token 时 Host 返回 401，UI 展示其错误文本。
- `/api/config` 对非法 root/target 采取“warning 后丢弃/停用”而不是报错：因此 UI 必须展示 `warnings`，否则“已保存”会掩盖配置被丢弃的事实。
- Host 归一化可能改写 target/root（重复 id 重命名、重叠 root 自动停用）：卡片在**本地无未保存修改**时跟随 Host 结果；保存/开关动作成功后还会用返回的 `status` 回填当前卡片，避免开关与实际配置脱节。

## 4. 关键取舍

1. **扁平点号字典键**。`dsh-client-locale` 的 lookup 是 `dict[key]` 直接取属性，不展开嵌套路径；参考插件里的嵌套字典 + `t('status.loading')` 实际取不到。因此内联字典全部使用 `'targets.heading'` 这类扁平键。
2. **locale JSON 只放 meta**。`dsh-app-boot` 的 `dictionariesOf()` 只读 `meta.title` / `meta.description`；界面文案注册在浏览器模块内（`ctx.locale.register(NS, { zh, en })`），与参考插件一致。
3. **严格 / 宽松两种解析**。`/status`、`/config`、`/export` 要求 `ok:true`；`/test`、`/sync`、`/import` 用“HTTP 2xx 即取 payload”，因为它们的 `ok:false` 表示业务结果而非接口错误。
4. **密码不回显**。状态里的 `"***"` 映射为空的 password/token 输入框，placeholder 显示“已保存（不回显）”；保存成功后清空输入框；页面任何位置都不把 `"***"` 当明文展示。
5. **危险删除二次确认**。使用行内两步确认（先点“删除”，出现问句 + “确认删除/取消”），不用 `window.confirm`，以保持与宿主设置页一致的样式。
6. **开关即时保存、间隔显式保存**。三个开关立即 `POST /config`；设备名与间隔需要点“保存设置”。间隔上下限与 Host 归一化对齐：自动保存 5–3600 秒，自动同步 15–86400 秒。新增 target/root 的表单也提供“启用”开关。
7. **导入摘要使用导入语义**。`imported/unchanged/conflicts/skipped/errors`，而不是同步的 `pushed/pulled`。
8. **导出下载**。POST `/export` 后按返回的 `url` 走同源 fetch（带 UI token），转 Blob 后用临时 `a[download]` 触发保存；`a` 挂在 section 根节点（不写 `document.body`），点击后移除并延迟释放 Blob URL。
9. **样式**。只使用 `--dsw-alias-*` token（bg-base/layer-1、border-l1/l2、label-primary/secondary、brand-primary、state-success/warn/error-primary），类名统一 `dsync-`，组件内 `<style>`；`@media (max-width:640px)` 下字段与操作区单列。
10. **不自动轮询**。状态只在首次加载、手动刷新、修改动作返回、同步/导入/导出完成后更新；避免设置页后台持续请求。
11. **数量上限前置拦截**。Host 归一化最多保留 16 个 root、16 个 target、每个 root 50 条排除项；UI 在新增按钮、root 保存、排除项编辑处提前拦截，避免静默截断。
12. **启用状态下的必填对齐 Host**。webdav/peer 仅在“启用”时要求地址；peer 启用时还要求有效 Token（保留已保存的掩码 Token 也算有效），与 `normalizeTarget` 的校验保持一致。

## 5. 未验证项与已知限制

- **没有浏览器目视验证**。插件未安装到 profile，未在 `http://127.0.0.1:38445` 的设置页实际打开本 section；因此不声称“视觉已验证”。已验证的是：源码语法、注册参数、字典完整性、以及用假 React 对 loading/ready/警告/报告分支做的深度渲染冒烟。
- **没有真实 API 往返的交互测试**。没有可用的 React 测试渲染器，按钮点击后的 fetch 序列（保存/测试/同步/导入/导出）未在浏览器或测试运行时执行；契约按 Host 源码逐项核对。
- **响应式布局与图标外观未目视检查**。断点、换行、图标观感仅按 CSS/SVG 结构推断。
- **剪贴板复制**依赖 `navigator.clipboard` 与安全上下文；失败时只显示“复制失败，请手动选择文本”，不自动全选。
- **下载**依赖浏览器对 `a[download]` 与 Blob URL 的支持；导出走同源 fetch + Blob，未实测大文件与取消下载的场景。
- **非 ASCII 归档文件名**：HTTP header 只允许可见 ASCII，UI 对非 ASCII 文件名使用 `encodeURIComponent`；Host 当前不 decode，日志/报告里的名字可能显示为百分号编码。纯 ASCII 文件名原样发送。
- **导入上限**：SPEC 的归档解压输入上限是 512 MiB，UI 客户端也按 512 MiB 预检查；但 Host 当前 `/api/import` 的路由体上限是 256 MiB（压缩后）。256–512 MiB 的文件会通过前端检查后被 Host 以 413 拒绝，UI 会展示 Host 的错误文本。文案已改为“超过 Host 限制的归档会被拒绝”，不再承诺 512 MiB 一定能导入。
- **技术性兜底文案未本地化**：Host 的 `error` 原样展示（外部数据）；`HTTP <status>`、`invalid response payload`、`invalid status payload`、`missing download url` 是异常兜底，不属于界面文案。
- **状态告警范围**：只展示本次 `POST /config` 返回的 `warnings`（前 5 条）；`status.warnings`（启动加载时的归一化告警）未展示。
- **日志/冲突数量**：日志展示最近 20 条（Host 状态里是最近 50 条）；冲突展示 Host 提供的最近 50 条。
- **`maxFileBytes` 与 `status.config`**：UI 未提供 `maxFileBytes` 编辑（不在 §9 清单内），也未使用 `status.config`。
- **UI token 依赖 index 注入**：若宿主 `webServer.tapIndex` 不可用或页面未带 meta，所有 API 会 401；这属于 Host 挂载链路，UI 只能展示错误，无法自愈。
- **时间显示**使用浏览器 `toLocaleString()`，格式随宿主语言环境变化。

## 6. 验收记录（实际执行）

```text
$ node --check lib/client.js
exit=0

$ node -e "JSON.parse(require('fs').readFileSync('locale/zh.json','utf8')); JSON.parse(require('fs').readFileSync('locale/en.json','utf8')); console.log('locale ok')"
locale ok

$ node --test test/ui-static.test.mjs
ui-static ok: locale keys=177, used keys=171, icon bytes=909
✔ test/ui-static.test.mjs
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0

$ wc -c icon.svg lib/client.js
   909 icon.svg
112825 lib/client.js
```

`test/ui-static.test.mjs` 的断言覆盖：

- `window.__ModuleLoader__.load` + `id: 'dsh-sync'`；
- `settings.section` 注入、`id/order=60/locale` 注册参数、`label()` 返回 `nav`；
- `inject: ['slots','locale']`；
- 无 `document.body`、无 `@deepseek-ai/*`、无 `import`、无 `iframe`、`require` 只有 `react`；
- 密码/token 输入框使用 `type='password'`；
- zh/en 字典键集合一致（177 个键），源码使用的 171 个显式键全部存在；动态拼接键单独校验；
- 假 React 深度渲染：loading 态、完整 ready 态（targets/roots/peer/logs 全卡片）、配置警告与同步报告分支；断言页面不出现 `"***"`；
- locale JSON 的 meta 字段、icon.svg 的 256 KiB 上限与蓝色系。