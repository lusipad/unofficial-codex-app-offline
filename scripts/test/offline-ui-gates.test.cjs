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
const initSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "desktop-patches", "init.cjs"),
  "utf8",
);
const patchScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "patch-app-asar.mjs"),
  "utf8",
);
const verifyScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
  "utf8",
);
const buildScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "build-offline-package.ps1"),
  "utf8",
);
const installerTemplateSource = fs.readFileSync(
  path.join(repoRoot, "installer", "CodexOffline.iss.tpl"),
  "utf8",
);
const webShellBridgeSource = fs.readFileSync(
  path.join(repoRoot, "web-gateway", "web-shell", "codex-bridge-polyfill.js"),
  "utf8",
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const requiredOfflineUiGates = {
  "824038554": "Codex/Work mode selector",
  "2106641128": "experimental features settings",
  "3693343337": "model features settings",
  "3026692602": "workspace dependencies settings",
  "2177625257": "browser history and profile import",
  "3413548395": "plugins management in Skills",
  "717035860": "sidebar customization and destination discovery",
};

test("offline builds force the supported product and navigation UI gates", () => {
  for (const [gateId, label] of Object.entries(requiredOfflineUiGates)) {
    assert.equal(
      contract.STATSIG_DEFAULT_FEATURE_OVERRIDES[gateId],
      true,
      `${label}: runtime contract`,
    );
    assert.ok(
      contract.DESKTOP_ASAR_KNOWN_GATE_IDS.includes(gateId),
      `${label}: asar gate list`,
    );
    assert.ok(
      contract.REQUIRED_STATSIG_FEATURE_MARKERS.includes(gateId),
      `${label}: package verifier markers`,
    );
    assert.match(
      initSource,
      new RegExp(`["']${gateId}["']\\s*:\\s*true`),
      `${label}: desktop runtime injection`,
    );
  }

  const workspaceMarker = "/*codex-offline:workspace-dependencies-settings*/";
  assert.ok(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(workspaceMarker));
  assert.match(
    verifyScriptSource,
    /requiredPatchMarker\('\/\*codex-offline:workspace-dependencies-settings\*\/'\)/,
  );
});

test("web shell verifier requires only markers owned by the bridge", () => {
  for (const marker of contract.REQUIRED_WEB_SHELL_FEATURE_MARKERS) {
    assert.ok(webShellBridgeSource.includes(marker), `web shell marker: ${marker}`);
    assert.equal(
      contract.REQUIRED_STATSIG_FEATURE_MARKERS.includes(marker),
      false,
      `Statsig marker is injected through cfg.capabilities: ${marker}`,
    );
  }
});

test("workspace dependencies settings gate handles imported and prepatched siblings", () => {
  const functionStart = patchScriptSource.indexOf(
    "function patchWorkspaceDependenciesSettingsGate",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\n// end patchWorkspaceDependenciesSettingsGate",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "workspace dependencies patch helper is missing");
  assert.notEqual(functionEnd, -1, "workspace dependencies helper terminator is missing");

  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const patchWorkspaceDependenciesSettingsGate = Function(
    "escapeRegExp",
    `"use strict";\n${helperSource}\nreturn patchWorkspaceDependenciesSettingsGate;`,
  )(escapeRegExp);
  const patchMarker = "/*codex-offline:workspace-dependencies-settings*/";
  const rendererMarker = "/*codex-offline:renderer-known-statsig-gates*/";
  const settingsSurface =
    ",x={defaultMessage:`Workspace Dependencies`,id:`settings.agent.dependencies.sectionTitle`}";

  const raw =
    "function wn(){let i=I(Tt),a=I(`2106641128`),o=I(`3693343337`),s}" +
    settingsSurface;
  const rawResult = patchWorkspaceDependenciesSettingsGate(
    raw,
    patchMarker,
    rendererMarker,
  );
  assert.equal(rawResult.seen, true);
  assert.equal(rawResult.patched, true);
  assert.match(rawResult.content, new RegExp(`i=!0${escapeRegExp(patchMarker)}`));

  const siblingsPrepatched =
    `function wn(){let i=I(Tt),a=!0${rendererMarker},o=!0${rendererMarker},s}` +
    settingsSurface;
  const prepatchedResult = patchWorkspaceDependenciesSettingsGate(
    siblingsPrepatched,
    patchMarker,
    rendererMarker,
  );
  assert.equal(prepatchedResult.patched, true);
  assert.match(prepatchedResult.content, new RegExp(`i=!0${escapeRegExp(patchMarker)}`));

  const secondPass = patchWorkspaceDependenciesSettingsGate(
    prepatchedResult.content,
    patchMarker,
    rendererMarker,
  );
  assert.equal(secondPass.alreadyCorrect, true);
  assert.equal(secondPass.content, prepatchedResult.content);

  const unrelated = patchWorkspaceDependenciesSettingsGate(
    "function x(){let i=I(Tt),a=I(`2106641128`),o=I(`3693343337`)}",
    patchMarker,
    rendererMarker,
  );
  assert.equal(unrelated.seen, false);
  assert.equal(unrelated.content.includes(patchMarker), false);
});

test("ultra reasoning effort stays available for models that already support max", () => {
  const functionStart = patchScriptSource.indexOf(
    "function patchUltraReasoningEffortAvailability",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\n// end patchUltraReasoningEffortAvailability",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "Ultra reasoning effort patch helper is missing");
  assert.notEqual(functionEnd, -1, "Ultra reasoning effort helper terminator is missing");

  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const patchUltraReasoningEffortAvailability = Function(
    '"use strict";\n' +
      "const ULTRA_REASONING_EFFORT_PATCH_MARKER = " +
      "`/*codex-offline:ultra-reasoning-effort*/`;\n" +
      `${helperSource}\nreturn patchUltraReasoningEffortAvailability;`,
  )();
  const fixture =
    "function r({authMethod:e,availableModels:n,defaultModel:r," +
    "enabledReasoningEfforts:i,includeUltraReasoningEffort:a,models:o," +
    "useHiddenModels:s}){let c=[],l=null,u=s&&e!==`amazonBedrock`," +
    "d=o.some(e=>e.supportedReasoningEfforts.some(({reasoningEffort:e})=>" +
    "e===`max`)),f=a&&o.some(e=>e.supportedReasoningEfforts.some(" +
    "({reasoningEffort:e})=>e===`ultra`));return o.forEach(r=>{" +
    "if(u?n.has(r.model):!r.hidden){let n=a?r.supportedReasoningEfforts:" +
    "r.supportedReasoningEfforts.filter(({reasoningEffort:e})=>" +
    "e!==`ultra`),o=n.filter(({reasoningEffort:e})=>t(e)&&i.has(e))," +
    "s={...r,supportedReasoningEfforts:o};c.push(s),r.isDefault&&(l=s)}})," +
    "l??=c.find(e=>e.model===r)??null,{models:c,defaultModel:l," +
    "hasModelSupportingMaxReasoningEffort:d," +
    "hasModelSupportingUltraReasoningEffort:f}}";

  const patched = patchUltraReasoningEffortAvailability(fixture);
  assert.equal(patched.seen, true);
  assert.equal(patched.patched, true);
  assert.match(patched.content, /\/\*codex-offline:ultra-reasoning-effort\*\//);
  assert.match(
    patched.content,
    /reasoningEffort:`ultra`,description:`ultra effort`/,
  );

  const filterModels = Function(
    "t",
    `"use strict";${patched.content};return r;`,
  )((effort) => ["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort));
  const result = filterModels({
    authMethod: "apiKey",
    availableModels: new Set(),
    defaultModel: "gpt-test",
    enabledReasoningEfforts: new Set(["max", "ultra"]),
    includeUltraReasoningEffort: false,
    models: [
      {
        model: "gpt-test",
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: "max", description: "max effort" },
        ],
      },
    ],
    useHiddenModels: false,
  });
  assert.equal(result.hasModelSupportingMaxReasoningEffort, true);
  assert.equal(result.hasModelSupportingUltraReasoningEffort, true);
  assert.deepEqual(
    result.models[0].supportedReasoningEfforts.map((item) => item.reasoningEffort),
    ["max", "ultra"],
  );

  const secondPass = patchUltraReasoningEffortAvailability(patched.content);
  assert.equal(secondPass.alreadyCorrect, true);
  assert.equal(secondPass.content, patched.content);

  const marker = "/*codex-offline:ultra-reasoning-effort*/";
  const markerOnly = patchUltraReasoningEffortAvailability(fixture + marker);
  assert.equal(markerOnly.alreadyCorrect, false);
  assert.equal(markerOnly.patched, false);
  assert.ok(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(marker));
  assert.match(
    verifyScriptSource,
    /requiredPatchMarker\('\/\*codex-offline:ultra-reasoning-effort\*\/'\)/,
  );
  assert.match(verifyScriptSource, /ultraReasoningEffortResiduals/);
});

test("installer Chinese task labels are read and emitted as explicit UTF-8", () => {
  const chineseMessages = [
    "zh.TaskSkills=安装默认离线技能（大部分技能需要联网，离线环境下无法使用）",
    "zh.TaskChromeHost=注册 @chrome 本机桥接",
    "zh.TaskCodexLinks=注册用于 CLI /app 的 codex:// 链接",
    "zh.TaskAppShim=安装 CLI /app 的 PowerShell shim（会覆盖 Get-AppxPackage 命令，可能与已安装的商店版 Codex Desktop 冲突）",
    "zh.TaskComputerUse=修复 Computer Use 插件布局",
    "zh.TaskChromeGuide=打开 Chrome 扩展设置引导",
    "zh.LaunchCodex=启动 Codex",
  ];

  assert.doesNotMatch(installerTemplateSource, /\uFFFD/);
  for (const message of chineseMessages) {
    assert.ok(installerTemplateSource.includes(message), `template: ${message}`);
    assert.ok(buildScriptSource.includes(message), `builder assertion: ${message}`);
    assert.ok(verifyScriptSource.includes(message), `package verifier: ${message}`);
  }
  assert.match(buildScriptSource, /\[System\.IO\.File\]::ReadAllText/);
  assert.match(buildScriptSource, /\[System\.IO\.File\]::WriteAllText/);
  assert.match(buildScriptSource, /System\.Text\.UTF8Encoding/);
  assert.match(verifyScriptSource, /\[System\.IO\.File\]::ReadAllText/);
  assert.match(verifyScriptSource, /System\.Text\.UTF8Encoding/);
});
