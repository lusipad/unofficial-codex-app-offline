const assert = require("node:assert/strict");
const test = require("node:test");

const { createChatgptBackendIpcHandlers } = require("../dist/ipc/codex/chatgptBackend.js");
const { createFetchIpcHandlers } = require("../dist/ipc/codex/fetchIpc.js");
const { createViewMessageHandlers } = require("../dist/ipc/codex/viewMessages.js");
const { UNHANDLED_CODEX_CHANNEL } = require("../dist/ipc/codex/IGatewayCodexIpcPort.js");

function makeFetchIpc(broadcasts = []) {
  return createFetchIpcHandlers({
    broadcast: (message) => broadcasts.push(message),
    logger: { info: () => {}, warn: () => {} },
    chatgptBackend: { parseMaybeJson: (body) => (body ? JSON.parse(body) : null) },
    targetClientIdForContext: () => "",
    withTargetClient: (message) => message,
    invokeCodexChannel: async () => UNHANDLED_CODEX_CHANNEL,
    shouldPatchStatsigInitialize: () => false,
    patchStatsigDefaultFeatures: (text) => text,
    statsigDefaultFeatureOverrides: {},
  });
}

test("26.1120 chatgptBackend normalizes workspaceRouting accountId/userId and entitlement", async () => {
  const backend = createChatgptBackendIpcHandlers({
    logger: { warn: () => {} },
    callAppServer: async (method) => {
      if (method === "account/read") {
        return {
          account: {
            type: "chatgpt",
            email: "user@example.com",
            planType: "prolite",
          },
          userId: "user-261120",
          workspaceRouting: {
            chatgptAccountId: "acct-261120",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });

  const accountInfo = await backend.accountInfoFromCodexAccount({});
  assert.equal(accountInfo.accountId, "acct-261120");
  assert.equal(accountInfo.userId, "user-261120");
  assert.equal(accountInfo.authenticatedUserId, "user-261120");
  assert.equal(accountInfo.plan, "prolite");
  assert.equal(accountInfo.email, "user@example.com");
  assert.equal(accountInfo.hasChatGptToken, true);

  const wham = await backend.buildWhamAccountsCheck();
  assert.deepEqual(wham.account_ordering, ["acct-261120"]);
  assert.equal(wham.default_account_id, "acct-261120");
  assert.equal(wham.accounts[0].account_id, "acct-261120");
  assert.equal(wham.accounts[0].account_user_id, "user-261120");
  assert.equal(wham.accounts[0].plan_type, "prolite");
  assert.equal(wham.accounts[0].is_deactivated, false);
  assert.equal(wham.accounts[0].entitlement.expires_at, null);
  assert.equal(wham.accounts[0].entitlement.has_active_subscription, true);
  assert.equal(wham.accounts[0].last_active_subscription.will_renew, false);

  const accountsCheck = await backend.buildAccountsCheck();
  const entry = accountsCheck.accounts["acct-261120"];
  assert.ok(entry, "account entry must be keyed by account id");
  assert.equal(entry.account.account_id, "acct-261120");
  assert.equal(entry.account.account_user_id, "user-261120");
  assert.equal(entry.account.is_deactivated, false);
  assert.equal(entry.entitlement.subscription_id, null);
  assert.equal(entry.entitlement.expires_at, null);
  assert.equal(entry.last_active_subscription.will_renew, false);
  assert.deepEqual(entry.features, []);
  assert.deepEqual(entry.eligible_offers, []);
});

test("26.1120 fetchIpc returns local offline fallbacks for onboarding and ChatGPT relative endpoints", async () => {
  const broadcasts = [];
  const fetchIpc = makeFetchIpc(broadcasts);

  const cases = [
    ["r-ctx", "GET", "/wham/onboarding/context", (v) => assert.ok(v && typeof v.desktop_onboarding_completed_at === "string")],
    ["r-done", "POST", "/wham/onboarding/desktop/complete", (v) => assert.ok(v && typeof v.desktop_onboarding_completed_at === "string")],
    ["r-msgs", "GET", "/wham/workspace-messages", (v) => assert.deepEqual(v, { messages: [] })],
    ["r-tbo", "GET", "/tbo?limit=25", (v) => assert.deepEqual(v, { items: [], cursor: null })],
    ["r-auto", "GET", "/automations?filter=scheduled", (v) => assert.deepEqual(v, { items: [] })],
    ["r-settings", "GET", "/settings/user", (v) => assert.deepEqual(v, {})],
    ["r-plugins", "GET", "/ps/plugins/installed?limit=1000", (v) => assert.deepEqual(v, { items: [], plugins: [], nextPageToken: null })],
  ];

  for (const [requestId, method, url, check] of cases) {
    const handled = await fetchIpc.handleFetchMessage({ requestId, method, url });
    assert.equal(handled, true);
    const msg = broadcasts.find((b) => b.payload && b.payload.requestId === requestId);
    assert.ok(msg, `missing broadcast for ${url}`);
    assert.equal(msg.payload.responseType, "success");
    assert.equal(msg.payload.status, 200);
    check(JSON.parse(msg.payload.bodyJsonString));
  }

  const celsiusHandled = await fetchIpc.handleFetchMessage({
    requestId: "r-celsius",
    method: "GET",
    url: "/celsius/ws/user",
  });
  assert.equal(celsiusHandled, true);
  const celsiusMsg = broadcasts.find((b) => b.payload && b.payload.requestId === "r-celsius");
  assert.equal(celsiusMsg.payload.responseType, "error");
  assert.equal(celsiusMsg.payload.status, 503);
});

test("26.1120 viewMessages replays app-server initialized and connected snapshots on ready and request-app-server-state", async () => {
  for (const type of ["ready", "request-app-server-state"]) {
    const broadcasts = [];
    const handlers = createViewMessageHandlers({
      debugLogs: false,
      desktopViewNoopMessageTypes: new Set(),
      statsigDefaultFeaturesConfig: "statsig_default_enable_features",
      sharedObjectSnapshot: new Map(),
      persistedState: {},
      appServerBridge: {},
      appServer: {
        getInitializationMessage: () => ({
          hostId: "local",
          transport: "stdio",
          appServerVersion: "0.172.0",
          installedCodexVersion: null,
        }),
      },
      pendingWorktrees: { handlePendingWorktreeMessage: () => true },
      desktopState: {},
      payloadShape: () => "",
      fetchIpc: { handleFetchMessage: async () => true, handleFetchStreamMessage: async () => true },
      logger: { warn: () => {}, info: () => {} },
      terminalIpc: {},
      workspaceIpc: { handleWorkspaceMessage: async () => false },
      workspaceRuntime: {},
      broadcast: (message) => broadcasts.push(message),
      contextClientId: () => "client-1",
      targetClientIdForContext: () => "client-1",
      withTargetClient: (msg, targetClientId) => ({ ...msg, targetClientId }),
      runDetached: () => {},
      patchCodexConfigResult: (r) => r,
      patchConfigRequirementsResult: (r) => r,
    });

    assert.equal(await handlers.handleViewMessage({ type }), true);
    const initEvent = broadcasts.find((b) => b.channel === "codex-app-server-initialized");
    const connEvent = broadcasts.find((b) => b.channel === "codex-app-server-connection-changed");
    assert.ok(initEvent, `${type} must broadcast codex-app-server-initialized`);
    assert.equal(initEvent.targetClientId, "client-1");
    assert.equal(initEvent.payload.appServerVersion, "0.172.0");
    assert.equal(initEvent.payload.isSnapshot, true);

    if (type === "request-app-server-state") {
      assert.ok(connEvent, `${type} must broadcast codex-app-server-connection-changed`);
      assert.equal(connEvent.targetClientId, "client-1");
      assert.equal(connEvent.payload.hostId, "local");
      assert.equal(connEvent.payload.state, "connected");
      assert.equal(connEvent.payload.isSnapshot, true);
    } else {
      assert.equal(connEvent, undefined);
    }
  }
});

test("26.1120 fetchIpc handles /ps/plugins/* via shared plugin-service contract and returns 404 for unknown plugin details", async () => {
  const broadcasts = [];
  const fetchIpc = makeFetchIpc(broadcasts);

  const expected200 = [
    ["ps-home", "/ps/plugins/home", { sections: [] }],
    ["ps-user", "/ps/plugins/list?scope=USER", { plugins: [] }],
    ["ps-ws", "/ps/plugins/list?scope=WORKSPACE", { plugins: [], pagination: { next_page_token: null } }],
    ["ps-created", "/ps/plugins/workspace/created", { plugins: [] }],
    ["ps-shared", "/ps/plugins/workspace/shared", { plugins: [] }],
    ["ps-installed", "/ps/plugins/installed?limit=1000", { items: [], plugins: [], nextPageToken: null }],
  ];
  for (const [requestId, url, expectedBody] of expected200) {
    assert.equal(await fetchIpc.handleFetchMessage({ requestId, method: "GET", url }), true);
    const msg = broadcasts.find((b) => b.payload && b.payload.requestId === requestId);
    assert.ok(msg, `missing response for ${url}`);
    assert.equal(msg.payload.responseType, "success");
    assert.equal(msg.payload.status, 200);
    assert.deepEqual(JSON.parse(msg.payload.bodyJsonString), expectedBody);
  }

  assert.equal(
    await fetchIpc.handleFetchMessage({ requestId: "ps-detail", method: "GET", url: "/ps/plugins/browser-plugin-id" }),
    true
  );
  const detailMsg = broadcasts.find((b) => b.payload && b.payload.requestId === "ps-detail");
  assert.equal(detailMsg.payload.responseType, "error");
  assert.equal(detailMsg.payload.status, 404);
});

test("26.1120 server app-fs paths allow bundled plugin/runtime assets on Windows while keeping auth.json/config.toml blocked", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const serverModulePath = require.resolve("../dist/server.js");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-appfs-test-"));
  const fakeHome = path.join(tmpRoot, "home");
  const fakeCodexHome = path.join(fakeHome, ".codex");
  const prevCodexHome = process.env.CODEX_HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;

  try {
    const pluginIcon = path.join(fakeCodexHome, ".tmp", "bundled-marketplaces", "openai-bundled", "plugins", "browser", "assets", "browser.png");
    const runtimeIcon = path.join(fakeHome, ".cache", "codex-runtimes", "codex-primary-runtime", "plugins", "logo.png");
    const authFile = path.join(fakeCodexHome, "auth.json");
    const configFile = path.join(fakeCodexHome, "config.toml");
    for (const f of [pluginIcon, runtimeIcon, authFile, configFile]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "ok");
    }

    process.env.CODEX_HOME = fakeCodexHome;
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    delete require.cache[serverModulePath];
    const { appFsPathFromRequestPath, isAllowedAppFsFile, isPublicOfficialStyleAsset } = require(serverModulePath);

    const winIconPath = appFsPathFromRequestPath(
      "/api/app-fs/@fs/C%3A/Users/demo/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/browser/assets/browser.png"
    );
    assert.equal(
      winIconPath,
      path.normalize("C:/Users/demo/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/browser/assets/browser.png")
    );
    assert.equal(isAllowedAppFsFile(pluginIcon), true);
    assert.equal(isAllowedAppFsFile(runtimeIcon), true);
    assert.equal(isAllowedAppFsFile(authFile), false);
    assert.equal(isAllowedAppFsFile(configFile), false);
    assert.equal(isPublicOfficialStyleAsset("/assets/OpenAISans-Semibold.ba1cdafb47.woff2"), true);
  } finally {
    delete require.cache[serverModulePath];
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("26.1120 assetPatches mock appServices includes notifications.registerVisibleConversation and importSound", () => {
  const { patchConnectAppHostChunk } = require("../dist/official/assetPatches.js");
  const sample =
    "function d(e){let{port1:t,port2:r}=new MessageChannel;return window.postMessage({type:`connect-app-host`,port:r},window.location.origin,[r]),n(t,e)}";
  const patched = patchConnectAppHostChunk(sample);
  assert.ok(patched.includes("registerVisibleConversation:function()"));
  assert.ok(patched.includes("importSound:function()"));
});

test("26.1120 chatgptBackend prefers OpenAI user_id/chatgpt_user_id over OAuth payload.sub", async () => {
  const makeJwt = (payload) => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${header}.${body}.sig`;
  };
  const fakeToken = makeJwt({
    sub: "google-oauth2|12345",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-real",
      user_id: "user-real",
      chatgpt_user_id: "user-real",
      chatgpt_plan_type: "prolite",
    },
    "https://api.openai.com/profile": {
      email: "profile@example.com",
    },
  });

  const backend = createChatgptBackendIpcHandlers({
    logger: { warn: () => {} },
    callAppServer: async (method) => {
      if (method === "getAuthStatus") {
        return { authMethod: "chatgpt", authToken: fakeToken };
      }
      if (method === "account/read") {
        return {
          account: {
            type: "chatgpt",
            email: "account@example.com",
            planType: "prolite",
          },
          userId: "user-real",
          workspaceRouting: {
            chatgptAccountId: "acct-real",
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  });

  const accountInfo = await backend.accountInfoFromCodexAccount({});
  assert.equal(accountInfo.accountId, "acct-real");
  assert.equal(accountInfo.userId, "user-real");
  assert.equal(accountInfo.authenticatedUserId, "user-real");
  assert.equal(accountInfo.plan, "prolite");
  assert.equal(accountInfo.email, "profile@example.com");
  assert.equal(accountInfo.hasChatGptToken, true);
});

test("26.1120 appServerHostRunner SettingsTarget.open returns spreadable plain operations object", async () => {
  const { SettingsTarget, createSettingsOpenResult } = require("../dist/official/appServerHostRunner.js");
  const target = new SettingsTarget();
  const res = target.open();
  const helperRes = createSettingsOpenResult();

  assert.equal(Object.getPrototypeOf(res.operations), Object.prototype);
  assert.equal(Object.getPrototypeOf(helperRes.operations), Object.prototype);

  const spread = { ...res.operations };
  const expectedMethods = [
    "readCatalogEntry",
    "readSettings",
    "fetchProxyConfig",
    "readCodexConfig",
    "readFollowUpQueueMode",
    "readPermissionRefreshEnabled",
    "hasReadyExecutionAssignments",
    "readExperimentPersonality",
  ];
  for (const name of expectedMethods) {
    assert.equal(typeof spread[name], "function", `spread operations must include ${name}`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(spread, "readColdResumeConfig"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spread, "readDynamicTools"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spread, "readShellEnvironment"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(spread, "readDeveloperInstructions"), false);

  assert.equal(await spread.readExperimentPersonality(), "friendly");
  assert.equal(await spread.readFollowUpQueueMode(), "send-now");
  assert.equal(await spread.readPermissionRefreshEnabled(), false);
  assert.equal(await spread.hasReadyExecutionAssignments(), true);
  assert.deepEqual(await spread.readSettings(), {
    defaultFeatureOverrides: {},
    defaultPersonality: "friendly",
    instructionOverrides: null,
    includeProseDetailLevelInstructions: false,
    writingBlocks: false,
  });

  const { PreparationTarget, ThreadsServiceTarget } = require("../dist/official/appServerHostRunner.js");
  assert.deepEqual(await new PreparationTarget().captureGit("thread-1", { cwd: "/repo" }), { result: null });
  assert.equal(await new ThreadsServiceTarget().open().readWorktreePreference("/repo"), null);
});
