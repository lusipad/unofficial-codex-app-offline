#!/usr/bin/env node
/**
 * patch-app-asar.mjs
 *
 * Patches app/resources/app.asar after it has been extracted from the MSIX so
 * that features which are gated on "running as a Windows Store app" continue to
 * work when Codex is launched as a standalone exe.
 *
 * Patches applied:
 *
 * 1. process.windowsStore = true
 *    Electron exposes this flag only inside MSIX containers.  Codex checks it
 *    for telemetry and build-type reporting.  We inject it at the top of the
 *    main-process entry point.
 *
 * 2. Implement "show-settings" and "open-config-toml" IPC handlers
 *    The Electron build throws "not implemented" for these messages.  We
 *    replace the throw with real handlers: show-settings reloads the window
 *    with the appropriate initialRoute, and open-config-toml opens the TOML
 *    config file in the system editor.  Three variable-naming variants are
 *    handled (V1: message=t/wc=e, V2: message=r/wc=n, V3: message=i/wc=r).
 *
 * 3. Fix enable_i18n default value inconsistency
 *    The settings page defaults enable_i18n to true (so the language selector
 *    is visible), but the i18n provider defaults it to false (so translations
 *    never load).  We unify the default to true.
 *
 * 4. Enable settings page entry for offline builds
 *    The settings menu item is gated behind a Statsig experiment that
 *    defaults to off when there is no network.  We bypass the gate so the
 *    entry is always visible in offline builds.  Older builds use the pattern
 *    `4166894088`...;let X=func(Y); newer builds call $f(`4166894088`)
 *    directly.
 *
 * 5. Enable Automations entry for offline builds
 *    The Automations sidebar item is gated behind Statsig experiment
 *    3075919032.  In offline mode Statsig cannot reach its servers, so the
 *    gate defaults to false and the entry is hidden even though all
 *    Automations UI is fully bundled.  We bypass the gate so the sidebar
 *    item is always visible in offline builds.  Newer builds use the
 *    $f(`3075919032`) inline call pattern.
 *
 * 6. Enable pull requests sidebar entry for offline builds
 *    The pull requests nav link is also gated behind a Statsig experiment in
 *    newer builds.  We bypass that gate so the offline build does not hide
 *    the bundled route when Statsig cannot resolve experiments.  Older builds
 *    embed the gate check inline; ≥ 26.429.x extract it to a standalone hook
 *    (function name(){return $f(`3789238711`)}) that we replace with !0.
 *
 * 7. Enable scratchpad sidebar entry for offline builds
 *    Scratchpad is bundled in newer builds but hidden behind a separate
 *    Statsig gate.  We bypass that gate so the offline build exposes the
 *    same route and sidebar nav entry as the official package.
 *
 * 16. Enable slash commands menu for offline builds
 *    The slash command menu in the composer is gated behind Statsig
 *    experiment 1609556872.  In offline mode Statsig cannot reach its
 *    servers, so the menu never opens even though the bundled app contains
 *    the full slash command UI and built-in commands.  We bypass the gate
 *    so typing `/` shows the same menu as the official package.
 *
 * 35. Enable Fast mode speed selector for offline builds
 *    The "Fast / Standard" speed selector button in the model picker is
 *    gated behind two run-time conditions inside the settings chunk:
 *    (1) statsig_default_enable_features.fast_mode === true (dynamic
 *    config that defaults to off when Statsig is unreachable) and
 *    (2) authMethod === "chatgpt".  We replace the compound gate
 *    expression `X?.fast_mode===!0&&authCheck(arg)` with !0 so the
 *    button is always visible in offline builds.
 *
 * 8. Normalize Windows automation cwd paths
 *    The packaged Automations UI can persist selected project paths in
 *    `\\?\C:\...` form on Windows.  Automation execution later compares that
 *    string against per-project config entries that use normal drive-letter
 *    paths, so approvals/sandbox settings fail to match and runs fall back to
 *    the wrong permissions.  We normalize those paths during execution, and
 *    strip the namespace prefix when the automation dialog saves selections.
 *
 * 9. Force offline Windows app-server launches onto the unelevated sandbox
 *    backend
 *    The packaged Windows build still reads the user's local ~/.codex
 *    config.toml, but `windows.sandbox = "elevated"` fails during the helper
 *    ACL refresh step for portable/offline runs.  We keep using the user's
 *    config and only inject a CLI override for the desktop app's internal
 *    `codex app-server` launch.
 *
 * Usage:
 *   node scripts/patch-app-asar.mjs --app-dir <path-to-app-dir>
 *
 * <path-to-app-dir> is the directory that contains Codex.exe (i.e. the "app"
 * subdirectory of the extracted source package).  The script expects to find
 * resources/app.asar inside it.
 *
 * Exit codes:
 *   0  Patch applied (or already applied, idempotent).
 *   1  Fatal error (asar not found, parse failure, …).
 */

import { createRequire } from 'module';
import { parseArgs } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

// ── CLI args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
  },
  strict: false,
});

const appDir = args['app-dir'];
if (!appDir) {
  console.error('Usage: node patch-app-asar.mjs --app-dir <path>');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[patch-app-asar] ${msg}`);
}

function warn(msg) {
  console.warn(`[patch-app-asar] WARNING: ${msg}`);
}

/** Return the main-process entry file listed in an asar's package.json. */
function resolveMainEntry(extractDir) {
  const pkgPath = path.join(extractDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const main = pkg.main || 'index.js';
  const candidates = [
    path.join(extractDir, main),
    path.join(extractDir, main.replace(/\.js$/, ''), 'index.js'),
  ];
  return candidates.find(fs.existsSync) ?? null;
}

const PATCH_MARKER = '/* codex-offline:windowsStore-patch */';
// Suppress EPIPE errors on stdout/stderr that surface as uncaught
// exceptions when the Electron app writes to a console pipe that has
// already been closed (e.g. the CMD window that launched Codex exits
// before the renderer finishes its cleanup logging).
const EPIPE_GUARD =
  'function _epipeGuard(s){' +
    'var ow=s.write;' +
    's.write=function(){' +
      'try{return ow.apply(s,arguments)}' +
      'catch(e){if(e.code!=="EPIPE")throw e}' +
    '}' +
  '}' +
  '_epipeGuard(process.stdout);_epipeGuard(process.stderr);\n';
const PATCH_SNIPPET = `${PATCH_MARKER}\nif(!process.windowsStore){process.windowsStore=true;}\n${EPIPE_GUARD}`;

/** Return true if the file already contains our patch marker. */
function isAlreadyPatched(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.includes(PATCH_MARKER);
}

/** Prepend the patch snippet to a JS file. */
function patchFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  fs.writeFileSync(filePath, PATCH_SNIPPET + original, 'utf8');
}

function listJavaScriptFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];

  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }

  return files;
}

function matchesPattern(content, pattern) {
  if (typeof pattern === 'string') {
    return content.includes(pattern);
  }

  pattern.lastIndex = 0;
  return pattern.test(content);
}

function countOccurrences(content, needle) {
  if (!needle) return 0;

  let count = 0;
  let start = 0;
  while (true) {
    const index = content.indexOf(needle, start);
    if (index === -1) return count;
    count += 1;
    start = index + needle.length;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const asarPath = path.resolve(appDir, 'resources', 'app.asar');

if (!fs.existsSync(asarPath)) {
  console.error(`[patch-app-asar] app.asar not found: ${asarPath}`);
  process.exit(1);
}

log(`Patching: ${asarPath}`);

// Extract to a temp directory.
const tmpDir = path.join(os.tmpdir(), `codex-asar-patch-${crypto.randomBytes(6).toString('hex')}`);
fs.mkdirSync(tmpDir, { recursive: true });

try {
  log('Extracting asar…');
  await asar.extractAll(asarPath, tmpDir);

  // Find main entry point.
  const mainEntry = resolveMainEntry(tmpDir);
  if (!mainEntry) {
    warn('Could not locate the main-process entry point. Patch skipped.');
    process.exit(0);
  }

  log(`Main entry: ${path.relative(tmpDir, mainEntry)}`);

  if (isAlreadyPatched(mainEntry)) {
    log('Main entry already patched.');
  } else {
    patchFile(mainEntry);
    log('windowsStore patch applied.');
  }

  // ── Patch 2: implement settings-related IPC handlers ──────────────────
  //
  // The Electron build groups several VS Code-only message types into a
  // single case block that throws "not implemented in Electron".  We break
  // out the user-facing ones and provide real implementations:
  //
  //   show-settings         → reload with ?initialRoute=/settings/<section>
  //   open-extension-settings → same, route to /settings/general-settings
  //   open-keyboard-shortcuts → same, route to /settings/general-settings
  //   open-config-toml      → open ~/.codex/config.toml via shell.openPath
  //
  // The remaining cases (open-vscode-command, etc.) keep throwing.

  const NOT_IMPLEMENTED_NEEDLE_V1 =
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:' +
    'case`open-extension-settings`:case`open-keyboard-shortcuts`:' +
    'case`open-config-toml`:case`show-settings`:case`install-wsl`:' +
    'throw Error(`"${t.type}" is not implemented in Electron.`)';
  const NOT_IMPLEMENTED_NEEDLE_V2 =
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:' +
    'case`open-extension-settings`:case`open-keyboard-shortcuts`:' +
    'case`open-config-toml`:case`show-settings`:case`install-wsl`:' +
    'throw Error(`"${r.type}" is not implemented in Electron.`)';
  // V3: message variable renamed to `i`, webContents to `r`, electron module to `n`
  // (seen in builds ≥ 26.422.8496.0)
  const NOT_IMPLEMENTED_NEEDLE_V3 =
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:' +
    'case`open-extension-settings`:case`open-keyboard-shortcuts`:' +
    'case`open-config-toml`:case`show-settings`:case`install-wsl`:' +
    'throw Error(`"${i.type}" is not implemented in Electron.`)';

  // Helper: reload the renderer at a given settings route.
  const NAV_HELPER =
    'function _nav(e,r){' +
      'let _u=new URL(e.getURL());' +
      '_u.searchParams.set("initialRoute",r);' +
      'e.loadURL(_u.toString())}';

  const SETTINGS_REPLACEMENT_V1 =
    // show-settings: reload the renderer with the desired settings route
    'case`show-settings`:{' +
      NAV_HELPER + ';' +
      '_nav(e,"/settings/"+(t.section||"agent"));break}' +
    // open-extension-settings: route to general settings
    'case`open-extension-settings`:{' +
      NAV_HELPER + ';' +
      '_nav(e,"/settings/general-settings");break}' +
    // open-keyboard-shortcuts: route to general settings (no dedicated page)
    'case`open-keyboard-shortcuts`:{' +
      NAV_HELPER + ';' +
      '_nav(e,"/settings/general-settings");break}' +
    // open-config-toml: open the file in the system default editor
    'case`open-config-toml`:{' +
      'let _cfg=require("path").join(require("os").homedir(),".codex","config.toml");' +
      'require("fs").mkdirSync(require("path").dirname(_cfg),{recursive:true});' +
      'if(!require("fs").existsSync(_cfg))require("fs").writeFileSync(_cfg,"# Codex config\\n",{encoding:"utf8"});' +
      'm.shell.openPath(_cfg);break}' +
    // keep throwing for the rest
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:' +
    'case`install-wsl`:' +
    'throw Error(`"${t.type}" is not implemented in Electron.`)';
  const SETTINGS_REPLACEMENT_V2 =
    'case`show-settings`:{' +
      'let e=t.BrowserWindow.fromWebContents(n);' +
      'if(e){let i=new URL(e.getURL());' +
      'i.searchParams.set("initialRoute","/settings/"+(r.section||"agent"));' +
      'e.loadURL(i.toString())}' +
      'break}' +
    'case`open-extension-settings`:{' +
      'let e=t.BrowserWindow.fromWebContents(n);' +
      'if(e){let i=new URL(e.getURL());' +
      'i.searchParams.set("initialRoute","/settings/general-settings");' +
      'e.loadURL(i.toString())}' +
      'break}' +
    'case`open-keyboard-shortcuts`:{' +
      'let e=t.BrowserWindow.fromWebContents(n);' +
      'if(e){let i=new URL(e.getURL());' +
      'i.searchParams.set("initialRoute","/settings/general-settings");' +
      'e.loadURL(i.toString())}' +
      'break}' +
    'case`open-config-toml`:{' +
      'let e=require("path").join(require("os").homedir(),".codex","config.toml");' +
      'require("fs").mkdirSync(require("path").dirname(e),{recursive:true});' +
      'if(!require("fs").existsSync(e))require("fs").writeFileSync(e,"# Codex config\\n",{encoding:"utf8"});' +
      't.shell.openPath(e);break}' +
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:' +
    'case`install-wsl`:' +
    'throw Error(`"${r.type}" is not implemented in Electron.`)';
  // V3: electron=n, webContents=r, message=i
  const SETTINGS_REPLACEMENT_V3 =
    'case`show-settings`:{' +
      'let e=n.BrowserWindow.fromWebContents(r);' +
      'if(e){let t=new URL(e.getURL());' +
      't.searchParams.set("initialRoute","/settings/"+(i.section||"agent"));' +
      'e.loadURL(t.toString())}' +
      'break}' +
    'case`open-extension-settings`:{' +
      'let e=n.BrowserWindow.fromWebContents(r);' +
      'if(e){let t=new URL(e.getURL());' +
      't.searchParams.set("initialRoute","/settings/general-settings");' +
      'e.loadURL(t.toString())}' +
      'break}' +
    'case`open-keyboard-shortcuts`:{' +
      'let e=n.BrowserWindow.fromWebContents(r);' +
      'if(e){let t=new URL(e.getURL());' +
      't.searchParams.set("initialRoute","/settings/general-settings");' +
      'e.loadURL(t.toString())}' +
      'break}' +
    'case`open-config-toml`:{' +
      'let e=require("path").join(require("os").homedir(),".codex","config.toml");' +
      'require("fs").mkdirSync(require("path").dirname(e),{recursive:true});' +
      'if(!require("fs").existsSync(e))require("fs").writeFileSync(e,"# Codex config\\n",{encoding:"utf8"});' +
      'n.shell.openPath(e);break}' +
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:' +
    'case`install-wsl`:' +
    'throw Error(`"${i.type}" is not implemented in Electron.`)';
  // Newer upstream builds already ship these handlers. Recognize that shape so
  // we do not warn just because the old "not implemented" needle disappeared.
  const SETTINGS_ALREADY_IMPLEMENTED_PATTERNS = [
    'case`show-settings`:{let ',
    'searchParams.set("initialRoute","/settings/"+(',
    'case`open-extension-settings`:{let ',
    'case`open-keyboard-shortcuts`:{let ',
    'searchParams.set("initialRoute","/settings/general-settings")',
    'case`open-config-toml`:{let ',
    '.shell.openPath(',
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:case`install-wsl`:throw Error(`',
  ];
  const AUTOMATION_CWD_NORMALIZER_INLINE =
    'e=>typeof e==`string`&&e.startsWith(`\\\\\\\\?\\\\`)&&/^[A-Za-z]:/.test(e.slice(4))?e.slice(4):e';
  const AUTOMATION_RUNTIME_CWD_RE =
    /let (\w+)=(\w+)\.cwds;if\(\1\.length===0\)/;
  const AUTOMATION_RUNTIME_CWD_REPLACEMENT =
    `let $1=$2.cwds.map(${AUTOMATION_CWD_NORMALIZER_INLINE});if($1.length===0)`;
  const AUTOMATION_RUNTIME_CWD_PATCH_MARKER =
    `.cwds.map(${AUTOMATION_CWD_NORMALIZER_INLINE})`;
  const APP_SERVER_SANDBOX_OVERRIDE_NEEDLE =
    'args:[`app-server`,`--analytics-default-enabled`]';
  const APP_SERVER_SANDBOX_OVERRIDE_REPLACEMENT =
    'args:[`-c`,`windows.sandbox=\'unelevated\'`,`app-server`,`--analytics-default-enabled`]';

  const mainBuildDir = path.join(tmpDir, '.vite', 'build');
  const mainBundleFiles = Array.from(new Set([
    mainEntry,
    ...listJavaScriptFiles(mainBuildDir),
  ]));
  const settingsPatchedFiles = [];
  const settingsAlreadyImplementedFiles = [];

  for (const filePath of mainBundleFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (SETTINGS_ALREADY_IMPLEMENTED_PATTERNS.every((pattern) => content.includes(pattern))) {
      settingsAlreadyImplementedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    let patchedContent = null;

    if (content.includes(NOT_IMPLEMENTED_NEEDLE_V1)) {
      patchedContent = content.replace(
        NOT_IMPLEMENTED_NEEDLE_V1,
        SETTINGS_REPLACEMENT_V1,
      );
    } else if (content.includes(NOT_IMPLEMENTED_NEEDLE_V2)) {
      patchedContent = content.replace(
        NOT_IMPLEMENTED_NEEDLE_V2,
        SETTINGS_REPLACEMENT_V2,
      );
    } else if (content.includes(NOT_IMPLEMENTED_NEEDLE_V3)) {
      patchedContent = content.replace(
        NOT_IMPLEMENTED_NEEDLE_V3,
        SETTINGS_REPLACEMENT_V3,
      );
    }

    if (patchedContent == null) continue;

    fs.writeFileSync(filePath, patchedContent, 'utf8');
    settingsPatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (settingsPatchedFiles.length > 0) {
    log(`Settings IPC handlers patched in ${settingsPatchedFiles.join(', ')}.`);
  }
  if (settingsAlreadyImplementedFiles.length > 0) {
    log(
      `Settings IPC handlers already implemented in ` +
      `${settingsAlreadyImplementedFiles.join(', ')}.`,
    );
  }
  if (settingsPatchedFiles.length === 0 && settingsAlreadyImplementedFiles.length === 0) {
    warn('Could not locate the "not implemented" throw for show-settings. ' +
         'Settings patch skipped (the app version may have changed).');
  }

  // ── Patch 8: Normalize Windows automation cwd paths at runtime ───────
  //
  // Automation configs can be saved with a Windows namespace prefix
  // (`\\?\C:\...`).  The runtime later uses the raw cwd string to resolve the
  // matching project configuration, so a namespaced path misses the normal
  // `C:\...` project key and picks the wrong sandbox/approval settings.

  const automationRuntimePatchedFiles = [];
  const automationRuntimeUnpatchedFiles = [];

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(AUTOMATION_RUNTIME_CWD_PATCH_MARKER)) {
      automationRuntimePatchedFiles.push(path.relative(tmpDir, filePath));
    } else if (AUTOMATION_RUNTIME_CWD_RE.test(content)) {
      const patchedContent = content.replace(
        AUTOMATION_RUNTIME_CWD_RE,
        AUTOMATION_RUNTIME_CWD_REPLACEMENT,
      );
      if (patchedContent !== content) {
        content = patchedContent;
        fs.writeFileSync(filePath, content, 'utf8');
        automationRuntimePatchedFiles.push(path.relative(tmpDir, filePath));
      }
    }

    if (!content.includes(AUTOMATION_RUNTIME_CWD_PATCH_MARKER) &&
        AUTOMATION_RUNTIME_CWD_RE.test(content)) {
      automationRuntimeUnpatchedFiles.push(path.relative(tmpDir, filePath));
    }
  }

  if (automationRuntimeUnpatchedFiles.length > 0) {
    throw new Error(
      'Known automation runtime cwd handling remained unpatched in ' +
      `${automationRuntimeUnpatchedFiles.join(', ')}.`,
    );
  }

  if (automationRuntimePatchedFiles.length > 0) {
    log('Automation runtime cwd normalization patched in ' +
        `${automationRuntimePatchedFiles.join(', ')}.`);
  } else {
    warn('Could not locate automation runtime cwd handling. ' +
         'Automation permission patch skipped (the app version may have changed).');
  }

  // ── Patch 9: Force packaged app-server launches onto unelevated sandbox ─
  //
  // Keep loading the user's ~/.codex config, but override just the
  // windows.sandbox backend for the desktop app's internal app-server launch.

  const appServerSandboxOverridePatchedFiles = [];
  let appServerSandboxOverrideCount = 0;
  let appServerSandboxOverrideDetected = 0;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    const alreadyPatchedCount = countOccurrences(
      content,
      APP_SERVER_SANDBOX_OVERRIDE_REPLACEMENT,
    );
    if (alreadyPatchedCount > 0) {
      appServerSandboxOverrideDetected += alreadyPatchedCount;
      appServerSandboxOverridePatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    const needleCount = countOccurrences(content, APP_SERVER_SANDBOX_OVERRIDE_NEEDLE);
    if (needleCount === 0) continue;

    content = content.split(APP_SERVER_SANDBOX_OVERRIDE_NEEDLE)
      .join(APP_SERVER_SANDBOX_OVERRIDE_REPLACEMENT);
    fs.writeFileSync(filePath, content, 'utf8');
    appServerSandboxOverrideCount += needleCount;
    appServerSandboxOverrideDetected += needleCount;
    appServerSandboxOverridePatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (appServerSandboxOverrideDetected === 0) {
    throw new Error(
      'Could not locate the desktop app-server launch arguments to force ' +
      'windows.sandbox=\'unelevated\'.',
    );
  }

  if (appServerSandboxOverrideCount > 0) {
    log('Desktop app-server sandbox override patched in ' +
        `${appServerSandboxOverridePatchedFiles.join(', ')}.`);
  } else {
    log('Desktop app-server sandbox override already patched.');
  }

  // ── Patch 3: Fix enable_i18n default value inconsistency ─────────────
  //
  // The general-settings component checks enable_i18n with default true,
  // so the language selector is visible and usable.  However the i18n
  // provider that actually loads translations defaults the same flag to
  // false, meaning selected translations never load.  Unify to true so
  // language selection works end-to-end.
  //
  // ≥ 26.422.8496.0: the upstream code was fixed and now defaults to !0,
  // so the old !1 pattern no longer exists and no patch is needed.

  const I18N_NEEDLE = '.get(`enable_i18n`,!1)';
  const I18N_REPLACEMENT = '.get(`enable_i18n`,!0)';
  // Marker present when the upstream code already has the correct default.
  const I18N_ALREADY_CORRECT_MARKER = '.get(`enable_i18n`,!0)';

  // ── Patch 4: Enable settings page entry for offline builds ─────────
  //
  // The settings menu item in the profile dropdown is gated behind
  // Statsig experiment 4166894088.  In offline mode Statsig cannot reach
  // its servers, so the gate defaults to false and the entry is hidden
  // even though the settings pages are fully bundled.  We replace the
  // gate check result with `true` so the entry is always visible.
  const SETTINGS_GATE_ID_MARKER = '`4166894088`';

  const SETTINGS_GATE_RE =
    /(`4166894088`[^;]*;let\s+)(\w+)\s*=\s*\w+\((\w+)\)/;
  // ≥ 26.422.8496.0: gate is called inline with a minified helper such as
  // $f(...) or Qf(...), with no surrounding let-statement pattern.
  const SETTINGS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`4166894088`\)/;

  // ── Patch 5: Enable Automations sidebar entry for offline builds ────
  //
  // The Automations nav item in the sidebar is gated behind Statsig
  // experiment 3075919032.  Offline builds cannot reach Statsig servers,
  // so the gate defaults to false and the Automations entry disappears
  // even though the full Automations UI is bundled.  We bypass the gate
  // so the sidebar item is always visible in offline builds.
  const AUTOMATIONS_GATE_ID_MARKER = '`3075919032`';

  const AUTOMATIONS_GATE_RE =
    /(`3075919032`[^;]*;let\s+)(\w+)\s*=\s*\w+\((\w+)\)/;
  // [$\w]+ instead of \w+ so that minified names like $f are also matched.
  const AUTOMATIONS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`3075919032`\)/;
  const PULL_REQUESTS_GATE_ID_MARKER = '`3789238711`';
  const PULL_REQUESTS_GATE_RE =
    /(`3789238711`[^;]*;let\s+)(\w+)\s*=\s*\w+\((\w+)\)/;
  const PULL_REQUESTS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`3789238711`\)/;
  // ≥ 26.429.x: sidebar gate extracted to a standalone hook that directly
  // returns the gate result, matching the pattern of other recently-extracted
  // gate hooks (e.g. background-subagents, chronicle, artifact-electron).
  const PULL_REQUESTS_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`3789238711`\)\}/;
  const PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{let\s+e=\(0,Q\.c\)\(3\),t;if\(e\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(t=`3789238711`,e\[0\]=t\):t=e\[0\],!xu\(t\)\)\{let\s+t;return\s+e\[1\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(t=\(0,\$\.jsx\)\(b,\{to:`\/`,replace:!0\}\),e\[1\]=t\):t=e\[1\],t\}let\s+n;return\s+e\[2\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(n=\(0,\$\.jsx\)\((\w+),\{\}\),e\[2\]=n\):n=e\[2\],n\}/;
  // ≥ 26.422.8496.0: 2-slot memo cache and direct $f() call.
  const PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V2 =
    /function\s+(\w+)\(\)\{let\s+\w+=\(0,Q\.c\)\(2\);if\(![$\w]+\(`3789238711`\)\)\{let\s+\w+;return\s+\w+\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=\(0,\$\.jsx\)\(\w+,\{to:`\/`,replace:!0\}\),\w+\[0\]=\w+\):\w+=\w+\[0\],\w+\}let\s+\w+;return\s+\w+\[1\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=\(0,\$\.jsx\)\((\w+),\{\}\),\w+\[1\]=\w+\):\w+=\w+\[1\],\w+\}/;
  const SCRATCHPAD_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{let\s+\w+=\(0,\w+\.c\)\(1\),\w+;return\s+\w+\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=`2302560359`,\w+\[0\]=\w+\):\w+=\w+\[0\],\w+\(\w+\)\}/;
  // ≥ 26.422.8496.0: gate function reduced to a direct call, possibly in a
  // separate chunk (e.g. use-navigate-to-local-conversation-*.js).
  const SCRATCHPAD_GATE_FUNCTION_RE_V2 =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`2302560359`\)\}/;

  // ── Patch 10: Enable Avatar Overlay for offline builds ─────────────────
  //
  // The avatar/mascot overlay component is wrapped in a gate function that
  // returns an empty React Fragment when gate 2679188970 is false.  Bypass
  // the gate so the overlay is always rendered in offline builds.
  const AVATAR_OVERLAY_GATE_ID_MARKER = '`2679188970`';
  const AVATAR_OVERLAY_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{let\s+\w+=\(0,Q\.c\)\(2\);if\(![$\w]+\(`2679188970`\)\)\{let\s+\w+;return\s+\w+\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=\(0,\$\.jsx\)\(\$\.Fragment,\{\}\),\w+\[0\]=\w+\):\w+=\w+\[0\],\w+\}let\s+\w+;return\s+\w+\[1\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=\(0,\$\.jsx\)\((\w+),\{\}\),\w+\[1\]=\w+\):\w+=\w+\[1\],\w+\}/;
  // ≥ 26.429.x: gate extracted to a standalone hook that directly returns the
  // gate result (same pattern seen for background-subagents, chronicle, etc.).
  const AVATAR_OVERLAY_GATE_FUNCTION_RE_V2 =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`2679188970`\)\}/;
  const AVATAR_OVERLAY_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`2679188970`\)/g;

  // ── Patch 11: Enable Heartbeat Automations for offline builds ──────────
  //
  // Gate 1488233300 controls whether the "heartbeat" schedule type is
  // available when creating automations.  When false only "cron" is
  // offered.  Replace all gate calls with !0 so heartbeat triggers are
  // always available.
  const HEARTBEAT_GATE_ID_MARKER = '`1488233300`';
  const HEARTBEAT_GATE_NEEDLE = '$f(`1488233300`)';
  const HEARTBEAT_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1488233300`\)/g;
  const HEARTBEAT_GATE_REPLACEMENT = '!0';
  // ≥ 26.429.x: extracted to a standalone hook.
  const HEARTBEAT_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`1488233300`\)\}/;

  // ── Patch 12: Enable Ambient Suggestions for offline builds ────────────
  //
  // Gate 2425897452 controls the ambient suggestions feature.  Replace all
  // gate calls with !0 so the feature is always active.
  const AMBIENT_SUGGESTIONS_GATE_ID_MARKER = '`2425897452`';
  const AMBIENT_SUGGESTIONS_GATE_NEEDLE = '$f(`2425897452`)';
  const AMBIENT_SUGGESTIONS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`2425897452`\)/g;
  const AMBIENT_SUGGESTIONS_GATE_REPLACEMENT = '!0';
  // ≥ 26.429.x: extracted to a standalone hook.
  const AMBIENT_SUGGESTIONS_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`2425897452`\)\}/;

  // ── Patch 13: Enable Artifacts Pane for offline builds ─────────────────
  //
  // Gate 3903742690 controls the artifacts side pane feature.  Replace all
  // gate calls with !0.
  const ARTIFACTS_PANE_GATE_ID_MARKER = '`3903742690`';
  const ARTIFACTS_PANE_GATE_NEEDLE = '$f(`3903742690`)';
  const ARTIFACTS_PANE_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`3903742690`\)/;
  const ARTIFACTS_PANE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`3903742690`\)\}/;
  const ARTIFACTS_PANE_GATE_REPLACEMENT = '!0';

  // ── Patch 14: Enable PR Badge Icons for offline builds ─────────────────
  //
  // Gate 2553306736 controls PR status badge icons shown on conversation
  // list items.  Enabling it complements the already-unlocked PR sidebar
  // entry.  Replace all gate calls with !0.
  const PR_ICONS_GATE_ID_MARKER = '`2553306736`';
  const PR_ICONS_GATE_NEEDLE = '$f(`2553306736`)';
  const PR_ICONS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`2553306736`\)/;
  const PR_ICONS_GATE_REPLACEMENT = '!0';
  // ≥ 26.429.x: extracted to a standalone hook.
  const PR_ICONS_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`2553306736`\)\}/;

  // ── Patch 15: Enable Memories for offline builds ────────────────────────
  //
  // Gate 875176429 controls the memories feature in the conversation
  // composer.  Replace the inline gate assignment with !0.
  const MEMORIES_GATE_CURRENT_PATTERN =
    '[$s]:Ue(e,ec)&&We(e,Qs).groupName===`Test`';
  // [$\w]+ instead of \w+ so that minified names like $f are also matched.
  const MEMORIES_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`875176429`\)/;
  // ≥ 26.429.x: extracted to a standalone hook.
  const MEMORIES_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`875176429`\)\}/;

  // ── Patch 16: Enable slash commands menu for offline builds ───────────
  //
  // Gate 1609556872 controls whether the composer slash command menu is
  // mounted.  Replace all gate calls with !0 so typing `/` opens the menu.
  const SLASH_COMMANDS_GATE_ID_MARKER = '`1609556872`';
  const SLASH_COMMANDS_GATE_NEEDLE = '$f(`1609556872`)';
  const SLASH_COMMANDS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1609556872`\)/;
  const SLASH_COMMANDS_GATE_REPLACEMENT = '!0';
  const SLASH_COMMANDS_GATE_ALREADY_CORRECT_MARKER =
    'a=i.pathname===`/hotkey-window`,o=!0,s=wo()';
  // ≥ 26.429.x: extracted to a standalone hook.
  const SLASH_COMMANDS_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`1609556872`\)\}/;

  // ── Patch 17: Enable Worktree mode for offline builds ────────────────
  //
  // Gate 505458 controls whether worktree mode can be selected in the
  // environment picker. Replace inline gate calls with !0.
  const WORKTREE_MODE_GATE_ID_MARKER = '`505458`';
  const WORKTREE_MODE_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`505458`\)/g;
  // ≥ 26.429.x: extracted to a standalone hook.
  const WORKTREE_MODE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`505458`\)\}/;

  // ── Patch 18: Enable local environments cloud onboarding for offline ─
  //
  // Gate 1907601843 controls the cloud onboarding path shown when no local
  // environments are available. Replace inline gate calls with !0.
  const CLOUD_ENVIRONMENT_GATE_ID_MARKER = '`1907601843`';
  const CLOUD_ENVIRONMENT_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1907601843`\)/g;
  // ≥ 26.429.x: extracted to a standalone hook.
  const CLOUD_ENVIRONMENT_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`1907601843`\)\}/;

  // ── Patch 19: Enable Browser Use for offline builds ───────────────────
  //
  // Gate 410262010 controls browser agent availability. Replace inline
  // gate calls with !0 while preserving the remaining config checks.
  const BROWSER_USE_GATE_ID_MARKER = '`410262010`';
  const BROWSER_USE_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`410262010`\)/g;
  // ≥ 26.429.x: extracted to a standalone hook.
  const BROWSER_USE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`410262010`\)\}/;

  // ── Patch 20: Enable in-app browser for offline builds ────────────────
  //
  // Gate 4250630194 controls in-app browser availability. Replace inline
  // gate calls with !0 while preserving the host/config checks.
  const IN_APP_BROWSER_GATE_ID_MARKER = '`4250630194`';
  const IN_APP_BROWSER_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`4250630194`\)/g;
  // ≥ 26.429.x: extracted to a standalone hook.
  const IN_APP_BROWSER_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`4250630194`\)\}/;

  // ── Patch 21: Enable bundled plugins marketplace for offline builds ──
  //
  // Gate 588076040 controls whether the OpenAI bundled marketplace is
  // merged into the plugins page. Replace inline gate calls with !0.
  const PLUGINS_BUNDLED_MARKETPLACE_GATE_ID_MARKER = '`588076040`';
  const PLUGINS_BUNDLED_MARKETPLACE_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`588076040`\)/g;
  // ≥ 26.429.x: extracted to a standalone hook.
  const PLUGINS_BUNDLED_MARKETPLACE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`588076040`\)\}/;

  // ── Patch 22: Enable Background Subagents for offline builds ───────────
  //
  // Gate 1221508807 controls whether background subagents are enabled.
  // A standalone file exports a hook that returns this gate result.  When
  // false the background agents panel in the composer is permanently hidden.
  // Bypass so the panel is always available in offline builds.
  const BACKGROUND_SUBAGENTS_GATE_ID_MARKER = '`1221508807`';
  const BACKGROUND_SUBAGENTS_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`1221508807`\)\}/;
  const BACKGROUND_SUBAGENTS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1221508807`\)/g;

  // ── Patch 23: Enable Thread Overlay for offline builds ─────────────────
  //
  // Gate 1060282072 (combined with gate 459748632) controls whether
  // conversations can be opened in an overlay window.  Replace inline gate
  // calls with !0 so the thread overlay is always available in Electron.
  const THREAD_OVERLAY_GATE_ID_MARKER = '`1060282072`';
  const THREAD_OVERLAY_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1060282072`\)/g;

  // ── Patch 24: Enable Multi-Window for offline builds ───────────────────
  //
  // Gate 459748632 controls multi-window support and (together with
  // 1060282072) the thread overlay feature.  Replace inline gate calls with
  // !0 to enable both capabilities in offline builds.
  const MULTI_WINDOW_GATE_ID_MARKER = '`459748632`';
  const MULTI_WINDOW_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`459748632`\)/g;

  // ── Patch 25: Enable Computer Use for offline builds ───────────────────
  //
  // Gate 1506311413 controls the computer-use capability flag that is
  // reported to the Electron main process via the
  // electron-desktop-features-changed IPC message.  Replace inline gate
  // calls with !0 so computer-use is always reported as available.
  const COMPUTER_USE_GATE_ID_MARKER = '`1506311413`';
  const COMPUTER_USE_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1506311413`\)/g;

  // ── Patch 26: Enable Control desktop feature for offline builds ─────────
  //
  // Gate 2171042036 controls the "control" flag in the desktop features
  // IPC message.  Replace inline gate calls with !0.
  const CONTROL_GATE_ID_MARKER = '`2171042036`';
  const CONTROL_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`2171042036`\)/g;

  // ── Patch 27: Enable Global Dictation for offline builds ───────────────
  //
  // Gates 1244621283 and 4100906017 together control the global dictation
  // (voice input) feature.  Both must be true to enable dictation and its
  // associated settings.  Replace all inline gate calls in every asset file
  // (general-settings, use-model-settings, main index) with !0.
  const DICTATION_GATE_1_ID_MARKER = '`1244621283`';
  const DICTATION_GATE_1_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1244621283`\)/g;
  const DICTATION_GATE_2_ID_MARKER = '`4100906017`';
  const DICTATION_GATE_2_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`4100906017`\)/g;

  // ── Patch 28: Enable Browser non-local sites for offline builds ─────────
  //
  // Gate 3903563814 controls whether the browser agent is permitted to
  // access non-local (internet) websites.  When false the browser agent is
  // restricted to localhost/LAN only.  Replace inline gate calls with !0.
  const BROWSER_NONLOCAL_GATE_ID_MARKER = '`3903563814`';
  const BROWSER_NONLOCAL_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`3903563814`\)/g;

  // ── Patch 29: Enable Thread Hover Cards for offline builds ─────────────
  //
  // Gate 3032432888 controls whether the conversation list items in the
  // sidebar show hover-card project labels.  Replace inline gate calls with
  // !0 so hover cards always appear in Electron offline builds.
  const THREAD_HOVER_CARDS_GATE_ID_MARKER = '`3032432888`';
  const THREAD_HOVER_CARDS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`3032432888`\)/g;

  // ── Patch 30: Enable Chronicle for offline builds ──────────────────────
  //
  // Gate 2574306096 controls the Chronicle feature (agent journal/history).
  // A standalone function in the chronicle-setup-state chunk exports the
  // gate result.  Replace that function to always return !0.
  const CHRONICLE_GATE_ID_MARKER = '`2574306096`';
  const CHRONICLE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`2574306096`\)\}/;
  const CHRONICLE_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`2574306096`\)/g;

  // ── Patch 31: Enable Agent Personality for offline builds ──────────────
  //
  // Gate 1444479692 controls the agent personality feature in the Chronicle
  // chunk.  Replace inline gate calls with !0 so personality configuration
  // is always available.
  const PERSONALITY_GATE_ID_MARKER = '`1444479692`';
  const PERSONALITY_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1444479692`\)/g;

  // ── Patch 32: Enable Remote Connections for offline builds ─────────────
  //
  // Gate 1042620455 controls remote Codex instance connections.  A
  // standalone function in the app-server-manager-hooks chunk exports the
  // gate result.  Replace to always return !0.
  const REMOTE_CONNECTIONS_GATE_ID_MARKER = '`1042620455`';
  const REMOTE_CONNECTIONS_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`1042620455`\)\}/;
  const REMOTE_CONNECTIONS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`1042620455`\)/g;

  // ── Patch 33: Enable Remote Connections feature flag for offline ─────────
  //
  // Gate 4114442250 is used in the app-server-manager-hooks feature check
  // function alongside the config check for features.remote_connections.
  // Replace inline gate calls with !0.
  const REMOTE_CONNECTIONS_FEATURE_GATE_ID_MARKER = '`4114442250`';
  const REMOTE_CONNECTIONS_FEATURE_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`4114442250`\)/g;

  // ── Patch 34: Enable Artifact Electron native functionality ────────────
  //
  // Gate 839469903 controls the native Windows artifact viewer (Walnut
  // WinRT assembly) in the artifact-tab-content.electron chunk.  The
  // standalone function exports the gate result.  Replace to always return
  // !0 so the native artifact viewer is always active in offline builds.
  const ARTIFACT_ELECTRON_GATE_ID_MARKER = '`839469903`';
  const ARTIFACT_ELECTRON_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`839469903`\)\}/;

  // ── Patch 35: Enable Fast mode speed selector for offline builds ────────
  //
  // The "Fast / Standard" speed selector in the model picker is gated
  // behind two run-time conditions inside the settings chunk:
  //   1. statsig_default_enable_features.fast_mode === true (dynamic
  //      config – defaults to false when Statsig is unreachable)
  //   2. authMethod === "chatgpt"
  // The visibility hook returns: `X?.fast_mode===!0&&authCheck(arg)`.
  // We replace the entire compound gate expression with !0 so both
  // conditions are satisfied and the button is always visible.
  const FAST_MODE_STORE_MARKER = 'statsig_default_enable_features';
  const FAST_MODE_KEY_MARKER = 'fast_mode';
  // Matches: X?.fast_mode===!0&&Y(Z)  or  X.fast_mode===!0&&Y(Z)
  const FAST_MODE_GATE_RE =
    /[$\w]+(?:\?\.|\.)fast_mode===!0&&[$\w]+\([$\w]+\)/;

  const AUTOMATION_DIALOG_CWD_PATCHES = [
    {
      needle: 'function qd(e){return m(e.value)}',
      replacement:
        `function qd(e){let t=m(e.value);return typeof t==\`string\`&&t.startsWith(\`\\\\\\\\?\\\\\`)&&/^[A-Za-z]:/.test(t.slice(4))?t.slice(4):t}`,
      patchMarker:
        `function qd(e){let t=m(e.value);return typeof t==\`string\`&&t.startsWith(\`\\\\\\\\?\\\\\`)&&/^[A-Za-z]:/.test(t.slice(4))?t.slice(4):t}`,
    },
    {
      needle: 'e.cwds.map(ve)',
      replacement:
        `e.cwds.map(ve).map(${AUTOMATION_CWD_NORMALIZER_INLINE})`,
      patchMarker:
        `.cwds.map(ve).map(${AUTOMATION_CWD_NORMALIZER_INLINE})`,
    },
  ];
  const AUTOMATION_DIALOG_CWD_REGEX_PATCHES = [
    {
      test:
        /cwds:[A-Za-z_$][\w$]*\.cwds\?\.map\([A-Za-z_$][\w$]*\)\?\?\[\]/,
      pattern:
        /cwds:([A-Za-z_$][\w$]*\.cwds\?\.map\([A-Za-z_$][\w$]*\)\?\?\[\])/g,
      replacement:
        `cwds:($1).map(${AUTOMATION_CWD_NORMALIZER_INLINE})`,
    },
  ];
  const AUTOMATION_DIALOG_CWD_UNPATCHED_PATTERNS = [
    'function qd(e){return m(e.value)}',
    /e\.cwds\.map\(ve\)(?!\.map\()/,
    /cwds:[A-Za-z_$][\w$]*\.cwds\?\.map\([A-Za-z_$][\w$]*\)\?\?\[\]/,
  ];

  const assetsDir = path.join(tmpDir, 'webview', 'assets');
  if (fs.existsSync(assetsDir)) {
    let i18nCount = 0;
    let i18nAlreadyCorrect = false;
    let gatePatched = false;
    let settingsGateSeen = false;
    let automationsGatePatched = false;
    let automationsGateSeen = false;
    let pullRequestsGatePatched = false;
    let pullRequestsGateSeen = false;
    let pullRequestsRouteGatePatched = false;
    let pullRequestsRouteGateSeen = false;
    let scratchpadGatePatched = false;
    let scratchpadGateSeen = false;
    let avatarOverlayGatePatched = false;
    let avatarOverlayGateSeen = false;
    let heartbeatGateCount = 0;
    let heartbeatGateSeen = false;
    let ambientSuggestionsGateCount = 0;
    let ambientSuggestionsGateSeen = false;
    let artifactsPaneGateCount = 0;
    let artifactsPaneGateSeen = false;
    let prIconsGateCount = 0;
    let prIconsGateSeen = false;
    let memoriesGatePatched = false;
    let memoriesGateSeen = false;
    let slashCommandsGateCount = 0;
    let slashCommandsGateSeen = false;
    let slashCommandsGateAlreadyCorrect = false;
    let worktreeModeGateCount = 0;
    let worktreeModeGateSeen = false;
    let cloudEnvironmentGateCount = 0;
    let cloudEnvironmentGateSeen = false;
    let browserUseGateCount = 0;
    let browserUseGateSeen = false;
    let inAppBrowserGateCount = 0;
    let inAppBrowserGateSeen = false;
    let pluginsBundledMarketplaceGateCount = 0;
    let pluginsBundledMarketplaceGateSeen = false;
    let automationDialogCwdPatched = false;
    const automationDialogCwdUnpatchedFiles = [];
    let backgroundSubagentsGatePatched = false;
    let backgroundSubagentsGateSeen = false;
    let threadOverlayGateCount = 0;
    let threadOverlayGateSeen = false;
    let multiWindowGateCount = 0;
    let multiWindowGateSeen = false;
    let computerUseGateCount = 0;
    let computerUseGateSeen = false;
    let controlGateCount = 0;
    let controlGateSeen = false;
    let dictation1GateCount = 0;
    let dictation1GateSeen = false;
    let dictation2GateCount = 0;
    let dictation2GateSeen = false;
    let browserNonlocalGateCount = 0;
    let browserNonlocalGateSeen = false;
    let threadHoverCardsGateCount = 0;
    let threadHoverCardsGateSeen = false;
    let chronicleGatePatched = false;
    let chronicleGateSeen = false;
    let personalityGateCount = 0;
    let personalityGateSeen = false;
    let remoteConnectionsGatePatched = false;
    let remoteConnectionsGateSeen = false;
    let remoteConnectionsFeatureGateCount = 0;
    let remoteConnectionsFeatureGateSeen = false;
    let artifactElectronGatePatched = false;
    let artifactElectronGateSeen = false;
    let fastModeGatePatched = false;
    let fastModeGateSeen = false;

    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith('.js')) continue;
      const filePath = path.join(assetsDir, file);
      let content = fs.readFileSync(filePath, 'utf8');
      const originalContent = content;
      let modified = false;

      settingsGateSeen ||= originalContent.includes(SETTINGS_GATE_ID_MARKER);
      automationsGateSeen ||= originalContent.includes(AUTOMATIONS_GATE_ID_MARKER);
      pullRequestsGateSeen ||=
        PULL_REQUESTS_GATE_RE.test(originalContent) ||
        PULL_REQUESTS_GATE_INLINE_RE.test(originalContent) ||
        PULL_REQUESTS_GATE_FUNCTION_RE.test(originalContent) ||
        originalContent.includes(PULL_REQUESTS_GATE_ID_MARKER);
      pullRequestsRouteGateSeen ||=
        PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE.test(originalContent) ||
        PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V2.test(originalContent) ||
        originalContent.includes(PULL_REQUESTS_GATE_ID_MARKER);
      scratchpadGateSeen ||=
        SCRATCHPAD_GATE_FUNCTION_RE.test(originalContent) ||
        SCRATCHPAD_GATE_FUNCTION_RE_V2.test(originalContent);
      avatarOverlayGateSeen ||=
        AVATAR_OVERLAY_GATE_FUNCTION_RE.test(originalContent) ||
        AVATAR_OVERLAY_GATE_FUNCTION_RE_V2.test(originalContent) ||
        AVATAR_OVERLAY_GATE_INLINE_RE.test(originalContent) ||
        originalContent.includes(AVATAR_OVERLAY_GATE_ID_MARKER);
      AVATAR_OVERLAY_GATE_INLINE_RE.lastIndex = 0;
      heartbeatGateSeen ||=
        originalContent.includes(HEARTBEAT_GATE_ID_MARKER) ||
        HEARTBEAT_GATE_INLINE_RE.test(originalContent) ||
        HEARTBEAT_GATE_FUNCTION_RE.test(originalContent);
      ambientSuggestionsGateSeen ||=
        originalContent.includes(AMBIENT_SUGGESTIONS_GATE_ID_MARKER) ||
        AMBIENT_SUGGESTIONS_GATE_INLINE_RE.test(originalContent) ||
        AMBIENT_SUGGESTIONS_GATE_FUNCTION_RE.test(originalContent);
      artifactsPaneGateSeen ||= originalContent.includes(ARTIFACTS_PANE_GATE_ID_MARKER);
      prIconsGateSeen ||=
        originalContent.includes(PR_ICONS_GATE_ID_MARKER) ||
        PR_ICONS_GATE_INLINE_RE.test(originalContent) ||
        PR_ICONS_GATE_FUNCTION_RE.test(originalContent);
      memoriesGateSeen ||=
        originalContent.includes(MEMORIES_GATE_CURRENT_PATTERN) ||
        MEMORIES_GATE_INLINE_RE.test(originalContent) ||
        MEMORIES_GATE_FUNCTION_RE.test(originalContent);
      slashCommandsGateSeen ||=
        originalContent.includes(SLASH_COMMANDS_GATE_ID_MARKER) ||
        SLASH_COMMANDS_GATE_INLINE_RE.test(originalContent) ||
        SLASH_COMMANDS_GATE_FUNCTION_RE.test(originalContent);
      worktreeModeGateSeen ||=
        originalContent.match(WORKTREE_MODE_GATE_INLINE_RE) !== null ||
        WORKTREE_MODE_GATE_FUNCTION_RE.test(originalContent);
      cloudEnvironmentGateSeen ||=
        originalContent.match(CLOUD_ENVIRONMENT_GATE_INLINE_RE) !== null ||
        CLOUD_ENVIRONMENT_GATE_FUNCTION_RE.test(originalContent);
      browserUseGateSeen ||=
        originalContent.match(BROWSER_USE_GATE_INLINE_RE) !== null ||
        BROWSER_USE_GATE_FUNCTION_RE.test(originalContent);
      inAppBrowserGateSeen ||=
        originalContent.match(IN_APP_BROWSER_GATE_INLINE_RE) !== null ||
        IN_APP_BROWSER_GATE_FUNCTION_RE.test(originalContent);
      pluginsBundledMarketplaceGateSeen ||=
        originalContent.match(PLUGINS_BUNDLED_MARKETPLACE_GATE_INLINE_RE) !== null ||
        PLUGINS_BUNDLED_MARKETPLACE_GATE_FUNCTION_RE.test(originalContent);
      backgroundSubagentsGateSeen ||= originalContent.includes(BACKGROUND_SUBAGENTS_GATE_ID_MARKER);
      threadOverlayGateSeen ||= originalContent.includes(THREAD_OVERLAY_GATE_ID_MARKER);
      multiWindowGateSeen ||= originalContent.includes(MULTI_WINDOW_GATE_ID_MARKER);
      computerUseGateSeen ||= originalContent.includes(COMPUTER_USE_GATE_ID_MARKER);
      controlGateSeen ||= originalContent.includes(CONTROL_GATE_ID_MARKER);
      dictation1GateSeen ||= originalContent.includes(DICTATION_GATE_1_ID_MARKER);
      dictation2GateSeen ||= originalContent.includes(DICTATION_GATE_2_ID_MARKER);
      browserNonlocalGateSeen ||= originalContent.includes(BROWSER_NONLOCAL_GATE_ID_MARKER);
      threadHoverCardsGateSeen ||= originalContent.includes(THREAD_HOVER_CARDS_GATE_ID_MARKER);
      chronicleGateSeen ||=
        CHRONICLE_GATE_FUNCTION_RE.test(originalContent) ||
        originalContent.includes(CHRONICLE_GATE_ID_MARKER);
      personalityGateSeen ||= originalContent.includes(PERSONALITY_GATE_ID_MARKER);
      remoteConnectionsGateSeen ||=
        REMOTE_CONNECTIONS_GATE_FUNCTION_RE.test(originalContent) ||
        originalContent.includes(REMOTE_CONNECTIONS_GATE_ID_MARKER);
      remoteConnectionsFeatureGateSeen ||=
        originalContent.includes(REMOTE_CONNECTIONS_FEATURE_GATE_ID_MARKER);
      artifactElectronGateSeen ||=
        ARTIFACT_ELECTRON_GATE_FUNCTION_RE.test(originalContent) ||
        originalContent.includes(ARTIFACT_ELECTRON_GATE_ID_MARKER);
      fastModeGateSeen ||=
        originalContent.includes(FAST_MODE_STORE_MARKER) &&
        originalContent.includes(FAST_MODE_KEY_MARKER);

      if (content.includes(I18N_NEEDLE)) {
        const count = content.split(I18N_NEEDLE).length - 1;
        content = content.replaceAll(I18N_NEEDLE, I18N_REPLACEMENT);
        i18nCount += count;
        modified = true;
      } else if (content.includes(I18N_ALREADY_CORRECT_MARKER)) {
        i18nAlreadyCorrect = true;
      }

      if (SETTINGS_GATE_RE.test(content)) {
        content = content.replace(SETTINGS_GATE_RE, '$1$2=!0');
        gatePatched = true;
        modified = true;
      } else if (SETTINGS_GATE_INLINE_RE.test(content)) {
        content = content.replace(SETTINGS_GATE_INLINE_RE, '$1!0');
        gatePatched = true;
        modified = true;
      }

      if (AUTOMATIONS_GATE_RE.test(content)) {
        content = content.replace(AUTOMATIONS_GATE_RE, '$1$2=!0');
        automationsGatePatched = true;
        modified = true;
      } else if (AUTOMATIONS_GATE_INLINE_RE.test(content)) {
        content = content.replace(AUTOMATIONS_GATE_INLINE_RE, '$1!0');
        automationsGatePatched = true;
        modified = true;
      }

      if (PULL_REQUESTS_GATE_RE.test(content)) {
        content = content.replace(PULL_REQUESTS_GATE_RE, '$1$2=!0');
        pullRequestsGatePatched = true;
        modified = true;
      } else if (PULL_REQUESTS_GATE_INLINE_RE.test(content)) {
        content = content.replace(PULL_REQUESTS_GATE_INLINE_RE, '$1!0');
        pullRequestsGatePatched = true;
        modified = true;
      } else if (PULL_REQUESTS_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(PULL_REQUESTS_GATE_FUNCTION_RE, 'function $1(){return!0}');
        pullRequestsGatePatched = true;
        modified = true;
      }
      // IIFE-form fallback: handles (0,$f)(`3789238711`) which the patterns above miss.
      // Guard is content.includes(ID_MARKER) — primary patterns remove the literal when they
      // match, so this naturally fires only when the primary patterns left the ID intact.
      if (content.includes(PULL_REQUESTS_GATE_ID_MARKER)) {
        const nc = content.replace(
          /(?:\(0,[$\w]+\)|[$\w]+)\(`3789238711`\)/g,
          '!0',
        );
        if (nc !== content) {
          pullRequestsGatePatched = true;
          content = nc;
          modified = true;
        }
      }

      if (PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(
          PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE,
          'function $1(){return(0,$.jsx)($2,{})}',
        );
        pullRequestsRouteGatePatched = true;
        modified = true;
      } else if (PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V2.test(content)) {
        content = content.replace(
          PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V2,
          'function $1(){return(0,$.jsx)($2,{})}',
        );
        pullRequestsRouteGatePatched = true;
        modified = true;
      }
      // IIFE-form fallback for route gate: same guard approach as sidebar.
      if (content.includes(PULL_REQUESTS_GATE_ID_MARKER)) {
        const nc = content.replace(
          /(?:\(0,[$\w]+\)|[$\w]+)\(`3789238711`\)/g,
          '!0',
        );
        if (nc !== content) {
          pullRequestsRouteGatePatched = true;
          content = nc;
          modified = true;
        }
      }

      if (SCRATCHPAD_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(SCRATCHPAD_GATE_FUNCTION_RE, 'function $1(){return!0}');
        scratchpadGatePatched = true;
        modified = true;
      } else if (SCRATCHPAD_GATE_FUNCTION_RE_V2.test(content)) {
        content = content.replace(SCRATCHPAD_GATE_FUNCTION_RE_V2, 'function $1(){return!0}');
        scratchpadGatePatched = true;
        modified = true;
      }

      if (AVATAR_OVERLAY_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(
          AVATAR_OVERLAY_GATE_FUNCTION_RE,
          'function $1(){return(0,$.jsx)($2,{})}',
        );
        avatarOverlayGatePatched = true;
        modified = true;
      } else if (AVATAR_OVERLAY_GATE_FUNCTION_RE_V2.test(content)) {
        content = content.replace(AVATAR_OVERLAY_GATE_FUNCTION_RE_V2, 'function $1(){return!0}');
        avatarOverlayGatePatched = true;
        modified = true;
      } else if (content.match(AVATAR_OVERLAY_GATE_INLINE_RE)) {
        content = content.replaceAll(AVATAR_OVERLAY_GATE_INLINE_RE, '$1!0');
        avatarOverlayGatePatched = true;
        modified = true;
      }
      // IIFE-form fallback: handles (0,$f)(`2679188970`).
      // Primary patterns remove the literal when they match, so this fires only when needed.
      if (content.includes(AVATAR_OVERLAY_GATE_ID_MARKER)) {
        const nc = content.replace(
          /(?:\(0,[$\w]+\)|[$\w]+)\(`2679188970`\)/g,
          '!0',
        );
        if (nc !== content) {
          avatarOverlayGatePatched = true;
          content = nc;
          modified = true;
        }
      }

      if (content.includes(HEARTBEAT_GATE_NEEDLE)) {
        const count = content.split(HEARTBEAT_GATE_NEEDLE).length - 1;
        content = content.replaceAll(HEARTBEAT_GATE_NEEDLE, HEARTBEAT_GATE_REPLACEMENT);
        heartbeatGateCount += count;
        modified = true;
      } else {
        const inlineMatches = content.match(HEARTBEAT_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(
            HEARTBEAT_GATE_INLINE_RE,
            '$1!0',
          );
          heartbeatGateCount += inlineMatches.length;
          modified = true;
        } else if (HEARTBEAT_GATE_FUNCTION_RE.test(content)) {
          content = content.replace(HEARTBEAT_GATE_FUNCTION_RE, 'function $1(){return!0}');
          heartbeatGateCount += 1;
          modified = true;
        }
      }

      if (content.includes(AMBIENT_SUGGESTIONS_GATE_NEEDLE)) {
        const count = content.split(AMBIENT_SUGGESTIONS_GATE_NEEDLE).length - 1;
        content = content.replaceAll(
          AMBIENT_SUGGESTIONS_GATE_NEEDLE,
          AMBIENT_SUGGESTIONS_GATE_REPLACEMENT,
        );
        ambientSuggestionsGateCount += count;
        modified = true;
      } else {
        const inlineMatches = content.match(AMBIENT_SUGGESTIONS_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(
            AMBIENT_SUGGESTIONS_GATE_INLINE_RE,
            '$1!0',
          );
          ambientSuggestionsGateCount += inlineMatches.length;
          modified = true;
        } else if (AMBIENT_SUGGESTIONS_GATE_FUNCTION_RE.test(content)) {
          content = content.replace(
            AMBIENT_SUGGESTIONS_GATE_FUNCTION_RE,
            'function $1(){return!0}',
          );
          ambientSuggestionsGateCount += 1;
          modified = true;
        }
      }

      if (content.includes(ARTIFACTS_PANE_GATE_NEEDLE)) {
        const count = content.split(ARTIFACTS_PANE_GATE_NEEDLE).length - 1;
        content = content.replaceAll(
          ARTIFACTS_PANE_GATE_NEEDLE,
          ARTIFACTS_PANE_GATE_REPLACEMENT,
        );
        artifactsPaneGateCount += count;
        modified = true;
      } else if (ARTIFACTS_PANE_GATE_INLINE_RE.test(content)) {
        content = content.replace(
          ARTIFACTS_PANE_GATE_INLINE_RE,
          '$1!0',
        );
        artifactsPaneGateCount += 1;
        modified = true;
      } else if (ARTIFACTS_PANE_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(
          ARTIFACTS_PANE_GATE_FUNCTION_RE,
          'function $1(){return!0}',
        );
        artifactsPaneGateCount += 1;
        modified = true;
      }

      if (content.includes(PR_ICONS_GATE_NEEDLE)) {
        const count = content.split(PR_ICONS_GATE_NEEDLE).length - 1;
        content = content.replaceAll(PR_ICONS_GATE_NEEDLE, PR_ICONS_GATE_REPLACEMENT);
        prIconsGateCount += count;
        modified = true;
      } else if (PR_ICONS_GATE_INLINE_RE.test(content)) {
        content = content.replace(PR_ICONS_GATE_INLINE_RE, '$1!0');
        prIconsGateCount += 1;
        modified = true;
      } else if (PR_ICONS_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(PR_ICONS_GATE_FUNCTION_RE, 'function $1(){return!0}');
        prIconsGateCount += 1;
        modified = true;
      }
      // IIFE-form fallback: handles (0,$f)(`2553306736`) in index / bridge chunks.
      // Uses content.includes(ID_MARKER) so it fires per-file, not guarded by a global count.
      if (content.includes(PR_ICONS_GATE_ID_MARKER)) {
        const nc = content.replace(
          /(?:\(0,[$\w]+\)|[$\w]+)\(`2553306736`\)/g,
          '!0',
        );
        if (nc !== content) {
          prIconsGateCount += 1;
          content = nc;
          modified = true;
        }
      }

      if (MEMORIES_GATE_INLINE_RE.test(content)) {
        content = content.replace(MEMORIES_GATE_INLINE_RE, '$1!0');
        memoriesGatePatched = true;
        modified = true;
      } else if (content.includes(MEMORIES_GATE_CURRENT_PATTERN)) {
        content = content.replace(
          MEMORIES_GATE_CURRENT_PATTERN,
          '[$s]:!0',
        );
        memoriesGatePatched = true;
        modified = true;
      } else if (MEMORIES_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(MEMORIES_GATE_FUNCTION_RE, 'function $1(){return!0}');
        memoriesGatePatched = true;
        modified = true;
      }

      if (content.includes(SLASH_COMMANDS_GATE_NEEDLE)) {
        const count = content.split(SLASH_COMMANDS_GATE_NEEDLE).length - 1;
        content = content.replaceAll(
          SLASH_COMMANDS_GATE_NEEDLE,
          SLASH_COMMANDS_GATE_REPLACEMENT,
        );
        slashCommandsGateCount += count;
        modified = true;
      } else if (SLASH_COMMANDS_GATE_INLINE_RE.test(content)) {
        content = content.replace(
          SLASH_COMMANDS_GATE_INLINE_RE,
          '$1!0',
        );
        slashCommandsGateCount += 1;
        modified = true;
      } else if (SLASH_COMMANDS_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(SLASH_COMMANDS_GATE_FUNCTION_RE, 'function $1(){return!0}');
        slashCommandsGateCount += 1;
        modified = true;
      } else if (content.includes(SLASH_COMMANDS_GATE_ALREADY_CORRECT_MARKER)) {
        slashCommandsGateAlreadyCorrect = true;
      }

      {
        const inlineMatches = content.match(WORKTREE_MODE_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(WORKTREE_MODE_GATE_INLINE_RE, '$1!0');
          worktreeModeGateCount += inlineMatches.length;
          modified = true;
        } else if (WORKTREE_MODE_GATE_FUNCTION_RE.test(content)) {
          content = content.replace(WORKTREE_MODE_GATE_FUNCTION_RE, 'function $1(){return!0}');
          worktreeModeGateCount += 1;
          modified = true;
        }
      }

      {
        const inlineMatches = content.match(CLOUD_ENVIRONMENT_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(CLOUD_ENVIRONMENT_GATE_INLINE_RE, '$1!0');
          cloudEnvironmentGateCount += inlineMatches.length;
          modified = true;
        } else if (CLOUD_ENVIRONMENT_GATE_FUNCTION_RE.test(content)) {
          content = content.replace(CLOUD_ENVIRONMENT_GATE_FUNCTION_RE, 'function $1(){return!0}');
          cloudEnvironmentGateCount += 1;
          modified = true;
        }
      }

      {
        const inlineMatches = content.match(BROWSER_USE_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(BROWSER_USE_GATE_INLINE_RE, '$1!0');
          browserUseGateCount += inlineMatches.length;
          modified = true;
        } else if (BROWSER_USE_GATE_FUNCTION_RE.test(content)) {
          content = content.replace(BROWSER_USE_GATE_FUNCTION_RE, 'function $1(){return!0}');
          browserUseGateCount += 1;
          modified = true;
        }
      }

      {
        const inlineMatches = content.match(IN_APP_BROWSER_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(IN_APP_BROWSER_GATE_INLINE_RE, '$1!0');
          inAppBrowserGateCount += inlineMatches.length;
          modified = true;
        } else if (IN_APP_BROWSER_GATE_FUNCTION_RE.test(content)) {
          content = content.replace(IN_APP_BROWSER_GATE_FUNCTION_RE, 'function $1(){return!0}');
          inAppBrowserGateCount += 1;
          modified = true;
        }
      }

      {
        const inlineMatches = content.match(PLUGINS_BUNDLED_MARKETPLACE_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(
            PLUGINS_BUNDLED_MARKETPLACE_GATE_INLINE_RE,
            '$1!0',
          );
          pluginsBundledMarketplaceGateCount += inlineMatches.length;
          modified = true;
        } else if (PLUGINS_BUNDLED_MARKETPLACE_GATE_FUNCTION_RE.test(content)) {
          content = content.replace(
            PLUGINS_BUNDLED_MARKETPLACE_GATE_FUNCTION_RE,
            'function $1(){return!0}',
          );
          pluginsBundledMarketplaceGateCount += 1;
          modified = true;
        }
      }

      // Patch 22: Background Subagents
      if (BACKGROUND_SUBAGENTS_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(BACKGROUND_SUBAGENTS_GATE_FUNCTION_RE, 'function $1(){return!0}');
        backgroundSubagentsGatePatched = true;
        modified = true;
      } else {
        const inlineMatches = content.match(BACKGROUND_SUBAGENTS_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(BACKGROUND_SUBAGENTS_GATE_INLINE_RE, '$1!0');
          backgroundSubagentsGatePatched = true;
          modified = true;
        }
      }

      // Patch 23: Thread Overlay
      {
        const inlineMatches = content.match(THREAD_OVERLAY_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(THREAD_OVERLAY_GATE_INLINE_RE, '$1!0');
          threadOverlayGateCount += inlineMatches.length;
          modified = true;
        }
      }

      // Patch 24: Multi-Window
      {
        const inlineMatches = content.match(MULTI_WINDOW_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(MULTI_WINDOW_GATE_INLINE_RE, '$1!0');
          multiWindowGateCount += inlineMatches.length;
          modified = true;
        }
      }

      // Patch 25: Computer Use
      {
        const inlineMatches = content.match(COMPUTER_USE_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(COMPUTER_USE_GATE_INLINE_RE, '$1!0');
          computerUseGateCount += inlineMatches.length;
          modified = true;
        }
      }

      // Patch 26: Control desktop feature
      {
        const inlineMatches = content.match(CONTROL_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(CONTROL_GATE_INLINE_RE, '$1!0');
          controlGateCount += inlineMatches.length;
          modified = true;
        }
      }

      // Patch 27: Global Dictation (both gates)
      {
        const m1 = content.match(DICTATION_GATE_1_INLINE_RE);
        if (m1) {
          content = content.replaceAll(DICTATION_GATE_1_INLINE_RE, '$1!0');
          dictation1GateCount += m1.length;
          modified = true;
        }
      }
      {
        const m2 = content.match(DICTATION_GATE_2_INLINE_RE);
        if (m2) {
          content = content.replaceAll(DICTATION_GATE_2_INLINE_RE, '$1!0');
          dictation2GateCount += m2.length;
          modified = true;
        }
      }

      // Patch 28: Browser non-local sites
      {
        const inlineMatches = content.match(BROWSER_NONLOCAL_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(BROWSER_NONLOCAL_GATE_INLINE_RE, '$1!0');
          browserNonlocalGateCount += inlineMatches.length;
          modified = true;
        }
      }

      // Patch 29: Thread Hover Cards
      {
        const inlineMatches = content.match(THREAD_HOVER_CARDS_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(THREAD_HOVER_CARDS_GATE_INLINE_RE, '$1!0');
          threadHoverCardsGateCount += inlineMatches.length;
          modified = true;
        }
      }

      // Patch 30: Chronicle
      if (CHRONICLE_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(CHRONICLE_GATE_FUNCTION_RE, 'function $1(){return!0}');
        chronicleGatePatched = true;
        modified = true;
      } else {
        const inlineMatches = content.match(CHRONICLE_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(CHRONICLE_GATE_INLINE_RE, '$1!0');
          chronicleGatePatched = true;
          modified = true;
        }
      }

      // Patch 31: Agent Personality
      {
        const inlineMatches = content.match(PERSONALITY_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(PERSONALITY_GATE_INLINE_RE, '$1!0');
          personalityGateCount += inlineMatches.length;
          modified = true;
        }
      }

      // Patch 32: Remote Connections
      if (REMOTE_CONNECTIONS_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(REMOTE_CONNECTIONS_GATE_FUNCTION_RE, 'function $1(){return!0}');
        remoteConnectionsGatePatched = true;
        modified = true;
      } else {
        const inlineMatches = content.match(REMOTE_CONNECTIONS_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(REMOTE_CONNECTIONS_GATE_INLINE_RE, '$1!0');
          remoteConnectionsGatePatched = true;
          modified = true;
        }
      }

      // Patch 33: Remote Connections feature flag
      {
        const inlineMatches = content.match(REMOTE_CONNECTIONS_FEATURE_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(REMOTE_CONNECTIONS_FEATURE_GATE_INLINE_RE, '$1!0');
          remoteConnectionsFeatureGateCount += inlineMatches.length;
          modified = true;
        }
      }

      // Patch 34: Artifact Electron native functionality
      if (ARTIFACT_ELECTRON_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(ARTIFACT_ELECTRON_GATE_FUNCTION_RE, 'function $1(){return!0}');
        artifactElectronGatePatched = true;
        modified = true;
      }

      // Patch 35: Fast mode speed selector
      // Only process files that contain both marker strings (the settings chunk).
      if (
        content.includes(FAST_MODE_STORE_MARKER) &&
        content.includes(FAST_MODE_KEY_MARKER) &&
        FAST_MODE_GATE_RE.test(content)
      ) {
        content = content.replace(FAST_MODE_GATE_RE, '!0');
        fastModeGatePatched = true;
        modified = true;
      }

      for (const patch of AUTOMATION_DIALOG_CWD_PATCHES) {
        if (content.includes(patch.patchMarker)) {
          automationDialogCwdPatched = true;
          continue;
        }

        if (!content.includes(patch.needle)) continue;

        const patchedContent = content.replaceAll(
          patch.needle,
          patch.replacement,
        );
        if (patchedContent === content) continue;

        content = patchedContent;
        automationDialogCwdPatched = true;
        modified = true;
      }

      for (const patch of AUTOMATION_DIALOG_CWD_REGEX_PATCHES) {
        if (!patch.test.test(content)) continue;

        const patchedContent = content.replace(
          patch.pattern,
          patch.replacement,
        );
        if (patchedContent === content) continue;

        content = patchedContent;
        automationDialogCwdPatched = true;
        modified = true;
      }

      // If the upstream code already contains the CWD normalizer (built in by
      // OpenAI), treat this file as already correctly handled so we don't emit
      // a spurious warning about missing normalization.
      if (!automationDialogCwdPatched && content.includes(AUTOMATION_CWD_NORMALIZER_INLINE)) {
        automationDialogCwdPatched = true;
      }

      if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
      }

      if (AUTOMATION_DIALOG_CWD_UNPATCHED_PATTERNS.some(pattern => matchesPattern(content, pattern))) {
        automationDialogCwdUnpatchedFiles.push(file);
      }
    }

    if (automationDialogCwdUnpatchedFiles.length > 0) {
      throw new Error(
        'Known automation dialog cwd serialization remained unpatched in ' +
        `${automationDialogCwdUnpatchedFiles.join(', ')}.`,
      );
    }

    if (i18nCount > 0) {
      log(`enable_i18n default unified (${i18nCount} occurrence(s)).`);
    } else if (i18nAlreadyCorrect) {
      log('enable_i18n default already correct (!0) in this app version. No patch needed.');
    } else {
      warn('Could not locate enable_i18n default-false pattern. ' +
           'i18n patch skipped (the app version may have changed).');
    }

    if (gatePatched) {
      log('Settings entry gate bypassed for offline mode.');
    } else if (!settingsGateSeen) {
      log('Settings gate 4166894088 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Settings gate 4166894088 is still present, but no supported patch ' +
        'pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (automationsGatePatched) {
      log('Automation sidebar gate bypassed for offline mode.');
    } else if (!automationsGateSeen) {
      log('Automation gate 3075919032 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Automation gate 3075919032 is still present, but no supported patch ' +
        'pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (pullRequestsGatePatched) {
      log('Pull requests sidebar gate bypassed for offline mode.');
    } else if (!pullRequestsGateSeen) {
      log('Pull requests gate 3789238711 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Pull requests gate 3789238711 is still present, but no supported ' +
        'sidebar patch pattern matched. Update the offline patch before ' +
        'shipping this build.',
      );
    }

    if (pullRequestsRouteGatePatched) {
      log('Pull requests route gate bypassed for offline mode.');
    } else if (!pullRequestsRouteGateSeen) {
      log('Pull requests route gate is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Pull requests route gate is still present, but no supported route ' +
        'patch pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (scratchpadGatePatched) {
      log('Scratchpad gate bypassed for offline mode.');
    } else if (!scratchpadGateSeen) {
      log('Scratchpad gate 2302560359 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Scratchpad gate 2302560359 is still present, but no supported patch ' +
        'pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (avatarOverlayGatePatched) {
      log('Avatar overlay gate bypassed for offline mode.');
    } else if (!avatarOverlayGateSeen) {
      log('Avatar overlay gate 2679188970 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Avatar overlay gate 2679188970 is still present, but no supported ' +
        'patch pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (heartbeatGateCount > 0) {
      log(`Heartbeat automations gate bypassed for offline mode (${heartbeatGateCount} occurrence(s)).`);
    } else if (!heartbeatGateSeen) {
      log('Heartbeat automations gate 1488233300 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Heartbeat automations gate 1488233300 is still present, but no ' +
        'supported patch pattern matched. Update the offline patch before ' +
        'shipping this build.',
      );
    }

    if (ambientSuggestionsGateCount > 0) {
      log(`Ambient suggestions gate bypassed for offline mode (${ambientSuggestionsGateCount} occurrence(s)).`);
    } else if (!ambientSuggestionsGateSeen) {
      log('Ambient suggestions gate 2425897452 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Ambient suggestions gate 2425897452 is still present, but no ' +
        'supported patch pattern matched. Update the offline patch before ' +
        'shipping this build.',
      );
    }

    if (artifactsPaneGateCount > 0) {
      log(`Artifacts pane gate bypassed for offline mode (${artifactsPaneGateCount} occurrence(s)).`);
    } else if (!artifactsPaneGateSeen) {
      log('Artifacts pane gate 3903742690 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Artifacts pane gate 3903742690 is still present, but no supported ' +
        'patch pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (prIconsGateCount > 0) {
      log(`PR badge icons gate bypassed for offline mode (${prIconsGateCount} occurrence(s)).`);
    } else if (!prIconsGateSeen) {
      log('PR badge icons gate 2553306736 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'PR badge icons gate 2553306736 is still present, but no supported ' +
        'patch pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (memoriesGatePatched) {
      log('Memories gate bypassed for offline mode.');
    } else if (!memoriesGateSeen) {
      log('Memories gate 875176429 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Memories gate 875176429 is still present, but no supported patch ' +
        'pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (slashCommandsGateCount > 0) {
      log(`Slash commands gate bypassed for offline mode (${slashCommandsGateCount} occurrence(s)).`);
    } else if (slashCommandsGateAlreadyCorrect) {
      log('Slash commands gate already bypassed (!0) in this app version. No patch needed.');
    } else if (!slashCommandsGateSeen) {
      log('Slash commands gate 1609556872 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Slash commands gate 1609556872 is still present, but no supported ' +
        'patch pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (worktreeModeGateCount > 0) {
      log(`Worktree mode gate bypassed for offline mode (${worktreeModeGateCount} occurrence(s)).`);
    } else if (!worktreeModeGateSeen) {
      log('Worktree mode gate 505458 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Worktree mode gate 505458 is still present, but no supported patch ' +
        'pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (cloudEnvironmentGateCount > 0) {
      log(
        'Local environments cloud onboarding gate bypassed for offline mode ' +
        `(${cloudEnvironmentGateCount} occurrence(s)).`,
      );
    } else if (!cloudEnvironmentGateSeen) {
      log(
        'Local environments cloud onboarding gate 1907601843 is not present ' +
        'in this app version. No patch needed.',
      );
    } else {
      throw new Error(
        'Local environments cloud onboarding gate 1907601843 is still present, ' +
        'but no supported patch pattern matched. Update the offline patch ' +
        'before shipping this build.',
      );
    }

    if (browserUseGateCount > 0) {
      log(`Browser Use gate bypassed for offline mode (${browserUseGateCount} occurrence(s)).`);
    } else if (!browserUseGateSeen) {
      log('Browser Use gate 410262010 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Browser Use gate 410262010 is still present, but no supported patch ' +
        'pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (inAppBrowserGateCount > 0) {
      log(`In-app browser gate bypassed for offline mode (${inAppBrowserGateCount} occurrence(s)).`);
    } else if (!inAppBrowserGateSeen) {
      log('In-app browser gate 4250630194 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'In-app browser gate 4250630194 is still present, but no supported ' +
        'patch pattern matched. Update the offline patch before shipping this build.',
      );
    }

    if (pluginsBundledMarketplaceGateCount > 0) {
      log(
        'Bundled plugins marketplace gate bypassed for offline mode ' +
        `(${pluginsBundledMarketplaceGateCount} occurrence(s)).`,
      );
    } else if (!pluginsBundledMarketplaceGateSeen) {
      log(
        'Bundled plugins marketplace gate 588076040 is not present in this ' +
        'app version. No patch needed.',
      );
    } else {
      throw new Error(
        'Bundled plugins marketplace gate 588076040 is still present, but no ' +
        'supported patch pattern matched. Update the offline patch before ' +
        'shipping this build.',
      );
    }

    if (backgroundSubagentsGatePatched) {
      log('Background subagents gate bypassed for offline mode.');
    } else if (!backgroundSubagentsGateSeen) {
      log('Background subagents gate 1221508807 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Background subagents gate 1221508807 is still present, but no ' +
        'supported patch pattern matched. The background agents panel may ' +
        'be hidden in this build.',
      );
    }

    if (threadOverlayGateCount > 0) {
      log(`Thread overlay gate bypassed for offline mode (${threadOverlayGateCount} occurrence(s)).`);
    } else if (!threadOverlayGateSeen) {
      log('Thread overlay gate 1060282072 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Thread overlay gate 1060282072 is still present, but no supported ' +
        'patch pattern matched. Thread overlay may be unavailable.',
      );
    }

    if (multiWindowGateCount > 0) {
      log(`Multi-window gate bypassed for offline mode (${multiWindowGateCount} occurrence(s)).`);
    } else if (!multiWindowGateSeen) {
      log('Multi-window gate 459748632 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Multi-window gate 459748632 is still present, but no supported ' +
        'patch pattern matched. Multi-window support may be unavailable.',
      );
    }

    if (computerUseGateCount > 0) {
      log(`Computer Use capability gate bypassed for offline mode (${computerUseGateCount} occurrence(s)).`);
    } else if (!computerUseGateSeen) {
      log('Computer Use gate 1506311413 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Computer Use gate 1506311413 is still present, but no supported ' +
        'patch pattern matched. Computer Use may be unavailable.',
      );
    }

    if (controlGateCount > 0) {
      log(`Control desktop feature gate bypassed for offline mode (${controlGateCount} occurrence(s)).`);
    } else if (!controlGateSeen) {
      log('Control gate 2171042036 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Control gate 2171042036 is still present, but no supported ' +
        'patch pattern matched. Control feature may be unavailable.',
      );
    }

    if (dictation1GateCount > 0) {
      log(`Global dictation gate 1 bypassed for offline mode (${dictation1GateCount} occurrence(s)).`);
    } else if (!dictation1GateSeen) {
      log('Global dictation gate 1244621283 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Global dictation gate 1244621283 is still present, but no supported ' +
        'patch pattern matched. Voice dictation may be unavailable.',
      );
    }

    if (dictation2GateCount > 0) {
      log(`Global dictation gate 2 bypassed for offline mode (${dictation2GateCount} occurrence(s)).`);
    } else if (!dictation2GateSeen) {
      log('Global dictation gate 4100906017 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Global dictation gate 4100906017 is still present, but no supported ' +
        'patch pattern matched. Voice dictation may be unavailable.',
      );
    }

    if (browserNonlocalGateCount > 0) {
      log(
        'Browser non-local sites gate bypassed for offline mode ' +
        `(${browserNonlocalGateCount} occurrence(s)).`,
      );
    } else if (!browserNonlocalGateSeen) {
      log('Browser non-local sites gate 3903563814 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Browser non-local sites gate 3903563814 is still present, but no ' +
        'supported patch pattern matched.',
      );
    }

    if (threadHoverCardsGateCount > 0) {
      log(
        'Thread hover cards gate bypassed for offline mode ' +
        `(${threadHoverCardsGateCount} occurrence(s)).`,
      );
    } else if (!threadHoverCardsGateSeen) {
      log('Thread hover cards gate 3032432888 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Thread hover cards gate 3032432888 is still present, but no ' +
        'supported patch pattern matched.',
      );
    }

    if (chronicleGatePatched) {
      log('Chronicle gate bypassed for offline mode.');
    } else if (!chronicleGateSeen) {
      log('Chronicle gate 2574306096 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Chronicle gate 2574306096 is still present, but no supported ' +
        'patch pattern matched. Chronicle feature may be unavailable.',
      );
    }

    if (personalityGateCount > 0) {
      log(`Agent personality gate bypassed for offline mode (${personalityGateCount} occurrence(s)).`);
    } else if (!personalityGateSeen) {
      log('Agent personality gate 1444479692 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Agent personality gate 1444479692 is still present, but no supported ' +
        'patch pattern matched.',
      );
    }

    if (remoteConnectionsGatePatched) {
      log('Remote connections gate bypassed for offline mode.');
    } else if (!remoteConnectionsGateSeen) {
      log('Remote connections gate 1042620455 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Remote connections gate 1042620455 is still present, but no supported ' +
        'patch pattern matched.',
      );
    }

    if (remoteConnectionsFeatureGateCount > 0) {
      log(
        'Remote connections feature flag gate bypassed for offline mode ' +
        `(${remoteConnectionsFeatureGateCount} occurrence(s)).`,
      );
    } else if (!remoteConnectionsFeatureGateSeen) {
      log('Remote connections feature gate 4114442250 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Remote connections feature gate 4114442250 is still present, but no ' +
        'supported patch pattern matched.',
      );
    }

    if (artifactElectronGatePatched) {
      log('Artifact Electron native functionality gate bypassed for offline mode.');
    } else if (!artifactElectronGateSeen) {
      log('Artifact Electron gate 839469903 is not present in this app version. No patch needed.');
    } else {
      warn(
        'Artifact Electron gate 839469903 is still present, but no supported ' +
        'patch pattern matched. Native artifact viewer may be unavailable.',
      );
    }

    if (fastModeGatePatched) {
      log('Fast mode speed selector gate bypassed for offline mode.');
    } else if (!fastModeGateSeen) {
      log('Fast mode gate (statsig_default_enable_features.fast_mode) is not present in this app version. No patch needed.');
    } else {
      warn(
        'Fast mode gate (statsig_default_enable_features.fast_mode) is still present, but no supported ' +
        'patch pattern matched. The Fast mode speed selector may be hidden in offline builds.',
      );
    }

    if (automationDialogCwdPatched) {
      log('Automation dialog cwd normalization patched for Windows.');
    } else {
      warn('Could not locate automation dialog cwd serialization. ' +
           'Future automation saves may still keep Windows namespace paths.');
    }
  } else {
    throw new Error(
      'webview/assets directory not found. Webview patch verification failed.',
    );
  }

  // Repack.
  log('Repacking asar…');
  // Back up the original.
  fs.renameSync(asarPath, asarPath + '.orig');
  await asar.createPackage(tmpDir, asarPath);
  // Remove backup only after successful repack.
  fs.rmSync(asarPath + '.orig', { force: true });

  // Disable asar integrity validation fuse in the Electron binary so it
  // accepts the modified asar without crashing on hash mismatch.
  const exePath = path.resolve(appDir, 'Codex.exe');
  log(`Flipping asar integrity fuse in ${path.basename(exePath)}…`);
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
  });
  log('Asar integrity fuse disabled.');

  log('Done.');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
