"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const patchScriptPath = path.resolve(__dirname, "..", "patch-app-asar.mjs");
const patchScriptSource = fs.readFileSync(patchScriptPath, "utf8");

function sourceSlice(startMarker, endMarker) {
  const start = patchScriptSource.indexOf(startMarker);
  const end = patchScriptSource.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return patchScriptSource.slice(start, end);
}

function loadGuardConstants() {
  const source = sourceSlice(
    "const STDIO_WRITE_ERROR_GUARD_MARKER =",
    "\n// Bootstrap snippet injected",
  );
  return Function(
    `"use strict";\n${source}\nreturn { STDIO_WRITE_ERROR_GUARD_MARKER, LEGACY_EPIPE_GUARD, EPIPE_GUARD };`,
  )();
}

function createStream(write) {
  const stream = new EventEmitter();
  stream.write = write ?? (() => true);
  return stream;
}

function applyGuard(guard, stdout, stderr) {
  Function("process", `"use strict";\n${guard}`)({ stdout, stderr });
}

test("stdio guard suppresses asynchronous EPIPE and EOF only", () => {
  const { EPIPE_GUARD } = loadGuardConstants();
  const stdout = createStream();
  const stderr = createStream();
  applyGuard(EPIPE_GUARD, stdout, stderr);

  for (const code of ["EPIPE", "EOF"]) {
    const error = Object.assign(new Error(`write ${code}`), { code });
    assert.doesNotThrow(() => stdout.emit("error", error));
    assert.doesNotThrow(() => stderr.emit("error", error));
  }

  const otherError = Object.assign(new Error("write EACCES"), { code: "EACCES" });
  assert.throws(() => stdout.emit("error", otherError), otherError);
});

test("stdio guard suppresses synchronous EPIPE and EOF only", () => {
  const { EPIPE_GUARD } = loadGuardConstants();

  for (const code of ["EPIPE", "EOF"]) {
    const error = Object.assign(new Error(`write ${code}`), { code });
    const stdout = createStream(() => {
      throw error;
    });
    applyGuard(EPIPE_GUARD, stdout, createStream());
    assert.doesNotThrow(() => stdout.write("ignored"));
  }

  const otherError = Object.assign(new Error("write EACCES"), { code: "EACCES" });
  const stdout = createStream(() => {
    throw otherError;
  });
  applyGuard(EPIPE_GUARD, stdout, createStream());
  assert.throws(() => stdout.write("preserved"), otherError);
});

test("refresh upgrades the legacy guard in an already patched main entry", () => {
  const {
    STDIO_WRITE_ERROR_GUARD_MARKER,
    LEGACY_EPIPE_GUARD,
    EPIPE_GUARD,
  } = loadGuardConstants();
  const refreshSource = sourceSlice(
    "function refreshMainEntryPatch(filePath) {",
    "\nfunction listJavaScriptFiles(dirPath) {",
  );
  const refreshMainEntryPatch = Function(
    "fs",
    "PATCH_MARKER",
    "COMPUTER_USE_ENV_DEFAULT",
    "MSIX_UPDATER_BINDING_STUB",
    "PATCH_BOOTSTRAP_REQUIRE",
    "STDIO_WRITE_ERROR_GUARD_MARKER",
    "LEGACY_EPIPE_GUARD",
    "EPIPE_GUARD",
    `"use strict";\n${refreshSource}\nreturn refreshMainEntryPatch;`,
  )(
    fs,
    "/* codex-offline:windowsStore-patch */",
    "",
    "",
    "",
    STDIO_WRITE_ERROR_GUARD_MARKER,
    LEGACY_EPIPE_GUARD,
    EPIPE_GUARD,
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-offline-stdio-"));
  const mainEntryPath = path.join(tempDir, "early-bootstrap.js");
  try {
    fs.writeFileSync(
      mainEntryPath,
      [
        "/* codex-offline:windowsStore-patch */",
        "CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE",
        "_codexOfflineMsixStub",
        LEGACY_EPIPE_GUARD,
        "_codexOfflineD",
        "upstream();",
      ].join("\n"),
      "utf8",
    );

    assert.equal(refreshMainEntryPatch(mainEntryPath), true);
    const refreshed = fs.readFileSync(mainEntryPath, "utf8");
    assert.equal(refreshed.includes(LEGACY_EPIPE_GUARD), false);
    assert.equal(refreshed.includes(EPIPE_GUARD), true);
    assert.equal(refreshed.includes(STDIO_WRITE_ERROR_GUARD_MARKER), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
