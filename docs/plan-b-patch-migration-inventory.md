# 方案 B 补丁迁移清单（Issue #59）

> 目标：把 `patch-app-asar.mjs` 的 renderer feature-gate 正则 needle 下沉到
> `init.cjs` 运行时拦截，收缩桌面版补丁维护面。
>
> 本文是"先出清单、再批量改"的清单交付物。所有结论基于对
> `scripts/patch-app-asar.mjs`、`scripts/desktop-patches/init.cjs`、
> `web-gateway/gateway/src/ipc/codex/*`、`scripts/verify-offline-package.ps1`
> 的静态审查（无法在此环境端到端构建/运行桌面版）。

## 0. 一句话结论

**gate 迁移在功能上已经完成**。renderer 的 Statsig feature-gate 现在由
`init.cjs`（`session.webRequest` 重定向 `ab.chatgpt.com/v1/initialize` + 包装
`ipcMain` 注入 gate 快照）加上 `patch-app-asar.mjs` 里唯一还在跑的通用
`patchDirectStatsigGateCalls(content, DESKTOP_ASAR_KNOWN_GATE_IDS, …)` 统一处理。

`patch-app-asar.mjs` 里 **Patch 4–34 的那批 per-gate 正则常量（约 118 个 const）已经是孤儿死代码**：
它们的 apply 逻辑早已移除，常量在全文件只出现一次（仅定义、从不引用），主 apply
循环（约 3904 行起）根本不调用它们。文件末尾那句
`log('Renderer Statsig gates handled by init.cjs IPC interception (no asar patching).')`
就是这次迁移已完成的显式标记。

所以方案 B 的剩余工作**不是"迁移"，而是"清理孤儿死代码 + 对齐 verify 触发器 + 刷新文档"**。
改动量中等、运行时风险低（删的是从不执行的声明）。

## 1. 当前 gate 真正的处理路径

| 层 | 位置 | 作用 |
|----|------|------|
| 运行时数据注入（主力） | `init.cjs` `STATSIG_GATE_OVERRIDES` | 覆盖全部已知 gate id；webRequest 把 `initialize` 重定向为全 gate=true 的假响应，并包装 `ipcMain` shared-object 通道二次注入 |
| asar 通用兜底 | `patch-app-asar.mjs` `patchDirectStatsigGateCalls(…, DESKTOP_ASAR_KNOWN_GATE_IDS, RENDERER_KNOWN_STATSIG_GATES_PATCH_MARKER)` | 把 renderer 里直接 `$f(\`<已知gateId>\`)` 的调用中和为 `!0`，覆盖"在 statsig store 初始化前就读取"的少数场景 |
| Web 版对照 | `web-gateway/.../fetchIpc.ts` + `featurePatches.ts` | 同一套 webview，纯靠拦 statsig initialize，**不打任何 per-gate renderer needle**（仅保留 settings gate `4166894088` 一处，见 §4） |

结论：per-gate needle 的职责已被上面三层完全接管，逐个 gate 的正则是冗余。

## 2. 分类清单

### 2A. 必须保留（USED，主进程 / config / 非 statsig renderer 逻辑）

这些是引导层与"网关拦不到"的补丁，**不动**。判据：全文件引用次数 > 1，且属于以下类别。

| 类别 | 代表常量 / 标记 | 为什么不能下沉 |
|------|----------------|----------------|
| 引导 | `PATCH_MARKER` (`windowsStore-patch`)、init.cjs require、MSIX autoUpdater 打桩 | 独立 exe 启动的硬性前提，主进程运行时行为 |
| 主进程 IPC | `SETTINGS_ROUTE_PATCH_MARKER`（show-settings / open-config-toml） | IPC 而非网络流量 |
| sandbox 后端 | `APP_SERVER_SANDBOX_OVERRIDE_*` | 进程启动参数 |
| automation cwd | `AUTOMATION_RUNTIME_CWD_*` | 执行期路径归一化 |
| Computer Use | `COMPUTER_USE_*`（mention/skill/node-repl/diagnostics/plugin-root） | mcp 配置合成 + renderer 动态工具，非 gate |
| node_repl 配置 | `NODE_REPL_*`（disable-sandbox / config-reconcile / tool-search） | 主进程 mcp_servers 合成 |
| bundled 插件 / marketplace | `BUNDLED_BROWSER_PLUGINS_*`、`BUNDLED_RUNTIME_MARKETPLACE_*`、`BUNDLED_PLUGIN_CACHE_LOCK_*` | runtime marketplace 过滤，非 statsig |
| windows browser-use 能力 | `WINDOWS_BROWSER_USE_CAPABILITY_*` | 桌面 feature-state 通道 |
| fast mode（部分） | `FAST_MODE_AUTH_METHOD_*`、`FAST_MODE_HOOK_*`、`FAST_MODE_SERVICE_TIER_ALLOWED_RE`、`FAST_MODE_KEY_MARKER` | 可用性由**模型列表 / authMethod 派生**，不是 statsig gate，注入 gate 无效 |
| i18n / locale | `I18N_*`、`LOCALE_SOURCE_*` | 静态字符串字面量，无 IPC/网络拦截面（脚本注释已明确说明） |
| archived threads | `ARCHIVED_THREADS_*` | renderer 分页兜底，非 gate |
| 通用 gate 兜底 | `RENDERER_KNOWN_STATSIG_GATES_PATCH_MARKER` + `DESKTOP_ASAR_KNOWN_GATE_IDS` | 这就是取代 per-gate needle 的机制本体，**保留** |

### 2B. 已迁移的孤儿死代码（可删，约 118 个 const）

判据：在 `patch-app-asar.mjs` 全文件仅出现一次（只有定义、无引用），且主 apply 循环不使用。
连续区间 **约行 3372–3788（Patch 4 头 到 Patch 34 尾，止于 Patch 35 FAST_MODE 头之前）**，
外加行 3799 `FAST_MODE_STORE_MARKER`。区间内可执行 apply 语句：**无**（纯声明 + 注释，已核验）。

涉及补丁（按脚本注释编号）：

- Patch 4 settings 入口 `4166894088`
- Patch 5 Automations `3075919032`
- Patch 6 Pull Requests `3789238711`（含 route/V2/V3 变体）
- Patch 7 Scratchpad `2302560359`
- avatar overlay `2679188970`
- Patch 11 Heartbeat `1488233300`
- Patch 12 Ambient Suggestions `2425897452`
- Patch 13 Artifacts Pane `3903742690`
- Patch 14 PR Icons `2553306736`
- Patch 15 Memories `875176429`
- Patch 16 Slash Commands `1609556872`
- Worktree `505458`、Cloud env `1907601843`
- Browser Use `410262010`、In-app Browser `4250630194`、External Browser `410065390`、Browser non-local `3903563814`、Bundled marketplace gate `588076040`
- Background Subagents `1221508807`、Thread Overlay `1060282072`、Multi-Window `459748632`
- Computer Use gate `1506311413`、Control `2171042036`、Dictation `1244621283`/`4100906017`
- Thread Hover Cards `3032432888`、Chronicle `2574306096`、Personality `1444479692`
- Remote Connections `1042620455`/`4114442250`、Artifact Electron `839469903`
- fast-mode 旧版选择器 REs（`FAST_MODE_GATE_RE`/`FAST_MODE_AVAILABILITY_RE`/`FAST_MODE_SERVICE_TIER_GET_RE`/`_OPTIONS_RE`/`_FAST_TIER_RE`，被 §2A 的 service-tier 方案取代）
- context-usage 旧 REs（`CONTEXT_USAGE_STATUS_SECTION_FALSE_RE`/`_TRUE_RE`/`_PATCHED_RE`，marker 本体仍 USED，仅这几个 RE 死）
- `AUTOMATION_DIALOG_CWD_PATCHES` / `_REGEX_PATCHES` / `_UNPATCHED_PATTERNS`（dialog 保存侧，已被 runtime 侧取代）
- `FEATURE_ENABLEMENT_LOCAL_STATE_RE`

> 注：所有这些 gate id **均已在 `init.cjs` 的 `STATSIG_GATE_OVERRIDES` 表里**，删除后由运行时注入继续覆盖。

### 2C. 休眠 + verify 触发器（需你决策，见 §3）

以下三组补丁的 apply 逻辑同样已消失、const 已成孤儿，但 `verify-offline-package.ps1`
里还挂着**条件式 required 断言**——只有当前 bundle 仍含对应 upstream 分支时才要求 marker：

| 补丁 | 孤儿 const（patch 脚本） | verify 条件断言 | 当前状态 |
|------|------------------------|----------------|----------|
| Plugins API-key nav | `PLUGINS_API_KEY_NAV_PATCH_MARKER` (行3621) | `if (hasPluginsApiKeyDisabledNavBranch && !pluginsApiKeyNavPatched)` (行1408) | 休眠：当前 bundle 无该分支，条件为假，构建通过 |
| Plugins API-key route | `PLUGINS_API_KEY_ROUTE_PATCH_MARKER` (行3623) | 行1420 | 同上 |
| Codex Mobile auth relogin | `CODEX_MOBILE_AUTH_RELOGIN_PATCH_MARKER` (行3770) | `if (codexMobileRemoteControlMfaEndpointSeen && !codexMobileAuthReloginPatched)` (行1468) | 同上 |
| External agent config import | `EXTERNAL_AGENT_CONFIG_GATE_IDS`(行3606,唯一 LIVE)/`_MARKERS`(行3612) | 无硬断言（gate id 已在 init.cjs） | 孤儿，`GATE_IDS`→`MARKERS` 自引用后即断 |

**风险**：这些补丁的 apply 逻辑已经不在了。一旦 upstream 重新引入对应分支，verify
条件变真、marker 未注入 → **构建会 fail，且脚本里已无对应 apply 代码可修**。也就是说
"休眠触发器"当前是半坏的：留着 const 给人"还在维护"的错觉，真出事也救不了。

## 3. 需要你决策的点

1. **2C 的休眠补丁怎么办？**
   - (A) 一并删除孤儿 const + 放宽/删除对应 verify 条件断言（承认这些老 bundle 补丁已退役，日后如需再按新 seam 重写）。
   - (B) 删 const，但**保留 verify 条件断言**作为 tripwire（upstream 若回退，构建 fail 提醒你补写）。
   - (C) 全部保留不动（最保守，但维护面不减）。
   推荐 (B)：既清理死代码，又保留"upstream 回退时报警"的安全网。

2. **孤儿 const 的注释/编号文档**：脚本头部 1–41 的补丁说明是否同步精简？建议保留"必须保留"类，删除已迁移类，并加一段"renderer gate 统一由 init.cjs 处理"的说明。

## 4. 一个反例提醒（不要顺手删 settings gate 相关）

Web 版即便拦了 statsig，`featurePatches`/`server.ts` 仍单独保留了 settings gate
`4166894088` 的 renderer 改写（`patchSettingsGateChunk`）。说明该 gate 在 renderer 里有
statsig store 之外的第二处读取。桌面侧由 `patchDirectStatsigGateCalls` +
`init.cjs` 覆盖，**通用兜底必须保留**；不要因为"Patch 4 是死代码"就误删通用机制。

## 5. 批量改造方案（分阶段、可静态验证）

- **Stage 1（安全、无行为变化）**：删除 §2B 连续死区（约行 3372–3788 + 3799 孤儿），
  保留 §2A 全部 USED 常量与通用兜底。
- **Stage 2（按 §3 决策）**：处理 §2C 休眠补丁的 const 与 verify 断言。
- **Stage 3**：精简脚本头部补丁编号文档 + `DESKTOP_ASAR_PATCH_MARKERS` 契约中
  仅剩孤儿的 marker（如 `external-agent-config-import`、`codex-mobile-auth-relogin`、
  `plugins-api-key-*`）按 §3 决策决定是否移除。

## 6. 实施状态（已完成）

- Stage 1+2 已实施：`scripts/patch-app-asar.mjs` 删除 §2B/§2C 的孤儿 per-gate
  死代码常量（连续死区 + `FAST_MODE_STORE_MARKER`，净 -437 行），换成迁移说明注释；
  头部 docstring 精简补丁 4–7 / 16 / 38–39 的编号段。
- 契约精简：`capabilityContractData.cjs` 移除唯一孤儿 marker
  `external-agent-config-import`。三个休眠 tripwire marker（`plugins-api-key-nav`/
  `plugins-api-key-route`/`codex-mobile-auth-relogin`）按 §3 决策**保留**在
  `DESKTOP_ASAR_PATCH_MARKERS` 与 verify 条件断言中。
- Stage 3 一致性断言已实施：新增 `scripts/check-gate-override-sync.mjs`，断言
  `DESKTOP_ASAR_KNOWN_GATE_IDS` 与 `init.cjs` `STATSIG_GATE_OVERRIDES` 的数字
  gate id 集合相等（当前 36 = 36）。已挂进 `build-offline-package.ps1`（patch 前）
  与 `patch-app-asar.mjs`（动 asar 前 fail-fast）。任一边加漏 gate → 构建 exit 1
  并点名缺失 id。
- 验证覆盖：三文件 `node --check` 通过；死常量引用归零；一致性断言正/反用例均验证；
  端到端 `build → verify → 启动 smoke` 仍需本地 Windows CI。

### 无运行时环境下的验证策略

1. `node --check scripts/patch-app-asar.mjs`（语法）。
2. 删除后断言：每个被删常量名在全仓库引用数归零（`grep -c` == 0），确保无悬空引用。
3. 断言 §2A 的 USED 常量集合与 `DESKTOP_ASAR_KNOWN_GATE_IDS` 未被触碰。
4. `capabilityContractData.cjs`（marker/gate 契约）与 `verify-offline-package.ps1`
   的 marker 集合保持自洽（`requiredPatchMarker` 要求 marker 仍在契约列表内）。
5. 端到端启动验证仍需你本地 CI：`build-offline-package.ps1` → `verify-offline-package.ps1`
   → `offline-direct-launch-smoke.mjs`。

---
_本清单由静态审查生成，行号基于审查时的工作副本，实施前以最新文件为准。_
