"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "../..");
const loadGateReport = () =>
  import(pathToFileURL(path.join(repoRoot, "scripts", "gate-report.mjs")).href);

const contract = {
  denylist: new Set(["1000300", "1234567", "7777777"]),
  forcedTrue: new Set(["1000100", "5555555"]),
  forcedFalse: new Set(["1000200"]),
  knownAsarGates: new Set(["1000100"]),
  dynamicConfigs: new Set(["9999999"]),
};

// Two chunks with minified names: app-shared defines and exports the readers,
// a lazy chunk imports one of them under a different local name.
const sharedChunk = {
  name: "app-shared-aaaa.js",
  surface: "renderer",
  content:
    "function Fyn(e,t){return e.checkGate(t)}function Nyn(e,t){return e.getLayer(t)}" +
    "let a=Gx(`1000100`),b=Gx(`1000200`),c=Gx(`1000300`),d=Ly(`4444444`),e=Ly(`9999999`);" +
    "q.getLayer(`4444444`);q.getDynamicConfig(`9999999`);" +
    "let m={gates:{shareThread:`1111111`},configs:{modelAvailability:`2222222`}};" +
    "let n={policy:`dictation`,statsig:[`3333333`,`1234567`]};" +
    "let layerOnly=Ly(`1234567`);" +
    "let shape={x:`1000000`,maxY:`2000000`};" +
    "export{Gx as zG,Ly as zL};",
};
const lazyChunk = {
  name: "settings-bbbb.js",
  surface: "renderer",
  content: 'import{zG as se,zL as re}from"./app-shared-aaaa.js";function fa(){return se(`6666666`)}',
};
const mainChunk = {
  name: "main-cccc.js",
  surface: "main",
  content: "if(client.checkGate(`5555555`))start();",
};

async function scanFixture() {
  const { scanGateReferences, buildGateReport } = await loadGateReport();
  const seeds = new Set([
    ...contract.denylist, ...contract.forcedTrue, ...contract.forcedFalse, ...contract.dynamicConfigs,
  ]);
  const refs = scanGateReferences([sharedChunk, lazyChunk, mainChunk], seeds);
  return buildGateReport({ refs, contract, version: "test" });
}

test("gate report learns minified readers and follows them across chunk imports", async () => {
  const report = await scanFixture();
  const byId = new Map(report.gates.map((gate) => [gate.id, gate]));
  // The lazy chunk's only read goes through an imported reader alias.
  assert.ok(byId.has("6666666"), "imported reader call sites must be resolved");
  assert.deepEqual(byId.get("6666666").files, ["settings-bbbb.js"]);
  assert.equal(byId.get("6666666").decision, "default-on");
  // Named maps carry the upstream name; statsig lists are gates.
  assert.deepEqual(byId.get("1111111").names, ["shareThread"]);
  assert.deepEqual(byId.get("2222222").kinds, ["config"]);
  assert.deepEqual(byId.get("3333333").kinds, ["gate"]);
  assert.deepEqual(byId.get("5555555").surfaces, ["main"]);
  // Unrelated numeric strings are not gates.
  assert.ok(!byId.has("1000000"));
  assert.ok(!byId.has("2000000"));
});

test("gate report classifies offline decisions and flags non-gate denylist entries", async () => {
  const report = await scanFixture();
  const decision = (id) => report.gates.find((gate) => gate.id === id)?.decision;
  assert.equal(decision("1000100"), "forced-true");
  assert.equal(decision("1000200"), "forced-false");
  assert.equal(decision("1000300"), "denied");
  assert.equal(decision("9999999"), "seeded-config");
  // A layer read is untouched by the default-on gate seams.
  assert.equal(decision("4444444"), "not-a-gate");
  assert.deepEqual(report.contractNotFound.denylist, ["7777777"]);
  assert.deepEqual(report.contractNotFound.forcedTrue, []);
});

test("gate report diff lists new, removed and repurposed ids against a baseline", async () => {
  const { diffGateReports, toBaseline, renderGateReportMarkdown } = await loadGateReport();
  const report = await scanFixture();
  const baseline = toBaseline(report);
  assert.deepEqual(diffGateReports(baseline, report), {
    baselineVersion: "test", added: [], removed: [], changed: [],
  });

  const previous = {
    ...baseline,
    version: "old",
    gates: baseline.gates
      .filter((gate) => gate.id !== "6666666")
      .concat([{ id: "8888888", kinds: ["gate"], names: [], surfaces: ["renderer"] }])
      .map((gate) => (gate.id === "1111111" ? { ...gate, names: ["oldName"] } : gate)),
  };
  const diff = diffGateReports(previous, report);
  assert.deepEqual(diff.added.map((gate) => gate.id), ["6666666"]);
  assert.deepEqual(diff.removed.map((gate) => gate.id), ["8888888"]);
  assert.deepEqual(diff.changed.map((gate) => gate.id), ["1111111"]);

  const markdown = renderGateReportMarkdown(report, diff);
  assert.match(markdown, /### Changes since old/);
  assert.match(markdown, /\*\*New ids \(1\)\*\*/);
  assert.match(markdown, /`1111111`: oldName · gate · renderer → shareThread · gate · renderer/);
  assert.match(markdown, /- denylist \(1\): `7777777`/);
});

test("committed gate baseline parses and matches the report schema", async () => {
  const baseline = require(path.join(repoRoot, "docs", "baselines", "gate-baseline.json"));
  assert.equal(baseline.schemaVersion, 1);
  assert.ok(baseline.gates.length > 0);
  for (const gate of baseline.gates) {
    assert.match(gate.id, /^\d+$/);
    assert.ok(Array.isArray(gate.kinds) && Array.isArray(gate.names) && Array.isArray(gate.surfaces));
  }
});

test("gate report discovers Rspack Statsig wrapper readers even with >60% unseeded gates", async () => {
  const { scanGateReferences, buildGateReport } = await loadGateReport();
  const atomChunk = {
    name: "366996.aaa.js",
    surface: "renderer",
    content:
      "export const __rspack_esm_ids=[366996];export const __webpack_modules__={" +
      "OMIV:(function(e,t,n){var i=n(\"Hl6a\");let a=(0,i.vP)(null);" +
      "let c=(0,i.bD)((e,{get:t})=>t(a)?t(a).getFeatureGate(e):null);" +
      "let u=(0,i.bD)((e,{get:t})=>t(a)?.getFeatureGate(e).value??!1);" +
      "n.d(t,{},{JW:u,dx:c})})};",
  };
  const hooksChunk = {
    name: "49792.bbb.js",
    surface: "renderer",
    content:
      "export const __rspack_esm_ids=[49792];export const __webpack_modules__={" +
      "hZax:(function(e,t,n){var i=n(\"IozE\"),o=n(\"OMIV\");" +
      "function u(){return (0,i.useStatsigClient)()}" +
      "function d(e,t,n){return e.getLayer(t,n)}" +
      "n.d(t,{},{Zj:function(e){return (0,i.Ul)(o.JW,e)},Ou:function(e,t){return d(u().client,e,t)},Fj:function(e,t){return u().getDynamicConfig(e,t)}})})};",
  };
  const consumerChunk = {
    name: "25051.ccc.js",
    surface: "renderer",
    content:
      "export const __rspack_esm_ids=[25051];export const __webpack_modules__={" +
      "mABC:(function(e,t,n){var h=n(\"hZax\"),o=n(\"OMIV\");" +
      "let x=(0,h.Zj)(\"1000100\"),y=(0,h.Zj)(\"9000001\"),z=(0,h.Zj)(\"9000002\"),w=(0,h.Zj)(\"9000003\");" +
      "let a=t(o.JW,\"9000004\"),l=(0,h.Ou)(\"9000005\"),c=(0,h.Fj)(\"9999999\");" +
      "let nonGate={port:\"30000\"};})};",
  };
  const seeds = new Set([...contract.forcedTrue, ...contract.dynamicConfigs]);
  const refs = scanGateReferences([atomChunk, hooksChunk, consumerChunk], seeds);
  const report = buildGateReport({ refs, contract, version: "26.1120.test" });
  const byId = new Map(report.gates.map((gate) => [gate.id, gate]));

  for (const id of ["1000100", "9000001", "9000002", "9000003", "9000004"]) {
    assert.ok(byId.has(id), `expected gate ${id}`);
    assert.deepEqual(byId.get(id).kinds, ["gate"]);
  }
  assert.equal(byId.get("9000001").decision, "default-on");
  assert.equal(byId.get("9000005").decision, "not-a-gate");
  assert.deepEqual(byId.get("9000005").kinds, ["layer"]);
  assert.equal(byId.get("9999999").decision, "seeded-config");
  assert.deepEqual(byId.get("9999999").kinds, ["config"]);
  assert.ok(!byId.has("30000"));
});
