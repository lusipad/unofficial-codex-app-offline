# Codex App Offline

这个仓库现在默认走一个临时可用的 hosted 方案：通过 `store.rg-adguard.net` 按包族名解析微软分发链接，下载 `OpenAI.Codex` 的 Store 包，再生成离线绿色版和安装包，同时把仓库内置 skills 一起打进去。

这条链路是为了满足“直接在 GitHub Actions 上触发构建”的目标，不再依赖你本机已经安装好的商店版 Codex。

## 当前方案

### 1. 来源模式

当前默认来源在 `D:/Repos/codex-app-offline/config/offline-package.json`：

- `appSource.mode`: `rg_adguard`
- `appSource.packageFamilyName`: `OpenAI.Codex_2p2nqsd0c76g0`
- `appSource.ring`: `Retail`

构建时流程如下：

1. `scripts/resolve-store-bundle-url.mjs` 用 Playwright 打开 `store.rg-adguard.net`
2. 以 `PackageFamilyName` 模式请求 `OpenAI.Codex_2p2nqsd0c76g0`
3. 解析返回的临时微软 CDN 下载链接
4. `scripts/import-store-bundle-from-url.ps1` 下载并解包 `.msix/.appx/.bundle`
5. 提取 `app` 运行目录，生成离线分发包

### 2. skills 集成

- 仓库内置 skills 放在 `D:/Repos/codex-app-offline/vendor/skills`
- `scripts/bundle-skills.ps1` 会生成 `seed/codex-home/skills`
- `scripts/bootstrap-codex-skills.ps1` 会在首次启动或 skills 变化时，把内置 skills 同步到 `~/.codex/skills`
- 不覆盖用户现有 `config.toml` 和认证信息

### 3. 产物

`D:/Repos/codex-app-offline/scripts/build-offline-package.ps1` 默认生成：

- `portable.zip`
- `setup.exe`（机器有 Inno Setup 时）
- `skills.zip`
- `store-export.zip`
- `SHA256SUMS.txt`

## GitHub Actions

工作流文件：`D:/Repos/codex-app-offline/.github/workflows/build-offline-package.yml`

现在已经改成 GitHub Hosted Windows Runner，可直接在 GitHub 上触发：

- `runs-on: windows-latest`
- 安装 Node.js
- `npm ci`
- `npx playwright install chromium`
- 运行 Playwright 解析非官方 Store 下载链接
- 构建离线包
- 上传 Actions Artifacts
- 发布 GitHub Release Assets

触发方式：

- `workflow_dispatch`
- 每天 UTC `03:15`
- `main` 分支上的脚本、配置、skills 变更

## 本地命令

同步当前用户 skills 到仓库：

```powershell
./scripts/sync-local-skills.ps1
```

本地测试解析下载链接：

```powershell
node ./scripts/resolve-store-bundle-url.mjs --package-family-name OpenAI.Codex_2p2nqsd0c76g0
```

本地生成离线包：

```powershell
./scripts/build-offline-package.ps1
```

只生成 zip，不生成安装器：

```powershell
./scripts/build-offline-package.ps1 -SkipInstaller
```

## 已验证结果

我已经在本机验证过这条 hosted-compatible 构建链路：

- 成功通过 `rg-adguard` 解析到了 `OpenAI.Codex` 的临时微软 CDN 链接
- 成功下载并解包 `OpenAI.Codex_26.305.950.0_x64__2p2nqsd0c76g0.msix`
- 成功生成 `D:/Repos/codex-app-offline/dist/offline/codex-offline-26.305.950.0`
- `app/resources/codex.exe --version` 可执行，返回 `codex-cli 0.108.0-alpha.12`

## 风险与边界

这是临时方案，不是官方供应链，主要风险有：

- `store.rg-adguard.net` 是第三方服务，可能失效、被限流或页面结构变化
- 返回的微软 CDN 下载链接是临时链接，每次构建都必须重新解析
- 如果 Store 包结构变动，解包规则可能需要调整
- 这条链路适合“临时离线分发”，不适合作为长期合规分发方案

## 目录说明

- `D:/Repos/codex-app-offline/config/offline-package.json`：离线构建配置
- `D:/Repos/codex-app-offline/scripts/resolve-store-bundle-url.mjs`：非官方链接解析器
- `D:/Repos/codex-app-offline/scripts/import-store-bundle-from-url.ps1`：下载并解包 Store 包
- `D:/Repos/codex-app-offline/scripts/build-offline-package.ps1`：总控打包脚本
- `D:/Repos/codex-app-offline/scripts/bootstrap-codex-skills.ps1`：启动前同步 skills
- `D:/Repos/codex-app-offline/scripts/sync-local-skills.ps1`：同步本机 skills 到仓库
- `D:/Repos/codex-app-offline/installer/CodexOffline.iss.tpl`：安装器模板
- `D:/Repos/codex-app-offline/.github/workflows/build-offline-package.yml`：GitHub Hosted 构建工作流

## 原则说明

- KISS：只做“解析下载链接 -> 解包 -> 集成 skills -> 发布”这条最短路径
- YAGNI：不引入额外镜像服务和私有包仓库
- DRY：解析、导入、打包、skills 同步分离，由总控脚本统一编排
- SOLID：每个脚本单一职责，后续切换来源模式时不会影响 skills 和安装器逻辑
