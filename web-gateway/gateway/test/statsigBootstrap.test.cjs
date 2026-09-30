const assert = require("node:assert/strict");
const test = require("node:test");

// 26.928 起「应用快照」（composer 捕获入口 + 设置分区）由 Statsig dynamic config
// 1193530394 的 appshots_enabled 驱动；Web 本地 initialize fallback 的
// dynamic_configs 若不带它，renderer 解析缺省为 false，功能入口整体消失。
test("26.928 appshots feature rides the 1193530394 dynamic config", () => {
  const { patchStatsigDefaultFeatures } = require("../dist/ipc/codex/featurePatches.js");
  const out = JSON.parse(patchStatsigDefaultFeatures(JSON.stringify({
    has_updates: true,
    time: 1,
    feature_gates: {},
    dynamic_configs: {},
    layer_configs: {},
    param_stores: {},
    exposures: {},
    sdk_flags: {},
  })));
  const config = out.dynamic_configs["1193530394"];
  assert.ok(config, "the 1193530394 dynamic config must exist in the fallback payload");
  assert.equal(config.value.appshots_enabled, true);
  // 既有 statsig_default_enable_features 注入不受影响
  const defaults = out.dynamic_configs["statsig_default_enable_features"];
  assert.ok(defaults && Object.keys(defaults.value).length > 0, "legacy defaults config must stay");
});

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
