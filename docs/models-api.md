# API/custom provider 模型目录

[English](#english)

`models-api.json` 是每个 GitHub Release 附带的可选 Codex 模型目录。它面向 API Key、CRS 和其他 Responses API 兼容 provider；项目不会自动安装或启用它，也不会在文件中写入 API Key。

该文件是完整目录，不是增量补丁：CI 从安装包内 `codex.exe --version` 读取精确的 `codex-cli` 版本，下载对应 `rust-v<version>` 的 OpenAI 官方目录，应用 GPT-5.6 custom-provider 临时修正，再合并 DeepSeek 官方 Codex 目录。

## 安装

1. 从与当前安装包相同版本的 [Releases](https://github.com/lusipad/unofficial-codex-app-offline/releases) 下载 `models-api.json`。
2. 将文件放到 `CODEX_HOME`；未设置该变量时，默认目录是 `%USERPROFILE%\.codex`。
3. 在 `CODEX_HOME\config.toml` 中设置文件的绝对路径；未设置 `CODEX_HOME` 时，该配置文件是 `%USERPROFILE%\.codex\config.toml`。Windows TOML 路径使用 `/`：

```toml
model_catalog_json = "C:/Users/你的用户名/.codex/models-api.json"
web_search = "live"
```

`model_catalog_json` 只在 app-server 启动时加载。修改文件或配置后，需要完全退出所有 Codex 进程，再重新启动并新建任务。

## CRS / Responses API 配置示例

以下示例使用环境变量保存密钥。请把 `base_url` 替换为 CRS 实际提供的 Responses API 根地址：

```toml
model = "gpt-5.6-sol"
model_provider = "crs"
model_catalog_json = "C:/Users/你的用户名/.codex/models-api.json"
web_search = "live"

[model_providers.crs]
name = "CRS"
base_url = "https://你的-CRS-地址/v1"
env_key = "CRS_API_KEY"
wire_api = "responses"
```

GPT-5.6 官方条目原本已经声明 `supports_search_tool = true`。目录只对以下字段应用临时兼容覆盖，避免 custom provider 请求使用 Codex 后端专用的 Responses Lite / collaboration 形状：

```json
{
  "tool_mode": null,
  "multi_agent_version": null,
  "use_responses_lite": false
}
```

这只能保证 Codex 构造原生 `web_search` 工具请求。CRS 仍必须支持并透传 Responses API 的托管 `web_search`；目录文件无法为不支持搜索的中转增加该能力。

## DeepSeek 配置示例

截至本文更新时，DeepSeek 官方 Codex 指南只确认 `deepseek-v4-flash` 可用。目录也保留官方提供的 `deepseek-v4-pro` 条目，但在官方确认支持前请使用 Flash。

```toml
model = "deepseek-v4-flash"
model_provider = "deepseek"
preferred_auth_method = "apikey"
forced_login_method = "api"
model_reasoning_effort = "high"
model_catalog_json = "C:/Users/你的用户名/.codex/models-api.json"
web_search = "live"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

## 模型与 provider 必须手动匹配

一个目录会同时显示 GPT 和 DeepSeek 模型，但 Codex 的模型条目不绑定 provider。模型选择器只切换模型名，不会同步修改 `model_provider`：

- `gpt-*` 应配合 OpenAI、CRS 或相应 OpenAI Responses 兼容 provider。
- `deepseek-*` 应配合 `deepseek` provider。

如果二者不匹配，请求会发送到错误的 API 地址并失败。切换 provider 时请编辑用户级 `config.toml` 并完全重启 Codex。

## 验证原生搜索

为了排除 Browser、Chrome 或 Computer Use 回退，可以暂时禁用这些工具，然后要求模型只使用原生 `web_search`。成功时，请求或事件日志应包含 `web_search` / `response.web_search_call.*`，而不是浏览器工具调用。

## 数据来源和维护

- OpenAI 基础目录：[`openai/codex`](https://github.com/openai/codex) 中与包内 CLI 精确匹配的 `rust-v<codex-cli-version>/codex-rs/models-manager/models.json`，不使用会持续变化的 `main`。
- DeepSeek 条目：[DeepSeek Codex 集成指南](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)提供的官方安装脚本。CI 校验提取后目录的内容指纹；上游内容变化时会停止发布，要求人工复核。
- GPT-5.6 临时修正对应上游问题 [openai/codex#31882](https://github.com/openai/codex/issues/31882) 和 [openai/codex#33250](https://github.com/openai/codex/issues/33250)。

退出条件：安装包内 Codex 已验证修复 custom-provider 工具注入后，删除 GPT-5.6 覆盖；Codex 原生支持 DeepSeek/provider 专属目录后，删除 DeepSeek 合并。如果两项都完成，就停止发布该文件。

---

<a id="english"></a>

## English

`models-api.json` is an optional, version-matched Codex catalog for API-key and Responses-compatible custom providers. It is a full replacement catalog, not a partial overlay.

Download it from the same GitHub Release as the app, copy it into `CODEX_HOME`, set an absolute `model_catalog_json` path in `CODEX_HOME/config.toml` (by default `%USERPROFILE%/.codex/config.toml`), and fully restart Codex. The catalog lists both GPT and DeepSeek models, but it does not bind models to providers; keep `gpt-*` on the matching OpenAI/CRS provider and `deepseek-*` on the DeepSeek provider.

The GPT-5.6 entries retain their official search metadata while temporarily disabling `tool_mode`, `multi_agent_version`, and Responses Lite for custom-provider compatibility. The provider must still implement or forward hosted Responses API `web_search`.

CI builds the file from the exact OpenAI catalog tag matching the bundled CLI and from DeepSeek's official Codex setup catalog. Upstream metadata changes fail the build for review instead of silently changing the Release asset. See the Chinese sections above for complete CRS and DeepSeek configuration examples and removal criteria.
