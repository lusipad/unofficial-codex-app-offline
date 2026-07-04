const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const contract = require("../dist/ipc/codex/capabilityContract.js");
const { filterUnsupportedFeatureEnablements } = require("../dist/ipc/codex/featurePatches.js");
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

test("feature enablement refresh leaves supported entries unchanged", () => {
  const result = filterUnsupportedFeatureEnablements({
    enablement: {
      tool_suggest: true,
    },
  });

  assert.deepEqual(result.removed, []);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.payload.enablement, {
    tool_suggest: true,
  });
});

test("feature enablement refresh drops unsupported entries without inventing app-server features", () => {
  const result = filterUnsupportedFeatureEnablements({
    enablement: {
      auth_elicitation: true,
    },
  });

  assert.deepEqual(result.removed, ["auth_elicitation"]);
  assert.equal(result.skipped, true);
  assert.deepEqual(result.payload.enablement, {});
});

test("source data contract declares every required desktop asar marker", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const markerCalls = [
    {
      path: path.join(repoRoot, "scripts", "patch-app-asar.mjs"),
      regex: /contractPatchMarker\((['"`])([^'"`]+)\1\)/g,
    },
    {
      path: path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
      regex: /requiredPatchMarker\((['"`])([^'"`]+)\1\)/g,
    },
  ];
  const declared = new Set(contractData.DESKTOP_ASAR_PATCH_MARKERS);

  for (const markerCall of markerCalls) {
    const source = fs.readFileSync(markerCall.path, "utf8");
    for (const match of source.matchAll(markerCall.regex)) {
      assert.ok(declared.has(match[2]), `${path.relative(repoRoot, markerCall.path)}: ${match[2]}`);
    }
  }

  assert.equal(declared.has("/*codex-offline:default-on-gate-wrapper*/"), false);
  assert.equal(Object.hasOwn(contractData, "DESKTOP_GATE_DENYLIST"), false);
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
    "/*codex-offline:node-repl-feature-enabled*/",
    "/*codex-offline:feature-overrides-preserve-mcp-config*/",
    "/*codex-offline:feature-enablement-preserve-unified-exec*/",
    "/*codex-offline:bundled-plugin-cache-lock-nonfatal*/",
    "/*codex-offline:node-repl-config-reconcile-finally*/",
    "/*codex-offline:node-repl-disable-sandbox*/",
    "/*codex-offline:node-repl-tool-search-feature*/",
    "/*codex-offline:computer-use-plugin-root-fallback*/",
    "/*codex-offline:computer-use-input-mention*/",
    "/*codex-offline:computer-use-input-mention-v2*/",
    "/*codex-offline:computer-use-input-skill*/",
    "/*codex-offline:computer-use-thread-start-tool-search*/",
    "/*codex-offline:computer-use-node-repl-dynamic-tool*/",
    "/*codex-offline:computer-use-node-repl-dynamic-tool-call*/",
    "/*codex-offline:archived-threads-partial-list*/",
    "/*codex-offline:archived-threads-cache-fallback*/",
    "/*codex-offline:bundled-browser-plugins-no-force-reload*/",
    "/*codex-offline:fast-mode-selector*/",
    "/*codex-offline:fast-mode-auth-method*/",
    "/*codex-offline:fast-mode-service-tier-options*/",
    "/*codex-offline:context-usage-visible*/",
    "/*codex-offline:renderer-known-statsig-gates*/",
    "/*codex-offline:electron-namespace-no-auto-updater*/",
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
  assert.match(patcherSource, /'computer-use'/);
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

test("web gateway lists archived threads from app-server", async () => {
  const requests = [];
  const archivedThread = {
    id: "archived-thread-1",
    name: "Archived",
    cwd: "D:\\Repos\\example",
    createdAt: 1,
    updatedAt: 2,
  };
  const handlers = makeHandlers({
    appServer: {
      isConnected: () => true,
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/list") return { data: [archivedThread], nextCursor: null };
        throw new Error(`unexpected method: ${method}`);
      },
    },
    broadcast: () => {},
    logger: { warn: () => {} },
    isClientConnected: () => false,
  });

  const result = await handlers.handle("list-archived-threads", { hostId: "local" });

  assert.ok(result.some((thread) => thread.id === archivedThread.id));
  assert.deepEqual(requests, [
    {
      method: "thread/list",
      params: {
        archived: true,
        cursor: null,
        limit: 200,
        modelProviders: null,
        sortKey: "updated_at",
        useStateDbOnly: true,
      },
    },
  ]);
});

test("archived thread listing avoids workspace scans", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const patcherSource = fs.readFileSync(path.join(repoRoot, "scripts", "patch-app-asar.mjs"), "utf8");
  const verifierSource = fs.readFileSync(path.join(repoRoot, "scripts", "verify-offline-package.ps1"), "utf8");

  assert.ok(patcherSource.includes("useStateDbOnly:${archived}?!0:${useStateDbOnly}"));
  assert.ok(verifierSource.includes("Archived thread list does not force useStateDbOnly for archived queries."));
});

test("web gateway returns partial archived threads when a page fails", async () => {
  let pageCount = 0;
  const handlers = makeHandlers({
    appServer: {
      isConnected: () => true,
      request: async (method, params) => {
        if (method === "thread/list") {
          pageCount++;
          if (pageCount === 1) {
            return {
              data: [{ id: "page1-thread", name: "Page 1", updatedAt: 2 }],
              nextCursor: "cursor-2",
            };
          }
          throw new Error("simulated timeout on page 2");
        }
        throw new Error(`unexpected method: ${method}`);
      },
    },
    broadcast: () => {},
    logger: { warn: () => {} },
    isClientConnected: () => false,
  });

  const result = await handlers.handle("list-archived-threads", { hostId: "local" });

  assert.ok(Array.isArray(result));
  assert.ok(result.some((thread) => thread.id === "page1-thread"));
});

test("web gateway syncs archived threads to desktop state for fallback", async () => {
  const syncThreadId = `_test_sync_${Date.now()}`;
  let appServerAvailable = true;
  const handlers = makeHandlers({
    appServer: {
      isConnected: () => true,
      request: async (method) => {
        if (!appServerAvailable) throw new Error("simulated app-server down");
        if (method === "thread/list") {
          return { data: [{ id: syncThreadId, name: "Sync Test", updatedAt: 2 }], nextCursor: null };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    },
    broadcast: () => {},
    logger: { warn: () => {} },
    isClientConnected: () => false,
  });

  await handlers.handle("list-archived-threads", { hostId: "local" });

  appServerAvailable = false;
  const fallbackResult = await handlers.handle("list-archived-threads", { hostId: "local" });

  assert.ok(fallbackResult.some((thread) => thread.id === syncThreadId));
});

test("web gateway archives conversation to desktop state on success", async () => {
  const archiveThreadId = `_test_archive_${Date.now()}`;
  let callCount = 0;
  const handlers = makeHandlers({
    appServer: {
      isConnected: () => true,
      request: async (method) => {
        callCount++;
        if (method === "thread/archive") return true;
        if (method === "thread/list") {
          if (callCount <= 2) throw new Error("simulated failure");
          throw new Error(`unexpected method: ${method}`);
        }
        throw new Error(`unexpected method: ${method}`);
      },
    },
    broadcast: () => {},
    logger: { warn: () => {} },
    isClientConnected: () => false,
  });

  await handlers.handle("archive-conversation", {
    params: { conversationId: archiveThreadId, name: "Archive Test" },
  });

  const result = await handlers.handle("list-archived-threads", { hostId: "local" });

  assert.ok(result.some((thread) => thread.id === archiveThreadId));
});

test("web gateway hydrates only unarchived pinned threads", async () => {
  const requests = [];
  const handlers = makeHandlers({
    appServer: {
      isConnected: () => true,
      request: async (method, params) => {
        requests.push({ method, params });
        if (method === "thread/list") {
          return { data: [{ id: "archived-thread-1", updatedAt: 2 }], nextCursor: null };
        }
        if (method === "thread/read") {
          return { thread: { id: params.threadId, createdAt: 1, updatedAt: 2, turns: [] } };
        }
        throw new Error(`unexpected method: ${method}`);
      },
    },
    broadcast: () => {},
    logger: { warn: () => {} },
    isClientConnected: () => false,
  });

  const result = await handlers.handle("hydrate-pinned-threads", {
    hostId: "local",
    threadIds: ["active-thread-1", "archived-thread-1"],
  });

  assert.deepEqual(result, { threadIds: ["active-thread-1"] });
  assert.deepEqual(
    requests.filter((request) => request.method === "thread/read"),
    [
      {
        method: "thread/read",
        params: { threadId: "active-thread-1", includeTurns: false },
      },
    ]
  );
});
