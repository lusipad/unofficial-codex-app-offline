# AGENTS.md

## 项目概述
Codex Offline - 离线版 Codex AI 编程助手 Web Gateway。

## 技术栈
- Node.js Express Web Gateway
- TypeScript
- WebSocket IPC Bridge
- Codex App-Server (JSON-RPC over stdio)

## 编码规范
- 使用 TypeScript 严格模式
- 遵循 KISS 原则
- IPC channel 命名使用 kebab-case

## 修改边界

先判断问题属于哪一层，再改代码。不要因为最终现象出现在桌面端，就直接修改编译后的 `app.asar`。

1. 请求转发、响应兼容、能力开关、插件数据和错误语义优先在 Gateway / App-Server 边界处理。
2. Gateway 与桌面端都要使用的兼容规则放到唯一的共享契约中，各层只保留薄适配。
3. 只有官方桌面运行时代码无法通过 Gateway 修复时，才修改桌面注入脚本或静态 bundle 补丁；必须先锁定版本、调用形态和回归测试。
4. 安装器与 setup 脚本只负责安装、升级、卸载和用户配置生命周期，不承载业务兼容逻辑。

## 关键文件地图

- Gateway IPC 与 App-Server 适配：`web-gateway/gateway/src/ipc/codex/`
- Gateway 回归测试：`web-gateway/gateway/test/`
- 插件服务共享兼容契约：`scripts/desktop-patches/plugin-service-compat.cjs`
- 桌面运行时薄适配：`scripts/desktop-patches/init.cjs`
- 版本相关的静态 `app.asar` 补丁：`scripts/patch-app-asar.mjs`
- 离线包构建编排：`scripts/build-offline-package.ps1`
- 离线包完整性验证：`scripts/verify-offline-package.ps1`
- 安装器模板：`installer/CodexOffline.iss.tpl`
- 安装、升级与清理逻辑：`scripts/setup-codex-offline.ps1`
- 构建和安装回归测试：`scripts/test/`
- 架构决策与版本兼容记录：`docs/`

## 定位与修改流程

1. 先确认当前 Store 包版本，并在对应的 stage / artifact 上复现；不要用旧构建目录推断最新版本行为。
2. 使用 `rg` 搜索准确的 IPC channel、方法名、功能 gate、错误码或界面文案，确认调用链属于 Gateway、桌面适配还是安装器。
3. 修改前先找到对应验证器和测试；没有覆盖时，先写一个能稳定失败的最小回归测试。
4. 优先修改最靠近数据源且职责正确的一层。能在 Gateway 统一处理的，不要在多个桌面 bundle 中重复补丁。
5. 只做解决当前问题所需的最小改动，不顺带重构相邻代码，也不要用宽泛正则跨版本替换未知 bundle。
6. 先运行目标测试，再运行完整验证矩阵；验证失败时继续定位，不用更新期望值来掩盖真实差异。

## 必须同步的契约

- 修改插件能力、方法映射或降级规则时，同步检查共享契约、Gateway 适配、桌面适配、静态补丁、包验证器和对应测试。共享规则只能有一个事实来源。
- 修改功能 gate 或 bundle marker 时，同步检查 `capabilityContractData.cjs`、补丁脚本、构建脚本、验证器和 gate 测试。
- 修改安装器 `[CustomMessages]` 的精确文案时，同步修改安装器模板、构建时 UTF-8 文案校验、离线包验证器和安装器测试。
- `model_catalog_json` 必须保持为 `config.toml` 根级键，写在任何 `[table]` 之前。取消勾选或卸载时，只能删除安装器管理的 catalog 路径和文件，必须保留用户的 Provider、API Key 与其他配置。
- 新增安装选项时，必须同时覆盖首次安装、重新安装时勾选、重新安装时取消勾选和卸载四条路径。

## 验证矩阵

按改动范围执行，发布候选必须全部通过：

```powershell
node --test .\scripts\test\*.test.cjs .\web-gateway\gateway\test\*.test.cjs
npm --prefix .\web-gateway run build:gateway
pwsh -NoProfile -File .\scripts\build-offline-package.ps1 -RequireInstaller
pwsh -NoProfile -File .\scripts\verify-offline-package.ps1 -BuildMetadataPath .\dist\offline\codex-offline-<version>\build-metadata.json
Get-FileHash .\dist\offline\codex-offline-<version>\codex-offline-<version>-setup.exe -Algorithm SHA256
```

此外，针对改动先运行最小目标测试。涉及桌面交互时，要在新生成的安装包上走一遍相关点击路径；涉及配置清理时，要验证用户已有配置仍然存在。

## 禁止事项

- 不要在未确认版本和调用形态时盲改压缩后的桌面 bundle。
- 不要把 IPC / transport 错误当作 HTTP 错误处理，也不要吞掉原始错误语义。
- 不要整段覆盖或删除用户的 `config.toml`、Provider、API Key 或非本安装器管理的文件。
- 不要覆盖工作区中与当前任务无关的未提交修改。
- 不要仅凭源码测试通过就宣称可发布；必须重新构建并运行离线包验证器。
- 未经用户明确授权，不创建 tag、GitHub Release 或发布正式资产。

## 交接要求

改动架构边界、版本兼容策略或安装生命周期时，更新 `CHANGELOG.md` 和对应 `docs/` 记录。交付说明至少包含：根因、改动落点、变更文件、验证结果、安装包路径与 SHA256，以及仍未覆盖的风险。
