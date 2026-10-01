# 离线未登录时停止 durable 主机重连（`durable-sign-in-retry-stop`）

## 现象

26.928 起，离线且未登录 ChatGPT 时，主进程日志每隔 15～30 秒出现一组 `Sign in to ChatGPT to start a durable thread.`，并附带多段堆栈，重连次数没有上限（3.5 分钟内 14 次）。界面无可见异常，但日志会持续增长。

## 根因

1. renderer 在 `remote-connections/bootstrap` 同步后，只要不是 host-backed 模式，就会无条件添加 `durable` host manager，并调用 `refreshRecentConversations()`，向 durable 发出 `thread/list`（`source=recent_threads`）。
2. 这个请求按需启动 durable 连接。主进程的 durable transport 取不到 ChatGPT 令牌，抛出 `Sign in to ChatGPT to start a durable thread.`。
3. `AppServerConnection` 在启动和重连两条失败路径上都会调用 `shouldStopRetryingRemoteConnection(error)`。该方法只对远程主机配置（`Rn`）设上限，durable 不属于远程主机，于是一直 `scheduleReconnect()`。

官方版同样会走到第 1 步。但官方用户已登录，令牌存在，连接成功，所以不会出现这个循环。

## 改动落点

- `scripts/patch-app-asar.mjs` 中的 `patchDurableSignInRetryStop`：在 `shouldStopRetryingRemoteConnection` 定义开头插入守卫。只有 `hostId === "durable"` 且错误文案完全等于上述提示时，才执行 `stopReconnectTimer()` 并返回 `true`，两条失败路径都会以 `restart_retry_limit_reached` 结束本次尝试。
- 不设置 `nonRetryableFatalError`：之后的按需请求（例如登录后）仍会重新发起连接。
- 锚点：只匹配方法定义（排除 `this.` 调用点），必须恰好一处；同时要求主进程中仍存在 `Error(\`Sign in to ChatGPT to start a durable thread.\`)`，否则守卫会变成死代码，两种情况都失败关闭。
- 契约注册表 `DESKTOP_ASAR_PATCHES` 登记为 required；`verify-offline-package.ps1` 断言 marker 与守卫形态。

## 验证

26.928.3736.0 stage 副本重打补丁，隔离 CODEX_HOME、无 `auth.json`、代理/DNS 全封，运行 3.5 分钟：

| | durable 连接尝试 |
|---|---|
| 补丁前 | 14 |
| 补丁后 | 1 |

定时任务侧栏、任务详情、首页均不受影响。

## 仍未覆盖

- 未在已登录账号下验证。按代码路径，登录后的新请求会重新连接，但没有实测。
- 其他远程主机（如 WSL 版本不兼容时的 `update-required`）的重试由上游自身逻辑处理，本补丁不改变。
