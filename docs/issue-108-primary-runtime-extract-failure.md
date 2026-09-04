# Issue 108: Primary runtime archive extraction failure

## Symptom

```
Failed to extract Codex primary runtime archive with tar exit code 1
```

The build reached `Resolve-OfflineRuntimePluginMarketplaceRoot`, downloaded
`codex-primary-runtime-win32-x64-<version>.tar.xz`, and failed while
extracting it. The archive itself is never the problem at that point: the
SHA256 is verified before extraction, so a truncated or substituted download
fails earlier with a hash mismatch.

## Root cause

The build shelled out to whatever `tar` `Get-Command` returned and reported
only `$LASTEXITCODE`. Both halves of that are wrong on a developer machine:

1. **The extractor was never checked for xz support.** Windows bundles bsdtar
   as `%SystemRoot%\System32\tar.exe`, and several Windows builds ship it
   linked against zlib only (`tar --version` lists no `liblzma`). Such a
   `tar.exe` cannot open a `.tar.xz` at all and exits 1 with
   `Unrecognized archive format`. The GitHub `windows-latest` runner ships a
   newer build that does include `liblzma`, which is why CI stayed green while
   local builds failed.
2. **`Get-Command tar` can resolve to an MSYS/Cygwin GNU tar** (Git for
   Windows, MSYS2) when it precedes `System32` on `PATH`. GNU tar reads the
   drive letter in `C:\...` as a remote host specification and also needs a
   separate `xz` binary for `.tar.xz`.
3. **tar's own diagnostics were discarded.** `& $tarCommand.Source -xf ...`
   left stderr to the console and the thrown error carried only the exit code,
   so the reported failure could not be told apart from the other Windows
   extraction failures that also exit 1: symlink creation without developer
   mode or elevation, antivirus locking files, a full disk, or a work root
   deep or non-ASCII enough to break path resolution.

## Fix boundary

All changes are in `scripts/build-offline-package.ps1`, inside the primary
runtime plugin step. Nothing about the Gateway, the desktop patches, the
installer, or the packaged output changes.

- `Resolve-ArchiveExtractionTool` inspects `%SystemRoot%\System32\tar.exe`
  before any `tar` on `PATH`, probes each candidate with `--version`, and
  accepts a bsdtar only when it reports `liblzma`, a GNU tar only when an `xz`
  binary is available (invoked with `--force-local` so the drive letter stays
  local).
- When no tar can read xz, the build falls back to 7-Zip (`7z`/`7zz`/`7za` on
  `PATH`, or the standard `7-Zip\7z.exe` install locations), decompressing
  `.tar.xz` to a staged `.tar` and then unpacking that. The staging directory
  is always removed.
- With no usable extractor at all the build fails closed and names every
  candidate it inspected.
- `Invoke-CapturedProcess` captures stdout and stderr, and
  `New-ArchiveExtractionErrorMessage` puts the last 20 output lines into the
  thrown error together with hints matched from that output (no xz support,
  symlink privilege, permission denied or file in use, out of disk) and from
  the extraction root itself (longer than 120 characters, or non-ASCII).

The post-extraction `marketplace.json` check is unchanged, so a partial
extraction still fails the build.

## Verification

- `node --test scripts/test/primary-runtime-archive-extraction.test.cjs` — 6
  tests, all failing against the previous implementation.
- `node --test scripts/test/*.test.cjs` — the two `repair-threads` PowerShell
  cases fail only because no `pwsh` is installed in the sandbox used for this
  change; they are unrelated to the extraction path.
- PowerShell AST parse of `scripts/build-offline-package.ps1` reports no
  syntax errors (the same check CI runs).
- Behavior was exercised on PowerShell 7.4 with stub extractors: a bsdtar
  without `liblzma` plus 7-Zip selects 7-Zip, extracts through the staged tar
  and removes the stage; a bsdtar with `liblzma` is used directly and its
  failure output reaches the thrown message with the matching hint; GNU tar
  gets `--force-local`; with no extractor present the fail-closed message
  lists what was inspected.

## Residual risk

The 7-Zip fallback is not exercised by CI, which always resolves a capable
`tar.exe`. Extraction root length and character-set problems are reported as
hints, not fixed automatically — a deep or non-ASCII checkout still needs
`-WorkRoot` pointed at a short ASCII path.
