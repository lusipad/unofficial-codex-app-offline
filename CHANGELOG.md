# Changelog

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
