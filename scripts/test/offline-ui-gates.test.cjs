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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const requiredOfflineUiGates = {
  "824038554": "Codex/Work mode selector",
  "2106641128": "experimental features settings",
  "3693343337": "model features settings",
  "3026692602": "workspace dependencies settings",
};

test("offline builds force the product-mode and configuration UI gates", () => {
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
