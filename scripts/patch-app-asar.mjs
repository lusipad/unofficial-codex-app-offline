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
 *    launches get the same runtime features as the provided launchers.
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
 * 38. Enable external agent config import in Settings > General
 *    Newer builds hide the "Import external agent config" row behind the
 *    external-agent-config gates.  Offline Statsig defaults can leave those
 *    gates false, so we bypass the local calls while keeping the migration
 *    IPC handlers safe to no-op in Web gateway builds.
 *
 * 39. Enable Plugins navigation for API-key/offline sessions
 *    The desktop sidebar shows a disabled Plugins item for API-key users when
 *    gate 533078438 is on, even though the bundled runtime marketplace can be
 *    used offline. We disable that API-key-only lockout and keep the bundled
 *    Plugins route visible for offline builds.
 *
 * 40. Keep offline runtime plugins in the materialized marketplace
 *    The desktop runtime copies only enabled bundled plugin descriptors into
 *    ~/.codex/.tmp/bundled-marketplaces/openai-bundled.  Office artifact
 *    plugins are injected into the bundled marketplace during packaging, so
 *    preserve those local entries even though the upstream app does not ship
 *    desktop feature descriptors for them.
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
const {
  DESKTOP_ASAR_PATCH_MARKERS,
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
const COMPUTER_USE_ENV_DEFAULT =
  'if(process.env.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE==null){' +
    'process.env.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE="1"' +
  '}\n';
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
const PATCH_SNIPPET = `${PATCH_MARKER}\nif(!process.windowsStore){process.windowsStore=true;}\n${COMPUTER_USE_ENV_DEFAULT}${EPIPE_GUARD}`;

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
  if (content.includes('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
    return false;
  }

  const windowsStoreLine = 'if(!process.windowsStore){process.windowsStore=true;}\n';
  if (content.includes(windowsStoreLine)) {
    content = content.replace(windowsStoreLine, windowsStoreLine + COMPUTER_USE_ENV_DEFAULT);
  } else {
    content = content.replace(PATCH_MARKER, `${PATCH_MARKER}\n${COMPUTER_USE_ENV_DEFAULT}`);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  return true;
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

  for (const filePath of filePaths) {
    let content = fs.readFileSync(filePath, 'utf8');
    const originalContent = content;

    if (content.includes(options.patchMarker)) {
      seen = true;
      alreadyCorrect = true;
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
    warn('Bundled Chrome plugin was not found. Chrome plugin script patches skipped.');
    return;
  }

  patchChromeBrowserClient(path.join(chromePluginRoot, 'scripts', 'browser-client.mjs'));
  patchChromeNativeHostCheck(path.join(chromePluginRoot, 'scripts', 'check-native-host-manifest.js'));
  patchChromeSkillInstructions(path.join(chromePluginRoot, 'skills', 'chrome', 'SKILL.md'));

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
      `${listFunction}=async()=>{let ${rootVar}="\\\\\\\\.\\\\pipe\\\\",` +
      `e=(await ${readdirFunction}(${rootVar})).map(${entryVar}=>${pathModule}.resolve(${rootVar},${entryVar})).filter(${pipeVar}=>${pipeVar}.startsWith(${pipePrefixVar})),` +
      `r=e.filter(${pipeVar}=>${pipeVar}.startsWith(${pipePrefixVar}+"\\\\"));return(r.length>0?r:e)}` +
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
      /if\(([A-Za-z_$][\w$]*)\(\)==null\)throw new Error\(([A-Za-z_$][\w$]*)\(\)\);/,
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

function patchChromeSkillInstructions(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Chrome skill instructions were not found: ${filePath}`);
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
    throw new Error('Could not locate Chrome skill browser-client bootstrap paragraph.');
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
  const WINDOWS_BROWSER_USE_CAPABILITY_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:windows-browser-use-capability*/');
  const WINDOWS_BROWSER_USE_CAPABILITY_LEGACY_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{env:([A-Za-z_$][\w$]*)=process\.env,platform:([A-Za-z_$][\w$]*)=process\.platform\}=\{\}\)\{return\s+\4!==`win32`\|\|\3\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`\?\2:\{\.\.\.\2,computerUse:!0,computerUseNodeRepl:!0\}\}/;
  const WINDOWS_BROWSER_USE_CAPABILITY_CURRENT_RE =
    /function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{((?:buildFlavor:[A-Za-z_$][\w$]*=[^,}]+,)?env:([A-Za-z_$][\w$]*)=[^,}]+,platform:([A-Za-z_$][\w$]*)=[^,}]+)\}=\{\}\)\{let ([A-Za-z_$][\w$]*)=\5===`win32`&&\4\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.\2,computerUse:!0,computerUseNodeRepl:!0\}:\2,/;
  // ── Patch 36: Keep bundled browser plugins in runtime marketplace ─────
  const BUNDLED_BROWSER_PLUGINS_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:bundled-browser-plugins-no-force-reload*/');
  const CHROME_DESCRIPTOR_RE =
    /(\{forceReload:!0,)(?:installWhenMissing:!0,)?(name:lt,isAvailable:\(\{buildFlavor:([A-Za-z_$][\w$]*),features:([A-Za-z_$][\w$]*)\}\)=>)(\4\.externalBrowserUseAllowed&&Yn\(\3\))(\})/;
  const CHROME_DESCRIPTOR_PATCHED_RE =
    /\{installWhenMissing:!0,name:lt,isAvailable:\(\{buildFlavor:[A-Za-z_$][\w$]*,features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0\}/;
  const BROWSER_USE_DESCRIPTOR_RE =
    /(\{autoInstallOptOutKey:([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\2\.([A-Za-z_$][\w$]*)\),forceReload:!0,installWhenMissing:!0,name:\2\.\4,isAvailable:\(\{features:([A-Za-z_$][\w$]*)\}\)=>)(\5\.inAppBrowserUseAllowed)(,migrate:([A-Za-z_$][\w$]*)\})/;
  const BROWSER_USE_DESCRIPTOR_PATCHED_RE =
    /\{autoInstallOptOutKey:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\),installWhenMissing:!0,name:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*,isAvailable:\(\{features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0,migrate:[A-Za-z_$][\w$]*\}/;
  const SYNC_EXTERNAL_BROWSER_DESCRIPTOR_RE =
    /\{forceReload:!0,name:([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?),syncInstallStateWithChromeExtension:!0,isAvailable:\(\{(buildFlavor:[A-Za-z_$][\w$]*(?:,env:[A-Za-z_$][\w$]*)?,features:([A-Za-z_$][\w$]*))\}\)=>(?:(?:[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)?\)&&\3\.externalBrowserUseAllowed)|(?:\3\.externalBrowserUseAllowed&&[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)))(\})/g;
  const SYNC_EXTERNAL_BROWSER_DESCRIPTOR_PATCHED_RE =
    /\{installWhenMissing:!0,name:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:[A-Za-z_$][\w$]*(?:,env:[A-Za-z_$][\w$]*)?,features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0\}/;
  const IN_APP_BROWSER_DESCRIPTOR_RE =
    /(\{forceReload:!0,name:([A-Za-z_$][\w$]*)\.On,isAvailable:\(\{buildFlavor:([A-Za-z_$][\w$]*),features:([A-Za-z_$][\w$]*)\}\)=>)(Jn\(\3\)&&\4\.externalBrowserUseAllowed)(\})/;
  const IN_APP_BROWSER_DESCRIPTOR_PATCHED_RE =
    /\{installWhenMissing:!0,name:[A-Za-z_$][\w$]*\.On,isAvailable:\(\{buildFlavor:[A-Za-z_$][\w$]*,features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0\}/;
  const BUNDLED_RUNTIME_PLUGIN_NAMES = [
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
    warn(
      'Bundled browser plugin descriptors were not found in main bundles. ' +
      '@chrome may be filtered from the runtime marketplace in this app version.',
    );
  } else {
    throw new Error(
      'Bundled browser plugin descriptors are present in main bundles, but ' +
      'no supported patch pattern matched. @chrome may be filtered from the ' +
      'runtime marketplace in offline builds.',
    );
  }

  const bundledRuntimeMarketplaceFilterPatch = patchBundledRuntimeMarketplaceFilter(
    mainBundleFiles,
    {
      filterRe: BUNDLED_RUNTIME_MARKETPLACE_FILTER_RE,
      patchMarker: BUNDLED_RUNTIME_MARKETPLACE_FILTER_PATCH_MARKER,
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
    throw new Error(
      'Bundled runtime marketplace filter was found but no supported patch ' +
      'pattern matched. Office plugins may be filtered from offline installs.',
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
    /function\s+(\w+)\(\)\{let\s+e=\(0,Q\.c\)\(3\),t;if\(e\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(t=`3789238711`,e\[0\]=t\):t=e\[0\],!xu\(t\)\)\{let\s+t;return\s+e\[1\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(t=\(0,([$\w]+)\.jsx\)\(b,\{to:`\/`,replace:!0\}\),e\[1\]=t\):t=e\[1\],t\}let\s+n;return\s+e\[2\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(n=\(0,\2\.jsx\)\((\w+),\{\}\),e\[2\]=n\):n=e\[2\],n\}/;
  // ≥ 26.422.8496.0: 2-slot memo cache and direct $f() call.
  const PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V2 =
    /function\s+(\w+)\(\)\{let\s+\w+=\(0,Q\.c\)\(2\);if\(![$\w]+\(`3789238711`\)\)\{let\s+\w+;return\s+\w+\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=\(0,([$\w]+)\.jsx\)\(\w+,\{to:`\/`,replace:!0\}\),\w+\[0\]=\w+\):\w+=\w+\[0\],\w+\}let\s+\w+;return\s+\w+\[1\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=\(0,\2\.jsx\)\((\w+),\{\}\),\w+\[1\]=\w+\):\w+=\w+\[1\],\w+\}/;
  // ≥ 26.429.2026.0: same route guard, but React compiler now emits
  // Symbol.for(...) checks directly rather than comparing memo slots first.
  const PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V3 =
    /function\s+(\w+)\(\)\{let\s+\w+=\(0,\w+\.c\)\(2\);if\(![$\w]+\(`3789238711`\)\)\{let\s+\w+;return\s+\w+\[0\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=\(0,([$\w]+)\.jsx\)\(\w+,\{to:`\/`,replace:!0\}\),\w+\[0\]=\w+\):\w+=\w+\[0\],\w+\}let\s+\w+;return\s+\w+\[1\]===Symbol\.for\(`react\.memo_cache_sentinel`\)\?\(\w+=\(0,\2\.jsx\)\((\w+),\{\}\),\w+\[1\]=\w+\):\w+=\w+\[1\],\w+\}/;
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
    /([,;]\s*[$\w]+\s*=)\s*[$\w]+\(`1488233300`\)/g;
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
  const PR_ICONS_GATE_HOOK_RE =
    /([,;]\s*\w+=)\s*[$\w]+\([$\w]+,`2553306736`\)/g;
  const PR_ICONS_GATE_STORE_GET_RE =
    /[$\w]+\([$\w]+\([$\w]+,`2553306736`\)\)/g;
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
    /([,;}]\s*[$\w]+\s*=)\s*[$\w]+\(`588076040`\)/g;
  // ≥ 26.429.x: extracted to a standalone hook.
  const PLUGINS_BUNDLED_MARKETPLACE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`588076040`\)\}/;

  // ── Patch 37: Enable external Chrome plugin mentions offline ─────────
  //
  // Gate 410065390 controls the renderer-side external browser availability
  // used by the composer/plugin filters. Without this, @chrome can be
  // installed but still hidden from mention suggestions in offline/API mode.
  const EXTERNAL_BROWSER_USE_GATE_ID_MARKER = '`410065390`';
  const EXTERNAL_BROWSER_USE_GATE_INLINE_RE =
    /([,;]\s*\w+\s*=)\s*[$\w]+\(`410065390`\)/g;
  const EXTERNAL_BROWSER_USE_GATE_FUNCTION_RE =
    /function\s+(\w+)\(\)\{return\s+[$\w]+\(`410065390`\)\}/;

  // ── Patch 38: Enable external agent config import for offline builds ──
  //
  // The Settings > General "Import external agent config" row is controlled
  // by the external-agent-config-gates chunk.  The chunk exports gate ids
  // 3326157269 / 2900529421 / 2711149772 / 816842483; consumers import those
  // ids under minified aliases and call the Statsig hook on the aliases.
  // Replace those local hook calls with !0 so the row is not hidden offline.
  const EXTERNAL_AGENT_CONFIG_IMPORT_PATCH_MARKER =
    contractPatchMarker('/*codex-offline:external-agent-config-import*/');
  const EXTERNAL_AGENT_CONFIG_GATE_IDS = [
    '3326157269',
    '2900529421',
    '2711149772',
    '816842483',
  ];
  const EXTERNAL_AGENT_CONFIG_GATE_ID_MARKERS =
    EXTERNAL_AGENT_CONFIG_GATE_IDS.map(id => '`' + id + '`');

  // ── Patch 39: Enable Plugins navigation for API-key/offline sessions ──
  //
  // Gate 533078438 enables a disabled "Please sign in with ChatGPT to use
  // plugins" sidebar item for API-key users. The same sidebar block also hides
  // the real Plugins/Skills+Apps route behind an auth-method check. Disable the
  // lockout while preserving the bundled marketplace feature check.
  const PLUGINS_API_KEY_NAV_PATCH_MARKER =
    '/*codex-offline:plugins-api-key-nav*/';
  const PLUGINS_API_KEY_ROUTE_PATCH_MARKER =
    '/*codex-offline:plugins-api-key-route*/';
  const PLUGINS_API_KEY_DISABLED_GATE_ID_MARKER = '`533078438`';
  const PLUGINS_API_KEY_DISABLED_GATE_INLINE_RE =
    /([,;]\s*[A-Za-z_$][\w$]*=)\s*[$\w]+\(`533078438`\)/g;
  const PLUGINS_ROUTE_FEATURE_AND_AUTH_RE =
    /([,;])([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{hostId:([A-Za-z_$][\w$]*)\}\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&\2&&!([A-Za-z_$][\w$]*)/g;
  const PLUGINS_ROUTE_FEATURE_AUTH_RE =
    /([,;])([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{hostId:([A-Za-z_$][\w$]*)\}\)&&!([A-Za-z_$][\w$]*)/g;
  const PLUGINS_DETAIL_AUTH_REDIRECT_RE =
    /(\{authMethod:([A-Za-z_$][\w$]*)\}=[A-Za-z_$][\w$]*\(\);)if\([A-Za-z_$][\w$]*\(\2\)\)\{let ([A-Za-z_$][\w$]*);return/g;

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
  const CONTROL_GATE_UNPATCHED_RE =
    /[$\w]+\(`2171042036`\)/;

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
  const PERSONALITY_GATE_UNPATCHED_RE =
    /[$\w]+\(`1444479692`\)/;

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
  const REMOTE_CONNECTIONS_FEATURE_GATE_CONFIG_RE =
    /([,;]\s*[$\w]+\s*=)\s*[$\w]+\([$\w]+\([$\w]+,`4114442250`\)\)/g;
  const REMOTE_CONNECTIONS_FEATURE_GATE_UNPATCHED_RE =
    /[$\w]+\(`4114442250`\)|[$\w]+\([$\w]+,`4114442250`\)/;

  // ── Patch 33b: Route Codex Mobile auth refresh through desktop login ────
  //
  // Codex Mobile's remote-control security check maps 401 responses through
  // chatgpt-token-auth.browser, which only redirects on chatgpt.com origins.
  // In the Electron desktop shell that helper is a no-op, so online users see
  // the generic "Couldn't check security requirements" error instead of the
  // existing desktop ChatGPT sign-in flow.  Import the desktop login action and
  // retry the original remote-control request after login completes.
  const CODEX_MOBILE_AUTH_RELOGIN_PATCH_MARKER =
    '/*codex-offline:codex-mobile-auth-relogin*/';
  const CODEX_MOBILE_SETUP_CHUNK_RE = /^codex-mobile-setup-flow-.*\.js$/;
  const ONBOARDING_LOGIN_CHUNK_RE = /^onboarding-login-content-.*\.js$/;
  const CODEX_MOBILE_CHATGPT_TOKEN_AUTH_IMPORT_RE =
    /import\{t as ([A-Za-z_$][\w$]*)\}from"\.\/chatgpt-token-auth\.browser-[^"]+\.js";/;
  const CODEX_MOBILE_REMOTE_CONTROL_AUTH_HANDLER_RE =
    /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{try\{return await \2\(\)\}catch\(([A-Za-z_$][\w$]*)\)\{throw \3 instanceof ([A-Za-z_$][\w$]*)\?\3\.status===404\?new ([A-Za-z_$][\w$]*):\3\.status===403\?new ([A-Za-z_$][\w$]*)\(\3\.message\):\3\.status===401\?\(([A-Za-z_$][\w$]*)\(\),new ([A-Za-z_$][\w$]*)\(`ChatGPT auth is required to load remote control environments\.`\)\):Error\(`Remote control request failed \(\$\{\3\.status\}\): \$\{\3\.message\}`\):\3\}\}/;

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
  // Older builds used a Statsig fast_mode gate:
  //   X?.fast_mode===!0&&authCheck(arg)
  // Newer builds route the composer/settings Speed selector through a helper:
  //   function F(e){return I(e).canUseFastMode}
  // In offline packages the model metadata can fail that availability test
  // after Fast is selected, hiding the only UI that can switch back to
  // Standard.  Patch only the selector visibility helper; the service-tier
  // setter still writes null/"fast" exactly as upstream does.
  const FAST_MODE_STORE_MARKER = FAST_MODE_CONTRACT.statsigStoreKey;
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
    const assetFiles = fs.readdirSync(assetsDir);
    const onboardingLoginChunk = assetFiles.find(file => ONBOARDING_LOGIN_CHUNK_RE.test(file));

    let i18nCount = 0;
    let i18nAlreadyCorrect = false;
    let localeSourceCount = 0;
    let localeSourceAlreadyCorrect = false;
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
    let externalBrowserUseGateCount = 0;
    let externalBrowserUseGateSeen = false;
    let externalAgentConfigGateCount = 0;
    let externalAgentConfigGateSeen = false;
    let externalAgentConfigGateAlreadyCorrect = false;
    let pluginsApiKeyNavGateCount = 0;
    let pluginsApiKeyNavAuthFilterCount = 0;
    let pluginsApiKeyNavGateSeen = false;
    let pluginsApiKeyNavAlreadyCorrect = false;
    let pluginsApiKeyRouteGateCount = 0;
    let pluginsApiKeyRouteGateSeen = false;
    let pluginsApiKeyRouteAlreadyCorrect = false;
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
    let codexMobileAuthReloginSeen = false;
    let codexMobileAuthReloginPatched = false;
    let artifactElectronGatePatched = false;
    let artifactElectronGateSeen = false;
    let fastModeGatePatched = false;
    let fastModeGateSeen = false;
    let fastModeGateAlreadyCorrect = false;
    let fastModeServiceTierOptionsPatched = false;
    let fastModeServiceTierOptionsSeen = false;
    let fastModeServiceTierOptionsAlreadyCorrect = false;
    let contextUsageStatusSectionPatched = false;
    let contextUsageStatusSectionSeen = false;
    let contextUsageStatusSectionAlreadyCorrect = false;

    for (const file of assetFiles) {
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
        PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V3.test(originalContent) ||
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
        PR_ICONS_GATE_HOOK_RE.test(originalContent) ||
        PR_ICONS_GATE_STORE_GET_RE.test(originalContent) ||
        PR_ICONS_GATE_FUNCTION_RE.test(originalContent);
      PR_ICONS_GATE_HOOK_RE.lastIndex = 0;
      PR_ICONS_GATE_STORE_GET_RE.lastIndex = 0;
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
      externalBrowserUseGateSeen ||=
        originalContent.match(EXTERNAL_BROWSER_USE_GATE_INLINE_RE) !== null ||
        EXTERNAL_BROWSER_USE_GATE_FUNCTION_RE.test(originalContent) ||
        originalContent.includes(EXTERNAL_BROWSER_USE_GATE_ID_MARKER);
      externalAgentConfigGateSeen ||=
        originalContent.includes('external-agent-config-gates') ||
        EXTERNAL_AGENT_CONFIG_GATE_ID_MARKERS.some(marker => originalContent.includes(marker));
      externalAgentConfigGateAlreadyCorrect ||=
        originalContent.includes(EXTERNAL_AGENT_CONFIG_IMPORT_PATCH_MARKER);
      pluginsApiKeyNavGateSeen ||=
        originalContent.includes(PLUGINS_API_KEY_DISABLED_GATE_ID_MARKER) ||
        originalContent.includes('sidebarElectron.pluginsDisabledTooltip');
      pluginsApiKeyNavAlreadyCorrect ||=
        originalContent.includes(PLUGINS_API_KEY_NAV_PATCH_MARKER);
      pluginsApiKeyRouteGateSeen ||=
        originalContent.includes('pluginDeepLinkAuthBlocked===!0') ||
        PLUGINS_DETAIL_AUTH_REDIRECT_RE.test(originalContent);
      pluginsApiKeyRouteAlreadyCorrect ||= originalContent.includes(PLUGINS_API_KEY_ROUTE_PATCH_MARKER);
      backgroundSubagentsGateSeen ||= originalContent.includes(BACKGROUND_SUBAGENTS_GATE_ID_MARKER);
      threadOverlayGateSeen ||= originalContent.includes(THREAD_OVERLAY_GATE_ID_MARKER);
      multiWindowGateSeen ||= originalContent.includes(MULTI_WINDOW_GATE_ID_MARKER);
      computerUseGateSeen ||= originalContent.includes(COMPUTER_USE_GATE_ID_MARKER);
      controlGateSeen ||= CONTROL_GATE_UNPATCHED_RE.test(originalContent);
      dictation1GateSeen ||= originalContent.includes(DICTATION_GATE_1_ID_MARKER);
      dictation2GateSeen ||= originalContent.includes(DICTATION_GATE_2_ID_MARKER);
      browserNonlocalGateSeen ||= originalContent.includes(BROWSER_NONLOCAL_GATE_ID_MARKER);
      threadHoverCardsGateSeen ||= originalContent.includes(THREAD_HOVER_CARDS_GATE_ID_MARKER);
      chronicleGateSeen ||=
        CHRONICLE_GATE_FUNCTION_RE.test(originalContent) ||
        originalContent.includes(CHRONICLE_GATE_ID_MARKER);
      personalityGateSeen ||= PERSONALITY_GATE_UNPATCHED_RE.test(originalContent);
      remoteConnectionsGateSeen ||=
        REMOTE_CONNECTIONS_GATE_FUNCTION_RE.test(originalContent) ||
        originalContent.includes(REMOTE_CONNECTIONS_GATE_ID_MARKER);
      remoteConnectionsFeatureGateSeen ||=
        REMOTE_CONNECTIONS_FEATURE_GATE_UNPATCHED_RE.test(originalContent);
      REMOTE_CONNECTIONS_FEATURE_GATE_CONFIG_RE.lastIndex = 0;
      codexMobileAuthReloginSeen ||=
        originalContent.includes('/wham/remote/control/mfa_requirement') &&
        originalContent.includes('ChatGPT auth is required to load remote control environments.');
      codexMobileAuthReloginPatched ||= originalContent.includes(CODEX_MOBILE_AUTH_RELOGIN_PATCH_MARKER);
      artifactElectronGateSeen ||=
        ARTIFACT_ELECTRON_GATE_FUNCTION_RE.test(originalContent) ||
        originalContent.includes(ARTIFACT_ELECTRON_GATE_ID_MARKER);
      fastModeGateSeen ||=
        (
          originalContent.includes(FAST_MODE_STORE_MARKER) &&
          originalContent.includes(FAST_MODE_KEY_MARKER)
        ) ||
        (
          FAST_MODE_AVAILABILITY_MARKERS.every(marker => originalContent.includes(marker)) &&
          FAST_MODE_AVAILABILITY_RE.test(originalContent)
        ) ||
        originalContent.includes(FAST_MODE_SELECTOR_PATCH_MARKER);
      fastModeServiceTierOptionsSeen ||=
        FAST_MODE_SERVICE_TIER_GET_RE.test(originalContent) ||
        FAST_MODE_SERVICE_TIER_OPTIONS_RE.test(originalContent) ||
        FAST_MODE_FAST_TIER_RE.test(originalContent) ||
        originalContent.includes(FAST_MODE_SERVICE_TIER_OPTIONS_PATCH_MARKER);
      fastModeServiceTierOptionsAlreadyCorrect ||=
        originalContent.includes(FAST_MODE_SERVICE_TIER_OPTIONS_PATCH_MARKER);
      contextUsageStatusSectionSeen ||=
        originalContent.includes(CONTEXT_USAGE_STATUS_SECTION_KEY) ||
        originalContent.includes(CONTEXT_USAGE_STATUS_SECTION_PATCH_MARKER);
      contextUsageStatusSectionAlreadyCorrect ||=
        originalContent.includes(CONTEXT_USAGE_STATUS_SECTION_PATCH_MARKER);
      if (content.includes(I18N_NEEDLE)) {
        const count = content.split(I18N_NEEDLE).length - 1;
        content = content.replaceAll(I18N_NEEDLE, I18N_REPLACEMENT);
        i18nCount += count;
        modified = true;
      } else if (content.includes(I18N_ALREADY_CORRECT_MARKER)) {
        i18nAlreadyCorrect = true;
      }

      if (content.includes(LOCALE_SOURCE_NEEDLE)) {
        const count = content.split(LOCALE_SOURCE_NEEDLE).length - 1;
        content = content.replaceAll(LOCALE_SOURCE_NEEDLE, LOCALE_SOURCE_REPLACEMENT);
        localeSourceCount += count;
        modified = true;
      } else if (content.includes(LOCALE_SOURCE_ALREADY_CORRECT_MARKER)) {
        localeSourceAlreadyCorrect = true;
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

      if (PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(
          PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE,
          'function $1(){return(0,$2.jsx)($3,{})}',
        );
        pullRequestsRouteGatePatched = true;
        modified = true;
      } else if (PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V2.test(content)) {
        content = content.replace(
          PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V2,
          'function $1(){return(0,$2.jsx)($3,{})}',
        );
        pullRequestsRouteGatePatched = true;
        modified = true;
      } else if (PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V3.test(content)) {
        content = content.replace(
          PULL_REQUESTS_ROUTE_GATE_FUNCTION_RE_V3,
          'function $1(){return(0,$2.jsx)($3,{})}',
        );
        pullRequestsRouteGatePatched = true;
        modified = true;
      }

      // IIFE-form fallback: handles (0,$f)(`3789238711`) which the patterns above miss.
      // Guard is content.includes(ID_MARKER) — primary patterns remove the literal when they
      // match, so this naturally fires only when the primary patterns left the ID intact.
      if (content.includes(PULL_REQUESTS_GATE_ID_MARKER)) {
        const nc = content.replace(
          /(?<!!)(?:\(0,[$\w]+\)|[$\w]+)\(`3789238711`\)/g,
          '!0',
        );
        if (nc !== content) {
          pullRequestsGatePatched = true;
          content = nc;
          modified = true;
        }
      }

      // IIFE-form fallback for route gate: same guard approach as sidebar.
      if (content.includes(PULL_REQUESTS_GATE_ID_MARKER)) {
        const nc = content.replace(
          /(?<!!)(?:\(0,[$\w]+\)|[$\w]+)\(`3789238711`\)/g,
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
      if (PR_ICONS_GATE_HOOK_RE.test(content)) {
        const count = content.match(PR_ICONS_GATE_HOOK_RE).length;
        content = content.replace(PR_ICONS_GATE_HOOK_RE, '$1!0');
        prIconsGateCount += count;
        modified = true;
      }
      PR_ICONS_GATE_HOOK_RE.lastIndex = 0;
      if (PR_ICONS_GATE_STORE_GET_RE.test(content)) {
        const count = content.match(PR_ICONS_GATE_STORE_GET_RE).length;
        content = content.replace(PR_ICONS_GATE_STORE_GET_RE, '!0');
        prIconsGateCount += count;
        modified = true;
      }
      PR_ICONS_GATE_STORE_GET_RE.lastIndex = 0;
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

      {
        const inlineMatches = content.match(EXTERNAL_BROWSER_USE_GATE_INLINE_RE);
        if (inlineMatches) {
          content = content.replaceAll(EXTERNAL_BROWSER_USE_GATE_INLINE_RE, '$1!0');
          externalBrowserUseGateCount += inlineMatches.length;
          modified = true;
        } else if (EXTERNAL_BROWSER_USE_GATE_FUNCTION_RE.test(content)) {
          content = content.replace(EXTERNAL_BROWSER_USE_GATE_FUNCTION_RE, 'function $1(){return!0}');
          externalBrowserUseGateCount += 1;
          modified = true;
        }
      }

      {
        if (!content.includes(EXTERNAL_AGENT_CONFIG_IMPORT_PATCH_MARKER)) {
          const externalAgentConfigDirectPatch = patchExternalAgentConfigDirectGateCalls(
            content,
            EXTERNAL_AGENT_CONFIG_GATE_IDS,
            EXTERNAL_AGENT_CONFIG_IMPORT_PATCH_MARKER,
          );
          if (externalAgentConfigDirectPatch.count > 0) {
            content = externalAgentConfigDirectPatch.content;
            externalAgentConfigGateCount += externalAgentConfigDirectPatch.count;
            modified = true;
          }

          const externalAgentConfigLiteralPatch = patchExternalAgentConfigGateIdLiterals(
            content,
            EXTERNAL_AGENT_CONFIG_GATE_IDS,
            EXTERNAL_AGENT_CONFIG_IMPORT_PATCH_MARKER,
          );
          if (externalAgentConfigLiteralPatch.count > 0) {
            content = externalAgentConfigLiteralPatch.content;
            modified = true;
          }

          const externalAgentConfigPatch = patchExternalAgentConfigGateCalls(
            content,
            EXTERNAL_AGENT_CONFIG_IMPORT_PATCH_MARKER,
          );
          if (externalAgentConfigPatch.count > 0) {
            content = externalAgentConfigPatch.content;
            externalAgentConfigGateCount += externalAgentConfigPatch.count;
            modified = true;
          }
        }
      }

      {
        if (
          originalContent.includes(PLUGINS_API_KEY_DISABLED_GATE_ID_MARKER) ||
          originalContent.includes('sidebarElectron.pluginsDisabledTooltip')
        ) {
          const gateMatches = content.match(PLUGINS_API_KEY_DISABLED_GATE_INLINE_RE);
          if (gateMatches) {
            content = content.replaceAll(
              PLUGINS_API_KEY_DISABLED_GATE_INLINE_RE,
              `$1!1${PLUGINS_API_KEY_NAV_PATCH_MARKER}`,
            );
            pluginsApiKeyNavGateCount += gateMatches.length;
            modified = true;
          }

          const featureAndAuthMatches = content.match(PLUGINS_ROUTE_FEATURE_AND_AUTH_RE);
          if (featureAndAuthMatches) {
            content = content.replaceAll(
              PLUGINS_ROUTE_FEATURE_AND_AUTH_RE,
              `$1$2=$3({hostId:$4}),$5=$6&&$2${PLUGINS_API_KEY_NAV_PATCH_MARKER}`,
            );
            pluginsApiKeyNavAuthFilterCount += featureAndAuthMatches.length;
            modified = true;
          }

          const featureAuthMatches = content.match(PLUGINS_ROUTE_FEATURE_AUTH_RE);
          if (featureAuthMatches) {
            content = content.replaceAll(
              PLUGINS_ROUTE_FEATURE_AUTH_RE,
              `$1$2=$3({hostId:$4})${PLUGINS_API_KEY_NAV_PATCH_MARKER}`,
            );
            pluginsApiKeyNavAuthFilterCount += featureAuthMatches.length;
            modified = true;
          }
        }
      }

      {
        const detailAuthRedirectMatch = content.match(PLUGINS_DETAIL_AUTH_REDIRECT_RE);
        if (detailAuthRedirectMatch) {
          content = content.replace(
            PLUGINS_DETAIL_AUTH_REDIRECT_RE,
            `$1if(!1${PLUGINS_API_KEY_ROUTE_PATCH_MARKER}){let $3;return`,
          );
          pluginsApiKeyRouteGateCount += 1;
          modified = true;
        }

        if (originalContent.includes('pluginDeepLinkAuthBlocked===!0')) {
          const skillsRouteNeedle = 'o&&!p){let t;return';
          const skillsRouteReplacement =
            `o${PLUGINS_API_KEY_ROUTE_PATCH_MARKER}){let t;return`;
          if (content.includes(skillsRouteNeedle)) {
            content = content.replace(skillsRouteNeedle, skillsRouteReplacement);
            pluginsApiKeyRouteGateCount += 1;
            modified = true;
          } else {
            const skillsRouteAuthBlockMatch = content.match(
              /,([A-Za-z_$][\w$]*)&&![A-Za-z_$][\w$]*\)\{let ([A-Za-z_$][\w$]*);return/,
            );
            if (skillsRouteAuthBlockMatch) {
              content = content.replace(
                skillsRouteAuthBlockMatch[0],
                `,${skillsRouteAuthBlockMatch[1]}${PLUGINS_API_KEY_ROUTE_PATCH_MARKER}){let ${skillsRouteAuthBlockMatch[2]};return`,
              );
              pluginsApiKeyRouteGateCount += 1;
              modified = true;
            }
          }
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
        } else {
          const configMatches = content.match(REMOTE_CONNECTIONS_FEATURE_GATE_CONFIG_RE);
          if (configMatches) {
            content = content.replaceAll(REMOTE_CONNECTIONS_FEATURE_GATE_CONFIG_RE, '$1!0');
            remoteConnectionsFeatureGateCount += configMatches.length;
            modified = true;
          }
        }
      }

      // Patch 33b: Codex Mobile desktop ChatGPT relogin
      if (
        CODEX_MOBILE_SETUP_CHUNK_RE.test(file) &&
        content.includes('/wham/remote/control/mfa_requirement') &&
        !content.includes(CODEX_MOBILE_AUTH_RELOGIN_PATCH_MARKER)
      ) {
        if (onboardingLoginChunk == null) {
          throw new Error(
            'Codex Mobile remote-control auth path is present, but the onboarding ' +
            'login chunk was not found.',
          );
        }
        const chatGptTokenAuthImportMatch = content.match(
          CODEX_MOBILE_CHATGPT_TOKEN_AUTH_IMPORT_RE,
        );
        const remoteControlAuthHandlerMatch = content.match(
          CODEX_MOBILE_REMOTE_CONTROL_AUTH_HANDLER_RE,
        );
        const dispatchBridgeMatch = content.match(
          /([A-Za-z_$][\w$]*)\.dispatchMessage\(`open-in-browser`,\{url:/,
        );

        if (!chatGptTokenAuthImportMatch) {
          throw new Error(
            'Codex Mobile remote-control auth path is present, but the ChatGPT ' +
            'token-auth import pattern no longer matches.',
          );
        }
        if (!remoteControlAuthHandlerMatch) {
          throw new Error(
            'Codex Mobile remote-control auth path is present, but the 401 handler ' +
            'pattern no longer matches.',
          );
        }
        if (!dispatchBridgeMatch) {
          throw new Error(
            'Codex Mobile remote-control auth path is present, but the browser-open ' +
            'dispatch bridge pattern no longer matches.',
          );
        }

        const [
          remoteControlAuthHandlerNeedle,
          handlerFunction,
          requestFunction,
          ,
          httpErrorClass,
          notFoundErrorClass,
          forbiddenErrorClass,
          tokenAuthFunction,
          authRequiredErrorClass,
        ] = remoteControlAuthHandlerMatch;
        const dispatchBridge = dispatchBridgeMatch[1];
        const errorVar = '_codexOfflineRemoteControlError';
        const loginVar = '_codexOfflineChatGptLoginResult';
        const completionVar = '_codexOfflineChatGptLoginCompletion';
        const remoteControlAuthHandlerReplacement =
          `async function ${handlerFunction}(${requestFunction}){` +
          `try{return await ${requestFunction}()}` +
          `catch(${errorVar}){throw ${errorVar} instanceof ${httpErrorClass}?` +
          `${errorVar}.status===404?new ${notFoundErrorClass}:` +
          `${errorVar}.status===403?new ${forbiddenErrorClass}(${errorVar}.message):` +
          `${errorVar}.status===401?await codexOfflineRemoteControlRelogin(${requestFunction}):` +
          `Error(\`Remote control request failed (${'${'}${errorVar}.status}): ${'${'}${errorVar}.message}\`):${errorVar}}}` +
          `async function codexOfflineRemoteControlRelogin(${requestFunction}){` +
          `if(${tokenAuthFunction}())throw new ${authRequiredErrorClass}(\`ChatGPT auth is required to load remote control environments.\`);` +
          `try{let ${loginVar}=await codexOfflineChatGptLogin({useStreamlinedLogin:!0});` +
          `${loginVar}.authUrl&&${dispatchBridge}.dispatchMessage(\`open-in-browser\`,{url:${loginVar}.authUrl});` +
          `let ${completionVar}=await ${loginVar}.completion;` +
          `if(${completionVar}.success)return await ${requestFunction}()}` +
          `catch{}throw new ${authRequiredErrorClass}(\`ChatGPT auth is required to load remote control environments.\`)}` +
          CODEX_MOBILE_AUTH_RELOGIN_PATCH_MARKER;

        content = content.replace(
          CODEX_MOBILE_CHATGPT_TOKEN_AUTH_IMPORT_RE,
          `$&import{r as codexOfflineChatGptLogin}from"./${onboardingLoginChunk}";`,
        );
        content = content.replace(
          remoteControlAuthHandlerNeedle,
          remoteControlAuthHandlerReplacement,
        );
        codexMobileAuthReloginPatched = true;
        modified = true;
      }

      // Patch 34: Artifact Electron native functionality
      if (ARTIFACT_ELECTRON_GATE_FUNCTION_RE.test(content)) {
        content = content.replace(ARTIFACT_ELECTRON_GATE_FUNCTION_RE, 'function $1(){return!0}');
        artifactElectronGatePatched = true;
        modified = true;
      }

      // Patch 35: Fast mode speed selector
      if (content.includes(FAST_MODE_SELECTOR_PATCH_MARKER)) {
        fastModeGateAlreadyCorrect = true;
      } else if (
        content.includes(FAST_MODE_STORE_MARKER) &&
        content.includes(FAST_MODE_KEY_MARKER) &&
        FAST_MODE_GATE_RE.test(content)
      ) {
        content = content.replace(FAST_MODE_GATE_RE, '!0');
        fastModeGatePatched = true;
        modified = true;
      } else if (
        FAST_MODE_AVAILABILITY_MARKERS.every(marker => content.includes(marker)) &&
        FAST_MODE_AVAILABILITY_RE.test(content)
      ) {
        content = content.replace(
          FAST_MODE_AVAILABILITY_RE,
          `function $1($2){return!0${FAST_MODE_SELECTOR_PATCH_MARKER}}`,
        );
        fastModeGatePatched = true;
        modified = true;
      }
      if (content.includes(FAST_MODE_AUTH_METHOD_PATCH_MARKER)) {
        fastModeGateAlreadyCorrect = true;
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
          fastModeGatePatched = true;
          modified = true;
        }
      }
      if (content.includes(FAST_MODE_SERVICE_TIER_OPTIONS_PATCH_MARKER)) {
        fastModeServiceTierOptionsAlreadyCorrect = true;
      } else if (
        FAST_MODE_SERVICE_TIER_GET_RE.test(content) &&
        FAST_MODE_SERVICE_TIER_OPTIONS_RE.test(content) &&
        FAST_MODE_FAST_TIER_RE.test(content)
      ) {
        let patchedFastModeServiceTierContent = content.replace(
          FAST_MODE_SERVICE_TIER_GET_RE,
          (
            _match,
            getTierFunction,
            modelVar,
            valueVar,
            getFastTierFunction,
            itemVar,
          ) =>
            `function ${getTierFunction}(${modelVar},${valueVar}){` +
            `return ${valueVar}==null?null:` +
            `${valueVar}===\`fast\`?${getFastTierFunction}(${modelVar}):` +
            `${modelVar}?.serviceTiers?.find(${itemVar}=>${itemVar}.id===${valueVar})??` +
            `codexOfflineFastModeTier(${modelVar},${valueVar})}`,
        );
        patchedFastModeServiceTierContent = patchedFastModeServiceTierContent.replace(
          FAST_MODE_SERVICE_TIER_OPTIONS_RE,
          (
            _match,
            getOptionsFunction,
            modelVar,
            labelsVar,
            itemVar,
            descriptionFunction,
            iconKindFunction,
            labelFunction,
          ) =>
            `function ${getOptionsFunction}(${modelVar}){` +
            `let codexOfflineFastModeOptions=codexOfflineFastModeTierOptions(${modelVar});` +
            `return[{description:${labelsVar}.standardDescription,iconKind:null,` +
            `label:${labelsVar}.standardLabel,tier:null,value:null},` +
            `...codexOfflineFastModeOptions.map(${itemVar}=>({description:${descriptionFunction}(${itemVar}),` +
            `iconKind:${iconKindFunction}(${itemVar}.id,${itemVar}.name),` +
            `label:${labelFunction}(${itemVar}),tier:${itemVar},value:${itemVar}.id}))]}` +
            `function codexOfflineFastModeTier(e,t){` +
            `return t===\`fast\`&&e?.additionalSpeedTiers?.includes(\`fast\`)===!0?` +
            `{id:\`fast\`,name:\`Fast\`,description:${labelsVar}.fastDescription}:` +
            `t===\`ultrafast\`&&e?.additionalSpeedTiers?.includes(\`ultrafast\`)===!0?` +
            `{id:\`ultrafast\`,name:\`Ultrafast\`,description:${labelsVar}.ultrafastDescription}:null}` +
            `function codexOfflineFastModeTierOptions(e){` +
            `let t=e?.serviceTiers??[],n=[...t],r=e?.additionalSpeedTiers??[];` +
            `for(let i of r)(i===\`fast\`||i===\`ultrafast\`)&&!n.some(e=>` +
            `${iconKindFunction}(e.id,e.name)===i||e.id===i)&&` +
            `n.push(codexOfflineFastModeTier(e,i));return n.filter(Boolean)}` +
            FAST_MODE_SERVICE_TIER_OPTIONS_PATCH_MARKER,
        );
        patchedFastModeServiceTierContent = patchedFastModeServiceTierContent.replace(
          FAST_MODE_FAST_TIER_RE,
          (
            _match,
            getFastTierFunction,
            modelVar,
            itemVar,
            iconKindFunction,
          ) =>
            `function ${getFastTierFunction}(${modelVar}){` +
            `return ${modelVar}?.serviceTiers?.find(${itemVar}=>` +
            `${iconKindFunction}(${itemVar}.id,${itemVar}.name)===\`fast\`||` +
            `${itemVar}.name.trim().toLowerCase()===\`priority\`)??` +
            `codexOfflineFastModeTier(${modelVar},\`fast\`)}`,
        );
        if (patchedFastModeServiceTierContent !== content) {
          content = patchedFastModeServiceTierContent;
          fastModeServiceTierOptionsPatched = true;
          modified = true;
        }
      }
      if (CONTEXT_USAGE_STATUS_SECTION_PATCHED_RE.test(content)) {
        contextUsageStatusSectionAlreadyCorrect = true;
      } else if (CONTEXT_USAGE_STATUS_SECTION_FALSE_RE.test(content)) {
        content = content.replace(
          CONTEXT_USAGE_STATUS_SECTION_FALSE_RE,
          `$1!0${CONTEXT_USAGE_STATUS_SECTION_PATCH_MARKER}$2`,
        );
        contextUsageStatusSectionPatched = true;
        modified = true;
      } else if (CONTEXT_USAGE_STATUS_SECTION_TRUE_RE.test(content)) {
        content = content.replace(
          CONTEXT_USAGE_STATUS_SECTION_TRUE_RE,
          `$1!0${CONTEXT_USAGE_STATUS_SECTION_PATCH_MARKER}$2`,
        );
        contextUsageStatusSectionPatched = true;
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

    if (localeSourceCount > 0) {
      log(`locale_source default switched to SYSTEM (${localeSourceCount} occurrence(s)).`);
    } else if (localeSourceAlreadyCorrect) {
      log('locale_source default already set to SYSTEM in this app version. No patch needed.');
    } else {
      warn('Could not locate locale_source default-IDE pattern. ' +
           'Locale-source patch skipped (the app version may have changed).');
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

    if (externalBrowserUseGateCount > 0) {
      log(
        'External Chrome plugin mention gate bypassed for offline mode ' +
        `(${externalBrowserUseGateCount} occurrence(s)).`,
      );
    } else if (!externalBrowserUseGateSeen) {
      log('External browser use gate 410065390 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'External browser use gate 410065390 is still present, but no ' +
        'supported patch pattern matched. @chrome may be hidden in the composer.',
      );
    }

    if (externalAgentConfigGateCount > 0) {
      log(
        'External agent config import gates bypassed for offline mode ' +
        `(${externalAgentConfigGateCount} occurrence(s)).`,
      );
    } else if (externalAgentConfigGateAlreadyCorrect) {
      log('External agent config import gates already patched.');
    } else if (!externalAgentConfigGateSeen) {
      log('External agent config import gates are not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'External agent config import gates are present, but no supported ' +
        'patch pattern matched. Settings > General may still miss the import row.',
      );
    }

    if (pluginsApiKeyNavGateCount > 0 || pluginsApiKeyNavAuthFilterCount > 0) {
      log(
        'Plugins navigation API-key lockout bypassed for offline mode ' +
        `(${pluginsApiKeyNavGateCount} gate occurrence(s), ` +
        `${pluginsApiKeyNavAuthFilterCount} auth filter occurrence(s)).`,
      );
    } else if (pluginsApiKeyNavAlreadyCorrect) {
      log('Plugins navigation API-key lockout already patched.');
    } else if (!pluginsApiKeyNavGateSeen) {
      log('Plugins navigation API-key lockout gate 533078438 is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Plugins navigation API-key lockout is present, but no supported ' +
        'patch pattern matched. API-key/offline users may still see a disabled Plugins entry.',
      );
    }

    if (pluginsApiKeyRouteGateCount > 0) {
      log(
        'Plugins page API-key fallback bypassed for offline mode ' +
        `(${pluginsApiKeyRouteGateCount} occurrence(s)).`,
      );
    } else if (pluginsApiKeyRouteAlreadyCorrect) {
      log('Plugins page API-key fallback already patched.');
    } else if (!pluginsApiKeyRouteGateSeen) {
      log('Plugins page API-key fallback gate is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Plugins page API-key fallback is present, but no supported patch pattern matched. ' +
        'API-key/offline users may still fall back to the skills-only page.',
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

    if (codexMobileAuthReloginPatched) {
      log('Codex Mobile remote-control 401 path now uses desktop ChatGPT login.');
    } else if (!codexMobileAuthReloginSeen) {
      log('Codex Mobile remote-control auth path is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Codex Mobile remote-control auth path is present, but desktop ChatGPT ' +
        'relogin was not patched.',
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
    } else if (fastModeGateAlreadyCorrect) {
      log('Fast mode speed selector gate already bypassed in this app version. No patch needed.');
    } else if (!fastModeGateSeen) {
      log('Fast mode selector gate is not present in this app version. No patch needed.');
    } else {
      warn(
        'Fast mode selector gate is still present, but no supported ' +
        'patch pattern matched. The Fast mode speed selector may be hidden in offline builds.',
      );
    }

    if (fastModeServiceTierOptionsPatched) {
      log('Fast mode service-tier options patched for additionalSpeedTiers metadata.');
    } else if (fastModeServiceTierOptionsAlreadyCorrect) {
      log('Fast mode service-tier options already patched in this app version. No patch needed.');
    } else if (!fastModeServiceTierOptionsSeen) {
      log('Fast mode service-tier options builder is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Fast mode service-tier options builder is present, but no supported ' +
        'patch pattern matched. The composer speed menu may be hidden in offline builds.',
      );
    }

    if (contextUsageStatusSectionPatched) {
      log('Context usage status section visibility patched for offline mode.');
    } else if (contextUsageStatusSectionAlreadyCorrect) {
      log('Context usage status section visibility already patched in this app version. No patch needed.');
    } else if (!contextUsageStatusSectionSeen) {
      log('Context usage status section is not present in this app version. No patch needed.');
    } else {
      throw new Error(
        'Context usage status section is present, but no supported visibility ' +
        'patch pattern matched. The context usage indicator may be hidden in offline builds.',
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
