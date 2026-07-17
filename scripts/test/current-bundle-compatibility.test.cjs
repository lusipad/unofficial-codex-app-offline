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
