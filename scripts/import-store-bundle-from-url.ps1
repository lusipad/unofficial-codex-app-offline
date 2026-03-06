[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BundleUrl,
    [string]$Destination = 'build/source-app',
    [string]$PackageFamilyName = 'OpenAI.Codex_2p2nqsd0c76g0',
    [string]$DownloadedFileName = '',
    [string]$ExpectedSha1 = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }

    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $PathValue))
}

function Expand-ZipLikeArchive {
    param(
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$DestinationPath
    )

    if (Test-Path $DestinationPath) {
        Remove-Item -Path $DestinationPath -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null

    $zipPath = Join-Path ([System.IO.Path]::GetDirectoryName($ArchivePath)) ([System.IO.Path]::GetFileNameWithoutExtension($ArchivePath) + '.zip')
    Copy-Item -Path $ArchivePath -Destination $zipPath -Force

    try {
        Expand-Archive -LiteralPath $zipPath -DestinationPath $DestinationPath -Force
    }
    finally {
        Remove-Item -Path $zipPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-PackageScore {
    param([Parameter(Mandatory = $true)][string]$FileName)

    $score = 0

    if ($FileName -match '(_x64_|x64)') {
        $score += 400
    }

    if ($FileName -match '\.(msixbundle|appxbundle)$') {
        $score += 250
    }

    if ($FileName -match '\.(msix|appx)$') {
        $score += 200
    }

    if ($FileName -match '(resources|resource|language|scale|test|debug|symbol)') {
        $score -= 500
    }

    if ($FileName -match '(arm64|_x86_|_arm_)') {
        $score -= 300
    }

    return $score
}

$destinationRoot = Resolve-AbsolutePath -PathValue $Destination
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-offline-' + [guid]::NewGuid().ToString('N'))
$downloadRoot = Join-Path $tempRoot 'download'
$outerExpandRoot = Join-Path $tempRoot 'outer'
$innerExpandRoot = Join-Path $tempRoot 'inner'

New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null

try {
    if (Test-Path $destinationRoot) {
        Remove-Item -Path $destinationRoot -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null

    if ([string]::IsNullOrWhiteSpace($DownloadedFileName)) {
        $downloadName = [System.IO.Path]::GetFileName(([System.Uri]$BundleUrl).AbsolutePath)
        if ([string]::IsNullOrWhiteSpace($downloadName)) {
            $downloadName = 'codex-package.msix'
        }
    }
    else {
        $downloadName = $DownloadedFileName
    }

    $downloadPath = Join-Path $downloadRoot $downloadName
    Invoke-WebRequest -Uri $BundleUrl -OutFile $downloadPath

    if (-not [string]::IsNullOrWhiteSpace($ExpectedSha1)) {
        $actualSha1 = (Get-FileHash -Path $downloadPath -Algorithm SHA1).Hash.ToLowerInvariant()
        if ($actualSha1 -ne $ExpectedSha1.ToLowerInvariant()) {
            throw "Downloaded package SHA1 mismatch. Expected $ExpectedSha1 but got $actualSha1"
        }
    }

    $downloadExtension = [System.IO.Path]::GetExtension($downloadPath).ToLowerInvariant()
    $packageArchivePath = $downloadPath

    if ($downloadExtension -in @('.msixbundle', '.appxbundle')) {
        Expand-ZipLikeArchive -ArchivePath $downloadPath -DestinationPath $outerExpandRoot

        $candidatePackage = Get-ChildItem -Path $outerExpandRoot -Recurse -File | Where-Object {
            $_.Extension -in @('.msix', '.appx') -and $_.Name -match '^OpenAI\.Codex_'
        } | Sort-Object @{ Expression = { Get-PackageScore -FileName $_.Name }; Descending = $true }, Name | Select-Object -First 1

        if ($null -eq $candidatePackage) {
            throw 'No main package was found inside the downloaded bundle.'
        }

        $packageArchivePath = $candidatePackage.FullName
    }

    Expand-ZipLikeArchive -ArchivePath $packageArchivePath -DestinationPath $innerExpandRoot

    $manifestPath = Join-Path $innerExpandRoot 'AppxManifest.xml'
    $appSourcePath = Join-Path $innerExpandRoot 'app'
    $metadataPath = Join-Path $destinationRoot 'metadata'

    if (-not (Test-Path $manifestPath)) {
        throw "AppxManifest.xml was not found in the extracted package: $innerExpandRoot"
    }

    if (-not (Test-Path $appSourcePath)) {
        throw "Expected app payload directory was not found: $appSourcePath"
    }

    New-Item -ItemType Directory -Force -Path $metadataPath | Out-Null
    Copy-Item -Path $appSourcePath -Destination (Join-Path $destinationRoot 'app') -Recurse -Force
    Copy-Item -Path $manifestPath -Destination (Join-Path $metadataPath 'AppxManifest.xml') -Force

    [xml]$manifest = Get-Content -Path $manifestPath -Raw
    $identity = $manifest.Package.Identity

    $metadata = [ordered]@{
        appName = $identity.Name
        packageFamilyName = $PackageFamilyName
        version = $identity.Version
        publisher = $identity.Publisher
        exportedAt = (Get-Date).ToString('o')
        exportedAppPath = 'app'
        manifestPath = 'metadata/AppxManifest.xml'
        sourceMode = 'rg_adguard'
        sourceBundleUrl = $BundleUrl
        sourceFileName = $downloadName
        sourceSha1 = if ([string]::IsNullOrWhiteSpace($ExpectedSha1)) { $null } else { $ExpectedSha1.ToLowerInvariant() }
    }

    $metadata | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $metadataPath 'package-metadata.json') -Encoding UTF8

    # Patch the extracted asar so Store-gated features (e.g. Settings menu)
    # work when running as a standalone exe outside the MSIX container.
    $patchScript = Join-Path $PSScriptRoot 'patch-app-asar.mjs'
    if (Test-Path $patchScript) {
        node $patchScript --app-dir (Join-Path $destinationRoot 'app')
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "patch-app-asar.mjs exited with code $LASTEXITCODE – continuing anyway."
        }
    }

    Write-Output $destinationRoot
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
