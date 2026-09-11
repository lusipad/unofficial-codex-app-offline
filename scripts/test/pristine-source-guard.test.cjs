"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const buildScript = fs.readFileSync(
  path.join(repoRoot, "scripts", "build-offline-package.ps1"),
  "utf8",
);

test("build script defines a pristine source guard", () => {
  assert.match(buildScript, /function\s+Assert-PristineAppSource/);
});

test("the guard looks for codex-offline markers in app.asar and fails closed", () => {
  const start = buildScript.indexOf("function Assert-PristineAppSource");
  assert.notEqual(start, -1);
  const body = buildScript.slice(start, start + 2400);
  assert.match(body, /app\.asar/);
  assert.match(body, /codex-offline:/);
  assert.match(body, /throw/);
});

test("the guard runs before the source payload is staged", () => {
  const guardCall = buildScript.indexOf("Assert-PristineAppSource -AppDir");
  const stageCopy = buildScript.indexOf(
    "Copy-Item -Path (Join-Path $sourceExportRoot 'app')",
  );
  const patchInvocation = buildScript.indexOf("node $patchScript --app-dir $stagedAppDir");

  assert.notEqual(guardCall, -1, "guard is never called");
  assert.notEqual(stageCopy, -1, "stage copy anchor moved");
  assert.notEqual(patchInvocation, -1, "patcher invocation anchor moved");
  assert.ok(guardCall < stageCopy, "guard must run before the source is copied to stage");
  assert.ok(guardCall < patchInvocation, "guard must run before the patcher");
});

test("a reused source cache is only accepted when it is still pristine", () => {
  // The cache short-circuit must not skip the guard: a locally patched
  // source-app is exactly the case the guard exists for.
  const guardCall = buildScript.indexOf("Assert-PristineAppSource -AppDir");
  const cacheCandidate = buildScript.indexOf("$cacheCandidate =");
  assert.notEqual(cacheCandidate, -1, "source cache anchor moved");
  assert.ok(guardCall > cacheCandidate, "guard must run after the cache decision, not before it");
});
