# Codex App Offline

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

This repository repackages the `OpenAI.Codex` Windows Store app into an offline portable edition and installer, bundling the required skills together.

The current implementation has two input pipelines:

- **App package**: Resolves the Microsoft Store distribution link via `store.rg-adguard.net`, downloads the `OpenAI.Codex` Store package, then extracts and repackages it.
- **Skills**: Fetched live from the official `openai/skills` repository at build time, then overlaid with local custom snapshots from `vendor/skills`.

This means the GitHub Actions runner does not depend on your local `~/.codex/skills`, nor does the repository need to cache official skills snapshots long-term.

### Configuration

The project provides three levels of configuration: a **build config file**, **runtime environment variables**, and **script parameters**.

#### Build Config — `config/offline-package.json`

This is the main build configuration file. All fields and their purposes:

```json
{
  "appName": "Codex",
  "packageId": "OpenAI.Codex",
  "releaseNamePrefix": "codex-offline",
  "installDirName": "Codex Offline",
  "appSource": {
    "mode": "rg_adguard",
    "packageFamilyName": "OpenAI.Codex_2p2nqsd0c76g0",
    "ring": "Retail"
  },
  "skills": {
    "sources": ["build/work/skills-official", "vendor/skills"],
    "official": {
      "owner": "openai",
      "repo": "skills",
      "ref": "main",
      "destination": "build/work/skills-official"
    }
  },
  "packaging": {
    "outputDir": "dist/offline",
    "portableZip": true,
    "setupExe": true,
    "skillArchive": true,
    "sourceExportArchive": true
  },
  "github": {
    "runner": "windows-latest"
  }
}
```

| Field | Description |
|-------|-------------|
| `appName` | Display name used in the installer and release notes |
| `packageId` | Windows Store package identifier |
| `releaseNamePrefix` | Prefix for release directory names (e.g. `codex-offline-1.2.3`) |
| `installDirName` | Directory name under `Program Files` shown in the installer |
| `appSource.mode` | Source mode: `rg_adguard` (download via rg-adguard) or `installed_store` (extract from locally installed Store app) |
| `appSource.packageFamilyName` | Windows Store package family name for rg-adguard resolution |
| `appSource.ring` | Store ring: `Retail`, `Preview`, or `Insider` |
| `skills.sources` | Ordered list of directories to merge for bundled skills (later entries override earlier ones) |
| `skills.official.owner` | GitHub owner for official skills repo (e.g. `openai`) |
| `skills.official.repo` | GitHub repo name for official skills (e.g. `skills`) |
| `skills.official.ref` | Git ref to sync from (branch, tag, or commit SHA) |
| `skills.official.destination` | Local directory for downloaded official skills |
| `packaging.outputDir` | Output directory for build artifacts |
| `packaging.portableZip` | Generate portable ZIP archive |
| `packaging.setupExe` | Generate Inno Setup installer EXE |
| `packaging.skillArchive` | Generate a separate skills ZIP |
| `packaging.sourceExportArchive` | Generate a ZIP of the extracted Store app source |
| `github.runner` | GitHub Actions runner label for CI |

#### Runtime Config — `skill-installer.env`

Users of the offline package can configure runtime behavior via a `skill-installer.env` file. Copy `skill-installer.env.example` (bundled in the package) and edit as needed.

**Search order** (first found wins):

1. `<Installation Dir>\skill-installer.env` — recommended (alongside the `.cmd` launchers)
2. `%USERPROFILE%\.codex\skill-installer.env` — user-level config

**Rules**: lines starting with `#` are comments; system environment variables always take precedence over file values; no need to escape backslashes in paths.

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_GITHUB_BASE` | `https://github.com` | GitHub web URL base. Set for mirrors or GitHub Enterprise. |
| `CODEX_GITHUB_API_BASE` | `https://api.github.com` | GitHub REST API base. For GHE: `https://<host>/api/v3` |
| `CODEX_CODELOAD_BASE` | Auto-derived from `CODEX_GITHUB_BASE` | Zip download base. Only set if the mirror's codeload URL differs from GitHub's subdomain layout. |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | GitHub personal access token for private repos or to bypass API rate limits |
| `CODEX_SKILL_SOURCE_DIR` | Auto-set by bootstrap | Local directory for skills. Skips GitHub entirely when set. Auto-configured to the bundled seed directory by the offline package bootstrap. |
| `CODEX_HOME` | `~/.codex` | Codex home directory where skills are installed |

**Example — GitHub Enterprise:**

```env
CODEX_GITHUB_BASE=https://ghe.company.local
CODEX_GITHUB_API_BASE=https://ghe.company.local/api/v3
GITHUB_TOKEN=ghp_yourtoken
```

**Example — Fully offline (no GitHub access):**

```env
CODEX_SKILL_SOURCE_DIR=\\company-nas\shared-skills
```

#### Script Parameters

**`build-offline-package.ps1`** (main build script):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-ConfigPath` | `config/offline-package.json` | Path to the build configuration file |
| `-SkipInstaller` | off | Skip Inno Setup installer generation |
| `-RequireInstaller` | off | Fail if Inno Setup is not found |
| `-MetadataOutputPath` | — | Write build metadata JSON to a custom path |

**`bootstrap-codex-skills.ps1`** (launch-time setup):

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-InstallRoot` | `$PSScriptRoot` | Root path of the offline package installation |
| `-CodexHome` | `$CODEX_HOME` or `~/.codex` | Override the Codex home directory |
| `-NoLaunch` | off | Sync skills only, do not launch Codex |

**`sync-official-skills.ps1`**:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-ConfigPath` | `config/offline-package.json` | Path to config file with `skills.official` section |
| `-Destination` | from config | Override the download destination |

**`sync-local-skills.ps1`**:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-CodexHome` | `~/.codex` | Source Codex home directory |
| `-Destination` | `vendor/skills` | Where to copy the synced skills |

**`bundle-skills.ps1`**:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-SourceRoots` | `@('vendor/skills-official', 'vendor/skills')` | Directories to merge (later overrides earlier) |
| `-Destination` | `build/seed/codex-home/skills` | Output directory for bundled skills |
| `-ManifestPath` | `build/seed/skills-manifest.json` | Path for the generated manifest JSON |
| `-PackageVersion` | `dev` | Version string embedded in the manifest |

### Architecture

#### App Source

Config file: `config/offline-package.json`

Current defaults:

- `appSource.mode`: `rg_adguard`
- `appSource.packageFamilyName`: `OpenAI.Codex_2p2nqsd0c76g0`
- `appSource.ring`: `Retail`

Build flow:

1. `scripts/resolve-store-bundle-url.mjs` opens `store.rg-adguard.net` via Playwright
2. Resolves `OpenAI.Codex_2p2nqsd0c76g0` by `PackageFamilyName`
3. Obtains a temporary Microsoft CDN download link
4. `scripts/import-store-bundle-from-url.ps1` downloads and extracts the `.msix/.appx/.bundle`
5. Extracts the `app` directory and enters the unified packaging flow

#### Skills Source

Two layers of skills sources at build time:

- **Official**: `scripts/sync-official-skills.ps1` downloads a zipball from `openai/skills` at build time, extracting `.system` and `.curated`
- **Custom**: `vendor/skills` in the repository

Merge order:

1. Place official skills into the temp directory `build/work/skills-official`
2. Overlay `vendor/skills` on top

If a skill with the same name exists in `vendor/skills`, it overrides the official version.

#### Skills Packaging Behavior

- `scripts/build-offline-package.ps1` automatically runs `scripts/sync-official-skills.ps1` before each build
- `scripts/bundle-skills.ps1` merges `build/work/skills-official` and `vendor/skills` into `seed/codex-home/skills`
- `scripts/bootstrap-codex-skills.ps1` syncs bundled skills to `~/.codex/skills` on the target machine at first launch
- Does not overwrite the user's existing `config.toml`, credentials, or other personal data

### GitHub Actions

#### 1. Offline Build Workflow

File: `.github/workflows/build-offline-package.yml`

Features:

- Runs on `windows-latest`
- Auto-installs Node.js and Playwright Chromium
- Auto-resolves the Store download link
- Fetches official skills live at build time
- Auto-generates `portable.zip`, `setup.exe`, `skills.zip`, `store-export.zip`
- Includes "skip if version unchanged" logic: skips build and release if the same release tag already exists

#### 2. Build Failure Retry / Alert Workflow

File: `.github/workflows/build-offline-package-monitor.yml`

Features:

- Automatically retries the failed job when the main build fails
- Retries up to 3 times
- If still failing, automatically creates or updates a GitHub Issue as an alert
- Automatically closes the alert Issue when a subsequent successful run is detected

### Local Commands

#### Sync local custom skills

```powershell
./scripts/sync-local-skills.ps1
```

Syncs your local `~/.codex/skills` to `vendor/skills` by default.

#### Test official skills fetch only

```powershell
./scripts/sync-official-skills.ps1
```

Fetches official `openai/skills` to `build/work/skills-official` based on the config in `config/offline-package.json`.

#### Test Store link resolution only

```powershell
node ./scripts/resolve-store-bundle-url.mjs --package-family-name OpenAI.Codex_2p2nqsd0c76g0
```

#### Build the offline package

```powershell
pwsh -NoProfile -File ./scripts/build-offline-package.ps1 -ConfigPath config/offline-package.json
```

#### Skip installer, generate zip only

```powershell
pwsh -NoProfile -File ./scripts/build-offline-package.ps1 -ConfigPath config/offline-package.json -SkipInstaller
```

### Artifacts

Default output directory: `dist/offline/<release-name>/`

Includes:

- `portable.zip`
- `setup.exe` (when Inno Setup is available)
- `skills.zip`
- `store-export.zip`
- `SHA256SUMS.txt`

### Verified Results

Locally verified:

- Successfully resolved the `OpenAI.Codex` Store download link via `rg-adguard`
- Successfully fetched official `openai/skills` before packaging
- Successfully merged official skills with `vendor/skills`
- Successfully generated the offline package directory `dist/offline/codex-offline-26.305.950.0`
- `app/resources/codex.exe --version` runs correctly after extraction

### Directory Reference

- `config/offline-package.json` — Offline build configuration
- `scripts/build-offline-package.ps1` — Main build orchestration script
- `scripts/resolve-store-bundle-url.mjs` — Unofficial Store download link resolver
- `scripts/import-store-bundle-from-url.ps1` — Download and extract Store packages
- `scripts/bundle-skills.ps1` — Merge and organize multiple skills sources
- `scripts/sync-local-skills.ps1` — Sync local custom skills to `vendor/skills`
- `scripts/sync-official-skills.ps1` — Fetch official `openai/skills` at build time
- `scripts/bootstrap-codex-skills.ps1` — Sync bundled skills to user directory before launch
- `vendor/skills` — Local custom skills snapshot
- `.github/workflows/build-offline-package.yml` — Offline build and release
- `.github/workflows/build-offline-package-monitor.yml` — Failure retry and alerting

### Risks & Limitations

This approach prioritizes "works for now" over being an official offline distribution channel. Key risks:

- `store.rg-adguard.net` is a third-party service that may go down, rate-limit, or change its page structure
- Microsoft CDN returns temporary links; each build must re-resolve them
- Official `openai/skills` are fetched live at build time; if the upstream repo structure changes, the sync script may need updates
- Changes to the internal structure of Store packages may require updates to the extraction logic

### Design Principles

- **KISS**: App packages, official skills, and local skills are handled independently, then unified during packaging
- **YAGNI**: Only implements what's needed for offline distribution — live fetch, merge, and release — no extra snapshot caching
- **DRY**: App resolution, skills sync, skills merge, and installer generation each have a single responsibility
- **SOLID**: Clear script boundaries; switching the Store source or skills source has minimal impact

---

<a id="中文"></a>

## 中文

这个仓库用于把 `OpenAI.Codex` 的 Windows Store 包重新封装为离线绿色版和安装包，并把需要的 skills 一起打进去。

当前实现包含两条输入链路：

- 应用包：通过 `store.rg-adguard.net` 解析 Microsoft Store 分发链接，下载 `OpenAI.Codex` 的 Store 包后再解包封装
- skills：打包时实时从官方 `openai/skills` 拉取，再叠加仓库里的本地自定义快照 `vendor/skills`

这意味着 GitHub Actions 服务器不需要依赖你本机的 `~/.codex/skills`，也不需要仓库长期缓存官方 skills 快照。

### 配置说明

项目提供三个层面的配置能力：**构建配置文件**、**运行时环境变量**、**脚本参数**。

#### 构建配置 — `config/offline-package.json`

这是主构建配置文件，所有字段及其用途：

```json
{
  "appName": "Codex",
  "packageId": "OpenAI.Codex",
  "releaseNamePrefix": "codex-offline",
  "installDirName": "Codex Offline",
  "appSource": {
    "mode": "rg_adguard",
    "packageFamilyName": "OpenAI.Codex_2p2nqsd0c76g0",
    "ring": "Retail"
  },
  "skills": {
    "sources": ["build/work/skills-official", "vendor/skills"],
    "official": {
      "owner": "openai",
      "repo": "skills",
      "ref": "main",
      "destination": "build/work/skills-official"
    }
  },
  "packaging": {
    "outputDir": "dist/offline",
    "portableZip": true,
    "setupExe": true,
    "skillArchive": true,
    "sourceExportArchive": true
  },
  "github": {
    "runner": "windows-latest"
  }
}
```

| 字段 | 说明 |
|------|------|
| `appName` | 显示名称，用于安装器和发布说明 |
| `packageId` | Windows Store 包标识符 |
| `releaseNamePrefix` | 发布目录名前缀（如 `codex-offline-1.2.3`） |
| `installDirName` | 安装器中 `Program Files` 下的目录名 |
| `appSource.mode` | 来源模式：`rg_adguard`（通过 rg-adguard 下载）或 `installed_store`（从本地已安装的 Store 应用提取） |
| `appSource.packageFamilyName` | rg-adguard 解析时使用的 Windows Store 包族名 |
| `appSource.ring` | Store 通道：`Retail`、`Preview` 或 `Insider` |
| `skills.sources` | 有序的 skills 目录列表，合并时后面的覆盖前面的 |
| `skills.official.owner` | 官方 skills 仓库的 GitHub owner（如 `openai`） |
| `skills.official.repo` | 官方 skills 仓库名（如 `skills`） |
| `skills.official.ref` | 要同步的 Git ref（分支、标签或 commit SHA） |
| `skills.official.destination` | 官方 skills 下载到本地的目录 |
| `packaging.outputDir` | 构建产物输出目录 |
| `packaging.portableZip` | 是否生成便携 ZIP |
| `packaging.setupExe` | 是否生成 Inno Setup 安装器 EXE |
| `packaging.skillArchive` | 是否单独生成 skills ZIP |
| `packaging.sourceExportArchive` | 是否生成 Store 应用源码导出 ZIP |
| `github.runner` | CI 使用的 GitHub Actions runner 标签 |

#### 运行时配置 — `skill-installer.env`

离线包用户可以通过 `skill-installer.env` 文件配置运行时行为。将包内附带的 `skill-installer.env.example` 复制一份并编辑即可。

**查找顺序**（先找到先生效）：

1. `<安装目录>\skill-installer.env` — 推荐（与 `.cmd` 文件并排）
2. `%USERPROFILE%\.codex\skill-installer.env` — 用户级配置

**规则**：以 `#` 开头的行为注释；系统环境变量优先级高于文件中的值；路径中无需转义反斜杠。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_GITHUB_BASE` | `https://github.com` | GitHub 网页根地址，用于镜像或 GitHub Enterprise |
| `CODEX_GITHUB_API_BASE` | `https://api.github.com` | GitHub REST API 根地址。GHE 通常为 `https://<host>/api/v3` |
| `CODEX_CODELOAD_BASE` | 自动从 `CODEX_GITHUB_BASE` 推导 | zip 下载根地址，仅在镜像的 codeload 地址与 GitHub 子域名规律不同时设置 |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | GitHub 个人访问令牌，用于私有仓库或绕过 API 速率限制 |
| `CODEX_SKILL_SOURCE_DIR` | 由 bootstrap 自动设置 | 本地 skills 目录，设置后跳过 GitHub。离线包启动时自动配置为内置 seed 目录 |
| `CODEX_HOME` | `~/.codex` | Codex 主目录，skills 安装位置 |

**示例 — GitHub Enterprise：**

```env
CODEX_GITHUB_BASE=https://ghe.company.local
CODEX_GITHUB_API_BASE=https://ghe.company.local/api/v3
GITHUB_TOKEN=ghp_yourtoken
```

**示例 — 完全离线（无 GitHub 访问）：**

```env
CODEX_SKILL_SOURCE_DIR=\\company-nas\shared-skills
```

#### 脚本参数

**`build-offline-package.ps1`**（主构建脚本）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-ConfigPath` | `config/offline-package.json` | 构建配置文件路径 |
| `-SkipInstaller` | 关 | 跳过 Inno Setup 安装器生成 |
| `-RequireInstaller` | 关 | 找不到 Inno Setup 时报错 |
| `-MetadataOutputPath` | — | 将构建元数据 JSON 写入自定义路径 |

**`bootstrap-codex-skills.ps1`**（启动时设置）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-InstallRoot` | `$PSScriptRoot` | 离线包安装根目录 |
| `-CodexHome` | `$CODEX_HOME` 或 `~/.codex` | 覆盖 Codex 主目录 |
| `-NoLaunch` | 关 | 只同步 skills，不启动 Codex |

**`sync-official-skills.ps1`**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-ConfigPath` | `config/offline-package.json` | 配置文件路径（需包含 `skills.official` 部分） |
| `-Destination` | 来自配置文件 | 覆盖下载目标目录 |

**`sync-local-skills.ps1`**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-CodexHome` | `~/.codex` | 源 Codex 主目录 |
| `-Destination` | `vendor/skills` | skills 同步目标目录 |

**`bundle-skills.ps1`**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-SourceRoots` | `@('vendor/skills-official', 'vendor/skills')` | 要合并的目录列表（后面覆盖前面） |
| `-Destination` | `build/seed/codex-home/skills` | 合并后的 skills 输出目录 |
| `-ManifestPath` | `build/seed/skills-manifest.json` | 生成的清单 JSON 路径 |
| `-PackageVersion` | `dev` | 写入清单的版本字符串 |

### 当前结构

#### 应用来源

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

#### skills 来源

打包时会有两层 skills 来源：

- 官方来源：`scripts/sync-official-skills.ps1` 在构建时实时从 `openai/skills` 下载 zipball，并解出 `.system` 和 `.curated`
- 自定义来源：仓库里的 `vendor/skills`

合并顺序：

1. 先放官方 skills 到临时目录 `build/work/skills-official`
2. 再把 `vendor/skills` 覆盖进去

因此如果 `vendor/skills` 里存在同名 skill，会覆盖官方内容。

#### skills 打包行为

- `scripts/build-offline-package.ps1` 会在每次打包前自动执行 `scripts/sync-official-skills.ps1`
- `scripts/bundle-skills.ps1` 会把 `build/work/skills-official` 和 `vendor/skills` 合并到 `seed/codex-home/skills`
- `scripts/bootstrap-codex-skills.ps1` 会在用户首次启动离线包时，把内置 skills 同步到目标机器的 `~/.codex/skills`
- 不覆盖用户已有的 `config.toml`、认证信息和其他个人数据

### GitHub Actions

#### 1. 离线构建工作流

文件：`.github/workflows/build-offline-package.yml`

特性：

- 运行环境：`windows-latest`
- 自动安装 Node.js 和 Playwright Chromium
- 自动解析 Store 下载链接
- 打包时实时拉取官方 skills
- 自动生成 `portable.zip`、`setup.exe`、`skills.zip`、`store-export.zip`
- 已加“版本不变时跳过发布”逻辑：如果同一个 release tag 已存在，则跳过构建和发布

#### 2. 构建失败重试/告警工作流

文件：`.github/workflows/build-offline-package-monitor.yml`

特性：

- 主构建失败时自动重试失败 job
- 最多重试到第 3 次
- 仍失败时自动创建或更新 GitHub Issue 告警
- 后续有成功运行时自动关闭这个告警 Issue

### 本地命令

#### 同步本地自定义 skills

```powershell
./scripts/sync-local-skills.ps1
```

默认会把本机 `~/.codex/skills` 同步到 `vendor/skills`。

#### 只测试官方 skills 拉取

```powershell
./scripts/sync-official-skills.ps1
```

默认会按 `config/offline-package.json` 中的配置，把官方 `openai/skills` 拉到临时目录 `build/work/skills-official`。

#### 只测试 Store 下载链接解析

```powershell
node ./scripts/resolve-store-bundle-url.mjs --package-family-name OpenAI.Codex_2p2nqsd0c76g0
```

#### 构建离线包

```powershell
pwsh -NoProfile -File ./scripts/build-offline-package.ps1 -ConfigPath config/offline-package.json
```

#### 跳过安装器，只生成 zip

```powershell
pwsh -NoProfile -File ./scripts/build-offline-package.ps1 -ConfigPath config/offline-package.json -SkipInstaller
```

### 产物

默认输出到：`dist/offline/<release-name>/`

默认包含：

- `portable.zip`
- `setup.exe`（机器有 Inno Setup 时）
- `skills.zip`
- `store-export.zip`
- `SHA256SUMS.txt`

### 已验证结果

本地已经验证通过的事项：

- 成功通过 `rg-adguard` 解析 `OpenAI.Codex` 的 Store 下载链接
- 成功在打包前实时拉取官方 `openai/skills`
- 成功把官方 skills 与 `vendor/skills` 合并打包
- 成功生成离线包目录 `dist/offline/codex-offline-26.305.950.0`
- 解包后的 `app/resources/codex.exe --version` 可执行

### 目录说明

- `config/offline-package.json`：离线构建配置
- `scripts/build-offline-package.ps1`：总控打包脚本
- `scripts/resolve-store-bundle-url.mjs`：非官方 Store 下载链接解析器
- `scripts/import-store-bundle-from-url.ps1`：下载并解包 Store 包
- `scripts/bundle-skills.ps1`：合并并整理多个 skills 来源
- `scripts/sync-local-skills.ps1`：同步本机自定义 skills 到 `vendor/skills`
- `scripts/sync-official-skills.ps1`：打包时实时拉取官方 `openai/skills`
- `scripts/bootstrap-codex-skills.ps1`：启动前同步内置 skills 到用户目录
- `vendor/skills`：本地自定义 skills 快照
- `.github/workflows/build-offline-package.yml`：离线构建与发布
- `.github/workflows/build-offline-package-monitor.yml`：失败重试与告警

### 风险与边界

当前方案仍然是“临时可用优先”，不是官方离线分发链路，主要风险：

- `store.rg-adguard.net` 是第三方服务，可能失效、限流或页面结构变化
- 微软 CDN 返回的是临时链接，每次构建都必须重新解析
- 构建时实时拉官方 `openai/skills`，如果官方仓库结构变化，同步脚本可能需要调整
- Store 包内部结构变化后，解包规则也可能需要调整

### 原则说明

- KISS：应用包、官方 skills、本地 skills 分别独立处理，再统一打包
- YAGNI：只做当前离线分发所需的实时拉取、合并和发布，不额外维护官方快照缓存
- DRY：应用解析、skills 同步、skills 合并、安装器生成各自单一职责
- SOLID：脚本边界清晰，后续切换 Store 来源或 skills 来源时影响面最小
