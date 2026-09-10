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
