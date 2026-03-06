[CmdletBinding()]
param(
    [string[]]$SourceRoots = @('vendor/skills-official', 'vendor/skills'),
    [string]$Destination = 'build/seed/codex-home/skills',
    [string]$ManifestPath = 'build/seed/skills-manifest.json',
    [string]$PackageVersion = 'dev'
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

function Get-ContentHash {
    param([Parameter(Mandatory = $true)][string]$Value)

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hasher = [System.Security.Cryptography.SHA256]::Create()

    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
}

function Get-DirectoryHash {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    $material = (Get-ChildItem -Path $DirectoryPath -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        $relativePath = [System.IO.Path]::GetRelativePath($DirectoryPath, $_.FullName).Replace('\\', '/').Replace('\', '/')
        $hash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
        '{0}:{1}' -f $relativePath, $hash
    }) -join "`n"

    return Get-ContentHash -Value $material
}

$destinationRoot = Resolve-AbsolutePath -PathValue $Destination
$manifestFile = Resolve-AbsolutePath -PathValue $ManifestPath
$resolvedSources = @()

foreach ($sourceRoot in $SourceRoots) {
    $resolved = Resolve-AbsolutePath -PathValue $sourceRoot

    if (Test-Path $resolved) {
        $resolvedSources += $resolved
    }
}

if ($resolvedSources.Count -eq 0) {
    throw 'No skill source directories were found.'
}

if (Test-Path $destinationRoot) {
    Remove-Item -Path $destinationRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $manifestFile -Parent) | Out-Null

foreach ($sourceRoot in $resolvedSources) {
    Get-ChildItem -Path $sourceRoot -Force | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $destinationRoot -Recurse -Force
    }
}

$skillEntries = @(
    Get-ChildItem -Path $destinationRoot -Directory -Force | Sort-Object Name | ForEach-Object {
        $skillFile = Join-Path $_.FullName 'SKILL.md'
        [ordered]@{
            name = $_.Name
            relativePath = $_.Name
            skillFile = if (Test-Path $skillFile) { 'SKILL.md' } else { $null }
            skillHash = Get-DirectoryHash -DirectoryPath $_.FullName
            fileCount = (Get-ChildItem -Path $_.FullName -Recurse -File -Force | Measure-Object).Count
        }
    }
)

$hashMaterial = ($skillEntries | Sort-Object name | ForEach-Object {
    '{0}:{1}' -f $_.name, $_.skillHash
}) -join "`n"

$manifest = [ordered]@{
    packageVersion = $PackageVersion
    generatedAt = (Get-Date).ToString('o')
    contentHash = Get-ContentHash -Value $hashMaterial
    sources = @($resolvedSources | ForEach-Object { [System.IO.Path]::GetRelativePath((Get-Location).Path, $_).Replace('\\', '/').Replace('\', '/') })
    skills = $skillEntries
}

$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestFile -Encoding UTF8
Write-Output $manifestFile
