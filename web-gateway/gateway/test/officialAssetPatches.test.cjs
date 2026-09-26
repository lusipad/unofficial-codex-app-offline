const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OFFICIAL_ASSET_PATCH_QUERY,
  patchConnectAppHostChunk,
  patchRpcInitChunk,
  patchOfficialAsset,
} = require("../dist/official/assetPatches.js");

// 26.908 webview 的真实 connect-app-host chunk 形态（语义锚点：postMessage type `connect-app-host`）。
const CONNECT_APP_HOST_26908 =
  'import{n as e}from"./rolldown-runtime-c05d78c594d1.js";' +
  'import{o as t,s as n}from"./usingCtx-9acf941363a3.js";' +
  "function r(){return navigator.userAgent}" +
  "var i=e((()=>{}));" +
  "function d(e){let{port1:t,port2:r}=new MessageChannel;" +
  "return window.postMessage({type:`connect-app-host`,port:r},window.location.origin,[r]),n(t,e)}" +
  "var f=e((()=>{t()}));" +
  'export{s as a,o as c,u as i,f as n,a as o,l as r,c as s,d as t};';

// 26.901 及更早版本的 rpc chunk 初始化形态。
const RPC_INIT_LEGACY =
  "var Q,$;async function de(){Q=ue(),$=await Q.services}export{$ as n,de as r,Q as t};";

// 26.908 的 rpc chunk 已退化为 re-export，不应再触发旧补丁或告警。
const RPC_REEXPORT_26908 =
  'import{DW as e,EW as t,TW as n,wW as r}from"./app-initial-d9bed9d614d8.js";' +
  "t();export{r as appHost,n as appServices,e as initializeAppHostServices};";

function captureWarns(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test("connect-app-host chunk: 26.908 shape is replaced with mock services", () => {
  const { result, warnings } = captureWarns(() => patchConnectAppHostChunk(CONNECT_APP_HOST_26908));
  assert.equal(warnings.length, 0);
  assert.ok(!result.includes("new MessageChannel"), "must not keep the MessageChannel connect");
  assert.ok(!result.includes("connect-app-host`),"), "must not keep the postMessage to the host");
  assert.ok(result.includes("services:Promise.resolve({"), "must return mock services");
  assert.ok(result.includes("hotkeyWindowHotkeys"), "must keep the mock service keys");
  assert.ok(result.includes("export{s as a"), "must keep the export statement intact");
});

test("connect-app-host chunk: drifted shape warns and stays unchanged (fail-closed)", () => {
  const drifted = CONNECT_APP_HOST_26908.replace("window.location.origin", "location.origin");
  const { result, warnings } = captureWarns(() => patchConnectAppHostChunk(drifted));
  assert.equal(result, drifted);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /connect-app-host patch skipped/);
});

test("rpc chunk: legacy de() init is replaced with mock services", () => {
  const { result, warnings } = captureWarns(() => patchRpcInitChunk(RPC_INIT_LEGACY));
  assert.equal(warnings.length, 0);
  assert.ok(!result.includes("Q=ue()"), "must not keep the real RPC connect");
  assert.ok(result.includes("services:Promise.resolve({"));
  assert.ok(result.includes("$=await Q.services"), "must keep the export-compatible shape");
});

test("rpc chunk: 26.908 re-export passes through without warn", () => {
  const { result, warnings } = captureWarns(() => patchRpcInitChunk(RPC_REEXPORT_26908));
  assert.equal(result, RPC_REEXPORT_26908);
  assert.equal(warnings.length, 0);
});

test("rpc chunk: unrecognized services await warns and stays unchanged", () => {
  const unknown = "var a,b;async function zz(){a=qq(),b=await a.services}export{b as n};";
  const { result, warnings } = captureWarns(() => patchRpcInitChunk(unknown));
  assert.equal(result, unknown);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rpc-init patch skipped/);
});

test("patchOfficialAsset wires the connect-app-host mock and module specifier query", () => {
  const reqPath = "/official/assets/connect-app-host-e569c097489b.js";
  const out = patchOfficialAsset(reqPath, Buffer.from(CONNECT_APP_HOST_26908, "utf-8")).toString("utf-8");
  assert.ok(!out.includes("new MessageChannel"));
  assert.ok(out.includes("services:Promise.resolve({"));
  assert.ok(
    out.includes(`from"./rolldown-runtime-c05d78c594d1.js?${OFFICIAL_ASSET_PATCH_QUERY}"`),
    "relative imports must carry the patch query"
  );
});

// 26.917 起 connect-app-host 握手被并进 app-shared chunk，不再有独立文件名。
const APP_SHARED_26924 =
  'import{n as e}from"./rolldown-runtime-c05d78c594d1.js";' +
  "var fWr={};function mWr(e){let{port1:t,port2:n}=new MessageChannel;" +
  "return window.postMessage({type:`connect-app-host`,port:n},window.location.origin,[n]),Unt(t,e)}" +
  "async function gWr(){s5=mWr(fWr),c5=await s5.services}";

test("patchOfficialAsset mocks connect-app-host wherever the handshake lives (26.924 app-shared)", () => {
  const reqPath = "/official/assets/app-shared-d93bebbb48ab.js";
  const { result, warnings } = captureWarns(() =>
    patchOfficialAsset(reqPath, Buffer.from(APP_SHARED_26924, "utf-8")).toString("utf-8")
  );
  assert.equal(warnings.length, 0);
  assert.ok(!result.includes("new MessageChannel"), "must not keep the MessageChannel connect");
  assert.ok(result.includes("function mWr(e){return{services:Promise.resolve({"));
  assert.ok(result.includes("s5=mWr(fWr),c5=await s5.services"), "callers stay intact");
  assert.ok(
    result.includes("httpFetch:window.__codexWebHttpFetch"),
    "26.924 renderer HTTP goes through the host httpFetch service"
  );
});

test("patchOfficialAsset does not warn on chunks without the connect-app-host handshake", () => {
  const body = "var a=1;export{a as b};";
  const { result, warnings } = captureWarns(() =>
    patchOfficialAsset("/official/assets/app-initial-58e226417aae.js", Buffer.from(body, "utf-8")).toString("utf-8")
  );
  assert.equal(result, body);
  assert.equal(warnings.length, 0);
});

test("patch query changes whenever the patch module changes", () => {
  // Official assets are served `immutable` for a year, so the query is the only
  // thing that evicts a browser's copy patched by an older gateway.
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const modulePath = require.resolve("../dist/official/assetPatches.js");
  const digest = crypto.createHash("sha256").update(fs.readFileSync(modulePath)).digest("hex").slice(0, 12);
  assert.equal(OFFICIAL_ASSET_PATCH_QUERY, `codex-web-patch=${digest}`);
});

test("patchOfficialAsset leaves non-asset paths untouched", () => {
  const body = Buffer.from(CONNECT_APP_HOST_26908, "utf-8");
  const out = patchOfficialAsset("/official/index.html", body);
  assert.ok(out.equals(body));
});
