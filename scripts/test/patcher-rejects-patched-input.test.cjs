"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(repoRoot, "scripts", "patch-app-asar.mjs"), "utf8");

test("the patcher refuses an already-patched asar", () => {
  assert.match(source, /function assertPristineAsar/);
  const start = source.indexOf("function assertPristineAsar");
  const body = source.slice(start, start + 900);
  assert.match(body, /codex-offline:/);
  assert.match(body, /throw new Error/);
});

test("the pristine assertion runs before the asar is extracted", () => {
  const call = source.indexOf("assertPristineAsar(asarPath)");
  const extract = source.indexOf("log('Extracting asar…')");
  assert.notEqual(call, -1, "assertion is never called");
  assert.notEqual(extract, -1, "extraction anchor moved");
  assert.ok(call < extract, "the assertion must run before extraction");
});

test("the re-patch path is gone", () => {
  assert.ok(!source.includes("refreshMainEntryPatch"), "refreshMainEntryPatch should be gone");
  assert.ok(!source.includes("isAlreadyPatched"), "isAlreadyPatched should be gone");
  const alreadyPatched = source.match(/already patched/g) ?? [];
  assert.equal(
    alreadyPatched.length,
    0,
    `patcher still reports ${alreadyPatched.length} "already patched" states`,
  );
});

test("upstream self-healing detection is preserved", () => {
  // "Already correct" has two meanings in this file. Checks against our own
  // marker are idempotency leftovers and go away once the input is guaranteed
  // pristine; checks against an upstream shape mean the bundle already does the
  // right thing and must keep working, or the build fails when upstream fixes
  // something itself.
  assert.match(source, /I18N_ALREADY_CORRECT_MARKER/);
  assert.match(source, /LOCALE_SOURCE_ALREADY_CORRECT_MARKER/);
  assert.match(
    source,
    /const I18N_ALREADY_CORRECT_MARKER =\s*'\.get\(`enable_i18n`,!0\)'/,
    "the i18n upstream-correct shape must stay an upstream literal",
  );
});
