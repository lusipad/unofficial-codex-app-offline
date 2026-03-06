[CmdletBinding()]
param(
    [string]$PackageId = 'OpenAI.Codex',
    [string]$Destination = 'build/source-app'
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

$destinationRoot = Resolve-AbsolutePath -PathValue $Destination
$package = Get-AppxPackage -Name $PackageId | Sort-Object Version -Descending | Select-Object -First 1

if ($null -eq $package) {
    throw "Store package '$PackageId' was not found on this machine."
}

$sourceAppDir = Join-Path $package.InstallLocation 'app'
$sourceManifest = Join-Path $package.InstallLocation 'AppxManifest.xml'

if (-not (Test-Path $sourceAppDir)) {
    throw "The installed package does not contain an app directory: $sourceAppDir"
}

if (Test-Path $destinationRoot) {
    Remove-Item -Path $destinationRoot -Recurse -Force
}

$metadataDestination = Join-Path $destinationRoot 'metadata'

New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null
New-Item -ItemType Directory -Force -Path $metadataDestination | Out-Null

Copy-Item -Path $sourceAppDir -Destination $destinationRoot -Recurse -Force
Copy-Item -Path $sourceManifest -Destination (Join-Path $metadataDestination 'AppxManifest.xml') -Force

$metadata = [ordered]@{
    appName = $package.Name
    packageFamilyName = $package.PackageFamilyName
    version = $package.Version.ToString()
    installLocation = $package.InstallLocation
    exportedAt = (Get-Date).ToString('o')
    exportedAppPath = 'app'
    manifestPath = 'metadata/AppxManifest.xml'
}

$metadata | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $metadataDestination 'package-metadata.json') -Encoding UTF8

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
