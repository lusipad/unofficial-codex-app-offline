"use strict";

const assert = require("node:assert/strict");
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

const KINDS = new Set(["patch", "sentinel"]);
const TIERS = new Set(["required", "degraded"]);
const ASSERTS = new Set(["negative", "marker", "absent"]);

test("every patch record has a complete, valid shape", () => {
  assert.ok(Array.isArray(contract.DESKTOP_ASAR_PATCHES));
  assert.ok(contract.DESKTOP_ASAR_PATCHES.length > 0);

  for (const record of contract.DESKTOP_ASAR_PATCHES) {
    assert.equal(typeof record.marker, "string", `marker: ${JSON.stringify(record)}`);
    assert.ok(record.marker.includes("codex-offline:"), record.marker);
    assert.ok(KINDS.has(record.kind), `${record.marker} kind=${record.kind}`);
    assert.ok(TIERS.has(record.tier), `${record.marker} tier=${record.tier}`);
    assert.ok(ASSERTS.has(record.assert), `${record.marker} assert=${record.assert}`);
    assert.ok(record.evidence.length > 0, `${record.marker} needs evidence`);
    assert.ok(record.reverify.length > 0, `${record.marker} needs reverify`);
  }
});

test("markers are unique", () => {
  const seen = new Set();
  for (const record of contract.DESKTOP_ASAR_PATCHES) {
    assert.ok(!seen.has(record.marker), `duplicate marker: ${record.marker}`);
    seen.add(record.marker);
  }
});

test("DESKTOP_ASAR_PATCH_MARKERS is derived from the records in order", () => {
  assert.deepEqual(
    contract.DESKTOP_ASAR_PATCH_MARKERS,
    contract.DESKTOP_ASAR_PATCHES.map((record) => record.marker),
  );
});

test("patches never assert absence", () => {
  for (const record of contract.DESKTOP_ASAR_PATCHES) {
    if (record.kind === "sentinel") continue;
    assert.notEqual(record.assert, "absent", `${record.marker} is a patch but asserts absent`);
  }
});

const REMOVED_MARKERS = [
  "/* codex-offline:windowsStore-patch */",
  "/*codex-offline:electron-namespace-no-auto-updater*/",
  "/*codex-offline:fast-mode-selector*/",
  "/*codex-offline:fast-mode-service-tier-options*/",
  "/*codex-offline:context-usage-visible*/",
  "/*codex-offline:node-repl-config-reconcile-finally*/",
  "/*codex-offline:feature-enablement-preserve-unified-exec*/",
  "/*codex-offline:computer-use-input-mention*/",
  "/*codex-offline:computer-use-input-mention-v2*/",
  "/*codex-offline:unified-plugins-page*/",
  "/*codex-offline:computer-use-plugin-root-fallback*/",
];

test("the surviving Computer Use runtime-path sentinel records what it absorbed", () => {
  const survivor = contract.getPatchRecord(
    "/*codex-offline:computer-use-resource-runtime-paths*/",
  );
  assert.ok(survivor, "computer-use-resource-runtime-paths must survive");
  assert.match(survivor.evidence, /plugin-root-fallback/);
});

test("legacy plugin-page migration is gone from the patcher", () => {
  const fs = require("node:fs");
  const patcher = fs.readFileSync(path.join(repoRoot, "scripts", "patch-app-asar.mjs"), "utf8");
  assert.ok(
    !patcher.includes("migrateLegacyPluginsPageSelection"),
    "the legacy plugins-page migration only fires on already-patched input",
  );
  assert.ok(
    !patcher.includes("_codexOfflineComputerUseMentionItems"),
    "the Computer Use mention helper had no applier and should be gone",
  );
});

test("retired patches are gone from the contract", () => {
  for (const marker of REMOVED_MARKERS) {
    assert.equal(contract.getPatchRecord(marker), undefined, `still present: ${marker}`);
    assert.ok(!contract.DESKTOP_ASAR_PATCH_MARKERS.includes(marker), marker);
  }
});

test("retired patches leave no residue in the patcher or verifier", () => {
  const fs = require("node:fs");
  const patcher = fs.readFileSync(path.join(repoRoot, "scripts", "patch-app-asar.mjs"), "utf8");
  const verifier = fs.readFileSync(
    path.join(repoRoot, "scripts", "verify-offline-package.ps1"),
    "utf8",
  );
  for (const marker of REMOVED_MARKERS) {
    const slug = marker.replace(/\/\*\s?|\s?\*\//g, "");
    assert.ok(!patcher.includes(slug), `patch-app-asar.mjs still references ${slug}`);
    assert.ok(!verifier.includes(slug), `verify-offline-package.ps1 still references ${slug}`);
  }
  assert.ok(
    !patcher.includes("MSIX_UPDATER_BINDING_STUB"),
    "MSIX updater stub should be gone with the windowsStore patch",
  );
  assert.ok(
    !patcher.includes("process.windowsStore=true"),
    "windowsStore injection should be gone",
  );
});

test("lookup helpers agree with the records", () => {
  const first = contract.DESKTOP_ASAR_PATCHES[0];
  assert.equal(contract.getPatchRecord(first.marker).kind, first.kind);
  assert.equal(contract.getPatchRecord("/*codex-offline:does-not-exist*/"), undefined);

  const required = contract.patchMarkersByTier("required");
  const degraded = contract.patchMarkersByTier("degraded");
  assert.equal(
    required.length + degraded.length,
    contract.DESKTOP_ASAR_PATCHES.length,
  );

  const patches = contract.patchMarkersByKind("patch");
  const sentinels = contract.patchMarkersByKind("sentinel");
  assert.equal(
    patches.length + sentinels.length,
    contract.DESKTOP_ASAR_PATCHES.length,
  );
});
