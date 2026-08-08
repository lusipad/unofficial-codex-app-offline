"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const patchScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "patch-app-asar.mjs"),
  "utf8",
);
const verifierScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
  "utf8",
);
const computerUseSmokeSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "e2e-computer-use-tool-smoke.mjs"),
  "utf8",
);
const buildScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "build-offline-package.ps1"),
  "utf8",
);
const setupScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "setup-codex-offline.ps1"),
  "utf8",
);

function sourceSlice(startNeedle, endNeedle) {
  const start = patchScriptSource.indexOf(startNeedle);
  const end = patchScriptSource.indexOf(endNeedle, start);
  assert.notEqual(start, -1, `${startNeedle} is missing`);
  assert.notEqual(end, -1, `${endNeedle} is missing`);
  return patchScriptSource.slice(start, end);
}

function verifierSourceSlice(startNeedle, endNeedle) {
  const start = verifierScriptSource.indexOf(startNeedle);
  const end = verifierScriptSource.indexOf(endNeedle, start);
  assert.notEqual(start, -1, `${startNeedle} is missing`);
  assert.notEqual(end, -1, `${endNeedle} is missing`);
  return verifierScriptSource.slice(start, end);
}

test("26.715 settings IPC keeps its native config handler while patching settings routes", () => {
  const needleSource = sourceSlice(
    "  // V5: open-config-toml has its own Electron implementation.",
    "  // Helper: reload the renderer at a given settings route.",
  );
  const replacementSource = sourceSlice(
    "  const SETTINGS_REPLACEMENT_V5 =",
    "\n  const AUTOMATION_CWD_NORMALIZER_INLINE =",
  );
  const { needle, replacement } = Function(
    "buildSettingsRouteStatement",
    `"use strict";\n${needleSource}\n${replacementSource}\nreturn { needle: NOT_IMPLEMENTED_NEEDLE_V5, replacement: SETTINGS_REPLACEMENT_V5 };`,
  )((urlVariable, messageVariable) =>
    `${urlVariable}.searchParams.set("initialRoute","/settings/"+${messageVariable}.section);`,
  );
  const fixture =
    "case`navigate-in-new-editor-tab`:case`open-vscode-command`:" +
    "case`open-extension-settings`:case`open-keyboard-shortcuts`:" +
    "case`show-settings`:case`install-wsl`:" +
    "throw Error(`\"${t.type}\" is not implemented in Electron.`);" +
    "case`open-config-toml`:{await c.shell.openPath(`config.toml`);break}";

  const patched = fixture.replace(needle, replacement);
  assert.notEqual(patched, fixture);
  assert.match(patched, /case`show-settings`:\{let _win=c\.BrowserWindow\.fromWebContents\(e\)/);
  assert.match(patched, /_url\.searchParams\.set\("initialRoute","\/settings\/"\+t\.section\)/);
  assert.ok(patched.includes("case`open-config-toml`:{await c.shell.openPath(`config.toml`);break}"));
});

test("26.727 archive verifier accepts the current isError prop layout", () => {
  const verifierBlock = verifierSourceSlice(
    "  archivedSettingsOfflineLocalVisibilityPatched ||=",
    "\n  featureOverridesPreserveMcpConfigPatched ||=",
  );
  const isVerified = Function(
    "content",
    "ARCHIVED_SETTINGS_OFFLINE_LOCAL_VISIBILITY_PATCH_MARKER",
    `"use strict";\nlet archivedSettingsOfflineLocalVisibilityPatched = false;\n${verifierBlock}\nreturn archivedSettingsOfflineLocalVisibilityPatched;`,
  );
  const marker = "/*codex-offline:archived-settings-offline-local-visibility*/";

  assert.equal(
    isVerified(`archivedChats:foo,isError:t&&l${marker},onLoadNextPage:d`, marker),
    true,
  );
  assert.equal(
    isVerified("archivedChats:foo,isError:t&&l,onLoadNextPage:d", marker),
    false,
  );
});

test("26.721 Chrome native pipe patch accepts an inline createConnection return", () => {
  const matchSource = sourceSlice(
    "    const createWithConnectionMatch =",
    "\n\n    if (!content.includes(helperNeedle)",
  );
  const matchTransport = Function(
    "content",
    "nativePipeSymbols",
    "escapeRegExp",
    `"use strict";\n${matchSource}\nreturn { createWithConnectionMatch, createWithInlineConnectionMatch, createNeedleMatch };`,
  );
  const fixture =
    "static async create(t){let r=Ru();if(r==null)throw new Error(jh());" +
    "return new e(await r.createConnection(t))}";
  const result = matchTransport(
    fixture,
    { bridgeGetter: "Ru", unavailableMessage: "jh" },
    value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );

  assert.equal(result.createWithConnectionMatch, null);
  assert.ok(result.createWithInlineConnectionMatch);
  assert.equal(result.createNeedleMatch[0], fixture);
  assert.deepEqual(result.createNeedleMatch.slice(1), ["t", "r", "e"]);
});

test("26.803 Chrome native pipe patch accepts additional node:os imports", () => {
  const matchSource = sourceSlice(
    "    const helperNeedleMatch =",
    "\n    if (!helperNeedleMatch",
  );
  const matchSymbols = Function(
    "content",
    `"use strict";\n${matchSource}\nreturn { helperNeedleMatch, unavailableMessageMatch, platformImportMatch, pipePrefixMatch };`,
  );
  const fixture =
    'import{platform as jK,tmpdir as qK}from"node:os";' +
    'var ys=e=>e==="win32"?"pipe-codex-browser-use":"/tmp/codex-browser-use";' +
    'function OM(){let e="privileged native pipe bridge is not available; browser-client is not trusted";' +
    'return ro()==="production"?e:`${e}. Reload bundled plugins.`}' +
    'function tm(){let e=globalThis.nodeRepl?.nativePipe;' +
    'return e==null||typeof e.createConnection!="function"?null:e}';

  const result = matchSymbols(fixture);
  assert.equal(result.helperNeedleMatch?.[1], "tm");
  assert.equal(result.unavailableMessageMatch?.[1], "OM");
  assert.equal(result.platformImportMatch?.[1], "jK");
  assert.equal(result.pipePrefixMatch?.[1], "ys");
});

test("26.803 Chrome pipe filter accepts platform-aware listing functions", () => {
  const matchSource = sourceSlice(
    "    const legacyPipeListMatch =",
    "\n    if (!pipeListMatch",
  );
  const matchPipeList = Function(
    "content",
    `"use strict";\n${matchSource}\nreturn pipeListMatch;`,
  );
  const fixture =
    't4=async e=>{let t=ys(e.platform),r="\\\\\\\\.\\\\pipe\\\\";' +
    'return(await BE(r)).map(i=>NE.resolve(r,i)).filter(i=>i.startsWith(t))}';

  const result = matchPipeList(fixture);
  assert.ok(result);
  assert.equal(result[0], fixture);
});

test("26.803 Chrome direct setup recognizes the platform dispatcher", () => {
  const matchSource = sourceSlice(
    "    const directSetupGuardMatch =",
    "\n    if (!directSetupGuardMatch && !platformAwareSetupMatch)",
  );
  const matchDirectSetup = Function(
    "content",
    `"use strict";\n${matchSource}\nreturn { directSetupGuardMatch, platformAwareSetupMatch };`,
  );
  const fixture = "var Q6=e=>e.platform===`win32`?t4(e):e4(e)";

  const result = matchDirectSetup(fixture);
  assert.equal(result.directSetupGuardMatch, null);
  assert.ok(result.platformAwareSetupMatch);
});

test("26.803 Chrome ambient network default accepts runtime-scoped env readers", () => {
  const matchSource = sourceSlice(
    "      const ambientEnvVarMatch =",
    "\n      if (scopedEnvGuardMatch &&",
  );
  const matchAmbientNetwork = Function(
    "content",
    "escapeRegExp",
    `"use strict";\n${matchSource}\nreturn { ambientEnvVarMatch, scopedEnvGuardMatch, scopedRawReaderMatch };`,
  );
  const fixture =
    'var Jy="BROWSER_USE_DISABLE_AMBIENT_NETWORK";' +
    'function $r(e,t){return _s(e,t)==="1"}' +
    'function qn(e){return $r(e,Jy)}';

  const result = matchAmbientNetwork(
    fixture,
    value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  assert.equal(result.ambientEnvVarMatch?.[1], "Jy");
  assert.equal(result.scopedEnvGuardMatch?.[1], "qn");
  assert.equal(result.scopedRawReaderMatch?.[3], "_s");
});

test("26.721 Computer Use accepts resource-based Windows runtime paths", () => {
  const regexSource = sourceSlice(
    "  const COMPUTER_USE_RESOURCE_RUNTIME_PATHS_CURRENT_RE =",
    "\n  const COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_NEEDLE =",
  );
  const currentRegex = Function(
    `"use strict";\n${regexSource}\nreturn COMPUTER_USE_RESOURCE_RUNTIME_PATHS_CURRENT_RE;`,
  )();
  const resolver =
    "function see({codexHome:e,env:t=process.env,marketplaceName:r=n.xc(i.a.resolve())," +
    "marketplaces:a,pathExists:o=_.existsSync}){for(let n of xn({marketplaceName:r,marketplaces:a}))" +
    "if(n.plugins.find(e=>e.name===`computer-use`&&e.installed&&e.enabled&&e.source.type===`local`)" +
    "?.source.type===`local`)return Pn({codexHome:e,env:t,pathExists:o});return Pn({env:t,pathExists:o})}";
  const fixture =
    `${resolver}return{nodeModuleDirs:n.cr(d)}` +
    "serviceAppPath:l.platform===`darwin`?o.serviceAppPath:null";

  assert.match(resolver, currentRegex);
  assert.match(fixture, /nodeModuleDirs:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)/);
  assert.ok(fixture.includes("serviceAppPath:l.platform===`darwin`?o.serviceAppPath:null"));
});

test("26.721 dynamic tool bridge accepts the execution claim guard", () => {
  const regexSource = sourceSlice(
    "  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CURRENT_V4_RE =",
    "\n  const COMPUTER_USE_NODE_REPL_RESULT_TEXT_CODE =",
  );
  const currentRegex = Function(
    `"use strict";\n${regexSource}\nreturn COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CURRENT_V4_RE;`,
  )();
  const fixture =
    "async function Hfu({scope:e,serverRequest:t,hostId:n,queryClient:r}){" +
    "let{id:i,params:a}=t,{threadId:o,tool:s}=a;if(!o){" +
    "Bf.error(`Missing threadId for dynamic tool call request`,{safe:{},sensitive:{id:i,params:a}});return}" +
    "if(dp.dynamicToolCalls!=null&&!await dp.dynamicToolCalls.tryClaimExecution(" +
    "{callId:a.callId,hostId:n,threadId:o,turnId:a.turnId}))return;" +
    "let c,l=a.namespace===a4,u=a.namespace==null&&epu.has(s)," +
    "d=l||u?await dHc({argumentsValue:a.arguments}):null," +
    "f=a.namespace===`plugin_management`?await XLc(a,{hostId:n}):null;" +
    "if(f!=null)c=f;else if(!l&&!u)c=Gx(`Unsupported dynamic tool namespace: ${a.namespace}`);" +
    "else if(d!=null)c=d;else";
  const match = currentRegex.exec(fixture);

  assert.ok(match);
  assert.equal(match.groups.hostId, "n");
  assert.equal(match.groups.params, "a");
  assert.equal(match.groups.result, "c");
  assert.equal(match.groups.failureFn, "Gx");
});

test("26.721 scheduled forwarding receives Computer Use thread context", () => {
  const injectionSource = sourceSlice(
    "  const COMPUTER_USE_INPUT_SKILL_INJECTION_CODE =",
    "\n  const COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE =",
  );
  const injection = Function(
    "COMPUTER_USE_INPUT_SKILL_PATCH_MARKER",
    `"use strict";\n${injectionSource}\nreturn { COMPUTER_USE_INPUT_SKILL_INJECTION_CODE, COMPUTER_USE_SCHEDULED_FORWARD_REQUEST_NEEDLE };`,
  )("/*codex-offline:computer-use-input-skill*/");
  const fixture =
    "let c=s?.sender??e;" +
    "this.options.logger.debug(`bridge_forwarded_to_transport`,{safe:{method:t.method}});";
  const patched = fixture.replace(
    injection.COMPUTER_USE_SCHEDULED_FORWARD_REQUEST_NEEDLE,
    injection.COMPUTER_USE_INPUT_SKILL_INJECTION_CODE +
      injection.COMPUTER_USE_SCHEDULED_FORWARD_REQUEST_NEEDLE,
  );

  assert.ok(patched.includes("t.method===`thread/start`"));
  assert.ok(patched.includes("t.method===`turn/start`"));
  assert.ok(patched.includes("type:`skill`,name:`computer-use`"));
  assert.ok(patched.includes("/*codex-offline:computer-use-input-skill*/"));
});

test("26.721 automation runtime normalizes cwd before creating legacy targets", () => {
  const regexSource = sourceSlice(
    "  const AUTOMATION_RUNTIME_LEGACY_TARGET_CWD_RE =",
    "\n  const AUTOMATION_RUNTIME_CWD_PATCH_MARKER =",
  );
  const patch = Function(
    "AUTOMATION_CWD_NORMALIZER_INLINE",
    `"use strict";\n${regexSource}\nreturn { re: AUTOMATION_RUNTIME_LEGACY_TARGET_CWD_RE, replacement: AUTOMATION_RUNTIME_LEGACY_TARGET_CWD_REPLACEMENT };`,
  )("e=>typeof e==`string`?e:e");
  const fixture =
    "if(t.target==null)h=t.cwds.map(e=>({type:`legacy`,cwd:e}));else";
  const patched = fixture.replace(patch.re, patch.replacement);

  assert.notEqual(patched, fixture);
  assert.ok(patched.includes("t.cwds.map(e=>typeof e==`string`?e:e).map(e=>"));
  assert.ok(patched.includes("type:`legacy`,cwd:e"));
});

test("26.721 plugin cache lock failures remain nonfatal in both reconcile branches", () => {
  const constantsSource = sourceSlice(
    "  const BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER =",
    "\n  const NODE_REPL_CONFIG_RECONCILE_FINAL_STEP =",
  );
  const constants = Function(
    "contractPatchMarker",
    `"use strict";\n${constantsSource}\nreturn { re: BUNDLED_PLUGIN_CACHE_LOCK_CURRENT_CATCH_THROW_RE, category: BUNDLED_PLUGIN_CACHE_LOCK_CATEGORY_VALUE, marker: BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER };`,
  )(value => value);
  const fixture =
    "catch(n){if(Gs.warning(`bundled_plugins_marketplace_install_failed`," +
    "{safe:{errorCategory:tc({error:n,platformFamily:e.platformFamily}),marketplaceName:t,platformFamily:e.platformFamily}," +
    "sensitive:{error:n,marketplaceRoot:e.materializedMarketplace.marketplaceRoot}}),e.throwOnReconcileFailure)throw n;" +
    "return{hadReconcileFailure:!0}}let{firstFailure:a}=i;if(a!=null){if(e.throwOnReconcileFailure)throw a.error;return{failed:!0}}";
  const match = fixture.match(constants.re);

  assert.ok(match);
  const [, errorVar, loggerVar, categoryFn, contextVar, marketplaceVar] = match;
  assert.deepEqual(
    [errorVar, loggerVar, categoryFn, contextVar, marketplaceVar],
    ["n", "Gs", "tc", "e", "t"],
  );
  assert.ok(fixture.includes("if(e.throwOnReconcileFailure)throw a.error"));
  assert.equal(constants.category, "`plugin_cache_windows_file_lock`");
  assert.equal(constants.marker, "/*codex-offline:bundled-plugin-cache-lock-nonfatal*/");
});

test("26.721 Chrome skill bootstrap accepts upstream single-line guidance", () => {
  const needleSource = sourceSlice(
    "  const needle =\n    /The `browser-client` module",
    "\n  const matched = content.match(needle)?.[0];",
  );
  const needle = Function(
    `"use strict";\n${needleSource}\nreturn needle;`,
  )();
  const fixture =
    "The `browser-client` module is the core entry point for browser use, and is available under " +
    "`scripts/browser-client.mjs` in this plugin's root directory. ALWAYS import it using an absolute path. " +
    "IMPORTANT: If this path cannot be found, stop and report that this plugin is missing " +
    "`scripts/browser-client.mjs`. NEVER use the built in `browser-client` library.";

  assert.match(fixture, needle);
});

test("26.727 Chrome descriptors accept dotted availability helpers", () => {
  const regexSource = sourceSlice(
    "  const SYNC_EXTERNAL_BROWSER_DESCRIPTOR_RE =",
    "\n  const SYNC_EXTERNAL_BROWSER_DESCRIPTOR_PATCHED_RE =",
  );
  const currentRegex = Function(
    `"use strict";\n${regexSource}\nreturn SYNC_EXTERNAL_BROWSER_DESCRIPTOR_RE;`,
  )();
  const fixture =
    "{name:s.c,syncInstallStateWithChromeExtension:!0," +
    "isAvailable:({buildFlavor:e,env:t,features:n})=>s.a(e,t)&&n.externalBrowserUseAllowed}";

  assert.match(fixture, currentRegex);
});

test("26.727 browser-use descriptor accepts external browser availability", () => {
  const regexSource = sourceSlice(
    "  const BROWSER_USE_DESCRIPTOR_RE =",
    "\n  const BROWSER_USE_DESCRIPTOR_PATCHED_RE =",
  );
  const currentRegex = Function(
    `"use strict";\n${regexSource}\nreturn BROWSER_USE_DESCRIPTOR_RE;`,
  )();
  const fixture =
    "{autoInstallOptOutKey:n.hs(n.rs),installWhenMissing:!0," +
    "name:n.rs,isAvailable:({features:e})=>e.inAppBrowserUseAllowed||" +
    "e.externalBrowserUseAllowed,migrate:Ds}";

  assert.match(fixture, currentRegex);
});

test("26.727 dynamic tools keep node_repl at the top-level namespace boundary", () => {
  const regexSource = sourceSlice(
    "  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOLS_TOP_LEVEL_CURRENT_RE =",
    "\n  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_RE =",
  );
  const currentRegex = Function(
    `"use strict";\n${regexSource}\nreturn COMPUTER_USE_NODE_REPL_DYNAMIC_TOOLS_TOP_LEVEL_CURRENT_RE;`,
  )();
  const replacementSource = sourceSlice(
    "  function computerUseNodeReplDynamicToolsTopLevelCurrentReplacement(",
    "\n  function patchComputerUseNodeReplDynamicTools(",
  );
  const replacement = Function(
    "COMPUTER_USE_NODE_REPL_NAMESPACE_GROUP_SPEC",
    "COMPUTER_USE_NODE_REPL_NAMESPACE_TOOL_SPEC",
    "COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_PATCH_MARKER",
    `"use strict";\n${replacementSource}\nreturn computerUseNodeReplDynamicToolsTopLevelCurrentReplacement;`,
  )(
    "{type:`namespace`,name:`node_repl`,description:`Node REPL tools for Computer Use.`,tools:[{type:`function`,name:`js`}]}",
    "{type:`function`,name:`js`}",
    "/*codex-offline:computer-use-node-repl-dynamic-tool*/",
  );
  const fixture =
    "const tools=[...C];" +
    "].map(e=>({type:`function`,...e,...x&&!jtl.has(e.name)?{deferLoading:!0}:{}}));" +
    "return x?[{type:`namespace`,name:L2,description:`Tools provided by the Codex app.`,tools:A},...D]:A";

  const patched = fixture.replace(currentRegex, replacement);
  assert.ok(patched.includes("/*codex-offline:computer-use-node-repl-dynamic-tool*/"));
  assert.match(patched, /\.\.\.D,\{type:`namespace`,name:`node_repl`/);
  assert.match(patched, /:A\.concat\(\[\{type:`function`,name:`js`/);
});

test("26.727 archived settings keeps local errors separate from cloud task errors", () => {
  const patchSource = sourceSlice(
    "  function patchArchivedSettingsOfflineVisibility(content) {",
    "\n  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_LEGACY_RE =",
  );
  const patchArchivedSettingsOfflineVisibility = Function(
    "ARCHIVED_SETTINGS_OFFLINE_LOCAL_VISIBILITY_PATCH_MARKER",
    `"use strict";\n${patchSource}\nreturn patchArchivedSettingsOfflineVisibility;`,
  )("/*codex-offline:archived-settings-offline-local-visibility*/");
  const fixture =
    "return{archivedChats:foo,projects:bar,isError:t&&l||u==null&&g," +
    "onLoadNextPage:d};";

  const result = patchArchivedSettingsOfflineVisibility(fixture);
  assert.equal(result.patched, true);
  assert.match(
    result.content,
    /isError:t&&l\/\*codex-offline:archived-settings-offline-local-visibility\*\//,
  );
  assert.ok(!result.content.includes("u==null&&g"));
});

test("26.727 Workspace Dependencies enables the current adjacent gate layout", () => {
  const patchSource = sourceSlice(
    "function patchWorkspaceDependenciesSettingsGate(",
    "// end patchWorkspaceDependenciesSettingsGate",
  );
  const patchWorkspaceDependenciesSettingsGate = Function(
    "escapeRegExp",
    `"use strict";\n${patchSource}\nreturn patchWorkspaceDependenciesSettingsGate;`,
  )((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const fixture =
    "settings.agent.dependencies.enabled.description;" +
    "a=ge(we),o=ge(`2106641128`),s=ge(`3693343337`);";

  const result = patchWorkspaceDependenciesSettingsGate(
    fixture,
    "/*codex-offline:workspace-dependencies-settings*/",
    "/*codex-offline:renderer-known-statsig-gates*/",
  );
  assert.equal(result.patched, true);
  assert.ok(
    result.content.includes(
      "a=!0/*codex-offline:workspace-dependencies-settings*/,o=ge(`2106641128`)",
    ),
  );
});

test("26.727 verifier recognizes the current agent settings surface", () => {
  const helperSource = verifierSourceSlice(
    "function hasWorkspaceDependenciesSettingsSurface(",
    "function directStatsigGateCallRe(",
  );
  const hasWorkspaceDependenciesSettingsSurface = Function(
    `"use strict";\n${helperSource}\nreturn hasWorkspaceDependenciesSettingsSurface;`,
  )();

  assert.equal(
    hasWorkspaceDependenciesSettingsSurface(
      "settings.agent.dependencies.enabled.description",
    ),
    true,
  );
  assert.equal(
    hasWorkspaceDependenciesSettingsSurface(
      "defaultMessage:`Workspace Dependencies`",
    ),
    true,
  );
  assert.equal(hasWorkspaceDependenciesSettingsSurface("other surface"), false);
});

test("26.730 node_repl config keeps env_vars when adding the sandbox bypass", () => {
  const helperSource = sourceSlice(
    "  const NODE_REPL_CONFIG_HELPER_RE =",
    "\n  const COMPUTER_USE_PLUGIN_ROOT_FALLBACK_NEEDLE =",
  );
  const [configHelperRe, replacement] = Function(
    "NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER",
    "NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER",
    `"use strict";\n${helperSource}\nreturn [NODE_REPL_CONFIG_HELPER_RE, NODE_REPL_CONFIG_HELPER_REPLACEMENT];`,
  )(
    "/*codex-offline:node-repl-tool-search-feature*/",
    "/*codex-offline:node-repl-disable-sandbox*/",
  );
  const fixture =
    "{[`mcp_servers.${ze}`]:{args:[],command:o,env:m," +
    "...n.length===0?{}:{env_vars:Array.from(n)},startup_timeout_sec:120}}";

  const patched = fixture.replace(configHelperRe, replacement);

  assert.notEqual(patched, fixture);
  assert.match(patched, /args:\[`--disable-sandbox`\],command:o,env:m,/);
  assert.ok(patched.includes("...n.length===0?{}:{env_vars:Array.from(n)}"));
  assert.ok(patched.includes("/*codex-offline:node-repl-disable-sandbox*/"));
  assert.doesNotMatch(
    "{[`mcp_servers.${ze}`]:{args:[],command:o,env:m,startup_timeout_sec:120}}",
    configHelperRe,
  );
});

test("26.730 verifier requires the direct @oai/sky Computer Use runtime", () => {
  const verifierBlock = verifierSourceSlice(
    "        if ($offlineRuntimePluginName -eq 'computer-use') {",
    "    if (-not (Test-Path (Join-Path $browserPluginRoot",
  );

  assert.ok(verifierBlock.includes('await import("@oai/sky")'));
  assert.ok(verifierBlock.includes("globalThis.sky = sky"));
  assert.ok(!verifierBlock.includes("computerUseClientPath"));
  assert.ok(!verifierBlock.includes("setupComputerUseRuntime"));
});

test("26.730 Computer Use smoke prompt initializes the direct sky runtime", () => {
  assert.ok(
    computerUseSmokeSource.includes('const { sky } = await import("@oai/sky")'),
  );
  assert.ok(computerUseSmokeSource.includes('import("node:fs/promises")'));
  assert.ok(computerUseSmokeSource.includes("readRuntimeProof(runtimeProofPath, marker)"));
  assert.ok(!computerUseSmokeSource.includes("inspectBridgeEvidence(stdout)"));
  assert.ok(!computerUseSmokeSource.includes("computer_use_node_repl_js_call"));
  assert.ok(!computerUseSmokeSource.includes("setupComputerUseRuntime"));
  assert.ok(
    computerUseSmokeSource.includes(
      '`"E2E_COMPUTER_USE_MARKER" + "_" + ${JSON.stringify(markerSuffix)}`',
    ),
  );
});

test("26.730 Computer Use smoke reuses caller state and clears the composer", () => {
  assert.ok(computerUseSmokeSource.includes("process.env.CODEX_HOME"));
  assert.ok(!computerUseSmokeSource.includes("seedCodexHome"));
  assert.ok(!computerUseSmokeSource.includes("auth.json"));
  assert.ok(computerUseSmokeSource.includes("await composer.fill('')"));
});

test("26.730 packaging does not carry the legacy Computer Use client repair", () => {
  assert.ok(!buildScriptSource.includes("Repair-ComputerUseClientNativePipeFallback"));
  assert.ok(!setupScriptSource.includes("Repair-ComputerUseClientNativePipeFallback"));
  assert.ok(!patchScriptSource.includes("setupComputerUseRuntime"));
});

test("26.730 packaging repairs the encoded Statsig global module filenames", () => {
  assert.ok(buildScriptSource.includes("function Repair-EncodedNodeModuleEntries"));
  assert.ok(buildScriptSource.includes("%24_StatsigGlobal.*"));
  assert.ok(buildScriptSource.includes(".Replace('%24', '$')"));
  assert.ok(
    buildScriptSource.includes(
      "Repair-EncodedNodeModuleEntries -RootPath (Join-Path $internalRoot 'app/resources/cua_node')",
    ),
  );
  assert.ok(verifierScriptSource.includes("'$_StatsigGlobal.js'"));
  assert.ok(verifierScriptSource.includes("'$_StatsigGlobal.d.ts'"));
  assert.ok(verifierScriptSource.includes("'%24_StatsigGlobal.*'"));
});

test("26.730 patcher does not carry pre-helper node_repl migrations", () => {
  assert.ok(!patchScriptSource.includes("NODE_REPL_DISABLE_SANDBOX_NEEDLE ="));
  assert.ok(
    !patchScriptSource.includes("NODE_REPL_DISABLE_SANDBOX_LEGACY_DIAGNOSTICS_NEEDLE"),
  );
  assert.ok(!patchScriptSource.includes("NODE_REPL_TOOL_SEARCH_FEATURE_UPGRADE_RE"));
  assert.ok(
    !patchScriptSource.includes("NODE_REPL_TOOL_SEARCH_FEATURE_MISSING_SEPARATOR_RE"),
  );
});

test("26.730 runtime marketplace manifest is written without a UTF-8 BOM", () => {
  assert.ok(
    buildScriptSource.includes(
      "[System.IO.File]::WriteAllText($manifestPath, $marketplaceJson, $utf8WithoutBom)",
    ),
  );
  assert.ok(
    buildScriptSource.includes(
      "$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)",
    ),
  );
  assert.ok(
    !buildScriptSource.includes(
      "$marketplace | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8",
    ),
  );
});

test("26.730 verifier rejects a UTF-8 BOM in the bundled marketplace manifest", () => {
  assert.ok(
    verifierScriptSource.includes("function Assert-FileHasNoUtf8Bom {"),
  );
  assert.ok(
    verifierScriptSource.includes(
      "Assert-FileHasNoUtf8Bom -Path $bundledMarketplaceManifestPath -Context 'Bundled OpenAI plugin marketplace manifest'",
    ),
  );
  assert.match(
    verifierScriptSource,
    /\$bytes = \[System\.IO\.File\]::ReadAllBytes\(\$Path\)[\s\S]*\$bytes\[0\] -eq 0xEF[\s\S]*\$bytes\[1\] -eq 0xBB[\s\S]*\$bytes\[2\] -eq 0xBF/,
  );
});
