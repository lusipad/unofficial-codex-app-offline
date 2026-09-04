"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");
const buildScriptSource = fs.readFileSync(
  path.join(repoRoot, "scripts", "build-offline-package.ps1"),
  "utf8",
);

function functionSource(name) {
  const start = buildScriptSource.indexOf(`function ${name} {`);
  assert.notEqual(start, -1, `function ${name} is missing`);
  const end = buildScriptSource.indexOf("\nfunction ", start + 1);
  assert.notEqual(end, -1, `function ${name} has no successor to bound it`);
  return buildScriptSource.slice(start, end);
}

test("primary runtime extraction prefers the Windows tar over an MSYS tar on PATH", () => {
  const resolver = functionSource("Resolve-ArchiveExtractionTool");

  assert.match(resolver, /\$env:SystemRoot 'System32\\tar\.exe'/);
  assert.ok(
    resolver.indexOf("System32\\tar.exe") <
      resolver.indexOf("Get-Command 'tar' -CommandType Application"),
    "the bundled Windows tar must be inspected before any tar found on PATH",
  );
});

test("primary runtime extraction only uses a tar that can read .tar.xz", () => {
  const capability = functionSource("Get-ArchiveToolCapability");

  // Windows ships bsdtar builds without liblzma, which cannot open the .tar.xz runtime archive.
  assert.match(capability, /bsdtar\|libarchive/);
  assert.match(capability, /supportsXz = \(\$versionText -match '\(\?i\)liblzma'\)/);
  // GNU tar delegates xz to a separate binary.
  assert.match(capability, /GNU tar/);
  assert.match(capability, /Get-Command 'xz' -CommandType Application/);

  const resolver = functionSource("Resolve-ArchiveExtractionTool");
  assert.match(resolver, /if \(\$capability\.supportsXz\) \{/);
});

test("primary runtime extraction falls back to 7-Zip when no tar can read xz", () => {
  const sevenZip = functionSource("Get-SevenZipCandidatePath");
  assert.match(sevenZip, /'7z', '7zz', '7za'/);
  assert.match(sevenZip, /'7-Zip\\7z\.exe'/);

  const resolver = functionSource("Resolve-ArchiveExtractionTool");
  assert.ok(
    resolver.indexOf("Get-SevenZipCandidatePath") >
      resolver.indexOf("if ($capability.supportsXz) {"),
    "7-Zip is only a fallback for tar builds without xz support",
  );
  assert.match(resolver, /kind = 'sevenzip'/);

  const expand = functionSource("Expand-CodexRuntimeArchive");
  // 7-Zip needs two passes: .tar.xz to a staged .tar, then the tar tree.
  assert.match(expand, /Get-ChildItem -LiteralPath \$stageRoot -Filter '\*\.tar' -File/);
  assert.match(expand, /Remove-Item -LiteralPath \$stageRoot -Recurse -Force -ErrorAction SilentlyContinue/);
});

test("primary runtime extraction keeps GNU tar from reading a drive letter as a remote host", () => {
  const expand = functionSource("Expand-CodexRuntimeArchive");
  assert.match(expand, /if \(\$tool\.forceLocal\) \{[\s\S]*?\$tarArguments \+= '--force-local'/);

  const resolver = functionSource("Resolve-ArchiveExtractionTool");
  assert.match(resolver, /forceLocal = \(\$capability\.flavor -eq 'gnutar'\)/);
});

test("primary runtime extraction failures report the extractor output and actionable hints", () => {
  const message = functionSource("New-ArchiveExtractionErrorMessage");
  assert.match(message, /Failed to extract Codex primary runtime archive with exit code \$ExitCode \(extractor: \$ToolPath\)/);
  assert.match(message, /Extractor output:/);
  assert.match(message, /Get-ArchiveExtractionHint -Output \$Output -ExtractRoot \$ExtractRoot/);

  const hints = functionSource("Get-ArchiveExtractionHint");
  assert.match(hints, /unrecognized archive format\|unsupported compression\|liblzma\|lzma/);
  assert.match(hints, /symlink\|symbolic link\|privilege/);
  assert.match(hints, /permission denied\|access is denied\|used by another process/);
  assert.match(hints, /no space left\|not enough space\|disk full/);
  assert.match(hints, /\$ExtractRoot\.Length -gt 120/);
  assert.match(hints, /\$ExtractRoot -cmatch '\[\^\\u0020-\\u007E\]'/);

  // The archive path itself ends in .tar.xz, so the xz hint must not match on the file name alone.
  assert.doesNotMatch(hints, /\(\?i\)[^']*\|xz\|/);

  const expand = functionSource("Expand-CodexRuntimeArchive");
  assert.match(expand, /No extractor able to read the Codex primary runtime archive/);
  assert.match(expand, /Inspected: \$inspectedText/);
});

test("primary runtime extraction captures both extractor streams instead of dropping them", () => {
  const captured = functionSource("Invoke-CapturedProcess");
  assert.match(captured, /-RedirectStandardOutput \$stdoutPath -RedirectStandardError \$stderrPath/);
  assert.match(captured, /exitCode = \[int\]\$process\.ExitCode/);

  // The old call site swallowed tar's diagnostics and only surfaced $LASTEXITCODE.
  assert.doesNotMatch(buildScriptSource, /tar exit code \$LASTEXITCODE/);
  assert.doesNotMatch(buildScriptSource, /& \$tarCommand\.Source -xf/);
  assert.match(
    buildScriptSource,
    /Expand-CodexRuntimeArchive -ArchivePath \$archivePath -ExtractRoot \$extractRoot/,
  );
});
