[CmdletBinding()]
param(
    [string[]]$SourceRoots = @('build/work/skills-official'),
    [string]$Destination = 'build/seed/codex-home/skills',
    [string]$ManifestPath = 'build/seed/skills-manifest.json',
    [string]$PackageVersion = 'dev',
    [string]$DefaultInstallProfile = 'offline',
    [string[]]$DefaultInstallPaths = @()
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
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hasher = [System.Security.Cryptography.SHA256]::Create()

    try {
        return ([System.BitConverter]::ToString($hasher.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
    }
}

function Get-RelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$PathValue
    )

    $resolvedBasePath = [System.IO.Path]::GetFullPath($BasePath)
    $resolvedTargetPath = [System.IO.Path]::GetFullPath($PathValue)
    $baseRoot = [System.IO.Path]::GetPathRoot($resolvedBasePath)
    $targetRoot = [System.IO.Path]::GetPathRoot($resolvedTargetPath)

    if (-not [string]::Equals($baseRoot, $targetRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $resolvedTargetPath.Replace('\\', '/').Replace('\', '/')
    }

    if ($resolvedBasePath -eq $resolvedTargetPath) {
        return '.'
    }

    if (-not $resolvedBasePath.EndsWith([string][System.IO.Path]::DirectorySeparatorChar) -and
        -not $resolvedBasePath.EndsWith([string][System.IO.Path]::AltDirectorySeparatorChar)) {
        $resolvedBasePath += [System.IO.Path]::DirectorySeparatorChar
    }

    $baseUri = [System.Uri]$resolvedBasePath
    $targetUri = [System.Uri]$resolvedTargetPath
    $relativePath = [System.Uri]::UnescapeDataString(
        $baseUri.MakeRelativeUri($targetUri).ToString()
    ).Replace('/', [System.IO.Path]::DirectorySeparatorChar)

    return $relativePath.Replace('\\', '/').Replace('\', '/')
}

function Get-DirectoryHash {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    $material = (Get-ChildItem -Path $DirectoryPath -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        $relativePath = Get-RelativePath -BasePath $DirectoryPath -PathValue $_.FullName
        $hash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
        '{0}:{1}' -f $relativePath, $hash
    }) -join "`n"

    return Get-ContentHash -Value $material
}

function Normalize-ManifestPath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return $PathValue.Replace('\', '/').Trim('/')
}

function Get-SkillDirectories {
    param([Parameter(Mandatory = $true)][string]$RootPath)

    $entries = [System.Collections.Generic.List[object]]::new()

    foreach ($groupName in @('.system', '.curated')) {
        $groupRoot = Join-Path $RootPath $groupName
        if (-not (Test-Path $groupRoot)) { continue }

        Get-ChildItem -Path $groupRoot -Directory -Force | ForEach-Object {
            if (Test-Path (Join-Path $_.FullName 'SKILL.md')) {
                $entries.Add([ordered]@{
                    name = $_.Name
                    relativePath = ('{0}/{1}' -f $groupName, $_.Name)
                    fullPath = $_.FullName
                })
            }
        }
    }

    Get-ChildItem -Path $RootPath -Directory -Force | Where-Object {
        -not $_.Name.StartsWith('.') -and (Test-Path (Join-Path $_.FullName 'SKILL.md'))
    } | ForEach-Object {
        $entries.Add([ordered]@{
            name = $_.Name
            relativePath = $_.Name
            fullPath = $_.FullName
        })
    }

    return @($entries)
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

$defaultInstallSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($defaultPath in $DefaultInstallPaths) {
    $normalizedDefaultPath = Normalize-ManifestPath -PathValue $defaultPath
    if (-not [string]::IsNullOrWhiteSpace($normalizedDefaultPath)) {
        $defaultInstallSet.Add($normalizedDefaultPath) | Out-Null
    }
}

$skillEntries = @(
    Get-SkillDirectories -RootPath $destinationRoot | Sort-Object relativePath | ForEach-Object {
        $installByDefault = $defaultInstallSet.Contains([string]$_.relativePath)
        $installProfiles = if ($installByDefault) {
            @($DefaultInstallProfile, 'all')
        }
        else {
            @('all')
        }

        [ordered]@{
            name = $_.name
            relativePath = $_.relativePath
            skillFile = 'SKILL.md'
            skillHash = Get-DirectoryHash -DirectoryPath $_.fullPath
            fileCount = (Get-ChildItem -Path $_.fullPath -Recurse -File -Force | Measure-Object).Count
            installByDefault = $installByDefault
            installProfiles = @($installProfiles | Select-Object -Unique)
        }
    }
)

$hashMaterial = ($skillEntries | Sort-Object relativePath | ForEach-Object {
    '{0}:{1}' -f $_.relativePath, $_.skillHash
}) -join "`n"

$defaultHashMaterial = ($skillEntries | Where-Object { $_.installByDefault } | Sort-Object relativePath | ForEach-Object {
    '{0}:{1}' -f $_.relativePath, $_.skillHash
}) -join "`n"

$profileHashes = [ordered]@{
    all = Get-ContentHash -Value $hashMaterial
}

if (-not [string]::IsNullOrWhiteSpace($DefaultInstallProfile)) {
    $profileHashes[$DefaultInstallProfile] = Get-ContentHash -Value $defaultHashMaterial
}

$manifest = [ordered]@{
    packageVersion = $PackageVersion
    generatedAt = (Get-Date).ToString('o')
    contentHash = $profileHashes.all
    defaultInstallProfile = $DefaultInstallProfile
    defaultInstallPaths = @($defaultInstallSet | Sort-Object)
    profileHashes = $profileHashes
    sources = @($resolvedSources | ForEach-Object { Get-RelativePath -BasePath (Get-Location).Path -PathValue $_ })
    skills = $skillEntries
}

$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestFile -Encoding UTF8
Write-Output $manifestFile
