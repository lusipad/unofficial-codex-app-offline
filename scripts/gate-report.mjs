#!/usr/bin/env node
/**
 * gate-report.mjs
 *
 * Inventories the Statsig gate / dynamic-config ids an upstream bundle reads and
 * how the offline build decides each one, so a new Store version can be
 * reviewed (new ids to classify, contract entries that went stale) before the
 * denylist or overrides are touched. Diagnostic only: it never fails a build.
 *
 * Minified reader names change every version, so readers are learned from the
 * bundle instead of hard-coded:
 *   1. direct Statsig SDK calls (`.checkGate("…")`, `.getDynamicConfig("…")`, …);
 *   2. named id maps (`gates:{shareThread:"…"}`, `configs:{…}`);
 *   3. any call site whose literal id arguments are mostly ids already known
 *      from 1–2 or the capability contract is treated as a gate reader, and
 *      every literal it receives is reported.
 * Ids passed through a variable stay invisible to a static scan; the report
 * says so instead of guessing.
 *
 * Usage:
 *   node scripts/gate-report.mjs --asar <app.asar> --out-dir <dir>
 *        [--baseline docs/baselines/gate-baseline.json] [--version <x>]
 *        [--write-baseline <path>] [--summary <file to append markdown to>]
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const ID = String.raw`[\x60"'](\d{4,10})[\x60"']`;
const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const SDK_CALL_RE = new RegExp(
  String.raw`\.(checkGate|getFeatureGate|getDynamicConfig|getExperiment|getLayer)\(\s*${ID}`,
  'g',
);
const NAMED_MAP_RE = new RegExp(String.raw`\b(gates|configs|experiments|layers):\{([^{}]*)\}`, 'g');
const NAMED_ENTRY_RE = new RegExp(String.raw`(${IDENT}):${ID}`, 'g');
const CALL_SITE_RE = new RegExp(String.raw`(${IDENT})\(\s*(?:(${IDENT}),\s*)?${ID}\s*[,)]`, 'g');
const STATSIG_LIST_RE = new RegExp(String.raw`\bstatsig:\[((?:\s*${ID}\s*,?)+)\]`, 'g');
const IMPORT_RE = /import\{([^}]*)\}from["']\.\/([^"']+)["']/g;
const EXPORT_RE = /export\{([^}]*)\}/g;
const RSPACK_MOD_SPLIT_RE = /(?:^|[{,])([A-Za-z0-9_$+\/]{4}):?\(?(?:function)?\([A-Za-z_$],[A-Za-z_$],([A-Za-z_$])\)\{/g;
const RSPACK_REQ_RE = /\b([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$])\("([A-Za-z0-9_$+\/]{4})"\)/g;
const RSPACK_CALL_RE = new RegExp(String.raw`(?:\(0,\s*(${IDENT})\.(${IDENT})\s*\)|(${IDENT})\.(${IDENT}))\(\s*${ID}\s*[,)]`, 'g');
const RSPACK_GET_RE = new RegExp(String.raw`(?:${IDENT}|\(0,\s*${IDENT}\.${IDENT}\s*\))\(\s*(${IDENT})\.(${IDENT})\s*,\s*${ID}\s*[,)]`, 'g');

const SDK_KIND = {
  checkGate: 'gate',
  getFeatureGate: 'gate',
  getDynamicConfig: 'config',
  getExperiment: 'experiment',
  getLayer: 'layer',
};
const MAP_KIND = { gates: 'gate', configs: 'config', experiments: 'experiment', layers: 'layer' };

// A call-site key is accepted as a gate reader once enough of its literal
// arguments are already-known ids; generic helpers fed unrelated numeric
// strings stay below the bar.
const READER_MIN_KNOWN = 2;
const READER_MIN_PRECISION = 0.5;

export function loadContract() {
  const contract = require(path.join(
    repoRoot, 'web-gateway', 'gateway', 'src', 'ipc', 'codex', 'capabilityContractData.cjs',
  ));
  const numeric = (keys) => keys.filter((key) => /^\d+$/.test(key));
  const overrides = contract.STATSIG_DEFAULT_FEATURE_OVERRIDES;
  return {
    denylist: new Set(contract.DESKTOP_GATE_DENYLIST),
    forcedTrue: new Set(numeric(Object.keys(overrides)).filter((key) => overrides[key] === true)),
    forcedFalse: new Set(numeric(Object.keys(overrides)).filter((key) => overrides[key] === false)),
    knownAsarGates: new Set(contract.DESKTOP_ASAR_KNOWN_GATE_IDS),
    dynamicConfigs: new Set(Object.keys(contract.STATSIG_DEFAULT_DYNAMIC_CONFIGS)),
  };
}

function contractIds(contract) {
  return new Set([
    ...contract.denylist,
    ...contract.forcedTrue,
    ...contract.forcedFalse,
    ...contract.knownAsarGates,
    ...contract.dynamicConfigs,
  ]);
}

function reference(refs, id) {
  let entry = refs.get(id);
  if (!entry) {
    entry = { id, kinds: new Set(), names: new Set(), files: new Set(), surfaces: new Set(), via: new Set() };
    refs.set(id, entry);
  }
  return entry;
}

function record(refs, id, file, { kind, name, via }) {
  const entry = reference(refs, id);
  entry.files.add(file.name);
  entry.surfaces.add(file.surface);
  if (kind) entry.kinds.add(kind);
  if (name) entry.names.add(name);
  entry.via.add(via);
}

function bindings(list) {
  return list.split(',').map((item) => item.trim()).filter(Boolean).map((item) => {
    const [exported, local = exported] = item.split(/\s+as\s+/);
    return { exported, local };
  });
}

// Chunks import each other's minified symbols under per-chunk local names; a
// reader is identified by its defining chunk + export name so call sites in
// every chunk that imports it pool their evidence.
function symbolResolver(file) {
  const imported = new Map();
  for (const match of file.content.matchAll(IMPORT_RE)) {
    const source = path.posix.basename(match[2]);
    for (const { exported, local } of bindings(match[1])) imported.set(local, `${source}#${exported}`);
  }
  // `export{local as name}` lists the local binding first, unlike imports.
  const ownExports = new Map();
  for (const match of file.content.matchAll(EXPORT_RE)) {
    for (const { exported: local, local: name } of bindings(match[1])) {
      ownExports.set(local, `${file.name}#${name}`);
    }
  }
  return (name) => imported.get(name) ?? ownExports.get(name) ?? `${file.name}~${name}`;
}

function splitRspackModules(content) {
  const starts = [];
  for (const match of content.matchAll(RSPACK_MOD_SPLIT_RE)) {
    starts.push({ modId: match[1], reqVar: match[2], index: match.index });
  }
  if (starts.length === 0) return [];
  return starts.map((entry, idx) => ({
    modId: entry.modId,
    reqVar: entry.reqVar,
    text: content.slice(entry.index, idx + 1 < starts.length ? starts[idx + 1].index : content.length),
  }));
}

function parseRspackRequires(text, reqVar) {
  const varToMod = new Map();
  for (const match of text.matchAll(RSPACK_REQ_RE)) {
    if (match[2] === reqVar) varToMod.set(match[1], match[3]);
  }
  return varToMod;
}

function extractBalancedObject(text, openBraceIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openBraceIndex + 1, i);
    }
  }
  return '';
}

function inferSdkKindFromSnippet(snippet) {
  const kinds = new Set();
  if (/\.(?:getFeatureGate|checkGate)\b/.test(snippet)) kinds.add('gate');
  if (/\.getDynamicConfig\b/.test(snippet)) kinds.add('config');
  if (/\.getLayer\b/.test(snippet)) kinds.add('layer');
  if (/\.getExperiment\b/.test(snippet)) kinds.add('experiment');
  return kinds;
}

// Inspect Rspack `req.d(exports, ...)` export definitions so direct Statsig
// wrappers and re-export hooks are recognized by structure rather than only
// seed precision (which drops below 50% when an upstream release adds many new gates).
function learnRspackStatsigExports(files) {
  const modules = [];
  for (const file of files) {
    for (const mod of splitRspackModules(file.content)) {
      modules.push(mod);
    }
  }
  const directKinds = new Map(); // "MODID#EXPORT" -> kind
  const moduleBindings = [];
  for (const mod of modules) {
    const varToMod = parseRspackRequires(mod.text, mod.reqVar);
    const localKinds = new Map();
    const dIndex = mod.text.search(new RegExp(String.raw`\b${mod.reqVar}\.d\(`));
    const bodyRegion = dIndex >= 0 ? mod.text.slice(0, dIndex) : mod.text;
    const fnMatches = bodyRegion.matchAll(
      new RegExp(String.raw`\b(?:function\s+(${IDENT})\([^)]*\)\s*\{|(?:let|var|const)\s+(${IDENT})\s*=)`, 'g'),
    );
    const fnStarts = [...fnMatches].map((m) => ({
      name: m[1] || m[2],
      idx: m.index,
      isFunc: Boolean(m[1]),
      braceIdx: m[1] ? m.index + m[0].length - 1 : -1,
    }));
    for (let i = 0; i < fnStarts.length; i++) {
      const fn = fnStarts[i];
      const end = i + 1 < fnStarts.length ? fnStarts[i + 1].idx : bodyRegion.length;
      const body = fn.isFunc
        ? extractBalancedObject(bodyRegion, fn.braceIdx)
        : bodyRegion.slice(fn.idx, Math.min(end, fn.idx + 600));
      const kinds = inferSdkKindFromSnippet(body);
      if (kinds.size > 0) localKinds.set(fn.name, kinds);
    }
    const dRe = new RegExp(String.raw`\b${mod.reqVar}\.d\(\s*${IDENT}\s*,(?:\s*\{\s*\}\s*,)?\s*\{`, 'g');
    const exportsList = [];
    for (const dMatch of mod.text.matchAll(dRe)) {
      const objBody = extractBalancedObject(mod.text, dMatch.index + dMatch[0].length - 1);
      if (!objBody) continue;
      let depth = 0;
      let start = 0;
      let quote = null;
      const entries = [];
      for (let i = 0; i <= objBody.length; i++) {
        const ch = i < objBody.length ? objBody[i] : ',';
        if (quote) {
          if (ch === '\\') { i++; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        else if (ch === '}' || ch === ')' || ch === ']') depth--;
        else if (ch === ',' && depth === 0) {
          const item = objBody.slice(start, i).trim();
          if (item) entries.push(item);
          start = i + 1;
        }
      }
      for (const entry of entries) {
        const colon = entry.indexOf(':');
        if (colon < 0) continue;
        const expName = entry.slice(0, colon).trim();
        const rhs = entry.slice(colon + 1).trim();
        if (!new RegExp(`^${IDENT}$`).test(expName)) continue;
        exportsList.push({ expName, rhs });
        const kinds = inferSdkKindFromSnippet(rhs);
        const arrowTarget = rhs.match(new RegExp(String.raw`^(?:\(\)\s*=>\s*)?(${IDENT})$`));
        if (arrowTarget && localKinds.has(arrowTarget[1])) {
          for (const k of localKinds.get(arrowTarget[1])) kinds.add(k);
        }
        for (const [localName, lKinds] of localKinds) {
          if (new RegExp(String.raw`\b${localName}\b`).test(rhs)) {
            for (const k of lKinds) kinds.add(k);
          }
        }
        if (kinds.size === 1) {
          directKinds.set(`${mod.modId}#${expName}`, [...kinds][0]);
        }
      }
    }
    moduleBindings.push({ modId: mod.modId, text: mod.text, varToMod, exportsList, localKinds });
  }
  for (const { modId, text, varToMod, exportsList } of moduleBindings) {
    if (varToMod.size === 0) continue;
    for (const { expName, rhs } of exportsList) {
      const key = `${modId}#${expName}`;
      if (directKinds.has(key)) continue;
      let combined = rhs;
      const refId = rhs.match(new RegExp(String.raw`^(?:\(\)\s*=>\s*)?(${IDENT})$`));
      if (refId) {
        const localFnMatch = text.match(new RegExp(String.raw`\bfunction\s+${refId[1]}\([^)]*\)\{[^}]{0,300}\}`));
        if (localFnMatch) combined += ' ' + localFnMatch[0];
      }
      const importedKinds = new Set();
      for (const m of combined.matchAll(new RegExp(String.raw`\b(${IDENT})\.(${IDENT})\b`, 'g'))) {
        const targetMod = varToMod.get(m[1]);
        if (!targetMod) continue;
        const targetKind = directKinds.get(`${targetMod}#${m[2]}`);
        if (targetKind) importedKinds.add(targetKind);
      }
      if (importedKinds.size === 1) {
        directKinds.set(key, [...importedKinds][0]);
      }
    }
  }
  return directKinds;
}

/**
 * @param {{name: string, surface: string, content: string}[]} files
 * @param {Set<string>} seedIds ids known to be gates before scanning
 */
export function scanGateReferences(files, seedIds = new Set()) {
  const refs = new Map();
  const known = new Set(seedIds);

  for (const file of files) {
    for (const match of file.content.matchAll(SDK_CALL_RE)) {
      record(refs, match[2], file, { kind: SDK_KIND[match[1]], via: 'sdk' });
      known.add(match[2]);
    }
    for (const map of file.content.matchAll(NAMED_MAP_RE)) {
      for (const entry of map[2].matchAll(NAMED_ENTRY_RE)) {
        record(refs, entry[2], file, { kind: MAP_KIND[map[1]], name: entry[1], via: 'named-map' });
        known.add(entry[2]);
      }
    }
    for (const list of file.content.matchAll(STATSIG_LIST_RE)) {
      for (const entry of list[1].matchAll(new RegExp(ID, 'g'))) {
        record(refs, entry[1], file, { kind: 'gate', via: 'statsig-list' });
        known.add(entry[1]);
      }
    }
  }

  // key -> [{ id, file }] across all chunks.
  const sites = new Map();
  const addSite = (key, id, file) => {
    if (!sites.has(key)) sites.set(key, []);
    sites.get(key).push({ id, file });
  };
  const rspackWrapperKinds = learnRspackStatsigExports(files);
  const rspackSites = new Map(); // "MODID#PROP" -> [{ id, file }]
  const addRspackSite = (exportKey, id, file) => {
    if (!rspackSites.has(exportKey)) rspackSites.set(exportKey, []);
    rspackSites.get(exportKey).push({ id, file });
  };

  for (const file of files) {
    const resolve = symbolResolver(file);
    for (const match of file.content.matchAll(CALL_SITE_RE)) {
      const [, callee, firstArg, id] = match;
      if (firstArg) {
        // `read(scope, "id")` is either a wrapper taking a scope or a getter
        // applied to an atom family; let the evidence pick.
        addSite(`call:${resolve(callee)}/2`, id, file);
        addSite(`arg:${resolve(firstArg)}`, id, file);
      } else {
        addSite(`call:${resolve(callee)}`, id, file);
      }
    }

    for (const mod of splitRspackModules(file.content)) {
      const varToMod = parseRspackRequires(mod.text, mod.reqVar);
      if (varToMod.size === 0) continue;
      for (const match of mod.text.matchAll(RSPACK_CALL_RE)) {
        const localVar = match[1] || match[3];
        const prop = match[2] || match[4];
        const targetMod = varToMod.get(localVar);
        if (targetMod) addRspackSite(`${targetMod}#${prop}`, match[5], file);
      }
      for (const match of mod.text.matchAll(RSPACK_GET_RE)) {
        const targetMod = varToMod.get(match[1]);
        if (targetMod) addRspackSite(`${targetMod}#${match[2]}`, match[3], file);
      }
    }
  }
  const typed = new Map([...refs].map(([id, entry]) => [id, new Set(entry.kinds)]));
  for (const entries of sites.values()) {
    const knownCount = entries.filter(({ id }) => known.has(id)).length;
    if (knownCount < READER_MIN_KNOWN || knownCount / entries.length < READER_MIN_PRECISION) continue;
    // A reader whose typed ids all share one kind (only gates, only configs, …)
    // passes that kind on to the ids it is the sole evidence for.
    const kinds = new Set(entries.flatMap(({ id }) => [...(typed.get(id) ?? [])]));
    const kind = kinds.size === 1 ? [...kinds][0] : undefined;
    for (const { id, file } of entries) record(refs, id, file, { kind, via: 'reader' });
  }
  for (const [exportKey, entries] of rspackSites.entries()) {
    const wrapperKind = rspackWrapperKinds.get(exportKey);
    if (!wrapperKind) {
      const uniqueIds = new Set(entries.map(({ id }) => id));
      const knownCount = [...uniqueIds].filter((id) => known.has(id)).length;
      if (knownCount < READER_MIN_KNOWN || knownCount / uniqueIds.size < READER_MIN_PRECISION) continue;
    }
    const kinds = new Set(entries.flatMap(({ id }) => [...(typed.get(id) ?? [])]));
    const kind = wrapperKind ?? (kinds.size === 1 ? [...kinds][0] : undefined);
    for (const { id, file } of entries) record(refs, id, file, { kind, via: 'rspack-reader' });
  }
  return refs;
}

export function classify(id, contract, kinds = []) {
  if (contract.dynamicConfigs.has(id)) return 'seeded-config';
  if (contract.forcedFalse.has(id)) return 'forced-false';
  if (contract.forcedTrue.has(id)) return 'forced-true';
  if (contract.denylist.has(id)) return 'denied';
  // Configs, experiments and layers are untouched by the default-on gate seams.
  if (kinds.length > 0 && !kinds.includes('gate')) return 'not-a-gate';
  return 'default-on';
}

export function buildGateReport({ refs, contract, version }) {
  const gates = [...refs.values()]
    .map((entry) => ({
      id: entry.id,
      decision: classify(entry.id, contract, [...entry.kinds]),
      kinds: [...entry.kinds].sort(),
      names: [...entry.names].sort(),
      surfaces: [...entry.surfaces].sort(),
      via: [...entry.via].sort(),
      files: [...entry.files].sort(),
      seededDynamicConfig: contract.dynamicConfigs.has(entry.id),
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
  const seen = new Set(gates.map((gate) => gate.id));
  const unseen = (ids) => [...ids].filter((id) => !seen.has(id)).sort((a, b) => Number(a) - Number(b));
  const counts = {};
  for (const gate of gates) counts[gate.decision] = (counts[gate.decision] ?? 0) + 1;
  return {
    schemaVersion: 1,
    version: version ?? null,
    counts,
    gates,
    contractNotFound: {
      denylist: unseen(contract.denylist),
      forcedTrue: unseen(contract.forcedTrue),
      forcedFalse: unseen(contract.forcedFalse),
      dynamicConfigs: unseen(contract.dynamicConfigs),
    },
    // Denylist entries the bundle only reads as a config/experiment/layer: the
    // denylist acts on gate reads, so these entries are no-ops.
    deniedNonGates: gates
      .filter((gate) => contract.denylist.has(gate.id) && gate.kinds.length > 0 && !gate.kinds.includes('gate'))
      .map((gate) => gate.id),
  };
}

// The baseline keeps only what is stable across versions: chunk names are
// content-hashed, so they would make every diff noisy.
export function toBaseline(report) {
  return {
    schemaVersion: 1,
    version: report.version,
    gates: report.gates.map(({ id, kinds, names, surfaces }) => ({ id, kinds, names, surfaces })),
  };
}

export function diffGateReports(baseline, report) {
  if (!baseline) return null;
  const before = new Map(baseline.gates.map((gate) => [gate.id, gate]));
  const after = new Map(report.gates.map((gate) => [gate.id, gate]));
  const join = (values) => (values ?? []).join(',');
  return {
    baselineVersion: baseline.version,
    added: report.gates.filter((gate) => !before.has(gate.id)),
    removed: baseline.gates.filter((gate) => !after.has(gate.id)),
    changed: report.gates
      .filter((gate) => before.has(gate.id))
      .filter((gate) => {
        const old = before.get(gate.id);
        return join(old.kinds) !== join(gate.kinds) || join(old.names) !== join(gate.names) ||
          join(old.surfaces) !== join(gate.surfaces);
      })
      .map((gate) => ({ ...gate, previous: before.get(gate.id) })),
  };
}

function describe(gate) {
  const parts = [];
  if (gate.names.length) parts.push(gate.names.join('/'));
  if (gate.kinds.length) parts.push(gate.kinds.join('/'));
  parts.push(gate.surfaces.join('+'));
  return parts.join(' · ');
}

function gateRows(gates) {
  return gates.map((gate) =>
    `| \`${gate.id}\` | ${gate.decision} | ${describe(gate)} | ${gate.files.slice(0, 3).join(', ')}` +
    `${gate.files.length > 3 ? ` (+${gate.files.length - 3})` : ''} |`);
}

export function renderGateReportMarkdown(report, diff) {
  const lines = [`## Gate report ${report.version ?? ''}`.trimEnd(), ''];
  lines.push(
    `${report.gates.length} ids read by the bundle: ` +
    Object.entries(report.counts).map(([decision, count]) => `${decision} ${count}`).join(', ') + '.',
    '',
    'Static scan only: ids passed through a variable are not listed.',
    '',
  );
  const table = ['| id | offline | kind | files |', '| --- | --- | --- | --- |'];
  if (diff) {
    lines.push(`### Changes since ${diff.baselineVersion ?? 'baseline'}`, '');
    if (diff.added.length) {
      lines.push(`**New ids (${diff.added.length})** — decide whether the default applies:`, '', ...table,
        ...gateRows(diff.added), '');
    }
    if (diff.removed.length) {
      lines.push(`**No longer read (${diff.removed.length}):** ` +
        diff.removed.map((gate) => `\`${gate.id}\``).join(', '), '');
    }
    if (diff.changed.length) {
      lines.push(`**Changed kind/name/surface (${diff.changed.length})** — the id may have been repurposed:`, '',
        ...diff.changed.map((gate) =>
          `- \`${gate.id}\`: ${describe(gate.previous)} → ${describe(gate)}`), '');
    }
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
      lines.push('No changes.', '');
    }
  }
  const stale = report.contractNotFound;
  const staleLines = Object.entries(stale)
    .filter(([, ids]) => ids.length)
    .map(([list, ids]) => `- ${list} (${ids.length}): ${ids.map((id) => `\`${id}\``).join(', ')}`);
  if (report.deniedNonGates.length) {
    staleLines.push(`- denylist entries read only as config/experiment/layer (${report.deniedNonGates.length}): ` +
      report.deniedNonGates.map((id) => `\`${id}\``).join(', '));
  }
  if (staleLines.length) {
    lines.push('### Contract entries to review', '',
      'Candidates for cleanup; confirm at runtime first, since variable-passed ids are invisible here.', '',
      ...staleLines, '');
  }
  lines.push('<details><summary>All ids</summary>', '', ...table, ...gateRows(report.gates), '', '</details>', '');
  return lines.join('\n');
}

export function readAsarFiles(asarPath) {
  const asar = require('@electron/asar');
  const files = [];
  for (const entry of asar.listPackage(asarPath)) {
    const normalized = entry.replace(/\\/g, '/').replace(/^\//, '');
    const surface = normalized.startsWith('webview/assets/')
      ? 'renderer'
      : normalized.startsWith('.vite/build/') ? 'main' : null;
    if (!surface || !normalized.endsWith('.js')) continue;
    files.push({
      name: path.posix.basename(normalized),
      surface,
      content: asar.extractFile(asarPath, entry.replace(/^[\\/]/, '')).toString('utf8'),
    });
  }
  return files;
}

export function generateGateReport({ files, version, baseline }) {
  const contract = loadContract();
  const refs = scanGateReferences(files, contractIds(contract));
  const report = buildGateReport({ refs, contract, version });
  const diff = diffGateReports(baseline, report);
  return { report, diff, markdown: renderGateReportMarkdown(report, diff) };
}

function main() {
  const { values } = parseArgs({
    options: {
      asar: { type: 'string' },
      'out-dir': { type: 'string' },
      baseline: { type: 'string' },
      version: { type: 'string' },
      'write-baseline': { type: 'string' },
      summary: { type: 'string' },
    },
  });
  if (!values.asar) throw new Error('--asar is required');
  const baselinePath = values.baseline ?? path.join(repoRoot, 'docs', 'baselines', 'gate-baseline.json');
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : null;
  const { report, diff, markdown } = generateGateReport({
    files: readAsarFiles(values.asar),
    version: values.version,
    baseline,
  });
  if (values['out-dir']) {
    fs.mkdirSync(values['out-dir'], { recursive: true });
    fs.writeFileSync(path.join(values['out-dir'], 'gate-report.json'),
      JSON.stringify({ ...report, diff }, null, 2) + '\n');
    fs.writeFileSync(path.join(values['out-dir'], 'gate-report.md'), markdown);
  }
  if (values['write-baseline']) {
    // One gate per line keeps the committed baseline reviewable in diffs.
    const baselineOut = toBaseline(report);
    fs.writeFileSync(values['write-baseline'],
      `{\n  "schemaVersion": ${baselineOut.schemaVersion},\n  "version": ${JSON.stringify(baselineOut.version)},\n` +
      `  "gates": [\n${baselineOut.gates.map((gate) => `    ${JSON.stringify(gate)}`).join(',\n')}\n  ]\n}\n`);
  }
  if (values.summary) fs.appendFileSync(values.summary, markdown + '\n');
  const added = diff ? `, ${diff.added.length} new / ${diff.removed.length} gone / ${diff.changed.length} changed vs ${diff.baselineVersion}` : '';
  console.log(`[gate-report] ${report.gates.length} ids (${Object.entries(report.counts)
    .map(([k, v]) => `${k} ${v}`).join(', ')})${added}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[gate-report] ${error.message}`);
    process.exit(1);
  }
}
