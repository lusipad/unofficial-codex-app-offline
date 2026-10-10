# Issue 127: Codex 26.1002 offline build failure

The scheduled `build-offline-package` run failed all three attempts on
`943dab6`. Two independent problems showed up, and fixing the first exposed a
second drifted anchor behind it:

| Attempt | Step | Failure |
| --- | --- | --- |
| 1, 3 | Validate patch scripts | `daily-launcher-codex-home.test.cjs` cleanup: `EPERM` from `rmSync` |
| 2 | Build offline bundle | `patch-app-asar.mjs`: `Could not locate app-server request bus for Computer Use node_repl.js bridge.` |

## Root cause 1: the node_repl bridge lost its bus (26.1002.7124.0)

The Store resolver now selects `OpenAI.Codex_26.1002.7124.0_x64` (SHA1
`8a1a586664fc00793ebc1f6114cebda16c866eaf`). The renderer dynamic-tool
handler (`webview/assets/app-shared-*.js`) still matches the canonical handler
regex, but the bridge's app-server request bus is gone:

- Up to 26.928 the handler's chunk defined the bus
  `function qU(e,t){let n=e.get(JU);if(n==null)throw Error(\`AppServerManager RPC is not connected\`);return n.forHost(t)}`.
- 26.1002 removed that function. The string survives only in a
  performance-snapshot helper in `app-initial-*.js`, which is not a request
  bus.
- The handler's chunk now resolves the per-host app-server RPC through a
  resolver that prefers the AppServerManager RPC, falls back to the host's own
  client, and rejects with `AppServerManager RPC is unavailable for hostId`:

  ```js
  function jI(e,t){try{var n=AI();let r=e.get(DI,t),i=e.get(MI);
  if(i!=null&&r.status!==`disconnected`&&(r.status!==`unavailable`||!e.get(TI).includes(t)))
  try{return i.forHost(t)}catch{}let{client:a}=r;if(a!=null)return a.rpc;…
  s.reject(Error(`AppServerManager RPC is unavailable for hostId: ${t}`))…}
  ```

  Eleven native call sites chain `.sendRequest` on its result
  (`config/read`, `config/batchWrite`, `plugin/list`, `plugin/installed`,
  `plugin/read`, `thread/items/list`, …), so it is the bus's direct
  replacement.

A second drift sat right behind the first: the handler's native response call
now passes the thread, which the responder lookup did not allow:

```js
K_n({dispatchMessageFromView:(e,t)=>Hd.dispatchMessage(e,t),hostId:r,method:n.method,threadId:c,response:{id:XA(o),result:…}})
```

### Fix boundary

This is a renderer-only call path that the Gateway cannot intercept, so it
stays a static `app.asar` patch, rewritten to the single current shape:

- `scripts/patch-app-asar.mjs` — `findAppServerRequestBusName` anchors on the
  resolver's definition (`.get(x,host)` + `.get(manager)` →
  `try{return manager.forHost(host)}catch{}` → `client.rpc` → the
  `AppServerManager RPC is unavailable for hostId` rejection) and fails closed
  when it is missing; `findDynamicToolCallResponder` requires the
  `threadId:<thread>` member, and the injected response passes it the same
  way.
- `scripts/verify-offline-package.ps1` — same resolver anchor, so the verifier
  keeps checking that the bridge calls the real bus.
- No Gateway, desktop runtime or installer change.

## Root cause 2: the archived settings panel gained ChatGPT archive props

With the bridge fixed the build stopped at the next fail-closed anchor,
`Could not locate archived settings panel isError to keep local archived
chats visible offline` — the only remaining required miss (every other patch,
optional ones included, applied). The isError expression in
`webview/assets/data-controls-*.js` is unchanged from 26.928, but it is no
longer followed by `onLoadNextPage`:

```js
isError:W.length===0&&(l&&(v.some(sn)||g.includes(`durable`)&&(h===`disconnected`||h===`error`))||y==null&&T||E&&j==null&&R),
chatGptArchiveError:E&&R?te:null,onRetryChatGptArchive:q,onLoadNextPage:J
```

`scripts/patch-app-asar.mjs` now anchors the lookahead on the new
`,chatGptArchiveError:` neighbour. The replacement is unchanged
(`W.length===0&&l&&v.some(sn)` plus the marker): local archived chats stay
visible offline and a real local query error still shows the error state. The
new `chatGptArchiveError` prop is left alone; it carries the ChatGPT archive
error separately (with `onRetryChatGptArchive`) and no longer feeds isError. The verifier's
marker check already accepts the result.

## Root cause 3: the launcher test raced its own probe

`Codex.cmd` and `Launch Codex Direct.cmd` hand `ChatGPT.exe` to `start`, so
the probe (a copy of `node.exe` running from inside the temporary package
root) can still be exiting when `probe.txt` appears. The test removed the
package root immediately and Windows refused with `EPERM`. The test now
retries the removal (`maxRetries`/`retryDelay`) until the probe has released
the directory. Only the test changed; the launchers are correct.

## Reproduction

This session's container cannot reach `store.rg-adguard.net` or the Microsoft
delivery CDN, so the 26.1002 payload was inspected on a GitHub-hosted runner
through a temporary, read-only workflow (`permissions: contents: read`, no
publish steps) on the fix branch, which was removed afterwards. The same
workflow ran the full Windows build and package verifier on the fix.

## Verification

- New regression tests run the bridge patch against the 26.1002 resolver,
  handler and responder shapes; they fail on the previous patcher and fail
  closed when only the retired bus is present or the responder drops the
  thread. The verifier test accepts the new resolver and rejects the retired
  bus. The archived settings test uses the 26.1002 panel props and fails on
  the previous patcher.
- Linux container: `node --test scripts/test/*.test.cjs web-gateway/gateway/test/*.test.cjs`
  passes 228 of 244 with 14 Windows-only skips; the 2 failures are
  `repair-threads.test.cjs` cases that need `pwsh`, which the container lacks
  (they fail identically on `main`). `npm --prefix web-gateway run
  build:gateway` passes.
- Windows runner (temporary workflow, run `37739409282`):
  `node --test ./scripts/test/*.test.cjs` passes, launcher tests included;
  `build-offline-package.ps1` with the installer builds 26.1002.7124.0;
  `verify-offline-package.ps1 -RequireInstallerAsset` reports
  `Offline package verification passed.` (direct-launch smoke included).
  `codex-offline-26.1002.7124.0-setup.exe` SHA256
  `D8052CC47EB9E5F3083E55DF38DFB443FABCD76E3F982EEDA933AD37D27EF7ED`; the
  artifact was not uploaded or published, the release pipeline on `main`
  rebuilds it.

## Remaining risk

- The bridge now calls the resolver that native code uses, but no interactive
  Computer Use session (`@电脑` → `node_repl` `js` call) was run against the
  26.1002 package; the e2e smoke (`scripts/e2e-computer-use-tool-smoke.mjs`)
  needs a Windows desktop with a model backend.
- The new `chatGptArchiveError` prop is passed through as upstream ships it;
  how the panel renders it while offline and signed in to ChatGPT was not
  observed.
