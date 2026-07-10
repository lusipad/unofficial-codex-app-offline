"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const repoRoot = path.resolve(__dirname, "../..");
const repairScript = path.join(
  repoRoot,
  "scripts",
  "powershell-shim",
  "CodexOfflineShim",
  "repair-threads.js"
);
const installerTemplate = path.join(repoRoot, "installer", "CodexOffline.iss.tpl");
const setupScript = path.join(repoRoot, "scripts", "setup-codex-offline.ps1");

const EXISTING_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_ID = "22222222-2222-4222-8222-222222222222";
const FAILING_ID = "33333333-3333-4333-8333-333333333333";

const FIXTURE_CWD = "D:\\work\\fixture";
const MANAGED_WORKSPACE_POLICY = JSON.stringify({
  type: "managed",
  file_system: {
    type: "restricted",
    entries: [
      {
        path: { type: "special", value: { kind: "root" } },
        access: "read",
      },
      { path: { type: "path", path: FIXTURE_CWD }, access: "write" },
      {
        path: { type: "special", value: { kind: "slash_tmp" } },
        access: "write",
      },
      {
        path: { type: "special", value: { kind: "tmpdir" } },
        access: "write",
      },
    ],
  },
  network: "restricted",
});
const MANAGED_READ_ONLY_POLICY = JSON.stringify({
  type: "managed",
  file_system: {
    type: "restricted",
    entries: [
      {
        path: { type: "special", value: { kind: "root" } },
        access: "read",
      },
    ],
  },
  network: "restricted",
});
const WORKSPACE_WRITE_TURN_CONTEXT = {
  approval_policy: "on-request",
  sandbox_policy: {
    type: "workspace-write",
    writable_roots: [FIXTURE_CWD],
    network_access: false,
    exclude_tmpdir_env_var: false,
    exclude_slash_tmp: false,
  },
};

const ORIGINAL_METADATA = {
  source: "vscode",
  model_provider: "openai",
  thread_source: "ide",
  sandbox_policy: MANAGED_WORKSPACE_POLICY,
  approval_mode: "on-request",
};

function makeThread(overrides = {}) {
  return {
    id: EXISTING_ID,
    rollout_path: "",
    created_at: 1_752_124_800,
    updated_at: 1_752_124_860,
    cwd: FIXTURE_CWD,
    title: "original title",
    cli_version: "0.144.1",
    git_branch: "main",
    created_at_ms: 1_752_124_800_000,
    updated_at_ms: 1_752_124_860_000,
    first_user_message: "original message",
    preview: "original preview",
    model: "gpt-5.4",
    archived: 0,
    ...ORIGINAL_METADATA,
    ...overrides,
  };
}

function sessionJsonl(meta, turnContext = WORKSPACE_WRITE_TURN_CONTEXT) {
  const sessionMeta = {
    timestamp: "2025-07-10T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: meta.id,
      timestamp: "2025-07-10T00:00:00.000Z",
      cwd: meta.cwd,
      cli_version: meta.cli_version,
      source: meta.source,
      model_provider: meta.model_provider,
      thread_source: meta.thread_source,
      model: meta.model,
    },
  };
  const userMessage = {
    timestamp: "2025-07-10T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "fixture message" },
  };
  const turnContextRecord = {
    timestamp: "2025-07-10T00:00:02.000Z",
    type: "turn_context",
    payload: {
      turn_id: "44444444-4444-4444-8444-444444444444",
      cwd: meta.cwd,
      approval_policy: turnContext.approval_policy,
      sandbox_policy: turnContext.sandbox_policy,
      model: meta.model,
    },
  };
  return `${JSON.stringify(sessionMeta)}\n${JSON.stringify(userMessage)}\n${JSON.stringify(turnContextRecord)}\n`;
}

function rewriteSessionHeader(jsonl, mutatePayload) {
  const newline = jsonl.indexOf("\n");
  const record = JSON.parse(newline === -1 ? jsonl : jsonl.slice(0, newline));
  mutatePayload(record.payload);
  return JSON.stringify(record) + (newline === -1 ? "" : jsonl.slice(newline));
}

function createThreadsDb(dbPath, rows = [], { threadSourceNullable = false } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      cli_version TEXT,
      git_branch TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      first_user_message TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      thread_source TEXT${threadSourceNullable ? "" : " NOT NULL DEFAULT ''"},
      archived INTEGER NOT NULL DEFAULT 0
    );
  `);

  const columns = [
    "id",
    "rollout_path",
    "created_at",
    "updated_at",
    "source",
    "model_provider",
    "cwd",
    "title",
    "sandbox_policy",
    "approval_mode",
    "cli_version",
    "git_branch",
    "created_at_ms",
    "updated_at_ms",
    "first_user_message",
    "preview",
    "model",
    "thread_source",
    "archived",
  ];
  const insert = db.prepare(
    `INSERT INTO threads (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
  );
  for (const row of rows) {
    insert.run(...columns.map((column) => row[column]));
  }
  db.close();
}

function createCatalogDb(dbPath, rows = []) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE local_thread_catalog (
      host_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      display_title TEXT,
      source_created_at REAL,
      source_updated_at REAL,
      cwd TEXT DEFAULT '',
      source_kind TEXT DEFAULT 'unknown',
      source_detail TEXT,
      model_provider TEXT DEFAULT '',
      git_branch TEXT,
      observation_sequence INTEGER DEFAULT 0,
      missing_candidate INTEGER DEFAULT 0,
      PRIMARY KEY (host_id, thread_id)
    );
    CREATE TABLE local_thread_catalog_sync_state (
      host_id TEXT PRIMARY KEY,
      watermark_updated_at REAL,
      initial_build_complete INTEGER DEFAULT 0,
      observation_sequence INTEGER DEFAULT 0
    );
    CREATE TABLE local_thread_catalog_metadata (
      id INTEGER PRIMARY KEY,
      catalog_revision INTEGER DEFAULT 0
    );
    INSERT INTO local_thread_catalog_sync_state
      (host_id, watermark_updated_at, initial_build_complete, observation_sequence)
      VALUES ('local', NULL, 1, 1);
    INSERT INTO local_thread_catalog_metadata (id, catalog_revision) VALUES (1, 1);
  `);
  const insert = db.prepare(`
    INSERT INTO local_thread_catalog
      (host_id, thread_id, display_title, source_created_at, source_updated_at,
       cwd, source_kind, source_detail, model_provider, git_branch,
       observation_sequence, missing_candidate)
    VALUES ('local', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, 0)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.title,
      row.created_at_ms,
      row.updated_at_ms,
      row.cwd,
      row.source,
      row.model_provider,
      row.git_branch
    );
  }
  db.close();
}

function createFixture(
  t,
  { dbRows = [], desktopRows = null, sessions = [], threadSourceNullable = false } = {}
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "repair-threads-test-"));
  const sessionsDir = path.join(home, "sessions");
  const sqliteDir = path.join(home, "sqlite");
  const stateDbPath = path.join(home, "state_5.sqlite");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(sqliteDir, { recursive: true });
  createThreadsDb(stateDbPath, dbRows, { threadSourceNullable });
  const desktopDbPath = path.join(sqliteDir, "state_5.sqlite");
  if (desktopRows) createThreadsDb(desktopDbPath, desktopRows);

  const sessionPaths = new Map();
  for (const meta of sessions) {
    const sessionPath = path.join(sessionsDir, `${meta.id}.jsonl`);
    fs.writeFileSync(sessionPath, sessionJsonl(meta));
    sessionPaths.set(meta.id, sessionPath);
  }

  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { desktopDbPath, home, stateDbPath, sessionPaths };
}

function createRestoreFixture(t) {
  const original = makeThread();
  const corrupted = makeThread({
    source: "cli",
    model_provider: "custom",
    thread_source: "user",
  });
  const fixture = createFixture(t, {
    dbRows: [corrupted],
    sessions: [corrupted],
  });
  const sessionPath = fixture.sessionPaths.get(EXISTING_ID);
  const legacyBackupPath = `${sessionPath}.bak-repair-session-meta`;
  const originalJsonl = sessionJsonl(original);
  const appendedAfterBackup = `${JSON.stringify({
    timestamp: "2025-07-10T00:05:00.000Z",
    type: "event_msg",
    payload: { type: "assistant_message", message: "added after backup" },
  })}\n`;
  const currentJsonl = sessionJsonl(corrupted) + appendedAfterBackup;
  const firstBackupNewline = originalJsonl.indexOf("\n");
  const firstCurrentNewline = currentJsonl.indexOf("\n");
  const expectedRestoredJsonl =
    originalJsonl.slice(0, firstBackupNewline + 1) + currentJsonl.slice(firstCurrentNewline + 1);
  fs.writeFileSync(sessionPath, currentJsonl);
  fs.writeFileSync(legacyBackupPath, originalJsonl);

  const catalogDbPath = path.join(fixture.home, "sqlite", "codex-dev.db");
  createCatalogDb(catalogDbPath, [corrupted]);

  return {
    ...fixture,
    catalogDbPath,
    corrupted,
    currentJsonl,
    expectedRestoredJsonl,
    legacyBackupPath,
    originalJsonl,
    sessionPath,
  };
}

function runRepair(home, args = []) {
  return spawnSync(process.execPath, [repairScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CODEX_HOME: home },
  });
}

function runSetupWithStubNode(t, { exitCode, stderr }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-threads-setup-test-"));
  const packageRoot = path.join(root, "package");
  const codexHome = path.join(root, "codex-home");
  const binDir = path.join(root, "bin");
  const requiredFiles = [
    path.join(packageRoot, "_internal", "app", "ChatGPT.exe"),
    path.join(packageRoot, "_internal", "bootstrap-codex-skills.ps1"),
    path.join(packageRoot, "_internal", "repair-chrome-host.ps1"),
    path.join(
      packageRoot,
      "_internal",
      "powershell-shim",
      "CodexOfflineShim",
      "repair-threads.js"
    ),
  ];
  for (const filePath of requiredFiles) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "");
  }
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "node.cmd"),
    `@echo off\r\n>&2 echo ${stderr}\r\nexit /b ${exitCode}\r\n`
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      setupScript,
      "-InstallRoot",
      packageRoot,
      "-CodexHome",
      codexHome,
      "-RepairThreads",
      "-ConfirmRepairThreadsRisk",
      "-SkipSkillSync",
      "-SkipChromeGuide",
      "-NoLaunch",
      "-NonInteractive",
      "-Language",
      "en",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir};${process.env.PATH}` },
      windowsHide: true,
    }
  );
}

function assertRepairSucceeded(result) {
  assert.equal(
    result.status,
    0,
    `repair failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
}

function readThread(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM threads WHERE id = ?").get(id);
  } finally {
    db.close();
  }
}

function readCatalogThread(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?")
      .get(id);
  } finally {
    db.close();
  }
}

function assertManagedReadOnlyPolicy(serialized) {
  const policy = JSON.parse(serialized);
  assert.equal(policy.type, "managed");
  assert.equal(policy.file_system?.type, "restricted");
  assert.equal(policy.network, "restricted");
  assert.deepEqual(policy.file_system.entries, JSON.parse(MANAGED_READ_ONLY_POLICY).file_system.entries);
}

function walkFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function snapshotTree(dir) {
  return Object.fromEntries(
    walkFiles(dir)
      .sort()
      .map((filePath) => {
        const contents = fs.readFileSync(filePath);
        return [
          path.relative(dir, filePath),
          {
            size: contents.length,
            sha256: createHash("sha256").update(contents).digest("hex"),
          },
        ];
      })
  );
}

function listDbBackups(dbPath) {
  const prefix = `${path.basename(dbPath)}.bak-repair-threads-`;
  return fs
    .readdirSync(path.dirname(dbPath))
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(path.dirname(dbPath), name));
}

function findRestorableStateBackup(home, originalId, missingId) {
  for (const candidate of walkFiles(home)) {
    const name = path.basename(candidate);
    if (name === "state_5.sqlite") continue;
    if (!name.startsWith("state_5.sqlite.bak-repair-threads-")) continue;

    let db;
    try {
      db = new DatabaseSync(candidate, { readOnly: true });
      const integrity = db.prepare("PRAGMA integrity_check").get();
      const original = db.prepare("SELECT * FROM threads WHERE id = ?").get(originalId);
      const missing = db.prepare("SELECT id FROM threads WHERE id = ?").get(missingId);
      if (integrity.integrity_check === "ok" && original && !missing) {
        return { candidate, original };
      }
    } catch {
      // Ignore unrelated backup artifacts and keep looking for a complete DB.
    } finally {
      db?.close();
    }
  }
  return null;
}

test("repair leaves an existing session JSONL byte-for-byte unchanged", (t) => {
  const existing = makeThread();
  const fixture = createFixture(t, { dbRows: [existing], sessions: [existing] });
  const sessionPath = fixture.sessionPaths.get(EXISTING_ID);
  const before = fs.readFileSync(sessionPath);

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assertRepairSucceeded(result);
  assert.deepEqual(fs.readFileSync(sessionPath), before);
});

test("repair preserves metadata and permissions of an existing database thread", (t) => {
  const existing = makeThread();
  const fixture = createFixture(t, { dbRows: [existing], sessions: [existing] });

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assertRepairSucceeded(result);
  const repaired = readThread(fixture.stateDbPath, EXISTING_ID);
  assert.deepEqual(
    {
      source: repaired.source,
      model_provider: repaired.model_provider,
      thread_source: repaired.thread_source,
      sandbox_policy: repaired.sandbox_policy,
      approval_mode: repaired.approval_mode,
    },
    ORIGINAL_METADATA
  );
});

test("repair imports a thread missing from both databases with conservative read-only safety", (t) => {
  const missing = makeThread({ id: MISSING_ID, title: "" });
  const fixture = createFixture(t, { sessions: [missing] });

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assertRepairSucceeded(result);
  const imported = readThread(fixture.stateDbPath, MISSING_ID);
  assert.deepEqual(
    {
      source: imported.source,
      model_provider: imported.model_provider,
      thread_source: imported.thread_source,
    },
    {
      source: ORIGINAL_METADATA.source,
      model_provider: ORIGINAL_METADATA.model_provider,
      thread_source: ORIGINAL_METADATA.thread_source,
    }
  );
  assert.equal(imported.approval_mode, "on-request");
  assertManagedReadOnlyPolicy(imported.sandbox_policy);
});

test("repair copies an existing Desktop thread when the App-server row is missing", (t) => {
  const desktopThread = makeThread({
    id: MISSING_ID,
    title: "desktop source row",
    first_user_message: "desktop first message",
    preview: "desktop preview",
  });
  const fixture = createFixture(t, {
    desktopRows: [desktopThread],
    sessions: [desktopThread],
  });

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assertRepairSucceeded(result);
  const imported = readThread(fixture.stateDbPath, MISSING_ID);
  for (const column of [
    "source",
    "model_provider",
    "thread_source",
    "sandbox_policy",
    "approval_mode",
    "model",
    "title",
    "first_user_message",
    "preview",
  ]) {
    assert.equal(imported[column], desktopThread[column], column);
  }
});

test("repair creates a complete pre-change SQLite backup that can restore original rows", (t) => {
  const existing = makeThread();
  const missing = makeThread({ id: MISSING_ID, title: "" });
  const fixture = createFixture(t, {
    dbRows: [existing],
    sessions: [existing, missing],
  });

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assertRepairSucceeded(result);
  const backup = findRestorableStateBackup(fixture.home, EXISTING_ID, MISSING_ID);
  assert.ok(backup, "expected a valid pre-repair state_5.sqlite backup under CODEX_HOME");
  assert.equal(backup.original.model_provider, ORIGINAL_METADATA.model_provider);
  assert.equal(backup.original.source, ORIGINAL_METADATA.source);
});

test("repair rolls back all inserts when a later thread import fails", (t) => {
  const first = makeThread({ id: MISSING_ID, title: "" });
  const failing = makeThread({ id: FAILING_ID, title: "" });
  const fixture = createFixture(t, { sessions: [first, failing] });
  const db = new DatabaseSync(fixture.stateDbPath);
  db.exec(`
    CREATE TRIGGER fail_fixture_thread
    BEFORE INSERT ON threads
    WHEN NEW.id = '${FAILING_ID}'
    BEGIN
      SELECT RAISE(ABORT, 'fixture insertion failure');
    END;
  `);
  db.close();

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assert.notEqual(result.status, 0, "fixture failure must make repair exit non-zero");
  assert.equal(readThread(fixture.stateDbPath, MISSING_ID), undefined);
});

test("repair restores every database when a later Desktop insert fails", (t) => {
  const missing = makeThread({ id: MISSING_ID, title: "" });
  const fixture = createFixture(t, {
    desktopRows: [],
    sessions: [missing],
  });
  const desktopDb = new DatabaseSync(fixture.desktopDbPath);
  desktopDb.exec(`
    CREATE TRIGGER fail_desktop_fixture_thread
    BEFORE INSERT ON threads
    WHEN NEW.id = '${MISSING_ID}'
    BEGIN
      SELECT RAISE(ABORT, 'desktop fixture insertion failure');
    END;
  `);
  desktopDb.close();

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assert.notEqual(result.status, 0, "Desktop failure must make repair exit non-zero");
  assert.equal(readThread(fixture.stateDbPath, MISSING_ID), undefined);
  assert.equal(readThread(fixture.desktopDbPath, MISSING_ID), undefined);
});

test("repair refuses to run without --confirm-risk and prints a risk warning", (t) => {
  const existing = makeThread();
  const fixture = createFixture(t, { dbRows: [existing], sessions: [existing] });

  const result = runRepair(fixture.home);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /风险|危险|risk/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /--confirm-risk/);
});

test("repair without --confirm-risk leaves CODEX_HOME unchanged", (t) => {
  const existing = makeThread();
  const missing = makeThread({ id: MISSING_ID, title: "" });
  const fixture = createFixture(t, {
    dbRows: [existing],
    sessions: [existing, missing],
  });
  const before = snapshotTree(fixture.home);

  runRepair(fixture.home);

  assert.deepEqual(snapshotTree(fixture.home), before);
});

test("repair executes when --confirm-risk is provided", (t) => {
  const missing = makeThread({ id: MISSING_ID, title: "" });
  const fixture = createFixture(t, { sessions: [missing] });

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assertRepairSucceeded(result);
  assert.equal(readThread(fixture.stateDbPath, MISSING_ID)?.id, MISSING_ID);
});

test("confirmed repair still prints a prominent risk warning", (t) => {
  const missing = makeThread({ id: MISSING_ID, title: "" });
  const fixture = createFixture(t, { sessions: [missing] });

  const result = runRepair(fixture.home, ["--confirm-risk"]);

  assertRepairSucceeded(result);
  assert.match(`${result.stdout}\n${result.stderr}`, /慎用|风险|危险|risk/i);
});

test("restore refuses to run without --confirm-risk and prints a risk warning", (t) => {
  const fixture = createRestoreFixture(t);

  const result = runRepair(fixture.home, ["--restore"]);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /风险|危险|risk/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /--confirm-risk/);
});

test("restore without --confirm-risk leaves CODEX_HOME unchanged", (t) => {
  const fixture = createRestoreFixture(t);
  const before = snapshotTree(fixture.home);

  runRepair(fixture.home, ["--restore"]);

  assert.deepEqual(snapshotTree(fixture.home), before);
});

test("restore repairs only evidenced metadata while preserving the current JSONL body", (t) => {
  const fixture = createRestoreFixture(t);

  const result = runRepair(fixture.home, ["--restore", "--confirm-risk"]);

  assertRepairSucceeded(result);
  assert.notEqual(fixture.expectedRestoredJsonl, fixture.originalJsonl);
  assert.equal(fs.readFileSync(fixture.sessionPath, "utf8"), fixture.expectedRestoredJsonl);

  const restored = readThread(fixture.stateDbPath, EXISTING_ID);
  assert.deepEqual(
    {
      source: restored.source,
      model_provider: restored.model_provider,
      thread_source: restored.thread_source,
      sandbox_policy: restored.sandbox_policy,
      approval_mode: restored.approval_mode,
    },
    ORIGINAL_METADATA
  );

  const catalogThread = readCatalogThread(fixture.catalogDbPath, EXISTING_ID);
  assert.equal(catalogThread.source_kind, ORIGINAL_METADATA.source);
  assert.equal(catalogThread.model_provider, ORIGINAL_METADATA.model_provider);
  assert.match(`${result.stdout}\n${result.stderr}`, /无法自动恢复/);
  assert.match(`${result.stdout}\n${result.stderr}`, /sandbox_policy|approval_mode/);
});

test("restore reports a conflict instead of overwriting a later valid session header", (t) => {
  const fixture = createRestoreFixture(t);
  const conflicted = rewriteSessionHeader(
    fs.readFileSync(fixture.sessionPath, "utf8"),
    (payload) => {
      payload.source = "vscode";
      payload.model_provider = "openai";
      payload.thread_source = "subagent";
    }
  );
  fs.writeFileSync(fixture.sessionPath, conflicted);

  const result = runRepair(fixture.home, ["--restore", "--confirm-risk"]);

  assert.equal(fs.readFileSync(fixture.sessionPath, "utf8"), conflicted);
  assert.match(`${result.stdout}\n${result.stderr}`, /conflict|冲突/i);
});

test("restore uses an unbacked valid JSONL header only to repair DB and catalog rows", (t) => {
  const original = makeThread();
  const polluted = makeThread({
    source: "cli",
    model_provider: "custom",
    thread_source: "user",
  });
  const fixture = createFixture(t, { dbRows: [polluted], sessions: [original] });
  const catalogDbPath = path.join(fixture.home, "sqlite", "codex-dev.db");
  createCatalogDb(catalogDbPath, [polluted]);
  const sessionPath = fixture.sessionPaths.get(EXISTING_ID);
  const before = fs.readFileSync(sessionPath);

  const result = runRepair(fixture.home, ["--restore", "--confirm-risk"]);

  assertRepairSucceeded(result);
  assert.deepEqual(fs.readFileSync(sessionPath), before);
  const restored = readThread(fixture.stateDbPath, EXISTING_ID);
  assert.equal(restored.source, ORIGINAL_METADATA.source);
  assert.equal(restored.model_provider, ORIGINAL_METADATA.model_provider);
  assert.equal(restored.thread_source, ORIGINAL_METADATA.thread_source);
  const catalog = readCatalogThread(catalogDbPath, EXISTING_ID);
  assert.equal(catalog.source_kind, ORIGINAL_METADATA.source);
  assert.equal(catalog.model_provider, ORIGINAL_METADATA.model_provider);
});

test("restore writes NULL when backup evidence omits nullable thread_source", (t) => {
  const original = makeThread();
  const polluted = makeThread({
    source: "cli",
    model_provider: "custom",
    thread_source: "user",
  });
  const fixture = createFixture(t, {
    dbRows: [polluted],
    sessions: [polluted],
    threadSourceNullable: true,
  });
  const sessionPath = fixture.sessionPaths.get(EXISTING_ID);
  const backup = rewriteSessionHeader(sessionJsonl(original), (payload) => {
    delete payload.thread_source;
  });
  fs.writeFileSync(`${sessionPath}.bak-repair-session-meta`, backup);

  const result = runRepair(fixture.home, ["--restore", "--confirm-risk"]);

  assertRepairSucceeded(result);
  assert.equal(readThread(fixture.stateDbPath, EXISTING_ID).thread_source, null);
  const restoredHeader = JSON.parse(fs.readFileSync(sessionPath, "utf8").split("\n", 1)[0]);
  assert.equal(Object.hasOwn(restoredHeader.payload, "thread_source"), false);
});

test("restore snapshots every database before replaying legacy evidence", (t) => {
  const fixture = createRestoreFixture(t);

  const result = runRepair(fixture.home, ["--restore", "--confirm-risk"]);

  assertRepairSucceeded(result);
  const stateBackups = listDbBackups(fixture.stateDbPath);
  const catalogBackups = listDbBackups(fixture.catalogDbPath);
  assert.equal(stateBackups.length, 1);
  assert.equal(catalogBackups.length, 1);

  const stateBackup = new DatabaseSync(stateBackups[0], { readOnly: true });
  const catalogBackup = new DatabaseSync(catalogBackups[0], { readOnly: true });
  try {
    assert.equal(
      stateBackup.prepare("SELECT model_provider FROM threads WHERE id = ?").get(EXISTING_ID)
        .model_provider,
      fixture.corrupted.model_provider
    );
    assert.equal(
      catalogBackup
        .prepare(
          "SELECT model_provider FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?"
        )
        .get(EXISTING_ID).model_provider,
      fixture.corrupted.model_provider
    );
  } finally {
    stateBackup.close();
    catalogBackup.close();
  }

  const stateStamp = path.basename(stateBackups[0]).slice("state_5.sqlite.bak-repair-threads-".length);
  const catalogStamp = path.basename(catalogBackups[0]).slice("codex-dev.db.bak-repair-threads-".length);
  assert.equal(stateStamp, catalogStamp);
});

test("installer GUI does not expose the repairthreads task", () => {
  const source = fs.readFileSync(installerTemplate, "utf8");

  assert.doesNotMatch(source, /TaskRepairThreads/i);
  assert.doesNotMatch(source, /Name:\s*["']repairthreads["']/i);
  assert.doesNotMatch(source, /WizardIsTaskSelected\(["']repairthreads["']\)/i);
});

test("PowerShell setup accepts a successful repair that writes its risk warning to stderr", (t) => {
  const result = runSetupWithStubNode(t, {
    exitCode: 0,
    stderr: "risk warning from fake repair",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.match(output, /risk warning from fake repair/i);
  assert.match(output, /Thread repair complete\./);
  assert.match(output, /Setup is complete\./);
});

test("PowerShell setup propagates a failed repair without printing completion", (t) => {
  const result = runSetupWithStubNode(t, {
    exitCode: 7,
    stderr: "repair failed from fake repair",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.match(output, /exit code 7|退出码[^\r\n]*7/i);
  assert.doesNotMatch(output, /Thread repair complete\.|Setup is complete\./);
});

test("PowerShell setup requires explicit repair or restore plus an independent risk confirmation", () => {
  const source = fs.readFileSync(setupScript, "utf8");
  const repairScriptIndex = source.indexOf("$repairScript =");
  assert.notEqual(repairScriptIndex, -1, "expected repair script invocation block");
  const repairBlock = source.slice(Math.max(0, repairScriptIndex - 1_000), repairScriptIndex + 2_000);

  assert.match(source, /\[switch\]\$RepairThreads/);
  assert.match(source, /\[switch\]\$RestoreThreads/);
  assert.match(source, /\[switch\]\$ConfirmRepairThreadsRisk/);
  assert.match(repairBlock, /\$RepairThreads/);
  assert.match(repairBlock, /\$RestoreThreads/);
  assert.match(
    repairBlock,
    /if\s*\(\s*(?:-not\s+)?\$ConfirmRepairThreadsRisk\s*\)/i
  );
  assert.doesNotMatch(repairBlock, /Read-SetupYesNo/);
  assert.doesNotMatch(repairBlock, /\$AssumeYes|\$NonInteractive/);
  assert.match(repairBlock, /--confirm-risk/);
  assert.match(repairBlock, /--restore/);
});
