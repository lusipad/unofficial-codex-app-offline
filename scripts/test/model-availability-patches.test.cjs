"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const initPath = path.join(repoRoot, "scripts", "desktop-patches", "init.cjs");
const patchScriptPath = path.join(repoRoot, "scripts", "patch-app-asar.mjs");
const buildScriptPath = path.join(repoRoot, "scripts", "build-offline-package.ps1");
const modelCatalogBuilderPath = path.join(repoRoot, "scripts", "build-api-model-catalog.mjs");
const modelCatalogCompatPath = path.join(
  repoRoot,
  "scripts",
  "desktop-patches",
  "model-catalog-compat.cjs",
);
const verifyScriptPath = path.join(repoRoot, "scripts", "verify-offline-package.ps1");
const modelCatalogDocPath = path.join(repoRoot, "docs", "models-api.md");
const readmePath = path.join(repoRoot, "README.md");
const capabilityContractPath = path.join(
  repoRoot,
  "web-gateway",
  "gateway",
  "src",
  "ipc",
  "codex",
  "capabilityContractData.cjs",
);
const modelConfigId = "107580212";
const clearedModelConfig = {
  available_models: [],
  use_hidden_models: false,
};

test("Statsig interception clears cached model allowlists in every response shape", () => {
  const registeredHandlers = new Map();
  let webRequestHandler;
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
        webRequest: {
          onBeforeRequest(_filter, handler) {
            webRequestHandler = handler;
          },
        },
      },
    },
    webContents: { getAllWebContents: () => [] },
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

    electron.ipcMain.handle("shared-object-get", (_event, payload) => payload);
    const handle = registeredHandlers.get("shared-object-get");
    assert.equal(typeof handle, "function");

    const oldEntry = () => ({
      name: modelConfigId,
      rule_id: "old-rule",
      value: { available_models: ["gpt-old"], use_hidden_models: true },
    });
    const snapshot = {
      dynamic_configs: { [modelConfigId]: oldEntry() },
      dynamicConfigs: { [modelConfigId]: oldEntry() },
      configs: { [modelConfigId]: oldEntry() },
    };
    handle({}, snapshot);
    for (const key of ["dynamic_configs", "dynamicConfigs", "configs"]) {
      assert.deepEqual(snapshot[key][modelConfigId].value, clearedModelConfig);
    }

    const raw = { key: modelConfigId, value: oldEntry().value };
    handle({}, raw);
    assert.deepEqual(raw.value, clearedModelConfig);

    const wrapped = { key: modelConfigId, value: oldEntry() };
    handle({}, wrapped);
    assert.deepEqual(wrapped.value.value, clearedModelConfig);

    let redirect;
    webRequestHandler({}, (response) => {
      redirect = response.redirectURL;
    });
    const fakeResponse = JSON.parse(
      decodeURIComponent(redirect.slice(redirect.indexOf(",") + 1)),
    );
    assert.deepEqual(
      fakeResponse.dynamic_configs[modelConfigId].value,
      clearedModelConfig,
    );
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

test("asar model-label patch replaces Custom with the existing ID formatter", () => {
  const source = fs.readFileSync(patchScriptPath, "utf8");
  const functionStart = source.indexOf("function patchModelDisplayNameFallback");
  const functionEnd = source.indexOf("\n// end patchModelDisplayNameFallback", functionStart);
  assert.notEqual(functionStart, -1, "model display-name patch helper is missing");
  assert.notEqual(functionEnd, -1, "model display-name patch helper terminator is missing");

  const helperSource = source.slice(functionStart, functionEnd);
  const patchModelDisplayNameFallback = Function(
    '"use strict";\n' +
      'const MODEL_DISPLAY_NAME_FALLBACK_PATCH_MARKER = ' +
      '`/*codex-offline:model-id-display-name-fallback*/`;\n' +
      `${helperSource}\nreturn patchModelDisplayNameFallback;`,
  )();
  const fixtures = [
    {
      source:
        "function x(e){let t=(0,C.c)(14),{model:n,displayName:r}=e,l;" +
        "if(r!=null){let a=F(r);l=a}else if(n){let a;" +
        "t[3]===Symbol.for(`react.memo_cache_sentinel`)?" +
        "(a=(0,J.jsx)(I,{id:`composer.mode.local.model.custom`," +
        "defaultMessage:`Custom`,description:`Custom model from config`})," +
        "t[3]=a):a=t[3],l=a}else l=n;return l}function y(){}",
      expected: "else if(n)l=F(n)/*codex-offline:model-id-display-name-fallback*/",
    },
    {
      source:
        "function P4(e){let t=(0,Gar.c)(16),{model:n,displayName:r," +
        "labelClassName:i}=e,u;" +
        "if(r!=null){let e=c&&!l,n;t[0]!==r||t[1]!==e?" +
        "(n=jW(r,{stripGptPrefix:e}),t[0]=r,t[1]=e,t[2]=n):n=t[2],u=n" +
        "}else if(n){let e;t[3]===Symbol.for(`react.memo_cache_sentinel`)?" +
        "(e=(0,F4.jsx)($,{id:`composer.mode.local.model.custom`," +
        "defaultMessage:`Custom`,description:`Custom model from config`})," +
        "t[3]=e):e=t[3],u=e}else u=n;return u}function y(){}",
      expected: "else if(n)u=jW(n)/*codex-offline:model-id-display-name-fallback*/",
    },
  ];

  for (const fixture of fixtures) {
    const patched = patchModelDisplayNameFallback(fixture.source);
    assert.equal(patched.patched, true);
    assert.ok(patched.content.includes(fixture.expected));
    assert.doesNotMatch(patched.content, /defaultMessage:`Custom`/);

    const secondPass = patchModelDisplayNameFallback(patched.content);
    assert.equal(secondPass.alreadyCorrect, true);
    assert.equal(secondPass.content, patched.content);
  }

  assert.match(source, /failRequiredPatch\([\s\S]*Custom model-label fallback/);
});

test("package verification requires both model availability patches", () => {
  const marker = "/*codex-offline:model-id-display-name-fallback*/";
  const contract = require(capabilityContractPath);
  const verifier = fs.readFileSync(verifyScriptPath, "utf8");

  assert.ok(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(marker));
  assert.match(verifier, /patchMarker\('\/\*codex-offline:model-id-display-name-fallback\*\/'\)/);
  assert.match(verifier, /desktopModelAvailabilityMarkers/);
  assert.match(verifier, /STATSIG_MODEL_AVAILABILITY_CONFIG = '107580212'/);
  assert.match(verifier, /result\.key === STATSIG_MODEL_AVAILABILITY_CONFIG/);
  assert.match(verifier, /patchModelListResponsePayload/);
  assert.match(verifier, /patchWireModelListResult/);
  assert.match(verifier, /STATSIG_DEFAULT_DYNAMIC_CONFIGS/);
});

test("shared model compatibility exposes Astra without exposing other hidden models", () => {
  const { ASTRA_MODEL_SLUG, patchModelListResult } = require(modelCatalogCompatPath);
  const original = {
    data: [
      { model: "gpt-hidden-other", hidden: true },
      { model: "gpt-5.6-sol", hidden: false },
    ],
    nextCursor: null,
  };

  const patched = patchModelListResult(original);
  assert.equal(patched.data[0].model, ASTRA_MODEL_SLUG);
  assert.equal(patched.data[0].displayName, "GPT-6-Astra");
  assert.equal(patched.data[0].hidden, false);
  assert.equal(
    patched.data.find((model) => model.model === "gpt-hidden-other").hidden,
    true,
  );
  assert.deepEqual(original.data.map((model) => model.model), [
    "gpt-hidden-other",
    "gpt-5.6-sol",
  ]);

  const existing = patchModelListResult({
    data: [{ model: ASTRA_MODEL_SLUG, displayName: "GPT-6-Astra", hidden: true }],
  });
  assert.equal(existing.data.length, 1);
  assert.equal(existing.data[0].hidden, false);
});

test("shared model list patch unhides gpt-6.1-sol but never synthesizes it", () => {
  const { ASTRA_MODEL_SLUG, GPT_6_1_SOL_SLUG, patchModelListResult } = require(
    modelCatalogCompatPath,
  );
  const original = {
    data: [
      { model: GPT_6_1_SOL_SLUG, displayName: "GPT-6.1 Sol", hidden: true },
      { model: "gpt-hidden-other", hidden: true },
    ],
    nextCursor: null,
  };

  const patched = patchModelListResult(original);
  assert.equal(
    patched.data.find((model) => model.model === GPT_6_1_SOL_SLUG).hidden,
    false,
  );
  assert.equal(
    patched.data.find((model) => model.model === "gpt-hidden-other").hidden,
    true,
  );
  // Gateway Astra 合成语义保持不变。
  assert.ok(patched.data.some((model) => model.model === ASTRA_MODEL_SLUG));

  // 本地目录没有 6.1 时不得向 API-key 用户合成一个后端不存在的模型。
  const without61 = patchModelListResult({ data: [{ model: "gpt-5.6-sol", hidden: false }] });
  assert.equal(
    without61.data.some((model) => model.model === GPT_6_1_SOL_SLUG),
    false,
  );
});

test("wire model list patch unhides only listed slugs and never synthesizes entries", () => {
  const { GPT_6_1_SOL_SLUG, patchWireModelListResult } = require(modelCatalogCompatPath);
  const otherHidden = { model: "gpt-hidden-other", hidden: true };
  const out = patchWireModelListResult({
    data: [{ model: GPT_6_1_SOL_SLUG, displayName: "GPT-6.1 Sol", hidden: true }, otherHidden],
    nextCursor: null,
  });
  assert.equal(out.data[0].hidden, false);
  assert.equal(out.data[1].hidden, true);
  // 桌面 wire 路径不做任何目录合成（包括 Astra）。
  assert.equal(out.data.length, 2);

  const absent = patchWireModelListResult({ data: [otherHidden] });
  assert.equal(absent.data.length, 1);

  const unchanged = patchWireModelListResult({
    data: [{ model: "gpt-5.6-sol", hidden: false }],
  });
  assert.equal(unchanged.data[0].hidden, false);

  const asArray = patchWireModelListResult([{ model: GPT_6_1_SOL_SLUG, hidden: true }]);
  assert.equal(asArray[0].hidden, false);
  assert.ok(Array.isArray(asArray));
});

function loadInitWithMockElectron(electron) {
  const originalLoad = Module._load;
  const originalActiveMarker = process.env.CODEX_OFFLINE_PATCH_ACTIVE;
  let webRequestHandler;
  const mockElectron = Object.assign(
    {
      app: { on() {} },
      ipcMain: { handle() {}, on() {} },
      session: {
        defaultSession: {
          webRequest: {
            onBeforeRequest(_filter, handler) {
              webRequestHandler = handler;
            },
          },
        },
      },
      webContents: { getAllWebContents: () => [] },
    },
    electron,
  );
  try {
    Module._load = function (request, parent, isMain) {
      if (request === "electron") return mockElectron;
      // 构建期才把 gateway 的共享契约拷到 patches/ 旁；测试直接喂真实契约，
      // 与打包后 init.cjs 看到的导出保持一致。
      if (request === "./capabilityContractData.cjs") return require(capabilityContractPath);
      return originalLoad.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve(initPath)];
    require(initPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(initPath)];
    if (originalActiveMarker === undefined) {
      delete process.env.CODEX_OFFLINE_PATCH_ACTIVE;
    } else {
      process.env.CODEX_OFFLINE_PATCH_ACTIVE = originalActiveMarker;
    }
  }
  return { mockElectron, getWebRequestHandler: () => webRequestHandler };
}

test("desktop init.cjs seeds the appshots dynamic config into the fake Statsig initialize", () => {
  const { getWebRequestHandler } = loadInitWithMockElectron({});
  const handler = getWebRequestHandler();
  assert.equal(typeof handler, "function");
  let redirect;
  handler({}, (response) => {
    redirect = response.redirectURL;
  });
  const fakeResponse = JSON.parse(
    decodeURIComponent(redirect.slice(redirect.indexOf(",") + 1)),
  );
  const appshotsConfig = fakeResponse.dynamic_configs["1193530394"];
  assert.ok(appshotsConfig, "1193530394 dynamic config must be seeded");
  assert.equal(appshotsConfig.value.appshots_enabled, true);
  // 既有 model availability 清空与默认 gate 注入不受影响。
  assert.deepEqual(fakeResponse.dynamic_configs["107580212"].value, clearedModelConfig);
  const defaults = fakeResponse.dynamic_configs["statsig_default_enable_features"];
  assert.ok(defaults && Object.keys(defaults.value).length > 0);
});

test("desktop init.cjs unhides gpt-6.1-sol on wire model/list responses only", () => {
  let windowCreatedHandler;
  const { mockElectron } = loadInitWithMockElectron({
    app: {
      on(event, handler) {
        if (event === "browser-window-created") windowCreatedHandler = handler;
      },
    },
  });
  assert.equal(typeof windowCreatedHandler, "function");

  const sent = [];
  const fakeWc = {
    id: 1,
    send(...args) {
      sent.push(args);
    },
  };
  windowCreatedHandler({}, { webContents: fakeWc });

  const modelListPayload = {
    type: "mcp-response",
    hostId: "local",
    requestMethod: "model/list",
    message: {
      id: 7,
      result: {
        data: [
          { model: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", hidden: true },
          { model: "gpt-5.6-sol", hidden: false },
        ],
        nextCursor: null,
      },
    },
  };
  fakeWc.send("codex_desktop:message-for-view", modelListPayload);
  assert.equal(modelListPayload.message.result.data[0].hidden, false);
  assert.equal(modelListPayload.message.result.data[1].hidden, false);
  assert.equal(modelListPayload.message.id, 7);

  // 其它 requestMethod 的负载不得改写（即使内容长得像模型列表）。
  const otherPayload = {
    type: "mcp-response",
    hostId: "local",
    requestMethod: "thread/list",
    message: {
      id: 8,
      result: { data: [{ model: "gpt-6.1-sol", hidden: true }] },
    },
  };
  fakeWc.send("codex_desktop:message-for-view", otherPayload);
  assert.equal(otherPayload.message.result.data[0].hidden, true);

  // 非 message-for-view 通道不动。
  const arrayPayload = [{ model: "gpt-6.1-sol", hidden: true }];
  fakeWc.send("codex_desktop:worker:git:for-view", arrayPayload);
  assert.equal(arrayPayload[0].hidden, true);
  assert.equal(sent.length, 3);
});

test("models-api.json is generated as a single release artifact with Astra, GPT-5.6 and DeepSeek compatibility fields", () => {
  const buildSource = fs.readFileSync(buildScriptPath, "utf8");
  const builderSource = fs.readFileSync(modelCatalogBuilderPath, "utf8");
  const compatSource = fs.readFileSync(modelCatalogCompatPath, "utf8");
  const verifierSource = fs.readFileSync(verifyScriptPath, "utf8");
  const docSource = fs.readFileSync(modelCatalogDocPath, "utf8");
  const readmeSource = fs.readFileSync(readmePath, "utf8");

  assert.match(buildSource, /build-api-model-catalog\.mjs/);
  assert.match(buildSource, /models-api\.json/);
  assert.match(builderSource, /OPENAI_CATALOG_URL/);
  assert.match(builderSource, /OPENAI_LATEST_CATALOG_URL/);
  assert.match(compatSource, /gpt-6-astra/);
  assert.match(builderSource, /DEEPSEEK_SETUP_URL/);
  assert.match(builderSource, /GPT_56_SLUGS/);
  assert.match(builderSource, /GPT_6_SLUGS = \["gpt-6-sol", "gpt-6-luna"\]/);
  assert.match(builderSource, /OPENAI_CUSTOM_PROVIDER_PATCH/);
  assert.match(builderSource, /deepseek-flash/);
  assert.match(builderSource, /deepseek-v4-pro/);
  assert.match(builderSource, /tool_mode: null/);
  // Capabilities are asserted per model, so a later upstream flip on one model
  // cannot be averaged away by a blanket expectation.
  assert.match(builderSource, /DEEPSEEK_EXPECTED_CAPABILITIES/);
  assert.match(builderSource, /supports_search_tool !== expected.supports_search_tool/);
  assert.match(builderSource, /web_search_tool_type !== expected.web_search_tool_type/);

  assert.match(verifierSource, /Expected exactly one models-api\.json asset/);
  assert.match(verifierSource, /API model catalog does not contain any models/);
  assert.match(verifierSource, /API model catalog has unexpected custom-provider fields for/);
  assert.match(verifierSource, /API model catalog has unexpected DeepSeek fields for/);
  assert.match(verifierSource, /gpt-6-astra/);
  // GPT-6 Sol / Luna carry the same custom-provider override as GPT-5.6.
  assert.match(verifierSource, /'gpt-5\.6-luna', 'gpt-6-sol', 'gpt-6-luna'\)\) \{/);

  assert.match(readmeSource, /models-api\.json/);
  assert.match(readmeSource, /docs\/models-api\.md/);
  assert.match(docSource, /codex\.exe --version/);
  assert.match(docSource, /deepseek-v4-flash/);
  assert.match(docSource, /退出条件/);
});
