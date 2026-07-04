# 离线 gate 策略重设计草案（未实施：默认开 + 黑名单 + 发现报告）

当前生产路径仍是：`init.cjs` 注入 36 个已知 gate id，加上
`patch-app-asar.mjs` 的 `patchDirectStatsigGateCalls(..., DESKTOP_ASAR_KNOWN_GATE_IDS)`
通用兜底。本文只记录下一阶段方案，不能当作已落地契约使用。

## 1. 现状与"太傻"在哪

`init.cjs` 的 `injectStatsigGatesIntoObject` 只遍历 `STATSIG_GATE_OVERRIDES` 里
**列出的 36 个 gate id** 强制置 true（在伪造的 statsig initialize 响应的
`feature_gates` 里），其余 gate 不动。renderer 的 `checkGate(id)` 对未列出的 gate
默认返回 `false`。

后果：upstream 每加一个 feature gate，离线下**默认 off、功能静默消失**，必须手动往
`STATSIG_GATE_OVERRIDES` + `DESKTOP_ASAR_KNOWN_GATE_IDS` 两个列表补 id。高频、易漏——
这就是"太傻"。

## 2. 架构约束（决定方案形态）

- **main 进程的数据注入只能处理"枚举出来的" gate**——你没法给"未知名字"的 gate 填值。
  所以"未知 gate 默认开"在数据层做不到。
- renderer 里 gate-check 的函数名**高度 minify 且各 chunk 不同**（`Aa`/`ve`/`Yn`… 20+
  种别名），数字 backtick 又混着非 gate 常量（如 `2^64-1`）。所以"构建期从 bundle 扫
  gate id 自动生成允许列表"**精度不可靠**，会误判。
- 但存在**一个中心评估点**：Statsig 客户端类的
  `checkGate(e,t){return this.getFeatureGate(e,t).value}`，所有别名最终汇到这里。
  已确认该字符串在真实 26.623 asar（`statsig-Dcce3pt_.js`）中**存在且唯一**，且与
  cache 版（不同 hash）文本一致——**跨版本稳定**。

结论：真正的"默认开"只能在这个中心 `checkGate` 接缝上包一层。这是一个 renderer 补丁，
但是**一个稳定的 SDK 方法接缝**，远比原来 36 个 gate-id needle 稳。

## 3. 方案草案（未实施）

### 3.1 默认开包裹（保形、失效保护）

对 `checkGate` 做**保形包裹**——返回值仍是 boolean，绝不凭空造对象：

```
// anchor
checkGate(e,t){return this.getFeatureGate(e,t).value}
// patched
checkGate(e,t){return __DENY__.indexOf(e)>=0?this.getFeatureGate(e,t).value:!0}
```

- 未知/未黑名单 gate → 返回 `!0`（默认开）。
- 黑名单 gate → 走原始评估（保持官方/离线默认，多为 false）。
- `__DENY__` 是**打补丁时从契约 `DESKTOP_GATE_DENYLIST` 内联**进去的 id 数组。

**失效保护**：这个 needle 是 **optional（warn 不 fail）**。若某天 SDK 改了这行匹配不上，
构建不中断——退回到现有的"枚举 36 个 floor"行为（已知功能仍可用，只是新功能不再自动开）。
即：坏也只是退化，不会 crash、不会 break 构建。

### 3.2 枚举注入作为"地板"

保留 `init.cjs` 现有的 36 个 gate 数据注入不动。它现在就是生产路径。若后续实现
包裹 needle，它会变成**保底地板**：即使包裹 needle 失效，已知核心功能仍被强制开。

### 3.3 发现报告（构建期）

打补丁时输出一份**尽力而为**的报告：列出这次 bundle 里 renderer 引用到的 gate-shaped
id（会有假阳性，标注清楚），供维护者 review——**这就是"不太傻"的可见性来源**：默认开了
什么，你看得到，从而决定要不要拉黑。

## 4. 黑名单（`DESKTOP_GATE_DENYLIST`，我定的框架）

黑名单 = 必须**保持关**的 gate。判据分类：

| 类别 | 说明 | 为什么保持关 |
|------|------|--------------|
| 云/在线依赖 | 依赖 ChatGPT 登录/云同步/远端服务 | 离线开了也用不了，反而给出会报错的入口 |
| 遥测/实验上报 | Statsig 曝光、A/B 上报类 | 不该在离线包激活（虽然网络层已 no-op，双保险） |
| 实验性/半成品 | 内部开发中、true=禁用的 kill-switch | 开了可能是坏 UI 或反向语义 |
| 付费/订阅锁 | 需付费计划/账号态的门控 | 离线无意义 |

**诚实的约束**：具体该拉黑哪些 gate id **无法在离线、无运行时的情况下凭空断定**——gate id
是不透明哈希，我若硬编几个反而更不负责任。而且当前离线包**已经**把云端 onboarding、
remote connections 等强制开着且能发布，说明"云类 gate 开着"未必崩。所以：

> 黑名单的**正确填充方式**是：先用本机跑一次测试构建 → 看发现报告 + 实际点一遍界面 →
> 把"开了之后坏掉/不该出现"的 gate id 填进 `DESKTOP_GATE_DENYLIST` → 复验。

这不是偷懒，是这个问题的本质：**"不太傻"的智能来自 review 回路，而 review 回路需要一次
你本机的构建**（这里无 Electron/renderer、完整构建又 OOM，我无法代跑）。

## 5. 后续落地清单

- [ ] 契约新增 `DESKTOP_GATE_DENYLIST`（数组 + 分类文档，初始保守）。
- [ ] 契约新增 `default-on-gate-wrapper` patch marker（只在 producer 落地时加入）。
- [ ] `patch-app-asar.mjs`：加 optional 的 checkGate 包裹 needle（内联黑名单）+ 发现报告。
- [ ] `server.ts`（web 版）：对 statsig chunk 做同款响应期包裹，保持双端一致。
- [ ] `check-gate-override-sync.mjs` / smoke：纳入"黑名单 ⊆ 已知/发现集合"的一致性与
      发现报告。
- [ ] 你本机：`build-offline-package.ps1` 跑一次 → 看发现报告 + 点界面 → 填黑名单 → 复验。

## 6. 风险与回退

- 风险：默认开会让某些在线/实验 gate 的 UI 出现，可能是坏入口或反向语义。
- 缓解：黑名单 + 发现报告 + 枚举地板 + optional needle（失效即退化，不 break）。
- 回退：移除包裹 needle 即回到纯枚举模型；黑名单/地板都是纯数据，随时可调。

_本文为后续方案草案；当前代码尚未实现默认开 wrapper，黑名单内容以测试构建后的结论为准。_
