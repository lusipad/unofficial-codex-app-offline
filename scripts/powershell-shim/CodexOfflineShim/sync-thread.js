// Sync CLI threads into the Desktop's databases so that
// codex://threads/{uuid} deep links show the full conversation.
//
// When called with a thread-id, syncs ALL missing CLI threads (so the
// Desktop sidebar shows the full history) and ensures that specific
// thread is definitely present.
//
// Usage: node sync-thread.js <thread-id>
// Exit 0 on success, 1 on error.

"use strict";
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const targetId = process.argv[2];
if (!targetId) process.exit(1);

const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const sqliteDir = path.join(home, "sqlite");
const cliDbPath = path.join(home, "state_5.sqlite");
const desktopDbPath = path.join(sqliteDir, "state_5.sqlite");

if (!fs.existsSync(cliDbPath) || !fs.existsSync(desktopDbPath))
  process.exit(1);

// ---- 1. Sync thread rows into Desktop state_5.sqlite ---------------------

const cliDb = new DatabaseSync(cliDbPath, { readOnly: true });
const desktopDb = new DatabaseSync(desktopDbPath);

const cliCols = cliDb
  .prepare("PRAGMA table_info(threads)")
  .all()
  .map((r) => r.name);
const desktopCols = desktopDb
  .prepare("PRAGMA table_info(threads)")
  .all()
  .map((r) => r.name);
const common = desktopCols.filter((c) => cliCols.includes(c));
const colList = common.join(", ");
const placeholders = common.map(() => "?").join(", ");

// Find CLI threads not yet in Desktop DB
const desktopIds = new Set(
  desktopDb
    .prepare("SELECT id FROM threads")
    .all()
    .map((r) => r.id)
);

const missingRows = cliDb
  .prepare(`SELECT ${colList} FROM threads WHERE archived = 0 OR archived IS NULL`)
  .all()
  .filter((r) => !desktopIds.has(r.id));

if (missingRows.length > 0) {
  const insert = desktopDb.prepare(
    `INSERT OR IGNORE INTO threads (${colList}) VALUES (${placeholders})`
  );
  for (const row of missingRows) {
    insert.run(...common.map((c) => row[c]));
  }
}

// ---- 2. Sync into Desktop catalog (codex.db / codex-dev.db) --------------

let catalogPath = null;
for (const name of ["codex.db", "codex-dev.db"]) {
  const p = path.join(sqliteDir, name);
  if (fs.existsSync(p)) {
    catalogPath = p;
    break;
  }
}

if (catalogPath) {
  const catDb = new DatabaseSync(catalogPath);

  const existingIds = new Set(
    catDb
      .prepare(
        "SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local'"
      )
      .all()
      .map((r) => r.thread_id)
  );

  const syncRow = catDb
    .prepare(
      "SELECT observation_sequence FROM local_thread_catalog_sync_state " +
        "WHERE host_id = 'local'"
    )
    .get();
  let nextSeq = syncRow ? syncRow.observation_sequence + 1 : 1;

  // Read meta for all missing threads from CLI DB
  const allMeta = cliDb
    .prepare(
      "SELECT id, title, created_at, updated_at, cwd, source, " +
        "model_provider, git_branch " +
        "FROM threads WHERE archived = 0 OR archived IS NULL"
    )
    .all()
    .filter((r) => !existingIds.has(r.id));

  if (allMeta.length > 0) {
    const insertCat = catDb.prepare(
      "INSERT OR IGNORE INTO local_thread_catalog " +
        "(host_id, thread_id, display_title, source_created_at, source_updated_at, " +
        " cwd, source_kind, source_detail, model_provider, git_branch, " +
        " observation_sequence, missing_candidate) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
    );

    for (const m of allMeta) {
      insertCat.run(
        "local",
        m.id,
        m.title || "CLI session",
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
        "UPDATE local_thread_catalog_metadata " +
          "SET catalog_revision = catalog_revision + 1 WHERE id = 1"
      )
      .run();
  }

  catDb.close();
}

cliDb.close();
desktopDb.close();
process.exit(0);
