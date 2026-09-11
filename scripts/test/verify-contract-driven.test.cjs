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
const verifier = fs.readFileSync(
  path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
  "utf8",
);
const patcher = fs.readFileSync(
  path.join(repoRoot, "scripts", "patch-app-asar.mjs"),
  "utf8",
);

test("patches that bypassed the contract are now declared in it", () => {
  for (const marker of [
    "/*codex-offline:settings-route-map*/",
    "/*codex-offline:locale-source-default*/",
    "/*codex-offline:stdio-write-error-guard-v2*/",
    "/*codex-offline:i18n-default-enabled*/",
  ]) {
    assert.ok(contract.getPatchRecord(marker), `missing from contract: ${marker}`);
  }
});

test("the verifier resolves patch records instead of bare markers", () => {
  assert.match(verifier, /function patchAssertion\(/);
  assert.ok(
    !verifier.includes("requiredPatchMarker"),
    "the marker-only lookup should be replaced by the record lookup",
  );
  assert.match(
    verifier,
    /const STDIO_WRITE_ERROR_GUARD_MARKER = patchMarker\(/,
    "the stdio guard marker must be resolved through the contract, not declared as a literal",
  );
});

test("the verifier separates required failures from degraded warnings", () => {
  assert.match(verifier, /degradedPatchWarnings/);
  assert.ok(
    contract.patchMarkersByTier("degraded").length > 0,
    "there should still be degraded entries to warn about",
  );
});

test("patches that can assert negatively do so", () => {
  const negative = contract.DESKTOP_ASAR_PATCHES.filter((r) => r.assert === "negative");
  const markers = negative.map((r) => r.marker);
  assert.ok(
    markers.includes("/*codex-offline:locale-source-default*/"),
    "locale_source has an upstream bad shape to assert against",
  );
  assert.ok(
    markers.includes("/*codex-offline:i18n-default-enabled*/"),
    "enable_i18n has an upstream bad shape to assert against",
  );
});

test("the i18n patch now carries an identity of its own", () => {
  assert.match(
    patcher,
    /codex-offline:i18n-default-enabled/,
    "the enable_i18n patch used to land with no marker at all",
  );
});
