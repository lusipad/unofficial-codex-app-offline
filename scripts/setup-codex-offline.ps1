[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$CodexHome = '',
    [string]$SkillProfile = '',
    [switch]$SkipSkillSync,
    [switch]$SkipChromeGuide,
    [switch]$NoLaunch,
    [switch]$AssumeYes,
    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return [System.IO.Path]::GetFullPath($PathValue)
}

function Resolve-PackageRoot {
    param([string]$RootPath)

    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($RootPath)) {
        $candidates += (Resolve-AbsolutePath -PathValue $RootPath)
    }

    $scriptRoot = Resolve-AbsolutePath -PathValue $PSScriptRoot
    $candidates += $scriptRoot
    $candidates += (Split-Path $scriptRoot -Parent)

    foreach ($candidate in $candidates) {
        if (
            (Test-Path -LiteralPath (Join-Path $candidate '_internal\app\Codex.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $candidate '_internal\bootstrap-codex-skills.ps1') -PathType Leaf)
        ) {
            return $candidate
        }
    }

    throw 'Could not resolve the Codex Offline package root.'
}

function Write-SetupHeader {
    Write-Host ''
    Write-Host 'Codex Offline Setup' -ForegroundColor Cyan
    Write-Host 'This interactive wizard prepares the offline package for first use.' -ForegroundColor Gray
    Write-Host ''
}

function Write-SetupStep {
    param(
        [Parameter(Mandatory = $true)][int]$Number,
        [Parameter(Mandatory = $true)][string]$Title
    )

    Write-Host ''
    Write-Host ("[{0}] {1}" -f $Number, $Title) -ForegroundColor Cyan
}

function Read-SetupYesNo {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [bool]$DefaultYes = $true
    )

    if ($AssumeYes) {
        return $true
    }

    if ($NonInteractive) {
        return $DefaultYes
    }

    $suffix = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    while ($true) {
        $answer = Read-Host "$Prompt $suffix"
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $DefaultYes
        }

        switch ($answer.Trim().ToLowerInvariant()) {
            { $_ -in @('y', 'yes') } { return $true }
            { $_ -in @('n', 'no') } { return $false }
            default { Write-Host 'Please answer y or n.' -ForegroundColor Yellow }
        }
    }
}

function Wait-SetupContinue {
    param([Parameter(Mandatory = $true)][string]$Prompt)

    if (-not $AssumeYes -and -not $NonInteractive) {
        Read-Host $Prompt | Out-Null
    }
}

function Open-ChromeExtensionsPage {
    $chromeCommand = Get-Command chrome.exe -ErrorAction SilentlyContinue
    if ($null -ne $chromeCommand) {
        Start-Process -FilePath $chromeCommand.Source -ArgumentList 'chrome://extensions/'
        return
    }

    Start-Process 'chrome://extensions/'
}

$packageRoot = Resolve-PackageRoot -RootPath $InstallRoot
$internalRoot = Join-Path $packageRoot '_internal'
$bootstrapScript = Join-Path $internalRoot 'bootstrap-codex-skills.ps1'
$repairChromeHostScript = Join-Path $internalRoot 'repair-chrome-host.ps1'
$dailyLauncher = Join-Path $packageRoot 'Codex.cmd'
$appLauncher = Join-Path $internalRoot 'app\Codex.exe'
$unpackedExtensionPath = Join-Path $internalRoot 'chrome-extension\unpacked'

if (-not (Test-Path -LiteralPath $repairChromeHostScript -PathType Leaf)) {
    throw "Chrome host repair script was not found: $repairChromeHostScript"
}

Write-SetupHeader
Write-Host "Package root: $packageRoot"
Write-Host "Daily launcher: $dailyLauncher"
Write-Host ''

$setupStarted = Read-SetupYesNo -Prompt 'Start setup now?' -DefaultYes $true
if (-not $setupStarted) {
    Write-Host 'Setup canceled.' -ForegroundColor Yellow
    exit 0
}

Write-SetupStep -Number 1 -Title 'Install default offline skills'
if ($SkipSkillSync) {
    Write-Host 'Skipped by -SkipSkillSync.' -ForegroundColor Yellow
}
elseif (Read-SetupYesNo -Prompt 'Install the default offline skills profile now?' -DefaultYes $true) {
    $bootstrapArgs = @{
        InstallRoot = $internalRoot
        NoLaunch = $true
        AssumeYes = $true
    }
    if (-not [string]::IsNullOrWhiteSpace($CodexHome)) {
        $bootstrapArgs.CodexHome = $CodexHome
    }
    if (-not [string]::IsNullOrWhiteSpace($SkillProfile)) {
        $bootstrapArgs.SkillProfile = $SkillProfile
    }

    & $bootstrapScript @bootstrapArgs
}
else {
    Write-Host 'Skill installation skipped.' -ForegroundColor Yellow
}

Write-SetupStep -Number 2 -Title 'Register Chrome native host'
if (Read-SetupYesNo -Prompt 'Register or repair @chrome native host access now?' -DefaultYes $true) {
    & $repairChromeHostScript -InstallRoot $packageRoot
}
else {
    Write-Host 'Chrome native host repair skipped.' -ForegroundColor Yellow
}

$dailyLauncherMessage = if (Test-Path -LiteralPath $dailyLauncher -PathType Leaf) {
    "Daily launcher:`n$dailyLauncher"
}
else {
    "Codex can be opened from:`n$appLauncher"
}

Write-SetupStep -Number 3 -Title 'Load Chrome extension'
if (-not $SkipChromeGuide -and (Test-Path -LiteralPath $unpackedExtensionPath -PathType Container)) {
    Write-Host 'For @chrome, Chrome must have the bundled extension loaded.'
    Write-Host "Extension path: $unpackedExtensionPath" -ForegroundColor Green
    if (Read-SetupYesNo -Prompt 'Open chrome://extensions now?' -DefaultYes $true) {
        Open-ChromeExtensionsPage
        Write-Host ''
        Write-Host 'In Chrome: enable Developer mode, choose Load unpacked, and select the extension path above.' -ForegroundColor Yellow
        Wait-SetupContinue -Prompt 'Press Enter after loading the extension, or press Enter to continue without it.'
    }
    else {
        Write-Host 'Chrome extension page skipped. You can load the extension later from the path above.' -ForegroundColor Yellow
    }
}
elseif ($SkipChromeGuide) {
    Write-Host 'Skipped by -SkipChromeGuide.' -ForegroundColor Yellow
}
else {
    Write-Host "Bundled Chrome extension was not found: $unpackedExtensionPath" -ForegroundColor Yellow
}

Write-SetupStep -Number 4 -Title 'Finish'
Write-Host 'Setup is complete.' -ForegroundColor Green
Write-Host $dailyLauncherMessage
Write-Host 'After this first setup, open Codex.cmd directly.'

if (-not $NoLaunch -and (Read-SetupYesNo -Prompt 'Launch Codex now?' -DefaultYes $true)) {
    Start-Process -FilePath $appLauncher -WorkingDirectory (Split-Path $appLauncher -Parent)
}
elseif ($NoLaunch) {
    Write-Host 'Launch skipped by -NoLaunch.' -ForegroundColor Yellow
}
