const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const contract = require("../dist/ipc/codex/capabilityContract.js");
const { makeHandlers } = require("../dist/ipc/codex/GatewayCodexIpcPort.js");
const contractData = require("../src/ipc/codex/capabilityContractData.cjs");

test("capability contract exports required statsig defaults", () => {
  assert.equal(contract.STATSIG_DEFAULT_FEATURES_CONFIG, "statsig_default_enable_features");

  for (const key of [
    "fast_mode",
    "inAppBrowserUseAllowed",
    "externalBrowserUseAllowed",
    "computerUseNodeRepl",
    "3903742690",
    "3326157269",
    "2900529421",
  ]) {
    assert.equal(contract.STATSIG_DEFAULT_FEATURE_OVERRIDES[key], true, key);
  }
});

test("capability contract exports desktop defaults and forced capabilities", () => {
  const defaults = contract.DEFAULT_DESKTOP_FEATURE_STATE;

  for (const key of [
    "artifactsPane",
    "avatarOverlay",
    "browserAgent",
    "browserAgentAvailable",
    "browserPane",
    "computerUse",
    "computerUseNodeRepl",
    "control",
    "externalBrowserUse",
    "externalBrowserUseAllowed",
    "inAppBrowserUse",
    "inAppBrowserUseAllowed",
  ]) {
    assert.equal(defaults[key], true, key);
  }

  assert.equal(defaults.ambientSuggestions, false);
  assert.equal(defaults.multiWindow, false);
});

test("normalizeDesktopFeatureValues accepts renderer booleans but keeps required features on", () => {
  const normalized = contract.normalizeDesktopFeatureValues(
    {
      ambientSuggestions: true,
      browserAgentAvailable: false,
      inAppBrowserUseAllowed: false,
      multiWindow: true,
      unknownString: "true",
    },
    { control: false }
  );

  assert.equal(normalized.ambientSuggestions, true);
  assert.equal(normalized.multiWindow, true);
  assert.equal(normalized.browserAgentAvailable, true);
  assert.equal(normalized.inAppBrowserUseAllowed, true);
  assert.equal(normalized.control, true);
  assert.equal(Object.hasOwn(normalized, "unknownString"), false);
});

test("capability contract provides verifier marker lists", () => {
  for (const key of [
    "fast_mode",
    "inAppBrowserUseAllowed",
    "externalBrowserUseAllowed",
    "computerUseNodeRepl",
    "setDesktopFeatureValues",
    "browserAgentAvailable",
  ]) {
    assert.ok(contract.REQUIRED_CAPABILITY_MARKERS.includes(key), key);
  }
});

test("source data contract covers direct exe asar patch surfaces", () => {
  assert.equal(contractData.STATSIG_DEFAULT_FEATURES_CONFIG, contract.STATSIG_DEFAULT_FEATURES_CONFIG);
  assert.deepEqual(contractData.DESKTOP_BROWSER_USE_CAPABILITY_KEYS, [
    "browserPane",
    "inAppBrowserUse",
    "inAppBrowserUseAllowed",
    "externalBrowserUse",
    "externalBrowserUseAllowed",
    "computerUse",
    "computerUseNodeRepl",
  ]);
  assert.deepEqual(contractData.DESKTOP_BROWSER_USE_AVAILABILITY_MARKERS, [
    "computerUseNodeRepl",
    "externalBrowserUse",
    "inAppBrowserUse",
  ]);

  for (const gateId of [
    "410262010",
    "410065390",
    "4250630194",
    "1506311413",
    "2171042036",
    "3326157269",
    "2900529421",
    "2711149772",
    "816842483",
  ]) {
    assert.ok(contractData.DESKTOP_ASAR_KNOWN_GATE_IDS.includes(gateId), gateId);
  }

  for (const marker of [
    "/*codex-offline:windows-browser-use-capability*/",
    "/*codex-offline:bundled-browser-plugins-no-force-reload*/",
    "/*codex-offline:fast-mode-selector*/",
    "/*codex-offline:fast-mode-auth-method*/",
    "/*codex-offline:fast-mode-service-tier-options*/",
    "/*codex-offline:context-usage-visible*/",
    "/*codex-offline:external-agent-config-import*/",
  ]) {
    assert.ok(contractData.DESKTOP_ASAR_PATCH_MARKERS.includes(marker), marker);
  }

  assert.equal(
    contractData.FAST_MODE_CONTRACT.serviceTierOptionsPatchMarker,
    "/*codex-offline:fast-mode-service-tier-options*/"
  );
  assert.equal(
    contractData.CONTEXT_USAGE_CONTRACT.visibilityPatchMarker,
    "/*codex-offline:context-usage-visible*/"
  );
});

test("desktop script patcher is wired to the source data contract", () => {
  const patcherPath = path.resolve(__dirname, "../../../scripts/patch-app-asar.mjs");
  const patcherSource = require("node:fs").readFileSync(patcherPath, "utf8");

  assert.match(patcherSource, /capabilityContractData\.cjs/);
});

test("web gateway safely no-ops external agent import channels", async () => {
  const handlers = makeHandlers({
    appServer: {},
    broadcast: () => {},
    logger: { warn: () => {} },
    isClientConnected: () => false,
  });

  assert.deepEqual(await handlers.handle("claude-code-import-status", { hostId: "local" }), {
    importedSessionCount: 0,
    latestImportedAtMs: null,
  });
  assert.deepEqual(await handlers.handle("external-agent-import-status", { hostId: "local" }), {
    importedSessionCount: 0,
    latestImportedAtMs: null,
  });
  assert.deepEqual(await handlers.handle("external-agent-import-detect", { hostId: "local" }), {
    items: [],
    unsupportedProjects: [],
  });
  assert.deepEqual(await handlers.handle("external-agent-import-import", { hostId: "local", items: [] }), {
    projectRoots: [],
  });
  assert.deepEqual(await handlers.handle("external-agent-imported-connectors", { hostId: "local" }), {
    connectors: [],
  });
});
