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

结果：denylist 396 个；atom 路径新开放 61 个本地功能 gate，包括：
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

## 仍未覆盖

- **Web 端**：Gateway 目前没有 `checkGate` 包裹，也没有 atom 补丁，gate 仍由 `featurePatches.ts` 按已知列表注入。若 Web 要对齐，应在 `assetPatches.ts` 复用同一 denylist，并先补齐 `checkGate` 语义。
- **新版本**：上游新增的 gate 会默认开启。每次升级都应重新扫描，把新增的云端 / 逻辑类 id 补进 denylist。以变量传入 id 的 gate 静态扫描看不到，需要用运行时打印的方法补查。
- **原生能力**：「应用快照」等功能除 gate 外还依赖原生截图和全局热键模块。gate 打开只保证入口出现，功能是否可用要在安装包上实测。
