[CmdletBinding()]
param(
    [string]$InstallRoot = $PSScriptRoot,
    [string]$CodexHome = '',
    [switch]$NoLaunch
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

$resolvedInstallRoot = Resolve-AbsolutePath -PathValue $InstallRoot
$resolvedCodexHome = if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    Join-Path $HOME '.codex'
}
else {
    Resolve-AbsolutePath -PathValue $CodexHome
}

$seedRoot = Join-Path $resolvedInstallRoot 'seed/codex-home/skills'
$manifestPath = Join-Path $resolvedInstallRoot 'seed/skills-manifest.json'
$stateRoot = Join-Path $resolvedCodexHome '.offline-package'
$statePath = Join-Path $stateRoot 'skills-manifest.json'
$targetSkillsRoot = Join-Path $resolvedCodexHome 'skills'
$launcherPath = Join-Path $resolvedInstallRoot 'app/Codex.exe'

if (-not (Test-Path $seedRoot)) {
    throw "Bundled skill seed directory was not found: $seedRoot"
}

if (-not (Test-Path $manifestPath)) {
    throw "Bundled skill manifest was not found: $manifestPath"
}

if (-not (Test-Path $launcherPath)) {
    throw "Codex executable was not found: $launcherPath"
}

$manifest = Get-Content -Path $manifestPath -Raw | ConvertFrom-Json
$needSync = $true

if (Test-Path $statePath) {
    $currentState = Get-Content -Path $statePath -Raw | ConvertFrom-Json

    if ($currentState.contentHash -eq $manifest.contentHash) {
        $needSync = $false
    }
}

if ($needSync) {
    New-Item -ItemType Directory -Force -Path $targetSkillsRoot | Out-Null

    foreach ($skillDirectory in (Get-ChildItem -Path $seedRoot -Directory -Force | Sort-Object Name)) {
        $targetPath = Join-Path $targetSkillsRoot $skillDirectory.Name
        New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
        Copy-Item -Path (Join-Path $skillDirectory.FullName '*') -Destination $targetPath -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $statePath -Encoding UTF8
}

if ($NoLaunch) {
    Write-Output "Skills ready in $targetSkillsRoot"
    return
}

Start-Process -FilePath $launcherPath -WorkingDirectory (Split-Path $launcherPath -Parent)
