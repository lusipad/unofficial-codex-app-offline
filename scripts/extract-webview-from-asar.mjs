#!/usr/bin/env node

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

const MANIFEST_SCHEMA_VERSION = 3;

const { values } = parseArgs({
  options: {
    asar: { type: "string" },
    destination: { type: "string" },
    manifest: { type: "string" },
    "source-app": { type: "string" },
    version: { type: "string" },
  },
});

function fail(message) {
  console.error(`[extract-webview-from-asar] ${message}`);
  process.exit(1);
}

function requireArg(name) {
  const value = values[name];
  if (!value) fail(`--${name} is required.`);
  return path.resolve(value);
}

function isUnsafeDestination(destination) {
  const resolved = path.resolve(destination);
  return (
    !resolved ||
    resolved === path.parse(resolved).root ||
    path.basename(resolved).toLowerCase() !== "webview"
  );
}

function stripArchiveRoot(entry) {
  return String(entry).replace(/^[\\/]+/, "");
}

function normalizeArchiveEntry(entry) {
  return stripArchiveRoot(entry).replace(/\\/g, "/");
}

function resolveDestination(root, relativeEntryPath) {
  if (
    !relativeEntryPath ||
    path.isAbsolute(relativeEntryPath) ||
    path.win32.isAbsolute(relativeEntryPath) ||
    path.posix.isAbsolute(relativeEntryPath) ||
    relativeEntryPath.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`Unsafe webview archive entry: ${relativeEntryPath}`);
  }

  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, relativeEntryPath);
  const relativeToRoot = path.relative(resolvedRoot, destination);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Webview archive entry escapes destination: ${relativeEntryPath}`);
  }
  return destination;
}

function writeFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

function extractPackageJson(asarPath) {
  try {
    return JSON.parse(asar.extractFile(asarPath, "package.json").toString("utf8"));
  } catch {
    return {};
  }
}

function ensureWebviewComplete(webviewDir) {
  const indexPath = path.join(webviewDir, "index.html");
  const assetsDir = path.join(webviewDir, "assets");
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Extracted webview is missing index.html: ${indexPath}`);
  }
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Extracted webview is missing assets directory: ${assetsDir}`);
  }
  const indexBundles = fs
    .readdirSync(assetsDir)
    .filter((entry) => /^index-[^\\/]+\.js$/.test(entry));
  if (indexBundles.length === 0) {
    throw new Error(`Extracted webview is missing assets/index-*.js in ${assetsDir}`);
  }
}

const asarPath = requireArg("asar");
const webviewDestDir = requireArg("destination");
const manifestPath = values.manifest
  ? path.resolve(values.manifest)
  : path.join(path.dirname(webviewDestDir), "manifest.json");

if (!fs.existsSync(asarPath)) fail(`app.asar was not found: ${asarPath}`);
if (isUnsafeDestination(webviewDestDir)) {
  fail(`Refusing to write webview to unsafe destination: ${webviewDestDir}`);
}

fs.rmSync(webviewDestDir, { recursive: true, force: true });
fs.mkdirSync(webviewDestDir, { recursive: true });

let fileCount = 0;
let byteCount = 0;
for (const rawEntry of asar.listPackage(asarPath)) {
  const archiveEntry = stripArchiveRoot(rawEntry);
  const entry = normalizeArchiveEntry(rawEntry);
  if (!entry.startsWith("webview/")) continue;

  const relativeEntryPath = entry.slice("webview/".length);
  if (!relativeEntryPath) continue;

  const stat = asar.statFile(asarPath, archiveEntry);
  if (stat && stat.files) continue;

  const data = asar.extractFile(asarPath, archiveEntry);
  writeFile(resolveDestination(webviewDestDir, relativeEntryPath), data);
  fileCount += 1;
  byteCount += data.length;
}

ensureWebviewComplete(webviewDestDir);

const resourcesPath = path.dirname(asarPath);
const sourceAppPath = values["source-app"]
  ? path.resolve(values["source-app"])
  : path.dirname(resourcesPath);
const packageInfo = extractPackageJson(asarPath);
const asarStat = fs.statSync(asarPath);
const manifest = {
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  sourceAppPath,
  sourceResourcesPath: resourcesPath,
  sourceAsarPath: asarPath,
  sourceCodexBinaryPath: path.join(resourcesPath, process.platform === "win32" ? "codex.exe" : "codex"),
  sourceLayoutKind: "preextracted-web-package",
  sourcePlatformHint: process.platform,
  bundleIdentifier:
    packageInfo?.build?.appId ||
    packageInfo?.appId ||
    packageInfo?.name ||
    "openai-codex-electron",
  version: values.version || String(packageInfo.version || "unknown"),
  build: String(packageInfo.buildNumber || packageInfo.buildVersion || `${asarStat.size}-${Math.trunc(asarStat.mtimeMs)}`),
  sourceAsarSize: asarStat.size,
  sourceAsarMtimeMs: Math.trunc(asarStat.mtimeMs),
  processedAt: new Date().toISOString(),
};

writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  JSON.stringify({
    webviewDir: webviewDestDir,
    manifestPath,
    fileCount,
    byteCount,
  })
);
