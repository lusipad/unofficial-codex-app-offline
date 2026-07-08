// Scan ~/.codex/sessions/ for JSONL session files and import any
// threads missing from the Desktop's databases.
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
const desktopDbPath = path.join(sqliteDir, "state_5.sqlite");

if (!fs.existsSync(sessionsDir)) {
  console.log("No sessions directory found.");
  process.exit(0);
}
if (!fs.existsSync(desktopDbPath)) {
  console.log("Desktop database not found.");
  process.exit(1);
}

// ---- 1. Collect thread metadata from JSONL files --------------------------

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

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

function parseSessionMeta(filePath) {
  try {
    const firstLine = readFirstLine(filePath);
    const obj = JSON.parse(firstLine);
    if (obj.type !== "session_meta") return null;
    const p = obj.payload;
    return {
      id: p.id,
      rollout_path: filePath,
      created_at: p.timestamp ? new Date(p.timestamp).getTime() : Date.now(),
      updated_at: fs.statSync(filePath).mtimeMs,
      source: p.source || "cli",
      model_provider: p.model_provider || "openai",
      cwd: p.cwd || "",
      title: null,
      cli_version: p.cli_version || null,
      git_branch: null,
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

// ---- 2. Find threads missing from Desktop state_5.sqlite ------------------

const desktopDb = new DatabaseSync(desktopDbPath);
const existingIds = new Set(
  desktopDb.prepare("SELECT id FROM threads").all().map((r) => r.id)
);

const missing = sessionMetas.filter((m) => !existingIds.has(m.id));
console.log(`Desktop DB has ${existingIds.size} threads, ${missing.length} missing.`);

if (missing.length === 0) {
  console.log("Nothing to repair.");
  desktopDb.close();
  process.exit(0);
}

// ---- 3. Insert missing threads into Desktop state_5.sqlite ----------------

const desktopCols = desktopDb
  .prepare("PRAGMA table_info(threads)")
  .all()
  .map((r) => r.name);

const DEFAULTS = {
  title: "",
  sandbox_policy: '{"type":"disabled"}',
  approval_mode: "never",
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
].filter((c) => desktopCols.includes(c));

const placeholders = insertCols.map(() => "?").join(", ");
const insertStmt = desktopDb.prepare(
  `INSERT OR IGNORE INTO threads (${insertCols.join(", ")}) VALUES (${placeholders})`
);

for (const m of missing) {
  insertStmt.run(...insertCols.map((c) => m[c] ?? DEFAULTS[c] ?? null));
}

console.log(`Imported ${missing.length} threads into Desktop DB.`);
desktopDb.close();

// ---- 4. Update catalog (codex.db / codex-dev.db) --------------------------

let catalogPath = null;
for (const name of ["codex.db", "codex-dev.db"]) {
  const p = path.join(sqliteDir, name);
  if (fs.existsSync(p)) {
    catalogPath = p;
    break;
  }
}

if (!catalogPath) {
  console.log("Catalog DB not found, skipping catalog update.");
  process.exit(0);
}

const catDb = new DatabaseSync(catalogPath);

const catalogIds = new Set(
  catDb
    .prepare(
      "SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local'"
    )
    .all()
    .map((r) => r.thread_id)
);

const catalogMissing = missing.filter((m) => !catalogIds.has(m.id));

if (catalogMissing.length > 0) {
  const syncRow = catDb
    .prepare(
      "SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id = 'local'"
    )
    .get();
  let nextSeq = syncRow ? syncRow.observation_sequence + 1 : 1;

  const insertCat = catDb.prepare(
    "INSERT OR IGNORE INTO local_thread_catalog " +
      "(host_id, thread_id, display_title, source_created_at, source_updated_at, " +
      " cwd, source_kind, source_detail, model_provider, git_branch, " +
      " observation_sequence, missing_candidate) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
  );

  for (const m of catalogMissing) {
    insertCat.run(
      "local",
      m.id,
      m.title || "Imported session",
      Number(m.created_at),
      Number(m.updated_at),
      m.cwd || "",
      m.source || "cli",
      null,
      m.model_provider || "openai",
      m.git_branch || null,
      nextSeq++
    );
  }

  catDb
    .prepare(
      "UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1"
    )
    .run();

  console.log(`Added ${catalogMissing.length} entries to catalog.`);
}

catDb.close();
console.log("Repair complete.");
process.exit(0);
