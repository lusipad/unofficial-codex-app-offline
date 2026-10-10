# Issue 107: Codex 26.901 renderer model-label drift

## Root cause

The scheduled `build-offline-package` run `33808003794` resolved Store
version `26.901.2854.0` and failed in `patch-app-asar.mjs` with:

```
Could not locate the renderer Custom model-label fallback to show the model ID.
```

The renderer still contains the stable
`composer.mode.local.model.custom` descriptor, but its surrounding function
changed from a direct formatter binding such as `let a=F(r)` to a React-cache
branch such as `n=jW(r,{stripGptPrefix:e})`. The existing matcher required the
old `let <var>=<formatter>(<var>);` shape and therefore rejected the otherwise
known bundle.

## Fix boundary

`patch-app-asar.mjs` now first finds the `displayName` binding in the matched
renderer function, then resolves a formatter call whose first argument is that
binding. This supports both the existing direct-binding shape and the
`26.901.2854.0` cache-aware shape while keeping the descriptor and fallback
matcher narrow. Unknown function layouts still fail closed.

## Verification

- Added a regression fixture for the exact `26.901.2854.0` renderer shape while
  retaining coverage for the previous shape.
- `node --test scripts/test/model-availability-patches.test.cjs` passed.
- Ran the full patcher against the real `26.901.2854.0` `app.asar`; the log
  confirmed:
  `Missing model display names now fall back to formatted model IDs in
  webview\assets\app-primary-cf3627f46e1e.js`.
- The isolated patcher run stopped later at the pre-existing bundled Chrome
  plugin requirement because the temporary app directory intentionally
  contained only `app.asar` and `ChatGPT.exe`; CI injects that plugin before
  this stage.

## Remaining risk

The matcher remains tied to the stable model descriptor and the formatter
relationship inside one function. A future renderer rewrite that removes or
renames either seam will fail the build instead of silently displaying
`Custom`.
