# Codex App Offline

[English](#english)

---

OpenAI Codex Windows 应用的**非官方离线便携版重打包**，附带 Windows / Linux / macOS 三平台通用的 **Web Gateway**。

构建时自动拉取 [openai/skills](https://github.com/openai/skills)，离线 seed 打包；首次 Setup 仅安装基础 profile，其余技能留在包内按需同步。

## 快速开始

### Windows 完整包

从 [Releases](../../releases) 下载 `*-portable.zip`，解压后：

1. 首次运行双击 **`Setup Codex.cmd`**，按提示完成引导
2. 日常使用双击 **`Codex.cmd`**
3. 浏览器版：先装 [Node.js 18+](https://nodejs.org)，双击 **`Codex Web.cmd`**

### Web-Only 包（Windows / Linux / macOS）

```bash
# Linux 一键安装
wget https://raw.githubusercontent.com/lusipad/unofficial-codex-app-offline/main/scripts/setup-linux.sh
bash setup-linux.sh
```

**手动安装：**

1. 安装 Node.js 18+ 和 Codex CLI
   ```bash
   npm install -g @openai/codex
   ```
2. 从 [Releases](../../releases) 下载 `*-web.zip` 并解压
3. Windows 双击 `start.bat` | Linux/macOS 执行 `bash start.sh`
4. 打开 `http://127.0.0.1:3737`

**公网部署：**

```bash
# 端口 80 需要 root 或 setcap
sudo setcap 'cap_net_bind_service=+ep' $(which node)

# 写入 .env 持久化配置
cat > .env << EOF
HOST=0.0.0.0
PORT=80
CODEX_WEB_PASSWORD=你的强密码
EOF
bash start.sh
```

LAN / 公网模式务必设密码。浏览器 UI 控制的是 gateway 所在机器的文件和进程，不要暴露到不受信网络。

## 包内结构

```
便携包（*-portable.zip）
├── Codex.cmd                 ← 桌面启动器
├── Codex Web.cmd             ← Web gateway 启动器
├── Setup Codex.cmd           ← 首次引导
├── _internal/
│   ├── app/                  ← Codex Desktop 应用（Electron）
│   ├── web/                  ← Node.js gateway 运行时
│   ├── chrome-extension/     ← 离线 Chrome 扩展
│   ├── seed/                 ← 离线技能种子
│   └── tools/                ← 修复/同步工具

Web-Only 包（*-web.zip）         ← 三平台通用
├── start.bat / start.sh      ← 启动脚本
├── start-web.mjs             ← gateway 入口
├── gateway/dist/             ← 编译后的 gateway
├── cache/webview/            ← 预提取 Codex 前端 UI
└── web-shell/                ← 登录页 + Electron polyfill
```

## 构建

```powershell
npm ci
npx playwright install chromium
pwsh -NoProfile -File ./scripts/build-offline-package.ps1
```

产物输出到 `dist/offline/<release-name>/`。

### 核心脚本

| 脚本 | 用途 |
|------|------|
| `build-offline-package.ps1` | 主编排：拉取 Store 包 → 打补丁 → 打包 |
| `resolve-store-bundle-url.mjs` | 解析 Microsoft Store CDN 下载链接 |
| `patch-app-asar.mjs` | 给官方 app.asar 打兼容补丁 |
| `setup-linux.sh` | Linux 引导式部署脚本 |
| `build-cross-platform.sh` | 独立跨平台 Web 包构建 |

### 构建流程

1. 解析 Microsoft Store 上 `OpenAI.Codex` 最新 Retail 版 CDN 链接
2. 下载 `.msixbundle`，提取 x64 应用载荷
3. 给 `app.asar` 打补丁（脱离 MSIX、绕 feature gate、路径修复等）
4. 拉取官方 skills、下载 primary runtime 插件、Chrome 扩展
5. 编译 web-gateway TypeScript
6. 打包：便携 ZIP + 跨平台 Web ZIP + 安装器 EXE

### CI

每天 UTC 3:15 自动检查 Store 版本，有新版则构建发布。`[force-rebuild]` 提交标记可强制重建。

## 配置

标准离线使用无需配置。高级场景下创建包根目录的 `skill-installer.env`（模板在 `_internal\skill-installer.env.example`）：

| 变量 | 说明 |
|------|------|
| `CODEX_HOME` | Codex 主目录（默认 `~/.codex`） |
| `GITHUB_TOKEN` | 私有仓库或绕过速率限制 |
| `CODEX_SKILL_SOURCE_DIR` | 本地技能目录（完全离线时使用） |

Web gateway 变量（`start.sh` 同级 `.env` 文件或环境变量）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `3737` | 监听端口 |
| `CODEX_WEB_PASSWORD` | — | 公网必备 |
| `CODEX_WEB_WORKSPACE_ROOTS` | — | 允许 Web UI 访问的本地目录 |

## 风险与限制

- `store.rg-adguard.net` 是第三方服务，可能失效
- Store 包内部结构变化后解包逻辑可能需调整
- Web gateway 需要 Node.js 18+ 和 `@openai/codex` CLI，当前包不捆绑这两者
- Chrome 扩展仍需用户手动加载一次
- 依赖第三方 OAuth 或在线 marketplace 的插件仍需网络

---

<a id="english"></a>

## English

Unofficial offline repackaging of the **OpenAI Codex** Windows desktop app, plus a cross-platform **Web Gateway** for Windows / Linux / macOS.

### Quick Start

**Windows full package:** Download `*-portable.zip` from [Releases](../../releases), extract, run `Setup Codex.cmd` once, then `Codex.cmd`.

**Web-Only (all platforms):** Install Node.js 18+ and `npm install -g @openai/codex`, download `*-web.zip`, run `start.bat` (Windows) or `bash start.sh` (Linux/macOS).

**Linux guided setup:**

```bash
wget https://raw.githubusercontent.com/lusipad/unofficial-codex-app-offline/main/scripts/setup-linux.sh
bash setup-linux.sh
```

### Building from Source

Windows 10/11 x64, Node.js 18+, PowerShell 7+, optional Inno Setup 6.

```powershell
npm ci
npx playwright install chromium
pwsh -NoProfile -File ./scripts/build-offline-package.ps1
```

Artifacts: `dist/offline/<release>/` — portable zip, web zip, setup exe, SHA256SUMS.

### Config

See `config/offline-package.json`. Key fields:

| Field | Description |
|-------|-------------|
| `appSource.ring` | `Retail` / `Preview` / `Insider` |
| `appSource.mode` | `rg_adguard` (download) or `installed_store` (local) |
| `packaging.portableZip` | Generate portable ZIP |
| `packaging.crossPlatformWeb` | Generate cross-platform web ZIP |
| `packaging.setupExe` | Generate Inno Setup installer |

CI runs daily at 3:15 UTC. Commits tagged `[force-rebuild]` trigger a rebuild even if the Store version hasn't changed.

### Risks

- Relies on third-party `store.rg-adguard.net`
- Store package structure changes may break extraction
- Web gateway requires Node.js 18+ and `@openai/codex` CLI (not bundled)
- Chrome extension still needs manual install step
