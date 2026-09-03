"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// The CI "Validate patch scripts" gate runs `node --test` before `npm ci`,
// so @electron/asar may be absent; the header-hash semantics test skips there.
let asar = null;
try {
  asar = require("@electron/asar");
} catch {
  asar = null;
}

const {
  computeAsarHeaderHash,
  updateEmbeddedAsarIntegrity,
  updateEmbeddedAsarIntegrityResource,
} = require("../asar-integrity-resource.cjs");

const OLD_HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);
const RESOURCE_MARKER_UTF16LE = Buffer.from("ELECTRONASAR", "utf16le");
const EMBEDDED_PAYLOAD =
  '[{"file":"resources\\\\app.asar","alg":"SHA256","value":"' + OLD_HASH + '"}]';

function buildExeBuffer({ withMarker = true, payload = EMBEDDED_PAYLOAD } = {}) {
  return Buffer.concat([
    Buffer.from("fake-pe-header"),
    ...(withMarker ? [RESOURCE_MARKER_UTF16LE] : []),
    Buffer.from(payload, "latin1"),
    Buffer.from("PADDINGXPADDINGX"),
  ]);
}

test("rewrites the embedded app.asar header hash in place", () => {
  const exeBuffer = buildExeBuffer();
  const originalLength = exeBuffer.length;

  const result = updateEmbeddedAsarIntegrity(exeBuffer, NEW_HASH);

  assert.deepEqual(result, { status: "updated", oldHash: OLD_HASH });
  assert.equal(exeBuffer.length, originalLength);
  const payloadMatch = exeBuffer
    .toString("latin1")
    .match(/\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([0-9a-f]{64})"\}\]/);
  assert.ok(payloadMatch, "embedded payload must remain intact JSON");
  assert.equal(payloadMatch[1], NEW_HASH);
  // Electron parses the resource payload as JSON; surrounding bytes must stay valid.
  const jsonStart = exeBuffer.indexOf(Buffer.from('[{"file"', "latin1"));
  const jsonEnd = exeBuffer.indexOf(Buffer.from("}]", "latin1")) + 2;
  assert.deepEqual(JSON.parse(exeBuffer.toString("latin1", jsonStart, jsonEnd)), [
    { file: "resources\\app.asar", alg: "SHA256", value: NEW_HASH },
  ]);
});

test("reports absent when the executable has no ELECTRONASAR resource", () => {
  const exeBuffer = Buffer.from("plain executable without the resource");

  const result = updateEmbeddedAsarIntegrity(exeBuffer, NEW_HASH);

  assert.deepEqual(result, { status: "absent" });
});

test("fails closed when the resource exists but the payload shape drifted", () => {
  const exeBuffer = buildExeBuffer({ payload: '[{"file":"resources\\\\app.asar"}]' });

  assert.throws(() => updateEmbeddedAsarIntegrity(exeBuffer, NEW_HASH), /ELECTRONASAR/);
});

test("rejects duplicate embedded app.asar integrity entries", () => {
  const exeBuffer = buildExeBuffer({ payload: EMBEDDED_PAYLOAD + EMBEDDED_PAYLOAD });

  assert.throws(() => updateEmbeddedAsarIntegrity(exeBuffer, NEW_HASH), /exactly one/);
});

test("rejects malformed replacement hashes", () => {
  const exeBuffer = buildExeBuffer();

  assert.throws(() => updateEmbeddedAsarIntegrity(exeBuffer, "not-a-hash"));
});

test("updateEmbeddedAsarIntegrityResource persists the rewritten executable", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asar-integrity-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const exePath = path.join(tempDir, "ChatGPT.exe");
  fs.writeFileSync(exePath, buildExeBuffer());

  const result = updateEmbeddedAsarIntegrityResource(exePath, NEW_HASH);

  assert.equal(result.status, "updated");
  const persisted = fs.readFileSync(exePath);
  assert.notEqual(persisted.indexOf(Buffer.from(NEW_HASH, "latin1")), -1);
});

test(
  "computeAsarHeaderHash hashes the header string, not the archive file",
  { skip: asar === null ? "@electron/asar is not installed yet" : false },
  async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "asar-integrity-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sourceDir = path.join(tempDir, "src");
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, "index.js"), "module.exports = 1;\n");
  const asarPath = path.join(tempDir, "app.asar");
  await asar.createPackage(sourceDir, asarPath);

  const headerHash = computeAsarHeaderHash(asarPath);

  const { headerString } = asar.getRawHeader(asarPath);
  const expected = crypto.createHash("sha256").update(headerString, "utf8").digest("hex");
  const wholeFile = crypto
    .createHash("sha256")
    .update(fs.readFileSync(asarPath))
    .digest("hex");
  assert.match(headerHash, /^[0-9a-f]{64}$/);
  assert.equal(headerHash, expected);
  assert.notEqual(headerHash, wholeFile);
  },
);
