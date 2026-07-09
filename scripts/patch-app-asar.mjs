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
 *    main-process entry point.  The same bootstrap patch also defaults the
 *    Windows Computer Use process environment gate so direct Codex.exe
 *    launches get the same runtime features as the provided launchers, and
 *    stubs the electron_browser_msix_updater native binding so that reading
 *    electron.autoUpdater (which windowsStore=true routes to the MSIX updater)
 *    does not abort standalone startup with "No such binding was linked".
 *
 * 2. Implement "show-settings" and "open-config-toml" IPC handlers
 *    The Electron build throws "not implemented" for these messages.  We
 *    replace the throw with real handlers: show-settings reloads the window
 *    with the appropriate initialRoute, and open-config-toml opens the TOML
 *    config file in the system editor.  Three variable-naming variants are
 *    handled (V1: message=t/wc=e, V2: message=r/wc=n, V3: message=i/wc=r).
 *
 * 3. Fix i18n defaults for offline builds
 *    The settings page defaults enable_i18n to true (so the language selector
 *    is visible), but the i18n provider defaults it to false (so translations
 *    never load) and prefers the IDE locale by default.  Offline desktop
 *    builds should default to the system locale instead.  We unify
 *    enable_i18n to true and switch the locale-source default to SYSTEM.
 *
 * 4-34. Renderer Statsig feature-gate unlocks (settings, automations, pull
 *    requests, scratchpad, slash commands, avatar overlay, artifacts,
 *    memories, dictation, chronicle, remote connections, etc.)
 *    Migrated to init.cjs runtime interception + the generic
 *    patchDirectStatsigGateCalls(..., DESKTOP_ASAR_KNOWN_GATE_IDS) pass. The
 *    per-gate asar needles were removed; each gate id lives in init.cjs
 *    STATSIG_GATE_OVERRIDES. See docs/plan-b-patch-migration-inventory.md.
 *
 * 35. Enable Fast mode speed selector for offline builds
 *    The "Fast / Standard" speed selector button in the model picker is
 *    gated by build-version-specific availability checks.  Older builds
 *    used a Statsig fast_mode check; newer builds hide the selector when
 *    the model list does not advertise the "fast" speed tier.  We keep the
 *    selector visible so users can switch back to Standard after selecting
 *    Fast.
 *
 * 35b. Show context usage status by default for offline builds
 *    The /status command toggles a local status section containing context
 *    usage.  Offline builds should expose it by default so users do not lose
 *    the conversation usage indicator.
 *
 * 36. Keep bundled browser plugins in the runtime marketplace
 *    Newer builds materialize only plugins whose feature availability checks
 *    are true. In offline/API mode browser feature flags can be false even
 *    though the browser-use and chrome plugins are bundled. We keep those
 *    descriptors available so @chrome is not removed at startup.
 *
 * 37. Enable external Chrome plugin mentions for offline builds
 *    The composer filters @chrome through the renderer-side
 *    browser_use_external availability check. In offline/API mode the online
 *    gate can be false even after the bundled Chrome plugin and native host
 *    are installed, so we bypass that renderer gate.
 *
 * 38-39. External agent config import & Plugins nav (API-key/offline)
 *    Renderer gates migrated to init.cjs; the per-gate asar needles were
 *    removed. verify-offline-package.ps1 keeps a dormant conditional tripwire
 *    (plugins-api-key-nav/route, codex-mobile-auth-relogin) that fails the
 *    build only if a future upstream bundle reintroduces the gated branch,
 *    signalling a rewrite against the new seam is due.
 *
 * 40. Keep offline runtime plugins in the materialized marketplace
 *    The desktop runtime copies only enabled bundled plugin descriptors into
 *    ~/.codex/.tmp/bundled-marketplaces/openai-bundled.  Office artifact
 *    plugins are injected into the bundled marketplace during packaging, so
 *    preserve those local entries even though the upstream app does not ship
 *    desktop feature descriptors for them.
 *
 * 41. Enable node_repl config for offline Computer Use
 *    Newer desktop builds synthesize Browser Use / Computer Use MCP config
 *    with features.js_repl disabled by default. Offline Windows builds need
 *    that flag enabled so the bundled Computer Use skill can call its
 *    official JavaScript entry point. The app's feature-default merge path
 *    must also preserve mcp_servers.* config keys instead of prefixing them
 *    as features.
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
 * Patch hardening principles (follow these when adding a patch — they exist so
 * an upstream bundle change fails the build instead of silently shipping a
 * broken package):
 *
 *   - Required vs optional. If a patch's absence breaks launch or a core
 *     feature, report a miss with failRequiredPatch() so the build fails before
 *     repacking; peripheral patches (diagnostics, resilience, legacy, non-core
 *     plugins) use warn(). A drift summary of both is printed each run.
 *   - Prefer stable interface boundaries over minified needles. Intercept at a
 *     durable seam — e.g. process._linkedBinding for the MSIX updater stub, or
 *     init.cjs IPC interception for Statsig gates — instead of string-replacing
 *     compiled tokens, which churn on every upstream build. This is the single
 *     most effective way to reduce per-release patch breakage.
 *   - When a needle is unavoidable, anchor on stable text (API names, error
 *     strings, gate IDs) rather than minified variable names, and keep the
 *     multi-variant fallbacks (V1/V2/V3) that absorb token churn.
 *   - Every required patch needs a matching assertion in
 *     verify-offline-package.ps1 (marker or behaviour) so a silent miss in this
 *     script is still caught downstream.
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
 *   1  Fatal error — asar not found, parse failure, or a required patch did not
 *      apply (the upstream bundle structure likely changed).
 */

import { createRequire } from 'module';
import { parseArgs } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { assertGateOverrideSync } from './check-gate-override-sync.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
const {
  DESKTOP_ASAR_PATCH_MARKERS,
  DESKTOP_ASAR_KNOWN_GATE_IDS,
  DESKTOP_BROWSER_USE_CAPABILITY_KEYS,
  CONTEXT_USAGE_CONTRACT,
  FAST_MODE_CONTRACT,
} = require('../web-gateway/gateway/src/ipc/codex/capabilityContractData.cjs');

const DESKTOP_ASAR_PATCH_MARKER_SET = new Set(DESKTOP_ASAR_PATCH_MARKERS);

function contractPatchMarker(marker) {
  if (!DESKTOP_ASAR_PATCH_MARKER_SET.has(marker)) {
    throw new Error(`Patch marker is not declared in capabilityContractData.cjs: ${marker}`);
  }
  return marker;
}

function minifiedTrueProperties(keys) {
  return keys.map(key => `${key}:!0`).join(',');
}

const DESKTOP_BROWSER_USE_CAPABILITY_PATCH_FIELDS =
  minifiedTrueProperties(DESKTOP_BROWSER_USE_CAPABILITY_KEYS);

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

// Optional patch misses are collected as well as printed so the end-of-run
// summary makes version drift visible: an optional needle failing today often
// foreshadows a required one failing on the next upstream bundle.
const optionalPatchWarnings = [];

function warn(msg) {
  optionalPatchWarnings.push(msg);
  console.warn(`[patch-app-asar] WARNING: ${msg}`);
}

// Required vs optional patch failures.
//
// A patch is "required" when its absence breaks core usability — launch, the
// settings page, Computer Use, or the bundled browser plugins. Those must fail
// the build instead of silently shipping a broken package. Optional patches
// (diagnostics, edge-case resilience, legacy migrations, non-core plugins) keep
// using warn(): their absence degrades a peripheral feature but the package
// still launches and works.
//
// Required failures are collected rather than thrown immediately so a single
// run surfaces every failure at once (an upstream restructure usually breaks
// several needles together); assertRequiredPatchesApplied() fails the build
// before the asar is repacked.
const requiredPatchFailures = [];

function failRequiredPatch(msg) {
  requiredPatchFailures.push(msg);
  console.error(`[patch-app-asar] REQUIRED PATCH FAILED: ${msg}`);
}

function assertRequiredPatchesApplied() {
  if (requiredPatchFailures.length === 0) {
    return;
  }
  throw new Error(
    `${requiredPatchFailures.length} required offline patch(es) failed to apply — ` +
    'the upstream bundle structure likely changed. Refusing to ship a ' +
    'crash-or-broken package:\n' +
    requiredPatchFailures.map((m) => `  - ${m}`).join('\n'),
  );
}

// Print a drift summary so CI surfaces how many patches missed this run, even
// when the build is allowed to proceed.
function logPatchDriftSummary() {
  const required = requiredPatchFailures.length;
  const optional = optionalPatchWarnings.length;
  if (required === 0 && optional === 0) {
    log('Patch drift summary: all patches applied or already correct.');
    return;
  }
  log(
    `Patch drift summary: ${required} required miss(es), ${optional} optional miss(es). ` +
    'Optional misses degrade peripheral features but do not block the build:',
  );
  for (const m of optionalPatchWarnings) {
    log(`  - [optional] ${m}`);
  }
  for (const m of requiredPatchFailures) {
    log(`  - [required] ${m}`);
  }
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
const LEGACY_ELECTRON_NAMESPACE_PATCH_MARKER =
  '/*codex-offline:electron-namespace-no-auto-updater*/';
const COMPUTER_USE_ENV_DEFAULT =
  'if(process.env.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE==null){' +
    'process.env.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE="1"' +
  '}\n';
// Neutralize the MSIX auto-updater native binding for portable launches.
// process.windowsStore=true makes Electron route electron.autoUpdater through
// the MSIX updater (lib/browser/api/auto-updater/auto-updater-msix.ts), whose
// module load calls process._linkedBinding("electron_browser_msix_updater").
// That binding is only linked inside a real MSIX container, so a standalone
// Codex.exe aborts at bootstrap with "No such binding was linked". Newer builds
// (>= 26.609) read electron.autoUpdater during startup via a __toESM namespace
// copy that the Sentry-breadcrumb needle patch does not cover, so we stub the
// binding itself: any electron_browser_msix_updater lookup returns a chainable
// no-op so the updater module loads (and stays inert) instead of crashing.
const MSIX_UPDATER_BINDING_STUB =
  '(function(){try{' +
    'if(process._codexOfflineMsixStub)return;' +
    'process._codexOfflineMsixStub=true;' +
    'var _lb=process._linkedBinding;' +
    'if(typeof _lb!=="function")return;' +
    'var _stub=new Proxy(function(){return _stub},{' +
      'get:function(_t,_p){return _p==="then"?undefined:_stub},' +
      'apply:function(){return _stub},' +
      'construct:function(){return _stub}' +
    '});' +
    'process._linkedBinding=function(_n){' +
      'if(_n==="electron_browser_msix_updater")return _stub;' +
      'return _lb.apply(this,arguments)' +
    '}' +
  '}catch(_e){}})();\n';
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
// Bootstrap snippet injected at the top of the main-process entry point.
// Includes a directory-walking require() that loads init.cjs from ../../patches/
// (relative to the asar entry) for IPC-level Statsig gate interception.
const PATCH_BOOTSTRAP_REQUIRE =
  'try{' +
    'var _codexOfflineD=__dirname,_codexOfflineP=require("path"),_codexOfflineF=require("fs");' +
    'for(var _codexOfflineI=0;_codexOfflineI<10;_codexOfflineI++){' +
      'var _codexOfflineC=_codexOfflineP.join(_codexOfflineD,"patches","init.cjs");' +
      'if(_codexOfflineF.existsSync(_codexOfflineC)){require(_codexOfflineC);break}' +
      'var _codexOfflineParent=_codexOfflineP.dirname(_codexOfflineD);' +
      'if(_codexOfflineParent===_codexOfflineD)break;' +
      '_codexOfflineD=_codexOfflineParent' +
    '}' +
  '}catch(_codexOfflineE){}' +
  '\n';
const PATCH_SNIPPET = `${PATCH_MARKER}\nif(!process.windowsStore){process.windowsStore=true;}\n${MSIX_UPDATER_BINDING_STUB}${COMPUTER_USE_ENV_DEFAULT}${EPIPE_GUARD}${PATCH_BOOTSTRAP_REQUIRE}`;

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

function refreshMainEntryPatch(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // Add Computer Use env default if missing from a prior build.
  if (!content.includes('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
    const windowsStoreLine = 'if(!process.windowsStore){process.windowsStore=true;}\n';
    if (content.includes(windowsStoreLine)) {
      content = content.replace(windowsStoreLine, windowsStoreLine + COMPUTER_USE_ENV_DEFAULT);
    } else {
      content = content.replace(PATCH_MARKER, `${PATCH_MARKER}\n${COMPUTER_USE_ENV_DEFAULT}`);
    }
    changed = true;
  }

  // Add the MSIX auto-updater binding stub if missing from a prior build.
  // Required for >= 26.609 portable startup (see MSIX_UPDATER_BINDING_STUB).
  if (!content.includes('_codexOfflineMsixStub')) {
    const windowsStoreLine = 'if(!process.windowsStore){process.windowsStore=true;}\n';
    if (content.includes(windowsStoreLine)) {
      content = content.replace(windowsStoreLine, windowsStoreLine + MSIX_UPDATER_BINDING_STUB);
    } else {
      content = content.replace(PATCH_MARKER, `${PATCH_MARKER}\n${MSIX_UPDATER_BINDING_STUB}`);
    }
    changed = true;
  }

  // Add init.cjs require() for IPC-level Statsig gate interception.
  if (!content.includes('_codexOfflineD')) {
    const epipeEnd = '_epipeGuard(process.stdout);_epipeGuard(process.stderr);';
    content = content.replace(epipeEnd, epipeEnd + '\n' + PATCH_BOOTSTRAP_REQUIRE);
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return changed;
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

const SETTINGS_SECTION_ROUTE_ALIASES = [
  ['general', 'general-settings'],
  ['git', 'git-settings'],
  ['plugins', 'plugins-settings'],
  ['skills', 'skills-settings'],
  ['mcp', 'mcp-settings'],
  ['hooks', 'hooks-settings'],
];
const SETTINGS_ROUTE_PATCH_MARKER =
  '/*codex-offline:settings-route-map*/';

function buildSettingsRouteMappingExpression(sectionVar) {
  return SETTINGS_SECTION_ROUTE_ALIASES.reduceRight(
    (fallback, [section, slug]) => (
      `${sectionVar}===\`${section}\`?\`${slug}\`:${fallback}`
    ),
    sectionVar,
  );
}

function buildSettingsRouteStatement(urlVar, messageVar) {
  const sectionVar = '_codexOfflineSettingsSection';
  return (
    `let ${sectionVar}=${messageVar}.section||"agent";` +
    `${urlVar}.searchParams.set("initialRoute","/settings/"+` +
    `${buildSettingsRouteMappingExpression(sectionVar)});` +
    `${SETTINGS_ROUTE_PATCH_MARKER}`
  );
}

function patchBundledBrowserPlugins(filePaths, options) {
  const patchedFiles = [];
  let seen = false;
  let alreadyCorrect = false;

  for (const filePath of filePaths) {
    let content = fs.readFileSync(filePath, 'utf8');
    const originalContent = content;
    options.syncExternalBrowserDescriptorRe.lastIndex = 0;
    const fileSeen =
      options.chromeDescriptorRe.test(originalContent) ||
      options.browserUseDescriptorRe.test(originalContent) ||
      options.syncExternalBrowserDescriptorRe.test(originalContent) ||
      options.inAppBrowserDescriptorRe.test(originalContent) ||
      options.chromeDescriptorPatchedRe.test(originalContent) ||
      options.browserUseDescriptorPatchedRe.test(originalContent) ||
      options.syncExternalBrowserDescriptorPatchedRe.test(originalContent) ||
      options.inAppBrowserDescriptorPatchedRe.test(originalContent);
    seen ||= fileSeen;

    if (!fileSeen) continue;

    if (originalContent.includes(options.patchMarker)) {
      alreadyCorrect = true;
    }

    if (options.chromeDescriptorRe.test(content)) {
      content = content.replace(
        options.chromeDescriptorRe,
        `{installWhenMissing:!0,$2${options.patchMarker}!0$6`,
      );
    }

    if (options.browserUseDescriptorRe.test(content)) {
      content = content.replace(
        options.browserUseDescriptorRe,
        `{autoInstallOptOutKey:$2.$3($2.$4),installWhenMissing:!0,name:$2.$4,isAvailable:({features:$5})=>${options.patchMarker}!0$7`,
      );
    }

    options.syncExternalBrowserDescriptorRe.lastIndex = 0;
    if (options.syncExternalBrowserDescriptorRe.test(content)) {
      options.syncExternalBrowserDescriptorRe.lastIndex = 0;
      content = content.replace(
        options.syncExternalBrowserDescriptorRe,
        (
          _match,
          nameExpr,
          params,
          _featuresVar,
          closingBrace,
        ) => (
          `{installWhenMissing:!0,name:${nameExpr},` +
          'syncInstallStateWithChromeExtension:!0,' +
          `isAvailable:({${params}})=>${options.patchMarker}!0${closingBrace}`
        ),
      );
    }

    if (options.inAppBrowserDescriptorRe.test(content)) {
      content = content.replace(
        options.inAppBrowserDescriptorRe,
        `{installWhenMissing:!0,name:$2.On,isAvailable:({buildFlavor:$3,features:$4})=>${options.patchMarker}!0$6`,
      );
    }

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content, 'utf8');
      patchedFiles.push(filePath);
    }
  }

  return { patchedFiles, seen, alreadyCorrect };
}

function patchBundledRuntimeMarketplaceFilter(filePaths, options) {
  const patchedFiles = [];
  let seen = false;
  let alreadyCorrect = false;
  const patchedPluginListRe =
    /for\(let (_codexOfflinePluginName) of (\[[^\]]*\])\)([A-Za-z_$][\w$]*)\.add\(\1\);/;

  for (const filePath of filePaths) {
    let content = fs.readFileSync(filePath, 'utf8');
    const originalContent = content;

    if (content.includes(options.patchMarker)) {
      seen = true;
      const pluginListMatch = content.match(patchedPluginListRe);
      const patchedPluginNames = pluginListMatch
        ? JSON.parse(pluginListMatch[2])
        : [];
      if (options.pluginNames.every(pluginName => patchedPluginNames.includes(pluginName))) {
        alreadyCorrect = true;
        continue;
      }

      content = content.replace(
        patchedPluginListRe,
        `for(let $1 of ${options.pluginNamesJson})$3.add($1);`,
      );
      if (content !== originalContent) {
        fs.writeFileSync(filePath, content, 'utf8');
        patchedFiles.push(filePath);
      }
      continue;
    }

    if (!options.filterRe.test(content)) continue;
    seen = true;
    content = content.replace(options.filterRe, (
      _match,
      functionName,
      argName,
      setName,
      pluginNamesProperty,
      pluginParam,
    ) => (
      `function ${functionName}(${argName}){` +
      `let ${setName}=new Set(${argName}.${pluginNamesProperty});` +
      `for(let _codexOfflinePluginName of ${options.pluginNamesJson})` +
      `${setName}.add(_codexOfflinePluginName);` +
      `return{...${argName}.marketplace,plugins:${argName}.marketplace.plugins.filter(` +
      `${pluginParam}=>${setName}.has(${pluginParam}.name))}}` +
      options.patchMarker
    ));

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content, 'utf8');
      patchedFiles.push(filePath);
    }
  }

  return { patchedFiles, seen, alreadyCorrect };
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function externalAgentConfigGateAliases(content) {
  const aliases = [];
  const gateExports = new Set(['i', 'n', 'r', 't']);
  const importRe = /import\{([^}]+)\}from"\.\/external-agent-config-gates-[^"]+\.js";/g;
  let match;

  while ((match = importRe.exec(content)) !== null) {
    for (const rawPart of match[1].split(',')) {
      const part = rawPart.trim();
      if (!part) continue;

      const aliasMatch = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!aliasMatch || !gateExports.has(aliasMatch[1])) continue;

      aliases.push(aliasMatch[2] || aliasMatch[1]);
    }
  }

  return aliases;
}

function patchExternalAgentConfigGateCalls(content, patchMarker) {
  let next = content;
  let count = 0;

  for (const alias of externalAgentConfigGateAliases(content)) {
    const twoArgGateCallRe = new RegExp(
      `(^|[^.\\w$])[$\\w]+\\([A-Za-z_$][\\w$]*\\s*,\\s*${escapeRegExp(alias)}\\)`,
      'g',
    );
    next = next.replace(twoArgGateCallRe, (_match, prefix) => {
      count += 1;
      return `${prefix}!0${patchMarker}`;
    });

    const gateCallRe = new RegExp(
      `(^|[^.\\w$])[$\\w]+\\(${escapeRegExp(alias)}\\)`,
      'g',
    );
    next = next.replace(gateCallRe, (_match, prefix) => {
      count += 1;
      return `${prefix}!0${patchMarker}`;
    });
  }

  return { content: next, count };
}

function patchExternalAgentConfigDirectGateCalls(content, gateIds, patchMarker) {
  let next = content;
  let count = 0;

  for (const gateId of gateIds) {
    const gateCallRe = new RegExp(
      `(?<!!)(?:\\(0,[$\\w]+\\)|[$\\w]+)\\(\`${gateId}\`\\)`,
      'g',
    );
    next = next.replace(gateCallRe, () => {
      count += 1;
      return `!0${patchMarker}`;
    });
  }

  return { content: next, count };
}

function patchDirectStatsigGateCalls(content, gateIds, patchMarker) {
  let next = content;
  let count = 0;

  for (const gateId of gateIds) {
    const escapedGateId = escapeRegExp(gateId);
    const negatedGateCallRe = new RegExp(
      `!(?:\\(0,[$\\w]+\\)|[$\\w]+)\\(\`${escapedGateId}\`\\)`,
      'g',
    );
    next = next.replace(negatedGateCallRe, () => {
      count += 1;
      return `!1${patchMarker}`;
    });

    const gateCallRe = new RegExp(
      `(?<!!)(?:\\(0,[$\\w]+\\)|[$\\w]+)\\(\`${escapedGateId}\`\\)`,
      'g',
    );
    next = next.replace(gateCallRe, () => {
      count += 1;
      return `!0${patchMarker}`;
    });
  }

  return { content: next, count };
}

function patchExternalAgentConfigGateIdLiterals(content, gateIds, patchMarker) {
  let next = content;
  let count = 0;

  for (const gateId of gateIds) {
    const literal = '`' + gateId + '`';
    if (!next.includes(literal)) continue;

    const splitAt = Math.floor(gateId.length / 2);
    const replacement =
      '`' + gateId.slice(0, splitAt) + '`+`' + gateId.slice(splitAt) + '`' +
      patchMarker;
    const occurrences = countOccurrences(next, literal);
    next = next.replaceAll(literal, replacement);
    count += occurrences;
  }

  return { content: next, count };
}

function patchChromePluginScripts(rootAppDir) {
  const chromePluginRoot = path.join(
    rootAppDir,
    'resources',
    'plugins',
    'openai-bundled',
    'plugins',
    'chrome',
  );
  if (!fs.existsSync(chromePluginRoot)) {
    failRequiredPatch('Bundled Chrome plugin was not found. Chrome plugin script patches skipped.');
    return;
  }

  patchChromeBrowserClient(path.join(chromePluginRoot, 'scripts', 'browser-client.mjs'));
  patchChromeNativeHostCheck(path.join(chromePluginRoot, 'scripts', 'check-native-host-manifest.js'));
  patchChromeSkillInstructions(chromePluginRoot);

  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(chromePluginRoot, 'scripts', 'browser-client.mjs')))
    .digest('hex');
}

function patchChromeBrowserClient(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Chrome browser client was not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  const nativePipeSymbols = {
    bridgeGetter: null,
    unavailableMessage: null,
    platform: null,
    pipePrefix: null,
  };
  const removeStaleTimeoutPatch = (needle, replacement, message) => {
    if (content.includes(needle)) {
      content = content.replace(needle, replacement);
      changed = true;
      log(message);
    }
  };

  const discoveryTimeoutPatchMarker = '/*codex-offline:browser-use-discovery-timeout*/';
  const profileMetadataTimeoutPatchMarker =
    '/*codex-offline:browser-use-profile-metadata-timeout*/';
  const originalDiscoveryFlow =
    'async function _O(t,e){let r=null,n="pipe-connect";try{' +
    'let o=await kc.create(t);r=e(o),n="backend-info-request";' +
    'let i=await r.getInfo(),s=await LS(i).catch(a=>(ee(a),i));' +
    'return{browser:{id:crypto.randomUUID().substring(8),api:r,info:xO(s)}}}' +
    'catch(o){return await r?.close(),ee(o),{failure:`${n}/${jS(o)}`}}}';
  const discoveryTimeoutFlow =
    'async function _O(t,e){let r=null,n="pipe-connect";try{' +
    'let o=await _codexOfflineBrowserUseDiscoveryTimeout(kc.create(t),"pipe-connect");' +
    'r=e(o),n="backend-info-request";' +
    'let i=await _codexOfflineBrowserUseDiscoveryTimeout(r.getInfo(),"backend-info-request"),' +
    's=await _codexOfflineBrowserUseDiscoveryTimeout(LS(i),"profile-metadata",2e3).catch(a=>(ee(a),i));' +
    'return{browser:{id:crypto.randomUUID().substring(8),api:r,info:xO(s)}}}' +
    'catch(o){return await r?.close(),ee(o),{failure:`${n}/${jS(o)}`}}}';
  const discoveryTimeoutFlowWithProfileMarker =
    discoveryTimeoutFlow.replace(
      '"profile-metadata",2e3).catch(a=>(ee(a),i));',
      `"profile-metadata",2e3).catch(a=>(ee(a),i));${profileMetadataTimeoutPatchMarker}`,
    );
  const discoveryTimeoutHelper =
    `var _codexOfflineBrowserUseDiscoveryTimeout=(t,e,r=8e3)=>new Promise((n,o)=>{` +
    `let i=setTimeout(()=>o(new Error(\`${'${e}'} timed out after ${'${r}'}ms\`)),r);` +
    `Promise.resolve(t).then(s=>{clearTimeout(i),n(s)},s=>{clearTimeout(i),o(s)})});` +
    discoveryTimeoutPatchMarker;
  removeStaleTimeoutPatch(
    discoveryTimeoutFlowWithProfileMarker,
    originalDiscoveryFlow,
    'Removed stale Chrome browser client discovery/profile timeout patch.',
  );
  removeStaleTimeoutPatch(
    discoveryTimeoutFlow,
    originalDiscoveryFlow,
    'Removed stale Chrome browser client discovery timeout patch.',
  );
  removeStaleTimeoutPatch(
    discoveryTimeoutHelper,
    '',
    'Removed stale Chrome browser client discovery timeout helper.',
  );
  removeStaleTimeoutPatch(
    `s=await _codexOfflineBrowserUseDiscoveryTimeout(LS(i),"profile-metadata",2e3).catch(a=>(ee(a),i));${profileMetadataTimeoutPatchMarker}`,
    's=await LS(i).catch(a=>(ee(a),i));',
    'Removed stale Chrome browser client profile metadata timeout patch.',
  );

  const nativePipeFallbackPatchMarker =
    '/*codex-offline:browser-use-native-pipe-fallback*/';
  const nativePipeDirectPatchMarker =
    '/*codex-offline:browser-use-native-pipe-direct*/';
  const nativePipeDirectCreateReplacement =
    `static async create(e){if(_codexOfflineShouldUseNativePipeFallback(e)){let r=await _codexOfflineCreateNativePipeConnection(e);return new t(r)}let r=Wf();if(r!=null){let n=await _codexOfflineBridgeCreateConnection(r,e);return new t(n)}throw new Error(Vf())}${nativePipeDirectPatchMarker}`;
  const nativePipeHelpersWithoutTimeout =
    'function _codexOfflineBridgeCreateConnection(t,e){return t.createConnection(e)}' +
    'async function _codexOfflineCreateNativePipeConnection(t){let{createConnection:e}=await import("node:net");return e(t)}';
  removeStaleTimeoutPatch(
    'function _codexOfflineNativePipeConnectTimeoutMs(){let t=Number(globalThis.nodeRepl?.requestMeta?.["x-codex-native-pipe-connect-timeout-ms"]);return Number.isFinite(t)&&t>0?t:1e3}' +
    'function _codexOfflineBridgeCreateConnection(t,e){let r=_codexOfflineNativePipeConnectTimeoutMs();return new Promise((n,o)=>{let i=setTimeout(()=>o(new Error(`native pipe bridge timed out after ${r}ms`)),r);Promise.resolve(t.createConnection(e)).then(s=>{clearTimeout(i),n(s)},s=>{clearTimeout(i),o(s)})})}' +
    'async function _codexOfflineCreateNativePipeConnection(t){let{createConnection:e}=await import("node:net"),r=_codexOfflineNativePipeConnectTimeoutMs();return await new Promise((n,o)=>{let i=e(t),s=!1,a=setTimeout(()=>u(new Error(`native pipe connect timed out after ${r}ms`)),r);function u(c,d){if(s)return;s=!0,clearTimeout(a),i.off("connect",l),i.off("error",u),c?(i.destroy(),o(c)):n(d)}function l(){u(null,i)}i.once("connect",l),i.once("error",u)})}',
    nativePipeHelpersWithoutTimeout,
    'Removed stale Chrome browser client native pipe timeout helpers.',
  );
  if (content.includes(nativePipeDirectPatchMarker)) {
    log('Chrome browser client native pipe direct path already patched.');
  } else if (content.includes(nativePipeFallbackPatchMarker)) {
    const fallbackFirstCreateNeedles = [
      'static async create(e){let r=Wf();if(r!=null)try{let n=await _codexOfflineBridgeCreateConnection(r,e);return new t(n)}catch(n){if(!_codexOfflineShouldUseNativePipeFallback(e))throw n}if(_codexOfflineShouldUseNativePipeFallback(e)){let n=await _codexOfflineCreateNativePipeConnection(e);return new t(n)}throw new Error(Vf())}',
      'static async create(e){if(_codexOfflineShouldUseNativePipeFallback(e)){let r=await _codexOfflineCreateNativePipeConnection(e);return new t(r)}let r=Wf();if(r!=null){let n=await _codexOfflineBridgeCreateConnection(r,e);return new t(n)}throw new Error(Vf())}',
    ];
    const fallbackFirstCreateNeedle = fallbackFirstCreateNeedles.find(
      needle => content.includes(needle),
    );
    if (!fallbackFirstCreateNeedle) {
      throw new Error(
        'Could not locate Chrome browser-client native pipe fallback flow to upgrade.',
      );
    }

    content = content.replace(fallbackFirstCreateNeedle, nativePipeDirectCreateReplacement);
    changed = true;
    log('Chrome browser client native pipe fallback upgraded to direct Windows path.');
  } else {
    const helperNeedleMatch = content.match(
      /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=import\.meta\.__codexNativePipe;return \2==null\|\|typeof \2\.createConnection!="function"\?null:\2\}/,
    ) ?? content.match(
      /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=globalThis\.nodeRepl\?\.nativePipe;return \2==null\|\|typeof \2\.createConnection!="function"\?null:\2\}/,
    );
    const unavailableMessageMatch = content.match(
      /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=import\.meta\.__codexNativePipeUnavailableMessage;return typeof \2=="string"&&\2\.length>0\?\2:"privileged native pipe bridge is not available; browser-client is not trusted"\}/,
    ) ?? content.match(
      /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\(\);return \2\?`privileged native pipe bridge is not available; browser-client is not trusted\. Load browser-client from the \$\{\2\} marketplace directory\.`:"privileged native pipe bridge is not available; browser-client is not trusted"\}/,
    ) ?? content.match(
      /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)="privileged native pipe bridge is not available; browser-client is not trusted";return [A-Za-z_$][\w$]*\(\)==="production"\?\2:`\$\{\2\}[^`]*`\}/,
    );
    const platformImportMatch = content.match(
      /import [A-Za-z_$][\w$]*,\{platform as ([A-Za-z_$][\w$]*)\}from"node:os";/,
    ) ?? content.match(
      /import\{platform as ([A-Za-z_$][\w$]*)\}from"node:os";/,
    );
    const pipePrefixMatch = content.match(
      /var ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>\2==="win32"\?"[^"]*codex-browser-use":"\/tmp\/codex-browser-use"/,
    );
    if (!helperNeedleMatch || !unavailableMessageMatch || !platformImportMatch || !pipePrefixMatch) {
      throw new Error(
        'Could not locate Chrome browser-client native pipe symbols to add Windows fallback.',
      );
    }

    nativePipeSymbols.bridgeGetter = helperNeedleMatch[1];
    nativePipeSymbols.unavailableMessage = unavailableMessageMatch[1];
    nativePipeSymbols.platform = platformImportMatch[1];
    nativePipeSymbols.pipePrefix = pipePrefixMatch[1];

    const helperNeedle = helperNeedleMatch[0];
    const helperReplacement =
      helperNeedle +
      `function _codexOfflineShouldUseNativePipeFallback(t){return ${nativePipeSymbols.platform}()==="win32"&&typeof t=="string"&&t.startsWith(${nativePipeSymbols.pipePrefix}("win32"))}` +
      nativePipeHelpersWithoutTimeout +
      nativePipeFallbackPatchMarker;
    const createNeedleMatch = content.match(
      new RegExp(
        `static async create\\(([A-Za-z_$][\\w$]*)\\)\\{` +
        `let ([A-Za-z_$][\\w$]*)=${escapeRegExp(nativePipeSymbols.bridgeGetter)}\\(\\);` +
        `if\\(\\2!=null\\)\\{let ([A-Za-z_$][\\w$]*)=await \\2\\.createConnection\\(\\1\\);` +
        `return new ([A-Za-z_$][\\w$]*)\\(\\3\\)\\}` +
        `throw new Error\\(${escapeRegExp(nativePipeSymbols.unavailableMessage)}\\(\\)\\)\\}`,
      ),
    );

    if (!content.includes(helperNeedle) || !createNeedleMatch) {
      throw new Error(
        'Could not locate Chrome browser-client native pipe transport to add Windows fallback.',
      );
    }

    const [
      createNeedle,
      pipeArg,
      bridgeVar,
      connectionVar,
      constructorVar,
    ] = createNeedleMatch;
    const createReplacement =
      `static async create(${pipeArg}){` +
      `if(_codexOfflineShouldUseNativePipeFallback(${pipeArg})){` +
      `let ${bridgeVar}=await _codexOfflineCreateNativePipeConnection(${pipeArg});` +
      `return new ${constructorVar}(${bridgeVar})}` +
      `let ${bridgeVar}=${nativePipeSymbols.bridgeGetter}();` +
      `if(${bridgeVar}!=null){` +
      `let ${connectionVar}=await _codexOfflineBridgeCreateConnection(${bridgeVar},${pipeArg});` +
      `return new ${constructorVar}(${connectionVar})}` +
      `throw new Error(${nativePipeSymbols.unavailableMessage}())}` +
      nativePipeDirectPatchMarker;

    content = content
      .replace(helperNeedle, helperReplacement)
      .replace(createNeedle, createReplacement);
    changed = true;
    log('Chrome browser client native pipe direct path patched.');
  }

  const diagnosticsPatchMarker =
    '/*codex-offline:browser-use-discovery-diagnostics*/';
  if (content.includes(diagnosticsPatchMarker)) {
    log('Chrome browser client discovery diagnostics already patched.');
  } else {
    const legacyDiagnosticsNeedle =
      'let e=t,r=new Ac,n=p=>new Rc(p,r,Gr),{browsers:o,diagnostics:i}=await US(n),s=await HO(o),a=s.map(p=>new Tc(p.api,p.id,p.info));';
    const legacyDiagnosticsReplacement =
      'let e=t,r=new Ac,n=p=>new Rc(p,r,Gr),{browsers:o,diagnostics:i}=await US(n);' +
      `e.__codexBrowserUseDiagnostics=i;${diagnosticsPatchMarker}` +
      'let s=await HO(o),a=s.map(p=>new Tc(p.api,p.id,p.info));';
    const currentDiagnosticsMatch = content.match(
      /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*);try\{if\(([A-Za-z_$][\w$]*)\(\)==null\)throw new Error\(([A-Za-z_$][\w$]*)\(\)\);([A-Za-z_$][\w$]*)\(\);let ([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*);\(\{browsers:([A-Za-z_$][\w$]*),diagnostics:([A-Za-z_$][\w$]*)\}=await ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)=>new ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\)\),([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\}/,
    );
    const currentCandidateDiagnosticsMatch = content.match(
      /,([A-Za-z_$][\w$]*)=\{backendCounts:[\s\S]*?pipeListingPipeCount:[A-Za-z_$][\w$]*\.pipes\.length\},([A-Za-z_$][\w$]*=)/,
    );

    if (content.includes(legacyDiagnosticsNeedle)) {
      content = content.replace(legacyDiagnosticsNeedle, legacyDiagnosticsReplacement);
    } else if (currentDiagnosticsMatch) {
      const [
        diagnosticsNeedle,
        globalsAlias,
        globalsParam,
        browsersVar,
        diagnosticsVar,
      ] = currentDiagnosticsMatch;
      const filteredBrowsersVar = currentDiagnosticsMatch[19];
      const diagnosticsReplacement = diagnosticsNeedle.replace(
        `))),${filteredBrowsersVar}=`,
        `)));${globalsAlias}.__codexBrowserUseDiagnostics=${diagnosticsVar};${diagnosticsPatchMarker}${filteredBrowsersVar}=`,
      );
      if (!diagnosticsReplacement.includes(diagnosticsPatchMarker)) {
        throw new Error(
          'Could not prepare Chrome browser-client discovery diagnostics replacement.',
        );
      }
      content = content.replace(diagnosticsNeedle, diagnosticsReplacement);
      void globalsParam;
      void browsersVar;
    } else if (currentCandidateDiagnosticsMatch) {
      const [diagnosticsNeedle, diagnosticsVar, nextBinding] =
        currentCandidateDiagnosticsMatch;
      const diagnosticsReplacement = diagnosticsNeedle.replace(
        `,${nextBinding}`,
        `;globalThis.__codexBrowserUseDiagnostics=${diagnosticsVar};${diagnosticsPatchMarker}let ${nextBinding}`,
      );
      if (!diagnosticsReplacement.includes(diagnosticsPatchMarker)) {
        throw new Error(
          'Could not prepare Chrome browser-client candidate diagnostics replacement.',
        );
      }
      content = content.replace(diagnosticsNeedle, diagnosticsReplacement);
    } else {
      throw new Error(
        'Could not locate Chrome browser-client setup flow to expose discovery diagnostics.',
      );
    }

    changed = true;
    log('Chrome browser client discovery diagnostics patched.');
  }

  const chromePipeFilterPatchMarker =
    '/*codex-offline:browser-use-chrome-pipe-filter*/';
  if (content.includes(chromePipeFilterPatchMarker)) {
    log('Chrome browser client Windows Chrome pipe filter already patched.');
  } else {
    const pipeListMatch = content.match(
      /([A-Za-z_$][\w$]*)=async\(\)=>\{let ([A-Za-z_$][\w$]*)="\\\\\\\\\.\\\\pipe\\\\";return\(await ([A-Za-z_$][\w$]*)\(\2\)\)\.map\(([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\.resolve\(\2,\4\)\)\.filter\(([A-Za-z_$][\w$]*)=>\6\.startsWith\(([A-Za-z_$][\w$]*)\)\)\}/,
    );
    if (!pipeListMatch) {
      throw new Error(
        'Could not locate Chrome browser-client Windows pipe listing flow.',
      );
    }

    const [
      pipeListNeedle,
      listFunction,
      rootVar,
      readdirFunction,
      entryVar,
      pathModule,
      pipeVar,
      pipePrefixVar,
    ] = pipeListMatch;
    const pipeListReplacement =
      `${listFunction}=async()=>{let ${rootVar}="\\\\\\\\.\\\\pipe\\\\";` +
      `let _codexOfflineBrowserUsePipes=(await ${readdirFunction}(${rootVar})).map(${entryVar}=>${pathModule}.resolve(${rootVar},${entryVar})).filter(${pipeVar}=>${pipeVar}.startsWith(${pipePrefixVar}));` +
      `let _codexOfflineChromePipes=_codexOfflineBrowserUsePipes.filter(${pipeVar}=>${pipeVar}.startsWith(${pipePrefixVar}+"\\\\"));` +
      `return(_codexOfflineChromePipes.length>0?_codexOfflineChromePipes:_codexOfflineBrowserUsePipes)}` +
      chromePipeFilterPatchMarker;
    content = content.replace(pipeListNeedle, pipeListReplacement);
    changed = true;
    log('Chrome browser client Windows Chrome pipe filter patched.');
  }

  const directSetupPatchMarker =
    '/*codex-offline:browser-use-direct-setup*/';
  if (content.includes(directSetupPatchMarker)) {
    log('Chrome browser client direct Windows pipe setup already patched.');
  } else {
    const shouldUseFallbackMatch = content.match(
      /function _codexOfflineShouldUseNativePipeFallback\(([A-Za-z_$][\w$]*)\)\{return ([A-Za-z_$][\w$]*)\(\)==="win32"&&typeof \1=="string"&&\1\.startsWith\(([^{}]+)\)\}/,
    );
    if (!shouldUseFallbackMatch) {
      throw new Error(
        'Could not locate Chrome browser-client native pipe fallback helper.',
      );
    }

    const directSetupHelperNeedle = shouldUseFallbackMatch[0];
    const platformFunction = shouldUseFallbackMatch[2];
    const directSetupHelperReplacement =
      directSetupHelperNeedle +
      `function _codexOfflineCanUseNativePipeDirect(){return ${platformFunction}()==="win32"}`;
    const directSetupGuardMatch = content.match(
      /if\(([A-Za-z_$][\w$]*)\(\)==null\)throw new Error\(([A-Za-z_$][\w$]*)\(\)\);?/,
    );
    if (!directSetupGuardMatch) {
      throw new Error(
        'Could not locate Chrome browser-client setup guard to enable direct Windows pipe setup.',
      );
    }

    const [
      directSetupGuardNeedle,
      bridgeGetter,
      unavailableMessage,
    ] = directSetupGuardMatch;
    const directSetupGuardReplacement =
      `if(${bridgeGetter}()==null&&!_codexOfflineCanUseNativePipeDirect())throw new Error(${unavailableMessage}());${directSetupPatchMarker}`;
    content = content
      .replace(directSetupHelperNeedle, directSetupHelperReplacement)
      .replace(directSetupGuardNeedle, directSetupGuardReplacement);
    changed = true;
    log('Chrome browser client direct Windows pipe setup patched.');
  }

  const requestTimeoutPatchMarker =
    '/*codex-offline:browser-use-request-timeout*/';
  const requestTimeoutNeedle =
    'sendRequest(e,r){let n=this.nextId++;return new Promise((o,i)=>{this.pendingRequests.set(n,{resolve:o,reject:i});try{this.transport.sendMessage({jsonrpc:"2.0",method:e.toString(),params:r,id:n})}catch(s){this.pendingRequests.delete(n),i(s)}})}';
  const requestTimeoutReplacement =
    'sendRequest(e,r){let n=this.nextId++,o=_codexOfflineBrowserUseRequestTimeoutMs(e,r);return new Promise((i,s)=>{let a=setTimeout(()=>{this.pendingRequests.delete(n),s(new Error(`${String(e)} timed out after ${o}ms`))},o);this.pendingRequests.set(n,{resolve:u=>{clearTimeout(a),i(u)},reject:u=>{clearTimeout(a),s(u)}});try{this.transport.sendMessage({jsonrpc:"2.0",method:e.toString(),params:r,id:n})}catch(u){clearTimeout(a),this.pendingRequests.delete(n),s(u)}})}';
  removeStaleTimeoutPatch(
    'function _codexOfflineBrowserUseRequestTimeoutMs(t,e){let r=Number(e?.client_timeout_ms??globalThis.nodeRepl?.requestMeta?.["x-codex-browser-use-request-timeout-ms"]);if(Number.isFinite(r)&&r>0)return r;let n=String(t);return /^(ping|getInfo|getTabs|getUserTabs|getUserHistory|claimUserTab|createTab|finalizeTabs|nameSession)$/.test(n)?15e3:12e4}' +
    requestTimeoutPatchMarker,
    '',
    'Removed stale Chrome browser client responsive request timeout helper.',
  );
  removeStaleTimeoutPatch(
    'function _codexOfflineBrowserUseRequestTimeoutMs(t,e){let r=Number(e?.client_timeout_ms??globalThis.nodeRepl?.requestMeta?.["x-codex-browser-use-request-timeout-ms"]);return Number.isFinite(r)&&r>0?r:1e4}' +
    requestTimeoutPatchMarker,
    '',
    'Removed stale Chrome browser client request timeout helper.',
  );
  removeStaleTimeoutPatch(
    requestTimeoutReplacement,
    requestTimeoutNeedle,
    'Removed stale Chrome browser client JSON-RPC request timeout patch.',
  );

  const ambientNetworkPatchMarker =
    '/*codex-offline:browser-use-disable-ambient-network-default*/';
  if (content.includes(ambientNetworkPatchMarker)) {
    log('Chrome browser client ambient network default already patched.');
  } else {
    const requestMetaAmbientNetworkMatch = content.match(
      /function ([A-Za-z_$][\w$]*)\(\)\{return globalThis\.nodeRepl\?\.requestMeta\?\.\[([A-Za-z_$][\w$]*)\]===!0\}/,
    );
    let ambientNetworkNeedle = null;
    let ambientNetworkReplacement = null;

    if (requestMetaAmbientNetworkMatch) {
      const [
        needle,
        ambientNetworkFunction,
        ambientNetworkHeader,
      ] = requestMetaAmbientNetworkMatch;

      ambientNetworkNeedle = needle;
      ambientNetworkReplacement =
        `function ${ambientNetworkFunction}(){let t=globalThis.nodeRepl?.requestMeta?.[${ambientNetworkHeader}];return t===!1?!1:!0}${ambientNetworkPatchMarker}`;
    } else {
      const ambientEnvVarMatch = content.match(
        /([A-Za-z_$][\w$]*)="BROWSER_USE_DISABLE_AMBIENT_NETWORK"/,
      );
      const ambientEnvVar = ambientEnvVarMatch?.[1];
      const envGuardMatch = ambientEnvVar
        ? content.match(
          new RegExp(
            `function ([A-Za-z_$][\\w$]*)\\(\\)\\{return ([A-Za-z_$][\\w$]*)\\(${escapeRegExp(ambientEnvVar)}\\)\\}`,
          ),
        )
        : null;
      const booleanReader = envGuardMatch?.[2];
      const rawReaderMatch = booleanReader
        ? content.match(
          new RegExp(
            `function ${escapeRegExp(booleanReader)}\\(([A-Za-z_$][\\w$]*)\\)\\{return ([A-Za-z_$][\\w$]*)\\(\\1\\)==="1"\\}`,
          ),
        )
        : null;
      const rawReader = rawReaderMatch?.[2];

      if (envGuardMatch && rawReader && ambientEnvVar) {
        ambientNetworkNeedle = envGuardMatch[0];
        ambientNetworkReplacement =
          `function ${envGuardMatch[1]}(){let t=${rawReader}(${ambientEnvVar});return t==="0"||t==="false"?!1:!0}${ambientNetworkPatchMarker}`;
      }
    }

    if (!ambientNetworkNeedle || !ambientNetworkReplacement) {
      throw new Error(
        'Could not locate Chrome browser-client ambient network guard to default offline.',
      );
    }

    content = content.replace(ambientNetworkNeedle, ambientNetworkReplacement);
    changed = true;
    log('Chrome browser client ambient network default patched.');
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function patchChromeNativeHostCheck(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Chrome native host check script was not found: ${filePath}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');
  const patchMarker = '/*codex-offline:localized-registry-default*/';
  if (content.includes(patchMarker)) {
    log('Chrome native host registry parser already patched.');
    return;
  }

  const needle = 'return readRegistryValue(output, "(Default)");';
  const replacement =
    `return readRegistryValue(output, "(Default)") ?? ` +
    `readRegistryDefaultValueFromVeOutput(output);${patchMarker}`;
  if (!content.includes(needle)) {
    throw new Error(
      'Could not locate Chrome native host registry parser return path.',
    );
  }

  const insertBefore = 'function getNativeHostManifestLocationProblem';
  const fallbackFunction =
    '\nfunction readRegistryDefaultValueFromVeOutput(output) {\n' +
    '  for (const line of output.split(/\\r?\\n/)) {\n' +
    '    const match = line.match(/^\\s*.*?\\s+REG_\\w+\\s+(.+?)\\s*$/);\n' +
    '    if (match) return stripRegistryString(match[1]);\n' +
    '  }\n' +
    '\n' +
    '  return null;\n' +
    '}\n';
  if (!content.includes(insertBefore)) {
    throw new Error(
      'Could not locate Chrome native host manifest problem helper.',
    );
  }

  content = content
    .replace(needle, replacement)
    .replace(insertBefore, fallbackFunction + insertBefore);
  fs.writeFileSync(filePath, content, 'utf8');
  log('Chrome native host registry parser patched for localized Windows output.');
}

function findChromeSkillInstructions(chromePluginRoot) {
  const skillsRoot = path.join(chromePluginRoot, 'skills');
  if (!fs.existsSync(skillsRoot)) {
    return null;
  }

  const skillPaths = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (fs.existsSync(candidate)) {
      skillPaths.push(candidate);
    }
  }

  return skillPaths.find(candidate => {
    const content = fs.readFileSync(candidate, 'utf8');
    return content.includes('scripts/browser-client.mjs');
  }) ?? null;
}

function patchChromeSkillInstructions(chromePluginRoot) {
  const filePath = findChromeSkillInstructions(chromePluginRoot);
  if (!filePath) {
    throw new Error(`Chrome skill instructions were not found under: ${chromePluginRoot}`);
  }

  let content = fs.readFileSync(filePath, 'utf8');
  const patchMarker = '<!-- codex-offline:trusted-marketplace-browser-client -->';
  if (content.includes(patchMarker)) {
    log('Chrome skill trusted marketplace bootstrap already patched.');
    return;
  }

  const needle =
    /The `browser-client` module is the core entry point for browser use, and is available under `scripts\/browser-client\.mjs` in this plugin's root directory\. ALWAYS import it using an absolute path\.\r?\nIMPORTANT: If this path cannot be found, stop and report that this plugin is missing `scripts\/browser-client\.mjs`\. NEVER use the built in `browser-client` library\./;
  const matched = content.match(needle)?.[0];
  const replacement =
    `${matched}\n\n` +
    `${patchMarker}\n` +
    'In bundled/offline desktop sessions, the trusted browser-client path is the `openai-bundled` runtime marketplace copy, not the persistent plugin cache. Prefer this root when it exists: `<codex home>/.tmp/bundled-marketplaces/openai-bundled/plugins/chrome`. Resolve `<codex home>` from `process.env.CODEX_HOME` or the user home `.codex` directory, then import `scripts/browser-client.mjs` from that root. Fall back to this skill plugin root only when the runtime marketplace copy does not exist.';

  if (!matched) {
    log("WARNING: Could not locate Chrome skill browser-client bootstrap paragraph (app version may have changed). Skipping.");
    optionalPatchWarnings.push("chrome-skill-browser-client-bootstrap");
    return;
  }

  content = content.replace(needle, replacement);
  fs.writeFileSync(filePath, content, 'utf8');
  log('Chrome skill trusted marketplace bootstrap patched.');
}

function patchTrustedBrowserClientHashes(filePaths, chromeBrowserClientHash) {
  const patchedFiles = [];
  let alreadyCorrect = false;
  const trustedHashesRe =
    /var ([A-Za-z_$][\w$]*)=\[((?:`[a-f0-9]{64}`)(?:,`[a-f0-9]{64}`)*)\]/;

  for (const filePath of filePaths) {
    let content = fs.readFileSync(filePath, 'utf8');
    const match = content.match(trustedHashesRe);
    if (!match) continue;

    const hashes = new Set(Array.from(match[2].matchAll(/`([a-f0-9]{64})`/g), item => item[1]));
    if (hashes.has(chromeBrowserClientHash)) {
      alreadyCorrect = true;
      continue;
    }

    content = content.replace(
      match[0],
      `var ${match[1]}=[${Array.from(hashes).map(hash => `\`${hash}\``).join(',')},\`${chromeBrowserClientHash}\`]`,
    );
    fs.writeFileSync(filePath, content, 'utf8');
    patchedFiles.push(filePath);
  }

  return { patchedFiles, alreadyCorrect };
}

function isMissingUnpackedFileError(error) {
  return error && error.code === 'ENOENT';
}

function isMissingElectronFuseSentinelError(error) {
  return error instanceof Error &&
    error.message.includes('Could not find sentinel in the provided Electron binary');
}

async function extractAsarForPatch(archivePath, destinationPath) {
  const skippedUnpackedFiles = [];
  const packageEntries = asar.listPackage(archivePath);
  const followLinks = process.platform === 'win32';

  fs.mkdirSync(destinationPath, { recursive: true });

  for (const fullPath of packageEntries) {
    const filename = fullPath.replace(/^[\\/]+/, '');
    const destinationFile = path.join(destinationPath, filename);

    if (path.relative(destinationPath, destinationFile).startsWith('..')) {
      throw new Error(`${fullPath}: file "${destinationFile}" writes out of the package`);
    }

    const file = asar.statFile(archivePath, filename, followLinks);
    if ('files' in file) {
      fs.mkdirSync(destinationFile, { recursive: true });
      continue;
    }

    if ('link' in file) {
      const linkSrcPath = path.dirname(path.join(destinationPath, file.link));
      const linkDestPath = path.dirname(destinationFile);
      const relativePath = path.relative(linkDestPath, linkSrcPath);
      const linkTo = path.join(relativePath, path.basename(file.link));

      if (path.relative(destinationPath, linkSrcPath).startsWith('..')) {
        throw new Error(`${fullPath}: file "${file.link}" links out of the package to "${linkSrcPath}"`);
      }

      fs.rmSync(destinationFile, { force: true });
      fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
      fs.symlinkSync(linkTo, destinationFile);
      continue;
    }

    try {
      const content = asar.extractFile(archivePath, filename, followLinks);
      fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
      fs.writeFileSync(destinationFile, content);
      if (file.executable) {
        fs.chmodSync(destinationFile, 0o755);
      }
    } catch (error) {
      if (file.unpacked && isMissingUnpackedFileError(error)) {
        skippedUnpackedFiles.push(filename.replaceAll(path.sep, '/'));
        continue;
      }

      throw error;
    }
  }

  return { skippedUnpackedFiles };
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Fail fast if the asar-side known-gate list (DESKTOP_ASAR_KNOWN_GATE_IDS)
// and the init.cjs runtime override list (STATSIG_GATE_OVERRIDES) have
// drifted — a new gate added to one but not the other leaves an offline
// coverage hole. Run before touching the asar so the build fails clearly.
try {
  assertGateOverrideSync();
} catch (error) {
  console.error(`[patch-app-asar] ${error.message}`);
  process.exit(1);
}

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
  const extraction = await extractAsarForPatch(asarPath, tmpDir);
  if (extraction.skippedUnpackedFiles.length > 0) {
    log(
      'Asar references unpacked entries absent from this Store bundle: ' +
      extraction.skippedUnpackedFiles.join(', '),
    );
  }

  // Find main entry point.
  //
  // The main-process entry carries the load-bearing bootstrap patches
  // (process.windowsStore, the MSIX updater binding stub, the Computer Use
  // env default and the init.cjs require). Without them a standalone
  // Codex.exe crashes at startup, so a missing entry must fail the build
  // instead of silently shipping a broken package.
  const mainEntry = resolveMainEntry(tmpDir);
  if (!mainEntry) {
    throw new Error(
      'Could not locate the main-process entry point. The bundle structure ' +
      'likely changed; refusing to ship an unpatched (crash-on-launch) package.',
    );
  }

  log(`Main entry: ${path.relative(tmpDir, mainEntry)}`);

  if (isAlreadyPatched(mainEntry)) {
    if (refreshMainEntryPatch(mainEntry)) {
      log('Main entry patch refreshed for direct Codex.exe Computer Use launch.');
    } else {
      log('Main entry already patched.');
    }
  } else {
    patchFile(mainEntry);
    log('windowsStore patch applied.');
  }

  const chromeBrowserClientHash = patchChromePluginScripts(path.resolve(appDir));

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
  // V4: message=n, webContents=e, electron=a (seen in builds ≥ 26.611.x)
  const NOT_IMPLEMENTED_NEEDLE_V4 =
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:' +
    'case`open-extension-settings`:case`open-keyboard-shortcuts`:' +
    'case`open-config-toml`:case`show-settings`:case`install-wsl`:' +
    'throw Error(`"${n.type}" is not implemented in Electron.`)';

  // Helper: reload the renderer at a given settings route.
  const NAV_HELPER =
    'function _nav(e,r){' +
      'let _u=new URL(e.getURL());' +
      '_u.searchParams.set("initialRoute",r);' +
      'e.loadURL(_u.toString())}';
  const SETTINGS_ROUTE_DIRECT_RE_GLOBAL =
    /([A-Za-z_$][\w$]*)\.searchParams\.set\("initialRoute","\/settings\/"\+\(([A-Za-z_$][\w$]*)\.section\|\|"agent"\)\);/g;

  const SETTINGS_REPLACEMENT_V1 =
    // show-settings: reload the renderer with the desired settings route
    'case`show-settings`:{' +
      NAV_HELPER + ';' +
      'let _codexOfflineSettingsSection=t.section||"agent";' +
      `_nav(e,"/settings/"+${buildSettingsRouteMappingExpression('_codexOfflineSettingsSection')});` +
      `${SETTINGS_ROUTE_PATCH_MARKER};break}` +
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
      buildSettingsRouteStatement('i', 'r') +
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
      buildSettingsRouteStatement('t', 'i') +
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
  const SETTINGS_REPLACEMENT_V4 =
    'case`show-settings`:{' +
      'let _win=a.BrowserWindow.fromWebContents(e);' +
      'if(_win){let _url=new URL(_win.getURL());' +
      buildSettingsRouteStatement('_url', 'n') +
      '_win.loadURL(_url.toString())}' +
      'break}' +
    'case`open-extension-settings`:{' +
      'let _win=a.BrowserWindow.fromWebContents(e);' +
      'if(_win){let _url=new URL(_win.getURL());' +
      '_url.searchParams.set("initialRoute","/settings/general-settings");' +
      '_win.loadURL(_url.toString())}' +
      'break}' +
    'case`open-keyboard-shortcuts`:{' +
      'let _win=a.BrowserWindow.fromWebContents(e);' +
      'if(_win){let _url=new URL(_win.getURL());' +
      '_url.searchParams.set("initialRoute","/settings/general-settings");' +
      '_win.loadURL(_url.toString())}' +
      'break}' +
    'case`open-config-toml`:{' +
      'let _cfg=require("path").join(require("os").homedir(),".codex","config.toml");' +
      'require("fs").mkdirSync(require("path").dirname(_cfg),{recursive:true});' +
      'if(!require("fs").existsSync(_cfg))require("fs").writeFileSync(_cfg,"# Codex config\\n",{encoding:"utf8"});' +
      'a.shell.openPath(_cfg);break}' +
    'case`navigate-in-new-editor-tab`:case`open-vscode-command`:' +
    'case`install-wsl`:' +
    'throw Error(`"${n.type}" is not implemented in Electron.`)';
  const AUTOMATION_CWD_NORMALIZER_INLINE =
    'e=>typeof e==`string`&&e.startsWith(`\\\\\\\\?\\\\`)&&/^[A-Za-z]:/.test(e.slice(4))?e.slice(4):e';
  const AUTOMATION_RUNTIME_CWD_RE =
    /let (\w+)=(\w+)\.cwds;if\(\1\.length===0\)/;
  const AUTOMATION_RUNTIME_CWD_REPLACEMENT =
    `let $1=$2.cwds.map(${AUTOMATION_CWD_NORMALIZER_INLINE});if($1.length===0)`;
  const AUTOMATION_RUNTIME_CWD_PATCH_MARKER =
    `.cwds.map(${AUTOMATION_CWD_NORMALIZER_INLINE})`;
  const APP_SERVER_SANDBOX_OVERRIDE_PATCHES = [
    {
      needle: 'args:[`app-server`,`--analytics-default-enabled`]',
      replacement: 'args:[`-c`,`windows.sandbox=\'unelevated\'`,`app-server`,`--analytics-default-enabled`]',
    },
    {
      needle: '[`-c`,`features.code_mode_host=true`,`app-server`,`--analytics-default-enabled`]',
      replacement: '[`-c`,`features.code_mode_host=true`,`-c`,`windows.sandbox=\'unelevated\'`,`app-server`,`--analytics-default-enabled`]',
    },
  ];
  const WINDOWS_BROWSER_USE_CAPABILITY_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:windows-browser-use-capability*/');
  const WINDOWS_BROWSER_USE_CAPABILITY_LEGACY_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{env:([A-Za-z_$][\w$]*)=process\.env,platform:([A-Za-z_$][\w$]*)=process\.platform\}=\{\}\)\{return\s+\4!==`win32`\|\|\3\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`\?\2:\{\.\.\.\2,computerUse:!0,computerUseNodeRepl:!0\}\}/;
  const WINDOWS_BROWSER_USE_CAPABILITY_CURRENT_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{((?:buildFlavor:[A-Za-z_$][\w$]*=[^,}]+,)?env:([A-Za-z_$][\w$]*)=[^,}]+,platform:([A-Za-z_$][\w$]*)=[^,}]+)\}=\{\}\)\{let ([A-Za-z_$][\w$]*)=\5===`win32`&&\4\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.\2,computerUse:!0,computerUseNodeRepl:!0\}:\2,/;
  // v26.608+ introduced a multi-step let chain: darwin/win32-cu checks precede the CODEX env check.
  // The CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE assignment is no longer the first let; it is
  // preceded by a comma rather than being immediately after the opening brace.
  const WINDOWS_BROWSER_USE_CAPABILITY_V3_RE =
    /,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`win32`&&([A-Za-z_$][\w$]*)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:\4(?=,)/;
  const NODE_REPL_FEATURE_ENABLED_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:node-repl-feature-enabled*/');
  const NODE_REPL_FEATURE_CONFIG_RE =
    /([A-Za-z_$][\w$]*=\{"features\.js_repl":)(!0|!1)(?:\/\*codex-offline:node-repl-feature-enabled\*\/)?(\})/g;
  const NODE_REPL_FEATURE_CONFIG_PATCHED_RE =
    /[A-Za-z_$][\w$]*=\{"features\.js_repl":!0\/\*codex-offline:node-repl-feature-enabled\*\/\}/;
  const NODE_REPL_CONFIG_RECONCILE_FINALLY_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:node-repl-config-reconcile-finally*/');
  const NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:node-repl-disable-sandbox*/');
  const NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:node-repl-tool-search-feature*/');
  const COMPUTER_USE_PLUGIN_ROOT_FALLBACK_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:computer-use-plugin-root-fallback*/');
  const COMPUTER_USE_THREAD_CONFIG_DIAGNOSTICS_PATCH_MARKER =
    '/*codex-offline:computer-use-thread-config-diagnostics*/';
  const COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER =
    '/*codex-offline:computer-use-forward-thread-start-diagnostics*/';
  const COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_PATCH_MARKER =
    '/*codex-offline:computer-use-forward-input-diagnostics*/';
  const COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_PATCH_MARKER =
    '/*codex-offline:computer-use-forward-input-diagnostics-v2*/';
  const COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V3_PATCH_MARKER =
    '/*codex-offline:computer-use-forward-input-diagnostics-v3*/';
  const COMPUTER_USE_THREAD_START_TOOL_CONTEXT_DIAGNOSTICS_PATCH_MARKER =
    '/*codex-offline:computer-use-thread-start-tool-context-diagnostics*/';
  const COMPUTER_USE_MCP_STATUS_DIAGNOSTICS_PATCH_MARKER =
    '/*codex-offline:computer-use-mcp-status-diagnostics*/';
  const COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:computer-use-thread-start-tool-search*/');
  const COMPUTER_USE_INPUT_MENTION_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:computer-use-input-mention*/');
  const COMPUTER_USE_INPUT_MENTION_V2_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:computer-use-input-mention-v2*/');
  const COMPUTER_USE_INPUT_SKILL_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:computer-use-input-skill*/');
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:computer-use-node-repl-dynamic-tool*/');
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:computer-use-node-repl-dynamic-tool-call*/');
  const ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:archived-threads-partial-list*/');
  const ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:archived-threads-cache-fallback*/');
  const ARCHIVED_SETTINGS_OFFLINE_LOCAL_VISIBILITY_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:archived-settings-offline-local-visibility*/');
  const COMPUTER_USE_INPUT_MENTION_HELPER =
    'function _codexOfflineComputerUseMentionItems(e){let t=typeof e==`string`?e.trimStart():``;' +
    'let n=t.match(/\\[(@?(?:[^\\]]+))\\]\\((plugin:\\/\\/computer-use(?:@[^)]+)?)\\)/),' +
    'r=n?.[2]??`plugin://computer-use@openai-bundled`,i=typeof n?.[1]==`string`?' +
    'n[1].replace(/^@/,``).trim():``;' +
    'i.length===0&&(i=/^(?:@?\\u7535\\u8111)(?=\\s|$)/.test(t)?`\\u7535\\u8111`:`Computer`);' +
    'r.includes(`@`)||(r=`plugin://computer-use@openai-bundled`);' +
    'return(t.includes(`plugin://computer-use`)||/^(?:@?(?:\\u7535\\u8111|Computer(?: Use)?))(?=\\s|$)/i.test(t))?' +
    '[{type:`mention`,name:i,path:r}]:[]}' +
    COMPUTER_USE_INPUT_MENTION_PATCH_MARKER +
    COMPUTER_USE_INPUT_MENTION_V2_PATCH_MARKER;
  const COMPUTER_USE_INPUT_MENTION_HELPER_RE =
    /function _codexOfflineComputerUseMentionItems\(e\)\{[\s\S]*?\}\/\*codex-offline:computer-use-input-mention\*\/(?:\/\*codex-offline:computer-use-input-mention-v2\*\/)?/;
  const COMPUTER_USE_INPUT_MENTION_HELPER_NEEDLE =
    'async function $g({context:e,prompt:t,workspaceRoots:n,cwd:r,hostId:i,agentMode:a,serviceTier:o,collaborationMode:s,memoryPreferences:c,workspaceKind:l=`project`,projectlessOutputDirectory:u,projectAssignment:d})';
  const COMPUTER_USE_INPUT_MENTION_PATCHES = [
    {
      needle:
        'input:[{type:`text`,text:t,text_elements:[]},...Qg(e,i!==He,{shouldRestrictRemoteHostImageSize:!1})]',
      replacement:
        'input:[{type:`text`,text:t,text_elements:[]},..._codexOfflineComputerUseMentionItems(t),...Qg(e,i!==He,{shouldRestrictRemoteHostImageSize:!1})]',
    },
    {
      needle:
        'p=[{type:`text`,text:v(i),text_elements:[]},...Qg(i,d,{shouldRestrictRemoteHostImageSize:!1})]',
      replacement:
        'p=[{type:`text`,text:v(i),text_elements:[]},..._codexOfflineComputerUseMentionItems(v(i)),...Qg(i,d,{shouldRestrictRemoteHostImageSize:!1})]',
    },
    {
      needle:
        'f=[{type:`text`,text:v(u),text_elements:[]},...Qg(u,c,{shouldRestrictRemoteHostImageSize:!1})]',
      replacement:
        'f=[{type:`text`,text:v(u),text_elements:[]},..._codexOfflineComputerUseMentionItems(v(u)),...Qg(u,c,{shouldRestrictRemoteHostImageSize:!1})]',
    },
  ];
  const COMPUTER_USE_INPUT_MENTION_CURRENT_RE =
    /(\[\{type:`text`,text:([^,\]]+?),text_elements:\[\]\},)\.\.\.([A-Za-z_$][\w$]*)\(([^)]*?\{shouldRestrictRemoteHostImageSize:!1\})\)\]/g;
  const COMPUTER_USE_INPUT_MENTION_CURRENT_TEST_RE =
    /(\[\{type:`text`,text:([^,\]]+?),text_elements:\[\]\},)\.\.\.([A-Za-z_$][\w$]*)\(([^)]*?\{shouldRestrictRemoteHostImageSize:!1\})\)\]/;
  const FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:feature-overrides-preserve-mcp-config*/');
  const FEATURE_OVERRIDES_CONFIG_NAMESPACE_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let\s+([A-Za-z_$][\w$]*)=\{\};for\(let\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\]of Object\.entries\(\2\)\)\{let\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\4\);([A-Za-z_$][\w$]*)\.has\(\6\)\|\|\(\3\[([A-Za-z_$][\w$]*)\(\6\)\]=\5\)\}return \3\}/;
  const FEATURE_OVERRIDES_UNIFIED_EXEC_ONLY_RE =
    /return ([A-Za-z_$][\w$]*)\[`features\.unified_exec`\]=!0,\1\}\/\*codex-offline:feature-overrides-preserve-mcp-config\*\//;
  const FEATURE_OVERRIDES_TOOL_SEARCH_PATCHED_RE =
    /[`"]features\.tool_search[`"]\]=!0[\s\S]{0,160}[`"]features\.js_repl_tools_only[`"]\]=!0[\s\S]{0,160}[`"]features\.tool_suggest[`"]\]=!0[\s\S]{0,220}[`"]features\.tool_search_always_defer_mcp_tools[`"]\]=!0[\s\S]{0,220}[`"]features\.non_prefixed_mcp_tool_names[`"]\]=!0[\s\S]{0,220}[`"]features\.unavailable_dummy_tools[`"]\]=!0[\s\S]{0,120}\/\*codex-offline:feature-overrides-preserve-mcp-config\*\//;
  const FEATURE_OVERRIDES_TOOL_SEARCH_ONLY_RE =
    /return ([A-Za-z_$][\w$]*)\[`features\.unified_exec`\]=!0,\1\[`features\.tool_search`\]=!0,\1\}\/\*codex-offline:feature-overrides-preserve-mcp-config\*\//;
  const FEATURE_OVERRIDES_TOOL_SEARCH_JS_REPL_ONLY_RE =
    /return ([A-Za-z_$][\w$]*)\[`features\.unified_exec`\]=!0,\1\[`features\.tool_search`\]=!0,\1\[`features\.js_repl_tools_only`\]=!0,\1\}\/\*codex-offline:feature-overrides-preserve-mcp-config\*\//;
  const FEATURE_OVERRIDES_TOOL_SUGGEST_ONLY_RE =
    /return ([A-Za-z_$][\w$]*)\[`features\.unified_exec`\]=!0,\1\[`features\.tool_search`\]=!0,\1\[`features\.js_repl_tools_only`\]=!0,\1\[`features\.tool_suggest`\]=!0,\1\}\/\*codex-offline:feature-overrides-preserve-mcp-config\*\//;
  const BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:bundled-plugin-cache-lock-nonfatal*/');
  const BUNDLED_PLUGIN_CACHE_LOCK_CATEGORY_VALUE =
    '`plugin_cache_windows_file_lock`';
  const BUNDLED_PLUGIN_CACHE_LOCK_THROW_NEEDLE =
    'if(i!=null){if(Fo.warning(`bundled_plugins_marketplace_install_failed`,{safe:{errorCategory:Ho({error:i.error,platformFamily:e.platformFamily}),marketplaceName:t,platformFamily:e.platformFamily,...i.safe},sensitive:{error:i.error,marketplaceRoot:e.materializedMarketplace.marketplaceRoot,...i.sensitive}}),n)throw i.error;return!1}return!0}';
  const BUNDLED_PLUGIN_CACHE_LOCK_THROW_REPLACEMENT =
    'if(i!=null){let r=Ho({error:i.error,platformFamily:e.platformFamily});' +
    'if(Fo.warning(`bundled_plugins_marketplace_install_failed`,{safe:{errorCategory:r,marketplaceName:t,platformFamily:e.platformFamily,...i.safe},sensitive:{error:i.error,marketplaceRoot:e.materializedMarketplace.marketplaceRoot,...i.sensitive}}),' +
    `n&&r!==${BUNDLED_PLUGIN_CACHE_LOCK_CATEGORY_VALUE})throw i.error;` +
    `return r===${BUNDLED_PLUGIN_CACHE_LOCK_CATEGORY_VALUE}` +
    BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER +
    '}return!0}';
  const BUNDLED_PLUGIN_CACHE_LOCK_THROW_RE =
    /if\(([A-Za-z_$][\w$]*)!=null\)\{if\(([A-Za-z_$][\w$]*)\.warning\(`bundled_plugins_marketplace_install_failed`,\{safe:\{errorCategory:([A-Za-z_$][\w$]*)\(\{error:\1\.error,platformFamily:e\.platformFamily\}\),marketplaceName:t,platformFamily:e\.platformFamily,\.\.\.\1\.safe\},sensitive:\{error:\1\.error,marketplaceRoot:e\.materializedMarketplace\.marketplaceRoot,\.\.\.\1\.sensitive\}\}\),n\)throw \1\.error;return!1\}return!0\}/g;
  const BUNDLED_PLUGIN_CACHE_LOCK_CATCH_THROW_RE =
    /catch\(([A-Za-z_$][\w$]*)\)\{if\(([A-Za-z_$][\w$]*)\.warning\(`bundled_plugins_marketplace_install_failed`,\{safe:\{errorCategory:([A-Za-z_$][\w$]*)\(\{error:\1,platformFamily:e\.platformFamily\}\),marketplaceName:t,platformFamily:e\.platformFamily\},sensitive:\{error:\1,marketplaceRoot:e\.materializedMarketplace\.marketplaceRoot\}\}\),n\)throw \1;return!1\}/g;
  const NODE_REPL_CONFIG_RECONCILE_FINAL_STEP =
    'await Ro({appServerConnection:r,chromeExtensionSyncManagedPluginStore:l,' +
    'devRuntimeRepoRoot:s,marketplacePluginNames:e.marketplacePluginNames,' +
    'forceInstallPluginNames:d,installWhenMissingPluginNames:f,' +
    'syncInstallStateWithChromeExtensionPluginNames:m,marketplaceName:a,' +
    'resourcesPath:i,runtimeMarketplaceRoot:o}),await Promise.all(' +
    'e.marketplacePluginDescriptors.map(async e=>{e.migrate!=null&&' +
    'await e.migrate({appServerConnection:r,codexHome:t.codexHome,' +
    'marketplaceName:a,trashItem:t.trashItem})})),await ci({' +
    'appServerConnection:r,desktopFeatureAvailability:e.desktopFeatureAvailability,' +
    'isPackaged:t.isPackaged,platform:u,repoRoot:t.repoRoot,resourcesPath:i}),' +
    'p=await b(e.marketplacePluginDescriptors),t.onReconcileComplete?.()';
  const NODE_REPL_CONFIG_RECONCILE_FINAL_STEP_REPLACEMENT =
    'try{await Ro({appServerConnection:r,chromeExtensionSyncManagedPluginStore:l,' +
    'devRuntimeRepoRoot:s,marketplacePluginNames:e.marketplacePluginNames,' +
    'forceInstallPluginNames:d,installWhenMissingPluginNames:f,' +
    'syncInstallStateWithChromeExtensionPluginNames:m,marketplaceName:a,' +
    'resourcesPath:i,runtimeMarketplaceRoot:o}),await Promise.all(' +
    'e.marketplacePluginDescriptors.map(async e=>{e.migrate!=null&&' +
    'await e.migrate({appServerConnection:r,codexHome:t.codexHome,' +
    'marketplaceName:a,trashItem:t.trashItem})}))}finally{await ci({' +
    'appServerConnection:r,desktopFeatureAvailability:e.desktopFeatureAvailability,' +
    'isPackaged:t.isPackaged,platform:u,repoRoot:t.repoRoot,resourcesPath:i})}' +
    NODE_REPL_CONFIG_RECONCILE_FINALLY_PATCH_MARKER +
    ';p=await b(e.marketplacePluginDescriptors),t.onReconcileComplete?.()';
  const NODE_REPL_CONFIG_RECONCILE_FINAL_STEP_CURRENT_RE =
    /await ([A-Za-z_$][\w$]*)\(\{appServerConnection:([A-Za-z_$][\w$]*),browserSkillVariant:([A-Za-z_$][\w$]*),chromeExtensionSyncManagedPluginStore:([A-Za-z_$][\w$]*),devRuntimeRepoRoot:([A-Za-z_$][\w$]*),marketplacePluginNames:([A-Za-z_$][\w$]*)\.marketplacePluginNames,forceInstallPluginNames:([A-Za-z_$][\w$]*),installWhenMissingPluginNames:([A-Za-z_$][\w$]*),syncInstallStateWithChromeExtensionPluginNames:([A-Za-z_$][\w$]*),marketplaceName:([A-Za-z_$][\w$]*),resourcesPath:([A-Za-z_$][\w$]*),runtimeMarketplaceRoot:([A-Za-z_$][\w$]*)\}\),await Promise\.all\(\6\.marketplacePluginDescriptors\.map\(async ([A-Za-z_$][\w$]*)=>\{\13\.migrate!=null&&await \13\.migrate\(\{appServerConnection:\2,codexHome:e\.codexHome,marketplaceName:\10,trashItem:e\.trashItem\}\)\}\)\),await ([A-Za-z_$][\w$]*)\(\{appServerConnection:\2,desktopFeatureAvailability:\6\.desktopFeatureAvailability,isPackaged:e\.isPackaged,platform:([A-Za-z_$][\w$]*),repoRoot:e\.repoRoot,resourcesPath:\11\}\),/;
  const NODE_REPL_DISABLE_SANDBOX_NEEDLE =
    'let x=Rn({computerUse:h,computerUsePaths:v,hostConfig:r,' +
    'runtimePaths:_,shouldUseWslPaths:d,availableBrowserUseBackends:g,' +
    'computerUseNativePipeEnabled:b,trustedBrowserClientSha256s:m||b?p:[]});' +
    'return x==null?null:(Fn(_),Vn([Tn,x]))';
  const NODE_REPL_DISABLE_SANDBOX_REPLACEMENT =
    'let x=Rn({computerUse:h,computerUsePaths:v,hostConfig:r,' +
    'runtimePaths:_,shouldUseWslPaths:d,availableBrowserUseBackends:g,' +
    'computerUseNativePipeEnabled:b,trustedBrowserClientSha256s:m||b?p:[]});' +
    'if(x!=null&&h&&f===`win32`){let S=`mcp_servers.${e.jn}`,C=x[S];' +
    'C&&typeof C==`object`&&!Array.isArray(C)&&' +
    '(x={...x,[S]:{...C,args:Array.from(new Set([' +
    '...(Array.isArray(C.args)?C.args:[]),`--disable-sandbox`]))}});' +
    'x={...x,[`features.tool_search`]:!0}' +
    NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER +
    '}' +
    NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER +
    'Cn.info(`computer_use_thread_config_resolved`,{safe:{computerUse:h,' +
    'computerUseNativePipeEnabled:b,hasNodeReplConfig:x?.[`mcp_servers.${e.jn}`]!=null,' +
    'hasWindowsHelperPath:v.windowsHelperPath!=null,' +
    'hasWindowsHelperTransportModulePath:v.windowsHelperTransportModulePath!=null,' +
    'nodeModuleDirCount:Array.isArray(v.nodeModuleDirs)?v.nodeModuleDirs.length:0,' +
    'platform:_.platform},sensitive:{nodeModuleDirs:v.nodeModuleDirs,' +
    'windowsHelperPath:v.windowsHelperPath,' +
    'windowsHelperTransportModulePath:v.windowsHelperTransportModulePath}});' +
    COMPUTER_USE_THREAD_CONFIG_DIAGNOSTICS_PATCH_MARKER +
    'return x==null?null:(Fn(_),Vn([Tn,x]))';
  const NODE_REPL_CONFIG_HELPER_RE =
    /\{\[`mcp_servers\.\$\{([A-Za-z_$][\w$]*)\}`\]:\{args:\[\],command:([A-Za-z_$][\w$]*),env:([A-Za-z_$][\w$]*),startup_timeout_sec:120\}\}/;
  const NODE_REPL_CONFIG_HELPER_REPLACEMENT =
    '{[`mcp_servers.${$1}`]:{args:[`--disable-sandbox`],command:$2,env:$3,startup_timeout_sec:120},' +
    '[`features.tool_search`]:!0,' +
    '[`features.js_repl_tools_only`]:!0,' +
    '[`features.tool_suggest`]:!0,' +
    '[`features.tool_search_always_defer_mcp_tools`]:!0,' +
    '[`features.non_prefixed_mcp_tool_names`]:!0,' +
    '[`features.unavailable_dummy_tools`]:!0' +
    NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER +
    '}' +
    NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER;
  const NODE_REPL_DISABLE_SANDBOX_LEGACY_DIAGNOSTICS_NEEDLE =
    NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER +
    'return x==null?null:(Fn(_),Vn([Tn,x]))';
  const NODE_REPL_DISABLE_SANDBOX_LEGACY_DIAGNOSTICS_REPLACEMENT =
    NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER +
    'Cn.info(`computer_use_thread_config_resolved`,{safe:{computerUse:h,' +
    'computerUseNativePipeEnabled:b,hasNodeReplConfig:x?.[`mcp_servers.${e.jn}`]!=null,' +
    'hasWindowsHelperPath:v.windowsHelperPath!=null,' +
    'hasWindowsHelperTransportModulePath:v.windowsHelperTransportModulePath!=null,' +
    'nodeModuleDirCount:Array.isArray(v.nodeModuleDirs)?v.nodeModuleDirs.length:0,' +
    'platform:_.platform},sensitive:{nodeModuleDirs:v.nodeModuleDirs,' +
    'windowsHelperPath:v.windowsHelperPath,' +
    'windowsHelperTransportModulePath:v.windowsHelperTransportModulePath}});' +
    COMPUTER_USE_THREAD_CONFIG_DIAGNOSTICS_PATCH_MARKER +
    'return x==null?null:(Fn(_),Vn([Tn,x]))';
  const NODE_REPL_TOOL_SEARCH_FEATURE_UPGRADE_RE =
    /(if\(x!=null&&h&&f===`win32`\)\{let S=`mcp_servers\.\$\{e\.jn\}`,C=x\[S\];C&&typeof C==`object`&&!Array\.isArray\(C\)&&\(x=\{\.\.\.x,\[S\]:\{\.\.\.C,args:Array\.from\(new Set\(\[\.\.\.\(Array\.isArray\(C\.args\)\?C\.args:\[\]\),`--disable-sandbox`\]\)\)\}\}\))(\})(\/\*codex-offline:node-repl-disable-sandbox\*\/)/;
  const NODE_REPL_TOOL_SEARCH_FEATURE_UPGRADE_REPLACEMENT =
    '$1;x={...x,[`features.tool_search`]:!0}' +
    NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER +
    '$2$3';
  const NODE_REPL_TOOL_SEARCH_FEATURE_MISSING_SEPARATOR_RE =
    /(\))x=\{\.\.\.x,\[`features\.tool_search`\]:!0\}(\/\*codex-offline:node-repl-tool-search-feature\*\/)/;
  const NODE_REPL_TOOL_SEARCH_FEATURE_MISSING_SEPARATOR_REPLACEMENT =
    '$1;x={...x,[`features.tool_search`]:!0}$2';
  const COMPUTER_USE_PLUGIN_ROOT_FALLBACK_NEEDLE =
    'function Tt({codexHome:t,env:r=process.env,marketplaceName:i=e.ir(n.j.resolve()),' +
    'marketplaces:a,pathExists:o=c.existsSync}){for(let n of ft({marketplaceName:i,marketplaces:a}))' +
    '{let i=n.plugins.find(e=>e.name===`computer-use`&&e.installed&&e.enabled&&e.source.type===`local`);' +
    'if(i?.source.type===`local`)return wt({env:r,installedPluginRoot:e.cr({codexHome:t,' +
    'localVersion:i.localVersion,marketplaceName:n.name,pluginName:i.name}),pathExists:o})}' +
    'return wt({env:r,pathExists:o})}';
  const COMPUTER_USE_PLUGIN_ROOT_FALLBACK_REPLACEMENT =
    'function Tt({codexHome:t,env:r=process.env,marketplaceName:i=e.ir(n.j.resolve()),' +
    'marketplaces:a,pathExists:l=c.existsSync}){for(let n of ft({marketplaceName:i,marketplaces:a}))' +
    '{let i=n.plugins.find(e=>e.name===`computer-use`&&e.installed&&e.enabled&&e.source.type===`local`);' +
    'if(i?.source.type===`local`)return wt({env:r,installedPluginRoot:e.cr({codexHome:t,' +
    'localVersion:i.localVersion,marketplaceName:n.name,pluginName:i.name}),pathExists:l});' +
    'let u=n.plugins.find(e=>e.name===`computer-use`&&' +
    '(e.source?.type===`local`||e.source?.source===`local`)),d=u?.source?.path??null,' +
    'f=n.path!=null&&d!=null?o.default.resolve(n.path,d):null;' +
    'if(f!=null&&l(f)){Cn.info(`computer_use_plugin_root_fallback_used`,' +
    '{safe:{marketplaceName:n.name},sensitive:{installedPluginRoot:f}});' +
    'return wt({env:r,installedPluginRoot:f,pathExists:l})}}' +
    COMPUTER_USE_PLUGIN_ROOT_FALLBACK_PATCH_MARKER +
    'return wt({env:r,pathExists:l})}';
  const COMPUTER_USE_PLUGIN_ROOT_FALLBACK_CURRENT_RE =
    /function ([A-Za-z_$][\w$]*)\(\{codexHome:([A-Za-z_$][\w$]*),env:([A-Za-z_$][\w$]*)=process\.env,marketplaceName:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.or\(([A-Za-z_$][\w$]*)\.M\.resolve\(\)\),marketplaces:([A-Za-z_$][\w$]*),pathExists:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.existsSync\}\)\{for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\(\{marketplaceName:\4,marketplaces:\7\}\)\)\{let ([A-Za-z_$][\w$]*)=\10\.plugins\.find\(([A-Za-z_$][\w$]*)=>\13\.name===`computer-use`&&\13\.installed&&\13\.enabled&&\13\.source\.type===`local`\);if\(\12\?\.source\.type===`local`\)return ([A-Za-z_$][\w$]*)\(\{env:\3,installedPluginRoot:\5\.([A-Za-z_$][\w$]*)\(\{codexHome:\2,localVersion:\12\.localVersion,marketplaceName:\10\.name,pluginName:\12\.name\}\),pathExists:\8\}\)\}return \14\(\{env:\3,pathExists:\8\}\)\}/;
  const COMPUTER_USE_PLUGIN_ROOT_FALLBACK_CURRENT_RE_V2 =
    /function ([A-Za-z_$][\w$]*)\(\{codexHome:([A-Za-z_$][\w$]*),env:([A-Za-z_$][\w$]*)=process\.env,marketplaceName:([A-Za-z_$][\w$]*)=([^,{}]+?\([^{}]*?\.resolve\(\)\)),marketplaces:([A-Za-z_$][\w$]*),pathExists:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.existsSync\}\)\{for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\(\{marketplaceName:\4,marketplaces:\6\}\)\)\{let ([A-Za-z_$][\w$]*)=\9\.plugins\.find\(([A-Za-z_$][\w$]*)=>\12\.name===`computer-use`&&\12\.installed&&\12\.enabled&&\12\.source\.type===`local`\);if\(\11\?\.source\.type===`local`\)return ([A-Za-z_$][\w$]*)\(\{env:\3,installedPluginRoot:([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\{codexHome:\2,localVersion:\11\.localVersion,marketplaceName:\9\.name,pluginName:\11\.name\}\),pathExists:\7\}\)\}return \13\(\{env:\3,pathExists:\7\}\)\}/;
  const COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_NEEDLE =
    'try{this.logger.debug(`bridge_forwarded_to_transport`,{safe:{requestId:r,' +
    'method:t.method,conversationId:i??null,originWebcontentsId:e.id,' +
    'transportKind:this.options.transport.kind,pendingCount:this.pendingRequests.size},' +
    'sensitive:{}}),this.sendMessage(t),t.method===`turn/start`&&i!=null&&' +
    'this.prewarmedThreads.publishThreadStarted(i)}catch(n){';
  const COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_LEGACY_SAFE_FIELDS =
    'inputItemCount:_codexOfflineItems.length,' +
    'inputItemTypes:_codexOfflineItems.map(e=>e?.type).join(`,`),' +
    'mentionCount:_codexOfflineItems.filter(e=>e?.type===`mention`).length,' +
    'skillCount:_codexOfflineItems.filter(e=>e?.type===`skill`).length,' +
    'hasComputerUseMention:_codexOfflineItems.some(e=>typeof e?.path===`string`&&' +
    'e.path.includes(`plugin://computer-use`)),' +
    'hasComputerUseText:_codexOfflineItems.some(e=>typeof e?.text===`string`&&' +
    'e.text.includes(`plugin://computer-use`)),' +
    'textPrefix:String(_codexOfflineItems.find(e=>e?.type===`text`)?.text??``).slice(0,160)';
  const COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_SAFE_FIELDS =
    'inputItemCount:_codexOfflineItems.length,' +
    'inputItemTypes:_codexOfflineItems.map(e=>e?.type).join(`,`),' +
    'mentionCount:_codexOfflineItems.filter(e=>e?.type===`mention`).length,' +
    'skillCount:_codexOfflineItems.filter(e=>e?.type===`skill`).length,' +
    'hasComputerUseMention:_codexOfflineItems.some(e=>typeof e?.path===`string`&&' +
    'e.path.includes(`plugin://computer-use`)),' +
    'hasComputerUseText:_codexOfflineItems.some(e=>typeof e?.text===`string`&&' +
    'e.text.includes(`plugin://computer-use`)),' +
    'mentionNames:_codexOfflineItems.filter(e=>e?.type===`mention`).map(e=>String(e?.name??``)).join(`|`),' +
    'mentionPaths:_codexOfflineItems.filter(e=>e?.type===`mention`).map(e=>String(e?.path??``)).join(`|`),' +
    'textElementCounts:_codexOfflineItems.filter(e=>e?.type===`text`).map(e=>Array.isArray(e?.text_elements)?e.text_elements.length:Array.isArray(e?.textElements)?e.textElements.length:-1).join(`,`),' +
    'textPrefix:String(_codexOfflineItems.find(e=>e?.type===`text`)?.text??``).slice(0,160)';
  const COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_SAFE_FIELDS =
    'inputItemCount:_codexOfflineItems.length,' +
    'inputItemTypes:_codexOfflineItems.map(e=>e?.type).join(`,`),' +
    'mentionCount:_codexOfflineItems.filter(e=>e?.type===`mention`).length,' +
    'skillCount:_codexOfflineItems.filter(e=>e?.type===`skill`).length,' +
    'hasComputerUseMention:_codexOfflineItems.some(e=>typeof e?.path===`string`&&' +
    'e.path.includes(`plugin://computer-use`)),' +
    'hasComputerUseText:_codexOfflineItems.some(e=>typeof e?.text===`string`&&' +
    'e.text.includes(`plugin://computer-use`)),' +
    'mentionNames:_codexOfflineItems.filter(e=>e?.type===`mention`).map(e=>String(e?.name??``)).join(`|`),' +
    'mentionPaths:_codexOfflineItems.filter(e=>e?.type===`mention`).map(e=>String(e?.path??``)).join(`|`),' +
    'skillNames:_codexOfflineItems.filter(e=>e?.type===`skill`).map(e=>String(e?.name??``)).join(`|`),' +
    'skillPaths:_codexOfflineItems.filter(e=>e?.type===`skill`).map(e=>String(e?.path??``)).join(`|`),' +
    'textElementCounts:_codexOfflineItems.filter(e=>e?.type===`text`).map(e=>Array.isArray(e?.text_elements)?e.text_elements.length:Array.isArray(e?.textElements)?e.textElements.length:-1).join(`,`),' +
    'textPrefix:String(_codexOfflineItems.find(e=>e?.type===`text`)?.text??``).slice(0,160)';
  const COMPUTER_USE_INPUT_SKILL_INJECTION_CODE =
    'let _codexOfflineComputerUseSkillPath=this._codexOfflineComputerUseSkillPath??null;' +
    'if(t.method===`thread/start`){let _codexOfflineNodeDirs=t.params?.config?.[`mcp_servers.node_repl`]?.env?.NODE_REPL_NODE_MODULE_DIRS;' +
    'if(typeof _codexOfflineNodeDirs===`string`){let _codexOfflineNodeDir=_codexOfflineNodeDirs.split(`;`).map(e=>e.trim()).find(e=>/[\\\\/]computer-use[\\\\/][^\\\\/]+[\\\\/]node_modules[\\\\/]?$/i.test(e));' +
    'if(_codexOfflineNodeDir!=null){let _codexOfflineRoot=_codexOfflineNodeDir.replace(/[\\\\/]node_modules[\\\\/]?$/i,``),_codexOfflineSep=_codexOfflineRoot.includes(`\\\\`)?`\\\\`:`/`;' +
    '_codexOfflineComputerUseSkillPath=`${_codexOfflineRoot}${_codexOfflineSep}skills${_codexOfflineSep}computer-use${_codexOfflineSep}SKILL.md`,this._codexOfflineComputerUseSkillPath=_codexOfflineComputerUseSkillPath}}}' +
    'if(t.method===`turn/start`&&_codexOfflineComputerUseSkillPath!=null){let _codexOfflineInput=t.params?.input??t.params?.params?.input??null;' +
    'if(Array.isArray(_codexOfflineInput)&&_codexOfflineInput.some(e=>e?.type===`mention`&&typeof e?.path===`string`&&e.path.includes(`plugin://computer-use`))&&!_codexOfflineInput.some(e=>e?.type===`skill`&&(e?.name===`computer-use`||typeof e?.path===`string`&&e.path.includes(`computer-use`))))' +
    '_codexOfflineInput.push({type:`skill`,name:`computer-use`,path:_codexOfflineComputerUseSkillPath})}' +
    COMPUTER_USE_INPUT_SKILL_PATCH_MARKER;
  const COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE =
    'if(t.method===`thread/start`&&t.params?.config?.[`mcp_servers.node_repl`]!=null)' +
    '{let _codexOfflineNodeReplConfig=t.params.config[`mcp_servers.node_repl`];' +
    'if(_codexOfflineNodeReplConfig&&typeof _codexOfflineNodeReplConfig===`object`&&!Array.isArray(_codexOfflineNodeReplConfig))' +
    't.params.config={...t.params.config,[`mcp_servers.node_repl`]:{..._codexOfflineNodeReplConfig,args:Array.from(new Set([...(Array.isArray(_codexOfflineNodeReplConfig.args)?_codexOfflineNodeReplConfig.args:[]),`--disable-sandbox`]))},' +
    '[`features.tool_search`]:!0,' +
    '[`features.js_repl_tools_only`]:!0,[`features.tool_suggest`]:!0,' +
    '[`features.tool_search_always_defer_mcp_tools`]:!0,' +
    '[`features.non_prefixed_mcp_tool_names`]:!0,' +
    '[`features.unavailable_dummy_tools`]:!0}}' +
    COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER;
  const COMPUTER_USE_THREAD_START_TOOL_SEARCH_TOOL_SUGGEST_ONLY_CODE =
    'if(t.method===`thread/start`&&t.params?.config?.[`mcp_servers.node_repl`]!=null)' +
    '{t.params.config={...t.params.config,[`features.tool_search`]:!0,' +
    '[`features.js_repl_tools_only`]:!0,[`features.tool_suggest`]:!0}}' +
    COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER;
  const COMPUTER_USE_THREAD_START_TOOL_SEARCH_LEGACY_CODE =
    'if(t.method===`thread/start`&&t.params?.config?.[`mcp_servers.node_repl`]!=null)' +
    '{t.params.config={...t.params.config,[`features.tool_search`]:!0}}' +
    COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER;
  const COMPUTER_USE_THREAD_START_TOOL_SEARCH_JS_REPL_ONLY_CODE =
    'if(t.method===`thread/start`&&t.params?.config?.[`mcp_servers.node_repl`]!=null)' +
    '{t.params.config={...t.params.config,[`features.tool_search`]:!0,' +
    '[`features.js_repl_tools_only`]:!0}}' +
    COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER;
  const COMPUTER_USE_THREAD_START_TOOL_SEARCH_FULL_FLAGS_ONLY_CODE =
    'if(t.method===`thread/start`&&t.params?.config?.[`mcp_servers.node_repl`]!=null)' +
    '{t.params.config={...t.params.config,[`features.tool_search`]:!0,' +
    '[`features.js_repl_tools_only`]:!0,[`features.tool_suggest`]:!0,' +
    '[`features.tool_search_always_defer_mcp_tools`]:!0,' +
    '[`features.non_prefixed_mcp_tool_names`]:!0,' +
    '[`features.unavailable_dummy_tools`]:!0}}' +
    COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER;
  const COMPUTER_USE_THREAD_START_TOOL_CONTEXT_DIAGNOSTICS_CODE =
    'if(t.method===`thread/start`){let _codexOfflineConfig=t.params?.config??{},' +
    '_codexOfflineDynamicTools=Array.isArray(t.params?.dynamicTools)?t.params.dynamicTools:[];' +
    'this.logger.info(`computer_use_thread_start_tool_context`,{safe:{' +
    'configKeys:_codexOfflineConfig&&typeof _codexOfflineConfig===`object`?' +
    'Object.keys(_codexOfflineConfig).sort().join(`|`):``,' +
    'hasToolSearchFeature:_codexOfflineConfig?.[`features.tool_search`]===!0,' +
    'hasToolSearchDeferMcpToolsFeature:_codexOfflineConfig?.[`features.tool_search_always_defer_mcp_tools`]===!0,' +
    'hasJsReplToolsOnlyFeature:_codexOfflineConfig?.[`features.js_repl_tools_only`]===!0,' +
    'hasNonPrefixedMcpToolNamesFeature:_codexOfflineConfig?.[`features.non_prefixed_mcp_tool_names`]===!0,' +
    'hasUnavailableDummyToolsFeature:_codexOfflineConfig?.[`features.unavailable_dummy_tools`]===!0,' +
    'hasToolSuggestFeature:_codexOfflineConfig?.[`features.tool_suggest`]===!0,' +
    'dynamicToolCount:_codexOfflineDynamicTools.length,' +
    'dynamicToolNames:_codexOfflineDynamicTools.map(e=>String(e?.name??``)).join(`|`),' +
    'dynamicToolNamespaces:_codexOfflineDynamicTools.map(e=>String(e?.namespace??``)).join(`|`),' +
    'dynamicToolDeferLoading:_codexOfflineDynamicTools.map(e=>e?.deferLoading===!0?`1`:`0`).join(`|`),' +
    'developerInstructionsLength:typeof t.params?.developerInstructions===`string`?t.params.developerInstructions.length:0,' +
    'computerUseSkillPathKnown:this._codexOfflineComputerUseSkillPath!=null},' +
    'sensitive:{dynamicTools:_codexOfflineDynamicTools,' +
    'developerInstructionsPrefix:String(t.params?.developerInstructions??``).slice(0,800)}})}' +
    COMPUTER_USE_THREAD_START_TOOL_CONTEXT_DIAGNOSTICS_PATCH_MARKER;
  const COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_REPLACEMENT =
    'try{' +
    COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE +
    't.method===`thread/start`&&this.logger.info(' +
    '`computer_use_forward_thread_start_config`,{safe:{' +
    'hasConfig:t.params?.config!=null,' +
    'hasJsReplFeature:t.params?.config?.[`features.js_repl`]===!0,' +
    'hasNodeReplConfig:t.params?.config?.[`mcp_servers.node_repl`]!=null,' +
    'configKeyCount:t.params?.config&&typeof t.params.config===`object`?' +
    'Object.keys(t.params.config).length:0},sensitive:{' +
    'nodeReplConfig:t.params?.config?.[`mcp_servers.node_repl`]??null}});' +
    COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER +
    COMPUTER_USE_INPUT_SKILL_INJECTION_CODE +
    COMPUTER_USE_THREAD_START_TOOL_CONTEXT_DIAGNOSTICS_CODE +
    'if(t.method===`thread/start`||t.method===`turn/start`){let ' +
    '_codexOfflineInput=t.params?.input??t.params?.params?.input??null,' +
    '_codexOfflineItems=Array.isArray(_codexOfflineInput)?_codexOfflineInput:[];' +
    'this.logger.info(`computer_use_forward_input`,{safe:{method:t.method,' +
    COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_SAFE_FIELDS +
    '},' +
    'sensitive:{}})}' +
    COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_PATCH_MARKER +
    COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_PATCH_MARKER +
    COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V3_PATCH_MARKER +
    'this.logger.debug(`bridge_forwarded_to_transport`,{safe:{requestId:r,' +
    'method:t.method,conversationId:i??null,originWebcontentsId:e.id,' +
    'transportKind:this.options.transport.kind,pendingCount:this.pendingRequests.size},' +
    'sensitive:{}}),this.sendMessage(t),t.method===`turn/start`&&i!=null&&' +
    'this.prewarmedThreads.publishThreadStarted(i)}catch(n){';
  const COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_LEGACY_NEEDLE =
    COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER +
    'this.logger.debug(`bridge_forwarded_to_transport`,{safe:{requestId:r,';
  const COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_LEGACY_REPLACEMENT =
    COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER +
    COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE +
    COMPUTER_USE_INPUT_SKILL_INJECTION_CODE +
    COMPUTER_USE_THREAD_START_TOOL_CONTEXT_DIAGNOSTICS_CODE +
    'if(t.method===`thread/start`||t.method===`turn/start`){let ' +
    '_codexOfflineInput=t.params?.input??t.params?.params?.input??null,' +
    '_codexOfflineItems=Array.isArray(_codexOfflineInput)?_codexOfflineInput:[];' +
    'this.logger.info(`computer_use_forward_input`,{safe:{method:t.method,' +
    COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_SAFE_FIELDS +
    '},' +
    'sensitive:{}})}' +
    COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_PATCH_MARKER +
    COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_PATCH_MARKER +
    COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V3_PATCH_MARKER +
    'this.logger.debug(`bridge_forwarded_to_transport`,{safe:{requestId:r,';
  const COMPUTER_USE_MCP_STATUS_RESPONSE_NEEDLE =
    'this.logger.info(`response_routed`,{safe:{requestId:n,method:r?.method??null,' +
    'conversationId:r?.conversationId??null,originWebcontentsId:r?.originWebContentsId??null,' +
    'durationMs:u,hadPending:r!=null,hadInternalHandler:!1,targetDestroyed:d,' +
    'broadcastFallback:r!=null&&d===!0,errorCode:t.error?.code??null},sensitive:{}}),';
  const COMPUTER_USE_MCP_STATUS_RESPONSE_REPLACEMENT =
    'if(r?.method===`mcpServerStatus/list`){let _codexOfflineMcpServers=' +
    'Array.isArray(t.result?.data)?t.result.data:[],' +
    '_codexOfflineNodeRepl=_codexOfflineMcpServers.find(e=>e?.name===`node_repl`),' +
    '_codexOfflineNodeReplTools=_codexOfflineNodeRepl?.tools&&' +
    'typeof _codexOfflineNodeRepl.tools===`object`&&!Array.isArray(_codexOfflineNodeRepl.tools)?' +
    'Object.keys(_codexOfflineNodeRepl.tools):[];' +
    'this.logger.info(`computer_use_mcp_status_response`,{safe:{' +
    'serverCount:_codexOfflineMcpServers.length,' +
    'serverNames:_codexOfflineMcpServers.map(e=>String(e?.name??``)).join(`|`),' +
    'nodeReplSeen:_codexOfflineNodeRepl!=null,' +
    'nodeReplToolNames:_codexOfflineNodeReplTools.join(`|`)},' +
    'sensitive:{nodeRepl:_codexOfflineNodeRepl??null}})}' +
    COMPUTER_USE_MCP_STATUS_DIAGNOSTICS_PATCH_MARKER +
    COMPUTER_USE_MCP_STATUS_RESPONSE_NEEDLE;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_SPEC =
    '({namespace:`node_repl`,name:`js`,description:`Execute JavaScript in the persistent Node REPL used by Computer Use.`,inputSchema:{type:`object`,additionalProperties:!1,properties:{code:{type:`string`,description:`JavaScript source to execute in the persistent Node-backed kernel.`},timeout_ms:{type:`integer`,minimum:1,description:`Optional execution timeout in milliseconds.`},title:{type:`string`,minLength:1,maxLength:80,description:`Short user-facing description.`}},required:[`code`]}})';
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_COMPAT_SPEC =
    '({name:`js`,description:`Execute JavaScript in the persistent Node REPL used by Computer Use. This forwards to node_repl.js.`,inputSchema:{type:`object`,additionalProperties:!1,properties:{code:{type:`string`,description:`JavaScript source to execute in the persistent Node-backed kernel.`},timeout_ms:{type:`integer`,minimum:1,description:`Optional execution timeout in milliseconds.`},title:{type:`string`,minLength:1,maxLength:80,description:`Short user-facing description.`}},required:[`code`]}})';
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOLS_RETURN_RE =
    /return(\[\.\.\.[A-Za-z_$][\w$]*\?\[[A-Za-z_$][\w$]*\(\)\]:\[\],[\s\S]{0,900}?\]\.map\([A-Za-z_$][\w$]*=>\(\{\.\.\.[A-Za-z_$][\w$]*,namespace:[A-Za-z_$][\w$]*,[\s\S]{0,220}?\}\)\))/;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOLS_NAMESPACE_RE =
    /(\]\.map\(([A-Za-z_$][\w$]*)=>\(\{type:`function`,\.\.\.\2,\.\.\.[A-Za-z_$][\w$]*\.has\(\2\.name\)\?\{\}:\{deferLoading:!0\}\}\)\))\}\]/;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOLS_ARRAY_RE =
    /\]\.map\(e=>\(\{type:`function`,\.\.\.e,\.\.\.[A-Za-z_$][\w$]*\.has\(e\.name\)\?\{\}:\{deferLoading:!0\}\}\)\);return/;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_COMPAT_MISSING_RE =
    /(\(\{namespace:`node_repl`,name:`js`,description:`Execute JavaScript in the persistent Node REPL used by Computer Use\.`,inputSchema:\{[\s\S]{0,700}?required:\[`code`\]\}\}\),)(?!\(\{name:`js`,description:`Execute JavaScript in the persistent Node REPL used by Computer Use\. This forwards to node_repl\.js\.`)/;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_RE =
    /(let [A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.get\([A-Za-z_$][\w$]*\),\{id:([A-Za-z_$][\w$]*),params:([A-Za-z_$][\w$]*)\}=[A-Za-z_$][\w$]*,\{threadId:([A-Za-z_$][\w$]*),tool:([A-Za-z_$][\w$]*)\}=\3;if\(!\4\)\{[\s\S]{0,260}?return\})/;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CURRENT_RE =
    /(async function [A-Za-z_$][\w$]*\(\{scope:([A-Za-z_$][\w$]*),serverRequest:([A-Za-z_$][\w$]*),hostId:([A-Za-z_$][\w$]*),queryClient:([A-Za-z_$][\w$]*)\}\)\{let [A-Za-z_$][\w$]*=\2\.get\([A-Za-z_$][\w$]*\),\{id:([A-Za-z_$][\w$]*),params:([A-Za-z_$][\w$]*)\}=\3,\{threadId:([A-Za-z_$][\w$]*),tool:([A-Za-z_$][\w$]*)\}=\7;if\(!\8\)\{[\s\S]{0,260}?return\})/;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CURRENT_V2_RE =
    /(?<prefix>async function [A-Za-z_$][\w$]*\(\{scope:(?<scope>[A-Za-z_$][\w$]*),serverRequest:(?<serverRequest>[A-Za-z_$][\w$]*),hostId:(?<hostId>[A-Za-z_$][\w$]*),queryClient:(?<queryClient>[A-Za-z_$][\w$]*)\}\)\{(?:let [^;{}]+;)?let\{id:(?<requestId>[A-Za-z_$][\w$]*),params:(?<params>[A-Za-z_$][\w$]*)\}=\k<serverRequest>,\{threadId:(?<threadId>[A-Za-z_$][\w$]*),tool:(?<tool>[A-Za-z_$][\w$]*)\}=\k<params>;if\(!\k<threadId>\)\{(?<logger>[A-Za-z_$][\w$]*)\.error\(`Missing threadId for dynamic tool call request`,\{safe:\{\},sensitive:\{id:\k<requestId>,params:\k<params>\}\}\);return\}let (?<result>[A-Za-z_$][\w$]*),(?<namespaceOk>[A-Za-z_$][\w$]*)=\k<params>\.namespace===[^,;]+,(?<compatOk>[A-Za-z_$][\w$]*)=\k<params>\.namespace==null&&[^;]+;)(?<gate>if\(!\k<namespaceOk>&&!\k<compatOk>\)\k<result>=(?<failureFn>[A-Za-z_$][\w$]*)\(`Unsupported dynamic tool namespace: \$\{\k<params>\.namespace\}`\);else)/;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CURRENT_V3_RE =
    /(?<prefix>async function [A-Za-z_$][\w$]*\(\{scope:(?<scope>[A-Za-z_$][\w$]*),serverRequest:(?<serverRequest>[A-Za-z_$][\w$]*),hostId:(?<hostId>[A-Za-z_$][\w$]*),queryClient:(?<queryClient>[A-Za-z_$][\w$]*)\}\)\{let\{id:(?<requestId>[A-Za-z_$][\w$]*),params:(?<params>[A-Za-z_$][\w$]*)\}=\k<serverRequest>,\{threadId:(?<threadId>[A-Za-z_$][\w$]*),tool:(?<tool>[A-Za-z_$][\w$]*)\}=\k<params>;if\(!\k<threadId>\)\{(?<logger>[A-Za-z_$][\w$]*)\.error\(`Missing threadId for dynamic tool call request`,\{safe:\{\},sensitive:\{id:\k<requestId>,params:\k<params>\}\}\);return\}let (?<result>[A-Za-z_$][\w$]*),(?<namespaceOk>[A-Za-z_$][\w$]*)=\k<params>\.namespace===[^,;]+,(?<compatOk>[A-Za-z_$][\w$]*)=\k<params>\.namespace==null&&[^;]+;)(?<gate>if\([A-Za-z_$][\w$]*!=null\)\k<result>=[A-Za-z_$][\w$]*;else if\(!\k<namespaceOk>&&!\k<compatOk>\)\k<result>=(?<failureFn>[A-Za-z_$][\w$]*)\(`Unsupported dynamic tool namespace: \$\{\k<params>\.namespace\}`\);else)/;
  const COMPUTER_USE_NODE_REPL_RESULT_TEXT_CODE =
    'let _codexOfflineNodeReplStringify=e=>{try{return JSON.stringify(e)}catch{return String(e)}};' +
    'let _codexOfflineNodeReplContentText=e=>Array.isArray(e)?e.map(e=>(e?.type===`text`||e?.type===`inputText`)?String(e.text??``):e?.text!=null?String(e.text):_codexOfflineNodeReplStringify(e)).join(`\\n`):``;' +
    'let _codexOfflineNodeReplText=(()=>{let e=_codexOfflineNodeReplResult;' +
    'for(let t of [e?.content,e?.contentItems,e?.toolResult?.content,e?.toolResult?.contentItems,e?.raw?.content,e?.raw?.contentItems]){let n=_codexOfflineNodeReplContentText(t);if(n.length>0)return n}' +
    'if(e?.structuredContent!=null)return _codexOfflineNodeReplStringify(e.structuredContent);' +
    'if(e?.toolResult?.structuredContent!=null)return _codexOfflineNodeReplStringify(e.toolResult.structuredContent);' +
    'if(e?.raw?.structuredContent!=null)return _codexOfflineNodeReplStringify(e.raw.structuredContent);' +
    'let t=_codexOfflineNodeReplContentText(e?.content??e?.contentItems);return t.length>0?t:_codexOfflineNodeReplStringify(e)??``})();';
  function findAppServerRequestBusName(content) {
    const patterns = [
      /listExperimentalFeatures:[A-Za-z_$][\w$]*=>\s*([A-Za-z_$][\w$]*)\(`list-experimental-features`,\{[\s\S]{0,260}?hostId:/,
      /listModels:[A-Za-z_$][\w$]*=>\s*([A-Za-z_$][\w$]*)\(`list-models-for-host`,\{[\s\S]{0,260}?hostId:/,
      /await\s+([A-Za-z_$][\w$]*)\(`handle-dynamic-tools-for-thread-start-response-for-host`,\{hostId:/,
      /await\s+([A-Za-z_$][\w$]*)\(`apply-thread-title-update-for-host`,\{hostId:/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(content);
      if (match?.[1]) return match[1];
    }
    return null;
  }
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CODE =
    'if(($3.namespace===`node_repl`&&$5===`js`)||($3.namespace==null&&$5===`js`)){let _codexOfflineNodeReplResult,_codexOfflineNodeReplResponse;try{' +
    '_codexOfflineNodeReplResult=await ln(`call-mcp-tool`,{hostId:n,threadId:$4,server:`node_repl`,tool:`js`,arguments:$3.arguments});' +
    COMPUTER_USE_NODE_REPL_RESULT_TEXT_CODE +
    'G.info(`computer_use_node_repl_js_call`,{safe:{namespace:$3.namespace??null,tool:$5,codePrefix:String($3.arguments?.code??``).slice(0,500),hasSetupComputerUseRuntime:String($3.arguments?.code??``).includes(`setupComputerUseRuntime`),hasDirectSkyImport:String($3.arguments?.code??``).includes(`@oai/sky`),hasListApps:String($3.arguments?.code??``).includes(`list_apps`),resultPrefix:_codexOfflineNodeReplText.slice(0,500),isError:_codexOfflineNodeReplResult?.isError===!0},sensitive:{}});' +
    '_codexOfflineNodeReplResponse={contentItems:[{type:`inputText`,text:_codexOfflineNodeReplText}],success:_codexOfflineNodeReplResult?.isError!==!0}' +
    '}catch(_codexOfflineNodeReplError){_codexOfflineNodeReplResponse=Ge(String(_codexOfflineNodeReplError?.message??_codexOfflineNodeReplError))}' +
    COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_PATCH_MARKER +
    'X.dispatchMessage(`mcp-response`,{hostId:n,response:{id:a($2),result:_codexOfflineNodeReplResponse}});return}';
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CURRENT_CODE =
    'if(($7.namespace===`node_repl`&&$9===`js`)||($7.namespace==null&&$9===`js`)){let _codexOfflineNodeReplResult,_codexOfflineNodeReplResponse;try{' +
    '_codexOfflineNodeReplResult=await ln(`call-mcp-tool`,{hostId:$4,threadId:$8,server:`node_repl`,tool:`js`,arguments:$7.arguments});' +
    COMPUTER_USE_NODE_REPL_RESULT_TEXT_CODE +
    'G.info(`computer_use_node_repl_js_call`,{safe:{namespace:$7.namespace??null,tool:$9,codePrefix:String($7.arguments?.code??``).slice(0,500),hasSetupComputerUseRuntime:String($7.arguments?.code??``).includes(`setupComputerUseRuntime`),hasDirectSkyImport:String($7.arguments?.code??``).includes(`@oai/sky`),hasListApps:String($7.arguments?.code??``).includes(`list_apps`),resultPrefix:_codexOfflineNodeReplText.slice(0,500),isError:_codexOfflineNodeReplResult?.isError===!0},sensitive:{}});' +
    '_codexOfflineNodeReplResponse={contentItems:[{type:`inputText`,text:_codexOfflineNodeReplText}],success:_codexOfflineNodeReplResult?.isError!==!0}' +
    '}catch(_codexOfflineNodeReplError){_codexOfflineNodeReplResponse=Ge(String(_codexOfflineNodeReplError?.message??_codexOfflineNodeReplError))}' +
    COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_PATCH_MARKER +
    'X.dispatchMessage(`mcp-response`,{hostId:$4,response:{id:a($6),result:_codexOfflineNodeReplResponse}});return}';
  function computerUseNodeReplDynamicToolCallCurrentV2Replacement(...args) {
    const groups = args.at(-1);
    const source = args.at(-2);
    const appServerRequestFn = typeof source === 'string'
      ? findAppServerRequestBusName(source)
      : null;
    if (!appServerRequestFn) {
      throw new Error(
        'Could not locate app-server request bus for Computer Use node_repl.js bridge.',
      );
    }
    return (
      groups.prefix +
      `if((${groups.params}.namespace===\`node_repl\`&&${groups.tool}===\`js\`)||` +
      `(${groups.params}.namespace==null&&${groups.tool}===\`js\`)){` +
      'let _codexOfflineNodeReplResult;try{' +
      `_codexOfflineNodeReplResult=await ${appServerRequestFn}(\`call-mcp-tool\`,{` +
      `hostId:${groups.hostId},threadId:${groups.threadId},server:\`node_repl\`,` +
      `tool:\`js\`,arguments:${groups.params}.arguments});` +
      COMPUTER_USE_NODE_REPL_RESULT_TEXT_CODE +
      `${groups.logger}.info(\`computer_use_node_repl_js_call\`,{safe:{` +
      `namespace:${groups.params}.namespace??null,tool:${groups.tool},` +
      `codePrefix:String(${groups.params}.arguments?.code??\`\`).slice(0,500),` +
      `hasSetupComputerUseRuntime:String(${groups.params}.arguments?.code??\`\`).includes(\`setupComputerUseRuntime\`),` +
      `hasDirectSkyImport:String(${groups.params}.arguments?.code??\`\`).includes(\`@oai/sky\`),` +
      `hasListApps:String(${groups.params}.arguments?.code??\`\`).includes(\`list_apps\`),` +
      'resultPrefix:_codexOfflineNodeReplText.slice(0,500),' +
      'isError:_codexOfflineNodeReplResult?.isError===!0},sensitive:{}});' +
      `${groups.result}={contentItems:[{type:\`inputText\`,text:_codexOfflineNodeReplText}],` +
      'success:_codexOfflineNodeReplResult?.isError!==!0}' +
      `}catch(_codexOfflineNodeReplError){${groups.result}=${groups.failureFn}(` +
      'String(_codexOfflineNodeReplError?.message??_codexOfflineNodeReplError))}' +
      COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_PATCH_MARKER +
      `}else ${groups.gate}`
    );
  }
  const COMPUTER_USE_NODE_REPL_NAMESPACE_TOOL_SPEC =
    '{type:`function`,name:`js`,description:`Execute JavaScript in the persistent Node REPL used by Computer Use.`,' +
    'inputSchema:{type:`object`,additionalProperties:!1,properties:{code:{type:`string`,' +
    'description:`JavaScript source to execute in the persistent Node-backed kernel.`},' +
    'timeout_ms:{type:`integer`,minimum:1,description:`Optional execution timeout in milliseconds.`},' +
    'title:{type:`string`,minLength:1,maxLength:80,description:`Short user-facing description.`}},' +
    'required:[`code`]}}';
  function patchComputerUseNodeReplDynamicTools(content) {
    if (content.includes(COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_PATCH_MARKER)) {
      return { content, alreadyCorrect: true, patched: false };
    }

    let next = content.replace(
      COMPUTER_USE_NODE_REPL_DYNAMIC_TOOLS_RETURN_RE,
      (_match, toolListExpression) =>
        `return${toolListExpression}.concat([` +
        `${COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_SPEC},` +
        `${COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_COMPAT_SPEC}])` +
        COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_PATCH_MARKER,
    );
    if (next !== content) {
      return { content: next, alreadyCorrect: false, patched: true };
    }

    next = content.replace(
      COMPUTER_USE_NODE_REPL_DYNAMIC_TOOLS_NAMESPACE_RE,
      (_match, mapExpression) =>
        `${mapExpression}},{type:\`namespace\`,name:\`node_repl\`,` +
        'description:`Node REPL tools for Computer Use.`,' +
        `tools:[${COMPUTER_USE_NODE_REPL_NAMESPACE_TOOL_SPEC}]}` +
        COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_PATCH_MARKER +
        ']',
    );
    if (next !== content) {
      return { content: next, alreadyCorrect: false, patched: true };
    }

    next = content.replace(
      COMPUTER_USE_NODE_REPL_DYNAMIC_TOOLS_ARRAY_RE,
      (match) =>
        `,{type:\`namespace\`,name:\`node_repl\`,description:\`Node REPL tools for Computer Use.\`,` +
        `tools:[${COMPUTER_USE_NODE_REPL_NAMESPACE_TOOL_SPEC}]}${COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_PATCH_MARKER}${match}`,
    );
    return { content: next, alreadyCorrect: false, patched: next !== content };
  }
  function patchComputerUseNodeReplDynamicToolCall(content) {
    if (content.includes(COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_PATCH_MARKER)) {
      return { content, alreadyCorrect: true, patched: false };
    }

    let next = content.replace(
      COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CURRENT_V2_RE,
      computerUseNodeReplDynamicToolCallCurrentV2Replacement,
    );
    if (next === content) {
      next = content.replace(
        COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_CURRENT_V3_RE,
        computerUseNodeReplDynamicToolCallCurrentV2Replacement,
      );
    }
    return { content: next, alreadyCorrect: false, patched: next !== content };
  }
  const ARCHIVED_THREADS_LIST_ALL_DIRECT_RE =
    /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{modelProviders:([A-Za-z_$][\w$]*),archived:([A-Za-z_$][\w$]*)=!1,sourceKinds:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),useStateDbOnly:([A-Za-z_$][\w$]*)=!1\}\)\{let ([A-Za-z_$][\w$]*)=\[\],([A-Za-z_$][\w$]*)=async ([A-Za-z_$][\w$]*)=>\{let ([A-Za-z_$][\w$]*)=await \2\.sendRequest\(`thread\/list`,\{limit:200,cursor:\10,sortKey:\2\.recentConversationsSortKey,modelProviders:\3,sourceKinds:\5,archived:\4,useStateDbOnly:\7\}\);\8\.push\(\.\.\.\11\.data\),\11\.nextCursor&&await \9\(\11\.nextCursor\)\};return await \9\(null\),\8\}/;
  const ARCHIVED_THREADS_LIST_ALL_QUERY_RE =
    /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{modelProviders:([A-Za-z_$][\w$]*),archived:([A-Za-z_$][\w$]*)=!1,sourceKinds:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),useStateDbOnly:([A-Za-z_$][\w$]*)=!1\}\)\{let ([A-Za-z_$][\w$]*)=\[\],([A-Za-z_$][\w$]*)=async ([A-Za-z_$][\w$]*)=>\{let ([A-Za-z_$][\w$]*)=\{limit:200,cursor:\10,sortKey:\2\.recentConversationsSortKey,modelProviders:\3,sourceKinds:\5,archived:\4,useStateDbOnly:\7\},([A-Za-z_$][\w$]*)=await \2\.sendRequest\(`thread\/list`,\11\);\8\.push\(\.\.\.\12\.data\),\12\.nextCursor&&await \9\(\12\.nextCursor\)\};return await \9\(null\),\8\}/;
  const ARCHIVED_THREADS_LIST_ALL_PATCHED_DIRECT_RE =
    /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{modelProviders:([A-Za-z_$][\w$]*),archived:([A-Za-z_$][\w$]*)=!1,sourceKinds:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),useStateDbOnly:([A-Za-z_$][\w$]*)=!1\}\)\{let ([A-Za-z_$][\w$]*)=\[\],([A-Za-z_$][\w$]*)=async ([A-Za-z_$][\w$]*)=>\{let ([A-Za-z_$][\w$]*);try\{\11=await \2\.sendRequest\(`thread\/list`,\{limit:200,cursor:\10,sortKey:\2\.recentConversationsSortKey,modelProviders:\3,sourceKinds:\5,archived:\4,useStateDbOnly:\7\}\)\}catch\(_codexOfflineArchiveListError\)\{if\(\4\)return;throw _codexOfflineArchiveListError\}\8\.push\(\.\.\.\(\11\.data\?\?\[\]\)\),\11\.nextCursor&&await \9\(\11\.nextCursor\)\};return await \9\(null\),\8\}\/\*codex-offline:archived-threads-partial-list\*\//;
  const ARCHIVED_THREADS_LIST_ALL_PATCHED_QUERY_RE =
    /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{modelProviders:([A-Za-z_$][\w$]*),archived:([A-Za-z_$][\w$]*)=!1,sourceKinds:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),useStateDbOnly:([A-Za-z_$][\w$]*)=!1\}\)\{let ([A-Za-z_$][\w$]*)=\[\],([A-Za-z_$][\w$]*)=async ([A-Za-z_$][\w$]*)=>\{let ([A-Za-z_$][\w$]*)=\{limit:200,cursor:\10,sortKey:\2\.recentConversationsSortKey,modelProviders:\3,sourceKinds:\5,archived:\4,useStateDbOnly:\7\},([A-Za-z_$][\w$]*);try\{\12=await \2\.sendRequest\(`thread\/list`,\11\)\}catch\(_codexOfflineArchiveListError\)\{if\(\4\)return;throw _codexOfflineArchiveListError\}\8\.push\(\.\.\.\(\12\.data\?\?\[\]\)\),\12\.nextCursor&&await \9\(\12\.nextCursor\)\};return await \9\(null\),\8\}\/\*codex-offline:archived-threads-partial-list\*\//;
  const ARCHIVED_THREADS_LIST_ALL_CURRENT_RE =
    /function (?<functionName>[A-Za-z_$][\w$]*)\((?<requestClient>[A-Za-z_$][\w$]*),\{modelProviders:(?<modelProviders>[A-Za-z_$][\w$]*),archived:(?<archived>[A-Za-z_$][\w$]*)=!1,sourceKinds:(?<sourceKinds>[A-Za-z_$][\w$]*)=(?<defaultSourceKinds>[A-Za-z_$][\w$]*),useStateDbOnly:(?<useStateDbOnly>[A-Za-z_$][\w$]*)=!1\}\)\{let (?<threads>[A-Za-z_$][\w$]*)=\[\],(?<loadPage>[A-Za-z_$][\w$]*)=async (?<cursor>[A-Za-z_$][\w$]*)=>\{let (?<query>[A-Za-z_$][\w$]*)=\{limit:100,cursor:\k<cursor>,sortKey:\k<requestClient>\.recentConversationsSortKey,modelProviders:\k<modelProviders>,sourceKinds:\k<sourceKinds>,archived:\k<archived>,useStateDbOnly:\k<useStateDbOnly>\},(?<page>[A-Za-z_$][\w$]*)=await \k<requestClient>\.sendRequest\(`thread\/list`,\k<query>,\{priority:`background`,source:`thread_list`\}\);\k<threads>\.push\(\.\.\.\k<page>\.data\),\k<page>\.nextCursor&&await \k<loadPage>\(\k<page>\.nextCursor\)\};return await \k<loadPage>\(null\),\k<threads>\}/;
  function archivedThreadsReturnExpression(archived, failed, threads) {
    return `${archived}?(${failed}&&${threads}.length===0?` +
      `(globalThis.__codexOfflineArchivedThreadsCache??${threads}):` +
      `(globalThis.__codexOfflineArchivedThreadsCache=${threads},${threads})):${threads}`;
  }
  function patchArchivedThreadsPartialList(content) {
    if (content.includes(ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER)) {
      return { content, alreadyCorrect: true, patched: false };
    }

    let next = content.replace(
      ARCHIVED_THREADS_LIST_ALL_DIRECT_RE,
      (
        _match,
        functionName,
        requestClient,
        modelProviders,
        archived,
        sourceKinds,
        defaultSourceKinds,
        useStateDbOnly,
        threads,
        loadPage,
        cursor,
        page,
      ) => {
        const failed = '_codexOfflineArchiveListFailed';
        return (
        `async function ${functionName}(${requestClient},{modelProviders:${modelProviders},` +
        `archived:${archived}=!1,sourceKinds:${sourceKinds}=${defaultSourceKinds},` +
        `useStateDbOnly:${useStateDbOnly}=!1}){let ${threads}=[],${failed}=!1,${loadPage}=async ${cursor}=>{` +
        `let ${page};try{${page}=await ${requestClient}.sendRequest(\`thread/list\`,{limit:200,` +
          `cursor:${cursor},sortKey:${requestClient}.recentConversationsSortKey,` +
          `modelProviders:${modelProviders},sourceKinds:${sourceKinds},archived:${archived},` +
          `useStateDbOnly:${archived}?!0:${useStateDbOnly}})}catch(_codexOfflineArchiveListError){` +
        `if(${archived}){${failed}=!0;return}throw _codexOfflineArchiveListError}` +
        `${threads}.push(...(${page}.data??[])),${page}.nextCursor&&await ${loadPage}(${page}.nextCursor)` +
        `};return await ${loadPage}(null),${archivedThreadsReturnExpression(archived, failed, threads)}}` +
        ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER +
        ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER
        );
      },
    );
    if (next === content) {
      next = content.replace(
        ARCHIVED_THREADS_LIST_ALL_QUERY_RE,
        (
          _match,
          functionName,
          requestClient,
          modelProviders,
          archived,
          sourceKinds,
          defaultSourceKinds,
          useStateDbOnly,
          threads,
          loadPage,
          cursor,
          query,
          page,
        ) => {
          const failed = '_codexOfflineArchiveListFailed';
          return (
          `async function ${functionName}(${requestClient},{modelProviders:${modelProviders},` +
          `archived:${archived}=!1,sourceKinds:${sourceKinds}=${defaultSourceKinds},` +
          `useStateDbOnly:${useStateDbOnly}=!1}){let ${threads}=[],${failed}=!1,${loadPage}=async ${cursor}=>{` +
          `let ${query}={limit:200,cursor:${cursor},sortKey:${requestClient}.recentConversationsSortKey,` +
          `modelProviders:${modelProviders},sourceKinds:${sourceKinds},archived:${archived},` +
          `useStateDbOnly:${archived}?!0:${useStateDbOnly}},${page};try{${page}=await ${requestClient}.sendRequest(\`thread/list\`,${query})` +
          `}catch(_codexOfflineArchiveListError){if(${archived}){${failed}=!0;return}throw _codexOfflineArchiveListError}` +
          `${threads}.push(...(${page}.data??[])),${page}.nextCursor&&await ${loadPage}(${page}.nextCursor)` +
          `};return await ${loadPage}(null),${archivedThreadsReturnExpression(archived, failed, threads)}}` +
          ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER +
          ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER
          );
        },
      );
    }
    if (next === content) {
      next = content.replace(
        ARCHIVED_THREADS_LIST_ALL_PATCHED_DIRECT_RE,
        (
          _match,
          functionName,
          requestClient,
          modelProviders,
          archived,
          sourceKinds,
          defaultSourceKinds,
          useStateDbOnly,
          threads,
          loadPage,
          cursor,
          page,
        ) => {
          const failed = '_codexOfflineArchiveListFailed';
          return (
          `async function ${functionName}(${requestClient},{modelProviders:${modelProviders},` +
          `archived:${archived}=!1,sourceKinds:${sourceKinds}=${defaultSourceKinds},` +
          `useStateDbOnly:${useStateDbOnly}=!1}){let ${threads}=[],${failed}=!1,${loadPage}=async ${cursor}=>{` +
          `let ${page};try{${page}=await ${requestClient}.sendRequest(\`thread/list\`,{limit:200,` +
        `cursor:${cursor},sortKey:${requestClient}.recentConversationsSortKey,` +
        `modelProviders:${modelProviders},sourceKinds:${sourceKinds},archived:${archived},` +
        `useStateDbOnly:${archived}?!0:${useStateDbOnly}})}catch(_codexOfflineArchiveListError){` +
          `if(${archived}){${failed}=!0;return}throw _codexOfflineArchiveListError}` +
          `${threads}.push(...(${page}.data??[])),${page}.nextCursor&&await ${loadPage}(${page}.nextCursor)` +
          `};return await ${loadPage}(null),${archivedThreadsReturnExpression(archived, failed, threads)}}` +
          ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER +
          ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER
          );
        },
      );
    }
    if (next === content) {
      next = content.replace(
        ARCHIVED_THREADS_LIST_ALL_PATCHED_QUERY_RE,
        (
          _match,
          functionName,
          requestClient,
          modelProviders,
          archived,
          sourceKinds,
          defaultSourceKinds,
          useStateDbOnly,
          threads,
          loadPage,
          cursor,
          query,
          page,
        ) => {
          const failed = '_codexOfflineArchiveListFailed';
          return (
          `async function ${functionName}(${requestClient},{modelProviders:${modelProviders},` +
          `archived:${archived}=!1,sourceKinds:${sourceKinds}=${defaultSourceKinds},` +
          `useStateDbOnly:${useStateDbOnly}=!1}){let ${threads}=[],${failed}=!1,${loadPage}=async ${cursor}=>{` +
          `let ${query}={limit:200,cursor:${cursor},sortKey:${requestClient}.recentConversationsSortKey,` +
          `modelProviders:${modelProviders},sourceKinds:${sourceKinds},archived:${archived},` +
          `useStateDbOnly:${archived}?!0:${useStateDbOnly}},${page};try{${page}=await ${requestClient}.sendRequest(\`thread/list\`,${query})` +
          `}catch(_codexOfflineArchiveListError){if(${archived}){${failed}=!0;return}throw _codexOfflineArchiveListError}` +
          `${threads}.push(...(${page}.data??[])),${page}.nextCursor&&await ${loadPage}(${page}.nextCursor)` +
          `};return await ${loadPage}(null),${archivedThreadsReturnExpression(archived, failed, threads)}}` +
          ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER +
          ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER
          );
        },
      );
    }
    if (next === content) {
      next = content.replace(
        ARCHIVED_THREADS_LIST_ALL_CURRENT_RE,
        (
          _match,
          functionName,
          requestClient,
          modelProviders,
          archived,
          sourceKinds,
          defaultSourceKinds,
          useStateDbOnly,
          threads,
          loadPage,
          cursor,
          query,
          page,
        ) => {
          const failed = '_codexOfflineArchiveListFailed';
          return (
          `function ${functionName}(${requestClient},{modelProviders:${modelProviders},` +
          `archived:${archived}=!1,sourceKinds:${sourceKinds}=${defaultSourceKinds},` +
          `useStateDbOnly:${useStateDbOnly}=!1}){let ${threads}=[],${failed}=!1,${loadPage}=async ${cursor}=>{` +
          `let ${query}={limit:100,cursor:${cursor},sortKey:${requestClient}.recentConversationsSortKey,` +
          `modelProviders:${modelProviders},sourceKinds:${sourceKinds},archived:${archived},` +
          `useStateDbOnly:${archived}?!0:${useStateDbOnly}},${page};try{${page}=await ${requestClient}.sendRequest(` +
          `\`thread/list\`,${query},{priority:\`background\`,source:\`thread_list\`})` +
          `}catch(_codexOfflineArchiveListError){if(${archived}){${failed}=!0;return}` +
          `throw _codexOfflineArchiveListError}${threads}.push(...(${page}.data??[])),` +
          `${page}.nextCursor&&await ${loadPage}(${page}.nextCursor)};return await ${loadPage}(null),` +
          `${archivedThreadsReturnExpression(archived, failed, threads)}}` +
          ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER +
          ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER
          );
        },
      );
    }
    return { content: next, alreadyCorrect: false, patched: next !== content };
  }
  // The archived settings panel (Settings → Data controls → Archived) combines
  // the LOCAL archived-thread query error with a CLOUD tasks query error into a
  // single isError prop: `<isErr>=<localErr>||<cloudData>==null&&<cloudErr>`. The
  // cloud query hits /wham/tasks/list, so while OFFLINE it always fails, forcing
  // the whole panel into its error state and hiding the perfectly good local
  // archived conversations. Drop the cloud term so local archived chats still
  // render offline; a genuine local query failure (localErr) still shows the
  // error state. Root cause of issue #55's "archived disappears when offline".
  function patchArchivedSettingsOfflineVisibility(content) {
    if (content.includes(ARCHIVED_SETTINGS_OFFLINE_LOCAL_VISIBILITY_PATCH_MARKER)) {
      return { content, alreadyCorrect: true, patched: false };
    }

    const archivedPanelAnchor = content.indexOf('archivedChats:');
    if (archivedPanelAnchor < 0) {
      return { content, alreadyCorrect: false, patched: false };
    }
    // Prop keys (archivedChats … isError … onLoadNextPage) are stable component
    // prop names; the isError value is a minified local we capture and rewrite.
    const isErrorPropMatch = content
      .slice(archivedPanelAnchor, archivedPanelAnchor + 400)
      .match(/isError:([A-Za-z_$][\w$]*),onLoadNextPage:/);
    if (!isErrorPropMatch) {
      return { content, alreadyCorrect: false, patched: false };
    }
    const isErrorVar = isErrorPropMatch[1];
    const combinedErrorRe = new RegExp(
      '(^|[^\\w$])(' + isErrorVar + ')=([A-Za-z_$][\\w$]*)\\|\\|' +
        '[A-Za-z_$][\\w$]*==null&&[A-Za-z_$][\\w$]*(?=[,;)])',
    );
    if (!combinedErrorRe.test(content)) {
      return { content, alreadyCorrect: false, patched: false };
    }
    const next = content.replace(
      combinedErrorRe,
      (_match, prefix, errorVar, localErrorVar) =>
        `${prefix}${errorVar}=${localErrorVar}` +
        ARCHIVED_SETTINGS_OFFLINE_LOCAL_VISIBILITY_PATCH_MARKER,
    );
    return { content: next, alreadyCorrect: false, patched: next !== content };
  }
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_LEGACY_RE =
    /if\(([A-Za-z_$][\w$]*)\.namespace===`node_repl`&&([A-Za-z_$][\w$]*)===`js`\)\{let _codexOfflineNodeReplResult;try\{_codexOfflineNodeReplResult=await Pi\(`mcpServer\/tool\/call`,\{params:\{threadId:([A-Za-z_$][\w$]*),server:`node_repl`,tool:`js`,arguments:\1\.arguments\}\}\);let _codexOfflineNodeReplText=Array\.isArray\(_codexOfflineNodeReplResult\?\.content\)\?_codexOfflineNodeReplResult\.content\.map\(e=>e\?\.type===`text`\?String\(e\.text\?\?``\):JSON\.stringify\(e\)\)\.join\(`\\n`\):JSON\.stringify\(_codexOfflineNodeReplResult\);u=\{contentItems:\[\{type:`inputText`,text:_codexOfflineNodeReplText\}\],success:_codexOfflineNodeReplResult\?\.isError!==!0\}\}catch\(_codexOfflineNodeReplError\)\{u=Ge\(String\(_codexOfflineNodeReplError\?\.message\?\?_codexOfflineNodeReplError\)\)\}\/\*codex-offline:computer-use-node-repl-dynamic-tool-call\*\/X\.dispatchMessage\(`mcp-response`,\{hostId:([A-Za-z_$][\w$]*),response:\{id:a\(([A-Za-z_$][\w$]*)\),result:u\}\}\);return\}/;
  const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_LEGACY_REPLACEMENT =
    'if(($1.namespace===`node_repl`&&$2===`js`)||($1.namespace==null&&$2===`js`)){let _codexOfflineNodeReplResult,_codexOfflineNodeReplResponse;try{' +
    '_codexOfflineNodeReplResult=await ln(`call-mcp-tool`,{hostId:$4,threadId:$3,server:`node_repl`,tool:`js`,arguments:$1.arguments});' +
    COMPUTER_USE_NODE_REPL_RESULT_TEXT_CODE +
    'G.info(`computer_use_node_repl_js_call`,{safe:{namespace:$1.namespace??null,tool:$2,codePrefix:String($1.arguments?.code??``).slice(0,500),hasSetupComputerUseRuntime:String($1.arguments?.code??``).includes(`setupComputerUseRuntime`),hasDirectSkyImport:String($1.arguments?.code??``).includes(`@oai/sky`),hasListApps:String($1.arguments?.code??``).includes(`list_apps`),resultPrefix:_codexOfflineNodeReplText.slice(0,500),isError:_codexOfflineNodeReplResult?.isError===!0},sensitive:{}});' +
    '_codexOfflineNodeReplResponse={contentItems:[{type:`inputText`,text:_codexOfflineNodeReplText}],success:_codexOfflineNodeReplResult?.isError!==!0}' +
    '}catch(_codexOfflineNodeReplError){_codexOfflineNodeReplResponse=Ge(String(_codexOfflineNodeReplError?.message??_codexOfflineNodeReplError))}' +
    COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_PATCH_MARKER +
    'X.dispatchMessage(`mcp-response`,{hostId:$4,response:{id:a($5),result:_codexOfflineNodeReplResponse}});return}';
  // ── Patch 36: Keep bundled browser plugins in runtime marketplace ─────
  const BUNDLED_BROWSER_PLUGINS_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:bundled-browser-plugins-no-force-reload*/');
  const CHROME_DESCRIPTOR_RE =
    /(\{forceReload:!0,)(?:installWhenMissing:!0,)?(name:lt,isAvailable:\(\{buildFlavor:([A-Za-z_$][\w$]*),features:([A-Za-z_$][\w$]*)\}\)=>)(\4\.externalBrowserUseAllowed&&Yn\(\3\))(\})/;
  const CHROME_DESCRIPTOR_PATCHED_RE =
    /\{installWhenMissing:!0,name:lt,isAvailable:\(\{buildFlavor:[A-Za-z_$][\w$]*,features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0\}/;
  const BROWSER_USE_DESCRIPTOR_RE =
    /(\{autoInstallOptOutKey:([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\2\.([A-Za-z_$][\w$]*)\),(?:forceReload:!0,)?installWhenMissing:!0,name:\2\.\4,isAvailable:\(\{features:([A-Za-z_$][\w$]*)\}\)=>)(\5\.inAppBrowserUseAllowed)(,migrate:([A-Za-z_$][\w$]*)\})/;
  const BROWSER_USE_DESCRIPTOR_PATCHED_RE =
    /\{autoInstallOptOutKey:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\),installWhenMissing:!0,name:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*,isAvailable:\(\{features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0,migrate:[A-Za-z_$][\w$]*\}/;
  const SYNC_EXTERNAL_BROWSER_DESCRIPTOR_RE =
    /\{(?:forceReload:!0,)?name:([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?),syncInstallStateWithChromeExtension:!0,isAvailable:\(\{(buildFlavor:[A-Za-z_$][\w$]*(?:,env:[A-Za-z_$][\w$]*)?,features:([A-Za-z_$][\w$]*))\}\)=>(?:(?:[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)?\)&&\3\.externalBrowserUseAllowed)|(?:\3\.externalBrowserUseAllowed&&[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)))(\})/g;
  const SYNC_EXTERNAL_BROWSER_DESCRIPTOR_PATCHED_RE =
    /\{installWhenMissing:!0,name:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:[A-Za-z_$][\w$]*(?:,env:[A-Za-z_$][\w$]*)?,features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0\}/;
  const IN_APP_BROWSER_DESCRIPTOR_RE =
    /(\{forceReload:!0,name:([A-Za-z_$][\w$]*)\.On,isAvailable:\(\{buildFlavor:([A-Za-z_$][\w$]*),features:([A-Za-z_$][\w$]*)\}\)=>)(Jn\(\3\)&&\4\.externalBrowserUseAllowed)(\})/;
  const IN_APP_BROWSER_DESCRIPTOR_PATCHED_RE =
    /\{installWhenMissing:!0,name:[A-Za-z_$][\w$]*\.On,isAvailable:\(\{buildFlavor:[A-Za-z_$][\w$]*,features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0\}/;
  const BUNDLED_RUNTIME_PLUGIN_NAMES = [
    'computer-use',
    'documents',
    'spreadsheets',
    'presentations',
  ];
  const BUNDLED_RUNTIME_MARKETPLACE_FILTER_PATCH_MARKER =
    '/*codex-offline:bundled-runtime-plugins*/';
  const BUNDLED_RUNTIME_MARKETPLACE_FILTER_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let\s+([A-Za-z_$][\w$]*)=new Set\(\2\.(enabledPluginNames|marketplacePluginNames)\);return\{\.\.\.\2\.marketplace,plugins:\2\.marketplace\.plugins\.filter\(([A-Za-z_$][\w$]*)=>\3\.has\(\5\.name\)\)\}\}/;

  const mainBuildDir = path.join(tmpDir, '.vite', 'build');
  const mainBundleFiles = Array.from(new Set([
    mainEntry,
    ...listJavaScriptFiles(mainBuildDir),
  ]));
  const settingsPatchedFiles = [];
  const settingsRoutePatchedFiles = [];
  const settingsRouteAlreadyCorrectFiles = [];
  let settingsHandlerSeen = false;

  const trustedBrowserClientHashesPatch =
    patchTrustedBrowserClientHashes(mainBundleFiles, chromeBrowserClientHash);
  if (trustedBrowserClientHashesPatch.patchedFiles.length > 0) {
    log(
      'Chrome browser-client trusted hash patched in ' +
      `${trustedBrowserClientHashesPatch.patchedFiles.map(filePath => path.relative(tmpDir, filePath)).join(', ')}.`,
    );
  } else if (trustedBrowserClientHashesPatch.alreadyCorrect) {
    log('Chrome browser-client trusted hash already patched.');
  } else {
    throw new Error(
      'Could not locate Browser Use trusted browser-client hash list to trust ' +
      'the patched bundled Chrome browser-client.',
    );
  }

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    const originalContent = content;
    let modified = false;

    settingsHandlerSeen ||= content.includes('case`show-settings`:{');

    if (content.includes(NOT_IMPLEMENTED_NEEDLE_V1)) {
      content = content.replace(
        NOT_IMPLEMENTED_NEEDLE_V1,
        SETTINGS_REPLACEMENT_V1,
      );
      modified = true;
      settingsPatchedFiles.push(path.relative(tmpDir, filePath));
    } else if (content.includes(NOT_IMPLEMENTED_NEEDLE_V2)) {
      content = content.replace(
        NOT_IMPLEMENTED_NEEDLE_V2,
        SETTINGS_REPLACEMENT_V2,
      );
      modified = true;
      settingsPatchedFiles.push(path.relative(tmpDir, filePath));
    } else if (content.includes(NOT_IMPLEMENTED_NEEDLE_V3)) {
      content = content.replace(
        NOT_IMPLEMENTED_NEEDLE_V3,
        SETTINGS_REPLACEMENT_V3,
      );
      modified = true;
      settingsPatchedFiles.push(path.relative(tmpDir, filePath));
    } else if (content.includes(NOT_IMPLEMENTED_NEEDLE_V4)) {
      content = content.replace(
        NOT_IMPLEMENTED_NEEDLE_V4,
        SETTINGS_REPLACEMENT_V4,
      );
      modified = true;
      settingsPatchedFiles.push(path.relative(tmpDir, filePath));
    }

    SETTINGS_ROUTE_DIRECT_RE_GLOBAL.lastIndex = 0;
    const routeMatches = content.match(SETTINGS_ROUTE_DIRECT_RE_GLOBAL);
    if (routeMatches) {
      SETTINGS_ROUTE_DIRECT_RE_GLOBAL.lastIndex = 0;
      content = content.replace(
        SETTINGS_ROUTE_DIRECT_RE_GLOBAL,
        (_, urlVar, messageVar) => buildSettingsRouteStatement(urlVar, messageVar),
      );
      modified = true;
      settingsRoutePatchedFiles.push(path.relative(tmpDir, filePath));
    } else if (
      originalContent.includes(SETTINGS_ROUTE_PATCH_MARKER) ||
      content.includes(SETTINGS_ROUTE_PATCH_MARKER)
    ) {
      settingsRouteAlreadyCorrectFiles.push(path.relative(tmpDir, filePath));
    }

    settingsHandlerSeen ||= content.includes('case`show-settings`:{');

    if (modified) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }

  if (settingsPatchedFiles.length > 0) {
    log(`Settings IPC handlers patched in ${settingsPatchedFiles.join(', ')}.`);
  }
  if (settingsRoutePatchedFiles.length > 0) {
    log(
      `Settings route mapping fixed in ` +
      `${settingsRoutePatchedFiles.join(', ')}.`,
    );
  }
  if (
    settingsPatchedFiles.length === 0 &&
    settingsRoutePatchedFiles.length === 0 &&
    settingsRouteAlreadyCorrectFiles.length > 0
  ) {
    log(
      `Settings IPC handlers already patched in ` +
      `${settingsRouteAlreadyCorrectFiles.join(', ')}.`,
    );
  }
  if (!settingsHandlerSeen) {
    failRequiredPatch('Could not locate the "not implemented" throw for show-settings. ' +
         'Settings patch skipped (the app version may have changed).');
  }

  // A previous portable-startup guard removed the CommonJS namespace wrapper
  // around the Electron module. That avoided autoUpdater reads, but it also
  // removed the `.default` export shape used by newer main bundles
  // (`electronNamespace.default.app`). Restore that wrapper when repatching an
  // affected build; the actual autoUpdater read is disabled below in Sentry's
  // breadcrumb setup.
  const electronNamespaceRestoredFiles = [];
  const electronNamespaceLegacyRe =
    /let ([A-Za-z_$][\w$]*)=require\(`electron`\);\/\*codex-offline:electron-namespace-no-auto-updater\*\//g;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (!electronNamespaceLegacyRe.test(content)) {
      electronNamespaceLegacyRe.lastIndex = 0;
      continue;
    }

    const helperMatch = content.match(
      /(?:const|let|var) ([A-Za-z_$][\w$]*)=require\(`\.\/src-[^`]+\.js`\)/,
    );
    if (!helperMatch) {
      electronNamespaceLegacyRe.lastIndex = 0;
      warn(
        'Found legacy Electron namespace patch but could not resolve the ' +
        `namespace helper in ${path.relative(tmpDir, filePath)}.`,
      );
      continue;
    }

    const helperVar = helperMatch[1];
    electronNamespaceLegacyRe.lastIndex = 0;
    content = content.replaceAll(
      electronNamespaceLegacyRe,
      `let $1=require(\`electron\`);$1=${helperVar}.Hi($1);`,
    );
    electronNamespaceLegacyRe.lastIndex = 0;
    fs.writeFileSync(filePath, content, 'utf8');
    electronNamespaceRestoredFiles.push(path.relative(tmpDir, filePath));
  }

  if (electronNamespaceRestoredFiles.length > 0) {
    log(
      'Legacy Electron namespace startup guard restored in ' +
      `${electronNamespaceRestoredFiles.join(', ')}.`,
    );
  }

  // Note: the former "autoUpdater breadcrumb" needle patch (which rewrote
  // Sentry's `autoUpdater:()=>!0` so it would not read electron.autoUpdater at
  // bootstrap) is no longer needed. The MSIX updater binding stub injected into
  // the main entry intercepts process._linkedBinding("electron_browser_msix_updater")
  // at a stable interface boundary, so reading electron.autoUpdater can no
  // longer abort startup — making the brittle minified needle obsolete.

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
    let fileChanged = false;
    let fileDetected = false;

    for (const { needle, replacement } of APP_SERVER_SANDBOX_OVERRIDE_PATCHES) {
      const alreadyPatchedCount = countOccurrences(content, replacement);
      if (alreadyPatchedCount > 0) {
        appServerSandboxOverrideDetected += alreadyPatchedCount;
        fileDetected = true;
      }

      const needleCount = countOccurrences(content, needle);
      if (needleCount === 0) continue;

      content = content.split(needle).join(replacement);
      appServerSandboxOverrideCount += needleCount;
      appServerSandboxOverrideDetected += needleCount;
      fileChanged = true;
      fileDetected = true;
    }

    if (fileChanged) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
    if (fileDetected) {
      appServerSandboxOverridePatchedFiles.push(path.relative(tmpDir, filePath));
    }
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

  // ── Patch 38: Enable Browser Use native pipe config for offline Windows ─
  //
  // The direct-launch bootstrap enables the Windows node_repl backend for
  // Computer Use. Browser Use needs the same desktop availability object to
  // include chrome/iab backends so node_repl receives the trusted
  // browser-client hash and request metadata.
  const windowsBrowserUseCapabilityPatchedFiles = [];
  let windowsBrowserUseCapabilityPatched = false;
  let windowsBrowserUseCapabilityAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(WINDOWS_BROWSER_USE_CAPABILITY_PATCH_MARKER)) {
      windowsBrowserUseCapabilityAlreadyCorrect = true;
      windowsBrowserUseCapabilityPatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    if (WINDOWS_BROWSER_USE_CAPABILITY_LEGACY_RE.test(content)) {
      content = content.replace(
        WINDOWS_BROWSER_USE_CAPABILITY_LEGACY_RE,
        'function $1($2,{env:$3=process.env,platform:$4=process.platform}={}){' +
          'return $4!==`win32`||$3.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`?$2:' +
          `{...$2,${DESKTOP_BROWSER_USE_CAPABILITY_PATCH_FIELDS}${WINDOWS_BROWSER_USE_CAPABILITY_PATCH_MARKER}}}`,
      );
    } else if (WINDOWS_BROWSER_USE_CAPABILITY_CURRENT_RE.test(content)) {
      content = content.replace(
        WINDOWS_BROWSER_USE_CAPABILITY_CURRENT_RE,
        'function $1($2,{$3}={}){' +
          'let $6=$5===`win32`&&$4.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?' +
          `{...$2,${DESKTOP_BROWSER_USE_CAPABILITY_PATCH_FIELDS}${WINDOWS_BROWSER_USE_CAPABILITY_PATCH_MARKER}}:$2,`,
      );
    } else if (WINDOWS_BROWSER_USE_CAPABILITY_V3_RE.test(content)) {
      content = content.replace(
        WINDOWS_BROWSER_USE_CAPABILITY_V3_RE,
        ',$1=$2===`win32`&&$3.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?' +
          `{...$4,computerUse:!0,computerUseNodeRepl:!0,${DESKTOP_BROWSER_USE_CAPABILITY_PATCH_FIELDS}${WINDOWS_BROWSER_USE_CAPABILITY_PATCH_MARKER}}:$4`,
      );
    } else {
      continue;
    }

    fs.writeFileSync(filePath, content, 'utf8');
    windowsBrowserUseCapabilityPatched = true;
    windowsBrowserUseCapabilityPatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (windowsBrowserUseCapabilityPatched) {
    log('Windows Browser Use capability override patched in ' +
        `${windowsBrowserUseCapabilityPatchedFiles.join(', ')}.`);
  } else if (windowsBrowserUseCapabilityAlreadyCorrect) {
    log('Windows Browser Use capability override already patched.');
  } else {
    throw new Error(
      'Could not locate the Windows desktop feature override that enables ' +
      'node_repl. @chrome may start node_repl without trusted browser-client ' +
      'metadata in offline builds.',
    );
  }

  // ── Patch 41: Enable node_repl config for offline Computer Use ─────────
  const nodeReplFeatureConfigPatchedFiles = [];
  let nodeReplFeatureConfigPatched = false;
  let nodeReplFeatureConfigAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (NODE_REPL_FEATURE_CONFIG_PATCHED_RE.test(content)) {
      nodeReplFeatureConfigAlreadyCorrect = true;
      nodeReplFeatureConfigPatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    NODE_REPL_FEATURE_CONFIG_RE.lastIndex = 0;
    if (!NODE_REPL_FEATURE_CONFIG_RE.test(content)) continue;

    NODE_REPL_FEATURE_CONFIG_RE.lastIndex = 0;
    content = content.replace(
      NODE_REPL_FEATURE_CONFIG_RE,
      `$1!0${NODE_REPL_FEATURE_ENABLED_PATCH_MARKER}$3`,
    );
    fs.writeFileSync(filePath, content, 'utf8');
    nodeReplFeatureConfigPatched = true;
    nodeReplFeatureConfigPatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (nodeReplFeatureConfigPatched) {
    log('Node REPL feature config default enabled in ' +
        `${nodeReplFeatureConfigPatchedFiles.join(', ')}.`);
  } else if (nodeReplFeatureConfigAlreadyCorrect) {
    log('Node REPL feature config default already enabled.');
  } else {
    throw new Error(
      'Could not locate Browser Use thread config features.js_repl default. ' +
      'Computer Use may not receive the official JavaScript execution tool.',
    );
  }

  const featureOverridesConfigNamespacePatchedFiles = [];
  let featureOverridesConfigNamespacePatched = false;
  let featureOverridesConfigNamespaceAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER)) {
      if (!FEATURE_OVERRIDES_TOOL_SEARCH_PATCHED_RE.test(content)) {
        let patchedContent = content.replace(
          FEATURE_OVERRIDES_UNIFIED_EXEC_ONLY_RE,
          'return $1[`features.unified_exec`]=!0,$1[`features.tool_search`]=!0,' +
            '$1[`features.js_repl_tools_only`]=!0,$1[`features.tool_suggest`]=!0,' +
            '$1[`features.tool_search_always_defer_mcp_tools`]=!0,' +
            '$1[`features.non_prefixed_mcp_tool_names`]=!0,' +
            '$1[`features.unavailable_dummy_tools`]=!0,$1}' +
            FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER,
        );
        if (patchedContent === content) {
          patchedContent = content.replace(
            FEATURE_OVERRIDES_TOOL_SEARCH_ONLY_RE,
            'return $1[`features.unified_exec`]=!0,$1[`features.tool_search`]=!0,' +
              '$1[`features.js_repl_tools_only`]=!0,$1[`features.tool_suggest`]=!0,' +
              '$1[`features.tool_search_always_defer_mcp_tools`]=!0,' +
              '$1[`features.non_prefixed_mcp_tool_names`]=!0,' +
              '$1[`features.unavailable_dummy_tools`]=!0,$1}' +
              FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER,
          );
        }
        if (patchedContent === content) {
          patchedContent = content.replace(
            FEATURE_OVERRIDES_TOOL_SEARCH_JS_REPL_ONLY_RE,
            'return $1[`features.unified_exec`]=!0,$1[`features.tool_search`]=!0,' +
              '$1[`features.js_repl_tools_only`]=!0,$1[`features.tool_suggest`]=!0,' +
              '$1[`features.tool_search_always_defer_mcp_tools`]=!0,' +
              '$1[`features.non_prefixed_mcp_tool_names`]=!0,' +
              '$1[`features.unavailable_dummy_tools`]=!0,$1}' +
              FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER,
          );
        }
        if (patchedContent === content) {
          patchedContent = content.replace(
            FEATURE_OVERRIDES_TOOL_SUGGEST_ONLY_RE,
            'return $1[`features.unified_exec`]=!0,$1[`features.tool_search`]=!0,' +
              '$1[`features.js_repl_tools_only`]=!0,$1[`features.tool_suggest`]=!0,' +
              '$1[`features.tool_search_always_defer_mcp_tools`]=!0,' +
              '$1[`features.non_prefixed_mcp_tool_names`]=!0,' +
              '$1[`features.unavailable_dummy_tools`]=!0,$1}' +
              FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER,
          );
        }
        if (patchedContent === content) {
          throw new Error(
            'Could not upgrade feature override config merge to preserve ' +
            'Computer Use MCP discovery feature flags.',
          );
        }
        content = patchedContent;
        fs.writeFileSync(filePath, content, 'utf8');
        featureOverridesConfigNamespacePatched = true;
      } else {
        featureOverridesConfigNamespaceAlreadyCorrect = true;
      }
      featureOverridesConfigNamespacePatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    FEATURE_OVERRIDES_CONFIG_NAMESPACE_RE.lastIndex = 0;
    if (!FEATURE_OVERRIDES_CONFIG_NAMESPACE_RE.test(content)) continue;

    content = content.replace(
      FEATURE_OVERRIDES_CONFIG_NAMESPACE_RE,
      (
        _match,
        functionName,
        inputVar,
        outputVar,
        keyVar,
        valueVar,
        normalizedKeyVar,
        stripPrefixFunction,
        unsupportedFeaturesSet,
        ensureFeaturePrefixFunction,
      ) =>
        `function ${functionName}(${inputVar}){let ${outputVar}={};` +
        `for(let[${keyVar},${valueVar}]of Object.entries(${inputVar})){` +
        `if(${keyVar}.startsWith(\`mcp_servers.\`)){${outputVar}[${keyVar}]=${valueVar};continue}` +
        `let ${normalizedKeyVar}=${stripPrefixFunction}(${keyVar});` +
        `${unsupportedFeaturesSet}.has(${normalizedKeyVar})||` +
        `(${outputVar}[${ensureFeaturePrefixFunction}(${normalizedKeyVar})]=${valueVar})}` +
        `return ${outputVar}[\`features.unified_exec\`]=!0,` +
        `${outputVar}[\`features.tool_search\`]=!0,` +
        `${outputVar}[\`features.js_repl_tools_only\`]=!0,` +
        `${outputVar}[\`features.tool_suggest\`]=!0,` +
        `${outputVar}[\`features.tool_search_always_defer_mcp_tools\`]=!0,` +
        `${outputVar}[\`features.non_prefixed_mcp_tool_names\`]=!0,` +
        `${outputVar}[\`features.unavailable_dummy_tools\`]=!0,${outputVar}}` +
        FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER,
    );
    fs.writeFileSync(filePath, content, 'utf8');
    featureOverridesConfigNamespacePatched = true;
    featureOverridesConfigNamespacePatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (featureOverridesConfigNamespacePatched) {
    log('Feature override config namespace preservation patched in ' +
        `${featureOverridesConfigNamespacePatchedFiles.join(', ')}.`);
  } else if (featureOverridesConfigNamespaceAlreadyCorrect) {
    log('Feature override config namespace preservation already patched.');
  } else {
    failRequiredPatch(
      'Could not locate feature override config merge function (app version may have changed). ' +
      'Computer Use may lose mcp_servers.node_repl before thread startup.',
    );
  }

  const bundledPluginCacheLockNonfatalPatchedFiles = [];
  let bundledPluginCacheLockNonfatalPatched = false;
  let bundledPluginCacheLockNonfatalAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    const originalContent = content;

    if (content.includes(BUNDLED_PLUGIN_CACHE_LOCK_THROW_NEEDLE)) {
      content = content.replace(
        BUNDLED_PLUGIN_CACHE_LOCK_THROW_NEEDLE,
        BUNDLED_PLUGIN_CACHE_LOCK_THROW_REPLACEMENT,
      );
    }

    content = content.replace(
      BUNDLED_PLUGIN_CACHE_LOCK_THROW_RE,
      (match, resultVar, loggerVar, categoryFn) =>
        `if(${resultVar}!=null){let _codexOfflinePluginCacheCategory=${categoryFn}({error:${resultVar}.error,platformFamily:e.platformFamily});` +
        `if(${loggerVar}.warning(\`bundled_plugins_marketplace_install_failed\`,{safe:{errorCategory:_codexOfflinePluginCacheCategory,marketplaceName:t,platformFamily:e.platformFamily,...${resultVar}.safe},sensitive:{error:${resultVar}.error,marketplaceRoot:e.materializedMarketplace.marketplaceRoot,...${resultVar}.sensitive}}),` +
        `n&&_codexOfflinePluginCacheCategory!==${BUNDLED_PLUGIN_CACHE_LOCK_CATEGORY_VALUE})throw ${resultVar}.error;` +
        `return _codexOfflinePluginCacheCategory===${BUNDLED_PLUGIN_CACHE_LOCK_CATEGORY_VALUE}` +
        BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER +
        '}return!0}',
    );

    content = content.replace(
      BUNDLED_PLUGIN_CACHE_LOCK_CATCH_THROW_RE,
      (match, errorVar, loggerVar, categoryFn) =>
        `catch(${errorVar}){let _codexOfflinePluginCacheCategory=${categoryFn}({error:${errorVar},platformFamily:e.platformFamily});` +
        `if(${loggerVar}.warning(\`bundled_plugins_marketplace_install_failed\`,{safe:{errorCategory:_codexOfflinePluginCacheCategory,marketplaceName:t,platformFamily:e.platformFamily},sensitive:{error:${errorVar},marketplaceRoot:e.materializedMarketplace.marketplaceRoot}}),` +
        `n&&_codexOfflinePluginCacheCategory!==${BUNDLED_PLUGIN_CACHE_LOCK_CATEGORY_VALUE})throw ${errorVar};` +
        `return _codexOfflinePluginCacheCategory===${BUNDLED_PLUGIN_CACHE_LOCK_CATEGORY_VALUE}` +
        BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER +
        '}',
    );

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content, 'utf8');
      bundledPluginCacheLockNonfatalPatched = true;
      bundledPluginCacheLockNonfatalPatchedFiles.push(path.relative(tmpDir, filePath));
    } else if (content.includes(BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER)) {
      bundledPluginCacheLockNonfatalAlreadyCorrect = true;
      bundledPluginCacheLockNonfatalPatchedFiles.push(path.relative(tmpDir, filePath));
    }
  }

  if (bundledPluginCacheLockNonfatalPatched) {
    log('Bundled plugin cache lock failures are nonfatal on Windows in ' +
        `${bundledPluginCacheLockNonfatalPatchedFiles.join(', ')}.`);
  } else if (bundledPluginCacheLockNonfatalAlreadyCorrect) {
    log('Bundled plugin cache lock failure handling already patched.');
  } else {
    warn(
      'Could not locate bundled plugin cache lock failure handling (app version may have changed). ' +
      'A locked Chrome plugin cache can still abort Computer Use plugin installation.',
    );
  }

  const nodeReplDisableSandboxPatchedFiles = [];
  let nodeReplDisableSandboxPatched = false;
  let nodeReplDisableSandboxAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER)) {
      const originalContent = content;
      if (!content.includes(NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER)) {
        content = content.replace(
          NODE_REPL_TOOL_SEARCH_FEATURE_UPGRADE_RE,
          NODE_REPL_TOOL_SEARCH_FEATURE_UPGRADE_REPLACEMENT,
        );
        if (!content.includes(NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER)) {
          warn(
            'Could not locate legacy node_repl --disable-sandbox patch to ' +
            'upgrade with features.tool_search for Computer Use (app version may have changed).',
          );
        }
      } else if (NODE_REPL_TOOL_SEARCH_FEATURE_MISSING_SEPARATOR_RE.test(content)) {
        content = content.replace(
          NODE_REPL_TOOL_SEARCH_FEATURE_MISSING_SEPARATOR_RE,
          NODE_REPL_TOOL_SEARCH_FEATURE_MISSING_SEPARATOR_REPLACEMENT,
        );
      }
      if (
        !content.includes(COMPUTER_USE_THREAD_CONFIG_DIAGNOSTICS_PATCH_MARKER) &&
        content.includes(NODE_REPL_DISABLE_SANDBOX_LEGACY_DIAGNOSTICS_NEEDLE)
      ) {
        content = content.replace(
          NODE_REPL_DISABLE_SANDBOX_LEGACY_DIAGNOSTICS_NEEDLE,
          NODE_REPL_DISABLE_SANDBOX_LEGACY_DIAGNOSTICS_REPLACEMENT,
        );
      }
      if (content !== originalContent) {
        fs.writeFileSync(filePath, content, 'utf8');
        nodeReplDisableSandboxPatched = true;
      } else {
        nodeReplDisableSandboxAlreadyCorrect = true;
      }
      nodeReplDisableSandboxPatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    if (content.includes(NODE_REPL_DISABLE_SANDBOX_NEEDLE)) {
      content = content.replace(
        NODE_REPL_DISABLE_SANDBOX_NEEDLE,
        NODE_REPL_DISABLE_SANDBOX_REPLACEMENT,
      );
    } else if (NODE_REPL_CONFIG_HELPER_RE.test(content)) {
      content = content.replace(
        NODE_REPL_CONFIG_HELPER_RE,
        NODE_REPL_CONFIG_HELPER_REPLACEMENT,
      );
    } else {
      continue;
    }
    fs.writeFileSync(filePath, content, 'utf8');
    nodeReplDisableSandboxPatched = true;
    nodeReplDisableSandboxPatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (nodeReplDisableSandboxPatched) {
    log('Node REPL sandbox bypass argument patched in ' +
        `${nodeReplDisableSandboxPatchedFiles.join(', ')}.`);
  } else if (nodeReplDisableSandboxAlreadyCorrect) {
    log('Node REPL sandbox bypass argument already patched.');
  } else {
    failRequiredPatch(
      'Could not locate Browser Use thread config generation to add ' +
      'node_repl --disable-sandbox for offline Windows Computer Use (app version may have changed).',
    );
  }

  const computerUsePluginRootFallbackPatchedFiles = [];
  let computerUsePluginRootFallbackPatched = false;
  let computerUsePluginRootFallbackAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(COMPUTER_USE_PLUGIN_ROOT_FALLBACK_PATCH_MARKER)) {
      computerUsePluginRootFallbackAlreadyCorrect = true;
      computerUsePluginRootFallbackPatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    if (content.includes(COMPUTER_USE_PLUGIN_ROOT_FALLBACK_NEEDLE)) {
      content = content.replace(
        COMPUTER_USE_PLUGIN_ROOT_FALLBACK_NEEDLE,
        COMPUTER_USE_PLUGIN_ROOT_FALLBACK_REPLACEMENT,
      );
    } else if (COMPUTER_USE_PLUGIN_ROOT_FALLBACK_CURRENT_RE.test(content)) {
      content = content.replace(
        COMPUTER_USE_PLUGIN_ROOT_FALLBACK_CURRENT_RE,
        (
          match,
          functionName,
          codexHomeVar,
          envVar,
          marketplaceNameVar,
          pluginPathNamespace,
          buildFlavorNamespace,
          marketplacesVar,
          pathExistsVar,
          fsNamespace,
          marketplaceVar,
          listMarketplacesFunction,
          installedPluginVar,
          pluginEntryVar,
          computerUsePathsFunction,
          pluginRootFunction,
        ) =>
          `function ${functionName}({codexHome:${codexHomeVar},env:${envVar}=process.env,` +
          `marketplaceName:${marketplaceNameVar}=${pluginPathNamespace}.or(${buildFlavorNamespace}.M.resolve()),` +
          `marketplaces:${marketplacesVar},pathExists:${pathExistsVar}=${fsNamespace}.existsSync})` +
          `{for(let ${marketplaceVar} of ${listMarketplacesFunction}({marketplaceName:${marketplaceNameVar},marketplaces:${marketplacesVar}}))` +
          `{let ${installedPluginVar}=${marketplaceVar}.plugins.find(${pluginEntryVar}=>${pluginEntryVar}.name===\`computer-use\`&&${pluginEntryVar}.installed&&${pluginEntryVar}.enabled&&${pluginEntryVar}.source.type===\`local\`);` +
          `if(${installedPluginVar}?.source.type===\`local\`)return ${computerUsePathsFunction}({env:${envVar},installedPluginRoot:${pluginPathNamespace}.${pluginRootFunction}({codexHome:${codexHomeVar},localVersion:${installedPluginVar}.localVersion,marketplaceName:${marketplaceVar}.name,pluginName:${installedPluginVar}.name}),pathExists:${pathExistsVar}});` +
          `let u=${marketplaceVar}.plugins.find(e=>e.name===\`computer-use\`&&(e.source?.type===\`local\`||e.source?.source===\`local\`)),d=u?.source?.path??null,` +
          `f=d==null?null:/^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)/.test(d)?d:${marketplaceVar}.path!=null?\`${'${'}String(${marketplaceVar}.path).replace(/[\\\\/]+$/,\`\`)}\\\\${'${'}String(d).replace(/^\\\\.?[\\\\/]/,\`\`)}\`:null;` +
          `if(f!=null&&${pathExistsVar}(f))return ${computerUsePathsFunction}({env:${envVar},installedPluginRoot:f,pathExists:${pathExistsVar}})}` +
          COMPUTER_USE_PLUGIN_ROOT_FALLBACK_PATCH_MARKER +
          `return ${computerUsePathsFunction}({env:${envVar},pathExists:${pathExistsVar}})}`,
      );
    } else if (COMPUTER_USE_PLUGIN_ROOT_FALLBACK_CURRENT_RE_V2.test(content)) {
      content = content.replace(
        COMPUTER_USE_PLUGIN_ROOT_FALLBACK_CURRENT_RE_V2,
        (
          match,
          functionName,
          codexHomeVar,
          envVar,
          marketplaceNameVar,
          marketplaceNameDefaultExpr,
          marketplacesVar,
          pathExistsVar,
          fsNamespace,
          marketplaceVar,
          listMarketplacesFunction,
          installedPluginVar,
          pluginEntryVar,
          computerUsePathsFunction,
          pluginPathNamespace,
          pluginRootFunction,
        ) =>
          `function ${functionName}({codexHome:${codexHomeVar},env:${envVar}=process.env,` +
          `marketplaceName:${marketplaceNameVar}=${marketplaceNameDefaultExpr},` +
          `marketplaces:${marketplacesVar},pathExists:${pathExistsVar}=${fsNamespace}.existsSync})` +
          `{for(let ${marketplaceVar} of ${listMarketplacesFunction}({marketplaceName:${marketplaceNameVar},marketplaces:${marketplacesVar}}))` +
          `{let ${installedPluginVar}=${marketplaceVar}.plugins.find(${pluginEntryVar}=>${pluginEntryVar}.name===\`computer-use\`&&${pluginEntryVar}.installed&&${pluginEntryVar}.enabled&&${pluginEntryVar}.source.type===\`local\`);` +
          `if(${installedPluginVar}?.source.type===\`local\`)return ${computerUsePathsFunction}({env:${envVar},installedPluginRoot:${pluginPathNamespace}.${pluginRootFunction}({codexHome:${codexHomeVar},localVersion:${installedPluginVar}.localVersion,marketplaceName:${marketplaceVar}.name,pluginName:${installedPluginVar}.name}),pathExists:${pathExistsVar}});` +
          `let u=${marketplaceVar}.plugins.find(e=>e.name===\`computer-use\`&&(e.source?.type===\`local\`||e.source?.source===\`local\`)),d=u?.source?.path??null,` +
          `f=d==null?null:/^(?:[A-Za-z]:[\\\\/]|\\\\\\\\)/.test(d)?d:${marketplaceVar}.path!=null?\`${'${'}String(${marketplaceVar}.path).replace(/[\\\\/]+$/,\`\`)}\\\\${'${'}String(d).replace(/^\\\\.?[\\\\/]/,\`\`)}\`:null;` +
          `if(f!=null&&${pathExistsVar}(f))return ${computerUsePathsFunction}({env:${envVar},installedPluginRoot:f,pathExists:${pathExistsVar}})}` +
          COMPUTER_USE_PLUGIN_ROOT_FALLBACK_PATCH_MARKER +
          `return ${computerUsePathsFunction}({env:${envVar},pathExists:${pathExistsVar}})}`,
      );
    } else {
      continue;
    }
    fs.writeFileSync(filePath, content, 'utf8');
    computerUsePluginRootFallbackPatched = true;
    computerUsePluginRootFallbackPatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (computerUsePluginRootFallbackPatched) {
    log('Computer Use plugin root fallback patched in ' +
        `${computerUsePluginRootFallbackPatchedFiles.join(', ')}.`);
  } else if (computerUsePluginRootFallbackAlreadyCorrect) {
    log('Computer Use plugin root fallback already patched.');
  } else {
    failRequiredPatch(
      'Could not locate Computer Use installed plugin path resolver (app version may have changed). ' +
      'node_repl may start without the packaged Computer Use plugin runtime paths.',
    );
  }

  const computerUseForwardThreadStartDiagnosticsPatchedFiles = [];
  let computerUseForwardThreadStartDiagnosticsPatched = false;
  let computerUseForwardThreadStartDiagnosticsAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER)) {
      let patchedContent = content;
      if (patchedContent.includes(COMPUTER_USE_THREAD_START_TOOL_SEARCH_LEGACY_CODE)) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_THREAD_START_TOOL_SEARCH_LEGACY_CODE,
          COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE,
        );
      }
      if (patchedContent.includes(COMPUTER_USE_THREAD_START_TOOL_SEARCH_JS_REPL_ONLY_CODE)) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_THREAD_START_TOOL_SEARCH_JS_REPL_ONLY_CODE,
          COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE,
        );
      }
      if (patchedContent.includes(COMPUTER_USE_THREAD_START_TOOL_SEARCH_TOOL_SUGGEST_ONLY_CODE)) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_THREAD_START_TOOL_SEARCH_TOOL_SUGGEST_ONLY_CODE,
          COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE,
        );
      }
      if (patchedContent.includes(COMPUTER_USE_THREAD_START_TOOL_SEARCH_FULL_FLAGS_ONLY_CODE)) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_THREAD_START_TOOL_SEARCH_FULL_FLAGS_ONLY_CODE,
          COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE,
        );
      }
      if (!patchedContent.includes(COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER)) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER,
          COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER +
            COMPUTER_USE_THREAD_START_TOOL_SEARCH_CODE,
        );
      }
      if (!patchedContent.includes(COMPUTER_USE_INPUT_SKILL_PATCH_MARKER)) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER,
          COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_PATCH_MARKER +
            COMPUTER_USE_INPUT_SKILL_INJECTION_CODE,
        );
      }
      if (!patchedContent.includes(
        COMPUTER_USE_THREAD_START_TOOL_CONTEXT_DIAGNOSTICS_PATCH_MARKER,
      )) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_INPUT_SKILL_PATCH_MARKER,
          COMPUTER_USE_INPUT_SKILL_PATCH_MARKER +
            COMPUTER_USE_THREAD_START_TOOL_CONTEXT_DIAGNOSTICS_CODE,
        );
      }
      if (
        patchedContent.includes(COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V3_PATCH_MARKER)
      ) {
        // Already has the current diagnostics shape. The optional mutations
        // above upgrade older builds so Computer Use context is observable.
      } else if (
        patchedContent.includes(COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_PATCH_MARKER)
      ) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_SAFE_FIELDS,
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_SAFE_FIELDS,
        );
        patchedContent = patchedContent.replace(
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_PATCH_MARKER,
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_PATCH_MARKER +
            COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V3_PATCH_MARKER,
        );
      } else if (patchedContent.includes(COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_PATCH_MARKER)) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_LEGACY_SAFE_FIELDS,
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_SAFE_FIELDS,
        );
        patchedContent = patchedContent.replace(
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_PATCH_MARKER,
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_PATCH_MARKER +
            COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V2_PATCH_MARKER +
            COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_V3_PATCH_MARKER,
        );
      } else if (
        patchedContent.includes(COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_LEGACY_NEEDLE)
      ) {
        patchedContent = patchedContent.replace(
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_LEGACY_NEEDLE,
          COMPUTER_USE_FORWARD_INPUT_DIAGNOSTICS_LEGACY_REPLACEMENT,
        );
      }
      if (patchedContent !== content) {
        content = patchedContent;
        fs.writeFileSync(filePath, content, 'utf8');
        computerUseForwardThreadStartDiagnosticsPatched = true;
      } else {
        computerUseForwardThreadStartDiagnosticsAlreadyCorrect = true;
      }
      computerUseForwardThreadStartDiagnosticsPatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    if (!content.includes(COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_NEEDLE)) continue;

    content = content.replace(
      COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_NEEDLE,
      COMPUTER_USE_FORWARD_THREAD_START_DIAGNOSTICS_REPLACEMENT,
    );
    fs.writeFileSync(filePath, content, 'utf8');
    computerUseForwardThreadStartDiagnosticsPatched = true;
    computerUseForwardThreadStartDiagnosticsPatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (computerUseForwardThreadStartDiagnosticsPatched) {
    log('Computer Use thread/start forwarding diagnostics patched in ' +
        `${computerUseForwardThreadStartDiagnosticsPatchedFiles.join(', ')}.`);
  } else if (computerUseForwardThreadStartDiagnosticsAlreadyCorrect) {
    log('Computer Use thread/start forwarding diagnostics already patched.');
  } else {
    warn(
      'Could not locate thread/start forwarding code for Computer Use diagnostics. ' +
      'The package can still run, but E2E logs will not show forwarded node_repl config.',
    );
  }

  const computerUseMcpStatusDiagnosticsPatchedFiles = [];
  let computerUseMcpStatusDiagnosticsPatched = false;
  let computerUseMcpStatusDiagnosticsAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(COMPUTER_USE_MCP_STATUS_DIAGNOSTICS_PATCH_MARKER)) {
      computerUseMcpStatusDiagnosticsAlreadyCorrect = true;
      computerUseMcpStatusDiagnosticsPatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }
    if (!content.includes(COMPUTER_USE_MCP_STATUS_RESPONSE_NEEDLE)) continue;

    content = content.replace(
      COMPUTER_USE_MCP_STATUS_RESPONSE_NEEDLE,
      COMPUTER_USE_MCP_STATUS_RESPONSE_REPLACEMENT,
    );
    fs.writeFileSync(filePath, content, 'utf8');
    computerUseMcpStatusDiagnosticsPatched = true;
    computerUseMcpStatusDiagnosticsPatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (computerUseMcpStatusDiagnosticsPatched) {
    log('Computer Use MCP status diagnostics patched in ' +
        `${computerUseMcpStatusDiagnosticsPatchedFiles.join(', ')}.`);
  } else if (computerUseMcpStatusDiagnosticsAlreadyCorrect) {
    log('Computer Use MCP status diagnostics already patched.');
  } else {
    log(
      'Computer Use MCP status diagnostics not needed for current verifier gates; required Computer Use gates remain enforced.',
    );
  }

  const nodeReplConfigReconcilePatchedFiles = [];
  let nodeReplConfigReconcilePatched = false;
  let nodeReplConfigReconcileAlreadyCorrect = false;

  for (const filePath of mainBundleFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(NODE_REPL_CONFIG_RECONCILE_FINALLY_PATCH_MARKER)) {
      nodeReplConfigReconcileAlreadyCorrect = true;
      nodeReplConfigReconcilePatchedFiles.push(path.relative(tmpDir, filePath));
      continue;
    }

    if (content.includes(NODE_REPL_CONFIG_RECONCILE_FINAL_STEP)) {
      content = content.replace(
        NODE_REPL_CONFIG_RECONCILE_FINAL_STEP,
        NODE_REPL_CONFIG_RECONCILE_FINAL_STEP_REPLACEMENT,
      );
    } else if (NODE_REPL_CONFIG_RECONCILE_FINAL_STEP_CURRENT_RE.test(content)) {
      content = content.replace(
        NODE_REPL_CONFIG_RECONCILE_FINAL_STEP_CURRENT_RE,
        (
          _match,
          reconcileFn,
          appServerConnection,
          browserSkillVariant,
          chromeExtensionSyncManagedPluginStore,
          devRuntimeRepoRoot,
          marketplaceDescriptorSource,
          forceInstallPluginNames,
          installWhenMissingPluginNames,
          syncInstallStateWithChromeExtensionPluginNames,
          marketplaceName,
          resourcesPath,
          runtimeMarketplaceRoot,
          descriptorVar,
          refreshNodeReplConfigFn,
          platform,
        ) =>
          `try{await ${reconcileFn}({appServerConnection:${appServerConnection},` +
          `browserSkillVariant:${browserSkillVariant},` +
          `chromeExtensionSyncManagedPluginStore:${chromeExtensionSyncManagedPluginStore},` +
          `devRuntimeRepoRoot:${devRuntimeRepoRoot},` +
          `marketplacePluginNames:${marketplaceDescriptorSource}.marketplacePluginNames,` +
          `forceInstallPluginNames:${forceInstallPluginNames},` +
          `installWhenMissingPluginNames:${installWhenMissingPluginNames},` +
          `syncInstallStateWithChromeExtensionPluginNames:${syncInstallStateWithChromeExtensionPluginNames},` +
          `marketplaceName:${marketplaceName},resourcesPath:${resourcesPath},` +
          `runtimeMarketplaceRoot:${runtimeMarketplaceRoot}}),await Promise.all(` +
          `${marketplaceDescriptorSource}.marketplacePluginDescriptors.map(async ${descriptorVar}=>{` +
          `${descriptorVar}.migrate!=null&&await ${descriptorVar}.migrate({` +
          `appServerConnection:${appServerConnection},codexHome:e.codexHome,` +
          `marketplaceName:${marketplaceName},trashItem:e.trashItem})}))}finally{` +
          `await ${refreshNodeReplConfigFn}({appServerConnection:${appServerConnection},` +
          `desktopFeatureAvailability:${marketplaceDescriptorSource}.desktopFeatureAvailability,` +
          `isPackaged:e.isPackaged,platform:${platform},repoRoot:e.repoRoot,` +
          `resourcesPath:${resourcesPath}})}` +
          NODE_REPL_CONFIG_RECONCILE_FINALLY_PATCH_MARKER +
          ';',
      );
    } else {
      continue;
    }
    fs.writeFileSync(filePath, content, 'utf8');
    nodeReplConfigReconcilePatched = true;
    nodeReplConfigReconcilePatchedFiles.push(path.relative(tmpDir, filePath));
  }

  if (nodeReplConfigReconcilePatched) {
    log('Node REPL config reconcile finalizer patched in ' +
        `${nodeReplConfigReconcilePatchedFiles.join(', ')}.`);
  } else if (nodeReplConfigReconcileAlreadyCorrect) {
    log('Node REPL config reconcile finalizer already patched.');
  } else {
    log(
      'Node REPL config reconcile finalizer not needed for this app version; verifier keeps required runtime gates.',
    );
  }

  const bundledBrowserPluginsPatch = patchBundledBrowserPlugins(mainBundleFiles, {
    browserUseDescriptorPatchedRe: BROWSER_USE_DESCRIPTOR_PATCHED_RE,
    browserUseDescriptorRe: BROWSER_USE_DESCRIPTOR_RE,
    chromeDescriptorPatchedRe: CHROME_DESCRIPTOR_PATCHED_RE,
    chromeDescriptorRe: CHROME_DESCRIPTOR_RE,
    inAppBrowserDescriptorPatchedRe: IN_APP_BROWSER_DESCRIPTOR_PATCHED_RE,
    inAppBrowserDescriptorRe: IN_APP_BROWSER_DESCRIPTOR_RE,
    patchMarker: BUNDLED_BROWSER_PLUGINS_PATCH_MARKER,
    syncExternalBrowserDescriptorPatchedRe: SYNC_EXTERNAL_BROWSER_DESCRIPTOR_PATCHED_RE,
    syncExternalBrowserDescriptorRe: SYNC_EXTERNAL_BROWSER_DESCRIPTOR_RE,
  });

  if (bundledBrowserPluginsPatch.patchedFiles.length > 0) {
    log(
      'Bundled browser plugins kept in runtime marketplace for offline mode in ' +
      `${bundledBrowserPluginsPatch.patchedFiles.map(filePath => path.relative(tmpDir, filePath)).join(', ')}.`,
    );
  } else if (bundledBrowserPluginsPatch.alreadyCorrect) {
    log('Bundled browser plugins runtime marketplace already patched.');
  } else if (!bundledBrowserPluginsPatch.seen) {
    failRequiredPatch(
      'Bundled browser plugin descriptors were not found in main bundles. ' +
      '@chrome may be filtered from the runtime marketplace in this app version.',
    );
  } else {
    failRequiredPatch(
      'Bundled browser plugin descriptors are present in main bundles, but ' +
      'no supported patch pattern matched (app version may have changed). ' +
      '@chrome may be filtered from the runtime marketplace in offline builds.',
    );
  }

  const bundledRuntimeMarketplaceFilterPatch = patchBundledRuntimeMarketplaceFilter(
    mainBundleFiles,
    {
      filterRe: BUNDLED_RUNTIME_MARKETPLACE_FILTER_RE,
      patchMarker: BUNDLED_RUNTIME_MARKETPLACE_FILTER_PATCH_MARKER,
      pluginNames: BUNDLED_RUNTIME_PLUGIN_NAMES,
      pluginNamesJson: JSON.stringify(BUNDLED_RUNTIME_PLUGIN_NAMES),
    },
  );

  if (bundledRuntimeMarketplaceFilterPatch.patchedFiles.length > 0) {
    log(
      'Bundled runtime plugin materialization preserved for offline mode in ' +
      `${bundledRuntimeMarketplaceFilterPatch.patchedFiles.map(filePath => path.relative(tmpDir, filePath)).join(', ')}.`,
    );
  } else if (bundledRuntimeMarketplaceFilterPatch.alreadyCorrect) {
    log('Bundled runtime plugin materialization already patched.');
  } else if (!bundledRuntimeMarketplaceFilterPatch.seen) {
    warn(
      'Bundled runtime marketplace filter was not found. ' +
      'Office plugins may not be copied into the runtime marketplace.',
    );
  } else {
    warn(
      'Bundled runtime marketplace filter was found but no supported patch ' +
      'pattern matched (app version may have changed). ' +
      'Office plugins may be filtered from offline installs.',
    );
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
  const LOCALE_SOURCE_NEEDLE = '.get(`locale_source`,`IDE`)';
  const LOCALE_SOURCE_PATCH_MARKER =
    '/*codex-offline:locale-source-default*/';
  const LOCALE_SOURCE_REPLACEMENT =
    '.get(`locale_source`,`SYSTEM`)' + LOCALE_SOURCE_PATCH_MARKER;
  const LOCALE_SOURCE_ALREADY_CORRECT_MARKER =
    '.get(`locale_source`,`SYSTEM`)';

  // ── Renderer Statsig feature gates (former Patches 4-34) ──────
  //
  // Settings entry, Automations, Pull Requests, Scratchpad, slash commands,
  // avatar overlay, artifacts, memories, dictation, chronicle, remote
  // connections and the other renderer feature-gate unlocks are now handled
  // at runtime by init.cjs (session.webRequest redirect of
  // ab.chatgpt.com/v1/initialize + ipcMain shared-object injection) plus the
  // generic patchDirectStatsigGateCalls(..., DESKTOP_ASAR_KNOWN_GATE_IDS)
  // pass below. Every gate id lives in init.cjs STATSIG_GATE_OVERRIDES, so the
  // per-gate asar needles were removed. See
  // docs/plan-b-patch-migration-inventory.md.

  // ── Patch 35: Enable Fast mode speed selector for offline builds ────────
  //
  // Older builds used a Statsig fast_mode gate:
  //   X?.fast_mode===!0&&authCheck(arg)
  // Newer builds route the composer/settings Speed selector through a helper:
  //   function F(e){return I(e).canUseFastMode}
  // In offline packages the model metadata can fail that availability test
  // after Fast is selected, hiding the only UI that can switch back to
  // Standard.  Patch only the selector visibility helper; the service-tier
  // setter still writes null/"fast" exactly as upstream does.
  const FAST_MODE_KEY_MARKER = FAST_MODE_CONTRACT.featureKey;
  const FAST_MODE_SELECTOR_PATCH_MARKER =
    contractPatchMarker(FAST_MODE_CONTRACT.selectorPatchMarker);
  const FAST_MODE_AUTH_METHOD_PATCH_MARKER =
    contractPatchMarker(FAST_MODE_CONTRACT.authMethodPatchMarker);
  const FAST_MODE_SERVICE_TIER_OPTIONS_PATCH_MARKER =
    contractPatchMarker(FAST_MODE_CONTRACT.serviceTierOptionsPatchMarker);
  // Matches: X?.fast_mode===!0&&Y(Z)  or  X.fast_mode===!0&&Y(Z)
  const FAST_MODE_GATE_RE =
    /[$\w]+(?:\?\.|\.)fast_mode===!0&&[$\w]+\([$\w]+\)/;
  const FAST_MODE_AVAILABILITY_MARKERS = Array.from(FAST_MODE_CONTRACT.availabilityMarkers);
  const FAST_MODE_AVAILABILITY_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return\s+[A-Za-z_$][\w$]*\(\2\)\.canUseFastMode\}/;
  const FAST_MODE_AUTH_METHOD_RE =
    /return!\(([A-Za-z_$][\w$]*)\?\.authMethod!==`chatgpt`\|\|([A-Za-z_$][\w$]*)\)\}/g;
  const FAST_MODE_HOOK_AUTH_METHOD_RE =
    /if\(([A-Za-z_$][\w$]*)\?\.authMethod!==`chatgpt`\|\|([A-Za-z_$][\w$]*)\)\{/g;
  const FAST_MODE_HOOK_CAN_USE_RE =
    /canUseFastMode:([A-Za-z_$][\w$]*),isDisabledByRequirement:([A-Za-z_$][\w$]*),isLoading:([A-Za-z_$][\w$]*)/g;
  // v26.608+: fast mode availability is gated on ChatGPT auth AND a backend API response
  // (featureRequirements.fast_mode). API-key users are always excluded. Patch the
  // isServiceTierAllowed computation to remove the chatgpt-auth requirement and treat a
  // null backend response as "allowed" (same intent as the old canUseFastMode:!0 patch).
  const FAST_MODE_SERVICE_TIER_ALLOWED_RE =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)!=null&&\4\?\.requirements\?\.featureRequirements\?\.fast_mode!==!1(?=,)/;
  const FAST_MODE_SERVICE_TIER_GET_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{return \3==null\?null:\3===`fast`\?([A-Za-z_$][\w$]*)\(\2\):\2\?\.serviceTiers\?\.find\(([A-Za-z_$][\w$]*)=>\5\.id===\3\)\?\?null\}/;
  const FAST_MODE_SERVICE_TIER_OPTIONS_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return\[\{description:([A-Za-z_$][\w$]*)\.standardDescription,iconKind:null,label:[A-Za-z_$][\w$]*\.standardLabel,tier:null,value:null\},\.\.\.\([A-Za-z_$][\w$]*\?\.serviceTiers\?\?\[\]\)\.map\(([A-Za-z_$][\w$]*)=>\(\{description:([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\),iconKind:([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\.id,[A-Za-z_$][\w$]*\.name\),label:([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\),tier:[A-Za-z_$][\w$]*,value:[A-Za-z_$][\w$]*\.id\}\)\)\]\}/;
  const FAST_MODE_FAST_TIER_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return \2\?\.serviceTiers\?\.find\(([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\(\3\.id,\3\.name\)===`fast`\|\|\3\.name\.trim\(\)\.toLowerCase\(\)===`priority`\)\?\?null\}/;
  const CONTEXT_USAGE_STATUS_SECTION_KEY =
    CONTEXT_USAGE_CONTRACT.localStatusSectionStorageKey;
  const CONTEXT_USAGE_STATUS_SECTION_PATCH_MARKER =
    contractPatchMarker(CONTEXT_USAGE_CONTRACT.visibilityPatchMarker);
  const CONTEXT_USAGE_STATUS_SECTION_PATCHED_RE = new RegExp(
    String.raw`[A-Za-z_$][\w$]*=[$\w]+\(` +
      '`' +
      escapeRegExp(CONTEXT_USAGE_STATUS_SECTION_KEY) +
      '`' +
      String.raw`,!0${escapeRegExp(CONTEXT_USAGE_STATUS_SECTION_PATCH_MARKER)}\)`,
  );
  const CONTEXT_USAGE_STATUS_SECTION_FALSE_RE = new RegExp(
    String.raw`([A-Za-z_$][\w$]*=[$\w]+\(` +
      '`' +
      escapeRegExp(CONTEXT_USAGE_STATUS_SECTION_KEY) +
      '`' +
      String.raw`,)!1(\))`,
  );
  const CONTEXT_USAGE_STATUS_SECTION_TRUE_RE = new RegExp(
    String.raw`([A-Za-z_$][\w$]*=[$\w]+\(` +
      '`' +
      escapeRegExp(CONTEXT_USAGE_STATUS_SECTION_KEY) +
      '`' +
      String.raw`,)!0(\))`,
  );
  const RENDERER_KNOWN_STATSIG_GATES_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:renderer-known-statsig-gates*/');
  const FEATURE_ENABLEMENT_PRESERVE_UNIFIED_EXEC_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:feature-enablement-preserve-unified-exec*/');
  const FEATURE_ENABLEMENT_LOCAL_STATE_RE =
    /if\(([A-Za-z_$][\w$]*)&&\(0,([A-Za-z_$][\w$]*)\.default\)\(\1,([A-Za-z_$][\w$]*)\)\)return \1;let ([A-Za-z_$][\w$]*)=Object\.entries\(\3\)\.filter\(([A-Za-z_$][\w$]*)\)\.map\(([A-Za-z_$][\w$]*)\);return \4\.length>0&&([A-Za-z_$][\w$]*)\.info\(`Features enabled`,\{safe:\{enabledFeatures:\4\.join\(`, `\)\},sensitive:\{\}\}\),\3/;

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

  // ═══════════════════════════════════════════════════════════════════
  // Locale defaults & auth-method gates: cannot be handled at runtime
  // because they are static string literals with no IPC/network
  // interception surface.  Must be patched directly in the asar.
  // ═══════════════════════════════════════════════════════════════════
  const assetsDir = path.join(tmpDir, 'webview', 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error('webview/assets directory not found. Package structure may have changed.');
  }
  {
    const webviewJsFiles = listJavaScriptFiles(assetsDir);
    let patchedCount = 0;
    let localeSourcePatched = false;
    let fastModeAuthPatched = false;
    let fastModeServiceTierPatched = false;
    let rendererKnownStatsigGatePatchCount = 0;
    const computerUseNodeReplDynamicToolPatchedFiles = [];
    const computerUseNodeReplDynamicToolCallPatchedFiles = [];
    const archivedThreadsPartialListPatchedFiles = [];
    const archivedSettingsOfflineVisibilityPatchedFiles = [];
    let computerUseNodeReplDynamicToolAlreadyCorrect = false;
    let computerUseNodeReplDynamicToolCallAlreadyCorrect = false;
    let archivedThreadsPartialListAlreadyCorrect = false;
    let archivedSettingsOfflineVisibilityAlreadyCorrect = false;

    for (const filePath of webviewJsFiles) {
      let content = fs.readFileSync(filePath, 'utf8');
      let changed = false;
      const computerUseNodeReplDynamicToolsPatch =
        patchComputerUseNodeReplDynamicTools(content);
      if (computerUseNodeReplDynamicToolsPatch.patched) {
        content = computerUseNodeReplDynamicToolsPatch.content;
        computerUseNodeReplDynamicToolPatchedFiles.push(path.relative(tmpDir, filePath));
        changed = true;
      } else if (computerUseNodeReplDynamicToolsPatch.alreadyCorrect) {
        computerUseNodeReplDynamicToolAlreadyCorrect = true;
      }

      const computerUseNodeReplDynamicToolCallPatch =
        patchComputerUseNodeReplDynamicToolCall(content);
      if (computerUseNodeReplDynamicToolCallPatch.patched) {
        content = computerUseNodeReplDynamicToolCallPatch.content;
        computerUseNodeReplDynamicToolCallPatchedFiles.push(path.relative(tmpDir, filePath));
        changed = true;
      } else if (computerUseNodeReplDynamicToolCallPatch.alreadyCorrect) {
        computerUseNodeReplDynamicToolCallAlreadyCorrect = true;
      }

      const archivedThreadsPartialListPatch =
        patchArchivedThreadsPartialList(content);
      if (archivedThreadsPartialListPatch.patched) {
        content = archivedThreadsPartialListPatch.content;
        archivedThreadsPartialListPatchedFiles.push(path.relative(tmpDir, filePath));
        changed = true;
      } else if (archivedThreadsPartialListPatch.alreadyCorrect) {
        archivedThreadsPartialListAlreadyCorrect = true;
      }

      const archivedSettingsOfflineVisibilityPatch =
        patchArchivedSettingsOfflineVisibility(content);
      if (archivedSettingsOfflineVisibilityPatch.patched) {
        content = archivedSettingsOfflineVisibilityPatch.content;
        archivedSettingsOfflineVisibilityPatchedFiles.push(path.relative(tmpDir, filePath));
        changed = true;
      } else if (archivedSettingsOfflineVisibilityPatch.alreadyCorrect) {
        archivedSettingsOfflineVisibilityAlreadyCorrect = true;
      }

      const rendererKnownStatsigGatePatch = patchDirectStatsigGateCalls(
        content,
        DESKTOP_ASAR_KNOWN_GATE_IDS,
        RENDERER_KNOWN_STATSIG_GATES_PATCH_MARKER,
      );
      if (rendererKnownStatsigGatePatch.count > 0) {
        content = rendererKnownStatsigGatePatch.content;
        rendererKnownStatsigGatePatchCount += rendererKnownStatsigGatePatch.count;
        changed = true;
      }
      if (content.includes(I18N_NEEDLE)) {
        content = content.replaceAll(I18N_NEEDLE, I18N_REPLACEMENT);
        changed = true;
      }
      if (content.includes(LOCALE_SOURCE_NEEDLE)) {
        content = content.replaceAll(LOCALE_SOURCE_NEEDLE, LOCALE_SOURCE_REPLACEMENT);
        localeSourcePatched = true;
        changed = true;
      }
      if (content.includes(FAST_MODE_AUTH_METHOD_PATCH_MARKER)) {
        fastModeAuthPatched = true;
      } else if (
        content.includes(FAST_MODE_KEY_MARKER) &&
        content.includes('authMethod!==`chatgpt`')
      ) {
        let patchedFastModeContent = content.replace(
          FAST_MODE_AUTH_METHOD_RE,
          (_match, _authMethodVar, disabledRequirementVar) =>
            `return ${disabledRequirementVar}!==!0${FAST_MODE_AUTH_METHOD_PATCH_MARKER}}`,
        );
        patchedFastModeContent = patchedFastModeContent.replace(
          FAST_MODE_HOOK_AUTH_METHOD_RE,
          (_match, _authMethodVar, disabledRequirementVar) =>
            `if(${disabledRequirementVar}===!0${FAST_MODE_AUTH_METHOD_PATCH_MARKER}){`,
        );
        patchedFastModeContent = patchedFastModeContent.replace(
          FAST_MODE_HOOK_CAN_USE_RE,
          (_match, _canUseVar, disabledRequirementVar, isLoadingVar) =>
            `canUseFastMode:!0${FAST_MODE_AUTH_METHOD_PATCH_MARKER},` +
            `isDisabledByRequirement:${disabledRequirementVar},isLoading:${isLoadingVar}`,
        );
        if (patchedFastModeContent !== content) {
          content = patchedFastModeContent;
          fastModeAuthPatched = true;
          changed = true;
        }
      } else if (
        content.includes(FAST_MODE_KEY_MARKER) &&
        FAST_MODE_SERVICE_TIER_ALLOWED_RE.test(content)
      ) {
        // v26.608+: force isServiceTierAllowed to true unconditionally, ignoring auth and any
        // backend response — so the Fast/Standard speed selector is always shown and selectable.
        const patched = content.replace(
          FAST_MODE_SERVICE_TIER_ALLOWED_RE,
          `$1=!0${FAST_MODE_AUTH_METHOD_PATCH_MARKER}`,
        );
        if (patched !== content) {
          content = patched;
          fastModeAuthPatched = true;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(filePath, content, 'utf8');
        patchedCount++;
      }
    }
    if (patchedCount > 0) {
      log(`Webview assets patched in ${patchedCount} files` +
        (localeSourcePatched ? ' (locale_source)' : '') +
        (fastModeAuthPatched ? ' (fast-mode auth)' : '') +
        (fastModeServiceTierPatched ? ' (fast-mode service-tier)' : '') +
        (rendererKnownStatsigGatePatchCount > 0 ? ` (renderer gates: ${rendererKnownStatsigGatePatchCount})` : '') +
        '.');
    } else {
      log('Webview assets already correct (no patching needed).');
    }
    if (computerUseNodeReplDynamicToolPatchedFiles.length > 0) {
      log('Computer Use node_repl.js dynamic tool exposed in ' +
        `${computerUseNodeReplDynamicToolPatchedFiles.join(', ')}.`);
    } else if (computerUseNodeReplDynamicToolAlreadyCorrect) {
      log('Computer Use node_repl.js dynamic tool exposure already patched.');
    } else {
      throw new Error(
        'Could not locate renderer dynamic tools list to expose Computer Use node_repl.js.',
      );
    }
    if (computerUseNodeReplDynamicToolCallPatchedFiles.length > 0) {
      log('Computer Use node_repl.js dynamic tool call bridge patched in ' +
        `${computerUseNodeReplDynamicToolCallPatchedFiles.join(', ')}.`);
    } else if (computerUseNodeReplDynamicToolCallAlreadyCorrect) {
      log('Computer Use node_repl.js dynamic tool call bridge already patched.');
    } else {
      throw new Error(
        'Could not locate renderer dynamic tool call handler for Computer Use node_repl.js.',
      );
    }
    if (archivedThreadsPartialListPatchedFiles.length > 0) {
      log('Archived threads partial list fallback patched in ' +
        `${archivedThreadsPartialListPatchedFiles.join(', ')}.`);
    } else if (archivedThreadsPartialListAlreadyCorrect) {
      log('Archived threads partial list fallback already patched.');
    } else {
      throw new Error(
        'Could not locate renderer archived thread list pagination to patch.',
      );
    }
    if (archivedSettingsOfflineVisibilityPatchedFiles.length > 0) {
      log('Archived settings offline local visibility patched in ' +
        `${archivedSettingsOfflineVisibilityPatchedFiles.join(', ')}.`);
    } else if (archivedSettingsOfflineVisibilityAlreadyCorrect) {
      log('Archived settings offline local visibility already patched.');
    } else {
      throw new Error(
        'Could not locate archived settings panel isError to keep local ' +
        'archived chats visible offline.',
      );
    }
  }
  log('Renderer Statsig gates handled by init.cjs IPC interception (no asar patching).');

  // Surface drift first (so optional misses are always visible), then fail the
  // build before repacking if any required patch did not apply, so an upstream
  // bundle restructure is caught here instead of by users at launch.
  logPatchDriftSummary();
  assertRequiredPatchesApplied();

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
  try {
    await flipFuses(exePath, {
      version: FuseVersion.V1,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    });
    log('Asar integrity fuse disabled.');
  } catch (error) {
    if (!isMissingElectronFuseSentinelError(error)) {
      throw error;
    }

    log(
      'Current Codex.exe does not expose the Electron asar integrity fuse; ' +
      'no fuse flip needed.',
    );
  }

  log('Done.');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
