# 插件服务兼容逻辑迁移计划

## 1. 最可能需要调整的决策

### 共享契约只描述稳定请求与降级结果

```js
matchPluginServiceRequest({ method, url })
// -> { surface, value } | null

createPluginServiceFallbackResponse(requestId, match)
// -> { requestId, responseType: "success", status: 200, ... }
```

首批支持的只读请求及结果：

```text
GET /ps/plugins/home                  -> { sections: [] }
GET /ps/plugins/list?scope=USER       -> { plugins: [] }
GET /ps/plugins/list?scope=WORKSPACE  -> { plugins: [], pagination: { next_page_token: null } }
GET /ps/plugins/workspace/created     -> { plugins: [] }
GET /ps/plugins/workspace/shared      -> { plugins: [] }
```

**置信度：高。** 这些结果与当前 renderer 补丁的既有语义一致。

**会推翻它的证据：** 官方 renderer 开始依赖这些结果中的新增必填字段，或端点/分页协议发生改变。

### 仅在传输失败时降级，不吞掉 HTTP 业务错误

Web Gateway 在代理 `fetch` 抛出异常时返回共享空结果；桌面端记录发出的匹配请求，只把对应的 `fetch-response` 错误改为空结果。HTTP 401/403/5xx 响应仍原样返回。

**置信度：高。** 这是当前补丁的有效语义，且不会掩盖登录、权限或服务端协议问题。

**会推翻它的证据：** 离线桌面实测证明官方请求以 HTTP 401 而非 Electron 网络错误表达“服务不可用”，并且该响应会阻断本地市场。

### renderer 只保留全局离线查询策略

删除 `patchOfflinePluginQueries`。保留现有 QueryClient 全局设置：查询使用 `offlineFirst`，变更使用 `always`；本地 `plugin/list` 因而无需业务专用正则。

**置信度：高。** 当前 bundle 只有插件补丁重复覆盖该能力，TanStack 的全局策略已经让本地查询在离线时启动。

**会推翻它的证据：** 行为测试或实机证明本地目录查询在 `navigator.onLine === false` 时仍未执行。

### 同一核心、两个薄适配器

共享 CommonJS 核心由 Web Gateway 源码持有，构建时复制到 Gateway `dist` 和桌面 `patches` 目录。Web 适配器在 `fetchIpc.ts` 使用它；桌面 `init.cjs` 只负责把通用 `fetch`/`fetch-response` IPC 映射到该契约。

**置信度：高。** Web 与桌面并不经过同一个进程，但使用的是同一 renderer 消息协议。

**会推翻它的证据：** 官方桌面不再通过通用 `fetch` 消息或不再以内联 `webContents.send` 返回响应。

### 插件页版本由能力契约选择

`3413548395` 在 Gateway 与桌面运行时中显式设为 `false`，使用 bundle 内已有完整分类路由的统一插件页。它不再参与 ASAR 的静态 true-gate 批量补丁；只迁移本项目旧缓存中带所有权 marker 的错误补丁。

**置信度：高。** 实机与 bundle 结构同时证明 true 分支的“查看更多”绑定空函数，而 false 分支复用官方分类页路由。

**会推翻它的证据：** 后续官方 bundle 反转该 gate 的语义，或统一插件页不再位于 false 分支。

## 2. 假设

- 桌面主进程收到的请求 payload 含 `type: "fetch"`、`requestId`、`method`、`url`；置信度高，来源为当前官方 bundle。
- 桌面响应 payload 含 `type: "fetch-response"` 和同一 `requestId`；置信度高，来源为当前官方 bundle。
- 全局 `offlineFirst` 足以启动本地插件查询；置信度高，来源为现有代码与 TanStack 行为。
- Featured 分类内容来自本地市场；云端 home/list 降级为空只负责解除阻断，不负责伪造分类；置信度高，来源为当前页面数据流。
- 首批迁移不重构 Statsig、模型、认证或 app-server 生命周期；置信度高，来源为用户要求的渐进迁移范围。

## 3. 偏离策略

遇到边缘情况时选择保守方案并记录后继续。这里的“保守”是：保持当前返回语义、只处理明确匹配的 GET 端点、只改错误响应、不改变成功响应、不给其他 IPC 增加副作用。

以下情况必须停止并重新确认：需要吞掉认证/权限错误；需要修改写请求；需要持久化新的用户状态；或发现桌面请求不经过已确认的 `fetch`/`fetch-response` 边界，从而推翻迁移前提。

## 4. 机械工作（低审阅价值——信任实现者）

- 新增共享 CommonJS 契约及单元测试。
- 构建时把契约复制到 Gateway `dist` 与两个桌面 `patches` 目录。
- 在 Web `fetchIpc.ts` 的网络异常分支调用共享契约。
- 在桌面 `init.cjs` 中按 webContents/requestId 跟踪匹配请求并转换错误响应。
- 删除 `patchOfflinePluginQueries`、相关 marker、必需补丁检查和旧字符串测试。
- 更新打包验证器，验证共享契约存在且 renderer 不再含插件业务补丁 marker。

## 5. 验证

- 共享契约对五个端点返回准确结构，对非 GET、未知 scope 和相似路径不匹配。
- Web Gateway 的插件传输失败返回 200 空目录；普通 URL、HTTP 错误和成功结果保持原样。
- 桌面适配器只转换同一 webContents 下已登记 requestId 的错误响应；成功、未知和跨窗口响应保持原样，记录会清理。
- 当前官方 renderer 经补丁后不存在 `plugin-query-network-mode`、`plugin-cloud-fallback` 或各 `/ps/plugins/*` 查询函数改写。
- 完整测试、包验证、app-server 启动和桌面直接启动均通过；生成同版本未发布安装包供试用。

实施记录见 [implementation-notes-plugin-service-compat.md](implementation-notes-plugin-service-compat.md)。
