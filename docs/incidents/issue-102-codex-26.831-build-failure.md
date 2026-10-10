# Issue 102: Codex 26.831 offline build failure

## Root cause

The Store resolver now selects `26.831.2377.0`. Its renderer moved archived
thread pagination into `webview/assets/data-controls-*.js`, where the loader is
an inline `async()=>` that calls `thread/list` with `archived:!0` and
`useStateDbOnly:!0`. The existing archived-thread matcher only recognized the
older shared helper layouts, so `patch-app-asar.mjs` stopped before repacking.

## Fix boundary

`scripts/patch-app-asar.mjs` adds one narrow matcher for the 26.831
`data-controls` loader. It catches offline transport failures, preserves
partial results, and falls back to `globalThis.__codexOfflineArchivedThreadsCache`.
Both existing patch markers are emitted so the package verifier keeps checking
the same contract. No Gateway or desktop runtime behavior was changed.

## Verification

- Added a regression fixture for the 26.831 loader shape.
- `node --check scripts/patch-app-asar.mjs` passed.
- `node --test scripts/test/*.test.cjs` passed (114 tests).
- The real 26.831.2377.0 ASAR reached the archived-thread patch and completed
  the patch drift summary with no required or optional misses. Local Node 25
  then failed inside `@electron/asar` during the final repack; CI uses Node 24
  and the source cache was quarantined after that local run.
