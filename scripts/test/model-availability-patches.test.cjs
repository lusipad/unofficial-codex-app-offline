"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const initPath = path.join(repoRoot, "scripts", "desktop-patches", "init.cjs");
const patchScriptPath = path.join(repoRoot, "scripts", "patch-app-asar.mjs");
const verifyScriptPath = path.join(repoRoot, "scripts", "verify-offline-package.ps1");
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
  const fixture =
    "function x(e){let t=(0,C.c)(14),{model:n,displayName:r}=e,l;" +
    "if(r!=null){let a=F(r);l=a}else if(n){let a;" +
    "t[3]===Symbol.for(`react.memo_cache_sentinel`)?" +
    "(a=(0,J.jsx)(I,{id:`composer.mode.local.model.custom`," +
    "defaultMessage:`Custom`,description:`Custom model from config`})," +
    "t[3]=a):a=t[3],l=a}else l=n;return l}function y(){}";

  const patched = patchModelDisplayNameFallback(fixture);
  assert.equal(patched.patched, true);
  assert.match(
    patched.content,
    /else if\(n\)l=F\(n\)\/\*codex-offline:model-id-display-name-fallback\*\//,
  );
  assert.doesNotMatch(patched.content, /defaultMessage:`Custom`/);

  const secondPass = patchModelDisplayNameFallback(patched.content);
  assert.equal(secondPass.alreadyCorrect, true);
  assert.equal(secondPass.content, patched.content);
  assert.match(source, /failRequiredPatch\([\s\S]*Custom model-label fallback/);
});

test("package verification requires both model availability patches", () => {
  const marker = "/*codex-offline:model-id-display-name-fallback*/";
  const contract = require(capabilityContractPath);
  const verifier = fs.readFileSync(verifyScriptPath, "utf8");

  assert.ok(contract.DESKTOP_ASAR_PATCH_MARKERS.includes(marker));
  assert.match(verifier, /requiredPatchMarker\('\/\*codex-offline:model-id-display-name-fallback\*\/'\)/);
  assert.match(verifier, /desktopModelAvailabilityMarkers/);
  assert.match(verifier, /STATSIG_MODEL_AVAILABILITY_CONFIG = '107580212'/);
  assert.match(verifier, /result\.key === STATSIG_MODEL_AVAILABILITY_CONFIG/);
});
