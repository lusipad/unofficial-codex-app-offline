"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const patchScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "patch-app-asar.mjs"),
  "utf8",
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function loadHashPatcher() {
  const functionStart = patchScriptSource.indexOf(
    "function patchTrustedBrowserClientHashes",
  );
  const functionEnd = patchScriptSource.indexOf(
    "\nfunction isMissingUnpackedFileError",
    functionStart,
  );

  assert.notEqual(functionStart, -1, "trusted-hash patch helper is missing");
  assert.notEqual(functionEnd, -1, "trusted-hash helper terminator is missing");

  return Function(
    "fs",
    "escapeRegExp",
    `"use strict";\n${patchScriptSource.slice(functionStart, functionEnd)}\nreturn patchTrustedBrowserClientHashes;`,
  )(fs, escapeRegExp);
}

test("trusted browser-client hashes support standalone and chained declarations", () => {
  const patchTrustedBrowserClientHashes = loadHashPatcher();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-offline-trusted-hashes-"));
  const oldHash = "a".repeat(64);
  const existingHash = "b".repeat(64);
  const replacementHash = "c".repeat(64);
  const oldFile = path.join(tempRoot, "old.js");
  const newFile = path.join(tempRoot, "new.js");
  const unrelatedFile = path.join(tempRoot, "unrelated.js");

  try {
    fs.writeFileSync(
      oldFile,
      `var bt=[\`${oldHash}\`,\`${existingHash}\`];function configure({trustedBrowserClientSha256s:h=bt}){return h}`,
      "utf8",
    );
    fs.writeFileSync(
      newFile,
      `var Dt=class{},Ot=[\`${oldHash}\`,\`${existingHash}\`],kt=\`CODEX_ELECTRON_RESOURCES_PATH\`;function configure({trustedBrowserClientSha256s:h=Ot}){return h}`,
      "utf8",
    );
    fs.writeFileSync(
      unrelatedFile,
      `var integrityHashes=[\`${oldHash}\`,\`${existingHash}\`];`,
      "utf8",
    );

    const firstPass = patchTrustedBrowserClientHashes(
      [oldFile, newFile, unrelatedFile],
      replacementHash,
    );
    assert.deepEqual(new Set(firstPass.patchedFiles), new Set([oldFile, newFile]));
    assert.equal(firstPass.alreadyCorrect, false);
    assert.match(fs.readFileSync(oldFile, "utf8"), new RegExp(`var bt=\\[[^\\]]*${replacementHash}`));
    assert.match(fs.readFileSync(newFile, "utf8"), new RegExp(`,Ot=\\[[^\\]]*${replacementHash}`));
    assert.equal(fs.readFileSync(unrelatedFile, "utf8").includes(replacementHash), false);

    const secondPass = patchTrustedBrowserClientHashes([oldFile, newFile], replacementHash);
    assert.deepEqual(secondPass.patchedFiles, []);
    assert.equal(secondPass.alreadyCorrect, true);
  }
  finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
