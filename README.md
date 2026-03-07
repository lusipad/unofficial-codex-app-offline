# Codex App Offline

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

Unofficial offline / portable repackaging of the **OpenAI Codex** Windows app.  
All official skills from [`openai/skills`](https://github.com/openai/skills) are fetched at build time and bundled into the package for fully offline use.

### Quick Start

#### Option A — Portable ZIP (no install required)

1. Go to [Releases](../../releases) and download the latest `*-portable.zip`.
2. Extract anywhere.
3. Double-click **`Launch Codex Offline.vbs`**.

On first launch the bundled skills are automatically copied to `~\.codex\skills`, then Codex opens.  
No console window will appear — the app starts silently in the background.

#### Option B — Installer

1. Download the latest `*-setup.exe` from [Releases](../../releases).
2. Run the installer — no admin required (installs per-user).
3. Launch from the desktop shortcut or Start Menu.

#### Updating Skills

Double-click **`Sync Codex Skills.vbs`** to re-sync bundled skills without launching the app.  
A message box will confirm when the sync is complete.

> **Note:** Always use the provided launchers (`.vbs` or `.cmd` files). Do not run `Codex.exe` directly — it will skip skill syncing and may not work correctly on first use.

### Package Contents

```
<root>/
├── Launch Codex Offline.vbs        ← double-click to start
├── Sync Codex Skills.vbs           ← re-sync skills only
└── README.md                       ← this document
    (hidden files)
    ├── _internal/                  ← app payload, skills, bootstrap script
    ├── Launch Codex Offline.cmd    ← command-line launcher (alternative)
    └── Sync Codex Skills.cmd       ← command-line sync (alternative)
```

### Configuration

No configuration is needed for standard offline use — everything works out of the box.

For advanced scenarios, copy `_internal\skill-installer.env.example` to `skill-installer.env` in the package root directory and uncomment the variables you need.

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_HOME` | `~/.codex` | Codex home directory (changes where skills are installed) |
| `CODEX_SKILL_SOURCE_DIR` | auto-set by bootstrap | Local skills directory; skips GitHub when set |
| `CODEX_GITHUB_BASE` | `https://github.com` | GitHub web URL (set for mirrors / GHE) |
| `CODEX_GITHUB_API_BASE` | `https://api.github.com` | GitHub REST API URL |
| `CODEX_CODELOAD_BASE` | derived from `CODEX_GITHUB_BASE` | Zip download URL (only if mirror layout differs) |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | Personal access token for private repos or rate-limit bypass |

Config file search order (first found wins):

1. `<install dir>\skill-installer.env` ← recommended
2. `%USERPROFILE%\.codex\skill-installer.env`

System environment variables always take precedence over file values.

<details>
<summary>Example — GitHub Enterprise</summary>

```env
CODEX_GITHUB_BASE=https://ghe.company.local
CODEX_GITHUB_API_BASE=https://ghe.company.local/api/v3
GITHUB_TOKEN=ghp_yourtoken
```
</details>

<details>
<summary>Example — Fully offline (no GitHub access)</summary>

```env
CODEX_SKILL_SOURCE_DIR=\\company-nas\shared-skills
```
</details>

---

### Building from Source

> The following sections are for developers who want to build the offline package themselves.

#### Prerequisites

- Windows 10/11 x64
- Node.js ≥ 24
- PowerShell 7+
- (Optional) [Inno Setup 6](https://jrsoftware.org/isinfo.php) for generating `setup.exe`

#### Build

```powershell
npm ci
npx playwright install chromium
pwsh -NoProfile -File ./scripts/build-offline-package.ps1
```

Artifacts are written to `dist/offline/<release-name>/`.

#### Build Options

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-ConfigPath` | `config/offline-package.json` | Build configuration file |
| `-SkipInstaller` | off | Skip Inno Setup installer |
| `-RequireInstaller` | off | Fail if Inno Setup is missing |
| `-MetadataOutputPath` | — | Write build metadata JSON to a custom path |

#### Build Config — `config/offline-package.json`

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
    "sources": ["build/work/skills-official"],
    "official": {
      "owner": "openai", "repo": "skills", "ref": "main",
      "destination": "build/work/skills-official"
    }
  },
  "packaging": {
    "outputDir": "dist/offline",
    "portableZip": true,
    "setupExe": true,
    "skillArchive": true,
    "sourceExportArchive": true
  }
}
```

<details>
<summary>Field reference</summary>

| Field | Description |
|-------|-------------|
| `appName` | Display name for installer and release notes |
| `packageId` | Windows Store package identifier |
| `releaseNamePrefix` | Release directory name prefix |
| `installDirName` | Directory name under Program Files |
| `appSource.mode` | `rg_adguard` (download) or `installed_store` (extract local) |
| `appSource.packageFamilyName` | Store package family name |
| `appSource.ring` | `Retail` / `Preview` / `Insider` |
| `skills.sources` | Directories to merge into the bundled skills |
| `skills.official.*` | GitHub repo coordinates for official skills |
| `packaging.outputDir` | Output directory |
| `packaging.portableZip` | Generate portable ZIP |
| `packaging.setupExe` | Generate Inno Setup EXE |
| `packaging.skillArchive` | Generate separate skills ZIP |
| `packaging.sourceExportArchive` | Generate Store app source export ZIP |

</details>

#### Other Scripts

| Script | Purpose | Key Parameters |
|--------|---------|----------------|
| `sync-official-skills.ps1` | Download official skills from GitHub | `-ConfigPath`, `-Destination` |
| `bundle-skills.ps1` | Merge skill directories + generate manifest | `-SourceRoots`, `-Destination`, `-PackageVersion` |
| `resolve-store-bundle-url.mjs` | Resolve Store download link via rg-adguard | `--package-family-name`, `--ring` |
| `import-store-bundle-from-url.ps1` | Download & extract Store bundle | `-BundleUrl`, `-Destination`, `-ExpectedSha1` |

#### How the Build Works

1. Playwright opens `store.rg-adguard.net` and resolves a temporary Microsoft CDN link for the `OpenAI.Codex` Store package.
2. The `.msixbundle` is downloaded and the x64 app payload is extracted.
3. `app.asar` is patched so Codex runs outside the MSIX container, and the Electron asar integrity fuse is disabled.
4. Official skills are fetched from [`openai/skills`](https://github.com/openai/skills) and bundled.
5. Everything is staged into a portable directory, then zipped / compiled into an installer.

#### CI / CD

| Workflow | File | Purpose |
|----------|------|---------|
| Build & Release | `build-offline-package.yml` | Daily schedule + push trigger; builds, uploads artifacts, publishes GitHub Release (skips if version unchanged) |
| Monitor | `build-offline-package-monitor.yml` | Auto-retries failed builds (up to 3×); opens/closes GitHub Issue alerts |

### Risks & Limitations

- `store.rg-adguard.net` is a third-party service — may go down, rate-limit, or change its page structure.
- Microsoft CDN links are temporary; each build re-resolves them.
- If the official `openai/skills` repo structure changes, the sync script may need updates.
- Store package internal structure changes may break extraction logic.

### Directory Reference

| Path | Purpose |
|------|---------|
| `config/offline-package.json` | Build configuration |
| `scripts/build-offline-package.ps1` | Main build script |
| `scripts/resolve-store-bundle-url.mjs` | Store link resolver (Playwright) |
| `scripts/import-store-bundle-from-url.ps1` | Download & extract Store packages |
| `scripts/bundle-skills.ps1` | Merge multiple skills sources |
| `scripts/sync-official-skills.ps1` | Fetch official skills from GitHub |
| `scripts/bootstrap-codex-skills.ps1` | Launch-time skill sync |
| `scripts/patch-app-asar.mjs` | Asar patching + Electron fuse flip |
| `installer/CodexOffline.iss.tpl` | Inno Setup template |

<a id="中文"></a>

## 中文

非官方的 **OpenAI Codex** Windows 应用离线/便携版重打包。
构建时从 [`openai/skills`](https://github.com/openai/skills) 拉取全部官方 skills 并打包，支持完全离线使用。

### 快速开始

#### 方式 A — 便携 ZIP（无需安装）

1. 前往 [Releases](../../releases) 下载最新的 `*-portable.zip`。
2. 解压到任意目录。
3. 双击 **`Launch Codex Offline.vbs`**。

首次启动时，内置 skills 会自动复制到 `~\.codex\skills`，然后打开 Codex。
不会弹出任何控制台窗口，应用在后台静默启动。

#### 方式 B — 安装器

1. 从 [Releases](../../releases) 下载最新的 `*-setup.exe`。
2. 运行安装器 — 无需管理员权限（安装到当前用户目录）。
3. 从桌面快捷方式或开始菜单启动。

#### 更新 Skills

双击 **`Sync Codex Skills.vbs`** 即可重新同步内置 skills，不会启动应用。
同步完成后会弹出提示框确认。

> **注意：** 请始终使用提供的启动器（`.vbs` 或 `.cmd` 文件）。不要直接运行 `Codex.exe` — 这样会跳过 skill 同步，首次使用时可能无法正常工作。

### 包内结构

```
<根目录>/
├── Launch Codex Offline.vbs        ← 双击启动
├── Sync Codex Skills.vbs           ← 仅同步 skills
└── README.md                       ← 本文档
    （隐藏文件）
    ├── _internal/                  ← 应用载荷、skills、引导脚本
    ├── Launch Codex Offline.cmd    ← 命令行启动器（备选）
    └── Sync Codex Skills.cmd       ← 命令行同步（备选）
```

### 配置说明

标准离线使用**无需任何配置**，开箱即用。

如需高级配置，将 `_internal\skill-installer.env.example` 复制为包根目录下的 `skill-installer.env`，取消注释所需变量即可。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CODEX_HOME` | `~/.codex` | Codex 主目录（改变 skills 安装位置） |
| `CODEX_SKILL_SOURCE_DIR` | 由 bootstrap 自动设置 | 本地 skills 目录；设置后跳过 GitHub |
| `CODEX_GITHUB_BASE` | `https://github.com` | GitHub 网页根地址（用于镜像 / GHE） |
| `CODEX_GITHUB_API_BASE` | `https://api.github.com` | GitHub REST API 地址 |
| `CODEX_CODELOAD_BASE` | 自动从 `CODEX_GITHUB_BASE` 推导 | zip 下载地址（仅在镜像布局不同时设置） |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | 个人访问令牌，用于私有仓库或绕过速率限制 |

配置文件查找顺序（先找到先生效）：

1. `<安装目录>\skill-installer.env` ← 推荐
2. `%USERPROFILE%\.codex\skill-installer.env`

系统环境变量优先级始终高于文件中的值。

<details>
<summary>示例 — GitHub Enterprise</summary>

```env
CODEX_GITHUB_BASE=https://ghe.company.local
CODEX_GITHUB_API_BASE=https://ghe.company.local/api/v3
GITHUB_TOKEN=ghp_yourtoken
```
</details>

<details>
<summary>示例 — 完全离线（无 GitHub 访问）</summary>

```env
CODEX_SKILL_SOURCE_DIR=\\company-nas\shared-skills
```
</details>

---

### 从源码构建

> 以下内容面向需要自行构建离线包的开发者。

#### 前置条件

- Windows 10/11 x64
- Node.js ≥ 24
- PowerShell 7+
- （可选）[Inno Setup 6](https://jrsoftware.org/isinfo.php)，用于生成 `setup.exe`

#### 构建

```powershell
npm ci
npx playwright install chromium
pwsh -NoProfile -File ./scripts/build-offline-package.ps1
```

产物输出到 `dist/offline/<release-name>/`。

#### 构建选项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-ConfigPath` | `config/offline-package.json` | 构建配置文件 |
| `-SkipInstaller` | 关 | 跳过 Inno Setup 安装器 |
| `-RequireInstaller` | 关 | 找不到 Inno Setup 时报错 |
| `-MetadataOutputPath` | — | 将构建元数据 JSON 写入自定义路径 |

#### 构建配置 — `config/offline-package.json`

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
    "sources": ["build/work/skills-official"],
    "official": {
      "owner": "openai", "repo": "skills", "ref": "main",
      "destination": "build/work/skills-official"
    }
  },
  "packaging": {
    "outputDir": "dist/offline",
    "portableZip": true,
    "setupExe": true,
    "skillArchive": true,
    "sourceExportArchive": true
  }
}
```

<details>
<summary>字段说明</summary>

| 字段 | 说明 |
|------|------|
| `appName` | 显示名称，用于安装器和发布说明 |
| `packageId` | Windows Store 包标识符 |
| `releaseNamePrefix` | 发布目录名前缀 |
| `installDirName` | Program Files 下的目录名 |
| `appSource.mode` | `rg_adguard`（下载）或 `installed_store`（提取本地） |
| `appSource.packageFamilyName` | Store 包族名 |
| `appSource.ring` | `Retail` / `Preview` / `Insider` |
| `skills.sources` | 合并到包内的 skills 目录列表 |
| `skills.official.*` | 官方 skills 的 GitHub 仓库坐标 |
| `packaging.outputDir` | 输出目录 |
| `packaging.portableZip` | 生成便携 ZIP |
| `packaging.setupExe` | 生成 Inno Setup EXE |
| `packaging.skillArchive` | 单独生成 skills ZIP |
| `packaging.sourceExportArchive` | 生成 Store 应用源码导出 ZIP |

</details>

#### 其他脚本

| 脚本 | 用途 | 主要参数 |
|------|------|----------|
| `sync-official-skills.ps1` | 从 GitHub 拉取官方 skills | `-ConfigPath`、`-Destination` |
| `bundle-skills.ps1` | 合并 skills 目录 + 生成清单 | `-SourceRoots`、`-Destination`、`-PackageVersion` |
| `resolve-store-bundle-url.mjs` | 通过 rg-adguard 解析 Store 下载链接 | `--package-family-name`、`--ring` |
| `import-store-bundle-from-url.ps1` | 下载并解包 Store 包 | `-BundleUrl`、`-Destination`、`-ExpectedSha1` |

#### 构建流程

1. Playwright 打开 `store.rg-adguard.net`，解析 `OpenAI.Codex` Store 包的微软 CDN 临时下载链接。
2. 下载 `.msixbundle` 并提取 x64 应用载荷。
3. 补丁 `app.asar` 使 Codex 可在 MSIX 容器外运行，并关闭 Electron asar 完整性校验。
4. 从 [`openai/skills`](https://github.com/openai/skills) 拉取全部官方 skills 并打包。
5. 所有内容 stage 到便携目录，然后打包 ZIP / 编译安装器。

#### CI / CD

| 工作流 | 文件 | 用途 |
|--------|------|------|
| 构建与发布 | `build-offline-package.yml` | 每日定时 + push 触发；构建、上传产物、发布 GitHub Release（版本不变时跳过） |
| 监控 | `build-offline-package-monitor.yml` | 自动重试失败构建（最多 3 次）；打开/关闭 GitHub Issue 告警 |

### 风险与边界

- `store.rg-adguard.net` 是第三方服务，可能失效、限流或页面结构变化。
- 微软 CDN 返回的是临时链接，每次构建都必须重新解析。
- 构建时实时拉取官方 `openai/skills`，如果官方仓库结构变化，同步脚本可能需要调整。
- Store 包内部结构变化后，解包规则也可能需要调整。

### 目录说明

| 路径 | 用途 |
|------|------|
| `config/offline-package.json` | 构建配置 |
| `scripts/build-offline-package.ps1` | 主构建脚本 |
| `scripts/resolve-store-bundle-url.mjs` | Store 链接解析器（Playwright） |
| `scripts/import-store-bundle-from-url.ps1` | 下载并解包 Store 包 |
| `scripts/bundle-skills.ps1` | 合并多个 skills 来源 |
| `scripts/sync-official-skills.ps1` | 从 GitHub 拉取官方 skills |
| `scripts/bootstrap-codex-skills.ps1` | 启动时 skills 同步 |
| `scripts/patch-app-asar.mjs` | Asar 补丁 + Electron fuse 翻转 |
| `installer/CodexOffline.iss.tpl` | Inno Setup 模板 |
