[CmdletBinding()]
param(
    [string]$BuildMetadataPath = 'build-metadata.json',
    [string]$ConfigPath = 'config/offline-package.json',
    [switch]$RequireInstallerAsset
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$PathValue
    )

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $PathValue))
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$buildMetadataFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $BuildMetadataPath
$configFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $ConfigPath

if (-not (Test-Path $buildMetadataFile)) {
    throw "Build metadata was not found: $buildMetadataFile"
}

if (-not (Test-Path $configFile)) {
    throw "Config file was not found: $configFile"
}

$metadata = Get-Content -Path $buildMetadataFile -Raw | ConvertFrom-Json
$config = Get-Content -Path $configFile -Raw | ConvertFrom-Json
$artifactRoot = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $metadata.artifactDirectory

if (-not (Test-Path $artifactRoot)) {
    throw "Artifact directory was not found: $artifactRoot"
}

$metadataAssets = @($metadata.assets)
$portableAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-portable.zip' })
$skillsAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-skills.zip' })
$installerAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-setup.exe' })
$storeExportAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-store-export.zip' })
$checksumAssets = @($metadataAssets | Where-Object { $_.fileName -eq 'SHA256SUMS.txt' })

if ($config.packaging.portableZip -and $portableAssets.Count -ne 1) {
    throw "Expected exactly one portable zip asset, found $($portableAssets.Count)."
}

if ($config.packaging.skillArchive -and $skillsAssets.Count -ne 1) {
    throw "Expected exactly one skills zip asset, found $($skillsAssets.Count)."
}

if ($checksumAssets.Count -ne 1) {
    throw "Expected exactly one SHA256SUMS.txt asset, found $($checksumAssets.Count)."
}

if (-not $config.packaging.sourceExportArchive -and $storeExportAssets.Count -gt 0) {
    throw 'Store export zip is disabled, but a *-store-export.zip asset was still produced.'
}

$storeExportFiles = @(Get-ChildItem -Path $artifactRoot -Filter '*-store-export.zip' -File -ErrorAction SilentlyContinue)
if (-not $config.packaging.sourceExportArchive -and $storeExportFiles.Count -gt 0) {
    throw 'Store export zip is disabled, but a *-store-export.zip file still exists in the artifact directory.'
}

if ($RequireInstallerAsset -and $config.packaging.setupExe -and $installerAssets.Count -ne 1) {
    throw "Installer verification required, but expected exactly one setup exe asset and found $($installerAssets.Count)."
}

foreach ($asset in $metadataAssets) {
    $assetPath = Join-Path $artifactRoot $asset.fileName
    if (-not (Test-Path $assetPath)) {
        throw "Metadata listed an asset that does not exist on disk: $assetPath"
    }
}

$portableZipPath = Join-Path $artifactRoot $portableAssets[0].fileName
if (-not (Test-Path $portableZipPath)) {
    throw "Portable zip was not found: $portableZipPath"
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-offline-verify-' + [System.Guid]::NewGuid().ToString('N'))

try {
    Expand-Archive -Path $portableZipPath -DestinationPath $tempRoot -Force

    $portableRoot = $tempRoot
    $topLevelEntries = @(Get-ChildItem -Path $tempRoot -Force)
    if ($topLevelEntries.Count -eq 1 -and $topLevelEntries[0].PSIsContainer) {
        $portableRoot = $topLevelEntries[0].FullName
    }

    $requiredPortableFiles = @(
        'Launch Codex Offline.vbs',
        '_internal\bootstrap-codex-skills.ps1',
        '_internal\app\Codex.exe',
        '_internal\app\resources\app.asar'
    )

    foreach ($relativePath in $requiredPortableFiles) {
        $fullPath = Join-Path $portableRoot $relativePath
        if (-not (Test-Path $fullPath)) {
            throw "Portable zip is missing required file: $relativePath"
        }
    }

    $asarPath = Join-Path $portableRoot '_internal\app\resources\app.asar'
    $verifyAsarScript = @'
const asar = require('@electron/asar');
const path = require('path');

const asarPath = process.argv[1];
const PATCH_MARKER = '/* codex-offline:windowsStore-patch */';
const SLASH_GATE_NEEDLE = '$f(`1609556872`)';
const SLASH_ALREADY_PATCHED_MARKER = 'a=i.pathname===`/hotkey-window`,o=!0,s=wo()';
const KNOWN_RAW_GATE_IDS = [
  '4166894088',
  '3075919032',
  '3789238711',
  '2302560359',
  '2679188970',
  '1488233300',
  '2425897452',
  '3903742690',
  '2553306736',
  '505458',
  '1907601843',
  '410262010',
  '4250630194',
  '588076040',
  '1609556872',
];
const MEMORIES_GATE_RESIDUAL_PATTERN = '[$s]:Ue(e,ec)&&We(e,Qs).groupName===`Test`';

function normalize(entry) {
  return entry.replace(/\\/g, '/').replace(/^\.?\//, '');
}

const rawEntries = asar.listPackage(asarPath);
const entryMap = new Map(
  rawEntries.map(entry => [normalize(entry), entry.replace(/^[\\/]+/, '')])
);
const entries = Array.from(entryMap.keys());

if (!entryMap.has('package.json')) {
  throw new Error('package.json was not found inside app.asar.');
}

const pkg = JSON.parse(asar.extractFile(asarPath, entryMap.get('package.json')).toString('utf8'));
const main = normalize(pkg.main || 'index.js');
const mainCandidates = [main];

if (main.endsWith('.js')) {
  mainCandidates.push(main.replace(/\.js$/, '/index.js'));
}

const mainEntry = mainCandidates.find(candidate => entries.includes(candidate));
if (!mainEntry) {
  throw new Error(`Could not resolve the main entry inside app.asar: ${mainCandidates.join(', ')}`);
}

const mainContent = asar.extractFile(asarPath, entryMap.get(mainEntry)).toString('utf8');
if (!mainContent.includes(PATCH_MARKER)) {
  throw new Error('windowsStore patch marker is missing from the main entry.');
}

const javaScriptEntries = entries.filter(entry => entry.endsWith('.js'));
const residualGateMatches = [];

for (const entry of javaScriptEntries) {
  const content = asar.extractFile(asarPath, entryMap.get(entry)).toString('utf8');
  const matchedGateIds = KNOWN_RAW_GATE_IDS.filter(gateId => content.includes('`' + gateId + '`'));
  if (matchedGateIds.length > 0) {
    residualGateMatches.push(`${entry}: ${matchedGateIds.join(', ')}`);
  }
  if (content.includes(MEMORIES_GATE_RESIDUAL_PATTERN)) {
    residualGateMatches.push(`${entry}: memories gate expression`);
  }
}

if (residualGateMatches.length > 0) {
  throw new Error(
    'Known gate ids are still present after patching: ' +
    residualGateMatches.join(' | ')
  );
}

const webviewEntry = entries.find(entry => /(^|\/)webview\/assets\/index-[^/]+\.js$/.test(entry));
if (!webviewEntry) {
  throw new Error('Could not locate the webview index bundle inside app.asar.');
}

const webviewContent = asar.extractFile(asarPath, entryMap.get(webviewEntry)).toString('utf8');
if (!webviewContent.includes(SLASH_ALREADY_PATCHED_MARKER)) {
  throw new Error('Slash command patched marker is missing from the webview bundle.');
}

if (webviewContent.includes(SLASH_GATE_NEEDLE)) {
  throw new Error('Slash command gate needle is still present in the webview bundle.');
}

console.log(`[verify-offline-package] Verified app.asar patches in ${path.basename(asarPath)}`);
'@

    node -e $verifyAsarScript -- $asarPath
    if ($LASTEXITCODE -ne 0) {
        throw "asar verification failed with exit code $LASTEXITCODE."
    }
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '[verify-offline-package] Offline package verification passed.'
