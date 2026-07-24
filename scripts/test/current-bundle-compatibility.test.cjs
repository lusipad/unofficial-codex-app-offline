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

test("26.715 archived list fallback supports a fixed useStateDbOnly value", () => {
  const archiveSource = sourceSlice(
    "  const ARCHIVED_THREADS_LIST_ALL_DIRECT_RE =",
    "\n  // The archived settings panel",
  );
  const partialListMarker = "/*codex-offline:archived-threads-partial-list*/";
  const cacheFallbackMarker = "/*codex-offline:archived-threads-cache-fallback*/";
  const patchArchivedThreadsPartialList = Function(
    "ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER",
    "ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER",
    `"use strict";\n${archiveSource}\nreturn patchArchivedThreadsPartialList;`,
  )(partialListMarker, cacheFallbackMarker);
  const fixture =
    "async function XS(e,{modelProviders:t,archived:n=!1,sourceKinds:r=O}){" +
    "let i=[],a=async o=>{let s={limit:100,cursor:o,sortKey:e.recentConversationsSortKey," +
    "modelProviders:t,sourceKinds:r,archived:n,useStateDbOnly:!0}," +
    "c=await e.sendRequest(`thread/list`,s,{priority:`background`,source:`thread_list`});" +
    "i.push(...c.data),c.nextCursor&&await a(c.nextCursor)};return await a(null),i}";

  const firstPass = patchArchivedThreadsPartialList(fixture);
  assert.equal(firstPass.patched, true);
  assert.ok(firstPass.content.includes(partialListMarker));
  assert.ok(firstPass.content.includes(cacheFallbackMarker));
  assert.match(firstPass.content, /catch\(_codexOfflineArchiveListError\)\{if\(n\)\{/);
  assert.match(firstPass.content, /useStateDbOnly:!0/);

  const secondPass = patchArchivedThreadsPartialList(firstPass.content);
  assert.equal(secondPass.patched, false);
  assert.equal(secondPass.alreadyCorrect, true);
});

test("archive verifier accepts dynamic and fixed useStateDbOnly layouts", () => {
  const verifierBlock = verifierSourceSlice(
    "  archivedThreadsStateDbOnlyPatched ||=",
    "\n  archivedSettingsOfflineLocalVisibilityPatched ||=",
  );
  const isVerified = Function(
    "content",
    "ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER",
    `"use strict";\nlet archivedThreadsStateDbOnlyPatched = false;\n${verifierBlock}\nreturn archivedThreadsStateDbOnlyPatched;`,
  );
  const marker = "/*codex-offline:archived-threads-partial-list*/";

  assert.equal(
    isVerified(`${marker}useStateDbOnly:n?!0:o`, marker),
    true,
  );
  assert.equal(isVerified(`${marker}useStateDbOnly:!0`, marker), true);
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
