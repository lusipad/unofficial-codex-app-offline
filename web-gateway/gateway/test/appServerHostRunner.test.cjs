const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { AsarArchiveReader } = require("../dist/official/AsarArchiveReader.js");
const { OfficialBundleFileSystem } = require("../dist/official/OfficialBundleFileSystem.js");
const { AsarWebviewExtractor } = require("../dist/official/AsarWebviewExtractor.js");
const { AppServerHostService } = require("../dist/official/AppServerHostService.js");
const {
  RpcTarget,
  createElectronPortPair,
  encodeCapnwebFrame,
  decodeCapnwebFrame,
  createStructuredCapnwebSession,
} = require("../dist/official/capnwebLite.js");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SOURCE_ASAR = path.join(REPO_ROOT, "build", "work", "source-app", "app", "resources", "app.asar");
const SOURCE_CODEX = path.join(REPO_ROOT, "build", "work", "source-app", "app", "resources", "codex.exe");

test("26.1120 app-server-host.js boots under Node AppServerHostService and answers Cap'n Web renderer calls", async (t) => {
  if (!fs.existsSync(SOURCE_ASAR) || !fs.existsSync(SOURCE_CODEX)) {
    t.skip("26.1120 source payload not present in build/work/source-app");
    return;
  }

  const archive = new AsarArchiveReader();
  const entries = archive.listPackage(SOURCE_ASAR);
  const hasHost = entries.some((e) => String(e).replace(/^[\\/]+/, "").replace(/\\/g, "/") === ".vite/build/app-server-host.js");
  if (!hasHost) {
    t.skip("source asar does not contain .vite/build/app-server-host.js");
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-host-runner-test-"));
  const hostDir = path.join(tmpRoot, "host");
  const codexHome = path.join(tmpRoot, "codex-home");
  fs.mkdirSync(codexHome, { recursive: true });

  const extractor = new AsarWebviewExtractor({
    archive,
    fileSystem: new OfficialBundleFileSystem(),
  });
  const extracted = extractor.extractHost(SOURCE_ASAR, hostDir);
  assert.equal(extracted.present, true);
  assert.ok(fs.existsSync(path.join(hostDir, "app-server-host.js")));

  const service = new AppServerHostService({
    hostDir,
    codexBinaryPath: SOURCE_CODEX,
    codexHome,
    workspaceDir: REPO_ROOT,
    version: "26.1120.6357.0",
  });

  const { port1, port2 } = createElectronPortPair();
  const clientSession = createStructuredCapnwebSession(port1, new RpcTarget());
  let handle = null;

  try {
    const gen = await service.ensureReady();
    assert.equal(gen, "1");

    handle = await service.attachRenderer({
      hostId: "local",
      generation: gen,
      onFrame: (frame) => {
        port2.postMessage(decodeCapnwebFrame(frame));
      },
      onClose: () => {
        port2.close();
      },
    });
    port2.start();
    port2.on("message", (ev) => {
      if (ev.data === null) {
        handle?.close();
        return;
      }
      handle?.sendFrame(encodeCapnwebFrame(ev.data));
    });

    const hostId = await clientSession.remoteMain.getHostId();
    assert.equal(hostId, "local");

    const account = await clientSession.remoteMain.getAccount();
    assert.ok(account !== undefined);

    const summary = await clientSession.remoteMain.getThreadListSummary("nonexistent-thread-id");
    assert.equal(summary ?? null, null);
  } finally {
    handle?.close();
    clientSession.dispose();
    service.dispose();
    await new Promise((r) => setTimeout(r, 250));
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {}
  }
});
