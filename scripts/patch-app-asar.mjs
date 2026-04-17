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
 *    config file in the system editor.
 *
 * 3. Fix enable_i18n default value inconsistency
 *    The settings page defaults enable_i18n to true (so the language selector
 *    is visible), but the i18n provider defaults it to false (so translations
 *    never load).  We unify the default to true.
 *
 * 4. Enable settings page entry for offline builds
 *    The settings menu item is gated behind a Statsig experiment that
 *    defaults to off when there is no network.  We bypass the gate so the
 *    entry is always visible in offline builds.
 *
 * 5. Enable Automations entry for offline builds
 *    The Automations sidebar item is gated behind Statsig experiment
 *    3075919032.  In offline mode Statsig cannot reach its servers, so the
 *    gate defaults to false and the entry is hidden even though all
 *    Automations UI is fully bundled.  We bypass the gate so the sidebar
 *    item is always visible in offline builds.
 *
 * 6. Enable pull requests sidebar entry for offline builds
 *    The pull requests nav link is also gated behind a Statsig experiment in
 *    newer builds.  We bypass that gate so the offline build does not hide
 *    the bundled route when Statsig cannot resolve experiments.
 *
 * 7. Enable scratchpad sidebar entry for offline builds
 *    Scratchpad is bundled in newer builds but hidden behind a separate
 *    Statsig gate.  We bypass that gate so the offline build exposes the
 *    same route and sidebar nav entry as the official package.
 *
 * 8. Normalize Windows automation cwd paths
 *    The packaged Automations UI can persist selected project paths in
 *    `\\?\C:\...` form on Windows.  Automation execution later compares that
 *    string against per-project config entries that use normal drive-letter
 *    paths, so approvals/sandbox settings fail to match and runs fall back to
 *    the wrong permissions.  We normalize those paths during execution, and
 *    strip the namespace prefix when the automation dialog saves selections.
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
  const AUTOMATION_RUNTIME_CWD_RE =
    /let (\w+)=(\w+)\.cwds;if\(\1\.length===0\)/;
  const AUTOMATION_RUNTIME_CWD_REPLACEMENT =
    'let $1=$2.cwds.map(e=>typeof e==`string`&&e.startsWith(`\\\\\\\\?\\\\`)&&/^[A-Za-z]:/.test(e.slice(4))?e.slice(4):e);if($1.length===0)';
  const AUTOMATION_RUNTIME_CWD_PATCH_MARKER =
    '.cwds.map(e=>typeof e==`string`&&e.startsWith(`\\\\\\\\?\\\\`)&&/^[A-Za-z]:/.test(e.slice(4))?e.slice(4):e)';

  const mainBuildDir = path.join(tmpDir, '.vite', 'build');
  const mainBundleFiles = Array.from(new Set([
    mainEntry,
    ...listJavaScriptFiles(mainBuildDir),
  ]));
  const settingsPatchedFiles = [];

  for (const filePath of mainBundleFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
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
    }

    if (patchedContent == null) continue;

    fs.writeFileSync(filePath, patchedContent, 'utf8');
    settingsPatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (settingsPatchedFiles.length > 0) {
    log(`Settings IPC handlers patched in ${settingsPatchedFiles.join(', ')}.`);
  } else {
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

  for (const filePath of mainBundleFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(AUTOMATION_RUNTIME_CWD_PATCH_MARKER)) {
      automationRuntimePatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    if (!AUTOMATION_RUNTIME_CWD_RE.test(content)) continue;

    const patchedContent = content.replace(
      AUTOMATION_RUNTIME_CWD_RE,
      AUTOMATION_RUNTIME_CWD_REPLACEMENT,
    );
    if (patchedContent === content) continue;

    fs.writeFileSync(filePath, patchedContent, 'utf8');
    automationRuntimePatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (automationRuntimePatchedFiles.length > 0) {
    log('Automation runtime cwd normalization patched in ' +
        `${automationRuntimePatchedFiles.join(', ')}.`);
  } else {
    warn('Could not locate automation runtime cwd handling. ' +
         'Automation permission patch skipped (the app version may have changed).');
  }

  // ── Patch 3: Fix enable_i18n default value inconsistency ─────────────
  //
  // The general-settings component checks enable_i18n with default true,
  // so the language selector is visible and usable.  However the i18n
  // provider that actually loads translations defaults the same flag to
  // false, meaning selected translations never load.  Unify to true so
  // language selection works end-to-end.

  const I18N_NEEDLE = '.get(`enable_i18n`,!1)';
  const I18N_REPLACEMENT = '.get(`enable_i18n`,!0)';

  // ── Patch 4: Enable settings page entry for offline builds ─────────
  //
  // The settings menu item in the profile dropdown is gated behind
  // Statsig experiment 4166894088.  In offline mode Statsig cannot reach
  // its servers, so the gate defaults to false and the entry is hidden
  // even though the settings pages are fully bundled.  We replace the
  // gate check result with `true` so the entry is always visible.

  const SETTINGS_GATE_RE =
    /(`4166894088`[^;]*;let\s+)(\w+)\s*=\s*\w+\((\w+)\)/;

  // ── Patch 5: Enable Automations sidebar entry for offline builds ────
  //
  // The Automations nav item in the sidebar is gated behind Statsig
  // experiment 3075919032.  Offline builds cannot reach Statsig servers,
  // so the gate defaults to false and the Automations entry disappears
  // even though the full Automations UI is bundled.  We bypass the gate
  // so the sidebar item is always visible in offline builds.

  const AUTOMATIONS_GATE_RE =
    /(`3075919032`[^;]*;let\s+)(\w+)\s*=\s*\w+\((\w+)\)/;
  const AUTOMATIONS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*\w+\(`3075919032`\)/;
  const PULL_REQUESTS_GATE_RE =
    /(`3789238711`[^;]*;let\s+)(\w+)\s*=\s*\w+\((\w+)\)/;
  const PULL_REQUESTS_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*\w+\(`3789238711`\)/;
  const PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{let\s+e=\(0,Q\.c\)\(3\),t;if\(e\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(t=`3789238711`,e\[0\]=t\):t=e\[0\],!xu\(t\)\)\{let\s+t;return\s+e\[1\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(t=\(0,\$\.jsx\)\(b,\{to:`\/`,replace:!0\}\),e\[1\]=t\):t=e\[1\],t\}let\s+n;return\s+e\[2\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(n=\(0,\$\.jsx\)\((\w+),\{\}\),e\[2\]=n\):n=e\[2\],n\}/;
  const SCRATCHPAD_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{let\s+\w+=\(0,\w+\.c\)\(1\),\w+;return\s+\w+\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=`2302560359`,\w+\[0\]=\w+\):\w+=\w+\[0\],\w+\(\w+\)\}/;
  const AUTOMATION_DIALOG_CWD_PATCHES = [
    {
      needle: 'function qd(e){return m(e.value)}',
      replacement:
        'function qd(e){let t=m(e.value);return typeof t==`string`&&t.startsWith(`\\\\\\\\?\\\\`)&&/^[A-Za-z]:/.test(t.slice(4))?t.slice(4):t}',
      patchMarker:
        'function qd(e){let t=m(e.value);return typeof t==`string`&&t.startsWith(`\\\\\\\\?\\\\`)&&/^[A-Za-z]:/.test(t.slice(4))?t.slice(4):t}',
    },
    {
      needle: 'e.cwds.map(ve)',
      replacement:
        'e.cwds.map(ve).map(e=>typeof e==`string`&&e.startsWith(`\\\\\\\\?\\\\`)&&/^[A-Za-z]:/.test(e.slice(4))?e.slice(4):e)',
      patchMarker:
        '.cwds.map(ve).map(e=>typeof e==`string`&&e.startsWith(`\\\\\\\\?\\\\`)&&/^[A-Za-z]:/.test(e.slice(4))?e.slice(4):e)',
    },
  ];

  const assetsDir = path.join(tmpDir, 'webview', 'assets');
  if (fs.existsSync(assetsDir)) {
    let i18nCount = 0;
    let gatePatched = false;
    let automationsGatePatched = false;
    let pullRequestsGatePatched = false;
    let pullRequestsRouteGatePatched = false;
    let scratchpadGatePatched = false;
    let automationDialogCwdPatched = false;

    for (const file of fs.readdirSync(assetsDir)) {
      if (!file.endsWith('.js')) continue;
      const filePath = path.join(assetsDir, file);
      let content = fs.readFileSync(filePath, 'utf8');
      let modified = false;

      if (content.includes(I18N_NEEDLE)) {
        const count = content.split(I18N_NEEDLE).length - 1;
        content = content.replaceAll(I18N_NEEDLE, I18N_REPLACEMENT);
        i18nCount += count;
        modified = true;
      }

      if (SETTINGS_GATE_RE.test(content)) {
        content = content.replace(SETTINGS_GATE_RE, '$1$2=!0');
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
      }

      if (PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(
          PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE,
          'function $1(){return(0,$.jsx)($2,{})}',
        );
        pullRequestsRouteGatePatched = true;
        modified = true;
      }

      if (SCRATCHPAD_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(SCRATCHPAD_GATE_FUNCTION_RE, 'function $1(){return!0}');
        scratchpadGatePatched = true;
        modified = true;
      }

      for (const patch of AUTOMATION_DIALOG_CWD_PATCHES) {
        if (content.includes(patch.patchMarker)) {
          automationDialogCwdPatched = true;
          break;
        }

        if (!content.includes(patch.needle)) continue;

        content = content.replace(
          patch.needle,
          patch.replacement,
        );
        automationDialogCwdPatched = true;
        modified = true;
        break;
      }

      if (modified) {
        fs.writeFileSync(filePath, content, 'utf8');
      }
    }

    if (i18nCount > 0) {
      log(`enable_i18n default unified (${i18nCount} occurrence(s)).`);
    } else {
      warn('Could not locate enable_i18n default-false pattern. ' +
           'i18n patch skipped (the app version may have changed).');
    }

    if (gatePatched) {
      log('Settings entry gate bypassed for offline mode.');
    } else {
      warn('Could not locate settings gate 4166894088. ' +
           'Settings entry patch skipped (the app version may have changed).');
    }

    if (automationsGatePatched) {
      log('Automation sidebar gate bypassed for offline mode.');
    } else {
      warn('Could not locate automation gate 3075919032. ' +
           'Automation sidebar patch skipped (the app version may have changed).');
    }

    if (pullRequestsGatePatched) {
      log('Pull requests sidebar gate bypassed for offline mode.');
    } else {
      warn('Could not locate pull requests gate 3789238711. ' +
           'Pull requests sidebar patch skipped (the app version may have changed).');
    }

    if (pullRequestsRouteGatePatched) {
      log('Pull requests route gate bypassed for offline mode.');
    } else {
      warn('Could not locate pull requests route gate 3789238711. ' +
           'Pull requests route patch skipped (the app version may have changed).');
    }

    if (scratchpadGatePatched) {
      log('Scratchpad gate bypassed for offline mode.');
    } else {
      warn('Could not locate scratchpad gate 2302560359. ' +
           'Scratchpad patch skipped (the app version may have changed).');
    }

    if (automationDialogCwdPatched) {
      log('Automation dialog cwd normalization patched for Windows.');
    } else {
      warn('Could not locate automation dialog cwd serialization. ' +
           'Future automation saves may still keep Windows namespace paths.');
    }
  } else {
    warn('webview/assets directory not found. Webview patches skipped.');
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
