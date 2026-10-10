# docs/ 索引

架构决策、实施记录、版本故障排查和维护工具说明都收在本目录。每条一句话说明；标为「历史」的文档已完成使命或已被取代，保留原样只为追溯，不再代表现行契约。

## 根目录

路径被已发布 Release 说明引用，因此不移动、不改名。

- `models-api.md`（现行）— 可选 `models-api.json` 模型目录的构建方式、安装配置与临时补丁退出条件。
- `offline-features.md`（现行，机器生成）— 面向用户的离线功能清单，由 `offline-feature-probe.mjs --promote` 生成，不要手工编辑。

## baselines/ — 机器可读的审阅基线

- `gate-baseline.json` — Statsig gate 扫描基线，`scripts/gate-report.mjs` 默认读取；更新流程见 `maintenance/gate-report.md`。
- `offline-features.json` — 离线功能清单基线，由探针 `--promote` 写入；与 `offline-features.md` 的同步由测试保证。

## maintenance/ — 维护流程与工具说明

- `gate-report.md`（现行）— gate 报告工具的输出位置、诊断用途和新 Store 版本的审阅流程。
- `offline-feature-probe.md`（现行）— 离线功能探针的测量方法、基线/用户文档生成流程和 Release 说明约定。

## architecture/ — 架构边界与设计决策

- `issue-59-gateway-vs-patch-analysis.md`（现行）— 评估「桌面版全走网关、不再 patch」是否可行：结论是不能归零，给出补丁面下限。
- `desktop-patch-boundary-design.md`（现行）— 桌面补丁边界重划的设计：补丁分级、证据与重验条件，现行补丁清单的评审依据。
- `desktop-patch-boundary-plan.md`（历史）— 上述设计的实施计划与自查记录，工作已完成。
- `plan-b-patch-migration-inventory.md`（历史）— 方案 B 迁移清单：renderer gate 正则 needle 下沉到 `init.cjs` 的逐项记录，迁移已完成（26.803 验证）。
- `plugin-service-compat-migration-plan.md`（历史）— 插件服务兼容逻辑迁移到共享契约的计划；落地结果见 `implementation-notes/plugin-service-compat.md`。
- `renderer-gate-atom-default-on.md`（现行）— renderer jotai gate atom 默认开启的方案、denylist 逐条理由与界面 A/B 方法。
- `gate-redesign.md`（历史）— 离线 gate 策略重设计草案，正文自注「保留为原始设计记录」；落地结果是 `renderer-gate-atom-default-on.md`。

## implementation-notes/ — 功能级实施记录

- `feature-gate-boundary.md`（现行）— feature gate 策略迁移到共享能力契约的实施记录。
- `plugin-service-compat.md`（现行）— 插件服务兼容迁移的实施记录，迁移计划的落地结果。
- `experimental-feature-availability.md`（现行）— 26.825 experimental feature 可用性兼容（computer_use / browser_use）。
- `priority-filter-fast-mode.md`（现行）— Activity View gate 覆盖与 Fast mode 可用性修复（26.730 / 26.803 形态）。
- `durable-sign-in-retry-stop.md`（现行）— 26.928 起离线未登录时停止 durable 主机无限重连。

## incidents/ — 按 issue 记录的版本漂移与故障排查

这些是对应 issue 的权威排查记录，不会过时；新增版本故障时在这里追加。

- `issue-100-permanent-worktree-head.md` — Codex 26.820 用 `branchName: "HEAD"` 创建永久 Worktree 的兼容处理。
- `issue-101-codex-26.825-build-failure.md` — 26.825 构建失败：两个 version-locked matcher 的 bundle 形态漂移。
- `issue-102-codex-26.831-build-failure.md` — 26.831 构建失败：归档线程分页 loader 移入 data-controls chunk。
- `issue-105-codex-26.901-asar-integrity.md` — 26.901 构建失败：`ELECTRONASAR` PE 完整性资源校验与重写。
- `issue-107-codex-26.901-model-label-drift.md` — 26.901 构建失败：renderer 自定义模型标签 fallback 漂移。
- `codex-26.901.5003-astra-validation.md` — 26.901.5003 选择 `gpt-6-astra` 报 `invalid_request_error` 的升级验收记录。
- `issue-108-primary-runtime-extract-failure.md` — primary runtime 归档解压失败（tar exit code 1）的排查。
- `issue-112-web-renderer-connect-app-host-drift.md` — 26.908 重构宿主连接导致 Web 端永久停在官方启动屏。
- `issue-127-codex-26.1002-build-failure.md` — 26.1002 构建失败：测试清理 `EPERM` 与 node_repl bridge 锚点漂移。
