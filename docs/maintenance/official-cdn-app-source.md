# 官方 CDN 包源（official_cdn）

`appSource.mode: "official_cdn"` 是默认的包源模式，来自 issue #134 记录的 OpenAI 官方企业部署文档（learn.chatgpt.com「Deploy the Windows app」，URL 参数 `user-source=offline`）。官方在该文档中公布了最新 Store 签名包的直链：

| 资源 | URL |
| --- | --- |
| x64 MSIX | `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix` |
| Arm64 MSIX | `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-arm64.msix` |
| 离线许可证 | `https://persistent.oaistatic.com/codex-app-prod/ChatGPT-License.xml` |

同一域名也是应用内置更新器使用的域名，且本项目已用它下载 primary runtime 插件包。

## 解析方式

`scripts/resolve-official-cdn-url.mjs` 对直链做一次 HEAD 请求，从 blob 元数据头解析：

- `x-ms-meta-package_identity`：包标识，必须与配置的 `packageFamilyName` 前缀一致（失配即失败关闭）。
- `x-ms-meta-package_version`：当前版本号，替代 rg-adguard 文件名里的版本解析。
- `ETag` / `Content-Length`：下载后的完整性复核依据（官方不提供 SHA1）。

输出 JSON 与 `resolve-store-bundle-url.mjs` 同构（`selected.href` / `selected.fileName` / `version` 等），`sha1` 恒为 `null`，`selected.etag` / `selected.size` 取而代之。

## 完整性校验

`import-store-bundle-from-url.ps1` 在 `-ExpectedSha1` 为空时接受 `-ExpectedEtag` / `-ExpectedSize`：下载完成后重新 HEAD 比对 ETag，并校验文件字节数。包本身仍是 Store 签名的 MSIX，Windows 安装时会做签名校验。

## 缓存与回退

- 源缓存复用要求来源模式、包族、版本、文件名与 ETag 全部一致（`Test-AppSourceCacheCompatible` 的 `official_cdn` 分支）。
- 官方直链只提供**最新 Retail 版**：Preview/Insider 通道或要指定历史版本时，把 `appSource.mode` 改回 `rg_adguard`（`resolve-store-bundle-url.mjs` 保留）；本机已装目标版本时可用 `installed_store`。
- 直链地址由 `config/offline-package.json` 的 `appSource.cdnUrl` 配置，也可用 `--url` / `CODEX_OFFICIAL_CDN_URL` 覆盖（例如换 arm64 包）。

## 相关官方机制（尚未采用，留作线索）

同一组文档还描述了官方托管配置：系统级 `%ProgramData%\OpenAI\Codex\requirements.toml` 可强制 approval policy、sandbox、web search 等，且 `[features]` 表可钉住 feature flags（含 `in_app_updates = false` 关闭内置更新器）。这些是未来替代部分 `app.asar` gate/updater 补丁的候选路径，采用前需在离线包上实测确认桌面端确实读取该文件。
