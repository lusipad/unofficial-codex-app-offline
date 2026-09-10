# 桌面补丁边界重划 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面补丁清单从一串 marker 字符串升级为带分类、分级、证据和重验条件的记录，删掉已证实失效的补丁，并让补丁器只面向当前 Store bundle 形态。

**Architecture:** 单一事实源仍是 `capabilityContractData.cjs`。新增 `DESKTOP_ASAR_PATCHES` 记录数组，现有 `DESKTOP_ASAR_PATCH_MARKERS` 改为从记录派生（内容逐字不变，保证第 1 步零行为变化）。补丁器与验证脚本随后改为从记录读 `tier` / `assert` 决定失败还是告警。

**Tech Stack:** Node.js（CommonJS 契约 + ESM 脚本）、`node:test`、PowerShell 5.1 构建/验证脚本、`@electron/asar`。

**Spec:** `docs/superpowers/specs/2026-09-11-desktop-patch-boundary-design.md`

## Global Constraints

- 验证基线固定为官方 `OpenAI.Codex_26.903.8094.0_x64`（SHA1 `c8d35cdf9673bb40660a075771f02e3a46c41186`）。所有"上游行为"判断以该包为准。
- 契约文件 `web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs` 是 CommonJS，且被 ESM（`patch-app-asar.mjs`）、CJS（`init.cjs`）、PowerShell 内嵌 JS（`verify-offline-package.ps1`）三方 `require`。任何新增导出必须是纯数据 + `Object.freeze`，不得使用 ESM 语法。
- `web-gateway/gateway/src/ipc/codex/capabilityContract.ts` 内容是 `module.exports = require("./capabilityContractData.cjs")`，新增导出自动透传，无需改动。
- 测试命令（CI 用的同一条）：`node --test './scripts/test/*.test.cjs'`。
- 包内 PowerShell 脚本由 PowerShell 5.1 执行；若改动引入中文字符，文件必须保存为带 BOM 的 UTF-8。
- 补丁器的失败关闭语义不得放松：未识别的上游形态一律阻止出包。

---

### Task 1: 契约记录结构（零行为变化）

**Files:**
- Modify: `web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs:217-241`（`DESKTOP_ASAR_PATCH_MARKERS` 定义）与 `:285-302`（`module.exports`）
- Test: `scripts/test/patch-contract-records.test.cjs`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `DESKTOP_ASAR_PATCHES: ReadonlyArray<{marker: string, kind: 'patch'|'sentinel', tier: 'required'|'degraded', assert: 'negative'|'marker'|'absent', evidence: string, reverify: string}>`
  - `DESKTOP_ASAR_PATCH_MARKERS: ReadonlyArray<string>`（派生，内容与改动前逐字相同、顺序相同）
  - `getPatchRecord(marker: string): object | undefined`
  - `patchMarkersByTier(tier: 'required'|'degraded'): ReadonlyArray<string>`
  - `patchMarkersByKind(kind: 'patch'|'sentinel'): ReadonlyArray<string>`

**注意（与 spec 的偏离）：** spec 的 4.1 节示例把 `DESKTOP_ASAR_PATCH_MARKERS` 派生为「只含 `assert === 'marker'` 的项」。那会在第一步就改变 `REQUIRED_CAPABILITY_MARKERS` 的内容并可能让 `verify-offline-package.ps1` 的 `requiredPatchMarker()` 抛错。本任务改为派生**全部** marker，保持内容不变；断言方式的切换留到 Task 7。

- [ ] **Step 1: 写失败测试**

新建 `scripts/test/patch-contract-records.test.cjs`：

```js
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const contract = require(path.join(
  repoRoot,
  "web-gateway",
  "gateway",
  "src",
  "ipc",
  "codex",
  "capabilityContractData.cjs",
));

const KINDS = new Set(["patch", "sentinel"]);
const TIERS = new Set(["required", "degraded"]);
const ASSERTS = new Set(["negative", "marker", "absent"]);

test("every patch record has a complete, valid shape", () => {
  assert.ok(Array.isArray(contract.DESKTOP_ASAR_PATCHES));
  assert.ok(contract.DESKTOP_ASAR_PATCHES.length > 0);

  for (const record of contract.DESKTOP_ASAR_PATCHES) {
    assert.equal(typeof record.marker, "string", `marker: ${JSON.stringify(record)}`);
    assert.ok(record.marker.includes("codex-offline:"), record.marker);
    assert.ok(KINDS.has(record.kind), `${record.marker} kind=${record.kind}`);
    assert.ok(TIERS.has(record.tier), `${record.marker} tier=${record.tier}`);
    assert.ok(ASSERTS.has(record.assert), `${record.marker} assert=${record.assert}`);
    assert.ok(record.evidence.length > 0, `${record.marker} needs evidence`);
    assert.ok(record.reverify.length > 0, `${record.marker} needs reverify`);
  }
});

test("markers are unique", () => {
  const seen = new Set();
  for (const record of contract.DESKTOP_ASAR_PATCHES) {
    assert.ok(!seen.has(record.marker), `duplicate marker: ${record.marker}`);
    seen.add(record.marker);
  }
});

test("DESKTOP_ASAR_PATCH_MARKERS is derived from the records in order", () => {
  assert.deepEqual(
    contract.DESKTOP_ASAR_PATCH_MARKERS,
    contract.DESKTOP_ASAR_PATCHES.map((record) => record.marker),
  );
});

test("sentinels assert absence, patches never do", () => {
  for (const record of contract.DESKTOP_ASAR_PATCHES) {
    if (record.kind === "sentinel") continue;
    assert.notEqual(record.assert, "absent", `${record.marker} is a patch but asserts absent`);
  }
});

test("lookup helpers agree with the records", () => {
  const first = contract.DESKTOP_ASAR_PATCHES[0];
  assert.equal(contract.getPatchRecord(first.marker).kind, first.kind);
  assert.equal(contract.getPatchRecord("/*codex-offline:does-not-exist*/"), undefined);

  const required = contract.patchMarkersByTier("required");
  const degraded = contract.patchMarkersByTier("degraded");
  assert.equal(
    required.length + degraded.length,
    contract.DESKTOP_ASAR_PATCHES.length,
  );

  const patches = contract.patchMarkersByKind("patch");
  const sentinels = contract.patchMarkersByKind("sentinel");
  assert.equal(
    patches.length + sentinels.length,
    contract.DESKTOP_ASAR_PATCHES.length,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test ./scripts/test/patch-contract-records.test.cjs
```

Expected: FAIL —— `contract.DESKTOP_ASAR_PATCHES` 是 `undefined`，第一个 `assert.ok(Array.isArray(...))` 报错。

- [ ] **Step 3: 把 marker 数组改写为记录数组**

在 `capabilityContractData.cjs` 中，把现有的 `const DESKTOP_ASAR_PATCH_MARKERS = Object.freeze([...])` 整块替换为 `DESKTOP_ASAR_PATCHES`，**保持 40 个 marker 的原有顺序**，每条按 spec 第 5 节填 `kind` / `tier` / `assert` / `evidence` / `reverify`。

分类依据（spec 5.3–5.5）：

- `kind:'sentinel'`、`tier:'required'`、`assert:'absent'`：`computer-use-resource-runtime-paths`、`plugins-api-key-nav`、`plugins-api-key-route`、`codex-mobile-auth-relogin`
- `kind:'patch'`、`tier:'degraded'`、`assert:'marker'`：`bundled-plugin-cache-lock-nonfatal`、`node-repl-feature-enabled`、`node-repl-disable-sandbox`、`node-repl-tool-search-feature`、`feature-overrides-preserve-mcp-config`、`computer-use-input-skill`、`computer-use-thread-start-tool-search`、`computer-use-node-repl-dynamic-tool`、`computer-use-node-repl-dynamic-tool-call`
- 其余全部 `kind:'patch'`、`tier:'required'`、`assert:'marker'`（`assert` 的切换在 Task 7 做，本步一律先写 `'marker'`，`sentinel` 除外）

本步**不删除任何 marker**，包括 Task 2 将要删的那 8 个——它们照常写成记录，`evidence` 直接引用 spec 5.1 的依据。

样例（写全部 40 条时照此格式）：

```js
const DESKTOP_ASAR_PATCHES = Object.freeze([
  Object.freeze({
    marker: "/* codex-offline:windowsStore-patch */",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence:
      "26.903.8094.0：process.windowsStore 全包仅 1 处引用，位于 Sentry build_type 遥测；运行时 A/B 证明移除后离线直启仍 PASS",
    reverify: "offline-direct-launch-smoke.mjs 对去掉该注入的变体包",
  }),
  Object.freeze({
    marker: "/*codex-offline:worktree-head-ref*/",
    kind: "patch",
    tier: "required",
    assert: "marker",
    evidence: "26.903.8094.0：上游仍把字面量 HEAD 解析为 refs/heads/HEAD",
    reverify: "needle 是否仍匹配；不匹配即上游已修",
  }),
  Object.freeze({
    marker: "/*codex-offline:computer-use-resource-runtime-paths*/",
    kind: "sentinel",
    tier: "required",
    assert: "absent",
    evidence:
      "26.903.8094.0：补丁器走 content.replace(RE, '$&' + MARKER) 分支，零行为改动，仅断言上游形态",
    reverify: "patch-app-asar.mjs 中该 marker 是否仍只出现在 '$&' 追加分支",
  }),
  Object.freeze({
    marker: "/*codex-offline:bundled-plugin-cache-lock-nonfatal*/",
    kind: "patch",
    tier: "degraded",
    assert: "marker",
    evidence:
      "26.903.8094.0：上游在 plugin_cache_windows_file_lock 时直接 throw；补丁使其非致命。属 Windows 文件锁竞态，单次跑通不构成必要性证据",
    reverify: "并发启动复现文件锁，或上游自行加入重试",
  }),
  // …其余 36 条同格式
]);
```

- [ ] **Step 4: 加派生导出与查询辅助**

紧接记录数组之后加入：

```js
const DESKTOP_ASAR_PATCH_MARKERS = Object.freeze(
  DESKTOP_ASAR_PATCHES.map((record) => record.marker),
);

const DESKTOP_ASAR_PATCH_BY_MARKER = new Map(
  DESKTOP_ASAR_PATCHES.map((record) => [record.marker, record]),
);

function getPatchRecord(marker) {
  return DESKTOP_ASAR_PATCH_BY_MARKER.get(marker);
}

function patchMarkersByTier(tier) {
  return Object.freeze(
    DESKTOP_ASAR_PATCHES.filter((record) => record.tier === tier).map((record) => record.marker),
  );
}

function patchMarkersByKind(kind) {
  return Object.freeze(
    DESKTOP_ASAR_PATCHES.filter((record) => record.kind === kind).map((record) => record.marker),
  );
}
```

并在 `module.exports` 中追加 `DESKTOP_ASAR_PATCHES`、`getPatchRecord`、`patchMarkersByTier`、`patchMarkersByKind`（保留全部现有导出不变）。

- [ ] **Step 5: 运行新测试确认通过**

```bash
node --test ./scripts/test/patch-contract-records.test.cjs
```

Expected: PASS，5 个测试全绿。

- [ ] **Step 6: 运行全量测试确认零回归**

```bash
node --test './scripts/test/*.test.cjs'
```

Expected: 全部 PASS。若 `offline-ui-gates.test.cjs` 失败，说明派生数组的内容或顺序与原数组不一致——回到 Step 3 逐条比对，不要修改测试。

- [ ] **Step 7: 提交**

```bash
git add web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs scripts/test/patch-contract-records.test.cjs
git commit -m "Carry patch classification and evidence in the capability contract"
```

---

### Task 2: 删除 8 个已证实失效的补丁

**Files:**
- Modify: `web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs`（删除对应记录）
- Modify: `scripts/patch-app-asar.mjs`（删除补丁实现、常量、日志与断言）
- Modify: `scripts/verify-offline-package.ps1`（删除对应 `requiredPatchMarker(...)` 与相关断言）
- Modify: `scripts/desktop-patches/init.cjs`（仅当删除项在其中有引用）
- Test: `scripts/test/patch-contract-records.test.cjs`（追加"已删除项不得回归"用例）

**Interfaces:**
- Consumes: Task 1 的 `DESKTOP_ASAR_PATCHES`、`getPatchRecord`
- Produces: 记录数由 40 减为 32

删除清单（spec 5.1）：

| marker | 依据 |
|---|---|
| `/* codex-offline:windowsStore-patch */` | 运行时 A/B 证实失效 |
| MSIX binding 打桩（无独立 marker，随上一条删除 `MSIX_UPDATER_BINDING_STUB`） | 只为修上一条引发的崩溃 |
| `/*codex-offline:electron-namespace-no-auto-updater*/` | 清理历史补丁的迁移代码 |
| `/*codex-offline:fast-mode-selector*/` | 锚点 `canUseFastMode` / `additionalSpeedTiers` 全包 0 次 |
| `/*codex-offline:fast-mode-service-tier-options*/` | `serviceTiers` 已从 app-primary 消失 |
| `/*codex-offline:context-usage-visible*/` | 锚点 `local-conversation-status-section-visible` 全包 0 次 |
| `/*codex-offline:node-repl-config-reconcile-finally*/` | 补丁器自报 "not needed for this app version" |
| `/*codex-offline:feature-enablement-preserve-unified-exec*/` | 锚点日志串 `Features enabled` 全包 0 次 |

- [ ] **Step 1: 先验证"锚点确实不存在"，避免误删**

对 4 个"锚点消失"类的补丁，在最新原始包上复核。若手头没有 pristine 包，先按 Task 8 Step 1 取一份。

```bash
P=build/verify-903/pristine/app/resources/app.asar
for s in canUseFastMode additionalSpeedTiers local-conversation-status-section-visible "Features enabled"; do
  printf '%-45s %s\n' "$s" "$(grep -ao "$s" "$P" | wc -l)"
done
```

Expected: 四项计数**全为 0**。任一不为 0 则停止，该补丁不属于本任务，改按 Task 3 的规则处理。

- [ ] **Step 2: 写失败测试**

在 `scripts/test/patch-contract-records.test.cjs` 末尾追加：

```js
const REMOVED_MARKERS = [
  "/* codex-offline:windowsStore-patch */",
  "/*codex-offline:electron-namespace-no-auto-updater*/",
  "/*codex-offline:fast-mode-selector*/",
  "/*codex-offline:fast-mode-service-tier-options*/",
  "/*codex-offline:context-usage-visible*/",
  "/*codex-offline:node-repl-config-reconcile-finally*/",
  "/*codex-offline:feature-enablement-preserve-unified-exec*/",
];

test("retired patches are gone from the contract", () => {
  for (const marker of REMOVED_MARKERS) {
    assert.equal(contract.getPatchRecord(marker), undefined, `still present: ${marker}`);
    assert.ok(!contract.DESKTOP_ASAR_PATCH_MARKERS.includes(marker), marker);
  }
});

test("retired patches leave no residue in the patcher or verifier", () => {
  const fsMod = require("node:fs");
  const patcher = fsMod.readFileSync(path.join(repoRoot, "scripts", "patch-app-asar.mjs"), "utf8");
  const verifier = fsMod.readFileSync(
    path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
    "utf8",
  );
  for (const marker of REMOVED_MARKERS) {
    const slug = marker.replace(/\/\*\s?|\s?\*\//g, "");
    assert.ok(!patcher.includes(slug), `patch-app-asar.mjs still references ${slug}`);
    assert.ok(!verifier.includes(slug), `verify-offline-package.ps1 still references ${slug}`);
  }
  assert.ok(
    !patcher.includes("MSIX_UPDATER_BINDING_STUB"),
    "MSIX updater stub should be gone with the windowsStore patch",
  );
  assert.ok(
    !patcher.includes("process.windowsStore=true"),
    "windowsStore injection should be gone",
  );
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test ./scripts/test/patch-contract-records.test.cjs
```

Expected: FAIL —— 两个新用例报"still present"。

- [ ] **Step 4: 从契约删除 7 条记录**

删掉上表中 7 个有 marker 的记录（MSIX 打桩无 marker，不在契约中）。

- [ ] **Step 5: 从补丁器删除实现**

在 `scripts/patch-app-asar.mjs` 中删除：

1. `PATCH_MARKER`、`MSIX_UPDATER_BINDING_STUB`、`PATCH_SNIPPET` 中的 `windowsStore` 行与打桩片段、`refreshMainEntryPatch` 里对应的注入分支。`PATCH_SNIPPET` 保留 `COMPUTER_USE_ENV_DEFAULT`、`EPIPE_GUARD`、`PATCH_BOOTSTRAP_REQUIRE` 三段，其结果应等价于：

```js
const PATCH_SNIPPET = `${COMPUTER_USE_ENV_DEFAULT}${EPIPE_GUARD}${PATCH_BOOTSTRAP_REQUIRE}`;
```

2. `LEGACY_ELECTRON_NAMESPACE_PATCH_MARKER`、`electronNamespaceLegacyRe` 及其整个 `for (const filePath of mainBundleFiles)` 恢复循环。
3. `FAST_MODE_CONTRACT.selectorPatchMarker` / `serviceTierOptionsPatchMarker` 相关的常量、正则（`FAST_MODE_GATE_RE`、`FAST_MODE_AVAILABILITY_RE`、`FAST_MODE_SERVICE_TIER_GET_RE`、`FAST_MODE_SERVICE_TIER_OPTIONS_RE`、`FAST_MODE_FAST_TIER_RE`）与应用分支。**保留** `fast-mode-auth-method` 的全部实现。
4. `CONTEXT_USAGE_CONTRACT` 相关的常量与分支。
5. `NODE_REPL_CONFIG_RECONCILE_FINALLY_PATCH_MARKER`、`NODE_REPL_CONFIG_RECONCILE_FINAL_STEP*` 常量与分支。
6. `FEATURE_ENABLEMENT_PRESERVE_UNIFIED_EXEC_PATCH_MARKER`、`FEATURE_ENABLEMENT_LOCAL_STATE_RE` 与分支。

同时删除 `capabilityContractData.cjs` 中已无消费方的 `CONTEXT_USAGE_CONTRACT`，并从 `FAST_MODE_CONTRACT` 移除 `selectorPatchMarker`、`serviceTierOptionsPatchMarker`、`availabilityMarkers` 三个字段。

- [ ] **Step 6: 从验证脚本删除断言**

在 `scripts/verify-offline-package.ps1` 中删除这 7 个 marker 的 `requiredPatchMarker(...)` 常量及其所有使用点，包括 `PATCH_MARKER`（windowsStore）相关的"已打补丁"判定。

- [ ] **Step 7: 运行测试确认通过**

```bash
node --test './scripts/test/*.test.cjs'
```

Expected: 全部 PASS。`offline-ui-gates.test.cjs` 若因断言这些 marker 而失败，一并删除其中对应断言——它们断言的是已删除的补丁。

- [ ] **Step 8: 语法自检**

```bash
node --check ./scripts/patch-app-asar.mjs
pwsh -NoProfile -Command "\$null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path './scripts/verify-offline-package.ps1'), [ref]\$null, [ref]\$errs); if (\$errs) { \$errs; exit 1 }"
```

Expected: 两条都无输出、退出码 0。

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "Drop desktop patches that no longer affect the current Store bundle"
```

---

### Task 3: 定位并处理 3 个未落地的补丁

**Files:**
- Modify: `web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs`
- Modify: `scripts/patch-app-asar.mjs`
- Modify: `scripts/verify-offline-package.ps1`
- Test: `scripts/test/patch-contract-records.test.cjs`

**Interfaces:**
- Consumes: Task 2 后的 32 条记录
- Produces: 记录数视判定结果减少 0–4 条；每条留下的记录 `evidence` 必须写明为何未落地

目标：`computer-use-plugin-root-fallback`、`computer-use-input-mention`、`computer-use-input-mention-v2`、`unified-plugins-page`。

**判定规则**（spec 5.2）：
1. 匹配式在最新原始包中**无任何匹配** → 删除，按 Task 2 的方式清理三处引用。
2. 有匹配但补丁器走了**别的分支**（例如 `computer-use-plugin-root-fallback` 的 V3 分支实际插入的是 `computer-use-resource-runtime-paths` 的 marker）→ 删除该冗余 marker，把它的语义并入实际生效分支的记录，并在该记录的 `evidence` 中说明。
3. 匹配成功却未应用 → 属补丁器缺陷，修复分支逻辑使其正确落地。

- [ ] **Step 1: 逐个定位**

对每个 marker，在 `scripts/patch-app-asar.mjs` 中找到它的全部出现位置，判断它属于哪条分支；再在最新原始包中测试该分支的匹配式。

```bash
for m in computer-use-plugin-root-fallback computer-use-input-mention unified-plugins-page; do
  echo "===== $m ====="
  grep -n "$m" scripts/patch-app-asar.mjs
done
```

把每个 marker 归入规则 1/2/3 之一，并记录依据。

- [ ] **Step 2: 写失败测试**

对判定为"删除"的 marker，追加到 Task 2 的 `REMOVED_MARKERS` 数组；对判定为"合并"的，写一条断言其记录已消失、且承接方记录的 `evidence` 提到它：

```js
test("merged markers point at the branch that actually applies", () => {
  const survivor = contract.getPatchRecord(
    "/*codex-offline:computer-use-resource-runtime-paths*/",
  );
  assert.ok(survivor, "survivor record must exist");
  assert.match(survivor.evidence, /plugin-root-fallback/);
});
```

（若 Step 1 判定 `computer-use-plugin-root-fallback` 不属于规则 2，改写这条断言以匹配实际判定，不要保留不成立的用例。）

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test ./scripts/test/patch-contract-records.test.cjs
```

Expected: FAIL。

- [ ] **Step 4: 按判定实施**

按规则 1/2/3 分别处理：删除记录与实现、合并到承接分支、或修复分支逻辑。

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test './scripts/test/*.test.cjs'
node --check ./scripts/patch-app-asar.mjs
```

Expected: 全绿、无语法错误。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "Resolve patches that never land on the current Store bundle"
```

---

### Task 4: 构建保证 pristine 源副本

**必须先于 Task 5。** Task 5 让补丁器拒绝已打补丁的输入；实测本地 `build/work/source-app` 的 asar 已带 marker，先做 Task 5 会让本地重建直接失败。

**Files:**
- Modify: `scripts/build-offline-package.ps1`（源导出与 stage 拷贝处，`$sourceExportRoot` 附近，约 `:1029`）
- Test: `scripts/test/pristine-source-guard.test.cjs`（新建）

**Interfaces:**
- Consumes: 无
- Produces: 构建脚本中新增函数 `Assert-PristineAppSource -AppDir <string>`，在把源拷贝到 stage **之前**调用；发现 marker 时 `throw`。

- [ ] **Step 1: 写失败测试**

新建 `scripts/test/pristine-source-guard.test.cjs`：

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const buildScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "build-offline-package.ps1"),
  "utf8",
);

test("build script defines a pristine source guard", () => {
  assert.match(buildScript, /function\s+Assert-PristineAppSource/);
});

test("the guard looks for codex-offline markers in app.asar", () => {
  const start = buildScript.indexOf("function Assert-PristineAppSource");
  assert.notEqual(start, -1);
  const body = buildScript.slice(start, start + 1600);
  assert.match(body, /app\.asar/);
  assert.match(body, /codex-offline/);
  assert.match(body, /throw/);
});

test("the guard runs before the source is staged", () => {
  const guardCall = buildScript.indexOf("Assert-PristineAppSource -AppDir");
  const stageCopy = buildScript.indexOf("--source-app");
  assert.notEqual(guardCall, -1, "guard is never called");
  assert.notEqual(stageCopy, -1);
  assert.ok(guardCall < stageCopy, "guard must run before the patcher is invoked");
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test ./scripts/test/pristine-source-guard.test.cjs
```

Expected: FAIL —— 第一个用例找不到 `Assert-PristineAppSource`。

- [ ] **Step 3: 在构建脚本中加入守卫**

在 `scripts/build-offline-package.ps1` 的函数区加入：

```powershell
function Assert-PristineAppSource {
  param([Parameter(Mandatory = $true)][string]$AppDir)

  $asarPath = Join-Path $AppDir 'resources/app.asar'
  if (-not (Test-Path -LiteralPath $asarPath)) {
    throw "Pristine source check: app.asar not found at $asarPath"
  }

  $marker = [System.Text.Encoding]::ASCII.GetBytes('codex-offline:')
  $stream = [System.IO.File]::OpenRead($asarPath)
  try {
    $buffer = New-Object byte[] (1MB)
    $tail = New-Object byte[] 0
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $window = New-Object byte[] ($tail.Length + $read)
      [Array]::Copy($tail, 0, $window, 0, $tail.Length)
      [Array]::Copy($buffer, 0, $window, $tail.Length, $read)
      $text = [System.Text.Encoding]::ASCII.GetString($window)
      if ($text.Contains('codex-offline:')) {
        throw "Pristine source check failed: $asarPath already contains codex-offline patch markers. The patcher only accepts an unpatched Store payload; re-extract the source bundle."
      }
      $keep = [Math]::Min($window.Length, $marker.Length)
      $tail = New-Object byte[] $keep
      [Array]::Copy($window, $window.Length - $keep, $tail, 0, $keep)
    }
  } finally {
    $stream.Dispose()
  }
}
```

在源导出完成、拷贝到 stage 之前调用：

```powershell
Assert-PristineAppSource -AppDir (Join-Path $sourceExportRoot 'app')
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test ./scripts/test/pristine-source-guard.test.cjs
```

Expected: PASS，3 个用例全绿。

- [ ] **Step 5: 用真实数据验证守卫两个方向都对**

```bash
pwsh -NoProfile -Command ". ./scripts/build-offline-package.ps1 -WhatIf 2>\$null; Assert-PristineAppSource -AppDir './build/verify-903/pristine/app'"
```

Expected: 无输出（干净载荷通过）。

```bash
pwsh -NoProfile -Command ". ./scripts/build-offline-package.ps1 -WhatIf 2>\$null; Assert-PristineAppSource -AppDir './build/verify-903/patch-run2'"
```

Expected: 抛错，信息含 "already contains codex-offline patch markers"。

若 `build-offline-package.ps1` 无法被 dot-source（顶层有立即执行代码），改为把该函数临时复制到一个 `.ps1` 文件中执行同样两条断言。

- [ ] **Step 6: 清理被污染的本地源缓存**

```bash
rm -rf build/work/source-app
```

（下次构建会重新提取。）

- [ ] **Step 7: 提交**

```bash
git add scripts/build-offline-package.ps1 scripts/test/pristine-source-guard.test.cjs
git commit -m "Require an unpatched Store payload before staging"
```

---

### Task 5: 补丁器拒绝已打补丁的输入并删除幂等分支

**Files:**
- Modify: `scripts/patch-app-asar.mjs`（入口 `Main` 区约 `:1941` 之后；以及全部 `already patched` / `alreadyCorrect` 分支）
- Test: `scripts/test/patcher-rejects-patched-input.test.cjs`（新建）

**Interfaces:**
- Consumes: Task 4 的构建守卫（保证正常流程下输入总是干净的）
- Produces: 补丁器新增导出无；行为上，输入含 marker 时以非零码退出并打印明确原因。

- [ ] **Step 1: 写失败测试**

新建 `scripts/test/patcher-rejects-patched-input.test.cjs`：

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(repoRoot, "scripts", "patch-app-asar.mjs"), "utf8");

test("the patcher refuses an already-patched asar", () => {
  assert.match(source, /assertPristineAsar/);
  const start = source.indexOf("function assertPristineAsar");
  assert.notEqual(start, -1);
  const body = source.slice(start, start + 900);
  assert.match(body, /codex-offline:/);
  assert.match(body, /throw new Error/);
});

test("idempotency branches are gone", () => {
  const alreadyPatched = source.match(/already patched/g) ?? [];
  assert.equal(
    alreadyPatched.length,
    0,
    `patcher still has ${alreadyPatched.length} "already patched" branches`,
  );
  assert.ok(!source.includes("refreshMainEntryPatch"), "refreshMainEntryPatch should be gone");
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test ./scripts/test/patcher-rejects-patched-input.test.cjs
```

Expected: FAIL —— 找不到 `assertPristineAsar`，且 `already patched` 计数远大于 0。

- [ ] **Step 3: 加入入口断言**

在 `scripts/patch-app-asar.mjs` 的辅助函数区加入：

```js
function assertPristineAsar(asarPath) {
  const contents = fs.readFileSync(asarPath);
  const index = contents.indexOf('codex-offline:', 0, 'utf8');
  if (index !== -1) {
    throw new Error(
      `${asarPath} already contains codex-offline patch markers. ` +
      'This patcher only accepts an unpatched Store payload; re-extract the source bundle.',
    );
  }
}
```

在 `log(\`Patching: ${asarPath}\`)` 之后、`Extracting asar…` 之前调用 `assertPristineAsar(asarPath);`。

- [ ] **Step 4: 删除幂等分支**

删除 `refreshMainEntryPatch` 函数及其调用点，并逐个删除 88 处 `already patched` / `alreadyCorrect` 分支。删除时对每个补丁保留唯一一条路径：匹配成功则应用，匹配失败则按 `tier` 走 `failRequiredPatch()` 或 `warn()`。

不要连带删除 `alreadyCorrect` **返回值本身**被上层用于日志的场景——把这类返回值一并简化为布尔 `patched`。

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test ./scripts/test/patcher-rejects-patched-input.test.cjs
node --check ./scripts/patch-app-asar.mjs
```

Expected: PASS、无语法错误。

- [ ] **Step 6: 用真实包验证两个方向**

```bash
node scripts/patch-app-asar.mjs --app-dir "$(pwd)/build/verify-903/patch-run2" 2>&1 | tail -3
```

Expected: 报错退出，信息含 "already contains codex-offline patch markers"。

```bash
rm -rf build/verify-903/task5-check
powershell -NoProfile -Command "robocopy 'build/verify-903/pristine/app' 'build/verify-903/task5-check' /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null; exit 0"
node scripts/patch-app-asar.mjs --app-dir "$(pwd)/build/verify-903/task5-check" 2>&1 | tail -5
```

Expected: 正常打完，末行 `Done.`，且 drift summary 为 `all patches applied`。

- [ ] **Step 7: 提交**

```bash
git add scripts/patch-app-asar.mjs scripts/test/patcher-rejects-patched-input.test.cjs
git commit -m "Accept only a pristine asar and drop the re-patch path"
```

---

### Task 6: 删除多形态兼容变体

**Files:**
- Modify: `scripts/patch-app-asar.mjs`
- Test: `scripts/test/patcher-single-shape.test.cjs`（新建）

**Interfaces:**
- Consumes: Task 5 后的单路径补丁器
- Produces: 每个补丁只保留一个匹配式

- [ ] **Step 1: 写失败测试**

新建 `scripts/test/patcher-single-shape.test.cjs`：

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(repoRoot, "scripts", "patch-app-asar.mjs"), "utf8");

test("no historical shape variants remain", () => {
  const variants = source.match(/_RE_V\d|_V\d_RE|LEGACY_[A-Z_0-9]+/g) ?? [];
  assert.deepEqual([...new Set(variants)], [], `variant constants left: ${[...new Set(variants)]}`);
});

test("the patcher documents the single-shape rule", () => {
  assert.match(source, /only the shape used by the current Store payload/i);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test ./scripts/test/patcher-single-shape.test.cjs
```

Expected: FAIL —— 列出残留的变体常量（改动前约 42 个）。

- [ ] **Step 3: 逐个补丁保留匹配当前包的那一个形态**

对每个含多形态的补丁：在最新原始包上确认哪个匹配式实际命中，删除其余的常量与分支。

判定命中与否的做法：在删除前先跑一次 Task 8 Step 2 的构建，确认该补丁仍在日志中报告"applied"；删除其余分支后再跑一次，结果必须一致。

`_CURRENT_RE` 命名在只剩一个形态后失去意义，一并去掉 `_CURRENT` 中缀。

- [ ] **Step 4: 更新补丁器头部的加固原则**

把现有那条原则改写为明确规则，使测试的第二个用例通过：

```
 *   - Single shape. Keep only the shape used by the current Store payload.
 *     When an upstream bundle changes, the patch fails closed and is rewritten
 *     against the new shape — never extended with an additional variant.
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test './scripts/test/*.test.cjs'
node --check ./scripts/patch-app-asar.mjs
```

Expected: 全绿。

- [ ] **Step 6: 对真实包回归**

```bash
rm -rf build/verify-903/task6-check
powershell -NoProfile -Command "robocopy 'build/verify-903/pristine/app' 'build/verify-903/task6-check' /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null; exit 0"
node scripts/patch-app-asar.mjs --app-dir "$(pwd)/build/verify-903/task6-check" 2>&1 | tail -6
```

Expected: `Patch drift summary: all patches applied`，且与 Task 5 Step 6 的补丁应用清单逐条一致。

- [ ] **Step 7: 提交**

```bash
git add scripts/patch-app-asar.mjs scripts/test/patcher-single-shape.test.cjs
git commit -m "Keep one shape per patch and fail closed on drift"
```

---

### Task 7: 验证脚本从契约派生断言与分级

**Files:**
- Modify: `scripts/verify-offline-package.ps1`（内嵌 JS 区，约 `:1320-1530`）
- Modify: `web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs`（把可做反向断言的记录改为 `assert:'negative'`，并纳入 3 个契约外 marker + 无 marker 的 i18n 补丁）
- Test: `scripts/test/verify-contract-driven.test.cjs`（新建）

**Interfaces:**
- Consumes: Task 1 的 `patchMarkersByTier` / `getPatchRecord`
- Produces: 验证脚本中 `requiredPatchMarker()` 被 `patchAssertion(marker)` 取代，后者返回 `{ marker, tier, assert }`

- [ ] **Step 1: 写失败测试**

新建 `scripts/test/verify-contract-driven.test.cjs`：

```js
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const contract = require(path.join(
  repoRoot,
  "web-gateway",
  "gateway",
  "src",
  "ipc",
  "codex",
  "capabilityContractData.cjs",
));
const verifier = fs.readFileSync(
  path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
  "utf8",
);

test("the verifier reads tier from the contract instead of hardcoding", () => {
  assert.match(verifier, /patchMarkersByTier/);
  assert.ok(
    !verifier.includes("'/*codex-offline:stdio-write-error-guard-v2*/'"),
    "stdio guard marker should come from the contract, not a literal",
  );
});

test("previously undeclared markers are now in the contract", () => {
  for (const marker of [
    "/*codex-offline:settings-route-map*/",
    "/*codex-offline:locale-source-default*/",
    "/*codex-offline:stdio-write-error-guard-v2*/",
  ]) {
    assert.ok(contract.getPatchRecord(marker), `missing from contract: ${marker}`);
  }
});

test("degraded patches do not fail the verifier", () => {
  const degraded = contract.patchMarkersByTier("degraded");
  assert.ok(degraded.length > 0);
  assert.match(verifier, /degraded/i);
});

test("patches that can assert negatively do so", () => {
  const negative = contract.DESKTOP_ASAR_PATCHES.filter((r) => r.assert === "negative");
  assert.ok(negative.length >= 2, "locale-source-default and settings-route-map at minimum");
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test ./scripts/test/verify-contract-driven.test.cjs
```

Expected: FAIL —— 4 个用例都不通过。

- [ ] **Step 3: 把 4 个游离补丁纳入契约**

为 `settings-route-map`、`locale-source-default`、`stdio-write-error-guard-v2` 各加一条记录。`enable_i18n` 补丁当前无 marker，为其新增 marker `/*codex-offline:i18n-default-enabled*/`（同时在补丁器的替换串中插入该 marker），记录 `assert:'negative'`、反向断言为 `.get(\`enable_i18n\`,!1)` 不再出现。

`locale-source-default` 与 `settings-route-map` 记录 `assert:'negative'`，反向断言分别为 `LOCALE_SOURCE_BAD_PATTERN` 与 `SETTINGS_ROUTE_BAD_PATTERN_RE` 不再匹配——这两条断言验证脚本里已经有了，本步只是把它们的归属写进契约。

- [ ] **Step 4: 改造验证脚本**

用下面的函数取代 `requiredPatchMarker`：

```js
function patchAssertion(marker) {
  const record = capabilityContract.getPatchRecord(marker);
  if (!record) {
    throw new Error(`Capability contract is missing app.asar patch marker: ${marker}`);
  }
  return record;
}
```

断言执行处按 `record.assert` 分派：`marker` 断言存在、`absent` 断言不存在、`negative` 走各自已有的坏形态正则。失败时按 `record.tier` 决定：`required` 计入失败列表，`degraded` 计入告警列表并在末尾单列打印。

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test './scripts/test/*.test.cjs'
```

Expected: 全绿。

- [ ] **Step 6: PowerShell 语法自检**

```bash
pwsh -NoProfile -Command "\$errs = \$null; \$null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path './scripts/verify-offline-package.ps1'), [ref]\$null, [ref]\$errs); if (\$errs) { \$errs; exit 1 }"
```

Expected: 无输出、退出码 0。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "Drive package verification from the patch contract"
```

---

### Task 8: 全量构建与端到端回归

**Files:**
- 无代码改动；失败时回到对应任务修复

**Interfaces:**
- Consumes: Task 1–7 全部产物
- Produces: 一份对最新 Store bundle 构建并验证通过的离线包

- [ ] **Step 1: 取一份最新原始包（若尚无）**

```bash
node scripts/resolve-store-bundle-url.mjs --package-family-name OpenAI.Codex_2p2nqsd0c76g0
```

按输出的 x64 `href` 下载到 `build/verify-903/`，用输出中的 `sha1` 校验后解压到 `build/verify-903/pristine/`。**复制载荷一律用 robocopy 并校验哈希**——`cp -r` 会静默损坏大二进制（`codex.exe` 大小相同但 SHA1 不同，导致 app-server `spawn UNKNOWN`）。

- [ ] **Step 2: 全量构建**

```bash
pwsh -NoProfile -File ./scripts/build-offline-package.ps1 -SkipInstaller -MetadataOutputPath ./build/tmp/boundary-build-metadata.json
```

Expected: 成功，且日志中不出现任何 `already patched`。

- [ ] **Step 3: 包验证**

```bash
pwsh -NoProfile -File ./scripts/verify-offline-package.ps1 -BuildMetadataPath ./build/tmp/boundary-build-metadata.json
```

Expected: 通过；`degraded` 的 9 项若缺失只出现在告警汇总里，不导致失败。

- [ ] **Step 4: 离线直启回归**

```bash
node scripts/offline-direct-launch-smoke.mjs --portable-root "<第 2 步产出的便携包根目录>" --timeout-ms 45000
```

Expected: `"pass": true`，`sawAppServerReady` 与 `sawWindowReady` 均为 `true`。**这一步直接验证 Task 2 删除 windowsStore 链后启动仍正常。**

- [ ] **Step 5: 记录本轮基线**

在 `CHANGELOG.md` 顶部追加一条，写明本次重划删除了哪些补丁、哪些降级为 `degraded`、以及验证所用的 Store 版本号。

- [ ] **Step 6: 提交**

```bash
git add CHANGELOG.md
git commit -m "Record the patch boundary redesign baseline"
```

---

## 自查记录

- **spec 覆盖**：4.1→Task 1；4.2→Task 1 + Task 7 Step 3；4.3→Task 5、Task 6；4.4→Task 7；4.5→Task 4；5.1→Task 2；5.2→Task 3；5.3/5.4/5.5→Task 1 Step 3 的分类；第 6 节迁移顺序→Task 1–8（已按依赖把构建前提提前到 Task 4，先于补丁器入口断言）；第 8 节排除项未安排任务，符合设计。
- **类型一致性**：`getPatchRecord` / `patchMarkersByTier` / `patchMarkersByKind` 在 Task 1 定义，Task 2、3、7 沿用同名同签名；`assertPristineAsar`（Node）与 `Assert-PristineAppSource`（PowerShell）分属两个运行时，命名刻意区分。
- **已知偏离**：Task 1 保持 `DESKTOP_ASAR_PATCH_MARKERS` 含全部 marker，而非 spec 4.1 示例中的"仅 `assert==='marker'`"，理由见 Task 1 说明。
