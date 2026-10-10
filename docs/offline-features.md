# 离线功能清单

<!-- 由 scripts/offline-feature-probe.mjs --promote 生成，请勿手工编辑；不可见原因在 scripts/offline-feature-expectations.json 中维护。 -->

本清单在 **26.1007.2314.0** 离线包上实测生成，读取「设置」导航中实际显示的分区。启动方式：API Key / 未登录 ChatGPT，网络已阻断。

- ✅ 离线可用：设置中可见。
- — 离线不可见：「说明」列给出原因。

登录 ChatGPT 账号后可见的分区会更多（例如「使用情况和计费」「云端偏好设置」），本清单暂未覆盖。左侧导航栏、编辑器按钮等其他入口也暂未覆盖。

## 个人

| 设置项 | 离线可见 | 说明 |
| --- | --- | --- |
| 常规 (`general-settings`) | ✅ |  |
| 通知 (`notifications`) | — | 需要登录 ChatGPT 账号 |
| 导入 (`import`) | ✅ |  |
| 个人资料 (`profile`) | — | 需要 ChatGPT 账号资料 |
| 外观 (`appearance`) | ✅ |  |
| 账户安全与登录 (`security`) | — | 上游当前对所有用户隐藏 |
| 账户 (`account`) | — | 需要登录 ChatGPT 账号 |
| 数据管理 (`data-controls`) | — | 需要登录 ChatGPT 账号；本地归档会话在「Archived chats」中管理 |
| Archived chats (`archived-chats`) | ✅ |  |
| 广告设置 (`ads-controls`) | — | ChatGPT 账号功能 |
| 家长控制 (`parental-controls`) | — | ChatGPT 账号功能 |
| 可信联系人 (`trusted-contact`) | — | ChatGPT 账号功能 |
| 安全 (`safety`) | — | ChatGPT 账号功能 |
| 语音 (`voice`) | ✅ |  |
| 存储 (`storage`) | ✅ |  |
| 配置 (`agent`) | ✅ |  |
| 个性化 (`personalization`) | ✅ |  |
| Mini 与虚拟宠物 (`pets`) | ✅ |  |
| 键盘快捷键 (`keyboard-shortcuts`) | ✅ |  |
| 使用情况和计费 (`usage`) | — | 需要 ChatGPT 账号的额度信息 |
| 账单 (`billing`) | — | 上游当前对所有用户隐藏 |
| 分析 (`analytics`) | — | 需要 ChatGPT 企业/团队工作区 |
| 消费者使用情况分析（内部） (`consumer-view`) | — | OpenAI 内部页面 |
| 代码审查用量 (`usage-code-review`) | — | 需要 ChatGPT 账号计划 |
| 调试 (`debug`) | — | 内部调试页，离线包刻意保持关闭 |
| 协议 (`agreements`) | — | 需要登录 ChatGPT 账号 |

## 团队

| 设置项 | 离线可见 | 说明 |
| --- | --- | --- |
| 团队 (`teams`) | — | 需要 ChatGPT 工作区账号 |

## 集成

| 设置项 | 离线可见 | 说明 |
| --- | --- | --- |
| 插件 (`plugins-settings`) | ✅ |  |
| 文件类型处理 (`file-type-handlers`) | — | 安装了提供文件处理入口的插件后才显示 |
| 密码 (`passwords`) | — | ChatGPT 账号功能 |
| 电脑操控 (`computer-use`) | ✅ |  |
| 电脑历史记录 (`chronicle`) | — | 仅 macOS |
| 应用快照 (`appshots`) | ✅ |  |
| Codex Micro (`codex-micro`) | — | 检测到过 Codex Micro 硬件后才显示 |
| MCP 服务器 (`mcp-settings`) | — | 已合并到「插件」页面 |
| 技能 (`skills-settings`) | — | 已合并到「插件」页面 |
| 浏览器 (`browser-use`) | ✅ |  |
| 云电脑 (`cloud-computer`) | — | 需要登录 ChatGPT 账号 |
| 浏览器扩展 (`extension`) | — | 上游当前对所有用户隐藏 |

## 编码

| 设置项 | 离线可见 | 说明 |
| --- | --- | --- |
| 钩子 (`hooks-settings`) | ✅ |  |
| 连接 (`connections`) | ✅ |  |
| 云端偏好设置 (`cloud-settings`) | — | 需要 ChatGPT 云端 |
| Codex 云端 (`codex-cloud`) | — | 需要 ChatGPT 云端访问 |
| 云环境 (`cloud-environments`) | — | 需要 ChatGPT 云端 |
| 代码审查 (`code-review`) | ✅ |  |
| Git (`git-settings`) | ✅ |  |
| 环境 (`local-environments`) | ✅ |  |
| 云端环境 (`environments`) | — | 开启云端环境时替代本地「环境」；离线显示本地「环境」 |
| Worktrees (`worktrees`) | ✅ |  |
