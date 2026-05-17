[CmdletBinding()]
param(
    [string]$ConfigPath = 'config/offline-package.json',
    [switch]$SkipInstaller,
    [switch]$RequireInstaller,
    [string]$MetadataOutputPath = '',
    [string]$WorkRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

trap {
    Write-Error ('Unhandled error: ' + $_.Exception.Message)
    if ($null -ne $_.InvocationInfo) {
        Write-Error $_.InvocationInfo.PositionMessage
    }
    if (-not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
        Write-Error $_.ScriptStackTrace
    }
    throw
}

function Write-BuildTrace {
    param([string]$Message)

    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Host "[build-offline] $Message"
    }
}

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

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    return (Get-FileHash -Algorithm SHA256 -Path $PathValue).Hash.ToLowerInvariant()
}

function Get-OptionalProperty {
    param(
        [Parameter(Mandatory = $false)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Get-RequiredProperty {
    param(
        [Parameter(Mandatory = $false)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $value = Get-OptionalProperty -Object $Object -Name $Name
    if ($null -eq $value -or ([string]$value).Trim() -eq '') {
        throw "$Context.$Name is required."
    }

    return $value
}

function Find-Iscc {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue

    if ($null -ne $command) {
        return $command.Source
    }

    $candidates = @(
        'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
        'C:/Program Files/Inno Setup 6/ISCC.exe'
    )

    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    return $null
}

function Invoke-NpmCommand {
    param(
        [Parameter(Mandatory = $true)][string]$WorkingDirectory,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) {
        $npm = Get-Command npm -ErrorAction SilentlyContinue
    }
    if ($null -eq $npm) {
        throw 'npm was not found. It is required to build the Codex Web gateway.'
    }

    $process = Start-Process -FilePath $npm.Source -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $($process.ExitCode)."
    }
}

function Add-WebGatewayRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$RepoRoot,
        [Parameter(Mandatory = $true)][string]$InternalRoot
    )

    $sourceRoot = Join-Path $RepoRoot 'web-gateway'
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'package.json') -PathType Leaf)) {
        return $null
    }

    Write-BuildTrace 'Building Codex Web gateway.'
    Invoke-NpmCommand -WorkingDirectory $sourceRoot -Arguments @('ci')
    Invoke-NpmCommand -WorkingDirectory $sourceRoot -Arguments @('run', 'build:gateway')

    $destinationRoot = Join-Path $InternalRoot 'web'
    if (Test-Path -LiteralPath $destinationRoot) {
        Remove-Item -LiteralPath $destinationRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null

    foreach ($fileName in @('start-web.mjs', 'package.json', 'package-lock.json', 'LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $fileName) -Destination (Join-Path $destinationRoot $fileName) -Force
    }

    Copy-Item -LiteralPath (Join-Path $sourceRoot 'node_modules') -Destination (Join-Path $destinationRoot 'node_modules') -Recurse -Force
    Invoke-NpmCommand -WorkingDirectory $destinationRoot -Arguments @('prune', '--omit=dev')
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'web-shell') -Destination (Join-Path $destinationRoot 'web-shell') -Recurse -Force

    New-Item -ItemType Directory -Force -Path (Join-Path $destinationRoot 'gateway') | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'gateway\dist') -Destination (Join-Path $destinationRoot 'gateway\dist') -Recurse -Force

    foreach ($requiredPath in @(
        'start-web.mjs',
        'gateway\dist\server.js',
        'web-shell\index.html',
        'web-shell\codex-bridge-polyfill.js',
        'node_modules\express\package.json',
        'node_modules\ws\package.json',
        'node_modules\@electron\asar\package.json'
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $destinationRoot $requiredPath) -PathType Leaf)) {
            throw "Codex Web gateway runtime is missing required file: $requiredPath"
        }
    }

    Write-BuildTrace 'Codex Web gateway bundled.'
    return [ordered]@{
        source = 'web-gateway'
        defaultHost = '127.0.0.1'
        defaultPort = 3737
    }
}

function Export-AppSource {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$ScriptRoot,
        [Parameter(Mandatory = $true)][string]$SourceExportRoot
    )

    $mode = [string]$Config.appSource.mode

    switch ($mode) {
        'installed_store' {
            & (Join-Path $ScriptRoot 'export-installed-store-app.ps1') -PackageId $Config.packageId -Destination $SourceExportRoot | Out-Null
            return [ordered]@{
                mode = $mode
                resolver = 'local-store-install'
            }
        }
        'rg_adguard' {
            $resolverJson = node (Join-Path $ScriptRoot 'resolve-store-bundle-url.mjs') --package-family-name $Config.appSource.packageFamilyName --ring $Config.appSource.ring
            if ($LASTEXITCODE -ne 0) {
                throw 'The rg-adguard resolver failed.'
            }

            $resolved = $resolverJson | ConvertFrom-Json
            & (Join-Path $ScriptRoot 'import-store-bundle-from-url.ps1') `
                -BundleUrl $resolved.selected.href `
                -DownloadedFileName $resolved.selected.fileName `
                -ExpectedSha1 $resolved.selected.sha1 `
                -Destination $SourceExportRoot `
                -PackageFamilyName $Config.appSource.packageFamilyName | Out-Null

            return [ordered]@{
                mode = $mode
                resolver = 'rg-adguard'
                packageFamilyName = $resolved.packageFamilyName
                selected = $resolved.selected
                version = $resolved.version
            }
        }
        default {
            throw "Unsupported app source mode: $mode"
        }
    }
}

function Get-ChromeExtensionConfig {
    param([Parameter(Mandatory = $true)][string]$AppRoot)

    $configPath = Join-Path $AppRoot 'resources\plugins\openai-bundled\plugins\chrome\scripts\extension-id.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        return $null
    }

    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$config.extensionId)) {
        throw "Chrome plugin extension config is missing extensionId: $configPath"
    }

    return $config
}

function Resolve-OfflineRuntimePluginMarketplaceRoot {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$WorkRoot
    )

    $runtimePluginsConfig = Get-RequiredProperty -Object $Config -Name 'runtimePlugins' -Context 'config'
    $primaryRuntimeConfig = Get-RequiredProperty -Object $runtimePluginsConfig -Name 'primaryRuntime' -Context 'config.runtimePlugins'
    $source = [string](Get-RequiredProperty -Object $primaryRuntimeConfig -Name 'source' -Context 'config.runtimePlugins.primaryRuntime')

    if ($source -ne 'archive') {
        throw "Unsupported primary runtime plugin source '$source'."
    }

    $url = [string](Get-RequiredProperty -Object $primaryRuntimeConfig -Name 'url' -Context 'config.runtimePlugins.primaryRuntime')
    $expectedSha256 = ([string](Get-RequiredProperty -Object $primaryRuntimeConfig -Name 'sha256' -Context 'config.runtimePlugins.primaryRuntime')).ToLowerInvariant()
    $marketplacePath = [string](Get-RequiredProperty -Object $primaryRuntimeConfig -Name 'marketplacePath' -Context 'config.runtimePlugins.primaryRuntime')
    $version = [string](Get-OptionalProperty -Object $primaryRuntimeConfig -Name 'version')
    if ([string]::IsNullOrWhiteSpace($version)) {
        $version = 'runtime'
    }

    $runtimeWorkRoot = Join-Path $WorkRoot 'runtime-plugins'
    $archiveRoot = Join-Path $runtimeWorkRoot $version
    $archivePath = Join-Path $archiveRoot 'codex-primary-runtime.tar.xz'
    $extractRoot = Join-Path $archiveRoot 'extract'
    $marketplaceRoot = Join-Path $extractRoot $marketplacePath

    New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null

    $needsDownload = $true
    if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
        $actualSha256 = Get-FileSha256 -PathValue $archivePath
        if ($actualSha256 -eq $expectedSha256) {
            $needsDownload = $false
        }
        else {
            Remove-Item -LiteralPath $archivePath -Force
        }
    }

    if ($needsDownload) {
        Write-BuildTrace "Downloading Codex primary runtime $version."
        $previousProgressPreference = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing
        }
        finally {
            $ProgressPreference = $previousProgressPreference
        }

        $actualSha256 = Get-FileSha256 -PathValue $archivePath
        if ($actualSha256 -ne $expectedSha256) {
            throw "Downloaded Codex primary runtime hash mismatch. Expected $expectedSha256, got $actualSha256."
        }
    }

    if (Test-Path -LiteralPath $extractRoot) {
        Remove-Item -LiteralPath $extractRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

    $tarCommand = Get-Command tar -ErrorAction SilentlyContinue
    if ($null -eq $tarCommand) {
        throw 'tar was not found. It is required to extract the Codex primary runtime archive.'
    }

    Write-BuildTrace "Extracting Codex primary runtime $version."
    & $tarCommand.Source -xf $archivePath -C $extractRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to extract Codex primary runtime archive with tar exit code $LASTEXITCODE."
    }

    if (-not (Test-Path -LiteralPath (Join-Path $marketplaceRoot '.agents\plugins\marketplace.json') -PathType Leaf)) {
        throw "Codex primary runtime marketplace was not found after extraction: $marketplaceRoot"
    }

    return [ordered]@{
        source = $source
        version = $version
        url = $url
        sha256 = $expectedSha256
        marketplaceRoot = $marketplaceRoot
    }
}

function Get-OfflineRuntimePluginSource {
    param(
        [Parameter(Mandatory = $true)][string]$MarketplaceRoot,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $pluginRoot = Join-Path (Join-Path $MarketplaceRoot 'plugins') $Name
    if (Test-Path -LiteralPath (Join-Path $pluginRoot '.codex-plugin\plugin.json') -PathType Leaf) {
        return $pluginRoot
    }

    $pluginRoot = Join-Path $MarketplaceRoot $Name
    if (-not (Test-Path -LiteralPath $pluginRoot -PathType Container)) {
        throw "Offline runtime plugin source root is missing: $pluginRoot"
    }

    $directManifestPath = Join-Path $pluginRoot '.codex-plugin\plugin.json'
    if (Test-Path -LiteralPath $directManifestPath -PathType Leaf) {
        return $pluginRoot
    }

    $candidates = @(
        Get-ChildItem -LiteralPath $pluginRoot -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.codex-plugin\plugin.json') -PathType Leaf }
    )
    if ($candidates.Count -ne 1) {
        throw "Expected exactly one offline runtime plugin version for '$Name', found $($candidates.Count)."
    }

    return $candidates[0].FullName
}

function Add-OfflineRuntimePlugins {
    param(
        [Parameter(Mandatory = $true)][string]$AppRoot,
        [Parameter(Mandatory = $true)][string]$MarketplaceSourceRoot,
        [Parameter(Mandatory = $true)][string[]]$PluginNames
    )

    $marketplaceRoot = Join-Path $AppRoot 'resources\plugins\openai-bundled'
    $manifestPath = Join-Path $marketplaceRoot '.agents\plugins\marketplace.json'
    $pluginsRoot = Join-Path $marketplaceRoot 'plugins'

    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Bundled plugin marketplace manifest was not found: $manifestPath"
    }

    New-Item -ItemType Directory -Force -Path $pluginsRoot | Out-Null

    $pluginInfo = @()
    foreach ($name in $PluginNames) {
        $sourceRoot = Get-OfflineRuntimePluginSource -MarketplaceRoot $MarketplaceSourceRoot -Name $name
        $destinationRoot = Join-Path $pluginsRoot $name
        if (Test-Path -LiteralPath $destinationRoot) {
            Remove-Item -LiteralPath $destinationRoot -Recurse -Force
        }

        Copy-Item -LiteralPath $sourceRoot -Destination $destinationRoot -Recurse -Force

        $pluginManifest = Get-Content -LiteralPath (Join-Path $destinationRoot '.codex-plugin\plugin.json') -Raw | ConvertFrom-Json
        $pluginInfo += [ordered]@{
            name = [string]$pluginManifest.name
            version = [string]$pluginManifest.version
            category = [string]$pluginManifest.interface.category
            path = "./plugins/$name"
        }
    }

    $marketplace = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $existingPlugins = @($marketplace.plugins | Where-Object { $PluginNames -notcontains [string]$_.name })
    foreach ($plugin in $pluginInfo) {
        $existingPlugins += [ordered]@{
            name = $plugin.name
            source = [ordered]@{
                source = 'local'
                path = $plugin.path
            }
            policy = [ordered]@{
                installation = 'AVAILABLE'
                authentication = 'ON_INSTALL'
            }
            category = $plugin.category
        }
    }

    $marketplace | Add-Member -NotePropertyName plugins -NotePropertyValue $existingPlugins -Force
    $marketplace | ConvertTo-Json -Depth 8 | Set-Content -Path $manifestPath -Encoding UTF8

    return $pluginInfo
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$configFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $ConfigPath
$config = Get-Content -Path $configFile -Raw | ConvertFrom-Json

$workRoot = if ($WorkRoot) {
    [System.IO.Path]::GetFullPath($WorkRoot)
} else {
    Join-Path $repoRoot 'build/work'
}
$outputRoot = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $config.packaging.outputDir
$sourceExportRoot = Join-Path $workRoot 'source-app'
$stageRoot = Join-Path $workRoot 'stage'

Write-BuildTrace 'Prepared work directories.'
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

    Write-BuildTrace 'Syncing official skills.'
if ($null -ne $config.skills.official) {
    & (Join-Path $scriptRoot 'sync-official-skills.ps1') -ConfigPath $ConfigPath | Out-Null
    Write-BuildTrace 'Official skills synced.'
}

Write-BuildTrace 'Exporting app source.'
$appSourceInfo = Export-AppSource -Config $config -ScriptRoot $scriptRoot -SourceExportRoot $sourceExportRoot
$sourceMetadata = Get-Content -Path (Join-Path $sourceExportRoot 'metadata/package-metadata.json') -Raw | ConvertFrom-Json
$version = $sourceMetadata.version
$releaseBase = '{0}-{1}' -f $config.releaseNamePrefix, $version
$releaseTag = 'offline-v{0}' -f $version
$artifactRoot = Join-Path $outputRoot $releaseBase
$packageRoot = Join-Path $stageRoot $releaseBase

Write-BuildTrace 'Preparing package staging directories.'
if (Test-Path $artifactRoot) {
    Remove-Item -Path $artifactRoot -Recurse -Force
}

if (Test-Path $packageRoot) {
    Remove-Item -Path $packageRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null

# Internal subdirectory holds app payload and implementation files users do not
# need for daily use. Setup creates the daily Codex shortcut after first run.
$internalRoot = Join-Path $packageRoot '_internal'
New-Item -ItemType Directory -Force -Path $internalRoot | Out-Null

Write-BuildTrace 'App payload copied to _internal.'
Copy-Item -Path (Join-Path $sourceExportRoot 'app') -Destination (Join-Path $internalRoot 'app') -Recurse -Force
Copy-Item -Path (Join-Path $scriptRoot 'bootstrap-codex-skills.ps1') -Destination (Join-Path $internalRoot 'bootstrap-codex-skills.ps1') -Force
Copy-Item -Path (Join-Path $scriptRoot 'repair-chrome-host.ps1') -Destination (Join-Path $internalRoot 'repair-chrome-host.ps1') -Force
Copy-Item -Path (Join-Path $scriptRoot 'setup-codex-offline.ps1') -Destination (Join-Path $internalRoot 'setup-codex-offline.ps1') -Force

Write-BuildTrace 'Bundling offline runtime plugins.'
$primaryRuntimePluginSource = Resolve-OfflineRuntimePluginMarketplaceRoot -Config $config -WorkRoot $workRoot
$runtimePluginsConfig = Get-RequiredProperty -Object $config -Name 'runtimePlugins' -Context 'config'
$primaryRuntimeConfig = Get-RequiredProperty -Object $runtimePluginsConfig -Name 'primaryRuntime' -Context 'config.runtimePlugins'
$offlineRuntimePluginNames = @((
        Get-RequiredProperty -Object $primaryRuntimeConfig -Name 'plugins' -Context 'config.runtimePlugins.primaryRuntime'
    ) | ForEach-Object { [string]$_ })
$offlineRuntimePluginInfo = Add-OfflineRuntimePlugins `
    -AppRoot (Join-Path $internalRoot 'app') `
    -MarketplaceSourceRoot $primaryRuntimePluginSource.marketplaceRoot `
    -PluginNames $offlineRuntimePluginNames
Write-BuildTrace 'Offline runtime plugins bundled.'

$chromeExtensionInfo = $null
$chromeExtensionConfig = Get-ChromeExtensionConfig -AppRoot (Join-Path $internalRoot 'app')
if ($null -eq $chromeExtensionConfig) {
    throw 'Bundled Chrome plugin was not found in the app payload, so @chrome offline assets cannot be packaged.'
}

Write-BuildTrace 'Bundling Chrome extension offline assets.'
$chromeExtensionRoot = Join-Path $internalRoot 'chrome-extension'
$downloadChromeExtensionArgs = @(
    (Join-Path $scriptRoot 'download-chrome-extension.mjs'),
    '--extension-id',
    [string]$chromeExtensionConfig.extensionId,
    '--destination',
    $chromeExtensionRoot
)
$chromeExtensionSourceCrxProperty = $config.packaging.PSObject.Properties['chromeExtensionSourceCrx']
$chromeExtensionSourceCrx = if ($null -ne $chromeExtensionSourceCrxProperty) { [string]$chromeExtensionSourceCrxProperty.Value } else { '' }
if (-not [string]::IsNullOrWhiteSpace($chromeExtensionSourceCrx)) {
    $downloadChromeExtensionArgs += @(
        '--source-crx',
        (Resolve-AbsolutePath -BasePath $repoRoot -PathValue $chromeExtensionSourceCrx)
    )
}

$chromeExtensionJson = & node @downloadChromeExtensionArgs
if ($LASTEXITCODE -ne 0) {
    throw 'download-chrome-extension.mjs failed.'
}
$chromeExtensionInfo = ($chromeExtensionJson -join [Environment]::NewLine) | ConvertFrom-Json
Write-BuildTrace 'Chrome extension offline assets bundled.'

# Patch app.asar so Codex runs correctly outside the MSIX container.
$patchScript = Join-Path $scriptRoot 'patch-app-asar.mjs'
$stagedAppDir = Join-Path $internalRoot 'app'
Write-BuildTrace 'Patching app.asar for standalone launch.'
node $patchScript --app-dir $stagedAppDir
if ($LASTEXITCODE -ne 0) {
    throw 'patch-app-asar.mjs failed.'
}
Write-BuildTrace 'app.asar patched successfully.'

# Config example: look in the official skills sync output first, then fall back
# to vendor/skills if it still exists (legacy).
$envExampleSrc = Join-Path $repoRoot 'build/work/skills-official/.system/skill-installer/skill-installer.env.example'
if (-not (Test-Path $envExampleSrc)) {
    $envExampleSrc = Join-Path $repoRoot 'vendor/skills/.system/skill-installer/skill-installer.env.example'
}
if (Test-Path $envExampleSrc) {
    Copy-Item -Path $envExampleSrc -Destination (Join-Path $internalRoot 'skill-installer.env.example') -Force
}

# Include root docs so users have documentation and package history inside the package.
foreach ($docName in @('README.md', 'CHANGELOG.md')) {
    $docSrc = Join-Path $repoRoot $docName
    if (Test-Path $docSrc) {
        Copy-Item -Path $docSrc -Destination (Join-Path $packageRoot $docName) -Force
    }
}

# Generate the one-time setup command. Setup is intentionally visible because
# Chrome extension loading and native-host repair failures need readable output.
$dailyLaunchCmd = @(
    '@echo off',
    'setlocal',
    'set CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE=1',
    'start "" "%~dp0_internal\app\Codex.exe" %*'
)
$dailyLaunchCmd | Set-Content -Path (Join-Path $packageRoot 'Codex.cmd') -Encoding ASCII

$webLaunchCmd = @(
    '@echo off',
    'setlocal',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Node.js was not found. Install Node.js 22 or newer, then run this launcher again.',
    '  pause',
    '  exit /b 1',
    ')',
    'node "%~dp0_internal\web\start-web.mjs" %*',
    'set WEB_EXIT=%ERRORLEVEL%',
    'if not "%WEB_EXIT%"=="0" (',
    '  echo.',
    '  echo Codex Web stopped with exit code %WEB_EXIT%.',
    '  pause',
    ')',
    'exit /b %WEB_EXIT%'
)
$webLaunchCmd | Set-Content -Path (Join-Path $packageRoot 'Codex Web.cmd') -Encoding ASCII

$setupCmd = @(
    '@echo off',
    'setlocal',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_internal\setup-codex-offline.ps1" %*',
    'set SETUP_EXIT=%ERRORLEVEL%',
    'if not "%SETUP_EXIT%"=="0" (',
    '  echo.',
    '  echo Codex Offline setup failed with exit code %SETUP_EXIT%.',
    '  pause',
    ')',
    'exit /b %SETUP_EXIT%'
)
$setupCmd | Set-Content -Path (Join-Path $packageRoot 'Setup Codex.cmd') -Encoding ASCII

$toolsRoot = Join-Path $internalRoot 'tools'
New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null

$launchDirectCmd = @(
    '@echo off',
    'setlocal',
    'set CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE=1',
    'start "" "%~dp0..\app\Codex.exe" %*'
)
$launchDirectCmd | Set-Content -Path (Join-Path $toolsRoot 'Launch Codex Direct.cmd') -Encoding ASCII

$syncDefaultCmd = @(
    '@echo off',
    'setlocal',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\bootstrap-codex-skills.ps1" -NoLaunch %*'
)
$syncDefaultCmd | Set-Content -Path (Join-Path $toolsRoot 'Sync Default Skills.cmd') -Encoding ASCII

$syncAllCmd = @(
    '@echo off',
    'setlocal',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\bootstrap-codex-skills.ps1" -NoLaunch -SkillProfile all %*'
)
$syncAllCmd | Set-Content -Path (Join-Path $toolsRoot 'Sync All Skills.cmd') -Encoding ASCII

$repairChromeHostCmd = @(
    '@echo off',
    'setlocal',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\repair-chrome-host.ps1" %*'
)
$repairChromeHostCmd | Set-Content -Path (Join-Path $toolsRoot 'Repair Chrome Host.cmd') -Encoding ASCII

$webGatewayInfo = Add-WebGatewayRuntime -RepoRoot $repoRoot -InternalRoot $internalRoot

Write-BuildTrace 'Resolving skill source roots.'
$skillSources = @()
foreach ($source in $config.skills.sources) {
    $skillSources += (Resolve-AbsolutePath -BasePath $repoRoot -PathValue $source)
}

Write-BuildTrace 'Bundling skills.'
$defaultInstallProfileProperty = $config.skills.PSObject.Properties['defaultInstallProfile']
$defaultInstallProfile = if ($null -ne $defaultInstallProfileProperty) { [string]$defaultInstallProfileProperty.Value } else { 'offline' }
$defaultInstallPathsProperty = $config.skills.PSObject.Properties['defaultInstallPaths']
$defaultInstallPaths = if ($null -ne $defaultInstallPathsProperty) { @($defaultInstallPathsProperty.Value | ForEach-Object { [string]$_ }) } else { @() }
& (Join-Path $scriptRoot 'bundle-skills.ps1') `
    -SourceRoots $skillSources `
    -Destination (Join-Path $internalRoot 'seed/codex-home/skills') `
    -ManifestPath (Join-Path $internalRoot 'seed/skills-manifest.json') `
    -PackageVersion $version `
    -DefaultInstallProfile $defaultInstallProfile `
    -DefaultInstallPaths $defaultInstallPaths | Out-Null
Write-BuildTrace 'Skills bundled.'
$buildInfo = [ordered]@{
    appName = $config.appName
    packageId = $config.packageId
    version = $version
    releaseTag = $releaseTag
    builtAt = (Get-Date).ToString('o')
    sourceMetadata = $sourceMetadata
    appSource = $appSourceInfo
    chromeExtension = $chromeExtensionInfo
    skills = [ordered]@{
        defaultInstallProfile = $defaultInstallProfile
        defaultInstallPaths = $defaultInstallPaths
    }
    primaryRuntime = $primaryRuntimePluginSource
    offlineRuntimePlugins = $offlineRuntimePluginInfo
    webGateway = $webGatewayInfo
}

Write-BuildTrace 'Build info written.'
$buildInfo | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $internalRoot 'build-info.json') -Encoding UTF8

$assets = [System.Collections.Generic.List[string]]::new()

Write-BuildTrace 'Creating archives.'
# Hide implementation details AFTER creating portable zip so Compress-Archive includes hidden items.
if ($config.packaging.portableZip) {
    $portableZip = Join-Path $artifactRoot ('{0}-portable.zip' -f $releaseBase)
    Compress-Archive -Path $packageRoot -DestinationPath $portableZip -Force
    $assets.Add($portableZip) | Out-Null
}

if ($config.packaging.crossPlatformWeb) {
    Write-BuildTrace 'Building cross-platform Web packages.'
    $crossWebDir = Join-Path $workRoot 'cross-platform-web'
    if (Test-Path $crossWebDir) { Remove-Item -Recurse -Force $crossWebDir }
    New-Item -ItemType Directory -Force -Path $crossWebDir | Out-Null

    $webRoot = Join-Path $crossWebDir $releaseBase
    New-Item -ItemType Directory -Force -Path $webRoot | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $webRoot 'gateway\dist') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $webRoot 'cache\official-bundle\webview') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $webRoot 'web-shell') | Out-Null

    # Gateway compiled artifacts
    Copy-Item -Path (Join-Path $repoRoot 'web-gateway\gateway\dist\*') -Destination (Join-Path $webRoot 'gateway\dist') -Recurse -Force
    Copy-Item -Path (Join-Path $repoRoot 'web-gateway\start-web.mjs') -Destination $webRoot -Force
    Copy-Item -Path (Join-Path $repoRoot 'web-gateway\package.json') -Destination $webRoot -Force

    # web-shell
    Copy-Item -Path (Join-Path $repoRoot 'web-gateway\web-shell\*') -Destination (Join-Path $webRoot 'web-shell') -Recurse -Force

    # webview (from already-extracted cache)
    $webviewSrc = Join-Path $internalRoot 'web\cache\official-bundle\webview'
    if (Test-Path $webviewSrc) {
        Copy-Item -Path "$webviewSrc\*" -Destination (Join-Path $webRoot 'cache\official-bundle\webview') -Recurse -Force
    }
    else {
        Write-Warning "Webview not found at $webviewSrc — cross-platform Web package will lack UI assets"
    }

    # Version
    $version | Set-Content -Path (Join-Path $webRoot 'VERSION') -Encoding ASCII

    # Universal launcher script
    $launcherPath = Join-Path $webRoot 'start.sh'
    @'
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
# 加载用户配置（如果存在）
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi
if [ ! -d "node_modules" ]; then
  echo "[codex-web] Installing dependencies..."
  npm install --omit=dev --no-audit --no-fund
fi
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3737}"
export CODEX_WEB_OFFICIAL_BUNDLE_DIR="${CODEX_WEB_OFFICIAL_BUNDLE_DIR:-$SCRIPT_DIR/cache/official-bundle}"
echo "[codex-web] Codex Web Gateway on $(uname -s)"
echo "[codex-web] http://${HOST}:${PORT}"
if [ -f "$SCRIPT_DIR/start-web.mjs" ]; then
  exec node "$SCRIPT_DIR/start-web.mjs"
else
  exec node gateway/dist/server.js
fi
'@ | Set-Content -Path $launcherPath -Encoding ASCII -NoNewline

    # 通用 Web 包：一份内容，三个平台通用，只区分启动脚本
    # start.sh → Linux / macOS，start.bat → Windows
    $startBat = Join-Path $webRoot 'start.bat'
    @'
@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (echo Node.js was not found. Install Node.js 18+ from https://nodejs.org && pause && exit /b 1)
where codex >nul 2>nul
if errorlevel 1 (echo Codex CLI was not found. Install with: npm install -g @openai/codex && pause && exit /b 1)
if not exist "node_modules\" (
  echo [codex-web] Installing dependencies...
  call npm install --omit=dev --no-audit --no-fund
)
set HOST=%HOST%
if "%HOST%"=="" set HOST=127.0.0.1
set PORT=%PORT%
if "%PORT%"=="" set PORT=3737
echo [codex-web] Codex Web Gateway
echo [codex-web] http://%HOST%:%PORT%
node start-web.mjs
'@ | Set-Content -Path $startBat -Encoding ASCII -NoNewline

    $webZip = Join-Path $artifactRoot ('{0}-web.zip' -f $releaseBase)
    Compress-Archive -Path $webRoot -DestinationPath $webZip -Force
    $assets.Add($webZip) | Out-Null
    Write-BuildTrace "Cross-platform Web package: $webZip"
}

if ($config.packaging.skillArchive) {
    $skillsZip = Join-Path $artifactRoot ('{0}-skills.zip' -f $releaseBase)
    Compress-Archive -Path (Join-Path $internalRoot 'seed/codex-home') -DestinationPath $skillsZip -Force
    $assets.Add($skillsZip) | Out-Null
}

if ($config.packaging.sourceExportArchive) {
    $sourceZip = Join-Path $artifactRoot ('{0}-store-export.zip' -f $releaseBase)
    Compress-Archive -Path $sourceExportRoot -DestinationPath $sourceZip -Force
    $assets.Add($sourceZip) | Out-Null
}

Write-BuildTrace 'Checking installer generation.'
if ($config.packaging.setupExe -and -not $SkipInstaller) {
    $iscc = Find-Iscc

    if ($null -eq $iscc) {
        if ($RequireInstaller) {
            throw 'Inno Setup was not found. Install Inno Setup 6 or run with -SkipInstaller.'
        }

        Write-Warning 'Inno Setup was not found. Skipping installer build.'
    }
    else {
        $templateFile = Join-Path $repoRoot 'installer/CodexOffline.iss.tpl'
        $issFile = Join-Path $workRoot 'CodexOffline.generated.iss'
        $template = Get-Content -Path $templateFile -Raw
        $rendered = $template
        $rendered = $rendered.Replace('__APP_NAME__', [string]$config.appName)
        $rendered = $rendered.Replace('__APP_VERSION__', [string]$version)
        $rendered = $rendered.Replace('__APP_DIR_NAME__', [string]$config.installDirName)
        $rendered = $rendered.Replace('__SOURCE_ROOT__', [string]$packageRoot.Replace('/', '\\'))
        $rendered = $rendered.Replace('__OUTPUT_ROOT__', [string]$artifactRoot.Replace('/', '\\'))
        $rendered = $rendered.Replace('__OUTPUT_BASENAME__', [string]('{0}-setup' -f $releaseBase))
        $rendered | Set-Content -Path $issFile -Encoding UTF8
        & $iscc $issFile | Out-Host

        $setupExe = Join-Path $artifactRoot ('{0}-setup.exe' -f $releaseBase)
        if (Test-Path $setupExe) {
            $assets.Add($setupExe) | Out-Null
        }
    }
}

Write-BuildTrace 'Writing checksums.'
$checksumFile = Join-Path $artifactRoot 'SHA256SUMS.txt'
($assets | Sort-Object | ForEach-Object {
    '{0} *{1}' -f (Get-FileSha256 -PathValue $_), (Split-Path $_ -Leaf)
}) | Set-Content -Path $checksumFile -Encoding ASCII
$assets.Add($checksumFile) | Out-Null

$assetInfo = @($assets | Sort-Object | ForEach-Object {
    [ordered]@{
        fileName = Split-Path $_ -Leaf
        fullPath = $_
        relativePath = Get-RelativePath -BasePath $repoRoot -PathValue $_
        sha256 = if ((Split-Path $_ -Leaf) -eq 'SHA256SUMS.txt') { $null } else { Get-FileSha256 -PathValue $_ }
    }
})

$buildMetadata = [ordered]@{
    appName = $config.appName
    packageId = $config.packageId
    version = $version
    releaseTag = $releaseTag
    releaseName = '{0} Offline {1}' -f $config.appName, $version
    artifactDirectory = $artifactRoot
    artifactDirectoryRelative = Get-RelativePath -BasePath $repoRoot -PathValue $artifactRoot
    generatedAt = (Get-Date).ToString('o')
    appSource = $appSourceInfo
    primaryRuntime = $primaryRuntimePluginSource
    assets = $assetInfo
}

Write-BuildTrace 'Finalizing metadata.'
$buildMetadataJson = $buildMetadata | ConvertTo-Json -Depth 8
$buildMetadataJson | Set-Content -Path (Join-Path $outputRoot 'build-metadata.json') -Encoding UTF8
$buildMetadataJson | Set-Content -Path (Join-Path $artifactRoot 'build-metadata.json') -Encoding UTF8

if (-not [string]::IsNullOrWhiteSpace($MetadataOutputPath)) {
    $metadataOutputFile = Resolve-AbsolutePath -BasePath $repoRoot -PathValue $MetadataOutputPath
    New-Item -ItemType Directory -Force -Path (Split-Path $metadataOutputFile -Parent) | Out-Null
    $buildMetadataJson | Set-Content -Path $metadataOutputFile -Encoding UTF8
}

$buildMetadataJson

