# Issue 101: Codex 26.825 offline build failure

## Root cause

The scheduled `build-offline-package` run `33135705772` failed while applying
the required ASAR patches to Store version `26.825.3734.0`. The failure was
caused by bundle-shape drift in two version-locked matchers:

- The Worktree starting-ref resolver gained an upstream `HEAD`/`@` fast path
  before local and remote branch resolution.
- The Browser/Computer Use defaults moved `features.js_repl` into a larger
  shared object and emitted the property with quotes.

The existing matcher recognized only the 26.820 resolver prefix and the
single-property, unquoted configuration object, so the required patch stage
stopped when neither 26.825 shape matched.

The build also trusted any existing `build/work/source-app` directory when its
executable and metadata file were present. That allowed a previous Store
version to become the input for a later scheduled build without re-resolving
the current Store target.

## Patch boundary

This is a packaging compatibility fix in `scripts/patch-app-asar.mjs`; it does
not change Gateway behavior or attempt to alter an official Codex runtime
feature. The patcher adds the project marker and explicit `HEAD` guard to the
known 26.825 resolver shape, and enables only the exact `features.js_repl`
property in the known shared defaults object. The neighboring
`features.js_repl_tools_only` property is preserved.

Both matchers remain narrow and required. Unrecognized bundle structures still
fail closed before the ASAR is repacked. The package verifier also rejects the
known 26.825 shared object if it still contains a disabled `features.js_repl`
value.

Compatibility is intentionally scoped to the current 26.825 Store payload;
the retired 26.820-and-earlier fallback matchers are not retained. Older or
unknown bundle shapes must be rebuilt only after a new, version-specific
matcher and regression evidence are added.

The source cache is now identity-checked before packaging. `rg_adguard` must
resolve the current package family, version, selected file name, and SHA1; the
cached metadata must contain the same values and `sourceMode=rg_adguard`.
Missing or mismatched metadata causes a fresh export. `installed_store` also
resolves the installed package version before deciding whether its cache can be
reused. This keeps old Store payloads out of a current release even when the
old bundle remains on disk.

## Verification

- Compatibility regression tests reject the retired 26.820 resolver shape and
  cover the 26.825 `HEAD`/`@` resolver, the quoted shared configuration,
  idempotence, and unknown-shape rejection.
- `scripts/patch-app-asar.mjs` successfully patched and repacked the real
  `26.825.3734.0` ASAR; both resolver copies received the marker and the
  renderer configuration received the feature marker.
- A second patch pass on the resulting ASAR completed with all required
  patches already correct.
- A build with a stale `26.814.5517.0` cache logged a cache mismatch and
  re-exported the current Store source before packaging.
- The full CI-shaped build completed with Inno Setup (`26.825.4187.0-setup.exe`)
  and the package verifier passed with `-RequireInstallerAsset`; the direct
  portable launch smoke test observed both app-server and window readiness.
