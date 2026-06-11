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

function Repair-EncodedScopedNodeModules {
    param([Parameter(Mandatory = $true)][string]$RootPath)

    if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
        return 0
    }

    $repairedCount = 0
    $nodeModulesRoots = @(Get-ChildItem -LiteralPath $RootPath -Directory -Filter 'node_modules' -Recurse -ErrorAction SilentlyContinue)
    foreach ($nodeModulesRoot in $nodeModulesRoots) {
        $encodedDirectories = @(
            Get-ChildItem -LiteralPath $nodeModulesRoot.FullName -Directory -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.Name.Contains('%40') } |
                Sort-Object { $_.FullName.Length } -Descending
        )
        foreach ($encodedDirectory in $encodedDirectories) {
            if (-not (Test-Path -LiteralPath $encodedDirectory.FullName -PathType Container)) {
                continue
            }

            $targetName = $encodedDirectory.Name.Replace('%40', '@')
            $targetPath = Join-Path $encodedDirectory.Parent.FullName $targetName
            if (Test-Path -LiteralPath $targetPath) {
                continue
            }

            Move-Item -LiteralPath $encodedDirectory.FullName -Destination $targetPath
            $repairedCount += 1
        }
    }

    return $repairedCount
}

function Repair-ComputerUseClientNativePipeFallback {
    param([Parameter(Mandatory = $true)][string]$RootPath)

    if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
        return 0
    }

    $clientPaths = @(
        Get-ChildItem -LiteralPath $RootPath -Recurse -File -Filter 'computer-use-client.mjs' -ErrorAction SilentlyContinue
    )
    $repairedCount = 0
    foreach ($clientPath in $clientPaths) {
        $content = (Get-Content -LiteralPath $clientPath.FullName -Raw).Replace("`r`n", "`n")
        if ($content.Contains('codex-offline:computer-use-native-pipe-fallback')) {
            continue
        }

        $oldImport = 'import { endianness, platform } from "node:os";'
        $newImport = "import { readdirSync } from `"node:fs`";`n$oldImport"
        $oldCreate = (@'
    const pipePath = getComputerUsePipePath();
    let transport = null;
    try {
      const socket = await nativePipe.createConnection(pipePath);
      transport = new NativePipeComputerUseTransport(socket);
      await transport.request("list_windows", {});
      return transport;
    } catch (error) {
      await transport?.close().catch(() => {});
      throw new Error(
        `Computer Use native pipe is unavailable: ${formatErrorMessage(error)}`,
      );
    }
'@).Replace("`r`n", "`n").Trim("`r", "`n")
        $newCreate = (@'
    const pipePaths = getComputerUsePipePaths();
    let lastError = null;
    for (const pipePath of pipePaths) {
      let transport = null;
      try {
        const socket = await nativePipe.createConnection(pipePath);
        transport = new NativePipeComputerUseTransport(socket);
        await transport.request("list_windows", {});
        return transport;
      } catch (error) {
        lastError = error;
        await transport?.close().catch(() => {});
      }
    }

    throw new Error(
      `Computer Use native pipe is unavailable: ${formatErrorMessage(lastError)}`,
    );
'@).Replace("`r`n", "`n").Trim("`r", "`n")
        $oldFunction = (@'
function getComputerUsePipePath() {
  const nativePipeDirectory =
    getComputerUsePrivilegedNodeRepl()?.env?.SKY_CUA_NATIVE_PIPE_DIRECTORY;
  if (typeof nativePipeDirectory === "string") {
    const trimmed = nativePipeDirectory.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  throw new Error("Computer Use native pipe path is unavailable");
}
'@).Replace("`r`n", "`n").Trim("`r", "`n")
        $newFunction = (@'
function getComputerUsePipePaths() {
  const paths = [];
  const nativePipeDirectory =
    getComputerUsePrivilegedNodeRepl()?.env?.SKY_CUA_NATIVE_PIPE_DIRECTORY;
  if (typeof nativePipeDirectory === "string") {
    const trimmed = nativePipeDirectory.trim();
    if (trimmed) {
      paths.push(trimmed);
    }
  }

  for (const discoveredPipePath of discoverComputerUsePipePaths()) {
    if (!paths.includes(discoveredPipePath)) {
      paths.push(discoveredPipePath);
    }
  }
  if (paths.length > 0) {
    return paths;
  }

  throw new Error("Computer Use native pipe path is unavailable");
}

function discoverComputerUsePipePaths() {
  // codex-offline:computer-use-native-pipe-fallback
  try {
    return readdirSync("\\\\.\\pipe\\")
      .filter((entry) => /^codex-computer-use-[0-9a-f-]{36}$/i.test(entry))
      .map((entry) => `\\\\.\\pipe\\${entry}`);
  } catch {
    return [];
  }
}
'@).Replace("`r`n", "`n").Trim("`r", "`n")

        if (
            -not $content.Contains($oldImport) -or
            -not $content.Contains($oldCreate) -or
            -not $content.Contains($oldFunction)
        ) {
            continue
        }

        $content = $content.Replace($oldImport, $newImport)
        $content = $content.Replace($oldCreate, $newCreate)
        $content = $content.Replace($oldFunction, $newFunction)
        Set-Content -LiteralPath $clientPath.FullName -Value $content -Encoding UTF8 -NoNewline
        $repairedCount += 1
    }

    return $repairedCount
}

function Repair-ComputerUsePluginLayout {
    param(
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)][string]$CodexHomePath
    )

    $roots = @(
        (Join-Path $PackageRoot '_internal\app\resources\plugins\openai-bundled\plugins\computer-use'),
        (Join-Path $CodexHomePath 'plugins\cache\openai-bundled\computer-use'),
        (Join-Path $CodexHomePath '.tmp\bundled-marketplaces\openai-bundled\plugins\computer-use')
    )

    $repairedCount = 0
    foreach ($root in $roots) {
        $repairedCount += Repair-EncodedScopedNodeModules -RootPath $root
        $repairedCount += Repair-ComputerUseClientNativePipeFallback -RootPath $root
    }

    return $repairedCount
}

$packageRoot = Resolve-PackageRoot -RootPath $InstallRoot
$internalRoot = Join-Path $packageRoot '_internal'
$bootstrapScript = Join-Path $internalRoot 'bootstrap-codex-skills.ps1'
$repairChromeHostScript = Join-Path $internalRoot 'repair-chrome-host.ps1'
$dailyLauncher = Join-Path $packageRoot 'Codex.cmd'
$appLauncher = Join-Path $internalRoot 'app\Codex.exe'
$unpackedExtensionPath = Join-Path $internalRoot 'chrome-extension\unpacked'
$resolvedCodexHome = if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    Join-Path ([System.Environment]::GetFolderPath('UserProfile')) '.codex'
}
else {
    Resolve-AbsolutePath -PathValue $CodexHome
}

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

Write-SetupStep -Number 3 -Title 'Repair Computer Use plugin layout'
$computerUseRepairCount = Repair-ComputerUsePluginLayout -PackageRoot $packageRoot -CodexHomePath $resolvedCodexHome
if ($computerUseRepairCount -gt 0) {
    Write-Host "Computer Use plugin layout repaired ($computerUseRepairCount)." -ForegroundColor Green
}
else {
    Write-Host 'Computer Use plugin layout already looks correct.' -ForegroundColor Green
}

$dailyLauncherMessage = if (Test-Path -LiteralPath $dailyLauncher -PathType Leaf) {
    "Daily launcher:`n$dailyLauncher"
}
else {
    "Codex can be opened from:`n$appLauncher"
}

Write-SetupStep -Number 4 -Title 'Load Chrome extension'
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

Write-SetupStep -Number 5 -Title 'Finish'
Write-Host 'Setup is complete.' -ForegroundColor Green
Write-Host $dailyLauncherMessage
Write-Host 'After this first setup, open Codex.cmd directly.'

if (-not $NoLaunch -and (Read-SetupYesNo -Prompt 'Launch Codex now?' -DefaultYes $true)) {
    Start-Process -FilePath $appLauncher -WorkingDirectory (Split-Path $appLauncher -Parent)
}
elseif ($NoLaunch) {
    Write-Host 'Launch skipped by -NoLaunch.' -ForegroundColor Yellow
}
