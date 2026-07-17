[CmdletBinding()]
param(
    [string]$BuildMetadataPath = 'build-metadata.json',
    [string]$ConfigPath = 'config/offline-package.json',
    [switch]$RequireInstallerAsset,
    [switch]$SkipDesktopLaunchSmoke
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-AbsolutePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$PathValue
    )

    if ([System.IO.Path]::IsPathRooted($PathValue)) {
        return [System.IO.Path]::GetFullPath($PathValue)
    }

    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $PathValue))
}

function Assert-ContentContainsMarkers {
    param(
        [Parameter(Mandatory = $true)][string]$Content,
        [Parameter(Mandatory = $true)]$Markers,
        [Parameter(Mandatory = $true)][string]$Context
    )

    foreach ($needle in @($Markers)) {
        if (-not $Content.Contains([string]$needle)) {
            throw "$Context is missing expected marker: $needle"
        }
    }
}

function Assert-NodeSyntax {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $syntaxOutput = & node --check $Path 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$Context is not valid JavaScript: $($syntaxOutput -join [Environment]::NewLine)"
    }
}

function Read-CapabilityContract {
    param(
        [Parameter(Mandatory = $true)][string]$ContractPath
    )

    if (-not (Test-Path $ContractPath)) {
        throw "Web gateway capability contract was not found: $ContractPath"
    }

    $nodeScript = @'
const contract = require(process.argv[1]);
console.log(JSON.stringify({
  statsigDefaultFeaturesConfig: contract.STATSIG_DEFAULT_FEATURES_CONFIG,
  statsigDefaultFeatureOverrides: contract.STATSIG_DEFAULT_FEATURE_OVERRIDES,
  defaultDesktopFeatureState: contract.DEFAULT_DESKTOP_FEATURE_STATE,
  requiredWebShellFeatureMarkers: contract.REQUIRED_WEB_SHELL_FEATURE_MARKERS,
  requiredStatsigFeatureMarkers: contract.REQUIRED_STATSIG_FEATURE_MARKERS,
  requiredDesktopFeatureMarkers: contract.REQUIRED_DESKTOP_FEATURE_MARKERS,
}));
'@
    $json = & node -e $nodeScript $ContractPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to load Web gateway capability contract: $ContractPath"
    }
    return $json | ConvertFrom-Json
}

function Assert-CapabilityContractDefaults {
    param(
        [Parameter(Mandatory = $true)]$Contract,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($Contract.statsigDefaultFeaturesConfig -ne 'statsig_default_enable_features') {
        throw "$Context capability contract has an unexpected Statsig config key: $($Contract.statsigDefaultFeaturesConfig)"
    }

    foreach ($needle in @($Contract.requiredStatsigFeatureMarkers)) {
        $featureProperty = $Contract.statsigDefaultFeatureOverrides.PSObject.Properties[[string]$needle]
        if ($null -eq $featureProperty -or $featureProperty.Value -ne $true) {
            throw "$Context capability contract does not force expected Statsig feature: $needle"
        }
    }

    foreach ($needle in @($Contract.requiredDesktopFeatureMarkers | Where-Object { $_ -ne 'setDesktopFeatureValues' })) {
        $featureProperty = $Contract.defaultDesktopFeatureState.PSObject.Properties[[string]$needle]
        if ($null -eq $featureProperty -or $featureProperty.Value -ne $true) {
            throw "$Context capability contract does not force expected Desktop feature: $needle"
        }
    }
}

function Get-WebShellOwnedFeatureMarkers {
    param(
        [Parameter(Mandatory = $true)]$Contract
    )

    $statsigMarkers = @($Contract.requiredStatsigFeatureMarkers | ForEach-Object { [string]$_ })
    return @($Contract.requiredWebShellFeatureMarkers | Where-Object {
        $statsigMarkers -notcontains [string]$_
    })
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$buildMetadataFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $BuildMetadataPath
$configFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $ConfigPath

if (-not (Test-Path $buildMetadataFile)) {
    throw "Build metadata was not found: $buildMetadataFile"
}

if (-not (Test-Path $configFile)) {
    throw "Config file was not found: $configFile"
}

$metadata = Get-Content -Path $buildMetadataFile -Raw | ConvertFrom-Json
$config = Get-Content -Path $configFile -Raw | ConvertFrom-Json
$artifactRoot = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $metadata.artifactDirectory

$installerTemplatePath = Join-Path $repoRoot 'installer\CodexOffline.iss.tpl'
if (-not (Test-Path $installerTemplatePath)) {
    throw "Installer template was not found: $installerTemplatePath"
}
$strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
$installerTemplateContent = [System.IO.File]::ReadAllText($installerTemplatePath, $strictUtf8)
foreach ($needle in @(
    'DefaultDirName={%USERPROFILE|{localappdata}}\Codex',
    'UsePreviousAppDir=no',
    '#define MyInstallerRoot "__INSTALLER_ROOT__"',
    'Name: "zh"; MessagesFile: "{#MyInstallerRoot}\ChineseSimplified.isl"',
    'Filename: "{app}\Codex.cmd"; WorkingDir: "{app}"',
    'IconFilename: "{app}\_internal\app\ChatGPT.exe"',
    'zh.TaskSkills=安装默认离线技能（大部分技能需要联网，离线环境下无法使用）',
    'zh.TaskChromeHost=注册 @chrome 本机桥接',
    'zh.TaskCodexLinks=注册用于 CLI /app 的 codex:// 链接',
    'zh.TaskAppShim=安装 CLI /app 的 PowerShell shim（会覆盖 Get-AppxPackage 命令，可能与已安装的商店版 Codex Desktop 冲突）',
    'zh.TaskComputerUse=修复 Computer Use 插件布局',
    'zh.TaskChromeGuide=打开 Chrome 扩展设置引导',
    'zh.LaunchCodex=启动 Codex',
    'Name: "skills"; Description: "{cm:TaskSkills}"; Flags: unchecked',
    'Name: "chromehost"; Description: "{cm:TaskChromeHost}"; Flags: unchecked',
    'Name: "codexlinks"; Description: "{cm:TaskCodexLinks}"; Flags: unchecked',
    'Name: "computeruse"; Description: "{cm:TaskComputerUse}"; Flags: unchecked',
    'Name: "chromeguide"; Description: "{cm:TaskChromeGuide}"; Flags: unchecked',
    'Software\Classes\codex',
    'URL Protocol',
    'Tasks: codexlinks',
    'ValueData: """{app}\Codex.cmd"" ""%1"""',
    'Filename: "{app}\Setup Codex.cmd"; Parameters: "{code:GetSetupCodexArgs} -NoLaunch"; Flags: skipifsilent shellexec',
    'Filename: "{app}\Codex.cmd"; Description: "{cm:LaunchCodex}"; Flags: nowait postinstall skipifsilent shellexec',
    'Result := ''-NonInteractive -Language '' + ActiveLanguage',
    'WizardIsTaskSelected(''skills'')',
    'WizardIsTaskSelected(''chromehost'')',
    'WizardIsTaskSelected(''codexlinks'')',
    'WizardIsTaskSelected(''computeruse'')',
    'WizardIsTaskSelected(''chromeguide'')'
)) {
    if (-not $installerTemplateContent.Contains($needle)) {
        throw "Installer template is missing expected launcher marker: $needle"
    }
}

$installerLanguagePath = Join-Path $repoRoot 'installer\ChineseSimplified.isl'
if (-not (Test-Path $installerLanguagePath)) {
    throw "Installer Simplified Chinese language file was not found: $installerLanguagePath"
}

$installerLanguageContent = [System.IO.File]::ReadAllText($installerLanguagePath, $strictUtf8)
foreach ($needle in @(
    'LanguageName=简体中文',
    'LanguageID=$0804'
)) {
    if (-not $installerLanguageContent.Contains($needle)) {
        throw "Installer Simplified Chinese language file is missing expected marker: $needle"
    }
}

if (-not (Test-Path $artifactRoot)) {
    throw "Artifact directory was not found: $artifactRoot"
}

$metadataAssets = @($metadata.assets)
$portableAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-portable.zip' })
$webAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-web.zip' })
$skillsAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-skills.zip' })
$installerAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-setup.exe' })
$storeExportAssets = @($metadataAssets | Where-Object { $_.fileName -like '*-store-export.zip' })
$checksumAssets = @($metadataAssets | Where-Object { $_.fileName -eq 'SHA256SUMS.txt' })
$crossPlatformWebEnabled = $null -ne $config.packaging.PSObject.Properties['crossPlatformWeb'] -and [bool]$config.packaging.crossPlatformWeb

$linuxSetupPath = Join-Path $repoRoot 'scripts\setup-linux.sh'
$linuxSetupContent = Get-Content -Path $linuxSetupPath -Raw
foreach ($needle in @(
    'install|start|stop|status|restart|update',
    'CODEX_WEB_INSTALL_DIR',
    'manage_gateway',
    'update_gateway',
    'download_latest_web_zip',
    'install_gateway_deps',
    'sudo systemctl "$command" "$SERVICE_NAME"',
    'UPDATE_DIR="$(mktemp -d)"',
    '[ "$(basename "$item")" = ".env" ] && continue'
)) {
    if (-not $linuxSetupContent.Contains($needle)) {
        throw "Linux setup script is missing expected management marker: $needle"
    }
}

if ($config.packaging.portableZip -and $portableAssets.Count -ne 1) {
    throw "Expected exactly one portable zip asset, found $($portableAssets.Count)."
}

if ($crossPlatformWebEnabled -and $webAssets.Count -ne 1) {
    throw "Expected exactly one web zip asset, found $($webAssets.Count)."
}

if (-not $crossPlatformWebEnabled -and $webAssets.Count -gt 0) {
    throw 'Cross-platform Web zip is disabled, but a *-web.zip asset was still produced.'
}

if ($config.packaging.skillArchive -and $skillsAssets.Count -ne 1) {
    throw "Expected exactly one skills zip asset, found $($skillsAssets.Count)."
}

if ($checksumAssets.Count -ne 1) {
    throw "Expected exactly one SHA256SUMS.txt asset, found $($checksumAssets.Count)."
}

if (-not $config.packaging.sourceExportArchive -and $storeExportAssets.Count -gt 0) {
    throw 'Store export zip is disabled, but a *-store-export.zip asset was still produced.'
}

$storeExportFiles = @(Get-ChildItem -Path $artifactRoot -Filter '*-store-export.zip' -File -ErrorAction SilentlyContinue)
if (-not $config.packaging.sourceExportArchive -and $storeExportFiles.Count -gt 0) {
    throw 'Store export zip is disabled, but a *-store-export.zip file still exists in the artifact directory.'
}

if ($RequireInstallerAsset -and $config.packaging.setupExe -and $installerAssets.Count -ne 1) {
    throw "Installer verification required, but expected exactly one setup exe asset and found $($installerAssets.Count)."
}

foreach ($asset in $metadataAssets) {
    $assetPath = Join-Path $artifactRoot $asset.fileName
    if (-not (Test-Path $assetPath)) {
        throw "Metadata listed an asset that does not exist on disk: $assetPath"
    }
}

$portableZipPath = Join-Path $artifactRoot $portableAssets[0].fileName
if (-not (Test-Path $portableZipPath)) {
    throw "Portable zip was not found: $portableZipPath"
}

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-offline-verify-' + [System.Guid]::NewGuid().ToString('N'))
$verifyAsarScriptPath = Join-Path $tempRoot 'verify-app-asar.cjs'
$directLaunchSmokeScriptPath = Join-Path $repoRoot 'scripts\offline-direct-launch-smoke.mjs'

if (-not (Test-Path $directLaunchSmokeScriptPath)) {
    throw "Desktop direct-launch smoke script was not found: $directLaunchSmokeScriptPath"
}

try {
    Expand-Archive -Path $portableZipPath -DestinationPath $tempRoot -Force

    $portableRoot = $tempRoot
    $topLevelEntries = @(Get-ChildItem -Path $tempRoot -Force)
    if ($topLevelEntries.Count -eq 1 -and $topLevelEntries[0].PSIsContainer) {
        $portableRoot = $topLevelEntries[0].FullName
    }

    $requiredPortableFiles = @(
        'Codex.cmd',
        'Codex Web.cmd',
        'Setup Codex.cmd',
        'README.md',
        'CHANGELOG.md',
        '_internal\bootstrap-codex-skills.ps1',
        '_internal\setup-codex-offline.ps1',
        '_internal\repair-chrome-host.ps1',
        '_internal\web\start-web.mjs',
        '_internal\web\gateway\dist\server.js',
        '_internal\web\web-shell\index.html',
        '_internal\web\web-shell\codex-bridge-polyfill.js',
        '_internal\web\node_modules\express\package.json',
        '_internal\web\node_modules\ws\package.json',
        '_internal\web\node_modules\smol-toml\package.json',
        '_internal\web\node_modules\@electron\asar\package.json',
        '_internal\tools\Launch Codex Direct.cmd',
        '_internal\tools\Sync Default Skills.cmd',
        '_internal\tools\Sync All Skills.cmd',
        '_internal\tools\Repair Chrome Host.cmd',
        '_internal\app\ChatGPT.exe',
        '_internal\app\resources\app.asar',
        '_internal\patches\init.cjs',
        '_internal\app\patches\init.cjs',
        '_internal\powershell-shim\CodexOfflineShim\CodexOfflineShim.psd1',
        '_internal\powershell-shim\CodexOfflineShim\CodexOfflineShim.psm1',
        '_internal\powershell-shim\CodexOfflineShim\sync-thread.js',
        '_internal\powershell-shim\CodexOfflineShim\repair-threads.js'
    )

    foreach ($relativePath in $requiredPortableFiles) {
        $fullPath = Join-Path $portableRoot $relativePath
        if (-not (Test-Path $fullPath)) {
            throw "Portable zip is missing required file: $relativePath"
        }
    }

    $desktopModelAvailabilityMarkers = @(
        "var STATSIG_MODEL_AVAILABILITY_CONFIG = '107580212';",
        'available_models: []',
        'use_hidden_models: false',
        "var configContainerKeys = ['dynamic_configs', 'dynamicConfigs', 'configs'];",
        'result.key === STATSIG_MODEL_AVAILABILITY_CONFIG'
    )
    foreach ($relativePath in @('_internal\patches\init.cjs', '_internal\app\patches\init.cjs')) {
        $initPatchContent = Get-Content -LiteralPath (Join-Path $portableRoot $relativePath) -Raw
        foreach ($marker in $desktopModelAvailabilityMarkers) {
            if (-not $initPatchContent.Contains($marker)) {
                throw "Packaged init.cjs is missing model availability override '$marker': $relativePath"
            }
        }
    }

    $installerBudgetRoot = 'C:\Users\123456789012345678901234567890\Codex'
    $maxInstallerPathLength = 259
    $longestInstallerPath = $null
    foreach ($entry in Get-ChildItem -Path $portableRoot -Recurse -Force) {
        $relativePath = [System.IO.Path]::GetRelativePath($portableRoot, $entry.FullName)
        $projectedPath = Join-Path $installerBudgetRoot $relativePath
        $projectedLength = $projectedPath.Length
        if ($null -eq $longestInstallerPath -or $projectedLength -gt $longestInstallerPath.Length) {
            $longestInstallerPath = [pscustomobject]@{
                Length = $projectedLength
                RelativePath = $relativePath
                ProjectedPath = $projectedPath
            }
        }
    }
    if ($null -ne $longestInstallerPath -and $longestInstallerPath.Length -gt $maxInstallerPathLength) {
        throw "Installer target path exceeds the MAX_PATH-safe budget ($($longestInstallerPath.Length) > $maxInstallerPathLength): $($longestInstallerPath.RelativePath)"
    }

    $asarUnpackedNodeModulesRoot = Join-Path $portableRoot '_internal\app\resources\app.asar.unpacked\node_modules'
    if (Test-Path $asarUnpackedNodeModulesRoot) {
        $encodedScopedPackageDirs = @(
            Get-ChildItem -Path $asarUnpackedNodeModulesRoot -Directory -Recurse -Force |
                Where-Object { $_.Name -like '*%40*' }
        )
        if ($encodedScopedPackageDirs.Count -gt 0) {
            throw "app.asar.unpacked still contains URL-encoded scoped node_modules paths: $($encodedScopedPackageDirs[0].FullName)"
        }
    }

    foreach ($relativePath in @(
        'Launch Codex Offline.vbs',
        'Launch Codex Offline.cmd',
        'Sync Codex Skills.vbs',
        'Sync Codex Skills.cmd',
        'Repair Chrome Host.vbs',
        'Repair Chrome Host.cmd',
        'Setup Codex.vbs',
        'Codex.exe',
        'Codex.lnk'
    )) {
        if (Test-Path (Join-Path $portableRoot $relativePath)) {
            throw "Portable zip still exposes legacy root launcher: $relativePath"
        }
    }

    # Windows PowerShell 5.1 reads BOM-less scripts in the system ANSI code page,
    # so non-ASCII text corrupts and can break parsing on localized systems (#68).
    foreach ($packagedScript in @(Get-ChildItem -Path (Join-Path $portableRoot '_internal') -Filter '*.ps1' -File)) {
        $packagedScriptBytes = [System.IO.File]::ReadAllBytes($packagedScript.FullName)
        $hasUtf8Bom = $packagedScriptBytes.Length -ge 3 -and
            $packagedScriptBytes[0] -eq 0xEF -and
            $packagedScriptBytes[1] -eq 0xBB -and
            $packagedScriptBytes[2] -eq 0xBF
        if ($hasUtf8Bom) {
            continue
        }
        foreach ($packagedScriptByte in $packagedScriptBytes) {
            if ($packagedScriptByte -gt 0x7F) {
                throw "Packaged PowerShell script contains non-ASCII text without a UTF-8 BOM, which Windows PowerShell 5.1 misparses: $($packagedScript.Name)"
            }
        }
    }

    $bootstrapPath = Join-Path $portableRoot '_internal\bootstrap-codex-skills.ps1'
    $bootstrapContent = Get-Content -Path $bootstrapPath -Raw
    if (-not $bootstrapContent.Contains('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
        throw 'Bootstrap script is missing the Windows Computer Use environment gate default.'
    }
    foreach ($needle in @('SkillProfile', 'AssumeYes', 'installProfile')) {
        if (-not $bootstrapContent.Contains($needle)) {
            throw "Bootstrap script is missing expected default-skill-profile marker: $needle"
        }
    }

    $setupPath = Join-Path $portableRoot '_internal\setup-codex-offline.ps1'
    $setupContent = Get-Content -Path $setupPath -Raw
    foreach ($needle in @(
        'Read-SetupYesNo',
        'Read-SetupLanguage',
        "[ValidateSet('auto', 'en', 'zh')]",
        '[switch]$InstallSkillSync',
        '[switch]$RegisterChromeHost',
        '[switch]$RegisterCodexLinks',
        '[switch]$RepairComputerUse',
        '[switch]$OpenChromeGuide',
        'Start setup now?',
        'Install the default offline skills profile now?',
        '$InstallSkillSync -or',
        "Get-SetupText 'InstallSkillsPrompt') -DefaultYes `$false",
        'Register or repair @chrome native host access now?',
        '$RegisterChromeHost -or',
        "Get-SetupText 'ChromeHostPrompt') -DefaultYes `$false",
        '$OpenChromeGuide -or',
        "Get-SetupText 'OpenChromePrompt') -DefaultYes `$false",
        'Register codex:// app links',
        "Get-SetupText 'LinksPrompt') -DefaultYes `$false",
        '$RegisterCodexLinks -or',
        'Register-CodexUrlProtocol',
        'HKCU:\Software\Classes\codex',
        'URL Protocol',
        '`"$LauncherPath`" `"%1`"',
        'Repair Computer Use plugin layout now?',
        '$RepairComputerUse -or',
        "Get-SetupText 'ComputerUsePrompt') -DefaultYes `$false",
        'Repair-ComputerUsePluginLayout',
        'chrome://extensions/',
        'Launch Codex now?',
        'AssumeYes',
        'NonInteractive',
        'repair-chrome-host.ps1',
        'bootstrap-codex-skills.ps1',
        'Codex.cmd',
        'Start-Process -FilePath $dailyLauncher',
        'After this first setup, open Codex.cmd directly.'
    )) {
        if (-not $setupContent.Contains($needle)) {
            throw "Setup script is missing expected all-in-one marker: $needle"
        }
    }

    $dailyLauncherPath = Join-Path $portableRoot 'Codex.cmd'
    $dailyLauncherContent = Get-Content -Path $dailyLauncherPath -Raw
    foreach ($needle in @('%~dp0_internal\app\ChatGPT.exe', '/D "%~dp0_internal\app"', 'CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
        if (-not $dailyLauncherContent.Contains($needle)) {
            throw "Daily launcher is missing expected relative-launch marker: $needle"
        }
    }

    $directLauncherPath = Join-Path $portableRoot '_internal\tools\Launch Codex Direct.cmd'
    $directLauncherContent = Get-Content -Path $directLauncherPath -Raw
    foreach ($needle in @('%~dp0..\app\ChatGPT.exe', '/D "%~dp0..\app"', 'CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
        if (-not $directLauncherContent.Contains($needle)) {
            throw "Direct launcher is missing expected app-working-directory marker: $needle"
        }
    }

    $webLauncherPath = Join-Path $portableRoot 'Codex Web.cmd'
    $webLauncherContent = Get-Content -Path $webLauncherPath -Raw
    foreach ($needle in @('where node', '%~dp0_internal\web\start-web.mjs')) {
        if (-not $webLauncherContent.Contains($needle)) {
            throw "Web launcher is missing expected Node startup marker: $needle"
        }
    }

    $webStartupPath = Join-Path $portableRoot '_internal\web\start-web.mjs'
    $webStartupContent = Get-Content -Path $webStartupPath -Raw
    foreach ($needle in @(
        '127.0.0.1',
        'CODEX_DESKTOP_APP_PATH',
        'CODEX_APP_SERVER_CMD',
        'CODEX_WEB_OFFICIAL_BUNDLE_DIR',
        'resources',
        'codex.exe',
        'CODEX_WEB_PASSWORD is required',
        'app-server --listen stdio://',
        '/api/health'
    )) {
        if (-not $webStartupContent.Contains($needle)) {
            throw "Web startup script is missing expected gateway marker: $needle"
        }
    }

    $webGatewayChatgptBackendPath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\chatgptBackend.js'
    $webGatewayChatgptBackendContent = Get-Content -Path $webGatewayChatgptBackendPath -Raw
    foreach ($needle in @('account/read', 'account_user_role', '/wham/accounts/check')) {
        if (-not $webGatewayChatgptBackendContent.Contains($needle)) {
            throw "Web gateway ChatGPT backend is missing expected local account-check marker: $needle"
        }
    }

    $webGatewayAppServerPath = Join-Path $portableRoot '_internal\web\gateway\dist\codex-app-server.js'
    $webGatewayAppServerContent = Get-Content -Path $webGatewayAppServerPath -Raw
    foreach ($needle in @('CODEX_WEB_APP_DIRECTORY_REQUEST_TIMEOUT_MS', 'APP_DIRECTORY_REQUEST_TIMEOUT_MS')) {
        if (-not $webGatewayAppServerContent.Contains($needle)) {
            throw "Web gateway app-server client is missing expected plugin-directory timeout marker: $needle"
        }
    }

    $webGatewayBridgePath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\appServerBridge.js'
    $webGatewayBridgeContent = Get-Content -Path $webGatewayBridgePath -Raw
    foreach ($needle in @('app-server request timed out', 'app/list unavailable')) {
        if (-not $webGatewayBridgeContent.Contains($needle)) {
            throw "Web gateway app-server bridge is missing expected plugin-directory fallback marker: $needle"
        }
    }

    $webGatewayServerPath = Join-Path $portableRoot '_internal\web\gateway\dist\server.js'
    $webGatewayServerContent = Get-Content -Path $webGatewayServerPath -Raw
    foreach ($needle in @('codex-web-worked-for=1', 'max-age=31536000, immutable')) {
        if (-not $webGatewayServerContent.Contains($needle)) {
            throw "Web gateway server is missing expected official asset cache marker: $needle"
        }
    }
    if ($webGatewayServerContent.Contains('if (shouldPatchOfficialAsset(reqPath)) return "no-store"')) {
        throw 'Web gateway server still disables browser cache for patched official JS assets.'
    }

    $webGatewayGitPath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\git.js'
    $webGatewayGitContent = Get-Content -Path $webGatewayGitPath -Raw
    foreach ($needle in @('codex-worktrees', 'isMainWorktree')) {
        if (-not $webGatewayGitContent.Contains($needle)) {
            throw "Web gateway git worker is missing expected worktree marker: $needle"
        }
    }

    $webGatewayAutomationsPath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\automations.js'
    $webGatewayAutomationsContent = Get-Content -Path $webGatewayAutomationsPath -Raw
    foreach ($needle in @('AUTOMATION_BACKEND_REQUIRED_ERROR', 'webControlOnly', 'schedulerBackend')) {
        if (-not $webGatewayAutomationsContent.Contains($needle)) {
            throw "Web gateway automations handler is missing expected Desktop-backend marker: $needle"
        }
    }

    $webGatewayIpcPath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\GatewayCodexIpcPort.js'
    $webGatewayIpcContent = Get-Content -Path $webGatewayIpcPath -Raw
    foreach ($needle in @('callAutomationBackend', 'automation-create', 'automation-run-now')) {
        if (-not $webGatewayIpcContent.Contains($needle)) {
            throw "Web gateway IPC is missing expected automation backend-forward marker: $needle"
        }
    }

    $webGatewayViewMessagesPath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\viewMessages.js'
    $webGatewayViewMessagesContent = Get-Content -Path $webGatewayViewMessagesPath -Raw
    foreach ($needle in @('electron-avatar-overlay-open', 'avatar-overlay-open-state-request', 'avatar-overlay-open-state-changed')) {
        if (-not $webGatewayViewMessagesContent.Contains($needle)) {
            throw "Web gateway viewMessages is missing expected avatar overlay close marker: $needle"
        }
    }

    $webShellBridgePath = Join-Path $portableRoot '_internal\web\web-shell\codex-bridge-polyfill.js'
    $webShellBridgeContent = Get-Content -Path $webShellBridgePath -Raw
    $webGatewayCapabilityContractPath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\capabilityContract.js'
    $webGatewayCapabilityContractDataPath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\capabilityContractData.cjs'
    $webGatewayCapabilityContractContent = Get-Content -Path $webGatewayCapabilityContractPath -Raw
    $webGatewayCapabilityContractDataContent = Get-Content -Path $webGatewayCapabilityContractDataPath -Raw
    $webGatewayCapabilityContract = Read-CapabilityContract -ContractPath $webGatewayCapabilityContractPath
    Assert-CapabilityContractDefaults -Contract $webGatewayCapabilityContract -Context 'Web gateway'
    Assert-ContentContainsMarkers -Content $webShellBridgeContent -Markers (Get-WebShellOwnedFeatureMarkers -Contract $webGatewayCapabilityContract) -Context 'Web shell bridge'
    Assert-ContentContainsMarkers -Content $webGatewayCapabilityContractContent -Markers @('capabilityContractData.cjs') -Context 'Web gateway capability contract'
    Assert-ContentContainsMarkers -Content $webGatewayCapabilityContractDataContent -Markers $webGatewayCapabilityContract.requiredStatsigFeatureMarkers -Context 'Web gateway capability contract data'
    Assert-ContentContainsMarkers -Content $webGatewayCapabilityContractDataContent -Markers $webGatewayCapabilityContract.requiredDesktopFeatureMarkers -Context 'Web gateway capability contract data'

    $webGatewayFeaturePatchesPath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\featurePatches.js'
    $webGatewayFeaturePatchesContent = Get-Content -Path $webGatewayFeaturePatchesPath -Raw
    Assert-ContentContainsMarkers -Content $webGatewayFeaturePatchesContent -Markers @('STATSIG_DEFAULT_FEATURE_OVERRIDES', './capabilityContract') -Context 'Web gateway feature patch defaults'

    $webGatewayDesktopStatePath = Join-Path $portableRoot '_internal\web\gateway\dist\ipc\codex\desktopState.js'
    $webGatewayDesktopStateContent = Get-Content -Path $webGatewayDesktopStatePath -Raw
    Assert-ContentContainsMarkers -Content $webGatewayDesktopStateContent -Markers @('setDesktopFeatureValues', 'normalizeDesktopFeatureValues', './capabilityContract') -Context 'Web gateway desktop state'

    if ($crossPlatformWebEnabled) {
        $webZipPath = Join-Path $artifactRoot $webAssets[0].fileName
        if (-not (Test-Path $webZipPath)) {
            throw "Web zip was not found: $webZipPath"
        }

        $webTempRoot = Join-Path $tempRoot 'web-package'
        Expand-Archive -Path $webZipPath -DestinationPath $webTempRoot -Force

        $webRoot = $webTempRoot
        $webTopLevelEntries = @(Get-ChildItem -Path $webTempRoot -Force)
        if ($webTopLevelEntries.Count -eq 1 -and $webTopLevelEntries[0].PSIsContainer) {
            $webRoot = $webTopLevelEntries[0].FullName
        }

        foreach ($relativePath in @(
            'start-web.mjs',
            'install.sh',
            'start.sh',
            'stop.sh',
            'status.sh',
            'install.bat',
            'start.bat',
            'stop.bat',
            'status.bat',
            'package.json',
            'package-lock.json',
            'gateway\dist\server.js',
            'web-shell\index.html',
            'web-shell\codex-bridge-polyfill.js',
            'cache\official-bundle\manifest.json',
            'cache\official-bundle\webview\index.html'
        )) {
            if (-not (Test-Path (Join-Path $webRoot $relativePath) -PathType Leaf)) {
                throw "Web zip is missing required file: $relativePath"
            }
        }

        $webZipChatgptBackendPath = Join-Path $webRoot 'gateway\dist\ipc\codex\chatgptBackend.js'
        $webZipChatgptBackendContent = Get-Content -Path $webZipChatgptBackendPath -Raw
        foreach ($needle in @('account/read', 'account_user_role', '/wham/accounts/check')) {
            if (-not $webZipChatgptBackendContent.Contains($needle)) {
                throw "Web zip ChatGPT backend is missing expected local account-check marker: $needle"
            }
        }

        $webZipAppServerPath = Join-Path $webRoot 'gateway\dist\codex-app-server.js'
        $webZipAppServerContent = Get-Content -Path $webZipAppServerPath -Raw
        foreach ($needle in @('CODEX_WEB_APP_DIRECTORY_REQUEST_TIMEOUT_MS', 'APP_DIRECTORY_REQUEST_TIMEOUT_MS')) {
            if (-not $webZipAppServerContent.Contains($needle)) {
                throw "Web zip app-server client is missing expected plugin-directory timeout marker: $needle"
            }
        }

        $webZipBridgePath = Join-Path $webRoot 'gateway\dist\ipc\codex\appServerBridge.js'
        $webZipBridgeContent = Get-Content -Path $webZipBridgePath -Raw
        foreach ($needle in @('app-server request timed out', 'app/list unavailable')) {
            if (-not $webZipBridgeContent.Contains($needle)) {
                throw "Web zip app-server bridge is missing expected plugin-directory fallback marker: $needle"
            }
        }

        $webZipServerPath = Join-Path $webRoot 'gateway\dist\server.js'
        $webZipServerContent = Get-Content -Path $webZipServerPath -Raw
        foreach ($needle in @('codex-web-worked-for=1', 'max-age=31536000, immutable')) {
            if (-not $webZipServerContent.Contains($needle)) {
                throw "Web zip gateway server is missing expected official asset cache marker: $needle"
            }
        }
        if ($webZipServerContent.Contains('if (shouldPatchOfficialAsset(reqPath)) return "no-store"')) {
            throw 'Web zip gateway server still disables browser cache for patched official JS assets.'
        }

        $webZipGitPath = Join-Path $webRoot 'gateway\dist\ipc\codex\git.js'
        $webZipGitContent = Get-Content -Path $webZipGitPath -Raw
        foreach ($needle in @('codex-worktrees', 'isMainWorktree')) {
            if (-not $webZipGitContent.Contains($needle)) {
                throw "Web zip git worker is missing expected worktree marker: $needle"
            }
        }

        $webZipAutomationsPath = Join-Path $webRoot 'gateway\dist\ipc\codex\automations.js'
        $webZipAutomationsContent = Get-Content -Path $webZipAutomationsPath -Raw
        foreach ($needle in @('AUTOMATION_BACKEND_REQUIRED_ERROR', 'webControlOnly', 'schedulerBackend')) {
            if (-not $webZipAutomationsContent.Contains($needle)) {
                throw "Web zip automations handler is missing expected Desktop-backend marker: $needle"
            }
        }

        $webZipGatewayIpcPath = Join-Path $webRoot 'gateway\dist\ipc\codex\GatewayCodexIpcPort.js'
        $webZipGatewayIpcContent = Get-Content -Path $webZipGatewayIpcPath -Raw
        foreach ($needle in @('callAutomationBackend', 'automation-create', 'automation-run-now')) {
            if (-not $webZipGatewayIpcContent.Contains($needle)) {
                throw "Web zip gateway IPC is missing expected automation backend-forward marker: $needle"
            }
        }

        $webZipViewMessagesPath = Join-Path $webRoot 'gateway\dist\ipc\codex\viewMessages.js'
        $webZipViewMessagesContent = Get-Content -Path $webZipViewMessagesPath -Raw
        foreach ($needle in @('electron-avatar-overlay-open', 'avatar-overlay-open-state-request', 'avatar-overlay-open-state-changed')) {
            if (-not $webZipViewMessagesContent.Contains($needle)) {
                throw "Web zip gateway viewMessages is missing expected avatar overlay close marker: $needle"
            }
        }

        $webZipShellBridgePath = Join-Path $webRoot 'web-shell\codex-bridge-polyfill.js'
        $webZipShellBridgeContent = Get-Content -Path $webZipShellBridgePath -Raw
        $webZipCapabilityContractPath = Join-Path $webRoot 'gateway\dist\ipc\codex\capabilityContract.js'
        $webZipCapabilityContractDataPath = Join-Path $webRoot 'gateway\dist\ipc\codex\capabilityContractData.cjs'
        $webZipCapabilityContractContent = Get-Content -Path $webZipCapabilityContractPath -Raw
        $webZipCapabilityContractDataContent = Get-Content -Path $webZipCapabilityContractDataPath -Raw
        $webZipCapabilityContract = Read-CapabilityContract -ContractPath $webZipCapabilityContractPath
        Assert-CapabilityContractDefaults -Contract $webZipCapabilityContract -Context 'Web zip gateway'
        Assert-ContentContainsMarkers -Content $webZipShellBridgeContent -Markers (Get-WebShellOwnedFeatureMarkers -Contract $webZipCapabilityContract) -Context 'Web zip shell bridge'
        Assert-ContentContainsMarkers -Content $webZipCapabilityContractContent -Markers @('capabilityContractData.cjs') -Context 'Web zip capability contract'
        Assert-ContentContainsMarkers -Content $webZipCapabilityContractDataContent -Markers $webZipCapabilityContract.requiredStatsigFeatureMarkers -Context 'Web zip capability contract data'
        Assert-ContentContainsMarkers -Content $webZipCapabilityContractDataContent -Markers $webZipCapabilityContract.requiredDesktopFeatureMarkers -Context 'Web zip capability contract data'

        $webZipFeaturePatchesPath = Join-Path $webRoot 'gateway\dist\ipc\codex\featurePatches.js'
        $webZipFeaturePatchesContent = Get-Content -Path $webZipFeaturePatchesPath -Raw
        Assert-ContentContainsMarkers -Content $webZipFeaturePatchesContent -Markers @('STATSIG_DEFAULT_FEATURE_OVERRIDES', './capabilityContract') -Context 'Web zip feature patch defaults'

        $webZipDesktopStatePath = Join-Path $webRoot 'gateway\dist\ipc\codex\desktopState.js'
        $webZipDesktopStateContent = Get-Content -Path $webZipDesktopStatePath -Raw
        Assert-ContentContainsMarkers -Content $webZipDesktopStateContent -Markers @('setDesktopFeatureValues', 'normalizeDesktopFeatureValues', './capabilityContract') -Context 'Web zip desktop state'

        foreach ($shellScriptName in @('install.sh', 'start.sh', 'stop.sh', 'status.sh')) {
            $shellScriptPath = Join-Path $webRoot $shellScriptName
            $shellScriptBytes = [System.IO.File]::ReadAllBytes($shellScriptPath)
            for ($i = 0; $i -lt ($shellScriptBytes.Length - 1); $i++) {
                if ($shellScriptBytes[$i] -eq 13 -and $shellScriptBytes[$i + 1] -eq 10) {
                    throw "Web zip $shellScriptName must use LF line endings, not CRLF."
                }
            }
        }

        $webInstallShContent = Get-Content -Path (Join-Path $webRoot 'install.sh') -Raw
        foreach ($needle in @('npm install --omit=dev --no-audit --no-fund --ignore-scripts', 'require.resolve(dep)', 'Install complete')) {
            if (-not $webInstallShContent.Contains($needle)) {
                throw "Web zip install.sh is missing expected install marker: $needle"
            }
        }

        $webStartShPath = Join-Path $webRoot 'start.sh'
        $webStartShContent = Get-Content -Path $webStartShPath -Raw
        foreach ($needle in @('Run: bash install.sh', 'CODEX_WEB_OFFICIAL_BUNDLE_DIR', 'exec node')) {
            if (-not $webStartShContent.Contains($needle)) {
                throw "Web zip start.sh is missing expected start-only marker: $needle"
            }
        }
        if ($webStartShContent.Contains('npm install --omit=dev') -or $webStartShContent.Contains('--ignore-scripts')) {
            throw 'Web zip start.sh still installs dependencies; install and start must stay separate.'
        }

        $webStopShContent = Get-Content -Path (Join-Path $webRoot 'stop.sh') -Raw
        foreach ($needle in @('lsof -ti', 'fuser', 'kill $PIDS')) {
            if (-not $webStopShContent.Contains($needle)) {
                throw "Web zip stop.sh is missing expected stop marker: $needle"
            }
        }

        $webStatusShContent = Get-Content -Path (Join-Path $webRoot 'status.sh') -Raw
        foreach ($needle in @('/api/health', 'CHECK_HOST', 'curl -fsS')) {
            if (-not $webStatusShContent.Contains($needle)) {
                throw "Web zip status.sh is missing expected status marker: $needle"
            }
        }

        $webInstallBatContent = Get-Content -Path (Join-Path $webRoot 'install.bat') -Raw
        foreach ($needle in @('npm install --omit=dev --no-audit --no-fund --ignore-scripts', 'dependency installation failed', 'dependency verification failed')) {
            if (-not $webInstallBatContent.Contains($needle)) {
                throw "Web zip install.bat is missing expected install marker: $needle"
            }
        }

        $webStartBatContent = Get-Content -Path (Join-Path $webRoot 'start.bat') -Raw
        foreach ($needle in @('Run install.bat first', 'node start-web.mjs')) {
            if (-not $webStartBatContent.Contains($needle)) {
                throw "Web zip start.bat is missing expected start-only marker: $needle"
            }
        }
        if ($webStartBatContent.Contains('call npm install') -or $webStartBatContent.Contains('--ignore-scripts')) {
            throw 'Web zip start.bat still installs dependencies; install and start must stay separate.'
        }

        $webStopBatContent = Get-Content -Path (Join-Path $webRoot 'stop.bat') -Raw
        foreach ($needle in @('Get-NetTCPConnection', 'Stop-Process')) {
            if (-not $webStopBatContent.Contains($needle)) {
                throw "Web zip stop.bat is missing expected stop marker: $needle"
            }
        }

        $webStatusBatContent = Get-Content -Path (Join-Path $webRoot 'status.bat') -Raw
        foreach ($needle in @('/api/health', 'Invoke-WebRequest', '0.0.0.0')) {
            if (-not $webStatusBatContent.Contains($needle)) {
                throw "Web zip status.bat is missing expected status marker: $needle"
            }
        }

        $webviewAssetsDir = Join-Path $webRoot 'cache\official-bundle\webview\assets'
        if (-not (Test-Path $webviewAssetsDir -PathType Container)) {
            throw 'Web zip is missing the webview assets directory.'
        }
        $webviewIndexBundles = @(Get-ChildItem -Path $webviewAssetsDir -Filter 'index-*.js' -File -ErrorAction SilentlyContinue)
        if ($webviewIndexBundles.Count -lt 1) {
            throw 'Web zip webview assets are incomplete: assets/index-*.js was not found.'
        }

        $webManifest = Get-Content -Path (Join-Path $webRoot 'cache\official-bundle\manifest.json') -Raw | ConvertFrom-Json
        if ([int]$webManifest.schemaVersion -ne 3) {
            throw "Web zip manifest has unexpected schemaVersion: $($webManifest.schemaVersion)"
        }
        if ([string]$webManifest.sourceLayoutKind -ne 'preextracted-web-package') {
            throw "Web zip manifest has unexpected sourceLayoutKind: $($webManifest.sourceLayoutKind)"
        }

        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $webZip = [System.IO.Compression.ZipFile]::OpenRead($webZipPath)
        try {
            foreach ($shellScriptName in @('install.sh', 'start.sh', 'stop.sh', 'status.sh')) {
                $shellScriptEntry = $webZip.Entries | Where-Object { $_.FullName -like "*/$shellScriptName" } | Select-Object -First 1
                if ($null -eq $shellScriptEntry) {
                    throw "Web zip $shellScriptName entry was not found while checking Unix permissions."
                }
                $unixMode = ($shellScriptEntry.ExternalAttributes -shr 16) -band 0xFFFF
                if (($unixMode -band 0x49) -ne 0x49) {
                    throw ("Web zip {0} is not marked executable for Unix users. Mode: 0{1:o}" -f $shellScriptName, $unixMode)
                }
            }
        }
        finally {
            $webZip.Dispose()
        }
    }

    $repairChromeHostPath = Join-Path $portableRoot '_internal\repair-chrome-host.ps1'
    $repairChromeHostContent = Get-Content -Path $repairChromeHostPath -Raw
    foreach ($needle in @('NativeMessagingHosts', 'com.openai.codexextension', 'extension-id.json', 'extension-host.exe')) {
        if (-not $repairChromeHostContent.Contains($needle)) {
            throw "Chrome native host repair script is missing expected marker: $needle"
        }
    }

    $chromePluginRoot = Join-Path $portableRoot '_internal\app\resources\plugins\openai-bundled\plugins\chrome'
    $bundledMarketplaceRoot = Join-Path $portableRoot '_internal\app\resources\plugins\openai-bundled'
    $bundledMarketplaceManifestPath = Join-Path $bundledMarketplaceRoot '.agents\plugins\marketplace.json'
    $browserPluginRoot = Join-Path $bundledMarketplaceRoot 'plugins\browser'
    if (-not (Test-Path $bundledMarketplaceManifestPath -PathType Leaf)) {
        throw 'Bundled OpenAI plugin marketplace manifest was not found in the portable package.'
    }
    $bundledMarketplaceManifest = Get-Content -Path $bundledMarketplaceManifestPath -Raw | ConvertFrom-Json
    $bundledMarketplaceEntries = @($bundledMarketplaceManifest.plugins)
    foreach ($offlineRuntimePluginName in @('computer-use', 'documents', 'spreadsheets', 'presentations')) {
        $offlineRuntimePluginEntries = @(
            $bundledMarketplaceEntries | Where-Object { [string]$_.name -eq $offlineRuntimePluginName }
        )
        if ($offlineRuntimePluginEntries.Count -ne 1) {
            throw "Bundled OpenAI plugin marketplace should contain exactly one '$offlineRuntimePluginName' entry, found $($offlineRuntimePluginEntries.Count)."
        }

        $offlineRuntimePluginEntry = $offlineRuntimePluginEntries[0]
        if ([string]$offlineRuntimePluginEntry.source.source -ne 'local') {
            throw "Bundled runtime plugin '$offlineRuntimePluginName' is not configured as a local plugin source."
        }
        if ([string]$offlineRuntimePluginEntry.source.path -ne "./plugins/$offlineRuntimePluginName") {
            throw "Bundled runtime plugin '$offlineRuntimePluginName' has an unexpected local source path: $($offlineRuntimePluginEntry.source.path)"
        }
        if ([string]$offlineRuntimePluginEntry.policy.installation -ne 'AVAILABLE') {
            throw "Bundled runtime plugin '$offlineRuntimePluginName' is not available for offline installation."
        }

        $offlineRuntimePluginRoot = Join-Path $bundledMarketplaceRoot "plugins\$offlineRuntimePluginName"
        $offlineRuntimePluginManifestPath = Join-Path $offlineRuntimePluginRoot '.codex-plugin\plugin.json'
        if (-not (Test-Path $offlineRuntimePluginManifestPath -PathType Leaf)) {
            throw "Bundled runtime plugin '$offlineRuntimePluginName' manifest was not found in the portable package."
        }

        $offlineRuntimePluginManifest = Get-Content -Path $offlineRuntimePluginManifestPath -Raw | ConvertFrom-Json
        if ([string]$offlineRuntimePluginManifest.name -ne $offlineRuntimePluginName) {
            throw "Bundled runtime plugin '$offlineRuntimePluginName' manifest name does not match its marketplace entry."
        }
        $offlineRuntimeSkillPath = Join-Path $offlineRuntimePluginRoot "skills\$offlineRuntimePluginName\SKILL.md"
        if (-not (Test-Path $offlineRuntimeSkillPath -PathType Leaf)) {
            throw "Bundled runtime plugin '$offlineRuntimePluginName' is missing its skill entrypoint."
        }

        if ($offlineRuntimePluginName -eq 'computer-use') {
            $computerUseClientPath = Join-Path $offlineRuntimePluginRoot 'scripts\computer-use-client.mjs'
            if (-not (Test-Path $computerUseClientPath -PathType Leaf)) {
                throw 'Bundled computer-use plugin is missing scripts\computer-use-client.mjs.'
            }
            Assert-NodeSyntax -Path $computerUseClientPath -Context 'Bundled computer-use client'
            $computerUseClientContent = Get-Content -Path $computerUseClientPath -Raw
            if (-not $computerUseClientContent.Contains('codex-offline:computer-use-native-pipe-fallback')) {
                throw 'Bundled computer-use client is missing the native pipe fallback patch.'
            }
            if ($computerUseClientContent.Contains('discoveredPipePaths.length === 1')) {
                throw 'Bundled computer-use client still ignores multiple discovered native pipes.'
            }
            $computerUseSkyRootCandidates = @(
                (Join-Path $offlineRuntimePluginRoot 'node_modules\@oai\sky'),
                (Join-Path $portableRoot '_internal\app\resources\cua_node\bin\node_modules\@oai\sky')
            )
            $computerUseSkyRoot = @(
                $computerUseSkyRootCandidates | Where-Object {
                    Test-Path (Join-Path $_ 'package.json') -PathType Leaf
                }
            ) | Select-Object -First 1
            if ($null -eq $computerUseSkyRoot) {
                throw 'Bundled computer-use plugin is missing node_modules\@oai\sky\package.json.'
            }
            $computerUseNodeModulesRoot = Split-Path -Parent (Split-Path -Parent $computerUseSkyRoot)
            $encodedComputerUseSkyPackagePath = Join-Path $computerUseNodeModulesRoot '%40oai\sky\package.json'
            if (Test-Path $encodedComputerUseSkyPackagePath -PathType Leaf) {
                throw 'Bundled computer-use plugin still has URL-encoded node_modules\%40oai\sky.'
            }
            $computerUseHelperPath = Join-Path $computerUseSkyRoot 'bin\windows\codex-computer-use.exe'
            if (-not (Test-Path $computerUseHelperPath -PathType Leaf)) {
                throw 'Bundled computer-use plugin is missing the Windows helper executable.'
            }
            $computerUseTransportPath = Join-Path $computerUseSkyRoot 'dist\project\cua\sky_js\src\targets\windows\internal\helper_transport.js'
            if (-not (Test-Path $computerUseTransportPath -PathType Leaf)) {
                throw 'Bundled computer-use plugin is missing the Windows helper transport module.'
            }
            $computerUsePnpmRoot = Join-Path $computerUseSkyRoot 'dist\node_modules\.pnpm'
            $computerUsePnpmTslibPaths = @(
                Get-ChildItem -LiteralPath $computerUsePnpmRoot -Recurse -Filter 'tslib.es6.js' -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.FullName -like '*\node_modules\tslib\tslib.es6.js' }
            )
            if ($computerUsePnpmTslibPaths.Count -eq 0) {
                throw 'Bundled computer-use plugin is missing its unencoded .pnpm tslib dependency path.'
            }
            $encodedComputerUsePnpmTslibPaths = @(
                $computerUsePnpmTslibPaths | Where-Object { $_.FullName -like '*%40rollup_plugin-typescript%40*' }
            )
            if ($encodedComputerUsePnpmTslibPaths.Count -gt 0) {
                throw 'Bundled computer-use plugin still has URL-encoded .pnpm tslib dependency path.'
            }
            $computerUseSkillContent = Get-Content -Path $offlineRuntimeSkillPath -Raw
            if (-not $computerUseSkillContent.Contains('setupComputerUseRuntime')) {
                throw 'Bundled computer-use skill is missing its runtime setup instructions.'
            }
        }
    }
    if (-not (Test-Path (Join-Path $browserPluginRoot '.codex-plugin\plugin.json') -PathType Leaf)) {
        throw 'Bundled browser plugin manifest was not found in the portable package.'
    }
    $browserSkillPath = Get-ChildItem -Path (Join-Path $browserPluginRoot 'skills') -Filter 'SKILL.md' -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { (Get-Content -Path $_.FullName -Raw).Contains('scripts/browser-client.mjs') } |
        Select-Object -First 1 -ExpandProperty FullName
    if ([string]::IsNullOrWhiteSpace($browserSkillPath)) {
        throw 'Bundled browser plugin is missing a browser-client skill entrypoint.'
    }
    if (-not (Test-Path $chromePluginRoot -PathType Container)) {
        throw 'Bundled Chrome plugin was not found in the portable package.'
    }
    if (-not (Test-Path (Join-Path $chromePluginRoot 'scripts\extension-id.json') -PathType Leaf)) {
        throw 'Bundled Chrome plugin is missing scripts\extension-id.json.'
    }
    $chromeBrowserClientPath = Join-Path $chromePluginRoot 'scripts\browser-client.mjs'
    if (-not (Test-Path $chromeBrowserClientPath -PathType Leaf)) {
        throw 'Bundled Chrome plugin is missing scripts\browser-client.mjs.'
    }
    Assert-NodeSyntax -Path $chromeBrowserClientPath -Context 'Bundled Chrome browser client'
    $chromeBrowserClientContent = Get-Content -Path $chromeBrowserClientPath -Raw
    foreach ($removedTimeoutNeedle in @(
        '/*codex-offline:browser-use-discovery-timeout*/',
        '/*codex-offline:browser-use-profile-metadata-timeout*/',
        '/*codex-offline:browser-use-request-timeout*/',
        '_codexOfflineBrowserUseDiscoveryTimeout',
        '_codexOfflineBrowserUseRequestTimeoutMs',
        '_codexOfflineNativePipeConnectTimeoutMs',
        'x-codex-browser-use-request-timeout-ms',
        'x-codex-native-pipe-connect-timeout-ms'
    )) {
        if ($chromeBrowserClientContent.Contains($removedTimeoutNeedle)) {
            throw "Bundled Chrome browser client still contains removed timeout patch marker: $removedTimeoutNeedle"
        }
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-native-pipe-fallback*/')) {
        throw 'Bundled Chrome browser client is missing the Windows native pipe fallback patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-native-pipe-direct*/')) {
        throw 'Bundled Chrome browser client is missing the Windows native pipe direct path patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-discovery-diagnostics*/')) {
        throw 'Bundled Chrome browser client is missing the discovery diagnostics patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-chrome-pipe-filter*/')) {
        throw 'Bundled Chrome browser client is missing the Windows Chrome pipe filter patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-direct-setup*/')) {
        throw 'Bundled Chrome browser client is missing the direct Windows pipe setup patch.'
    }
    if (-not $chromeBrowserClientContent.Contains('/*codex-offline:browser-use-disable-ambient-network-default*/')) {
        throw 'Bundled Chrome browser client is missing the offline ambient network default patch.'
    }
    $chromeNativeHostCheckPath = Join-Path $chromePluginRoot 'scripts\check-native-host-manifest.js'
    if (-not (Test-Path $chromeNativeHostCheckPath -PathType Leaf)) {
        throw 'Bundled Chrome plugin is missing scripts\check-native-host-manifest.js.'
    }
    $chromeNativeHostCheckContent = Get-Content -Path $chromeNativeHostCheckPath -Raw
    if (-not $chromeNativeHostCheckContent.Contains('/*codex-offline:localized-registry-default*/')) {
        throw 'Bundled Chrome native host check is missing the localized registry parser patch.'
    }
    $chromeSkillPath = Get-ChildItem -Path (Join-Path $chromePluginRoot 'skills') -Filter 'SKILL.md' -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { (Get-Content -Path $_.FullName -Raw).Contains('scripts/browser-client.mjs') } |
        Select-Object -First 1 -ExpandProperty FullName
    if ([string]::IsNullOrWhiteSpace($chromeSkillPath)) {
        throw 'Bundled Chrome plugin is missing a browser-client Chrome skill.'
    }
    $chromeSkillContent = Get-Content -Path $chromeSkillPath -Raw
    if (-not $chromeSkillContent.Contains('<!-- codex-offline:trusted-marketplace-browser-client -->')) {
        Write-Warning 'Bundled Chrome skill is missing the trusted marketplace browser-client guidance (upstream text may have changed).'
    }
    if (-not (Get-ChildItem -Path (Join-Path $chromePluginRoot 'extension-host\windows') -Filter 'extension-host.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        throw 'Bundled Chrome plugin is missing a Windows extension-host.exe binary.'
    }
    $chromeExtensionConfig = Get-Content -Path (Join-Path $chromePluginRoot 'scripts\extension-id.json') -Raw | ConvertFrom-Json
    $chromeExtensionId = [string]$chromeExtensionConfig.extensionId
    if ([string]::IsNullOrWhiteSpace($chromeExtensionId)) {
        throw 'Bundled Chrome plugin extension-id.json is missing extensionId.'
    }

    $chromeExtensionRoot = Join-Path $portableRoot '_internal\chrome-extension'
    $chromeExtensionInfoPath = Join-Path $chromeExtensionRoot 'extension-info.json'
    $chromeExtensionCrxPath = Join-Path $chromeExtensionRoot 'codex.crx'
    $chromeExtensionManifestPath = Join-Path $chromeExtensionRoot 'unpacked\manifest.json'
    foreach ($relativePath in @(
        '_internal\chrome-extension\extension-info.json',
        '_internal\chrome-extension\codex.crx',
        '_internal\chrome-extension\unpacked\manifest.json'
    )) {
        if (-not (Test-Path (Join-Path $portableRoot $relativePath) -PathType Leaf)) {
            throw "Portable zip is missing bundled Chrome extension asset: $relativePath"
        }
    }

    $chromeExtensionInfo = Get-Content -Path $chromeExtensionInfoPath -Raw | ConvertFrom-Json
    if ([string]$chromeExtensionInfo.extensionId -ne $chromeExtensionId) {
        throw "Bundled Chrome extension id '$($chromeExtensionInfo.extensionId)' does not match plugin extension id '$chromeExtensionId'."
    }
    $chromeExtensionCrxHeader = [System.IO.File]::ReadAllBytes($chromeExtensionCrxPath)
    if ($chromeExtensionCrxHeader.Length -lt 4 -or [System.Text.Encoding]::ASCII.GetString($chromeExtensionCrxHeader, 0, 4) -ne 'Cr24') {
        throw 'Bundled Chrome extension CRX is missing the Cr24 header.'
    }
    $chromeExtensionManifest = Get-Content -Path $chromeExtensionManifestPath -Raw | ConvertFrom-Json
    if ([string]$chromeExtensionManifest.name -ne [string]$chromeExtensionInfo.name) {
        throw 'Bundled Chrome extension unpacked manifest does not match extension-info.json.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$chromeExtensionManifest.key)) {
        throw 'Bundled Chrome extension unpacked manifest is missing a fixed key.'
    }

    $seedSkillsRoot = Join-Path $portableRoot '_internal\seed\codex-home\skills'
    $seedManifestPath = Join-Path $portableRoot '_internal\seed\skills-manifest.json'
    if (-not (Test-Path (Join-Path $seedSkillsRoot '.system') -PathType Container)) {
        throw 'Bundled skills seed is missing the .system skill group.'
    }
    if (-not (Test-Path (Join-Path $seedSkillsRoot '.curated') -PathType Container)) {
        throw 'Bundled skills seed is missing the .curated skill group.'
    }
    if (-not (Test-Path $seedManifestPath)) {
        throw 'Bundled skills manifest was not found in the portable package.'
    }

    $seedManifest = Get-Content -Path $seedManifestPath -Raw | ConvertFrom-Json
    $manifestSkillPaths = @($seedManifest.skills | ForEach-Object { [string]$_.relativePath })
    if (-not ($manifestSkillPaths | Where-Object { $_.StartsWith('.system/') })) {
        throw 'Bundled skills manifest does not include .system skill entries.'
    }
    if (-not ($manifestSkillPaths | Where-Object { $_.StartsWith('.curated/') })) {
        throw 'Bundled skills manifest does not include .curated skill entries.'
    }
    if ([string]::IsNullOrWhiteSpace([string]$seedManifest.defaultInstallProfile)) {
        throw 'Bundled skills manifest is missing defaultInstallProfile.'
    }
    if ($null -eq $seedManifest.profileHashes) {
        throw 'Bundled skills manifest is missing profileHashes.'
    }
    $defaultSkillPaths = @($seedManifest.skills | Where-Object { $_.installByDefault } | ForEach-Object { [string]$_.relativePath })
    if ($defaultSkillPaths.Count -eq 0) {
        throw 'Bundled skills manifest does not mark any default offline skills.'
    }
    if ($defaultSkillPaths.Count -ge $manifestSkillPaths.Count) {
        throw 'Default skill profile unexpectedly installs every bundled skill.'
    }
    if ($defaultSkillPaths | Where-Object { $_.StartsWith('.curated/') }) {
        throw 'Default offline skill profile should not auto-install curated skills.'
    }
    foreach ($expectedDefaultSkill in @($config.skills.defaultInstallPaths | ForEach-Object { [string]$_ })) {
        if ($defaultSkillPaths -notcontains $expectedDefaultSkill) {
            throw "Configured default skill was not marked installByDefault: $expectedDefaultSkill"
        }
    }
    $skillSources = @($config.skills.sources)
    $officialOnlySkillsPackage = (
        $null -ne $config.skills.official -and
        $skillSources.Count -eq 1 -and
        [string]$skillSources[0] -eq [string]$config.skills.official.destination
    )
    if ($officialOnlySkillsPackage -and ($manifestSkillPaths | Where-Object { $_ -notlike '.*/*' })) {
        throw 'Bundled skills manifest still contains flattened top-level official skill entries.'
    }

    $asarPath = Join-Path $portableRoot '_internal\app\resources\app.asar'
    $verifyAsarScript = @'
const path = require('path');
const { createRequire } = require('module');

const repoRoot = process.argv[2];
const asarPath = process.argv[3];
const capabilityContractPath = process.argv[4];
const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
const asar = requireFromRepo('@electron/asar');
const capabilityContract = require(capabilityContractPath);
const DESKTOP_ASAR_PATCH_MARKERS = capabilityContract.DESKTOP_ASAR_PATCH_MARKERS || [];
const DESKTOP_ASAR_KNOWN_GATE_IDS = capabilityContract.DESKTOP_ASAR_KNOWN_GATE_IDS || [];
const DESKTOP_BROWSER_USE_AVAILABILITY_MARKERS = capabilityContract.DESKTOP_BROWSER_USE_AVAILABILITY_MARKERS || [];
const DESKTOP_BROWSER_USE_CAPABILITY_KEYS = capabilityContract.DESKTOP_BROWSER_USE_CAPABILITY_KEYS || [];
function requiredPatchMarker(marker) {
  if (!DESKTOP_ASAR_PATCH_MARKERS.includes(marker)) {
    throw new Error(`Capability contract is missing required app.asar patch marker: ${marker}`);
  }
  return marker;
}
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function info(message) {
  console.log(`[verify-offline-package] ${message}`);
}
function directStatsigGateCallRe(gateId) {
  return new RegExp(
    `!?(?:\\(0,[$\\w]+\\)|[$\\w]+)\\(\`${escapeRegExp(gateId)}\`\\)`
  );
}
const PATCH_MARKER = requiredPatchMarker('/* codex-offline:windowsStore-patch */');
const SETTINGS_ROUTE_BAD_PATTERN_RE =
  /searchParams\.set\("initialRoute","\/settings\/"\+\([A-Za-z_$][\w$]*\.section\|\|"agent"\)\);/;
const LOCALE_SOURCE_BAD_PATTERN = '.get(`locale_source`,`IDE`)';
const WEBVIEW_BROKEN_BOOLEAN_PATCH_RE =
  /(?:^|[^\w$])(?!(?:return|throw|case)\b)[A-Za-z_$][\w$]*!0(?=[?),;])/;

const SLASH_UI_MARKER_GROUPS = [
  ['composer.slashCommands.dialogTitle'],
  ['composer.personalitySlashCommand.title', 'composer.personalitySlashCommand.label'],
  ['composer.planSlashCommand.title'],
];
const CODEX_MOBILE_REMOTE_CONTROL_MFA_ENDPOINT = '/wham/remote/control/mfa_requirement';
const CODEX_MOBILE_AUTH_RELOGIN_MARKER = requiredPatchMarker('/*codex-offline:codex-mobile-auth-relogin*/');
const LEGACY_ELECTRON_NAMESPACE_PATCH_MARKER =
  '/*codex-offline:electron-namespace-no-auto-updater*/';
const BUNDLED_BROWSER_PLUGINS_PATCH_MARKER = requiredPatchMarker('/*codex-offline:bundled-browser-plugins-no-force-reload*/');
const BUNDLED_RUNTIME_PLUGINS_PATCH_MARKER = requiredPatchMarker('/*codex-offline:bundled-runtime-plugins*/');
const WINDOWS_BROWSER_USE_CAPABILITY_PATCH_MARKER = requiredPatchMarker('/*codex-offline:windows-browser-use-capability*/');
const APP_SERVER_SANDBOX_OVERRIDE = '`-c`,`windows.sandbox=\'unelevated\'`,`app-server`,`--analytics-default-enabled`';
const NODE_REPL_FEATURE_ENABLED_PATCH_MARKER = requiredPatchMarker('/*codex-offline:node-repl-feature-enabled*/');
const NODE_REPL_CONFIG_RECONCILE_FINALLY_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:node-repl-config-reconcile-finally*/');
const NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:node-repl-disable-sandbox*/');
const NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:node-repl-tool-search-feature*/');
const COMPUTER_USE_PLUGIN_ROOT_FALLBACK_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:computer-use-plugin-root-fallback*/');
const COMPUTER_USE_INPUT_MENTION_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:computer-use-input-mention*/');
const COMPUTER_USE_INPUT_MENTION_V2_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:computer-use-input-mention-v2*/');
const COMPUTER_USE_INPUT_SKILL_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:computer-use-input-skill*/');
const COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:computer-use-thread-start-tool-search*/');
const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:computer-use-node-repl-dynamic-tool*/');
const COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:computer-use-node-repl-dynamic-tool-call*/');
const ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:archived-threads-partial-list*/');
const ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:archived-threads-cache-fallback*/');
const ARCHIVED_SETTINGS_OFFLINE_LOCAL_VISIBILITY_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:archived-settings-offline-local-visibility*/');
const FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:feature-overrides-preserve-mcp-config*/');
const FEATURE_ENABLEMENT_PRESERVE_UNIFIED_EXEC_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:feature-enablement-preserve-unified-exec*/');
const BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:bundled-plugin-cache-lock-nonfatal*/');
const RENDERER_KNOWN_STATSIG_GATES_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:renderer-known-statsig-gates*/');
const WORKSPACE_DEPENDENCIES_SETTINGS_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:workspace-dependencies-settings*/');
const MODEL_DISPLAY_NAME_FALLBACK_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:model-id-display-name-fallback*/');
const ULTRA_REASONING_EFFORT_PATCH_MARKER =
  requiredPatchMarker('/*codex-offline:ultra-reasoning-effort*/');
const bundledPluginCacheLockFatalResultRe =
  /if\([A-Za-z_$][\w$]*!=null\)\{if\([A-Za-z_$][\w$]*\.warning\(`bundled_plugins_marketplace_install_failed`,\{safe:\{errorCategory:[A-Za-z_$][\w$]*\(\{error:[A-Za-z_$][\w$]*\.error,platformFamily:e\.platformFamily\}\),marketplaceName:t,platformFamily:e\.platformFamily,\.\.\.[A-Za-z_$][\w$]*\.safe\},sensitive:\{error:[A-Za-z_$][\w$]*\.error,marketplaceRoot:e\.materializedMarketplace\.marketplaceRoot,\.\.\.[A-Za-z_$][\w$]*\.sensitive\}\}\),n\)throw [A-Za-z_$][\w$]*\.error;return!1\}return!0\}/;
const bundledPluginCacheLockFatalCatchRe =
  /catch\([A-Za-z_$][\w$]*\)\{if\([A-Za-z_$][\w$]*\.warning\(`bundled_plugins_marketplace_install_failed`,\{safe:\{errorCategory:[A-Za-z_$][\w$]*\(\{error:[A-Za-z_$][\w$]*,platformFamily:e\.platformFamily\}\),marketplaceName:t,platformFamily:e\.platformFamily\},sensitive:\{error:[A-Za-z_$][\w$]*,marketplaceRoot:e\.materializedMarketplace\.marketplaceRoot\}\}\),n\)throw [A-Za-z_$][\w$]*;return!1\}/;
function findAppServerRequestBusName(content) {
  const patterns = [
    /listExperimentalFeatures:[A-Za-z_$][\w$]*=>\s*([A-Za-z_$][\w$]*)\(`list-experimental-features`,\{[\s\S]{0,260}?hostId:/,
    /listModels:[A-Za-z_$][\w$]*=>\s*([A-Za-z_$][\w$]*)\(`list-models-for-host`,\{[\s\S]{0,260}?hostId:/,
    /await\s+([A-Za-z_$][\w$]*)\(`handle-dynamic-tools-for-thread-start-response-for-host`,\{hostId:/,
    /await\s+([A-Za-z_$][\w$]*)\(`apply-thread-title-update-for-host`,\{hostId:/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match?.[1]) return match[1];
  }
  return null;
}
function hasComputerUseNodeReplDynamicToolCallBridge(content) {
  const requestFn = findAppServerRequestBusName(content);
  if (!requestFn) return false;
  const bridgeCallRe =
    /([A-Za-z_$][\w$]*)\(`call-mcp-tool`,\{((?:params:\{)?hostId:[A-Za-z_$][\w$]*,threadId:[A-Za-z_$][\w$]*,server:`node_repl`,tool:`js`,arguments:[A-Za-z_$][\w$]*\.arguments\}\}?)\)/g;
  const matches = [...content.matchAll(bridgeCallRe)];
  if (matches.some(match => match[2].startsWith('params:'))) {
    throw new Error('Computer Use node_repl.js bridge still wraps call-mcp-tool arguments in params.');
  }
  const wrongRequestFn = matches.find(match => match[1] !== requestFn)?.[1];
  if (wrongRequestFn) {
    throw new Error(
      `Computer Use node_repl.js bridge uses ${wrongRequestFn} instead of app-server request bus ${requestFn}.`
    );
  }
  return matches.some(match => match[1] === requestFn);
}
const PLUGINS_API_KEY_NAV_PATCH_MARKER = requiredPatchMarker('/*codex-offline:plugins-api-key-nav*/');
const PLUGINS_API_KEY_ROUTE_PATCH_MARKER = requiredPatchMarker('/*codex-offline:plugins-api-key-route*/');

const bundledBrowserPluginForceReloadRe = new RegExp(
  'forceReload:!0[\\s\\S]{0,500}(?:' +
    [...DESKTOP_BROWSER_USE_CAPABILITY_KEYS.filter(key => key.endsWith('BrowserUseAllowed')), 'syncInstallStateWithChromeExtension']
      .map(escapeRegExp)
      .join('|') +
    ')'
);
function normalize(entry) {
  return entry.replace(/\\/g, '/').replace(/^\.?\//, '');
}

const rawEntries = asar.listPackage(asarPath);
const entryMap = new Map(
  rawEntries.map(entry => [normalize(entry), entry.replace(/^[\\/]+/, '')])
);
const entries = Array.from(entryMap.keys());

if (!entryMap.has('package.json')) {
  throw new Error('package.json was not found inside app.asar.');
}

const pkg = JSON.parse(asar.extractFile(asarPath, entryMap.get('package.json')).toString('utf8'));
const main = normalize(pkg.main || 'index.js');
const mainCandidates = [main];

if (main.endsWith('.js')) {
  mainCandidates.push(main.replace(/\.js$/, '/index.js'));
}

const mainEntry = mainCandidates.find(candidate => entries.includes(candidate));
if (!mainEntry) {
  throw new Error(`Could not resolve the main entry inside app.asar: ${mainCandidates.join(', ')}`);
}

const mainContent = asar.extractFile(asarPath, entryMap.get(mainEntry)).toString('utf8');
if (!mainContent.includes(PATCH_MARKER)) {
  throw new Error('windowsStore patch marker is missing from the main entry.');
}
if (!mainContent.includes('CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE')) {
  throw new Error('Computer Use environment default is missing from the main entry.');
}
if (!mainContent.includes('_codexOfflineMsixStub')) {
  throw new Error('MSIX auto-updater binding stub is missing from the main entry.');
}
if (!mainContent.includes('electron_browser_msix_updater')) {
  throw new Error('MSIX auto-updater binding stub does not target electron_browser_msix_updater.');
}

const javaScriptEntries = entries.filter(entry => entry.endsWith('.js'));

const allJavaScriptContent = [];
let bundledBrowserPluginsPatched = false;
let bundledRuntimePluginsPatched = false;
let browserUseDescriptorPatched = false;
let bundledBrowserPluginDescriptorSeen = false;
let windowsBrowserUseCapabilityPatched = false;
let appServerSandboxOverridePatched = false;
let nodeReplFeatureConfigPatched = false;
let nodeReplConfigReconcileFinallyPatched = false;
let nodeReplDisableSandboxPatched = false;
let nodeReplToolSearchFeaturePatched = false;
let computerUsePluginRootFallbackPatched = false;
let computerUseInputMentionPatched = false;
let computerUseInputSkillPatched = false;
let computerUseThreadStartToolSearchPatched = false;
let computerUseNodeReplDynamicToolPatched = false;
let computerUseNodeReplNamespaceGroupSeen = false;
let computerUseNodeReplNamespaceGroupTopLevel = false;
let computerUseNodeReplDynamicToolCallPatched = false;
let archivedThreadsPartialListPatched = false;
let archivedThreadsCacheFallbackPatched = false;
let archivedThreadsStateDbOnlyPatched = false;
let archivedSettingsOfflineLocalVisibilityPatched = false;
let featureOverridesPreserveMcpConfigPatched = false;
let featureEnablementPreserveUnifiedExecPatched = false;
let bundledPluginCacheLockNonfatalPatched = false;
let pluginsApiKeyNavPatched = false;
let pluginsApiKeyRoutePatched = false;
let rendererKnownStatsigGatesPatched = false;
let workspaceDependenciesSettingsSurfaceSeen = false;
let workspaceDependenciesSettingsPatched = false;
let modelDisplayNameFallbackPatched = false;
let ultraReasoningEffortSurfaceSeen = false;
let ultraReasoningEffortPatched = false;
let codexMobileRemoteControlMfaEndpointSeen = false;
let codexMobileAuthReloginPatched = false;
const bundledBrowserPluginForceReloadResiduals = [];
const settingsRouteResiduals = [];
const localeSourceResiduals = [];
const legacyElectronNamespacePatchResiduals = [];
const bundledPluginCacheLockFatalResiduals = [];
const webviewBrokenBooleanPatchResiduals = [];
const rendererKnownStatsigGateResiduals = [];
const rendererKnownStatsigGateLiteralEntries = [];
const ultraReasoningEffortResiduals = [];

for (const entry of javaScriptEntries) {
  const content = asar.extractFile(asarPath, entryMap.get(entry)).toString('utf8');
  allJavaScriptContent.push(content);
  const isWebviewAsset = /(^|\/)webview\/assets\/[^/]+\.js$/.test(entry);
  if (isWebviewAsset && WEBVIEW_BROKEN_BOOLEAN_PATCH_RE.test(content)) {
    webviewBrokenBooleanPatchResiduals.push(entry);
  }
  if (isWebviewAsset) {
    if (content.includes(RENDERER_KNOWN_STATSIG_GATES_PATCH_MARKER)) {
      rendererKnownStatsigGatesPatched = true;
    }
    if (content.includes('defaultMessage:`Workspace Dependencies`')) {
      workspaceDependenciesSettingsSurfaceSeen = true;
      if (content.includes(WORKSPACE_DEPENDENCIES_SETTINGS_PATCH_MARKER)) {
        workspaceDependenciesSettingsPatched = true;
      }
    }
    if (content.includes(MODEL_DISPLAY_NAME_FALLBACK_PATCH_MARKER)) {
      modelDisplayNameFallbackPatched = true;
    }
    if (content.includes('hasModelSupportingUltraReasoningEffort')) {
      ultraReasoningEffortSurfaceSeen = true;
      if (
        /\.supportedReasoningEfforts\.filter\(\(\{reasoningEffort:[A-Za-z_$][\w$]*\}\)=>[A-Za-z_$][\w$]*!==`ultra`\)/.test(content)
      ) {
        ultraReasoningEffortResiduals.push(entry);
      }
      if (
        content.includes(ULTRA_REASONING_EFFORT_PATCH_MARKER) &&
        content.includes('reasoningEffort:`ultra`,description:`ultra effort`') &&
        content.includes('===`max`||')
      ) {
        ultraReasoningEffortPatched = true;
      }
    }
    const literalGateIds = [];
    for (const gateId of DESKTOP_ASAR_KNOWN_GATE_IDS) {
      if (content.includes('`' + gateId + '`')) {
        literalGateIds.push(gateId);
      }
      if (directStatsigGateCallRe(gateId).test(content)) {
        rendererKnownStatsigGateResiduals.push(`${entry}:${gateId}`);
      }
    }
    if (literalGateIds.length > 0) {
      rendererKnownStatsigGateLiteralEntries.push(`${entry}:${literalGateIds.join(',')}`);
    }
  }
  bundledBrowserPluginsPatched ||= content.includes(BUNDLED_BROWSER_PLUGINS_PATCH_MARKER);
  bundledRuntimePluginsPatched ||= content.includes(BUNDLED_RUNTIME_PLUGINS_PATCH_MARKER);
  windowsBrowserUseCapabilityPatched ||= content.includes(WINDOWS_BROWSER_USE_CAPABILITY_PATCH_MARKER);
  appServerSandboxOverridePatched ||= content.includes(APP_SERVER_SANDBOX_OVERRIDE);
  nodeReplFeatureConfigPatched ||= content.includes(NODE_REPL_FEATURE_ENABLED_PATCH_MARKER);
  nodeReplConfigReconcileFinallyPatched ||=
    content.includes(NODE_REPL_CONFIG_RECONCILE_FINALLY_PATCH_MARKER);
  nodeReplDisableSandboxPatched ||=
    content.includes(NODE_REPL_DISABLE_SANDBOX_PATCH_MARKER) &&
    content.includes('`--disable-sandbox`');
  nodeReplToolSearchFeaturePatched ||=
    content.includes(NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER) &&
    content.includes('`features.tool_search`');
  if (content.includes(')x={...x,[`features.tool_search`]:!0}' + NODE_REPL_TOOL_SEARCH_FEATURE_PATCH_MARKER)) {
    throw new Error('Browser Use thread config has a malformed features.tool_search insertion.');
  }
  computerUsePluginRootFallbackPatched ||=
    content.includes(COMPUTER_USE_PLUGIN_ROOT_FALLBACK_PATCH_MARKER) &&
    content.includes('installedPluginRoot:f') &&
    content.includes('source?.source===`local`');
  computerUseInputMentionPatched ||=
    content.includes(COMPUTER_USE_INPUT_MENTION_PATCH_MARKER) &&
    content.includes(COMPUTER_USE_INPUT_MENTION_V2_PATCH_MARKER) &&
    content.includes('name:i,path:r') &&
    content.includes('plugin://computer-use@openai-bundled');
  computerUseInputSkillPatched ||=
    content.includes(COMPUTER_USE_INPUT_SKILL_PATCH_MARKER) &&
    content.includes('type:`skill`,name:`computer-use`') &&
    content.includes('SKILL.md');
  computerUseThreadStartToolSearchPatched ||=
    content.includes(COMPUTER_USE_THREAD_START_TOOL_SEARCH_PATCH_MARKER) &&
    content.includes('`mcp_servers.node_repl`') &&
    content.includes('`features.tool_search`') &&
    content.includes('`features.js_repl_tools_only`') &&
    content.includes('`features.tool_suggest`') &&
    content.includes('`features.tool_search_always_defer_mcp_tools`') &&
    content.includes('`features.non_prefixed_mcp_tool_names`') &&
    content.includes('`features.unavailable_dummy_tools`') &&
    content.includes('`--disable-sandbox`');
  computerUseNodeReplDynamicToolPatched ||=
    content.includes(COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_PATCH_MARKER) &&
    (content.includes('namespace:`node_repl`') || content.includes('type:`namespace`,name:`node_repl`')) &&
    content.includes('name:`js`') &&
    (content.includes('This forwards to node_repl.js') || content.includes('type:`namespace`,name:`node_repl`')) &&
    content.includes('persistent Node REPL');
  // A namespace group is only legal alongside the sibling groups the app-server
  // deserializes as namespaces. Nested inside a group's `tools:` array it fails
  // thread/start with "unknown variant `namespace`, expected `function`".
  computerUseNodeReplNamespaceGroupSeen ||=
    content.includes('type:`namespace`,name:`node_repl`');
  computerUseNodeReplNamespaceGroupTopLevel ||=
    /\{type:`namespace`,name:`node_repl`,description:`Node REPL tools for Computer Use\.`,tools:\[\{type:`function`,name:`js`[\s\S]{0,900}?\}\]\}\]:[A-Za-z_$][\w$]*\.concat\(\[\{type:`function`,name:`js`/.test(content);
  computerUseNodeReplDynamicToolCallPatched ||=
    content.includes(COMPUTER_USE_NODE_REPL_DYNAMIC_TOOL_CALL_PATCH_MARKER) &&
    hasComputerUseNodeReplDynamicToolCallBridge(content) &&
    content.includes('namespace==null');
  archivedThreadsPartialListPatched ||=
    content.includes(ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER) &&
    content.includes('_codexOfflineArchiveListError') &&
    content.includes('thread/list') &&
    content.includes('archived:');
  archivedThreadsCacheFallbackPatched ||=
    content.includes(ARCHIVED_THREADS_CACHE_FALLBACK_PATCH_MARKER) &&
    content.includes('__codexOfflineArchivedThreadsCache') &&
    content.includes('_codexOfflineArchiveListFailed') &&
    content.includes('globalThis.__codexOfflineArchivedThreadsCache');
  archivedThreadsStateDbOnlyPatched ||=
    content.includes(ARCHIVED_THREADS_PARTIAL_LIST_PATCH_MARKER) &&
    (/useStateDbOnly:[A-Za-z_$][\w$]*\?!0:[A-Za-z_$][\w$]*/.test(content) ||
      content.includes('useStateDbOnly:!0'));
  archivedSettingsOfflineLocalVisibilityPatched ||=
    content.includes(ARCHIVED_SETTINGS_OFFLINE_LOCAL_VISIBILITY_PATCH_MARKER) &&
    content.includes('archivedChats:') &&
    /=[A-Za-z_$][\w$]*\/\*codex-offline:archived-settings-offline-local-visibility\*\//.test(content);
  featureOverridesPreserveMcpConfigPatched ||=
    content.includes(FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER) &&
    content.includes('`features.unified_exec`]=!0') &&
    content.includes('`features.tool_search`]=!0') &&
    content.includes('`features.js_repl_tools_only`]=!0') &&
    content.includes('`features.tool_suggest`]=!0') &&
    content.includes('`features.tool_search_always_defer_mcp_tools`]=!0') &&
    content.includes('`features.non_prefixed_mcp_tool_names`]=!0') &&
    content.includes('`features.unavailable_dummy_tools`]=!0');
  featureEnablementPreserveUnifiedExecPatched ||=
    (
      content.includes(FEATURE_ENABLEMENT_PRESERVE_UNIFIED_EXEC_PATCH_MARKER) &&
      content.includes('unified_exec:!0')
    ) ||
    (
      content.includes(FEATURE_OVERRIDES_PRESERVE_MCP_CONFIG_PATCH_MARKER) &&
      content.includes('`features.unified_exec`]=!0') &&
      content.includes('`features.tool_search`]=!0')
    );
  if (content.includes('`tool_suggest`,`unified_exec`')) {
    throw new Error('Renderer sends unsupported unified_exec through app-server feature enablement.');
  }
  bundledPluginCacheLockNonfatalPatched ||= content.includes(BUNDLED_PLUGIN_CACHE_LOCK_NONFATAL_PATCH_MARKER);
  if (
    bundledPluginCacheLockFatalResultRe.test(content) ||
    bundledPluginCacheLockFatalCatchRe.test(content)
  ) {
    bundledPluginCacheLockFatalResiduals.push(entry);
  }
  pluginsApiKeyNavPatched ||= content.includes(PLUGINS_API_KEY_NAV_PATCH_MARKER);
  pluginsApiKeyRoutePatched ||= content.includes(PLUGINS_API_KEY_ROUTE_PATCH_MARKER);
  codexMobileRemoteControlMfaEndpointSeen ||= content.includes(CODEX_MOBILE_REMOTE_CONTROL_MFA_ENDPOINT);
  codexMobileAuthReloginPatched ||= content.includes(CODEX_MOBILE_AUTH_RELOGIN_MARKER);
  if (content.includes(LEGACY_ELECTRON_NAMESPACE_PATCH_MARKER)) {
    legacyElectronNamespacePatchResiduals.push(entry);
  }
  browserUseDescriptorPatched ||=
    /\{autoInstallOptOutKey:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\),installWhenMissing:!0,name:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*,isAvailable:\(\{features:[A-Za-z_$][\w$]*\}\)=>\/\*codex-offline:bundled-browser-plugins-no-force-reload\*\/!0,migrate:[A-Za-z_$][\w$]*\}/.test(content);
  bundledBrowserPluginDescriptorSeen ||= browserUseDescriptorPatched || bundledBrowserPluginsPatched;
  if (bundledBrowserPluginForceReloadRe.test(content)) {
    bundledBrowserPluginDescriptorSeen = true;
    bundledBrowserPluginForceReloadResiduals.push(entry);
  }
  if (SETTINGS_ROUTE_BAD_PATTERN_RE.test(content)) {
    settingsRouteResiduals.push(entry);
  }
  if (content.includes(LOCALE_SOURCE_BAD_PATTERN)) {
    localeSourceResiduals.push(entry);
  }

}

if (settingsRouteResiduals.length > 0) {
  throw new Error(
    'Settings deep-link route still uses unmapped section slugs: ' +
    settingsRouteResiduals.join(', ')
  );
}
if (localeSourceResiduals.length > 0) {
  throw new Error(
    'Renderer i18n provider still defaults locale_source to IDE: ' +
    localeSourceResiduals.join(', ')
  );
}
if (webviewBrokenBooleanPatchResiduals.length > 0) {
  throw new Error(
    'Webview JavaScript contains malformed boolean patch output such as identifier!0: ' +
    webviewBrokenBooleanPatchResiduals.join(', ')
  );
}
if (rendererKnownStatsigGateResiduals.length > 0) {
  throw new Error(
    'Renderer webview assets still call offline-known Statsig gates directly: ' +
    rendererKnownStatsigGateResiduals.join(', ')
  );
}
if (!rendererKnownStatsigGatesPatched && rendererKnownStatsigGateLiteralEntries.length > 0) {
  throw new Error(
    'Renderer webview assets contain offline-known Statsig gate literals but no direct-gate patch marker: ' +
    rendererKnownStatsigGateLiteralEntries.join(', ')
  );
}
if (!workspaceDependenciesSettingsSurfaceSeen) {
  throw new Error('Workspace Dependencies settings surface is missing from app.asar.');
}
if (!workspaceDependenciesSettingsPatched) {
  throw new Error('Workspace Dependencies imported gate patch marker is missing from app.asar.');
}
if (!modelDisplayNameFallbackPatched) {
  throw new Error('Renderer formatted model-ID fallback marker is missing from app.asar.');
}
if (ultraReasoningEffortResiduals.length > 0) {
  throw new Error(
    'Renderer still filters Ultra reasoning effort after patching: ' +
    ultraReasoningEffortResiduals.join(', ')
  );
}
if (!ultraReasoningEffortSurfaceSeen) {
  throw new Error('Renderer Ultra reasoning effort model filter is missing from app.asar.');
}
if (!ultraReasoningEffortPatched) {
  throw new Error('Renderer Ultra reasoning effort availability patch is missing from app.asar.');
}
if (legacyElectronNamespacePatchResiduals.length > 0) {
  throw new Error(
    'Legacy Electron namespace patch breaks electron.default and must be removed: ' +
    legacyElectronNamespacePatchResiduals.join(', ')
  );
}

const webviewEntry = entries.find(entry => /(^|\/)webview\/assets\/index-[^/]+\.js$/.test(entry));
if (!webviewEntry) {
  throw new Error('Could not locate the webview index bundle inside app.asar.');
}

const missingSlashUiMarkers = SLASH_UI_MARKER_GROUPS
  .filter(markers => !allJavaScriptContent.some(content => markers.some(marker => content.includes(marker))))
  .map(markers => markers.join(' or '));
if (missingSlashUiMarkers.length > 0) {
  throw new Error(`Slash command UI markers are missing from app.asar JavaScript bundles: ${missingSlashUiMarkers.join(', ')}`);
}

const hasDesktopFeatureAvailability = allJavaScriptContent.some(content =>
  DESKTOP_BROWSER_USE_AVAILABILITY_MARKERS.every(key => content.includes(key))
);
if (hasDesktopFeatureAvailability && !windowsBrowserUseCapabilityPatched) {
  throw new Error('Windows Browser Use capability override is present but was not patched.');
}
if (!nodeReplFeatureConfigPatched) {
  throw new Error('Browser Use thread config still lacks the node_repl feature enable patch.');
}
if (!appServerSandboxOverridePatched) {
  throw new Error('Desktop app-server launch does not force windows.sandbox=\'unelevated\'.');
}
if (!nodeReplConfigReconcileFinallyPatched) {
  info('Current app version does not require the bundled plugin reconcile finalizer marker; required node_repl gates are verified separately.');
}
if (!nodeReplDisableSandboxPatched) {
  throw new Error('Browser Use thread config does not add node_repl --disable-sandbox for offline Windows Computer Use.');
}
if (!nodeReplToolSearchFeaturePatched) {
  throw new Error('Browser Use thread config does not enable features.tool_search for offline Windows Computer Use.');
}
if (!featureOverridesPreserveMcpConfigPatched) {
  throw new Error('Feature override config merge does not preserve mcp_servers.* keys and required Computer Use features.');
}
if (!featureEnablementPreserveUnifiedExecPatched) {
  throw new Error('Renderer feature enablement refresh does not preserve unified_exec.');
}
if (bundledPluginCacheLockFatalResiduals.length > 0) {
  throw new Error(
    'Bundled plugin cache lock failure handling still has fatal throw branches: ' +
    bundledPluginCacheLockFatalResiduals.join(', ')
  );
}
if (!bundledPluginCacheLockNonfatalPatched) {
  info('Current app version does not expose the bundled plugin cache lock fatal branch; nonfatal marker is not required.');
}
if (allJavaScriptContent.some(content => /[A-Za-z_$][\w$]*=\{"features\.js_repl":!1\}/.test(content))) {
  throw new Error('Browser Use thread config still disables features.js_repl by default.');
}

const hasPluginsApiKeyDisabledNavBranch = allJavaScriptContent.some(content =>
  /sidebarElectron\.pluginsDisabledTooltip[\s\S]{0,700}disabled:!0[\s\S]{0,700}sidebarElectron\.pluginsRouteNavLink/.test(content) ||
  /sidebarElectron\.pluginsRouteNavLink[\s\S]{0,700}disabled:!0[\s\S]{0,700}sidebarElectron\.pluginsDisabledTooltip/.test(content)
);
if (hasPluginsApiKeyDisabledNavBranch && !pluginsApiKeyNavPatched) {
  throw new Error('Plugins API-key navigation lockout branch is present but was not patched.');
}
const pluginsDetailAuthRedirectRe =
  /\{authMethod:([A-Za-z_$][\w$]*)\}=[A-Za-z_$][\w$]*\(\);if\([A-Za-z_$][\w$]*\(\1\)\)\{let [A-Za-z_$][\w$]*;return/;
const hasPluginsApiKeyRouteFallback = allJavaScriptContent.some(content =>
  content.includes('pluginDeepLinkAuthBlocked===!0') &&
  (
    content.includes('o&&!p){let t;return') ||
    pluginsDetailAuthRedirectRe.test(content)
  )
);
if (hasPluginsApiKeyRouteFallback && !pluginsApiKeyRoutePatched) {
  throw new Error('Plugins API-key page fallback branch is present but was not patched.');
}
if (allJavaScriptContent.some(content => pluginsDetailAuthRedirectRe.test(content))) {
  throw new Error('Plugins detail API-key auth redirect is present but was not patched.');
}
if (bundledBrowserPluginForceReloadResiduals.length > 0) {
  throw new Error(
    'Bundled browser plugin descriptors still force reload and may hit Windows file locks: ' +
    bundledBrowserPluginForceReloadResiduals.join(', ')
  );
}
if (bundledBrowserPluginDescriptorSeen && !bundledBrowserPluginsPatched) {
  throw new Error('Bundled browser plugin descriptor patch marker is missing.');
}
if (bundledBrowserPluginDescriptorSeen && !browserUseDescriptorPatched) {
  throw new Error('Bundled browser-use descriptor was not patched for offline marketplace materialization.');
}
if (!bundledRuntimePluginsPatched) {
  throw new Error('Bundled runtime plugin materialization patch marker is missing.');
}
if (!allJavaScriptContent.some(content => /for\(let [A-Za-z_$][\w$]* of \[(["'`])computer-use\1,\1documents\1,\1spreadsheets\1,\1presentations\1\]\)/.test(content))) {
  throw new Error('Bundled runtime plugin materialization patch does not preserve computer-use.');
}
if (!computerUsePluginRootFallbackPatched) {
  throw new Error('Computer Use plugin root fallback marker is missing; packaged computer-use runtime paths may be unavailable.');
}
if (!computerUseInputMentionPatched) {
  info('Computer Use prompt input mention marker is not required for this app version; transport-level skill injection is verified separately.');
}
if (!computerUseInputSkillPatched) {
  throw new Error('Computer Use prompt input skill injection patch marker is missing.');
}
if (!computerUseThreadStartToolSearchPatched) {
  throw new Error('Computer Use thread/start forwarding does not preserve features.tool_search and node_repl --disable-sandbox.');
}
if (!computerUseNodeReplDynamicToolPatched) {
  throw new Error('Computer Use node_repl.js dynamic tool exposure marker is missing.');
}
if (computerUseNodeReplNamespaceGroupSeen && !computerUseNodeReplNamespaceGroupTopLevel) {
  throw new Error(
    'Computer Use node_repl namespace group is nested inside a function-only tools array; ' +
    'app-server rejects thread/start with "unknown variant `namespace`, expected `function`".',
  );
}
if (!computerUseNodeReplDynamicToolCallPatched) {
  throw new Error('Computer Use node_repl.js dynamic tool call bridge marker is missing.');
}
if (!archivedThreadsPartialListPatched) {
  throw new Error('Archived thread list pagination fallback marker is missing.');
}
if (!archivedThreadsCacheFallbackPatched) {
  throw new Error('Archived thread list cache fallback marker is missing.');
}
if (!archivedThreadsStateDbOnlyPatched) {
  throw new Error('Archived thread list does not force useStateDbOnly for archived queries.');
}
if (!archivedSettingsOfflineLocalVisibilityPatched) {
  throw new Error('Archived settings panel still hides local archived chats when the cloud tasks query fails offline.');
}
if (codexMobileRemoteControlMfaEndpointSeen && !codexMobileAuthReloginPatched) {
  info('Codex Mobile remote-control auth relogin is a legacy renderer patch outside the current Computer Use gate.');
}
console.log(`[verify-offline-package] Verified app.asar patches in ${path.basename(asarPath)}`);
'@

    Set-Content -Path $verifyAsarScriptPath -Value $verifyAsarScript -Encoding UTF8
    node $verifyAsarScriptPath $repoRoot $asarPath $webGatewayCapabilityContractPath
    if ($LASTEXITCODE -ne 0) {
        throw "asar verification failed with exit code $LASTEXITCODE."
    }

    if (-not $SkipDesktopLaunchSmoke) {
        $directLaunchSmokeWorkRoot = Join-Path $tempRoot 'direct-launch-smoke'
        node $directLaunchSmokeScriptPath `
            --portable-root $portableRoot `
            --work-root $directLaunchSmokeWorkRoot `
            --timeout-ms 30000
        if ($LASTEXITCODE -ne 0) {
            throw "Desktop direct-launch offline smoke failed with exit code $LASTEXITCODE."
        }
    }
}
finally {
    if (Test-Path $tempRoot) {
        Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host '[verify-offline-package] Offline package verification passed.'
