"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(repoRoot, "scripts", "patch-app-asar.mjs"), "utf8");

test("no numbered shape variants remain", () => {
  const variants = [...new Set(source.match(/[A-Z_0-9]*_RE_V\d|[A-Z_0-9]*_V\d_RE/g) ?? [])];
  assert.deepEqual(variants, [], `variant constants left: ${variants.join(", ")}`);
});

test("no historical shape constants remain", () => {
  const legacy = [...new Set(source.match(/LEGACY_[A-Z_0-9]+/g) ?? [])];
  assert.deepEqual(legacy, [], `legacy constants left: ${legacy.join(", ")}`);
});

test("the patcher states the single-shape rule", () => {
  assert.match(
    source,
    /only the shape used by the current Store payload/i,
    "the hardening principles must say a drifted patch is rewritten, not extended",
  );
});
