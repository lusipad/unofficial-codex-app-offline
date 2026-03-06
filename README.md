# Codex App Offline

这个仓库用于把 `OpenAI.Codex` 的 Windows Store 包重新封装为离线绿色版和安装包，并把需要的 skills 一起打进去。

当前实现包含两条输入链路：

- 应用包：通过 `store.rg-adguard.net` 解析 Microsoft Store 分发链接，下载 `OpenAI.Codex` 的 Store 包后再解包封装
- skills：优先使用仓库内的官方快照 `vendor/skills-official`，再叠加本地自定义快照 `vendor/skills`

这样 GitHub Actions 服务器不需要依赖你本机的 `~/.codex/skills`，也不需要服务器自己预装 skills。

## 当前结构

### 应用来源

配置文件：`config/offline-package.json`

当前默认值：

- `appSource.mode`: `rg_adguard`
- `appSource.packageFamilyName`: `OpenAI.Codex_2p2nqsd0c76g0`
- `appSource.ring`: `Retail`

构建流程：

1. `scripts/resolve-store-bundle-url.mjs` 用 Playwright 打开 `store.rg-adguard.net`
2. 按 `PackageFamilyName` 解析 `OpenAI.Codex_2p2nqsd0c76g0`
3. 取得微软 CDN 临时下载链接
4. `scripts/import-store-bundle-from-url.ps1` 下载并解包 `.msix/.appx/.bundle`
5. 提取 `app` 目录并进入统一打包流程

### skills 来源

配置文件里现在有两层 skills 来源：

- `vendor/skills-official`：从官方 `openai/skills` 同步下来的快照
- `vendor/skills`：你本地同步出来的自定义或补充快照

打包时按这个顺序合并：

1. 先放官方快照
2. 再放本地快照

因此如果本地快照里存在同名 skill，会覆盖官方快照中的同名文件。

### skills 打包行为

- `scripts/bundle-skills.ps1` 会把多个来源合并到 `seed/codex-home/skills`
- `scripts/bootstrap-codex-skills.ps1` 会在用户首次启动离线包时，把内置 skills 同步到目标机器的 `~/.codex/skills`
- 不覆盖用户已有的 `config.toml`、认证信息和其他个人数据

## GitHub Actions

### 1. 离线构建工作流

文件：`.github/workflows/build-offline-package.yml`

特性：

- 运行环境：`windows-latest`
- 自动安装 Node.js 和 Playwright Chromium
- 自动解析 Store 下载链接
- 自动生成 `portable.zip`、`setup.exe`、`skills.zip`、`store-export.zip`
- 已加“版本不变时跳过发布”逻辑：如果同一个 release tag 已存在，则跳过构建和发布

### 2. 构建失败重试/告警工作流

文件：`.github/workflows/build-offline-package-monitor.yml`

特性：

- 主构建失败时自动重试失败 job
- 最多重试到第 3 次
- 仍失败时自动创建或更新 GitHub Issue 告警
- 后续有成功运行时自动关闭这个告警 Issue

### 3. 官方 skills 同步工作流

文件：`.github/workflows/sync-official-skills.yml`

特性：

- 定时从官方 `openai/skills` 拉取最新快照
- 把官方 `.system` 和 `.curated` 规范化同步到 `vendor/skills-official`
- 如果快照有变化，则自动提交回当前仓库
- 这次提交会触发离线构建工作流，生成新的离线包

## 本地命令

### 同步本地自定义 skills

```powershell
./scripts/sync-local-skills.ps1
```

默认会把本机 `~/.codex/skills` 同步到 `vendor/skills`。

### 同步官方 skills 快照

```powershell
./scripts/sync-official-skills.ps1
```

默认会按 `config/offline-package.json` 中的配置，把官方 `openai/skills` 快照同步到 `vendor/skills-official`。

### 只测试 Store 下载链接解析

```powershell
node ./scripts/resolve-store-bundle-url.mjs --package-family-name OpenAI.Codex_2p2nqsd0c76g0
```

### 构建离线包

```powershell
pwsh -NoProfile -File ./scripts/build-offline-package.ps1 -ConfigPath config/offline-package.json
```

### 跳过安装器，只生成 zip

```powershell
pwsh -NoProfile -File ./scripts/build-offline-package.ps1 -ConfigPath config/offline-package.json -SkipInstaller
```

## 产物

默认输出到：`dist/offline/<release-name>/`

默认包含：

- `portable.zip`
- `setup.exe`（机器有 Inno Setup 时）
- `skills.zip`
- `store-export.zip`
- `SHA256SUMS.txt`

## 已验证结果

本地已经验证通过的事项：

- 成功通过 `rg-adguard` 解析 `OpenAI.Codex` 的 Store 下载链接
- 成功同步官方 `openai/skills` 快照到 `vendor/skills-official`
- 成功把 `vendor/skills-official` 和 `vendor/skills` 合并打包
- 成功生成离线包目录 `dist/offline/codex-offline-26.305.950.0`
- 解包后的 `app/resources/codex.exe --version` 可执行

## 目录说明

- `config/offline-package.json`：离线构建配置
- `scripts/build-offline-package.ps1`：总控打包脚本
- `scripts/resolve-store-bundle-url.mjs`：非官方 Store 下载链接解析器
- `scripts/import-store-bundle-from-url.ps1`：下载并解包 Store 包
- `scripts/bundle-skills.ps1`：合并并整理多个 skills 来源
- `scripts/sync-local-skills.ps1`：同步本机自定义 skills 到 `vendor/skills`
- `scripts/sync-official-skills.ps1`：同步官方 `openai/skills` 到 `vendor/skills-official`
- `scripts/bootstrap-codex-skills.ps1`：启动前同步内置 skills 到用户目录
- `vendor/skills-official`：官方 skills 快照
- `vendor/skills`：本地自定义 skills 快照
- `.github/workflows/build-offline-package.yml`：离线构建与发布
- `.github/workflows/build-offline-package-monitor.yml`：失败重试与告警
- `.github/workflows/sync-official-skills.yml`：官方 skills 同步

## 风险与边界

当前方案仍然是“临时可用优先”，不是官方离线分发链路，主要风险：

- `store.rg-adguard.net` 是第三方服务，可能失效、限流或页面结构变化
- 微软 CDN 返回的是临时链接，每次构建都必须重新解析
- Store 包内部结构变化后，解包规则可能需要调整
- 官方 skills 仓库结构若变化，同步脚本也可能需要调整

## 原则说明

- KISS：应用包、官方 skills、本地 skills 分别独立处理，再统一打包
- YAGNI：只做当前离线分发所需的同步、合并和发布，不引入额外私有镜像基础设施
- DRY：应用解析、skills 同步、skills 合并、安装器生成各自单一职责
- SOLID：脚本边界清晰，后续切换 Store 来源或 skills 来源时影响面最小
