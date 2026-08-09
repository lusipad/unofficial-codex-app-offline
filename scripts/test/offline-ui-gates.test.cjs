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
    "\nfunction patchOfflinePluginQueries",
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
    "u&&e.get(Mg,`3413548395`)&&x();v&&Fg(`717035860`)&&y();",
    ["3413548395", "717035860"],
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

test("offline plugin queries force local IPC online and cloud plugin views degrade gracefully", async () => {
  const functionStart = patchScriptSource.indexOf("function patchOfflinePluginQueries");
  const functionEnd = patchScriptSource.indexOf(
    "\nfunction patchWorkspaceDependenciesSettingsGate",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "offline plugin query patch helper is missing");
  assert.notEqual(functionEnd, -1, "offline plugin query helper terminator is missing");

  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const patchOfflinePluginQueries = Function(
    "PLUGIN_QUERY_NETWORK_MODE_PATCH_MARKER",
    "PLUGIN_CLOUD_FALLBACK_PATCH_MARKER",
    `"use strict";\n${helperSource}\nreturn patchOfflinePluginQueries;`,
  )(
    "/*codex-offline:plugin-query-network-mode*/",
    "/*codex-offline:plugin-cloud-fallback*/",
  );

  const fixture =
    "queryKey:[...mL,`local`,e,s],queryFn:async()=>{let{featuredPluginIds:t,marketplaces:r}=await _m(`list-plugins`,{hostId:e,...s.length>0?{cwds:s}:{},marketplaceKinds:[`local`]});return{featuredPluginIds:t,plugins:await fii({hostId:e,plugins:pL(r),queryClient:n})}},retry:!1,staleTime:ym.ONE_MINUTE;" +
    "Mii=Oa(Q,({buildFlavor:e,hostId:t,installSuggestionPluginNames:n,isOpenAICuratedRemoteMarketplaceEnabled:r,marketplaceKinds:i,roots:a,shouldHideOpenAICuratedMarketplaces:o},{queryClient:s})=>{let c=Yri({isOpenAICuratedRemoteMarketplaceEnabled:r,shouldHideOpenAICuratedMarketplaces:o}),l=n==null?qri(t,a,i,r,o):Wri(t,a,Cii,n,r,o);return{queryKey:l,queryFn:async()=>{if(n!=null){let e=await _m(`send-cli-request-for-host`,{hostId:t,method:`plugin/installed`,params:{...a.length>0?{cwds:a}:{},installSuggestionPluginNames:n}}),r=Xri(e.marketplaces,c),i=pL(r,s.getQueryData(l)?.plugins);return{featuredPluginIds:xii,marketplaceLoadErrors:e.marketplaceLoadErrors,marketplaces:dii(r),plugins:await fii({hostId:t,plugins:i,queryClient:s})}}let r=await _m(`list-plugins`,i==null?{hostId:t,...a.length>0?{cwds:a}:{},forceRefetch:bii.has(t)||void 0}:{hostId:t,...a.length>0?{cwds:a}:{},marketplaceKinds:i,forceRefetch:bii.has(t)||void 0}),o=Xri(r.marketplaces,c),u=pL(o,s.getQueryData(l)?.plugins),d=e==null?u:cii({buildFlavor:e,plugins:u}),f=Rri(r.featuredPluginIds).filter(e=>!c.some(t=>e.endsWith(`@${t}`)));return{featuredPluginIds:e==null?f:sii({buildFlavor:e,featuredPluginIds:f}),marketplaceLoadErrors:r.marketplaceLoadErrors,marketplaces:dii(o),plugins:await fii({hostId:t,plugins:d,queryClient:s})}},staleTime:ym.SIX_HOURS,gcTime:1/0}});" +
    "Nii=Oa(Q,({hostId:e,marketplaceKind:t},{queryClient:n})=>{let r=[...mL,`marketplace-kind`,e,t];return{queryKey:r,queryFn:async()=>fii({hostId:e,plugins:pL((await _m(`list-plugins`,{hostId:e,marketplaceKinds:[t],forceRefetch:bii.has(e)||void 0})).marketplaces,n.getQueryData(r)),queryClient:n}),staleTime:ym.SIX_HOURS}});" +
    "xDc=Oa(Q,e=>({queryKey:[...mL,`home`,e],queryFn:()=>K_.safeGet(`/ps/plugins/home`),retry:!1,staleTime:ym.ONE_MINUTE}));" +
    "mi=Xe(Zt,({hostId:e,source:t})=>({queryFn:({signal:e})=>{let n={limit:9};switch(t){case`user`:return yt.safeGet(`/ps/plugins/list`,{parameters:{query:{scope:`USER`,...n}},signal:e});case`workspace-created`:return yt.safeGet(`/ps/plugins/workspace/created`,{parameters:{query:n},signal:e});case`workspace-shared`:return yt.safeGet(`/ps/plugins/workspace/shared`,{parameters:{query:n},signal:e})}},queryKey:[...Ct,`personal`,t,e],retry:!1,select:e=>e.plugins,staleTime:Be.ONE_MINUTE}));" +
    "Ti=d(Zt,e=>({getNextPageParam:e=>e.pagination.next_page_token??void 0,initialPageParam:null,queryFn:({pageParam:e,signal:t})=>yt.safeGet(`/ps/plugins/list`,{parameters:{query:{scope:`WORKSPACE`,limit:wi,pageToken:e??void 0}},signal:t}),queryKey:[...Ct,`workspace`,e],retry:!1,select:e=>e.pages.flatMap(e=>e.plugins),staleTime:Be.ONE_MINUTE}))";

  const result = patchOfflinePluginQueries(fixture);
  assert.equal(result.patched, true);
  for (const key of [
    "local-directory",
    "all-marketplaces",
    "marketplace-kind",
    "cloud-home",
    "cloud-personal-network-mode",
    "cloud-workspace-list",
  ]) {
    assert.ok(
      result.content.includes(
        `/*codex-offline:plugin-query-network-mode*//*codex-offline:plugin-query-surface:${key}*/`,
      ),
      key,
    );
  }
  for (const key of [
    "cloud-home",
    "cloud-user-list",
    "cloud-workspace-created",
    "cloud-workspace-shared",
    "cloud-workspace-list",
  ]) {
    assert.ok(
      result.content.includes(
        `/*codex-offline:plugin-cloud-fallback*//*codex-offline:plugin-fallback-surface:${key}*/`,
      ),
      key,
    );
  }
  assert.match(result.content, /globalThis\.navigator\?\.onLine===!1/);
  assert.match(result.content, /ERR_NETWORK_ACCESS_DENIED/);
  assert.match(result.content, /ERR_PROXY_CONNECTION_FAILED/);
  assert.ok(
    verifyScriptSource.includes(
      "ERR_NETWORK_ACCESS_DENIED",
    ) && verifyScriptSource.includes(
      "ERR_PROXY_CONNECTION_FAILED",
    ),
    "package verifier must reject the navigator-only fallback",
  );
  assert.match(result.content, /Promise\.reject\(e\)/);
  assert.equal(result.content.includes(".catch(()=>"), false);
  assert.equal(
    result.content.includes(
      'return yt.safeGet(`/ps/plugins/workspace/shared`,{parameters:{query:n},signal:e})}},queryKey:[...Ct,`personal`,t,e]',
    ),
    false,
    "patched workspace/shared query must not match the verifier's unpatched boundary",
  );
  assert.deepEqual(result.correctKeys.sort(), result.expectedKeys.sort());

  for (const [key, emptyValue] of [
    ["cloud-home", { sections: [] }],
    ["cloud-user-list", { plugins: [] }],
    ["cloud-workspace-created", { plugins: [] }],
    ["cloud-workspace-shared", { plugins: [] }],
    ["cloud-workspace-list", { plugins: [], pagination: { next_page_token: null } }],
  ]) {
    const marker =
      `/*codex-offline:plugin-cloud-fallback*/` +
      `/*codex-offline:plugin-fallback-surface:${key}*/`;
    const markerIndex = result.content.indexOf(marker);
    const catchIndex = result.content.lastIndexOf(".catch(", markerIndex);
    assert.notEqual(markerIndex, -1, key);
    assert.notEqual(catchIndex, -1, key);
    const callbackSource = result.content.slice(
      catchIndex + ".catch(".length,
      markerIndex - 1,
    );
    const callback = Function(
      "globalThis",
      `"use strict"; return (${callbackSource});`,
    )({ navigator: { onLine: true } });

    for (const errorName of [
      "ERR_NETWORK_ACCESS_DENIED",
      "ERR_PROXY_CONNECTION_FAILED",
      "ERR_INTERNET_DISCONNECTED",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_NAME_RESOLUTION_FAILED",
      "ERR_ADDRESS_UNREACHABLE",
      "ERR_CONNECTION_REFUSED",
      "ERR_CONNECTION_TIMED_OUT",
    ]) {
      assert.deepEqual(
        await callback(new Error(`net::${errorName}`)),
        emptyValue,
        `${key} must degrade ${errorName} to its empty cloud result`,
      );
    }

    const serviceError = new Error("HTTP 503 Service Unavailable");
    await assert.rejects(callback(serviceError), error => error === serviceError);
  }

  const legacyCloudHomeFixture =
    "queryKey:[...mL,`home`,e],queryFn:()=>K_.safeGet(`/ps/plugins/home`).catch(e=>globalThis.navigator?.onLine===!1?({sections:[]}):Promise.reject(e))" +
    "/*codex-offline:plugin-cloud-fallback*//*codex-offline:plugin-fallback-surface:cloud-home*/,retry:!1," +
    "networkMode:`always`/*codex-offline:plugin-query-network-mode*//*codex-offline:plugin-query-surface:cloud-home*/,staleTime:ym.ONE_MINUTE";
  const legacyUpgrade = patchOfflinePluginQueries(legacyCloudHomeFixture);
  assert.equal(legacyUpgrade.patched, true);
  assert.match(legacyUpgrade.content, /ERR_NETWORK_ACCESS_DENIED/);
  assert.equal(
    legacyUpgrade.content.includes(
      ".catch(e=>globalThis.navigator?.onLine===!1?",
    ),
    false,
    "packages built with the navigator-only fallback must be upgraded",
  );

  const secondPass = patchOfflinePluginQueries(result.content);
  assert.equal(secondPass.patched, false);
  assert.deepEqual(secondPass.correctKeys.sort(), secondPass.expectedKeys.sort());
});

test("offline plugin directory queries stay runnable when the renderer is offline", () => {
  assert.ok(
    contract.DESKTOP_ASAR_PATCH_MARKERS.includes("/*codex-offline:plugin-query-network-mode*/"),
    "capability contract must declare the plugin query network-mode marker",
  );
  assert.match(
    patchScriptSource,
    /plugin-query-network-mode/,
    "patcher must keep local plugin directory IPC queries alive while offline",
  );
  assert.match(
    verifyScriptSource,
    /offlinePluginQueryResiduals|missingPluginQuerySurfaces/,
    "verifier must fail if local plugin directory queries still pause when offline",
  );
});

test("offline plugins page preserves the local marketplace when cloud plugin catalogs fail", () => {
  assert.ok(
    contract.DESKTOP_ASAR_PATCH_MARKERS.includes("/*codex-offline:plugin-cloud-fallback*/"),
    "capability contract must declare the plugin cloud fallback marker",
  );
  assert.match(
    patchScriptSource,
    /plugin-cloud-fallback|\/ps\/plugins\/home[\s\S]{0,1200}catch\(/,
    "patcher must convert cloud plugin catalog failures into a local-marketplace fallback",
  );
  assert.match(
    verifyScriptSource,
    /offlinePluginCloudResiduals|missingPluginFallbackSurfaces/,
    "verifier must cover the local-marketplace fallback when cloud plugin catalogs fail",
  );
});

test("priority and plugin-prefetch surfaces carry dedicated static gate markers", () => {
  const functionStart = patchScriptSource.indexOf(
    "function patchIndirectRendererGateSurfaces",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\nfunction patchWorkspaceDependenciesSettingsGate",
    functionStart,
  );
  assert.notEqual(functionStart, -1, "indirect gate helper is missing");
  assert.notEqual(functionEnd, -1, "indirect gate helper terminator is missing");

  const sidebarMarker = "/*codex-offline:sidebar-activity-view*/";
  const pluginsMarker = "/*codex-offline:plugins-management-in-skills*/";
  const helperSource = patchScriptSource.slice(functionStart, functionEnd);
  const patchIndirectRendererGateSurfaces = Function(
    "SIDEBAR_ACTIVITY_VIEW_PATCH_MARKER",
    "PLUGINS_MANAGEMENT_IN_SKILLS_PATCH_MARKER",
    "escapeRegExp",
    `"use strict";\n${helperSource}\nreturn patchIndirectRendererGateSurfaces;`,
  )(sidebarMarker, pluginsMarker, escapeRegExp);
  const fixture =
    "function Fvc(){let e=Fg(Lvc),t=q(Sw);return e&&(t.status===`allowed`||t.status===`loading`)}" +
    "Lvc=`4039078146`;function tOc(e,t,n){t&&e.get(Mg,`3413548395`)&&Promise.all([])}";
  const result = patchIndirectRendererGateSurfaces(fixture);

  assert.equal(result.patched, true);
  assert.equal(result.sidebarSurfaceSeen, true);
  assert.equal(result.pluginsSurfaceSeen, true);
  assert.equal(result.sidebarCorrect, true);
  assert.equal(result.pluginsCorrect, true);
  assert.ok(result.content.includes(`e=!0${sidebarMarker},t=q(Sw)`));
  assert.ok(result.content.includes(`t&&!0${pluginsMarker}&&Promise.all`));

  const secondPass = patchIndirectRendererGateSurfaces(result.content);
  assert.equal(secondPass.patched, false);
  assert.equal(secondPass.sidebarCorrect, true);
  assert.equal(secondPass.pluginsCorrect, true);

  const markerOnly = patchIndirectRendererGateSurfaces(sidebarMarker + pluginsMarker);
  assert.equal(markerOnly.sidebarSurfaceSeen, false);
  assert.equal(markerOnly.pluginsSurfaceSeen, false);
  assert.equal(markerOnly.sidebarCorrect, false);
  assert.equal(markerOnly.pluginsCorrect, false);
  for (const marker of [sidebarMarker, pluginsMarker]) {
    assert.ok(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(marker), marker);
    assert.ok(verifyScriptSource.includes(`requiredPatchMarker('${marker}')`), marker);
  }
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
