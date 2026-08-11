# Implementation notes — 插件服务兼容逻辑迁移

Plan: [plugin-service-compat-migration-plan.md](plugin-service-compat-migration-plan.md)

## Decisions

- `scripts/patch-app-asar.mjs` 已有全局 `queries.networkMode = "offlineFirst"`，它覆盖本地插件目录的离线启动需求；插件专用 `always` 补丁不再保留。
- 云端插件目录继续遵循旧行为：只对传输错误降级，不把 HTTP 业务错误伪装成空目录。
- 共享核心放在 `scripts/desktop-patches/plugin-service-compat.cjs`；桌面构建原本就会复制该目录，Web 构建只需把同一文件复制到 Gateway `dist`，不引入第二份规则源。
- 插件页分支由能力契约统一决定：`3413548395` 明确为 `false`，选择官方统一插件页；该 gate 不再进入 ASAR 的“全部强制为 true”列表。renderer 只保留对本项目旧缓存标记的定向迁移，不新增点击事件补丁。

## Deviations

## Surprises

- 桌面 renderer 的 HTTP 请求不经过 Electron `session.webRequest` 注册面；它通过通用 `fetch` IPC 交给主进程的 `electron.net.fetch`。稳定接缝是 IPC 请求/响应 payload，而不是 URL 过滤器。
- 当前桌面主进程把 HTTP 非 2xx 和网络异常都编码为 `responseType: "error"`；因此桌面适配器必须进一步检查 `errorCode`/网络错误链，不能仅凭 responseType 降级。参考 `build/work/asar-extracted/.vite/build/main-Bu4_GUHm.js` 的 fetch wrapper。
- `3413548395 = true` 会加载旧版 `Ri` storefront，其中分类“查看更多”的 `onClick` 实际为 `function ii(){}`；同一 bundle 已包含带完整分类路由的统一页面 `wr`。因此正确修复是能力决策为 `false`，而不是在 DOM 层补一个事件代理。

## Questions for review
