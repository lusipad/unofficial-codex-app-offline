const assert = require("node:assert/strict");
const test = require("node:test");

const { makeHandlers } = require("../dist/ipc/codex/GatewayCodexIpcPort.js");

function makeTestHandlers(overrides = {}) {
  const broadcasts = [];
  const handlers = makeHandlers({
    appServer: {
      isConnected: () => false,
      request: async () => {
        throw new Error("not connected");
      },
    },
    broadcast: (message) => broadcasts.push(message),
    logger: { warn: () => {} },
    isClientConnected: () => false,
    ...overrides,
  });
  return { handlers, broadcasts };
}

test("26.908 desktop-host notifications are ACKed instead of failing the invoke", async () => {
  const { handlers } = makeTestHandlers();
  const types = [
    "checkout-webview-presentation-changed",
    "browser-sidebar-annotation-multi-select-enabled-changed",
    "browser-sidebar-tweaks-enabled-changed",
    "browser-sidebar-site-annotation-api-enabled-changed",
    "electron-avatar-overlay-feedback-diagnostics-changed",
    "electron-sparkle-gates-changed",
    "electron-window-zoom-changed",
    "remote-hosted-pip-active-thread-changed",
    "workspace-settings-webview-presentation-changed",
    "subagent-thread-full-fidelity-changed",
    "update-diff-if-open",
  ];
  for (const type of types) {
    assert.equal(
      await handlers.handle("codex_desktop:message-from-view", { type }),
      true,
      `${type} should be ACKed`
    );
  }
});

test("unknown view message types still fail loudly", async () => {
  const { handlers } = makeTestHandlers();
  await assert.rejects(
    handlers.handle("codex_desktop:message-from-view", { type: "totally-unknown-26908" }),
    /Unsupported Codex message type/
  );
});

test("inbox-items returns the 26.908 unreadRunCounts shape", async () => {
  const { handlers } = makeTestHandlers();
  const result = await handlers.handle("inbox-items", { limit: 200 });
  assert.deepEqual(result, {
    items: [],
    unreadRunCounts: { total: 0, automationIds: [], unreadRuns: [] },
  });
});

test("git worker answers 26.908 availability/config-value/review-summary", async () => {
  const { handlers, broadcasts } = makeTestHandlers();

  const send = (id, method, params) =>
    handlers.handle("codex_desktop:worker:git:from-view", {
      type: "worker-request",
      request: { id, method, params },
    });

  assert.equal(await send("a", "availability", { hostConfig: {}, operationSource: "test" }), true);
  assert.equal(await send("c", "config-value", { key: "user.name", scope: "local", root: process.cwd() }), true);
  assert.equal(await send("r", "review-summary", { source: "branch", cwd: process.cwd() }), true);

  const byId = Object.fromEntries(
    broadcasts
      .filter((b) => b.channel === "codex_desktop:worker:git:for-view")
      .map((b) => [b.payload.response.id, b.payload.response.result])
  );
  assert.equal(byId.a.type, "ok");
  assert.equal(typeof byId.a.value.available, "boolean");
  assert.equal(byId.c.type, "ok");
  assert.ok("value" in byId.c.value, "config-value must return a value field");
  assert.equal(byId.r.type, "ok");
  assert.equal(byId.r.value.type, "error");
  assert.equal(byId.r.value.failureReason, "repository_unavailable");
});

test("codex-home returns the 26.908 {codexHome, worktreesSegment} object", async () => {
  const os = require("node:os");
  const path = require("node:path");
  const { handlers } = makeTestHandlers();
  const result = await handlers.handle("codex-home", { hostId: "local" });
  const codexHome = path.join(os.homedir(), ".codex");
  assert.deepEqual(result, { codexHome, worktreesSegment: path.join(codexHome, "worktrees") });
  assert.ok(path.isAbsolute(result.codexHome), "codexHome must be absolute");
});

test("26.908 get-setting/set-setting/get-settings channels round-trip", async () => {
  const { handlers } = makeTestHandlers({
    appServer: {
      isConnected: () => true,
      request: async (method) => {
        if (method === "config/read") return { config: { model: "gpt-test" } };
        if (method === "config/batchWrite") return {};
        throw new Error("unexpected method " + method);
      },
    },
  });

  // 未知 key 读为 null，形状必须是 {value}，不能是裸值或 undefined
  assert.deepEqual(await handlers.handle("get-setting", { key: "no-such-key" }), { value: null });

  // set-setting 写入后可读回
  assert.deepEqual(
    await handlers.handle("set-setting", { key: "theme", value: "dark" }),
    { success: true }
  );
  assert.deepEqual(await handlers.handle("get-setting", { key: "theme" }), { value: "dark" });

  // get-settings 返回 {configuredValues, values} 快照，values.codexConfig 来自 app-server
  const all = await handlers.handle("get-settings", undefined);
  assert.deepEqual(all.configuredValues, {});
  assert.equal(all.values.codexConfig.model, "gpt-test");
  assert.equal(all.values.theme, "dark");
});

test("thread/resume strips incomplete codex_app MCP overrides before forwarding", async () => {
  const seen = [];
  const { handlers, broadcasts } = makeTestHandlers({
    appServer: {
      isConnected: () => true,
      request: async (method, params) => {
        seen.push({ method, params });
        if (method === "thread/resume") return { thread: { id: "t1", turns: [] } };
        throw new Error("unexpected method " + method);
      },
    },
  });

  const config = {
    model: "gpt-6-astra",
    "mcp_servers.codex_app.enabled_tools": ["js"],
    mcp_servers: {
      codex_app: { enabled_tools: ["js"] },
      node_repl: { command: "node_repl.exe" },
    },
  };
  const ack = await handlers.handle("codex_desktop:message-from-view", {
    type: "mcp-request",
    request: { id: "r1", method: "thread/resume", params: { threadId: "t1", config } },
  });
  assert.equal(ack, true);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const forwarded = seen.find((entry) => entry.method === "thread/resume");
  assert.ok(forwarded, "thread/resume must be forwarded");
  assert.ok(!("mcp_servers.codex_app.enabled_tools" in forwarded.params.config));
  assert.ok(!("codex_app" in forwarded.params.config.mcp_servers));
  assert.deepEqual(forwarded.params.config.mcp_servers.node_repl, { command: "node_repl.exe" });
  assert.equal(forwarded.params.config.model, "gpt-6-astra");
  // 完整传输定义不受影响
  const response = broadcasts.find((b) => b.channel === "mcp-response");
  assert.ok(response, "mcp-response must be broadcast");
  assert.ok(response.payload.message.result, "resume must succeed");
});

test("thread/resume keeps codex_app overrides that carry a real transport", async () => {
  const seen = [];
  const { handlers } = makeTestHandlers({
    appServer: {
      isConnected: () => true,
      request: async (method, params) => {
        seen.push({ method, params });
        return { thread: { id: "t1", turns: [] } };
      },
    },
  });
  const config = {
    "mcp_servers.codex_app.command": "codex-app-tools.exe",
    "mcp_servers.codex_app.enabled_tools": ["js"],
  };
  await handlers.handle("codex_desktop:message-from-view", {
    type: "mcp-request",
    request: { id: "r2", method: "thread/resume", params: { threadId: "t1", config } },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const forwarded = seen.find((entry) => entry.method === "thread/resume");
  assert.equal(forwarded.params.config["mcp_servers.codex_app.command"], "codex-app-tools.exe");
  assert.deepEqual(forwarded.params.config["mcp_servers.codex_app.enabled_tools"], ["js"]);
});

test("ensure-directory creates the local directory and returns null", async () => {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const { handlers } = makeTestHandlers();
  const dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "codex-ensure-dir-")),
    "nested",
    "deeper"
  );
  const result = await handlers.handle("ensure-directory", { hostId: "local", path: dir });
  assert.equal(result, null);
  assert.ok(fs.statSync(dir).isDirectory(), "directory must be created recursively");
  // 幂等：已存在时不报错
  assert.equal(await handlers.handle("ensure-directory", { hostId: "local", path: dir }), null);
});

test("fetch on unhandled vscode://codex endpoint never yields an unparseable response", async () => {
  const { createFetchIpcHandlers } = require("../dist/ipc/codex/fetchIpc.js");
  const { UNHANDLED_CODEX_CHANNEL } = require("../dist/ipc/codex/IGatewayCodexIpcPort.js");
  const broadcasts = [];
  const fetchIpc = createFetchIpcHandlers({
    broadcast: (message) => broadcasts.push(message),
    logger: { info: () => {}, warn: () => {} },
    chatgptBackend: { parseMaybeJson: (body) => (body ? JSON.parse(body) : null) },
    targetClientIdForContext: () => "",
    withTargetClient: (message) => message,
    invokeCodexChannel: async () => UNHANDLED_CODEX_CHANNEL,
    shouldPatchStatsigInitialize: () => false,
    patchStatsigDefaultFeatures: (text) => text,
    statsigDefaultFeatureOverrides: {},
  });

  // 宿主 fire-and-forget 设置项：成功 ACK 且 bodyJsonString 必须可解析
  await fetchIpc.handleFetchMessage({
    requestId: "r-benign",
    method: "POST",
    url: "vscode://codex/global-dictation-hotkey-state",
    body: "{}",
  });
  const benign = broadcasts.find((b) => b.payload.requestId === "r-benign");
  assert.equal(benign.payload.responseType, "success");
  assert.equal(benign.payload.bodyJsonString, "null");
  assert.doesNotThrow(() => JSON.parse(benign.payload.bodyJsonString));

  // 真正未知的端点：明确 501 错误，不能返回缺 body 的 success
  await fetchIpc.handleFetchMessage({
    requestId: "r-unknown",
    method: "POST",
    url: "vscode://codex/no-such-endpoint-26908",
    body: "{}",
  });
  const unknown = broadcasts.find((b) => b.payload.requestId === "r-unknown");
  assert.equal(unknown.payload.responseType, "error");
  assert.equal(unknown.payload.status, 501);
  assert.match(unknown.payload.error, /Unsupported Codex fetch endpoint/);
});

test("broadcastFetchResponse serializes non-JSON values as null", async () => {
  const { createFetchIpcHandlers } = require("../dist/ipc/codex/fetchIpc.js");
  const broadcasts = [];
  const fetchIpc = createFetchIpcHandlers({
    broadcast: (message) => broadcasts.push(message),
    logger: { info: () => {}, warn: () => {} },
    chatgptBackend: { parseMaybeJson: (body) => (body ? JSON.parse(body) : null) },
    targetClientIdForContext: () => "",
    withTargetClient: (message) => message,
    invokeCodexChannel: async () => Symbol("leaked"),
    shouldPatchStatsigInitialize: () => false,
    patchStatsigDefaultFeatures: (text) => text,
    statsigDefaultFeatureOverrides: {},
  });
  // invokeCodexChannel 意外返回 Symbol 时（非哨兵路径不可能，但序列化层必须兜底）
  await fetchIpc.handleFetchMessage({
    requestId: "r-sym",
    method: "POST",
    url: "vscode://codex/get-global-state",
    body: "{}",
  });
  const sym = broadcasts.find((b) => b.payload.requestId === "r-sym");
  assert.ok(sym, "response must be broadcast");
  assert.equal(typeof sym.payload.bodyJsonString, "string");
  assert.doesNotThrow(() => JSON.parse(sym.payload.bodyJsonString));
});

test("pending_worktrees shared object defaults to an empty array like the desktop host", async () => {
  const { handlers, broadcasts } = makeTestHandlers();
  assert.equal(
    await handlers.handle("codex_desktop:message-from-view", {
      type: "shared-object-subscribe",
      key: "pending_worktrees",
    }),
    true
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const update = broadcasts.find(
    (b) => b.channel === "shared-object-updated" && b.payload.key === "pending_worktrees"
  );
  assert.ok(update, "subscribe must broadcast the current value");
  assert.deepEqual(update.payload.value, []);
});

test("codex-worktrees scans worktreesRoot and returns {dir, gitDir} per the 26.908 desktop contract", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worktrees-"));
  const mainRepo = path.join(tmp, "main-repo");
  fs.mkdirSync(mainRepo, { recursive: true });
  execFileSync("git", ["init", mainRepo]);

  // 手工构造一个 linked worktree：.git 文件 + 主仓库侧的 worktree 元数据
  const worktreesRoot = path.join(tmp, "worktrees");
  const entry = path.join(worktreesRoot, "parent-repo", "feature-branch");
  fs.mkdirSync(entry, { recursive: true });
  const gitdirMeta = path.join(mainRepo, ".git", "worktrees", "feature-branch");
  fs.mkdirSync(gitdirMeta, { recursive: true });
  fs.writeFileSync(path.join(entry, ".git"), `gitdir: ${gitdirMeta}\n`);
  fs.writeFileSync(path.join(gitdirMeta, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdirMeta, "gitdir"), path.join(entry, ".git") + "\n");
  fs.writeFileSync(path.join(gitdirMeta, "HEAD"), "ref: refs/heads/feature-branch\n");

  // 同级放一个非 git 目录，必须被排除
  fs.mkdirSync(path.join(worktreesRoot, "parent-repo", "not-a-repo"));

  const { handlers, broadcasts } = makeTestHandlers();
  const send = (id, method, params) =>
    handlers.handle("codex_desktop:worker:git:from-view", {
      type: "worker-request",
      request: { id, method, params },
    });

  assert.equal(await send("w", "codex-worktrees", { worktreesRoot }), true);
  const response = broadcasts.find(
    (b) => b.channel === "codex_desktop:worker:git:for-view" && b.payload.response.id === "w"
  );
  assert.equal(response.payload.response.result.type, "ok");
  assert.deepEqual(response.payload.response.result.value, {
    worktrees: [{ dir: entry, gitDir: mainRepo }],
  });

  // worktreesRoot 缺失时返回空列表而不是抛错
  assert.equal(
    await send("w2", "codex-worktrees", { worktreesRoot: path.join(tmp, "missing") }),
    true
  );
  const missing = broadcasts.find(
    (b) => b.channel === "codex_desktop:worker:git:for-view" && b.payload.response.id === "w2"
  );
  assert.deepEqual(missing.payload.response.result.value, { worktrees: [] });
});

test("pending-worktree-create runs git worktree add and drives the shared-object state machine", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pending-worktree-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "e2e@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "e2e"]);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-m", "init"]);

  // CODEX_HOME 在模块加载时已定型（GatewayCodexIpcPort.ts 同款回退链），
  // worktree 会落在 $CODEX_HOME/worktrees 下，测试末尾负责清理。
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const expectedRoot = path.join(codexHome, "worktrees");
  const { handlers, broadcasts } = makeTestHandlers();

  const request = {
    id: "local:wt-test-1",
    hostId: "local",
    launchMode: "start-conversation",
    clientThreadId: "client-thread-1",
    sourceWorkspaceRoot: repo,
    startingState: { type: "branch", branchName: "main" },
    prompt: "hi",
  };
  assert.equal(
    await handlers.handle("codex_desktop:message-from-view", {
      type: "pending-worktree-create",
      hostId: "local",
      request,
    }),
    true
  );

  // 等状态机推进到 worktree-ready
  let ready = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snapshot = broadcasts
      .filter((b) => b.channel === "shared-object-updated" && b.payload.key === "pending_worktrees")
      .map((b) => b.payload.value)
      .pop();
    const entry = Array.isArray(snapshot) ? snapshot.find((e) => e.id === request.id) : null;
    if (entry && (entry.phase === "worktree-ready" || entry.phase === "failed")) {
      ready = entry;
      break;
    }
  }
  assert.ok(ready, "pending worktree must reach a terminal phase");
  assert.equal(ready.phase, "worktree-ready", ready.errorMessage || "creation must succeed");
  assert.ok(ready.worktreeGitRoot.startsWith(expectedRoot), ready.worktreeGitRoot);
  assert.ok(fs.existsSync(path.join(ready.worktreeGitRoot, ".git")), "worktree must exist on disk");

  // settle 后 dismiss 清空列表
  assert.equal(
    await handlers.handle("codex_desktop:message-from-view", {
      type: "pending-worktree-dismiss",
      hostId: "local",
      id: request.id,
    }),
    true
  );
  const last = broadcasts
    .filter((b) => b.channel === "shared-object-updated" && b.payload.key === "pending_worktrees")
    .map((b) => b.payload.value)
    .pop();
  assert.deepEqual(last, []);

  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", ready.worktreeGitRoot]);
});
