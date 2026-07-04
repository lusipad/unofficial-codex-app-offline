# Issue #59 评估：桌面版是否"全走网关、不再 patch"

> 关联 Issue：[#59 可以考虑下群友的思路，干脆不要 patch 了，全走网关算了](https://github.com/lusipad/unofficial-codex-app-offline/issues/59)
> 参考项目：[happy-loki/codexhub](https://github.com/happy-loki/codexhub)
> 结论一句话：**Web 端已经"全走网关"；桌面版能把补丁面压到最小引导层、其余下沉到 `init.cjs` 进程内拦截，但无法归零——除非放弃原生桌面应用本身。**

---

## 1. 先厘清一个前提：codexhub 和本项目解决的不是同一件事

Issue 把两件不同的事混在了一起，评估前必须拆开。

**codexhub 做的是"模型 / 鉴权重定向"。** 它把 `chatgpt_base_url` 指向本地 backend，用 Codex 原生的 remote-control 协议 + 本地 AI Gateway，把模型请求转发到 DeepSeek / Claude / GLM 等渠道。它在 README 里明确写"不修改任何 Codex 前端代码"。它之所以不需要 patch，是因为**它根本不试图解锁被 feature gate 挡住的 UI 功能**,它只换模型后端。

**本项目桌面版做的是"离线解锁"。** 它的核心价值是让官方 Codex Windows 应用脱离 MSIX 容器、绕过 Statsig feature gate、修好路径，在离线 / 独立 exe 下把被隐藏的功能全部点亮。这天然需要触碰应用本身。

所以"全走网关就不用 patch 了"这个推论，**对桌面版只成立一半**：网关能替代模型后端重定向（codexhub 那部分），但替代不了"让 Electron 脱离 MSIX 启动"和"点亮 gated UI"这两件桌面独有的事。

---

## 2. 现状：Web 端其实已经"全走网关"了

仓库现在是双轨架构，两条路各有一套 feature 处理实现，只共享 `capabilityContractData.cjs` 里的 marker / gate ID 契约。

| | 前端 | 后端 | feature / statsig 处理 | 是否 patch app.asar |
|---|---|---|---|---|
| **浏览器版** | 浏览器 | `start-web.mjs` 拉起 `codex app-server` | gateway 层 `fetchIpc.ts` + `featurePatches.ts` 拦截 | **否** |
| **桌面版** | 官方 Electron UI | 内置 Codex | `patch-app-asar.mjs`（约 40 个补丁）+ `init.cjs` 运行时拦截 | **是** |

浏览器版从 `cache/official-bundle` 提取托管 webview，Statsig 在 gateway 的网络层拦截、伪造 `ab.chatgpt.com/v1/initialize` 响应,**它完全不碰 app.asar**。这条路已经是 Issue 想要的形态。

维护痛点数据也印证了 Issue 的判断：**2026-03 至今 170 个提交里，58 个（34%）动了 `patch-app-asar.mjs`**。抽取最近的提交标题可以看到，几乎全是渲染层 gate needle 随 Codex 版本漂移而重断：

```
Restore offline desktop tools after renderer gate drift
add V3 regex for Patch 38 (v26.608+ bundle structure)
add standalone-hook function RE for PR icons + heartbeat/ambient/memories/slash gates
add avatar overlay + inline-RE gate V3 function patterns for Codex 26.429
support Codex 26.616 bundle structure changes
```

换句话说，**维护成本高度集中在渲染层 Statsig gate 的正则 needle 上**——它们锚定的是 React 编译器产出的 minified 代码，每次 Codex 发版都会变形，于是要不断补 V1 / V2 / V3 变体。

---

## 3. 核心发现：churn 大户其实已经被 `init.cjs` 双重覆盖了

这是整份评估里最关键的一点。

`init.cjs` 是桌面版的**进程内拦截层**（desktop 版的 `fetchIpc.ts` 对应物）。它在 Electron 主进程里做了三件事：

- **Layer 1**：`session.webRequest` 拦截 `ab.chatgpt.com/v1/initialize`，重定向为一个 `data:` URI，塞进伪造的 statsig 响应；
- **Layer 0 / 2 / 3**：包装 `webContents.send` / `ipcMain.handle` / `ipcMain.on`，在 shared-object 快照流里注入 gate override。

而它注入的 gate 列表，**已经包含了 `patch-app-asar.mjs` 里那些正则补丁所针对的同一批 gate ID**——36 个权威渲染层 gate ID（`DESKTOP_ASAR_KNOWN_GATE_IDS`）在 `init.cjs` 里逐个 `: true`：

```
'3075919032': true,   // Automations
'3789238711': true,   // Pull Requests
'2302560359': true,   // Scratchpad
'875176429':  true,   // Memories
'505458':     true,   // Worktree mode
'1609556872': true,   // Slash commands menu
'1221508807': true,   // Background subagents
'459748632':  true,   // Multi-window
'2574306096': true,   // Chronicle
... （共 36 个）
```

也就是说，Patch 4、5、10–35 这批渲染层 gate needle，和 `init.cjs` 的运行时注入**在解决同一个问题**。仓库其实已经在往这个方向走——提交 `536b9c8 Refactor: replace renderer ASAR regex patches with IPC-level gate injection` 就是这次迁移的起点，`patch-app-asar.mjs` 头部的"加固原则"也白纸黑字写着：**优先在稳定接口边界（`process._linkedBinding`、`init.cjs` IPC 拦截）拦截，而不是字符串替换编译后的 token**。

> ⚠️ 需要诚实说明的约束：两套东西目前并存，是有防御性理由的。正则 needle 拦的是渲染层**调用** gate 函数那一刻（`$f(\`3789238711\`)` 的返回值）；`init.cjs` 拦的是 gate **数据源**。当某个 gate 在 seeded store 解析完成之前就被读取，或渲染层把默认值编译进了 React memo slot、绕过了 store，此时只有正则 needle 兜得住。所以迁移**不是"闭眼删掉 25 个补丁"**，而是"逐个验证该 gate 的读取路径确实被 seeding 覆盖后，再删"。少数 gate 可能仍需保留 needle。

---

## 4. 补丁迁移清单（按可迁移性分层）

把约 40 个补丁按"能否脱离 asar"分成四层。列 **迁移目标** 表示建议归属。

### Tier 0 — 引导层：必须留在 asar，稳定，约 1 处

| 补丁 | marker | 作用 | 为什么迁不走 |
|---|---|---|---|
| Patch 1 | `windows` / `electron-namespace-no-auto-updater` / `windows-browser-use-capability` | `process.windowsStore=true`、MSIX autoUpdater native binding 打桩、注入 `init.cjs` require、Computer Use 环境默认 | 独立 `Codex.exe` 启动的运行时前提。`windowsStore` 只在 MSIX 容器里由 Electron 置位；置位后读 `autoUpdater` 会路由到未链接的 MSIX updater binding 直接崩。**这是进程启动行为，任何外部网关都拦不到。** |

锚点是稳定 seam（`process._linkedBinding`、入口 bootstrap），几乎不随版本漂移。**这是补丁面不可归零的下限。**

### Tier 1 — 主进程 IPC：必须留在 asar，中等稳定，约 4 处

| 补丁 | marker | 作用 | 为什么迁不走 |
|---|---|---|---|
| Patch 2 | `settings-route-map` | 实现 `show-settings` / `open-config-toml` 等 IPC handler（官方在 Electron 下直接 throw"not implemented"） | 主进程 IPC，不是网络流量 |
| Patch 8 | — | Windows automation cwd 路径归一化（`\\?\C:\...` → 盘符形式） | 主进程执行期行为 |
| Patch 9 | — | 强制打包 app-server 走非提权 sandbox backend | 主进程启动参数注入 |
| Patch 33b | `codex-mobile-auth-relogin` | Codex Mobile 鉴权刷新走桌面登录 | 主进程鉴权路由 |

这些能不能少改？可以稳定化（锚定 IPC channel 名、API 名等稳定文本），但删不掉。

### Tier 2 — 渲染层 Statsig gate 旁路：迁移目标 = `init.cjs`，约 25 处（**churn 主力**）

Patch 4、5、6、7、10、11、12、13、14、15、16、17、18、19、20、21、22、23、24、25、26、27、28、29、30、31、32、33、34、35。

全部形如「匹配 gate ID 字面量 → 替换为 `true` / `!0`」，覆盖 Automations、Pull Requests、Scratchpad、Slash commands、Memories、Worktree、Background subagents、Multi-window、Chronicle、Avatar overlay、Computer Use、Browser use 等。

- **迁移目标**：`init.cjs` 的 statsig initialize 拦截 + shared-object 注入（gate ID 已全部列入）。
- **收益**：这一层是 34% 维护量的来源。锚定在 `session.webRequest` / `ipcMain` 稳定边界后，几乎不再随 minify 漂移。
- **动作**：逐个验证 seeding 是否完全覆盖该 gate 的读取路径 → 覆盖则删除 needle 及其在 `verify-offline-package.ps1` 里的 marker 断言，改为**行为断言**（打开应用检查该功能是否可见）；未覆盖的少数保留。

### Tier 3 — 运行时配置 / 能力合成：逐个判断，约 10 处

不是简单 gate，处理要更小心。

| 补丁 | marker | 说明 | 建议 |
|---|---|---|---|
| Patch 3 | `locale-source-default` | i18n / locale_source 默认值 | 渲染层配置默认，非 gate；churn 低（新版本已自愈成 no-op），保留 |
| Patch 36 | `bundled-browser-plugins-no-force-reload` | 保留 bundled 浏览器插件在 runtime marketplace | 数据层过滤，**可考虑下沉 init.cjs** |
| Patch 37 | `computer-use-input-mention` 等 | 外部 Chrome 插件 @mention 能力检查 | gate + 渲染能力检查，随 Tier 2 一起验证 |
| Patch 38（native pipe） | `browser-use-native-pipe-*` | Browser Use native pipe 配置合成 | 主进程配置合成，保留 |
| Patch 38（agent config） | `external-agent-config-import` | 外部 agent 配置导入 | 部分可下沉，部分主进程迁移 IPC 保留 |
| Patch 39 | `plugins-api-key-nav` / `plugins-api-key-route` | 绕过 API-key 用户的 Plugins 锁 | gate 类，随 Tier 2 验证 |
| Patch 40 | `bundled-runtime-plugins` | 离线 runtime 插件写入 materialized marketplace | 打包期数据注入，保留 |
| Patch 41 | `node-repl-*` / `feature-*-preserve-*` | Computer Use 的 node_repl 配置合成 + feature 合并保 mcp 配置 | 配置合并逻辑，保留 |

---

## 5. 三条改造路径

**A. 真·零 patch = 砍掉桌面 repack，只发浏览器版。**
唯一能"少量改动彻底摆脱 patch"的做法：停止构建桌面产物 + 改文档引导用户用浏览器版。
代价：牺牲"解压即用的原生 Electron UI"这一核心卖点。

**B. 收缩 + 下沉（推荐）。**
把 asar patch 砍到只剩 Tier 0 + Tier 1（引导层 + 主进程 IPC），把 Tier 2 的约 25 个渲染 gate needle 全部下沉进 `init.cjs` 运行时拦截，Tier 3 逐个判断。
保留桌面 UX，把 34% 的高频维护面收敛到几个跟着稳定 API 走、几乎不随 minify 变动的 seam。
方向你已经在走（`536b9c8`），这是**把它走完**。

**C. codexhub 式重定向作为补充。**
加 `chatgpt_base_url` → 本地 gateway 做多模型 / 离线鉴权。它解决的是模型渠道问题,**不能替代**桌面的引导 patch，只能叠加。可作为"多模型"能力的独立特性，别当成"去 patch"的方案。

---

## 6. 直接回答：能少量改动达到目的吗？

取决于"目的"怎么定义：

| 目的 | 能否少量改动 | 说明 |
|---|---|---|
| 彻底不再维护 patch | ✅ 但仅路径 A | 代价是砍掉原生桌面版 |
| 大幅降维护 + 保留桌面版 | ⚠️ 非"少量"，是一次**中等重构**（路径 B） | ROI 高：把 58/170 的 churn 点换成几个稳定 seam；方向已开始 |
| "全走网关所以桌面不用 patch" 字面成立 | ❌ 对桌面版不成立 | Electron 脱离 MSIX 独立启动必须改 asar，网关拦不到进程启动和主进程 IPC |

**总结**：Web 端"全走网关"已经落地。桌面版真正可做、且性价比最高的，是**路径 B**——不是消灭补丁，而是把补丁从"随版本漂移的渲染层正则 needle"压缩为"锚定稳定接口的最小引导 + 主进程 seam"。补丁面无法归零，除非放弃原生桌面应用（路径 A）。

---

### 附：迁移时别忘的两处配套

1. **验证层要跟着改**：删掉 needle 的同时，要删掉 / 改写 `verify-offline-package.ps1` 里对应的 marker 断言，换成行为断言，否则会出现"needle 删了但 verify 仍在找 marker"的假失败。
2. **契约单一来源**：gate ID / marker 已集中在 `capabilityContractData.cjs`，下沉时保持这里为唯一事实源，桌面（`init.cjs`）与 Web（`fetchIpc.ts`）共用，避免再次分叉成两套。
