# Issue 105: Codex 26.901 asar integrity build failure

## Root cause

The Store resolver selected `26.901.1978.0`. This build embeds an
`ELECTRONASAR` PE resource in `ChatGPT.exe` containing
`[{"file":"resources\\app.asar","alg":"SHA256","value":"<hex>"}]`, where the
value is the SHA256 of the asar **header string** (not the whole archive).
Windows enforces this check at startup even though the binary does not expose
the Electron fuse config sentinel, so the existing `@electron/fuses` flip in
`patch-app-asar.mjs` logged "no fuse flip needed" and the repacked
`app.asar` crashed the direct-launch smoke with:

```
FATAL:third_party\electron\shell\common\asar\asar_util.cc:143]
Integrity check failed for asar archive (<embedded> vs <actual>)
```

`26.831` behaved identically in the fuse step but carried no `ELECTRONASAR`
resource, so skipping the flip was harmless until now.

## Fix boundary

`scripts/asar-integrity-resource.cjs` (new, shared by the patcher and its
test) rewrites the embedded value in place — the hash is a fixed-length
64-hex ASCII string, so the exe size never changes. The hash is computed from
`asar.getRawHeader(...).headerString`, matching what Electron hashes at
runtime (verified against the untouched 26.901 binaries: the method
reproduces the originally embedded value).

`scripts/patch-app-asar.mjs` calls it after repacking. Fail-closed rules:

- No `ELECTRONASAR` marker → logged skip (older Store builds).
- Marker present but the payload no longer matches the known JSON shape, or
  the app.asar entry appears more than once → the build throws instead of
  shipping a package that crashes at launch.

`@electron/asar@3.2.18` repacking does not emit per-file integrity entries,
so only the archive-level header hash needs updating.

## Verification

- Added `scripts/test/asar-integrity-resource.test.cjs` (7 tests: in-place
  rewrite keeps the payload parseable JSON, absent-marker skip, fail-closed
  on shape drift / duplicate entries / malformed hash, persistence, and the
  header-string hashing semantics).
- Reproduced the CI failure locally with the real 26.901.1978.0 Store
  binaries: patched asar + untouched exe → same FATAL at `asar_util.cc:143`.
- After the fix, `patch-app-asar.mjs` updated the resource
  (`5d404e81…` → `8132889d…`, matching the hash the runtime had computed for
  the patched archive) and `offline-direct-launch-smoke.mjs` passed:
  app-server ready, window ready, process survived the 30s offline launch.
- `node --test scripts/test/*.test.cjs web-gateway/gateway/test/*.test.cjs` passed (141 tests).
- Full release matrix on the real 26.901.1978.0 Store bundle:
  `npm --prefix web-gateway run build:gateway` →
  `build-offline-package.ps1 -RequireInstaller` →
  `verify-offline-package.ps1` all passed; the verifier's direct-launch smoke
  reported app-server ready, window ready, and the process surviving the 30s
  offline launch. Package:
  `dist/offline/codex-offline-26.901.1978.0/codex-offline-26.901.1978.0-setup.exe`,
  SHA256 `5F9236C6979F52BC5FFB4E4D76CFE7DD0D772F3F5588FB181B8CA9D25394A92C`.

Local environment notes (not repo bugs): the build host must resolve `tar` to
`C:\Windows\System32\tar.exe` (bsdtar) before Git Bash's GNU tar, and the
verifier's `codex debug models` JSON parse needs UTF-8 console output
encoding.

## Remaining risk

The offline package verifier's direct-launch smoke already covers this check
end-to-end on every build, so future Store builds that change the embedded
integrity layout will fail either in the patcher (shape drift) or in the
verifier (runtime rejection).
