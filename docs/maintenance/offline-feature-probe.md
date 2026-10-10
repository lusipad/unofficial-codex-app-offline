# 离线功能探针（offline-feature-probe）

`scripts/offline-feature-probe.mjs` 记录离线包实际显示了哪些官方设置分区，用来回答“离线版里哪些功能能用”。gate 报告（`docs/maintenance/gate-report.md`）是维护者排查用的；这份清单面向用户，以界面上实际显示的内容为准，不做推断。

## 方法

- **静态全集**：从原始 `app.asar` 的 settings-page 导航分组（`{key, heading, slugs}`）提取全部设置分区 slug。
- **运行时可见**：启动打包后的应用，读取设置导航按钮上的 `data-settings-panel-slug` 属性。名称取自按钮的 `aria-label`，即界面上显示的文字。
  - 运行环境：API Key 模式的 `auth.json`、不登录 ChatGPT、预置首启引导完成标志（`electron:onboarding-projectless-completed`）、网络阻断、`--lang=zh-CN`。
- **离线缺失** = 静态全集 − 运行时可见。

slug 跨版本稳定，比 gate id 更适合做长期对照。

## 可信度保障

以下任意一项不满足，探针就以非零退出，不产出可用结果：

1. **结构自检**：
   - 静态全集至少有 20 个 slug；
   - 可见的每一项都必须属于静态全集；
   - 必然可见的分区（常规、外观、键盘快捷键）必须出现。
2. **稳定读取**：导航连续 3 次读取结果相同（间隔 1.5 秒）才采用，避免把加载中（pending）的分区当成不可用。
3. **失败重试**：启动失败或结构自检不通过时，换新的用户目录重试一次。
4. **金标准断言**：`scripts/offline-feature-expectations.json` 中的 `expectVisible` / `expectHidden` 都在界面上确认过。结果与之矛盾时直接失败，不重试。

维护提示（只警告）：
- 不可见但没有说明的分区，例如上游新增的分区；
- 说明已过时，即写了不可见原因但实际已经可见的分区；
- 期望清单中引用了已不存在的 slug。

## 运行位置

`verify-offline-package.ps1` 在启动冒烟测试之后运行探针，输出到 `dist/offline/reports/<version>/offline-features.{json,md}`。这个目录与 gate 报告相同，都不随 Release 发布。使用 `-SkipDesktopLaunchSmoke` 时会一起跳过。

手动运行：

```powershell
node scripts/offline-feature-probe.mjs --portable-root <便携包根目录> --out-dir <dir> --version <x>
```

## 基线、用户文档与 Release 说明

- **基线**：`docs/baselines/offline-features.json` 是维护者审阅过的状态。面向用户的 [`docs/offline-features.md`](../offline-features.md) 由它生成，不要手工编辑；测试会检查两者是否一致。
- **差异**：每次运行都会和基线对比。结果写入报告的“相对 X 的变化”一节，同时生成 `offline-features-release.md`：
  - 只有通过全部检查的运行才会生成这个文件；
  - 没有变化时内容为空，Release 说明里不会出现这一段；
  - 变化不超过 5 项时逐条列出：新增可见、不再可见、新增设置分区、上游移除；
  - 超过 5 项时只写变化数量，并附上完整清单的链接。
- **Release**：CI 的 “Build release notes” 步骤读取这个文件，内容非空时插入 Release 说明。
- **更新基线**：审阅报告后，先补齐新增不可见分区的说明，然后运行：

```powershell
node scripts/offline-feature-probe.mjs --promote dist/offline/reports/<version>/offline-features.json
```

  未通过检查的报告，或者存在没有说明的不可见分区时，promote 会拒绝执行。

## 维护不可见原因（notes）

说明会直接展示给用户：只写用户能理解的原因，不要写 gate id 等内部细节（这些记录在 CHANGELOG 或 docs 中）。


`offline-feature-expectations.json` 的 `notes` 按 slug 记录不可见分区的名称和原因。原因依据渲染层自身的可见性规则（`use-visible-settings-sections` 中的 switch、`Ta` 能力映射，以及 settings-page 中的过滤器）。原因无法确定时，如实写“待确认”。

修复了某个功能入口后：
1. 把它加入 `expectVisible`；
2. 删除对应的 note。

## 已知范围

- 目前只覆盖设置导航。左侧导航栏、编辑器按钮、菜单项后续再扩展。
- 只覆盖 API Key / 未登录模式。登录 ChatGPT 后，「使用情况和计费」「数据管理」「云端偏好设置」等会出现，这个模式暂未覆盖。
