"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const compatPath = path.join(
  repoRoot,
  "scripts",
  "desktop-patches",
  "plugin-service-compat.cjs",
);
const initPath = path.join(repoRoot, "scripts", "desktop-patches", "init.cjs");
const fetchIpcPath = path.join(
  repoRoot,
  "web-gateway",
  "gateway",
  "src",
  "ipc",
  "codex",
  "fetchIpc.ts",
);

function loadFetchIpc(compat) {
  const source = fs
    .readFileSync(fetchIpcPath, "utf8")
    .replace(/^export \{\};\r?\n/m, "");
  const loaded = { exports: {} };
  const localRequire = (request) => {
    if (request === "./pluginServiceCompat.cjs") return compat;
    return require(request);
  };
  Function("require", "module", "exports", source)(
    localRequire,
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

function createFetchDeps(broadcasts) {
  return {
    broadcast(message) {
      broadcasts.push(message);
    },
    logger: { info() {}, warn() {} },
    chatgptBackend: {
      parseMaybeJson(value) {
        return value;
      },
      normalizeFetchHeaders(value) {
        return value || {};
      },
    },
    targetClientIdForContext() {
      return "";
    },
    withTargetClient(message) {
      return message;
    },
    invokeCodexChannel() {
      throw new Error("unexpected invokeCodexChannel");
    },
    shouldPatchStatsigInitialize() {
      return false;
    },
    patchStatsigDefaultFeatures() {
      return null;
    },
    statsigDefaultFeatureOverrides: {},
  };
}

test("shared plugin-service contract matches only the supported read surfaces", () => {
  const compat = require(compatPath);
  const cases = [
    ["/ps/plugins/home", "home", { sections: [] }],
    [
      "https://chatgpt.com/backend-api/ps/plugins/list?limit=9&scope=USER",
      "user-list",
      { plugins: [] },
    ],
    [
      "/ps/plugins/list?scope=WORKSPACE&pageToken=next",
      "workspace-list",
      { plugins: [], pagination: { next_page_token: null } },
    ],
    ["/ps/plugins/workspace/created?limit=9", "workspace-created", { plugins: [] }],
    ["/ps/plugins/workspace/shared", "workspace-shared", { plugins: [] }],
  ];

  for (const [url, surface, value] of cases) {
    assert.deepEqual(
      compat.matchPluginServiceRequest({ method: "GET", url }),
      { surface, value },
      url,
    );
  }

  for (const request of [
    { method: "POST", url: "/ps/plugins/home" },
    { method: "GET", url: "/ps/plugins/home/extra" },
    { method: "GET", url: "/ps/plugins/list" },
    { method: "GET", url: "/ps/plugins/list?scope=UNKNOWN" },
    { method: "GET", url: "/ps/plugins/workspace/deleted" },
    { method: "GET", url: "/wham/usage" },
  ]) {
    assert.equal(compat.matchPluginServiceRequest(request), null, request.url);
  }
});

test("shared contract degrades transport failures without hiding HTTP errors", () => {
  const compat = require(compatPath);
  const request = {
    requestId: "plugin-home",
    method: "GET",
    url: "/ps/plugins/home",
  };
  const fallback = compat.pluginServiceFallbackForError(request, {
    responseType: "error",
    status: 500,
    error: "net::ERR_INTERNET_DISCONNECTED",
    errorCode: "ERR_INTERNET_DISCONNECTED",
  });

  assert.deepEqual(fallback, {
    requestId: "plugin-home",
    responseType: "success",
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    bodyText: '{"sections":[]}',
    bodyJsonString: '{"sections":[]}',
  });
  assert.equal(
    compat.pluginServiceFallbackForError(request, {
      responseType: "error",
      status: 401,
      error: "Unauthorized",
    }),
    null,
  );
  assert.equal(
    compat.pluginServiceFallbackForError(request, {
      responseType: "error",
      status: 499,
      error: "The operation was aborted",
      errorCode: "ABORT_ERR",
    }),
    null,
  );
  assert.ok(
    compat.pluginServiceFallbackForError(
      { ...request, requestId: "node-fetch" },
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      }),
    ),
  );
});

test("Web Gateway applies the shared fallback only when plugin transport fails", async () => {
  const compat = require(compatPath);
  const { createFetchIpcHandlers } = loadFetchIpc(compat);
  const broadcasts = [];
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ENOTFOUND" },
      });
    };
    const handlers = createFetchIpcHandlers(createFetchDeps(broadcasts));
    await handlers.handleFetchMessage({
      type: "fetch",
      requestId: "web-plugin-home",
      method: "GET",
      url: "https://chatgpt.com/backend-api/ps/plugins/home",
    });

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].payload.responseType, "success");
    assert.equal(broadcasts[0].payload.status, 200);
    assert.equal(broadcasts[0].payload.bodyJsonString, '{"sections":[]}');

    broadcasts.length = 0;
    await handlers.handleFetchMessage({
      type: "fetch",
      requestId: "ordinary-failure",
      method: "GET",
      url: "https://example.com/data",
    });
    assert.equal(broadcasts[0].payload.responseType, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop adapter correlates plugin fetch failures per webContents and requestId", async () => {
  const registeredHandlers = new Map();
  const sent = [];
  const wc = {
    id: 41,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  const electron = {
    app: { on() {} },
    ipcMain: {
      handle(channel, handler) {
        registeredHandlers.set(channel, handler);
      },
      on() {},
    },
    session: {
      defaultSession: {
        webRequest: { onBeforeRequest() {} },
      },
    },
    webContents: { getAllWebContents: () => [wc] },
  };

  const originalLoad = Module._load;
  const originalActiveMarker = process.env.CODEX_OFFLINE_PATCH_ACTIVE;
  try {
    Module._load = function (request, parent, isMain) {
      if (request === "electron") return electron;
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(initPath)];
    require(initPath);

    electron.ipcMain.handle("view-message", async () => true);
    const handle = registeredHandlers.get("view-message");
    const event = { sender: wc };
    await handle(event, {
      type: "fetch",
      requestId: "desktop-plugin-home",
      method: "GET",
      url: "/ps/plugins/home",
    });
    wc.send("message-to-view", {
      type: "fetch-response",
      requestId: "desktop-plugin-home",
      responseType: "error",
      status: 500,
      error: "net::ERR_INTERNET_DISCONNECTED",
      errorCode: "ERR_INTERNET_DISCONNECTED",
    });
    assert.equal(sent.at(-1).payload.responseType, "success");
    assert.equal(sent.at(-1).payload.bodyJsonString, '{"sections":[]}');

    await handle(event, {
      type: "fetch",
      requestId: "desktop-http-error",
      method: "GET",
      url: "/ps/plugins/home",
    });
    wc.send("message-to-view", {
      type: "fetch-response",
      requestId: "desktop-http-error",
      responseType: "error",
      status: 401,
      error: "Unauthorized",
    });
    assert.equal(sent.at(-1).payload.responseType, "error");

    await handle(event, {
      type: "fetch",
      requestId: "desktop-cancelled",
      method: "GET",
      url: "/ps/plugins/home",
    });
    await handle(event, { type: "cancel-fetch", requestId: "desktop-cancelled" });
    wc.send("message-to-view", {
      type: "fetch-response",
      requestId: "desktop-cancelled",
      responseType: "error",
      status: 500,
      error: "net::ERR_INTERNET_DISCONNECTED",
      errorCode: "ERR_INTERNET_DISCONNECTED",
    });
    assert.equal(sent.at(-1).payload.responseType, "error");
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(initPath)];
    if (originalActiveMarker === undefined) {
      delete process.env.CODEX_OFFLINE_PATCH_ACTIVE;
    } else {
      process.env.CODEX_OFFLINE_PATCH_ACTIVE = originalActiveMarker;
    }
  }
});
