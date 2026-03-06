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

# Load skill-installer.env from the same directory as this script (app root).
# Values in the file are applied only when the corresponding env var is not
# already set — system environment variables always take precedence.
function Import-EnvFile {
    param([string]$Path)

    if (-not (Test-Path $Path)) { return }

    foreach ($line in (Get-Content -Path $Path -Encoding UTF8)) {
        $line = $line.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        $eqIdx = $line.IndexOf('=')
        if ($eqIdx -le 0) { continue }
        $key   = $line.Substring(0, $eqIdx).Trim()
        $value = $line.Substring($eqIdx + 1).Trim()
        # Strip surrounding quotes (single or double)
        if ($value.Length -ge 2 -and $value[0] -eq $value[-1] -and ($value[0] -eq '"' -or $value[0] -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        # Only set if not already defined in the environment
        if ($key -ne '' -and -not [System.Environment]::GetEnvironmentVariable($key)) {
            [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
        }
    }
}

# Check the package root (parent of _internal/) first so the user's config at
# the root takes priority, then fall back to a file beside this script.
Import-EnvFile -Path (Join-Path $PSScriptRoot '..' 'skill-installer.env')
Import-EnvFile -Path (Join-Path $PSScriptRoot 'skill-installer.env')

$resolvedInstallRoot = Resolve-AbsolutePath -PathValue $InstallRoot
$resolvedCodexHome = if (-not [string]::IsNullOrWhiteSpace($CodexHome)) {
    Resolve-AbsolutePath -PathValue $CodexHome
}
elseif (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    Resolve-AbsolutePath -PathValue $env:CODEX_HOME
}
else {
    Join-Path $HOME '.codex'
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
