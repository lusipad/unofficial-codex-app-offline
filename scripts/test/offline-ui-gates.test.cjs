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
  "4039078146": "sidebar activity view",
  "717035860": "sidebar customization and destination discovery",
};
const cloudOnlyGateIds = ["1042620455", "4114442250"];

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

test("offline builds select the unified plugins page instead of the legacy storefront", () => {
  const gateId = "3413548395";
  const patchMarker = "/*codex-offline:unified-plugins-page*/";

  assert.equal(contract.STATSIG_DEFAULT_FEATURE_OVERRIDES[gateId], false);
  assert.equal(contract.DESKTOP_ASAR_KNOWN_GATE_IDS.includes(gateId), false);
  assert.equal(contract.REQUIRED_STATSIG_FEATURE_MARKERS.includes(gateId), false);
  assert.match(initSource, new RegExp(`["']${gateId}["']\\s*:\\s*false`));
  assert.ok(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(patchMarker));
  assert.ok(verifyScriptSource.includes(`requiredPatchMarker('${patchMarker}')`));
  assert.equal(
    patchScriptSource.includes(
      "contractPatchMarker('/*codex-offline:plugins-management-in-skills*/')",
    ),
    false,
  );
});

test("offline builds do not force cloud-only remote connection gates", () => {
  for (const gateId of cloudOnlyGateIds) {
    assert.equal(contract.STATSIG_DEFAULT_FEATURE_OVERRIDES[gateId], undefined, gateId);
    assert.equal(contract.DESKTOP_ASAR_KNOWN_GATE_IDS.includes(gateId), false, gateId);
    assert.doesNotMatch(
      initSource,
      new RegExp(`["']${gateId}["']\\s*:\\s*true`),
      `${gateId}: desktop runtime must preserve the official cloud gate`,
    );
  }
});

test("runtime gate fallback patches custom sessions and asynchronous IPC results", () => {
  assert.match(
    initSource,
    /function setupWebRequestInterceptor\(targetSession\)[\s\S]*targetSession \|\| session\.defaultSession/,
  );
  assert.match(
    initSource,
    /app\.on\('session-created', function \(createdSession\)[\s\S]*setupWebRequestInterceptor\(createdSession\)/,
  );
  assert.match(
    initSource,
    /function patchMaybeAsync\(result, patcher\)[\s\S]*result\.then\(function \(resolved\)/,
  );
  assert.match(
    initSource,
    /statsigConfig\.value\[gateKeys\[j\]\] !== configGateValue/,
    "runtime fallback must overwrite a stale false gate instead of only filling missing keys",
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

test("renderer known gate patch handles direct and second-argument gate calls", () => {
  const functionStart = patchScriptSource.indexOf("function patchDirectStatsigGateCalls");
  const functionEnd = patchScriptSource.indexOf(
    "\nfunction patchOfflineNetworkModeDefaults",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "renderer gate patch helper is missing");
  assert.notEqual(functionEnd, -1, "renderer gate helper terminator is missing");

  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const patchDirectStatsigGateCalls = Function(
    "escapeRegExp",
    `"use strict";\n${helperSource}\nreturn patchDirectStatsigGateCalls;`,
  )(escapeRegExp);

  const patched = patchDirectStatsigGateCalls(
    "u&&e.get(Mg,`533078438`)&&x();v&&Fg(`717035860`)&&y();",
    ["533078438", "717035860"],
    "/*codex-offline:renderer-known-statsig-gates*/",
  );
  assert.equal(patched.count, 2);
  assert.ok(
    patched.content.includes("u&&!0/*codex-offline:renderer-known-statsig-gates*/&&x()"),
  );
  assert.ok(
    patched.content.includes("v&&!0/*codex-offline:renderer-known-statsig-gates*/&&y()"),
  );
});

test("renderer defaults run local queries and mutations while the OS is offline", () => {
  const functionStart = patchScriptSource.indexOf(
    "function patchOfflineNetworkModeDefaults",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\n// end patchOfflineNetworkModeDefaults",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "offline network-mode helper is missing");
  assert.notEqual(functionEnd, -1, "offline network-mode helper terminator is missing");

  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const patchOfflineNetworkModeDefaults = Function(
    "escapeRegExp",
    `"use strict";\n${helperSource}\nreturn patchOfflineNetworkModeDefaults;`,
  )(escapeRegExp);
  const queryMarker = "/*codex-offline:offline-query-network-mode*/";
  const mutationMarker = "/*codex-offline:offline-mutation-network-mode*/";
  const fixture =
    "Gkl={defaultOptions:{queries:{refetchOnWindowFocus:!1,retry:(e,t)=>!1}}}";
  const result = patchOfflineNetworkModeDefaults(fixture, queryMarker, mutationMarker);

  assert.equal(result.seen, true);
  assert.equal(result.patched, true);
  assert.match(
    result.content,
    /mutations:\{networkMode:`always`\/\*codex-offline:offline-mutation-network-mode\*\//,
  );
  assert.match(
    result.content,
    /queries:\{networkMode:`offlineFirst`\/\*codex-offline:offline-query-network-mode\*\//,
  );
  assert.doesNotThrow(() => Function(result.content));

  const secondPass = patchOfflineNetworkModeDefaults(
    result.content,
    queryMarker,
    mutationMarker,
  );
  assert.equal(secondPass.seen, true);
  assert.equal(secondPass.alreadyCorrect, true);
  assert.equal(secondPass.correct, true);
  assert.equal(secondPass.content, result.content);

  const markerOnly = patchOfflineNetworkModeDefaults(
    `const unrelated=true;${queryMarker}${mutationMarker}`,
    queryMarker,
    mutationMarker,
  );
  assert.equal(markerOnly.seen, false);
  assert.equal(markerOnly.correct, false);

  for (const marker of [queryMarker, mutationMarker]) {
    assert.ok(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(marker), marker);
    assert.ok(verifyScriptSource.includes(`requiredPatchMarker('${marker}')`), marker);
  }
});

test("plugin-service fallback no longer patches renderer query functions", () => {
  for (const marker of [
    "/*codex-offline:plugin-query-network-mode*/",
    "/*codex-offline:plugin-cloud-fallback*/",
  ]) {
    assert.equal(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(marker), false, marker);
    assert.equal(
      verifyScriptSource.includes(`requiredPatchMarker('${marker}')`),
      false,
      marker,
    );
  }
  assert.equal(patchScriptSource.includes("function patchOfflinePluginQueries"), false);
  assert.doesNotMatch(patchScriptSource, /\/ps\/plugins\/(?:home|list|workspace)/);
  assert.match(initSource, /require\('\.\/plugin-service-compat\.cjs'\)/);
  assert.match(initSource, /rememberPluginFetch[\s\S]*patchPluginFetchResponse/);
  assert.match(verifyScriptSource, /LEGACY_PLUGIN_RENDERER_PATCH_MARKERS/);
});

test("legacy renderer plugin injections are removed only by owned markers", () => {
  const functionStart = patchScriptSource.indexOf(
    "function removeLegacyOfflinePluginQueryPatches",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\n// end removeLegacyOfflinePluginQueryPatches",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "legacy plugin cleanup helper is missing");
  assert.notEqual(functionEnd, -1, "legacy plugin cleanup terminator is missing");

  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const removeLegacyOfflinePluginQueryPatches = Function(
    `"use strict";\n${helperSource}\nreturn removeLegacyOfflinePluginQueryPatches;`,
  )();
  const original =
    "queryFn:()=>T_.safeGet(`/ps/plugins/home`),retry:!1,staleTime:vm.ONE_MINUTE";
  const legacy =
    "queryFn:()=>T_.safeGet(`/ps/plugins/home`)" +
    ".catch(e=>globalThis.navigator?.onLine===!1?({sections:[]}):Promise.reject(e))" +
    "/*codex-offline:plugin-cloud-fallback*/" +
    "/*codex-offline:plugin-fallback-surface:cloud-home*/,retry:!1," +
    "networkMode:`always`/*codex-offline:plugin-query-network-mode*/" +
    "/*codex-offline:plugin-query-surface:cloud-home*/,staleTime:vm.ONE_MINUTE";
  const result = removeLegacyOfflinePluginQueryPatches(legacy);
  assert.equal(result.removed, 2);
  assert.equal(result.content, original);

  assert.throws(
    () =>
      removeLegacyOfflinePluginQueryPatches(
        "officialCode()/*codex-offline:plugin-cloud-fallback*/" +
          "/*codex-offline:plugin-fallback-surface:cloud-home*/",
      ),
    /unexpected shape/,
  );
});
test("priority surface carries its dedicated static gate marker", () => {
  const functionStart = patchScriptSource.indexOf(
    "function patchSidebarActivitySurface",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\nfunction migrateLegacyPluginsPageSelection",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "sidebar gate helper is missing");
  assert.notEqual(functionEnd, -1, "sidebar gate helper terminator is missing");

  const sidebarMarker = "/*codex-offline:sidebar-activity-view*/";
  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const patchSidebarActivitySurface = Function(
    "SIDEBAR_ACTIVITY_VIEW_PATCH_MARKER",
    "escapeRegExp",
    `"use strict";\n${helperSource}\nreturn patchSidebarActivitySurface;`,
  )(sidebarMarker, escapeRegExp);
  const fixture =
    "function Fvc(){let e=Fg(Lvc),t=q(Sw);return e&&(t.status===`allowed`||t.status===`loading`)}" +
    "Lvc=`4039078146`";
  const result = patchSidebarActivitySurface(fixture);

  assert.equal(result.patched, true);
  assert.equal(result.sidebarSurfaceSeen, true);
  assert.equal(result.sidebarCorrect, true);
  assert.ok(result.content.includes(`e=!0${sidebarMarker},t=q(Sw)`));

  const secondPass = patchSidebarActivitySurface(result.content);
  assert.equal(secondPass.patched, false);
  assert.equal(secondPass.sidebarCorrect, true);

  const markerOnly = patchSidebarActivitySurface(sidebarMarker);
  assert.equal(markerOnly.sidebarSurfaceSeen, false);
  assert.equal(markerOnly.sidebarCorrect, false);

  const currentFixture =
    "function Ivc(){let e=bg(Rvc),t=q(Lw);return e&&(t.status===`allowed`||t.status===`loading`)}" +
    "Rvc=`4039078146`";
  const currentResult = patchSidebarActivitySurface(currentFixture);
  assert.equal(currentResult.patched, true);
  assert.equal(currentResult.sidebarCorrect, true);
  assert.ok(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(sidebarMarker), sidebarMarker);
  assert.ok(verifyScriptSource.includes(`requiredPatchMarker('${sidebarMarker}')`));
});

test("legacy plugin page patches migrate to the unified plugins page", () => {
  const functionStart = patchScriptSource.indexOf(
    "function migrateLegacyPluginsPageSelection",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\nfunction patchWorkspaceDependenciesSettingsGate",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "plugin page migration helper is missing");
  assert.notEqual(functionEnd, -1, "plugin page migration helper terminator is missing");

  const legacyPluginsMarker = "/*codex-offline:plugins-management-in-skills*/";
  const rendererGateMarker = "/*codex-offline:renderer-known-statsig-gates*/";
  const unifiedPluginsMarker = "/*codex-offline:unified-plugins-page*/";
  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const migrateLegacyPluginsPageSelection = Function(
    "LEGACY_PLUGINS_MANAGEMENT_IN_SKILLS_PATCH_MARKER",
    "RENDERER_KNOWN_STATSIG_GATES_PATCH_MARKER",
    "UNIFIED_PLUGINS_PAGE_PATCH_MARKER",
    "escapeRegExp",
    `"use strict";\n${helperSource}\nreturn migrateLegacyPluginsPageSelection;`,
  )(
    legacyPluginsMarker,
    rendererGateMarker,
    unifiedPluginsMarker,
    escapeRegExp,
  );
  const fixture =
    "let o=H(dr,a),s=!0/*codex-offline:renderer-known-statsig-gates*/&&" +
    "o===`plugins`&&(r.initialTab===`plugins`||r.initialTab===`skills`);" +
    "function nOc(e,t,n){t&&!0/*codex-offline:plugins-management-in-skills*/" +
    "&&Promise.all([])}";

  const result = migrateLegacyPluginsPageSelection(fixture);
  assert.equal(result.migratedCount, 2);
  assert.equal(result.legacyMarkerResidual, false);
  assert.ok(
    result.content.includes(
      `s=!1${unifiedPluginsMarker}&&o===\`plugins\`&&` +
        "(r.initialTab===`plugins`||r.initialTab===`skills`)",
    ),
  );
  assert.ok(result.content.includes(`t&&!1${unifiedPluginsMarker}&&Promise.all`));

  const secondPass = migrateLegacyPluginsPageSelection(result.content);
  assert.equal(secondPass.migratedCount, 0);
  assert.equal(secondPass.content, result.content);
  assert.equal(secondPass.legacyMarkerResidual, false);

  const runtimeDriven =
    "let o=H(dr,a),s=gt(`3413548395`)&&o===`plugins`&&" +
    "(r.initialTab===`plugins`||r.initialTab===`skills`)";
  const untouched = migrateLegacyPluginsPageSelection(runtimeDriven);
  assert.equal(untouched.migratedCount, 0);
  assert.equal(untouched.content, runtimeDriven);
});

test("renderer gate verifier covers method-style gate reads and scoped alias surfaces", () => {
  assert.ok(
    patchScriptSource.includes('const callablePattern') &&
      patchScriptSource.includes('(?:\\\\.[$\\\\w]+)*'),
    "patcher must recognize method-style gate readers like e.get(...)",
  );
  assert.match(
    verifyScriptSource,
    /secondArgumentStatsigGateCallRe|sidebarActivityUnpatchedSurfaceRe/,
    "verifier must inspect indirect gate call shapes, not only literal direct calls",
  );
  assert.doesNotMatch(
    verifyScriptSource,
    /aliasStatsigGateCallRe/,
    "alias checks must stay scoped to their known surface instead of the full bundle",
  );
});

test("renderer gate verifier always blocks residual indirect gate calls", () => {
  assert.match(
    verifyScriptSource,
    /rendererKnownStatsigGateResiduals\.length > 0/,
    "verifier must fail on indirect residual gate calls",
  );
  assert.match(
    verifyScriptSource,
    /secondArgumentStatsigGateCallRe\(gateId\)\.test\(content\)/,
    "verifier must reject second-argument gate reads that escaped static patching",
  );
  assert.match(
    verifyScriptSource,
    /for \(const gateId of DESKTOP_ASAR_KNOWN_GATE_IDS\) \{\s*if \(!content\.includes\(gateId\)\) continue;/,
    "verifier must skip expensive gate regexes for chunks that do not contain the gate id",
  );
  assert.doesNotMatch(
    verifyScriptSource,
    /if \(!rendererKnownStatsigGatesPatched && rendererKnownStatsigGateLiteralEntries\.length > 0\)/,
    "a global marker must never mask a residual gate call",
  );
  assert.match(
    verifyScriptSource,
    /sidebarActivityPatchedSurfaceRe\.test\(content\)[\s\S]*sidebarActivityViewResiduals/,
    "priority verification must bind the marker to its live surface",
  );
  assert.match(
    verifyScriptSource,
    /offlineNetworkModePatchedSurfaceRe\.test\(content\)[\s\S]*offlineNetworkModeResiduals/,
    "QueryClient verification must reject a stale marker in an unrelated chunk",
  );
});

test("current Fast mode availability falls back after legacy patterns do not match", () => {
  const functionStart = patchScriptSource.indexOf("function patchFastModeAvailability");
  const functionEnd = patchScriptSource.indexOf(
    "\n// end patchFastModeAvailability",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "Fast mode availability patch helper is missing");
  assert.notEqual(functionEnd, -1, "Fast mode availability helper terminator is missing");

  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const patchFastModeAvailability = Function(
    `"use strict";\n${helperSource}\nreturn patchFastModeAvailability;`,
  )();
  const marker = "/*codex-offline:fast-mode-auth-method*/";
  const legacyBundle =
    "function availability(e,t){if(e?.authMethod!==`chatgpt`||t){" +
    "return{canUseFastMode:a,isDisabledByRequirement:t,isLoading:n}}}" +
    "const feature=`fast_mode`;";
  const legacyResult = patchFastModeAvailability(legacyBundle, marker);
  assert.equal(legacyResult.patched, true);
  assert.match(legacyResult.content, new RegExp(`canUseFastMode:!0${escapeRegExp(marker)}`));
  assert.doesNotThrow(() => Function(legacyResult.content));

  const currentBundle =
    "function legacyNoise(e){return e.authMethod!==`chatgpt`}" +
    "function availability(e){let a=e?.authMethod===`chatgpt`," +
    "o=!!e?.isLoading||a&&pending,d=a&&!o&&config!=null&&" +
    "config?.requirements?.featureRequirements?.fast_mode!==!1,f;" +
    "return{isServiceTierAllowed:d,isLoading:o}}";

  const result = patchFastModeAvailability(currentBundle, marker);
  assert.equal(result.patched, true);
  assert.match(result.content, new RegExp(`d=!0${escapeRegExp(marker)}`));
  assert.doesNotThrow(() => Function(result.content));

  const secondPass = patchFastModeAvailability(result.content, marker);
  assert.equal(secondPass.patched, false);
  assert.equal(secondPass.content, result.content);
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
