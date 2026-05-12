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
        'Codex.cmd',
        'Setup Codex.cmd',
        '_internal\bootstrap-codex-skills.ps1',
        '_internal\setup-codex-offline.ps1',
        '_internal\repair-chrome-host.ps1',
        '_internal\tools\Launch Codex Direct.cmd',
        '_internal\tools\Sync Default Skills.cmd',
        '_internal\tools\Sync All Skills.cmd',
        '_internal\tools\Repair Chrome Host.cmd',
        '_internal\app\Codex.exe',
        '_internal\app\resources\app.asar'
    )

    foreach ($relativePath in $requiredPortableFiles) {
        $fullPath = Join-Path $portableRoot $relativePath
        if (-not (Test-Path $fullPath)) {
            throw "Portable zip is missing required file: $relativePath"
        }
    }

    foreach ($relativePath in @(
        'Launch Codex Offline.vbs',
        'Launch Codex Offline.cmd',
        'Sync Codex Skills.vbs',
        'Sync Codex Skills.cmd',
        'Repair Chrome Host.vbs',
        'Repair Chrome Host.cmd',
        'Setup Codex.vbs',
        'Codex.exe',
        'Codex.lnk'
    )) {
        if (Test-Path (Join-Path $portableRoot $relativePath)) {
            throw "Portable zip still exposes legacy root launcher: $relativePath"
        }
    }

    $bootstrapPath = Join-Path $portableRoot '_internal\bootstrap-codex-skills.ps1'
    $bootstrapContent = Get-Content -Path $bootstrapPath -Raw
    if (-not $bootstrapContent.Contains('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
        throw 'Bootstrap script is missing the Windows Computer Use environment gate default.'
    }
    foreach ($needle in @('SkillProfile', 'AssumeYes', 'installProfile')) {
        if (-not $bootstrapContent.Contains($needle)) {
            throw "Bootstrap script is missing expected default-skill-profile marker: $needle"
        }
    }

    $setupPath = Join-Path $portableRoot '_internal\setup-codex-offline.ps1'
    $setupContent = Get-Content -Path $setupPath -Raw
    foreach ($needle in @(
        'Read-SetupYesNo',
        'Start setup now?',
        'Install the default offline skills profile now?',
        'Register or repair @chrome native host access now?',
        'Load Chrome extension',
        'chrome://extensions/',
        'Launch Codex now?',
        'AssumeYes',
        'NonInteractive',
        'repair-chrome-host.ps1',
        'bootstrap-codex-skills.ps1',
        'Codex.cmd',
        'After this first setup, open Codex.cmd directly.'
    )) {
        if (-not $setupContent.Contains($needle)) {
            throw "Setup script is missing expected all-in-one marker: $needle"
        }
    }

    $dailyLauncherPath = Join-Path $portableRoot 'Codex.cmd'
    $dailyLauncherContent = Get-Content -Path $dailyLauncherPath -Raw
    foreach ($needle in @('%~dp0_internal\app\Codex.exe', 'CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
        if (-not $dailyLauncherContent.Contains($needle)) {
            throw "Daily launcher is missing expected relative-launch marker: $needle"
        }
    }

    $repairChromeHostPath = Join-Path $portableRoot '_internal\repair-chrome-host.ps1'
    $repairChromeHostContent = Get-Content -Path $repairChromeHostPath -Raw
    foreach ($needle in @('NativeMessagingHosts', 'com.openai.codexextension', 'extension-id.json', 'extension-host.exe')) {
        if (-not $repairChromeHostContent.Contains($needle)) {
            throw "Chrome native host repair script is missing expected marker: $needle"
        }
    }

    $chromePluginRoot = Join-Path $portableRoot '_internal\app\resources\plugins\openai-bundled\plugins\chrome'
    if (-not (Test-Path $chromePluginRoot -PathType Container)) {
        throw 'Bundled Chrome plugin was not found in the portable package.'
    }
    if (-not (Test-Path (Join-Path $chromePluginRoot 'scripts\extension-id.json') -PathType Leaf)) {
        throw 'Bundled Chrome plugin is missing scripts\extension-id.json.'
    }
    $chromeBrowserClientPath = Join-Path $chromePluginRoot 'scripts\browser-client.mjs'
    if (-not (Test-Path $chromeBrowserClientPath -PathType Leaf)) {
        throw 'Bundled Chrome plugin is missing scripts\browser-client.mjs.'
    }
    $chromeBrowserClientContent = Get-Content -Path $chromeBrowserClientPath -Raw
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-discovery-timeout*/')) {
        throw 'Bundled Chrome browser client is missing the discovery timeout patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-profile-metadata-timeout*/')) {
        throw 'Bundled Chrome browser client is missing the profile metadata timeout patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-native-pipe-fallback*/')) {
        throw 'Bundled Chrome browser client is missing the Windows native pipe fallback patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-native-pipe-direct*/')) {
        throw 'Bundled Chrome browser client is missing the Windows native pipe direct path patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-discovery-diagnostics*/')) {
        throw 'Bundled Chrome browser client is missing the discovery diagnostics patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-chrome-pipe-filter*/')) {
        throw 'Bundled Chrome browser client is missing the Windows Chrome pipe filter patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-direct-setup*/')) {
        throw 'Bundled Chrome browser client is missing the direct Windows pipe setup patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-request-timeout*/')) {
        throw 'Bundled Chrome browser client is missing the JSON-RPC request timeout patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-disable-ambient-network-default*/')) {
        throw 'Bundled Chrome browser client is missing the offline ambient network default patch.'
    }
    $chromeNativeHostCheckPath = Join-Path $chromePluginRoot 'scripts\check-native-host-manifest.js'
    if (-not (Test-Path $chromeNativeHostCheckPath -PathType Leaf)) {
        throw 'Bundled Chrome plugin is missing scripts\check-native-host-manifest.js.'
    }
    $chromeNativeHostCheckContent = Get-Content -Path $chromeNativeHostCheckPath -Raw
    if (-not $chromeNativeHostCheckContent.Contains('/*codex-offline:localized-registry-default*/')) {
        throw 'Bundled Chrome native host check is missing the localized registry parser patch.'
    }
    $chromeSkillPath = Join-Path $chromePluginRoot 'skills\chrome\SKILL.md'
    if (-not (Test-Path $chromeSkillPath -PathType Leaf)) {
        throw 'Bundled Chrome plugin is missing skills\chrome\SKILL.md.'
    }
    $chromeSkillContent = Get-Content -Path $chromeSkillPath -Raw
    if (-not $chromeSkillContent.Contains('<!-- codex-offline:trusted-marketplace-browser-client -->')) {
        throw 'Bundled Chrome skill is missing the trusted marketplace browser-client guidance.'
    }
    if (-not (Get-ChildItem -Path (Join-Path $chromePluginRoot 'extension-host\windows') -Filter 'extension-host.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        throw 'Bundled Chrome plugin is missing a Windows extension-host.exe binary.'
    }
    $chromeExtensionConfig = Get-Content -Path (Join-Path $chromePluginRoot 'scripts\extension-id.json') -Raw | ConvertFrom-Json
    $chromeExtensionId = [string]$chromeExtensionConfig.extensionId
    if ([string]::IsNullOrWhiteSpace($chromeExtensionId)) {
        throw 'Bundled Chrome plugin extension-id.json is missing extensionId.'
    }

    $chromeExtensionRoot = Join-Path $portableRoot '_internal\chrome-extension'
    $chromeExtensionInfoPath = Join-Path $chromeExtensionRoot 'extension-info.json'
    $chromeExtensionCrxPath = Join-Path $chromeExtensionRoot 'codex.crx'
    $chromeExtensionManifestPath = Join-Path $chromeExtensionRoot 'unpacked\manifest.json'
    foreach ($relativePath in @(
        '_internal\chrome-extension\extension-info.json',
        '_internal\chrome-extension\codex.crx',
        '_internal\chrome-extension\unpacked\manifest.json'
    )) {
        if (-not (Test-Path (Join-Path $portableRoot $relativePath) -PathType Leaf)) {
            throw "Portable zip is missing bundled Chrome extension asset: $relativePath"
        }
    }

    $chromeExtensionInfo = Get-Content -Path $chromeExtensionInfoPath -Raw | ConvertFrom-Json
    if ([string]$chromeExtensionInfo.extensionId -ne $chromeExtensionId) {
        throw "Bundled Chrome extension id '$($chromeExtensionInfo.extensionId)' does not match plugin extension id '$chromeExtensionId'."
    }
    $chromeExtensionCrxHeader = [System.IO.File]::ReadAllBytes($chromeExtensionCrxPath)
    if ($chromeExtensionCrxHeader.Length -lt 4 -or [System.Text.Encoding]::ASCII.GetString($chromeExtensionCrxHeader, 0, 4) -ne 'Cr24') {
        throw 'Bundled Chrome extension CRX is missing the Cr24 header.'
    }
    $chromeExtensionManifest = Get-Content -Path $chromeExtensionManifestPath -Raw | ConvertFrom-Json
    if ([string]$chromeExtensionManifest.name -ne [string]$chromeExtensionInfo.name) {
        throw 'Bundled Chrome extension unpacked manifest does not match extension-info.json.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$chromeExtensionManifest.key)) {
        throw 'Bundled Chrome extension unpacked manifest is missing a fixed key.'
    }

    $seedSkillsRoot = Join-Path $portableRoot '_internal\seed\codex-home\skills'
    $seedManifestPath = Join-Path $portableRoot '_internal\seed\skills-manifest.json'
    if (-not (Test-Path (Join-Path $seedSkillsRoot '.system') -PathType Container)) {
        throw 'Bundled skills seed is missing the .system skill group.'
    }
    if (-not (Test-Path (Join-Path $seedSkillsRoot '.curated') -PathType Container)) {
        throw 'Bundled skills seed is missing the .curated skill group.'
    }
    if (-not (Test-Path $seedManifestPath)) {
        throw 'Bundled skills manifest was not found in the portable package.'
    }

    $seedManifest = Get-Content -Path $seedManifestPath -Raw | ConvertFrom-Json
    $manifestSkillPaths = @($seedManifest.skills | ForEach-Object { [string]$_.relativePath })
    if (-not ($manifestSkillPaths | Where-Object { $_.StartsWith('.system/') })) {
        throw 'Bundled skills manifest does not include .system skill entries.'
    }
    if (-not ($manifestSkillPaths | Where-Object { $_.StartsWith('.curated/') })) {
        throw 'Bundled skills manifest does not include .curated skill entries.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$seedManifest.defaultInstallProfile)) {
        throw 'Bundled skills manifest is missing defaultInstallProfile.'
    }
    if ($null -eq $seedManifest.profileHashes) {
        throw 'Bundled skills manifest is missing profileHashes.'
    }
    $defaultSkillPaths = @($seedManifest.skills | Where-Object { $_.installByDefault } | ForEach-Object { [string]$_.relativePath })
    if ($defaultSkillPaths.Count -eq 0) {
        throw 'Bundled skills manifest does not mark any default offline skills.'
    }
    if ($defaultSkillPaths.Count -ge $manifestSkillPaths.Count) {
        throw 'Default skill profile unexpectedly installs every bundled skill.'
    }
    if ($defaultSkillPaths | Where-Object { $_.StartsWith('.curated/') }) {
        throw 'Default offline skill profile should not auto-install curated skills.'
    }
    foreach ($expectedDefaultSkill in @($config.skills.defaultInstallPaths | ForEach-Object { [string]$_ })) {
        if ($defaultSkillPaths -notcontains $expectedDefaultSkill) {
            throw "Configured default skill was not marked installByDefault: $expectedDefaultSkill"
        }
    }
    $skillSources = @($config.skills.sources)
    $officialOnlySkillsPackage = (
        $null -ne $config.skills.official -and
        $skillSources.Count -eq 1 -and
        [string]$skillSources[0] -eq [string]$config.skills.official.destination
    )
    if ($officialOnlySkillsPackage -and ($manifestSkillPaths | Where-Object { $_ -notlike '.*/*' })) {
        throw 'Bundled skills manifest still contains flattened top-level official skill entries.'
    }

    $asarPath = Join-Path $portableRoot '_internal\app\resources\app.asar'
    $verifyAsarScript = @'
const asar = require('@electron/asar');
const path = require('path');

const asarPath = process.argv[1];
const PATCH_MARKER = '/* codex-offline:windowsStore-patch */';
const SLASH_GATE_NEEDLE = '$f(`1609556872`)';
const SLASH_UI_MARKERS = [
  'composer.slashCommands.dialogTitle',
  'composer.personalitySlashCommand.title',
  'composer.planSlashCommand.title',
];
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
  '410065390',
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
if (!mainContent.includes('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
  throw new Error('Computer Use environment default is missing from the main entry.');
}

const javaScriptEntries = entries.filter(entry => entry.endsWith('.js'));
const residualGateMatches = [];
const allJavaScriptContent = [];
let fastModeSelectorPatched = false;
let bundledBrowserPluginsPatched = false;
let browserUseDescriptorPatched = false;
let windowsBrowserUseCapabilityPatched = false;
const bundledBrowserPluginForceReloadResiduals = [];

for (const entry of javaScriptEntries) {
  const content = asar.extractFile(asarPath, entryMap.get(entry)).toString('utf8');
  allJavaScriptContent.push(content);
  fastModeSelectorPatched ||= content.includes('/*codex-offline:fast-mode-selector*/');
  bundledBrowserPluginsPatched ||= content.includes('/*codex-offline:bundled-browser-plugins-no-force-reload*/');
  windowsBrowserUseCapabilityPatched ||= content.includes('/*codex-offline:windows-browser-use-capability*/');
  browserUseDescriptorPatched ||=
    /\{autoInstallOptOutKey:[A-Za-z_$][\w$]*\.Nn\([A-Za-z_$][\w$]*\.Dn\),installWhenMissing:!0,name:[A-Za-z_$][\w$]*\.Dn,isAvailable:\(\{features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0,migrate:[A-Za-z_$][\w$]*\}/.test(content);
  if (
    /forceReload:!0,installWhenMissing:!0,name:[A-Za-z_$][\w$]*\.Dn,isAvailable:\(\{features:[A-Za-z_$][\w$]*\}\)=>[A-Za-z_$][\w$]*\.inAppBrowserUseAllowed/.test(content) ||
    /forceReload:!0,(?:installWhenMissing:!0,)?name:lt,isAvailable:\(\{buildFlavor:[A-Za-z_$][\w$]*,features:[A-Za-z_$][\w$]*\}\)=>[A-Za-z_$][\w$]*\.externalBrowserUseAllowed&&/.test(content) ||
    /forceReload:!0,name:[A-Za-z_$][\w$]*\.On,isAvailable:\(\{buildFlavor:[A-Za-z_$][\w$]*,features:[A-Za-z_$][\w$]*\}\)=>/.test(content)
  ) {
    bundledBrowserPluginForceReloadResiduals.push(entry);
  }
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
if (webviewContent.includes(SLASH_GATE_NEEDLE)) {
  throw new Error('Slash command gate needle is still present in the webview bundle.');
}

const missingSlashUiMarkers = SLASH_UI_MARKERS.filter(marker => !allJavaScriptContent.some(content => content.includes(marker)));
if (missingSlashUiMarkers.length > 0) {
  throw new Error(`Slash command UI markers are missing from app.asar JavaScript bundles: ${missingSlashUiMarkers.join(', ')}`);
}

const hasFastModeAvailabilityHelper = allJavaScriptContent.some(content =>
  content.includes('additionalSpeedTiers') &&
  content.includes('canUseFastMode')
);
if (hasFastModeAvailabilityHelper && !fastModeSelectorPatched) {
  throw new Error('Fast mode selector availability helper is present but was not patched.');
}

const hasDesktopFeatureAvailability = allJavaScriptContent.some(content =>
  content.includes('computerUseNodeRepl') &&
  content.includes('externalBrowserUse') &&
  content.includes('inAppBrowserUse')
);
if (hasDesktopFeatureAvailability && !windowsBrowserUseCapabilityPatched) {
  throw new Error('Windows Browser Use capability override is present but was not patched.');
}

if (!bundledBrowserPluginsPatched) {
  throw new Error('Bundled browser plugin descriptor patch marker is missing.');
}
if (!browserUseDescriptorPatched) {
  throw new Error('Bundled browser-use descriptor was not patched for offline marketplace materialization.');
}
if (bundledBrowserPluginForceReloadResiduals.length > 0) {
  throw new Error(
    'Bundled browser plugin descriptors still force reload and may hit Windows file locks: ' +
    bundledBrowserPluginForceReloadResiduals.join(', ')
  );
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
