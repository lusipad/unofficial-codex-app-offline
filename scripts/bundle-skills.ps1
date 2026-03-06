[CmdletBinding()]
param(
    [string[]]$SourceRoots = @('vendor/skills'),
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

$skillEntries = [System.Collections.Generic.List[object]]::new()
$seenSkills = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

foreach ($sourceRoot in $resolvedSources) {
    Get-ChildItem -Path $sourceRoot -Directory -Force | Sort-Object Name | ForEach-Object {
        if (-not $seenSkills.Add($_.Name)) {
            return
        }

        $targetPath = Join-Path $destinationRoot $_.Name
        Copy-Item -Path $_.FullName -Destination $targetPath -Recurse -Force

        $skillFile = Join-Path $targetPath 'SKILL.md'
        $skillHash = $null

        if (Test-Path $skillFile) {
            $skillHash = (Get-FileHash -Algorithm SHA256 -Path $skillFile).Hash.ToLowerInvariant()
        }

        $skillEntries.Add([ordered]@{
            name = $_.Name
            relativePath = $_.Name
            skillFile = if (Test-Path $skillFile) { 'SKILL.md' } else { $null }
            skillHash = $skillHash
            fileCount = (Get-ChildItem -Path $targetPath -Recurse -File -Force | Measure-Object).Count
        }) | Out-Null
    }
}

$hashMaterial = ($skillEntries | Sort-Object name | ForEach-Object {
    '{0}:{1}' -f $_.name, $_.skillHash
}) -join "`n"

$manifest = [ordered]@{
    packageVersion = $PackageVersion
    generatedAt = (Get-Date).ToString('o')
    contentHash = Get-ContentHash -Value $hashMaterial
    skills = @($skillEntries | Sort-Object name)
}

$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestFile -Encoding UTF8
Write-Output $manifestFile
