[CmdletBinding()]
param(
    [string]$ConfigPath = 'config/offline-package.json',
    [switch]$SkipInstaller,
    [switch]$RequireInstaller,
    [string]$MetadataOutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

trap {
    Write-Error ('Unhandled error: ' + $_.Exception.Message)
    if ($null -ne $_.InvocationInfo) {
        Write-Error $_.InvocationInfo.PositionMessage
    }
    if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
        Write-Error $_.ScriptStackTrace
    }
    throw
}

function Write-BuildTrace {
    param([string]$Message)

    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Host "[build-offline] $Message"
    }
}

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

function Get-RelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$PathValue
    )

    return [System.IO.Path]::GetRelativePath($BasePath, $PathValue).Replace('\\', '/').Replace('\', '/')
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return (Get-FileHash -Algorithm SHA256 -Path $PathValue).Hash.ToLowerInvariant()
}

function Find-Iscc {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue

    if ($null -ne $command) {
        return $command.Source
    }

    $candidates = @(
        'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
        'C:/Program Files/Inno Setup 6/ISCC.exe'
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

function Export-AppSource {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$ScriptRoot,
        [Parameter(Mandatory = $true)][string]$SourceExportRoot
    )

    $mode = [string]$Config.appSource.mode

    switch ($mode) {
        'installed_store' {
            & (Join-Path $ScriptRoot 'export-installed-store-app.ps1') -PackageId $Config.packageId -Destination $SourceExportRoot | Out-Null
            return [ordered]@{
                mode = $mode
                resolver = 'local-store-install'
            }
        }
        'rg_adguard' {
            $resolverJson = node (Join-Path $ScriptRoot 'resolve-store-bundle-url.mjs') --package-family-name $Config.appSource.packageFamilyName --ring $Config.appSource.ring
            if ($LASTEXITCODE -ne 0) {
                throw 'The rg-adguard resolver failed.'
            }

            $resolved = $resolverJson | ConvertFrom-Json
            & (Join-Path $ScriptRoot 'import-store-bundle-from-url.ps1') `
                -BundleUrl $resolved.selected.href `
                -DownloadedFileName $resolved.selected.fileName `
                -ExpectedSha1 $resolved.selected.sha1 `
                -Destination $SourceExportRoot `
                -PackageFamilyName $Config.appSource.packageFamilyName | Out-Null

            return [ordered]@{
                mode = $mode
                resolver = 'rg-adguard'
                packageFamilyName = $resolved.packageFamilyName
                selected = $resolved.selected
                version = $resolved.version
            }
        }
        default {
            throw "Unsupported app source mode: $mode"
        }
    }
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$configFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $ConfigPath
$config = Get-Content -Path $configFile -Raw | ConvertFrom-Json

$workRoot = Join-Path $repoRoot 'build/work'
$outputRoot = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $config.packaging.outputDir
$sourceExportRoot = Join-Path $workRoot 'source-app'
$stageRoot = Join-Path $workRoot 'stage'

Write-BuildTrace 'Prepared work directories.'
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

    Write-BuildTrace 'Syncing official skills.'
if ($null -ne $config.skills.official) {
    & (Join-Path $scriptRoot 'sync-official-skills.ps1') -ConfigPath $ConfigPath | Out-Null
    Write-BuildTrace 'Official skills synced.'
}

Write-BuildTrace 'Exporting app source.'
$appSourceInfo = Export-AppSource -Config $config -ScriptRoot $scriptRoot -SourceExportRoot $sourceExportRoot
$sourceMetadata = Get-Content -Path (Join-Path $sourceExportRoot 'metadata/package-metadata.json') -Raw | ConvertFrom-Json
$version = $sourceMetadata.version
$releaseBase = '{0}-{1}' -f $config.releaseNamePrefix, $version
$releaseTag = 'offline-v{0}' -f $version
$artifactRoot = Join-Path $outputRoot $releaseBase
$packageRoot = Join-Path $stageRoot $releaseBase

Write-BuildTrace 'Preparing package staging directories.'
if (Test-Path $artifactRoot) {
    Remove-Item -Path $artifactRoot -Recurse -Force
}

if (Test-Path $packageRoot) {
    Remove-Item -Path $packageRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

# Internal subdirectory — holds app payload and data files users don't need to
# touch.  Only the .cmd launchers and the env config example are at the root.
$internalRoot = Join-Path $packageRoot '_internal'
New-Item -ItemType Directory -Force -Path $internalRoot | Out-Null

Write-BuildTrace 'App payload copied to _internal.'
Copy-Item -Path (Join-Path $sourceExportRoot 'app') -Destination (Join-Path $internalRoot 'app') -Recurse -Force
Copy-Item -Path (Join-Path $scriptRoot 'bootstrap-codex-skills.ps1') -Destination (Join-Path $internalRoot 'bootstrap-codex-skills.ps1') -Force

# Patch app.asar so Codex runs correctly outside the MSIX container.
$patchScript = Join-Path $scriptRoot 'patch-app-asar.mjs'
$stagedAppDir = Join-Path $internalRoot 'app'
Write-BuildTrace 'Patching app.asar for standalone launch.'
node $patchScript --app-dir $stagedAppDir
if ($LASTEXITCODE -ne 0) {
    throw 'patch-app-asar.mjs failed.'
}
Write-BuildTrace 'app.asar patched successfully.'

# Config example: look in the official skills sync output first, then fall back
# to vendor/skills if it still exists (legacy).
$envExampleSrc = Join-Path $repoRoot 'build/work/skills-official/.system/skill-installer/skill-installer.env.example'
if (-not (Test-Path $envExampleSrc)) {
    $envExampleSrc = Join-Path $repoRoot 'vendor/skills/.system/skill-installer/skill-installer.env.example'
}
if (Test-Path $envExampleSrc) {
    Copy-Item -Path $envExampleSrc -Destination (Join-Path $internalRoot 'skill-installer.env.example') -Force
}

# Include README so users have documentation inside the package.
$readmeSrc = Join-Path $repoRoot 'README.md'
if (Test-Path $readmeSrc) {
    Copy-Item -Path $readmeSrc -Destination (Join-Path $packageRoot 'README.md') -Force
}

# Generate a small VBScript wrapper that launches PowerShell without showing a
# console window.  The .cmd files call this wrapper so the user never sees a
# flashing terminal.
$launcherVbs = @'
Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
psArgs = "-NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\_internal\bootstrap-codex-skills.ps1"""
shell.Run "powershell.exe " & psArgs, 0, False
'@
$launcherVbs | Set-Content -Path (Join-Path $packageRoot 'Launch Codex Offline.vbs') -Encoding ASCII

$syncVbs = @'
Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
psArgs = "-NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "\_internal\bootstrap-codex-skills.ps1"" -NoLaunch"
shell.Run "powershell.exe " & psArgs, 0, True
MsgBox "Skills synced successfully.", vbInformation, "Codex Offline"
'@
$syncVbs | Set-Content -Path (Join-Path $packageRoot 'Sync Codex Skills.vbs') -Encoding ASCII

# Keep .cmd launchers as fallback for users who prefer command-line access.
$launchCmd = @(
    '@echo off',
    'setlocal',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_internal\bootstrap-codex-skills.ps1"'
)
$launchCmd | Set-Content -Path (Join-Path $packageRoot 'Launch Codex Offline.cmd') -Encoding ASCII

$syncCmd = @(
    '@echo off',
    'setlocal',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_internal\bootstrap-codex-skills.ps1" -NoLaunch'
)
$syncCmd | Set-Content -Path (Join-Path $packageRoot 'Sync Codex Skills.cmd') -Encoding ASCII

Write-BuildTrace 'Resolving skill source roots.'
$skillSources = @()
foreach ($source in $config.skills.sources) {
    $skillSources += (Resolve-AbsolutePath -BasePath $repoRoot -PathValue $source)
}

Write-BuildTrace 'Bundling skills.'
& (Join-Path $scriptRoot 'bundle-skills.ps1') `
    -SourceRoots $skillSources `
    -Destination (Join-Path $internalRoot 'seed/codex-home/skills') `
    -ManifestPath (Join-Path $internalRoot 'seed/skills-manifest.json') `
    -PackageVersion $version | Out-Null
Write-BuildTrace 'Skills bundled.'

$buildInfo = [ordered]@{
    appName = $config.appName
    packageId = $config.packageId
    version = $version
    releaseTag = $releaseTag
    builtAt = (Get-Date).ToString('o')
    sourceMetadata = $sourceMetadata
    appSource = $appSourceInfo
}

Write-BuildTrace 'Build info written.'
$buildInfo | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $internalRoot 'build-info.json') -Encoding UTF8

$assets = [System.Collections.Generic.List[string]]::new()

Write-BuildTrace 'Creating archives.'
# Hide implementation details AFTER creating portable zip so Compress-Archive includes hidden items.
if ($config.packaging.portableZip) {
    $portableZip = Join-Path $artifactRoot ('{0}-portable.zip' -f $releaseBase)
    Compress-Archive -Path $packageRoot -DestinationPath $portableZip -Force
    $assets.Add($portableZip) | Out-Null
}

attrib +h (Join-Path $packageRoot '_internal')
attrib +h (Join-Path $packageRoot 'Launch Codex Offline.cmd')
attrib +h (Join-Path $packageRoot 'Sync Codex Skills.cmd')

if ($config.packaging.skillArchive) {
    $skillsZip = Join-Path $artifactRoot ('{0}-skills.zip' -f $releaseBase)
    Compress-Archive -Path (Join-Path $internalRoot 'seed/codex-home') -DestinationPath $skillsZip -Force
    $assets.Add($skillsZip) | Out-Null
}

if ($config.packaging.sourceExportArchive) {
    $sourceZip = Join-Path $artifactRoot ('{0}-store-export.zip' -f $releaseBase)
    Compress-Archive -Path $sourceExportRoot -DestinationPath $sourceZip -Force
    $assets.Add($sourceZip) | Out-Null
}

Write-BuildTrace 'Checking installer generation.'
if ($config.packaging.setupExe -and -not $SkipInstaller) {
    $iscc = Find-Iscc

    if ($null -eq $iscc) {
        if ($RequireInstaller) {
            throw 'Inno Setup was not found. Install Inno Setup 6 or run with -SkipInstaller.'
        }

        Write-Warning 'Inno Setup was not found. Skipping installer build.'
    }
    else {
        $templateFile = Join-Path $repoRoot 'installer/CodexOffline.iss.tpl'
        $issFile = Join-Path $workRoot 'CodexOffline.generated.iss'
        $template = Get-Content -Path $templateFile -Raw
        $rendered = $template
        $rendered = $rendered.Replace('__APP_NAME__', [string]$config.appName)
        $rendered = $rendered.Replace('__APP_VERSION__', [string]$version)
        $rendered = $rendered.Replace('__APP_DIR_NAME__', [string]$config.installDirName)
        $rendered = $rendered.Replace('__SOURCE_ROOT__', [string]$packageRoot.Replace('/', '\\'))
        $rendered = $rendered.Replace('__OUTPUT_ROOT__', [string]$artifactRoot.Replace('/', '\\'))
        $rendered = $rendered.Replace('__OUTPUT_BASENAME__', [string]('{0}-setup' -f $releaseBase))
        $rendered | Set-Content -Path $issFile -Encoding UTF8
        & $iscc $issFile | Out-Host

        $setupExe = Join-Path $artifactRoot ('{0}-setup.exe' -f $releaseBase)
        if (Test-Path $setupExe) {
            $assets.Add($setupExe) | Out-Null
        }
    }
}

Write-BuildTrace 'Writing checksums.'
$checksumFile = Join-Path $artifactRoot 'SHA256SUMS.txt'
($assets | Sort-Object | ForEach-Object {
    '{0} *{1}' -f (Get-FileSha256 -PathValue $_), (Split-Path $_ -Leaf)
}) | Set-Content -Path $checksumFile -Encoding ASCII
$assets.Add($checksumFile) | Out-Null

$assetInfo = @($assets | Sort-Object | ForEach-Object {
    [ordered]@{
        fileName = Split-Path $_ -Leaf
        fullPath = $_
        relativePath = Get-RelativePath -BasePath $repoRoot -PathValue $_
        sha256 = if ((Split-Path $_ -Leaf) -eq 'SHA256SUMS.txt') { $null } else { Get-FileSha256 -PathValue $_ }
    }
})

$buildMetadata = [ordered]@{
    appName = $config.appName
    packageId = $config.packageId
    version = $version
    releaseTag = $releaseTag
    releaseName = '{0} Offline {1}' -f $config.appName, $version
    artifactDirectory = $artifactRoot
    artifactDirectoryRelative = Get-RelativePath -BasePath $repoRoot -PathValue $artifactRoot
    generatedAt = (Get-Date).ToString('o')
    appSource = $appSourceInfo
    assets = $assetInfo
}

Write-BuildTrace 'Finalizing metadata.'
$buildMetadataJson = $buildMetadata | ConvertTo-Json -Depth 8
$buildMetadataJson | Set-Content -Path (Join-Path $outputRoot 'build-metadata.json') -Encoding UTF8
$buildMetadataJson | Set-Content -Path (Join-Path $artifactRoot 'build-metadata.json') -Encoding UTF8

if (-not [string]::IsNullOrWhiteSpace($MetadataOutputPath)) {
    $metadataOutputFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $MetadataOutputPath
    New-Item -ItemType Directory -Force -Path (Split-Path $metadataOutputFile -Parent) | Out-Null
    $buildMetadataJson | Set-Content -Path $metadataOutputFile -Encoding UTF8
}

$buildMetadataJson

