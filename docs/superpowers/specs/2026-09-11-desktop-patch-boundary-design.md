# 桌面补丁边界重划 —— 设计

> 日期：2026-09-11
> 验证基线：官方 `OpenAI.Codex_26.903.8094.0_x64`（SHA1 `c8d35cdf9673bb40660a075771f02e3a46c41186`，直接取自 Store CDN，零 `codex-offline` marker）

## 1. 背景

桌面版给官方 Codex 打约 40 个补丁。这些补丁逐年累积，从未系统验证过必要性——加上去就一直留着，上游每次发版跟着修。2026-03 以来 34% 的提交动过 `patch-app-asar.mjs`。

一次实测暴露了问题的性质：`process.windowsStore = true` 这个补丁在最新版**已无任何功能价值**（全包仅 1 处引用，位于 Sentry 遥测的 `build_type` 字段），但设置它会让 Electron 把 `autoUpdater` 路由到未链接的 MSIX 原生绑定并崩溃，于是又加了第二个补丁打桩去修。**两个补丁长期维护，净收益为零。**

问题不是"有几个补丁过期了"，而是**补丁清单里没有地方记录一个补丁为什么还在**，也没有机制让过期的东西浮出来。

## 2. 验证结论

完整取证过程见第 7 节。核心事实：

1. **官方原始载荷脱离 MSIX、断网直启可以正常工作**（`offline-direct-launch-smoke.mjs` PASS）。启动崩溃是本项目补丁自招的，不是脱离容器的固有代价。
2. **gate 在离线下 fail-closed**：`_makeFeatureGate` 的实现是 `value: n?.value === !0`，无评估对象即 `false`；实测断网运行时 localStorage 只有 `statsig.session_id` / `statsig.stable_id`，**没有任何 cached evaluations**。这是渲染层 gate 补丁的存在理由，成立。
3. **40 个契约 marker 中只有 27 个在最新版落地**；另有 4 个实际落地的 marker 不在契约中，以及 1 个完全无 marker 的补丁（`enable_i18n`）。
4. **补丁清单里混着四种性质不同的东西**：真补丁、零改动的形状哨兵、清理历史补丁的迁移代码、锚点已消失的死补丁。

## 3. 设计目标

- 每个补丁都能回答"为什么还在"，且这个答案跟着代码走、被 CI 执行，而不是写在会过期的文档里。
- 无法判定必要性的补丁不删，但不再让它们制造硬性构建中断。
- 补丁器只面向**当前 Store bundle** 的形态，不为历史版本保留兼容路径。

## 4. 设计

### 4.1 契约数据结构

`web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs` 中的 `DESKTOP_ASAR_PATCH_MARKERS` 目前是扁平字符串数组。改为记录数组：

```js
const DESKTOP_ASAR_PATCHES = Object.freeze([
  Object.freeze({
    marker: '/*codex-offline:worktree-head-ref*/',
    kind: 'patch',
    tier: 'required',
    assert: 'negative',
    evidence: '26.903.8094.0：上游仍把字面量 HEAD 解析为 refs/heads/HEAD；needle 匹配成功即证明未修',
    reverify: 'needle 是否仍匹配',
  }),
  // ...
]);
```

为兼容现有消费方，从记录派生并继续导出字符串数组：

```js
const DESKTOP_ASAR_PATCH_MARKERS = Object.freeze(
  DESKTOP_ASAR_PATCHES.filter((p) => p.assert === 'marker').map((p) => p.marker),
);
```

### 4.2 字段取值

**`kind` —— 这是什么**

| 取值 | 含义 |
|---|---|
| `patch` | 真改行为 |
| `sentinel` | 零改动，只断言上游形态；形态漂移时失败关闭 |

历史清理代码与锚点已消失的死补丁**不设分类，直接删除**（见 4.5）。

**`tier` —— 缺失时的处理**

| 取值 | 处理 |
|---|---|
| `required` | 构建失败 |
| `degraded` | 仅告警，并在构建末尾单独列出陛落清单 |

**`assert` —— 验证方式**

| 取值 | 含义 |
|---|---|
| `negative` | 断言上游的坏形态已消失（首选） |
| `marker` | 断言 marker 出现（做不出反向断言时才用） |
| `absent` | 仅用于 `kind:'sentinel'`——marker 出现才是信号 |

**规则**：`kind:'patch'` 一律优先 `negative`。反向断言验的是"目的达成"而非"我们改过了"，上游自愈时自动通过而不是误报。

**`evidence` / `reverify`**：`evidence` 记录判定依据（含验证时的上游版本号）；`reverify` 记录重新判定需要的条件。`tier:'degraded'` 的记录两者都必填。

### 4.3 补丁器改动（`scripts/patch-app-asar.mjs`）

**一个补丁只保留一个形态。** 删除同一补丁的多形态变体（`_CURRENT_RE` 26 个、`_V2_RE`…`_V6_RE` 约 16 个、`LEGACY_*` 10 个常量）。匹配不上即失败关闭，由构建报错驱动更新，而不是再加一个 `_V7_RE`。

**拒绝已打补丁的输入。** 入口断言 `app.asar` 不含任何 `codex-offline` marker，含则报错退出。随之删除 `refreshMainEntryPatch` 与 88 处 `already patched` / `alreadyCorrect` 分支。

**tier 从契约读取。** `failRequiredPatch()` 与 `warn()` 的选择不再硬编码在各补丁处，改为查 `tier`。

### 4.4 验证脚本改动（`scripts/verify-offline-package.ps1`）

- 断言方式从契约的 `assert` 字段派生，不再由各处自行决定。
- `tier:'degraded'` 的缺失降级为告警，并汇总打印。
- `kind:'sentinel'` 的断言方向反转：marker 出现时失败。
- 现有 3 个游离在契约外的 marker（`settings-route-map`、`locale-source-default`、`stdio-write-error-guard-v2`）与无 marker 的 `enable_i18n` 补丁一并纳入契约记录。

### 4.5 构建流程前提（`scripts/build-offline-package.ps1`）

4.3 的"拒绝已打补丁输入"要求构建保证每次从干净载荷开始。实测发现本地 `build/work/source-app` 的 asar **已带补丁 marker**（含未提交的 `default-on-gate-wrapper`），说明这个前提当前不成立。

构建须保留一份 pristine 源副本，每次打补丁前从该副本拷贝到 stage 目录；源缓存的兼容性判定（`Test-AppSourceCacheCompatible`）同时校验副本未被污染。

## 5. 逐补丁归属

### 5.1 删除（8）

| 项 | 依据 |
|---|---|
| `windowsStore-patch` | 运行时 A/B：移除后离线直启仍 PASS；全包 1 处引用且在遥测 |
| MSIX binding 打桩（无独立 marker） | 随上一条；它只为修上一条引发的崩溃 |
| `electron-namespace-no-auto-updater` | 清理历史补丁的迁移代码，全新包永不落地 |
| `fast-mode-selector` | 锚点 `canUseFastMode` / `additionalSpeedTiers` 全包 0 次出现 |
| `fast-mode-service-tier-options` | 同上；`serviceTiers` 已从 app-primary 消失 |
| `context-usage-visible` | 锚点 `local-conversation-status-section-visible` 全包 0 次出现，无改名等价物 |
| `node-repl-config-reconcile-finally` | 补丁器自报 "not needed for this app version" |
| `feature-enablement-preserve-unified-exec` | 锚点日志串 `Features enabled` 全包 0 次出现 |

### 5.2 实施第一步须先定位（3）

以下补丁在最新版未落地，但相关上游字面量仍存在，需逐个定位后再决定。

**判定规则**：若其匹配式在最新原始包中无任何匹配 → 删除；若有匹配但补丁器走了别的分支 → 合并到该分支并复用该分支的 marker；若匹配成功却未应用 → 属于补丁器缺陷，修复。

- `computer-use-plugin-root-fallback`（已知：V3 分支改插了 `computer-use-resource-runtime-paths` 的 marker）
- `computer-use-input-mention` 与 `computer-use-input-mention-v2`（`browser_use_external`、`mentionItems` 字面量仍在）
- `unified-plugins-page`（`plugins-settings` 字面量仍在）

### 5.3 `kind: 'sentinel'`（4）

| marker | 说明 |
|---|---|
| `computer-use-resource-runtime-paths` | `content.replace(RE, '$&' + MARKER)`，零行为改动 |
| `plugins-api-key-nav` | 上游若回退到旧 gated 分支则触发 |
| `plugins-api-key-route` | 同上 |
| `codex-mobile-auth-relogin` | 同上 |

### 5.4 `kind: 'patch'` / `tier: 'required'`（18）

| marker | 上游行为 → 补丁行为 |
|---|---|
| `archived-threads-partial-list` | `do{...}while` 分页无 try/catch → 包 try/catch |
| `archived-threads-cache-fallback` | 无缓存回退 → 失败且结果为空时回退到全局缓存 |
| `archived-settings-offline-local-visibility` | `de=ae.length===0&&(c&&x‖S==null&&O‖k&&N==null&&ee)` → `de=ae.length===0&&c&&x`（`O` 为云端查询错误，离线必真——issue #55 根因） |
| `offline-query-network-mode` | 无 `networkMode` 配置（React Query 默认 `online`）→ `offlineFirst` |
| `offline-mutation-network-mode` | 同上 → `always` |
| `fast-mode-auth-method` | `a&&!u&&c?.requirements?.featureRequirements?.fast_mode!==!1` → `!0` |
| `windows-browser-use-capability` | 仅开 `computerUse`+`computerUseNodeRepl` → 另开 5 项 browser 能力 |
| `bundled-runtime-plugins` | `plugins.filter(marketplacePluginNames)` → 名单加 4 个打包期注入插件 |
| `bundled-browser-plugins-no-force-reload` | browser/chrome 的 `isAvailable` 依赖在线 feature → `!0` |
| `worktree-head-ref` | 字面量 `HEAD` 解析 bug 上游仍在 |
| `model-id-display-name-fallback` | 无名模型显示为 `Custom` → 格式化 model ID |
| `locale-source-default` | `.get('locale_source','IDE')` → `'SYSTEM'` |
| `renderer-known-statsig-gates` | gate 离线 fail-closed → 38 处调用点置 `!0` |
| `default-on-gate-wrapper` | `checkGate` 路径未知 gate 默认启用 |
| `sidebar-activity-view` | 变量 gate ID 的旁路 |
| `workspace-dependencies-settings` | 变量 gate ID 的旁路 |
| `ultra-reasoning-effort` | 上游 `filter(e!=='ultra')` → 放行并在仅支持 `max` 时合成 ultra 条目 |
| `settings-route-map` | 上游对 `show-settings` 抛 "not implemented" → 实现路由 |

另需纳入契约的两项：`stdio-write-error-guard-v2`（当前在 verify 中硬编码字面量）、`enable_i18n` 默认值补丁（当前完全无 marker，`assert` 用 `negative`）。

### 5.5 `kind: 'patch'` / `tier: 'degraded'`（9）

必要性无法在当前取证手段下判定，保留但降级。`reverify` 统一记为「完整便携包（含 primary runtime 插件）+ Computer Use 端到端场景」，`bundled-plugin-cache-lock-nonfatal` 除外。

| marker | 无法判定的原因 |
|---|---|
| `bundled-plugin-cache-lock-nonfatal` | Windows 文件锁竞态，单次跑通不构成证据。`reverify`：并发启动复现，或上游自行加入重试 |
| `node-repl-feature-enabled` | 需 Computer Use 插件实际安装才走到 |
| `node-repl-disable-sandbox` | 同上 |
| `node-repl-tool-search-feature` | 同上 |
| `feature-overrides-preserve-mcp-config` | 同上 |
| `computer-use-input-skill` | 同上 |
| `computer-use-thread-start-tool-search` | 同上 |
| `computer-use-node-repl-dynamic-tool` | 同上（加法型：上游无此工具，功能存在即必要） |
| `computer-use-node-repl-dynamic-tool-call` | 同上（加法型） |

## 6. 迁移顺序

1. 契约结构改造 + 派生导出（不改行为，现有测试须全绿）
2. 删除 5.1 的 8 项，同步删除其在补丁器与验证脚本中的断言
3. 定位并处理 5.2 的 3 项
4. 补丁器：删除多形态变体与 already-patched 分支；入口加"拒绝已打补丁输入"断言
5. 构建流程：保证 pristine 源副本（4.5）
6. 验证脚本：断言方式与 tier 改为从契约派生；degraded 降级为告警并汇总
7. 全量构建 + `verify-offline-package.ps1` 对最新 Store bundle 做回归

第 4 步依赖第 5 步先落地，否则本地重建会因输入已被污染而失败。

## 7. 取证记录

| 结论 | 手段 |
|---|---|
| 原始包可离线直启 | `offline-direct-launch-smoke.mjs`，全程 `--host-resolver-rules=MAP * 0.0.0.0` + 死代理 |
| windowsStore 链可删 | 同上工具，对比「全补丁」与「去掉 windowsStore+MSIX 打桩」两个变体，均 PASS；变体中 init.cjs 的 Statsig 拦截与 gate 注入照常生效 |
| gate 离线 fail-closed | 读 `_makeFeatureGate` 实现 + CDP 探针读运行时 localStorage |
| 逐补丁改动 | 原始 asar 与打补丁 asar 的多块差异比对 |
| marker 落地情况 | 遍历 asar 内 JS 条目统计 marker 出现次数 |

**方法论注意**：用 `cp -r` 复制载荷会静默损坏大二进制（`codex.exe` 大小相同、SHA1 不同，导致 app-server `spawn UNKNOWN`）。复制载荷须用 robocopy 并校验哈希。

## 8. 不在本次范围

**gate seam 上移。** 验证发现渲染层读 gate 有两条并行路径：jotai atom → `getFeatureGate`（30 处已知调用点）与直接 `client.checkGate`（21 处）。当前的 `default-on-gate-wrapper` 打在 `checkGate` 上，位于两条路径分叉的下游，**只覆盖后者**。具体实例：`app-initial` 中 `_e = wE('2957382457')` 走 atom 路径，该 gate 不在任何名单中，离线恒为 `false`。

两条路径在 `_getFeatureGateImpl` 汇合，其中存在两个更高位的收敛点：`_makeFeatureGate`（单点覆盖两条路径），以及 Statsig SDK 自带的 `overrideAdapter.getGateOverride` 扩展点。后者符合补丁器自身的加固原则（优先在稳定接口边界拦截）。

这是新增能力而非边界重划，单独立项，本设计不含。
