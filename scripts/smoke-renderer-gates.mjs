#!/usr/bin/env node
/**
 * smoke-renderer-gates.mjs
 *
 * Fast, cross-platform regression smoke for the offline desktop gate handling.
 * Sanity-checks the init.cjs-based gate migration WITHOUT a full build (no Store
 * download, no 179 MB asar repack).
 *
 * Static layer (always, no inputs, ~milliseconds):
 *   1. Gate-override sync: DESKTOP_ASAR_KNOWN_GATE_IDS (asar static fallback)
 *      must equal the numeric gate ids in init.cjs STATSIG_GATE_OVERRIDES
 *      (runtime injection). Reuses assertGateOverrideSync().
 *   2. Contract <-> verify marker consistency: every marker that
 *      verify-offline-package.ps1 passes to requiredPatchMarker('...') must exist
 *      in DESKTOP_ASAR_PATCH_MARKERS, else `verify` throws at load. (Protects the
 *      dormant plugins-api-key / codex-mobile tripwires.)
 *
 * Bundle marker scan (optional, when a bundle is supplied):
 *   3. Reads the *.js files out of app.asar one entry at a time (memory-light)
 *      and reports which DESKTOP_ASAR_PATCH_MARKERS are present. The renderer
 *      keeps its Statsig gate CALLS intact (unlocked at runtime by init.cjs), so
 *      there is no static "gate call" invariant. What IS checkable is that a
 *      patched bundle actually carries the expected patch markers; this catches a
 *      build that silently skipped a patch. verify-offline-package.ps1 stays the
 *      authority.
 *
 * Usage:
 *   node scripts/smoke-renderer-gates.mjs
 *   node scripts/smoke-renderer-gates.mjs --app-dir <dir containing resources/app.asar>
 *   node scripts/smoke-renderer-gates.mjs --asar <path to app.asar>
 *   node scripts/smoke-renderer-gates.mjs --app-dir <dir> --strict
 *
 * Exit: 0 all hard checks pass (absent markers are warnings unless --strict); 1 otherwise.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { parseArgs } from 'util';

import { compareGateOverrideSync } from './check-gate-override-sync.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const CONTRACT_PATH = path.resolve(
  scriptDir, '..', 'web-gateway', 'gateway', 'src', 'ipc', 'codex', 'capabilityContractData.cjs',
);
const VERIFY_PATH = path.resolve(scriptDir, 'verify-offline-package.ps1');

// Present iff the asar has been through patch-app-asar.mjs. Spaces are part of
// the literal marker.
const PATCHED_ANCHOR_MARKER = '/* codex-offline:windowsStore-patch */';

const { values: args } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    'asar': { type: 'string' },
    'strict': { type: 'boolean', default: false },
  },
  strict: false,
});

let failures = 0;
let warnings = 0;
function pass(msg) { console.log(`[smoke]  OK   ${msg}`); }
function fail(msg) { failures++; console.error(`[smoke] FAIL  ${msg}`); }
function warn(msg) { warnings++; console.warn(`[smoke] WARN  ${msg}`); }
function shortMarker(m) { return m.replace(/\/\*+\s*|\s*\*+\//g, '').trim(); }

function checkGateSync() {
  const r = compareGateOverrideSync();
  if (r.ok) {
    pass(`gate-override sync: ${r.knownCount} ids match across DESKTOP_ASAR_KNOWN_GATE_IDS and init.cjs STATSIG_GATE_OVERRIDES.`);
    return;
  }
  if (r.missingFromRuntime.length) {
    fail(`gate ids in DESKTOP_ASAR_KNOWN_GATE_IDS but NOT injected by init.cjs: ${r.missingFromRuntime.join(', ')}`);
  }
  if (r.missingFromKnown.length) {
    fail(`gate ids injected by init.cjs but NOT in DESKTOP_ASAR_KNOWN_GATE_IDS: ${r.missingFromKnown.join(', ')}`);
  }
}

function checkMarkerConsistency() {
  const contract = require(CONTRACT_PATH);
  const contractMarkers = new Set(contract.DESKTOP_ASAR_PATCH_MARKERS || []);
  if (contractMarkers.size === 0) {
    fail('DESKTOP_ASAR_PATCH_MARKERS is empty or missing from the capability contract.');
    return;
  }
  if (!fs.existsSync(VERIFY_PATH)) {
    warn(`verify-offline-package.ps1 not found at ${VERIFY_PATH}; skipping marker cross-check.`);
    return;
  }
  const verifySrc = fs.readFileSync(VERIFY_PATH, 'utf8');
  const required = new Set();
  for (const m of verifySrc.matchAll(/requiredPatchMarker\(\s*'([^']+)'\s*\)/g)) required.add(m[1]);
  const missing = [...required].filter(m => !contractMarkers.has(m)).sort();
  if (missing.length) {
    fail('markers required by verify-offline-package.ps1 but absent from DESKTOP_ASAR_PATCH_MARKERS ' +
         `(verify would throw at load): ${missing.join(', ')}`);
    return;
  }
  pass(`marker consistency: all ${required.size} verify-required markers present in the contract.`);
}

function* iterBundleJs() {
  let asarPath = args['asar'];
  if (!asarPath && args['app-dir']) asarPath = path.join(path.resolve(args['app-dir']), 'resources', 'app.asar');
  if (!asarPath) return;
  if (!fs.existsSync(asarPath)) throw new Error(`asar not found: ${asarPath}`);
  const entries = asar.listPackage(asarPath).filter(p => p.replace(/\\/g, '/').endsWith('.js'));
  for (const entry of entries) {
    yield {
      read: () => {
        try { return asar.extractFile(asarPath, entry).toString('utf8'); }
        catch { return asar.extractFile(asarPath, entry.replace(/^[\\/]/, '')).toString('utf8'); }
      },
    };
  }
}

function checkBundleMarkers() {
  if (!args['app-dir'] && !args['asar']) {
    console.log('[smoke]  ..   no --app-dir/--asar supplied; skipping bundle scan (static checks only).');
    return;
  }
  const contract = require(CONTRACT_PATH);
  const markers = contract.DESKTOP_ASAR_PATCH_MARKERS || [];
  const present = new Set();
  let fileCount = 0;
  for (const file of iterBundleJs()) {
    fileCount++;
    const src = file.read();
    for (const m of markers) if (!present.has(m) && src.includes(m)) present.add(m);
  }
  if (fileCount === 0) {
    warn('bundle scan found no *.js entries in the asar (layout may have changed).');
    return;
  }
  if (!present.has(PATCHED_ANCHOR_MARKER)) {
    console.log(`[smoke]  ..   bundle appears UNPATCHED — no windowsStore marker in ${fileCount} JS files ` +
                `(${present.size}/${markers.length} markers present). Run patch-app-asar.mjs first.`);
    return;
  }
  const absent = markers.filter(m => !present.has(m));
  pass(`bundle patched: ${present.size}/${markers.length} contract patch markers present across ${fileCount} JS files.`);
  if (absent.length) {
    const msg = 'contract markers NOT found in this bundle (dormant/conditional patches are expected; an ' +
                'unexpected one signals a skipped/broken patch — confirm with verify-offline-package.ps1): ' +
                absent.map(shortMarker).join(', ');
    if (args['strict']) fail(msg); else warn(msg);
  } else {
    pass('bundle scan: every contract patch marker is present.');
  }
}

console.log('[smoke] offline renderer-gate smoke test');
try {
  checkGateSync();
  checkMarkerConsistency();
  checkBundleMarkers();
} catch (error) {
  fail(error.message);
}
console.log(`[smoke] done — ${failures} failure(s), ${warnings} warning(s).`);
process.exit(failures > 0 ? 1 : 0);
