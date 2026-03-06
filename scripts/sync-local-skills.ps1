[CmdletBinding()]
param(
    [string]$CodexHome = '',
    [string]$Destination = 'vendor/skills'
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

$resolvedCodexHome = if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    Join-Path $HOME '.codex'
}
else {
    Resolve-AbsolutePath -PathValue $CodexHome
}

$sourceRoot = Join-Path $resolvedCodexHome 'skills'
$destinationRoot = Resolve-AbsolutePath -PathValue $Destination

if (-not (Test-Path $sourceRoot)) {
    throw "Skill source directory was not found: $sourceRoot"
}

if (Test-Path $destinationRoot) {
    Remove-Item -Path $destinationRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null
Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $destinationRoot -Recurse -Force

Write-Output $destinationRoot
