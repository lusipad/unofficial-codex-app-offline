// Scan ~/.codex/sessions/ for JSONL session files and import any
// threads missing from the Desktop's databases.  Also ensure every
// thread in state_5.sqlite has a catalog entry with a high
// observation_sequence so Desktop's cold-full-sweep cannot hide it.
//
// Usage: node repair-threads.js
// Exit 0 on success, 1 on error.

"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const os = require("os");

const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const sessionsDir = path.join(home, "sessions");
const sqliteDir = path.join(home, "sqlite");
const appServerDbPath = path.join(home, "state_5.sqlite");
const desktopDbPath = path.join(sqliteDir, "state_5.sqlite");

// observation_sequence ceiling — must be far higher than any value the
// Desktop's nextObservationSequence() will ever reach, so completeScan's
// "observation_sequence <= ?" check never matches our pinned entries.
const PINNED_SEQ = 2147483647;
const RECENT_LIST_MODEL_PROVIDER = "custom";
const RECENT_LIST_SOURCE = "cli";
const RECENT_LIST_THREAD_SOURCE = "user";
const DEFAULT_MODEL = "gpt-5.5";
const FULL_ACCESS_SANDBOX_POLICY = '{"type":"disabled"}';
const FULL_ACCESS_APPROVAL_MODE = "never";
const SESSION_META_BACKUP_SUFFIX = ".bak-repair-session-meta";

if (!fs.existsSync(sessionsDir)) {
  console.log("No sessions directory found.");
  process.exit(0);
}
if (!fs.existsSync(appServerDbPath)) {
  console.log("App-server database not found.");
  process.exit(1);
}

// ---- 1. Collect thread metadata from JSONL files --------------------------

const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function walkSessionFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkSessionFiles(full));
    } else if (entry.name.endsWith(".jsonl") && UUID_RE.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function readFirstLine(filePath) {
  const CHUNK = 256 * 1024;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    const n = fs.readSync(fd, buf, 0, CHUNK, 0);
    const text = buf.toString("utf8", 0, n);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    fs.closeSync(fd);
  }
}

function readInitialLines(filePath, maxLines = 80) {
  const CHUNK = 1024 * 1024;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(CHUNK);
    const n = fs.readSync(fd, buf, 0, CHUNK, 0);
    return buf
      .toString("utf8", 0, n)
      .split(/\r?\n/)
      .slice(0, maxLines)
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 20_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function toEpochSeconds(value) {
  return Math.floor(toEpochMs(value) / 1000);
}

function firstTextFromInput(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  return input
    .flatMap((item) => {
      if (item == null || typeof item !== "object") return [];
      if (typeof item.text === "string") return [item.text];
      if (typeof item.content === "string") return [item.content];
      return [];
    })
    .join("\n")
    .trim();
}

function readFirstUserMessage(filePath) {
  try {
    for (const line of readInitialLines(filePath)) {
      const obj = JSON.parse(line);
      if (obj.type === "event_msg" && obj.payload?.type === "user_message") {
        return String(obj.payload.message || "").trim();
      }
      if (obj.type === "user_message") {
        return String(obj.payload?.message || obj.message || "").trim();
      }
      if (obj.type === "turn_context" || obj.type === "response_item") {
        const text = firstTextFromInput(obj.payload?.input || obj.input);
        if (text) return text;
      }
    }
  } catch {}
  return "";
}

function makeShortText(text, fallback) {
  const raw = String(text || fallback || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  return raw.length <= 80 ? raw : raw.slice(0, 79).trimEnd() + "…";
}

function parseSessionMeta(filePath) {
  try {
    const firstLine = readFirstLine(filePath);
    const obj = JSON.parse(firstLine);
    if (obj.type !== "session_meta") return null;
    const p = obj.payload;
    const createdMs = toEpochMs(p.timestamp);
    const updatedMs = fs.statSync(filePath).mtimeMs;
    const firstUserMessage = readFirstUserMessage(filePath);
    const title = makeShortText(firstUserMessage, p.cwd || p.id);
    return {
      id: p.id,
      rollout_path: filePath,
      created_at: Math.floor(createdMs / 1000),
      updated_at: Math.floor(updatedMs / 1000),
      created_at_ms: Math.round(createdMs),
      updated_at_ms: Math.round(updatedMs),
      source: RECENT_LIST_SOURCE,
      model_provider: RECENT_LIST_MODEL_PROVIDER,
      cwd: p.cwd || "",
      title,
      cli_version: p.cli_version || null,
      git_branch: null,
      first_user_message: firstUserMessage,
      preview: firstUserMessage,
      model: p.model || DEFAULT_MODEL,
      thread_source: p.thread_source || RECENT_LIST_THREAD_SOURCE,
    };
  } catch {
    return null;
  }
}

const jsonlFiles = walkSessionFiles(sessionsDir);
const sessionMetas = [];
for (const f of jsonlFiles) {
  const meta = parseSessionMeta(f);
  if (meta) sessionMetas.push(meta);
}

console.log(`Found ${sessionMetas.length} session files.`);

function readVisibleThreadIds(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return new Set(
      db
        .prepare("SELECT id FROM threads WHERE archived = 0")
        .all()
        .map((r) => r.id)
    );
  } finally {
    db.close();
  }
}

function normalizeSessionMetaFiles(visibleThreadIds) {
  let changed = 0;
  let skipped = 0;

  for (const meta of sessionMetas) {
    if (!visibleThreadIds.has(meta.id)) continue;

    let firstLine;
    try {
      firstLine = readFirstLine(meta.rollout_path);
      const obj = JSON.parse(firstLine);
      if (obj.type !== "session_meta" || obj.payload == null) {
        skipped++;
        continue;
      }

      const payload = obj.payload;
      const alreadyCorrect =
        payload.model_provider === RECENT_LIST_MODEL_PROVIDER &&
        payload.source === RECENT_LIST_SOURCE &&
        payload.thread_source === RECENT_LIST_THREAD_SOURCE;
      if (alreadyCorrect) continue;

      payload.model_provider = RECENT_LIST_MODEL_PROVIDER;
      payload.source = RECENT_LIST_SOURCE;
      payload.thread_source = RECENT_LIST_THREAD_SOURCE;

      const text = fs.readFileSync(meta.rollout_path, "utf8");
      const nl = text.indexOf("\n");
      const rest = nl === -1 ? "" : text.slice(nl + 1);
      const eol = nl > 0 && text[nl - 1] === "\r" ? "\r\n" : "\n";
      const backupPath = meta.rollout_path + SESSION_META_BACKUP_SUFFIX;
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(meta.rollout_path, backupPath);
      }
      fs.writeFileSync(meta.rollout_path, JSON.stringify(obj) + eol + rest);
      changed++;
    } catch {
      skipped++;
    }
  }

  console.log(
    `Normalized ${changed} visible session_meta JSONL headers (${skipped} skipped).`
  );
}

normalizeSessionMetaFiles(readVisibleThreadIds(appServerDbPath));

// ---- 2. Repair the app-server state_5.sqlite used by thread/list ----------

function repairThreadsDb(dbPath, label) {
  const db = new DatabaseSync(dbPath);
  const cols = db
    .prepare("PRAGMA table_info(threads)")
    .all()
    .map((r) => r.name);
  const existingIds = new Set(
    db.prepare("SELECT id FROM threads").all().map((r) => r.id)
  );

  const missing = sessionMetas.filter((m) => !existingIds.has(m.id));
  console.log(
    `${label} DB has ${existingIds.size} threads, ${missing.length} missing.`
  );

  if (missing.length > 0) {
    const DEFAULTS = {
      title: "",
      sandbox_policy: FULL_ACCESS_SANDBOX_POLICY,
      approval_mode: FULL_ACCESS_APPROVAL_MODE,
      model_provider: RECENT_LIST_MODEL_PROVIDER,
      source: RECENT_LIST_SOURCE,
      thread_source: RECENT_LIST_THREAD_SOURCE,
      model: DEFAULT_MODEL,
      first_user_message: "",
      preview: "",
    };

    const insertCols = [
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
    ].filter((c) => cols.includes(c));

    const placeholders = insertCols.map(() => "?").join(", ");
    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO threads (${insertCols.join(", ")}) VALUES (${placeholders})`
    );

    for (const m of missing) {
      insertStmt.run(...insertCols.map((c) => m[c] ?? DEFAULTS[c] ?? null));
    }

    console.log(`Imported ${missing.length} threads into ${label} DB.`);
  }

  function hasCol(name) {
    return cols.includes(name);
  }

  const normalizeSets = [
    "created_at = CASE WHEN created_at > 20000000000 THEN CAST(created_at / 1000 AS INTEGER) ELSE CAST(created_at AS INTEGER) END",
    "updated_at = CASE WHEN updated_at > 20000000000 THEN CAST(updated_at / 1000 AS INTEGER) ELSE CAST(updated_at AS INTEGER) END",
    "model_provider = ?",
    "source = ?",
  ];
  const normalizeParams = [RECENT_LIST_MODEL_PROVIDER, RECENT_LIST_SOURCE];

  if (hasCol("created_at_ms")) {
    normalizeSets.push(
      "created_at_ms = CASE WHEN created_at_ms > 20000000000000 THEN CAST(created_at_ms / 1000 AS INTEGER) WHEN created_at_ms IS NULL OR created_at_ms < 20000000000 THEN CAST((CASE WHEN created_at > 20000000000 THEN created_at ELSE created_at * 1000 END) AS INTEGER) ELSE CAST(created_at_ms AS INTEGER) END"
    );
  }
  if (hasCol("updated_at_ms")) {
    normalizeSets.push(
      "updated_at_ms = CASE WHEN updated_at_ms > 20000000000000 THEN CAST(updated_at_ms / 1000 AS INTEGER) WHEN updated_at_ms IS NULL OR updated_at_ms < 20000000000 THEN CAST((CASE WHEN updated_at > 20000000000 THEN updated_at ELSE updated_at * 1000 END) AS INTEGER) ELSE CAST(updated_at_ms AS INTEGER) END"
    );
  }
  if (hasCol("thread_source")) {
    normalizeSets.push("thread_source = ?");
    normalizeParams.push(RECENT_LIST_THREAD_SOURCE);
  }
  if (hasCol("model")) {
    normalizeSets.push("model = COALESCE(NULLIF(model, ''), ?)");
    normalizeParams.push(DEFAULT_MODEL);
  }
  if (hasCol("sandbox_policy")) {
    normalizeSets.push("sandbox_policy = ?");
    normalizeParams.push(FULL_ACCESS_SANDBOX_POLICY);
  }
  if (hasCol("approval_mode")) {
    normalizeSets.push("approval_mode = ?");
    normalizeParams.push(FULL_ACCESS_APPROVAL_MODE);
  }
  if (hasCol("first_user_message")) {
    normalizeSets.push(
      "first_user_message = COALESCE(NULLIF(first_user_message, ''), NULLIF(preview, ''), NULLIF(title, ''), cwd)"
    );
  }
  if (hasCol("preview")) {
    normalizeSets.push(
      "preview = COALESCE(NULLIF(preview, ''), NULLIF(first_user_message, ''), NULLIF(title, ''), cwd)"
    );
  }
  if (hasCol("title")) {
    normalizeSets.push(
      "title = COALESCE(NULLIF(title, ''), NULLIF(first_user_message, ''), NULLIF(preview, ''), cwd)"
    );
  }

  const normalized = db
    .prepare(
      `UPDATE threads SET ${normalizeSets.join(", ")} WHERE archived = 0`
    )
    .run(...normalizeParams);
  console.log(
    `Normalized ${normalized.changes} visible ${label} DB threads for default recent-list discovery.`
  );

  db.close();
}

repairThreadsDb(appServerDbPath, "App-server");

// Keep the legacy Desktop sqlite copy in sync when present. Deep links and
// older Desktop flows still consult this DB, while current thread/list reads
// the app-server DB above.
if (fs.existsSync(desktopDbPath)) {
  repairThreadsDb(desktopDbPath, "Desktop");
}

// ---- 4. Update catalog (codex-dev.db) ------------------------------------
// Desktop with unset BUILD_FLAVOR uses codex-dev.db; we also check codex.db
// for completeness.

let catalogPath = null;
for (const name of ["codex-dev.db", "codex.db"]) {
  const p = path.join(sqliteDir, name);
  if (fs.existsSync(p)) {
    catalogPath = p;
    break;
  }
}

if (!catalogPath) {
  // Create codex-dev.db from scratch — the Desktop would create it too, but
  // we need it now to pre-populate.
  catalogPath = path.join(sqliteDir, "codex-dev.db");
  console.log("Catalog DB not found, creating codex-dev.db.");
}

const catDb = new DatabaseSync(catalogPath);

// Ensure schema exists (Desktop normally creates these)
catDb.exec(`
  CREATE TABLE IF NOT EXISTS local_thread_catalog (
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
  CREATE TABLE IF NOT EXISTS local_thread_catalog_sync_state (
    host_id TEXT PRIMARY KEY,
    watermark_updated_at REAL,
    initial_build_complete INTEGER DEFAULT 0,
    observation_sequence INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS local_thread_catalog_metadata (
    id INTEGER PRIMARY KEY,
    catalog_revision INTEGER DEFAULT 0
  );
  INSERT OR IGNORE INTO local_thread_catalog_metadata (id, catalog_revision)
    VALUES (1, 0);
  INSERT OR IGNORE INTO local_thread_catalog_sync_state
    (host_id, watermark_updated_at, initial_build_complete, observation_sequence)
    VALUES ('local', NULL, 0, 0);
`);

// ---- 4a. Sync ALL non-archived threads from app-server DB into catalog ----

const stateDb = new DatabaseSync(appServerDbPath, { readOnly: true });
const allThreads = stateDb
  .prepare(
    `SELECT id, title, created_at, updated_at, source,
            model_provider, cwd, git_branch
     FROM threads WHERE archived = 0`
  )
  .all();
stateDb.close();

function parseSourceKind(src) {
  if (typeof src === "string" && !src.startsWith("{")) return src;
  if (typeof src === "string") {
    try {
      const obj = JSON.parse(src);
      if (typeof obj === "object" && obj !== null) {
        if ("subagent" in obj) return "subagent";
        if ("custom" in obj) return "custom";
      }
    } catch {}
  }
  return "unknown";
}

function makeDisplayTitle(t) {
  const raw = (t.title || t.cwd || t.id || "").replace(/\s+/g, " ").trim();
  if (raw.length === 0) return t.id;
  return raw.length <= 36 ? raw : raw.slice(0, 35).trimEnd() + "…";
}

const upsertCat = catDb.prepare(`
  INSERT INTO local_thread_catalog
    (host_id, thread_id, display_title, source_created_at, source_updated_at,
     cwd, source_kind, source_detail, model_provider, git_branch,
     observation_sequence, missing_candidate)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT (host_id, thread_id) DO UPDATE SET
    display_title     = excluded.display_title,
    source_created_at = excluded.source_created_at,
    source_updated_at = excluded.source_updated_at,
    cwd               = excluded.cwd,
    source_kind       = excluded.source_kind,
    model_provider    = excluded.model_provider,
    git_branch        = excluded.git_branch,
    observation_sequence = excluded.observation_sequence,
    missing_candidate = 0
`);

let upserted = 0;
for (const t of allThreads) {
  const createdMs = toEpochMs(t.created_at);
  const updatedMs = toEpochMs(t.updated_at || t.created_at);

  upsertCat.run(
    "local",
    t.id,
    makeDisplayTitle(t),
    createdMs,
    updatedMs,
    t.cwd || "",
    parseSourceKind(t.source),
    null,
    t.model_provider || "",
    t.git_branch || null,
    PINNED_SEQ
  );
  upserted++;
}

console.log(
  `Synced ${upserted} threads from state_5.sqlite into catalog (all pinned at seq=${PINNED_SEQ}).`
);

// ---- 4b. Pin any pre-existing catalog entries too -------------------------

catDb
  .prepare(
    `UPDATE local_thread_catalog
     SET observation_sequence = ?, missing_candidate = 0
     WHERE host_id = 'local' AND observation_sequence < ?`
  )
  .run(PINNED_SEQ, PINNED_SEQ);

// ---- 4c. Mark initial build complete and set watermark --------------------

const maxTs = catDb
  .prepare("SELECT MAX(source_updated_at) as v FROM local_thread_catalog")
  .get();

catDb
  .prepare(
    `UPDATE local_thread_catalog_sync_state
     SET initial_build_complete = 1, watermark_updated_at = ?
     WHERE host_id = 'local'`
  )
  .run(maxTs.v);

catDb
  .prepare(
    `UPDATE local_thread_catalog_metadata
     SET catalog_revision = catalog_revision + 1
     WHERE id = 1`
  )
  .run();

const finalCount = catDb
  .prepare(
    "SELECT COUNT(*) as cnt FROM local_thread_catalog WHERE host_id = 'local' AND missing_candidate = 0"
  )
  .get();

catDb.close();
console.log(
  `Catalog now has ${finalCount.cnt} visible entries. Repair complete.`
);
process.exit(0);
