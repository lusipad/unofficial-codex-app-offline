# 渲染层 gate atom 默认开启（`default-on-gate-atom`）

## 现象

官方 Codex 设置里有「应用快照」「Mini 与虚拟宠物」等条目，离线包里没有。

## 根因

renderer 读取 Statsig gate 有两条路径：

| 路径 | 读法 | 离线处理（本次之前） |
|---|---|---|
| `checkGate` | `client.checkGate(id)`，及 `Ic`/`ZEe` 等薄包装 | `default-on-gate-wrapper`：未拉黑的 gate 一律 `true` |
| jotai gate atom | `getFeatureGate(key).value` 写入 atom，UI hook（`qo`/`CZ`、`Zc`、`wu` 等）读 atom | **无**：只有 44 个已知 id 被静态替换或注入 |

离线时 Statsig 没有评估结果，`_makeFeatureGate` 得到 `value:false`。所以只走 atom 路径的 UI 功能全部隐藏，同一个 gate 还可能出现 `checkGate` 路径为开、atom 路径为关的不一致。

## 改动落点

`scripts/patch-app-asar.mjs` 中的 `patchDefaultOnStatsigGateAtom`：

- **锚点**：上游自己的“评估已识别”判定
  `function X(e){return e.details.reason===`LocalOverride`||e.details.reason?.endsWith(`:Recognized`)===!0}`。
  atom 的两处写入（onMount、`values_updated` 刷新）都把 `getFeatureGate(key).value` 和这个判定成对写入，补丁用反向引用要求两者成对出现，不依赖压缩变量名。
- **语义**：`value || (!recognized(gate) && !DENY.includes(key))`。
  - 已识别的评估保持权威，包括 init.cjs 注入的显式 `false`（如 `3413548395`）；
  - 显式 `false` 的 override 同时并入 DENY，避免 Statsig 加载期间短暂打开；
  - 只有“无评估且不在 denylist”的 gate 默认开，和 `checkGate` 包裹对齐。
- **范围**：
  - 只处理 `webview/assets`。主进程 `.vite/build/main-*.js` 内也打包了同一个 Statsig SDK，但主进程 gate 控制更新器、原生能力等启动路径，这里不碰。
  - 直接调用 `getFeatureGate` 的业务逻辑不受影响，例如下发给 app-server 的 `executionValues`（`localThreadStoreCompression`、`backgroundPaginatedRolloutMigration` 等）和 tool catalog。
- **失败关闭**：判定函数或任一写入失配都记为 required 失败，构建中止。`verify-offline-package.ps1` 要求 marker 恰好出现两次，并拒绝残留未打补丁的 atom 写入。

没有选择在 SDK `_getFeatureGateImpl` 层默认开：那样会同时打开 app-server 实验 feature、tool catalog 和主进程 gate，且上游每新增一个这类 gate 都会被静默开启。

## Denylist（`DESKTOP_GATE_DENYLIST`）

基于 26.924.2738.0 renderer 静态扫描。对每个以 `fn(`id`)` / `fn(x,`id`)` 形式读取的 gate，按引用它的 chunk 分类：

- **拒绝**：
  - 只出现在云端 / ChatGPT chunk 中（计费、GPT、Library、Sites、地图、广告、语音、手机、公告、NUX）；
  - 只出现在 `app-initial`/`app-shared`/`page`/`dialog` 等通用 chunk、无法确认用途；
  - 人工确认的 onboarding、插件界面（保持插件服务契约现状）、遥测、app-server 绑定（`eTa` tool catalog、`Ec` 映射）。
- **排除**：已经由 `checkGate` 路径打开的 gate，以及 `DESKTOP_ASAR_KNOWN_GATE_IDS`。denylist 同时作用于 `checkGate` 包裹，把它们列进来会让当前已开的功能反向关闭。本次改动只新增开启，不关闭任何现有功能。

结果：denylist 398 个；atom 路径新开放 60 个本地功能 gate，包括：
- 应用快照（`1532120159`）；
- 宠物（`1655510532`、`188145323`）；
- 头像悬浮；
- 代码审查设置；
- Worktrees；
- 自动化；
- 会话 / Artifact 界面；
- 电脑操控 / 浏览器设置。

### 运行时校验（A/B）

静态扫描只能看到字面量 id，所以在 26.924.2738.0 的同一个 stage 上做了对照：
- 对照组只还原 atom 补丁、重新打包 asar、改写 `ELECTRONASAR`，然后跑 `offline-direct-launch-smoke.mjs`；
- 实验组为补丁版加调试打印，记录每个被打开的 gate。

结论：

- `375130565`：初判为“本地环境设置”，实际还用于云端任务环境标签。打开后 renderer 会连接 `durable` host，报 `Sign in to ChatGPT to start a durable thread` 并反复重试。已加入 denylist，由二分定位。
- `3389661532`（工作区语音权限）、`1009060764`（renderer 卡顿检测遥测）以变量传入 id，扫描不到，由运行时打印发现。已加入 denylist。
- `3855399757` 即 `wsl_remote_connections`，打开后会自动连接 WSL 内的 Codex。它是本地功能，保留开启。WSL 内 codex 版本低于要求（如 0.130 < 0.141）时会显示 `update-required` 并重试，行为与官方版一致。
- 最终版冒烟：`durable` 连接为 0，启动通过。

### 界面校验（CDP）

用同一个 stage 的便携程序、隔离的 user-data 目录和临时 CODEX_HOME（只含 `config.toml`、`auth.json`、`.codex-global-state.json`），通过 CDP 打开设置并截图对比：

- 首轮补丁版比无补丁版多出：
  - 设置 → 集成「应用快照」；
  - 设置 → 个人「个人资料」「语音」「调试」；
  - 左栏「资料库」。
- 「调试」：由 `2423536643`（GPU 画面撕裂调试，`isGpuTearingDebugEnabled`）控制，是官方版不显示的内部页，已拒绝。
- 「资料库」：由 `3765605143`（ChatGPT Library）控制，离线无法加载，已拒绝。它是唯一一个已被 `checkGate` 路径读取、仍被放进 denylist 的 id：无补丁版左栏本来就没有它。
- 最终版设置导航与官方版一致，只缺云端专属的「通知」「家长控制」「受信任联系人」。「应用快照」页可以正常打开，显示快捷键、发送目标、播放音效和示意图；「Mini 与虚拟宠物」页正常渲染。
- 首启引导页、“完成 Windows 设置以继续”提示在无补丁版上同样出现，与本补丁无关。

### 从 denylist 移出：`3085093835`（26.928 新导航）

- 26.928 的导航模式判定 `GSr` 在 atom 路径（`zR`）和 app-shared 的 `Ao` 都读 `3085093835`，两者皆 false 时返回 `legacy`：左侧是旧式单列导航，没有图标栏，也没有定时任务侧栏 `ScheduledSidebar`。
- 它是在首轮静态扫描时整批进入 denylist 的，没有单独做过 A/B。旧导航下 `/scheduled` 经 `SDa` 落到云端已安排任务表；未登录时 `automations.cloud` 判定可用，但 `cloud-automations/table` 查询因无账号被禁用，永远停在 pending，页面一直显示「正在加载任务」。
- 移出后的界面 A/B（26.928.2636.0 stage 副本重打补丁、无 `auth.json`、代理/DNS 全封，另测 `navigator.onLine=false`）：出现图标栏（首页/定时任务/插件/探索/代码审查），没有离线不可用的云端入口；定时任务主区是 `ScheduledLanding`，侧栏「即将执行」列出本地任务，任务详情可以打开。契约测试锁定它不得再进入 denylist。

### 从 denylist 移出：`1892382740`（26.928 电脑操控 / browserUseTinysky）

- 26.928 上游新增 `unified-computer-use` 插件（`cua_repl` MCP 服务 + TinySky CUA 运行时，与旧 `computer-use` 插件并存）。主进程对它的可用性判断是 `features.browserUseTinysky && (inAppBrowserUse || externalBrowserUse || computerUse)`；`browserUseTinysky` 在 renderer 侧就是 Statsig gate `1892382740`（`electron-desktop-features-changed` 的 `browserUseTinysky` 字段，主进程同时把它镜像进 node_repl 子进程的 `BROWSER_USE_TINYSKY_ENABLED`）。
- 该 id 在 26.924 静态扫描时只出现在通用 chunk、用途不明，被整批拉黑；26.928 里它关闭的是电脑操控的新栈：基线上主进程判定不可用 → 统一插件完全不进插件清单，应用向 `config.toml` 写入 `BROWSER_USE_TINYSKY_ENABLED="0"`，并注册一个指向 `ChatGPT.exe` 的假 `cua_repl` 占位（unavailable dummy tool）。
- 移出后的 A/B（26.928.3736.0 stage 副本：从已打补丁的 asar 精准移除 denylist 中该 id 共 3 处、重打包并改写 ELECTRONASAR 完整性资源；隔离 CODEX_HOME、代理/DNS 全封）：统一插件变为 `installed:true / enabled:true / availability:AVAILABLE`，应用写入 `BROWSER_USE_TINYSKY_ENABLED="1"` 且不再注册假 `cua_repl` 占位；`offline-direct-launch-smoke` 通过（durable 连接 0 次）。composer 的「电脑」mention、插件页的 Computer Use 卡片在基线与实验组均存在（来自旧 `computer-use` 插件，与本 gate 无关）。契约测试锁定它不得再进入 denylist。

## 仍未覆盖

- **Web 端**：Gateway 目前没有 `checkGate` 包裹，也没有 atom 补丁，gate 仍由 `featurePatches.ts` 按已知列表注入。若 Web 要对齐，应在 `assetPatches.ts` 复用同一 denylist，并先补齐 `checkGate` 语义。
- **新版本**：上游新增的 gate 会默认开启。每次升级都应重新扫描，把新增的云端 / 逻辑类 id 补进 denylist。以变量传入 id 的 gate 静态扫描看不到，需要用运行时打印的方法补查。
- **原生能力**：「应用快照」等功能除 gate 外还依赖原生截图和全局热键模块。gate 打开只保证入口出现，功能是否可用要在安装包上实测。
