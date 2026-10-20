# 离线未登录与版本不兼容时停止远程主机重连（`durable-sign-in-retry-stop`）

## 现象

1. **durable 无限重连（26.928 起）**：离线且未登录 ChatGPT 时，主进程日志每隔 15～30 秒出现一组 `Sign in to ChatGPT to start a durable thread.`，并附带多段堆栈，重连次数没有上限（3.5 分钟内 14 次）。
2. **WSL / 远程 app-server 版本不支持无限高频重连卡顿（26.1002 起）**：26.1002 提高最低依赖 app-server 版本（如要求 0.141.0，而系统内 WSL 安装了 0.130.0 时），Windows 自动发现的默认 WSL 分发自动带 `autoConnect: true`，连接抛出 `codex-app-server-version-unsupported:0.130.0 (minRequiredVersion: 0.141.0)`。`shouldStopRetryingRemoteConnection` 未将其识别为不可重试错误，主进程以 0 延迟无限循环重新拉起 `wsl.exe`（几分钟内高达数百次），导致主进程事件循环被淹没、窗口严重卡顿（Jank）。

## 根因

1. renderer 在 `remote-connections/bootstrap` 同步后，只要不是 host-backed 模式，就会无条件添加 `durable` host manager，并调用 `refreshRecentConversations()`，向 durable 发出 `thread/list`（`source=recent_threads`）。
2. 这个请求按需启动 durable 连接。主进程的 durable transport 取不到 ChatGPT 令牌，抛出 `Sign in to ChatGPT to start a durable thread.`。
3. `AppServerConnection` 在启动和重连两条失败路径上都会调用 `shouldStopRetryingRemoteConnection(error)`。该方法只对普通远程配置（`Rn`）设上限，durable 不属于远程主机，于是一直 `scheduleReconnect()`。
4. 26.1002+ 中，发现的 WSL 实例默认被标记 `autoConnect: true`，启动即建立连接；若 WSL 内环境的 codex 版本低于最低要求，抛出版本不支持错误，原逻辑未拦截该错误，导致高频重连风暴。
5. 此外，离线环境下 Statsig SDK 发送 POST 请求到 `ab.chatgpt.com/v1/initialize`，Chromium 不允许 POST 重定向到 `data:` URI，导致网络层等待 30 秒 TCP 超时才失败。

## 改动落点

1. **`scripts/patch-app-asar.mjs` 中的 `patchDurableSignInRetryStop`**：
   在 `shouldStopRetryingRemoteConnection` 定义开头插入守卫：
   - 当错误包含 `codex-app-server-version-unsupported`，或为 durable 且等于 `Sign in to ChatGPT to start a durable thread.` 时，执行 `stopReconnectTimer()` 并返回 `true`。
   - 两条失败路径均以 `restart_retry_limit_reached` 结束重试，彻底杜绝零延迟死循环。
2. **`scripts/desktop-patches/init.cjs`**：
   - `patchSharedObjectPayload` & `ipcMain.handle("set-remote-wsl-connections-enabled")`：将 WSL 连接项的 `autoConnect` 强制归一化为 `false`，离线启动不自动发起后台 WSL 进程连接。
   - `setupWebRequestInterceptor`：对 `*://ab.chatgpt.com/*` 的 POST 请求直接 `cancel: true`，0ms Fail-Fast，避免 30 秒 TCP 挂起。
3. **契约与验证器同步**：
   - 契约 `web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs` 登记版本不支持守护；
   - `scripts/verify-offline-package.ps1` 同步断言 marker 与守卫形态；
   - 单元测试覆盖上述守卫分支与 IPC 过滤行为。

## 验证

1. 26.928 副本与 26.1013 离线环境均覆盖验证：
   - durable 与 WSL 均仅尝试 1 次后停用重连定时器，日志不再无休止输出。
   - `node --test .\scripts\test\*.test.cjs .\web-gateway\gateway\test\*.test.cjs` 全量测试通过。
2. Statsig POST 请求 0ms 即被取消，无 30 秒网络超时停顿。

## 仍未覆盖

- 用户在 WSL 中手动执行更新后，需要通过重载或重启 Codex 使连接恢复。
