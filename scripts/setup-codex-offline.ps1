[CmdletBinding()]
param(
    [string]$InstallRoot = '',
    [string]$CodexHome = '',
    [string]$SkillProfile = '',
    [switch]$InstallSkillSync,
    [switch]$SkipSkillSync,
    [switch]$RegisterChromeHost,
    [switch]$RegisterCodexLinks,
    [switch]$RepairComputerUse,
    [switch]$OpenChromeGuide,
    [switch]$SkipChromeGuide,
    [switch]$NoLaunch,
    [switch]$AssumeYes,
    [switch]$NonInteractive,
    [ValidateSet('auto', 'en', 'zh')]
    [string]$Language = 'auto'
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

$script:SetupLanguage = 'en'
$script:SetupMessages = @{
    LanguagePrompt = @{
        en = 'Choose setup language: [1] 中文  [2] English'
        zh = '选择安装语言：[1] 中文  [2] English'
    }
    LanguageInvalid = @{
        en = 'Please enter 1 or 2.'
        zh = '请输入 1 或 2。'
    }
    HeaderTitle = @{
        en = 'Codex Offline Setup'
        zh = 'Codex 离线版设置'
    }
    HeaderBody = @{
        en = 'This wizard prepares the offline package for first use.'
        zh = '这个向导会完成首次使用所需的最小设置。'
    }
    PackageRoot = @{
        en = 'Package root'
        zh = '包目录'
    }
    DailyLauncher = @{
        en = 'Daily launcher'
        zh = '日常启动器'
    }
    StartSetupPrompt = @{
        en = 'Start setup now?'
        zh = '现在开始设置吗？'
    }
    SetupCanceled = @{
        en = 'Setup canceled.'
        zh = '已取消设置。'
    }
    AnswerYesNo = @{
        en = 'Please answer y or n.'
        zh = '请输入 y 或 n。'
    }
    StepSkills = @{
        en = 'Optional offline skills'
        zh = '可选离线技能'
    }
    SkippedBySwitch = @{
        en = 'Skipped by switch.'
        zh = '已按参数跳过。'
    }
    InstallSkillsPrompt = @{
        en = 'Install the default offline skills profile now?'
        zh = '现在安装默认离线技能配置吗？'
    }
    SkillsSkipped = @{
        en = 'Skill installation skipped. You can install skills later in Codex.'
        zh = '已跳过技能安装。之后可以在 Codex 里自行安装。'
    }
    StepChromeHost = @{
        en = 'Optional Chrome native host'
        zh = '可选 Chrome 本机桥接'
    }
    ChromeHostPrompt = @{
        en = 'Register or repair @chrome native host access now?'
        zh = '现在注册或修复 @chrome 本机桥接吗？'
    }
    ChromeHostSkipped = @{
        en = 'Chrome native host repair skipped. You can run Repair Chrome Host later.'
        zh = '已跳过 Chrome 本机桥接修复。之后可以运行 Repair Chrome Host。'
    }
    StepLinks = @{
        en = 'Register codex:// app links'
        zh = '注册 codex:// 应用链接'
    }
    LinksPrompt = @{
        en = 'Register codex:// links so CLI /app can open this package?'
        zh = '注册 codex:// 链接，让 CLI /app 可以打开这个离线包吗？'
    }
    LinksRegistered = @{
        en = 'codex:// links now open this Codex Offline package.'
        zh = 'codex:// 链接现在会打开这个 Codex 离线包。'
    }
    LinksSkipped = @{
        en = 'codex:// registration skipped. CLI /app will use whichever Codex handler is already registered.'
        zh = '已跳过 codex:// 注册。CLI /app 会使用系统当前已有的 Codex 处理程序。'
    }
    StepComputerUse = @{
        en = 'Optional Computer Use plugin repair'
        zh = '可选 Computer Use 插件修复'
    }
    ComputerUsePrompt = @{
        en = 'Repair Computer Use plugin layout now?'
        zh = '现在修复 Computer Use 插件布局吗？'
    }
    ComputerUseRepaired = @{
        en = 'Computer Use plugin layout repaired ({0}).'
        zh = '已修复 Computer Use 插件布局（{0}）。'
    }
    ComputerUseOk = @{
        en = 'Computer Use plugin layout already looks correct.'
        zh = 'Computer Use 插件布局看起来已经正确。'
    }
    ComputerUseSkipped = @{
        en = 'Computer Use plugin repair skipped. You can install or repair it later in Codex.'
        zh = '已跳过 Computer Use 插件修复。之后可以在 Codex 里安装或修复。'
    }
    DailyLauncherMessage = @{
        en = "Daily launcher:`n{0}"
        zh = "日常启动器：`n{0}"
    }
    AppLauncherMessage = @{
        en = "Codex can be opened from:`n{0}"
        zh = "可以从这里打开 Codex：`n{0}"
    }
    StepChromeExtension = @{
        en = 'Optional Chrome extension'
        zh = '可选 Chrome 扩展'
    }
    ChromeExtensionNeed = @{
        en = 'For @chrome, Chrome must have the bundled extension loaded.'
        zh = '如需使用 @chrome，需要在 Chrome 中加载随包扩展。'
    }
    ExtensionPath = @{
        en = 'Extension path'
        zh = '扩展路径'
    }
    OpenChromePrompt = @{
        en = 'Open chrome://extensions now?'
        zh = '现在打开 chrome://extensions 吗？'
    }
    ChromeInstructions = @{
        en = 'In Chrome: enable Developer mode, choose Load unpacked, and select the extension path above.'
        zh = '在 Chrome 中：开启开发者模式，选择“加载已解压的扩展程序”，并选择上面的扩展路径。'
    }
    ChromeContinuePrompt = @{
        en = 'Press Enter after loading the extension, or press Enter to continue without it.'
        zh = '加载扩展后按 Enter；或直接按 Enter 跳过。'
    }
    ChromePageSkipped = @{
        en = 'Chrome extension page skipped. You can load the extension later from the path above.'
        zh = '已跳过 Chrome 扩展页面。之后可以从上面的路径手动加载。'
    }
    ChromeGuideSkipped = @{
        en = 'Skipped by -SkipChromeGuide.'
        zh = '已按 -SkipChromeGuide 跳过。'
    }
    ChromeExtensionMissing = @{
        en = 'Bundled Chrome extension was not found: {0}'
        zh = '未找到随包 Chrome 扩展：{0}'
    }
    StepFinish = @{
        en = 'Finish'
        zh = '完成'
    }
    SetupComplete = @{
        en = 'Setup is complete.'
        zh = '设置已完成。'
    }
    AfterSetup = @{
        en = 'After this first setup, open Codex.cmd directly.'
        zh = '首次设置完成后，日常直接打开 Codex.cmd 即可。'
    }
    LaunchPrompt = @{
        en = 'Launch Codex now?'
        zh = '现在启动 Codex 吗？'
    }
    LaunchSkipped = @{
        en = 'Launch skipped by -NoLaunch.'
        zh = '已按 -NoLaunch 跳过启动。'
    }
}

function Get-SetupText {
    param([Parameter(Mandatory = $true)][string]$Key)

    $entry = $script:SetupMessages[$Key]
    if ($null -eq $entry) {
        return $Key
    }

    return $entry[$script:SetupLanguage]
}

function Resolve-SetupLanguage {
    if ($Language -eq 'zh' -or $Language -eq 'en') {
        return $Language
    }

    if ([System.Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName -eq 'zh') {
        return 'zh'
    }

    return 'en'
}

function Read-SetupLanguage {
    $defaultLanguage = Resolve-SetupLanguage
    if ($AssumeYes -or $NonInteractive) {
        return $defaultLanguage
    }

    while ($true) {
        $suffix = if ($defaultLanguage -eq 'zh') { '[1]' } else { '[2]' }
        $answer = Read-Host "$($script:SetupMessages.LanguagePrompt[$defaultLanguage]) $suffix"
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return $defaultLanguage
        }

        switch ($answer.Trim().ToLowerInvariant()) {
            { $_ -in @('1', 'zh', 'cn', 'chinese', '中文') } { return 'zh' }
            { $_ -in @('2', 'en', 'english') } { return 'en' }
            default { Write-Host $script:SetupMessages.LanguageInvalid[$defaultLanguage] -ForegroundColor Yellow }
        }
    }
}

function Write-SetupHeader {
    Write-Host ''
    Write-Host (Get-SetupText 'HeaderTitle') -ForegroundColor Cyan
    Write-Host (Get-SetupText 'HeaderBody') -ForegroundColor Gray
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
            default { Write-Host (Get-SetupText 'AnswerYesNo') -ForegroundColor Yellow }
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

function Register-CodexUrlProtocol {
    param([Parameter(Mandatory = $true)][string]$LauncherPath)

    if (-not (Test-Path -LiteralPath $LauncherPath -PathType Leaf)) {
        throw "Codex launcher was not found: $LauncherPath"
    }

    $protocolRoot = 'HKCU:\Software\Classes\codex'
    $iconRoot = Join-Path $protocolRoot 'DefaultIcon'
    $commandRoot = Join-Path $protocolRoot 'shell\open\command'
    New-Item -Path $protocolRoot -Force | Out-Null
    New-Item -Path $iconRoot -Force | Out-Null
    New-Item -Path $commandRoot -Force | Out-Null
    Set-Item -Path $protocolRoot -Value 'URL:Codex Protocol'
    New-ItemProperty -Path $protocolRoot -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    Set-Item -Path $iconRoot -Value "`"$appLauncher`",0"
    Set-Item -Path $commandRoot -Value "`"$LauncherPath`" `"%1`""
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
        $newFunctionEnvLine = '    getComputerUsePrivilegedNodeRepl()?.env?.SKY_CUA_NATIVE_PIPE_DIRECTORY;'
        if (-not $content.Contains($oldFunction)) {
            $oldFunction = (@'
function getComputerUsePipePath() {
  const nativePipeDirectory =
    globalThis.nodeRepl?.env?.SKY_CUA_NATIVE_PIPE_DIRECTORY;
  if (typeof nativePipeDirectory === "string") {
    const trimmed = nativePipeDirectory.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  throw new Error("Computer Use native pipe path is unavailable");
}
'@).Replace("`r`n", "`n").Trim("`r", "`n")
            $newFunctionEnvLine = '    globalThis.nodeRepl?.env?.SKY_CUA_NATIVE_PIPE_DIRECTORY;'
        }
        $newFunction = (@'
function getComputerUsePipePaths() {
  const paths = [];
  const nativePipeDirectory =
__NATIVE_PIPE_ENV_LINE__
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
        $newFunction = $newFunction.Replace('__NATIVE_PIPE_ENV_LINE__', $newFunctionEnvLine)

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

$script:SetupLanguage = Read-SetupLanguage
Write-SetupHeader
Write-Host ("{0}: {1}" -f (Get-SetupText 'PackageRoot'), $packageRoot)
Write-Host ("{0}: {1}" -f (Get-SetupText 'DailyLauncher'), $dailyLauncher)
Write-Host ''

$setupStarted = Read-SetupYesNo -Prompt (Get-SetupText 'StartSetupPrompt') -DefaultYes $true
if (-not $setupStarted) {
    Write-Host (Get-SetupText 'SetupCanceled') -ForegroundColor Yellow
    exit 0
}

Write-SetupStep -Number 1 -Title (Get-SetupText 'StepSkills')
if ($SkipSkillSync) {
    Write-Host (Get-SetupText 'SkippedBySwitch') -ForegroundColor Yellow
}
elseif ($InstallSkillSync -or (Read-SetupYesNo -Prompt (Get-SetupText 'InstallSkillsPrompt') -DefaultYes $false)) {
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
    Write-Host (Get-SetupText 'SkillsSkipped') -ForegroundColor Yellow
}

Write-SetupStep -Number 2 -Title (Get-SetupText 'StepChromeHost')
if ($RegisterChromeHost -or (Read-SetupYesNo -Prompt (Get-SetupText 'ChromeHostPrompt') -DefaultYes $false)) {
    & $repairChromeHostScript -InstallRoot $packageRoot
}
else {
    Write-Host (Get-SetupText 'ChromeHostSkipped') -ForegroundColor Yellow
}

Write-SetupStep -Number 3 -Title (Get-SetupText 'StepLinks')
if ($RegisterCodexLinks -or (Read-SetupYesNo -Prompt (Get-SetupText 'LinksPrompt') -DefaultYes $false)) {
    Register-CodexUrlProtocol -LauncherPath $dailyLauncher
    Write-Host (Get-SetupText 'LinksRegistered') -ForegroundColor Green
}
else {
    Write-Host (Get-SetupText 'LinksSkipped') -ForegroundColor Yellow
}

Write-SetupStep -Number 4 -Title (Get-SetupText 'StepComputerUse')
if ($RepairComputerUse -or (Read-SetupYesNo -Prompt (Get-SetupText 'ComputerUsePrompt') -DefaultYes $false)) {
    $computerUseRepairCount = Repair-ComputerUsePluginLayout -PackageRoot $packageRoot -CodexHomePath $resolvedCodexHome
    if ($computerUseRepairCount -gt 0) {
        Write-Host ((Get-SetupText 'ComputerUseRepaired') -f $computerUseRepairCount) -ForegroundColor Green
    }
    else {
        Write-Host (Get-SetupText 'ComputerUseOk') -ForegroundColor Green
    }
}
else {
    Write-Host (Get-SetupText 'ComputerUseSkipped') -ForegroundColor Yellow
}

$dailyLauncherMessage = if (Test-Path -LiteralPath $dailyLauncher -PathType Leaf) {
    (Get-SetupText 'DailyLauncherMessage') -f $dailyLauncher
}
else {
    (Get-SetupText 'AppLauncherMessage') -f $appLauncher
}

Write-SetupStep -Number 5 -Title (Get-SetupText 'StepChromeExtension')
if (-not $SkipChromeGuide -and (Test-Path -LiteralPath $unpackedExtensionPath -PathType Container)) {
    Write-Host (Get-SetupText 'ChromeExtensionNeed')
    Write-Host ("{0}: {1}" -f (Get-SetupText 'ExtensionPath'), $unpackedExtensionPath) -ForegroundColor Green
    if ($OpenChromeGuide -or (Read-SetupYesNo -Prompt (Get-SetupText 'OpenChromePrompt') -DefaultYes $false)) {
        Open-ChromeExtensionsPage
        Write-Host ''
        Write-Host (Get-SetupText 'ChromeInstructions') -ForegroundColor Yellow
        Wait-SetupContinue -Prompt (Get-SetupText 'ChromeContinuePrompt')
    }
    else {
        Write-Host (Get-SetupText 'ChromePageSkipped') -ForegroundColor Yellow
    }
}
elseif ($SkipChromeGuide) {
    Write-Host (Get-SetupText 'ChromeGuideSkipped') -ForegroundColor Yellow
}
else {
    Write-Host ((Get-SetupText 'ChromeExtensionMissing') -f $unpackedExtensionPath) -ForegroundColor Yellow
}

Write-SetupStep -Number 6 -Title (Get-SetupText 'StepFinish')
Write-Host (Get-SetupText 'SetupComplete') -ForegroundColor Green
Write-Host $dailyLauncherMessage
Write-Host (Get-SetupText 'AfterSetup')

if (-not $NoLaunch -and (Read-SetupYesNo -Prompt (Get-SetupText 'LaunchPrompt') -DefaultYes $true)) {
    if (Test-Path -LiteralPath $dailyLauncher -PathType Leaf) {
        Start-Process -FilePath $dailyLauncher -WorkingDirectory $packageRoot
    }
    else {
        Start-Process -FilePath $appLauncher -WorkingDirectory (Split-Path $appLauncher -Parent)
    }
}
elseif ($NoLaunch) {
    Write-Host (Get-SetupText 'LaunchSkipped') -ForegroundColor Yellow
}
