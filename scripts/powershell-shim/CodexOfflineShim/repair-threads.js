// Import session files that are genuinely missing from Codex databases.
// This is a risky recovery tool and must never be run implicitly.
//
// Usage:
//   node repair-threads.js --confirm-risk
//   node repair-threads.js --restore --confirm-risk

"use strict";

const sqlite = require("node:sqlite");
const { DatabaseSync } = sqlite;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const SESSION_META_BACKUP_SUFFIX = ".bak-repair-session-meta";
const UUID_JSONL_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const CONSERVATIVE_APPROVAL_MODE = "on-request";
const CONSERVATIVE_SANDBOX_POLICY = JSON.stringify({
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

function printUsage() {
  console.error("用法 / Usage:");
  console.error("  node repair-threads.js --confirm-risk");
  console.error("  node repair-threads.js --restore --confirm-risk");
}

function parseArguments(argv) {
  const options = { confirmRisk: false, restore: false };
  for (const argument of argv) {
    if (argument === "--confirm-risk") {
      options.confirmRisk = true;
    } else if (argument === "--restore") {
      options.restore = true;
    } else {
      throw new Error(`未知参数 / Unknown argument: ${argument}`);
    }
  }
  return options;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  printUsage();
  process.exitCode = 2;
}

if (options && !options.confirmRisk) {
  console.error(
    "风险警告 / Risk warning: 此工具会修改本地会话数据库；请先自行备份并确认理解风险。"
  );
  console.error(
    "This tool modifies local session databases. Back up your data and use it with caution."
  );
  console.error(
    "运行前请关闭 Codex App 和所有 Codex CLI 进程 / Close Codex App and all Codex CLI processes before running."
  );
  printUsage();
  process.exitCode = 2;
} else if (options) {
  console.error(
    "风险警告 / Risk warning: 已显式确认，仍请慎用；工具将先创建完整 SQLite 快照。"
  );
  console.error(
    "请确认 Codex App 和所有 Codex CLI 进程均已关闭，避免数据库句柄或 WAL 阻止恢复。 / Ensure all Codex App and CLI processes are closed so open handles or WAL files cannot block recovery."
  );
  main(options).catch((error) => {
    console.error(`会话修复失败 / Thread repair failed: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main({ restore }) {
  // Do not resolve or inspect CODEX_HOME until the explicit confirmation above.
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const paths = {
    sessions: path.join(home, "sessions"),
    appServer: path.join(home, "state_5.sqlite"),
    desktop: path.join(home, "sqlite", "state_5.sqlite"),
    sqliteDir: path.join(home, "sqlite"),
  };

  if (restore) {
    await restoreLegacyRepair(paths);
  } else {
    await importMissingThreads(paths);
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableInfo(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all();
}

function tableExists(db, tableName) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
  );
}

function withImmediateTransaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function readFirstLine(filePath) {
  const chunkSize = 256 * 1024;
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, 0);
    const text = buffer.toString("utf8", 0, bytesRead);
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    fs.closeSync(fd);
  }
}

function readInitialLines(filePath, maxLines = 80) {
  const chunkSize = 1024 * 1024;
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(chunkSize);
    const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, 0);
    return buffer
      .toString("utf8", 0, bytesRead)
      .split(/\r?\n/)
      .slice(0, maxLines)
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, predicate));
    } else if (predicate(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

function toEpochMs(value, fallback = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 20_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
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
      const record = JSON.parse(line);
      if (
        record.type === "event_msg" &&
        record.payload?.type === "user_message"
      ) {
        return String(record.payload.message || "").trim();
      }
      if (record.type === "user_message") {
        return String(record.payload?.message || record.message || "").trim();
      }
      if (record.type === "turn_context" || record.type === "response_item") {
        const text = firstTextFromInput(record.payload?.input || record.input);
        if (text) return text;
      }
    }
  } catch {}
  return "";
}

function shortText(value, fallback) {
  const text = String(value || fallback || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= 80 ? text : `${text.slice(0, 79).trimEnd()}…`;
}

function serializeSource(source) {
  if (typeof source === "string") return source;
  if (source !== undefined) return JSON.stringify(source);
  return "unknown";
}

function serializeOptionalValue(value) {
  if (value == null || typeof value === "string") return value;
  return JSON.stringify(value);
}

function sourceCatalogValues(source) {
  const serialized = serializeSource(source);
  if (typeof source === "string") {
    const trimmed = source.trim();
    if (!trimmed.startsWith("{")) {
      return { kind: trimmed || "unknown", detail: null };
    }
    try {
      source = JSON.parse(trimmed);
    } catch {
      return { kind: "unknown", detail: serialized };
    }
  }
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const keys = Object.keys(source);
    const kind = keys.includes("subagent")
      ? "subagent"
      : keys.includes("custom")
        ? "custom"
        : keys[0] || "unknown";
    return { kind, detail: serialized };
  }
  return { kind: "unknown", detail: serialized };
}

function parseSessionMeta(filePath) {
  try {
    const record = JSON.parse(readFirstLine(filePath));
    if (record.type !== "session_meta" || !record.payload?.id) return null;
    const payload = record.payload;
    const stat = fs.statSync(filePath);
    const createdAtMs = toEpochMs(payload.timestamp || record.timestamp, stat.mtimeMs);
    const updatedAtMs = Math.round(stat.mtimeMs);
    const firstUserMessage = readFirstUserMessage(filePath);
    return {
      id: payload.id,
      rollout_path: filePath,
      created_at: Math.floor(createdAtMs / 1000),
      updated_at: Math.floor(updatedAtMs / 1000),
      created_at_ms: Math.round(createdAtMs),
      updated_at_ms: updatedAtMs,
      source: serializeSource(payload.source),
      model_provider:
        payload.model_provider == null ? "" : String(payload.model_provider),
      cwd: payload.cwd || "",
      title: shortText(firstUserMessage, payload.cwd || payload.id),
      sandbox_policy: CONSERVATIVE_SANDBOX_POLICY,
      approval_mode: CONSERVATIVE_APPROVAL_MODE,
      cli_version: payload.cli_version || "",
      git_branch: payload.git_branch || null,
      first_user_message: firstUserMessage,
      preview: firstUserMessage,
      model: payload.model == null ? null : String(payload.model),
      thread_source: serializeOptionalValue(payload.thread_source),
    };
  } catch {
    return null;
  }
}

function collectSessionMetas(sessionsDir) {
  const byId = new Map();
  for (const filePath of walkFiles(sessionsDir, (name) => UUID_JSONL_RE.test(name))) {
    const meta = parseSessionMeta(filePath);
    if (!meta) continue;
    const previous = byId.get(meta.id);
    if (!previous || meta.updated_at_ms > previous.updated_at_ms) {
      byId.set(meta.id, meta);
    }
  }
  return [...byId.values()];
}

function rowsById(db, columns = ["*"]) {
  const selection =
    columns.length === 1 && columns[0] === "*"
      ? "*"
      : columns.map(quoteIdentifier).join(", ");
  return new Map(
    db
      .prepare(`SELECT ${selection} FROM threads`)
      .all()
      .map((row) => [row.id, row])
  );
}

function makeInsertSpec(info, values, label) {
  const columns = [];
  const parameters = [];
  for (const column of info) {
    if (Object.hasOwn(values, column.name) && values[column.name] !== undefined) {
      columns.push(column.name);
      parameters.push(values[column.name]);
    }
  }

  for (const column of info) {
    if (
      column.pk === 0 &&
      column.notnull === 1 &&
      column.dflt_value == null &&
      !columns.includes(column.name)
    ) {
      throw new Error(`${label} 缺少必填列 / missing required column: ${column.name}`);
    }
  }
  if (!columns.includes("id")) {
    throw new Error(`${label} 缺少 id / missing id`);
  }
  return { columns, parameters };
}

function insertIfMissing(db, spec) {
  const columnList = spec.columns.map(quoteIdentifier).join(", ");
  const placeholders = spec.columns.map(() => "?").join(", ");
  const id = spec.parameters[spec.columns.indexOf("id")];
  return db
    .prepare(
      `INSERT INTO threads (${columnList}) ` +
        `SELECT ${placeholders} WHERE NOT EXISTS (` +
        `SELECT 1 FROM threads WHERE id = ?)`
    )
    .run(...spec.parameters, id).changes;
}

function findCatalogPath(sqliteDir) {
  for (const name of ["codex-dev.db", "codex.db"]) {
    const candidate = path.join(sqliteDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function inspectCatalog(catalogPath, candidateIds) {
  if (!catalogPath) return { ready: false, missingIds: [] };
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  try {
    const requiredTables = [
      "local_thread_catalog",
      "local_thread_catalog_sync_state",
      "local_thread_catalog_metadata",
    ];
    if (!requiredTables.every((table) => tableExists(db, table))) {
      return { ready: false, missingIds: [] };
    }
    const syncState = db
      .prepare(
        "SELECT observation_sequence FROM local_thread_catalog_sync_state " +
          "WHERE host_id = 'local'"
      )
      .get();
    const metadata = db
      .prepare("SELECT catalog_revision FROM local_thread_catalog_metadata WHERE id = 1")
      .get();
    if (!syncState || !metadata) return { ready: false, missingIds: [] };
    const existing = new Set(
      db
        .prepare(
          "SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local'"
        )
        .all()
        .map((row) => row.thread_id)
    );
    return {
      ready: true,
      missingIds: candidateIds.filter((id) => !existing.has(id)),
    };
  } finally {
    db.close();
  }
}

function rowIsVisible(row) {
  return row && (row.archived == null || Number(row.archived) === 0);
}

async function importMissingThreads(paths) {
  if (!fs.existsSync(paths.sessions)) {
    console.log("未找到 sessions 目录 / No sessions directory found.");
    return;
  }
  if (!fs.existsSync(paths.appServer)) {
    throw new Error("未找到 App-server 数据库 / App-server database not found");
  }

  const sessions = collectSessionMetas(paths.sessions);
  console.log(`发现 ${sessions.length} 个会话文件 / Found ${sessions.length} session files.`);

  const appRead = new DatabaseSync(paths.appServer, { readOnly: true });
  let appInfo;
  let appRows;
  try {
    appInfo = tableInfo(appRead, "threads");
    if (appInfo.length === 0) throw new Error("App-server threads 表不存在");
    appRows = rowsById(appRead);
  } finally {
    appRead.close();
  }

  let desktopInfo = null;
  let desktopRows = new Map();
  if (fs.existsSync(paths.desktop)) {
    const desktopRead = new DatabaseSync(paths.desktop, { readOnly: true });
    try {
      desktopInfo = tableInfo(desktopRead, "threads");
      if (desktopInfo.length > 0) desktopRows = rowsById(desktopRead);
    } finally {
      desktopRead.close();
    }
  }

  const appColumnNames = new Set(appInfo.map((column) => column.name));
  const desktopCommonColumns = desktopInfo
    ? desktopInfo
        .map((column) => column.name)
        .filter((name) => appColumnNames.has(name))
    : [];
  const appInsertSpecs = [];
  const prospectiveRows = new Map(appRows);

  for (const session of sessions) {
    if (appRows.has(session.id)) continue;
    const desktopRow = desktopRows.get(session.id);
    const values = desktopRow
      ? Object.fromEntries(desktopCommonColumns.map((name) => [name, desktopRow[name]]))
      : session;
    appInsertSpecs.push(
      makeInsertSpec(appInfo, values, `App-server thread ${session.id}`)
    );
    prospectiveRows.set(session.id, desktopRow || { ...session, archived: 0 });
  }

  const desktopMissingIds = desktopInfo
    ? sessions
        .map((session) => session.id)
        .filter((id) => prospectiveRows.has(id) && !desktopRows.has(id))
    : [];
  const visibleCandidateIds = sessions
    .map((session) => session.id)
    .filter((id) => rowIsVisible(prospectiveRows.get(id)));
  const catalogPath = findCatalogPath(paths.sqliteDir);
  const catalogPlan = inspectCatalog(catalogPath, visibleCandidateIds);
  if (catalogPath && !catalogPlan.ready) {
    console.warn(
      "Catalog schema/state 不完整，已跳过 catalog 导入 / Catalog schema or state is incomplete; catalog import skipped."
    );
  }

  const databasesToModify = [];
  if (appInsertSpecs.length > 0) databasesToModify.push(paths.appServer);
  if (desktopMissingIds.length > 0) databasesToModify.push(paths.desktop);
  if (catalogPlan.missingIds.length > 0) databasesToModify.push(catalogPath);
  const backups = await backupDatabases(databasesToModify);

  try {
    let appInserted = 0;
    if (appInsertSpecs.length > 0) {
      const appDb = new DatabaseSync(paths.appServer);
      try {
        appInserted = withImmediateTransaction(appDb, () => {
          let inserted = 0;
          for (const spec of appInsertSpecs) inserted += insertIfMissing(appDb, spec);
          return inserted;
        });
      } finally {
        appDb.close();
      }
    }

    let desktopInserted = 0;
    if (desktopMissingIds.length > 0) {
      desktopInserted = copyAppRowsToDesktop(
        paths.appServer,
        paths.desktop,
        desktopMissingIds
      );
    }

    let catalogInserted = 0;
    if (catalogPlan.missingIds.length > 0) {
      catalogInserted = insertMissingCatalogRows(
        paths.appServer,
        catalogPath,
        catalogPlan.missingIds
      );
    }

    console.log(
      `修复完成 / Repair complete: App-server +${appInserted}, Desktop +${desktopInserted}, Catalog +${catalogInserted}.`
    );
  } catch (error) {
    compensateAndRethrow(backups, error);
  }
}

function copyAppRowsToDesktop(appPath, desktopPath, ids) {
  const appDb = new DatabaseSync(appPath, { readOnly: true });
  const desktopDb = new DatabaseSync(desktopPath);
  try {
    const appInfo = tableInfo(appDb, "threads");
    const desktopInfo = tableInfo(desktopDb, "threads");
    const appColumns = new Set(appInfo.map((column) => column.name));
    const commonColumns = desktopInfo
      .map((column) => column.name)
      .filter((name) => appColumns.has(name));
    const appRows = rowsById(appDb, commonColumns);
    const idSet = new Set(ids);
    return withImmediateTransaction(desktopDb, () => {
      let inserted = 0;
      for (const [id, row] of appRows) {
        if (!idSet.has(id)) continue;
        const spec = makeInsertSpec(desktopInfo, row, `Desktop thread ${id}`);
        inserted += insertIfMissing(desktopDb, spec);
      }
      return inserted;
    });
  } finally {
    desktopDb.close();
    appDb.close();
  }
}

function insertMissingCatalogRows(appPath, catalogPath, candidateIds) {
  const appDb = new DatabaseSync(appPath, { readOnly: true });
  const catalogDb = new DatabaseSync(catalogPath);
  try {
    const appRows = rowsById(appDb);
    const candidateSet = new Set(candidateIds);
    return withImmediateTransaction(catalogDb, () => {
      const syncState = catalogDb
        .prepare(
          "SELECT observation_sequence FROM local_thread_catalog_sync_state " +
            "WHERE host_id = 'local'"
        )
        .get();
      if (!syncState) throw new Error("Catalog sync_state(local) 不存在");
      if (
        !catalogDb
          .prepare("SELECT 1 FROM local_thread_catalog_metadata WHERE id = 1")
          .get()
      ) {
        throw new Error("Catalog metadata(1) 不存在");
      }

      const existing = new Set(
        catalogDb
          .prepare(
            "SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local'"
          )
          .all()
          .map((row) => row.thread_id)
      );
      const insert = catalogDb.prepare(`
        INSERT INTO local_thread_catalog
          (host_id, thread_id, display_title, source_created_at,
           source_updated_at, cwd, source_kind, source_detail,
           model_provider, git_branch, observation_sequence, missing_candidate)
        VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);
      let sequence = Number(syncState.observation_sequence) || 0;
      let inserted = 0;
      for (const [id, row] of appRows) {
        if (!candidateSet.has(id) || existing.has(id) || !rowIsVisible(row)) continue;
        const source = sourceCatalogValues(row.source);
        sequence += 1;
        insert.run(
          id,
          shortText(row.title, row.cwd || id),
          toEpochMs(row.created_at_ms ?? row.created_at),
          toEpochMs(row.updated_at_ms ?? row.updated_at ?? row.created_at),
          row.cwd || "",
          source.kind,
          source.detail,
          row.model_provider || "",
          row.git_branch || null,
          sequence
        );
        inserted += 1;
      }
      if (inserted > 0) {
        catalogDb
          .prepare(
            "UPDATE local_thread_catalog_sync_state " +
              "SET observation_sequence = ? WHERE host_id = 'local'"
          )
          .run(sequence);
        catalogDb
          .prepare(
            "UPDATE local_thread_catalog_metadata " +
              "SET catalog_revision = catalog_revision + 1 WHERE id = 1"
          )
          .run();
      }
      return inserted;
    });
  } finally {
    catalogDb.close();
    appDb.close();
  }
}

function backupStamp() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

async function backupDatabases(databasePaths) {
  const uniquePaths = [...new Set(databasePaths.filter(Boolean))];
  if (uniquePaths.length === 0) return [];

  const baseStamp = backupStamp();
  let stamp = baseStamp;
  let attempt = 0;
  while (
    uniquePaths.some((dbPath) =>
      fs.existsSync(`${dbPath}.bak-repair-threads-${stamp}`)
    )
  ) {
    attempt += 1;
    stamp = `${baseStamp}-${attempt}`;
  }

  const backupPaths = uniquePaths.map(
    (dbPath) => `${dbPath}.bak-repair-threads-${stamp}`
  );
  for (const backupPath of backupPaths) {
    if (fs.existsSync(backupPath)) {
      throw new Error(`备份已存在，拒绝覆盖 / Backup already exists: ${backupPath}`);
    }
  }

  for (let index = 0; index < uniquePaths.length; index += 1) {
    await createDatabaseBackup(uniquePaths[index], backupPaths[index]);
  }
  console.log(
    `已创建 ${backupPaths.length} 个 SQLite 快照 / Created ${backupPaths.length} SQLite snapshot(s), stamp=${stamp}.`
  );
  return uniquePaths.map((dbPath, index) => ({
    backupPath: backupPaths[index],
    dbPath,
  }));
}

async function createDatabaseBackup(dbPath, backupPath) {
  const sourceDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (typeof sqlite.backup === "function") {
      await sqlite.backup(sourceDb, backupPath);
    } else {
      sourceDb.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    }
  } finally {
    sourceDb.close();
  }

  assertDatabaseIntegrity(backupPath);
}

function assertDatabaseIntegrity(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const results = db.prepare("PRAGMA integrity_check").all();
    if (
      results.length !== 1 ||
      String(Object.values(results[0])[0]).toLowerCase() !== "ok"
    ) {
      throw new Error(`SQLite 完整性校验失败 / integrity check failed: ${dbPath}`);
    }
  } finally {
    db.close();
  }
}

function removeSqliteSidecars(dbPath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
}

function restoreDatabasesFromBackups(backups) {
  const failures = [];
  for (let index = 0; index < backups.length; index += 1) {
    const { backupPath, dbPath } = backups[index];
    const temporaryPath = `${dbPath}.restore-repair-threads-${process.pid}-${index}.tmp`;
    try {
      fs.copyFileSync(backupPath, temporaryPath, fs.constants.COPYFILE_EXCL);
      assertDatabaseIntegrity(temporaryPath);
      removeSqliteSidecars(dbPath);
      fs.renameSync(temporaryPath, dbPath);
      removeSqliteSidecars(dbPath);
      assertDatabaseIntegrity(dbPath);
    } catch (error) {
      failures.push(new Error(`${dbPath}: ${error.message}`));
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "SQLite 快照补偿失败 / SQLite snapshot compensation failed"
    );
  }
  console.warn(
    `下游步骤失败，已从快照恢复 ${backups.length} 个数据库 / Downstream step failed; restored ${backups.length} database(s) from snapshots.`
  );
}

function compensateAndRethrow(backups, originalError) {
  try {
    restoreDatabasesFromBackups(backups);
  } catch (compensationError) {
    throw new AggregateError(
      [originalError, compensationError],
      "修复失败且快照补偿未完整完成 / Repair and snapshot compensation both failed"
    );
  }
  throw originalError;
}

function collectRestoreEvidence(sessionsDir) {
  const evidence = [];
  let legacyBackupCount = 0;
  for (const sessionPath of walkFiles(sessionsDir, (name) =>
    UUID_JSONL_RE.test(name)
  )) {
    try {
      const currentRecord = JSON.parse(readFirstLine(sessionPath));
      if (currentRecord.type !== "session_meta" || !currentRecord.payload?.id) {
        continue;
      }

      let backupPayload = null;
      const backupPath = `${sessionPath}${SESSION_META_BACKUP_SUFFIX}`;
      if (fs.existsSync(backupPath)) {
        try {
          const backupRecord = JSON.parse(readFirstLine(backupPath));
          if (
            backupRecord.type === "session_meta" &&
            backupRecord.payload?.id === currentRecord.payload.id
          ) {
            backupPayload = backupRecord.payload;
            legacyBackupCount += 1;
          }
        } catch {}
      }

      const currentPayload = currentRecord.payload;
      const targetPayload = isPollutedThread(currentPayload)
        ? backupPayload
        : currentPayload;
      if (!targetPayload) continue;
      evidence.push({
        id: currentPayload.id,
        sessionPath,
        backupPayload,
        targetPayload,
      });
    } catch {}
  }
  return { evidence, legacyBackupCount };
}

function isPollutedThread(row) {
  return (
    row?.source === "cli" &&
    row?.model_provider === "custom" &&
    row?.thread_source === "user"
  );
}

function metadataFieldsEqual(left, right) {
  for (const field of ["source", "model_provider", "thread_source"]) {
    if (Object.hasOwn(left, field) !== Object.hasOwn(right, field)) return false;
    if (Object.hasOwn(left, field) && !isDeepStrictEqual(left[field], right[field])) {
      return false;
    }
  }
  return true;
}

function inspectThreadRestorePlans(dbPath, evidence) {
  if (!fs.existsSync(dbPath)) return { plans: [] };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const info = tableInfo(db, "threads");
    const columns = new Set(info.map((column) => column.name));
    if (!["source", "model_provider", "thread_source"].every((name) => columns.has(name))) {
      return { plans: [] };
    }
    const threadSourceNotNull =
      info.find((column) => column.name === "thread_source")?.notnull === 1;
    const select = db.prepare(
      "SELECT id, source, model_provider, thread_source FROM threads WHERE id = ?"
    );
    const plans = [];
    for (const item of evidence) {
      const row = select.get(item.id);
      if (!isPollutedThread(row)) continue;
      const payload = item.targetPayload;
      const desired = {
        source: serializeSource(payload.source),
        modelProvider:
          payload.model_provider == null ? "" : String(payload.model_provider),
        threadSource:
          serializeOptionalValue(payload.thread_source) ??
          (threadSourceNotNull ? "" : null),
      };
      if (
        row.source === desired.source &&
        row.model_provider === desired.modelProvider &&
        row.thread_source === desired.threadSource
      ) {
        continue;
      }
      plans.push({ desired, item });
    }
    return { plans };
  } finally {
    db.close();
  }
}

function inspectCatalogRestorePlans(catalogPath, evidence) {
  if (!catalogPath) return [];
  const db = new DatabaseSync(catalogPath, { readOnly: true });
  try {
    if (
      !tableExists(db, "local_thread_catalog") ||
      !tableExists(db, "local_thread_catalog_metadata")
    ) {
      return [];
    }
    const select = db.prepare(
      "SELECT source_kind, model_provider FROM local_thread_catalog " +
        "WHERE host_id = 'local' AND thread_id = ?"
    );
    const plans = [];
    for (const item of evidence) {
      const row = select.get(item.id);
      if (row?.source_kind !== "cli" || row?.model_provider !== "custom") {
        continue;
      }
      const source = sourceCatalogValues(item.targetPayload.source);
      const modelProvider =
        item.targetPayload.model_provider == null
          ? ""
          : String(item.targetPayload.model_provider);
      if (row.source_kind === source.kind && row.model_provider === modelProvider) {
        continue;
      }
      plans.push({ item, modelProvider, sourceKind: source.kind });
    }
    return plans;
  } finally {
    db.close();
  }
}

async function restoreLegacyRepair(paths) {
  const { evidence, legacyBackupCount } = collectRestoreEvidence(paths.sessions);
  console.log(
    `发现 ${legacyBackupCount} 份旧版备份、${evidence.length} 份可用元数据证据 / Found ${legacyBackupCount} legacy backup(s) and ${evidence.length} usable metadata record(s).`
  );
  console.warn(
    "警告 / Warning: 旧版没有 SQLite 备份，无法自动恢复 sandbox_policy 或 approval_mode；本次恢复不会修改这些安全字段。"
  );

  const statePlans = [paths.appServer, paths.desktop]
    .map((dbPath) => ({ dbPath, ...inspectThreadRestorePlans(dbPath, evidence) }))
    .filter(({ plans }) => plans.length > 0);
  const catalogPath = findCatalogPath(paths.sqliteDir);
  const catalogPlans = inspectCatalogRestorePlans(catalogPath, evidence);
  const backups = await backupDatabases([
    ...statePlans.map(({ dbPath }) => dbPath),
    ...(catalogPlans.length > 0 ? [catalogPath] : []),
  ]);

  try {
    let stateRestored = 0;
    for (const { dbPath, plans } of statePlans) {
      const db = new DatabaseSync(dbPath);
      try {
        stateRestored += withImmediateTransaction(db, () => {
          const update = db.prepare(
            "UPDATE threads SET source = ?, model_provider = ?, thread_source = ? " +
              "WHERE id = ? AND source = 'cli' AND model_provider = 'custom' " +
              "AND thread_source = 'user'"
          );
          let restored = 0;
          for (const { desired, item } of plans) {
            restored += update.run(
              desired.source,
              desired.modelProvider,
              desired.threadSource,
              item.id
            ).changes;
          }
          return restored;
        });
      } finally {
        db.close();
      }
    }

    let catalogRestored = 0;
    if (catalogPlans.length > 0) {
      const db = new DatabaseSync(catalogPath);
      try {
        catalogRestored = withImmediateTransaction(db, () => {
          const update = db.prepare(
            "UPDATE local_thread_catalog SET source_kind = ?, model_provider = ? " +
              "WHERE host_id = 'local' AND thread_id = ? " +
              "AND source_kind = 'cli' AND model_provider = 'custom'"
          );
          let restored = 0;
          for (const plan of catalogPlans) {
            restored += update.run(
              plan.sourceKind,
              plan.modelProvider,
              plan.item.id
            ).changes;
          }
          if (restored > 0) {
            db.prepare(
              "UPDATE local_thread_catalog_metadata " +
                "SET catalog_revision = catalog_revision + 1 WHERE id = 1"
            ).run();
          }
          return restored;
        });
      } finally {
        db.close();
      }
    }

    let filesRestored = 0;
    let fileConflicts = 0;
    for (const item of evidence) {
      if (!item.backupPayload) continue;
      const result = restoreSessionHeader(item);
      if (result === "restored") filesRestored += 1;
      if (result === "conflict") fileConflicts += 1;
    }
    console.log(
      `恢复完成 / Restore complete: JSONL ${filesRestored}, conflicts ${fileConflicts}, state rows ${stateRestored}, catalog rows ${catalogRestored}.`
    );
  } catch (error) {
    compensateAndRethrow(backups, error);
  }
}

function restoreSessionHeader(item) {
  const current = JSON.parse(readFirstLine(item.sessionPath));
  if (current.type !== "session_meta" || current.payload?.id !== item.id) {
    throw new Error(
      `当前 session_meta 已变化，拒绝覆盖 / Current session_meta changed: ${item.sessionPath}`
    );
  }
  const backup = item.backupPayload;
  if (metadataFieldsEqual(current.payload, backup)) return "unchanged";
  if (!isPollutedThread(current.payload)) {
    console.warn(
      `跳过已另行修改的 session_meta / Skipped conflicting session_meta: ${item.sessionPath}`
    );
    return "conflict";
  }
  for (const field of ["source", "model_provider", "thread_source"]) {
    if (Object.hasOwn(backup, field)) {
      current.payload[field] = backup[field];
    } else {
      delete current.payload[field];
    }
  }

  const contents = fs.readFileSync(item.sessionPath);
  const newlineIndex = contents.indexOf(0x0a);
  const body = newlineIndex === -1 ? Buffer.alloc(0) : contents.subarray(newlineIndex + 1);
  const eol =
    newlineIndex > 0 && contents[newlineIndex - 1] === 0x0d ? "\r\n" : "\n";
  const header = Buffer.from(`${JSON.stringify(current)}${eol}`, "utf8");
  const restored = Buffer.concat([header, body]);
  if (restored.equals(contents)) return "unchanged";

  const temporaryPath = `${item.sessionPath}.repair-threads-${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, restored, { flag: "wx" });
  try {
    fs.renameSync(temporaryPath, item.sessionPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
  return "restored";
}
