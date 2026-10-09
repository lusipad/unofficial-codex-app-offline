# Gate 报告（gate-report）

`scripts/gate-report.mjs` 盘点上游 bundle 读取的全部 Statsig id，并标出离线构建对每个 id 的处理方式。它用来在新 Store 版本上决定是否需要更新 `DESKTOP_GATE_DENYLIST`、`STATSIG_DEFAULT_FEATURE_OVERRIDES` 或 `STATSIG_DEFAULT_DYNAMIC_CONFIGS`。它只做诊断，不会让构建失败。

## 生成位置

- `build-offline-package.ps1` 在**打补丁之前**对原始 `app.asar` 运行。即使补丁失配导致构建失败，报告也已经生成。
- 输出到 `dist/offline/reports/<version>/gate-report.{json,md}`。这个目录不在发布资产目录里，不会随 Release 上传。
- CI 上同时把 Markdown 追加到 job summary（`GITHUB_STEP_SUMMARY`）。
- 手动运行：

```powershell
node scripts/gate-report.mjs --asar <app.asar> --out-dir <dir> --version <x>
```

## 识别方法

minified 函数名每个版本都会变，所以读取函数是从 bundle 里学出来的，不是写死的：

1. 直接的 SDK 调用：`.checkGate` / `.getFeatureGate` / `.getDynamicConfig` / `.getExperiment` / `.getLayer`。
2. 具名映射：`gates:{shareThread:"…"}`、`configs:{…}`，以及 `statsig:[…]` 列表。
3. 读取函数学习：解析各 chunk 的 ESM `import`/`export`，把调用点归一到“定义 chunk + 导出名”，并跨 chunk 合并。一个调用点接收的字面量 id 中，若至少 2 个、且不少于一半是已知 id（来自 1、2 或契约），就把它视为读取函数，报告它收到的所有 id。读取函数已知 id 的种类（gate/config/layer/experiment）唯一时，这个种类会传给它的其他 id。

**盲区**：通过变量传入的 id（例如 `fs(cond&&"id")`、`wsl_remote_connections`）静态扫描不到。

## 离线判定

| 判定 | 含义 |
| --- | --- |
| `forced-true` / `forced-false` | `STATSIG_DEFAULT_FEATURE_OVERRIDES` 显式指定 |
| `denied` | 在 `DESKTOP_GATE_DENYLIST` 中，保持上游离线值（false） |
| `default-on` | 由 checkGate wrapper 与 gate-atom 默认开启 |
| `not-a-gate` | 只作为 config/layer/experiment 读取，不受默认开启补丁影响 |
| `seeded-config` | 在 `STATSIG_DEFAULT_DYNAMIC_CONFIGS` 中播种 |

## 新版本的审阅流程

1. 看 **Changes since \<baseline\>**：
   - **New ids**：判断默认开启是否合适。需要登录或云端的、引导页、遥测等，按 `docs/renderer-gate-atom-default-on.md` 的方法做界面 A/B 后再决定是否加入 denylist。
   - **No longer read**：对应的契约条目可能已经过时。
   - **Changed kind/name/surface**：id 可能被复用了。例如 26.1007 的 `1193530394` 从应用快照变成了实时语音配置。
2. 看 **Contract entries to review**：
   - 契约里有、但扫描没找到的条目。
   - denylist 中只作为 config/layer 读取的条目，它们对 gate seam 不起作用。
   
   这些都只是清理候选。删除前要先在运行时确认，因为变量传参的 id 看不到。
3. 审阅完成后，更新基线：

```powershell
node scripts/gate-report.mjs --asar <原始 app.asar> --version <x> --write-baseline docs/gate-baseline.json
```

基线只保存跨版本稳定的字段（id、种类、名称、所在层），每个 gate 一行，便于 diff 审阅。chunk 文件名带内容哈希，所以不写进基线。
