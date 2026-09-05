# Codex 26.901.5003.0：Astra 升级验收

验收日期：2026-09-05（北京时间）。

## 版本与问题

用户反馈桌面端选择 `gpt-6-astra` 后收到 `invalid_request_error`，提示需要更新 Codex，但独立 CLI 可以使用同一模型。

本机实际读取的版本：

| 组件 | 版本 |
| --- | --- |
| 原 Store App | `26.901.4073.0` |
| 原 App 内置 `codex.exe --version` | `0.153.1` |
| 独立 CLI | `0.153.2` |
| 新离线包 App | `26.901.5003.0` |
| 新包内置 `codex.exe --version` | `0.153.3` |

升级后在当前 Provider 下的 CLI 和桌面请求均成功。此次无需新增 Gateway 规则或桌面补丁；沿用现有构建脚本解析 Retail 源包，并按内置 CLI 的精确版本生成模型目录。以上证据支持更新 App 内置运行时，不能据此推断所有 Provider 的最低客户端版本。

## 真实请求

- 使用新包内置 `codex.exe`，显式指定 `gpt-6-astra`，以只读、临时会话发送不使用工具的最小提示，收到 `ASTRA_READY_5003`，退出码为 0。
- 启动新包 `ChatGPT.exe`，在桌面模型选择器中选择 **6 Astra / Ultra**，使用“请求批准”权限模式发送最小提示，收到 `ASTRA_UI_5003_OK`。
- 桌面提示要求将 `ASTRA`、`UI`、`5003`、`OK` 用下划线连接，输入中没有完整的期望答案；验收确认答案出现在助手回复中。
- 测试使用独立 Electron 用户数据目录和本机现有 Provider；未编辑用户 `config.toml` 或 API Key。

本地证据保存在 `build/astra-live-probe/`、`build/astra-ui-5003/` 和 `build/smoke-5003/`。这些目录可能包含本机路径或界面信息，不作为公开 Release 附件上传。

## 正式资产核对

本次检查时，`offline-v26.901.5003.0` 已于北京时间 2026-09-05 08:45:17 发布，发布提交为 `81fcdc669a7a3fdfcecbc0177a96c0b0e5d8c075`。

- [正式 Release](https://github.com/lusipad/unofficial-codex-app-offline/releases/tag/offline-v26.901.5003.0)
- [成功的构建及包验证记录](https://github.com/lusipad/unofficial-codex-app-offline/actions/runs/33932972107)
- Store 源文件：`OpenAI.Codex_26.901.5003.0_x64__2p2nqsd0c76g0.msix`
- 源文件 SHA1：`addaf210dc927efcaa8a81e2d10a1bbb7da2b83c`

已下载正式 portable ZIP 并核对 SHA256，再直接读取归档内文件计算哈希。以下四个文件与本地桌面实测使用的文件逐字节一致：

| 文件 | SHA256 |
| --- | --- |
| `_internal/app/ChatGPT.exe` | `a974651d99fdc234eed130c9472f5bedae4da2f5c8b02aeb9b3f6d78b4b42246` |
| `_internal/app/resources/codex.exe` | `bc15d59a3062bf165181a30007c3d0f5b1ee0ca4855e33d9b486ad59c984a31b` |
| `_internal/app/resources/app.asar` | `371bb64a3c88d2f381e5be82b4e0f7a640057452948bbd90868477f19ea5b148` |
| `_internal/models-api.json` | `105a815e9989d21b4968145849b6671fea884a3144b25e9f9c2aa7659969279b` |

正式资产哈希（安装器值由 Release digest 与发布的 `SHA256SUMS.txt` 交叉核对；portable ZIP 另在本机重新计算）：

```text
fc0a384cc52bfbb3cacc32a691f890accea99a3ed6e9c8ca48fc0592651d98ee  codex-offline-26.901.5003.0-portable.zip
990f987efb41b52b35129686a1446ce7a4b12ea5e738a231a661cb76be6e20b1  codex-offline-26.901.5003.0-setup.exe
```

本地重新构建的安装器位于 `dist/offline/codex-offline-26.901.5003.0/codex-offline-26.901.5003.0-setup.exe`，SHA256 为 `74b13c5bd72e89212d3e960417860b06846e71e3f3cd7a15b63348af514f6b47`。本地与 CI 的归档并非逐字节可复现，不用本地归档覆盖已经验证的正式资产，也不移动现有 tag。

## 验证范围

- 模型目录、模型可见性、当前 bundle 兼容目标测试：64/64 通过。
- 构建脚本及 Gateway 完整测试：153/153 通过。
- Gateway TypeScript 构建通过；现有补丁全部匹配新 bundle。
- 本地 `build-offline-package.ps1 -RequireInstaller` 成功生成安装器、portable ZIP、Web ZIP、技能目录及校验文件。
- 本地 `verify-offline-package.ps1 -BuildMetadataPath dist/offline/codex-offline-26.901.5003.0/build-metadata.json -RequireInstallerAsset` 通过，包含从最终 portable ZIP 解包后的桌面启动检查。
- 独立的 30 秒离线启动检查通过：窗口和 app-server 就绪，进程保持运行。

限制：Astra 实测覆盖当前 Provider 的最小文本请求和 Ultra 档位，不代表所有账号、Provider、工具调用或长任务均已验证；本次未执行真实用户目录上的安装、卸载或配置迁移。构建依赖审计仍报告一项中等严重性问题，未在这次版本验收中改动依赖。
