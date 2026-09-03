"use strict";

// Electron >= 30 on Windows verifies the asar header hash at runtime against
// an `ELECTRONASAR` PE resource embedded in the main executable. The resource
// payload is JSON:
//   [{"file":"resources\\app.asar","alg":"SHA256","value":"<64 hex>"}]
// where `value` is the SHA256 of the asar *header string* (not the whole
// archive). Newer Codex Store builds ship this resource but do not expose the
// fuse config sentinel, so @electron/fuses cannot disable the check; after
// repacking app.asar the embedded value must be rewritten to the new header
// hash instead.

const crypto = require("node:crypto");
const fs = require("node:fs");

const RESOURCE_NAME_UTF16LE = Buffer.from("ELECTRONASAR", "utf16le");
// Regex-escaped form of the JSON-escaped path `resources\\app.asar`.
const APP_ASAR_RESOURCE_FILE_PATTERN = "resources\\\\\\\\app\\.asar";
const HASH_HEX_LENGTH = 64;

function hasEmbeddedAsarIntegrityResource(exeBuffer) {
  return exeBuffer.indexOf(RESOURCE_NAME_UTF16LE) !== -1;
}

function computeAsarHeaderHash(asarPath) {
  const asar = require("@electron/asar");
  const { headerString } = asar.getRawHeader(asarPath);
  return crypto.createHash("sha256").update(headerString, "utf8").digest("hex");
}

// Rewrites the embedded app.asar header hash in place. The hash is a
// fixed-length hex string, so the replacement never changes the buffer size.
// Returns { status: "updated", oldHash } or { status: "absent" } when the
// executable carries no ELECTRONASAR resource at all. Throws when the resource
// marker is present but the payload no longer matches the known shape, so
// upstream layout drift fails the build instead of shipping a broken package.
function updateEmbeddedAsarIntegrity(exeBuffer, newHash) {
  if (!/^[0-9a-f]{64}$/.test(newHash)) {
    throw new Error(`New asar header hash must be 64 lowercase hex chars, got: ${newHash}`);
  }

  const entryPattern = new RegExp(
    `\\{"file":"${APP_ASAR_RESOURCE_FILE_PATTERN}","alg":"SHA256","value":"([0-9a-f]{${HASH_HEX_LENGTH}})"\\}`,
    "g",
  );
  const content = exeBuffer.toString("latin1");
  const matches = [...content.matchAll(entryPattern)];

  if (matches.length === 0) {
    if (hasEmbeddedAsarIntegrityResource(exeBuffer)) {
      throw new Error(
        "Executable exposes an ELECTRONASAR resource but its payload does not match " +
          'the known [{"file":"resources\\\\app.asar","alg":"SHA256","value":"…"}] shape.',
      );
    }
    return { status: "absent" };
  }
  if (matches.length > 1) {
    throw new Error(
      `Expected exactly one embedded app.asar integrity entry, found ${matches.length}.`,
    );
  }

  const oldHash = matches[0][1];
  if (oldHash !== newHash) {
    // The entry ends with `<64 hex>"}` — the hash starts 66 bytes before the end.
    const valueOffset = matches[0].index + matches[0][0].length - (HASH_HEX_LENGTH + 2);
    exeBuffer.write(newHash, valueOffset, HASH_HEX_LENGTH, "latin1");
  }
  return { status: "updated", oldHash };
}

function updateEmbeddedAsarIntegrityResource(exePath, newHash) {
  const exeBuffer = fs.readFileSync(exePath);
  const result = updateEmbeddedAsarIntegrity(exeBuffer, newHash);
  if (result.status === "updated") {
    fs.writeFileSync(exePath, exeBuffer);
  }
  return result;
}

module.exports = {
  computeAsarHeaderHash,
  hasEmbeddedAsarIntegrityResource,
  updateEmbeddedAsarIntegrity,
  updateEmbeddedAsarIntegrityResource,
};
