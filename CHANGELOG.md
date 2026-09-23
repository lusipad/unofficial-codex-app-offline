# Changelog

## 2026-09-23

### 中文

- 修复 CI `build-offline-package` 在 `26.917.6896.0` 上连续三次重试全部失败的问题（issue #119）。上游 26.917 同时让两处静态补丁的语义锚点漂移，补丁器按设计失败关闭，构建停在 `Build offline bundle`：
  1. **Chrome native pipe**：`browser-service.mjs` 把桥接查找、「桥不可用」错误和 socket 连接从传输类的 `static async create` 整体移进了一个共享 async 工厂（auth broker 与本机凭据读取两个调用点也复用它），`create` 里只剩一行委托，原来匹配连接流程的两种 `create` 形态同时失配，抛 `Could not locate Chrome browser-client native pipe transport to add Windows fallback.`。现按 single-shape 规则重写为当前形态：先用桥接 getter、不可用消息函数和 `createConnection` 这三个语义符号定位那个工厂（仅用于取压缩后的工厂名与传输类名），补丁**仍然只落在 browser-use 发现流程真正调用的传输类 `create` 上**，共享工厂保持原样——Windows 下 auth broker 的 socket 同样由 `${browser-use 前缀}-${uuid}` 生成，改工厂会把它们一起从特权桥改道到 `node:net` 直连。
  2. **Windows Browser Use 能力覆盖**：上游把 `computerUseNodeRepl` 从能力对象里彻底删除（该键已不在 bundle 任何位置，能力 schema 里也没有了），并把 win32 分支收回成解析函数开头的 `let` 绑定；原正则要求 `,` 前缀且含 `computerUseNodeRepl:!0`，因此失配并抛 `Could not locate the Windows desktop feature override that enables node_repl.`。现按新形态重写，替换串改为直接展开共享契约的 `DESKTOP_BROWSER_USE_CAPABILITY_KEYS`，不再重复写死 `computerUse`/`computerUseNodeRepl`（此前会生成重复键）。
- 定位说明（便于下次复现）：① CI 只会报**第一处**失配，第二处要把完整构建跑到底才会暴露——只修第一处并不能让 CI 转绿；② MSIX 本身就是 ZIP，用 HTTP Range 先读尾部 EOCD、再读中央目录、最后只取目标条目，约 6 MB 就能从 792 MB 的官方包里取出 `browser-service.mjs` 复现匹配失败，无需整包下载；③ 本地 `build/source-app` 缓存可能是旧版本且已被打过补丁，必须以 `Assert-PristineAppSource` 认可的新导出为准，不要用旧 stage 目录推断新版本形态。
- 验证：`node --test ./scripts/test/*.test.cjs` 全绿；对 `26.917.6896.0` 跑通完整离线包构建（`build-offline-package.ps1`，补丁器报 `all patches applied or already correct`）并通过 `verify-offline-package.ps1`。

### English

- Fixed CI `build-offline-package` failing all three retries on `26.917.6896.0` (issue #119). Upstream 26.917 drifted two static-patch anchors at once, so the patcher failed closed and the build stopped at `Build offline bundle`:
  1. **Chrome native pipe**: `browser-service.mjs` moved the bridge lookup, the unavailable-bridge error and the socket connect out of the transport class's `static async create` and into one shared async factory that the auth-broker and native-credential call sites reuse, leaving `create` a one-line delegate. Both `create` shapes that carried the connect flow stopped matching, raising `Could not locate Chrome browser-client native pipe transport to add Windows fallback.` The needle is rewritten to the single current shape: the factory is located by three semantic symbols (bridge getter, unavailable-message function, `createConnection`) purely to recover the minified factory and transport-class names, and the patch **still lands only on the transport `create` that browser-use discovery calls**, leaving the shared factory alone — on Windows the auth-broker socket is generated as `${browser-use prefix}-${uuid}` too, so patching the factory would divert those sockets off the privileged bridge onto a direct `node:net` connect.
  2. **Windows Browser Use capability override**: upstream deleted `computerUseNodeRepl` outright (the key is gone from the whole bundle, including the capability schema) and folded the win32 branch back into the resolver's opening `let` binding. The old regex required a `,` prefix and `computerUseNodeRepl:!0`, so it missed and raised `Could not locate the Windows desktop feature override that enables node_repl.` It is rewritten against the new shape, and the replacement now expands the shared contract's `DESKTOP_BROWSER_USE_CAPABILITY_KEYS` instead of restating `computerUse`/`computerUseNodeRepl` (which previously emitted duplicate keys).
- Debugging notes for next time: (1) CI only reports the **first** miss — the second one surfaces only when a full build runs to completion, so fixing the first does not turn CI green; (2) an MSIX is a ZIP, so reading the trailing EOCD, then the central directory, then just the wanted entries over HTTP range requests pulls `browser-service.mjs` out of the 792 MB official package in about 6 MB, which is enough to reproduce the match failure without downloading the whole bundle; (3) a local `build/source-app` cache can be an older version that is already patched — trust a fresh export that `Assert-PristineAppSource` accepts rather than inferring the new shape from an old stage directory.
- Verified: `node --test ./scripts/test/*.test.cjs` all green; a full offline package build of `26.917.6896.0` completes (`build-offline-package.ps1`, patcher reports `all patches applied or already correct`) and passes `verify-offline-package.ps1`.

## 2026-09-19

### 中文

- 修复 `26.915.4065.0` 离线包启动即白屏、CI `build-offline-package` 在 `Verify offline bundle` 连续失败的问题（issue #116）：上游 `26.915` 给 bundle 的 `package.json` 新增了 `codexWindowsAppContainedCore: "1"`，主进程 bootstrap 因此进入一条仅 MSIX 成立的分支，在 import 主应用**之前**调用原生更新器的 `getCurrentPackageFamily()`；脱离 MSIX 容器时该原生调用抛 `The process has no package identity.`（调用点前的可选链只挡插件加载失败，挡不住调用本身抛错），外层 catch 随即销毁所有窗口，主应用从未启动。离线包本就不是 app-contained core（没有包标识、自带 bundled core），因此补丁把该字段置为 `"0"`，同时让运行时回到它实际附带的 `bundled` 核心选择路径。补丁锚定 manifest 字段名而非压缩标识符，可跨重新压缩存活；字段缺失或出现未知值时补丁器失败关闭，验证器另加一条反向断言拒绝仍带 `"1"` 的包。
- 定位说明（便于下次复现）：日志里最显眼的 `[sparkle] Failed to set up updater` 调用栈**不是**根因——它栈顶是 catch 内的 `startUpdaterAfterStartupFailure`，属二次失败，且 `initializeUpdaterOnce` 自带 try/catch 本就把它兜住；`phase=bootstrap-import-main` 也只是进入 try 前赋好的常量标签，并不代表失败发生在 import。用零补丁的官方原始载荷直启即可复现同样的失败，这条基线排除了本项目补丁的嫌疑，剩下的原始异常要靠给 bootstrap 的 catch 插桩才能打出来。
- 验证：对 `26.915.4065.0` 全补丁包运行 `offline-direct-launch-smoke.mjs` 通过（app-server 与窗口均 ready）；把该字段改回 `"1"` 后验证器如期失败关闭。

### English

- Fixed the `26.915.4065.0` offline package launching to nothing, which failed CI `build-offline-package` at `Verify offline bundle` on every retry (issue #116): upstream `26.915` added `codexWindowsAppContainedCore: "1"` to the bundle's `package.json`, which sends the main-process bootstrap down an MSIX-only branch that calls the native updater's `getCurrentPackageFamily()` *before* importing the main app. Outside an MSIX container that native call throws `The process has no package identity.` — the optional chain in front of it only guards a missing addon, not a throwing one — so the surrounding catch destroys every window and the main app never starts. The offline package genuinely is not an app-contained core build (no package identity, ships its own bundled core), so the patch declares the field as `"0"`, which also keeps the runtime on the `bundled` core-selection path it actually ships. The patch anchors on the manifest field name rather than a minified identifier, so it survives re-minification; a missing field or an unexpected value fails the build closed, and the verifier gained a negative assertion that rejects any package still shipping `"1"`.
- Debugging note for next time: the prominent `[sparkle] Failed to set up updater` stack in the logs is **not** the root cause — its top frame is `startUpdaterAfterStartupFailure`, invoked from inside the catch, and `initializeUpdaterOnce` already swallows that failure on its own. Likewise `phase=bootstrap-import-main` is a constant label assigned before the try block, not evidence that the import is where it broke. A pristine, zero-patch official payload reproduces the identical failure, which clears this project's patches; recovering the actual exception requires instrumenting the bootstrap catch.
- Verified: `offline-direct-launch-smoke.mjs` passes against a fully patched `26.915.4065.0` package (both app-server and window reach ready), and the verifier fails closed as expected once the field is flipped back to `"1"`.

## 2026-09-13

### 中文

- 官方原版 MSIX 作为 release 资产一键直发：构建时保留未修改的官方 x64 包并以稳定名 `OpenAI.Codex-x64.msix` 发布，README 顶部与 MSIX 小节提供 `/releases/latest/download/OpenAI.Codex-x64.msix` 一键直链——点击即下载、双击即安装，不再需要到 rg-adguard 二次输入；rg-adguard 网页与解析脚本保留为备用方式（ARM 设备仍需走备用方式选 arm64 包）。release notes 的资产清单同步列出该文件。
- 修复 DeepSeek + Ultra 组合报错 `The reasoning_text in the thinking mode must be passed back to the API`（issue #114）：`ultra-reasoning-effort` 补丁此前会给所有声明 `max` 的模型合成 Ultra 档位，第三方目录模型（`deepseek-flash` 声明 low/high/max）也因此暴露出 Ultra；DeepSeek 把 ultra 当作 thinking 模式并要求后续请求回传 `reasoning_text`，而 codex 不会回传，第二轮起必报错。现在合成仅限 `gpt-*` 模型（ultra 是 OpenAI 侧能力，GPT-6-Astra/Ultra 组合已实测验证），第三方目录模型保持其目录声明的档位。

### English

- The pristine official MSIX is now published as a release asset: the build preserves the unmodified official x64 package and ships it under the stable name `OpenAI.Codex-x64.msix`, and the README (top callout and MSIX section) links `/releases/latest/download/OpenAI.Codex-x64.msix` — one click to download, double-click to install, no more typing into rg-adguard. The rg-adguard page and the resolver script stay as fallbacks (ARM devices still need a fallback to pick the arm64 package). The release notes asset list mentions the new file.
- Fixed the DeepSeek + Ultra combination failing with `The reasoning_text in the thinking mode must be passed back to the API` (issue #114): the `ultra-reasoning-effort` patch used to synthesize an Ultra entry for every model advertising `max`, which exposed Ultra for third-party catalog models too (`deepseek-flash` declares low/high/max). DeepSeek treats ultra as thinking mode and requires `reasoning_text` echoed back on subsequent requests, which codex never sends, so every turn after the first fails. Synthesis is now limited to `gpt-*` models (ultra is an OpenAI-side capability, validated end to end with GPT-6-Astra/Ultra); third-party catalog models keep exactly the efforts their catalog declares.

## 2026-09-12

### 中文

- 修复 Web 端打开后永久停在官方启动屏（OpenAI logo 加载动画）的问题（issue #112）：Codex `26.908` 把 renderer 的宿主连接从 `rpc-*` chunk 里的 `de(){Q=ue(),$=await Q.services}` 迁移到独立的 `connect-app-host-*` chunk——通过 `window.postMessage({type:"connect-app-host"})` 向 Electron 宿主换取 MessagePort，Web 端无人应答导致 `initializeAppHostServices` 永久 await。Gateway 的运行时补丁仍以压缩标识符匹配旧形态，静默失配。现改为锚定协议常量 `connect-app-host` 替换该连接函数为直接返回 mock services；旧形态保留兼容，两类补丁失配时都会打警告并保持原样（失败关闭）。官方 asset 运行时补丁同步从 `server.ts` 抽到可单测的 `official/assetPatches` 模块，并补了针对新旧两种形态的回归测试。
- 用真实浏览器（Playwright）对 26.908 Web 版做端到端验证后补修了一串连环问题：Windows 下 app-server spawn 命令行用了 POSIX 单引号导致 `codex.exe app-server` 无法启动（改为 Windows 双引号）；`inbox-items` 缺 `unreadRunCounts` 字段导致 renderer 进错误边界；`codex-home` 误返回裸字符串而非 `{codexHome, worktreesSegment}`，attachments 路径退化为相对路径被 app-server 拒绝；26.908 新增的 61 个桌面宿主通知消息类型逐条 ACK；git worker 补 `subscribe-live-query`/`availability`/`config-value`/`review-summary`；mock services 补 `requestUserInputAutoResolution`；新增 `get-setting`/`get-settings`/`set-setting` 设置通道（renderer 会话恢复前要读 `useAppServerPermissionDefault`，缺失时 fetch 响应体为 undefined 会让 renderer `JSON.parse(undefined)` 崩溃）；`thread/start`/`thread/resume`/`thread/fork`/`turn/start` 的 config 覆盖在转发前剔除不完整的 `mcp_servers.codex_app` 碎片（其传输由桌面主进程注入，Web 端只有 `enabled_tools` 碎片会导致 app-server 报 `invalid transport`）；fetch-response 的 `bodyJsonString` 在值为 undefined 时归一为 `"null"`。验证结果：首页完整渲染、会话线程 2.5 秒内加载出消息、附件读取成功，0 页面错误、0 失败请求。

- Web 端新增 gateway 进程代号（server generation）：WS 握手时下发当前代号，页面配置的代号不一致（gateway 重启/升级后旧标签页还跑着过期代码、mock 缺失表现为各种 "not supported by this host"）时自动刷新一次，sessionStorage 记录目标代号防止刷新循环；代号注入首屏配置且 no-store。验证：页面正常加载无刷新循环，重启 gateway 后旧页面自动刷新恢复渲染。
- 修复 Web 端发送消息失败的连环问题（issue #112 后续）：26.908 会话创建会调用宿主 `threadProjectAssignments` 写项目归属，mock services 缺失时报 `Thread project membership is not supported by this host`——现经 fetch 桥对 gateway global-state 做 read-modify-write（与桌面端共享持久化状态）；未实现的 `vscode://codex/*` 端点把 `UNHANDLED_CODEX_CHANNEL` 哨兵 Symbol 直接当返回值序列化，`JSON.stringify(Symbol)` 产出 undefined 导致 fetch-response 丢 `bodyJsonString`，renderer `JSON.parse(undefined)` 报 `"undefined" is not valid JSON`、首条消息发送失败——现在哨兵会被显式识别：宿主 fire-and-forget 设置项（如 `global-dictation-hotkey-state`）按成功 ACK，真正未知的端点返回 501 明确报错而不是无法解析的响应，序列化层对不可 JSON 化的值兜底 `"null"`；`ensure-directory` 在 gateway 真实创建本地目录（等价桌面宿主行为）；`pending_worktrees` shared object 种子为 `[]`（桌面主进程启动即发布数组，缺省 null 会让 renderer 路由 atom 崩溃进错误边界）；`browser-use-session-route-capture` 等桌面通知补 ACK。验证结果：浏览器里新建会话发送首条消息成功，`turn/start` 返回 `turn/started` 进入 inProgress，无错误横幅、无错误边界。
- 修复 Web 端 worktree 全面不可用的问题（issue #112 后续）：① 设置 → Worktrees 页面崩溃进错误边界——旧 renderer mock 补丁对 26.908 新 chunk 静默失配后真实查询打到 gateway，而 `codex-worktrees` 返回的是旧契约 `{path, root, branch, isMainWorktree}`，renderer 对 undefined 的 `dir` 调 `.replace` 崩溃；现对齐桌面 worker（Khe）契约，两级扫描 worktreesRoot 返回 `{dir, gitDir}`（gitDir 经 `git rev-parse --git-common-dir` 解析主仓库根），mock 补丁按分层规则删除。② composer 的"本地/工作树"环境下拉不渲染——26.908 项目改由 app-server 管理后项目路径可以在磁盘任意位置，git worker 的 allowed-roots 校验只认 Desktop workspace roots，`stable-metadata` 对项目路径一律返回 null；现把 Desktop globalState `local-projects` 注册表与 `project/*` RPC 响应里的 rootPaths 纳入允许根。③ 工作树模式发消息卡在"正在等待工作树设置..."——`pending-worktree-create` 等 6 个消息此前被 ACK 吞掉；现实现完整的 pending worktree 状态机（queued → creating → worktree-ready/failed，全量广播 `pending_worktrees` shared object），真实执行 `git worktree add --detach`（支持 `working-tree` 起始状态带未提交改动），并实现 cancel/dismiss/retry/continue/update-metadata 语义；thread/start 按契约由 renderer 自己发起。④ `default-branch` 硬编 `master` 兜底导致 `fatal: invalid reference: master`——改为远端 HEAD → 当前分支 → 本地分支列表（偏好 main/master）→ init.defaultBranch 的解析链，未知时返回 null 由 renderer 按 main 兜底。⑤ git worker 补 `list-worktrees`/`resolve-worktree-for-thread`/`managed-worktree-state`/`delete-worktree`，fetch 桥补 `worktree-set-owner-thread`（归属写入 worktree 的 git config `codex.ownerThreadId`）。验证：浏览器里工作树模式发消息端到端成功（创建 worktree、会话启动、助手回复、settle 后 pending 卡片消失），设置页正常列出托管 worktree，新增 2 个回归测试。
- 跟进 Codex `26.908.4834.0` 的两处上游结构变化：渲染层动态工具列表改为从解构的 `tools` 参数构建（集合从数组字面量变成绑定）、应用命名空间描述被抽到共享绑定，补丁已针对新形态重写；同时上游把 Sky 的 tslib 依赖布局改浅，原先为规避 Windows 路径长度而做的缩短步骤不再有对应形态，予以退休——便携包 200 字符的解压路径预算检查仍然失败关闭，继续兜住未来重新变深的布局。
- 跟进 DeepSeek 官方 Codex 目录的改名与合并：`deepseek-v4-flash` 改名为 `deepseek-flash` 并且**自带图像输入**，独立的 `deepseek-v4-flash-vision-exp` 被上游移除。图像能力校验随之移到 `deepseek-flash`，不再允许它悄悄退化成纯文本模型。上游同时关闭了 `deepseek-v4-pro` 的搜索工具支持，因此能力校验从"所有型号必须一致"改为**按型号声明预期**，这样单个型号再变仍会被拦下。`config.toml` 里写着旧 `deepseek-v4-flash` 的需要改成 `deepseek-flash`。
- 修复包验证在中文等非 UTF-8 代码页的 Windows 上失败的问题：`codex debug models` 输出的是 UTF-8 JSON，而 PowerShell 用主机代码页解码原生命令输出，会打散模型指令模板里的非 ASCII 字符并使 JSON 无法解析。验证期间强制按 UTF-8 解码。
- 重划桌面补丁边界。补丁清单升级为记录，每条带 `kind`（活补丁 / 零改动哨兵）、`tier`（必需 / 陛落）、`assert`（marker / 缺席 / 反向）以及证据和重验条件；补丁器和验证脚本都从这份契约读取，不再各自硬编码。基线为官方 `26.903.8094.0`。
- 删除对当前 Store bundle 无作用的补丁：`windowsStore-patch` 及其 MSIX updater 打桩（该标志全包仅 1 处引用且在 Sentry 遥测里，注入它本身才是把 autoUpdater 指向未链接 MSIX 绑定的原因，A/B 实测移除后离线直启正常）、`electron-namespace-no-auto-updater`、`fast-mode-selector`、`fast-mode-service-tier-options`、`context-usage-visible`、`node-repl-config-reconcile-finally`、`feature-enablement-preserve-unified-exec`、`computer-use-input-mention`(+v2)、`unified-plugins-page`，并把 `computer-use-plugin-root-fallback` 合并进 `computer-use-resource-runtime-paths`。
- 每个补丁只保留与当前 Store bundle 匹配的一个形态；未识别的上游改动失败关闭，由重写补丁解决而不是再加变体。所有变体均对原始包实测后再取舍——`automation cwd` 名为 `LEGACY` 的形态才是生效的那个。
- 补丁器只接受未打补丁的 asar，构建在 staging 前校验源载荷，`import-store-bundle-from-url.ps1` 不再对导入的载荷打补丁（此前源与 stage 会被打两遍，靠补丁器幂等掩盖）。
- 契约成为单一事实源：`settings-route-map`、`locale-source-default`、`stdio-write-error-guard-v2` 不再绕过契约；`enable_i18n` 补丁此前既无 marker 也无任何断言，现已补齐身份与反向断言。必要性无法确定的 9 个补丁降级为告警并登记重验条件，不再造成硬性构建中断。

### English

- Fixed the web UI hanging forever on the official splash screen (OpenAI logo spinner) (issue #112): in Codex `26.908` the renderer moved host connection from the `rpc-*` chunk's `de(){Q=ue(),$=await Q.services}` into a dedicated `connect-app-host-*` chunk that trades a MessagePort with the Electron host via `window.postMessage({type:"connect-app-host"})`; with no host answering in the browser, `initializeAppHostServices` awaits forever. The Gateway runtime patch still matched the old shape by minified identifiers and silently no-opped. The patch now anchors on the `connect-app-host` protocol constant and replaces the connect function with one returning mock services; the legacy shape stays supported, and both patches warn and leave the source untouched (fail closed) when the shape drifts. The official-asset runtime patches moved from `server.ts` into a unit-testable `official/assetPatches` module with regression tests covering both shapes.
- End-to-end verification of the 26.908 web UI in a real browser (Playwright) surfaced and fixed a chain of follow-up issues: the app-server spawn command line used POSIX single quotes on Windows so `codex.exe app-server` never started (now double-quoted); `inbox-items` lacked the `unreadRunCounts` field, pushing the renderer into its error boundary; `codex-home` returned a bare string instead of `{codexHome, worktreesSegment}`, degrading attachment paths to relative ones the app-server rejects; the 61 new desktop-host notification message types in 26.908 are ACKed; the git worker gained `subscribe-live-query`/`availability`/`config-value`/`review-summary`; the mock services gained `requestUserInputAutoResolution`; new `get-setting`/`get-settings`/`set-setting` channels (the renderer reads settings before resuming a conversation, and a missing channel produced an undefined fetch body that crashed `JSON.parse`); `thread/start`/`thread/resume`/`thread/fork`/`turn/start` config overrides are stripped of incomplete `mcp_servers.codex_app` fragments before forwarding (the transport is injected by the desktop main process, and a fragment-only entry makes the app-server fail with `invalid transport`); and fetch-response `bodyJsonString` is normalized to `"null"` when the value is undefined. Result: the home page fully renders, conversation threads load their messages in ~2.5 seconds, and attachment reads succeed, with zero page errors and zero failed requests.
- Added a gateway server generation to the web UI: the current generation is pushed during the WS handshake, and when it differs from the generation baked into the page config (i.e. the gateway restarted or was upgraded while a tab kept running stale code, where missing mocks surface as various "not supported by this host" errors) the page reloads itself once; the target generation is recorded in sessionStorage to prevent reload loops, and the generation is injected into the first-screen config with no-store. Verified: pages load without any reload loop, and after a gateway restart a stale tab reloads itself and recovers.
- Fixed the chain of issues that broke sending messages in the web UI (follow-up to issue #112): 26.908 conversation creation calls the host `threadProjectAssignments` service to record project membership, and the missing mock threw `Thread project membership is not supported by this host` — the mock now does read-modify-write against the Gateway global-state over the fetch bridge, sharing persisted state with the desktop app; unimplemented `vscode://codex/*` endpoints leaked the `UNHANDLED_CODEX_CHANNEL` sentinel Symbol as a return value, and `JSON.stringify(Symbol)` yields undefined, so the fetch-response lost `bodyJsonString` and the renderer crashed with `"undefined" is not valid JSON`, failing the first message — the sentinel is now recognized explicitly: fire-and-forget host settings (e.g. `global-dictation-hotkey-state`) get a success ACK, genuinely unknown endpoints get a clear 501 instead of an unparseable response, and the serialization layer falls back to `"null"` for non-JSON-able values; `ensure-directory` now really creates the local directory in the Gateway (matching the desktop host); the `pending_worktrees` shared object is seeded with `[]` (the desktop main process publishes an array at startup, and a null default crashed a renderer route atom into the error boundary); desktop notifications such as `browser-use-session-route-capture` are ACKed. Verified: creating a conversation and sending the first message in a real browser succeeds, `turn/start` returns `turn/started` and the turn runs, with no error banner and no error boundary.
- Fixed worktrees being entirely unusable in the web UI (follow-up to issue #112): (1) Settings → Worktrees crashed into the error boundary — the old renderer mock patch silently missed the 26.908 chunk shape, the real query reached the Gateway, and `codex-worktrees` answered with the legacy contract `{path, root, branch, isMainWorktree}`, so the renderer called `.replace` on an undefined `dir`; the Gateway now follows the desktop worker (Khe) contract and two-level-scans worktreesRoot, returning `{dir, gitDir}` (gitDir resolved to the main repository root via `git rev-parse --git-common-dir`), and the mock patch was removed per the layering rules. (2) The composer's local/worktree environment dropdown never rendered — once projects became app-server-managed in 26.908 their paths can live anywhere on disk, but the git worker's allowed-roots check only honored Desktop workspace roots, so `stable-metadata` returned null for every project path; the Desktop globalState `local-projects` registry and the rootPaths from `project/*` RPC responses are now registered as additional allowed roots. (3) Sending a message in worktree mode stalled at "waiting for worktree setup" — the six `pending-worktree-*` messages were previously ACK-swallowed; the Gateway now implements the full pending-worktree state machine (queued → creating → worktree-ready/failed, broadcasting the full `pending_worktrees` shared object on every change), really executes `git worktree add --detach` (including `working-tree` starting states that carry uncommitted changes), and honors the cancel/dismiss/retry/continue/update-metadata semantics; thread/start stays with the renderer per the contract. (4) `default-branch` hardcoded a `master` fallback, producing `fatal: invalid reference: master` — it now resolves remote HEAD → current branch → local branch list (preferring main/master) → init.defaultBranch, returning null when unknown so the renderer falls back to main. (5) The git worker gained `list-worktrees`/`resolve-worktree-for-thread`/`managed-worktree-state`/`delete-worktree`, and the fetch bridge gained `worktree-set-owner-thread` (ownership stored in the worktree's git config `codex.ownerThreadId`). Verified end to end in a real browser: worktree-mode message creates the worktree, starts the conversation, gets an assistant reply, and the pending card settles away; the settings page lists managed worktrees; two new regression tests.
- Followed two upstream restructurings in Codex `26.908.4834.0`: the renderer dynamic tools list now builds from a destructured `tools` parameter, so the collection is a binding rather than an inline array literal, and the app-namespace description moved into a shared binding — the patch is rewritten against that shape. Upstream also flattened the Sky tslib dependency layout, so the path-shortening step that existed to keep Windows paths short no longer has a shape to act on and is retired; the portable zip's 200-character extraction budget still fails closed and remains the guard against a future deep layout.
- Followed DeepSeek's rename and consolidation of its official Codex catalog: `deepseek-v4-flash` is now `deepseek-flash` and **carries image input itself**, and the separate `deepseek-v4-flash-vision-exp` entry is gone upstream. The image capability check moved onto `deepseek-flash` so it cannot quietly regress to a text-only model. Upstream also turned the search tool off for `deepseek-v4-pro`, so capabilities are now asserted per model rather than requiring one answer from all of them — a later flip on a single model is still caught. Configs still naming `deepseek-v4-flash` need updating to `deepseek-flash`.
- Fixed package verification failing on Windows hosts whose code page is not UTF-8 (for example Chinese locales). `codex debug models` emits UTF-8 JSON, but PowerShell decodes a native command's output with the host code page, which mangles the non-ASCII characters in the model instruction templates and leaves the JSON unparseable. Verification now forces UTF-8 for that call.
- Redrew the desktop patch boundary. The patch list is now a record set: each entry carries `kind` (live patch or zero-change sentinel), `tier` (required or degraded), `assert` (marker, absence, or the upstream bad shape), plus the evidence behind it and what would settle it again. The patcher and the package verifier both read that contract instead of hardcoding their own answers. Established against the official `26.903.8094.0` bundle.
- Dropped patches that no longer affect the current Store bundle: `windowsStore-patch` and its MSIX updater stub (the flag has a single reference, inside Sentry's `build_type`, and setting it was itself what routed `autoUpdater` to the unlinked MSIX binding; an A/B launch test confirmed the offline package starts without either), `electron-namespace-no-auto-updater`, `fast-mode-selector`, `fast-mode-service-tier-options`, `context-usage-visible`, `node-repl-config-reconcile-finally`, `feature-enablement-preserve-unified-exec`, `computer-use-input-mention` (+v2) and `unified-plugins-page`, and merged `computer-use-plugin-root-fallback` into `computer-use-resource-runtime-paths`.
- Each patch keeps a single shape matching the current Store bundle; unrecognized upstream changes fail closed and are answered by rewriting the patch rather than adding another variant. Every variant was tested against the pristine bundle before being dropped — for automation cwd normalization the shape named `LEGACY` turned out to be the live one.
- The patcher accepts only an unpatched asar, the build verifies the source payload before staging, and `import-store-bundle-from-url.ps1` no longer patches what it imports. Previously the source and the staged copy were both patched, which only worked because the patcher was idempotent.
- The contract is now authoritative: `settings-route-map`, `locale-source-default` and `stdio-write-error-guard-v2` no longer assert themselves outside it, and the `enable_i18n` patch — which had neither a marker nor any assertion — gained both. Nine patches whose necessity could not be established are degraded to warnings that name their re-verification condition instead of failing the build.

## 2026-09-04

### 中文

- 修复本地构建在解压 primary runtime 插件包（`.tar.xz`）时报 `tar exit code 1` 的问题：构建现在优先使用 Windows 自带的 `System32\tar.exe`，并先用 `--version` 确认它支持 xz（bsdtar 需带 `liblzma`，GNU tar 需有 `xz` 且以 `--force-local` 调用）；都不满足时回退到 7-Zip，没有可用解压器时失败关闭并列出检查过的候选。解压失败还会带上解压器的真实输出与排查提示（缺少 xz 支持、符号链接权限、杀软占用、磁盘不足、工作目录过深或含非 ASCII 字符）。
- 生成的自定义模型目录和软件默认模型列表现在都会显示 `GPT-6-Astra`。构建会从 OpenAI 官方目录补入并校验固定指纹的 Astra 条目，为 custom provider 应用现有 Responses 兼容覆盖；Gateway 只补入或取消隐藏 Astra，其他隐藏模型保持隐藏。

### English

- Fixed local builds failing with `tar exit code 1` while extracting the primary runtime plugin archive (`.tar.xz`). The build now prefers the Windows-bundled `System32\tar.exe`, probes `--version` to confirm xz support (bsdtar must report `liblzma`; GNU tar needs an `xz` binary and is invoked with `--force-local`), falls back to 7-Zip when no tar qualifies, and fails closed listing every inspected candidate when nothing can read the archive. Extraction failures now carry the extractor's real output plus hints for the known causes: missing xz support, symlink privilege, antivirus locks, a full disk, and deep or non-ASCII work roots.
- Added `GPT-6-Astra` to both the generated custom model catalog and the app's default model list. Builds supplement the versioned catalog with a pinned official Astra entry and apply the existing custom-provider Responses compatibility fields; the Gateway exposes only Astra while leaving other hidden models hidden.

## 2026-09-03

### 中文

- 修复 Codex `26.901.1978.0` Store bundle 导致离线包验证失败的问题：新版本在 `ChatGPT.exe` 内嵌了 `ELECTRONASAR` asar 完整性资源且不暴露 fuse sentinel，导致无法再用 @electron/fuses 关闭校验。补丁器现在在重打包后把资源中的期望值重写为新 app.asar 头部字符串的 SHA256；资源形状漂移时构建失败关闭。
- 修复 Codex `26.901.2854.0` Store bundle 导致离线包构建失败的问题：renderer 的自定义 model 标签改为 React cache 形态后，补丁器现在从同一 renderer 函数中的 display-name formatter 解析兼容调用；未知形态仍会失败关闭。

### English

- Fixed offline package verification failing against the Codex `26.901.1978.0` Store bundle, which embeds an `ELECTRONASAR` asar integrity resource in `ChatGPT.exe` without exposing the fuse sentinel, so the check can no longer be disabled via @electron/fuses. After repacking, the patcher now rewrites the embedded value to the SHA256 of the new app.asar header string and fails closed when the resource shape drifts.
- Fixed offline package builds failing against the Codex `26.901.2854.0` Store bundle, whose renderer moved the custom-model label into a React-cache shape. The patcher now resolves the display-name formatter from the same renderer function before applying the compatibility fallback, while unknown shapes still fail closed.

## 2026-09-02

### 中文

- 修复 Codex `26.831.2377.0` Store bundle 导致离线包构建失败的问题：归档会话分页已迁移到 `data-controls` 新布局，补丁器现在仅针对该精确形状注入离线缓存回退；未知布局仍会失败关闭。

### English

- Fixed offline package builds failing against the Codex `26.831.2377.0` Store bundle, which moved archived-thread pagination into the new `data-controls` layout. The patcher now adds the offline cache fallback only for that exact shape and still fails closed on unknown layouts.

## 2026-08-30

### 中文

- 修复 portable ZIP 解压时的路径过深问题：归档条目现在相对于包根写入，保留隐藏文件并移除不必要的版本目录前缀；包验证器新增 200 字符的 ZIP 条目路径预算检查。
- 修复 26.825 设置页将 Computer Use、应用内浏览器和外部浏览器显示为不可用的问题：Gateway 现在在 `experimentalFeature/list` 边界强制补齐这三项 renderer 必需能力，同时保留其他实验特性和分页信息。

### English

- Fixed portable ZIP extraction failures caused by deep paths: archive entries are now written relative to the package root, hidden files remain included, and the unnecessary version-directory prefix is removed. The package verifier now enforces a 200-character ZIP entry path budget.
- Fixed Codex 26.825 settings reporting Computer Use, in-app browser, and external browser as unavailable: the Gateway now normalizes these three renderer-required capabilities at the `experimentalFeature/list` boundary while preserving other experimental features and pagination.

## 2026-08-28

### 中文

- 修复 Codex `26.825` Store bundle 结构变化导致离线包构建失败的问题：Worktree `HEAD` resolver 和带引号的 `features.js_repl` 共享配置现在有窄兼容匹配；未知结构仍会阻止出包。构建器现在先解析线上目标，`rg_adguard` 仅在来源模式、包族、版本、文件名和 SHA1 全部匹配时复用 source cache。

### English

- Fixed offline package builds failing against the Codex `26.825` Store bundle. The Worktree `HEAD` resolver and quoted `features.js_repl` shared configuration now have narrow compatibility matches, while unknown structures still block packaging. The builder resolves the online target first and reuses an `rg_adguard` source cache only when source mode, package family, version, file name, and SHA1 all match.

## 2026-08-27

### 中文

- 修复 Codex `26.820.7780.0` 创建永久 Worktree 时将字面量 `HEAD` 错误解析为 `refs/heads/HEAD`、导致创建失败的问题。
- 每日离线包构建时间由北京时间 11:00 调整为 03:00。

### English

- Fixed permanent Worktree creation in Codex `26.820.7780.0` failing because the literal `HEAD` starting ref was incorrectly resolved as `refs/heads/HEAD`.
- Moved the daily offline package build from 11:00 to 03:00 Beijing time.

## 2026-08-26

### 中文

- 修复 Codex `26.820.7780.0` renderer 将动态工具 namespace 描述提取为共享变量后导致离线包构建失败的问题；兼容匹配保留原有守卫并继续对未知结构失败关闭。

### English

- Fixed offline package builds failing against Codex `26.820.7780.0`, whose renderer extracted the dynamic-tool namespace description into a shared binding; the narrow compatibility match preserves existing guards and still fails closed on unknown shapes.

## 2026-08-22

### 中文

- 修复 Codex `26.818.x` renderer 在动态工具处理器中新增执行元数据后导致离线包构建失败的问题；兼容补丁现在保留中止与执行声明守卫，并继续在未识别上游形态时阻止出包。
- 更新 DeepSeek 官方 Codex 模型目录指纹，纳入新增的 `deepseek-v4-flash-vision-exp` 条目，同时继续校验既有模型能力字段。
- 对 `deepseek-v4-flash-vision-exp` 增加独立图像输入能力校验，避免把视觉模型误当作纯文本模型发布。

### English

- Fixed offline package builds failing after Codex `26.818.x` added execution metadata to the renderer dynamic-tool handler; the compatibility patch preserves abort and execution-claim guards while still failing closed on unknown upstream shapes.
- Updated the pinned hash for DeepSeek's official Codex model catalog to include the new `deepseek-v4-flash-vision-exp` entry while keeping capability checks for the existing models.
- Added a dedicated image-input capability check for `deepseek-v4-flash-vision-exp` so the vision model cannot be published as a text-only entry.

## 2026-08-19

### 中文

- 修复 Codex `26.814.x` 最新 Store bundle 导致离线包构建失败的问题：Chrome 的 `browser-service.mjs` 新入口、跨 chunk 的 trusted-path 信任形态、Computer Use 规范 runtime 路径、共享 Chrome 插件描述符和 renderer `node_repl` 动态工具调用现在都有窄兼容匹配；未识别的后续漂移仍会阻止出包。

### English

- Fixed offline package builds against the latest Codex `26.814.x` Store bundle: the new Chrome `browser-service.mjs` entry, cross-chunk trusted-path shape, canonical Computer Use runtime path, shared Chrome plugin descriptors, and renderer `node_repl` dynamic-tool handler now have narrow compatibility matches; unrecognized future drift still blocks packaging.

## 2026-08-15

### 中文

- 修复 Codex `26.810.7004.0` 的 renderer 动态工具结构变化导致最新版离线包无法生成的问题。
- Computer Use 的 `node_repl.js` 兼容补丁现在会保留新版 `deferLoading`、线程归属、实时委派和客户端协调守卫，仅补入顶层 namespace、无 namespace fallback 与调用桥；缺少必需 marker 时仍会阻止出包。
- 归档设置兼容补丁现在识别新版带空列表守卫的 `isError` 别名，只保留本地归档查询错误，避免两个云端归档源在离线时隐藏已加载的本地会话。
- Sidebar Activity priority surface 的权限状态读取器不再锁定单个压缩变量名，并继续由专用 marker 静态启用与验包。
- Sky 0.6.11 的 tslib 路径缩短现在兼容 `dist/node_modules/.pnpm` 布局，重写 34 个导入并删除超过 Windows MAX_PATH 的依赖缓存路径。
- Sky 缓存清理会在递归删除前拒绝根目录或子目录中的 NTFS reparse point，避免 `.pnpm` Junction 把删除范围带出 staging 目录。
- Chrome `browser-client.mjs` 的环境读取补丁不再复用新版压缩函数参数名，并会修复旧构建缓存中已生成的 `function zn(t){let t=...}` 无效代码。
- 离线包验证器在当前 import-settings gate chunk 缺失时改为直接失败，避免上游改名、合并或内联该 chunk 后静默放过入口回归。

### English

- Fixed the latest offline package build failing after Codex `26.810.7004.0` changed the renderer dynamic-tool structure.
- The Computer Use `node_repl.js` compatibility patch now preserves the new `deferLoading`, thread-ownership, realtime-delegation, and client-coordination guards while adding only the top-level namespace, namespace-free fallback, and call bridge. Missing required markers still block packaging.
- The archived-settings compatibility patch now recognizes the guarded `isError` alias, preserves only local archive-query failures, and prevents two offline cloud-source errors from hiding loaded local conversations.
- The Sidebar Activity priority surface no longer pins its permission-status reader to one minified alias and remains statically enabled and verified through its dedicated marker.
- Sky 0.6.11 tslib path shortening now supports the `dist/node_modules/.pnpm` layout, rewrites 34 imports, and removes the dependency-cache path that exceeds Windows MAX_PATH.
- Sky cache cleanup now rejects NTFS reparse points in the cache root or descendants before recursive deletion, preventing a `.pnpm` junction from carrying deletion outside staging.
- The Chrome `browser-client.mjs` ambient-network patch no longer reuses a minified function parameter and repairs invalid `function zn(t){let t=...}` output already present in cached exports.
- Package verification now fails when the current import-settings gate chunk is missing, preventing an upstream rename, merge, or inline change from silently bypassing the settings-entry tripwire.

### Verification

- `node --test scripts/test/*.test.cjs web-gateway/gateway/test/*.test.cjs` (115/115 passed)
- `npm --prefix web-gateway run build:gateway`
- Full installer and portable package build for Codex `26.810.7004.0`
- Offline package verification and 30-second direct-launch smoke test

## 2026-08-13

### 中文

- 恢复最新版离线桌面设置中的“导入”和“连接”入口：共享能力契约跟进新的导入设置 gate，并重新启用本地桌面的远程连接 gate；配对、鉴权和网络错误仍沿用官方行为。
- 离线包验证器现在会从当前 `import-settings-gate-*.js` 读取 gate ID，并在共享契约或桌面运行时未同步时阻止出包，避免上游 gate 漂移再次静默隐藏入口。

### English

- Restored the Import and Connections entries in the latest offline desktop settings. The shared capability contract now tracks the current import-settings gate and re-enables the local desktop remote-connections gates, while pairing, authentication, and network failures keep their upstream behavior.
- Package verification now reads the gate ID from the current `import-settings-gate-*.js` chunk and blocks packaging when the shared contract or desktop runtime falls out of sync, preventing future upstream gate drift from silently hiding the entry.

### Verification

- Targeted offline UI and Gateway capability-contract tests
- Gateway TypeScript build
- Full script and Gateway regression suites
- Current-bundle installer build and offline package verification

## 2026-08-12

### 中文

- 修复 Featured 等插件分类的“查看另外 N 个”入口无法进入完整分类页的问题：Gateway 与桌面运行时现在明确选择官方统一插件页，不再误入点击处理为空的旧版 storefront；仅对旧构建缓存执行定向迁移。
- 安装器新增“使用内置自定义 model 目录”选项；重新安装时取消勾选或卸载会清除安装器管理的目录文件及对应 `model_catalog_json`，不会删除其他 provider、API key 或用户自定义目录。
- 将插件服务断网降级迁移到 Gateway/桌面 IPC 的共享兼容核心，renderer 只保留通用离线查询策略。
- 将传递依赖 `brace-expansion` 更新到 `5.0.9`，修复 npm audit 报告的 high 级拒绝服务漏洞。

### English

- Fixed Featured and other plugin-category “see more” rows failing to open the complete category view. The Gateway and desktop runtime now explicitly select the official unified plugins page instead of the legacy storefront whose click handler is empty; only previously patched build caches receive a targeted migration.
- Added an installer option for the bundled custom model catalog. Unchecking it on a later install or uninstalling removes only the installer-managed catalog and its `model_catalog_json` entry, preserving other providers, API keys, and user catalogs.
- Moved plugin-service network fallback into a shared Gateway/desktop IPC compatibility core; the renderer now keeps only the generic offline query policy.
- Updated the transitive `brace-expansion` dependency to `5.0.9`, resolving the high-severity denial-of-service advisory reported by npm audit.

### Verification

- `node --test scripts/test/*.test.cjs web-gateway/gateway/test/*.test.cjs`
- Gateway TypeScript build
- Current-bundle patch against Codex `26.803.10989.0`
- Full installer and portable package build
- Offline package verification and desktop direct-launch smoke test

## 2026-08-09

### 中文

- 修复系统离线或 Windows 仍报告在线但外网被策略拒绝（如 `net::ERR_NETWORK_ACCESS_DENIED`）时，插件页遮蔽本地和内网市场的问题；明确的 Chromium 网络不可达错误会让云端目录降级为空结果，本地插件查询与安装保持可用。
- 恢复离线状态下 Activity 视图的优先级筛选入口，并让 Skills 页面继续加载本地插件管理数据。
- 不再强制开启依赖云服务的远程连接功能开关，避免离线界面暴露不可用入口。
- 将完整脚本回归测试纳入发布工作流，覆盖离线 UI、插件市场和模型目录补丁。

### English

- Fixed local and intranet marketplaces being hidden when Windows reports online while external access is policy-blocked (for example, `net::ERR_NETWORK_ACCESS_DENIED`), as well as when Windows reports offline. Known Chromium network-unavailable errors now degrade cloud catalogs to empty results while local plugin queries and installs remain runnable.
- Restored the Activity priority filter while offline and kept local plugin-management data loading on the Skills page.
- Stopped forcing cloud-only remote connection gates in offline builds, avoiding unusable UI entries.
- Added the complete script regression suite to the release workflow, covering offline UI, plugin marketplace, and model-catalog patches.

### Verification

- `node --test scripts/test/*.test.cjs`
- `node --test web-gateway/gateway/test/*.test.cjs`
- `npm --prefix web-gateway run build:gateway`
- Full installer and portable package build for Codex `26.803.5235.0`
- Offline package verification and direct-launch UI smoke test

## 2026-08-08

### 中文

- 每个 Release 现在额外提供一个与包内 Codex CLI 精确匹配的 `models-api.json`，合并 DeepSeek 官方条目，并为 GPT-5.6 custom provider 搜索问题提供受校验的临时目录覆盖。
- 恢复 Activity View 的优先级筛选入口，并让 Fast 模式在离线/API Key 场景保持可见可选。
- 兼容 Codex `26.803.5235.0` 的 Chrome native pipe、平台分发器和运行时环境变量读取结构，修复最新版无法生成离线包的问题。
- 增加当前 bundle 结构与离线 UI gate 的回归测试。

### English

- Each Release now includes a `models-api.json` catalog matched to the bundled Codex CLI, combining official DeepSeek entries with a guarded temporary GPT-5.6 custom-provider compatibility override.
- Restored the Activity View priority filter and kept Fast mode available in offline/API-key sessions.
- Added compatibility for Codex `26.803.5235.0` Chrome native-pipe, platform-dispatch, and runtime environment-reader shapes, fixing offline package generation for the latest release.
- Added regression coverage for the current bundle structure and offline UI gates.

### Verification

- `node --test scripts/test/api-model-catalog.test.cjs`
- `node --test scripts/test/*.test.cjs`
- `npm --prefix web-gateway run build:gateway`
- Full installer and portable package build for Codex `26.803.5235.0`
- Offline package verification and 30-second direct-launch smoke test

## 2026-05-17

### English

- Added `Codex Web.cmd`, a localhost-first browser gateway for the offline package.
- Simplified the web path into a local shell around the packaged Codex renderer and app-server. The package no longer carries the extra Electron compatibility runtime, generated channel registry, or duplicated app-name registration layer.
- Removed external source branding from the web shell UI and storage keys. The browser entrypoint now presents itself as `Codex Offline`.
- Packaging now builds and copies the web gateway runtime into `_internal\web`, and the verifier checks the browser launcher, gateway files, and package history file.

### 中文

- 新增 `Codex Web.cmd`，作为离线包的本地优先浏览器 gateway。
- 将 Web 路径收敛成“本地运行壳”：浏览器访问包内 Codex renderer，gateway 桥接到包内 app-server；不再随包携带额外 Electron 兼容运行时、生成式 channel registry 或重复的应用名称登记层。
- 清理 Web 壳 UI 和存储键里的外部来源标识；浏览器入口现在统一显示为 `Codex Offline`。
- 打包流程会构建并复制 Web gateway 运行时到 `_internal\web`，校验脚本会检查浏览器启动器、gateway 文件和历史记录文件。

### Verification

- `npm --prefix web-gateway run build:gateway`
- `node --check web-gateway/start-web.mjs`
- `pwsh -NoProfile -File ./scripts/build-offline-package.ps1 -SkipInstaller -MetadataOutputPath ./build/tmp/web-refactor-build-metadata.json`
- `pwsh -NoProfile -File ./scripts/verify-offline-package.ps1 -BuildMetadataPath ./build/tmp/web-refactor-build-metadata.json`
- Browser smoke on `http://127.0.0.1:3744`
- Desktop feature gates now use the shared capability contract from both the Gateway and `init.cjs`. A central renderer Statsig seam enables unknown gates by default while preserving explicit false decisions; the existing known-gate patch remains as a fallback when the upstream seam drifts.
