"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..", "..");

const resolverModulePromise = import("../resolve-official-cdn-url.mjs");

const packageFamilyName = "OpenAI.Codex_2p2nqsd0c76g0";
const cdnUrl =
  "https://persistent.oaistatic.com/codex-app-prod/ChatGPT-x64.msix";

async function resolveFrom(entries) {
  const { parseOfficialCdnHeaders } = await resolverModulePromise;
  return parseOfficialCdnHeaders({
    url: cdnUrl,
    headers: new Headers(entries),
    packageFamilyName,
    resolvedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function resolveError(entries) {
  const { parseOfficialCdnHeaders } = await resolverModulePromise;
  try {
    parseOfficialCdnHeaders({
      url: cdnUrl,
      headers: new Headers(entries),
      packageFamilyName,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    });
  } catch (error) {
    return error;
  }
  return null;
}

const wellFormedHeaders = {
  "x-ms-meta-package_identity": "OpenAI.Codex",
  "x-ms-meta-package_version": "26.1007.2314.0",
  "x-ms-meta-architecture": "x64",
  etag: '"0x8DF265427C674A5"',
  "content-length": "944693176",
};

test("official CDN resolver reads identity, version, ETag and size from blob headers", async () => {
  const resolved = await resolveFrom(wellFormedHeaders);

  assert.equal(resolved.packageFamilyName, packageFamilyName);
  assert.equal(resolved.packageName, "OpenAI.Codex");
  assert.equal(resolved.version, "26.1007.2314.0");
  assert.equal(resolved.selected.fileName, "ChatGPT-x64.msix");
  assert.equal(resolved.selected.href, cdnUrl);
  assert.equal(resolved.selected.etag, '"0x8DF265427C674A5"');
  assert.equal(resolved.selected.size, 944693176);
  assert.equal(resolved.selected.architecture, "x64");
  assert.equal(resolved.selected.sha1, null);
});

test("official CDN resolver tolerates header casing differences", async () => {
  const resolved = await resolveFrom({
    "X-MS-META-PACKAGE_IDENTITY": "OpenAI.Codex",
    "X-MS-META-PACKAGE_VERSION": "26.1007.2314.0",
    ETAG: '"0x1"',
  });

  assert.equal(resolved.version, "26.1007.2314.0");
  assert.equal(resolved.selected.size, null);
});

test("official CDN resolver fails closed when required headers are missing", async () => {
  const noIdentity = { ...wellFormedHeaders };
  delete noIdentity["x-ms-meta-package_identity"];
  assert.match((await resolveError(noIdentity)).message, /package_identity/);

  const noVersion = { ...wellFormedHeaders };
  delete noVersion["x-ms-meta-package_version"];
  assert.match((await resolveError(noVersion)).message, /package_version/);

  const noEtag = { ...wellFormedHeaders };
  delete noEtag.etag;
  assert.match((await resolveError(noEtag)).message, /ETag/);
});

test("official CDN resolver rejects a package identity mismatch", async () => {
  const error = await resolveError({
    ...wellFormedHeaders,
    "x-ms-meta-package_identity": "OpenAI.Other",
  });
  assert.match(error.message, /does not match/);
});

test("official CDN resolver rejects an unparsable Content-Length", async () => {
  const error = await resolveError({
    ...wellFormedHeaders,
    "content-length": "soon",
  });
  assert.match(error.message, /Content-Length/);
});

test("official_cdn mode is wired through the build and version scripts", () => {
  const buildScriptSource = fs.readFileSync(
    path.join(repoRoot, "scripts", "build-offline-package.ps1"),
    "utf8",
  );
  const versionScriptSource = fs.readFileSync(
    path.join(repoRoot, "scripts", "get-app-source-version.ps1"),
    "utf8",
  );
  const importScriptSource = fs.readFileSync(
    path.join(repoRoot, "scripts", "import-store-bundle-from-url.ps1"),
    "utf8",
  );

  // Resolve-AppSourceTarget, Test-AppSourceCacheCompatible and Export-AppSource
  // must each handle the mode.
  assert.equal(buildScriptSource.match(/'official_cdn'/g).length >= 3, true);
  assert.match(buildScriptSource, /resolve-official-cdn-url\.mjs/);
  assert.match(versionScriptSource, /'official_cdn'/);
  assert.match(versionScriptSource, /resolve-official-cdn-url\.mjs/);
  // The import script must record the mode and support the ETag/size checks.
  assert.match(importScriptSource, /\$SourceMode/);
  assert.match(importScriptSource, /\$ExpectedEtag/);
  assert.match(importScriptSource, /sourceEtag/);
});
