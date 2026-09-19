"use strict";

// Regression cover for the 26.915 launch failure (issue #116).
//
// 26.915 added `codexWindowsAppContainedCore: "1"` to the bundle's
// package.json. With it set, the main-process bootstrap takes an MSIX-only
// branch that calls the native updater's getCurrentPackageFamily() *before*
// importing the main app. Outside an MSIX container that native call throws
// "The process has no package identity."; the bootstrap catch then destroys
// every window and the app never starts. A pristine 26.915 payload reproduces
// this with zero offline patches applied, so this is upstream behaviour the
// offline package has to opt out of.

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
const contract = require(path.join(
  repoRoot,
  "web-gateway",
  "gateway",
  "src",
  "ipc",
  "codex",
  "capabilityContractData.cjs",
));

const MARKER = "/*codex-offline:windows-app-contained-core-off*/";

function sourceSlice(startNeedle, endNeedle) {
  const start = patchScriptSource.indexOf(startNeedle);
  assert.notEqual(start, -1, `${startNeedle} is missing`);
  const end = patchScriptSource.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `${endNeedle} is missing`);
  return patchScriptSource.slice(start, end);
}

function loadPatcher() {
  const source = sourceSlice(
    "const WINDOWS_APP_CONTAINED_CORE_FIELD",
    "// ── End windows app-contained core ──",
  );
  return Function(
    `"use strict";\n${source}\nreturn { disableWindowsAppContainedCore, WINDOWS_APP_CONTAINED_CORE_FIELD };`,
  )();
}

function manifest(value) {
  const base = { name: "openai-codex-electron", version: "26.915.31945" };
  if (value !== undefined) base.codexWindowsAppContainedCore = value;
  base.codexWindowsPackageIdentity = "OpenAI.Codex";
  return `${JSON.stringify(base, null, 2)}\n`;
}

test("the 26.915 app-contained core gate is turned off", () => {
  const { disableWindowsAppContainedCore } = loadPatcher();
  const result = disableWindowsAppContainedCore(manifest("1"));

  assert.equal(result.status, "patched");
  assert.equal(JSON.parse(result.text).codexWindowsAppContainedCore, "0");
});

test("unrelated manifest fields survive the rewrite", () => {
  const { disableWindowsAppContainedCore } = loadPatcher();
  const result = disableWindowsAppContainedCore(manifest("1"));
  const parsed = JSON.parse(result.text);

  assert.equal(parsed.name, "openai-codex-electron");
  assert.equal(parsed.version, "26.915.31945");
  assert.equal(parsed.codexWindowsPackageIdentity, "OpenAI.Codex");
});

test("a missing gate field is reported instead of silently passing", () => {
  // Upstream dropping the field must reach a human: the bootstrap branch it
  // guards may have been restructured too.
  const { disableWindowsAppContainedCore } = loadPatcher();
  assert.equal(disableWindowsAppContainedCore(manifest()).status, "missing");
});

test("an unexpected gate value is reported instead of being coerced", () => {
  const { disableWindowsAppContainedCore } = loadPatcher();
  const result = disableWindowsAppContainedCore(manifest("2"));

  assert.equal(result.status, "unexpected");
  assert.equal(result.current, "2");
});

test("an already-disabled gate is left alone", () => {
  const { disableWindowsAppContainedCore } = loadPatcher();
  assert.equal(disableWindowsAppContainedCore(manifest("0")).status, "already-correct");
});

test("a gate miss fails the build rather than shipping a package that cannot launch", () => {
  const applySource = sourceSlice(
    "  const containedCore = disableWindowsAppContainedCore(",
    "  const chromeBrowserClientHash =",
  );
  assert.match(
    applySource,
    /failRequiredPatch\(/,
    "the app-contained core gate must be a required patch: without it the app never starts",
  );
  assert.ok(
    !/\bwarn\(/.test(applySource),
    "a launch-blocking gate must not degrade to a warning",
  );
});

test("the capability contract records the gate as a required negative assertion", () => {
  const record = contract.getPatchRecord(MARKER);
  assert.ok(record, `capability contract is missing ${MARKER}`);
  assert.equal(record.kind, "patch");
  assert.equal(record.tier, "required");
  assert.equal(record.assert, "negative");
  assert.match(record.evidence, /26\.915/);
  assert.ok(record.reverify.length > 0);
});

test("the verifier rejects a package that still ships the gate enabled", () => {
  assert.ok(
    verifierScriptSource.includes(MARKER),
    "verify-offline-package.ps1 must assert the gate through the contract record",
  );
  assert.ok(
    verifierScriptSource.includes("codexWindowsAppContainedCore"),
    "the verifier must read the manifest field it asserts on",
  );
});
