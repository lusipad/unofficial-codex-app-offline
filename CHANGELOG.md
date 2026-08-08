# Changelog

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
