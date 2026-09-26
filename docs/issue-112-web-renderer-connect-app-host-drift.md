# Issue 112: Web 端永久停在官方启动屏

## Root cause

Codex `26.908` 重构了 renderer 的宿主连接：旧形态在 `rpc-*.js` 里是

```js
var Q,$;async function de(){Q=ue(),$=await Q.services}export{$ as n,de as r,Q as t};
```

新形态把 `rpc-*.js` 退化为 148 字节的 re-export，真正的初始化移到
`app-initial-*.js` 的 `initializeAppHostServices`：

```js
async function R0i(){z0i=kae(I0i),Iq=await z0i.services,...}
```

其中 `kae` 来自 `connect-app-host-*.js`：

```js
function d(e){let{port1:t,port2:r}=new MessageChannel;
return window.postMessage({type:`connect-app-host`,port:r},window.location.origin,[r]),n(t,e)}
```

Web 端没有 Electron 宿主应答 `connect-app-host`，`z0i.services` 永不 resolve；
renderer 引导流程 `await R0i()` 之后才会 render，因此页面永远停在官方 splash
（OpenAI logo 加载动画）——正是 issue #112 截图的现象。

Gateway 原有的 `patchRpcInitChunk` 用硬编码压缩标识符（`de/Q/ue`）匹配旧形态，
对 26.908 静默失配（无告警、不 fail-closed），导致 mock 不再注入。

## Fix boundary

- 补丁落点仍在 Gateway 响应期（不落盘改官方 bundle），见
  `web-gateway/gateway/src/official/assetPatches.ts`。
- 新增 `patchConnectAppHostChunk`：锚定协议常量 `connect-app-host`
  （postMessage type，等同 IPC channel 名，属于稳定语义而非压缩标识符），把连接函数
  整体替换为直接返回 `{services: Promise.resolve(<mock services>)}`。
  mock services 与旧 rpc 补丁共用同一份字面量（`MOCK_APP_SERVICES`）。
- 旧 `de()` 形态保留，兼容 26.901 及更早 bundle。
- 两类补丁失配时都打 `[gateway] ... patch skipped` 警告并保持原样（失败关闭，
  与 `patchAppServerManagerSignalsChunk` 的既有行为一致）；rpc chunk 另加
  `await x.services` 嗅觉检查，bundle 再次漂移时不会静默。
- 官方 asset 运行时补丁从 `server.ts` 抽到 `official/assetPatches.ts`，
  使其可以被 `node --test` 直接覆盖（`server.ts` 导入即启动服务，无法单测）。

## Verification

- `web-gateway/gateway/test/officialAssetPatches.test.cjs`：26.908 形态命中替换、
  漂移形态告警且原样返回、旧 `de()` 形态仍被 mock、26.908 re-export rpc chunk 不误报、
  `patchOfficialAsset` 接线（mock + 相对 import 加 query）、非 asset 路径不动。
- 对真实 26.908 webview（`connect-app-host-e569c097489b.js`）跑 `patchOfficialAsset`，
  确认 MessageChannel 被移除、mock services 注入、export 语句完整。
- 端到端冒烟：以 26.908 预提取 bundle 启动 gateway，HTTP 拉取
  `/official/assets/connect-app-host-*.js`，确认响应已是 mock 版本。

## 端到端验证后补修的连环问题（26.908，真实浏览器 Playwright）

启动屏修复后用真实浏览器跑通 Web 版，按调用链又发现并修复：

1. `codex-app-server.ts` 的 `shellQuote` 用 POSIX 单引号，Windows cmd.exe 不识别，
   app-server spawn 直接退出（退出码 1）；win32 下改为双引号。
2. `inbox-items` mock 缺 `unreadRunCounts:{total,automationIds,unreadRuns}`，
   renderer 解构 `unreadRunCounts.unreadRuns` 崩进错误边界。
3. `codex-home` 误返回裸字符串；26.908 桌面契约是
   `{codexHome, worktreesSegment}`（见主进程 `readCodexHomePaths`）。
   renderer 拿到 undefined 后 attachments 路径退化为相对路径，
   `fs/readFile` 被 app-server 以 "AbsolutePathBuf deserialized without a base path" 拒绝。
4. `DESKTOP_VIEW_NOOP_MESSAGE_TYPES` 从 35 扩到 96，覆盖 26.908 新增的
   桌面宿主通知（electron-window-zoom-changed、browser-sidebar-* 等全量 dispatchMessage 枚举）。
5. git worker 补 `subscribe-live-query`/`availability`/`config-value`（真实 `git config --get`，
   scope 白名单 local/global/system/worktree）/`review-summary`
   （对齐桌面 worker 的 `repository_unavailable` 契约）。
6. mock services 补 `requestUserInputAutoResolution`
   （`recordConversationPresented`/`setConversationPresented`/`snooze` 无操作实现）；
   renderer 打开会话线程时 `Iq.requestUserInputAutoResolution.setConversationPresented?.()` 对
   服务对象本身没有可选链，缺失即 TypeError 进错误边界。
7. 新增 `get-setting`/`get-settings`/`set-setting` 通道
   （26.908 桌面契约分别是 `{value}` 与 `{configuredValues, values}`）。renderer 恢复会话前
   要读 `useAppServerPermissionDefault`；通道缺失时 gateway 回 success 但值为 undefined，
   `JSON.stringify(undefined)` 的键经 WebSocket 序列化后丢失，renderer `JSON.parse(undefined)`
   崩溃并陷入 resume 重试循环。fetch-response 的 `bodyJsonString` 同步归一 undefined 为 `"null"`。
8. `thread/resume`（以及 `thread/start`/`thread/fork`/`turn/start`）的 config 覆盖在
   `appServerBridge.callAppServer` 汇聚点剔除不完整的 `mcp_servers.codex_app` 碎片：
   该 server 的 command/args/env 由桌面主进程注入（见 `So(e)`/`uie` 写插件 `.mcp.json`），
   Web 端 renderer 回显的快照只剩 `enabled_tools`，app-server 合并时报
   `failed to load configuration: invalid transport in mcp_servers.codex_app`。
   带 command/url 的完整定义保持不变。

发送消息路径的第二轮连环修复（用户实机反馈 + 浏览器复现）：

9. 26.908 会话创建会调用宿主 `threadProjectAssignments.setAssignment/setProjectless`
   写项目归属；mock services 缺失时 `n3n()` 直接抛
   `Thread project membership is not supported by this host`，首条消息发送失败。
   现 mock 经 fetch 桥读写 gateway global-state 的
   `thread-project-assignments`/`projectless-thread-ids`（read-modify-write，
   与桌面端共享同一份持久化状态，不整体覆盖），`setMembership`/`restoreMemberships`
   无操作。
10. 未实现的 `vscode://codex/*` 端点把 `UNHANDLED_CODEX_CHANNEL` 哨兵 Symbol 当返回值
    交给 fetch 层序列化：`JSON.stringify(Symbol)` 产出 undefined，WebSocket 序列化丢键，
    renderer `JSON.parse(undefined)` 报 `"undefined" is not valid JSON`，
    composer 首条消息发送失败。修复分三层：`ensure-directory` 在 gateway 真实
    `mkdir -p`（renderer 发消息前确保目录存在，对齐桌面宿主）；fire-and-forget 宿主设置项
    （`global-dictation-hotkey-state`、`set-remote-wsl-connections-enabled`）显式成功 ACK；
    其余未知端点返回 501 明确报错（不静默吞掉错误语义），序列化层对不可 JSON 化的值
    兜底 `"null"`。
11. `pending_worktrees` shared object 缺省为 null 时 renderer 路由 atom
    （`AV`/`Nti`）`.find` 崩溃进整页错误边界；桌面主进程启动即发布数组
    （`publishPendingWorktrees`，见主进程 `main-*.js`）。gateway 快照种子补
    `pending_worktrees: []`。`browser-use-session-route-capture` 桌面通知同步补 ACK。

浏览器验证结果（`build/tmp/web-e2e*.cjs`）：首页完整渲染（约 20-27s，慢在 renderer 等待
不可达的 statsig/telemetry 超时），点开会话线程 2.5s 内加载出消息，附件读取成功，
新建会话发送首条消息后 `turn/start` 返回 `turn/started`、turn 进入 inProgress，
无错误横幅、无错误边界，0 pageErrors。

## 旧标签页跑过期代码（用户二次复现的根因）

上述修复全部上线后用户仍复现 membership 报错。日志证据：报错堆栈里
`n3n()` 抛点是 renderer 的**降级默认值**（`Iq?.threadProjectAssignments ?? {setAssignment:e=>n3n()...}`），
说明该页面实例的 `Iq` 没有 `threadProjectAssignments`——即页面是修复前加载的
（当时 mock services 还没有该属性），之后从未重新加载。官方 chunk 的 URL 是内容哈希，
而 gateway 补丁是响应期生效、URL 不变，旧标签页不刷新就会一直跑过期代码。

修复：gateway 进程启动生成 server generation（`server.ts` 的 `SERVER_GENERATION`），
注入首屏配置（no-store）并在 WS hello 握手时回发 `codex-web:server-hello`；
web-shell polyfill 发现代号不一致时自动 `location.reload()` 一次，
sessionStorage 记录目标代号防刷新循环。验证（`build/tmp/web-e2e-autoreload.cjs`）：
页面正常加载 navCount=1 无刷新循环；杀掉并重启 gateway 后旧页面自动刷新并恢复渲染。

## 仍未覆盖的风险

- 报告者环境未确认（无 DevTools / gateway 日志）；若其卡加载另有原因（如 app-server
  握手挂起，`initialize` 无超时兜底），本修复不覆盖。
- 包验证器仍没有 web gateway 端到端 smoke（启动 + 拉取 patched index/assets），
  类似回归只能靠单测和人工冒烟兜底。

## Worktree 支持（用户三次复现：设置页打不开 + worktree 不可用）

设置 → Worktrees 崩溃与 composer 工作树模式卡死的定位与修复：

1. **设置页崩溃**：26.908 worktrees 设置页按桌面 worker（Khe）契约消费
   `codex-worktrees` 的 `{dir, gitDir}`；gateway 返回旧契约
   `{path, root, branch, isMainWorktree}`，renderer 对 undefined `dir` 调 `.replace`
   崩溃进整页错误边界。旧 renderer mock 补丁（`patchWorktreesSettingsChunk`，
   `use-codex-worktrees-*` chunk）对 26.908 静默失配，真实查询因此打到 gateway。
   修复：gateway 对齐真实契约——两级扫描 worktreesRoot（默认 `~/.codex/worktrees`），
   entry 含 `.git`（文件或目录）才计入，`gitDir` 经
   `git rev-parse --path-format=absolute --git-common-dir` 解析主仓库根；
   mock 补丁按分层规则删除（gateway 已提供稳定数据）。
2. **环境下拉不渲染**：composer 的 Local/Worktree 下拉 gating 于
   `stable-metadata` 返回 `root != null`。26.908 项目由 app-server 管理
   （`local-projects` globalState / `project/*` RPC），路径可在磁盘任意位置，
   而 git worker 的 allowed-roots 只认 Desktop workspace roots（`D:\Repos` 等），
   项目路径（如 `C:\Users\...\devops-review`）一律被判越权返回 null。
   修复：`isWithinAllowedRoots` 纳入 Desktop globalState `local-projects`
   注册表和 `project/list|read|create|import|update` 响应中的 rootPaths。
3. **发消息卡"正在等待工作树设置..."**：renderer 把 worktree 创建托管给宿主
   （`pending-worktree-create` dispatchMessage），此前 6 个 `pending-worktree-*`
   消息被 gateway ACK 吞掉。现实现桌面 WorktreeService（XVe）契约的状态机：
   queued → creating → worktree-ready/failed，每次变更全量广播 `pending_worktrees`
   shared object；创建真实执行 `git worktree add --detach <path> <ref>`
   （路径 `<worktreesRoot>/<4位hex>/<repo名>`，`working-tree` 起始状态会先
   `git diff HEAD` 并复制 untracked 文件再 `git apply` 到新 worktree）；
   cancel（含 continueLocally → `executionTarget:'source-workspace'`）、dismiss、
   retry、continue、update-metadata 语义齐全。thread/start 由 renderer 在
   `worktree-ready` 后自己发起（Kfi→startConversation），宿主不代劳；
   settle 后 renderer 回发 update-metadata（conversationStartResult）与 dismiss。
   注意 entry 必须补默认值（`worktreeOutputText` 等），否则 pending 卡片组件
   `$A` 读 undefined `.includes` 崩溃。
4. **`fatal: invalid reference: master`**：`default-branch` 旧实现只查
   `init.defaultBranch` 配置并硬编 `master` 兜底。改为远端 HEAD
   （`symbolic-ref refs/remotes/origin/HEAD`）→ 当前分支 → 本地分支列表
   （偏好 main/master）→ init.defaultBranch，未知返回 null（renderer 按 main 兜底）。
5. **会话页"无法检查工作树状态"横幅**：git worker 缺 `managed-worktree-state`
   （available/gone 主路径）、`resolve-worktree-for-thread`（linked worktree 直接
   复用 + 按 git config `codex.ownerThreadId` 匹配 conversationId）、
   `list-worktrees`（`git worktree list --porcelain` 解析）、`delete-worktree`
   （`git worktree remove --force`）；fetch 桥补 `worktree-set-owner-thread`
   （归属写 worktree 的 git config）。

浏览器验证（`build/tmp/web-e2e-wtsend.cjs`）：devops-review 项目切"新建本地工作树"
发消息，worktree 真实落盘（`~/.codex/worktrees/<hex>/devops-review`，detached HEAD），
会话启动、助手 3-4s 内回复、settle 后 pending 卡片消失，0 pageErrors；
设置页正常列出托管 worktree。回归测试：`webCompat26908.test.cjs` 新增
`codex-worktrees` 两级扫描契约测试与 pending-worktree 状态机端到端测试
（真实 tmp git 仓库跑 `git worktree add`）。

### 仍未覆盖的 worktree 风险

- move-to-worktree 对话框（已有线程迁入工作树）依赖 `worktree-create-managed`
  fetch 端点与 `move-thread-to-worktree` worker 方法（stash/checkout/apply 编排），
  尚未实现；renderer 会收到 501 明确报错而非静默降级。
- `managed-worktree-state` 未实现 snapshot 恢复（桌面的 `restorable` 分支依赖
  删除时打 snapshot ref，gateway 的 delete-worktree 不打 snapshot）。
- 桌面 `create-worktree` 的 local environment setup 脚本执行、上游刷新
  （`upstreamRefreshMode`）与 synced branch 设置未复刻；entry 无 setup 阶段日志。

## 26.917 / 26.924 复发（Web 再次停在启动屏）

26.917 起 Web 端又停在官方启动屏，26.924 修掉握手后仍进不了主界面。逐层定位到五处，
全部在 Gateway / web-shell 层修复，未改桌面 bundle：

1. **mock 按文件名分派失效**：握手从 `connect-app-host-*.js` 并进 `app-shared-*.js`，
   `patchOfficialAsset` 按文件名判断，补丁从未被调用，失配告警也不会触发。
   改为按协议常量 `{type:` + "`connect-app-host`" 分派——文件名不是稳定语义锚点。
2. **补丁查询串写死**：官方资源 `immutable, max-age=1y`，查询串是唯一的失效手段，
   却固定为 `codex-web-worked-for=1`。Gateway 修复后浏览器仍跑缓存里的旧 chunk
   （排查时曾因此误判"修复无效"）。现为 `codex-web-patch=<assetPatches 模块内容哈希>`。
3. **宿主 `httpFetch` service**：26.924 renderer 的 HTTP 请求走 `c5.httpFetch`
   （`fetch(id, req)` 返回可 dispose 的 Promise，结果为 `{response}` 或 `{error, status, …}`；
   `cancel(id)`）。web-shell 的 `createCodexWebHttpFetch` 把它转发到 Gateway 既有的
   `fetch` 消息通道，并照搬桌面主进程 `prepareFetchInit`：字符串 JSON body 且无
   `Content-Type` 时补 `application/json`（否则 `/wham/statsig/bootstrap` 400）。
4. **`codex-app-server-initialized`**：renderer 的 gateway OAuth 就绪（`Uli`）依赖其中的
   app-server 版本，收不到就永远 `loading`。桌面主进程在 initialize 后广播，并在 renderer
   发 `ready` 时经 `sendInitializationSnapshot` 补发；Gateway 按同一契约实现
   （版本取自 initialize `userAgent` 的 `<name>/<version>`）。在 WebSocket hello 时补发无效：
   那时 renderer 还没注册消息处理器。
5. **登录后 Statsig bootstrap**：新增 `POST /wham/statsig/bootstrap`，renderer 5 秒超时，
   离线代理只会超时。Gateway 与 `ab.chatgpt.com` initialize 一样本地返回默认特性，
   响应为 `{statsigPayload: "<initialize JSON，含 user>"}`。

排查方法：遍历 React fiber 读取 `RouteContext.matches` 与挂起组件的 hook 状态，
比静态追踪压缩代码快得多；定位到 `jui` 的 `gatewayOAuthReadiness === "loading"` 后再反查数据来源。

### 仍未覆盖的风险（26.924）

- 首屏约 11～14 秒，其中约 5 秒空档尚未定位。
- 内联可视化沙箱 iframe（`codex-sandbox://`）在 Web 端被 CSP 拦截，属外围功能。
- 直接打开 `/settings/...` 等深链接会落到首页（renderer 使用内存路由），需在应用内导航。
