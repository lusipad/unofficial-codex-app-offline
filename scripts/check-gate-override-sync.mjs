#!/usr/bin/env node
/**
 * check-gate-override-sync.mjs
 *
 * Build-time tripwire that keeps the desktop offline build's two Statsig
 * feature-gate coverage lists in sync:
 *
 *   1. capabilityContractData.cjs  -> DESKTOP_ASAR_KNOWN_GATE_IDS
 *      Consumed by patch-app-asar.mjs `patchDirectStatsigGateCalls`, which
 *      neutralizes direct `$f(`<id>`)` renderer calls in the asar (static
 *      fallback path).
 *
 *   2. desktop-patches/init.cjs    -> STATSIG_GATE_OVERRIDES
 *      Injected true at runtime by init.cjs (session.webRequest redirect of
 *      ab.chatgpt.com/v1/initialize + ipcMain shared-object injection).
 *
 * Both mechanisms must cover the SAME set of numeric gate ids so that a gate
 * is unlocked regardless of which path the renderer reads it through. If a new
 * gate is added to one list but not the other, offline coverage silently gets
 * a hole. This script asserts the two numeric-id sets are equal and fails the
 * build (exit 1) on any asymmetric difference, naming the missing ids.
 *
 * Non-numeric keys in STATSIG_GATE_OVERRIDES (guardian_approval, fast_mode,
 * browserPane, …) are init.cjs-only capability flags, not Statsig gate ids, so
 * they are excluded from the comparison.
 *
 * Usage:
 *   node scripts/check-gate-override-sync.mjs        # CLI: prints result, exits 0/1
 *   import { assertGateOverrideSync } from './check-gate-override-sync.mjs'
 *
 * Exit codes:
 *   0  The two gate-id sets are identical.
 *   1  Mismatch, or a source file/anchor could not be parsed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const CONTRACT_PATH = path.resolve(
  scriptDir,
  '..',
  'web-gateway',
  'gateway',
  'src',
  'ipc',
  'codex',
  'capabilityContractData.cjs',
);
const INIT_CJS_PATH = path.resolve(scriptDir, 'desktop-patches', 'init.cjs');

/** Numeric gate ids declared in DESKTOP_ASAR_KNOWN_GATE_IDS (the asar-side list). */
function readKnownGateIds() {
  const contract = require(CONTRACT_PATH);
  const ids = contract && contract.DESKTOP_ASAR_KNOWN_GATE_IDS;
  if (!Array.isArray(ids)) {
    throw new Error(
      `DESKTOP_ASAR_KNOWN_GATE_IDS is not an array in ${CONTRACT_PATH} ` +
      '(capability contract structure changed).',
    );
  }
  return new Set(ids.map(String).filter(id => /^\d+$/.test(id)));
}

/** Numeric gate ids set to true in init.cjs STATSIG_GATE_OVERRIDES (runtime list). */
function readInitGateIds() {
  const source = fs.readFileSync(INIT_CJS_PATH, 'utf8');
  const block = source.match(/STATSIG_GATE_OVERRIDES\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!block) {
    throw new Error(
      `Could not locate the STATSIG_GATE_OVERRIDES object literal in ${INIT_CJS_PATH} ` +
      '(init.cjs structure changed).',
    );
  }
  const ids = new Set();
  for (const match of block[1].matchAll(/['"](\d+)['"]\s*:\s*true\b/g)) {
    ids.add(match[1]);
  }
  if (ids.size === 0) {
    throw new Error(
      'Parsed zero numeric gate ids from STATSIG_GATE_OVERRIDES ' +
      '(init.cjs structure changed).',
    );
  }
  return ids;
}

/**
 * Compares the two lists. Returns a report object; does not throw on mismatch
 * (callers decide how to surface it).
 */
export function compareGateOverrideSync() {
  const known = readKnownGateIds();
  const runtime = readInitGateIds();
  const knownOnly = [...known].filter(id => !runtime.has(id)).sort();
  const runtimeOnly = [...runtime].filter(id => !known.has(id)).sort();
  return {
    ok: knownOnly.length === 0 && runtimeOnly.length === 0,
    knownCount: known.size,
    runtimeCount: runtime.size,
    // In DESKTOP_ASAR_KNOWN_GATE_IDS but missing from init.cjs runtime injection.
    missingFromRuntime: knownOnly,
    // Injected by init.cjs but absent from the asar-side known-gate list.
    missingFromKnown: runtimeOnly,
  };
}

/**
 * Asserts the two gate-id sets are identical. Throws an Error describing the
 * drift on mismatch. Intended to be called from patch-app-asar.mjs at startup.
 */
export function assertGateOverrideSync() {
  const r = compareGateOverrideSync();
  if (r.ok) return r;
  const lines = ['Gate override lists are out of sync between init.cjs and capabilityContractData.cjs:'];
  if (r.missingFromRuntime.length > 0) {
    lines.push(
      `  - In DESKTOP_ASAR_KNOWN_GATE_IDS but NOT in init.cjs STATSIG_GATE_OVERRIDES ` +
      `(runtime injection would miss these): ${r.missingFromRuntime.join(', ')}`,
    );
  }
  if (r.missingFromKnown.length > 0) {
    lines.push(
      `  - In init.cjs STATSIG_GATE_OVERRIDES but NOT in DESKTOP_ASAR_KNOWN_GATE_IDS ` +
      `(asar direct-call fallback would miss these): ${r.missingFromKnown.join(', ')}`,
    );
  }
  lines.push('  Add the missing gate id(s) to both lists so offline coverage stays complete.');
  throw new Error(lines.join('\n'));
}

// CLI entry point.
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  try {
    const r = assertGateOverrideSync();
    console.log(
      `[check-gate-override-sync] OK — ${r.knownCount} gate ids in sync across ` +
      'DESKTOP_ASAR_KNOWN_GATE_IDS and init.cjs STATSIG_GATE_OVERRIDES.',
    );
    process.exit(0);
  } catch (error) {
    console.error(`[check-gate-override-sync] ${error.message}`);
    process.exit(1);
  }
}
