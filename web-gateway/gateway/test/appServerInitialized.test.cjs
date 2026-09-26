const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { appServerVersionFromUserAgent } = require("../dist/codex-app-server.js");

// 26.924 起 renderer 要收到桌面端的 codex-app-server-initialized（带 app-server 版本）
// 才会离开启动页；版本号与桌面主进程一样取自 initialize 响应的 userAgent。
test("app-server version is parsed from the initialize userAgent", () => {
  assert.equal(
    appServerVersionFromUserAgent("probe/0.158.0-alpha.2 (Windows 10.0.26200; x86_64) WindowsTerminal (probe; 0)"),
    "0.158.0-alpha.2"
  );
  assert.equal(appServerVersionFromUserAgent("codex_desktop/0.155.0"), "0.155.0");
  assert.equal(appServerVersionFromUserAgent(""), null);
  assert.equal(appServerVersionFromUserAgent(undefined), null);
  assert.equal(appServerVersionFromUserAgent("no-version-here"), null);
});

test("gateway broadcasts codex-app-server-initialized after initialize", () => {
  const appServerSource = fs.readFileSync(path.join(__dirname, "..", "src", "codex-app-server.ts"), "utf8");
  assert.match(appServerSource, /channel: "codex-app-server-initialized", payload: initializationMessage/);
  assert.match(appServerSource, /getInitializationMessage,/);
});

test("renderer ready replays the initialization snapshot to that client", () => {
  // 页面通常在 app-server 初始化之后才就绪；与桌面端一样在 renderer 发 ready 时定向补发快照。
  const { createViewMessageHandlers } = require("../dist/ipc/codex/viewMessages.js");
  const sent = [];
  const snapshot = { hostId: "local", transport: "stdio", appServerVersion: "0.158.0-alpha.2", installedCodexVersion: null };
  const { handleViewMessage } = createViewMessageHandlers({
    appServer: { getInitializationMessage: () => snapshot },
    broadcast: (message) => sent.push(message),
    withTargetClient: (message, clientId) => ({ ...message, targetClientId: clientId }),
    targetClientIdForContext: (context) => context.clientId,
    desktopViewNoopMessageTypes: new Set(),
  });
  return Promise.resolve(handleViewMessage({ type: "ready" }, { clientId: "c1" })).then((handled) => {
    assert.equal(handled, true);
    assert.deepEqual(sent, [{
      channel: "codex-app-server-initialized",
      payload: { ...snapshot, isSnapshot: true },
      targetClientId: "c1",
    }]);
  });
});
