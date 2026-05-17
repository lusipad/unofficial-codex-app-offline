# Codex App Offline

[English](#english) | [中文](#中文)

---

<a id="english"></a>

## English

Unofficial offline / portable repackaging of the **OpenAI Codex** Windows app, plus a **cross-platform Web Gateway** that runs on Windows, Linux, and macOS using the Codex CLI.  
Official skills from [`openai/skills`](https://github.com/openai/skills) are fetched at build time as an offline seed, but first-time setup installs only a small offline-friendly default profile. Extra skills stay inside the package and can be synced manually when needed.

### What Changed In This Offline Build

- Bundles the official `openai/skills` repository as a local seed, while default setup installs only the configured offline profile instead of auto-syncing every curated skill.
  Extra bundled skills remain available under `_internal\seed` and can be synced from `_internal\tools` if you really want the full set.
- Bundles the Codex Chrome plugin assets already shipped with the app, plus an offline copy of the matching Chrome browser extension under `_internal\chrome-extension`.
  On stock Google Chrome, the supported `@chrome` path is to manually load `_internal\chrome-extension\unpacked` once in `chrome://extensions`, then use the installed extension normally after restarting Chrome.
- Does not download or pre-enable every official marketplace plugin. The offline package keeps the app's bundled runtime plugins, adds local copies of the Documents, Spreadsheets, and Presentations plugins, keeps the Plugins page reachable in API-key/offline sessions, and adds the Chrome extension assets needed for `@chrome`.
  The Office artifact plugins can be discovered and installed without the online marketplace, but a fresh fully offline machine still needs the separate Codex primary runtime cache pre-seeded before DOCX/XLSX/PPTX generation.
  Plugins that require a ChatGPT account, online marketplace install flow, or third-party OAuth still need those online services.
- Adds a one-time interactive guided setup:
  `Setup Codex.cmd` asks step by step whether to sync the default offline skills profile, register the bundled Chrome native host, open Chrome's extension page, and launch Codex.
  After setup, use `Codex.cmd` for daily launches; it starts `_internal\app\Codex.exe` by relative path.
- Adds a cross-platform local web entrypoint (Windows / Linux / macOS):
  The web gateway serves the bundled Codex renderer in your browser and bridges it to a local app-server backend.
  On Windows, the backend can be the packaged desktop binary or the Codex CLI. On Linux and macOS, the Codex CLI provides the backend.
  The standalone **`-web.zip`** release artifact contains just the gateway + web UI and works on all three platforms with Node.js 18+ and `@openai/codex` CLI.
  The web gateway is localhost-only by default; setting `HOST=0.0.0.0` or `HOST=::` requires `CODEX_WEB_PASSWORD`.
- Patches the Microsoft Store desktop build so it can run as a normal standalone package outside the Store install flow, including bootstrap/runtime fixes, Electron fuse adjustments, and Windows-specific path handling fixes used by the offline repack.
- Adds a compatibility patch layer for selected bundled features that may be hidden behind remote feature gates in some upstream app versions. When those gates are present, the offline build can unlock the already-bundled UI instead of silently hiding it.
  This includes keeping the Speed selector visible so users can switch between Fast and Standard modes in offline builds.
- Adds build-time verification so packaging fails when a known patch or gate bypass no longer matches the upstream app, instead of shipping a silently broken offline build.

### Quick Start

#### Option A — Portable ZIP (no install required)

1. Go to [Releases](../../releases) and download the latest `*-portable.zip`.
2. Extract anywhere.
3. Double-click **`Setup Codex.cmd`** once and follow the console prompts.
4. If you want `@chrome`, use the Chrome extensions page opened by setup to manually install `_internal\chrome-extension\unpacked` once: enable Developer mode, choose **Load unpacked**, then restart Chrome.
5. After setup, open **`Codex.cmd`** directly.
6. To try the browser-based version, install Node.js 18 or newer, then open **`Codex Web.cmd`**. Keep its console window open while using the web UI.

Setup asks before copying the default offline skills profile to `~\.codex\skills` and leaves the rest of the bundled skills inside the package.
Setup runs in a console window so Chrome/native-host errors are visible instead of hidden.

#### Option C — Web-Only (Windows / Linux / macOS)

The standalone **`-web.zip`** package works on all three platforms without the full Electron Desktop app.

**Linux users: use the guided setup script:**

```bash
wget https://raw.githubusercontent.com/lusipad/unofficial-codex-app-offline/main/scripts/setup-linux.sh
bash setup-linux.sh
```

The script walks through: system deps → download latest → install CLI → configure port/password → systemd service.

**Manual install:**

1. Install Node.js 18+ and the Codex CLI:
   ```bash
   # Windows (PowerShell as Administrator)
   winget install OpenJS.NodeJS.LTS
   npm install -g @openai/codex

   # Linux
   sudo apt install nodejs npm
   npm install -g @openai/codex

   # macOS
   brew install node
   npm install -g @openai/codex
   ```
2. Download `*-web.zip` from [Releases](../../releases) and extract.
3. **Windows:** double-click `start.bat` | **Linux/macOS:** `bash start.sh`
4. Open `http://127.0.0.1:3737`.

The gateway auto-detects the Codex CLI on PATH and uses it as the backend. First launch runs `npm install` automatically to compile native dependencies.

#### Browser Web Gateway

`Codex Web.cmd` (Windows portable package) and `start.sh` / `start.bat` (cross-platform web package) are local browser shells. They start a Node.js gateway, serve the bundled Codex renderer, and bridge it to a local app-server backend.

The backend is selected automatically:
- **Bundled binary** (`_internal/app/resources/codex.exe`) — used when present in the portable package
- **Codex CLI** (`codex` on PATH) — used on Linux/macOS, or when the bundled binary is absent on Windows

Keep the terminal window open while using the browser UI; closing it stops the gateway. Node.js 18 or newer must be available on `PATH`.

For LAN use, set an explicit bind address and password before launching:

```bash
# Windows PowerShell
$env:HOST = "0.0.0.0"
$env:PORT = "3737"
$env:CODEX_WEB_PASSWORD = "change-this-password"
& ".\Codex Web.cmd"

# Linux / macOS
HOST=0.0.0.0 PORT=3737 CODEX_WEB_PASSWORD="change-this-password" bash start.sh
```

Only use LAN mode on a trusted network or VPN. The browser UI controls files and processes on the machine that runs the gateway, so do not expose it directly to the public internet.

#### Option B — Installer

1. Download the latest `*-setup.exe` from [Releases](../../releases).
2. Run the installer — no admin required (installs per-user).
3. Follow the post-install **Setup Codex** prompts, then launch **Codex** from the desktop shortcut or Start Menu.

#### Updating Skills

Normal users do not need to update skills separately. Setup installs the default offline profile.

Advanced tools are under `_internal\tools`:

- `Sync Default Skills.cmd` re-syncs the default offline profile.
- `Sync All Skills.cmd` installs every bundled official skill, including online-dependent curated skills.

#### Repairing Chrome Access

Setup registers the bundled Chrome native messaging host automatically.

If Chrome does not already have the Codex extension installed, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `_internal\chrome-extension\unpacked`.
Restart Chrome after loading the extension, then try `@chrome` again.

The unpacked folder is bundled so you can install the extension manually once in Chrome. Stock Google Chrome does not reliably support the command-line unpacked-extension loading path used by developer smokes, so the supported real-user flow is: manual install once, restart Chrome, then use `@chrome` through the installed extension.

If `@chrome` appears in the composer but cannot communicate with Chrome while offline, rerun **`Setup Codex.cmd`** or use `_internal\tools\Repair Chrome Host.cmd` for diagnostics.

> **Note:** Setup is a first-run repair/bootstrap step. After it completes, launch `Codex.cmd` directly.

### Package Contents

```
<root>/
├── Codex.cmd                       ← daily relative launcher
├── Codex Web.cmd                   ← local browser gateway launcher
├── Setup Codex.cmd                 ← first-run guided setup
├── README.md                       ← this document
├── CHANGELOG.md                    ← package history
└── _internal/                      ← app payload, skills, bootstrap script
    ├── chrome-extension/           ← offline Chrome extension CRX + unpacked copy
    ├── web/                        ← Node.js web gateway runtime
    └── tools/                      ← advanced repair/sync commands
```

`Codex.cmd` starts `_internal\app\Codex.exe` by relative path, so the portable folder can be moved after extraction.
`Codex Web.cmd` starts `_internal\web\start-web.mjs` and opens `http://127.0.0.1:3737` after the gateway is healthy.

**Web-Only Package (`-web.zip`)**

```
<root>/
├── start.bat                       ← Windows launcher
├── start.sh                        ← Linux / macOS launcher
├── start-web.mjs                   ← gateway entry point
├── package.json
├── VERSION
├── gateway/dist/                   ← compiled gateway server
├── cache/official-bundle/webview/  ← pre-extracted Codex renderer
└── web-shell/                      ← login page + Electron polyfill
```

Same content across all three platforms — only the launcher script differs.

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

Web gateway variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `127.0.0.1` | Web gateway bind address |
| `PORT` | `3737` | Web gateway port |
| `CODEX_WEB_PASSWORD` | — | Required when `HOST` listens beyond localhost |
| `CODEX_WEB_WORKSPACE_ROOTS` | — | Comma-separated workspace roots exposed to the web UI |

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
- Network access to download the pinned Codex primary runtime archive configured in `config\offline-package.json`. The build extracts only the runtime plugin marketplace needed for Documents / Spreadsheets / Presentations.

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
    "crossPlatformWeb": true,
    "setupExe": true,
    "skillArchive": true,
    "sourceExportArchive": false
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
| `skills.defaultInstallProfile` | Profile installed by first-run setup |
| `skills.defaultInstallPaths` | Skill paths included in the default setup profile |
| `packaging.outputDir` | Output directory |
| `packaging.portableZip` | Generate portable ZIP |
| `packaging.crossPlatformWeb` | Generate cross-platform web-only ZIP (Windows/Linux/macOS) |
| `packaging.setupExe` | Generate Inno Setup EXE |
| `packaging.skillArchive` | Generate separate skills ZIP |
| `packaging.sourceExportArchive` | Generate Store app source export ZIP (disabled by default) |
| `packaging.chromeExtensionSourceCrx` | Optional local CRX path; when omitted, the build downloads the matching Chrome extension from Chrome Web Store |

</details>

#### Other Scripts

| Script | Purpose | Key Parameters |
|--------|---------|----------------|
| `sync-official-skills.ps1` | Download official skills from GitHub | `-ConfigPath`, `-Destination` |
| `bundle-skills.ps1` | Merge skill directories + generate manifest | `-SourceRoots`, `-Destination`, `-PackageVersion`, `-DefaultInstallPaths` |
| `resolve-store-bundle-url.mjs` | Resolve Store download link via rg-adguard | `--package-family-name`, `--ring` |
| `import-store-bundle-from-url.ps1` | Download & extract Store bundle | `-BundleUrl`, `-Destination`, `-ExpectedSha1` |
| `download-chrome-extension.mjs` | Download / unpack the matching Chrome extension | `--extension-id`, `--destination`, `--source-crx` |

#### How the Build Works

1. Playwright opens `store.rg-adguard.net` and resolves a temporary Microsoft CDN link for the `OpenAI.Codex` Store package.
2. The `.msixbundle` is downloaded and the x64 app payload is extracted.
3. `app.asar` is patched so Codex runs outside the MSIX container, and the Electron asar integrity fuse is disabled.
4. The matching Chrome browser extension CRX is downloaded and unpacked into `_internal\chrome-extension`.
5. Official skills are fetched from [`openai/skills`](https://github.com/openai/skills), bundled as a local seed, and tagged with a small default setup profile.
6. The pinned Codex primary runtime archive is downloaded, hash-verified, and extracted under the build work directory; its Documents / Spreadsheets / Presentations plugins are copied into the bundled offline marketplace so the Plugins page can offer local installs.
7. Everything is staged into a portable directory, then zipped / compiled into an installer.
8. When `crossPlatformWeb` is enabled, the web gateway and pre-extracted webview are packaged into a standalone `-web.zip` with launcher scripts for Windows, Linux, and macOS.

#### CI / CD

| Workflow | File | Purpose |
|----------|------|---------|
| Build & Release | `build-offline-package.yml` | Daily schedule + push trigger; builds, uploads artifacts, publishes GitHub Release (skips if version unchanged) |
| Monitor | `build-offline-package-monitor.yml` | Auto-retries failed builds (up to 3×); opens/closes GitHub Issue alerts |

### Desktop Notifications

Codex uses a **policy-based notification system**. If you feel notifications are not working, check the following:

| Mode | Behavior |
|------|----------|
| `off` | All desktop notifications suppressed |
| `unfocused` (default) | Notifications only appear when the Codex window is **not** in focus |
| `always` | Notifications always appear |

Additionally, notifications for the conversation you are currently viewing are suppressed.  Approval-request notifications are controlled by a separate permission toggle.

> **Tip:** If you never see notifications, make sure the system notification permission for Codex is enabled in Windows Settings → System → Notifications.

### Risks & Limitations

- `store.rg-adguard.net` is a third-party service — may go down, rate-limit, or change its page structure.
- Microsoft CDN links are temporary; each build re-resolves them.
- The Chrome browser extension can be bundled for offline loading, but Chrome still requires the user or enterprise policy to install/load browser extensions.
- `Codex Web.cmd` and the web-only packages require Node.js 18+ and `@openai/codex` CLI on `PATH`; the current packages do not bundle Node.js or the CLI runtime.
- If the official `openai/skills` repo structure changes, the sync script may need updates.
- Store package internal structure changes may break extraction logic.

### Directory Reference

| Path | Purpose |
|------|---------|
| `config/offline-package.json` | Build configuration |
| `scripts/build-offline-package.ps1` | Main build script |
| `scripts/build-cross-platform.sh` | Standalone cross-platform web package builder |
| `scripts/resolve-store-bundle-url.mjs` | Store link resolver (Playwright) |
| `scripts/import-store-bundle-from-url.ps1` | Download & extract Store packages |
| `scripts/download-chrome-extension.mjs` | Download / unpack the matching Chrome extension |
| `scripts/bundle-skills.ps1` | Merge multiple skills sources |
| `scripts/sync-official-skills.ps1` | Fetch official skills from GitHub |
| `scripts/bootstrap-codex-skills.ps1` | Default/full bundled skill sync |
| `scripts/setup-codex-offline.ps1` | First-run setup orchestration |
| `scripts/patch-app-asar.mjs` | Asar patching + Electron fuse flip |
| `web-gateway/` | Cross-platform Node.js web gateway source |
| `installer/CodexOffline.iss.tpl` | Inno Setup template |

<a id="中文"></a>

## 中文

非官方的 **OpenAI Codex** Windows 应用离线/便携版重打包，附带可在 Windows、Linux、macOS 上运行的**跨平台 Web Gateway**。
构建时从 [`openai/skills`](https://github.com/openai/skills) 拉取官方 skills 作为离线 seed，但首次 Setup 默认只安装一小组离线友好的基础 profile；其它 skills 留在包内，需要时再手动同步。

### 这个离线版做了哪些改动

- 将官方 `openai/skills` 仓库作为本地 seed 打进安装包，但默认 Setup 只安装配置好的离线 profile，不再自动同步全部 curated skills。
  其它内置 skills 仍保留在 `_internal\seed`，确实需要完整集合时可从 `_internal\tools` 手动同步。
- 将应用自带的 Codex Chrome plugin 资产打进包内，并在 `_internal\chrome-extension` 下附带匹配的 Chrome 浏览器扩展离线副本。
  在标准版 Google Chrome 上，`@chrome` 的正式支持路径是：先在 `chrome://extensions` 里手动一次性加载 `_internal\chrome-extension\unpacked`，重启 Chrome 后再按已安装扩展的方式正常使用。
- 不会下载或预启用所有官方 marketplace 插件；离线包保留应用自带 runtime 插件，增加 Documents、Spreadsheets、Presentations 插件的本地副本，在 API key/离线会话中保持 Plugins 页面可进入，并额外附带 `@chrome` 所需的 Chrome 扩展资产。
  Office artifact 插件可以在不访问在线 marketplace 的情况下被发现和安装；但一台全新的断网机器如果要真正生成 DOCX/XLSX/PPTX，还需要提前预置独立的 Codex primary runtime 缓存。
  依赖 ChatGPT 账号、在线 marketplace 安装流程或第三方 OAuth 的插件仍然需要对应在线服务。
- 增加一次性交互式引导 Setup：
  `Setup Codex.cmd` 会逐步询问是否同步默认离线 skills profile、注册包内 Chrome native host、打开 Chrome 扩展页面，以及是否启动 Codex。
  Setup 完成后，日常直接打开 `Codex.cmd`；它会用相对路径启动 `_internal\app\Codex.exe`。
- 增加跨平台本地 Web 入口（Windows / Linux / macOS）：
  Web gateway 在浏览器中提供打包后的 Codex renderer，并桥接回本地 app-server 后端。
  Windows 上可用包内 desktop 二进制或 Codex CLI 作为后端；Linux 和 macOS 使用 Codex CLI。
  独立的 **`-web.zip`** 发布产物仅包含 gateway + Web UI，三个平台通用，需要 Node.js 18+ 和 `@openai/codex` CLI。
  Web gateway 默认只监听本机；如果设置 `HOST=0.0.0.0` 或 `HOST=::`，必须同时设置 `CODEX_WEB_PASSWORD`。
- 对微软商店版桌面应用做了离线重打包所需的运行时修补，使其可以脱离商店安装流程作为普通独立包运行，包括 bootstrap/runtime 修补、Electron fuse 调整，以及 Windows 路径处理修复。
- 增加了一层兼容性 patch，用来处理上游某些版本里被远端 feature gate 隐藏、但实际上已经随包提供的功能界面；当这些 gate 在目标版本中存在时，离线版会解锁对应的已捆绑 UI，而不是静默隐藏。
  其中包括保持 Speed 选择器可见，避免离线版选择 Fast 后无法切回 Standard。
- 增加了构建期校验；如果某个已知 patch 或 gate bypass 与上游版本不再匹配，打包会直接失败，避免产出一个表面成功、实际失效的离线包。

### 快速开始

#### 方式 A — 便携 ZIP（无需安装）

1. 前往 [Releases](../../releases) 下载最新的 `*-portable.zip`。
2. 解压到任意目录。
3. 首次使用双击 **`Setup Codex.cmd`**，按控制台提示操作。
4. 如果要用 `@chrome`，在 Setup 打开的 Chrome 扩展页面里手动安装一次 `_internal\chrome-extension\unpacked`：启用开发者模式，选择 **加载已解压的扩展程序**，然后重启 Chrome。
5. Setup 完成后，日常直接打开 **`Codex.cmd`**。
6. 如果要试用浏览器版，先安装 Node.js 18 或更新版本，然后打开 **`Codex Web.cmd`**。使用 Web UI 时保持它的控制台窗口打开。

Setup 会先询问，再把默认离线 skills profile 复制到 `~\.codex\skills`，其它内置 skills 继续留在包内。
Setup 会打开控制台窗口，这样 Chrome/native-host 错误不会被隐藏。

#### 方式 C — Web-Only（Windows / Linux / macOS）

独立的 **`-web.zip`** 包可在三个平台上使用，无需完整的 Electron Desktop 应用。

**Linux 推荐使用一键引导脚本：**

```bash
wget https://raw.githubusercontent.com/lusipad/unofficial-codex-app-offline/main/scripts/setup-linux.sh
bash setup-linux.sh
```

脚本会引导完成：系统依赖 → 下载最新版 → 安装 CLI → 配置端口/密码 → systemd 服务。

**手动安装：**

1. 安装 Node.js 18+ 和 Codex CLI：
   ```bash
   # Windows（PowerShell 管理员权限）
   winget install OpenJS.NodeJS.LTS
   npm install -g @openai/codex

   # Linux
   sudo apt install nodejs npm
   npm install -g @openai/codex

   # macOS
   brew install node
   npm install -g @openai/codex
   ```
2. 从 [Releases](../../releases) 下载 `*-web.zip` 并解压。
3. **Windows:** 双击 `start.bat` | **Linux/macOS:** `bash start.sh`
4. 打开 `http://127.0.0.1:3737`。

Gateway 会自动检测 PATH 中的 Codex CLI 作为后端。首次运行会自动执行 `npm install` 编译原生依赖。

#### 浏览器 Web Gateway

`Codex Web.cmd`（Windows 便携包）和 `start.sh` / `start.bat`（跨平台 Web 包）都是本地浏览器壳。它们启动 Node.js gateway，提供打包后的 Codex renderer，并桥接回本地 app-server 后端。

后端选择优先级：
- **包内二进制**（`_internal/app/resources/codex.exe`）— 便携包中存在时优先使用
- **Codex CLI**（PATH 中的 `codex`）— Linux/macOS 默认，或 Windows 上包内二进制不存在时使用

使用浏览器 UI 时保持终端窗口打开；关闭终端就会停止 gateway。系统 `PATH` 中必须有 Node.js 18 或更新版本。

如果要在局域网访问，启动前显式设置监听地址和密码：

```bash
# Windows PowerShell
$env:HOST = "0.0.0.0"
$env:PORT = "3737"
$env:CODEX_WEB_PASSWORD = "change-this-password"
& ".\Codex Web.cmd"

# Linux / macOS
HOST=0.0.0.0 PORT=3737 CODEX_WEB_PASSWORD="change-this-password" bash start.sh
```

局域网模式只建议放在可信网络或 VPN 里使用。浏览器 UI 控制的是运行 gateway 那台机器上的文件和进程，不要直接暴露到公网。

#### 方式 B — 安装器

1. 从 [Releases](../../releases) 下载最新的 `*-setup.exe`。
2. 运行安装器 — 无需管理员权限（安装到当前用户目录）。
3. 按安装后的 **Setup Codex** 提示完成引导，然后从桌面快捷方式或开始菜单打开 **Codex**。

#### 更新 Skills

普通用户不需要单独更新 skills。Setup 默认安装离线基础 profile。

高级工具在 `_internal\tools` 下：

- `Sync Default Skills.cmd` 重新同步默认离线 profile。
- `Sync All Skills.cmd` 安装全部内置官方 skills，包括依赖联网能力的 curated skills。

#### 修复 Chrome 访问

Setup 会自动注册包内 Chrome native messaging host。

如果 Chrome 里还没有安装 Codex 扩展，打开 `chrome://extensions`，启用开发者模式，选择 **加载已解压的扩展程序**，并选择 `_internal\chrome-extension\unpacked`。
加载扩展后重启 Chrome，再尝试 `@chrome`。

包内附带这个已解压目录，是为了让你在 Chrome 里手动安装一次扩展。标准版 Google Chrome 对开发态 smoke 使用的命令行已解压扩展加载路径支持并不可靠，所以正式可用的用户路径是：手动安装一次，重启 Chrome，然后通过已安装扩展使用 `@chrome`。

如果输入框里能看到 `@chrome`，但离线时无法和 Chrome 通信，重新运行 **`Setup Codex.cmd`**，或使用 `_internal\tools\Repair Chrome Host.cmd` 查看诊断信息。

> **注意：** Setup 是首次引导/修复步骤。完成后日常直接打开 `Codex.cmd`。

### 包内结构

```
<根目录>/
├── Codex.cmd                       ← 日常相对路径启动器
├── Codex Web.cmd                   ← 本地浏览器 gateway 启动器
├── Setup Codex.cmd                 ← 首次引导式 Setup
├── README.md                       ← 本文档
├── CHANGELOG.md                    ← 包历史记录
└── _internal/                      ← 应用载荷、skills、引导脚本
    ├── chrome-extension/           ← 离线 Chrome 扩展 CRX + 已解压副本
    ├── web/                        ← Node.js Web gateway 运行时
    └── tools/                      ← 高级修复/同步命令
```

`Codex.cmd` 会用相对路径启动 `_internal\app\Codex.exe`，所以解压后的便携目录可以整体移动。
`Codex Web.cmd` 会启动 `_internal\web\start-web.mjs`，gateway 健康后打开 `http://127.0.0.1:3737`。

**Web-Only 包（`-web.zip`）**

```
<根目录>/
├── start.bat                       ← Windows 启动器
├── start.sh                        ← Linux / macOS 启动器
├── start-web.mjs                   ← gateway 入口
├── package.json
├── VERSION
├── gateway/dist/                   ← 编译后的 gateway 服务端
├── cache/official-bundle/webview/  ← 预提取的 Codex renderer
└── web-shell/                      ← 登录页 + Electron polyfill
```

三个平台同一份内容，只有启动脚本不同。

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

Web gateway 变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `127.0.0.1` | Web gateway 监听地址 |
| `PORT` | `3737` | Web gateway 端口 |
| `CODEX_WEB_PASSWORD` | — | 当 `HOST` 监听范围超出本机时必填 |
| `CODEX_WEB_WORKSPACE_ROOTS` | — | 允许暴露给 Web UI 的 workspace roots，多个路径用英文逗号分隔 |

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
- 需要联网下载 `config\offline-package.json` 中固定的 Codex primary runtime archive。构建只会提取 Documents / Spreadsheets / Presentations 所需的 runtime plugin marketplace。

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
    "crossPlatformWeb": true,
    "setupExe": true,
    "skillArchive": true,
    "sourceExportArchive": false
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
| `skills.defaultInstallProfile` | 首次 Setup 默认安装的 profile |
| `skills.defaultInstallPaths` | 默认 Setup profile 包含的 skill 路径 |
| `packaging.outputDir` | 输出目录 |
| `packaging.portableZip` | 生成便携 ZIP |
| `packaging.crossPlatformWeb` | 生成跨平台 Web-only ZIP（Windows/Linux/macOS） |
| `packaging.setupExe` | 生成 Inno Setup EXE |
| `packaging.skillArchive` | 单独生成 skills ZIP |
| `packaging.sourceExportArchive` | 生成 Store 应用源码导出 ZIP（默认关闭） |
| `packaging.chromeExtensionSourceCrx` | 可选的本地 CRX 路径；未设置时构建会从 Chrome Web Store 下载匹配的 Chrome 扩展 |

</details>

#### 其他脚本

| 脚本 | 用途 | 主要参数 |
|------|------|----------|
| `sync-official-skills.ps1` | 从 GitHub 拉取官方 skills | `-ConfigPath`、`-Destination` |
| `bundle-skills.ps1` | 合并 skills 目录 + 生成清单 | `-SourceRoots`、`-Destination`、`-PackageVersion`、`-DefaultInstallPaths` |
| `resolve-store-bundle-url.mjs` | 通过 rg-adguard 解析 Store 下载链接 | `--package-family-name`、`--ring` |
| `import-store-bundle-from-url.ps1` | 下载并解包 Store 包 | `-BundleUrl`、`-Destination`、`-ExpectedSha1` |
| `download-chrome-extension.mjs` | 下载 / 解包匹配的 Chrome 扩展 | `--extension-id`、`--destination`、`--source-crx` |

#### 构建流程

1. Playwright 打开 `store.rg-adguard.net`，解析 `OpenAI.Codex` Store 包的微软 CDN 临时下载链接。
2. 下载 `.msixbundle` 并提取 x64 应用载荷。
3. 补丁 `app.asar` 使 Codex 可在 MSIX 容器外运行，并关闭 Electron asar 完整性校验。
4. 下载匹配的 Chrome 浏览器扩展 CRX，并解包到 `_internal\chrome-extension`。
5. 从 [`openai/skills`](https://github.com/openai/skills) 拉取官方 skills，作为本地 seed 打包，并标记小型默认 Setup profile。
6. 下载固定版本的 Codex primary runtime archive，校验 hash 后解压到 build work 目录，并把其中的 Documents / Spreadsheets / Presentations 插件复制进离线 marketplace，使 Plugins 页面可以本地安装。
7. 所有内容 stage 到便携目录，然后打包 ZIP / 编译安装器。
8. 当 `crossPlatformWeb` 开启时，web gateway 和预提取的 webview 会打包进独立的 `-web.zip`，附带 Windows / Linux / macOS 三平台启动脚本。

#### CI / CD

| 工作流 | 文件 | 用途 |
|--------|------|------|
| 构建与发布 | `build-offline-package.yml` | 每日定时 + push 触发；构建、上传产物、发布 GitHub Release（版本不变时跳过） |
| 监控 | `build-offline-package-monitor.yml` | 自动重试失败构建（最多 3 次）；打开/关闭 GitHub Issue 告警 |

### 桌面通知

Codex 使用**策略性通知系统**。如果你觉得通知不工作，请检查以下设置：

| 模式 | 行为 |
|------|------|
| `off` | 抑制所有桌面通知 |
| `unfocused`（默认） | 仅在 Codex 窗口**未聚焦**时弹出通知 |
| `always` | 始终弹出通知 |

此外，当前正在查看的对话的通知也会被抑制。审批请求通知由单独的权限开关控制。

> **提示：** 如果始终看不到通知，请确认 Windows 系统设置（设置 → 系统 → 通知）中已为 Codex 启用通知权限。

### 风险与边界

- `store.rg-adguard.net` 是第三方服务，可能失效、限流或页面结构变化。
- 微软 CDN 返回的是临时链接，每次构建都必须重新解析。
- Chrome 浏览器扩展可以随包提供离线加载资产，但 Chrome 仍要求用户手动加载扩展，或由企业策略安装扩展。
- `Codex Web.cmd` 和 Web-only 包需要系统 `PATH` 中有 Node.js 18+ 和 `@openai/codex` CLI；当前安装包不内置 Node.js 和 CLI 运行时。
- 构建时实时拉取官方 `openai/skills`，如果官方仓库结构变化，同步脚本可能需要调整。
- Store 包内部结构变化后，解包规则也可能需要调整。

### 目录说明

| 路径 | 用途 |
|------|------|
| `config/offline-package.json` | 构建配置 |
| `scripts/build-offline-package.ps1` | 主构建脚本 |
| `scripts/build-cross-platform.sh` | 独立跨平台 Web 包构建脚本 |
| `scripts/resolve-store-bundle-url.mjs` | Store 链接解析器（Playwright） |
| `scripts/import-store-bundle-from-url.ps1` | 下载并解包 Store 包 |
| `scripts/download-chrome-extension.mjs` | 下载 / 解包匹配的 Chrome 扩展 |
| `scripts/bundle-skills.ps1` | 合并多个 skills 来源 |
| `scripts/sync-official-skills.ps1` | 从 GitHub 拉取官方 skills |
| `scripts/bootstrap-codex-skills.ps1` | 默认/完整内置 skills 同步 |
| `scripts/setup-codex-offline.ps1` | 首次 Setup 编排 |
| `scripts/patch-app-asar.mjs` | Asar 补丁 + Electron fuse 翻转 |
| `web-gateway/` | 跨平台 Node.js Web gateway 源码 |
| `installer/CodexOffline.iss.tpl` | Inno Setup 模板 |
