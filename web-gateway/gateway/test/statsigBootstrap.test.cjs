const assert = require("node:assert/strict");
const test = require("node:test");

// 26.924 起 renderer 登录后 POST /wham/statsig/bootstrap（5 秒超时），离线时代理到远端只会超时，
// 首屏因此多等 5~10 秒；与 ab.chatgpt.com initialize 一样由 gateway 本地应答默认特性。
test("post-login statsig bootstrap is answered locally with the default features", async () => {
  const { createFetchIpcHandlers } = require("../dist/ipc/codex/fetchIpc.js");
  const broadcasts = [];
  let proxied = 0;
  const fetchIpc = createFetchIpcHandlers({
    broadcast: (message) => broadcasts.push(message),
    logger: { info: () => {}, warn: () => {} },
    chatgptBackend: {
      parseMaybeJson: (body) => (body ? JSON.parse(body) : null),
      normalizeFetchHeaders: (headers) => headers || {},
      fetchChatgptBackendRaw: async () => {
        proxied += 1;
        throw new Error("must not reach the backend");
      },
    },
    targetClientIdForContext: () => "",
    withTargetClient: (message) => message,
    invokeCodexChannel: async () => null,
    shouldPatchStatsigInitialize: () => false,
    patchStatsigDefaultFeatures: (text) => {
      const value = JSON.parse(text);
      value.feature_gates = { gate: { value: true } };
      return JSON.stringify(value);
    },
    statsigDefaultFeatureOverrides: { gate: true },
  });

  await fetchIpc.handleFetchMessage({
    requestId: "boot",
    method: "POST",
    url: "/wham/statsig/bootstrap",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stable_id: "stable-1", locale: "zh-CN", app_version: "26.924.1866.0" }),
  });

  assert.equal(proxied, 0);
  const reply = broadcasts.find((b) => b.payload.requestId === "boot").payload;
  assert.equal(reply.responseType, "success");
  assert.equal(reply.status, 200);
  const { statsigPayload } = JSON.parse(reply.bodyJsonString);
  const payload = JSON.parse(statsigPayload);
  assert.deepEqual(payload.feature_gates, { gate: { value: true } });
  assert.equal(payload.user.customIDs.stableID, "stable-1");
  assert.equal(payload.user.locale, "zh-CN");
  assert.equal(payload.user.appVersion, "26.924.1866.0");
});
