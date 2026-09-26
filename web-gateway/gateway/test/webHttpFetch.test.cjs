const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const polyfillSource = fs.readFileSync(
  path.join(__dirname, "..", "..", "web-shell", "codex-bridge-polyfill.js"),
  "utf8"
);

// 26.924 起 renderer 通过宿主 httpFetch service 发 HTTP 请求（fetch(id, req) / cancel(id)），
// Web 端把它转发到 gateway 既有的 `fetch` 消息通道。
function loadFactory() {
  const start = polyfillSource.indexOf("function createCodexWebHttpFetch(");
  const end = polyfillSource.indexOf("\n  }\n", start);
  assert.notEqual(start, -1, "createCodexWebHttpFetch is missing from the bridge polyfill");
  return Function(`"use strict";\n${polyfillSource.slice(start, end + 4)}\nreturn createCodexWebHttpFetch;`)();
}

function harness() {
  const sent = [];
  const handlers = new Map();
  const httpFetch = loadFactory()({
    send: (message) => sent.push(message),
    subscribe: (channel, handler) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  });
  const reply = (payload) => handlers.get("fetch-response")(payload);
  return { httpFetch, sent, reply };
}

test("httpFetch forwards the request through the gateway fetch channel", async () => {
  const { httpFetch, sent, reply } = harness();
  const pending = httpFetch.fetch("req-1", {
    url: "https://chatgpt.com/backend-api/me",
    method: "POST",
    headers: new Headers({ "x-a": "1" }),
    body: '{"k":1}',
  });
  assert.equal(typeof pending[Symbol.dispose], "function", "the pending call must be disposable");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(sent, [{
    type: "fetch",
    requestId: "req-1",
    url: "https://chatgpt.com/backend-api/me",
    method: "POST",
    headers: { "content-type": "application/json", "x-a": "1" },
    body: '{"k":1}',
  }]);

  reply({ requestId: "other", responseType: "success", status: 200, bodyText: "ignored" });
  reply({
    requestId: "req-1",
    responseType: "success",
    status: 201,
    headers: { "content-type": "application/json" },
    bodyText: '{"ok":true}',
    bodyJsonString: '{"ok":true}',
  });
  const result = await pending;
  assert.equal(typeof result[Symbol.dispose], "function", "the result must be disposable");
  assert.equal(result.response.status, 201);
  assert.equal(result.response.headers.get("content-type"), "application/json");
  assert.deepEqual(await result.response.json(), { ok: true });
});

test("httpFetch infers a JSON content type like the desktop fetch wrapper", async () => {
  // 桌面主进程 prepareFetchInit：字符串 body 且无 Content-Type、内容是 JSON 对象/数组时补 application/json；
  // 26.924 的 /wham/statsig/bootstrap 依赖它，否则后端 400 并让首屏等到超时。
  const { httpFetch, sent } = harness();
  httpFetch.fetch("j", { url: "/wham/statsig/bootstrap", method: "POST", headers: { originator: "Codex Desktop" }, body: ' {"a":1}' });
  httpFetch.fetch("k", { url: "/x", method: "POST", headers: { "Content-Type": "text/plain" }, body: '{"a":1}' });
  httpFetch.fetch("l", { url: "/y", method: "POST", body: "{not json" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.find((m) => m.requestId === "j").headers["content-type"], "application/json");
  assert.equal(sent.find((m) => m.requestId === "k").headers["content-type"], "text/plain");
  assert.equal(sent.find((m) => m.requestId === "l").headers["content-type"], undefined);
});

test("httpFetch falls back to bodyJsonString and keeps null-body statuses empty", async () => {
  const { httpFetch, reply } = harness();
  const json = httpFetch.fetch("a", { url: "vscode://codex/x" });
  const empty = httpFetch.fetch("b", { url: "https://chatgpt.com/ces/v1/t" });
  await Promise.resolve();
  reply({ requestId: "a", responseType: "success", status: 200, bodyJsonString: "[1,2]" });
  reply({ requestId: "b", responseType: "success", status: 204, bodyText: "", bodyJsonString: "null" });
  assert.deepEqual(await (await json).response.json(), [1, 2]);
  const emptyResult = await empty;
  assert.equal(emptyResult.response.status, 204);
  assert.equal(emptyResult.response.body, null);
});

test("httpFetch maps gateway errors to the host error shape without throwing", async () => {
  const { httpFetch, reply } = harness();
  const pending = httpFetch.fetch("e", { url: "https://example.com" });
  await Promise.resolve();
  reply({ requestId: "e", responseType: "error", status: 502, error: "upstream down" });
  const result = await pending;
  assert.equal("response" in result, false);
  assert.equal(result.error, "upstream down");
  assert.equal(result.status, 502);
  assert.equal(typeof result[Symbol.dispose], "function");
});

test("httpFetch cancel settles the pending request and ignores late replies", async () => {
  const { httpFetch, reply } = harness();
  const pending = httpFetch.fetch("c", { url: "https://example.com" });
  await httpFetch.cancel("c");
  const result = await pending;
  assert.equal("response" in result, false);
  assert.match(result.error, /cancel/i);
  reply({ requestId: "c", responseType: "success", status: 200, bodyText: "late" });
});
