#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';

// The Electron binary the MSIX manifest declares as its entry point.
const MAIN_EXECUTABLE_NAME = 'ChatGPT.exe';

const args = parseArgs(process.argv.slice(2));
// 26.1117 app-server initialize awaits the curated-plugin startup_sync
// fallback chain (~35s with the network blackholed) before logging readiness;
// keep the default window above that bounded upstream latency.
const timeoutMs = Number(args.timeoutMs ?? args['timeout-ms'] ?? 90_000);
const workRoot = path.resolve(
  args.workRoot ??
    args['work-root'] ??
    path.join(os.tmpdir(), `codex-offline-direct-launch-${Date.now()}`),
);

if (process.platform !== 'win32') {
  throw new Error('offline direct launch smoke is Windows-only.');
}

fs.rmSync(workRoot, { recursive: true, force: true });
fs.mkdirSync(workRoot, { recursive: true });

const portableRoot = resolvePortableRoot({
  portableRoot: args.portableRoot ?? args['portable-root'],
  portableZip: args.portableZip ?? args['portable-zip'],
  workRoot,
});
const appRoot = path.join(portableRoot, '_internal', 'app');
const appExe = path.join(appRoot, MAIN_EXECUTABLE_NAME);

if (!fs.existsSync(appExe)) {
  throw new Error(`${MAIN_EXECUTABLE_NAME} was not found under portable root: ${appExe}`);
}

const stdoutPath = path.join(workRoot, 'codex-stdout.log');
const stderrPath = path.join(workRoot, 'codex-stderr.log');
const resultPath = path.join(workRoot, 'result.json');
const userDataPath = path.join(workRoot, 'user-data');
const codexHome = path.join(workRoot, '.codex');
fs.mkdirSync(userDataPath, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });

const out = fs.openSync(stdoutPath, 'w');
const err = fs.openSync(stderrPath, 'w');
const launchArgs = [
  `--user-data-dir=${userDataPath}`,
  '--enable-logging',
  '--v=1',
  '--host-resolver-rules=MAP * 0.0.0.0,EXCLUDE localhost,EXCLUDE 127.0.0.1',
  '--proxy-server=http://127.0.0.1:9',
];

const appProcess = spawn(appExe, launchArgs, {
  cwd: appRoot,
  detached: false,
  env: {
    ...process.env,
    ALL_PROXY: 'http://127.0.0.1:9',
    CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE: '1',
    CODEX_ELECTRON_USER_DATA_PATH: userDataPath,
    CODEX_HOME: codexHome,
    CODEX_OFFLINE_PATCH_DEBUG: '1',
    ELECTRON_ENABLE_LOGGING: '1',
    ELECTRON_ENABLE_STACK_DUMPING: '1',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: 'localhost,127.0.0.1',
  },
  stdio: ['ignore', out, err],
  windowsHide: false,
});

let exitCode = null;
let exitSignal = null;
let spawnError = null;
appProcess.once('exit', (code, signal) => {
  exitCode = code;
  exitSignal = signal;
});
appProcess.once('error', (error) => {
  spawnError = error;
});

let stdout = '';
let stderr = '';
let sawAppServerReady = false;
let sawWindowReady = false;
let survivedUntilTimeout = false;
const startedAt = Date.now();

// 26.1117 stopped writing the connection's "Codex CLI initialized" log to the
// captured stdout (main-process logs no longer forward there), but the
// renderer-side "Loading local plugin inventory" query only fires once the
// local app-server connection is initialized — the same readiness point.
const APP_SERVER_READY_MARKERS = [
  'Codex CLI initialized',
  'Loading local plugin inventory',
];
const sawAppServerReadyIn = (text) =>
  APP_SERVER_READY_MARKERS.some((marker) => text.includes(marker));

try {
  while (Date.now() - startedAt < timeoutMs) {
    await delay(500);
    stdout = readFileIfExists(stdoutPath);
    stderr = readFileIfExists(stderrPath);
    sawAppServerReady ||= sawAppServerReadyIn(stdout);
    sawWindowReady ||=
      stdout.includes('window ready-to-show') ||
      stdout.includes('window main frame finished load');

    if (spawnError) break;
    if (exitCode !== null || exitSignal !== null) break;
  }
  survivedUntilTimeout = spawnError == null && exitCode === null && exitSignal === null;
} finally {
  if (survivedUntilTimeout) {
    killProcessTree(appProcess.pid);
  }
  fs.closeSync(out);
  fs.closeSync(err);
}

stdout = readFileIfExists(stdoutPath);
stderr = readFileIfExists(stderrPath);
sawAppServerReady ||= sawAppServerReadyIn(stdout);
sawWindowReady ||=
  stdout.includes('window ready-to-show') ||
  stdout.includes('window main frame finished load');

const pass =
  spawnError == null &&
  survivedUntilTimeout &&
  sawAppServerReady &&
  sawWindowReady;
const result = {
  pass,
  reason: pass
    ? 'direct-exe-survived-offline-launch'
    : spawnError
      ? `spawn-error: ${spawnError.message}`
      : exitCode !== null || exitSignal !== null
        ? `process-exited-before-timeout: code=${exitCode} signal=${exitSignal}`
        : !sawAppServerReady
          ? 'missing-app-server-ready-log'
          : 'missing-window-ready-log',
  timeoutMs,
  portableRoot,
  appExe,
  workRoot,
  stdoutPath,
  stderrPath,
  sawAppServerReady,
  sawWindowReady,
  survivedUntilTimeout,
  exitCode,
  exitSignal,
  stdoutTail: tail(stdout),
  stderrTail: tail(stderr),
};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify(result, null, 2));
process.exit(pass ? 0 : 1);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
    parsed[key] = value;
  }
  return parsed;
}

function resolvePortableRoot({ portableRoot, portableZip, workRoot }) {
  if (portableRoot) {
    return normalizePortableRoot(path.resolve(portableRoot));
  }

  if (!portableZip) {
    throw new Error('Provide --portable-root or --portable-zip.');
  }

  const extractRoot = path.join(workRoot, 'portable');
  fs.mkdirSync(extractRoot, { recursive: true });
  execFileSync('tar.exe', ['-xf', path.resolve(portableZip), '-C', extractRoot], {
    stdio: 'pipe',
  });
  return normalizePortableRoot(extractRoot);
}

function normalizePortableRoot(root) {
  if (fs.existsSync(path.join(root, '_internal', 'app', MAIN_EXECUTABLE_NAME))) {
    return root;
  }

  const children = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name));
  if (children.length === 1 && fs.existsSync(path.join(children[0], '_internal', 'app', MAIN_EXECUTABLE_NAME))) {
    return children[0];
  }

  throw new Error(`Could not resolve portable root under: ${root}`);
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function tail(value, maxChars = 4000) {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Process may already be gone.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
